# Interfaz de Paridad

Una sola pantalla, cuatro estados, una acción. Pensada para entenderse en
menos de cinco segundos y para grabarse.

```text
01 TU FACTURA  →  02 IA LOCAL  →  03 RESULTADOS
```

## Identidad

| Uso | Color |
|---|---|
| Fondo | `#F9F8F6` |
| Superficies secundarias | `#EFE9E3` |
| Bordes | `#D9CFC7` |
| Acento / CTA | `#C9B59C` |

Texto en derivados cálidos (`#2B2622`, `#6F655C`, `#9A8F85`); dos tonos de
estado muy discretos: verde apagado para "pagas por debajo" / grupo conectado,
terracota para "pagas por encima". Sin fondo fotográfico, sin gradientes, sin
sombras. Tipografía: Fraunces para títulos, IBM Plex Sans para el resto.

### Logo

El original (`src/ui/brand/paridad-logo.original.svg`, 2,9 MB) es un SVG
envoltorio de dos PNG en base64: no es vectorial y no se puede cargar en cada
página. Se derivaron dos versiones web **renderizando el SVG tal cual lo pinta
el navegador** y recortando solo el margen transparente, sin tocar el dibujo ni
sus proporciones (ratio 1,028):

- `brand/paridad-logo-512.png` (190 KB) — pantalla de inicio;
- `brand/paridad-logo-96.png` (14 KB) — cabecera y favicon.

## Vistas

`src/ui/app.js` es una máquina de estados de **presentación**. Elige la vista a
partir del estado real que publica `nodo-paridad.mjs` por SSE; no extrae, no
comparte ni agrega nada.

| Vista | Cuándo | Qué muestra |
|---|---|---|
| `idle` | sin facturas | logo, «Compara tus precios de compra sin compartirlos.», stepper con 01 activo, **Cargar factura**, «Tu factura se procesa en este dispositivo.» |
| `processing` | IA local cargando o leyendo | «Analizando tu factura» y la lista ✓ Factura cargada · ● IA local procesando · ○ Productos identificados · ○ Datos protegidos. Al terminar, «N productos encontrados» un instante y pasa a resultados |
| `results` | hay facturas | «Tu compra · N productos registrados» y la tabla `Producto · Tu precio · Comparación` de la última factura |
| `history` | el usuario pulsa «Facturas agregadas» | cada factura con «N productos · Procesada localmente», desplegable con sus productos y comparación |

Procesar una factura siempre se ve, aunque el usuario estuviera en el
historial: es el momento que la demo tiene que enseñar.

### Comparación por producto

| Estado real | Se muestra |
|---|---|
| `DISPONIBLE` | `$43.33  +8.5%` y «Pagas por encima / por debajo de la referencia del grupo» |
| `NO_DISPONIBLE` | «Sin comparación disponible» — «Aún no hay suficientes negocios con este producto.» |
| `PENDIENTE` | «Comparación pendiente» — «Esperando al grupo.» |

Nunca se inventa una referencia y nunca aparece un precio de otro negocio.

## Navegación

Solo dos entradas: **+ Agregar factura** y **Facturas agregadas**. Un único
CTA: si el nodo arrancó con facturas pendientes (`--manual`) el mismo botón
dice «Procesar factura» y las procesas; si no, abre el diálogo de archivos del
sistema. La misma zona de inicio acepta **arrastrar y soltar** la imagen (PNG o
JPG): mientras hay un archivo encima, el borde se tiñe y la nota bajo el botón
cambia a «Suelta la imagen para cargarla». Fuera de esa zona soltar no hace
nada (la página no navega a la imagen). La imagen va al proceso local por
`localhost` y no sale del dispositivo.

Junto al logo, una etiqueta «Negocio A/B/C» (y el título de la pestaña) dice en
qué nodo estás: sale de `nodeName`, que el nodo publica con su estado.

El estado del grupo es una línea discreta bajo la cabecera:
«● Grupo conectado · 3 participantes» o «● Grupo · 2 de 3 participantes».
Peers, shares, puertos y DHT no aparecen; siguen en los logs del nodo.

Las páginas `productos.html`, `proveedores.html`, `ajustes.html` y
`calculadora.html` **se conservan** con su hoja de estilos anterior
(`styles.css`) pero quedan fuera de la navegación del MVP. La pantalla
principal usa `paridad.css`.

## Preparado para la siguiente iteración

- La comparación se pinta desde `registro.comparacion`, que calcula
  `estadoComparacion()` en `nodo-paridad.mjs`. Cuando exista la comparación por
  producto con participantes variables, la UI no cambia.
- El caso del vídeo (A y B «pendiente» hasta que C completa el grupo, y
  entonces aparece la referencia en los tres) ya se representa: `PENDIENTE` →
  `DISPONIBLE` llega por SSE y la tabla se repinta sola.

## Motion y microinteracciones

Sin librerías nuevas ni cambios en extracción, privacidad o red. CSS usa
entradas de 240–320 ms (opacity y desplazamiento de 6 px), feedback de botones
de 140 ms y una entrada de 400 ms cuando el grupo pasa realmente a READY.
Los productos/facturas entran con 60 ms entre elementos; más de ocho elimina
el escalonado. Una comparación disponible presenta referencia, porcentaje y
explicación con separaciones de 60 ms, sin interpolar precios.

Las filas se conservan por id: un evento SSE idéntico no reconstruye las
tablas ni reinicia sus animaciones. Solo se reemplaza la comparación que
cambia. El historial conserva sus facturas abiertas y el foco. Los
desplegables usan apertura nativa con expansión suave donde el navegador
admite `interpolate-size`; en otros navegadores permanece la apertura nativa.
No se usa View Transitions porque las entradas CSS bastan sin diferir el render.

El cierre «N productos encontrados» dura 400 ms y solo aparece tras una
extracción terminada, nunca por un error. No retrasa QVAC ni P2P. Con
`prefers-reduced-motion: reduce` se eliminan animaciones, stagger y esa pausa.
No hay animaciones infinitas ni contadores simulados.

Para verificar: `npm test`, después `npm run demo`; abrir
`http://localhost:4700`. Revisar procesamiento, cinco productos de la factura
multi, comparación del aceite y navegación a Facturas agregadas y vuelta.
Para observar el inicio vacío usar `npm run demo:manual` (los nodos arrancan
sin facturas y con historial limpio) y cargar A, B y C de uno en uno, por
diálogo o arrastrando. Comprobar también teclado, movimiento reducido y
pantalla estrecha.
