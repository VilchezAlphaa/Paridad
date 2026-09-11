// Proceso Paridad de UNA laptop: extraccion local de facturas (pipeline
// QVAC de src/extraction) + capa de red + rondas de agregacion + UI
// local (localhost). No es un backend central: cada participante corre
// el suyo y el intercambio entre negocios va solo por Hyperswarm
// (nombres de producto, shares y column-sums; nunca precios ni facturas).
//
// Uso:
//   node nodo-paridad.mjs A --factura demo-data/facturas/factura-demo-a.png
//   node nodo-paridad.mjs A --carpeta C:\facturas        (vigila la carpeta)
//   node nodo-paridad.mjs A --item "aceite motor 20w50:4700:4[:Proveedor]"
//   node nodo-paridad.mjs A --price 4700 --product "..."  (item unico)
//   flags extra: --port, --topic, --no-ui, --bootstrap '<json>' (tests),
//                --ocr-backend cpu|vulkan (por defecto respeta
//                PARIDAD_OCR_BACKEND; en esta laptop Intel usar cpu)
//
// Los precios van en CENTAVOS y solo viven en este proceso. La UI se
// sirve en http://localhost:<port>/ con estado en vivo por SSE.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import { fileURLToPath } from "node:url";
import { ParidadNetwork } from "./src/network/paridad-network.mjs";
import { AggregationRunner } from "./src/network/aggregation-runner.mjs";
import { PARTICIPANTS } from "./src/privacy/aggregation-protocol.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- argumentos -------------------------------------------------------------

const [, , selfName, ...rest] = process.argv;

function argValue(flag) {
  const index = rest.indexOf(flag);
  return index !== -1 ? rest[index + 1] : undefined;
}

if (!PARTICIPANTS.includes(selfName)) {
  console.error(`Uso: node nodo-paridad.mjs <${PARTICIPANTS.join("|")}> --price <centavos> [--product <nombre>] [--port <puerto>]`);
  process.exit(1);
}

const priceCents = argValue("--price");
const product = argValue("--product") ?? "Producto de demo";
const quantity = Number(argValue("--quantity") ?? 1);

// Items locales. Cada uno corre SU PROPIA ronda P2P (multi-producto).
// Formato: --item "Nombre:centavos:cantidad[:Proveedor]", repetible
// (--queue se acepta como alias por compatibilidad). Si no hay --item,
// se usa el trio --product/--price/--quantity como unico item. Cuando
// el pipeline QVAC este integrado, esta lista saldra de las facturas.
const itemSpecs = rest.flatMap((arg, index) =>
  (arg === "--item" || arg === "--queue") && rest[index + 1] ? [rest[index + 1]] : []
);

function parseItemSpec(spec) {
  const [name, cents, qty, proveedor] = spec.split(":");
  return {
    product: name,
    priceCents: BigInt(cents),
    quantity: Number(qty ?? 1),
    proveedor: proveedor ?? null,
  };
}
const port = Number(argValue("--port") ?? 4700);
const topicSeed = argValue("--topic");
const bootstrapJson = argValue("--bootstrap");
// Alternativa a --bootstrap sin JSON: evita el infierno de escapado de
// comillas al pasar el flag entre distintas shells (PowerShell en
// particular reescribe las comillas de un argumento nativo y rompe el
// JSON). Uso real (laptops, LAN): --bootstrap-host/--bootstrap-port.
const bootstrapHost = argValue("--bootstrap-host");
const bootstrapPortArg = argValue("--bootstrap-port");
const withUi = !rest.includes("--no-ui");
// --manual: no procesar al arrancar; esperar el boton de la UI.
const manual = rest.includes("--manual");

const facturas = rest.flatMap((arg, index) => (arg === "--factura" && rest[index + 1] ? [rest[index + 1]] : []));
const carpeta = argValue("--carpeta") ?? null;
const ocrBackend = argValue("--ocr-backend"); // undefined -> default del pipeline (respeta env)

