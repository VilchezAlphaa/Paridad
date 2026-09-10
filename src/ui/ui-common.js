// Utilidades compartidas por todas las paginas de la UI (dashboard,
// productos, proveedores, ajustes, calculadora).
import { mockDataSource } from "./mock-data.js";
import { realDataSource, isServedByParidadNode } from "./real-data-source.js";

/** Fuente real si la pagina la sirve un nodo Paridad; mock si es estatica. */
export async function pickDataSource() {
  return (await isServedByParidadNode()) ? realDataSource : mockDataSource;
}

export function formatPrice(value) {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "—";
}

/**
 * Veredicto visual de un item segun su estado de ronda y posicion.
 * @returns {{className: ""|"over"|"good", label: string, detail: string}}
 */
export function verdictForItem(item) {
  if (item.status === "DONE" && typeof item.positionPercent === "number") {
    if (item.positionPercent > 1) {
      return { className: "over", label: "Pagas de más", detail: `${item.positionPercent.toFixed(0)}% más caro` };
    }
    if (item.positionPercent < -1) {
      return { className: "good", label: "Buen precio", detail: `${Math.abs(item.positionPercent).toFixed(0)}% menos` };
    }
    return { className: "good", label: "En el promedio", detail: "±1%" };
  }
  if (item.status === "NOT_COMMON") {
    return { className: "", label: "Solo tú lo tienes", detail: "sin grupo que comparar" };
  }
  if (item.status === "SHARING") {
    return { className: "", label: "Calculando", detail: "ronda en curso" };
  }
  return { className: "", label: "En espera", detail: "esperando al grupo" };
}

/** Rellena la fila de producto (dashboard y pagina de productos). */
export function buildItemRow(item, index, { showProveedor = false } = {}) {
  const verdict = verdictForItem(item);

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
  prodName.textContent = item.display ?? item.product;
  nameWrap.append(chip, prodName);
  if (showProveedor && item.proveedor) {
    const prov = document.createElement("span");
    prov.className = "row-proveedor";
    prov.textContent = item.proveedor;
    nameWrap.append(prov);
  }

  const yourPrice = document.createElement("span");
  yourPrice.className = "price";
  yourPrice.innerHTML = `<span class="lbl">Tú pagas</span>`;
  yourPrice.append(formatPrice(item.unitPrice));

  const groupPrice = document.createElement("span");
  groupPrice.className = "price";
  groupPrice.innerHTML = `<span class="lbl">Promedio del grupo</span>`;
  groupPrice.append(formatPrice(item.groupAverage));

  const verdictEl = document.createElement("span");
  verdictEl.className = `verdict${verdict.className ? ` ${verdict.className}` : ""}`;
  verdictEl.innerHTML = `<span class="verdict-label"></span><span class="verdict-pct"></span>`;
  verdictEl.querySelector(".verdict-label").textContent = verdict.label;
  verdictEl.querySelector(".verdict-pct").textContent = verdict.detail;

  row.append(rank, nameWrap, yourPrice, groupPrice, verdictEl);
  return row;
}
