import { EventEmitter } from "node:events";
import { buildShareMatrix, AggregationSession } from "../privacy/aggregation-protocol.mjs";
import { NETWORK_STATE } from "./network-state.mjs";

// Pegamento entre ParidadNetwork y AggregationSession: ejecuta sobre la
// red real el protocolo validado en p2p-privacy-test.mjs (shares ->
// column-sums -> total local), extendido a VARIAS rondas en paralelo:
// una por producto.
//
// Protocolo multi-producto:
//   1. Cada nodo conoce sus items locales (setItems): producto + precio
//      en centavos. Los PRECIOS nunca se envian; los NOMBRES de producto
//      si (el grupo necesita acordar que esta comparando -- el modelo de
//      privacidad protege precios y facturas, no la identidad del
//      producto, igual que en CLAUDE.md).
//   2. Al llegar la red a READY, cada nodo hace broadcast de su lista de
//      nombres ("products"). Con las listas de TODOS, cada nodo calcula
//      la interseccion de forma independiente y deterministica.
//   3. Por cada producto comun corre una AggregationSession propia, con
//      mensajes "share"/"column-sum" etiquetados con el producto.
//   4. Un producto que no tienen todos queda NOT_COMMON (sin ronda): la
//      suma de 3 participantes necesita el share de los 3.
//
// Si un peer se cae a mitad, la red sale de READY; al volver, TODOS
// reinician las rondas incompletas con sesiones y shares frescos (los
// resultados ya calculados se conservan). Ver nota de la ventana de
// reconexion en la version anterior de este archivo; sigue aplicando.

export const ROUND_STATE = Object.freeze({
  WAITING_ITEMS: "WAITING_ITEMS",
  WAITING_NETWORK: "WAITING_NETWORK",
  SHARING: "SHARING",
  DONE: "DONE",
});

