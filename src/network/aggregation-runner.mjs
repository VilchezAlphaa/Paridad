import { EventEmitter } from "node:events";
import { buildShareMatrix, AggregationSession } from "../privacy/aggregation-protocol.mjs";
import { NETWORK_STATE } from "./network-state.mjs";

// Pegamento entre ParidadNetwork y AggregationSession: ejecuta sobre la
// red real el mismo protocolo ya validado en p2p-privacy-test.mjs
// (shares -> column-sums -> total calculado localmente por cada nodo).
//
// No implementa criptografia ni red: la matematica vive en
// aggregation-protocol.mjs y el transporte en paridad-network.mjs.
//
// Ciclo de una ronda:
//   1. El nodo conoce su precio local (setPrice, en centavos). El precio
//      NUNCA se envia por la red: solo shares y column-sums.
//   2. Cuando la red llega a READY_FOR_AGGREGATION, se crea una sesion
//      fresca y se envia a CADA peer exactamente el share que le toca.
//   3. Con los shares de todos, se calcula la suma parcial (column-sum)
//      y se hace broadcast de ella.
//   4. Con todas las column-sums, cada nodo calcula el total y el
//      benchmark localmente. No hay servidor central.
//
// Si un peer se cae a mitad de ronda, la red sale de READY; cuando todos
// vuelven a estar identificados, TODOS los nodos reinician la ronda con
// una sesion y shares frescos (los shares viejos quedan invalidados).
// Nota MVP: existe una ventana de milisegundos en la reconexion donde un
// share fresco de un peer rapido puede llegar antes de nuestro propio
// reinicio y rechazarse como duplicado; el peer afectado reintenta al
// reiniciar su propia ronda, y para la demo (3 laptops en red estable)
// es suficiente.

export const ROUND_STATE = Object.freeze({
  WAITING_PRICE: "WAITING_PRICE",
  WAITING_NETWORK: "WAITING_NETWORK",
  SHARING: "SHARING",
  DONE: "DONE",
});

export class AggregationRunner extends EventEmitter {
  /** @param {import("./paridad-network.mjs").ParidadNetwork} net */
  constructor(net) {
    super();

    this.net = net;
    this.selfName = net.selfName;
    this.participants = net.participants;

    this.priceCents = null; // BigInt; solo vive en este proceso
    this.session = null;
    this.sharesSent = 0;
    this.result = null;

    // Mensajes que llegan antes de que este nodo este listo para
    // procesarlos (peer mas rapido): se guarda el ultimo por remitente y
    // se ingiere al arrancar la ronda / calcular la propia column-sum.
    this._pendingShares = new Map();
    this._pendingColumnSums = new Map();

    net.on("state", (state) => this._maybeStartRound(state.status));
    net.on("message", (message) => this._handleMessage(message));
  }

  /** Fija el precio local en centavos (entero). Nunca sale del proceso. */
  setPrice(cents) {
    this.priceCents = BigInt(cents);
    this._maybeStartRound(this.net.status);
    this.emit("update");
  }

  getRoundState() {
    if (this.result) return ROUND_STATE.DONE;
    if (this.priceCents === null) return ROUND_STATE.WAITING_PRICE;
    if (this.session) return ROUND_STATE.SHARING;
    return ROUND_STATE.WAITING_NETWORK;
  }

  getState() {
    return {
      roundState: this.getRoundState(),
      sharesSent: this.sharesSent,
      sharesReceived: this.session
        ? this.session.receivedShares.size - 1 // sin contar el propio
        : 0,
      result: this.result,
    };
  }

  _maybeStartRound(networkStatus) {
    if (this.result || this.priceCents === null) return;
    if (networkStatus !== NETWORK_STATE.READY_FOR_AGGREGATION) return;

    // Sesion y shares frescos en cada (re)inicio: si una ronda anterior
    // quedo a medias por una desconexion, sus shares ya no valen.
    this.session = new AggregationSession(this.selfName, this.participants);
    const shares = buildShareMatrix(this.priceCents, this.participants);
    this.session.recordOwnShare(shares[this.selfName]);

    this.sharesSent = 0;
    for (const peer of this.net.peers) {
      // A cada peer se le envia UNICAMENTE su share, nunca los demas.
      if (this.net.send(peer, "share", { share: shares[peer].toString() })) {
        this.sharesSent++;
      }
    }

    for (const [from, share] of this._pendingShares) this._recordShare(from, share);
    this._pendingShares.clear();

    this.emit("update");
    this._maybeAdvance();
  }

  _handleMessage({ from, type, payload }) {
    if (type === "share") {
      if (!this.session || this.result) {
        this._pendingShares.set(from, payload.share);
        return;
      }
      this._recordShare(from, payload.share);
      this._maybeAdvance();
      return;
    }

    if (type === "column-sum") {
      if (!this.session || this.session.myColumnSum === null) {
        this._pendingColumnSums.set(from, payload.value);
        return;
      }
      this._recordColumnSum(from, payload.value);
      this._maybeAdvance();
      return;
    }
  }

  _recordShare(from, share) {
    try {
      this.session.recordPeerShare(from, share);
      this.emit("update");
    } catch (err) {
      this.emit("protocol-error", new Error(`Share de ${from} rechazado: ${err.message}`));
    }
  }

  _recordColumnSum(from, value) {
    try {
      this.session.recordColumnSum(from, value);
      this.emit("update");
    } catch (err) {
      this.emit("protocol-error", new Error(`Column-sum de ${from} rechazado: ${err.message}`));
    }
  }

  _maybeAdvance() {
    if (!this.session || this.result) return;

    if (this.session.myColumnSum === null && this.session.hasAllShares()) {
      const columnSum = this.session.computeColumnSum();
      this.net.broadcast("column-sum", { value: columnSum.toString() });

      for (const [from, value] of this._pendingColumnSums) this._recordColumnSum(from, value);
      this._pendingColumnSums.clear();

      this.emit("update");
    }

    if (this.session.myColumnSum !== null && this.session.hasAllColumnSums()) {
      const totalCents = this.session.computeTotal();
      const averageCents = Number(totalCents) / this.participants.length;
      const positionPercent =
        ((Number(this.priceCents) - averageCents) / averageCents) * 100;

      this.result = {
        totalCents: totalCents.toString(),
        averageCents,
        positionPercent,
        participants: this.participants.length,
      };
      this.emit("update");
      this.emit("result", this.result);
    }
  }
}
