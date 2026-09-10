# Flujo end-to-end de Paridad

Integra el pipeline de factura con el protocolo P2P de agregación privada.

```text
FACTURA (imagen local)
    ↓  QVAC OCR local            src/extraction/invoice-pipeline.mjs
    ↓  extracción estructurada   (json_schema → GBNF)
    ↓  unit_price_cents
    ↓  secret sharing            src/privacy/secret-sharing.mjs
    ↓  Hyperswarm P2P            src/p2p/aggregation-node.mjs
    ↓  agregación privada        src/privacy/aggregation-protocol.mjs
    ↓  promedio del grupo
```

## Módulos y responsabilidades

| Módulo | Responsabilidad | Sabe de red | Sabe de facturas |
|---|---|---|---|
| `secret-sharing.mjs` | `split` / `combine` mod p | no | no |
| `aggregation-protocol.mjs` | estado de la ronda, column-sums | no | no |
| `p2p/aggregation-node.mjs` | Hyperswarm, framing, handshake | sí | no |
| `extraction/invoice-pipeline.mjs` | QVAC OCR + extracción | no | sí |
| `paridad-node.mjs` | punto de entrada que los une | — | — |

La separación es deliberada: el protocolo criptográfico no conoce la red, y la
capa de red no conoce las facturas. Por eso se pudo integrar el pipeline sin
tocar `secret-sharing.mjs` ni `aggregation-protocol.mjs`.

## Ejecutar el flujo completo

Tres terminales, una por participante:

```bash
node paridad-node.mjs A demo-data/facturas/factura-demo-a.png
```

```bash
node paridad-node.mjs B demo-data/facturas/factura-demo-b.png
```

```bash
node paridad-node.mjs C demo-data/facturas/factura-demo-c.png
```

Cada nodo imprime su benchmark local:

```text
Total del grupo: 13000 centavos
Promedio grupo:  $43.33 (4333 centavos)
Tu posición:     +8.5% vs. el promedio
```

Opciones útiles:

- `--precio-cents <n>` — salta QVAC y usa un precio dado. Sirve para probar la
  capa P2P sin cargar modelos; no es el flujo real.
- `--esperado <n>` — falla si la extracción no da ese valor. Lo usa el test.
- `--timeout <ms>` — cierra la ronda como incompleta en vez de esperar siempre.
- `--topic <nombre>` — aísla una ronda de otras.

## Qué viaja por la red y qué no

El nodo audita todo lo que envía. Solo hay tres tipos de mensaje:

```json
{"type":"hello","node":"A"}
{"type":"share","from":"A","share":"39465233817785969690092644692178131461"}
{"type":"column-sum","from":"A","value":"<entero mod p>"}
```

`share` es un fragmento aleatorio mod p; `column-sum` mezcla un fragmento de
cada precio. Ninguno de los dos es el precio de nadie.

La comprobación es por **igualdad de valor**, no por subcadena: los shares son
enteros de ~39 dígitos y "4700" puede aparecer dentro por casualidad sin que eso
signifique fuga. Lo que debe ser imposible es que el precio viaje como valor.

Además, `send()` lleva una puerta de auditoría que lanza si un mensaje contiene
el valor privado. Si el protocolo se rompiera en el futuro, el nodo falla en vez
de filtrar en silencio.

El total del grupo tampoco viaja: cada nodo lo calcula por su cuenta a partir de
las sumas parciales.

## Test end-to-end

```bash
node src/e2e/test-end-to-end.mjs
```

Lanza procesos reales que se descubren por Hyperswarm. Tres escenarios:

1. **Flujo completo** — las tres facturas de demo, con QVAC, hasta el benchmark.
   Verifica extracción, total, promedio y la auditoría cruzada de todo el
   tráfico.
2. **Participante ausente** — solo A y B: la ronda se cierra como incompleta y
   ningún nodo publica un benchmark con datos parciales.
3. **Participante que se cae en caliente** — se mata C con SIGKILL después de
   que A lo haya visto; A y B deben sobrevivir y terminar limpio.

Para saltarse QVAC y probar solo la capa P2P:

```bash
node src/e2e/test-end-to-end.mjs --solo-p2p
```

## Limitaciones conocidas

- **Ronda de tamaño fijo.** `PARTICIPANTS` es `["A","B","C"]`. No hay
  descubrimiento dinámico de participantes ni rondas de tamaño variable.
- **Sin reintegración de un peer caído.** Si un participante se cae a mitad de
  la ronda, la ronda no se completa. El nodo lo detecta, lo dice y sigue en pie
  por si vuelve, pero no hay reanudación: hay que relanzar la ronda.
- **Sin autenticación de peers.** La identidad (`"A"`, `"B"`, `"C"`) se declara
  en el `hello` y solo se comprueba que sea uno de los participantes esperados
  y que no esté duplicada. Cualquiera que conozca el topic puede presentarse
  como un participante que aún no se ha conectado.
- **El descubrimiento por DHT necesita internet.** El objetivo de operar solo en
  red local (CLAUDE.md §14) NO está implementado todavía: Hyperswarm usa los
  bootstrap públicos. No se debe afirmar que funciona sin internet hasta
  haberlo verificado con un bootstrap local.
- **Tres OCR en GPU a la vez no caben** en la máquina de desarrollo; ver
  `docs/pipeline-extraccion.md`.
