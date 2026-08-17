# Shuttle Tracker — capturas para marketing

Set solicitado por el equipo del website (2026-08-17) para la página de
recogida en aeropuerto. Ocho capturas, cuatro estados × dos idiomas, en pares
simétricos para emparejarlas en la web.

| Estado | ES | EN |
|---|---|---|
| Mapa en vivo | `tracker-live-es.png` | `tracker-live-en.png` |
| Ubicación del cliente | `tracker-location-es.png` | `tracker-location-en.png` |
| Solicitud confirmada | `tracker-requested-es.png` | `tracker-requested-en.png` |
| Sin señal | `tracker-offline-es.png` | `tracker-offline-en.png` |

**Formato:** PNG, 780 px de ancho (viewport móvil 390 px a 2x), viewport puro
— sin barra de direcciones ni marco de dispositivo. Tenant de demostración.

**⚠️ ORIGEN DE LOS DATOS: SIMULADOR.** Todas las posiciones del shuttle salen
de `backend/scripts/shuttle-simulator.mjs` (el GPS real espera credenciales
del proveedor de telemática). El acuerdo con el equipo del website
(2026-08-16) es que estas se publican **etiquetadas como demostración**.
Cuando exista GPS real se rehace el set y se avisa — esas sí irían sin
etiqueta.

**Nota de idioma:** las instrucciones de sede ("dónde esperar") las escribe el
administrador y el producto las muestra literales, sin traducir — ese
comportamiento es correcto. Para estas capturas se alternó el texto de la sede
Demo entre español e inglés por tanda, de modo que cada captura sea monolingüe
de arriba a abajo.

**Cómo regenerar:** el guion de captura vive en la historia de la sesión de
2026-08-17 (Puppeteer headless contra la página pública de prod con un link de
demo del tenant Demo; estados escenificados vía la config del tracker y la
frescura del último fix). El estado "sin señal" se produce parando el
simulador y esperando ~5 min a que el último fix supere el umbral de
staleness. Ningún dato real de clientes aparece ni puede aparecer: el payload
público es una whitelist.
