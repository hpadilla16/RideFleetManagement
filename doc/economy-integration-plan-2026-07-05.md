# Plan de integración — Economy (RezLight) · 2026-07-05

Integración nueva de booking-source para importar reservas de **Economy Rent A Car**
(portal RezLight) automáticamente dentro de Ride. Tenant-specific y **location-specific**.
Primer caso: tenant **CorpUSA**, cuenta Economy que ve **MIA + LAX**.

Sigue el patrón de la integración **TL International** ya existente (mismos modelos,
mismo cifrado, misma lógica de promoción), pero es **más simple** porque Economy no tiene
CloudFlare, ni proxy residencial, ni cookie que expira cada hora.

---

## Hallazgos del recon (portal en vivo)

- **Portal**: RezLight (ASP.NET MVC), host `rezlight.economyrentacar.com`, base `/Production`.
- **Auth**: username + password SOLAMENTE. Sin 2FA, sin captcha, sin authenticator app.
  Session cookie de ASP.NET + token anti-CSRF `__RequestVerificationToken`. **No aparenta
  IP-binding** (a diferencia de TL, que amarra la cookie al IP de Puerto Rico) → el login se
  puede automatizar server-side y correr **autónomo**.
- **Endpoint de LISTA** (JSON limpio, no hay que raspar HTML):
  `POST /Production/RezAlliance/Reservations/GetReservationLookupRecords`
  → formato DataTables `{ draw, recordsTotal, recordsFiltered, data:[...] }`, cada fila:
  `rgConfirmation, rgDateBooked, rgClass (ACRISS), rgLocPickup, rgLocDropOff, rgDatePickup,
  rgDateDropOff, rgRate, rgLastName, rgName, rgEmail, rgIata, rgStatus`.
  Request form-encoded con **TRES** params (capturado 2026-07-05):
  `__RequestVerificationToken` + `jsonPaginationParameters` (DataTables con las 13 columnas rg*)
  + **`pFilter={"docType":"R"}`** (R=Reservation). ⚠️ Sin `pFilter` el endpoint devuelve 0 filas.
- **Endpoint de DETALLE**: `POST /Production/RezAlliance/Reservations` (command-based)
  → objeto completo: `resCustomerFullName, resReqFlight (flight#), resProvider,
  resPickupLocation/Desc/Date/Time/RealTime, resDropOff*, resVehClass/Description/Luggage/
  Passenger/Doors, resRateCode/Description, resIata, isPrepaid, resInsuranceType` + en
  pantalla Currency, Rate Rent, Rate Total, Booking Source, Seller, License Plate.
- **Multi-location**: la cuenta "ECONOMY MIAMI / MIAO01" ve reservas de MIA **y** LAX
  (códigos `MIAO01`, `LAXO01`). Por eso el filtro por location es esencial.

---

## Requisitos de Hector (decididos)

1. **Tenant-specific**: no todo el mundo tiene Economy; se habilita por tenant (CorpUSA).
2. **Location-specific con UNA credencial**: la misma cuenta Economy sirve para MIA y LAX.
   La config decide, por location de Ride, qué código externo jalar:
   - Habilitada para Miami → importa solo `rgLocPickup=MIA…`
   - La MISMA credencial habilitada para LAX → importa solo `rgLocPickup=LAX…`
   - Ambas → cada una a su location de Ride.
3. **Autónomo**: una vez puestas las credenciales, corre solo (login + re-login automático).

---

## Arquitectura — qué se reusa vs qué es nuevo

