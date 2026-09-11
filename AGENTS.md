# AGENTS.md — Guía de trabajo para Codex en Paridad

## 0. Propósito de este archivo

Este archivo es la guía principal para cualquier agente de código que trabaje sobre **Paridad**.

Antes de modificar código:

1. Lee este archivo completo.
2. Lee `CLAUDE.md` si existe.
3. Lee `README.md`.
4. Revisa `package.json`.
5. Revisa el historial reciente de Git.
6. Ejecuta `git status`.
7. Ejecuta `npm test`.

El repositorio es la fuente de verdad del estado actual. No supongas que decisiones antiguas de la conversación siguen vigentes si el código actual dice otra cosa.

---

# 1. Qué es Paridad

**Paridad** es una solución de inteligencia artificial local + P2P para que varios negocios puedan obtener referencias comparativas de sus precios de compra sin revelar directamente los precios individuales ni enviar sus facturas a un servidor central.

La idea central:

> Cada negocio procesa su propia información localmente. Luego los participantes colaboran mediante una red peer-to-peer para obtener una referencia conjunta sin centralizar las facturas ni los precios individuales.

Paridad no intenta ser una fuente universal de precios de mercado.

El escenario de adopción pensado es un **grupo de negocios que ya existe**, por ejemplo una asociación, cooperativa, grupo de talleres o red de comercios que ya comparten una relación previa.

---

# 2. Problema que resuelve

Un negocio puede saber cuánto pagó por un producto, pero no necesariamente sabe si está pagando más o menos que otros negocios similares.

Una solución tradicional podría centralizar las facturas en una plataforma para calcular una referencia.

Paridad propone otra arquitectura:

```text
Negocio A ─┐
Negocio B ─┼─ P2P ─→ referencia conjunta
Negocio C ─┘
```

Las facturas y los precios individuales permanecen en los dispositivos participantes.

La comparación se muestra solamente cuando existen suficientes participantes para preservar el modelo de privacidad.

---

# 3. Papel de QVAC

QVAC es importante porque permite procesar la información privada **en el dispositivo donde se genera**, en lugar de enviar la factura a una API de IA cloud.

Actualmente QVAC se usa para:

- OCR local de facturas;
- extracción estructurada;
- extracción de múltiples productos;
- canonicalización/normalización de productos;
- identificación de cantidad y precio.

Importante:

**QVAC no es la fuente de la privacidad criptográfica.**

La privacidad de la agregación proviene del protocolo de secret sharing y del intercambio P2P.

El papel de QVAC es:

> Entender la información privada localmente para convertirla en datos utilizables sin sacar la factura del dispositivo.

No describir a QVAC como si fuera responsable del secret sharing.

---

# 4. Arquitectura actual

Flujo conceptual:

```text
Factura
   ↓
QVAC / OCR local
   ↓
Productos estructurados
   ↓
Historial local
   ↓
Precio protegido
   ↓
Hyperswarm / P2P
   ↓
Secret sharing
   ↓
Agregación privada
   ↓
Referencia del grupo
   ↓
Comparación por producto
```

---

# 5. Componentes actuales

## QVAC

- QVAC CLI/SDK 0.19.0.
- Modelo de chat usado en el proyecto: `qwen3-600m-inst-q4`.
- GPU disponible en el entorno principal: AMD Radeon integrada con Vulkan.
- OCR optimizado para esta máquina.
- Se ha comprobado que tres OCR simultáneos pueden saturar/romper el worker de QVAC.
- La demo procesa las facturas secuencialmente para evitar ese problema.

## Extracción

Archivo principal:

```text
src/extraction/invoice-pipeline.mjs
```

Actualmente soporta extracción multi-producto.

Una factura de prueba de 5 líneas fue procesada correctamente con QVAC.

Los resultados demo principales siguen siendo:

```text
A = 4700
B = 3100
C = 5200

total = 13000
average = 4333.33

A = +8.5%
B = -28.5%
C = +20.0%
```

## Historial local

Archivo:

