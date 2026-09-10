/**
 * Pipeline de extracción local de facturas de Paridad.
 *
 *   imagen de factura → QVAC OCR → texto → QVAC completion → JSON estructurado
 *
 * Todo ocurre en el dispositivo con QVAC. Este módulo no hace ninguna llamada
 * de red hacia servicios de inferencia: no hay fallback a la nube. Si QVAC
 * falla, el pipeline falla de forma visible (ver CLAUDE.md §26).
 *
 * La única salida de este módulo es el objeto estructurado. La imagen, el
 * texto OCR y el nombre del proveedor NO se exportan hacia la capa P2P: son
 * el lado privado de la frontera (CLAUDE.md §4). La integración con P2P se
 * hace en otro spike; aquí no se toca red.
 */

import {
  loadModel,
  unloadModel,
  ocr,
  completion,
  close,
  OCR_LATIN,
  QWEN3_600M_INST_Q4,
} from "@qvac/sdk";

/**
 * Configuración del OCR, medida empíricamente contra las facturas de demo
 * (ver tools/generar-facturas-demo.ps1 y docs/pipeline-extraccion.md).
 *
 * magRatio 1.2 es un punto medio deliberado sobre estas imágenes:
 *   - 1.5 leía la cantidad "6" como "0" en factura-demo-b;
 *   - 1.0 es ~30% más rápido pero se saltaba algunos importes de total;
 *   - 1.2 lee bien cantidad y precio unitario en las tres facturas.
 */
export const OCR_MODEL_CONFIG = {
  langList: ["es", "en"],
  magRatio: 1.2,
  contrastRetry: false,
  lowConfidenceThreshold: 0.5,
  recognizerBatchSize: 1,
};

/**
 * Schema que se le impone al modelo por gramática (GBNF) vía responseFormat.
 *
 * Nota deliberada sobre `unit_price`: se le pide al modelo el precio como
 * TEXTO tal como aparece impreso ("47.00"), no como número de centavos.
 * Un modelo de 600M multiplicando 47.00 × 100 es una fuente de error
 * innecesaria; la conversión a centavos la hace JavaScript de forma
 * determinista más abajo. El schema público del pipeline sí expone
 * `unit_price_cents`.
 *
 * `additionalProperties: false` y `required` van explícitos porque la doc del
 * SDK 0.19.0 advierte que `json_schema.strict` NO aplica el auto-tightening
 * de OpenAI: el schema se reenvía al addon tal cual.
 */
export const LLM_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    product: { type: "string" },
    quantity: { type: "integer" },
    unit_price: { type: "string", pattern: "^[0-9]+\\.[0-9]{2}$" },
  },
  required: ["product", "quantity", "unit_price"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = [
  "Eres un extractor de datos de facturas de compra.",
  "Recibes el texto OCR de UNA factura y devuelves la línea de producto que se compró.",
  "product: solo la descripción del producto, SIN la cantidad y SIN la unidad (UND, PZA).",
  "quantity: la cantidad comprada, como entero.",
  "unit_price: el PRECIO UNITARIO, copiado literalmente del texto, con dos decimales.",
  "No uses el total a pagar como precio unitario.",
  "No inventes datos que no estén en el texto.",
  "/no_think",
].join(" ");

/**
 * Decodificación greedy y semilla fija.
 *
 * Sin esto el pipeline no es reproducible: en pruebas repetidas sobre la MISMA
 * factura el modelo devolvió unas veces "ACEITE MOTOR 20W50" y otras
 * "ACEITE MOTOR 20W50 UND", lo que cambiaba el producto canónico y habría roto
 * el agrupamiento del benchmark. Para extracción estructurada no queremos
 * diversidad de muestreo, queremos la misma respuesta siempre.
 */
export const GENERATION_PARAMS = {
  temp: 0,
  top_k: 1,
  seed: 42,
};

/**
 * Unidades de medida que el OCR arrastra pegadas a la descripción.
 * Se eliminan al canonizar para que "ACEITE MOTOR 20W50" y
 * "ACEITE MOTOR 20W50 UND" caigan en el mismo producto.
 */
const UNIDADES_ALT = "und|unid|unidad|unidades|un|pza|pzas|pieza|piezas|c/u";
const UNIDADES = new RegExp(`\\b(?:${UNIDADES_ALT})\\b`, "g");

/**
 * El OCR devuelve bloques sueltos a nivel de palabra con su bbox. Para que el
 * modelo vea algo parecido a la factura original, se reagrupan en líneas por
 * coordenada vertical y se ordenan por coordenada horizontal.
 *
 * bbox llega como [x0, y0, x1, y1].
 */
export function reconstructLines(blocks, toleranciaY = 20) {
  const ordenados = [...blocks].filter((b) => b.text && b.text.trim());

  const lineas = [];
  for (const bloque of ordenados) {
    const [x0, y0, , y1] = bloque.bbox;
    const centroY = (y0 + y1) / 2;

    const linea = lineas.find((l) => Math.abs(l.centroY - centroY) <= toleranciaY);
    if (linea) {
      linea.bloques.push({ x0, text: bloque.text });
      // Media móvil: evita que una línea se "arrastre" con bloques altos.
      linea.centroY = (linea.centroY * (linea.bloques.length - 1) + centroY) / linea.bloques.length;
    } else {
      lineas.push({ centroY, bloques: [{ x0, text: bloque.text }] });
    }
  }

  return lineas
    .sort((a, b) => a.centroY - b.centroY)
    .map((l) =>
      l.bloques
        .sort((a, b) => a.x0 - b.x0)
        .map((b) => b.text)
        .join(" ")
    );
}

/**
 * Reparaciones deterministas de confusiones del OCR observadas de forma
 * reproducible sobre las facturas de demo. Es una lista corta y explícita,
 * NO un corrector general: cada regla corresponde a un fallo medido.
 *
 *   - "20h50" / "20w50" → "20W50": el recognizer confunde la W de los códigos
 *     de viscosidad SAE con h, y a veces la devuelve en minúscula.
 *   - "47 . 00" / "47 .00" → "47.00": a veces el punto decimal se detecta como
 *     bloque separado y al reconstruir la línea queda con espacios.
 */
export function repairOcrText(texto) {
  return texto
    .replace(/\b(\d{1,2})\s*[hHwW]\s*(\d{2})\b/g, "$1W$2")
    .replace(/(\d)\s+\.\s*(\d{2})\b/g, "$1.$2")
    .replace(/(\d)\s*\.\s+(\d{2})\b/g, "$1.$2");
}

/**
 * Normalización canónica mínima del nombre de producto, para que variantes
 * textuales del mismo insumo se agrupen en el mismo benchmark.
 * Determinista a propósito: no gasta inferencia en esto.
 */
export function normalizeProduct(producto) {
  const base = producto
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // quita acentos combinantes (tras NFD)
    .replace(/[^a-z0-9/]+/g, " ")
    .trim();

  return (
    base
      // "4 und aceite..." → "aceite...". Solo se quita el número inicial
      // cuando va seguido de una unidad, para no borrar productos cuyo
      // nombre empieza legítimamente por un número.
      .replace(new RegExp(`^\\d+\\s*(?:${UNIDADES_ALT})\\b`), " ")
      .replace(UNIDADES, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ")
  );
}

/** Convierte "47.00" a 4700 centavos sin pasar por coma flotante. */
export function priceStringToCents(precio) {
  const match = /^(\d+)\.(\d{2})$/.exec(precio.trim());
  if (!match) {
    throw new Error(`Precio con formato inesperado: "${precio}"`);
  }
  return Number(match[1]) * 100 + Number(match[2]);
}

/**
 * Carga los dos modelos locales del pipeline.
 * Devuelve los ids para poder reutilizarlos entre facturas (cargar el modelo
 * es lo caro; procesar una factura más no lo es).
 */
export async function loadPipeline({ onProgress } = {}) {
  const ocrModelId = await loadModel({
    modelSrc: OCR_LATIN,
    modelConfig: OCR_MODEL_CONFIG,
    onProgress,
  });

  const llmModelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    onProgress,
  });

  return { ocrModelId, llmModelId };
}

