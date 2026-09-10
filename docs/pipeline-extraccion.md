# Spike: extracción local de facturas (QVAC)

Estado del pipeline `factura → OCR → texto → completion → JSON estructurado`.
Todo corre en el dispositivo con QVAC 0.19.0. No hay ninguna llamada a APIs de
inferencia en la nube, ni fallback a ellas.

## Qué hace

```text
imagen PNG de factura
    ↓  QVAC ocr()          modelo OCR_LATIN (EasyOCR GGUF, ~15 MB)
bloques OCR con bbox
    ↓  reconstructLines()  reagrupa palabras en líneas por coordenada
    ↓  repairOcrText()     corrige confusiones OCR conocidas
texto de la factura
    ↓  QVAC completion()   modelo QWEN3_600M_INST_Q4 (~382 MB)
    ↓  responseFormat: json_schema (gramática GBNF)
{ product, quantity, unit_price }
    ↓  priceStringToCents()
{ product, quantity, unit_price_cents, product_canonical }
```

La imagen, el texto OCR y el nombre del proveedor se quedan en `_local` y no
forman parte del schema público: son el lado privado de la frontera.

## Decisiones de diseño

**El precio se le pide al modelo como texto, no como centavos.** El schema del
LLM pide `unit_price: "47.00"` con `pattern` y la conversión a 4700 centavos la
hace JavaScript. Un modelo de 600M multiplicando por 100 es una fuente de error
innecesaria en el dato más importante del proyecto.

**`required` y `additionalProperties` van explícitos en el schema.** La doc del
SDK 0.19.0 advierte que `json_schema.strict` se acepta por compatibilidad con
OpenAI pero NO aplica el auto-tightening: el schema se reenvía al addon tal
cual.

**Decodificación greedy (`temp: 0`, `top_k: 1`, `seed: 42`).** Con el muestreo
por defecto el pipeline no era reproducible: sobre la misma factura el modelo
devolvía unas veces `ACEITE MOTOR 20W50` y otras `ACEITE MOTOR 20W50 UND`, lo
que cambiaba el producto canónico y habría roto el agrupamiento del benchmark.

**El OCR corre en Vulkan con respaldo automático a CPU.** La GPU integrada baja
el OCR de ~14,4 s a ~2,8 s por factura, pero el detector CRAFT revienta con
`ggml_gallocr_alloc_graph failed` cuando el canvas de detección es grande, y
ese fallo **no** cae solo a CPU: aborta la operación. Por eso
`ocrInvoiceConRespaldo()` recarga el modelo en CPU y reintenta una vez. El
respaldo es a **CPU local**; no existe ningún respaldo a servicios externos.
Se puede forzar CPU con `PARIDAD_OCR_BACKEND=cpu`.

## Barrido de configuraciones del OCR

`tools/bench-ocr.mjs` reproduce las medidas que justifican la configuración.
Resultados sobre las tres facturas (Ryzen 5 5500U, Radeon integrada):

| Config | Escala | canvasSize | Backend | s/factura | Lee las 3 |
|---|---|---|---|---|---|
| anterior | 2.1 | — (2560) | cpu | **61,6** | ✅ |
| + `recognizerBatchSize` 32 | 2.1 | — | cpu | 57,2 | ✅ |
| + sin rotaciones | 2.1 | — | cpu | 53,8 | ✅ |
| + umbral 0,4 | 2.1 | — | cpu | 52,2 | ✅ |
| ídem | 2.1 | 2100 | cpu | 34,8 | ❌ `20150` (las 3) |
| ídem | 2.1 | 1920 | cpu | 29,4 | ✅ |
| ídem | 2.1 | 1600 | cpu | 20,6 | ❌ `20150` |
| ídem | 2.1 | 1280 | cpu | 14,5 | ❌ `20150` |
| ídem | 1.6 | 1600 | cpu | 20,8 | ❌ `47 00` |
| ídem | 1.6 | 1280 | cpu | 14,3 | ❌ `47 00` |
| ídem | 1.4 | 1400 | cpu | 16,7 | ✅ |
| **adoptada** | **1.4** | **1280** | **cpu** | **14,4** | ✅ |
| ídem | 1.4 | 1152 | cpu | 12,0 | ✅ |
| **adoptada** | **1.4** | **1280** | **vulkan** | **2,8** | ✅ |
| ídem | 1.4 | 1152 | vulkan | 2,4 | ✅ |
| ídem | 2.1 / 1.6 | 1920, 2560 | vulkan | 💥 | `alloc_graph failed` |

Dos lecturas importantes de esta tabla:

1. **La velocidad no se cambia por precisión de forma monótona.** A escala 2.1,
   canvas 1920 acierta pero 2100, 1600 y 1280 fallan. Ese punto es una isla, no
   un punto de una curva, y adoptarlo sería frágil.
2. **La escala 1.4 sí es una región estable**: canvas 1152, 1280 y 1400 leen
   bien las tres facturas. Se adoptó 1280 por tener vecinos verificados a ambos
   lados, no por ser el más rápido.

Los fallos se concentran en dos sitios: la `W` de `20W50` (que se lee `20150`,
`20/50` o `20W/50`) y el punto decimal de `47.00` (que se pierde: `47 00`).
Ninguno se "arregló" ampliando `repairOcrText()`: inferir una `W` que el OCR no
vio sería fabricar datos.

## Limitaciones del OCR (medidas, no estimadas)

