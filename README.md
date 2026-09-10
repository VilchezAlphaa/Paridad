# Paridad

> **Paridad permite que negocios independientes comparen lo que pagan por un mismo producto sin revelar sus precios individuales ni enviar sus facturas a un servidor central.**

Proyecto para la **Decentralized AI Hackathon 2026**. Toda la inteligencia corre **local** (QVAC + Qwen3 0.6B), el intercambio entre negocios es **P2P real** (Hyperswarm) y la privacidad se garantiza con **additive secret sharing**: por la red solo viajan fragmentos matemáticos (shares) y sumas parciales — nunca un precio.

---

## El problema

Las MiPymes (talleres, bodegas, restaurantes) no saben si están pagando un precio justo por sus insumos. Les serviría compararse con otros negocios, pero nadie quiere revelar sus precios de compra ni subir sus facturas a una plataforma de terceros.

## La solución

Cada negocio corre un **nodo Paridad** en su propia laptop:

```text
factura (imagen) → QVAC local (OCR + extracción) → producto + precio
                                                        ↓
                                        precio → shares (secret sharing)
                                                        ↓
                                        P2P (Hyperswarm) entre los nodos
                                                        ↓
                      cada nodo calcula EL PROMEDIO DEL GRUPO localmente
```

Al final, cada participante ve **solo dos cosas**: el promedio del grupo y su posición frente a él ("pagas 8% más caro" / "buen precio, 28% menos"). Nadie — ni siquiera la app — conoce el precio de otro negocio.

---

## Cómo funciona la privacidad (additive secret sharing)

Con 3 participantes A, B, C y precios `vA`, `vB`, `vC` (en centavos):

1. Cada nodo divide su precio en 3 shares aleatorios que suman su precio:
   `vA = sA1 + sA2 + sA3`. Cada share por sí solo es ruido.
2. Cada nodo **se queda un share propio y envía exactamente UN share a cada peer**
   (nunca dos shares del mismo precio al mismo nodo).
3. Cada nodo suma la "columna" que recibió (un share de cada participante)
   → su **column-sum**. Ese valor mezcla fragmentos de los 3 precios: no revela ninguno.
4. Los nodos intercambian sus column-sums (no shares crudos) y cada uno calcula:
   `total = suma de column-sums = vA + vB + vC` → `promedio = total / 3`.

Ningún precio individual cruza la red en ningún momento. La matemática está testeada con 100+ casos aleatorios (`npm run test:privacy`).

---

## Estructura del repo

```text
nodo-paridad.mjs            ← proceso de UNA laptop: red + ronda + UI local (SSE)
demo-local.mjs              ← ensayo de la demo con 3 nodos en una sola máquina
p2p-privacy-test.mjs        ← spike original del protocolo sobre Hyperswarm (validado)
nodo-a.mjs / nodo-b.mjs     ← spike original de comunicación bidireccional
qvac.config.json            ← config del servidor QVAC local (modelo qwen3-600m-inst-q4)

src/privacy/
  secret-sharing.mjs        ← split/combine (additive secret sharing, BigInt)
  aggregation-protocol.mjs  ← AggregationSession + buildShareMatrix (sin red)
  test-*.mjs                ← tests de la matemática (100 casos + protocolo)

src/network/
  paridad-network.mjs       ← capa de red sobre Hyperswarm: descubrimiento,
                              identificación (hello), mensajes tipados NDJSON,
                              estados de red, resiliencia a mensajes corruptos
  network-state.mjs         ← enum de estados (importable desde Node y navegador)
  aggregation-runner.mjs    ← pegamento red + protocolo: ejecuta la ronda completa
  test-paridad-network.mjs  ← test de red con 3 procesos reales (DHT local)
  test-aggregation-e2e.mjs  ← test end-to-end: 3 nodos → mismo promedio en todos

src/ui/
  index.html + styles.css   ← dashboard (diseño de los mockups del equipo)
  app.js                    ← renderizador; elige fuente real o mock
  real-data-source.js       ← estado en vivo por SSE desde el nodo local
  mock-data.js              ← datos fijos para diseñar la UI sin red (con banner)
  calculadora.html          ← calculadora de ahorro vs el promedio del grupo
```

---

## Cómo correr

### Demo real (una laptop por participante)

En cada laptop, dentro del repo:

```bash
npm install

# laptop 1:
node nodo-paridad.mjs A --price 4700 --product "Aceite Motor 20W50" --quantity 4
# laptop 2:
node nodo-paridad.mjs B --price 3100 --product "Aceite Motor 20W50" --quantity 2
# laptop 3:
node nodo-paridad.mjs C --price 5200 --product "Aceite Motor 20W50" --quantity 6
```

- El precio va en **centavos** y **nunca sale del proceso**.
- Cada nodo sirve su dashboard en `http://localhost:4700` (cámbialo con `--port`).
- Los nodos se descubren por el DHT público de Hyperswarm, se identifican,
  ejecutan la ronda automáticamente y el dashboard se actualiza en vivo.
