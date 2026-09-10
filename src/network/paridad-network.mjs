import Hyperswarm from "hyperswarm";
import crypto from "crypto";
import { EventEmitter } from "node:events";
import { PARTICIPANTS as DEFAULT_PARTICIPANTS } from "../privacy/aggregation-protocol.mjs";
import { NETWORK_STATE } from "./network-state.mjs";

// Capa de red aislada para Paridad, sobre Hyperswarm.
//
// No implementa ningun protocolo criptografico ni de agregacion: solo
// conecta nodos, los identifica, entrega mensajes tipados y expone un
// estado de red simple. La logica de shares/column-sum (ya validada en
// p2p-privacy-test.mjs) vive fuera de este archivo y se construye
// encima usando send()/broadcast()/on("message").
//
// Reutiliza, en forma generica, el mismo patron ya probado en
// p2p-privacy-test.mjs: handshake "hello" para identificar peers,
// framing NDJSON sobre el stream, y no tumbar el proceso ante mensajes
// corruptos o peers caidos a mitad de ronda.

export { NETWORK_STATE };

function rawConnectedStateName(rawConnectedCount) {
  return `${rawConnectedCount}_PEERS_CONNECTED`;
}

export class ParidadNetwork extends EventEmitter {
  /**
   * @param {string} selfName - debe estar incluido en `participants`.
   * @param {object} [options]
   * @param {string[]} [options.participants] - por defecto, PARTICIPANTS de aggregation-protocol.mjs.
   * @param {string} [options.topicSeed] - identifica el "canal" de Paridad; nodos con distinto
   *   seed nunca se ven entre si. Distinto del topic que usa p2p-privacy-test.mjs a proposito,
   *   para no chocar con ese script de prueba.
   * @param {Array<{host: string, port: number}>} [options.bootstrap] - nodos bootstrap del DHT.
   *   Solo para tests (testnet local de hyperdht): varios procesos en UNA misma maquina no se
   *   alcanzan de forma confiable via el DHT publico (hairpinning NAT). En uso real entre
   *   laptops distintas se omite y Hyperswarm usa el DHT publico normal.
   */
  constructor(selfName, options = {}) {
    super();

    const participants = options.participants ?? DEFAULT_PARTICIPANTS;
    if (!participants.includes(selfName)) {
      throw new Error(`selfName desconocido: ${selfName}`);
    }

    this.selfName = selfName;
    this.participants = participants;
    this.peers = participants.filter((name) => name !== selfName);
    this.topicSeed = options.topicSeed ?? "paridad-network-v1";
    this.bootstrap = options.bootstrap ?? null;

    this.swarm = null;
    this.topic = crypto.createHash("sha256").update(this.topicSeed).digest();

    // remotePublicKey (hex) -> { conn, name|null, buffer }
    this.connectionsByKey = new Map();
    // nombre de peer identificado -> remotePublicKey (hex)
    this.keyByPeerName = new Map();

    this.status = NETWORK_STATE.WAITING_FOR_PEERS;
    this._started = false;
    this._destroyed = false;
    this._discovery = null;
    this._refreshTimer = null;
  }

  // --- estado ---------------------------------------------------------

  getState() {
    return {
      selfName: this.selfName,
      participants: this.participants,
      expectedPeerCount: this.peers.length,
      rawConnectedCount: this.connectionsByKey.size,
      identifiedPeers: [...this.keyByPeerName.keys()],
      status: this.status,
    };
  }

  _recomputeStatus(trigger) {
    const identifiedCount = this.keyByPeerName.size;
    const rawIdentifiedOrPendingCount = this.connectionsByKey.size;
    const expected = this.peers.length;

    let next;
    if (identifiedCount >= expected) {
      next = NETWORK_STATE.READY_FOR_AGGREGATION;
    } else if (trigger === "disconnect") {
      next = NETWORK_STATE.PEER_DISCONNECTED;
    } else if (rawIdentifiedOrPendingCount > 0) {
      next = rawConnectedStateName(rawIdentifiedOrPendingCount);
    } else {
      next = NETWORK_STATE.WAITING_FOR_PEERS;
    }

    if (next !== this.status) {
      this.status = next;
      this.emit("state", this.getState());
    }
  }

  // --- ciclo de vida ---------------------------------------------------

