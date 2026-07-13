# Flexways (MobilityPS) — integración autónoma de booking source (plan 2026-07-13)

**Estado:** Fase 0 (recon) **PASS con sesión real** (2026-07-13, Hector logueó en el
Browser pane y se mapeó el sistema en vivo). Queda 1 unknown: validar la cookie desde
IP del droplet (se prueba en Fase 2 con la cookie cifrada en IntegrationCredential).

## Hallazgos con sesión (2026-07-13) — el sistema es MEJOR de lo esperado

- **La grilla de reservas es un endpoint JSON**: `GET /Helpers/funcionesAjaxReservas.php`
  devuelve DataTables-JSON (`{draw, recordsTotal, data:[[...]]}`) — 160 reservas al
  momento del recon. NADA de parsear HTML de grids (NU/RadGrid era mucho peor). El
  service = cookie + GET + JSON.parse (las celdas traen fragmentos HTML → strip tags).
- **Columnas del grid (9)**: 0=sede ("Flexways Orlando - Vista East"), 1=fecha de booking
  (DD/MM/YYYY HH:mm — formato LATAM, ojo parser), 2=pickup datetime, 3=pickup location,
  4=dropoff location, 5=canal ("API"), 6=cliente+código ("Joan V... VISSAHE"),
  7=status (ícono con tooltip "Reserva Nueva - API"), 8=ref ("QSRC58").
- **Lo que NO está en el grid** (va del detalle por reserva, mapear en Fase 2):
  clase/ACRISS, total/moneda, email/phone del cliente.
- **Locations = "sedes"** (`idSede=383` en las URLs; menú "Configuración oficinas" →
  listadoSucursales.php) → `FlexwaysLocationConfig` mapea por idSede, cero hardcode.
- Otras listas útiles: `Comercial/Reservas/listadoCotizaciones.php?...&idSede=` (contratos),
  `listadoReservasAfiliados.php`. Dashboard con KPIs de flota (227 contratos abiertos etc.).
- Stack interno: dhtmlxScheduler + DataTables, PHP, UI en español.

**Contexto:** 3ra fuente del arco de integraciones (TL → Economy → NU → **Flexways**).
Advantage quedó ON-HOLD (Hector está consiguiendo el login). Igual que NU: locations por
config, cero hardcode. Portal: `https://system.mobilityps.com/login.php`.

## Hallazgos del recon (2026-07-13, página pública)

- **Stack:** PHP clásico (login.php), UI en ESPAÑOL ("Iniciar sesión"/"Ingresar"). MPS =
  MobilityPS. NADA de ASP.NET/viewstate/Telerik (más simple que NU).
- **Form de login:** `POST login.php` con `usuario`, `clave` + hidden `URI` y `userData`
  (probable CSRF/estado — el service debe GET login.php primero y parsear los hidden).
- **⚠️ reCAPTCHA v3** (invisible, score-based: `api.js?render=<sitekey>`) cargado global
  en la página. NO es un challenge que resolver — v3 puntúa el request por comportamiento,
  no presenta puzzle. **Arquitectura elegida (decisión Hector 2026-07-13): AUTÓNOMO, patrón
  TL_INTERNATIONAL con browser headless.** Un Puppeteer/stealth maneja la PÁGINA DE LOGIN
  REAL → el propio `grecaptcha` de la página genera su token solo → el login procede. Es
  automatizar el flujo legítimo, NO bypasear/resolver/forjar captcha (servicios de
  captcha-solving y token-farms quedan PROHIBIDOS — no hacen falta). El worker se re-loguea
  solo cuando la sesión expira (sin intervención humana), igual que NU/Economy.
  **RIESGO A PROBAR EN EL PoC:** el score de v3 desde IP de datacenter (droplet). Si nos
  puntúa bajo/bloquea → proxy residencial (mismo patrón que `TL_INTERNATIONAL_PROXY_URL`
  hoy). El re-login manual queda SOLO como fallback de emergencia en el panel, no como el
  modo de operación.
- **Ojo:** la misma página trae un widget público de PAGO con tarjeta (MercadoPago-style:
  cuotas, tipo de documento). Irrelevante para el import, pero confirma que MPS es una
  plataforma de pagos/rentas LATAM — verificar TZ y formato de fechas del grid en el PoC.
- **IP de datacenter:** la página carga sin bloqueo desde IP residencial; probar desde el
  droplet en el PoC (lección TL: CloudFlare puede atar cookie al IP → proxy residencial).

