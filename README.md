# Paridad

> **Paridad permite que negocios independientes comparen lo que pagan por un mismo producto sin revelar sus precios individuales ni enviar sus facturas a un servidor central.**

Prototipo para la **Decentralized AI Hackathon 2026**.

- La IA corre **en el dispositivo** con el SDK de QVAC: la factura nunca sale de la laptop.
- Los negocios se comunican **entre sí**, por P2P (Hyperswarm). No hay servidor de Paridad.
- La referencia del grupo se calcula con **secret sharing aditivo**: por la red viajan fragmentos aleatorios y sumas parciales, no precios.

Resultado del demo validado con tres nodos y facturas procesadas por QVAC: referencia del grupo **$43.33**; A paga **+8.5 %**, B **−28.5 %**, C **+20.0 %**, sin que ningún nodo reciba el precio de otro.

---

## 1. Problema

Una MiPyme (un taller, una bodega, un lubricentro) sabe cuánto pagó por un insumo, pero no si ese precio es razonable frente a lo que pagan negocios parecidos. Compararse le serviría; la vía habitual es subir facturas o precios a una plataforma de terceros, que pasa a conocer los datos comerciales de todos.

Para muchos pequeños negocios eso no es aceptable, y en contextos de registros en papel, digitalización parcial y desconfianza hacia plataformas centralizadas, tampoco es realista.

## 2. Solución

Cada negocio ejecuta un **nodo Paridad** en su propio equipo. El nodo lee la factura con IA local, guarda productos y precios en el dispositivo, y participa en una agregación privada con los demás nodos del grupo. Al final, cada negocio ve **su** precio, la **referencia del grupo** y su **posición** frente a ella. No ve el precio de nadie más.

```text
factura (imagen)
   ↓  QVAC / OCR local              (en tu dispositivo)
productos + precios
   ↓  historial local               (en tu dispositivo)
precio → shares                     (secret sharing aditivo)
   ↓  Hyperswarm P2P                (solo fragmentos y sumas parciales)
agregación privada
   ↓
referencia del grupo + tu posición
```

El escenario pensado es un **grupo que ya existe** —una asociación, cooperativa o red de comercios que ya se conocen—, no un mercado abierto de desconocidos.

## 3. Por qué es descentralizado

| Qué | Dónde ocurre | Quién más lo ve |
|---|---|---|
| Lectura de la factura (OCR + extracción) | en el dispositivo, con QVAC | nadie |
| Historial de productos y precios | archivo JSON local del dispositivo | nadie |
| Descubrimiento de los otros nodos | DHT de Hyperswarm (público o local) | el DHT ve claves públicas y un hash de topic |
| Intercambio de shares y sumas parciales | conexiones cifradas directas entre nodos | solo los participantes |
| Cálculo de la referencia | cada nodo, por su cuenta | — |

No hay backend de Paridad, ni base de datos central, ni servicio de inferencia remoto. Si se apaga un nodo, los demás siguen funcionando (solo no se cierra esa ronda). Si se apaga el bootstrap local después del descubrimiento, las conexiones ya establecidas continúan.

## 4. Cómo funciona

1. **Cargar factura.** El usuario elige una imagen (PNG/JPG). Va del navegador al proceso local por `localhost`.
2. **IA local.** El nodo carga los modelos de QVAC, hace OCR y extrae todas las líneas de producto: nombre, cantidad y precio unitario. Las líneas se guardan en el historial local. Los modelos se liberan al terminar.
3. **Grupo.** Los nodos se descubren y se identifican (`A`, `B`, `C`). Intercambian solo la **lista de nombres** de producto para saber qué tienen en común.
4. **Agregación privada.** Para cada producto común, cada nodo parte su precio en shares, entrega exactamente uno a cada peer, suma la columna que recibe y comparte esa suma parcial. Con las sumas parciales, cada nodo calcula el total y la referencia.
5. **Resultados.** Para productos con datos de los tres participantes: referencia y posición. Para el resto: **"Sin comparación disponible"**, sin inventar nada.

## 5. Arquitectura

