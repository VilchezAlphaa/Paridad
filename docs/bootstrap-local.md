# Bootstrap local (descubrimiento sin DHT público)

## Qué problema resuelve

Hyperswarm descubre peers a través de un DHT cuyos nodos de arranque
(*bootstrap*) son públicos y viven en internet. Eso significaba que Paridad, pese
a no usar ningún servidor de inferencia ni agregador central, **necesitaba
internet para que los participantes se encontraran**.

El bootstrap local permite arrancar un DHT privado propio, de modo que los nodos
se descubran dentro de una red local.

## Lo que esto sí es y lo que no es

Con precisión, porque la diferencia importa:

| Afirmación | ¿Cierta? |
|---|---|
| Sin servicios de IA en la nube | ✅ siempre, desde el principio |
| Sin agregador central | ✅ siempre |
| Sin DHT público | ✅ **esto es lo que añade el bootstrap local** |
| Funciona en una red local (Wi-Fi/LAN) sin internet | ✅ con bootstrap local |
| Funciona sin ninguna conectividad de red | ❌ **no** |

Paridad necesita que las máquinas puedan hablarse por IP. Si no hay red, no hay
P2P. **No se debe decir que Paridad funciona "completamente offline".** La
afirmación defendible es:

> Paridad puede establecer comunicación P2P en una red local sin depender de un
> servidor de inferencia ni de un agregador central.

## Arquitectura

No se sustituye Hyperswarm ni se toca el protocolo. El único cambio es de dónde
sale el DHT que Hyperswarm usa por debajo:

```text
MODO NORMAL (por defecto)
  new Hyperswarm()
      └── DHT contra los bootstrap públicos de hyperdht

MODO BOOTSTRAP LOCAL (--bootstrap host:puerto)
  new Hyperswarm({ dht: new DHT({ bootstrap, ephemeral:false, firewalled:false }) })
      └── DHT privado que solo conoce el bootstrap indicado
```

Se construye el DHT a mano en lugar de pasar `bootstrap` a Hyperswarm porque un
DHT privado de 3–4 nodos necesita además `ephemeral: false` y
`firewalled: false`: en una red tan pequeña los nodos efímeros no sostienen los
anuncios del topic. Es el mismo patrón que usa el helper de testnet de hyperdht.

El proceso bootstrap (`paridad-bootstrap.mjs`) es `DHT.bootstrapper()`, es decir,
un nodo DHT normal en modo arranque. **No es un servidor permanente ni un
servicio de la aplicación.**

### Refresco del descubrimiento (necesario en DHT pequeño)

Al implementarlo apareció un problema que no se da en el DHT público y que vale
la pena documentar, porque no es evidente.

Con el bootstrap local, la malla se quedaba en **estrella**: A veía a B y a C,
pero B y C nunca se veían entre sí, así que la ronda no cerraba nunca.

La causa es que Hyperswarm solo vuelve a consultar el DHT cada
`REFRESH_INTERVAL` = **10 minutos**, más un jitter de hasta 2. En el DHT público
eso no importa porque los anuncios están ampliamente replicados y la primera
consulta ya encuentra a todos. En un DHT privado de 4 nodos, el que consulta
antes de que otro se haya anunciado no lo vuelve a ver hasta pasados 10 minutos.

La solución es refrescar el descubrimiento cada 3 s hasta que el nodo tenga
conexión con todos los participantes esperados, y entonces parar. Es un cambio
en la capa de **descubrimiento**: no modifica qué mensajes se envían, a quién,
ni la matemática de secret sharing. Con él la malla se completa en menos de 5 s.

## Qué sabe y qué no sabe el bootstrap

El bootstrap responde consultas del DHT: qué claves públicas anuncian un
determinado hash de 32 bytes y en qué dirección están.

**Conoce:**
- que ciertas claves públicas anuncian cierto topic;
- sus direcciones IP y puertos.

**No conoce, por construcción y no por convención:**
- ningún precio individual;
- ningún share ni suma parcial;
- el total ni el promedio del grupo;
- ninguna factura ni texto OCR;
- qué producto se está comparando;
- ni siquiera que exista un cálculo: para él son claves anunciando un hash.

La razón estructural es que el bootstrap **nunca se une al topic de Paridad y no
habla el protocolo de Paridad**. Los mensajes `hello` / `share` / `column-sum`
viajan por conexiones cifradas directas entre peers (Noise, vía Hyperswarm), en
las que el bootstrap no participa. No hay ninguna ruta por la que un share pueda
llegarle.

El bootstrap tampoco puede convertirse en agregador accidental: no implementa
`AggregationSession`, no recibe shares y no tiene manera de pedirlos.

## Si el bootstrap desaparece