const cliItems = itemSpecs.length
  ? itemSpecs.map(parseItemSpec)
  : priceCents !== undefined && /^\d+$/.test(priceCents)
    ? [{ product, priceCents: BigInt(priceCents), quantity, proveedor: argValue("--proveedor") ?? null }]
    : [];

if (!cliItems.length && !facturas.length && !carpeta) {
  console.error(
    "Falta al menos una fuente de datos:\n" +
      "  --factura <imagen>  (extraccion QVAC local)\n" +
      "  --carpeta <dir>     (vigilar carpeta de facturas)\n" +
      '  --item "Nombre:centavos:cantidad[:Proveedor]"  |  --price <centavos>'
  );
  process.exit(1);
}

// --- red + ronda ------------------------------------------------------------

const bootstrap = bootstrapHost
  ? [{ host: bootstrapHost, port: Number(bootstrapPortArg ?? 49738) }]
  : bootstrapJson
    ? JSON.parse(bootstrapJson)
    : null;

const net = new ParidadNetwork(selfName, {
  ...(topicSeed ? { topicSeed } : {}),
  ...(bootstrap ? { bootstrap } : {}),
});
const runner = new AggregationRunner(net);

console.log(`🟢 Nodo ${selfName} — Paridad`);
console.log(
  `   ${cliItems.length} item(s) por CLI, ${facturas.length} factura(s)${carpeta ? `, carpeta vigilada: ${carpeta}` : ""} — los precios nunca salen de este proceso`
);

net.on("state", (s) => {
  console.log(`   [red] ${s.status} — peers identificados: ${s.identifiedPeers.join(", ") || "ninguno"}`);
});
net.on("error", (err) => console.warn(`   ⚠️  [red] ${err.message}`));
runner.on("protocol-error", (err) => console.warn(`   ⚠️  [ronda] ${err.message}`));
runner.on("result", (result) => {
  console.log(
    `📊 ${result.product}: promedio del grupo $${(result.averageCents / 100).toFixed(2)}, ` +
      `tu posicion ${result.positionPercent >= 0 ? "+" : ""}${result.positionPercent.toFixed(1)}% (${result.participants} participantes)`
  );
  // Linea parseable para el test end-to-end (una por producto).
  console.log(`RESULT ${JSON.stringify(result)}`);
});

net.start();

// Items vivos del nodo (CLI + los que produzca la extraccion de
// facturas). La clave de ronda es el nombre canonico del producto.
const liveItems = [...cliItems];
if (liveItems.length) runner.setItems(liveItems);

// --- extraccion local de facturas (pipeline QVAC de Pablo) ------------------
//
// Se importa en diferido: un nodo sin --factura/--carpeta no carga el
// SDK de QVAC. El pipeline corre EN este proceso (no usa el servidor
// http de QVAC) y tiene respaldo automatico a CPU si la GPU falla.

// Ciclo de vida de `extraction.status` (lo pinta la UI tal cual):
//   IDLE        hay facturas configuradas, esperando el disparo
//   LOADING_AI  cargando los modelos QVAC en este dispositivo
//   PROCESSING  extrayendo producto y precio de una factura
//   READY       modelos cargados y en reposo (solo con --carpeta)
//   DONE        cola inicial procesada y modelos liberados
//   ERROR       el pipeline no arranco o fallo
const hayFuenteDeFacturas = facturas.length > 0 || carpeta !== null;

let extraction = hayFuenteDeFacturas
  ? {
      status: "IDLE",
      currentFile: null,
      steps: null,
      processed: 0,
      total: facturas.length,
      folder: carpeta,
      error: null,
    }
  : null; // null = este nodo no extrae facturas
let extractionQueue = Promise.resolve();
let extractionStarted = false;
const processedFiles = new Set();

function upsertItem(nuevo) {
  const index = liveItems.findIndex((item) => item.product === nuevo.product);
  if (index === -1) liveItems.push(nuevo);
  else liveItems[index] = nuevo;
  runner.setItems(liveItems);
}

