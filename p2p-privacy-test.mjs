import Hyperswarm from "hyperswarm";
import crypto from "crypto";
import {
  PARTICIPANTS,
  buildShareMatrix,
  AggregationSession,
} from "./src/privacy/aggregation-protocol.mjs";

// --- DATOS SINTÉTICOS DE DEMO ---------------------------------------------
// Precios ficticios creados por el equipo para este spike. NO provienen de
// ningún negocio, factura ni proveedor real.
// Están aquí solo hasta que el pipeline QVAC (factura → OCR → JSON) alimente
// este valor localmente; en uso real el precio saldría de la factura
// procesada en el dispositivo y nunca estaría escrito en el repositorio.
// --------------------------------------------------------------------------
const DEMO_PRICES = Object.freeze({
  A: 4700n, // demo sintético
  B: 3100n, // demo sintético
  C: 5200n, // demo sintético
});

const nodeName = process.argv[2];

if (!PARTICIPANTS.includes(nodeName)) {
  console.error(`Uso: node p2p-privacy-test.mjs ${PARTICIPANTS.join("|")}`);
  process.exit(1);
}

const myPrice = DEMO_PRICES[nodeName];
const myShares = buildShareMatrix(myPrice, PARTICIPANTS);
const session = new AggregationSession(nodeName, PARTICIPANTS);
session.recordOwnShare(myShares[nodeName]);

console.log(`\n🟢 Nodo ${nodeName} — Paridad (spike de agregación privada)`);
console.log(
  `Precio local [DATO SINTÉTICO DE DEMO] (nunca sale de este proceso): ${myPrice}`
);
console.log(
  "Shares generados para repartir (uno por peer, nunca todos al mismo peer):",
  Object.fromEntries(
    Object.entries(myShares).map(([who, s]) => [who, s.toString()])
  )
);

const swarm = new Hyperswarm();
const topic = crypto
  .createHash("sha256")
  .update("paridad-aggregation-protocol-v1")
  .digest();

// remotePublicKey (hex) -> nombre de nodo, una vez confirmado por "hello".
const nodeNameByPeerKey = new Map();
// nombre de nodo -> conexión activa (evita procesar duplicados).
const connectionByNode = new Map();

let columnSumBroadcast = false;
let totalAnnounced = false;

function peerLabel(conn) {
  const remoteKey = conn.remotePublicKey?.toString("hex");
  return (remoteKey && nodeNameByPeerKey.get(remoteKey)) || "peer sin identificar";
}

function send(conn, message) {
  // Escribir sobre una conexión que ya se cerró (peer caído a mitad de la
  // ronda) no debe tumbar el nodo: se registra y se sigue.
  try {
    conn.write(JSON.stringify(message) + "\n");
  } catch (err) {
    console.warn(
      `⚠️  Nodo ${nodeName}: no se pudo enviar "${message.type}" a ${peerLabel(conn)}: ${err.message}`
    );
  }
}

function broadcastColumnSum() {
  if (columnSumBroadcast) return;
  const columnSum = session.computeColumnSum();
  columnSumBroadcast = true;

  console.log(
    `📤 Nodo ${nodeName}: shares de los 3 participantes recibidos. Suma parcial (column-sum) calculada: ${columnSum}`
  );
  console.log(
    "   (este valor mezcla un fragmento de cada precio original; por sí solo no revela ningún precio individual)"
  );

  for (const conn of connectionByNode.values()) {
    send(conn, { type: "column-sum", from: nodeName, value: columnSum.toString() });
  }
}

function maybeAnnounceTotal() {
  if (totalAnnounced || !session.hasAllColumnSums()) return;
  totalAnnounced = true;

  const total = session.computeTotal();
  const average = Number(total) / PARTICIPANTS.length;
  const position = ((Number(myPrice) - average) / average) * 100;

  console.log(`\n📊 Resultado del benchmark (calculado localmente por ${nodeName}, sin servidor central):`);
  console.log(`PEERS: ${PARTICIPANTS.length}`);
  console.log(`Tu precio:       hidden (solo tú lo conoces)`);
  console.log(`Total del grupo: ${total} centavos`);
  console.log(`Promedio grupo:  $${(average / 100).toFixed(2)} (${average.toFixed(0)} centavos)`);
  console.log(`Tu posición:     ${position >= 0 ? "+" : ""}${position.toFixed(1)}% vs. el promedio`);
}

