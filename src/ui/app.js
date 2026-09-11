// Renderizador del dashboard de Paridad. No sabe de Hyperswarm ni de
// QVAC: solo recibe un estado (subscribe(callback)) y lo pinta. Fuente
// real por SSE si la sirve nodo-paridad.mjs; mock si es estatica.
import { NETWORK_STATE } from "../network/network-state.mjs";
import { pickDataSource, formatPrice, buildItemRow } from "./ui-common.js";

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

function renderProducts(state) {
  const rows = $("product-rows");
  rows.replaceChildren();

  if (!state.items.length) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span class="row-rank">01</span><span class="row-name"><span class="prod-name">Sin datos</span></span>`;
    rows.append(row);
    return;
  }

  // El dashboard muestra hasta 5; la lista completa vive en productos.html.
  state.items.slice(0, 5).forEach((item, index) => rows.append(buildItemRow(item, index)));
}

function renderKpis(state) {
  const { potentialSavings, savingsCount, benchmarkedCount, totalItems, participants } = state.summary;

  $("kpi-savings").textContent = benchmarkedCount > 0 ? formatPrice(potentialSavings) : "—";

  const count = $("kpi-savings-count");
  count.textContent = benchmarkedCount > 0 ? `${savingsCount} de ${benchmarkedCount}` : "—";
  $("kpi-savings-count-sub").textContent =
    benchmarkedCount > 0
      ? `productos comparados (${totalItems} en total)`
      : "esperando las rondas del grupo";

  $("kpi-participants").textContent = String(participants);
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

function renderExtraction(state) {
  const note = $("extract-note");
  const ex = state.extraction;

  if (!ex || ex.status === "DISABLED") {
    note.textContent =
      "La IA local detecta sola las facturas que guardes en tu carpeta — nada se sube a la nube";
    return;
  }
  if (ex.status === "LOADING_AI") {
    note.textContent = "Cargando la IA local (QVAC)… los modelos corren en este dispositivo";
    return;
  }
  if (ex.status === "PROCESSING") {
    const step = (ok, label) => `${ok ? "✓" : "…"} ${label}`;
    note.textContent =
      `Procesando ${ex.currentFile}:  ${step(ex.steps.cargada, "Factura cargada")}  ` +
      `${step(ex.steps.ia, "IA local")}  ${step(ex.steps.producto, "Producto")}  ${step(ex.steps.precio, "Precio")}`;
    return;
  }
  if (ex.status === "ERROR" || ex.error) {
    note.textContent = `⚠ Extracción con problema: ${ex.error ?? "error desconocido"}`;
    return;
  }
  // READY
  note.textContent =
    `✓ IA local lista — ${ex.processed} factura(s) procesadas en este dispositivo` +
    (ex.folder ? ` · vigilando ${ex.folder}` : "");
}

// --- panel "El recorrido de tu factura" -----------------------------------
//
// Cada paso se pinta con el estado REAL que publica el nodo local: nada
// aqui se adelanta ni se simula. "done" es un hecho ya ocurrido, "active"
// es lo que esta pasando ahora mismo y "" es lo que todavia no ha pasado.

function marcarPaso(nombre, estado, texto) {
  const li = document.querySelector(`.flow-step[data-step="${nombre}"]`);
  if (li) li.dataset.state = estado;
  const sub = $(`flow-${nombre === "agregacion" ? "agg" : nombre === "resultado" ? "res" : nombre}`);
  if (sub) sub.textContent = texto;
}

function renderFlow(state) {
  const ex = state.extraction ?? { status: "DISABLED" };
  const item = state.items[0] ?? null;
  const conectado = state.network.status === NETWORK_STATE.READY_FOR_AGGREGATION;

  // 1. Factura
  if (ex.status === "DISABLED") {
    marcarPaso("factura", "", "este nodo no procesa facturas");
  } else if (ex.processed > 0) {
    marcarPaso("factura", "done", `${ex.processed} procesada(s) en este dispositivo`);
  } else if (ex.status === "PROCESSING") {
    marcarPaso("factura", "done", `${ex.currentFile} cargada`);
  } else {
    marcarPaso("factura", "", `${ex.total ?? 0} en cola`);
  }

  // 2. IA local
  if (ex.status === "LOADING_AI") {
    marcarPaso("ia", "active", "cargando los modelos en este dispositivo…");
  } else if (ex.status === "PROCESSING") {
    marcarPaso("ia", "active", "extrayendo producto y precio…");
  } else if (ex.status === "ERROR") {
    marcarPaso("ia", "error", ex.error ?? "fallo del pipeline");
  } else if (ex.processed > 0) {
    marcarPaso("ia", "done", `procesamiento completado · ${state.localAi.model}`);
  } else if (ex.status === "DISABLED") {
    marcarPaso("ia", "", "sin facturas que procesar");
  } else {
    marcarPaso("ia", "", "en espera");
  }

  // 3. Precio protegido (el precio se conoce, pero no viaja)
  if (item) {
    marcarPaso("precio", "done", `${item.display ?? item.product} · solo tú lo ves`);
  } else {
    marcarPaso("precio", "", "aún sin dato local");
  }

  // 4. Red P2P
  const peers = state.network.identifiedPeers.length;
  marcarPaso(
    "p2p",
    conectado ? "done" : peers > 0 ? "active" : "",
    conectado ? `conexión directa con ${state.network.identifiedPeers.join(" y ")}` : `${peers}/${state.network.expectedPeerCount} participantes`
  );

  // 5. Agregacion privada
  const compartiendo = item?.status === "SHARING";
  const listo = item?.status === "DONE";
  marcarPaso(
    "agregacion",
    listo ? "done" : compartiendo ? "active" : "",
    listo
      ? `${state.privacy.sharesExchanged} fragmentos intercambiados, ningún precio`
      : compartiendo
        ? "intercambiando fragmentos…"
        : "esperando al grupo"
  );

  // 6. Resultado
  marcarPaso("resultado", listo ? "done" : "", listo ? "referencia calculada en este dispositivo" : "—");

  // Boton de disparo manual: solo cuando de verdad hay algo que disparar.
  const btn = $("procesar-btn");
  btn.hidden = !(ex.status === "IDLE");

  // Tarjeta de resultado
  const card = $("flow-result");
  if (listo) {
    card.hidden = false;
    $("flow-result-product").textContent = item.display ?? item.product;
    $("flow-result-mine").textContent = formatPrice(item.unitPrice);
    $("flow-result-group").textContent = formatPrice(item.groupAverage);
    const pct = item.positionPercent;
    $("flow-result-pos").textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
    $("flow-result-pos").dataset.tone = pct > 1 ? "over" : pct < -1 ? "good" : "";
    $("flow-result-note").textContent =
      pct > 1
        ? "Pagas por encima de la referencia del grupo."
        : pct < -1
          ? "Pagas por debajo de la referencia del grupo."
          : "Pagas prácticamente la referencia del grupo.";
  } else {
    card.hidden = true;
  }

  renderP2pFigure(state);
}

/**
 * Triangulo A-B-C. Solo se pintan como conocidas las dos aristas de ESTE
 * nodo: un participante no puede saber si los otros dos estan conectados
 * entre si, y dibujarlo como si lo supiera seria inventarlo.
 */
function renderP2pFigure(state) {
  const self = state.nodeName ?? "?";
  const otros = state.settings?.participants ?? ["A", "B", "C"];
  const peers = otros.filter((p) => p !== self);
  const identificados = new Set(state.network.identifiedPeers);

  $("label-self").textContent = self;
  $("label-1").textContent = peers[0] ?? "?";
  $("label-2").textContent = peers[1] ?? "?";

  const pintar = (edgeId, nodeId, peer) => {
    const on = identificados.has(peer);
    $(edgeId).classList.toggle("on", on);
    $(nodeId).classList.toggle("on", on);
  };
  pintar("edge-self-1", "node-1", peers[0]);
  pintar("edge-self-2", "node-2", peers[1]);

  $("p2p-caption").textContent =
    `${identificados.size + 1} de ${otros.length} participantes · ${identificados.size} conexión(es) directa(s) desde ${self}`;
}

function render(state) {
  $("mock-banner").hidden = !state.isMock;
  renderHeader(state);
  renderFlow(state);
  renderProducts(state);
  renderKpis(state);
  renderStatus(state);
  renderExtraction(state);
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

const dataSource = await pickDataSource();
dataSource.subscribe(render);
