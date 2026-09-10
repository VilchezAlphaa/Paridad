// Fuente de datos REAL de la UI: consume el estado que publica el
// proceso local nodo-paridad.mjs por SSE (/events). Mismo contrato que
// mockDataSource (subscribe(callback) -> unsubscribe), asi que app.js
// puede usar cualquiera de las dos sin cambios.
//
// Solo funciona cuando la pagina la sirve nodo-paridad.mjs (localhost).
// Si la UI se sirve como archivos estaticos (`npm run ui`), /events no
// existe y app.js cae al mock.
export const realDataSource = {
  /** @param {(state: object) => void} callback */
  subscribe(callback) {
    const source = new EventSource("/events");
    source.onmessage = (event) => callback(JSON.parse(event.data));
    // Si el nodo local se cae, EventSource reintenta solo; no hay nada
    // que hacer aqui mas que dejarlo reconectar.
    return () => source.close();
  },
};

/** true si esta pagina la esta sirviendo un nodo Paridad local. */
export async function isServedByParidadNode() {
  try {
    const res = await fetch("/api/state");
    return res.ok;
  } catch {
    return false;
  }
}
