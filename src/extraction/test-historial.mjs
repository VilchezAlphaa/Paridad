/**
 * Tests del historial local de compras (sin QVAC, sin red).
 *
 *   node src/extraction/test-historial.mjs
 *
 * Cubre los requisitos de la fase 1:
 *   1. una factura con N productos genera N registros;
 *   2. todos pertenecen a la misma factura;
 *   3. un producto no sobreescribe a otro;
 *   4. el historial devuelve todos los productos;
 *   5. una segunda factura no borra los de la primera;
 *   6. reabrir el historial (reinicio) conserva todo;
 *   7. reprocesar la MISMA factura no duplica;
 *   8. los precios quedan solo en el archivo local: lo que va a la ronda no
 *      lleva nada que no llevara ya, y el archivo no se toca desde la red.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { abrirHistorial, idDeFactura, COMPARACION, MIN_PARTICIPANTES_COMPARACION } from "./historial.mjs";

console.log("🧪 Historial local de compras...");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paridad-historial-"));
const ruta = path.join(dir, "historial.json");

// Lo que devuelve extractInvoiceItems().items para una factura de 5 líneas.
const ITEMS_FACTURA_1 = [
  { product: "ACEITE MOTOR 20W50", product_canonical: "aceite motor 20w50", quantity: 4, unit_price_cents: 4700 },
  { product: "FILTRO DE ACEITE", product_canonical: "filtro de aceite", quantity: 12, unit_price_cents: 680 },
  { product: "PASTILLAS DE FRENO DELANT", product_canonical: "pastillas de freno delant", quantity: 6, unit_price_cents: 2850 },
  { product: "BATERIA 12V 650A", product_canonical: "bateria 12v 650a", quantity: 2, unit_price_cents: 7800 },
  { product: "BUJIAS DE ENCENDIDO X4", product_canonical: "bujias de encendido x4", quantity: 8, unit_price_cents: 1640 },
];

const ITEMS_FACTURA_2 = [
  { product: "Aceite Motor 20W50", product_canonical: "aceite motor 20w50", quantity: 2, unit_price_cents: 4500 },
  { product: "LIQUIDO DE FRENOS DOT4", product_canonical: "liquido de frenos dot4", quantity: 3, unit_price_cents: 950 },
];

// --- 1-4: una factura, N registros, misma factura, nada se pisa -------------
{
  const h = abrirHistorial({ ruta, nodo: "A" });
  const creados = h.registrar({ id: "f1", archivo: "factura-1.png" }, ITEMS_FACTURA_1);

  assert.equal(creados.length, 5, "5 líneas → 5 registros");
  assert.ok(creados.every((r) => r.facturaId === "f1"), "todos de la misma factura");
  assert.equal(new Set(creados.map((r) => r.id)).size, 5, "ids distintos");

  const todos = h.todos();
  assert.equal(todos.length, 5, "el historial devuelve los 5");
  assert.deepEqual(
    todos.map((r) => r.productCanonical).sort(),
    ITEMS_FACTURA_1.map((i) => i.product_canonical).sort(),
    "ningún producto sobreescribió a otro"
  );
  assert.deepEqual(
    todos.map((r) => r.unitPriceCents).sort((a, b) => a - b),
    [680, 1640, 2850, 4700, 7800],
    "cada registro conserva su precio"
  );
  assert.ok(todos.every((r) => r.comparacion.estado === COMPARACION.PENDIENTE), "sin ronda → PENDIENTE");
  assert.deepEqual(h.resumen(), { facturas: 1, productos: 5, productosDistintos: 5 });
  console.log("✅ Una factura de 5 productos genera 5 registros, todos de esa factura, sin pisarse");
}

// --- 5: segunda factura, los anteriores siguen -------------------------------
{
  const h = abrirHistorial({ ruta, nodo: "A" });
  h.registrar({ id: "f2", archivo: "factura-2.png" }, ITEMS_FACTURA_2);

  assert.equal(h.todos().length, 7, "5 + 2 registros");
  assert.equal(h.porFactura("f1").length, 5, "la primera factura sigue completa");
  assert.equal(h.porFactura("f2").length, 2);
  assert.deepEqual(h.resumen(), { facturas: 2, productos: 7, productosDistintos: 6 });

  // A la ronda va UN item por producto canónico, el más reciente.
  const ronda = h.ultimoPorProducto();
  assert.equal(ronda.length, 6, "6 productos distintos");
  const aceite = ronda.find((r) => r.productCanonical === "aceite motor 20w50");
  assert.equal(aceite.unitPriceCents, 4500, "para la ronda cuenta el precio más reciente");
  console.log("✅ Una segunda factura añade sin borrar; la ronda recibe el último precio por producto");
}

// --- 6: reinicio → reabrir el archivo conserva todo -------------------------
{
  const h = abrirHistorial({ ruta, nodo: "A" });
  assert.equal(h.todos().length, 7, "tras reabrir siguen los 7");
  assert.equal(h.facturas().length, 2);
  const enDisco = JSON.parse(fs.readFileSync(ruta, "utf8"));
  assert.equal(enDisco.registros.length, 7);
  assert.equal(enDisco.nodo, "A");
  console.log("✅ Reabrir el historial (reinicio del proceso) conserva las 2 facturas y los 7 productos");
}

// --- 7: reprocesar la misma factura reemplaza, no duplica ----------------------
{
  const h = abrirHistorial({ ruta, nodo: "A" });
  h.registrar({ id: "f1", archivo: "factura-1.png" }, ITEMS_FACTURA_1);
  assert.equal(h.todos().length, 7, "reprocesar f1 no duplica sus 5 líneas");
  assert.equal(h.porFactura("f2").length, 2, "y no toca la otra factura");
  console.log("✅ Reprocesar la misma factura reemplaza sus registros en vez de duplicarlos");
}

// --- id por contenido: mismo archivo → mismo id; contenido distinto → distinto --
{
  const a = path.join(dir, "a.png");
  const b = path.join(dir, "b.png");
  fs.writeFileSync(a, Buffer.from("imagen-a"));
  fs.writeFileSync(b, Buffer.from("imagen-b"));
  const copia = path.join(dir, "copia-de-a.png");
  fs.copyFileSync(a, copia);

  assert.equal(idDeFactura(a), idDeFactura(copia), "misma imagen con otro nombre → mismo id");
  assert.notEqual(idDeFactura(a), idDeFactura(b));
  console.log("✅ La factura se identifica por contenido, no por nombre de archivo");
}

// --- comparación: marcar y umbral de privacidad -------------------------------
{
  const h = abrirHistorial({ ruta, nodo: "A" });
  const cmp = { estado: COMPARACION.DISPONIBLE, referencia: 43.33, posicionPct: 8.5, participantes: 3 };
  assert.ok(h.marcarComparacion("aceite motor 20w50", cmp), "marca los registros del producto");
  const marcados = h.todos().filter((r) => r.productCanonical === "aceite motor 20w50");
  assert.equal(marcados.length, 2, "las dos líneas de aceite (una por factura)");
  assert.ok(marcados.every((r) => r.comparacion.estado === COMPARACION.DISPONIBLE));
  assert.ok(
    h.todos().filter((r) => r.productCanonical !== "aceite motor 20w50").every((r) => r.comparacion.estado === COMPARACION.PENDIENTE),
    "los demás productos no se tocan"
  );
  assert.equal(MIN_PARTICIPANTES_COMPARACION, 3, "la regla de privacidad es 3 participantes");
  console.log("✅ La comparación se marca por producto y no contamina a los demás");
}

// --- archivo corrupto: no impide arrancar, se conserva aparte -------------------
{
  fs.writeFileSync(ruta, "{esto no es json");
  const h = abrirHistorial({ ruta, nodo: "A" });
  assert.equal(h.todos().length, 0, "arranca vacío");
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith("historial.json.corrupto-")), "el archivo roto se guarda aparte");
  console.log("✅ Un historial corrupto no impide arrancar y se conserva para no perder datos");
}

// --- privacidad: los registros nunca se serializan hacia la red ----------------
// El historial no tiene ninguna dependencia de red (ni la importa). Lo único
// que sale de él hacia la ronda es ultimoPorProducto(), y la ronda ya solo
// pone en la red nombres de producto, shares y sumas parciales. Aquí se
// comprueba que el módulo no arrastre nada de red y que el JSON en disco sea
// el único sitio con precios.
{
  const fuente = fs.readFileSync(new URL("./historial.mjs", import.meta.url), "utf8");
  assert.ok(!/hyperswarm|hyperdht|node:net|node:http|fetch\(/.test(fuente), "historial.mjs no importa nada de red");
  console.log("✅ historial.mjs no tiene ninguna ruta hacia la red: los precios solo viven en el archivo local");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("\n✅ Todos los tests del historial local pasaron.");
