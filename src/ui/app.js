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
  if (benchmarkedCount > 0) {
    count.innerHTML = "";
    count.append(String(savingsCount));
    const dim = document.createElement("span");
    dim.className = "kpi-dim";
    dim.textContent = ` de ${benchmarkedCount}`;
    count.append(dim);
  } else {
    count.textContent = "—";
  }
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

  if (state.localAi.status === "ACTIVE") {
    setStatus("st-ai", state.localAi.model, "ok");
  } else if (state.localAi.status === "LOADING") {
    setStatus("st-ai", "CARGANDO…", "warn");
  } else {
    setStatus("st-ai", "OFFLINE", "bad");
  }

  // Internet OFFLINE es un estado deseable de demo (funciona sin nube),
  // por eso no se pinta como error.
  if (state.internet.status === "OFFLINE") {
    setStatus("st-internet", "OFFLINE ✓", "ok");
  } else {
    setStatus("st-internet", "ONLINE", undefined);
  }

  setStatus("st-shares", String(state.privacy.sharesExchanged), state.privacy.sharesExchanged > 0 ? "ok" : undefined);
  $("privacy-note").textContent = state.privacy.note;
}

function render(state) {
  $("mock-banner").hidden = !state.isMock;
  renderHeader(state);
  renderProducts(state);
  renderKpis(state);
  renderStatus(state);
}

const dataSource = await pickDataSource();
dataSource.subscribe(render);