| Pieza | Origen | Veredicto |
|---|---|---|
| Cifrado AES-256-GCM de credenciales | `lib/integration-crypto.js` | **Reusar tal cual** |
| Modelos ExternalReservation / ExternalSyncRun / IntegrationCredential / AcrissCategoryMap / LocationCodeMap / FranchisePayoutPeriod | `schema.prisma` (keyed por `sourceSystem`) | **Reusar tal cual** — las filas de Economy conviven con las de TL por el unique `(sourceSystem, externalRef)` |
| Lógica de promoción (gates currency/ACRISS/location/customer) | `promotion-matcher.service.js` | **Reusar tal cual** |
| Detector de duplicados | `duplicate-detector.service.js` | Reusar (con timeZone por location) |
| Upsert/rotate de credencial + `recordTestStatus` | `tl-international.service.js` | Reusar-con-cambio (guarda `{username,password}` en vez de cookie) |
| Ciclo de vida del worker + `promoteWithMappings` + auto-create customer | `tl-international.worker.js` | Reusar-con-cambio (constantes + filtro por location) |
| Bandeja de imports pendientes | `PendingFranchiseImportsTray.jsx` | Reusar-con-cambio (parametrizar el base path por source) |
| **Login + cookie jar + re-login + `__RequestVerificationToken`** | — | **NUEVO** (`economy.service.js`) |
| **Scheduler autónomo** | patrón `tolls.scheduler.js` | **NUEVO** (`economy.scheduler.js`) — OJO: el "cron" de TL nunca se implementó; TL solo corre por run-now manual. La autonomía es net-new. |
| **EconomyLocationConfig** (enable por tenant+área) | — | **NUEVO** (una migración aditiva) |
| Fetch de lista/detalle (parseo DataTables JSON) | — | NUEVO (sin cheerio, sin Puppeteer, sin proxy) |
| Panel de settings Economy (user/pass + grid de locations) | clon de `TLIntegrationPanel.jsx` | NUEVO |

**Money**: la integración escribe SOLO `estimatedTotal` en la reserva (igual que TL). NO cobra,
NO captura tarjeta, NO dispara autocharge. Misma postura de seguridad que TL.

---

## Modelo de datos (migración aditiva mínima)

- `ExternalReservation.sourceSystem` es **string libre** → nueva constante `'ECONOMY'`, sin migración.
- `Reservation.bookingChannel` es string libre → `'FRANCHISE_ECONOMY'`, sin migración.
- `IntegrationCredential` unique `(tenantId, sourceSystem)` → **UNA credencial Economy por tenant**
  cubre MIA+LAX. Sin `locationId` aquí.
- **NUEVO `EconomyLocationConfig`** (dónde vive el "enable por location"):

```
model EconomyLocationConfig {
  id           String   @id @default(cuid())
  tenantId     String
  locationId   String            // location de Ride (Miami/FLL/MCO/LAX)
  externalArea String            // 'MIA' | 'LAX' — prefijo de rgLocPickup
  enabled      Boolean  @default(true)
  createdAt    DateTime @default(now())
  @@unique([tenantId, externalArea])
  @@index([tenantId, enabled])
}
```

El scheduler enumera pares activos `(tenant, área)` = tenants con credencial ECONOMY **y** ≥1
`EconomyLocationConfig` enabled. `LocationCodeMap` (ya existe) resuelve el código completo
`MIAO01 → locationId de Miami`.

---

## Fases

### Fase 0 — PoC de login autónomo (GATE de decisión) ⚠️ primero
**RESULTADO 2026-07-05: PASS en autonomía.** Corrido desde el droplet (IP NYC):
- Login server-side funcionó → apareció `.AspNet.ApplicationCookie` (cookie de auth de ASP.NET
  Identity, solo aparece si el login pasó). Campos del form: `username`, `password`,
  `__RequestVerificationToken`. Sin 2FA/captcha.
- Página autenticada `/RezAlliance/Reservations` cargó 200 SIN rebotar al login → sesión válida.
- `GetReservationLookupRecords` respondió 200 JSON desde el droplet → **NO hay IP-binding** (a
  diferencia de TL). Economy corre autónomo desde el droplet.
- Único pendiente de afinamiento (no bloqueador): el payload `jsonPaginationParameters` genérico
  del PoC devolvió `recordsTotal:0`; hay que usar el formato EXACTO que manda el portal (capturar
  de la red) — se clava en la Fase 2. Auth/IP/autonomía ya confirmados; el 0 es solo formato de
  payload, no de sesión.
- Ajuste menor del PoC: el veredicto esperaba un 302 post-login, pero RezLight responde 200 (la
  auth se confirma por la cookie + la página autenticada), así que el "REVISAR" fue falso negativo.


Script desechable corrido **desde el droplet** (IP de NYC, no tu Mac de PR):
1. GET del login → capturar cookie + scrapear `__RequestVerificationToken`.
2. POST de credenciales → confirmar 302 a dashboard (no de vuelta a /Login) + cookie autenticada.
3. Con la sesión, POST a `GetReservationLookupRecords` → confirmar JSON con `data[]`.
4. **Verificar que funciona desde el IP del droplet** (si sí → la sesión NO está atada al IP).

**Gate**: PASS → todo con `fetch` + cookie jar, autónomo (el objetivo). FAIL → plan B: proxy
estilo TL (`ECONOMY_PROXY_URL` + ProxyAgent), el resto del plan igual. Capturar también:
TTL de sesión, path exacto del login, nombres exactos de campos, si el token va en body o header.

