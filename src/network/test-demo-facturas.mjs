// Test de la DEMO DE PRODUCTO: factura -> QVAC local -> P2P -> referencia.
//
// A diferencia de test-aggregation-e2e.mjs (que inyecta precios por CLI
// para probar solo la red), aqui los precios los produce el OCR real. Por
// eso este test NO forma parte de `npm test`: necesita los modelos de QVAC
// y tarda ~1,5 min.
//
//   npm run test:demo
//
// Comprueba:
//   1. cada nodo ejecuta QVAC de verdad (backend y tiempos reales);
//   2. el precio extraido es el de su factura;
//   3. la agregacion da 13000 / 4333.33 y las posiciones correctas;
//   4. por la red NO viaja ningun precio ni nada del contenido OCR.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createTestnet from "hyperdht/testnet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..", "..");
const NODO = path.join(REPO, "nodo-paridad.mjs");
const FACTURAS = path.join(REPO, "demo-data", "facturas");

const CASOS = [
  { nombre: "A", puerto: 4810, factura: "factura-demo-a.png", cents: 4700, posicion: 8.5 },
  { nombre: "B", puerto: 4811, factura: "factura-demo-b.png", cents: 3100, posicion: -28.5 },
  { nombre: "C", puerto: 4812, factura: "factura-demo-c.png", cents: 5200, posicion: 20.0 },
];

const TOTAL = 13000;
const PROMEDIO = 4333.33;
const ESPERA_EXTRACCION_MS = 240_000;
const ESPERA_RONDA_MS = 120_000;

console.log("🧪 Demo de producto: factura -> QVAC local -> P2P -> referencia del grupo\n");
console.log("   (usa los modelos QVAC reales; la primera vez puede descargarlos)\n");

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperarHasta(condicion, limiteMs, queEspero) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) {
    if (await condicion()) return true;
    await esperar(1000);
  }
  throw new Error(`Tiempo agotado esperando: ${queEspero}`);
}

const testnet = await createTestnet(3);
const topic = `paridad-test-demo-${process.pid}`;
const hijos = [];

function lanzar(caso) {
  const hijo = spawn(
    process.execPath,
    [
      NODO, caso.nombre,
      "--port", String(caso.puerto),
      "--topic", topic,
      "--bootstrap", JSON.stringify(testnet.bootstrap),
      "--factura", path.join(FACTURAS, caso.factura),
    ],
    {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
      // Enciende la auditoria de cable en los tres nodos.
      env: { ...process.env, PARIDAD_WIRE_AUDIT: "1" },
    }
  );

  let salida = "";
  hijo.stdout.on("data", (d) => (salida += d.toString()));
  hijo.stderr.on("data", (d) => (salida += d.toString()));
  hijos.push(hijo);
  return { ...caso, hijo, leer: () => salida };
}

async function estado(puerto) {
  const res = await fetch(`http://127.0.0.1:${puerto}/api/state`);
  return res.json();
}

let fallos = 0;
function comprobar(condicion, mensaje) {
  if (condicion) console.log(`  ✅ ${mensaje}`);
  else {
    console.error(`  ❌ ${mensaje}`);
    fallos++;
  }
}