```text
                     Laptop A                                 Laptop B / C
   ┌────────────────────────────────────────────┐        ┌───────────────────┐
   │ nodo-paridad.mjs                           │        │ (idéntico)        │
   │                                            │        │                   │
   │  src/extraction/invoice-pipeline.mjs       │        │                   │
   │    QVAC SDK ─ OCR (EasyOCR GGUF)           │        │                   │
   │             ─ LLM (Qwen3 0.6B, json_schema)│        │                   │
   │  src/extraction/historial.mjs              │        │                   │
   │    data/nodo-A/historial.json              │        │                   │
   │                                            │        │                   │
   │  src/privacy/secret-sharing.mjs            │        │                   │
   │  src/privacy/aggregation-protocol.mjs      │        │                   │
   │  src/network/aggregation-runner.mjs        │        │                   │
   │  src/network/paridad-network.mjs ──────────┼── P2P ─┼─▶                 │
   │    Hyperswarm + NDJSON                     │ Noise  │                   │
   │                                            │        │                   │
   │  UI local (src/ui/, SSE) ─ localhost:4700  │        │ localhost:4701/2  │
   └────────────────────────────────────────────┘        └───────────────────┘
                              │
                     descubrimiento: HyperDHT
                     (público, o bootstrap local en la LAN)
```

Cada laptop es un nodo completo y se sirve su propia interfaz. Lo único compartido es el mecanismo de descubrimiento.

## 6. QVAC / IA local

Paridad usa el **SDK de QVAC 0.19.0 dentro del proceso del nodo** (no el servidor http de QVAC). Dos modelos, ambos del registro de QVAC:

| Paso | Modelo | Qué hace |
|---|---|---|
| OCR | `OCR_LATIN` (EasyOCR, GGUF, ~15 MB) | imagen → bloques de texto con posición |
| Extracción | `QWEN3_600M_INST_Q4` (Qwen3-0.6B Q4_0, ~380 MB) | texto → JSON con las líneas de producto |

Decisiones que importan para la fiabilidad:

- La extracción usa **`responseFormat: json_schema`**: llama.cpp convierte el schema a gramática GBNF, así que la forma del JSON está garantizada. Decodificación greedy (`temp: 0`, semilla fija) para que la misma factura dé siempre el mismo resultado.
- El precio se pide al modelo **como texto** (`"47.00"`) y se convierte a centavos en JavaScript. Un modelo de 600M haciendo aritmética era una fuente de error innecesaria.
- Los bloques del OCR se reagrupan en líneas por coordenada y se aplican **reparaciones deterministas y acotadas** a confusiones medidas (`20h50` → `20W50`, `47 . 00` → `47.00`). No hay corrector general.
- OCR en **Vulkan** sobre la GPU integrada (~3–5 s por factura) con **respaldo automático a CPU** (~14 s) si la GPU falla. El respaldo es a CPU local; **no existe ninguna ruta hacia inferencia externa**.
- La configuración del OCR (`canvasSize`, `magRatio`, batch) se eligió con un barrido reproducible: `node tools/bench-ocr.mjs`. Ver `docs/pipeline-extraccion.md`.

**Cómo verificar que la inferencia es local:** cada nodo imprime `PARIDAD_EXTRACCION {…}` con el backend real y los tiempos de OCR/LLM; `npm run test:demo` comprueba que esos tiempos existen y que el precio extraído es el de la factura. En el código no hay ninguna llamada a proveedores de IA: todas las llamadas `fetch` van a `localhost` (la UI a su propio nodo; `test-qvac.mjs`, un script de validación inicial, al servidor QVAC local).

**Otras conexiones salientes, para ser exhaustivos:** la primera ejecución **descarga los modelos** del registro de QVAC (~400 MB); el nodo hace una resolución DNS periódica (`one.one.one.one`) solo para informar en la UI si hay Internet, sin enviar datos; y la UI carga tipografías de Google Fonts si hay conexión. Ninguna interviene en la inferencia ni transporta datos del negocio.

## 7. P2P y agregación privada

### Red (Hyperswarm)