### Fase 1 — Migración + modelo (backend, aditivo)
`EconomyLocationConfig` + relación en `Tenant`. Constantes `SOURCE_SYSTEM='ECONOMY'`,
`BOOKING_CHANNEL='FRANCHISE_ECONOMY'`. Migración auto-boot.

### Fase 2 — Service de auth/sesión (`economy.service.js`)
Login + cookie jar en memoria por tenant, manejo del `__RequestVerificationToken`, `authedFetch`
con re-login automático al detectar 302→login/401, `fetchReservationList` (parseo DataTables),
`fetchReservationDetail`, `setCredentials/getCredentials` (cifradas), `testAuth`. Reusa el cifrado
y el patrón de credencial del TL; net-new el transporte (fetch, sin Puppeteer/proxy).

### Fase 3 — Import/mapping + filtro por location (`economy.worker.js`)
Clon del ciclo TL. **Filtro clave**: por cada fila, derivar el área de `rgLocPickup` (prefijo
`MIAO01→MIA`) y quedarse SOLO si hay `EconomyLocationConfig(tenant, área, enabled)`. Mapeo
`rg*/res* → ExternalReservation → Reservation` (prefijo `ECON-<rgConfirmation>`). **TZ por
location** (Miami/FLL/MCO = America/New_York; LAX = America/Los_Angeles) — Economy es
multi-timezone, TL era solo PR. Reusa promoción, ACRISS, dedup, auto-create.

### Fase 4 — Scheduler autónomo (`economy.scheduler.js`)
Patrón `tolls.scheduler.js`: `setInterval` + guard de en-progreso + delay de arranque. Enumera
`(tenant, área)` activos y encola un job `economy.sync` por área. `registerEconomySyncWorker`
en el worker. Flag `ECONOMY_INTEGRATION_ENABLED` (default false, ship dark). Cadencia
`ECONOMY_SYNC_INTERVAL_MINUTES` (default 15).

### Fase 5 — Routes + Frontend (needs mockup aprobado antes de construir UI)
`economy.routes.js` (`/api/admin/integrations/economy`): status, test-auth, run-now, runs,
pending-imports (promote/reject), payout-periods — reusados con source ECONOMY; net-new
`POST /credentials {username,password}` y `GET/PUT /locations` (config MIA/LAX → locationId).
`EconomyIntegrationPanel.jsx` (clon del TL, user/pass + grid de locations). Bandeja de pendientes
parametrizada por source.

### Fase 6 — Tests + smoke
Unit del mapper y del filtro `rgLocPickup→área` (el core de correctitud multi-location); test del
service con `fetch` mockeado (login→token→list→re-login en 302). Smoke tras habilitar el flag con
la cuenta real de CorpUSA/Miami: importar una reserva MIA y verificar que las LAX NO entran.

---

## Preguntas abiertas para Hector (para cerrar antes/durante el build)

1. **PoC (Fase 0)**: ¿corremos el PoC de login desde el droplet primero para confirmar autonomía,
   antes de invertir en las Fases 1-5? (recomendado — es el gate).
2. **Regla del prefijo**: ¿`rgLocPickup` siempre es `AAA`+sufijo (los 3 primeros = área)? Vimos
   `MIAO01` y `LAXO01`. ¿FLL/MCO seguirían el mismo patrón si Economy los expusiera?
3. **FLL/MCO**: la cuenta Economy de CorpUSA hoy es MIA + LAX. ¿FLL y MCO reciben reservas de
   Economy también (necesitarían su propia área/config), o por ahora solo MIA (+ LAX en su local)?
4. **Modelo**: ¿OK con la tabla `EconomyLocationConfig` (recomendado, da índice para el scheduler)
   vs guardar las áreas en `Tenant.integrationConfig.economy` JSON?

---

## Riesgos

- Pareo cookie-vs-form del `__RequestVerificationToken` en ASP.NET — el PoC debe clavar los nombres exactos.
- Multi-timezone (ET vs PT) — la TZ sale de la location mapeada, no de una constante.
- La bandeja de pendientes hoy hardcodea el path de TL — hay que parametrizar por source.
- Si el badge "franchise import" de la lista de reservas se ata al string exacto `FRANCHISE_TL`,
  hay que generalizarlo para que Economy también muestre el badge (cambio de 1 línea).
- Money: ninguno — solo `estimatedTotal`, sin cobro.
