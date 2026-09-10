import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createTestnet from "hyperdht/testnet.js";

// Test end-to-end del hito de CLAUDE.md §30: protocolo de privacidad
// (ya testeado en memoria) + capa de red (ya testeada) = ronda completa
// entre 3 procesos nodo-paridad.mjs REALES sobre Hyperswarm (DHT local).
//
// Precios sinteticos de demo (mismos que p2p-privacy-test.mjs):
//   A=4700 + B=3100 + C=5200 = 13000 centavos -> promedio 4333.33
// Cada nodo debe calcular el MISMO total localmente, sin que ningun
// precio individual cruce la red (solo shares y column-sums).

console.log("🧪 Probando ronda de agregacion end-to-end (3 procesos nodo-paridad reales)...");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodePath = path.join(__dirname, "..", "..", "nodo-paridad.mjs");

const PRICES = { A: 4700n, B: 3100n, C: 5200n };
const EXPECTED_TOTAL = "13000";
const EXPECTED_AVERAGE = 13000 / 3;

const topicSeed = `paridad-e2e-test-${process.pid}-${process.hrtime.bigint()}`;
const testnet = await createTestnet(3);
const bootstrapJson = JSON.stringify(testnet.bootstrap);

const children = [];
const resultPromises = [];

for (const name of Object.keys(PRICES)) {
  const child = spawn(
    process.execPath,
    [nodePath, name, "--price", PRICES[name].toString(), "--no-ui", "--topic", topicSeed, "--bootstrap", bootstrapJson],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  children.push(child);

  resultPromises.push(
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout esperando RESULT del nodo ${name}`)),
        120_000
      );
      timer.unref?.();

      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (line.startsWith("RESULT ")) {
          clearTimeout(timer);
          resolve({ name, result: JSON.parse(line.slice("RESULT ".length)) });
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Nodo ${name} termino antes de producir un resultado (exit ${code})`));
      });
    })
  );
}

try {
  const results = await Promise.all(resultPromises);

  for (const { name, result } of results) {
    assert.equal(result.totalCents, EXPECTED_TOTAL, `${name}: total incorrecto`);
    assert.ok(Math.abs(result.averageCents - EXPECTED_AVERAGE) < 0.01, `${name}: promedio incorrecto`);
    assert.equal(result.participants, 3, `${name}: numero de participantes incorrecto`);

    const expectedPosition = ((Number(PRICES[name]) - EXPECTED_AVERAGE) / EXPECTED_AVERAGE) * 100;
    assert.ok(
      Math.abs(result.positionPercent - expectedPosition) < 0.01,
      `${name}: posicion incorrecta (${result.positionPercent} vs ${expectedPosition})`
    );
  }

  console.log("✅ Los 3 nodos calcularon localmente el mismo total (13000) y promedio (4333.33)");
  console.log("✅ Cada nodo obtuvo su posicion correcta vs el promedio (A +8.5%, B -28.5%, C +20.0%)");
  console.log("\n✅ Ronda de agregacion end-to-end sobre Hyperswarm: OK.");
} finally {
  for (const child of children) child.kill();
  await testnet.destroy();
}

process.exit(0);
