# Plan de integración — NU Car Rentals (portal de afiliados)

**Fecha:** 2026-07-09 · **Tenant:** CorpUSA · **Localidad Ride:** FLL (Fort Lauderdale)
**Estado:** Fase 0 (recon + PoC login) CERRADA — PASS. Pendiente build Fases 1-N.
**Playbook:** clona la integración Economy (RezLight). Reusa modelos/crypto/promotion/dedup.

---

## 1. Hallazgos del recon (Fase 0)

**Portal:** `https://affiliates.nucarrentals.com` — ASP.NET **WebForms + Telerik RadControls**.
- Login: `AffiliateLOGIN.aspx`. Campos reales: `txtLoginID`, `txtPSWD`, botón `Button1` (value "Submit").
  - **Truco Telerik ClientState (CLAVE):** el RadTextBox NO lee el input plano; lee su valor del
    hidden `<campo>_ClientState` (JSON). Hay que poblar `txtLoginID_ClientState` y
    `txtPSWD_ClientState` con `{enabled:true,emptyMessage:"",validationText:V,valueAsString:V,lastSetTextBoxValue:V}`.
    Sin esto: "LoginID Is Required". Reenviar además `__VIEWSTATE`, `__VIEWSTATEGENERATOR`, `__EVENTVALIDATION`.
  - Éxito = 302 → `AffiliateMAIN.aspx` → `affiliates.aspx` (200). **Auth por sesión
    (`ASP.NET_SessionId`), NO setea forms-cookie.** Sin IP-binding, sin 2FA, sin captcha.
- **AUTÓNOMO desde el droplet (IP NYC) confirmado** — como Economy, **sin proxy** (a diferencia de TL).

**Página de reservas:** `affiliates.aspx` (una sola página, RadGrid `RadGrid1`, postback a sí misma).
- La cuenta está amarrada a **UNA localidad**: "CORPUSA CAR RENTAL @ NU CAR RENTALS -FT. LAUDERDALE (100)".
  → **NU → FLL es 1:1** (no hay filtro de área por credencial como MIA/LAX en Economy).
- **Consulta por rango de fechas (postback):**
  - `RadRadioButtonList1` → tipo de fecha: **Rental Date** / Return Date / Taken Date.
  - `RadDatePickerSTART$dateInput` + `RadDatePickerEND$dateInput` — formato **M/D/YYYY** (ej. `07/9/2026`).
    (RadDatePicker = mismo patrón Telerik; poblar el `$dateInput` + su ClientState.)
  - Otros filtros: `txtLastName`, `txtFirstName`, `txtCF` (confirmation), Status (default OPEN).
  - Disparo: `btnRefreshGrid` (REFRESH, type=button → `__EVENTTARGET=ctl00$ContentPlaceHolder1$btnRefreshGrid`).
  - Export alterno: `btnExcel` (genera .xlsx) — NO se usa; extracción elegida = parse del RadGrid HTML.

**Columnas del grid (rg → ExternalReservation):**

| Grid | Significado | Mapeo |
|---|---|---|
| Confirmation (`617-0103071-NU`) | ref externa | `externalRef`; reservationNumber prefijo `NU-` |
| Last Name / First Name | cliente | customer match (jaroWinkler) |
| PU | ¿pickup loc/desk? | informativo |
| Flight | vuelo (o `UN`=unknown) | `flightNumber` si aplica |
| TAKEN + Time | fecha reservada | `bookedAt` |
| RENTAL + Time | **pickup** | `pickupAt` (TZ America/New_York) |
| RETURN + Time | **dropoff** | `dropoffAt` |
| Class | **ACRISS** (IFAR/SFAR/CCAR/ECAR/FCAR/ICAR/MVAR/XXAR/FFAR) | `AcrissCategoryMap(NU)` → vehicleType |
| Status | OPEN | `status` |
| **Total** | **monto de la reserva** | **`estimatedTotal`** (nunca cobra) |
| **Code** | **PP/OP = prepago; en blanco = pago a destino** | flag `isPrepaid` (ver §3) |
| RATE | código de tarifa (número) | informativo |
| AltConfirmation# | conf. alterna (a veces) | metadata |

---

## 2. Diferencias vs Economy (lo net-new / distinto)

1. **WebForms + Telerik** en vez de MVC + DataTables. El service NU postea `affiliates.aspx`
   (viewstate + ClientState + rango de fechas + `__EVENTTARGET=btnRefreshGrid`) y **parsea el
   RadGrid HTML** (en vez del JSON DataTables de Economy). Login con truco ClientState.
2. **1 credencial = 1 localidad (FLL).** No hay filtro de área por prefijo. El config es
   simplemente "NU de este tenant → localidad Ride FLL". (Los campos Region/District/Center del
   portal sugieren que cuentas NU multi-center existen — el config queda preparado para eso, ver §4.)
