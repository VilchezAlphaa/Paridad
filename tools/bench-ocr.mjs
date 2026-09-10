/**
 * Banco de pruebas de configuraciones de OCR de QVAC.
 *
 * Sirve para justificar con medidas —y poder rehacer— la configuración que usa
 * src/extraction/invoice-pipeline.mjs, en vez de dejarla como números mágicos.
 *
 *   node tools/bench-ocr.mjs fase1              poda: 1 factura, N configuraciones
 *   node tools/bench-ocr.mjs fase2 C3,C4        finalistas: 3 facturas
 *   node tools/bench-ocr.mjs fase3 C3           ganadora: 2 corridas consecutivas
 *
 * Las imágenes a escalas distintas de la del repo se generan antes con:
 *   powershell -File tools/generar-facturas-demo.ps1 -Escala 1.6 -OutDir <dir>
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModel, unloadModel, ocr, close, OCR_LATIN } from "@qvac/sdk";
import {
  reconstructLines,
  repairOcrText,
  normalizeProduct,
} from "../src/extraction/invoice-pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const DIR_ESCALAS = process.env.PARIDAD_BENCH_DIR ?? path.join(REPO, "..", "paridad-bench-tmp");

// Verdad de referencia: los datos con los que se generaron las facturas.
const ESPERADO = {
  a: { quantity: 4, unit_price: "47.00", producto: "aceite motor 20w50" },
  b: { quantity: 6, unit_price: "31.00", producto: "aceite motor 20w50" },
  c: { quantity: 3, unit_price: "52.00", producto: "aceite motor 20w50" },
};

/** Configuración que tenía el proyecto antes de este barrido. */
const BASE = {
  langList: ["es", "en"],
  magRatio: 1.2,
  contrastRetry: false,
  lowConfidenceThreshold: 0.5,
  recognizerBatchSize: 1,
};

/**
 * Corrección evaluada sobre el TEXTO del OCR, sin gastar inferencia del LLM:
 * comprueba que los tres datos que el pipeline necesita estén legibles.
 */
function evaluarTexto(texto, esperado) {
  const errores = [];
  const t = texto.toUpperCase();

  if (!new RegExp(`PRECIO\\s+UNITARIO:?\\s*${esperado.unit_price.replace(".", "\\.")}`).test(t)) {
    errores.push(`precio ${esperado.unit_price} ilegible`);
  }
  if (!new RegExp(`\\b${esperado.quantity}\\s*UND\\b`).test(t)) {
    errores.push(`cantidad ${esperado.quantity} ilegible`);
  }
  if (!normalizeProduct(repairOcrText(t)).includes(esperado.producto)) {
    errores.push("producto no resuelve al canónico");
  }
  return errores;
}

async function correrOCR({ config, imagen }) {
  const modelId = await loadModel({ modelSrc: OCR_LATIN, modelConfig: config });
  const t0 = Date.now();
  const { blocks, stats } = ocr({ modelId, image: imagen, options: { paragraph: false } });
  const bloques = await blocks;
  const ms = Date.now() - t0;

  let info = null;
  try {
    info = await stats;
  } catch {
    info = null;
  }
  await unloadModel({ modelId, clearStorage: false });

  return {
    ms,
    bloques,
    stats: info,
    texto: repairOcrText(reconstructLines(bloques).join("\n")),
  };
}

// Cada configuración parte de BASE y cambia una variable más que la anterior,
// para poder atribuir la mejora a una causa concreta.
const CONMUTADORES = {
  recognizerBatchSize: 32,
  defaultRotationAngles: [],
  lowConfidenceThreshold: 0.4,
};