function handleMessage(conn, message) {
  if (message.type === "hello") {
    const remoteKey = conn.remotePublicKey.toString("hex");
    if (nodeNameByPeerKey.has(remoteKey)) return; // ya saludado

    if (message.node === nodeName || !PARTICIPANTS.includes(message.node)) {
      console.warn(`⚠️  Nodo ${nodeName}: identidad de peer inválida (${message.node}), ignorando conexión`);
      conn.destroy();
      return;
    }

    if (connectionByNode.has(message.node)) {
      // Conexión duplicada hacia un peer ya conocido (puede pasar con
      // topics de Hyperswarm si ambos lados intentan conectar). Nos
      // quedamos con la primera y cerramos esta.
      conn.destroy();
      return;
    }

    nodeNameByPeerKey.set(remoteKey, message.node);
    connectionByNode.set(message.node, conn);
    console.log(`🔗 Nodo ${nodeName}: conexión P2P confirmada con ${message.node}`);

    // Le envío ÚNICAMENTE el share que le corresponde a este peer,
    // nunca los otros dos shares que generé.
    send(conn, {
      type: "share",
      from: nodeName,
      share: myShares[message.node].toString(),
    });
    return;
  }

  const fromNode = nodeNameByPeerKey.get(conn.remotePublicKey.toString("hex"));
  if (!fromNode || fromNode !== message.from) {
    console.warn(`⚠️  Nodo ${nodeName}: mensaje con remitente no verificado, ignorado`);
    return;
  }

  if (message.type === "share") {
    session.recordPeerShare(fromNode, message.share);
    console.log(`📩 Nodo ${nodeName}: share privado recibido de ${fromNode} (valor enmascarado, no es su precio)`);

    if (session.hasAllShares()) {
      broadcastColumnSum();
    }
    return;
  }

  if (message.type === "column-sum") {
    session.recordColumnSum(fromNode, message.value);
    console.log(`📩 Nodo ${nodeName}: suma parcial recibida de ${fromNode}`);
    maybeAnnounceTotal();
    return;
  }
}

swarm.on("error", (err) => {
  console.warn(`⚠️  Nodo ${nodeName}: error del swarm: ${err.message}`);
});

swarm.join(topic, { client: true, server: true });

swarm.on("connection", (conn) => {
  let buffer = "";

  send(conn, { type: "hello", node: nodeName });

  conn.on("data", (data) => {
    // Framing NDJSON: TCP/las streams de Hyperswarm pueden entregar
    // varios mensajes juntos o un mensaje partido en varios "data".
    buffer += data.toString();
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      // Un mensaje corrupto, mal formado o rechazado por el protocolo
      // (duplicado, remitente desconocido) descarta ese mensaje, no el nodo.
      try {
        const message = JSON.parse(line);
        if (message === null || typeof message !== "object") {
          console.warn(
            `⚠️  Nodo ${nodeName}: mensaje con formato inesperado de ${peerLabel(conn)}, ignorado`
          );
          continue;
        }
        handleMessage(conn, message);
      } catch (err) {
        console.warn(
          `⚠️  Nodo ${nodeName}: mensaje descartado de ${peerLabel(conn)} (${err.message})`
        );
      }
    }
  });

  // Sin este listener, un error de stream (peer caído, handshake fallido)
  // se convierte en excepción no capturada y mata el nodo.
  conn.on("error", (err) => {
    console.warn(
      `⚠️  Nodo ${nodeName}: error de conexión con ${peerLabel(conn)}: ${err.message}`
    );
    // La limpieza de estado la hace el handler de "close", que Hyperswarm
    // emite igualmente después del error.
  });

  conn.on("close", () => {
    const remoteKey = conn.remotePublicKey.toString("hex");
    const peerName = nodeNameByPeerKey.get(remoteKey);
    if (peerName) {
      console.log(`🔌 Nodo ${nodeName}: ${peerName} se desconectó`);
      connectionByNode.delete(peerName);
      nodeNameByPeerKey.delete(remoteKey);
    }
  });
});

// --- Apagado limpio --------------------------------------------------------
// Un solo camino de salida: cierra Hyperswarm una única vez (Ctrl+C repetido
// o SIGTERM tras SIGINT no lanzan un segundo destroy) y garantiza que el
// proceso termine aunque el cierre del swarm se cuelgue.
let shuttingDown = false;

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n🛑 Cerrando nodo ${nodeName} (${reason})...`);

  const forceExit = setTimeout(() => {
    console.error(
      `⚠️  Nodo ${nodeName}: el cierre del swarm tardó demasiado, forzando salida`
    );
    process.exit(exitCode || 1);
  }, 5000);
  forceExit.unref();

  let finalExitCode = exitCode;

  try {
    await swarm.destroy();
    console.log(`✅ Nodo ${nodeName}: swarm cerrado, sin estado de red pendiente`);
  } catch (err) {
    console.error(`⚠️  Nodo ${nodeName}: error al destruir el swarm: ${err.message}`);
    finalExitCode = finalExitCode || 1;
  } finally {
    clearTimeout(forceExit);
    process.exit(finalExitCode);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

// Ninguna excepción/promesa rechazada debe dejar el nodo "vivo pero muerto":
// el swarm mantiene el event loop abierto, así que sin esto el proceso
// seguiría corriendo en silencio sin participar en el protocolo.
process.on("uncaughtException", (err) => {
  console.error(`\n💥 Nodo ${nodeName}: excepción no capturada`);
  console.error(err);
  void shutdown("uncaughtException", 1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`\n💥 Nodo ${nodeName}: promesa rechazada sin manejar`);
  console.error(reason);
  void shutdown("unhandledRejection", 1);
});
