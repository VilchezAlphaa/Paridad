/**
 * Test end-to-end de Paridad.
 *
 * Lanza TRES PROCESOS separados que se descubren por Hyperswarm real y
 * comprueba el flujo completo:
 *
 *   factura → QVAC OCR → extracción → cents → shares → P2P → benchmark
 *
 * Escenarios:
 *   1. Flujo completo con QVAC sobre las tres facturas de demo.
 *   2a. Participante ausente: la ronda se cierra como incompleta, sin colgarse.
 *   2b. Participante que se cae en caliente: los demás lo detectan sin morir.
 *
 * Uso:
 *   node src/e2e/test-end-to-end.mjs              (todo)
 *   node src/e2e/test-end-to-end.mjs --solo-p2p   (omite QVAC, solo escenarios 2)
 */

import { spawn } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..", "..");
const NODO = path.join(REPO, "paridad-node.mjs");
const FACTURAS = path.join(REPO, "demo-data", "facturas");

// Verdad de referencia: los datos con los que se generaron las facturas.
const CASOS = [
  { nodo: "A", archivo: "factura-demo-a.png", cents: 4700 },
  { nodo: "B", archivo: "factura-demo-b.png", cents: 3100 },
  { nodo: "C", archivo: "factura-demo-c.png", cents: 5200 },
];

const TOTAL_ESPERADO = 13000;
const PROMEDIO_ESPERADO = 4333;

let fallos = 0;

function comprobar(condicion, mensaje) {
  if (condicion) {
    console.log(`  ✅ ${mensaje}`);
  } else {
    console.error(`  ❌ ${mensaje}`);
    fallos++;
  }
}

/** Topic único por corrida: aísla el test de peers viejos o de otra ejecución. */
function topicUnico(etiqueta) {
  return `paridad-e2e-${etiqueta}-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Lanza un nodo y recoge su salida. Devuelve un manejador con el proceso vivo
 * y una promesa que resuelve al terminar.
 */
function lanzarNodo(args, { etiqueta }) {
  const hijo = spawn(process.execPath, [NODO, ...args], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let salida = "";
  hijo.stdout.on("data", (d) => (salida += d.toString()));
  hijo.stderr.on("data", (d) => (salida += d.toString()));

  const terminado = new Promise((resolve) => {
    hijo.on("close", (code) => resolve({ code, salida, etiqueta }));
  });

  return { hijo, terminado, leer: () => salida, etiqueta };
}

/** Extrae el JSON de una línea con prefijo (PARIDAD_RESULTADO, etc.). */
function leerLinea(salida, prefijo) {
  const linea = salida.split(/\r?\n/).find((l) => l.startsWith(prefijo));
  if (!linea) return null;
  try {
    return JSON.parse(linea.slice(prefijo.length).trim());
  } catch {
    return null;
  }
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Mata un proceso y espera a que muera de verdad. */
async function matar(manejador) {
  if (manejador.hijo.exitCode === null) {
    manejador.hijo.kill("SIGKILL");
  }
  await manejador.terminado;
}

async function conLimite(promesa, ms, etiqueta) {
  let temporizador;
  const limite = new Promise((_, reject) => {
    temporizador = setTimeout(() => reject(new Error(`${etiqueta}: excedió ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promesa, limite]);
  } finally {
    clearTimeout(temporizador);
  }
}

