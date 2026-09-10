/**
 * Test del pipeline de extracción de facturas.
 *
 * Tiene dos partes:
 *
 *   1. Tests puros (sin QVAC): reconstrucción de líneas, reparación de OCR,
 *      normalización de producto, conversión a centavos y validación de
 *      schema. Corren en milisegundos y no descargan modelos.
 *
 *   2. Test de integración con QVAC: procesa las 3 facturas de demo con
 *      inferencia local real y valida el resultado contra el schema.
 *      Es lento (decenas de segundos por factura) y descarga modelos la
 *      primera vez.
 *
 * Uso:
 *   node src/extraction/test-invoice-pipeline.mjs           (todo)
 *   node src/extraction/test-invoice-pipeline.mjs --solo-puros
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  reconstructLines,
  repairOcrText,
  normalizeProduct,
  priceStringToCents,
  validateExtraction,
  loadPipeline,
  unloadPipeline,
  extractInvoice,
} from "./invoice-pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const facturasDir = path.join(__dirname, "..", "..", "demo-data", "facturas");

// Valores esperados: son los datos SINTÉTICOS con los que se generaron las
// imágenes en tools/generar-facturas-demo.ps1.
const FACTURAS_DEMO = [
  { archivo: "factura-demo-a.png", quantity: 4, unit_price_cents: 4700 },
  { archivo: "factura-demo-b.png", quantity: 6, unit_price_cents: 3100 },
  { archivo: "factura-demo-c.png", quantity: 3, unit_price_cents: 5200 },
];

const PRODUCTO_CANONICO_ESPERADO = "aceite motor 20w50";

// ==========================================================================
// 1. Tests puros
// ==========================================================================

console.log("🧪 Tests puros del pipeline (sin QVAC)...");

{
  // Bloques desordenados de dos líneas; deben agruparse por Y y ordenarse por X.
  const blocks = [
    { text: "MOTOR", bbox: [282, 299, 363, 326] },
    { text: "CANT", bbox: [42, 252, 108, 276] },
    { text: "ACEITE", bbox: [178, 299, 274, 326] },
    { text: "DESCRIPCION", bbox: [134, 252, 306, 278] },
    { text: "20W50", bbox: [373, 299, 455, 326] },
  ];

  assert.deepEqual(reconstructLines(blocks), [
    "CANT DESCRIPCION",
    "ACEITE MOTOR 20W50",
  ]);
  console.log("✅ reconstructLines agrupa por línea y ordena por posición");
}

{
  // Confusiones medidas de forma reproducible en el OCR de las facturas demo.
  assert.equal(repairOcrText("ACEITE MOTOR 20h50"), "ACEITE MOTOR 20W50");
  assert.equal(repairOcrText("ACEITE MOTOR 20w50"), "ACEITE MOTOR 20W50");
  assert.equal(repairOcrText("PRECIO UNITARIO: 47 . 00"), "PRECIO UNITARIO: 47.00");
  assert.equal(repairOcrText("PRECIO UNITARIO: 47 .00"), "PRECIO UNITARIO: 47.00");
  // No debe tocar texto ya correcto.
  assert.equal(repairOcrText("ACEITE MOTOR 20W50 47.00"), "ACEITE MOTOR 20W50 47.00");
  console.log("✅ repairOcrText corrige las confusiones conocidas sin dañar texto correcto");
}

{
  // Variaciones textuales del mismo insumo (CLAUDE.md §19).
  const variantes = [
    "ACEITE MOTOR 20W50",
    "aceite motor 20w50",
    "Aceite  Motor   20W50",
    "ACEITE MOTOR 20h50", // tal como lo devuelve el OCR sin reparar
    "ACEITE MOTOR 20W50 UND", // el modelo a veces arrastra la unidad
    "4 UND ACEITE MOTOR 20W50", // o la línea entera de la tabla
    "ACEITE MOTOR 20W50 C/U",
  ];

  const canonicos = variantes.map((v) => normalizeProduct(repairOcrText(v)));
  for (const c of canonicos) {
    assert.equal(c, PRODUCTO_CANONICO_ESPERADO, `variante normalizó a "${c}"`);
  }
  assert.equal(normalizeProduct("Aceite Motór"), "aceite motor");
  console.log("✅ normalizeProduct agrupa variantes del mismo producto");
}

{
  assert.equal(priceStringToCents("47.00"), 4700);
  assert.equal(priceStringToCents("31.00"), 3100);
  assert.equal(priceStringToCents("0.05"), 5);
  assert.equal(priceStringToCents("1234.56"), 123456);
  assert.throws(() => priceStringToCents("47"), /formato inesperado/);
  assert.throws(() => priceStringToCents("47,00"), /formato inesperado/);
  console.log("✅ priceStringToCents convierte sin pasar por coma flotante");
}

{
  assert.deepEqual(validateExtraction({ product: "aceite", quantity: 4, unit_price_cents: 4700 }), []);
  assert.ok(validateExtraction({ product: "", quantity: 4, unit_price_cents: 4700 }).length === 1);
  assert.ok(validateExtraction({ product: "x", quantity: 1.5, unit_price_cents: 4700 }).length === 1);
  assert.ok(validateExtraction({ product: "x", quantity: 4, unit_price_cents: 0 }).length === 1);
  assert.ok(validateExtraction(null).length === 3);
  console.log("✅ validateExtraction detecta los casos inválidos");
}

console.log("✅ Tests puros pasaron.\n");

if (process.argv.includes("--solo-puros")) {
  console.log("(--solo-puros: se omite la integración con QVAC)");
  process.exit(0);
}

// ==========================================================================
// 2. Integración real con QVAC (inferencia local)
// ==========================================================================

console.log("🧪 Integración con QVAC — inferencia 100% local, sin nube.");
console.log("   (la primera ejecución descarga los modelos; luego usa la caché local)\n");

let modelos;
try {
  const t0 = Date.now();
  modelos = await loadPipeline();
  console.log(`▸ Modelos cargados en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  OCR: ${modelos.ocrModelId} (backend: ${modelos.ocrBackend})   LLM: ${modelos.llmModelId}\n`);

  let fallos = 0;

  for (const esperado of FACTURAS_DEMO) {
    const imagePath = path.join(facturasDir, esperado.archivo);
    const resultado = await extractInvoice({ sesion: modelos, imagePath });

    const errores = validateExtraction(resultado);
    const { msOcr, msLlm, ocrBackend } = resultado._local;

    console.log(
      `▸ ${esperado.archivo}  (OCR ${(msOcr / 1000).toFixed(1)}s en ${ocrBackend} · LLM ${(msLlm / 1000).toFixed(1)}s)`
    );
    console.log(`  ${JSON.stringify({
      product: resultado.product,
      quantity: resultado.quantity,
      unit_price_cents: resultado.unit_price_cents,
    })}`);
    console.log(`  canónico: "${resultado.product_canonical}"`);

    if (errores.length) {
      console.error(`  ❌ schema inválido: ${errores.join("; ")}`);
      fallos++;
      continue;
    }

    // El precio unitario es el dato que alimenta el benchmark: tiene que ser exacto.
    if (resultado.unit_price_cents !== esperado.unit_price_cents) {
      console.error(`  ❌ unit_price_cents: esperado ${esperado.unit_price_cents}, obtenido ${resultado.unit_price_cents}`);
      fallos++;
      continue;
    }
    if (resultado.quantity !== esperado.quantity) {
      console.error(`  ❌ quantity: esperado ${esperado.quantity}, obtenido ${resultado.quantity}`);
      fallos++;
      continue;
    }
    if (resultado.product_canonical !== PRODUCTO_CANONICO_ESPERADO) {
      console.error(`  ❌ product_canonical: esperado "${PRODUCTO_CANONICO_ESPERADO}", obtenido "${resultado.product_canonical}"`);
      fallos++;
      continue;
    }

    console.log("  ✅ schema válido y valores correctos\n");
  }

  // Las 3 facturas describen el mismo insumo: deben caer en el mismo producto
  // canónico, que es lo que permitirá compararlas en el benchmark.
  if (fallos === 0) {
    console.log("✅ Las 3 facturas de demo se extrajeron correctamente con QVAC local.");
    console.log(`✅ Las 3 resolvieron al mismo producto canónico: "${PRODUCTO_CANONICO_ESPERADO}"`);
  } else {
    console.error(`\n❌ ${fallos} de ${FACTURAS_DEMO.length} facturas fallaron.`);
    process.exitCode = 1;
  }
} catch (err) {
  // Sin fallback a la nube: si QVAC falla, el test falla de forma visible.
  console.error("\n❌ El pipeline QVAC falló:");
  console.error(err);
  process.exitCode = 1;
} finally {
  if (modelos) await unloadPipeline(modelos);
}

process.exit(process.exitCode ?? 0);
