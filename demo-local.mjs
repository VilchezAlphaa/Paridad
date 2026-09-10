// Ensayo de la demo en UNA sola maquina: levanta un DHT local y los 3
// nodos Paridad completos (red + ronda + UI). En la demo real cada
// laptop corre su propio `node nodo-paridad.mjs <nombre> --price <c>` y
// no hace falta este script ni el DHT local.
//
//   node demo-local.mjs
//   -> UI de A: http://localhost:4700   (B: 4701, C: 4702)
//
// Ctrl+C cierra todo.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createTestnet from "hyperdht/testnet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodePath = path.join(__dirname, "nodo-paridad.mjs");

// Precios sinteticos de demo, mismos que p2p-privacy-test.mjs.
const NODES = [
  { name: "A", price: "4700", port: 4700, product: "Aceite Motor 20W50", quantity: "4" },
  { name: "B", price: "3100", port: 4701, product: "Aceite Motor 20W50", quantity: "2" },
  { name: "C", price: "5200", port: 4702, product: "Aceite Motor 20W50", quantity: "6" },
];

const testnet = await createTestnet(3);
const bootstrapJson = JSON.stringify(testnet.bootstrap);
const topicSeed = `paridad-demo-local-${process.pid}`;

console.log("🎬 Demo local de Paridad (3 nodos en esta maquina, DHT local)");

const children = NODES.map(({ name, price, port, product, quantity }) => {
  const child = spawn(
    process.execPath,
    [
      nodePath, name,
      "--price", price,
      "--product", product,
      "--quantity", quantity,
      "--port", String(port),
      "--topic", topicSeed,
      "--bootstrap", bootstrapJson,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return child;
});

async function shutdown() {
  console.log("\n🛑 Cerrando demo local...");
  for (const child of children) child.kill();
  await testnet.destroy();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