El detector CRAFT de `OCR_LATIN` falla de forma reproducible en tres puntos
cuando la factura se renderiza a tamaño "normal" (1000 px de ancho, fuente 20):

| Fallo | Ejemplo | Estado |
|---|---|---|
| Glifos aislados de un carácter no se detectan | la cantidad `4` desaparecía por completo | mitigado |
| `W` en códigos alfanuméricos se lee `h` | `20W50` → `20h50` (confianza 0.36) | mitigado |
| El punto decimal se detecta como bloque aparte | `47.00` → `47` + `00` | mitigado |

Mitigaciones aplicadas:

1. **Render a escala 1.4** (1400 px de ancho), con `canvasSize: 1280`. Subir
   `magRatio` **no** funcionaba — triplicaba la latencia (23 s → 108 s) e
   introducía errores nuevos (`ESQUINA` → `ESQUIMA`). Renderizar más grande sí
   arreglaba los tres fallos, y durante un tiempo el proyecto usó escala 2.1;
   el barrido posterior mostró que 1.4 los arregla igual y es 4× más rápida.
2. **`magRatio: 1.2`.** Con 1.5 la cantidad `6` de la factura B se leía `0`; con
   1.0 `20W50` se leía `20150`.
3. **La cantidad se escribe `4 UND`** en las facturas de demo, no `4` suelto.
   Además de ser más robusto para el OCR, es como aparece en facturas reales.
4. **`repairOcrText()`** corrige `20h50`/`20w50` → `20W50` y `47 . 00` → `47.00`.
   Es una lista corta y explícita de confusiones medidas, no un corrector
   general.

### Limitaciones que siguen abiertas

- **Latencia.** ~2,8 s de OCR por factura en Vulkan y ~14,4 s en CPU (Ryzen 5
  5500U, Radeon integrada). El LLM añade 1,1–1,5 s. Sigue siendo el OCR el
  componente más caro, y en máquinas sin GPU utilizable la ruta es la de 14,4 s.
- **La aceleración por GPU depende del hardware.** En esta iGPU (~1 GB) el OCR
  solo cabe con `canvasSize` ≤ 1280; con canvas mayores aborta. En otra máquina
  el margen puede ser distinto, por eso existe el respaldo a CPU.
- **No caben tres procesos haciendo OCR en GPU a la vez.** Con tres nodos
  Paridad extrayendo simultáneamente en la misma máquina, el worker de QVAC
  muere entero (`Bare worker exited mid-request (code=3221226505)`, que es
  `STATUS_STACK_BUFFER_OVERRUN`). Dos procesos concurrentes sí funcionan.
  Consecuencias prácticas:
    - el respaldo recarga **los dos** modelos en CPU, no solo el OCR: cuando el
      worker cae se lleva también el modelo de lenguaje;
    - el test end-to-end arranca los nodos escalonados 15 s para que las fases
      de OCR no se solapen (la fase P2P sí queda concurrente);
    - en la demo real cada participante debería estar en una máquina distinta,
      o bien ejecutarse con `PARIDAD_OCR_BACKEND=cpu` si los tres nodos van a
      compartir una sola máquina y GPU.
- **El margen de precisión es estrecho.** Varias configuraciones vecinas leen
  mal `20W50` o pierden el punto decimal de `47.00`. La configuración adoptada
  está en una región verificada, pero la región no es ancha.
- **Solo se prueba con facturas sintéticas y limpias.** Son PNG generados,
  monoespaciados, negro sobre blanco, sin ruido, sin rotación, sin sellos ni
  arrugas. No hay evidencia de que el pipeline funcione sobre fotos de facturas
  reales, y no se debe afirmar que funcione.
- **Una sola línea de producto por factura.** Las facturas de demo tienen un
  único ítem. El pipeline no resuelve facturas con varias líneas.
- **Las reparaciones de OCR son específicas de estos casos.** `repairOcrText()`
  cubre las confusiones observadas; otras confusiones (`5`↔`S`, `1`↔`l`) no
  están cubiertas.
- **Sin verificación aritmética.** No se comprueba que
  `cantidad × precio_unitario = total`, que sería una validación cruzada barata
  para detectar errores de OCR en el precio.

## Cómo ejecutarlo

Tests puros (rápidos, sin descargar modelos):

```bash
node src/extraction/test-invoice-pipeline.mjs --solo-puros
```

Pipeline completo con inferencia QVAC local (lento; la primera vez descarga
~400 MB de modelos):

```bash
node src/extraction/test-invoice-pipeline.mjs
```

Forzar CPU (útil si la GPU está ocupada o da problemas):

```bash
PARIDAD_OCR_BACKEND=cpu node src/extraction/test-invoice-pipeline.mjs
```

Regenerar las facturas de demo (requiere Windows/.NET; los PNG ya están
versionados, así que normalmente no hace falta):

```bash
powershell -ExecutionPolicy Bypass -File tools/generar-facturas-demo.ps1
```

Reproducir el barrido de configuraciones de OCR:

```bash
node tools/bench-ocr.mjs fase1
```

## Datos de demo

`demo-data/facturas/` contiene tres facturas **sintéticas**. Los negocios, RUC,
clientes y proveedores son inventados. Los precios unitarios (47.00 / 31.00 /
52.00) coinciden a propósito con los `DEMO_PRICES` de `p2p-privacy-test.mjs`
(4700 / 3100 / 5200 centavos) para poder encadenar los dos spikes más adelante.

La integración con P2P **no** está hecha todavía: este módulo no toca la red.
