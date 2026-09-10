// Renderizador de la UI de Paridad. No sabe de Hyperswarm ni de QVAC:
// solo recibe un estado (via una fuente con subscribe(callback)) y lo
// pinta. Si la pagina la sirve nodo-paridad.mjs usa la fuente real
// (SSE); si se sirve como estaticos (`npm run ui`), cae al mock.
//
// El diseno replica los mockups del equipo (paridad-dashboard.html),
// con una diferencia deliberada: los mockups comparaban contra precios
// de proveedores con nombre, pero el modelo de privacidad de Paridad
// solo conoce agregados. Aqui el veredicto compara SIEMPRE contra el
// promedio anonimo del grupo.
import { mockDataSource } from "./mock-data.js";
import { realDataSource, isServedByParidadNode } from "./real-data-source.js";
import { NETWORK_STATE } from "../network/network-state.mjs";

const $ = (id) => document.getElementById(id);

function setStatus(id, text, tone) {
  const el = $(id);
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function formatPrice(value) {
  if (value === "hidden") return "🔒 oculto";
  if (typeof value === "number") return `$${value.toFixed(2)}`;
  return "—";
}

function verdictFor(positionPercent) {
  if (typeof positionPercent !== "number") {
    return { className: "", label: "Esperando ronda", detail: "faltan participantes" };
  }
  if (positionPercent > 1) {
    return { className: "over", label: "Pagas de más", detail: `${positionPercent.toFixed(0)}% más caro` };
  }
  if (positionPercent < -1) {
    return { className: "good", label: "Buen precio", detail: `${Math.abs(positionPercent).toFixed(0)}% menos` };
  }
  return { className: "good", label: "En el promedio", detail: "±1%" };
}

function renderHeader(state) {
  const name = state.nodeName ?? "?";
  $("node-label").textContent = `Tu nodo local — ${name}`;
  $("avatar").textContent = name.slice(0, 2).toUpperCase();

  const { status } = state.network;
  if (status === NETWORK_STATE.READY_FOR_AGGREGATION) {
    $("sync-text").textContent = "Conectado al grupo";
  } else if (status === NETWORK_STATE.PEER_DISCONNECTED) {
    $("sync-text").textContent = "Un peer se desconectó";
  } else {
    $("sync-text").textContent = "Buscando peers…";
  }
}

function renderProducts(state) {
  const rows = $("product-rows");
  rows.replaceChildren();

  const items = state.invoice.items;
  if (!items.length) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span class="row-rank">01</span><span class="row-name"><span class="prod-name">Sin datos</span></span>`;
    rows.append(row);
    return;
  }

  items.forEach((item, index) => {
    const verdict = verdictFor(state.benchmark.yourPositionPercent);

    const row = document.createElement("div");
    row.className = `row${verdict.className ? ` row-${verdict.className}` : ""}`;

    const rank = document.createElement("span");
    rank.className = "row-rank";
    rank.textContent = String(index + 1).padStart(2, "0");

    const nameWrap = document.createElement("span");
    nameWrap.className = "row-name";
    const chip = document.createElement("span");
    chip.className = "cat-chip";
    chip.textContent = item.product.slice(0, 3);
    const prodName = document.createElement("span");
    prodName.className = "prod-name";
    prodName.textContent = `${item.product} ×${item.quantity}`;
    nameWrap.append(chip, prodName);

    const yourPrice = document.createElement("span");
    yourPrice.className = "price";
    yourPrice.innerHTML = `<span class="lbl">Tú pagas</span>`;
    yourPrice.append(formatPrice(item.unitPrice));

    const groupPrice = document.createElement("span");
    groupPrice.className = "price";
    groupPrice.innerHTML = `<span class="lbl">Promedio del grupo</span>`;
    groupPrice.append(formatPrice(state.benchmark.groupAverage));

    const verdictEl = document.createElement("span");
    verdictEl.className = `verdict${verdict.className ? ` ${verdict.className}` : ""}`;
    verdictEl.innerHTML = `<span class="verdict-label"></span><span class="verdict-pct"></span>`;
    verdictEl.querySelector(".verdict-label").textContent = verdict.label;
    verdictEl.querySelector(".verdict-pct").textContent = verdict.detail;

    row.append(rank, nameWrap, yourPrice, groupPrice, verdictEl);
    rows.append(row);
  });

  $("invoice-filename").textContent = state.invoice.fileName ?? "Ninguna factura cargada";
}

function renderKpis(state) {
  const { groupAverage, yourPositionPercent, participants } = state.benchmark;

  $("kpi-average").textContent = formatPrice(groupAverage);
  $("kpi-position").textContent =
    typeof yourPositionPercent === "number"
      ? `${yourPositionPercent > 0 ? "+" : ""}${yourPositionPercent.toFixed(1)}%`
      : "—";
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

const dataSource = (await isServedByParidadNode()) ? realDataSource : mockDataSource;
dataSource.subscribe(render);
