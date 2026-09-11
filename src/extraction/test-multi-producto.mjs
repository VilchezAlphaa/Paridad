/**
 * Test con QVAC REAL: una factura de varios productos → historial local.
 *
 *   npm run test:multi
 *
 * No forma parte de `npm test` (necesita los modelos y ~1 min). Comprueba:
 *   1. la factura de 5 líneas produce 5 registros con los precios exactos;
 *   2. una segunda factura (1 línea) se AÑADE: 6 registros, nada desaparece;
 *   3. la UI (/api/state) expone todos los registros con su precio propio;
 *   4. reiniciar el nodo conserva el historial sin volver a pasar por QVAC;
 *   5. por la red no viaja ningún precio ni el historial: solo nombres de
 *      producto, shares y sumas parciales (auditoría de cable).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createTestnet from "hyperdht/testnet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..", "..");
const NODO = path.join(REPO, "nodo-paridad.mjs");
const FACTURAS = path.join(REPO, "demo-data", "facturas");
const PUERTO = 4820;

// Lo que dice la imagen factura-demo-multi.png (ver tools/generar-factura-multi.ps1).
const ESPERADO_MULTI = [
  { canon: "aceite motor 20w50", quantity: 4, cents: 4700 },
  { canon: "filtro de aceite", quantity: 12, cents: 680 },
  { canon: "pastillas de freno delant", quantity: 6, cents: 2850 },
  { canon: "bateria 12v 650a", quantity: 2, cents: 7800 },
  { canon: "bujias de encendido x4", quantity: 8, cents: 1640 },
];

const datosDir = fs.mkdtempSync(path.join(os.tmpdir(), "paridad-multi-"));
const testnet = await createTestnet(3);
const topic = `paridad-test-multi-${process.pid}`;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let fallos = 0;
function comprobar(cond, msg) {
  if (cond) console.log(`  ✅ ${msg}`);
  else {
    console.error(`  ❌ ${msg}`);
    fallos++;
  }
}

function lanzarNodo(facturas, { nombre = "A", puerto = PUERTO, extra = [] } = {}) {
  const hijo = spawn(
    process.execPath,
    [
      NODO, nombre,
      "--port", String(puerto),
      "--topic", topic,
      "--bootstrap", JSON.stringify(testnet.bootstrap),
      "--datos", nombre === "A" ? datosDir : path.join(datosDir, nombre),
      ...facturas.flatMap((f) => ["--factura", path.join(FACTURAS, f)]),
      ...extra,
    ],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PARIDAD_WIRE_AUDIT: "1" } }
  );
  let salida = "";
  hijo.stdout.on("data", (d) => (salida += d));
  hijo.stderr.on("data", (d) => (salida += d));
  return { hijo, leer: () => salida };
}

async function esperarLinea(nodo, marcador, ms) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (nodo.leer().includes(marcador)) return true;
    if (nodo.leer().includes("💥")) return false;
    await esperar(1000);
  }
  return false;
}

async function estado() {
  return (await fetch(`http://127.0.0.1:${PUERTO}/api/state`)).json();
}

function matar(nodo) {
  return new Promise((resolve) => {
    nodo.hijo.on("close", resolve);
    nodo.hijo.kill();
  });
}

console.log("🧪 Factura de varios productos → historial local (QVAC real)\n");

// B y C participan con el aceite por CLI (sin QVAC): así hay ronda real
// para el producto común y tráfico que auditar. Sus precios son los de la
// demo (3100 y 5200), que con el 4700 de A dan la referencia conocida.
const peers = [
  lanzarNodo([], { nombre: "B", puerto: PUERTO + 1, extra: ["--item", "aceite motor 20w50:3100:6", "--no-ui"] }),
  lanzarNodo([], { nombre: "C", puerto: PUERTO + 2, extra: ["--item", "aceite motor 20w50:5200:3", "--no-ui"] }),
];

try {
  // --- 1. factura multi + factura de una línea, en el mismo nodo --------------
  const n1 = lanzarNodo(["factura-demo-multi.png", "factura-demo-a.png"]);
  const ok = await esperarLinea(n1, "PARIDAD_EXTRACCION_LISTA", 240_000);
  assert.ok(ok, "el nodo terminó de extraer");

  let s = await estado();
  console.log("▸ Extracción de 2 facturas (5 líneas + 1 línea):");
  comprobar(s.historial.resumen.facturas === 2, `2 facturas procesadas (${s.historial.resumen.facturas})`);
  comprobar(s.historial.resumen.productos === 6, `6 registros en total (${s.historial.resumen.productos})`);
  comprobar(s.historial.resumen.productosDistintos === 5, `5 productos distintos (${s.historial.resumen.productosDistintos})`);

  const multi = s.historial.registros.filter((r) => r.archivo === "factura-demo-multi.png");
  comprobar(multi.length === 5, `la factura multi generó 5 registros (${multi.length})`);
  comprobar(new Set(multi.map((r) => r.facturaId)).size === 1, "los 5 pertenecen a la misma factura");

  for (const e of ESPERADO_MULTI) {
    const r = multi.find((x) => x.productCanonical === e.canon);
    comprobar(
      r && Math.round(r.unitPrice * 100) === e.cents && r.quantity === e.quantity,
      `${e.canon}: ${e.quantity} x ${e.cents} centavos` + (r ? ` (obtuvo ${r.quantity} x ${Math.round(r.unitPrice * 100)})` : " (NO ENCONTRADO)")
    );
  }

  const unaLinea = s.historial.registros.filter((r) => r.archivo === "factura-demo-a.png");
  comprobar(unaLinea.length === 1 && Math.round(unaLinea[0].unitPrice * 100) === 4700, "la segunda factura añadió su línea (4700) sin borrar las 5 anteriores");
  comprobar(s.historial.registros.every((r) => r.comparacion?.estado), "todos los registros llevan estado de comparación");
  comprobar(s.items.length === 5, `a la ronda entran 5 productos distintos (${s.items.length})`);

  // --- 1b. capa de comparación: el producto común compara, los demás no ------
  console.log("\n▸ Capa de comparación (con B y C en la red):");
  {
    const fin = Date.now() + 90_000;
    while (Date.now() < fin) {
      s = await estado();
      const aceite = s.historial.registros.find((r) => r.productCanonical === "aceite motor 20w50");
      if (aceite?.comparacion?.estado === "DISPONIBLE") break;
      await esperar(1000);
    }
  }
  const aceites = s.historial.registros.filter((r) => r.productCanonical === "aceite motor 20w50");
  comprobar(
    aceites.length === 2 && aceites.every((r) => r.comparacion.estado === "DISPONIBLE"),
    "las 2 líneas de aceite (una por factura) tienen comparación DISPONIBLE"
  );
  const cmp = aceites[0]?.comparacion ?? {};
  comprobar(Math.abs((cmp.referencia ?? 0) - 43.33) < 0.01, `referencia del grupo $${cmp.referencia?.toFixed(2)} (esperada $43.33)`);
  comprobar(Math.abs((cmp.posicionPct ?? 0) - 8.5) < 0.1, `posición +${cmp.posicionPct?.toFixed(1)}% (esperada +8.5%)`);
  comprobar(cmp.participantes === 3, `${cmp.participantes} participantes (regla: mínimo 3)`);
  const otros = s.historial.registros.filter((r) => r.productCanonical !== "aceite motor 20w50");
  comprobar(
    otros.length === 4 && otros.every((r) => r.comparacion.estado === "NO_DISPONIBLE"),
    "los otros 4 productos quedan en el historial con «Sin comparación disponible», sin referencia inventada"
  );
  comprobar(otros.every((r) => r.comparacion.referencia === undefined), "ningún producto sin grupo lleva referencia");

  // --- 2. la UI muestra todos: /api/state es exactamente lo que pinta ----------
  console.log("\n▸ Lo que ve la UI:");
  comprobar(
    s.historial.registros.length === 6 && s.historial.registros.every((r) => typeof r.unitPrice === "number"),
    "los 6 registros llegan a la UI con su precio propio"
  );

  // --- 3. auditoría de cable: el historial no sale del proceso ----------------
  console.log("\n▸ Auditoría de red:");
  const wire = n1.leer().split(/\r?\n/).filter((l) => l.startsWith("PARIDAD_WIRE "));
  const tipos = new Set(wire.map((l) => JSON.parse(l.slice(13)).type));
  comprobar(wire.length > 0, `se capturó tráfico (${wire.length} mensajes; tipos: ${[...tipos].join(", ")})`);
  comprobar([...tipos].every((t) => ["hello", "products", "share", "column-sum"].includes(t)), "solo viajan los 4 tipos del protocolo");
  const textoWire = wire.join("\n");
  const precios = ["4700", "680", "2850", "7800", "1640"];
  const valoresWire = new Set();
  for (const l of wire) {
    const visitar = (v) => {
      if (v === null || v === undefined) return;
      if (typeof v === "object") return Object.values(v).forEach(visitar);
      valoresWire.add(String(v));
    };
    visitar(JSON.parse(l.slice(13)));
  }
  comprobar(precios.every((p) => !valoresWire.has(p)), "ningún precio del historial viajó como valor");
  comprobar(!/unitPrice|unitPriceCents|facturaId|procesadaEn|historial/.test(textoWire), "ningún campo del historial viajó por la red");
  comprobar(!/PRECIO UNITARIO|P\.UNIT|RUC|FACTURA No/.test(textoWire), "ningún texto OCR viajó por la red");

  const archivoHistorial = path.join(datosDir, "historial.json");
  comprobar(fs.existsSync(archivoHistorial), `el historial está en disco: ${archivoHistorial}`);

  await matar(n1);

  // --- 4. reinicio: sin --factura, el historial sigue y QVAC no se carga --------
  console.log("\n▸ Reinicio del nodo (sin facturas por CLI):");
  const n2 = lanzarNodo([]);
  await esperar(4000);
  s = await estado();
  comprobar(s.historial.resumen.productos === 6, `tras reiniciar siguen los 6 registros (${s.historial.resumen.productos})`);
  comprobar(s.items.length === 5, "y los 5 productos vuelven a entrar en ronda");
  comprobar(!n2.leer().includes("pipeline QVAC cargado"), "no se volvió a cargar QVAC: no había nada que procesar");
  comprobar(s.localAi.status === "IDLE", `IA local EN ESPERA, no OFFLINE (${s.localAi.status})`);

  // --- 5. reprocesar la misma factura no duplica --------------------------------
  console.log("\n▸ Reprocesar la misma factura:");
  await matar(n2);
  const n3 = lanzarNodo(["factura-demo-multi.png"]);
  await esperarLinea(n3, "PARIDAD_EXTRACCION_LISTA", 240_000);
  s = await estado();
  comprobar(s.historial.resumen.productos === 6, `sigue habiendo 6 registros, no 11 (${s.historial.resumen.productos})`);
  comprobar(s.historial.resumen.facturas === 2, "y 2 facturas, no 3");
  await matar(n3);
} catch (err) {
  console.error(`\n💥 ${err.message}`);
  fallos++;
} finally {
  for (const p of peers) p.hijo.kill();
  await testnet.destroy();
  fs.rmSync(datosDir, { recursive: true, force: true });
}

console.log("\n" + "═".repeat(66));
if (fallos === 0) {
  console.log("✅ Factura multi-producto → historial local: OK.");
  process.exit(0);
} else {
  console.error(`❌ ${fallos} comprobación(es) fallaron.`);
  process.exit(1);
}