  start() {
    if (this._started) return;
    this._started = true;

    this.swarm = new Hyperswarm(this.bootstrap ? { bootstrap: this.bootstrap } : {});

    this.swarm.on("error", (err) => {
      this.emit("error", err);
    });

    this.swarm.on("connection", (conn) => this._handleConnection(conn));

    this._discovery = this.swarm.join(this.topic, { client: true, server: true });

    // Mientras falten peers, fuerza re-announce + re-lookup cada pocos
    // segundos. Sin esto, un nodo que se une un poco despues queda a
    // merced del ciclo de refresh interno de Hyperswarm (~10-15s o mas):
    // marca a los demas de forma unilateral, pero los demas tardan en
    // enterarse de su announce y el par puede tardar mucho en cruzarse.
    // Con el refresh activo ambos lados se descubren rapido y el par
    // conecta a la primera. Cuando ya estan todos identificados, no hace
    // falta y se deja de refrescar.
    this._refreshTimer = setInterval(() => {
      if (this._destroyed || this.status === NETWORK_STATE.READY_FOR_AGGREGATION) return;
      this._discovery.refresh().catch(() => {});
    }, 3000);
    this._refreshTimer.unref?.();
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this._refreshTimer) clearInterval(this._refreshTimer);
    if (!this.swarm) return;

    const forceTimeout = setTimeout(() => {
      this.emit("error", new Error("swarm.destroy() tardo demasiado, abandonando"));
    }, 5000);
    forceTimeout.unref?.();

