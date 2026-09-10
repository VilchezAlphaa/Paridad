/**
 * Spike de agregación privada con precios de demo FIJOS.
 *
 * Este script fue el primero en validar el protocolo P2P entre dos laptops
 * físicas. Su lógica de red se extrajo a src/p2p/aggregation-node.mjs para
 * poder reutilizarla desde el flujo end-to-end (paridad-node.mjs); aquí queda
 * el mismo comportamiento de siempre, ahora sobre el módulo compartido.
 *
 * El protocolo de cable no cambió: mismos mensajes, mismo topic.
 *
 * Uso:  node p2p-privacy-test.mjs A|B|C
 */

import { PARTICIPANTS } from "./src/privacy/aggregation-protocol.mjs";
import { createAggregationNode } from "./src/p2p/aggregation-node.mjs";

// --- DATOS SINTÉTICOS DE DEMO ---------------------------------------------
// Precios ficticios creados por el equipo para este spike. NO provienen de
// ningún negocio, factura ni proveedor real.
// El flujo real toma el precio de una factura procesada localmente con QVAC:
// eso es paridad-node.mjs. Aquí se mantienen fijos para poder probar la capa
// P2P sin cargar modelos.
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

const nodo = createAggregationNode({ nodeName, privateValue: myPrice });

console.log(`\n🟢 Nodo ${nodeName} — Paridad (spike de agregación privada)`);
console.log(`Precio local [DATO SINTÉTICO DE DEMO] (nunca sale de este proceso): ${myPrice}`);
console.log(
  "Shares generados para repartir (uno por peer, nunca todos al mismo peer):",
  Object.fromEntries(Object.entries(nodo.misShares).map(([who, s]) => [who, s.toString()]))
);

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
    console.error(`⚠️  Nodo ${nodeName}: el cierre del swarm tardó demasiado, forzando salida`);
    process.exit(exitCode || 1);
  }, 5000);
  forceExit.unref();

  let finalExitCode = exitCode;

  try {
    await nodo.stop();
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

nodo.start();
