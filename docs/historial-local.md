# Historial local de compras (fase 1)

```text
FACTURA → EXTRACCIÓN LOCAL → HISTORIAL LOCAL → COMPARACIÓN CUANDO HAYA DATOS
```

Una factura entra, QVAC la lee en el dispositivo, y **todos** sus productos
quedan registrados y visibles para el usuario. Cada producto puede tener o no
una comparación con el grupo; si no la tiene, se dice.

## Facturas con varios productos

El pipeline tenía una ruta de **un** producto por factura
(`extractInvoice`, schema de un objeto). Se añadió una ruta multi-línea,
`extractInvoiceItems`, con el mismo objeto de línea envuelto en un array
(`LLM_ITEMS_SCHEMA`, `minItems: 1`). La ruta de un producto se conserva tal
cual.

Medido con QVAC real:

| Factura | Líneas | Resultado |
|---|---|---|
| `factura-demo-multi.png` | 5 | 5/5, cantidades y precios exactos (4700, 680, 2850, 7800, 1640) |
| `factura-demo-a/b/c.png` | 1 | 1/1 cada una, mismos valores que la ruta de un producto (4700/3100/5200) |

La ruta multi es un superconjunto estricto de la validada: el nodo usa siempre
esta, y los valores de la demo no cambian.

La factura de 5 líneas se genera con `tools/generar-factura-multi.ps1`. Su
layout es deliberadamente "OCR-friendly": cada precio va pegado a la etiqueta
`P.UNIT`, sin columnas anchas (con columnas separadas por mucho espacio el
detector partía `47.00` en `47` y `00`).

## Cómo se guarda el historial

`src/extraction/historial.mjs`. Un JSON por nodo:

```text
data/nodo-<X>/historial.json          uso real
data/demo/nodo-<X>/historial.json     npm run demo
data/nodo-<X>/facturas/               facturas añadidas desde la UI
```

`data/` está en `.gitignore`: son datos del dispositivo del usuario.

Cada registro conserva:

```json
{
  "id": "b42821a49460a8be-2",
  "facturaId": "b42821a49460a8be",
  "archivo": "factura-demo-multi.png",
  "procesadaEn": "2026-09-11T03:46:30.405Z",
  "product": "FILTRO DE ACEITE",
  "productCanonical": "filtro de aceite",
  "quantity": 12,
  "unitPriceCents": 680,
  "comparacion": { "estado": "PENDIENTE" }
}
```

Decisiones:

- **JSON plano, sin base de datos.** Son decenas de registros. Escritura
  atómica (temporal + `rename`) para no dejar el archivo a medias.
- **La factura se identifica por el hash de su contenido**, no por el nombre.
  Reprocesar la misma imagen reemplaza *sus* registros en vez de duplicarlos.
  Por eso reiniciar el nodo (que vuelve a procesar sus `--factura`) o repetir
  `npm run demo` no engorda el historial.
- **Un producto nunca sobreescribe a otro.** Los registros solo se reemplazan
  al reprocesar la misma factura.
- **Sobrevive al reinicio.** Al arrancar, el nodo carga el historial y sus
  productos entran en ronda sin volver a pasar por QVAC.
- Un archivo corrupto no impide arrancar: se aparta con sufijo `.corrupto-*`
  y se empieza de cero, sin perder nada.

## Qué va a la ronda P2P

A la ronda entra **un** ítem por producto canónico: el último precio conocido.
Es la misma ronda de siempre; el historial no la cambia. Dos modos que no se
mezclan:

- con `--item` (demo:items, tests de red): exactamente lo que dio la CLI;
- sin `--item` (modo producto): lo derivado del historial.

Si se mezclaran, un historial que quedara en `data/` de una sesión anterior se
colaría en los tests de red.

## Capa de comparación (preparada para la fase 2)

`estadoComparacion(productCanonical)` en `nodo-paridad.mjs` es el **único**
punto donde el historial se cruza con el resultado de agregación:

| Situación | Estado | Qué ve el usuario |
|---|---|---|
| Ronda cerrada con ≥ 3 participantes | `DISPONIBLE` | referencia del grupo y posición % |
| Ronda en curso | `PENDIENTE` | "Comparación pendiente" |
| Algún participante no tiene el producto | `NO_DISPONIBLE` | "Sin comparación disponible" |

Regla de privacidad: `MIN_PARTICIPANTES_COMPARACION = 3`. Sin tres
participantes válidos para un producto no se expone referencia alguna.

Hoy lee el resultado por producto que ya calcula `aggregation-runner`. Cuando
exista la comparación por producto con umbral dinámico, se conecta aquí; ni el
historial ni la UI tienen que cambiar.

Verificado en `npm run test:multi`: con B y C participando solo con el aceite,
las dos líneas de aceite de A salen `DISPONIBLE` ($43.33, +8.5 %, 3
participantes) y los otros cuatro productos `NO_DISPONIBLE` **sin referencia**.

## Interfaz

**Pantalla inicial** (`index.html`): qué es Paridad, la acción principal
«Agregar factura», y un resumen con facturas procesadas, productos registrados
y participantes conectados. Sin cuentas ni contraseñas: la identidad es el
nombre del nodo.

«Agregar factura» abre el selector de archivos. La imagen va al proceso
**local** (`POST /api/factura`, localhost), se guarda en
`data/nodo-<X>/facturas/` y entra en la cola. Nunca sale del dispositivo.

**Factura procesada**: aparece al terminar, con «N productos registrados» y la
lista de esa factura con los precios propios.

**Mis compras**: todo el historial, con precio propio y estado de comparación
por producto. Los precios de otros negocios nunca se muestran.

Los indicadores de cabecera siguen siendo reales: `IA local` pasa por
EN ESPERA → CARGANDO… → PROCESANDO… → LISTA ✓ (nunca OFFLINE mientras
trabaja). Se retiró el sondeo del servidor http de QVAC que pintaba ACTIVE si
`qvac serve` estaba corriendo: Paridad no lo usa y era engañoso.

## Procesamiento

El nodo es un worker de cola **secuencial**: carga los modelos, procesa lo que
haya, y sin `--carpeta` los libera al terminar (`PARIDAD_EXTRACCION_LISTA`).
Nunca hay dos OCR a la vez en un proceso, y la GPU queda libre entre lotes.
Una factura añadida desde la UI más tarde vuelve a cargar los modelos sola.

`npm run demo` sigue arrancando A → B → C en serie. A procesa ahora dos
facturas (la de una línea y la de cinco).

## Privacidad

- El historial no importa nada de red (verificado en el test).
- Por la red solo viajan `hello`, `products` (nombres), `share` y
  `column-sum`. `npm run test:multi` audita el cable con
  `PARIDAD_WIRE_AUDIT=1`: ningún precio, ningún campo del historial
  (`unitPrice`, `facturaId`, …), ningún texto OCR.
- La subida de facturas es navegador → proceso local en la misma máquina.

## Tests

```powershell
npm test              # incluye el historial (puro, sin QVAC)
npm run test:multi    # factura de 5 productos con QVAC real, reinicio, auditoría
npm run test:demo     # demo de producto con QVAC real
```

## Limitaciones

- **Una sola factura de varios productos**, sintética y limpia. No hay
  evidencia sobre fotos reales.
- Los nombres canónicos salen de la normalización existente: `PASTILLAS DE
  FRENO DELANT` → `pastillas de freno delant`. Variantes de redacción
  distintas no se agrupan todavía.
- La comparación por producto usa la ronda actual (fija a A/B/C). No hay
  rondas por producto con participantes variables: eso es la fase 2.
- El historial es por nodo y por máquina. No se sincroniza a ningún sitio.