- Cada nodo se une a un *topic* (SHA-256 de un nombre de grupo) con `client: true, server: true`.
- Las conexiones son streams cifrados de Hyperswarm (Noise). Encima, Paridad usa **NDJSON**: un objeto JSON por línea.
- Handshake `hello` para identificar al participante; deduplicación de conexiones delegada en Hyperswarm; mensajes corruptos o de remitente no verificado se descartan sin tumbar el nodo; tope al buffer de entrada.
- Descubrimiento por el **DHT público** de Hyperswarm (laptops en redes distintas) o por un **bootstrap local** (`paridad-bootstrap.mjs`, un nodo `HyperDHT` propio) para redes locales sin salida a Internet.

Solo existen cuatro tipos de mensaje:

```json
{"type":"hello","from":"A"}
{"type":"products","from":"A","payload":{"products":["aceite motor 20w50"]}}
{"type":"share","from":"A","payload":{"product":"aceite motor 20w50","share":"<entero mod p>"}}
{"type":"column-sum","from":"A","payload":{"product":"aceite motor 20w50","value":"<entero mod p>"}}
```

### Agregación (secret sharing aditivo, `src/privacy/`)

Con participantes A, B, C, precios en centavos `vA, vB, vC` y un primo `p = 2^127 − 1`:

1. Cada nodo parte su precio en 3 shares aleatorios en ℤ*p* que suman su precio: `vA = sA1 + sA2 + sA3 (mod p)`. Un share por sí solo es ruido uniforme.
2. Cada nodo se queda **un** share y envía **exactamente un** share a cada peer. Ningún nodo recibe dos shares del mismo precio.
3. Cada nodo suma la columna que recibió (un share de cada participante): su **suma parcial**. Mezcla un fragmento de cada precio; no revela ninguno.
4. Los nodos intercambian sumas parciales y cada uno calcula `total = Σ sumas parciales = vA + vB + vC`, y la referencia `total / 3`.

Todo en `BigInt`; la conversión a dólares ocurre solo al mostrar. Corre **una ronda por producto común**, en paralelo.

**Verificación:** `npm run test:privacy` (100 casos aleatorios de split/combine, más el protocolo completo simulado en memoria con ceros, valores grandes y rechazo de duplicados). Los tests de demo activan `PARIDAD_WIRE_AUDIT=1`, que imprime cada mensaje tal cual se serializa, y comprueban que **ningún precio, ningún campo del historial y ningún texto OCR** aparecen en el cable.

## 8. Privacidad y límites

Lo que Paridad puede sostener, y lo que no:

**Se queda en el dispositivo:** la imagen de la factura, el texto OCR, el precio individual, el historial completo y el nombre del proveedor.

**Sale por la red:** claves públicas y hash del topic (descubrimiento), el nombre del participante (`A`/`B`/`C`), los **nombres de producto**, shares y sumas parciales. Los nombres de producto **no** son privados en este diseño: el grupo necesita saber qué está comparando.

**Modelo de amenaza real, con 3 participantes:**

- Un participante **curioso pero honesto**, que sigue el protocolo, no puede deducir el precio de otro a partir de lo que recibe (un share ajeno por participante y las sumas parciales).
- Si **dos participantes se coluden**, pueden deducir el precio del tercero: con `n` participantes, `n − 1` coludidos siempre pueden. Es una propiedad de cualquier suma aditiva, y con `n = 3` el margen es el mínimo. Por eso el prototipo **no publica comparaciones con menos de 3 participantes** (`MIN_PARTICIPANTES_COMPARACION = 3`): con 2, el total revela directamente el otro precio.
- No hay autenticación de participantes: la identidad se declara en el `hello`. El grupo se asume cerrado y conocido. Cualquiera que conozca el topic podría presentarse como un participante que aún no se ha conectado.
- El descubrimiento por DHT público expone la clave pública del nodo y el hash del topic a la red DHT (no los datos).

Preferimos decir **privacidad por diseño**: la arquitectura no da a ningún tercero —tampoco a Paridad— acceso a los precios. No decimos "privacidad absoluta".

**Sobre "offline":** Paridad necesita que las máquinas se alcancen por IP. Con el bootstrap local funciona en una red local sin salida a Internet ni servidores externos. **No funciona sin ninguna conectividad.** En §16 está qué se ha verificado físicamente y qué no.

