/**
 * Nodo de agregación privada de Paridad sobre Hyperswarm.
 *
 * Esta es la lógica P2P que antes vivía dentro de p2p-privacy-test.mjs,
 * extraída para poder reutilizarla desde distintos puntos de entrada (precios
 * de demo fijos, o precios extraídos de una factura con QVAC). El protocolo de
 * cable es EL MISMO, mensaje por mensaje:
 *
 *   {"type":"hello","node":"A"}
 *   {"type":"share","from":"A","share":"<entero mod p>"}
 *   {"type":"column-sum","from":"A","value":"<entero mod p>"}
 *
 * Lo que NO hace este módulo:
 *   - no conoce facturas, OCR ni QVAC;
 *   - no decide el valor privado, lo recibe ya calculado;
 *   - no toca la matemática de secret sharing (eso es secret-sharing.mjs);
 *   - no instala manejadores de señales: eso corresponde al script que lo usa.
 */

import Hyperswarm from "hyperswarm";
import DHT from "hyperdht";
import crypto from "crypto";
import {
  PARTICIPANTS,
  buildShareMatrix,
  AggregationSession,
} from "../privacy/aggregation-protocol.mjs";

export const TOPIC_POR_DEFECTO = "paridad-aggregation-protocol-v1";

/**
 * Comprueba si un mensaje serializable contiene el valor privado.
 *
 * Se compara por igualdad de valor, no por subcadena: los shares son enteros
 * de ~39 dígitos y un precio de 4 dígitos puede aparecer por casualidad dentro
 * de ellos sin que eso signifique fuga alguna. Lo que debe ser imposible es
 * que el precio viaje COMO valor.
 */
export function mensajeFiltraValor(mensaje, valorPrivado) {
  const objetivo = String(valorPrivado);

  const visitar = (valor) => {
    if (valor === null || valor === undefined) return false;
    if (typeof valor === "object") return Object.values(valor).some(visitar);
    return String(valor) === objetivo;
  };

  return visitar(mensaje);
}

/**
 * Crea un nodo de agregación.
 *
 * @param {string}   nodeName      identidad del nodo en la ronda ("A", "B"...)
 * @param {bigint}   privateValue  valor privado en centavos. Nunca sale del proceso.
 * @param {string[]} participants  orden fijo de participantes.
 * @param {string}   topicName     topic de Hyperswarm.
 * @param {number}   timeoutMs     0 = esperar indefinidamente. Si se agota antes
 *                                 de completar la ronda, se resuelve como ronda
 *                                 incompleta en vez de quedarse colgado.
 * @param {string[]} bootstrap     lista de "host:puerto" de nodos bootstrap.
 *                                 Vacío/null = DHT público (comportamiento
 *                                 actual). Con valores, el nodo se une a un DHT
 *                                 privado y NO consulta la red pública.
 * @param {object}   log           destino de los mensajes legibles.
 */
