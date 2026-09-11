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
 * Configuración del OCR, elegida con el barrido de tools/bench-ocr.mjs sobre
 * las tres facturas de demo (tabla completa en docs/pipeline-extraccion.md).
 *
 *   canvasSize 1280   recorta el canvas de detección. Es la variable que más
 *                     pesa en el tiempo. Combinada con imágenes a escala 1.4
 *                     está en una REGIÓN estable: canvas 1152, 1280 y 1400
 *                     leen bien las tres facturas. Se elige 1280 por tener
 *                     vecinos verificados a ambos lados, no por ser el más
 *                     rápido.
 *   recognizerBatchSize 32   es el DEFAULT de QVAC. Antes estaba en 1, copiado
 *                     del ejemplo del SDK, lo que obligaba al reconocedor a
 *                     procesar las ~31 cajas de una en una.
 *   defaultRotationAngles []   desactiva los reintentos rotados. El default de
 *                     QVAC es [90, 270]; nuestras facturas nunca están giradas.
 *   lowConfidenceThreshold 0.4   es el DEFAULT de QVAC. Antes estaba en 0.5,
 *                     un umbral MÁS alto, que marcaba más cajas como dudosas y
 *                     disparaba más reintentos.
 *   magRatio 1.2      se mantiene: 1.5 leía la cantidad "6" como "0" y 1.0
 *                     leía "20W50" como "20150".
 */
export const OCR_MODEL_CONFIG = {
  langList: ["es", "en"],
  magRatio: 1.2,
  canvasSize: 1280,
  defaultRotationAngles: [],
  contrastRetry: false,
  lowConfidenceThreshold: 0.4,
  recognizerBatchSize: 32,
};

/**
 * Backend de cómputo del OCR.
 *
 * Vulkan sobre la iGPU baja el OCR de ~14,4 s a ~2,8 s por factura. Pero el
 * detector CRAFT revienta con `ggml_gallocr_alloc_graph failed` si el canvas
 * es grande (falla a 1920 y 2560 en una iGPU de ~1 GB) y ese fallo NO cae
 * elegantemente a CPU por sí solo: mata la operación. Por eso el pipeline
 * reintenta en CPU (ver ocrInvoiceConRespaldo).
 *
 * Se puede forzar con PARIDAD_OCR_BACKEND=cpu, útil si la GPU está ocupada.
 */
export const OCR_BACKEND_PREFERIDO = process.env.PARIDAD_OCR_BACKEND ?? "vulkan";

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

/**
 * Schema para facturas con VARIAS líneas de producto. Es el mismo objeto de
 * línea que LLM_EXTRACTION_SCHEMA, envuelto en un array con `minItems: 1`.
 *
 * Medido sobre las facturas de demo: las de una línea siguen dando exactamente
 * un ítem con los mismos valores que la ruta de un producto (4700/3100/5200), y
 * la de cinco líneas da los cinco con cantidades y precios exactos. Por eso
 * esta ruta se puede usar como superconjunto de la otra.
 */
export const LLM_ITEMS_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      minItems: 1,
      items: LLM_EXTRACTION_SCHEMA,
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const SYSTEM_PROMPT_ITEMS = [
  "Eres un extractor de datos de facturas de compra.",
  "Recibes el texto OCR de UNA factura y devuelves TODAS las líneas de producto que se compraron, una por línea de la factura.",
  "product: solo la descripción del producto, SIN la cantidad y SIN la unidad (UND, PZA).",
  "quantity: la cantidad comprada de esa línea, como entero.",
  "unit_price: el precio unitario de esa línea (el número que sigue a P.UNIT o PRECIO UNITARIO), copiado literalmente con dos decimales.",
  "No uses el total a pagar como precio unitario.",
  "No inventes líneas que no estén en el texto.",
  "/no_think",
].join(" ");

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
function cargarModeloOcr(backendDevice, onProgress) {
  return loadModel({
    modelSrc: OCR_LATIN,
    modelConfig: { ...OCR_MODEL_CONFIG, backendDevice },
    onProgress,
  });
}

export async function loadPipeline({ onProgress, backendDevice = OCR_BACKEND_PREFERIDO } = {}) {
  const ocrModelId = await cargarModeloOcr(backendDevice, onProgress);

  const llmModelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    onProgress,
  });

  // El objeto devuelto es la SESIÓN del pipeline y es mutable: si la GPU falla
  // a mitad de una ronda, ocrInvoiceConRespaldo sustituye el modelo OCR por uno
  // en CPU y actualiza estos campos.
  return { ocrModelId, llmModelId, ocrBackend: backendDevice, onProgress };
}

/**
 * Libera los modelos. Es código de limpieza: si el worker de QVAC ya murió,
 * descargar es discutible y, sobre todo, NO debe lanzar. Antes lo hacía, y un
 * `Failed to unload model` en el bloque finally enmascaraba el error real que
 * había tumbado al worker.
 */
