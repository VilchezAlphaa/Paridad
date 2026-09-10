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

## Limitaciones del OCR (medidas, no estimadas)

El detector CRAFT de `OCR_LATIN` falla de forma reproducible en tres puntos
cuando la factura se renderiza a tamaño "normal" (1000 px de ancho, fuente 20):

| Fallo | Ejemplo | Estado |
|---|---|---|
| Glifos aislados de un carácter no se detectan | la cantidad `4` desaparecía por completo | mitigado |
| `W` en códigos alfanuméricos se lee `h` | `20W50` → `20h50` (confianza 0.36) | mitigado |
| El punto decimal se detecta como bloque aparte | `47.00` → `47` + `00` | mitigado |

Mitigaciones aplicadas:

1. **Render a escala 2.1** (2100 px de ancho). Es lo que más impacto tuvo: a esa
   escala los tres fallos desaparecen. Subir `magRatio` en el OCR **no**
   funcionaba — triplicaba la latencia (23 s → 108 s) e introducía errores
   nuevos (`ESQUINA` → `ESQUIMA`).
2. **`magRatio: 1.2`.** Con 1.5 la cantidad `6` de la factura B se leía `0`; con
   1.0 se perdían algunos importes de total. 1.2 lee bien cantidad y precio
   unitario en las tres facturas.
3. **La cantidad se escribe `4 UND`** en las facturas de demo, no `4` suelto.
   Además de ser más robusto para el OCR, es como aparece en facturas reales.
4. **`repairOcrText()`** corrige `20h50`/`20w50` → `20W50` y `47 . 00` → `47.00`.
   Es una lista corta y explícita de confusiones medidas, no un corrector
   general.

### Limitaciones que siguen abiertas

- **Latencia.** ~57–62 s de OCR por factura en la máquina de desarrollo (Ryzen 5
  5500U, gráficos integrados). La inferencia del LLM en cambio es rápida
  (1,5–4,7 s). El cuello de botella es el OCR sobre imágenes de 2100 px.
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

Regenerar las facturas de demo (requiere Windows/.NET; los PNG ya están
versionados, así que normalmente no hace falta):

```bash
powershell -ExecutionPolicy Bypass -File tools/generar-facturas-demo.ps1
```

## Datos de demo

`demo-data/facturas/` contiene tres facturas **sintéticas**. Los negocios, RUC,
clientes y proveedores son inventados. Los precios unitarios (47.00 / 31.00 /
52.00) coinciden a propósito con los `DEMO_PRICES` de `p2p-privacy-test.mjs`
(4700 / 3100 / 5200 centavos) para poder encadenar los dos spikes más adelante.

La integración con P2P **no** está hecha todavía: este módulo no toca la red.