// ==========================================================================
// Escenario 1 — flujo completo con QVAC
// ==========================================================================
async function escenarioFlujoCompleto() {
  console.log("\n═══ Escenario 1: FACTURA → QVAC → shares → P2P → benchmark ═══\n");

  const topic = topicUnico("completo");

  // Los nodos se arrancan ESCALONADOS a propósito.
  //
  // Cada nodo carga su propio contexto OCR en Vulkan, y tres a la vez sobre la
  // iGPU de desarrollo (~1 GB) tumban el worker de QVAC entero. Como cada nodo
  // libera sus modelos en cuanto termina de extraer, basta con separar los
  // arranques para que las fases de OCR no se solapen; la fase P2P sí queda
  // concurrente, que es lo que este test debe ejercitar.
  //
  // En el despliegue real cada participante es una máquina distinta y este
  // escalonado no aplica. Ver docs/pipeline-extraccion.md.
  const RETRASO_ENTRE_NODOS = 15000;
  const nodos = [];
  for (const c of CASOS) {
    if (nodos.length) await esperar(RETRASO_ENTRE_NODOS);
    console.log(`  ▸ arrancando nodo ${c.nodo} (${c.archivo})`);
    nodos.push(
      lanzarNodo(
        [c.nodo, path.join(FACTURAS, c.archivo), "--esperado", String(c.cents), "--timeout", "300000", "--topic", topic],
        { etiqueta: c.nodo }
      )
    );
  }

  const resultados = await conLimite(
    Promise.all(nodos.map((n) => n.terminado)),
    420000,
    "escenario 1"
  );

  const auditorias = [];

  for (const c of CASOS) {
    const r = resultados.find((x) => x.etiqueta === c.nodo);
    console.log(`\n▸ Nodo ${c.nodo} (salida con código ${r.code}):`);

    const extraccion = leerLinea(r.salida, "PARIDAD_EXTRACCION");
    const resultado = leerLinea(r.salida, "PARIDAD_RESULTADO");
    const auditoria = leerLinea(r.salida, "PARIDAD_AUDITORIA");

    if (r.code !== 0 || extraccion === null) {
      // Sin esto un fallo aquí es indepurable: se ve "undefined" y nada más.
      console.error(`  --- salida completa del nodo ${c.nodo} ---`);
      console.error(r.salida.trim() || "(sin salida)");
      console.error(`  --- fin salida del nodo ${c.nodo} ---`);
    }

    comprobar(r.code === 0, `terminó limpio`);
    comprobar(
      extraccion !== null && extraccion.unit_price_cents === c.cents,
      `QVAC extrajo ${c.cents} centavos de ${c.archivo} (obtuvo ${extraccion?.unit_price_cents})`
    );
    comprobar(
      extraccion?.product_canonical === "aceite motor 20w50",
      `producto canónico correcto (obtuvo "${extraccion?.product_canonical}")`
    );
    comprobar(resultado?.completo === true, `completó la ronda de agregación`);
    comprobar(
      resultado?.total === TOTAL_ESPERADO,
      `total del grupo = ${TOTAL_ESPERADO} (obtuvo ${resultado?.total})`
    );
    comprobar(
      resultado !== null && Math.round(resultado.average) === PROMEDIO_ESPERADO,
      `promedio ≈ ${PROMEDIO_ESPERADO} centavos = $43.33 (obtuvo ${resultado?.average?.toFixed(2)})`
    );
    comprobar(
      auditoria?.valorPrivadoTransmitido === false,
      `no transmitió su propio precio por la red`
    );

    if (auditoria) auditorias.push({ nodo: c.nodo, payloads: auditoria.payloads });
  }

  // --- Comprobación cruzada de privacidad ---------------------------------
  // Ningún nodo debe haber puesto en la red NINGÚN precio individual, ni el
  // suyo ni el de otro. Se compara por valor, no por subcadena: los shares son
  // enteros de ~39 dígitos y "4700" puede aparecer dentro por casualidad.
  console.log("\n▸ Auditoría cruzada de todo el tráfico de red:");

  const preciosIndividuales = CASOS.map((c) => String(c.cents));
  const valoresEnLaRed = new Set();
  let totalMensajes = 0;

  for (const { payloads } of auditorias) {
    for (const json of payloads) {
      totalMensajes++;
      const visitar = (v) => {
        if (v === null || v === undefined) return;
        if (typeof v === "object") return Object.values(v).forEach(visitar);
        valoresEnLaRed.add(String(v));
      };
      visitar(JSON.parse(json));
    }
  }

  const filtrados = preciosIndividuales.filter((p) => valoresEnLaRed.has(p));
  console.log(`  Mensajes inspeccionados: ${totalMensajes}`);
  console.log(`  Valores distintos vistos en la red: ${valoresEnLaRed.size}`);
  comprobar(
    filtrados.length === 0,
    `ningún precio individual (${preciosIndividuales.join(", ")}) viajó como valor` +
      (filtrados.length ? ` — FILTRADOS: ${filtrados.join(", ")}` : "")
  );

  // El total sí es público (es el resultado del benchmark), pero tampoco
  // debería viajar: cada nodo lo calcula por su cuenta a partir de las sumas.
  comprobar(
    !valoresEnLaRed.has(String(TOTAL_ESPERADO)),
    `el total ${TOTAL_ESPERADO} tampoco viajó: cada nodo lo calcula localmente`
  );
}