## 9. Demo

```bash
npm run demo
```

Levanta en una sola máquina un DHT local y tres nodos. Cada nodo procesa **su** factura de `demo-data/facturas/` con QVAC; el precio sale del OCR, no de datos precargados. Los nodos arrancan en serie —cada uno libera los modelos antes de que empiece el siguiente— porque tres contextos OCR en Vulkan a la vez saturan el worker de QVAC en la máquina de desarrollo. Después la agregación corre sola.

| Nodo | UI | Factura |
|---|---|---|
| A | http://localhost:4700 | `factura-demo-a.png` (1 producto) + `factura-demo-multi.png` (5 productos) |
| B | http://localhost:4701 | `factura-demo-b.png` |
| C | http://localhost:4702 | `factura-demo-c.png` |

Duración: ~55 s hasta los resultados (más la descarga de modelos la primera vez).

Variantes:

```bash
npm run demo:manual   # modo grabación: nodos vacíos; cargas o arrastras la factura en cada UI
npm run demo:items    # 5 productos por CLI, sin OCR: solo ejercita la red
```

**Tres laptops en una red local:** una corre `Iniciar_Bootstrap_Paridad.ps1` (bootstrap de descubrimiento; no ve precios) y las tres corren `Iniciar_Nodo_Paridad.ps1` con la IP del bootstrap. Detalle en `docs/demo.md` y `docs/bootstrap-local.md`.

### Qué muestra el vídeo

Una factura entra en un nodo; la IA local la lee en ese dispositivo y registra sus productos; los tres participantes se conectan; se ejecuta la agregación; aparece la referencia del grupo y la posición de cada uno, sin que ningún precio ajeno se vea en ninguna pantalla.

## 10. Resultados del demo

Con las facturas sintéticas de demo procesadas por QVAC (`Aceite Motor 20W50`, extraído en cada nodo):

| Nodo | Precio extraído | Referencia del grupo | Posición |
|---|---|---|---|
| A | 4700 centavos | $43.33 | +8.5 % |
| B | 3100 centavos | $43.33 | −28.5 % |
| C | 5200 centavos | $43.33 | +20.0 % |

Total agregado: 13 000 centavos; los tres nodos llegan al mismo total y promedio por su cuenta. La factura de 5 productos de A produce 5 registros con cantidades y precios exactos; los 4 productos que B y C no tienen quedan en el historial de A como "Sin comparación disponible".

Son resultados **del demo, con datos sintéticos**, útiles para verificar el pipeline. No son un benchmark de precios reales.

Memoria por nodo: ~110 MB durante la extracción, ~80 MB después de liberar modelos, plana durante minutos. Reproducible con `npm run test:demo` y `npm run test:multi`.

## 11. Stack y componentes preexistentes

Declaración de todo lo que Paridad usa y no desarrolló:

| Componente | Versión | Licencia | Qué aporta |
|---|---|---|---|
| **@qvac/sdk** (Tether) | 0.19.0 | Apache-2.0 | inferencia local: OCR (`OCR_LATIN`, EasyOCR GGUF) y LLM (`QWEN3_600M_INST_Q4`) con salida estructurada por gramática; backend Vulkan/CPU |
| **hyperswarm** (Holepunch) | 4.17.1 | MIT | conexiones P2P cifradas, descubrimiento por topic, deduplicación de conexiones |
| **hyperdht** (Holepunch) | 6.34.0 | MIT | DHT de descubrimiento; `DHT.bootstrapper()` para el bootstrap local; `testnet.js` para el DHT de pruebas |
| **@hyperswarm/rpc** | 3.5.0 | Apache-2.0 | declarado en `package.json`; **no se usa** en el código actual |
| **Node.js** | 24 | MIT | `node:http`, `node:fs`, `node:crypto`, `child_process`; sin framework web |
| Modelos: Qwen3-0.6B (Alibaba; GGUF de unsloth) y EasyOCR latin_g2 (GGUF de QVAC) | — | según cada modelo | descargados del registro de QVAC en la primera ejecución |
| Google Fonts (Fraunces, IBM Plex Sans) | — | OFL | tipografía de la UI; sin Internet se usan las del sistema. **No interviene en la inferencia** |

