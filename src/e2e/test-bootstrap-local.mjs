/**
 * Pruebas del bootstrap local de Paridad.
 *
 * Demuestran que los nodos pueden encontrarse sin consultar el DHT público,
 * usando un nodo bootstrap propio, y que ese bootstrap no ve datos privados.
 *
 * Escenarios:
 *   1. Descubrimiento por bootstrap local → ronda completa y correcta.
 *   2. El bootstrap desaparece tras el descubrimiento → las conexiones siguen.
 *   3. Aislamiento: con un bootstrap inalcanzable NO se cae al DHT público.
 *   4. Flujo end-to-end real (facturas + QVAC) sobre bootstrap local.
 *
 * Uso:
 *   node src/e2e/test-bootstrap-local.mjs
 *   node src/e2e/test-bootstrap-local.mjs --sin-qvac   (omite el escenario 4)
 */

import { spawn } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..", "..");
const NODO = path.join(REPO, "paridad-node.mjs");
const BOOTSTRAP = path.join(REPO, "paridad-bootstrap.mjs");
const FACTURAS = path.join(REPO, "demo-data", "facturas");

const CASOS = [
  { nodo: "A", archivo: "factura-demo-a.png", cents: 4700 },
  { nodo: "B", archivo: "factura-demo-b.png", cents: 3100 },
  { nodo: "C", archivo: "factura-demo-c.png", cents: 5200 },
];

const TOTAL_ESPERADO = 13000;
const PROMEDIO_ESPERADO = 4333.33;

let fallos = 0;

function comprobar(condicion, mensaje) {
  if (condicion) {
    console.log(`  ✅ ${mensaje}`);
  } else {
    console.error(`  ❌ ${mensaje}`);
    fallos++;
  }
}

/** Vuelca la salida de un nodo cuando algo va mal: sin esto es indepurable. */
function volcar(r) {
  console.error(`  --- salida del nodo ${r.etiqueta} (codigo ${r.code}) ---`);
  console.error(r.salida.trim() || "(sin salida)");
  console.error(`  --- fin ---`);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const topicUnico = (e) => `paridad-bs-${e}-${crypto.randomBytes(5).toString("hex")}`;
// Puerto alto y aleatorio: evita chocar con el 49737 de los peers y con otras corridas.
const puertoLibre = () => 49800 + Math.floor(Math.random() * 90);

function lanzar(script, args, etiqueta) {
  const hijo = spawn(process.execPath, [script, ...args], {
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

function leerLinea(salida, prefijo) {
  const linea = salida.split(/\r?\n/).find((l) => l.startsWith(prefijo));
  if (!linea) return null;
  try {
    return JSON.parse(linea.slice(prefijo.length).trim());
  } catch {
    return null;
  }
}

async function matar(m) {
  if (m.hijo.exitCode === null) m.hijo.kill("SIGKILL");
  await m.terminado;
}

async function esperarHasta(condicion, limiteMs, intervalo = 250) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) {
    if (condicion()) return true;
    await esperar(intervalo);
  }
  return false;
}

async function conLimite(promesa, ms, etiqueta) {
  let t;
  const limite = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${etiqueta}: excedió ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promesa, limite]);
  } finally {
    clearTimeout(t);
  }
}

/** Arranca el bootstrap y espera a que anuncie que está listo. */
async function arrancarBootstrap(puerto) {
  const bs = lanzar(BOOTSTRAP, ["--host", "127.0.0.1", "--port", String(puerto)], "bootstrap");
  const listo = await esperarHasta(() => bs.leer().includes("PARIDAD_BOOTSTRAP_LISTO"), 20000);
  if (!listo) {
    await matar(bs);
    throw new Error(`el bootstrap no arrancó en el puerto ${puerto}`);
  }
  return bs;
}

