// Renderizador del dashboard de Paridad. No sabe de Hyperswarm ni de
// QVAC: solo recibe un estado (subscribe(callback)) y lo pinta. Fuente
// real por SSE si la sirve nodo-paridad.mjs; mock si es estatica.
import { NETWORK_STATE } from "../network/network-state.mjs";
import { pickDataSource, formatPrice } from "./ui-common.js";

const $ = (id) => document.getElementById(id);

function setStatus(id, text, tone) {
  const el = $(id);
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function renderHeader(state) {
  const name = state.nodeName ?? "?";
  $("node-label").textContent = `Tu nodo local — ${name}`;
  $("avatar").textContent = name.slice(0, 2).toUpperCase();

  const { status } = state.network;
  const sync = $("sync-text");
  if (status === NETWORK_STATE.READY_FOR_AGGREGATION) {
    sync.textContent = "Conectado al grupo";
    sync.dataset.tone = "ok";
  } else if (status === NETWORK_STATE.PEER_DISCONNECTED) {
    sync.textContent = "Un peer se desconectó";
    sync.dataset.tone = "bad";
  } else {
    sync.textContent = "Buscando peers…";
    sync.dataset.tone = "warn";
  }
}

function renderStatus(state) {
  const { status, identifiedPeers, expectedPeerCount } = state.network;

  if (status === NETWORK_STATE.READY_FOR_AGGREGATION) {
    setStatus("st-p2p", "CONECTADO", "ok");
  } else if (status === NETWORK_STATE.PEER_DISCONNECTED) {
    setStatus("st-p2p", "PEER CAÍDO", "bad");
  } else {
    setStatus("st-p2p", "BUSCANDO…", "warn");
  }

  setStatus(
    "st-peers",
    `${identifiedPeers.length} / ${expectedPeerCount}`,
    identifiedPeers.length >= expectedPeerCount ? "ok" : "warn"
  );

  // La IA local solo se marca en rojo cuando de verdad no hay ninguna:
  // decir OFFLINE mientras esta cargando modelos o procesando una factura
  // era exactamente lo contrario de lo que estaba pasando.
  const ai = state.localAi.status;
  const ex = state.extraction?.status;
  if (ex === "PROCESSING") {
    setStatus("st-ai", "PROCESANDO…", "warn");
  } else if (ai === "LOADING") {
    setStatus("st-ai", "CARGANDO…", "warn");
  } else if (ai === "ACTIVE") {
    setStatus("st-ai", state.localAi.model, "ok");
  } else if (ai === "DONE") {
    setStatus("st-ai", "LISTA ✓", "ok");
  } else if (ai === "IDLE") {
    setStatus("st-ai", "EN ESPERA", "warn");
  } else {
    setStatus("st-ai", "NO ACTIVA", "bad");
  }

  // Dato estructural, no una medida: Paridad no tiene ninguna ruta hacia
  // un servicio de inferencia externo. Antes aqui iba el estado de
  // internet, que es otra cosa y confundia (se podia leer "ONLINE" como
  // "esta usando la nube").
  setStatus("st-cloud", state.cloudAi?.used ? "EN USO" : "NO USADA", state.cloudAi?.used ? "bad" : "ok");

  setStatus("st-shares", String(state.privacy.sharesExchanged), state.privacy.sharesExchanged > 0 ? "ok" : undefined);
  $("privacy-note").textContent = state.privacy.note;
}

// --- pantalla inicial ---------------------------------------------------

function renderLanding(state) {
  const h = state.historial ?? { resumen: { facturas: 0, productos: 0 } };
  $("ls-facturas").textContent = String(h.resumen.facturas);
  $("ls-productos").textContent = String(h.resumen.productos);
  $("ls-peers").textContent = `${state.network.identifiedPeers.length + 1} / ${state.network.expectedPeerCount + 1}`;

  const ex = state.extraction ?? { status: "IDLE", pendientes: 0 };
  const btn = $("procesar-btn");
  const pendientes = ex.pendientes ?? 0;
  btn.hidden = !(ex.status === "IDLE" && pendientes > 0);
  btn.textContent = pendientes === 1 ? "Procesar 1 factura pendiente" : `Procesar ${pendientes} facturas pendientes`;

  const hint = $("landing-hint");
  if (ex.status === "LOADING_AI") hint.textContent = "Cargando la IA local…";
  else if (ex.status === "PROCESSING") hint.textContent = `Leyendo ${ex.currentFile}…`;
  else if (ex.status === "ERROR") hint.textContent = `⚠ ${ex.error ?? "fallo del pipeline"}`;
  else hint.textContent = "PNG o JPG · se procesa en este dispositivo";

  // Subir una factura: va al proceso local (localhost), nunca a un servidor.
  $("factura-input").disabled = ex.status === "LOADING_AI" || ex.status === "PROCESSING";
}

// --- panel de procesamiento (solo mientras trabaja o justo despues) ---------

function marcarPaso(nombre, estado, texto) {
  const li = document.querySelector(`.flow-step[data-step="${nombre}"]`);
  if (li) li.dataset.state = estado;
  const sub = $(`flow-${nombre}`);
  if (sub) sub.textContent = texto;
}

function etiquetaComparacion(c) {
  if (!c) return { label: "Comparación pendiente", className: "", detail: "" };
  if (c.estado === "DISPONIBLE") {
    const pct = c.posicionPct;
    const signo = pct >= 0 ? "+" : "";
    return {
      label: `Referencia ${formatPrice(c.referencia)}`,
      className: pct > 1 ? "over" : "good",
      detail: `${signo}${pct.toFixed(1)}% · ${c.participantes} negocios`,
    };
  }
  if (c.estado === "NO_DISPONIBLE") {
    return { label: "Sin comparación disponible", className: "", detail: c.motivo ?? "" };
  }
  return { label: "Comparación pendiente", className: "", detail: "esperando al grupo" };
}

/** Fila de un registro del historial: producto, TU precio, y su comparación. */
function filaRegistro(r, index) {
  const cmp = etiquetaComparacion(r.comparacion);
  const row = document.createElement("div");
  row.className = `row${cmp.className ? ` row-${cmp.className}` : ""}`;

  const rank = document.createElement("span");
  rank.className = "row-rank";
  rank.textContent = String(index + 1).padStart(2, "0");

  const nameWrap = document.createElement("span");
  nameWrap.className = "row-name";
  const prodName = document.createElement("span");
  prodName.className = "prod-name";
  prodName.textContent = r.product;
  const meta = document.createElement("span");
  meta.className = "row-proveedor";
  meta.textContent = `${r.quantity} und · ${r.archivo}`;
  nameWrap.append(prodName, meta);

  const yourPrice = document.createElement("span");
  yourPrice.className = "price";
  yourPrice.innerHTML = `<span class="lbl">Tú pagas</span>`;
  yourPrice.append(formatPrice(r.unitPrice));

  const verdictEl = document.createElement("span");
  verdictEl.className = `verdict${cmp.className ? ` ${cmp.className}` : ""}`;
  verdictEl.innerHTML = `<span class="verdict-label"></span><span class="verdict-pct"></span>`;
  verdictEl.querySelector(".verdict-label").textContent = cmp.label;
  verdictEl.querySelector(".verdict-pct").textContent = cmp.detail;

  row.append(rank, nameWrap, yourPrice, verdictEl);
  return row;
}

function renderFlow(state) {
  const ex = state.extraction ?? { status: "IDLE" };
  const panel = $("flow-panel");
  const trabajando = ex.status === "LOADING_AI" || ex.status === "PROCESSING";
  const ultima = ex.ultimaFactura;

  // Se muestra mientras trabaja, y despues como "Factura procesada" con
  // los productos de ESA factura. Sin nada que contar, se oculta.
  panel.hidden = !trabajando && !ultima && ex.status !== "ERROR";
  if (panel.hidden) return;

  if (trabajando) {
    $("flow-title").textContent = "Procesando tu factura";
    $("flow-subtitle").textContent = "Todo esto ocurre en este dispositivo.";
  } else if (ex.status === "ERROR") {
    $("flow-title").textContent = "No se pudo procesar";
    $("flow-subtitle").textContent = ex.error ?? "";
  } else {
    $("flow-title").textContent = "Factura procesada";
    $("flow-subtitle").textContent =
      ultima.lineas === 1 ? "1 producto registrado" : `${ultima.lineas} productos registrados`;
  }

  if (ex.status === "PROCESSING") marcarPaso("factura", "done", `${ex.currentFile} cargada`);
  else if (ultima) marcarPaso("factura", "done", ultima.archivo);
  else marcarPaso("factura", "", "en cola");

  if (ex.status === "LOADING_AI") marcarPaso("ia", "active", "cargando los modelos en este dispositivo…");
  else if (ex.status === "PROCESSING") marcarPaso("ia", "active", "extrayendo productos y precios…");
  else if (ex.status === "ERROR") marcarPaso("ia", "error", ex.error ?? "fallo");
  else marcarPaso("ia", "done", `procesamiento completado · ${state.localAi.model}`);

  if (ultima && !trabajando) marcarPaso("precio", "done", "solo tú los ves; por la red no viaja ninguno");
  else marcarPaso("precio", "", "aún sin datos");

  const card = $("flow-result");
  if (ultima && !trabajando) {
    card.hidden = false;
    $("flow-result-product").textContent = ultima.archivo;
    const rows = $("flow-result-rows");
    rows.replaceChildren();
    (state.historial?.registros ?? [])
      .filter((r) => r.facturaId === ultima.id)
      .forEach((r, i) => rows.append(filaRegistro(r, i)));
  } else {
    card.hidden = true;
  }
}

// --- Mis compras --------------------------------------------------------

function renderCompras(state) {
  const rows = $("compras-rows");
  rows.replaceChildren();
  const registros = state.historial?.registros ?? [];
  const resumen = state.historial?.resumen ?? { facturas: 0, productos: 0 };

  $("compras-sub").textContent = registros.length
    ? `${resumen.productos} producto(s) de ${resumen.facturas} factura(s), guardados en este dispositivo.`
    : "Todo lo extraído de tus facturas, guardado en este dispositivo.";

  if (!registros.length) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span class="row-rank">—</span><span class="row-name"><span class="prod-name">Todavía no hay compras. Agrega una factura para empezar.</span></span>`;
    rows.append(row);
    return;
  }
  registros.forEach((r, i) => rows.append(filaRegistro(r, i)));
}

function render(state) {
  $("mock-banner").hidden = !state.isMock;
  renderHeader(state);
  renderLanding(state);
  renderFlow(state);
  renderCompras(state);
  renderStatus(state);
}

$("procesar-btn").addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  try {
    await fetch("/api/procesar", { method: "POST" });
  } catch {
    // Si falla, el proximo estado por SSE volvera a mostrar el boton.
  } finally {
    event.currentTarget.disabled = false;
  }
});

$("factura-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  $("landing-hint").textContent = `Enviando ${file.name} al proceso local…`;
  try {
    const res = await fetch("/api/factura", {
      method: "POST",
      headers: { "x-nombre": encodeURIComponent(file.name), "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      $("landing-hint").textContent = `⚠ ${err.error ?? `error ${res.status}`}`;
    }
  } catch (err) {
    $("landing-hint").textContent = `⚠ ${err.message}`;
  }
});

const dataSource = await pickDataSource();
dataSource.subscribe(render);
