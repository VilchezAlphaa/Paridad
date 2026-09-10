import assert from "node:assert/strict";
import {
  PARTICIPANTS,
  buildShareMatrix,
  AggregationSession,
} from "./aggregation-protocol.mjs";

console.log("🧪 Probando protocolo de agregación (sin red, simulado en memoria)...");

/**
 * Simula una ronda completa del protocolo para un conjunto de precios
 * privados, sin usar Hyperswarm. Sirve para validar la lógica del
 * protocolo de forma aislada y rápida.
 */
function runProtocol(pricesByNode, participants = PARTICIPANTS) {
  // 1. Cada nodo construye su propia matriz de shares.
  const matrices = {};
  for (const name of participants) {
    matrices[name] = buildShareMatrix(pricesByNode[name], participants);
  }

  // 2. Cada nodo crea su sesión y registra su propio share.
  const sessions = {};
  for (const name of participants) {
    sessions[name] = new AggregationSession(name, participants);
    sessions[name].recordOwnShare(matrices[name][name]);
  }

  // 3. Se distribuye EXACTAMENTE un share por peer (no todos a todos).
  //    Registramos también qué shares "viajaron" para poder auditar
  //    la propiedad de aislamiento más abajo.
  const wireTraffic = [];
  for (const from of participants) {
    for (const to of participants) {
      if (from === to) continue;
      const share = matrices[from][to];
      wireTraffic.push({ from, to, share });
      sessions[to].recordPeerShare(from, share);
    }
  }

  // 4. Cada nodo calcula su column-sum.
  const columnSums = {};
  for (const name of participants) {
    columnSums[name] = sessions[name].computeColumnSum();
  }

  // 5. Se intercambian los column-sums (no shares crudos).
  for (const from of participants) {
    for (const to of participants) {
      if (from === to) continue;
      sessions[to].recordColumnSum(from, columnSums[from]);
    }
  }

  // 6. Cada nodo calcula el total de forma independiente.
  const totals = {};
  for (const name of participants) {
    totals[name] = sessions[name].computeTotal();
  }

  return { matrices, wireTraffic, columnSums, totals };
}

// --- Caso del enunciado: 4700 + 3100 + 5200 = 13000 ---
{
  const prices = { A: 4700n, B: 3100n, C: 5200n };
  const { totals } = runProtocol(prices);

  for (const name of PARTICIPANTS) {
    assert.equal(totals[name], 13000n, `Nodo ${name} no llegó al total esperado`);
  }
  console.log("✅ Caso base (4700 + 3100 + 5200 = 13000): todos los nodos coinciden");
}

// --- Casos aleatorios, incluyendo cero, valores chicos y grandes ---
{
  const cases = [
    { A: 0n, B: 0n, C: 0n },
    { A: 1n, B: 0n, C: 0n },
    { A: 1n, B: 2n, C: 3n },
    { A: 999999n, B: 1n, C: 0n },
    { A: 123456789n, B: 987654321n, C: 555555555n },
  ];

  for (let i = 0; i < 50; i++) {
    cases.push({
      A: BigInt(Math.floor(Math.random() * 10_000_000)),
      B: BigInt(Math.floor(Math.random() * 10_000_000)),
      C: BigInt(Math.floor(Math.random() * 10_000_000)),
    });
  }

  for (const [i, prices] of cases.entries()) {
    const expected = prices.A + prices.B + prices.C;
    const { totals } = runProtocol(prices);

    for (const name of PARTICIPANTS) {
      assert.equal(
        totals[name],
        expected,
        `Caso ${i}: nodo ${name} obtuvo ${totals[name]} en vez de ${expected}`
      );
    }
  }
  console.log(`✅ ${cases.length} casos aleatorios/edge-case pasaron (incluye ceros y valores grandes)`);
}

// --- Propiedad de aislamiento: ningún peer recibe más de UN share ---
// --- de otro participante (nunca ve los otros dos shares de esa persona) ---
{
  const prices = { A: 4700n, B: 3100n, C: 5200n };
  const { wireTraffic } = runProtocol(prices);

  const sharesReceivedByPair = new Map();
  for (const { from, to, share } of wireTraffic) {
    const key = `${from}->${to}`;
    assert.ok(!sharesReceivedByPair.has(key), `Se envió más de un share en ${key}`);
    sharesReceivedByPair.set(key, share);
  }

  // Cada nodo recibe exactamente (participants.length - 1) mensajes de share,
  // y nunca los 3 shares completos de otro nodo.
  const receivedByRecipient = new Map();
  for (const { to } of wireTraffic) {
    receivedByRecipient.set(to, (receivedByRecipient.get(to) || 0) + 1);
  }
  for (const name of PARTICIPANTS) {
    assert.equal(receivedByRecipient.get(name), PARTICIPANTS.length - 1);
  }

  console.log("✅ Ningún nodo recibió más de un share por participante (sin acceso directo a todos los shares ajenos)");
}

// --- Reconstrucción con shares desordenados/repetidos debe fallar ---
{
  const session = new AggregationSession("A", PARTICIPANTS);
  session.recordOwnShare(10n);
  session.recordPeerShare("B", 20n);

  assert.throws(() => session.computeColumnSum(), /Faltan shares/);

  session.recordPeerShare("C", 30n);
  assert.doesNotThrow(() => session.computeColumnSum());

  assert.throws(
    () => session.recordPeerShare("B", 99n),
    /Ya se recibió un share/,
    "Debe rechazar un segundo share del mismo peer (duplicado/replay)"
  );

  console.log("✅ AggregationSession valida estado incompleto y rechaza shares duplicados");
}

console.log("\n✅ Todos los tests del protocolo de agregación pasaron.");