const CONFIGS = [
  { id: "C0", desc: "actual del proyecto", escala: 2.1, cfg: { ...BASE } },
  { id: "C1", desc: "+ batch 32 (default)", escala: 2.1, cfg: { ...BASE, recognizerBatchSize: 32 } },
  { id: "C2", desc: "+ sin rotaciones", escala: 2.1, cfg: { ...BASE, recognizerBatchSize: 32, defaultRotationAngles: [] } },
  { id: "C3", desc: "+ umbral 0.4 (default)", escala: 2.1, cfg: { ...BASE, ...CONMUTADORES } },
  { id: "C4", desc: "C3 + vulkan", escala: 2.1, cfg: { ...BASE, ...CONMUTADORES, backendDevice: "vulkan" } },
  { id: "C5", desc: "C3 + canvasSize 1280", escala: 2.1, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 1280 } },
  { id: "C6", desc: "C3 + escala 1.4", escala: 1.4, cfg: { ...BASE, ...CONMUTADORES } },
  { id: "C7", desc: "C3 + escala 1.6", escala: 1.6, cfg: { ...BASE, ...CONMUTADORES } },
  { id: "C8", desc: "C3 + magRatio 1.0", escala: 2.1, cfg: { ...BASE, ...CONMUTADORES, magRatio: 1.0 } },
  { id: "C9", desc: "C3 + magRatio 1.5", escala: 2.1, cfg: { ...BASE, ...CONMUTADORES, magRatio: 1.5 } },
  { id: "C10", desc: "C3 + esc 1.6 + canvas 1280", escala: 1.6, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 1280 } },
  { id: "C11", desc: "C3 + esc 1.6 + canvas 1600", escala: 1.6, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 1600 } },
  { id: "C12", desc: "C3 + esc 2.1 + canvas 1600", escala: 2.1, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 1600 } },
  { id: "C13", desc: "C3 + esc 1.4 + canvas 1280", escala: 1.4, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 1280 } },
  { id: "C14", desc: "C10 + nThreads 12", escala: 1.6, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 1280, nThreads: 12 } },
  // Vulkan falló en C4 por asignación de memoria (iGPU ~1 GB). Se reintenta
  // con el canvas reducido, que baja mucho el pico de memoria del detector.
  { id: "C15", desc: "C10 + vulkan", escala: 1.6, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 1280, backendDevice: "vulkan" } },
  { id: "C16", desc: "C3 + esc 2.1 + canvas 1920", escala: 2.1, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 1920 } },
  // C17 conserva las imágenes que ya están versionadas (escala 2.1) y usa GPU.
  { id: "C17", desc: "C16 + vulkan (conserva imágenes del repo)", escala: 2.1, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 1920, backendDevice: "vulkan" } },
  { id: "C18", desc: "C17 con canvas 2560 (sin recorte)", escala: 2.1, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 2560, backendDevice: "vulkan" } },
  // C19/C20 sondean el vecindario de C13: si toda la zona alrededor lee bien,
  // C13 está en una región estable; si solo acierta el punto exacto, es azar
  // de remuestreo y no se debe adoptar.
  { id: "C19", desc: "esc 1.4 + canvas 1400", escala: 1.4, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 1400 } },
  { id: "C20", desc: "esc 1.4 + canvas 1152", escala: 1.4, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 1152 } },
  { id: "C21", desc: "esc 2.1 + canvas 2100", escala: 2.1, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 2100 } },
  // Vulkan arranca con canvas 1280; C15 falló por la escala 1.6, no por la GPU.
  // C22 combina la GPU con la escala 1.4, que sí está en región estable.
  { id: "C22", desc: "C13 + vulkan", escala: 1.4, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 1280, backendDevice: "vulkan" } },
  { id: "C23", desc: "esc 1.4 + canvas 1152 + vulkan", escala: 1.4, cfg: { ...BASE, ...CONMUTADORES, canvasSize: 1152, backendDevice: "vulkan" } },
];

function rutaImagen(escala, letra) {
  const dir =
    escala === 2.1
      ? path.join(REPO, "demo-data", "facturas")
      : path.join(DIR_ESCALAS, `esc-${escala}`);
  return path.join(dir, `factura-demo-${letra}.png`);
}

function backendDe(stats) {
  return (
    stats?.backend?.device ??
    stats?.backendDevice ??
    stats?.backend ??
    "n/d"
  );
}

async function fase1(filtro) {
  console.log("### FASE 1 — poda sobre la factura B (la que más falló históricamente)\n");
  console.log("id    escala  tiempo    bloques  backend   resultado");
  const seleccion = filtro ? CONFIGS.filter((c) => filtro.includes(c.id)) : CONFIGS;
  for (const { id, desc, escala, cfg } of seleccion) {
    try {
      const { ms, texto, bloques, stats } = await correrOCR({ config: cfg, imagen: rutaImagen(escala, "b") });
      const errores = evaluarTexto(texto, ESPERADO.b);
      console.log(
        `${id.padEnd(5)} ${String(escala).padEnd(6)} ${String(ms).padStart(6)}ms ${String(bloques.length).padStart(7)}  ${String(backendDe(stats)).padEnd(8)} ${
          errores.length ? "❌ " + errores.join("; ") : "✅"
        }   (${desc})`
      );
      if (errores.length) console.log(`      texto: ${texto.replace(/\n/g, " | ")}`);
    } catch (err) {
      console.log(`${id.padEnd(5)} ${String(escala).padEnd(6)}  💥 ${err.message}   (${desc})`);
    }
  }
}

async function sobreLasTres({ id, escala, cfg }) {
  let total = 0;
  let fallos = 0;
  for (const letra of ["a", "b", "c"]) {
    const { ms, texto } = await correrOCR({ config: cfg, imagen: rutaImagen(escala, letra) });
    const errores = evaluarTexto(texto, ESPERADO[letra]);
    total += ms;
    if (errores.length) fallos++;
    console.log(`  ${id} factura ${letra}: ${String(ms).padStart(6)}ms  ${errores.length ? "❌ " + errores.join("; ") : "✅"}`);
    if (errores.length) console.log(`      texto: ${texto.replace(/\n/g, " | ")}`);
  }
  console.log(`  ${id} TOTAL ${total}ms — ${(total / 3 / 1000).toFixed(1)}s por factura — fallos: ${fallos}\n`);
  return { total, fallos };
}

const modo = process.argv[2] ?? "fase1";
const ids = (process.argv[3] ?? "C3").split(",");

try {
  if (modo === "fase1") {
    await fase1(process.argv[3] ? ids : null);
  } else {
    const repeticiones = modo === "fase3" ? 2 : 1;
    for (let i = 1; i <= repeticiones; i++) {
      for (const id of ids) {
        const c = CONFIGS.find((x) => x.id === id);
        if (!c) throw new Error(`configuración desconocida: ${id}`);
        console.log(`### ${modo} · corrida ${i} · ${c.id} (${c.desc}, escala ${c.escala})`);
        await sobreLasTres(c);
      }
    }
  }
} finally {
  await close();
}

process.exit(0);