/**
 * Auditoría: recorre todos los payloads emitidos por los nodos y comprueba que
 * ningún precio individual, ni el total, viajaron COMO VALOR.
 * La comparación es por valor y no por subcadena: los shares son enteros de
 * ~39 dígitos y "4700" puede aparecer dentro por azar sin que sea una fuga.
 */
function auditarTrafico(auditorias) {
  const valores = new Set();
  let mensajes = 0;

  for (const a of auditorias) {
    for (const json of a.payloads) {
      mensajes++;
      const visitar = (v) => {
        if (v === null || v === undefined) return;
        if (typeof v === "object") return Object.values(v).forEach(visitar);
        valores.add(String(v));
      };
      visitar(JSON.parse(json));
    }
  }

  return { valores, mensajes };
}

// ==========================================================================
// Escenario 1 — descubrimiento por bootstrap local
// ==========================================================================
async function escenarioDescubrimiento() {
  console.log("\n═══ Escenario 1: descubrimiento por bootstrap local (sin DHT público) ═══\n");

  const puerto = puertoLibre();
  const topic = topicUnico("descubrir");
  const bs = await arrancarBootstrap(puerto);
  console.log(`  Bootstrap activo en 127.0.0.1:${puerto}`);

  const nodos = CASOS.map((c) =>
    lanzar(
      NODO,
      [
        c.nodo,
        "--precio-cents", String(c.cents),
        "--bootstrap", `127.0.0.1:${puerto}`,
        "--timeout", "90000",
        "--topic", topic,
      ],
      c.nodo
    )
  );

  const resultados = await conLimite(Promise.all(nodos.map((n) => n.terminado)), 150000, "escenario 1");
  const auditorias = [];

  for (const c of CASOS) {
    const r = resultados.find((x) => x.etiqueta === c.nodo);
    const resultado = leerLinea(r.salida, "PARIDAD_RESULTADO");
    const auditoria = leerLinea(r.salida, "PARIDAD_AUDITORIA");
    const conexiones = leerLinea(r.salida, "PARIDAD_CONEXIONES");

    console.log(`\n▸ Nodo ${c.nodo} (código ${r.code}):`);

    if (r.code !== 0 || !resultado) {
      console.error(`  --- salida del nodo ${c.nodo} ---`);
      console.error(r.salida.trim() || "(sin salida)");
      console.error(`  --- fin ---`);
    }

    comprobar(r.code === 0, "terminó limpio");
    comprobar(
      conexiones?.modoDescubrimiento === "bootstrap-local",
      `usó descubrimiento bootstrap-local (fue "${conexiones?.modoDescubrimiento}")`
    );
    comprobar(resultado?.completo === true, "completó la ronda sin DHT público");
    comprobar(resultado?.total === TOTAL_ESPERADO, `total = ${TOTAL_ESPERADO} (obtuvo ${resultado?.total})`);
    comprobar(
      resultado !== null && Math.abs(resultado.average - PROMEDIO_ESPERADO) < 0.01,
      `promedio = ${PROMEDIO_ESPERADO} = $43.33 (obtuvo ${resultado?.average?.toFixed(2)})`
    );
    comprobar(auditoria?.valorPrivadoTransmitido === false, "no transmitió su propio precio");

    if (auditoria) auditorias.push(auditoria);
  }

  // --- Auditoría del tráfico entre nodos ----------------------------------
  console.log("\n▸ Auditoría del tráfico P2P:");
  const { valores, mensajes } = auditarTrafico(auditorias);
  const precios = CASOS.map((c) => String(c.cents));
  const filtrados = precios.filter((p) => valores.has(p));

  console.log(`  Mensajes inspeccionados: ${mensajes}`);
  comprobar(
    filtrados.length === 0,
    `ningún precio individual (${precios.join(", ")}) viajó como valor` +
      (filtrados.length ? ` — FILTRADOS: ${filtrados.join(", ")}` : "")
  );
  comprobar(!valores.has(String(TOTAL_ESPERADO)), `el total ${TOTAL_ESPERADO} tampoco viajó`);

  // --- Auditoría del propio bootstrap -------------------------------------
  console.log("\n▸ Auditoría del proceso bootstrap:");
  const salidaBs = bs.leer();
  await matar(bs);

  // Se audita SOLO lo que el bootstrap emite después de anunciarse listo.
  // Lo anterior es su propio banner de ayuda —texto estático que incluye una
  // línea de ejemplo con un nombre de factura—, y confundirlo con datos
  // recibidos daría un falso positivo.
  //
  // El corte va tras el FIN DE LÍNEA del marcador, no tras el marcador: esa
  // misma línea lleva el JSON con host y puerto, que también es texto propio.
  const enEjecucion = salidaBs.slice(
    salidaBs.indexOf("\n", salidaBs.indexOf("PARIDAD_BOOTSTRAP_LISTO")) + 1
  );

  const rastros = [...precios, String(TOTAL_ESPERADO)].filter((v) => enEjecucion.includes(v));
  comprobar(
    rastros.length === 0,
    `el bootstrap no vio ningún precio ni el total` + (rastros.length ? ` — VIO: ${rastros.join(", ")}` : "")
  );
  comprobar(
    !/"type":"(share|column-sum|hello)"/.test(enEjecucion),
    "el bootstrap no procesó ningún mensaje del protocolo de Paridad"
  );
  comprobar(
    !/aceite|20W50|factura-demo/i.test(enEjecucion),
    "el bootstrap no vio productos ni nombres de factura"
  );

  // La comprobación más fuerte: durante toda la ronda el bootstrap no registró
  // absolutamente nada, porque no participa en el protocolo.
  const lineasEnEjecucion = enEjecucion
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("🛑") && !l.startsWith("✅"));

  comprobar(
    lineasEnEjecucion.length === 0,
    `el bootstrap no registró ninguna actividad durante la ronda` +
      (lineasEnEjecucion.length ? ` — registró: ${JSON.stringify(lineasEnEjecucion.slice(0, 3))}` : "")
  );
}