async function startExtraction() {
  if (!hayFuenteDeFacturas || extractionStarted) return;
  extractionStarted = true;

  extraction.status = "LOADING_AI";
  localAiStatus = "LOADING";
  broadcastUiState();

  const pipeline = await import("./src/extraction/invoice-pipeline.mjs");
  const sesion = await pipeline.loadPipeline(ocrBackend ? { backendDevice: ocrBackend } : {});
  console.log(`   [ia] pipeline QVAC cargado (OCR en ${sesion.ocrBackend})`);
  localAiStatus = "ACTIVE";
  extraction.status = "READY";
  broadcastUiState();

  async function procesarFactura(ruta) {
    const nombre = path.basename(ruta);
    extraction.status = "PROCESSING";
    extraction.currentFile = nombre;
    extraction.steps = { cargada: true, ia: true, producto: false, precio: false };
    extraction.error = null;
    broadcastUiState();
    console.log(`   [ia] procesando ${nombre}...`);

    try {
      const resultado = await pipeline.extractInvoice({ sesion, imagePath: ruta });
      const errores = pipeline.validateExtraction(resultado);
      if (errores.length) throw new Error(errores.join("; "));

      extraction.steps.producto = true;
      extraction.steps.precio = true;
      extraction.processed++;

      // La factura, el texto OCR y todo lo de _local se quedan aqui.
      upsertItem({
        product: resultado.product_canonical,
        display: resultado.product,
        priceCents: BigInt(resultado.unit_price_cents),
        quantity: resultado.quantity,
        proveedor: null,
      });
      console.log(
        `   [ia] ${nombre}: "${resultado.product_canonical}" x${resultado.quantity} — precio extraido localmente (no se muestra en logs de red)`
      );

      // Evidencia auditable de que la factura paso por QVAC en ESTE
      // dispositivo: backend real y tiempos de OCR/LLM. El precio NO se
      // imprime a proposito -- en la demo local los tres stdout se mezclan
      // en la misma terminal y ver los tres precios contradiria el relato.
      // Cada nodo si expone el suyo en su propia UI (/api/state).
      console.log(
        `PARIDAD_EXTRACCION ${JSON.stringify({
          nodo: selfName,
          archivo: nombre,
          product: resultado.product,
          product_canonical: resultado.product_canonical,
          quantity: resultado.quantity,
          ocrBackend: resultado._local.ocrBackend,
          msOcr: resultado._local.msOcr,
          msLlm: resultado._local.msLlm,
        })}`
      );
    } catch (err) {
      extraction.error = `${nombre}: ${err.message}`;
      console.warn(`   ⚠️  [ia] fallo extrayendo ${nombre}: ${err.message}`);
    } finally {
      extraction.status = "READY";
      extraction.currentFile = null;
      broadcastUiState();
    }
  }

  function encolarFactura(ruta) {
    const clave = path.normalize(ruta).toLowerCase();
    if (processedFiles.has(clave)) return;
    processedFiles.add(clave);
    extractionQueue = extractionQueue.then(() => procesarFactura(ruta));
  }

  for (const ruta of facturas) encolarFactura(path.resolve(ruta));

  if (carpeta) {
    const dir = path.resolve(carpeta);
    // Al arrancar se procesan las facturas que ya esten en la carpeta...
    for (const nombre of fs.readdirSync(dir)) {
      if (/\.(png|jpe?g)$/i.test(nombre)) encolarFactura(path.join(dir, nombre));
    }
    // ...y despues se vigila para detectar las nuevas. El debounce da
    // tiempo a que el archivo termine de copiarse.
    const pendientes = new Map();
    fs.watch(dir, (_event, nombre) => {
      if (!nombre || !/\.(png|jpe?g)$/i.test(nombre)) return;
      clearTimeout(pendientes.get(nombre));
      pendientes.set(
        nombre,
        setTimeout(() => {
          pendientes.delete(nombre);
          const ruta = path.join(dir, nombre);
          if (fs.existsSync(ruta)) encolarFactura(ruta);
        }, 1500)
      );
    });
    console.log(`   [ia] vigilando carpeta de facturas: ${dir}`);
  } else {
    // Sin carpeta que vigilar, la IA ya no hace falta cuando termina la
    // cola inicial. Liberar los modelos devuelve ~400 MB de RAM y, sobre
    // todo, suelta la GPU: tres contextos OCR en Vulkan a la vez tumban
    // el worker de QVAC en esta maquina (ver docs/pipeline-extraccion.md).
    extractionQueue = extractionQueue.then(async () => {
      const pipelineMod = await import("./src/extraction/invoice-pipeline.mjs");
      await pipelineMod.unloadPipeline(sesion);
      extraction.status = "DONE";
      localAiStatus = "DONE";
      broadcastUiState();
      console.log(
        `PARIDAD_EXTRACCION_LISTA ${JSON.stringify({ nodo: selfName, procesadas: extraction.processed })}`
      );
    });
  }
}

