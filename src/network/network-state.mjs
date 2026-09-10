// Enum de estados de red, sin ninguna dependencia (ni Hyperswarm, ni
// Node). Vive separado de paridad-network.mjs para poder importarse
// tanto desde el backend (Node) como desde la UI (navegador), sin
// arrastrar dependencias que el navegador no puede resolver.
export const NETWORK_STATE = Object.freeze({
  WAITING_FOR_PEERS: "WAITING_FOR_PEERS",
  READY_FOR_AGGREGATION: "READY_FOR_AGGREGATION",
  PEER_DISCONNECTED: "PEER_DISCONNECTED",
});