3. **Prepago mixto.** A diferencia de Economy/TL (todo prepago), NU trae reservas **prepago
   (Code PP/OP)** Y **pago a destino (Code en blanco)**. Requiere flag por reserva (ver §3).
4. **Auth por sesión** (ASP.NET_SessionId), no forms-cookie — el re-login se detecta por rebote a login.

**Reusa igual que Economy:** `ExternalReservation`, `ExternalSyncRun`, `IntegrationCredential`,
`AcrissCategoryMap`, `LocationCodeMap`, `FranchisePayoutPeriod`, `integration-crypto.js`,
`promotion-matcher.service.js` (con `overrideLocationId`), `duplicate-detector.service.js`.

---

## 3. Prepago / badge (regla de negocio de Hector)

- `Code` ∈ {PP, OP} → **prepago** → badge "Franchise import / prepago — no cobrar en counter".
- `Code` en blanco (solo número en RATE, sin letras) → **pago a destino** → **SÍ se cobra en el
  mostrador**, sin badge de prepago.
- Guardar `isPrepaid` por `ExternalReservation` (derivado del Code). El display de la reserva y el
  badge deben distinguir prepago vs pago-a-destino. `bookingChannel='FRANCHISE_NU'` (el badge de
  franchise ya cubre `FRANCHISE_*`), pero el **texto** del badge se condiciona a `isPrepaid`.
- **Postura de dinero (igual que Economy/TL):** solo escribe `estimatedTotal`,
  `sendConfirmationEmail:false`. **Nunca cobra, nunca toca tarjeta** — ni siquiera las pago-a-destino
  (esas las cobra el counter manualmente al entregar).

---

## 4. Config "qué reservas mirar" (genérico)

NU es 1:1 FLL, así que el mínimo es mapear la credencial NU → localidad FLL. Opciones:
- **(A) Mirror Economy:** `NuLocationConfig(tenantId, locationId, externalCenter?, enabled, lookbackDays?, lookaheadDays?)`.
  Consistente con Economy; soporta multi-center futuro (campo `externalCenter` = "100"/FLL).
- **(B) Generalizar:** refactor a `IntegrationLocationConfig(tenantId, sourceSystem, externalArea, ...)`
  que Economy y NU compartan — cumple mejor el requisito genérico ("para cualquier persona que
  conectemos... una forma de decir qué reservas mirar"), pero migra/toca el código de Economy (en pausa).

**Recomendación:** (A) ahora para no tocar Economy en vuelo; anotar (B) como refactor futuro cuando
haya una 3ra fuente (Advantage/Flexways/MEX) para hacerlo una sola vez.

Master enable + credenciales: `Tenant.integrationConfig.nu.enabled` + `IntegrationCredential(tenant,'NU')`
(username/password cifrado AES-256), mirror exacto de Economy.

---

## 5. Fases del build (mirror Economy, ship dark)

- **Fase 1 — schema+migración:** `NuLocationConfig` + relación en Tenant + `isPrepaid` en
  ExternalReservation (o metadata) + constants (`SOURCE_SYSTEM='NU'`, `BOOKING_CHANNEL='FRANCHISE_NU'`,
  `QUEUE_NAME='nu.sync'`, `RESERVATION_PREFIX='NU-'`, TZ FLL=America/New_York, ventana default).
- **Fase 2 — `nu.service.js`:** login (ClientState) + cookie jar (SessionId) + re-login-once +
  `fetchReservationList(dateFrom,dateTo)` (postback affiliates.aspx: RadDatePicker START/END + ClientState
  + RadRadioButtonList=Rental Date + `__EVENTTARGET=btnRefreshGrid` + viewstate) + **parser del RadGrid**.
  Reusa integration-crypto. Ventana de fechas M/D/YYYY. `testAuth`.
- **Fase 3 — `nu.worker.js`:** run lifecycle (ExternalSyncRun) + mapeo rg→ExternalReservation + `isPrepaid`
  desde Code + ACRISS→vehicleType (AcrissCategoryMap NU) + `overrideLocationId`=FLL + promotion/dedup +
  guard cross-tenant. TZ America/New_York.
- **Fase 4 — `nu.scheduler.js`:** autónomo (patrón tolls.scheduler), master-flag por tenant, feature flag
  `NU_INTEGRATION_ENABLED` (default false, ship dark).
- **Fase 5 — rutas + panel:** `nu.routes.js` (admin, tenant-scoped, credenciales cifradas nunca
  devueltas, run-now gated) + `NuIntegrationPanel.jsx` (mockup aprobado primero). Reusa el tray
  source-aware (ya generalizado en Economy) con `source="nu"`. El badge distingue prepago vs pago-a-destino.
- **Fase 6 — tests + smoke.** Fase 7 — training PDF.

Cada fase por el pipeline (Innovation + QA; UI necesita mockup aprobado). Money/access = revisión de Hector.
