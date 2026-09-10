import crypto from "crypto";

// Primo grande usado como módulo.
// Para nuestro MVP trabajaremos con precios en centavos.
const PRIME = 2n ** 127n - 1n;

function randomBigInt(max) {
  const bytes = 16;
  let value;

  do {
    value = BigInt("0x" + crypto.randomBytes(bytes).toString("hex"));
  } while (value >= max);

  return value;
}

/**
 * Divide un valor en N shares.
 * La suma de los shares, modulo PRIME, reconstruye el valor original.
 */
export function split(value, numberOfShares) {
  if (!Number.isInteger(numberOfShares) || numberOfShares < 2) {
    throw new Error("numberOfShares debe ser >= 2");
  }

  const normalized = BigInt(value);

  if (normalized < 0n) {
    throw new Error("value no puede ser negativo");
  }

  const shares = [];
  let accumulated = 0n;

  for (let i = 0; i < numberOfShares - 1; i++) {
    const share = randomBigInt(PRIME);
    shares.push(share);
    accumulated = (accumulated + share) % PRIME;
  }

  const lastShare = (normalized - accumulated + PRIME) % PRIME;
  shares.push(lastShare);

  return shares;
}

/**
 * Reconstruye el valor original a partir de sus shares.
 */
export function combine(shares) {
  if (!Array.isArray(shares) || shares.length === 0) {
    throw new Error("shares debe ser un array no vacío");
  }

  return shares.reduce(
    (sum, share) => (sum + BigInt(share)) % PRIME,
    0n
  );
}