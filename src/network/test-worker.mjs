// Worker de un solo nodo, pensado para correr en su PROPIO proceso
// (igual que nodo-a.mjs / nodo-b.mjs, y que el uso real: una laptop = un
// proceso). test-paridad-network.mjs lo usa para probar la capa de red
// con procesos separados de verdad, ya que varias instancias de
// Hyperswarm dentro de un mismo proceso no se descubren entre si.
//
// Protocolo por stdin/stdout (una linea = un evento/comando en JSON o texto simple):
//   stdout: "STATE <json>" | "IDENTIFIED <nombre>" | "DISCONNECTED <nombre>" |
//           "MESSAGE <json>" | "ERROR <texto>" | "READY"
//   stdin:  "SEND <peer> <type> <json-payload>" | "BROADCAST <type> <json-payload>" |
//           "POISON <peer>" (escribe basura + mensaje spoofeado en la conexion cruda) |
//           "DESTROY"

import readline from "node:readline";
import { ParidadNetwork } from "./paridad-network.mjs";

const [, , selfName, topicSeed, participantsCsv, bootstrapJson] = process.argv;
const participants = participantsCsv.split(",");
const bootstrap = bootstrapJson ? JSON.parse(bootstrapJson) : null;

const net = new ParidadNetwork(selfName, { participants, topicSeed, bootstrap });

net.on("state", (s) => console.log(`STATE ${JSON.stringify(s)}`));
net.on("peer:identified", (p) => console.log(`IDENTIFIED ${p}`));
net.on("peer:disconnected", (p) => console.log(`DISCONNECTED ${p}`));
net.on("message", (m) => console.log(`MESSAGE ${JSON.stringify(m)}`));
net.on("error", (e) => console.log(`ERROR ${e.message}`));

net.start();
console.log("READY");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const [cmd, ...rest] = line.split(" ");

  if (cmd === "SEND") {
    const [peer, type, ...payloadParts] = rest;
    net.send(peer, type, JSON.parse(payloadParts.join(" ")));
    return;
  }

  if (cmd === "BROADCAST") {
    const [type, ...payloadParts] = rest;
    net.broadcast(type, JSON.parse(payloadParts.join(" ")));
    return;
  }

  if (cmd === "POISON") {
    const [peer] = rest;
    const key = net.keyByPeerName.get(peer);
    const entry = key && net.connectionsByKey.get(key);
    if (entry) {
      entry.conn.write("esto no es json\n");
      entry.conn.write('{"type":"algo","from":"un-nodo-que-no-existe","payload":1}\n');
    }
    return;
  }

  if (cmd === "DESTROY") {
    await net.destroy();
    process.exit(0);
  }
});