export function createAggregationNode({
  nodeName,
  privateValue,
  participants = PARTICIPANTS,
  topicName = TOPIC_POR_DEFECTO,
  timeoutMs = 0,
  bootstrap = null,
  log = console,
}) {
  if (!participants.includes(nodeName)) {
    throw new Error(`nodeName desconocido: ${nodeName}`);
  }

  const valorPrivado = BigInt(privateValue);
  const misShares = buildShareMatrix(valorPrivado, participants);
  const session = new AggregationSession(nodeName, participants);
  session.recordOwnShare(misShares[nodeName]);

  // --- Descubrimiento -------------------------------------------------------
  // Sin `bootstrap` se mantiene exactamente el comportamiento de siempre:
  // Hyperswarm construye su propio DHT contra los bootstrap públicos.
  //
  // Con `bootstrap`, se construye el DHT a mano para poder apuntarlo a un
  // bootstrap local. Se hace con `new DHT(...)` y no con las opciones de
  // Hyperswarm porque un DHT privado de 3-4 nodos necesita además
  // `ephemeral: false` y `firewalled: false` (es el mismo patrón que usa el
  // helper de testnet de hyperdht): en una red tan pequeña los nodos efímeros
  // no sostienen los anuncios del topic.
  //
  // hyperdht resuelve `opts.bootstrap || BOOTSTRAP_NODES`, así que una lista no
  // vacía impide cualquier consulta a la red pública: si el bootstrap local no
  // responde, el nodo NO se cae silenciosamente al DHT público, simplemente no
  // encuentra a nadie.
  const usaBootstrapLocal = Array.isArray(bootstrap) && bootstrap.length > 0;
  const modoDescubrimiento = usaBootstrapLocal ? "bootstrap-local" : "dht-publico";

  const swarm = usaBootstrapLocal
    ? new Hyperswarm({
        dht: new DHT({ bootstrap, ephemeral: false, firewalled: false }),
      })
    : new Hyperswarm();

  const topic = crypto.createHash("sha256").update(topicName).digest();

  // remotePublicKey (hex) -> nombre de nodo, una vez confirmado por "hello".
  const nodeNameByPeerKey = new Map();
  // nombre de nodo -> conexión activa (evita procesar duplicados).
  const connectionByNode = new Map();

  // Auditoría de privacidad: se guarda TODO lo que sale por la red.
  const mensajesEnviados = [];

  let columnSumBroadcast = false;
  let rondaCerrada = false;
  let temporizador = null;
  let descubrimiento = null;
  let refresco = null;

  let resolverResultado;
  const resultado = new Promise((resolve) => {
    resolverResultado = resolve;
  });

  function peerLabel(conn) {
    const remoteKey = conn.remotePublicKey?.toString("hex");
    return (remoteKey && nodeNameByPeerKey.get(remoteKey)) || "peer sin identificar";
  }

  function send(conn, mensaje) {
    // Puerta de auditoría: ningún mensaje puede llevar el valor privado.
    // Si esto salta es un bug del protocolo, no una condición esperada.
    if (mensajeFiltraValor(mensaje, valorPrivado)) {
      throw new Error(
        `FUGA DE PRIVACIDAD: el nodo ${nodeName} intentó enviar su valor privado en un mensaje "${mensaje.type}"`
      );
    }

    const serializado = JSON.stringify(mensaje);
    mensajesEnviados.push({ tipo: mensaje.type, bytes: serializado.length, json: serializado });

    // Escribir sobre una conexión que ya se cerró (peer caído a mitad de la
    // ronda) no debe tumbar el nodo: se registra y se sigue.
    try {
      conn.write(serializado + "\n");
    } catch (err) {
      log.warn(
        `⚠️  Nodo ${nodeName}: no se pudo enviar "${mensaje.type}" a ${peerLabel(conn)}: ${err.message}`
      );
    }
  }

  function broadcastColumnSum() {
    if (columnSumBroadcast) return;
    const columnSum = session.computeColumnSum();
    columnSumBroadcast = true;

    log.log(
      `📤 Nodo ${nodeName}: shares de los ${participants.length} participantes recibidos. Suma parcial (column-sum) calculada: ${columnSum}`
    );
    log.log(
      "   (este valor mezcla un fragmento de cada precio original; por sí solo no revela ningún precio individual)"
    );

    for (const conn of connectionByNode.values()) {
      send(conn, { type: "column-sum", from: nodeName, value: columnSum.toString() });
    }
  }

  function maybeAnnounceTotal() {
    if (rondaCerrada || !session.hasAllColumnSums()) return;
    rondaCerrada = true;
    if (temporizador) clearTimeout(temporizador);

    const total = session.computeTotal();
    const average = Number(total) / participants.length;
    const position = ((Number(valorPrivado) - average) / average) * 100;

    log.log(`\n📊 Resultado del benchmark (calculado localmente por ${nodeName}, sin servidor central):`);
    log.log(`PEERS: ${participants.length}`);
    log.log(`Tu precio:       hidden (solo tú lo conoces)`);
    log.log(`Total del grupo: ${total} centavos`);
    log.log(`Promedio grupo:  $${(average / 100).toFixed(2)} (${average.toFixed(0)} centavos)`);
    log.log(`Tu posición:     ${position >= 0 ? "+" : ""}${position.toFixed(1)}% vs. el promedio`);

    resolverResultado({ completo: true, total, average, position, nodeName });
  }

  function rondaIncompleta(motivo) {
    if (rondaCerrada) return;
    rondaCerrada = true;

    const faltanShares = participants.filter(
      (p) => p !== nodeName && !session.receivedShares.has(p)
    );
    const faltanSumas = participants.filter(
      (p) => p !== nodeName && !session.receivedColumnSums.has(p)
    );

    log.log(`\n⏳ Nodo ${nodeName}: RONDA INCOMPLETA (${motivo}).`);
    log.log(`   Falta el share de:        ${faltanShares.join(", ") || "nadie"}`);
    log.log(`   Falta la suma parcial de: ${faltanSumas.join(", ") || "nadie"}`);
    log.log("   No se publica ningún benchmark: el protocolo necesita a todos los participantes.");

    resolverResultado({ completo: false, motivo, faltanShares, faltanSumas, nodeName });
  }

  function handleMessage(conn, message) {
    if (message.type === "hello") {
      const remoteKey = conn.remotePublicKey.toString("hex");
      if (nodeNameByPeerKey.has(remoteKey)) return; // ya saludado

      if (message.node === nodeName || !participants.includes(message.node)) {
        log.warn(`⚠️  Nodo ${nodeName}: identidad de peer inválida (${message.node}), ignorando conexión`);
        conn.destroy();
        return;
      }

      if (connectionByNode.has(message.node)) {
        // Conexión duplicada hacia un peer ya conocido (puede pasar con
        // topics de Hyperswarm si ambos lados intentan conectar). Nos
        // quedamos con la primera y cerramos esta.
        conn.destroy();
        return;
      }

      nodeNameByPeerKey.set(remoteKey, message.node);
      connectionByNode.set(message.node, conn);
      log.log(`🔗 Nodo ${nodeName}: conexión P2P confirmada con ${message.node}`);

      // Le envío ÚNICAMENTE el share que le corresponde a este peer,
      // nunca los otros dos shares que generé.
      send(conn, {
        type: "share",
        from: nodeName,
        share: misShares[message.node].toString(),
      });
      return;
    }

    const fromNode = nodeNameByPeerKey.get(conn.remotePublicKey.toString("hex"));
    if (!fromNode || fromNode !== message.from) {
      log.warn(`⚠️  Nodo ${nodeName}: mensaje con remitente no verificado, ignorado`);
      return;
    }

    if (message.type === "share") {
      session.recordPeerShare(fromNode, message.share);
      log.log(`📩 Nodo ${nodeName}: share privado recibido de ${fromNode} (valor enmascarado, no es su precio)`);

      if (session.hasAllShares()) {
        broadcastColumnSum();
      }
      return;
    }

    if (message.type === "column-sum") {
      session.recordColumnSum(fromNode, message.value);
      log.log(`📩 Nodo ${nodeName}: suma parcial recibida de ${fromNode}`);
      maybeAnnounceTotal();
      return;
    }
  }

  function alConectar(conn) {
    let buffer = "";

    send(conn, { type: "hello", node: nodeName });

    conn.on("data", (data) => {
      // Framing NDJSON: TCP/las streams de Hyperswarm pueden entregar
      // varios mensajes juntos o un mensaje partido en varios "data".
      buffer += data.toString();
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;

        // Un mensaje corrupto, mal formado o rechazado por el protocolo
        // (duplicado, remitente desconocido) descarta ese mensaje, no el nodo.
        try {
          const message = JSON.parse(line);
          if (message === null || typeof message !== "object") {
            log.warn(`⚠️  Nodo ${nodeName}: mensaje con formato inesperado de ${peerLabel(conn)}, ignorado`);
            continue;
          }
          handleMessage(conn, message);
        } catch (err) {
          log.warn(`⚠️  Nodo ${nodeName}: mensaje descartado de ${peerLabel(conn)} (${err.message})`);
        }
      }
    });

    // Sin este listener, un error de stream (peer caído, handshake fallido)
    // se convierte en excepción no capturada y mata el nodo.
    conn.on("error", (err) => {
      log.warn(`⚠️  Nodo ${nodeName}: error de conexión con ${peerLabel(conn)}: ${err.message}`);
    });

    conn.on("close", () => {
      const remoteKey = conn.remotePublicKey.toString("hex");
      const peerName = nodeNameByPeerKey.get(remoteKey);
      if (peerName) {
        log.log(`🔌 Nodo ${nodeName}: ${peerName} se desconectó`);
        connectionByNode.delete(peerName);
        nodeNameByPeerKey.delete(remoteKey);

        if (!rondaCerrada) {
          log.log(`   La ronda no puede completarse sin ${peerName}; el nodo sigue en pie por si vuelve.`);
        }
      }
    });
  }

  return {
    nodeName,
    misShares,
    resultado,
    modoDescubrimiento,

    /** Peers con conexión P2P confirmada en este instante. */
    peersConectados() {
      return [...connectionByNode.keys()].sort();
    },

    /** Resumen auditable de todo lo que este nodo puso en la red. */
    auditoria() {
      return {
        valorPrivadoTransmitido: mensajesEnviados.some((m) =>
          mensajeFiltraValor(JSON.parse(m.json), valorPrivado)
        ),
        mensajes: mensajesEnviados.map(({ tipo, bytes }) => ({ tipo, bytes })),
        payloads: mensajesEnviados.map((m) => m.json),
      };
    },

    start() {
      swarm.on("error", (err) => {
        log.warn(`⚠️  Nodo ${nodeName}: error del swarm: ${err.message}`);
      });
      swarm.on("connection", alConectar);
      descubrimiento = swarm.join(topic, { client: true, server: true });

      // Refresco activo del descubrimiento hasta que la malla esté completa.
      //
      // Hyperswarm solo vuelve a consultar el DHT cada ~10 min (REFRESH_INTERVAL
      // más un jitter de 2 min). En el DHT público eso da igual: los anuncios
      // están ampliamente replicados y la primera consulta ya encuentra a todos.
      // En un DHT privado de 4 nodos NO: quien consulta antes de que otro se
      // haya anunciado no lo vuelve a ver hasta el refresco periódico, y la
      // malla se queda en estrella (A ve a B y C, pero B y C no se ven entre sí)
      // y la ronda nunca cierra.
      //
      // Esto es descubrimiento, no protocolo: no cambia qué se envía ni a quién.
      const faltanPeers = () => connectionByNode.size < participants.length - 1;

      refresco = setInterval(() => {
        if (rondaCerrada || !faltanPeers()) {
          clearInterval(refresco);
          refresco = null;
          return;
        }
        descubrimiento.refresh({ client: true, server: true }).catch(() => {
          // Un refresco fallido no es fatal: se reintenta en el siguiente tick.
        });
      }, 3000);
      refresco.unref();

      if (timeoutMs > 0) {
        temporizador = setTimeout(() => rondaIncompleta(`sin completar tras ${timeoutMs} ms`), timeoutMs);
        temporizador.unref();
      }

      return resultado;
    },

    async stop() {
      if (temporizador) clearTimeout(temporizador);
      if (refresco) clearInterval(refresco);
      await swarm.destroy();
    },
  };
}
