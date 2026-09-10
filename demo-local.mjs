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

// Matriz sintetica de demo: 5 productos comunes, precios DISTINTOS por
// nodo (cada producto corre su propia ronda P2P). El primer producto
// conserva los precios historicos de p2p-privacy-test.mjs. Proveedores
// solo para el nodo A (dato local, pagina "Proveedores").
const ITEMS = {
  A: [
    "Aceite Motor 20W50:4700:4:Distribuidora Central",
    "Filtro de aceite:680:12:Distribuidora Central",
    "Pastillas de freno delanteras:2850:6:Refaccionaria Lopez",
    "Bateria 12V 650A:7800:2:Repuestos El Rapido",
    "Bujias de encendido (juego x4):1640:8:Ferreteria Ideal",
  ],
  B: [
    "Aceite Motor 20W50:3100:2",
    "Filtro de aceite:640:10",
    "Pastillas de freno delanteras:2310:4",
    "Bateria 12V 650A:8250:1",
    "Bujias de encendido (juego x4):1590:6",
  ],
  C: [
    "Aceite Motor 20W50:5200:6",
    "Filtro de aceite:720:15",
    "Pastillas de freno delanteras:2500:8",
    "Bateria 12V 650A:8100:3",
    "Bujias de encendido (juego x4):1710:10",
  ],
};
const NODES = [
  { name: "A", port: 4700 },
  { name: "B", port: 4701 },
  { name: "C", port: 4702 },
];

const testnet = await createTestnet(3);
const bootstrapJson = JSON.stringify(testnet.bootstrap);
const topicSeed = `paridad-demo-local-${process.pid}`;

console.log("🎬 Demo local de Paridad (3 nodos en esta maquina, DHT local)");

const children = NODES.map(({ name, port }) => {
  const child = spawn(
    process.execPath,
    [
      nodePath, name,
      "--port", String(port),
      "--topic", topicSeed,
      "--bootstrap", bootstrapJson,
      ...ITEMS[name].flatMap((item) => ["--item", item]),
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
