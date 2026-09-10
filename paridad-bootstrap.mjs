/**
 * Nodo bootstrap local de Paridad.
 *
 * Arranca un nodo DHT que sirve ÚNICAMENTE para que los participantes se
 * encuentren entre sí sin consultar el DHT público de Hyperswarm.
 *
 * Lo que este proceso hace:
 *   - responder consultas del DHT (quién anuncia qué topic, en qué dirección);
 *   - nada más.
 *
 * Lo que este proceso NO hace, por construcción y no por convención:
 *   - no se une al topic de Paridad;
 *   - no habla el protocolo de Paridad (hello / share / column-sum);
 *   - no recibe shares, ni precios, ni totales, ni facturas, ni texto OCR;
 *   - no agrega nada.
 *
 * No sabe siquiera qué se está calculando: para él los participantes son
 * claves públicas que anuncian un hash de 32 bytes. El intercambio de datos
 * ocurre en conexiones cifradas directas entre peers, en las que este proceso
 * no participa.
 *
 * Uso:
 *   node paridad-bootstrap.mjs                      (127.0.0.1:49738)
 *   node paridad-bootstrap.mjs --host 192.168.1.50  (para otras laptops)
 *   node paridad-bootstrap.mjs --host 192.168.1.50 --port 49738
 */

import DHT from "hyperdht";
import os from "node:os";

const args = process.argv.slice(2);

function opcion(nombre, porDefecto) {
  const i = args.indexOf(nombre);
  return i === -1 ? porDefecto : args[i + 1];
}

const host = opcion("--host", "127.0.0.1");
// Puerto distinto del 49737 que hyperdht usa por defecto para los peers, para
// que bootstrap y participantes puedan convivir en la misma máquina.
const port = Number(opcion("--port", "49738"));

/** Direcciones IPv4 de esta máquina, para saber qué pasarle a las otras. */
function direccionesLocales() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([nombre, señales]) =>
      (señales ?? [])
        .filter((s) => s.family === "IPv4" && !s.internal)
        .map((s) => `${s.address}  (${nombre})`)
    );
}

let dht = null;
let cerrando = false;

async function apagar(motivo, exitCode = 0) {
  if (cerrando) return;
  cerrando = true;

  console.log(`\n🛑 Cerrando bootstrap (${motivo})...`);

  const forzar = setTimeout(() => {
    console.error("⚠️  El cierre tardó demasiado, forzando salida");
    // Se sale con el codigo que corresponde al desenlace real, NO con 1.
    // Un cierre lento no convierte en fallo una ronda que si se completo:
    // cuando los tres nodos terminan a la vez se resetean las conexiones
    // mutuamente y swarm.destroy() puede no cerrar dentro del margen.
    process.exit(exitCode);
  }, 5000);
  forzar.unref();

  try {
    if (dht) await dht.destroy();
    console.log("✅ Bootstrap cerrado.");
  } catch (err) {
    console.error(`⚠️  Error al cerrar el bootstrap: ${err.message}`);
    exitCode = exitCode || 1;
  } finally {
    clearTimeout(forzar);
    process.exit(exitCode);
  }
}

process.on("SIGINT", () => void apagar("SIGINT"));
process.on("SIGTERM", () => void apagar("SIGTERM"));

process.on("uncaughtException", (err) => {
  console.error("\n💥 Bootstrap: excepción no capturada");
  console.error(err);
  void apagar("uncaughtException", 1);
});

process.on("unhandledRejection", (reason) => {
  console.error("\n💥 Bootstrap: promesa rechazada sin manejar");
  console.error(reason);
  void apagar("unhandledRejection", 1);
});

try {
  // bootstrapper() crea un nodo DHT no efímero, no cortafuegos y con
  // `bootstrap: []`, es decir, que no consulta la red pública.
  dht = DHT.bootstrapper(port, host);
  await dht.ready();

  console.log("\n🧭 Bootstrap local de Paridad activo");
  console.log(`   Dirección para los nodos:  ${host}:${port}`);
  console.log("");
  console.log("   Este proceso solo resuelve descubrimiento.");
  console.log("   No recibe precios, ni shares, ni totales, ni facturas.");
  console.log("");

  const otras = direccionesLocales();
  if (host === "127.0.0.1" && otras.length) {
    console.log("   Escuchando en 127.0.0.1: solo sirve para nodos de ESTA máquina.");
    console.log("   Para una demo con varias laptops, relánzalo con una de estas IP:");
    for (const dir of otras) console.log(`     --host ${dir}`);
    console.log("");
  }

  console.log("   Arranca los nodos así:");
  console.log(`     node paridad-node.mjs A demo-data/facturas/factura-demo-a.png --bootstrap ${host}:${port}`);
  console.log("");
  console.log("   Ctrl+C para detenerlo.\n");

  console.log(`PARIDAD_BOOTSTRAP_LISTO ${JSON.stringify({ host, port })}`);
} catch (err) {
  console.error(`\n❌ No se pudo arrancar el bootstrap en ${host}:${port}: ${err.message}`);
  await apagar("error", 1);
}
