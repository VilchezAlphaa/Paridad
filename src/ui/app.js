// Paridad — pantalla principal.
//
// Una pequeña máquina de estados de PRESENTACIÓN sobre el estado real que
// publica nodo-paridad.mjs por SSE:
//
//   idle        no hay facturas: logo, mensaje, stepper y un único CTA
//   processing  la IA local está leyendo una factura
//   results     productos de la última factura, con su comparación
//   history     todas las facturas agregadas
//
// Aquí no se extrae, no se comparte ni se agrega nada: solo se pinta lo que
// el nodo local ya calculó. Fuente real por SSE si la sirve nodo-paridad.mjs;
// mock si la página es estática.
import { NETWORK_STATE } from "../network/network-state.mjs";
import { pickDataSource, formatPrice } from "./ui-common.js";

const $ = (id) => document.getElementById(id);

// --- estado de presentación -------------------------------------------------

let vistaElegida = null; // null = automática; "history" = el usuario la pidió
let ultimoEstado = null;
let facturaMostrandoFin = null; // factura cuyo "N productos encontrados" está en pantalla
let facturaYaCerrada = null; // última factura para la que ya se mostró ese cierre
let temporizadorFin = null;
let vistaAnterior = null;
const movimientoReducido = matchMedia("(prefers-reduced-motion: reduce)");

// Reutilizar filas evita repetir entradas, perder foco o cerrar facturas por SSE.
function actualizarFilas(tbody, registros) {
  const existentes = new Map([...tbody.children].map((el) => [el.dataset.id, el]));
  registros.forEach((r, i) => {
    let fila = existentes.get(r.id);
    const firma = JSON.stringify([r.product, r.quantity, r.unitPrice]);
    const comparacion = JSON.stringify(r.comparacion);
    if (!fila || fila.dataset.firma !== firma) {
      const nueva = filaProducto(r);
      nueva.dataset.id = r.id;
      nueva.dataset.firma = firma;
      nueva.style.setProperty("--entry-delay", `${registros.length > 8 ? 0 : i * 60}ms`);
      if (fila) fila.replaceWith(nueva);
      fila = nueva;
    } else if (fila.dataset.comparacion !== comparacion) {
      fila.lastElementChild.replaceChildren(celdaComparacion(r.comparacion));
    }
    fila.dataset.comparacion = comparacion;
    if (tbody.children[i] !== fila) tbody.insertBefore(fila, tbody.children[i] ?? null);
    existentes.delete(r.id);
  });
  existentes.forEach((el) => el.remove());
}

function vistaDesde(state) {
  const ex = state.extraction ?? { status: "IDLE" };
  // Procesar una factura siempre se ve, aunque el usuario estuviera en el
  // historial: es el momento que la demo tiene que enseñar.
  if (ex.status === "LOADING_AI" || ex.status === "PROCESSING") return "processing";
  if (facturaMostrandoFin) return "processing"; // pausa breve "N productos encontrados"
  if (vistaElegida === "history") return "history";
  if ((state.historial?.facturas ?? []).length) return "results";
  return "idle";
}

function ultimaFactura(state) {
  // historial.facturas viene de más reciente a más antigua y sobrevive al
  // reinicio, a diferencia de extraction.ultimaFactura.
  return state.historial?.facturas?.[0] ?? null;
}

function registrosDe(state, facturaId) {
  return (state.historial?.registros ?? []).filter((r) => r.facturaId === facturaId);
}

function pluralProductos(n) {
  return n === 1 ? "1 producto" : `${n} productos`;
}

/** "1 producto encontrado" / "5 productos encontrados": concuerda el participio. */
function fraseProductos(n, participio) {
  return `${pluralProductos(n)} ${participio}${n === 1 ? "" : "s"}`;
}

// --- piezas ---------------------------------------------------------------

function celdaComparacion(c) {
  const wrap = document.createElement("span");
  wrap.className = "cmp";
  wrap.dataset.estado = c?.estado ?? "PENDIENTE";

  if (c?.estado === "DISPONIBLE") {
    const pct = c.posicionPct;
    const ref = document.createElement("span");
    ref.className = "cmp-ref";
    ref.textContent = formatPrice(c.referencia);
    const p = document.createElement("span");
    p.className = "cmp-pct";
    p.dataset.tone = pct > 1 ? "over" : pct < -1 ? "good" : "";
    p.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
    const note = document.createElement("span");
    note.className = "cmp-note";
    note.textContent =
      pct > 1
        ? "Pagas por encima de la referencia del grupo"
        : pct < -1
          ? "Pagas por debajo de la referencia del grupo"
          : "En la referencia del grupo";
    wrap.append(ref, p, note);
    return wrap;
  }

  const main = document.createElement("span");
  main.className = "cmp-none";
  const note = document.createElement("span");
  note.className = "cmp-note";
  if (c?.estado === "NO_DISPONIBLE") {
    main.textContent = "Sin comparación disponible";
    note.textContent = "Aún no hay suficientes negocios con este producto.";
  } else {
    main.textContent = "Comparación pendiente";
    note.textContent = "Esperando al grupo.";
  }
  wrap.append(main, note);
  return wrap;
}