try {
  // --- 1. Extraccion, un nodo detras de otro (no solapar OCR) ------------
  const nodos = [];
  for (const caso of CASOS) {
    const nodo = lanzar(caso);
    nodos.push(nodo);
    await esperarHasta(
      async () => nodo.leer().includes("PARIDAD_EXTRACCION_LISTA"),
      ESPERA_EXTRACCION_MS,
      `que el nodo ${caso.nombre} termine su extraccion`
    );
    console.log(`   ▸ ${caso.nombre} extrajo su factura`);
  }

  console.log("\n▸ QVAC se ejecuto de verdad en cada nodo:");
  for (const nodo of nodos) {
    const linea = nodo
      .leer()
      .split(/\r?\n/)
      .find((l) => l.startsWith("PARIDAD_EXTRACCION "));
    const info = linea ? JSON.parse(linea.slice("PARIDAD_EXTRACCION ".length)) : null;

    comprobar(info !== null, `${nodo.nombre}: emitio evidencia de extraccion`);
    comprobar(
      info?.product_canonical === "aceite motor 20w50",
      `${nodo.nombre}: producto canonico correcto (${info?.product_canonical})`
    );
    comprobar(
      typeof info?.msOcr === "number" && info.msOcr > 200,
      `${nodo.nombre}: el OCR corrio de verdad (${info?.msOcr} ms en ${info?.ocrBackend})`
    );
    comprobar(
      typeof info?.msLlm === "number" && info.msLlm > 100,
      `${nodo.nombre}: la extraccion estructurada corrio de verdad (${info?.msLlm} ms)`
    );
  }

  // --- 2. El precio extraido es el de SU factura -------------------------
  console.log("\n▸ Cada nodo obtuvo el precio de su propia factura:");
  for (const caso of CASOS) {
    const s = await estado(caso.puerto);
    comprobar(
      Math.round(s.items[0]?.unitPrice * 100) === caso.cents,
      `${caso.nombre}: ${caso.cents} centavos desde ${caso.factura} (obtuvo ${Math.round((s.items[0]?.unitPrice ?? 0) * 100)})`
    );
  }

  // --- 3. Agregacion ------------------------------------------------------
  console.log("\n▸ Agregacion privada sobre P2P real:");
  await esperarHasta(
    async () => {
      const s = await estado(CASOS[0].puerto);
      return s.items[0]?.status === "DONE";
    },
    ESPERA_RONDA_MS,
    "que se cierre la ronda de agregacion"
  );

  for (const caso of CASOS) {
    const s = await estado(caso.puerto);
    const item = s.items[0];
    comprobar(s.network.status === "READY_FOR_AGGREGATION", `${caso.nombre}: READY_FOR_AGGREGATION`);
    // groupAverage viene en DOLARES; PROMEDIO esta en centavos.
    comprobar(
      Math.abs(item.groupAverage * 100 - PROMEDIO) < 1,
      `${caso.nombre}: referencia del grupo $${item.groupAverage?.toFixed(2)} (total ${TOTAL})`
    );
    comprobar(
      Math.abs(item.positionPercent - caso.posicion) < 0.1,
      `${caso.nombre}: posicion ${item.positionPercent?.toFixed(1)}% (esperada ${caso.posicion}%)`
    );
    comprobar(s.cloudAi?.used === false, `${caso.nombre}: la UI declara Cloud AI NO USADA`);
  }

  // --- 4. Auditoria de cable ----------------------------------------------
  console.log("\n▸ Auditoria: que sale realmente por la red:");

  const TIPOS_PERMITIDOS = new Set(["hello", "products", "share", "column-sum"]);
  // Trozos del texto OCR de las facturas demo que jamas deben cruzar la red.
  const RASTROS_DE_FACTURA = ["PRECIO UNITARIO", "FACTURA No", "RUC", "TOTAL A PAGAR", "DISTRIBUIDORA", "SUMINISTROS", "IMPORTADORA"];
  const PRECIOS = CASOS.map((c) => String(c.cents));

  let mensajes = 0;
  const tiposVistos = new Set();
  const valores = new Set();

  for (const nodo of nodos) {
    for (const linea of nodo.leer().split(/\r?\n/)) {
      if (!linea.startsWith("PARIDAD_WIRE ")) continue;
      mensajes++;
      const m = JSON.parse(linea.slice("PARIDAD_WIRE ".length));
      tiposVistos.add(m.type);
      const visitar = (v) => {
        if (v === null || v === undefined) return;
        if (typeof v === "object") return Object.values(v).forEach(visitar);
        valores.add(String(v));
      };
      visitar(m);
    }
  }

  console.log(`  Mensajes auditados: ${mensajes} — tipos: ${[...tiposVistos].join(", ")}`);
  comprobar(mensajes > 0, "se capturo trafico de red para auditar");
  comprobar(
    [...tiposVistos].every((t) => TIPOS_PERMITIDOS.has(t)),
    `solo viajan los tipos del protocolo (${[...TIPOS_PERMITIDOS].join(", ")})`
  );

  // Comparacion por valor, no por subcadena: los shares son enteros de ~39
  // digitos y "4700" puede aparecer dentro por azar sin ser una fuga.
  const filtrados = PRECIOS.filter((p) => valores.has(p));
  comprobar(
    filtrados.length === 0,
    `ningun precio individual viajo por la red${filtrados.length ? ` — FILTRADOS: ${filtrados.join(", ")}` : ""}`
  );

  const wireCompleto = nodos
    .map((n) => n.leer().split(/\r?\n/).filter((l) => l.startsWith("PARIDAD_WIRE ")).join("\n"))
    .join("\n");
  const rastros = RASTROS_DE_FACTURA.filter((r) => wireCompleto.includes(r));
  comprobar(
    rastros.length === 0,
    `ningun trozo del texto OCR de las facturas viajo por la red${rastros.length ? ` — VISTOS: ${rastros.join(", ")}` : ""}`
  );
} catch (err) {
  console.error(`\n💥 ${err.message}`);
  fallos++;
} finally {
  for (const hijo of hijos) hijo.kill();
  await testnet.destroy();
}

console.log("\n" + "═".repeat(66));
if (fallos === 0) {
  console.log("✅ Demo de producto (factura -> QVAC -> P2P -> referencia): OK.");
  process.exit(0);
} else {
  console.error(`❌ Demo de producto: ${fallos} comprobacion(es) fallaron.`);
  process.exit(1);
}