**Desarrollado por el equipo de Paridad:** el protocolo de agregación (`src/privacy/`), la capa de red y la ejecución de rondas por producto (`src/network/`), el pipeline de extracción sobre el SDK de QVAC con sus reparaciones y canonicalización (`src/extraction/invoice-pipeline.mjs`), el historial local (`src/extraction/historial.mjs`), el nodo y su UI (`nodo-paridad.mjs`, `src/ui/`), las demos, los tests y las herramientas de medición (`tools/`).

**Asistencia de IA en el desarrollo:** el código se escribió con ayuda de asistentes de programación (Claude Code y Codex); `CLAUDE.md` y `AGENTS.md` son sus guías de trabajo. Las decisiones técnicas y las medidas documentadas se verificaron ejecutándolas en la máquina de desarrollo.

Sin backend, sin base de datos, sin blockchain, sin cuentas.

## 12. Instalación

Requisitos: Node.js 24 (la versión con la que se desarrolló y probó), npm, y para la extracción una máquina donde QVAC funcione (validado en Windows 11, Ryzen 5 5500U, 16 GB, Radeon integrada con Vulkan; hay respaldo a CPU).

```bash
git clone <repo>
cd proyecto-paridad
npm install
```

La primera vez que se procesa una factura, el SDK descarga los modelos (~400 MB).

## 13. Ejecución

Un nodo, con una factura:

```bash
node nodo-paridad.mjs A --factura demo-data/facturas/factura-demo-a.png
```

Abre http://localhost:4700. Opciones: `--port`, `--topic <grupo>`, `--carpeta <dir>` (vigila una carpeta de facturas), `--bootstrap-host <ip> --bootstrap-port 49738` (descubrimiento por bootstrap local en vez de DHT público), `--datos <dir>` (dónde guardar el historial), `--ocr-backend cpu|vulkan`, `--manual`.

Sin `--bootstrap-host`, el nodo usa el DHT público de Hyperswarm: es el modo para laptops en redes distintas.

Bootstrap local para una LAN:

```bash
node paridad-bootstrap.mjs --host <ip-de-esta-laptop>
```

Auditoría de lo que sale por la red (imprime cada mensaje):

```bash
PARIDAD_WIRE_AUDIT=1 npm run demo
```

## 14. Tests

```bash
npm test              # privacidad + historial + red + agregación end-to-end (sin GPU)
npm run test:privacy  # secret sharing (100 casos), protocolo, historial local
npm run test:network  # capa de red con 3 procesos reales sobre DHT local
npm run test:e2e      # 3 nodos → mismo total y promedio en todos
npm run test:demo     # demo de producto con QVAC real + auditoría de cable (~1 min)
npm run test:multi    # factura de 5 productos con QVAC real, reinicio, deduplicación
```

`npm test` no incluye los dos últimos a propósito: necesitan los modelos y la GPU, y no deben hacer fallar la batería normal en una máquina sin ellos.

Pruebas del spike original del protocolo y del bootstrap local (procesos reales, con y sin DHT público): `node src/e2e/test-end-to-end.mjs`, `node src/e2e/test-bootstrap-local.mjs`.

## 15. Estructura del repositorio

```text
nodo-paridad.mjs              proceso de UNA laptop: extracción + historial + red + ronda + UI
demo-local.mjs                npm run demo (3 nodos, DHT local, QVAC real)
demo-items.mjs                demo de red por CLI, sin OCR
paridad-bootstrap.mjs         nodo bootstrap para descubrimiento en red local
Iniciar_*.ps1 / .bat          lanzadores para la demo con 3 laptops

src/extraction/
  invoice-pipeline.mjs        QVAC: OCR + extracción (1 y N líneas), reparaciones, canonicalización
  historial.mjs               historial local (JSON, escritura atómica, dedupe por hash de factura)
  test-historial.mjs · test-multi-producto.mjs · test-invoice-pipeline.mjs
src/privacy/
  secret-sharing.mjs          split / combine mod p, BigInt
  aggregation-protocol.mjs    AggregationSession, buildShareMatrix (sin red)
  test-*.mjs
src/network/
  paridad-network.mjs         Hyperswarm + NDJSON + handshake + estados + auditoría de cable
  aggregation-runner.mjs      una ronda por producto común sobre la red
  test-*.mjs
src/ui/                       una pantalla, cuatro estados (idle · processing · results · history), SSE
  brand/                      logo oficial (original + derivados web)

src/p2p/ · paridad-node.mjs · p2p-privacy-test.mjs · src/e2e/
                              spike original del protocolo sobre Hyperswarm y pruebas del bootstrap local
demo-data/facturas/           facturas sintéticas (3 de una línea + 1 de cinco)
tools/                        generador de facturas, barrido de configuración del OCR
docs/                         detalle técnico de cada pieza
```

