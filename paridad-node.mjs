/**
 * Nodo Paridad end-to-end.
 *
 *   FACTURA
 *     → QVAC OCR local
 *     → extracción estructurada (json_schema)
 *     → producto canónico + unit_price_cents
 *     → secret sharing
 *     → Hyperswarm P2P
 *     → agregación privada
 *     → promedio del grupo
 *
 * Uso:
 *   node paridad-node.mjs A demo-data/facturas/factura-demo-a.png
 *   node paridad-node.mjs A --precio-cents 4700        (salta QVAC, solo P2P)
 *   node paridad-node.mjs A <factura> --esperado 4700  (falla si la extracción cambia)
 *   node paridad-node.mjs A <factura> --timeout 60000
 *   node paridad-node.mjs A <factura> --topic ronda-de-prueba
 *
 * La factura, el texto OCR y el proveedor NO salen de este proceso: lo único
 * que cruza la red son shares enmascarados y sumas parciales.
 */

import { PARTICIPANTS } from "./src/privacy/aggregation-protocol.mjs";
import { createAggregationNode, TOPIC_POR_DEFECTO } from "./src/p2p/aggregation-node.mjs";
import {
  loadPipeline,
  unloadPipeline,
  extractInvoice,
  validateExtraction,
} from "./src/extraction/invoice-pipeline.mjs";

// --- Argumentos ------------------------------------------------------------
const args = process.argv.slice(2);
const nodeName = args[0];

function opcion(nombre) {
  const i = args.indexOf(nombre);
  return i === -1 ? null : args[i + 1];
}

const rutaFactura = args[1] && !args[1].startsWith("--") ? args[1] : null;
const precioCentsDirecto = opcion("--precio-cents");
const esperado = opcion("--esperado");
const timeoutMs = Number(opcion("--timeout") ?? 0);
const topicName = opcion("--topic") ?? TOPIC_POR_DEFECTO;

if (!PARTICIPANTS.includes(nodeName) || (!rutaFactura && !precioCentsDirecto)) {
  console.error(
    `Uso: node paridad-node.mjs <${PARTICIPANTS.join("|")}> <ruta-factura.png>\n` +
      `     node paridad-node.mjs <${PARTICIPANTS.join("|")}> --precio-cents <n>`
  );
  process.exit(1);
}

// --- Paso 1: obtener el precio privado -------------------------------------
/**
 * Devuelve el valor privado en centavos.
 *
 * Con factura, usa el pipeline QVAC ya validado. La ruta --precio-cents existe
 * para poder ejercitar la capa P2P sin cargar modelos (por ejemplo al probar
 * desconexiones); no es un atajo para el flujo real.
 */
async function obtenerPrecioPrivado() {
  if (precioCentsDirecto) {
    const cents = Number(precioCentsDirecto);
    if (!Number.isInteger(cents) || cents <= 0) {
      throw new Error(`--precio-cents inválido: ${precioCentsDirecto}`);
    }
    console.log(`💵 Nodo ${nodeName}: precio privado suministrado directamente (${cents} centavos, sin OCR)`);
    return cents;
  }

  console.log(`📄 Nodo ${nodeName}: procesando ${rutaFactura} con QVAC local...`);

  const sesion = await loadPipeline();
  try {
    const extraccion = await extractInvoice({ sesion, imagePath: rutaFactura });

    const errores = validateExtraction(extraccion);
    if (errores.length) {
      throw new Error(`La extracción no cumple el schema: ${errores.join("; ")}`);
    }

    const { msOcr, msLlm, ocrBackend } = extraccion._local;
    console.log(
      `🧠 Nodo ${nodeName}: QVAC local listo (OCR ${(msOcr / 1000).toFixed(1)}s en ${ocrBackend} · LLM ${(msLlm / 1000).toFixed(1)}s)`
    );

    // Línea estructurada para que el test end-to-end pueda verificar la
    // extracción sin volver a ejecutar el pipeline.
    console.log(
      `PARIDAD_EXTRACCION ${JSON.stringify({
        product: extraccion.product,
        product_canonical: extraccion.product_canonical,
        quantity: extraccion.quantity,
        unit_price_cents: extraccion.unit_price_cents,
      })}`
    );

    if (esperado !== null && extraccion.unit_price_cents !== Number(esperado)) {
      throw new Error(
        `La extracción cambió: se esperaban ${esperado} centavos y QVAC devolvió ${extraccion.unit_price_cents}`
      );
    }

    return extraccion.unit_price_cents;
  } finally {
    // Se liberan los modelos antes de entrar en la fase P2P: a partir de aquí
    // ya no hace falta inferencia y son ~400 MB de RAM.
    await unloadPipeline(sesion);
  }
}