```text
src/extraction/historial.mjs
```

El historial se almacena localmente.

Estructura de referencia:

```text
data/nodo-A/historial.json
data/nodo-B/historial.json
data/nodo-C/historial.json
```

La carpeta `data/` está en `.gitignore`.

El historial:

- conserva múltiples productos;
- no sobrescribe productos distintos;
- identifica la factura por hash de contenido;
- evita duplicar una factura reprocesada;
- puede sobrevivir a reinicios;
- no necesita backend;
- no debe enviarse a cloud.

## Privacidad

Archivos:

```text
src/privacy/secret-sharing.mjs
src/privacy/aggregation-protocol.mjs
```

Secret sharing aditivo probado extensamente.

Caso principal:

```text
4700 + 3100 + 5200 = 13000
```

Un nodo no recibe todos los shares ajenos.

No enviar precios individuales por red.

## P2P

La comunicación utiliza:

- Hyperswarm;
- HyperDHT/bootstrap local donde corresponda;
- streams + NDJSON;
- descubrimiento P2P.

No reemplazar Hyperswarm sin una razón extremadamente fuerte.

## Network

Archivos sensibles:

```text
src/network/aggregation-runner.mjs
src/network/paridad-network.mjs
```

Hubo un bug crítico de amplificación:

```text
products recibido
→ re-broadcast
→ otros re-broadcast
→ bucle infinito
→ buffers crecían
→ OOM
```

Fue corregido haciendo que `_announceProducts()` sea idempotente.

Antes del arreglo:

- millones de mensajes `products`;
- buffers de escritura de cientos de MB;
- procesos morían por OOM.

Después:

- `products` acotados;
- memoria plana;
- demo estable;
- sin OOM.

**No reintroducir broadcast recursivo o echo loops.**

---

# 6. Regla crítica de privacidad

El sistema debe diferenciar claramente entre:

### Información local

- factura;
- OCR bruto;
- precio individual;
- historial completo;
- datos propios del negocio.

### Información que puede salir por la red

Solo la información estrictamente necesaria para:

- discovery;
- handshake;
- identificación del participante dentro del protocolo;
- intercambio de shares;
- agregación;
- estados de red.

No enviar:

- factura;
- texto OCR;
- precio individual;
- historial completo;
- total crudo por un servidor central.

---

# 7. Regla de mínimo de participantes

La comparación está pensada para **mínimo 3 participantes**.

Con dos participantes, el total permite a cada uno inferir directamente el valor del otro.

Por eso:

```text
2 participantes
→ no publicar una comparación privada

3 participantes
→ sí permitir la referencia del grupo
```

No afirmar "privacidad absoluta".

La formulación recomendada es:

> **Privacidad por diseño.**

---

# 8. Reglas de comparación por producto

Cada producto de una factura queda registrado localmente.

Para cada producto:

### Si hay suficientes participantes

Mostrar:

- referencia del grupo;
- posición del usuario;
- porcentaje más/menos.

### Si no hay suficientes participantes

Mostrar:

> **Sin comparación disponible**

El producto **NO desaparece** del historial.

No inventar promedios.

No mostrar un estado de error cuando simplemente no hay suficientes datos.

La comparación se hace por producto canonicalizado.

No implementar matching avanzado de productos sin necesidad.

---

# 9. Flujo de producto actual

La UX debe sentirse como una aplicación enfocada:

```text
01 TU FACTURA
→
02 IA LOCAL
→
03 RESULTADOS
```

La acción principal es:

> **Cargar factura**

Después:

```text
Factura
→ procesamiento local
→ productos registrados
→ comparación disponible o pendiente
```

El historial es secundario:

> **Facturas agregadas**

No convertir la interfaz en un dashboard saturado.

---

# 10. Estado actual de la UI

La UI se rediseñó hacia:

- minimalismo;
- mucho whitespace;
- navegación mínima;
- eliminación del fondo fotográfico;
- paleta cálida;
- flujo paso a paso.

Paleta principal:

```text
#F9F8F6  fondo/superficie base
#EFE9E3  superficies secundarias
#D9CFC7  bordes/divisiones
#C9B59C  acento/CTA
```

La navegación principal debe reducirse a:

```text
+ Agregar factura
Facturas agregadas
```

La pantalla inicial debe responder inmediatamente:

- qué es Paridad;
- qué hago primero;
- dónde está mi información;
- qué obtengo al final.

---

# 11. Logo

Existe un logo oficial entregado para Paridad.

Debe conservarse su identidad.

Existe una versión original pesada y derivados web ligeros.

No redibujar ni sustituir el logo por un icono genérico.

No deformarlo.

---

# 12. Demo actual

Comando principal:

```powershell
npm run demo
```

Actualmente la demo:

- levanta 3 nodos en una misma máquina;
- utiliza un DHT local de demo;
- procesa facturas reales de prueba con QVAC;
- procesa A, B y C secuencialmente para no saturar QVAC;
- libera modelos después de la extracción;
- luego ejecuta la agregación P2P;
- actualiza las UI locales por SSE.

URLs de referencia:

```text
A → http://localhost:4700
B → http://localhost:4701
C → http://localhost:4702
```

El objetivo de la demo visual es mostrar:

```text
factura
→ QVAC local
→ productos
→ precio protegido
→ grupo
→ comparación
```

---

# 13. Demostración física planeada

El compañero dispone de 3 laptops.

La demostración ideal del video es:

### Laptop A

Carga una factura.

### Laptop B

Carga una factura diferente.

A y B procesan localmente.

Los productos quedan en:

> comparación pendiente

### Laptop C

Carga su factura.

Cuando el grupo llega a suficientes participantes para un producto:

A, B y C reciben una referencia para ese producto.

Ejemplo:

```text
A → $47 → +8.5%
B → $31 → -28.5%
C → $52 → +20.0%

Referencia del grupo → $43.33
```

Los precios individuales de B y C no deben aparecer en la UI de A.

---

# 14. Prueba LAN pendiente

Todavía debe validarse físicamente la conectividad entre dos laptops en la misma red local.

Esta prueba no debe confundirse con la demo local de tres nodos en una sola máquina.

Objetivo:

```text
Laptop A
   ↓
bootstrap local
   ↓
LAN
   ↓
Laptop B
```

Luego comprobar que el bootstrap puede desaparecer después del discovery sin convertirse en intermediario de los datos privados.

No afirmar "completamente offline".

La formulación correcta es:

> **Paridad puede establecer comunicación P2P en una red local sin depender de un servidor de inferencia ni de un agregador central.**

---

# 15. Tests

Comando principal:

```powershell
npm test
```

Incluye actualmente pruebas de:

- secret sharing;
- aggregation protocol;
- network;
- end-to-end;
- historial local.

Prueba adicional de extracción multi-producto:

```powershell
npm run test:multi
```

Prueba de demo con QVAC real, si existe en `package.json`:

```powershell
npm run test:demo
```

Antes y después de cambios importantes:

```powershell
npm test
npm run demo
```

Nunca considerar una modificación como estable si rompe estos tests sin una razón explícita.

---

# 16. Rama y Git

La rama de trabajo principal actual para este desarrollo es:

```text
test-pablo
```

El compañero ha trabajado en:

```text
test-alpha
```

y su trabajo se integra mediante merge cuando corresponde.

`main` debe representar un estado estable.

No trabajar directamente sobre `main`.

Antes de modificar:

```powershell
git status
git fetch origin
git log --oneline --graph --decorate -15
```

Después de un cambio estable:

```powershell
git status
npm test
```

No hacer commits automáticamente salvo que el usuario lo pida.

---

# 17. Historial de cambios importantes

## Checkpoint 1 — QVAC local

QVAC quedó funcionando en la máquina principal.

## Checkpoint 2 — OCR optimizado

Se redujo el tiempo de OCR aproximadamente de ~60 s a unos pocos segundos con la configuración optimizada y Vulkan.