El bootstrap solo interviene en el **descubrimiento inicial**. Una vez que dos
peers se han encontrado, su conexión es directa y no lo atraviesa. Si el proceso
bootstrap muere después del descubrimiento:

- las conexiones P2P ya establecidas siguen funcionando;
- la ronda de agregación en curso se completa con normalidad;
- **un participante nuevo ya no podría unirse** hasta que haya otra vez un
  bootstrap alcanzable.

Con un matiz importante que se descubrió probándolo: el bootstrap debe seguir
vivo hasta que la malla esté **completa**, no hasta que un nodo haya visto a los
demás. Son tres parejas (A–B, A–C, B–C) y cada una necesita el bootstrap para
descubrirse. Si se apaga cuando solo A ha encontrado a B y a C, B y C se quedan
sin ninguna vía para encontrarse entre sí y la ronda no cierra.

Esto está cubierto por el escenario 2 de `src/e2e/test-bootstrap-local.mjs`, que
mata el bootstrap con SIGKILL en cuanto los tres nodos se han visto y comprueba
que siguen conectados 15 s después y que la ronda da el resultado correcto.

## Cómo ejecutar la demo

### Una sola máquina (para probar)

Cuatro terminales de PowerShell:

```powershell
node paridad-bootstrap.mjs
```

```powershell
node paridad-node.mjs A demo-data/facturas/factura-demo-a.png --bootstrap 127.0.0.1:49738
```

```powershell
node paridad-node.mjs B demo-data/facturas/factura-demo-b.png --bootstrap 127.0.0.1:49738
```

```powershell
node paridad-node.mjs C demo-data/facturas/factura-demo-c.png --bootstrap 127.0.0.1:49738
```

Con tres nodos en la misma máquina conviene añadir `PARIDAD_OCR_BACKEND=cpu` o
arrancarlos escalonados: tres contextos OCR en Vulkan a la vez tumban el worker
de QVAC (ver `docs/pipeline-extraccion.md`).

### Varias laptops en la misma red

En la máquina que hará de bootstrap, mira su IP local y arráncalo con ella:

```powershell
node paridad-bootstrap.mjs --host 192.168.1.104
```

El script imprime las IPv4 disponibles si lo arrancas en `127.0.0.1`, para no
tener que buscarlas.

En cada laptop participante:

```powershell
node paridad-node.mjs B demo-data/facturas/factura-demo-b.png --bootstrap 192.168.1.104:49738
```

La máquina que corre el bootstrap puede además correr un nodo participante: son
procesos distintos y el puerto del bootstrap (49738) es distinto del que usan
los peers por defecto (49737).

### Direcciones y puertos

| Proceso | Puerto | Quién necesita conocerlo |
|---|---|---|
| `paridad-bootstrap.mjs` | 49738 (`--port`) | todos los nodos |
| `paridad-node.mjs` | 49737 por defecto, negociado | nadie: se descubren solos |

El único dato de configuración que hay que repartir a mano es `host:puerto` del
bootstrap.

## Aislamiento del DHT público

Cuando se pasa `--bootstrap`, hyperdht resuelve `opts.bootstrap || BOOTSTRAP_NODES`,
y una lista no vacía impide cualquier consulta a la red pública. Por tanto, si el
bootstrap local no responde, el nodo **no** se cae silenciosamente al DHT
público: simplemente no encuentra a nadie y la ronda queda incompleta.

Esto se verifica explícitamente en el escenario 3 del test, apuntando los nodos a
un puerto donde no hay nada: no aparece ninguna conexión.

## Pruebas

```powershell
node src/e2e/test-bootstrap-local.mjs
node src/e2e/test-bootstrap-local.mjs --sin-qvac
```

El modo DHT público sigue cubierto por `src/e2e/test-end-to-end.mjs`.

## Limitaciones reales

- **Hace falta red.** Wi-Fi o LAN. Sin conectividad IP no hay P2P.
- **Alguien tiene que arrancar el bootstrap y repartir su `host:puerto`.** No hay
  descubrimiento automático en la LAN (no se implementó mDNS/UDP broadcast: sería
  la siguiente mejora natural, pero no es necesaria para el MVP).
- **El bootstrap es un punto único durante el descubrimiento.** Si no está
  disponible al principio, nadie se encuentra. Tras el descubrimiento deja de
  ser necesario.
- **Sin autenticación de peers.** Igual que en modo DHT público: la identidad
  (`"A"`, `"B"`, `"C"`) se declara en el `hello` y solo se comprueba que sea un
  participante esperado y no duplicado.
- **Probado en una sola máquina (127.0.0.1).** El modo `--host <IP LAN>` con
  varias laptops físicas **no se ha verificado en esta sesión**; el código es el
  mismo camino, pero el salto a IP de LAN y cortafuegos de Windows no está
  comprobado. Hay que probarlo antes de la demo.