## 16. Limitaciones actuales

- **Grupo fijo de 3 participantes** (`A`, `B`, `C`). La ronda de un producto solo cierra cuando los tres lo tienen; no hay grupos de tamaño variable ni descubrimiento de negocios desconocidos. Es una decisión de MVP coherente con el escenario (un grupo que ya existe).
- **Sin autenticación de participantes** (§8).
- **Colusión de n−1** (§8): con 3 participantes, dos coludidos deducen al tercero.
- **Facturas sintéticas.** Las de demo son PNG generados, limpios y con un layout pensado para el OCR. No hay evidencia de que el pipeline funcione con fotos de facturas reales; el barrido mostró un margen de precisión estrecho (`docs/pipeline-extraccion.md`).
- **Canonicalización simple.** `PASTILLAS DE FRENO DELANT` y `Pastillas de freno delanteras` no se agruparían. Es normalización de texto, no matching semántico.
- **Conectividad.** Verificado: 3 nodos en una máquina (DHT local) y 2 laptops en redes distintas por DHT público. **Pendiente de verificación física:** 3 laptops en la misma LAN con bootstrap local (el código y los lanzadores existen; los tests del bootstrap corren en `127.0.0.1`). No afirmamos "completamente offline".
- **Tres OCR simultáneos** en una misma GPU integrada saturan el worker de QVAC; en una máquina la demo los serializa. En el despliegue real cada participante tiene su propia máquina.
- **Sin reintegración de peers:** si un nodo cae a mitad de ronda, los demás lo detectan y la ronda se reinicia cuando vuelve; no hay reanudación parcial.
- El historial es por máquina; no se sincroniza a ningún sitio (por diseño).

## 17. Hackathon: criterios y cumplimiento

| Criterio | Dónde verlo |
|---|---|
| **Uso de QVAC** | `src/extraction/invoice-pipeline.mjs` (SDK 0.19.0 in-process, dos modelos del registro, `json_schema`); evidencia en cada ejecución (`PARIDAD_EXTRACCION`) y en `npm run test:demo` |
| **Inferencia local, sin nube** | no existe código que llame a una API de IA externa; respaldo GPU → **CPU local**; la UI declara `Cloud AI: NO USADA` como hecho estructural |
| **P2P / descentralización** | Hyperswarm entre nodos, sin servidor de Paridad; DHT público o bootstrap local; auditoría de cable en tests |
| **Componentes preexistentes** | §11, con versión y licencia |
| **Funciona donde la nube no llega** | red local con bootstrap propio, sin servicios externos (§8; alcance verificado en §16) |
| **Technical** | protocolo de secret sharing testeado; capa de red resiliente (mensajes corruptos, peers caídos, echo-loop de `products` corregido y documentado); pipeline determinista con barrido de OCR medido |
| **Innovation** | no encontramos una implementación equivalente que combine lectura local de facturas con agregación P2P privada por producto; no afirmamos que no exista |
| **Impact** | MiPymes con registros en papel y sin apetito por plataformas centralizadas; el modelo no exige confiar en Paridad |
| **Design** | una pantalla, tres pasos, una acción; la privacidad se expresa como diseño, no como promesa |
| **Completion** | `npm test` en verde; `npm run demo` reproducible de factura a referencia; limitaciones declaradas en §16 |

Licencia del código de Paridad: ISC (`package.json`).
