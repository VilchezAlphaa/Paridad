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
import { abrirHistorial, idDeFactura, COMPARACION, MIN_PARTICIPANTES_COMPARACION } from "./src/extraction/historial.mjs";

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

// Arrancar sin fuente de datos es valido: la UI permite anadir facturas
// (Agregar factura) y el historial local puede tener compras anteriores.
if (!cliItems.length && !facturas.length && !carpeta) {
  console.log(
    "   Sin facturas ni items por CLI: anade facturas desde la UI (Agregar factura),\n" +
      "   o arranca con --factura <imagen> | --carpeta <dir> | --item \"Nombre:centavos:cantidad\""
  );
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

// --- historial local + items de ronda ----------------------------------------
//
//   factura → extracción local → HISTORIAL LOCAL → comparación cuando haya datos
//
// El historial guarda TODOS los productos de cada factura (uno por línea) en
// un JSON del dispositivo. A la ronda P2P solo llega, por producto canónico,
// el último precio conocido: la ronda ya existía y no cambia; lo nuevo es
// que ningún producto sobreescribe a otro y que todo sobrevive al reinicio.
const datosDir = path.resolve(argValue("--datos") ?? path.join(__dirname, "data", `nodo-${selfName}`));
const facturasSubidasDir = path.join(datosDir, "facturas");
const historial = abrirHistorial({ ruta: path.join(datosDir, "historial.json"), nodo: selfName });

/**
 * Items que entran en la ronda.
 *
 * Dos modos que NO se mezclan:
 *   - con --item (demo:items, tests de red): exactamente lo que dio la CLI;
 *   - sin --item (modo producto): el último precio por producto canónico
 *     del historial local.
 * Si se mezclaran, un historial que quedara en data/ de una sesión anterior
 * se colaría en los tests de red y cambiaría lo que esperan.
 */
function itemsParaRonda() {
  if (cliItems.length) return [...cliItems];

  return historial.ultimoPorProducto().map((r) => ({
    product: r.productCanonical,
    display: r.product,
    priceCents: BigInt(r.unitPriceCents),
    quantity: r.quantity,
    proveedor: null,
  }));
}

function sincronizarRonda() {
  const items = itemsParaRonda();
  if (items.length) runner.setItems(items);
}

// Lo que ya había en el historial entra en ronda desde el arranque.
sincronizarRonda();

/**
 * CAPA DE COMPARACIÓN (preparada para la fase 2).
 *
 * Único punto donde el historial se cruza con el resultado de agregación.
 * Hoy lee el resultado de la ronda por producto que ya calcula el runner;
 * cuando exista la comparación por producto con umbral, se conecta aquí y
 * ni el historial ni la UI tienen que cambiar.
 *
 * Regla de privacidad: sin al menos MIN_PARTICIPANTES_COMPARACION
 * participantes válidos para ese producto no se expone ninguna referencia.
 */
function estadoComparacion(productCanonical, itemsDeRonda) {
  const item = itemsDeRonda.get(productCanonical);
  if (item?.result && item.result.participants >= MIN_PARTICIPANTES_COMPARACION) {
    return {
      estado: COMPARACION.DISPONIBLE,
      referencia: item.result.averageCents / 100,
      posicionPct: item.result.positionPercent,
      participantes: item.result.participants,
    };
  }
  if (item?.status === "NOT_COMMON") {
    return { estado: COMPARACION.NO_DISPONIBLE, motivo: "no hay suficientes negocios con este producto" };
  }
  return { estado: COMPARACION.PENDIENTE };
}

function mapaItemsDeRonda() {
  return new Map(runner.getState().items.map((item) => [item.product, item]));
}

runner.on("result", (result) => {
  historial.marcarComparacion(result.product, estadoComparacion(result.product, mapaItemsDeRonda()));
});

// --- extracción local de facturas (pipeline QVAC) ---------------------------
//
// Se importa en diferido: un nodo que nunca procesa facturas no carga el SDK
// de QVAC. El pipeline corre EN este proceso (no usa el servidor http de
// QVAC) y tiene respaldo automático a CPU si la GPU falla.
//
// Es un worker de cola SECUENCIAL: carga los modelos, procesa lo que haya en
// cola, y si no hay carpeta que vigilar los libera al terminar. Así:
//   - nunca hay dos OCR a la vez en este proceso;
//   - la GPU queda libre entre lotes (tres contextos OCR en Vulkan a la vez
//     tumban el worker de QVAC en esta máquina);
//   - una factura añadida desde la UI más tarde vuelve a cargar los modelos
//     sola.
//
// Ciclo de vida de `extraction.status` (lo pinta la UI tal cual):
//   IDLE        nada en marcha; puede haber facturas pendientes (--manual)
//   LOADING_AI  cargando los modelos QVAC en este dispositivo
//   PROCESSING  extrayendo producto(s) y precio(s) de una factura
//   READY       modelos cargados y en reposo (solo con --carpeta)
//   DONE        lote procesado y modelos liberados
//   ERROR       el pipeline no arrancó o falló
const extraction = {
  status: "IDLE",
  currentFile: null,
  steps: null,
  processed: 0,
  pendientes: 0,
  folder: carpeta,
  error: null,
  ultimaFactura: null, // { id, archivo, lineas, procesadaEn }
};

const cola = [];
const processedFiles = new Set();
let trabajando = false;
let sesionPersistente = null; // solo con --carpeta: los modelos se quedan cargados

function encolarFactura(ruta, { inmediato }) {
  const clave = path.normalize(ruta).toLowerCase();
  if (processedFiles.has(clave)) return false;
  processedFiles.add(clave);
  cola.push(ruta);
  extraction.pendientes = cola.length;
  broadcastUiState();
  if (inmediato) void trabajar();
  return true;
}

async function procesarFactura(pipeline, sesion, ruta) {
  const nombre = path.basename(ruta);
  extraction.status = "PROCESSING";
  extraction.currentFile = nombre;
  extraction.steps = { cargada: true, ia: true, producto: false, precio: false };
  extraction.error = null;
  broadcastUiState();
  console.log(`   [ia] procesando ${nombre}...`);

  try {
    const resultado = await pipeline.extractInvoiceItems({ sesion, imagePath: ruta });
    for (const item of resultado.items) {
      const errores = pipeline.validateExtraction(item);
      if (errores.length) throw new Error(`línea "${item.product}": ${errores.join("; ")}`);
    }

    extraction.steps.producto = true;
    extraction.steps.precio = true;

    // La factura, el texto OCR y todo lo de _local se quedan aquí. Al
    // historial van las líneas; a la ronda, el último precio por producto.
    const facturaId = idDeFactura(ruta);
    const { msOcr, msLlm, ocrBackend } = resultado._local;
    const registros = historial.registrar(
      { id: facturaId, archivo: nombre, ocrBackend, msOcr, msLlm },
      resultado.items
    );
    sincronizarRonda();

    extraction.processed++;
    extraction.ultimaFactura = {
      id: facturaId,
      archivo: nombre,
      lineas: registros.length,
      procesadaEn: registros[0].procesadaEn,
    };

    console.log(
      `   [ia] ${nombre}: ${registros.length} producto(s) registrados localmente — precios extraídos en este dispositivo (no se muestran en logs de red)`
    );

    // Evidencia auditable de que la factura pasó por QVAC en ESTE
    // dispositivo: backend real y tiempos de OCR/LLM. Los precios NO se
    // imprimen a propósito: en la demo local los tres stdout se mezclan en
    // la misma terminal y ver los precios de todos contradiría el relato.
    // Cada nodo sí expone los suyos en su propia UI (/api/state).
    resultado.items.forEach((item, i) => {
      console.log(
        `PARIDAD_EXTRACCION ${JSON.stringify({
          nodo: selfName,
          archivo: nombre,
          facturaId,
          linea: i + 1,
          lineas: resultado.items.length,
          product: item.product,
          product_canonical: item.product_canonical,
          quantity: item.quantity,
          ocrBackend,
          msOcr,
          msLlm,
        })}`
      );
    });
    console.log(
      `PARIDAD_FACTURA_REGISTRADA ${JSON.stringify({ nodo: selfName, archivo: nombre, facturaId, lineas: registros.length })}`
    );
  } catch (err) {
    extraction.error = `${nombre}: ${err.message}`;
    console.warn(`   ⚠️  [ia] fallo extrayendo ${nombre}: ${err.message}`);
  } finally {
    extraction.currentFile = null;
    extraction.pendientes = cola.length;
    broadcastUiState();
  }
}

async function trabajar() {
  if (trabajando || cola.length === 0) return;
  trabajando = true;

  let pipeline = null;
  let sesion = sesionPersistente;
  try {
    pipeline = await import("./src/extraction/invoice-pipeline.mjs");

    if (!sesion) {
      extraction.status = "LOADING_AI";
      localAiStatus = "LOADING";
      broadcastUiState();
      sesion = await pipeline.loadPipeline(ocrBackend ? { backendDevice: ocrBackend } : {});
      console.log(`   [ia] pipeline QVAC cargado (OCR en ${sesion.ocrBackend})`);
    }
    localAiStatus = "ACTIVE";
    extraction.status = "READY";
    broadcastUiState();

    while (cola.length) {
      await procesarFactura(pipeline, sesion, cola.shift());
    }
  } catch (err) {
    extraction.status = "ERROR";
    extraction.error = err.message;
    localAiStatus = "OFFLINE";
    console.error(`   💥 [ia] no se pudo iniciar el pipeline de extracción: ${err.message}`);
  } finally {
    if (sesion && carpeta) {
      // Vigilando una carpeta merece la pena dejar los modelos cargados.
      sesionPersistente = sesion;
      if (extraction.status !== "ERROR") extraction.status = "READY";
    } else if (sesion) {
      // Sin carpeta, la IA ya no hace falta: liberar devuelve ~400 MB y,
      // sobre todo, suelta la GPU para el siguiente nodo o el siguiente lote.
      await pipeline.unloadPipeline(sesion);
      if (extraction.status !== "ERROR") extraction.status = "DONE";
      localAiStatus = "DONE";
      console.log(
        `PARIDAD_EXTRACCION_LISTA ${JSON.stringify({ nodo: selfName, procesadas: extraction.processed })}`
      );
    }
    trabajando = false;
    extraction.pendientes = cola.length;
    broadcastUiState();
    // Si entró algo mientras liberábamos, se atiende en un lote nuevo.
    if (cola.length) void trabajar();
  }
}

/** Disparo explícito (botón de la UI o --manual): procesa lo que esté en cola. */
function dispararExtraccion() {
  return trabajar();
}

// Facturas configuradas por CLI. Con --manual quedan en cola hasta que
// alguien pulse el botón en la UI; sin el flag arrancan solas.
// setImmediate: el resto del módulo (estado de UI, servidor) debe terminar
// de evaluarse antes de que la extracción toque ese estado.
setImmediate(() => {
  for (const ruta of facturas) encolarFactura(path.resolve(ruta), { inmediato: false });
  if (facturas.length && !manual) void trabajar();
});

if (carpeta) {
  const dir = path.resolve(carpeta);
  // Al arrancar se procesan las facturas que ya estén en la carpeta...
  setImmediate(() => {
    for (const nombre of fs.readdirSync(dir)) {
      if (/\.(png|jpe?g)$/i.test(nombre)) encolarFactura(path.join(dir, nombre), { inmediato: false });
    }
    void trabajar();
  });
  // ...y después se vigila para detectar las nuevas. El debounce da
  // tiempo a que el archivo termine de copiarse.
  const pendientesWatch = new Map();
  fs.watch(dir, (_event, nombre) => {
    if (!nombre || !/\.(png|jpe?g)$/i.test(nombre)) return;
    clearTimeout(pendientesWatch.get(nombre));
    pendientesWatch.set(
      nombre,
      setTimeout(() => {
        pendientesWatch.delete(nombre);
        const ruta = path.join(dir, nombre);
        if (fs.existsSync(ruta)) encolarFactura(ruta, { inmediato: true });
      }, 1500)
    );
  });
  console.log(`   [ia] vigilando carpeta de facturas: ${dir}`);
}

// --- chequeos de entorno (solo lectura, para las tiles de la UI) ------------

// IDLE | LOADING | ACTIVE | DONE | OFFLINE.
// Con facturas configuradas arranca en IDLE ("va a procesar"), no en
// OFFLINE: decir OFFLINE mientras la IA local esta a punto de trabajar
// -- o trabajando -- era justo lo contrario de lo que pasa.
let localAiStatus = "IDLE";
let internetStatus = "OFFLINE";

async function checkEnvironment() {
  // El estado de la IA local lo gobierna el propio pipeline (in-process).
  // Antes, sin extracción configurada, se sondeaba el servidor http de QVAC
  // y se pintaba ACTIVE si estaba corriendo: engañoso, porque Paridad no lo
  // usa para nada. Ahora sin facturas procesadas la IA figura EN ESPERA.

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
    extraction: { ...extraction, pendientes: cola.length },
    // Historial local: TODOS los productos de TODAS las facturas de este
    // nodo, con su precio (es el dispositivo del propio usuario) y el
    // estado de comparacion calculado en la capa de comparacion.
    historial: (() => {
      const itemsDeRonda = mapaItemsDeRonda();
      return {
        resumen: historial.resumen(),
        facturas: historial.facturas(),
        registros: historial.todos().map((r) => ({
          id: r.id,
          facturaId: r.facturaId,
          archivo: r.archivo,
          procesadaEn: r.procesadaEn,
          product: r.product,
          productCanonical: r.productCanonical,
          quantity: r.quantity,
          unitPrice: r.unitPriceCents / 100,
          comparacion: estadoComparacion(r.productCanonical, itemsDeRonda),
        })),
      };
    })(),
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

    // "Agregar factura": el navegador manda la imagen al proceso LOCAL (mismo
    // dispositivo, localhost). Se guarda en el directorio de datos del nodo y
    // entra en la cola de extraccion. No sale de aqui.
    if (pathname === "/api/factura" && req.method === "POST") {
      const nombreCrudo = decodeURIComponent(req.headers["x-nombre"] ?? "factura.png");
      const nombre = path.basename(nombreCrudo).replace(/[^\w.\-]+/g, "_");
      if (!/\.(png|jpe?g)$/i.test(nombre)) {
        res.writeHead(415, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Solo se aceptan imagenes PNG o JPG" }));
        return;
      }

      const LIMITE = 15 * 1024 * 1024;
      const trozos = [];
      let bytes = 0;
      req.on("data", (d) => {
        bytes += d.length;
        if (bytes > LIMITE) {
          req.destroy();
          return;
        }
        trozos.push(d);
      });
      req.on("end", () => {
        if (bytes === 0 || bytes > LIMITE) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Archivo vacio o demasiado grande (max 15 MB)" }));
          return;
        }
        fs.mkdirSync(facturasSubidasDir, { recursive: true });
        const ruta = path.join(facturasSubidasDir, `${Date.now()}-${nombre}`);
        fs.writeFileSync(ruta, Buffer.concat(trozos));
        const encolada = encolarFactura(ruta, { inmediato: true });
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, archivo: path.basename(ruta), encolada }));
      });
      return;
    }

    // Disparo manual de la extraccion desde el boton de la UI. Es
    // idempotente: trabajar() ignora las llamadas mientras ya esta en marcha.
    if (pathname === "/api/procesar") {
      if (cola.length === 0) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "No hay facturas pendientes de procesar" }));
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