export async function unloadPipeline({ ocrModelId, llmModelId }) {
  for (const modelId of [ocrModelId, llmModelId]) {
    if (!modelId) continue;
    try {
      await unloadModel({ modelId, clearStorage: false });
    } catch (err) {
      console.warn(`⚠️  No se pudo descargar el modelo "${modelId}": ${err.message}`);
    }
  }

  try {
    await close();
  } catch (err) {
    console.warn(`⚠️  No se pudo cerrar el cliente QVAC: ${err.message}`);
  }
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
 * OCR con respaldo a CPU.
 *
 * Si el backend acelerado falla —lo típico en una iGPU con poca VRAM: el
 * detector CRAFT no consigue asignar su grafo— se recarga el modelo en CPU y
 * se reintenta UNA vez, mutando la sesión para que las siguientes facturas ya
 * usen CPU directamente.
 *
 * El respaldo es a CPU LOCAL. No existe ningún respaldo a servicios de
 * inferencia externos (CLAUDE.md §26).
 */
export async function ocrInvoiceConRespaldo(sesion, imagePath) {
  try {
    return await ocrInvoice({ ocrModelId: sesion.ocrModelId, imagePath });
  } catch (err) {
    if (sesion.ocrBackend === "cpu") throw err;

    console.warn(
      `⚠️  OCR en "${sesion.ocrBackend}" falló (${err.message}). Recargando en CPU y reintentando.`
    );

    // Se recargan LOS DOS modelos, no solo el OCR.
    //
    // Cuando la GPU se queda sin memoria, QVAC no falla solo la operación: en
    // las pruebas con tres procesos concurrentes sobre una iGPU de ~1 GB, el
    // worker de Bare muere entero (`code=3221226505`). Eso invalida también el
    // modelo de lenguaje, así que recargar únicamente el OCR dejaba la sesión
    // con un llmModelId muerto y el fallo reaparecía en el paso siguiente.
    for (const modelId of [sesion.ocrModelId, sesion.llmModelId]) {
      try {
        await unloadModel({ modelId, clearStorage: false });
      } catch {
        // Ya estaba muerto: no hay nada que liberar.
      }
    }

    sesion.ocrModelId = await cargarModeloOcr("cpu", sesion.onProgress);
    sesion.llmModelId = await loadModel({
      modelSrc: QWEN3_600M_INST_Q4,
      onProgress: sesion.onProgress,
    });
    sesion.ocrBackend = "cpu";

    return ocrInvoice({ ocrModelId: sesion.ocrModelId, imagePath });
  }
}

/**
 * Pipeline completo para una factura.
 *
 * Devuelve el objeto con el schema público de Paridad:
 *   { product, quantity, unit_price_cents }
 * más metadatos locales que NO deben cruzar la frontera P2P.
 *
 * `sesion` es lo que devuelve loadPipeline().
 */
export async function extractInvoice({ sesion, imagePath }) {
  const t0 = Date.now();
  const { texto, lineas } = await ocrInvoiceConRespaldo(sesion, imagePath);
  const msOcr = Date.now() - t0;

  const t1 = Date.now();
  const crudo = await extractStructured({ llmModelId: sesion.llmModelId, texto });
  const msLlm = Date.now() - t1;

  return {
    // --- schema público ---
    product: crudo.product,
    quantity: crudo.quantity,
    unit_price_cents: priceStringToCents(crudo.unit_price),
    // --- derivado local ---
    product_canonical: normalizeProduct(repairOcrText(crudo.product)),
    // --- solo local: nunca se envía por la red ---
    _local: { texto, lineas, msOcr, msLlm, ocrBackend: sesion.ocrBackend },
  };
}

/** Paso 2 (variante multi-línea): texto → { items: [...] }, garantizado por gramática. */
export async function extractStructuredItems({ llmModelId, texto }) {
  const run = completion({
    modelId: llmModelId,
    history: [
      { role: "system", content: SYSTEM_PROMPT_ITEMS },
      { role: "user", content: `Texto OCR de la factura:\n\n${texto}` },
    ],
    stream: false,
    generationParams: GENERATION_PARAMS,
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "invoice_items", schema: LLM_ITEMS_SCHEMA },
    },
  });

  const final = await run.final;
  const bruto = final.contentText.trim();

  try {
    return JSON.parse(bruto);
  } catch (err) {
    throw new Error(`QVAC devolvió un JSON no parseable: ${err.message}\nSalida: ${bruto}`);
  }
}

/**
 * Pipeline completo para una factura con UNA O VARIAS líneas de producto.
 *
 * Devuelve `items`: un registro por línea, cada uno con el schema público
 * { product, quantity, unit_price_cents, product_canonical }. Es la ruta que
 * usa el nodo; extractInvoice() (un producto) se conserva tal cual.
 */
export async function extractInvoiceItems({ sesion, imagePath }) {
  const t0 = Date.now();
  const { texto, lineas } = await ocrInvoiceConRespaldo(sesion, imagePath);
  const msOcr = Date.now() - t0;

  const t1 = Date.now();
  const crudo = await extractStructuredItems({ llmModelId: sesion.llmModelId, texto });
  const msLlm = Date.now() - t1;

  const items = crudo.items.map((linea) => ({
    product: linea.product,
    quantity: linea.quantity,
    unit_price_cents: priceStringToCents(linea.unit_price),
    product_canonical: normalizeProduct(repairOcrText(linea.product)),
  }));

  return {
    items,
    // --- solo local: nunca se envía por la red ---
    _local: { texto, lineas, msOcr, msLlm, ocrBackend: sesion.ocrBackend },
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