## Checkpoint 3 — Secret sharing

100 casos unitarios pasaron.

## Checkpoint 4 — P2P

3 nodos funcionaron y también se validó comunicación entre dos laptops en redes distintas usando Hyperswarm/DHT público.

## Checkpoint 5 — Integración E2E

Factura → QVAC → precio → secret sharing → P2P → resultado.

## Checkpoint 6 — Bootstrap local

Se añadió DHT privado con bootstrap local.

## Checkpoint 7 — OOM corregido

Se descubrió y arregló el echo loop de `products`.

## Checkpoint 8 — Demo QVAC real

`npm run demo` pasó a utilizar facturas reales y QVAC local.

## Checkpoint 9 — Historial multi-producto

Una factura puede producir múltiples productos que quedan registrados localmente.

## Checkpoint 10 — UI minimalista

La interfaz fue rediseñada para:

- `idle`;
- `processing`;
- `results`;
- `history`.

La dirección actual de UX prioriza claridad, whitespace y una sola acción principal.

## Checkpoint 11 — Motion

La siguiente tarea visual es añadir motion sutil y microinteracciones, no rehacer el diseño.

---

# 18. Principios de desarrollo

## No sobreingeniería

No agregar:

- blockchain;
- backend central;
- base de datos externa;
- login;
- cuentas;
- pagos;
- proveedores;
- analytics complejos;
- chatbot;
- funcionalidades comerciales grandes;
- nuevas capas de infraestructura innecesarias.

## Cambios mínimos

Si una funcionalidad puede implementarse con 30 líneas, no escribir 300.

## Preservar interfaces

Antes de cambiar una API usada por otras partes del proyecto, inspecciona sus consumidores.

## No ocultar problemas

Si algo falla:

- diagnosticar;
- medir;
- corregir la causa;
- no esconder el problema aumentando límites arbitrariamente.

---

# 19. Rendimiento y memoria

No usar:

```text
--max-old-space-size
```

como solución principal a un problema de memoria.

Si aparece crecimiento de memoria:

1. medir `rss`;
2. medir `heapUsed`;
3. revisar timers;
4. revisar listeners;
5. revisar sockets;
6. revisar retries;
7. revisar acumulación de arrays/maps/sets;
8. revisar buffers;
9. revisar loops de mensajes.

No ejecutar múltiples OCR simultáneos en Vulkan en la máquina principal salvo que se haya demostrado que es seguro.

---

# 20. UI y animaciones — tarea visual actual

La próxima mejora visual prevista es motion sutil:

- transiciones entre vistas;
- stepper;
- botón Cargar factura;
- estados de procesamiento;
- aparición escalonada de productos;
- transición pendiente → disponible;
- cambio 2/3 → 3/3 participantes;
- aparición del resultado;
- navegación del historial.

Preferencia tecnológica:

1. CSS transitions/keyframes;
2. View Transitions u otras APIs nativas si son útiles;
3. librería ligera solo si aporta valor claro.

No instalar una librería grande solo para animaciones.

No usar motion como decoración.

La referencia es:

> **premium + precisa + viva + sobria**

No:

> demo de efectos.

Debe respetarse:

```css
prefers-reduced-motion
```

---

# 21. Pregunta crítica sobre las animaciones

Todas las animaciones deben tener una razón.

Buenos ejemplos:

```text
idle → processing
```

para comunicar cambio de etapa.

```text
pending → available
```

para comunicar que el grupo alcanzó suficiente información.

```text
2/3 → 3/3
```

para reforzar visualmente el momento clave de la demo.

Malos ejemplos:

- partículas;
- confetti;
- hologramas;
- glitch;
- 3D;
- loops permanentes;
- elementos rotando;
- contadores exagerados.

---

# 22. Código y archivos sensibles

Antes de tocar cualquiera de estos archivos, justificar la necesidad:

