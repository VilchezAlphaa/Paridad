// DEMO DE PRODUCTO de Paridad, en UNA sola maquina.
//
// Es el flujo completo y real, sin datos precargados:
//
//   factura (imagen) -> QVAC/OCR local -> producto + precio
//     -> secret sharing -> Hyperswarm P2P -> agregacion -> referencia del grupo
//
// Cada nodo extrae SU factura con QVAC en su propio proceso. El precio
// nunca sale de ese proceso: por la red solo viajan nombres de producto,
// shares y sumas parciales.
//
//   npm run demo            procesa las facturas automaticamente
//   npm run demo:manual     espera a que pulses "Procesar facturas" en cada UI
//   npm run demo:items      demo de red con 5 productos por CLI (sin OCR)
//
// Abre despues:  A http://localhost:4700   B :4701   C :4702
// Ctrl+C cierra todo.
//
// POR QUE ARRANCA UN NODO DETRAS DE OTRO
// Tres contextos OCR de QVAC en Vulkan a la vez tumban el worker (medido:
// "Bare worker exited mid-request (code=3221226505)"). Asi que el nodo B
// no arranca hasta que A avisa de que ya termino y libero los modelos, y C
// espera a B. Cada nodo suelta la GPU al acabar su cola de facturas, asi
// que en ningun momento hay dos OCR compitiendo. En la demo real cada
// participante esta en su propia laptop y esto no aplica.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createTestnet from "hyperdht/testnet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodePath = path.join(__dirname, "nodo-paridad.mjs");
const facturasDir = path.join(__dirname, "demo-data", "facturas");

const manual = process.argv.includes("--manual");

// Una factura real por participante. Los precios NO estan aqui: salen del
// OCR de cada imagen (4700 / 3100 / 5200 centavos de "Aceite Motor 20W50").
const NODES = [
  { name: "A", port: 4700, factura: "factura-demo-a.png" },
  { name: "B", port: 4701, factura: "factura-demo-b.png" },
  { name: "C", port: 4702, factura: "factura-demo-c.png" },
];

// Margen amplio: la primera vez QVAC puede tener que descargar modelos.
const ESPERA_MAX_EXTRACCION_MS = 240_000;

const testnet = await createTestnet(3);
const bootstrapJson = JSON.stringify(testnet.bootstrap);
const topicSeed = `paridad-demo-local-${process.pid}`;

console.log("🎬 Demo de Paridad — 3 nodos en esta maquina, DHT local, QVAC real");
console.log(`   Facturas: ${facturasDir}`);
console.log(
  manual
    ? "   Modo manual: pulsa «Procesar facturas» en cada UI, DE UNA EN UNA.\n"
    : "   Cada nodo procesa su factura y libera la GPU antes de que arranque el siguiente.\n"
);

const children = [];
let cerrando = false;

function lanzarNodo({ name, port, factura }) {
  const child = spawn(
    process.execPath,
    [
      nodePath, name,
      "--port", String(port),
      "--topic", topicSeed,
      "--bootstrap", bootstrapJson,
      "--factura", path.join(facturasDir, factura),
      ...(manual ? ["--manual"] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let salida = "";
  child.stdout.on("data", (d) => {
    salida += d.toString();
    process.stdout.write(`[${name}] ${d}`);
  });
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));

  children.push(child);
  return { name, child, leer: () => salida };
}

/** Espera a que un nodo publique que ya termino su cola de facturas. */
function esperarExtraccion(nodo) {
  return new Promise((resolve) => {
    const limite = Date.now() + ESPERA_MAX_EXTRACCION_MS;
    const timer = setInterval(() => {
      const listo = nodo.leer().includes("PARIDAD_EXTRACCION_LISTA");
      const fallo = nodo.leer().includes("no se pudo iniciar el pipeline");
      if (listo || fallo || Date.now() > limite || cerrando) {
        clearInterval(timer);
        if (!listo && !cerrando) {
          console.warn(
            `⚠️  ${nodo.name} no confirmo su extraccion (${fallo ? "fallo del pipeline" : "tiempo agotado"}); se continua igualmente.`
          );
        }
        resolve();
      }
    }, 500);
    timer.unref?.();
  });
}

for (const config of NODES) {
  const nodo = lanzarNodo(config);
  if (manual) continue; // en manual el ritmo lo marca quien pulsa los botones
  await esperarExtraccion(nodo);
}

console.log("\n✅ Los tres nodos tienen su dato local. La agregacion P2P corre sola.");
console.log("   UI:  A http://localhost:4700   B http://localhost:4701   C http://localhost:4702\n");

async function shutdown() {
  if (cerrando) return;
  cerrando = true;
  console.log("\n🛑 Cerrando demo local...");
  for (const child of children) child.kill();
  await testnet.destroy();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
