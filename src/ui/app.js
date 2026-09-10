// Renderizador de la UI de Paridad. No sabe de Hyperswarm ni de QVAC:
// solo recibe un estado (via una fuente con subscribe(callback)) y lo
// pinta. Hoy la fuente es mockDataSource; cuando exista la fuente real
// respaldada por ParidadNetwork, se cambia solo este import.
import { mockDataSource } from "./mock-data.js";
import { NETWORK_STATE } from "../network/network-state.mjs";

const $ = (id) => document.getElementById(id);

function setStat(id, text, tone) {
  const el = $(id);
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function formatPrice(value) {
  if (value === "hidden") return "🔒 oculto";
  if (typeof value === "number") return `S/ ${value.toFixed(2)}`;
  return "—";
}

function renderNetwork(network) {
  const { status, identifiedPeers, expectedPeerCount } = network;

  setStat(
    "val-peers",
    `${identifiedPeers.length} / ${expectedPeerCount}`,
    identifiedPeers.length >= expectedPeerCount ? "ok" : "warn"
  );

  if (status === NETWORK_STATE.READY_FOR_AGGREGATION) {
    setStat("val-p2p", "CONECTADO", "ok");
  } else if (status === NETWORK_STATE.PEER_DISCONNECTED) {
    setStat("val-p2p", "PEER CAIDO", "bad");
  } else {
    setStat("val-p2p", "BUSCANDO...", "warn");
  }
}

function renderLocalAi(localAi) {
  if (localAi.status === "ACTIVE") {
    setStat("val-local-ai", localAi.model, "ok");
  } else if (localAi.status === "LOADING") {
    setStat("val-local-ai", "CARGANDO...", "warn");
  } else {
    setStat("val-local-ai", "OFFLINE", "bad");
  }
}

function renderInternet(internet) {
  // Internet OFFLINE es un estado deseable de demo (funciona sin nube),
  // por eso no se pinta como error.
  if (internet.status === "OFFLINE") {
    setStat("val-internet", "OFFLINE ✓", "ok");
  } else {
    setStat("val-internet", "ONLINE", undefined);
  }
}

function renderPrivacy(privacy) {
  setStat("val-shared", String(privacy.sharesExchanged), privacy.sharesExchanged > 0 ? "ok" : undefined);
  $("privacy-note").textContent = privacy.note;
}

function renderInvoice(invoice) {
  $("invoice-filename").textContent = invoice.fileName ?? "Ningun archivo cargado";

  const body = $("invoice-items-body");
  body.replaceChildren();

  if (!invoice.items.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.textContent = "Sin datos";
    row.append(cell);
    body.append(row);
    return;
  }

  for (const item of invoice.items) {
    const row = document.createElement("tr");
    for (const value of [item.product, String(item.quantity), formatPrice(item.unitPrice)]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
}

function renderBenchmark(benchmark) {
  $("bm-your-price").textContent = formatPrice(benchmark.yourPrice);
  $("bm-group-average").textContent = formatPrice(benchmark.groupAverage);
  $("bm-position").textContent =
    typeof benchmark.yourPositionPercent === "number"
      ? `${benchmark.yourPositionPercent > 0 ? "+" : ""}${benchmark.yourPositionPercent.toFixed(1)}% vs promedio`
      : "—";
  $("bm-participants").textContent = String(benchmark.participants);
}

function render(state) {
  $("mock-banner").hidden = !state.isMock;
  renderNetwork(state.network);
  renderLocalAi(state.localAi);
  renderInternet(state.internet);
  renderPrivacy(state.privacy);
  renderInvoice(state.invoice);
  renderBenchmark(state.benchmark);
}

mockDataSource.subscribe(render);