export const ITEM_STATE = Object.freeze({
  WAITING: "WAITING", // sin red o sin las listas de todos los peers
  NOT_COMMON: "NOT_COMMON", // algun participante no tiene este producto
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

    // [{ product, priceCents (BigInt), quantity, proveedor }]
    this.items = null;
    // peer -> Set<nombre de producto>
    this.peerProducts = new Map();
    // producto -> AggregationSession (rondas en curso)
    this.sessions = new Map();
    // producto -> resultado final
    this.results = new Map();

    this.sharesSent = 0;

    // Mensajes que llegan antes de que este nodo este listo para
    // procesarlos: se guarda el ultimo por (remitente, producto).
    this._pendingShares = new Map();
    this._pendingColumnSums = new Map();

    net.on("state", (state) => this._onNetworkState(state.status));
    net.on("message", (message) => this._handleMessage(message));
  }

  /**
   * Fija los items locales. Los precios (centavos, enteros) solo viven
   * en este proceso.
   * @param {Array<{product: string, priceCents: bigint|number|string, quantity?: number, proveedor?: string}>} items
   */
  setItems(items) {
    this.items = items.map((item) => ({
      product: item.product,
      display: item.display ?? item.product,
      priceCents: BigInt(item.priceCents),
      quantity: item.quantity ?? 1,
      proveedor: item.proveedor ?? null,
    }));
    this._announceProducts();
    this._maybeStartSessions();
    this.emit("update");
  }

  _itemFor(product) {
    return this.items?.find((item) => item.product === product) ?? null;
  }

  // --- estado ---------------------------------------------------------

  _itemState(product) {
    if (this.results.has(product)) return ITEM_STATE.DONE;
    if (this.sessions.has(product)) return ITEM_STATE.SHARING;
    if (this._haveAllPeerLists()) {
      return this._isCommon(product) ? ITEM_STATE.SHARING : ITEM_STATE.NOT_COMMON;
    }
    return ITEM_STATE.WAITING;
  }

  getRoundState() {
    if (!this.items) return ROUND_STATE.WAITING_ITEMS;
    if (this.sessions.size > 0) return ROUND_STATE.SHARING;
    if (this.results.size > 0) return ROUND_STATE.DONE;
    return ROUND_STATE.WAITING_NETWORK;
  }

  getState() {
    return {
      roundState: this.getRoundState(),
      sharesSent: this.sharesSent,
      resultsCount: this.results.size,
      items: (this.items ?? []).map((item) => {
        const result = this.results.get(item.product) ?? null;
        return {
          product: item.product,
          display: item.display,
          quantity: item.quantity,
          proveedor: item.proveedor,
          unitPriceCents: Number(item.priceCents),
          status: this._itemState(item.product),
          result,
        };
      }),
    };
  }

  // --- arranque de rondas ------------------------------------------------

  _onNetworkState(status) {
    if (status !== NETWORK_STATE.READY_FOR_AGGREGATION) return;

    // Rondas incompletas quedan invalidadas por la reconexion: sesiones
    // y shares frescos. Los resultados ya calculados se conservan.
    this.sessions.clear();
    this._pendingShares.clear();
    this._pendingColumnSums.clear();

    this._announceProducts();
    this._maybeStartSessions();
  }

  _announceProducts() {
    if (!this.items) return;
    if (this.net.status !== NETWORK_STATE.READY_FOR_AGGREGATION) return;
    this.net.broadcast("products", { products: this.items.map((item) => item.product) });
  }

  _haveAllPeerLists() {
    return this.net.peers.every((peer) => this.peerProducts.has(peer));
  }

  _isCommon(product) {
    return this.net.peers.every((peer) => this.peerProducts.get(peer)?.has(product));
  }

  _maybeStartSessions() {
    if (!this.items) return;
    if (this.net.status !== NETWORK_STATE.READY_FOR_AGGREGATION) return;
    if (!this._haveAllPeerLists()) return;

    for (const item of this.items) {
      const { product } = item;
      if (this.results.has(product) || this.sessions.has(product)) continue;
      if (!this._isCommon(product)) continue;

      const session = new AggregationSession(this.selfName, this.participants);
      const shares = buildShareMatrix(item.priceCents, this.participants);
      session.recordOwnShare(shares[this.selfName]);
      this.sessions.set(product, session);

      for (const peer of this.net.peers) {
        // A cada peer se le envia UNICAMENTE su share de este producto.
        if (this.net.send(peer, "share", { product, share: shares[peer].toString() })) {
          this.sharesSent++;
        }
      }

      for (const [key, share] of this._pendingShares) {
        const [from, pendingProduct] = key.split("|");
        if (pendingProduct === product) {
          this._recordShare(product, from, share);
          this._pendingShares.delete(key);
        }
      }

      this._maybeAdvance(product);
    }

    this.emit("update");
  }

  // --- mensajes ----------------------------------------------------------

  _handleMessage({ from, type, payload }) {
    if (type === "products") {
      this.peerProducts.set(from, new Set(payload.products));
      // Simetria: si el peer acaba de (re)anunciarse, que tambien tenga
      // nuestra lista aunque nuestro broadcast anterior no le llegara.
      this._announceProducts();
      this._maybeStartSessions();
      this.emit("update");
      return;
    }

    if (type === "share") {
      const { product, share } = payload;
      if (!this.sessions.has(product)) {
        if (!this.results.has(product)) this._pendingShares.set(`${from}|${product}`, share);
        return;
      }
      this._recordShare(product, from, share);
      this._maybeAdvance(product);
      return;
    }

    if (type === "column-sum") {
      const { product, value } = payload;
      const session = this.sessions.get(product);
      if (!session || session.myColumnSum === null) {
        if (!this.results.has(product)) this._pendingColumnSums.set(`${from}|${product}`, value);
        return;
      }
      this._recordColumnSum(product, from, value);
      this._maybeAdvance(product);
      return;
    }
  }

  _recordShare(product, from, share) {
    try {
      this.sessions.get(product).recordPeerShare(from, share);
      this.emit("update");
    } catch (err) {
      this.emit("protocol-error", new Error(`Share de ${from} (${product}) rechazado: ${err.message}`));
    }
  }

  _recordColumnSum(product, from, value) {
    try {
      this.sessions.get(product).recordColumnSum(from, value);
      this.emit("update");
    } catch (err) {
      this.emit("protocol-error", new Error(`Column-sum de ${from} (${product}) rechazado: ${err.message}`));
    }
  }

  _maybeAdvance(product) {
    const session = this.sessions.get(product);
    if (!session) return;

    if (session.myColumnSum === null && session.hasAllShares()) {
      const columnSum = session.computeColumnSum();
      this.net.broadcast("column-sum", { product, value: columnSum.toString() });

      for (const [key, value] of this._pendingColumnSums) {
        const [from, pendingProduct] = key.split("|");
        if (pendingProduct === product) {
          this._recordColumnSum(product, from, value);
          this._pendingColumnSums.delete(key);
        }
      }

      this.emit("update");
    }

    if (session.myColumnSum !== null && session.hasAllColumnSums()) {
      const totalCents = session.computeTotal();
      const averageCents = Number(totalCents) / this.participants.length;
      const myPrice = Number(this._itemFor(product).priceCents);
      const positionPercent = ((myPrice - averageCents) / averageCents) * 100;

      const result = {
        product,
        totalCents: totalCents.toString(),
        averageCents,
        positionPercent,
        participants: this.participants.length,
      };
      this.results.set(product, result);
      this.sessions.delete(product);

      this.emit("update");
      this.emit("result", result);
    }
  }
}