// ==========================================================================
// Escenario 2a — participante ausente
// ==========================================================================
async function escenarioParticipanteAusente() {
  console.log("\n═══ Escenario 2a: falta un participante (C nunca se une) ═══\n");

  const topic = topicUnico("ausente");
  const nodos = ["A", "B"].map((n, i) =>
    lanzarNodo(
      [n, "--precio-cents", String(CASOS[i].cents), "--timeout", "60000", "--topic", topic],
      { etiqueta: n }
    )
  );

  const resultados = await conLimite(Promise.all(nodos.map((n) => n.terminado)), 120000, "escenario 2a");

  for (const r of resultados) {
    console.log(`\n▸ Nodo ${r.etiqueta} (código ${r.code}):`);
    const resultado = leerLinea(r.salida, "PARIDAD_RESULTADO");

    comprobar(r.code === 0, `terminó limpio en vez de colgarse o reventar`);
    comprobar(resultado?.completo === false, `reportó la ronda como INCOMPLETA`);
    comprobar(
      r.salida.includes("RONDA INCOMPLETA"),
      `explicó al usuario que la ronda no se pudo completar`
    );
    comprobar(
      !r.salida.includes("Resultado del benchmark"),
      `NO publicó ningún benchmark con datos incompletos`
    );
    comprobar(!/at .*\n.*at /.test(r.salida), `no volcó ninguna traza de excepción`);
  }
}

// ==========================================================================
// Escenario 2b — participante que se cae en caliente
// ==========================================================================
async function escenarioDesconexionEnCaliente() {
  console.log("\n═══ Escenario 2b: C se cae después de conectarse ═══\n");

  const topic = topicUnico("caida");
  const nodos = CASOS.map((c) =>
    lanzarNodo([c.nodo, "--precio-cents", String(c.cents), "--timeout", "90000", "--topic", topic], {
      etiqueta: c.nodo,
    })
  );

  const [a, b, c] = nodos;

  // Esperar a que A vea a C, y matar C en ese momento.
  const limite = Date.now() + 120000;
  while (Date.now() < limite && !a.leer().includes("conexión P2P confirmada con C")) {
    await esperar(250);
  }

  const vioAC = a.leer().includes("conexión P2P confirmada con C");

  if (vioAC) {
    console.log("  A confirmó conexión con C → se ejercita la caída EN CALIENTE");
  } else {
    // Sin esta advertencia el escenario pasa igual pero probando otra cosa:
    // si C nunca llegó a conectarse, matarlo equivale al escenario 2a y la
    // ruta de desconexión en caliente NO queda cubierta en esta corrida.
    console.warn(
      "  ⚠️  A no llegó a ver a C dentro de la ventana de espera: esta corrida NO ejercita\n" +
        "      la desconexión en caliente, solo repite el caso del participante ausente."
    );
  }

  await matar(c);
  console.log("  C eliminado con SIGKILL");

  const resultados = await conLimite(Promise.all([a.terminado, b.terminado]), 150000, "escenario 2b");

  for (const r of resultados) {
    console.log(`\n▸ Nodo ${r.etiqueta} (código ${r.code}):`);
    const resultado = leerLinea(r.salida, "PARIDAD_RESULTADO");

    comprobar(r.code === 0, `sobrevivió a la caída de C y terminó limpio`);
    comprobar(resultado !== null, `emitió un resultado en vez de quedarse colgado`);
    comprobar(!/at .*\n.*at /.test(r.salida), `no volcó ninguna traza de excepción`);

    // El resultado depende de si los shares de C llegaron antes del SIGKILL.
    // Cualquiera de los dos desenlaces es correcto; lo que NO puede pasar es
    // publicar un benchmark con datos de menos de 3 participantes.
    if (resultado?.completo) {
      console.log(`  (los shares de C llegaron antes del corte: ronda completada)`);
      comprobar(resultado.total === TOTAL_ESPERADO, `el total sigue siendo ${TOTAL_ESPERADO}`);
    } else {
      console.log(`  (C cayó antes de completar: ronda incompleta, como debe ser)`);
      comprobar(
        !r.salida.includes("Resultado del benchmark"),
        `NO publicó benchmark con un participante caído`
      );
    }
  }
}

// ==========================================================================

const soloP2p = process.argv.includes("--solo-p2p");

try {
  if (!soloP2p) {
    await escenarioFlujoCompleto();
  } else {
    console.log("(--solo-p2p: se omite el escenario con QVAC)");
  }
  await escenarioParticipanteAusente();
  await escenarioDesconexionEnCaliente();
} catch (err) {
  console.error(`\n💥 El test end-to-end falló: ${err.message}`);
  fallos++;
}

console.log("\n" + "═".repeat(70));
if (fallos === 0) {
  console.log("✅ Test end-to-end: todas las comprobaciones pasaron.");
  process.exit(0);
} else {
  console.error(`❌ Test end-to-end: ${fallos} comprobación(es) fallaron.`);
  process.exit(1);
}
