/**
 * Historial local de compras de Paridad.
 *
 *   factura → extracción local → HISTORIAL LOCAL → comparación cuando haya datos
 *
 * Guarda TODOS los productos extraídos de cada factura, uno por línea, en un
 * JSON del dispositivo. No conoce la red: nada de lo que hay aquí se envía a
 * ningún sitio, y el precio individual vive únicamente en este archivo y en
 * la memoria del proceso local.
 *
 * Decisiones:
 *   - JSON plano en disco, sin base de datos: son decenas de registros, no
 *     miles. Escritura atómica (temporal + rename) para no dejar el archivo
 *     a medias si el proceso muere escribiendo.
 *   - Cada factura se identifica por el hash de su contenido, no por el
 *     nombre: procesar dos veces la misma imagen REEMPLAZA sus registros en
 *     vez de duplicarlos. Así reiniciar el nodo (que vuelve a procesar sus
 *     --factura) no engorda el historial, y una factura distinta con el mismo
 *     nombre de archivo sí se registra aparte.
 *   - Los registros nunca se sobreescriben entre sí: un producto nuevo se
 *     AÑADE; solo se reemplazan los de la misma factura al reprocesarla.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const VERSION_HISTORIAL = 1;

/** Estados de comparación de un registro (capa preparada para la fase 2). */
export const COMPARACION = Object.freeze({
  PENDIENTE: "PENDIENTE", // aún no hay ronda cerrada para este producto
  DISPONIBLE: "DISPONIBLE", // hay referencia del grupo con >= 3 participantes
  NO_DISPONIBLE: "NO_DISPONIBLE", // no hay participantes suficientes con este producto
});

/** Regla de privacidad: sin al menos 3 participantes válidos no hay comparación. */
export const MIN_PARTICIPANTES_COMPARACION = 3;

/** Identificador de factura por contenido (sha256 del archivo, acortado). */
export function idDeFactura(rutaArchivo) {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(rutaArchivo)).digest("hex");
  return hash.slice(0, 16);
}

function escribirAtomico(ruta, contenido) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const temporal = `${ruta}.${process.pid}.tmp`;
  fs.writeFileSync(temporal, contenido, "utf8");
  fs.renameSync(temporal, ruta);
}

/**
 * Abre (o crea) el historial en `ruta`.
 *
 * @param {object} opts
 * @param {string} opts.ruta   archivo JSON del historial
 * @param {string} opts.nodo   nombre del nodo local (solo informativo)
 */
export function abrirHistorial({ ruta, nodo }) {
  let datos = { version: VERSION_HISTORIAL, nodo, facturas: [], registros: [] };

  if (fs.existsSync(ruta)) {
    try {
      const leido = JSON.parse(fs.readFileSync(ruta, "utf8"));
      if (leido && Array.isArray(leido.registros)) {
        datos = { ...datos, ...leido, nodo: leido.nodo ?? nodo };
      }
    } catch (err) {
      // Un archivo corrupto no debe impedir arrancar; se conserva aparte
      // para no perder nada y se empieza de cero.
      const respaldo = `${ruta}.corrupto-${Date.now()}`;
      fs.renameSync(ruta, respaldo);
      console.warn(`⚠️  Historial ilegible (${err.message}); movido a ${path.basename(respaldo)}`);
    }
  }

  function guardar() {
    escribirAtomico(ruta, JSON.stringify(datos, null, 2));
  }

  return {
    ruta,

    /**
     * Registra los productos extraídos de UNA factura.
     *
     * @param {object} factura  { id, archivo, procesadaEn?, msOcr?, msLlm?, ocrBackend? }
     * @param {Array}  items    salida de extractInvoiceItems().items
     * @returns {Array} los registros creados
     */
    registrar(factura, items) {
      if (!factura?.id) throw new Error("La factura necesita un id");
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("No hay líneas de producto que registrar");
      }

      const procesadaEn = factura.procesadaEn ?? new Date().toISOString();

      // Reprocesar la misma factura reemplaza SUS registros, no los ajenos.
      datos.registros = datos.registros.filter((r) => r.facturaId !== factura.id);
      datos.facturas = datos.facturas.filter((f) => f.id !== factura.id);

      datos.facturas.push({
        id: factura.id,
        archivo: factura.archivo,
        procesadaEn,
        lineas: items.length,
        ocrBackend: factura.ocrBackend ?? null,
        msOcr: factura.msOcr ?? null,
        msLlm: factura.msLlm ?? null,
      });

      const nuevos = items.map((item, i) => ({
        id: `${factura.id}-${i + 1}`,
        facturaId: factura.id,
        archivo: factura.archivo,
        procesadaEn,
        product: item.product,
        productCanonical: item.product_canonical,
        quantity: item.quantity,
        unitPriceCents: item.unit_price_cents,
        // Se recalcula al leer (ver estadoComparacion en el nodo). Se guarda
        // el último valor conocido para que la UI tenga algo coherente al
        // arrancar antes de que haya red.
        comparacion: { estado: COMPARACION.PENDIENTE },
      }));

      datos.registros.push(...nuevos);
      guardar();
      return nuevos;
    },

    /** Actualiza el estado de comparación guardado de todos los registros de un producto. */
    marcarComparacion(productCanonical, comparacion) {
      let cambio = false;
      for (const r of datos.registros) {
        if (r.productCanonical !== productCanonical) continue;
        if (JSON.stringify(r.comparacion) === JSON.stringify(comparacion)) continue;
        r.comparacion = comparacion;
        cambio = true;
      }
      if (cambio) guardar();
      return cambio;
    },

    /** Todos los registros, del más reciente al más antiguo. */
    todos() {
      return [...datos.registros].sort((a, b) => b.procesadaEn.localeCompare(a.procesadaEn));
    },

    porFactura(facturaId) {
      return datos.registros.filter((r) => r.facturaId === facturaId);
    },

    facturas() {
      return [...datos.facturas].sort((a, b) => b.procesadaEn.localeCompare(a.procesadaEn));
    },

    /**
     * Último precio conocido por producto canónico: lo que se entrega a la
     * ronda de agregación. Un producto = una entrada, aunque aparezca en
     * varias facturas (se toma la más reciente).
     */
    ultimoPorProducto() {
      const porProducto = new Map();
      for (const r of this.todos()) {
        if (!porProducto.has(r.productCanonical)) porProducto.set(r.productCanonical, r);
      }
      return [...porProducto.values()];
    },

    resumen() {
      return {
        facturas: datos.facturas.length,
        productos: datos.registros.length,
        productosDistintos: new Set(datos.registros.map((r) => r.productCanonical)).size,
      };
    },
  };
}