    try {
      await this.swarm.destroy();
    } finally {
      clearTimeout(forceTimeout);
      this.connectionsByKey.clear();
      this.keyByPeerName.clear();
    }
  }

  // --- mensajeria --------------------------------------------------------

  /** Envia un mensaje tipado a un peer ya identificado. No lanza si el peer no esta disponible. */
  send(peerName, type, payload) {
    const key = this.keyByPeerName.get(peerName);
    const entry = key && this.connectionsByKey.get(key);
    if (!entry) {
      this.emit("error", new Error(`No se puede enviar a "${peerName}": no esta identificado`));
      return false;
    }
    return this._write(entry.conn, { type, from: this.selfName, payload });
  }

  /** Envia un mensaje tipado a todos los peers identificados. */
  broadcast(type, payload) {
    for (const name of this.keyByPeerName.keys()) {
      this.send(name, type, payload);
    }
  }

  _write(conn, message) {
    try {
      conn.write(JSON.stringify(message) + "\n");
      return true;
    } catch (err) {
      this.emit("error", new Error(`No se pudo escribir en la conexion: ${err.message}`));
      return false;
    }
  }

  // --- manejo de conexiones ----------------------------------------------

  _handleConnection(conn) {
    const remoteKey = conn.remotePublicKey.toString("hex");

    // Hyperswarm ya deduplica conexiones por peer internamente: cuando
    // A y B se discan a la vez resuelve el empate por clave publica, y
    // en una reconexion se queda con la conexion nueva (ver
    // _handleServerConnection en hyperswarm/index.js). Por eso una
    // conexion emitida aqui es SIEMPRE la vigente para ese peer: si
    // todavia tenemos una entrada anterior con la misma clave, es un
    // resto obsoleto y se reemplaza. (Un desempate propio en esta capa
    // resulto contraproducente: destruia reconexiones validas mientras
    // conservaba conexiones zombi medio abiertas, bloqueando el pair
    // ~13s por ciclo hasta el timeout de UDX.)
    // OJO: nunca llamar removeAllListeners() sobre estos streams -- son
    // los mismos objetos que Hyperswarm registra internamente, y borrarle
    // sus listeners de "close" deja al peer marcado como conectado para
    // siempre en su tabla interna (las conexiones futuras de ese peer ya
    // no se emiten). Solo destroy(); _handleClose ignora los cierres de
    // entradas que ya fueron reemplazadas.
    const existing = this.connectionsByKey.get(remoteKey);
    if (existing) {
      existing.conn.destroy();
      if (existing.name) this.keyByPeerName.delete(existing.name);
      this.connectionsByKey.delete(remoteKey);
    }

    const entry = { conn, name: null, buffer: "" };
    this.connectionsByKey.set(remoteKey, entry);
    this._recomputeStatus("connect");

    this._write(conn, { type: "hello", from: this.selfName, payload: null });

    conn.on("data", (data) => this._handleData(remoteKey, entry, data));

    conn.on("error", (err) => {
      this.emit("error", new Error(`Conexion con ${entry.name ?? "peer sin identificar"}: ${err.message}`));
      // La limpieza de estado normalmente la hace "close", que Hyperswarm
      // emite igual tras un error. Pero con red real inestable (Wi-Fi, no
      // localhost) se observaron conexiones que erroran y luego NUNCA
      // cierran: el timer de abajo es el respaldo para que esa entrada no
      // se quede viva para siempre en connectionsByKey.
    });

    conn.on("close", () => this._handleClose(remoteKey, entry));

    // Respaldo: si tras este plazo la conexion no se identifico Y sigue
    // "viva" segun nuestro propio mapa, se fuerza su cierre y limpieza.
    // Sin esto, una conexion que erroro sin disparar "close" (visto en
    // pruebas reales entre laptops, no en localhost) queda acumulada para
    // siempre: cada reintento de descubrimiento suma una entrada mas y la
    // memoria del proceso crece sin limite durante una reconexion larga.
    const idTimeout = setTimeout(() => {
      if (this.connectionsByKey.get(remoteKey) !== entry || entry.name) return;
      entry.conn.destroy();
      this._handleClose(remoteKey, entry);
    }, 20000);
    idTimeout.unref?.();
    conn.on("close", () => clearTimeout(idTimeout));
  }

  _handleData(remoteKey, entry, data) {
    // Framing NDJSON: el stream puede entregar varios mensajes juntos
    // o uno partido en varios eventos "data".
    entry.buffer += data.toString();
    let newlineIndex;
    while ((newlineIndex = entry.buffer.indexOf("\n")) !== -1) {
      const line = entry.buffer.slice(0, newlineIndex);
      entry.buffer = entry.buffer.slice(newlineIndex + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch (err) {
        // Un mensaje corrupto descarta ese mensaje, nunca el nodo ni la conexion.
        this.emit("error", new Error(`Mensaje descartado (JSON invalido) de ${entry.name ?? remoteKey.slice(0, 8)}: ${err.message}`));
        continue;
      }

      if (message === null || typeof message !== "object") {
        this.emit("error", new Error(`Mensaje con formato inesperado de ${entry.name ?? remoteKey.slice(0, 8)}`));
        continue;
      }

      this._handleMessage(remoteKey, entry, message);
    }
  }

  _handleMessage(remoteKey, entry, message) {
    if (message.type === "hello") {
      if (entry.name) return; // ya identificado

      const claimedName = message.from;
      if (claimedName === this.selfName || !this.participants.includes(claimedName)) {
        this.emit("error", new Error(`Identidad de peer invalida ("${claimedName}"), cerrando conexion`));
        entry.conn.destroy();
        return;
      }
      if (this.keyByPeerName.has(claimedName)) {
        // El nombre ya esta mapeado a OTRA clave: el peer se reinicio
        // con un keypair nuevo. La conexion vieja puede estar muerta sin
        // que lo sepamos todavia; la nueva es la vigente. (Participantes
        // son un conjunto fijo y conocido -- ver CLAUDE.md -- asi que no
        // tratamos esto como robo de identidad.)
        const oldKey = this.keyByPeerName.get(claimedName);
        const old = this.connectionsByKey.get(oldKey);
        if (old) {
          old.conn.destroy();
          this.connectionsByKey.delete(oldKey);
        }
        this.keyByPeerName.delete(claimedName);
      }

      entry.name = claimedName;
      this.keyByPeerName.set(claimedName, remoteKey);
      this._recomputeStatus("connect");
      this.emit("peer:identified", claimedName);
      return;
    }

    // Cualquier otro tipo de mensaje requiere que el remitente ya este identificado
    // y que coincida con quien dice ser (evita mensajes de un peer no verificado).
    if (!entry.name || entry.name !== message.from) {
      this.emit("error", new Error("Mensaje con remitente no verificado, ignorado"));
      return;
    }

    this.emit("message", { from: message.from, type: message.type, payload: message.payload });
  }

  _handleClose(remoteKey, entry) {
    // Si esta entrada ya fue reemplazada por una conexion mas nueva, el
    // cierre de la vieja no es una desconexion real: no hay que limpiar.
    if (this.connectionsByKey.get(remoteKey) !== entry) return;

    this.connectionsByKey.delete(remoteKey);
    if (entry.name) {
      this.keyByPeerName.delete(entry.name);
      this.emit("peer:disconnected", entry.name);
      this._recomputeStatus("disconnect");
    } else {
      this._recomputeStatus("disconnect-unidentified");
    }
  }
}