/** Punto unico de arranque de la extraccion (auto o desde la UI). */
function dispararExtraccion() {
  return startExtraction().catch((err) => {
    if (extraction) {
      extraction.status = "ERROR";
      extraction.error = err.message;
    }
    localAiStatus = "OFFLINE";
    broadcastUiState();
    console.error(`   💥 [ia] no se pudo iniciar el pipeline de extraccion: ${err.message}`);
  });
}

// Con --manual el nodo carga la red pero espera a que alguien pulse
// "Procesar facturas" en su UI (POST /api/procesar). Sirve para conducir
// la demo a mano; sin el flag arranca solo.
if (hayFuenteDeFacturas && !manual) {
  // setImmediate: el resto del modulo (estado de UI, servidor) debe
  // terminar de evaluarse antes de que la extraccion toque ese estado.
  setImmediate(() => void dispararExtraccion());
}

// --- chequeos de entorno (solo lectura, para las tiles de la UI) ------------

// IDLE | LOADING | ACTIVE | DONE | OFFLINE.
// Con facturas configuradas arranca en IDLE ("va a procesar"), no en
// OFFLINE: decir OFFLINE mientras la IA local esta a punto de trabajar
// -- o trabajando -- era justo lo contrario de lo que pasa.
let localAiStatus = hayFuenteDeFacturas ? "IDLE" : "OFFLINE";
let internetStatus = "OFFLINE";

async function checkEnvironment() {
  // Con el pipeline de extraccion activo, el estado de la IA local lo
  // gobierna el propio pipeline (in-process); el chequeo del servidor
  // http de QVAC solo aplica cuando no hay extraccion.
  if (extraction === null) {
    try {
      const res = await fetch("http://127.0.0.1:11434/v1/models", {
        signal: AbortSignal.timeout(1500),
      });
      localAiStatus = res.ok ? "ACTIVE" : "OFFLINE";
    } catch {
      localAiStatus = "OFFLINE";
    }
  }

  try {
    await Promise.race([
      dns.lookup("one.one.one.one"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000).unref?.()),
    ]);
    internetStatus = "ONLINE";
  } catch {
    internetStatus = "OFFLINE";
  }

  broadcastUiState();
}

checkEnvironment();
const envTimer = setInterval(checkEnvironment, 10_000);
envTimer.unref?.();

// --- estado para la UI (misma forma que mock-data.js) -----------------------