## Recon del DETALLE (2026-07-13, sesión viva de Hector) — hallazgos clave

- **El grid (`funcionesAjaxReservas.php`) NO trae `idAlquiler`** (ni ACRISS/total/email). Solo: sede,
  fechas, pickup/dropoff location, canal, nombre+código de cliente, status, ref. 9 columnas, sin
  `DT_RowId`.
- **El detalle vive en `Comercial/Reservas/modificarReserva.php?idAlquiler=${idAlquiler}`** (la clave es
  `idAlquiler` = id del alquiler, NO el ref del grid). El `idAlquiler`/`idReserva` viene de los EVENTOS
  del timeline (`eventObj.idReserva`), que carga `Administrativo/Vehiculo/vehiculosOcupacion.php` (POST
  con fechaDesde/fechaHasta → devuelve la PÁGINA HTML del timeline, ~710KB, con los eventos embebidos).
- **⚠️ Las categorías de vehículo son NOMBRES propios de MobilityPS, NO códigos ACRISS**: el dashboard
  mostró "Grande Automatico / SUV Automatico / Intermediate AT / Monovolumen 7 pax Elite / ...". → El
  mapeo de clase debe ser por NOMBRE de categoría Flexways → VehicleType, NO por AcrissCategoryMap. Esto
  cambia el diseño de Fase 3: `vehicleAcriss` guardará el nombre de categoría, y hace falta un
  `FlexwaysCategoryMap` (o reusar AcrissCategoryMap con las STRINGS de categoría como key).
### RECON DEL DETALLE COMPLETO (2026-07-13, idAlquiler=485160)

**FUENTE CON idAlquiler: `GET /Helpers/funcionesAjaxContratos.php?idSede=<sede>`** — DataTables
array-OF-OBJECTS (no array-of-arrays como el grid): col 0 = **idAlquiler** (numérico, ej. 485160),
col 1 = iniciales, col 2 = sede, col 3 = fecha booking, col 4 = fecha devolución, col 5 = pickup loc,
col 6 = dropoff loc, col 7 = **canal** (API = afiliado), col 8 = nombre cliente, col 10 = **ref**
(ej. QJDK07), col 11 = acciones. 200 registros. → El grid `funcionesAjaxReservas.php` (el que usa el
worker hoy) NO trae idAlquiler; **cambiar la fuente a `funcionesAjaxContratos.php`** para obtenerlo.

**DETALLE: `GET /Comercial/Reservas/modificarReserva.php?idAlquiler=<id>`** — HTML form (~1MB) con:
- `emailCustomer` = email REAL del cliente (ej. FREAKIN...@GMAIL.COM) + `idCliente` (ej. 308707).
- `total` / `totalfin` = monto (ej. 32.50); `cbMoneda` select → texto "USD".
- `cbCategoria` select → el texto de la opción seleccionada es **"Nombre (ACRISS)"** — ej.
  "SUV Compact AT **(CFAR)**". **¡Los códigos ACRISS SÍ existen, en el paréntesis!** Lista observada:
  Economico Base (EBMN), Economico Elite (EBMR), Compacto (CDMR), Compacto Premium (DDMR),
  Sedan Mediano (IDMR), Grande Automatico (FDAR), Minivan 7 pax (FVMR), SUV Compact AT (CFAR)...
  → El AcrissCategoryMap FUNCIONA: extraer el código con `/\(([A-Z]{4})\)/`.
- Teléfono: no aparició en el sample (email es la key primaria de match; teléfono opcional).

**DISEÑO FINAL de Fase 3 (detail-fetch)**: worker lista por `funcionesAjaxContratos.php` (idAlquiler+ref+
canal API+nombre) → por cada fila, `fetchReservationDetail(idAlquiler)` parsea modificarReserva.php →
`emailCustomer`, `total`+moneda, ACRISS del paréntesis de cbCategoria. Mapea: email→match cliente ·
ACRISS→AcrissCategoryMap→VehicleType · total→estimatedTotal. Con esto las reservas AUTO-PROMUEVEN.
Sembrar el AcrissCategoryMap del tenant corpus con los códigos observados ANTES de encender.

## ⚠️ GATES DE PoC EN VIVO ANTES DE UN-DARK (Innovation 2026-07-13)

