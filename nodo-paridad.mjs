// Proceso Paridad de UNA laptop: capa de red + ronda de agregacion +
// servidor LOCAL de la UI (localhost). No es un backend central: cada
// participante corre el suyo y el intercambio entre negocios va solo
// por Hyperswarm (shares y column-sums, nunca precios).
//
// Uso:
//   node nodo-paridad.mjs A --price 4700 [--product "Aceite Motor 20W50"]
//        [--quantity 4] [--port 4700] [--topic <seed>] [--no-ui]
//        [--bootstrap '<json>']   (solo tests: DHT local)
//
// El precio va en CENTAVOS y solo vive en este proceso. La UI se sirve
// en http://localhost:<port>/ y recibe el estado por SSE (/events); no
// hay dependencias nuevas (node:http).

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
const withUi = !rest.includes("--no-ui");

const items = itemSpecs.length
  ? itemSpecs.map(parseItemSpec)
  : priceCents !== undefined && /^\d+$/.test(priceCents)
    ? [{ product, priceCents: BigInt(priceCents), quantity, proveedor: argValue("--proveedor") ?? null }]
    : null;

if (!items) {
  console.error(
    'Faltan items: --price <centavos> (+ --product) o --item "Nombre:centavos:cantidad[:Proveedor]" repetible.\n' +
      "En el flujo final saldran del pipeline QVAC local."
  );
  process.exit(1);
}

// --- red + ronda ------------------------------------------------------------

const net = new ParidadNetwork(selfName, {
  ...(topicSeed ? { topicSeed } : {}),
  ...(bootstrapJson ? { bootstrap: JSON.parse(bootstrapJson) } : {}),
});
const runner = new AggregationRunner(net);

console.log(`🟢 Nodo ${selfName} — Paridad`);
console.log(`   ${items.length} producto(s) local(es); los precios nunca salen de este proceso`);

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
runner.setItems(items);

// --- chequeos de entorno (solo lectura, para las tiles de la UI) ------------

let localAiStatus = "OFFLINE";
let internetStatus = "OFFLINE";

async function checkEnvironment() {
  try {
    const res = await fetch("http://127.0.0.1:11434/v1/models", {
      signal: AbortSignal.timeout(1500),
    });
    localAiStatus = res.ok ? "ACTIVE" : "OFFLINE";
  } catch {
    localAiStatus = "OFFLINE";
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
    settings: {
      port,
      group: topicSeed ?? "paridad-network-v1",
      participants: net.participants,
      // La carpeta vigilada llegara con la integracion del pipeline QVAC.
      invoiceFolder: null,
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