- Si un peer se cae a mitad de ronda, los demás lo detectan (estado
  `PEER_DISCONNECTED`) y al volver **todos reinician la ronda con shares frescos**.

### Ensayo en una sola máquina

```bash
npm run demo
# UI del nodo A: http://localhost:4700  (B: 4701, C: 4702)
```

Levanta un DHT local (testnet de hyperdht) y los 3 nodos completos en esta máquina.
Nota: entre procesos de una misma máquina la convergencia puede tardar
15–60 s por quirks de red local; entre laptops distintas conecta directo.

### Tests

```bash
npm test                # todo: privacidad + red + end-to-end
npm run test:privacy    # secret sharing (100 casos) + protocolo de agregación
npm run test:network    # capa de red con 3 procesos reales sobre DHT local
npm run test:e2e        # ronda completa: los 3 nodos calculan el mismo promedio
```

### UI sola (sin red, datos mock)

```bash
npm run ui
# abre http://localhost:4173/src/ui/  (banner amarillo = datos de prueba)
```

---

## La interfaz

Diseño basado en los mockups del equipo (`paridad-dashboard.html`, `paridad-calculadora.html`): tema papel, tipografías Fraunces + IBM Plex, veredictos con color.

- **Dashboard** (`/src/ui/`): tu producto con "Tú pagas" vs "Promedio del grupo" y
  veredicto (*Pagas de más / Buen precio / En el promedio*), KPIs (promedio, tu
  posición, participantes), estado del nodo (P2P, peers, IA local, Internet,
  shares enviados) y panel de privacidad.
- **Calculadora de ahorro** (`/src/ui/calculadora.html`): cantidad × (tu precio
  vs promedio del grupo) → cuánto ahorrarías comprando al precio promedio.

**Decisión importante:** los mockups comparaban contra proveedores con nombre y
precio. Eso revelaría precios individuales y rompería el modelo de privacidad,
así que la app compara **únicamente contra el promedio anónimo del grupo**.
Es el argumento central del pitch, no una limitación.

La UI recibe el estado por **SSE** (`/events`) desde su propio nodo local — no
hay backend central; cada laptop se sirve su propia interfaz.

---

## Estados

**Red** (`network-state.mjs` + dinámicos):
`WAITING_FOR_PEERS` → `1_PEERS_CONNECTED`, `2_PEERS_CONNECTED`… → `READY_FOR_AGGREGATION` / `PEER_DISCONNECTED`

**Ronda** (`aggregation-runner.mjs`):
`WAITING_PRICE` → `WAITING_NETWORK` → `SHARING` → `DONE`

---

## Decisiones técnicas y lecciones aprendidas

- **Hyperswarm v4 ya deduplica conexiones internamente** (con desempate por clave
  pública y regla de reconexión). Implementar un desempate propio encima resultó
  contraproducente: destruía reconexiones válidas y conservaba conexiones zombi.
  La capa de red confía en la dedup de Hyperswarm.
- **Nunca llamar `removeAllListeners()` sobre un stream del swarm**: borra también
  los listeners internos de Hyperswarm y corrompe su contabilidad de conexiones
  (peers "conectados" para siempre).
- **Tests con DHT local** (`hyperdht/testnet.js`): varios procesos en UNA máquina
  no se alcanzan de forma fiable por el DHT público (hairpinning NAT). Los tests
  y `demo-local` usan un testnet en 127.0.0.1 con los mismos code paths reales;
  en laptops reales se usa el DHT público (sin `--bootstrap`).
- **Refresh activo del discovery**: mientras falten peers, cada nodo re-anuncia y
  re-busca cada 3 s. Sin esto, un nodo que llega tarde depende del ciclo interno
  de Hyperswarm (~10-15 s o más) y la convergencia era impredecible.
- **Cero dependencias para la UI**: el servidor local usa `node:http` + SSE.
  Las únicas dependencias del proyecto son Hyperswarm y el SDK de QVAC.
- **Precios como BigInt en centavos**: la matemática del secret sharing es exacta;
  la conversión a moneda ocurre solo al mostrar.

## Límites conocidos (MVP de hackathon)

- El pipeline QVAC (factura → OCR → JSON) vive en otra rama; aquí el precio entra
  por CLI. El punto de integración está listo: `runner.setPrice(centavos)`.
- Participantes fijos (`A`, `B`, `C`) y un producto por ronda.
- En la reconexión tras una caída hay una ventana de milisegundos donde un share
  fresco puede rechazarse como duplicado; el protocolo se recupera al reiniciar
  la ronda (aceptable para la demo con red estable).
- Los nombres de nodo no están autenticados criptográficamente (grupo cerrado y
  honesto por diseño del MVP).

## Próximos pasos

1. Integrar el pipeline QVAC de la otra rama → `setPrice()` desde la factura real.
2. Flujo de demo con guion (3 laptops + narrativa de privacidad) y video.
3. Descubrimiento local (LAN) para demo 100 % sin Internet.
