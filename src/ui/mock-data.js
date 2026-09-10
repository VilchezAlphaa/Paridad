// Fuente de datos MOCK de la UI. Nada de esto viene de una API, de la
// red ni de QVAC -- son valores fijos para disenar y probar la interfaz
// sin la capa real. La fuente real (real-data-source.js, alimentada por
// nodo-paridad.mjs) implementa la MISMA forma que este estado.
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
    status: "OFFLINE", // ONLINE | OFFLINE
  },

  privacy: {
    sharesExchanged: 10,
    note: "Tus precios nunca salen de tu dispositivo. Solo se comparten fragmentos matematicos (shares), nunca los valores reales.",
  },

  // status: WAITING | NOT_COMMON | SHARING | DONE (ver ITEM_STATE del runner)
  items: [
    { product: "Aceite Motor 20W50", quantity: 4, proveedor: "Distribuidora Central", unitPrice: 47.0, status: "DONE", groupAverage: 43.33, positionPercent: 8.5 },
    { product: "Filtro de aceite", quantity: 12, proveedor: "Distribuidora Central", unitPrice: 6.8, status: "DONE", groupAverage: 6.8, positionPercent: 0.0 },
    { product: "Pastillas de freno delanteras", quantity: 6, proveedor: "Refaccionaria Lopez", unitPrice: 28.5, status: "DONE", groupAverage: 25.53, positionPercent: 11.6 },
    { product: "Bateria 12V 650A", quantity: 2, proveedor: "Repuestos El Rapido", unitPrice: 78.0, status: "DONE", groupAverage: 80.5, positionPercent: -3.1 },
    { product: "Bujias de encendido (juego x4)", quantity: 8, proveedor: "Ferreteria Ideal", unitPrice: 16.4, status: "SHARING", groupAverage: null, positionPercent: null },
  ],

  summary: {
    potentialSavings: 32.5,
    savingsCount: 2,
    benchmarkedCount: 4,
    totalItems: 5,
    participants: 3,
  },

  settings: {
    port: 4700,
    group: "paridad-network-v1",
    participants: ["A", "B", "C"],
    invoiceFolder: null,
  },
});

export const mockDataSource = {
  /** @param {(state: typeof MOCK_STATE) => void} callback */
  subscribe(callback) {
    callback(MOCK_STATE);
    return () => {}; // unsubscribe no-op: los datos mock no cambian solos
  },
};
