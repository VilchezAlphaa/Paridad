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

// Productos adicionales SOLO para mostrar en la lista "Lo que mas
// compras" como "en cola" (cada ronda cubre un producto; estos esperan
// la suya). Formato: --queue "Nombre:centavos:cantidad", repetible.
// Cuando el pipeline QVAC este integrado, esta lista saldra de las
// facturas detectadas, no de argumentos.
const queuedItems = rest
  .flatMap((arg, index) => (arg === "--queue" && rest[index + 1] ? [rest[index + 1]] : []))
  .map((spec) => {
    const [name, cents, qty] = spec.split(":");
    return { product: name, quantity: Number(qty ?? 1), unitPrice: Number(cents) / 100 };
  });
const port = Number(argValue("--port") ?? 4700);
const topicSeed = argValue("--topic");
const bootstrapJson = argValue("--bootstrap");
const withUi = !rest.includes("--no-ui");

if (priceCents === undefined || !/^\d+$/.test(priceCents)) {
  console.error("Falta --price <centavos> (entero; ej: 4700 = S/ 47.00). En el flujo final saldra del pipeline QVAC local.");
  process.exit(1);
}

// --- red + ronda ------------------------------------------------------------

const net = new ParidadNetwork(selfName, {
  ...(topicSeed ? { topicSeed } : {}),
  ...(bootstrapJson ? { bootstrap: JSON.parse(bootstrapJson) } : {}),
});
const runner = new AggregationRunner(net);

console.log(`🟢 Nodo ${selfName} — Paridad`);
console.log(`   Precio local: ${priceCents} centavos (nunca sale de este proceso)`);

net.on("state", (s) => {
  console.log(`   [red] ${s.status} — peers identificados: ${s.identifiedPeers.join(", ") || "ninguno"}`);
});
net.on("error", (err) => console.warn(`   ⚠️  [red] ${err.message}`));
runner.on("protocol-error", (err) => console.warn(`   ⚠️  [ronda] ${err.message}`));
runner.on("update", () => {
  const { roundState, sharesSent, sharesReceived } = runner.getState();
  console.log(`   [ronda] ${roundState} — shares enviados: ${sharesSent}, recibidos: ${sharesReceived}`);
});
runner.on("result", (result) => {
  console.log(`\n📊 Benchmark (calculado localmente por ${selfName}, sin servidor central):`);
  console.log(`   Promedio del grupo: S/ ${(result.averageCents / 100).toFixed(2)}`);
  console.log(`   Tu posicion: ${result.positionPercent >= 0 ? "+" : ""}${result.positionPercent.toFixed(1)}% vs promedio`);
  console.log(`   Participantes: ${result.participants}`);
  // Linea parseable para el test end-to-end.
  console.log(`RESULT ${JSON.stringify(result)}`);
});

net.start();
runner.setPrice(priceCents);

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
      note: "Tu precio nunca sale de tu dispositivo. Solo se comparten fragmentos matematicos (shares), nunca el valor real.",
    },
    invoice: {
      // El pipeline QVAC (factura -> OCR -> JSON) vive en otra rama; por
      // ahora los items vienen de los argumentos de arranque del nodo.
      // Solo el primero participa en la ronda actual.
      fileName: null,
      items: [{ product, quantity, unitPrice: Number(priceCents) / 100 }, ...queuedItems],
    },
    benchmark: {
      yourPrice: Number(priceCents) / 100,
      groupAverage: round.result ? round.result.averageCents / 100 : null,
      yourPositionPercent: round.result ? round.result.positionPercent : null,
      participants: round.result ? round.result.participants : net.participants.length,
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