function buildUiState() {
  const netState = net.getState();
  const round = runner.getState();

  const uiItems = round.items.map((item) => ({
    product: item.product,
    display: item.display ?? item.product,
    quantity: item.quantity,
    proveedor: item.proveedor,
    unitPrice: item.unitPriceCents / 100,
    status: item.status,
    groupAverage: item.result ? item.result.averageCents / 100 : null,
    positionPercent: item.result ? item.result.positionPercent : null,
  }));

  // Ahorro potencial: en los productos donde pagas MAS que el promedio,
  // cuanto ahorrarias por ciclo de compra pagando el promedio.
  let potentialSavings = 0;
  let savingsCount = 0;
  let benchmarkedCount = 0;
  for (const item of uiItems) {
    if (item.groupAverage === null) continue;
    benchmarkedCount++;
    const diff = (item.unitPrice - item.groupAverage) * item.quantity;
    if (diff > 0) {
      potentialSavings += diff;
      savingsCount++;
    }
  }

  return {
    isMock: false,
    nodeName: selfName,
    network: {
      status: netState.status,
      identifiedPeers: netState.identifiedPeers,
      expectedPeerCount: netState.expectedPeerCount,
    },
    localAi: { status: localAiStatus, model: "qwen3-600m-inst-q4" },
    // Indicador honesto y estatico: Paridad no tiene ninguna ruta hacia un
    // servicio de inferencia externo. No se deduce del estado de internet,
    // que es otra cosa distinta y confundia al leer la cabecera.
    cloudAi: { used: false },
    internet: { status: internetStatus },
    privacy: {
      sharesExchanged: round.sharesSent,
      note: "Tus precios nunca salen de tu dispositivo. Solo se comparten fragmentos matematicos (shares), nunca los valores reales.",
    },
    items: uiItems,
    summary: {
      potentialSavings,
      savingsCount,
      benchmarkedCount,
      totalItems: uiItems.length,
      participants: net.participants.length,
    },
    extraction: extraction ?? { status: "DISABLED" },
    settings: {
      port,
      group: topicSeed ?? "paridad-network-v1",
      participants: net.participants,
      invoiceFolder: carpeta,
    },
  };
}

// --- servidor local de UI + SSE ---------------------------------------------

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

const sseClients = new Set();

function broadcastUiState() {
  if (!sseClients.size) return;
  const data = `data: ${JSON.stringify(buildUiState())}\n\n`;
  for (const res of sseClients) res.write(data);
}

net.on("state", broadcastUiState);
net.on("peer:identified", broadcastUiState);
net.on("peer:disconnected", broadcastUiState);
runner.on("update", broadcastUiState);

let server = null;
if (withUi) {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, `http://localhost:${port}`).pathname;

    if (pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(buildUiState()));
      return;
    }

    // Disparo manual de la extraccion desde el boton de la UI. Es
    // idempotente: startExtraction() ignora las llamadas repetidas.
    if (pathname === "/api/procesar") {
      if (!hayFuenteDeFacturas) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Este nodo no tiene facturas configuradas" }));
        return;
      }
      void dispararExtraccion();
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(buildUiState())}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // La UI vive bajo /src/ui/ (mismas rutas que `npm run ui`) para que
    // sus imports y hrefs relativos resuelvan igual en ambos servidores.
    if (pathname === "/") {
      res.writeHead(302, { location: "/src/ui/" });
      res.end();
      return;
    }

    // Archivos estaticos: solo /src/**.
    const target = pathname === "/src/ui/" ? "/src/ui/index.html" : pathname;
    const filePath = path.normalize(path.join(__dirname, target));
    const allowedRoot = path.join(__dirname, "src") + path.sep;
    if (!filePath.startsWith(allowedRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("No encontrado");
      return;
    }

    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    });
    fs.createReadStream(filePath).pipe(res);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`   UI local: http://localhost:${port}/`);
  });
}

// --- apagado limpio (mismo patron validado en p2p-privacy-test.mjs) ---------

let shuttingDown = false;

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n🛑 Cerrando nodo ${selfName} (${reason})...`);

  const forceExit = setTimeout(() => process.exit(exitCode || 1), 5000);
  forceExit.unref?.();

  try {
    for (const res of sseClients) res.end();
    if (server) server.close();
    await net.destroy();
  } finally {
    process.exit(exitCode);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  console.error(`💥 Nodo ${selfName}: excepcion no capturada`, err);
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`💥 Nodo ${selfName}: promesa rechazada sin manejar`, reason);
  void shutdown("unhandledRejection", 1);
});