```text
src/privacy/secret-sharing.mjs
src/privacy/aggregation-protocol.mjs
src/network/aggregation-runner.mjs
src/network/paridad-network.mjs
src/extraction/invoice-pipeline.mjs
```

Si una tarea es solamente UI, no tocar estos archivos.

---

# 23. Estado visual recomendado

La UI debe priorizar:

### Primera pantalla

```text
PARIDAD

Compara tus precios de compra sin compartirlos.

01 Tu factura   02 IA local   03 Resultados

[ Cargar factura ]

Tu factura se procesa en este dispositivo.
```

### Procesando

```text
01 ✓   02 ●   03 ○

Analizando tu factura

✓ Factura cargada
● IA local procesando
○ Productos identificados
○ Datos protegidos
```

### Resultados

```text
Tu compra
5 productos registrados

Producto          Tu precio       Comparación

Aceite             $47.00         +8.5%
Filtro              $6.80         Sin comparación
...
```

### Historial

```text
Facturas agregadas
```

y cada factura con sus productos.

---

# 24. Lenguaje de producto

Preferir:

> Comparación pendiente

> Sin comparación disponible

> Privacidad por diseño

> Procesado localmente

> Grupo conectado

Evitar:

> Privacidad garantizada

> Totalmente offline

> 100 % seguro

> Datos imposibles de recuperar

No hacer afirmaciones absolutas.

---

# 25. Guion y demo del hackathon

La narrativa del video debe ser:

```text
PROBLEMA
↓
PARIDAD
↓
FACTURA
↓
IA LOCAL
↓
PRECIO PROTEGIDO
↓
3 PARTICIPANTES
↓
AGREGACIÓN PRIVADA
↓
RESULTADO
```

La tecnología debe respaldar la historia.

El video no debe convertirse en una explicación larga de:

- Hyperswarm;
- DHT;
- NDJSON;
- secret sharing.

Mostrar la consecuencia primero.

---

# 26. Criterio de calidad del producto

Antes de considerar una UI terminada, una persona que nunca haya visto Paridad debe poder responder rápidamente:

1. ¿Qué hace?
2. ¿Qué debo hacer primero?
3. ¿Qué pasa con mi factura?
4. ¿Dónde queda mi precio?
5. ¿Qué obtengo al final?

Si la respuesta no es evidente, simplificar.

---

# 27. Al comenzar una nueva tarea

No asumas.

Primero:

```text
git status
git log --oneline --graph --decorate -15
npm test
```

Después inspecciona los archivos relevantes.

Distingue:

- lo que ya está probado;
- lo que está parcialmente probado;
- lo que todavía no está probado.

Si el usuario pide una tarea de UI, no conviertas la tarea en refactor del backend.

Si el usuario pide una tarea de networking, protege el flujo QVAC y privacidad existente.

---

# 28. Regla especial para trabajo con otro agente

Puede haber código desarrollado en `test-alpha` y `test-pablo`.

Nunca asumir que `main` es el estado más reciente.

Antes de fusionar:

```powershell
git fetch origin
```

Después:

```powershell
git merge origin/test-alpha
```

Si aparece conflicto:

- no resolver automáticamente a ciegas;
- identificar primero qué cambio pertenece a cada rama;
- preservar correcciones críticas ya validadas.

En particular, si hay conflicto en:

```text
src/network/aggregation-runner.mjs
```

recordar que contiene la corrección que eliminó el echo loop de `products` y evitó el OOM.

---

# 29. Objetivo inmediato de trabajo

El proyecto está en una etapa de cierre y preparación de demo.

Prioridades:

1. mantener estabilidad;
2. pulir UX;
3. motion sutil;
4. estados de 3 participantes;
5. validación física LAN;
6. ensayo;
7. grabación;
8. documentación final.

No agregar funcionalidades que no sean necesarias para estas prioridades.

---

# 30. Resumen de una sola frase

> **Paridad permite que varios negocios comparen lo que pagan por un mismo producto sin revelar sus precios individuales ni centralizar sus facturas, usando IA local para entender la información y P2P para obtener una referencia conjunta.**