export async function unloadPipeline({ ocrModelId, llmModelId }) {
  if (ocrModelId) await unloadModel({ modelId: ocrModelId, clearStorage: false });
  if (llmModelId) await unloadModel({ modelId: llmModelId, clearStorage: false });
  await close();
}

/** Paso 1: imagen → texto. */
export async function ocrInvoice({ ocrModelId, imagePath }) {
  const { blocks } = ocr({
    modelId: ocrModelId,
    image: imagePath,
    options: { paragraph: false },
  });

  const resultado = await blocks;
  const lineas = reconstructLines(resultado);
  const texto = repairOcrText(lineas.join("\n"));

  return { texto, lineas, blocks: resultado };
}

/** Paso 2: texto → JSON estructurado, con la forma garantizada por gramática. */
export async function extractStructured({ llmModelId, texto }) {
  const run = completion({
    modelId: llmModelId,
    history: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Texto OCR de la factura:\n\n${texto}` },
    ],
    stream: false,
    generationParams: GENERATION_PARAMS,
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "invoice_line_item", schema: LLM_EXTRACTION_SCHEMA },
    },
  });

  const final = await run.final;
  const bruto = final.contentText.trim();

  let parseado;
  try {
    parseado = JSON.parse(bruto);
  } catch (err) {
    // La gramática debería impedirlo, pero si el modelo se corta por límite
    // de tokens el JSON puede quedar truncado. Falla claro, sin fallback.
    throw new Error(`QVAC devolvió un JSON no parseable: ${err.message}\nSalida: ${bruto}`);
  }

  return parseado;
}

/**
 * Pipeline completo para una factura.
 *
 * Devuelve el objeto con el schema público de Paridad:
 *   { product, quantity, unit_price_cents }
 * más metadatos locales que NO deben cruzar la frontera P2P.
 */
export async function extractInvoice({ ocrModelId, llmModelId, imagePath }) {
  const t0 = Date.now();
  const { texto, lineas } = await ocrInvoice({ ocrModelId, imagePath });
  const msOcr = Date.now() - t0;

  const t1 = Date.now();
  const crudo = await extractStructured({ llmModelId, texto });
  const msLlm = Date.now() - t1;

  return {
    // --- schema público ---
    product: crudo.product,
    quantity: crudo.quantity,
    unit_price_cents: priceStringToCents(crudo.unit_price),
    // --- derivado local ---
    product_canonical: normalizeProduct(repairOcrText(crudo.product)),
    // --- solo local: nunca se envía por la red ---
    _local: { texto, lineas, msOcr, msLlm },
  };
}

/**
 * Validación del resultado contra el schema público de Paridad.
 * Devuelve un array de errores (vacío = válido).
 */
export function validateExtraction(resultado) {
  const errores = [];

  if (typeof resultado?.product !== "string" || !resultado.product.trim()) {
    errores.push("product debe ser un string no vacío");
  }
  if (!Number.isInteger(resultado?.quantity) || resultado.quantity <= 0) {
    errores.push("quantity debe ser un entero positivo");
  }
  if (!Number.isInteger(resultado?.unit_price_cents) || resultado.unit_price_cents <= 0) {
    errores.push("unit_price_cents debe ser un entero positivo de centavos");
  }

  return errores;
}