// --- Paso 2 y 3: secret sharing + P2P --------------------------------------
let nodo = null;
let cerrando = false;

async function apagar(motivo, exitCode = 0) {
  if (cerrando) return;
  cerrando = true;

  console.log(`\n🛑 Cerrando nodo ${nodeName} (${motivo})...`);

  const forzar = setTimeout(() => {
    console.error(`⚠️  Nodo ${nodeName}: el cierre tardó demasiado, forzando salida`);
    process.exit(exitCode || 1);
  }, 5000);
  forzar.unref();

  let salida = exitCode;
  try {
    if (nodo) await nodo.stop();
    console.log(`✅ Nodo ${nodeName}: swarm cerrado, sin estado de red pendiente`);
  } catch (err) {
    console.error(`⚠️  Nodo ${nodeName}: error al cerrar: ${err.message}`);
    salida = salida || 1;
  } finally {
    clearTimeout(forzar);
    process.exit(salida);
  }
}

process.on("SIGINT", () => void apagar("SIGINT"));
process.on("SIGTERM", () => void apagar("SIGTERM"));

process.on("uncaughtException", (err) => {
  console.error(`\n💥 Nodo ${nodeName}: excepción no capturada`);
  console.error(err);
  void apagar("uncaughtException", 1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`\n💥 Nodo ${nodeName}: promesa rechazada sin manejar`);
  console.error(reason);
  void apagar("unhandledRejection", 1);
});

try {
  const precioCents = await obtenerPrecioPrivado();

  nodo = createAggregationNode({
    nodeName,
    privateValue: BigInt(precioCents),
    topicName,
    timeoutMs,
  });

  console.log(`\n🟢 Nodo ${nodeName} — Paridad end-to-end`);
  console.log(`Precio local (nunca sale de este proceso): ${precioCents} centavos`);
  console.log(
    "Shares generados para repartir (uno por peer, nunca todos al mismo peer):",
    Object.fromEntries(Object.entries(nodo.misShares).map(([quien, s]) => [quien, s.toString()]))
  );

  const resultado = await nodo.start();

  // --- Paso 4: auditoría de privacidad -------------------------------------
  const auditoria = nodo.auditoria();
  console.log(`\n🔍 Auditoría de red del nodo ${nodeName}:`);
  console.log(`   Mensajes enviados: ${auditoria.mensajes.length}`);
  for (const m of auditoria.mensajes) {
    console.log(`     - ${m.tipo} (${m.bytes} bytes)`);
  }
  console.log(
    `   ¿El precio ${precioCents} viajó como valor en algún mensaje?  ${
      auditoria.valorPrivadoTransmitido ? "SÍ ← FUGA" : "NO"
    }`
  );

  console.log(`PARIDAD_AUDITORIA ${JSON.stringify({
    precioCents,
    valorPrivadoTransmitido: auditoria.valorPrivadoTransmitido,
    payloads: auditoria.payloads,
  })}`);

  console.log(`PARIDAD_RESULTADO ${JSON.stringify({
    nodeName,
    completo: resultado.completo,
    total: resultado.total !== undefined ? Number(resultado.total) : null,
    average: resultado.average ?? null,
    motivo: resultado.motivo ?? null,
  })}`);

  // Margen de cortesía antes de cerrar el swarm.
  //
  // Un nodo termina en cuanto recibe las sumas parciales de los demás, pero sus
  // propios envíos pueden no haberse vaciado todavía en el socket del peer.
  // Destruir el swarm de inmediato dejaría al peer más lento esperando un
  // mensaje que ya no va a llegar. En el spike anterior esto no pasaba porque
  // el proceso se quedaba vivo hasta Ctrl+C.
  const graciaMs = Number(opcion("--gracia") ?? 3000);
  if (resultado.completo && graciaMs > 0) {
    await new Promise((r) => setTimeout(r, graciaMs));
  }

  await apagar(resultado.completo ? "ronda completada" : "ronda incompleta", 0);
} catch (err) {
  // Sin respaldo a la nube: si QVAC o el protocolo fallan, se falla visible.
  console.error(`\n❌ Nodo ${nodeName}: ${err.message}`);
  await apagar("error", 1);
}