1. **Col 3 del contrato = pickupAt (el #1)**: el recon la etiquetó "fecha booking"; el build la mapea a
   pickup (con col 4 = devolución). Antes de encender, VERIFICAR contra una reserva conocida que col 3
   sea el pickup real (y que col 4 ≥ col 3). Si no, `FLEXWAYS_CONTRACT_COL_PICKUP` lo corrige sin
   re-deploy. Money seguro igual (fail-safe), pero el pickupAt saldría mal.
2. **Field-names del detalle** (emailCustomer/total/cbMoneda/cbCategoria) — todos `FLEXWAYS_DETAIL_*`
   env-overridable; confirmar en el PoC que no cambiaron.
3. **Canal**: default fail-closed `['API']` (solo afiliados). Confirmar que ese es el canal correcto de
   las reservas a importar; `FLEXWAYS_CONTRACT_CHANNELS` para ajustar (o "ALL").
4. Sembrar `AcrissCategoryMap` de corpus con los códigos observados (EBMN/EBMR/CDMR/DDMR/IDMR/FDAR/
   FVMR/CFAR → VehicleTypes) ANTES de encender.
5. **DEFERIDO (cross-source)**: currency null → el matcher compartido lo trata como USD; true fail-closed
   necesitaría tocar promotion-matcher (afecta NU/Economy/TL). Moot hoy (cuenta USD-Orlando).

## Fase 0 — cierre del recon (GATE)

1. Hector mete credenciales en el panel (cifradas) o hace el primer login manual.
2. PoC desde el droplet: ¿la cookie de sesión funciona desde IP datacenter? ¿TTL?
3. Mapear el grid de reservas post-login: filtros de fecha, paginación, columnas
   (ref, cliente, email/phone, clase/ACRISS o equivalente, pickup/dropoff, location,
   total, moneda, prepago), TZ, formato de fechas.
4. Set de códigos de clase y de location observados (para AcrissCategoryMap +
   FlexwaysLocationConfig).

## Fases 1-7 (mirror NU; sujeto al refactor source-aware)

Flexways es la 3ra fuente construida → **antes de Fase 1, Innovation evalúa el refactor
source-aware** (extraer service/worker/scheduler genérico; Economy/NU/Flexways como
adapters — anotado desde el plan de NU). Después:

- **Fase 1** — schema aditivo: `FlexwaysLocationConfig` + constants (`SOURCE_SYSTEM='FLEXWAYS'`,
  `BOOKING_CHANNEL='FRANCHISE_FLEXWAYS'`, `QUEUE_NAME='flexways.sync'`, `RESERVATION_PREFIX='FW-'`,
  TZ según recon).
- **Fase 2** — `flexways.service.js`: cookie-jar persistente (patrón TL) + fetch del grid +
  parser + `testAuth` (valida la sesión guardada, NO hace login).
- **Fase 3** — `flexways.worker.js`: run lifecycle + mapeo → ExternalReservation + ACRISS/clase
  map + location por config + dedup + guard cross-tenant. **Sembrar AcrissCategoryMap del
  tenant ANTES del primer sync** (lección NU: 556 atascadas por mapa vacío).
- **Fase 4** — scheduler autónomo: master-flag `integrationConfig.flexways.enabled` + env
  `FLEXWAYS_INTEGRATION_ENABLED` (default false, dark) + `FLEXWAYS_AUTO_CREATE_CUSTOMERS`
  (false hasta validar matching). Keys a `.env.example` Y al `.env` del droplet pre-deploy.
- **Fase 5** — rutas + panel. **MOCKUP APROBADO por Hector 2026-07-13** (versión autónoma:
  `doc/flexways-panel-mockup-2026-07-13.html` — card de credenciales + auto-login healthy +
  proxy avanzado colapsado + Force re-login solo emergencia). Tray source-aware
  `source="flexways"` (ya generalizado en R0).
- **Fase 6** — tests + smoke con data prod. **Fase 7** — training PDF.

## Lecciones aplicadas (Economy/NU/TL)

- AcrissCategoryMap sembrado ANTES del primer sync; AUTO_CREATE_CUSTOMERS empieza false.
- Worker tiene su propia imagen docker — siempre en el build.
- env-diff-check exige las keys nuevas en el droplet antes del deploy.
- Cookie atada a IP → proxy residencial (patrón TL_INTERNATIONAL_PROXY_URL) si hace falta.
- La bandeja de pendientes ya es visible para ADMIN del tenant (cambio 2026-07-13).