function filaProducto(r) {
  const tr = document.createElement("tr");

  const tdName = document.createElement("td");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = r.product;
  const qty = document.createElement("span");
  qty.className = "qty";
  qty.textContent = `${r.quantity} und`;
  tdName.append(name, qty);

  const tdPrice = document.createElement("td");
  tdPrice.className = "num";
  tdPrice.textContent = formatPrice(r.unitPrice);

  const tdCmp = document.createElement("td");
  tdCmp.append(celdaComparacion(r.comparacion));

  tr.append(tdName, tdPrice, tdCmp);
  return tr;
}

function tablaProductos(registros) {
  const table = document.createElement("table");
  table.className = "products";
  table.innerHTML = `<thead><tr><th>Producto</th><th class="num">Tu precio</th><th>Comparación</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  actualizarFilas(tbody, registros);
  table.append(tbody);
  return table;
}

// --- vistas ---------------------------------------------------------------

function renderGrupo(state) {
  const { status, identifiedPeers, expectedPeerCount } = state.network;
  const total = expectedPeerCount + 1;
  const conectados = identifiedPeers.length + 1;
  const el = $("group-status");
  const listo = status === NETWORK_STATE.READY_FOR_AGGREGATION;
  if (el.dataset.ready !== String(listo)) {
    el.classList.toggle("group-arrived", listo && el.dataset.ready === "false");
  }
  el.dataset.ready = String(listo);
  if (status === NETWORK_STATE.READY_FOR_AGGREGATION) {
    el.dataset.tone = "ok";
    $("group-text").textContent = `Grupo conectado · ${total} participantes`;
  } else {
    delete el.dataset.tone;
    $("group-text").textContent = `Grupo · ${conectados} de ${total} participantes`;
  }
}

function renderCta(state) {
  const ex = state.extraction ?? { status: "IDLE", pendientes: 0 };
  const pendientes = ex.status === "IDLE" && (ex.pendientes ?? 0) > 0;
  const ocupado = ex.status === "LOADING_AI" || ex.status === "PROCESSING";

  // Un único CTA. Si el nodo arrancó con facturas pendientes (demo manual),
  // el mismo botón las procesa; si no, abre el selector de archivo.
  for (const [id, cargar, procesar] of [
    ["cta-main", "Cargar factura", "Procesar factura"],
    ["nav-add", "+ Agregar factura", "▶ Procesar factura"],
  ]) {
    const b = $(id);
    b.textContent = pendientes ? procesar : cargar;
    b.dataset.accion = pendientes ? "procesar" : "cargar";
    b.disabled = ocupado;
  }
}

function renderProcessing(state) {
  const ex = state.extraction ?? {};
  const terminado = Boolean(facturaMostrandoFin);
  const encontrados = terminado ? registrosDe(state, facturaMostrandoFin).length : 0;
  $("view-processing").dataset.complete = String(terminado);

  $("chk-ia").dataset.state = terminado ? "done" : "active";
  $("chk-ia").textContent = terminado ? "IA local completada" : ex.status === "LOADING_AI" ? "IA local cargando modelos" : "IA local procesando";
  $("chk-productos").dataset.state = terminado ? "done" : "";
  $("chk-productos").textContent = terminado ? fraseProductos(encontrados, "identificado") : "Productos identificados";
  $("chk-datos").dataset.state = terminado ? "done" : "";

  document.querySelector("#view-processing .view-title").textContent = terminado
    ? fraseProductos(encontrados, "encontrado")
    : "Analizando tu factura";
}

function renderResults(state) {
  const factura = ultimaFactura(state);
  const registros = factura ? registrosDe(state, factura.id) : [];
  $("results-sub").textContent = fraseProductos(registros.length, "registrado");

  const tbody = $("results-rows");
  actualizarFilas(tbody, registros);

  const total = state.historial?.resumen ?? { facturas: 0, productos: 0 };
  $("results-foot").textContent =
    `${factura?.archivo ?? ""} · procesada localmente` +
    (total.facturas > 1 ? ` · ${total.productos} productos en ${total.facturas} facturas` : "");
}

function renderHistory(state) {
  const facturas = state.historial?.facturas ?? [];
  const list = $("invoice-list");
  const existentes = new Map([...list.querySelectorAll(".invoice")].map((el) => [el.dataset.id, el]));

  $("history-sub").textContent = facturas.length
    ? `${facturas.length === 1 ? "1 factura" : `${facturas.length} facturas`} · datos guardados en este dispositivo.`
    : "Datos guardados en este dispositivo.";

  if (!facturas.length) {
    if (list.querySelector(".empty")) return;
    list.replaceChildren();
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Todavía no has agregado ninguna factura.";
    list.append(p);
    return;
  }
  list.querySelector(".empty")?.remove();

  facturas.forEach((f, i) => {
    const existente = existentes.get(f.id);
    if (existente) {
      existente.querySelector(".inv-name").textContent = f.archivo;
      existente.querySelector(".inv-meta").textContent = `${pluralProductos(f.lineas)} · Procesada localmente`;
      actualizarFilas(existente.querySelector("tbody"), registrosDe(state, f.id));
      if (list.children[i] !== existente) list.insertBefore(existente, list.children[i] ?? null);
      existentes.delete(f.id);
      return;
    }
    const det = document.createElement("details");
    det.className = "invoice";
    det.dataset.id = f.id;
    det.style.setProperty("--entry-delay", `${facturas.length > 8 ? 0 : i * 60}ms`);
    if (i === 0) det.open = true;

    const sum = document.createElement("summary");
    const name = document.createElement("span");
    name.className = "inv-name";
    name.textContent = f.archivo;
    const meta = document.createElement("span");
    meta.className = "inv-meta";
    meta.textContent = `${pluralProductos(f.lineas)} · Procesada localmente`;
    sum.append(name, meta);

    det.append(sum, tablaProductos(registrosDe(state, f.id)));
    list.insertBefore(det, list.children[i] ?? null);
  });
  existentes.forEach((el) => el.remove());
}

function render(state) {
  ultimoEstado = state;
  $("mock-banner").hidden = !state.isMock;

  // Cierre honesto "N productos encontrados": cuando termina una factura
  // que estábamos viendo procesar, se enseña el final un momento antes de
  // pasar a resultados. Solo se activa si de verdad estábamos en processing.
  const ex = state.extraction ?? {};
  const ultima = ultimaFactura(state);
  const yaNoProcesa = ex.status !== "PROCESSING" && ex.status !== "LOADING_AI";
  if (
    ultima &&
    ex.status !== "ERROR" &&
    ex.ultimaFactura?.id === ultima.id &&
    yaNoProcesa &&
    vistaAnterior === "processing" &&
    !facturaMostrandoFin &&
    facturaYaCerrada !== ultima.id // sin esto el cierre se reactivaba en bucle
  ) {
    facturaYaCerrada = ultima.id;
    facturaMostrandoFin = ultima.id;
    clearTimeout(temporizadorFin);
    temporizadorFin = setTimeout(() => {
      facturaMostrandoFin = null;
      if (ultimoEstado) render(ultimoEstado);
    }, movimientoReducido.matches ? 0 : 400);
  }

  const vista = vistaDesde(state);
  vistaAnterior = vista;

  for (const v of ["idle", "processing", "results", "history"]) {
    $(`view-${v}`).hidden = v !== vista;
  }
  $("nav-history").setAttribute("aria-current", vista === "history" ? "page" : "false");

  renderGrupo(state);
  renderCta(state);
  if (vista === "processing") renderProcessing(state);
  if (vista === "results") renderResults(state);
  if (vista === "history") renderHistory(state);

  const err = $("error-line");
  err.hidden = ex.status !== "ERROR";
  if (ex.status === "ERROR") err.textContent = `No se pudo procesar la factura: ${ex.error ?? "error desconocido"}`;
}

// --- acciones -------------------------------------------------------------

async function accionPrincipal(boton) {
  if (boton.dataset.accion === "procesar") {
    vistaElegida = null;
    try {
      await fetch("/api/procesar", { method: "POST" });
    } catch {
      // El siguiente estado por SSE repinta el botón.
    }
    return;
  }
  $("factura-input").click();
}

$("cta-main").addEventListener("click", (e) => void accionPrincipal(e.currentTarget));
$("nav-add").addEventListener("click", (e) => void accionPrincipal(e.currentTarget));

$("nav-history").addEventListener("click", () => {
  vistaElegida = vistaElegida === "history" ? null : "history";
  if (ultimoEstado) render(ultimoEstado);
});
$("results-history").addEventListener("click", () => {
  vistaElegida = "history";
  if (ultimoEstado) render(ultimoEstado);
});

$("factura-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  vistaElegida = null;
  try {
    // La imagen va al proceso LOCAL (localhost). No sale del dispositivo.
    const res = await fetch("/api/factura", {
      method: "POST",
      headers: { "x-nombre": encodeURIComponent(file.name), "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const line = $("error-line");
      line.hidden = false;
      line.textContent = err.error ?? `No se pudo enviar la factura (error ${res.status})`;
    }
  } catch (err) {
    const line = $("error-line");
    line.hidden = false;
    line.textContent = err.message;
  }
});

const dataSource = await pickDataSource();
dataSource.subscribe(render);
