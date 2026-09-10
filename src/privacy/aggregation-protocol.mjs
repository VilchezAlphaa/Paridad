import { split, combine } from "./secret-sharing.mjs";

// Orden fijo de participantes. El índice de cada nombre en este array
// determina qué share del split() le corresponde a cada quién.
export const PARTICIPANTS = ["A", "B", "C"];

/**
 * A partir de un valor privado, genera un share destinado a cada
 * participante (incluyendo uno para sí mismo).
 *
 * Devuelve un mapa { participante: share } en vez de un array plano:
 * así el nodo emisor puede repartir un share distinto a cada peer,
 * en lugar de enviar todos los shares a todos.
 */
export function buildShareMatrix(value, participants = PARTICIPANTS) {
  const shares = split(value, participants.length);

  const sharesByRecipient = {};
  participants.forEach((recipient, index) => {
    sharesByRecipient[recipient] = shares[index];
  });

  return sharesByRecipient;
}

/**
 * Estado de agregación de un solo nodo. No conoce nada de red:
 * solo procesa shares y column-sums que le entregan desde afuera.
 *
 * Protocolo (suma segura de 3+ participantes, additive secret sharing):
 *
 *   1. Cada nodo X divide su precio en split(v_X, n) shares.
 *   2. Del array de shares, la posición de cada participante define
 *      a quién le corresponde: X se queda con su propio share y
 *      envía EXACTAMENTE UN share (nunca los otros) a cada peer.
 *   3. Cada nodo Y recibe así "una columna": un share de cada
 *      participante (incluido el suyo propio). Ningún nodo llega a
 *      ver más de un share ajeno por participante.
 *   4. Y suma esa columna (combine) -> columnSum_Y. Ese valor por sí
 *      solo es indistinguible de ruido: mezcla un fragmento de cada
 *      precio original.
 *   5. Los nodos intercambian sus columnSum (no shares crudos) y
 *      cada uno calcula total = combine(todos los columnSum).
 *      La suma de columnSums es igual a la suma de todos los v_X
 *      porque cada v_X aporta exactamente una vez a cada columna.
 */
export class AggregationSession {
  constructor(selfName, participants = PARTICIPANTS) {
    if (!participants.includes(selfName)) {
      throw new Error(`selfName desconocido: ${selfName}`);
    }

    this.selfName = selfName;
    this.participants = participants;
    this.peers = participants.filter((name) => name !== selfName);

    this.receivedShares = new Map();
    this.receivedColumnSums = new Map();
    this.myColumnSum = null;
  }

  recordOwnShare(share) {
    this.receivedShares.set(this.selfName, BigInt(share));
  }

  recordPeerShare(fromNode, share) {
    if (!this.peers.includes(fromNode)) {
      throw new Error(`Share inesperado de un nodo desconocido: ${fromNode}`);
    }
    if (this.receivedShares.has(fromNode)) {
      throw new Error(`Ya se recibió un share de ${fromNode} (posible duplicado o replay)`);
    }
    this.receivedShares.set(fromNode, BigInt(share));
  }

  hasAllShares() {
    return this.receivedShares.size === this.participants.length;
  }

  computeColumnSum() {
    if (!this.hasAllShares()) {
      throw new Error("Faltan shares de otros participantes para calcular la suma parcial");
    }
    this.myColumnSum = combine([...this.receivedShares.values()]);
    return this.myColumnSum;
  }

  recordColumnSum(fromNode, columnSum) {
    if (!this.peers.includes(fromNode)) {
      throw new Error(`Column-sum inesperado de un nodo desconocido: ${fromNode}`);
    }
    this.receivedColumnSums.set(fromNode, BigInt(columnSum));
  }

  hasAllColumnSums() {
    return (
      this.myColumnSum !== null &&
      this.peers.every((name) => this.receivedColumnSums.has(name))
    );
  }

  computeTotal() {
    if (!this.hasAllColumnSums()) {
      throw new Error("Faltan column-sums de otros participantes para calcular el total");
    }
    return combine([this.myColumnSum, ...this.receivedColumnSums.values()]);
  }
}
