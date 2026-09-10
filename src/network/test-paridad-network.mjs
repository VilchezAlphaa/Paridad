import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createTestnet from "hyperdht/testnet.js";

// Nota: se probo primero con 3 instancias de ParidadNetwork en el mismo
// proceso (mas simple de escribir), pero varias instancias de Hyperswarm
// en un mismo proceso Node no se descubren entre si de forma confiable.
// Este test usa procesos separados de verdad -- una laptop = un
// proceso, igual que nodo-a.mjs / nodo-b.mjs y el uso real -- via
// test-worker.mjs.
//
// Ademas usa un testnet DHT LOCAL (hyperdht/testnet.js) en vez del DHT
// publico: 3 procesos en una misma maquina detras del mismo NAT no
// siempre logran conectarse entre si via el DHT publico (hairpinning) --
// algun par queda sin conexion y el test se cae de forma aleatoria. Con
// el testnet todo pasa por 127.0.0.1 y el test es determinista, usando
// los mismos code paths reales de Hyperswarm. El uso real entre laptops
// distintas no usa bootstrap y va por el DHT publico.

console.log("🧪 Probando capa de red Paridad (Hyperswarm real, 3 procesos separados, DHT local)...");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(__dirname, "test-worker.mjs");

const topicSeed = `paridad-network-test-${process.pid}-${process.hrtime.bigint()}`;
const PARTICIPANTS = ["A", "B", "C"];

const testnet = await createTestnet(3);
const bootstrapJson = JSON.stringify(testnet.bootstrap);

class WorkerHandle {
  constructor(name) {
    this.name = name;
    this.child = spawn(process.execPath, [workerPath, name, topicSeed, PARTICIPANTS.join(","), bootstrapJson], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.listeners = [];
    this.lastState = null;

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this._handleLine(line));
  }

  _handleLine(line) {
    const spaceIdx = line.indexOf(" ");
    const tag = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);

    if (tag === "STATE") this.lastState = JSON.parse(rest);
    if (tag === "ERROR") console.log(`   (info) Nodo ${this.name} reporto un error no fatal: ${rest}`);

    for (const { predicate, resolve } of [...this.listeners]) {
      const args = tag === "STATE" || tag === "MESSAGE" ? [JSON.parse(rest)] : [rest];
      if (predicate(tag, ...args)) {
        this.listeners = this.listeners.filter((l) => l.resolve !== resolve);
        resolve(args);
      }
    }
  }

  waitFor(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l.resolve !== resolve);
        reject(new Error(`Timeout esperando "${label}" en nodo ${this.name} (${timeoutMs}ms)`));
      }, timeoutMs);
      timer.unref?.();
      this.listeners.push({
        predicate,
        resolve: (args) => {
          clearTimeout(timer);
          resolve(args);
        },
      });
    });
  }

  waitForStatus(status, timeoutMs, label) {
    if (this.lastState?.status === status) return Promise.resolve();
    return this.waitFor((tag, state) => tag === "STATE" && state.status === status, timeoutMs, label);
  }

  send(cmd) {
    this.child.stdin.write(cmd + "\n");
  }

  async destroy() {
    if (this.child.exitCode !== null) return;
    this.send("DESTROY");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 5000);
      timer.unref?.();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

const workers = {};
for (const name of PARTICIPANTS) {
  workers[name] = new WorkerHandle(name);
}

try {
  // --- arranque + descubrimiento --------------------------------------
  await Promise.all(
    PARTICIPANTS.map((name) => workers[name].waitFor((tag) => tag === "READY", 10_000, `${name} arranca`))
  );

  await Promise.all(
    PARTICIPANTS.map((name) =>
      workers[name].waitForStatus("READY_FOR_AGGREGATION", 120_000, `${name} -> READY_FOR_AGGREGATION`)
    )
  );

  for (const name of PARTICIPANTS) {
    const state = workers[name].lastState;
    assert.equal(state.status, "READY_FOR_AGGREGATION");
    assert.equal(state.identifiedPeers.length, 2, `${name} deberia tener 2 peers identificados`);
    for (const peer of PARTICIPANTS) {
      if (peer !== name) assert.ok(state.identifiedPeers.includes(peer), `${name} deberia conocer a ${peer}`);
    }
  }
  console.log("✅ Los 3 nodos (procesos separados) se descubrieron, se identificaron entre si y llegaron a READY_FOR_AGGREGATION");

  // --- mensajeria tipada -------------------------------------------------
  {
    const received = workers.B.waitFor(
      (tag, msg) => tag === "MESSAGE" && msg.type === "ping" && msg.from === "A",
      5_000,
      "B recibe ping de A"
    );
    workers.A.send('SEND B ping {"n":42}');
    const [msg] = await received;
    assert.equal(msg.payload.n, 42);
    console.log("✅ send() punto a punto entrega el mensaje al peer correcto con su payload");
  }

  {
    const gotFromB = workers.B.waitFor((tag, m) => tag === "MESSAGE" && m.type === "hola", 5_000, "B recibe broadcast");
    const gotFromC = workers.C.waitFor((tag, m) => tag === "MESSAGE" && m.type === "hola", 5_000, "C recibe broadcast");
    workers.A.send('BROADCAST hola {"texto":"hola a todos"}');
    await Promise.all([gotFromB, gotFromC]);
    console.log("✅ broadcast() entrega el mensaje a todos los peers identificados");
  }

  // --- resiliencia ante mensajes corruptos --------------------------------
  {
    const stillWorks = workers.C.waitFor(
      (tag, m) => tag === "MESSAGE" && m.type === "sigo-vivo",
      5_000,
      "C recibe tras basura"
    );
    workers.A.send("POISON C");
    workers.A.send("SEND C sigo-vivo null");
    await stillWorks;
    console.log("✅ Mensajes corruptos o de remitente no verificado se descartan sin tumbar el nodo");
  }

  // --- desconexion -------------------------------------------------------
  {
    const aDisconnectedForB = workers.B.waitFor((tag, n) => tag === "DISCONNECTED" && n === "A", 15_000, "B ve a A desconectarse");
    const aDisconnectedForC = workers.C.waitFor((tag, n) => tag === "DISCONNECTED" && n === "A", 15_000, "C ve a A desconectarse");
    const bSeesDisconnectedState = workers.B.waitForStatus("PEER_DISCONNECTED", 15_000, "B -> PEER_DISCONNECTED");

    await workers.A.destroy();
    delete workers.A;

    await Promise.all([aDisconnectedForB, aDisconnectedForC, bSeesDisconnectedState]);

    const stateB = workers.B.lastState;
    assert.equal(stateB.status, "PEER_DISCONNECTED");
    assert.ok(!stateB.identifiedPeers.includes("A"));
    console.log("✅ Al caerse un nodo, los demas detectan la desconexion y el estado pasa a PEER_DISCONNECTED");
  }

  console.log("\n✅ Todos los tests de la capa de red pasaron.");
} finally {
  await Promise.all(Object.values(workers).map((w) => w.destroy()));
  await testnet.destroy();
}

process.exit(0);