// ==========================================================================
// Escenario 2 — el bootstrap desaparece tras el descubrimiento
// ==========================================================================
async function escenarioBootstrapDesaparece() {
  console.log("\n═══ Escenario 2: el bootstrap muere después del descubrimiento ═══\n");

  const puerto = puertoLibre();
  const topic = topicUnico("efimero");
  const bs = await arrancarBootstrap(puerto);
  console.log(`  Bootstrap activo en 127.0.0.1:${puerto}`);

  // --gracia alto: los nodos siguen vivos un rato tras cerrar la ronda, que es
  // la ventana en la que se observa si las conexiones sobreviven al bootstrap.
  const GRACIA = 15000;
  const nodos = CASOS.map((c) =>
    lanzar(
      NODO,
      [
        c.nodo,
        "--precio-cents", String(c.cents),
        "--bootstrap", `127.0.0.1:${puerto}`,
        "--timeout", "90000",
        "--gracia", String(GRACIA),
        "--topic", topic,
      ],
      c.nodo
    )
  );

  // Se espera a que la MALLA esté completa, no a que un nodo haya visto a los
  // demás. Son tres parejas (A-B, A-C, B-C) y cada una necesita el bootstrap
  // para descubrirse. Matarlo cuando solo A ha visto a todos deja a B y C sin
  // ninguna vía para encontrarse entre sí, y la ronda nunca se cierra.
  const mallaCompleta = () =>
    nodos.every((n) => {
      const otros = CASOS.map((c) => c.nodo).filter((x) => x !== n.etiqueta);
      return otros.every((o) => n.leer().includes(`conexión P2P confirmada con ${o}`));
    });

  const conectado = await esperarHasta(mallaCompleta, 90000);

  comprobar(conectado, "los tres nodos se descubrieron entre sí a través del bootstrap local");

  await matar(bs);
  console.log("  🔪 Bootstrap eliminado con SIGKILL (los nodos siguen vivos)");

  const resultados = await conLimite(Promise.all(nodos.map((n) => n.terminado)), 150000, "escenario 2");

  for (const c of CASOS) {
    const r = resultados.find((x) => x.etiqueta === c.nodo);
    const resultado = leerLinea(r.salida, "PARIDAD_RESULTADO");
    const conexiones = leerLinea(r.salida, "PARIDAD_CONEXIONES");
    const otros = CASOS.map((x) => x.nodo).filter((n) => n !== c.nodo);

    console.log(`\n▸ Nodo ${c.nodo} (código ${r.code}):`);
    if (r.code !== 0 || resultado?.completo !== true) volcar(r);
    comprobar(r.code === 0, "terminó limpio pese a perder el bootstrap");
    comprobar(resultado?.completo === true, "completó la agregación");
    comprobar(resultado?.total === TOTAL_ESPERADO, `total = ${TOTAL_ESPERADO}`);
    comprobar(
      JSON.stringify(conexiones?.trasGracia) === JSON.stringify(otros),
      `seguía conectado a ${otros.join(" y ")} ${GRACIA} ms después de morir el bootstrap ` +
        `(tenía: ${JSON.stringify(conexiones?.trasGracia)})`
    );
  }
}

