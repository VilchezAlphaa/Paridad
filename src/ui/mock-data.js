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
    // esa parte quedo fuera de esta rama). Top-5 de ejemplo para disenar
    // la lista; en la fuente real solo el primer item tiene benchmark
    // (un producto por ronda) y los demas quedan "en cola".
    fileName: null,
    items: [
      { product: "Aceite Motor 20W50", quantity: 4, unitPrice: 47.0 },
      { product: "Filtro de aceite", quantity: 12, unitPrice: 6.8 },
      { product: "Pastillas de freno delanteras", quantity: 6, unitPrice: 28.5 },
      { product: "Bateria 12V 650A", quantity: 2, unitPrice: 78.0 },
      { product: "Bujias de encendido (juego x4)", quantity: 8, unitPrice: 16.4 },
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
