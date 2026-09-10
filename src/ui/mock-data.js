// Fuente de datos MOCK para la primera version de la UI. Nada de esto
// viene de una API, de la red, ni de QVAC -- son valores fijos para
// poder disenar y probar la interfaz antes de que la capa de red y el
// pipeline de IA esten conectados a ella.
//
// Cuando exista una fuente real (ej: un objeto respaldado por
// ParidadNetwork + eventos de la UI), debe implementar la MISMA forma
// que `mockDataSource` (un metodo `subscribe(callback)`) para poder
// reemplazar este archivo sin tocar app.js.
import { NETWORK_STATE } from "../network/network-state.mjs";

const MOCK_STATE = Object.freeze({
  isMock: true,
  nodeName: "A",

  network: {
    status: NETWORK_STATE.READY_FOR_AGGREGATION,
    identifiedPeers: ["B", "C"],
    expectedPeerCount: 2,
  },

  localAi: {
    status: "ACTIVE", // ACTIVE | LOADING | OFFLINE
    model: "qwen3-600m-inst-q4",
  },

  internet: {
    // Paridad debe poder demostrar que el benchmark sigue funcionando
    // con internet apagado, una vez que la capa de red tenga
    // descubrimiento local (ver CLAUDE.md, seccion 14).
    status: "OFFLINE", // ONLINE | OFFLINE
  },

  privacy: {
    sharesExchanged: 2,
    note: "Tu precio nunca sale de tu dispositivo. Solo se comparten fragmentos matematicos (shares), nunca el valor real.",
  },

  invoice: {
    // No hay pipeline de OCR conectado todavia (ver decision del equipo:
    // esa parte quedo fuera de esta rama). Este bloque es un placeholder
    // visual para donde ira la factura una vez que exista esa fuente real.
    fileName: null,
    items: [
      { product: "Aceite Motor 20W50", quantity: 4, unitPrice: "hidden" },
    ],
  },

  benchmark: {
    yourPrice: "hidden",
    groupAverage: 43.33,
    yourPositionPercent: 8.5,
    participants: 3,
  },
});

export const mockDataSource = {
  /** @param {(state: typeof MOCK_STATE) => void} callback */
  subscribe(callback) {
    callback(MOCK_STATE);
    return () => {}; // unsubscribe no-op: los datos mock no cambian solos
  },
};