// ==========================================================================
// Escenario 3 — aislamiento del DHT público
// ==========================================================================
async function escenarioAislamiento() {
  console.log("\n═══ Escenario 3: con bootstrap inalcanzable NO se cae al DHT público ═══\n");

  // Puerto donde no hay nada escuchando.
  const puertoMuerto = puertoLibre();
  const topic = topicUnico("aislado");
  console.log(`  Apuntando los nodos a 127.0.0.1:${puertoMuerto}, donde no hay bootstrap.`);

  const nodos = ["A", "B"].map((n, i) =>
    lanzar(
      NODO,
      [
        n,
        "--precio-cents", String(CASOS[i].cents),
        "--bootstrap", `127.0.0.1:${puertoMuerto}`,
        "--timeout", "45000",
        "--topic", topic,
      ],
      n
    )
  );

  const resultados = await conLimite(Promise.all(nodos.map((n) => n.terminado)), 120000, "escenario 3");

  for (const r of resultados) {
    const resultado = leerLinea(r.salida, "PARIDAD_RESULTADO");
    console.log(`\n▸ Nodo ${r.etiqueta} (código ${r.code}):`);

    comprobar(r.code === 0, "terminó limpio en vez de colgarse");
    comprobar(
      !r.salida.includes("conexión P2P confirmada"),
      "NO encontró ningún peer: no hubo respaldo silencioso al DHT público"
    );
    comprobar(resultado?.completo === false, "reportó la ronda como incompleta");
  }
}

