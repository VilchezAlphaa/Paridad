import assert from "node:assert/strict";
import { split, combine } from "./secret-sharing.mjs";

console.log("🧪 Probando secret sharing...");

for (let i = 0; i < 100; i++) {
  const original = BigInt(Math.floor(Math.random() * 100000));

  const shares = split(original, 3);
  const reconstructed = combine(shares);

  assert.equal(reconstructed, original);

  console.log(`✅ Caso ${i + 1}: ${original} → correcto`);
}

console.log("\n✅ Los 100 casos pasaron.");