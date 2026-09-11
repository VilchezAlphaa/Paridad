# La demo de Paridad

`npm run demo` es la **demo de producto**: el flujo real de principio a fin,
sin datos precargados.

```text
factura (imagen)
   ↓  QVAC / OCR local            en el proceso de cada nodo
producto + precio unitario
   ↓  secret sharing               el precio se parte en fragmentos
   ↓  Hyperswarm P2P               solo cruzan fragmentos y nombres
agregación privada
   ↓
referencia del grupo
```

## Cómo lanzarla

```powershell
npm run demo
```

Eso es todo. El script:

1. levanta un DHT local (3 nodos `hyperdht`) para que los participantes se
   encuentren sin usar el DHT público;
2. arranca el nodo **A**, que carga QVAC y extrae `factura-demo-a.png`;
3. cuando A termina y **libera los modelos**, arranca **B** con su factura;
4. después **C**;
5. con los tres datos locales listos, la agregación P2P corre sola.

Luego abre las tres interfaces:

| Nodo | URL |
|---|---|
| A | http://localhost:4700 |
| B | http://localhost:4701 |
| C | http://localhost:4702 |

`Ctrl+C` en la terminal cierra los tres nodos y el DHT local.

### Variante conducida a mano

```powershell
npm run demo:manual
```

Los nodos arrancan pero **no procesan nada** hasta que pulsas
«Procesar facturas» en su UI. Sirve para grabar el vídeo mostrando el
disparo. **Pulsa de uno en uno y espera a que el anterior termine**: tres OCR
simultáneos tumban el worker de QVAC en esta máquina.

### Demo de red (sin OCR)

```powershell
npm run demo:items
```

3 nodos y 5 productos con precios dados por CLI. **No usa QVAC.** Sirve para
ejercitar varias rondas P2P en paralelo sin depender de la GPU. No es la demo
de producto.

## Por qué las facturas se procesan una detrás de otra

Tres contextos OCR de QVAC en Vulkan a la vez tumban el worker entero
(`Bare worker exited mid-request (code=3221226505)`, medido en esta máquina;
ver `docs/pipeline-extraccion.md`).

La demo lo evita sin límites artificiales: cada nodo **libera los modelos en
cuanto acaba su cola de facturas**, y `demo-local.mjs` no arranca el siguiente
nodo hasta ver la línea `PARIDAD_EXTRACCION_LISTA` del anterior. Así nunca hay
dos OCR compitiendo por la GPU.

En el despliegue real cada participante está en su propia laptop y esto no
aplica: la serialización es una necesidad de ejecutar tres nodos en una sola
máquina.

## Qué es real y qué es presentación

**Real, medible:**

- la extracción: OCR + estructuración con QVAC en el proceso de cada nodo,
  sobre las imágenes de `demo-data/facturas/`;
- el precio: sale del OCR, no está escrito en ningún sitio del código de la
  demo;
- la red: Hyperswarm de verdad entre tres procesos, con DHT local;
- el secret sharing y la agregación;
- los estados que pinta la UI (vienen por SSE del nodo local).

**Presentación:**

- el triángulo A–B–C de la UI es un dibujo. Las dos aristas que salen de *tu*
  nodo sí reflejan conexiones reales; la arista entre los otros dos se pinta
  siempre tenue y punteada **porque un participante no puede saber si los
  otros dos están conectados entre sí**;
- el DHT local y el arranque escalonado son andamiaje de la demo, no del
  producto.

## Estados de la interfaz

Los indicadores de la cabecera reflejan el estado real del nodo:

| Indicador | Qué significa |
|---|---|
| `P2P` | CONECTADO cuando el nodo identificó a todos los participantes |
| `Peers` | identificados / esperados |
| `IA local` | EN ESPERA → CARGANDO… → PROCESANDO… → LISTA ✓ |
| `Cloud AI` | NO USADA. Es un hecho estructural: no hay ninguna ruta hacia inferencia externa |
| `Shares enviados` | fragmentos que este nodo puso en la red |

`IA local` ya no dice OFFLINE mientras la IA está cargando o procesando, que
era justo lo contrario de lo que ocurría. Y el indicador de `Internet` se
sustituyó por `Cloud AI`: el estado de la conexión a internet es otra cosa y
se leía como si Paridad estuviera usando la nube. Sigue disponible en Ajustes.

El panel «El recorrido de tu factura» muestra los seis pasos con su estado
real: hecho, en curso o pendiente. Ninguno se adelanta.

## Auditoría: qué sale por la red

Con `PARIDAD_WIRE_AUDIT=1` cada nodo imprime **todos** los mensajes que pone
en la red, tal cual se serializan:

```powershell
$env:PARIDAD_WIRE_AUDIT = "1"; npm run demo
```

Solo hay cuatro tipos: `hello`, `products`, `share` y `column-sum`. El precio
no aparece en ninguno; tampoco el texto OCR ni el nombre del proveedor. Es lo
que verifica `npm run test:demo`.

## Tests

```powershell
npm test        # privacidad + red + agregación (rápido, sin GPU)
npm run test:demo   # la demo de producto con QVAC real (~1,5 min)
```

`npm test` no incluye `test:demo` a propósito: ese necesita los modelos de
QVAC y la GPU, y no debe hacer fallar la batería normal en una máquina que no
los tenga.

## Limitaciones

- **Un solo producto.** Solo hay tres facturas de demo y las tres son del
  mismo producto (`Aceite Motor 20W50`), una por participante. La demo de
  producto compara ese producto. Los 5 productos siguen disponibles en
  `npm run demo:items`, pero ahí los precios son sintéticos.
- **Duración.** ~25–30 s de extracción (los tres nodos, en serie) más el
  descubrimiento P2P. La primera vez puede tardar mucho más si QVAC tiene que
  descargar los modelos.
- **Facturas sintéticas y limpias.** Son PNG generados, no fotos. No hay
  evidencia de que el pipeline funcione sobre facturas fotografiadas.
- **Requiere red local.** El DHT es local, pero los procesos necesitan
  conectividad IP. No es "completamente offline".
- **Sin autenticación de peers.** Ver `docs/flujo-end-to-end.md`.
- Si una corrida anterior dejó procesos `node` colgados, los puertos
  4700–4702 quedan ocupados y el nodo afectado muere con `EADDRINUSE`.
  Ciérralos antes de relanzar.