// ==========================================================================
// Escenario 4 — end-to-end real sobre bootstrap local
// ==========================================================================
async function escenarioEndToEndConBootstrap() {
  console.log("\n═══ Escenario 4: FACTURA → QVAC → shares → bootstrap local → benchmark ═══\n");

  const puerto = puertoLibre();
  const topic = topicUnico("e2e");
  const bs = await arrancarBootstrap(puerto);
  console.log(`  Bootstrap activo en 127.0.0.1:${puerto}`);

  // Arranque escalonado: tres contextos OCR en Vulkan a la vez tumban el worker
  // de QVAC en esta máquina (ver docs/pipeline-extraccion.md).
  const nodos = [];
  for (const c of CASOS) {
    if (nodos.length) await esperar(15000);
    console.log(`  ▸ arrancando nodo ${c.nodo} (${c.archivo})`);
    nodos.push(
      lanzar(
        NODO,
        [
          c.nodo,
          path.join(FACTURAS, c.archivo),
          "--esperado", String(c.cents),
          "--bootstrap", `127.0.0.1:${puerto}`,
          "--timeout", "300000",
          "--topic", topic,
        ],
        c.nodo
      )
    );
  }

  const resultados = await conLimite(Promise.all(nodos.map((n) => n.terminado)), 420000, "escenario 4");
  const auditorias = [];

  for (const c of CASOS) {
    const r = resultados.find((x) => x.etiqueta === c.nodo);
    const extraccion = leerLinea(r.salida, "PARIDAD_EXTRACCION");
    const resultado = leerLinea(r.salida, "PARIDAD_RESULTADO");
    const auditoria = leerLinea(r.salida, "PARIDAD_AUDITORIA");

    console.log(`\n▸ Nodo ${c.nodo} (código ${r.code}):`);

    if (r.code !== 0 || !resultado) {
      console.error(`  --- salida del nodo ${c.nodo} ---`);
      console.error(r.salida.trim() || "(sin salida)");
      console.error(`  --- fin ---`);
    }

    comprobar(r.code === 0, "terminó limpio");
    comprobar(
      extraccion?.unit_price_cents === c.cents,
      `QVAC extrajo ${c.cents} de ${c.archivo} (obtuvo ${extraccion?.unit_price_cents})`
    );
    comprobar(resultado?.completo === true, "completó la ronda usando solo el bootstrap local");
    comprobar(resultado?.total === TOTAL_ESPERADO, `total = ${TOTAL_ESPERADO} (obtuvo ${resultado?.total})`);
    comprobar(
      resultado !== null && Math.abs(resultado.average - PROMEDIO_ESPERADO) < 0.01,
      `promedio = $43.33 (obtuvo ${resultado?.average?.toFixed(2)})`
    );

    if (auditoria) auditorias.push(auditoria);
  }

  const salidaBs = bs.leer();
  await matar(bs);

  console.log("\n▸ Auditoría con facturas reales:");
  const { valores, mensajes } = auditarTrafico(auditorias);
  const precios = CASOS.map((c) => String(c.cents));
  console.log(`  Mensajes inspeccionados: ${mensajes}`);
  comprobar(
    precios.every((p) => !valores.has(p)),
    `ningún precio extraído de factura viajó por la red`
  );

  // Igual que en el escenario 1: se audita lo emitido tras anunciarse listo,
  // no el banner estático de ayuda.
  const enEjecucion = salidaBs.slice(
    salidaBs.indexOf("\n", salidaBs.indexOf("PARIDAD_BOOTSTRAP_LISTO")) + 1
  );
  comprobar(
    !/ACEITE|20W50/i.test(enEjecucion),
    "el bootstrap no vio nada del contenido de las facturas"
  );
  comprobar(
    [...precios, String(TOTAL_ESPERADO)].every((v) => !enEjecucion.includes(v)),
    "el bootstrap no vio precios ni el total"
  );
}

// ==========================================================================

const sinQvac = process.argv.includes("--sin-qvac");
const soloArg = process.argv.indexOf("--solo");
const solo = soloArg === -1 ? null : process.argv[soloArg + 1];
const corre = (n) => solo === null || solo === String(n);

try {
  if (corre(1)) await escenarioDescubrimiento();
  if (corre(2)) await escenarioBootstrapDesaparece();
  if (corre(3)) await escenarioAislamiento();
  if (sinQvac) {
    console.log("\n(--sin-qvac: se omite el escenario end-to-end con facturas)");
  } else {
    await escenarioEndToEndConBootstrap();
  }
} catch (err) {
  console.error(`\n💥 Las pruebas de bootstrap fallaron: ${err.message}`);
  fallos++;
}

console.log("\n" + "═".repeat(70));
if (fallos === 0) {
  console.log("✅ Bootstrap local: todas las comprobaciones pasaron.");
  process.exit(0);
} else {
  console.error(`❌ Bootstrap local: ${fallos} comprobación(es) fallaron.`);
  process.exit(1);
}
