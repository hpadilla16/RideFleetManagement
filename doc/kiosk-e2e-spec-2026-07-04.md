# Ride Kiosk — Spec técnico end-to-end (2026-07-04)

Ejecuta el plan de producto `doc/kiosk-autonomo-plan-2026-06-11.md` con UN cambio de
scope decidido por Hector (2026-07-04): **walk-up "Rent a car now" ENTRA en v1**
(en el plan de junio estaba en "Qué NO hace v1"). Mockups: `doc/kiosk-mockups-2026-07-04.html`.

## Goal (acceptance criteria)
Solución end-to-end de kiosk que cualquier tenant activa en su local:
1. Cliente con reserva completa su pickup solo: lookup → ID scan → upsell → pago →
   firma → llaves. Termina en RentalAgreement CHECKED_OUT real (mismo estado que un
   checkout de counter). Target < 6 min.
2. Cliente SIN reserva (walk-up) ve clases disponibles HOY con precio, crea la reserva
   en el kiosk y entra al mismo flujo de pickup.
3. Todo tenant-scoped: el tenant enciende el módulo `kiosk`, parea sus tablets, define
   su catálogo de upsell y reglas por canal. Nada hardcodeado a Manuel/Orlando.
4. Escalación: cliente atorado → staff (v1: notificación/cola; video Remote Agent = Fase F).
5. Telemetría por sesión (funnel completo, ofertas shown/accepted/declined, outcome) —
   base del piloto: % resuelto sin humano ≥70%, attach rate vs counter.
6. QA gate: nada live se rompe (checkout de counter, pricing, fee-engine intactos).

## Reuse map (verificado en el repo 2026-07-04)
| Necesidad | Pieza existente | Nota |
|---|---|---|
| Ciclo de checkout | `checkout-session` state machine (CONFIRMING→…→CLOSED) | caller nuevo tipo kiosk; guards existentes aplican (NO_VEHICLE_ASSIGNED 422) |
| Auth de páginas públicas | `HandoffToken` (kinds TERMS_SIGNING/MOBILE_INSPECTION/CUSTOMER_INSPECTION) | device auth NO usa HandoffToken → modelo `KioskDevice` propio (tokens rotables); las sub-acciones sí pueden emitir handoffs |
| Ancillaries daily | `ReservationCharge.chargeType=DAILY` + `AdditionalService` (FIXED/PER_DAY/PERCENTAGE) | el soporte daily YA existe — el plan de junio asumía que faltaba; lo que falta es catálogo curado + reglas por canal |
| Pago sin terminal | **SÍ existe payment-link público**: `paymentRequestToken` + página `/customer/pay` (Auth.Net hosted/Stripe/Square, webhook verificado, dedupe idempotente en `postAuthNetPaymentToReservation`) | **EXTENDER ese patrón con opción iPOS** (reusar token fields + verificación + dedupe), NO construir una segunda página de pago paralela. La página de tarjeta = **iPOSpays Hosted Payment Page** SIEMPRE (PCI SAQ-A) — nunca form propio. MONEY: review de Hector línea a línea |
| Depósito | Transact `/auth` (PreAuth) — patrón de `spin-charge.service.js` incl. rollback/void. Fuente de verdad = `securityDepositAmount`/cargos SECURITY_DEPOSIT de la reserva (como el counter); `kioskDepositConfig` SOLO como fallback de walk-up | **GATE B5 (resolver contra docs iPOS antes de código)**: confirmar que el token del HPP CNP sirve para (a) la 2da operación deposit-PreAuth con el mismo orden de rollback/void, y (b) card-on-file post-renta (tolls/daños/citations) — si no, los checkouts de kiosk pierden card-on-file vs counter |
| ID scan | `frontend/src/lib/aamva.js` + `LicenseScanner.jsx` (pdf417 nativo + zxing fallback) | puro, drop-in |
| Lookup de reserva | **NO hay endpoint reusable** (corregido: `customer-portal` no tiene lookup; el real es `POST /api/public-booking/lookup` que keyea reference+email y devuelve PII completa — NO sirve) | lookup del kiosk = código NUEVO con respuesta stub mínima (nombre enmascarado, ventana de pickup, clase — match server-side, nada más) + contador de intentos por device con lockout + `attachPublicRequestMeta`/`createPublicRateLimitGuard`. OJO: `tenant-rate-limit` corre después de requireAuth → NO cubre rutas kiosk; los guards por IP/device son la única defensa |
| Walk-up reservation | `POST /api/reservations` + pricing quote (`/api/reservations/:id/pricing`) + create-options (clases+rates+counts) | |
| Página pública/fullscreen | patrón `/inspect/[token]` (sin AppShell, phone-first) + i18n en/es existente | kiosk = `/kiosk/*` con KioskShell fullscreen |
| Gating | `module-access.js` MODULE_KEYS + `requireModuleAccess('kiosk')` | patrón beta.212 (maintenance/citations) |

## Data model (migración ADITIVA)
```prisma
model KioskDevice {
  id            String   @id @default(cuid())
  tenantId      String
  locationId    String
  name          String
  tokenHash     String   @unique        // SHA-256 de crypto.randomBytes(32); compare constante; token solo se muestra al parear
  tokenVersion  Int      @default(1)    // bump al rotar (semántica tokenVersion del service-account)
  pairingCodeHash String?               // código 6 dígitos HASHEADO, single-use
  pairingCodeExpiresAt DateTime?        // TTL 10 min
  pairingAttempts Int    @default(0)    // lockout de fuerza bruta en /pair
  status        KioskDeviceStatus @default(ACTIVE)   // ACTIVE | REVOKED
  revokedAt     DateTime?
  rotatedAt     DateTime?
  walkupEnabled Boolean  @default(true)
  lastSeenAt    DateTime?
  appVersion    String?
  createdAt     DateTime @default(now())
  @@index([tenantId, locationId])
}

model KioskSession {
  id            String   @id @default(cuid())
  tenantId      String
  deviceId      String
  kind          KioskSessionKind        // PICKUP | WALKUP
  reservationId String?                 // set al encontrar/crear la reserva
  checkoutSessionId String?
  step          String                  // funnel actual (WELCOME/LOOKUP/ID/UPSELL/PAYMENT/SIGN/DONE)
  outcome       KioskSessionOutcome @default(IN_PROGRESS) // COMPLETED | ESCALATED | ABANDONED | IN_PROGRESS
  escalatedReason String?
  eventsJson    Json                    // funnel: [{at, step, event, data}] — ofertas shown/accepted/declined, scan attempts
  startedAt     DateTime @default(now())
  endedAt       DateTime?
  @@index([tenantId, deviceId, startedAt])
}

model UpsellRule {                       // reglas por canal/broker, por tenant
  id            String  @id @default(cuid())
  tenantId      String
  channel       String                  // normalizado desde Reservation.bookingChannel; '*' = default
  prepaidServiceIds String[]            // lo que el broker ya cobró → NUNCA ofrecer (IDs de AdditionalService, NO codes — code es nullable/no-unique)
  offerServiceIds   String[]            // orden de oferta (IDs de AdditionalService, validados al guardar contra el catálogo activo del tenant)
  strategy      String                  // 'PACKAGES_3' | 'UPGRADE_FIRST'
  isActive      Boolean @default(true)
  @@unique([tenantId, channel])
}
```
Los tres modelos usan relaciones Prisma reales a Tenant/Location (no strings sueltos),
como el resto del schema. El "prepaid del broker" es realidad PER-RESERVATION (no solo
per-channel) — v1 usa la aproximación per-channel + hook para flag por reserva después.
Catálogo de productos = `AdditionalService` existente (no se duplica); los paquetes
Basic/Recomendado/Premium se componen de **IDs** del catálogo (JSON de config por tenant,
`AppSetting kioskPackagesConfig`, editable en Settings → Upsell) con la misma validación
al guardar que UpsellRule (code es nullable/no-unique — nunca referenciar por code).
`KioskSession` lleva `lastActivityAt` (bump en el endpoint de events) como señal limpia
de staleness para el sweep de abandono.

## API contract `/api/kiosk/*`
Auth de device: header `X-Kiosk-Token` → middleware `requireKioskDevice` (hash lookup,
tenant/location scoping, actualiza lastSeenAt). NO pasa por auth de usuario.
Rate-limited por device. Todas las respuestas ya filtradas (nunca PII completa de otros
clientes; lookup devuelve stub como el customer-portal).

**Orden del flujo (corregido por Innovation): el carro se asegura ANTES de cobrar.**
attach/create reservation → **auto-pick atómico de vehículo** → create checkout-session →
upsell → pago → firma. Nunca se toma dinero sin unidad confirmada (el race clásico de
2 kiosks + counter vendiendo el último carro).

- `POST /api/kiosk/pair` `{pairingCode}` → `{deviceToken, device}` — ÚNICA ruta sin token:
  code hasheado single-use + TTL 10 min + lockout por intentos + guard por IP.
- Toda ruta `/sessions/:id/*` verifica `session.deviceId === device.id` + tenant match
  (un token robado no alcanza sesiones de otro kiosk).
- `POST /api/kiosk/sessions` `{kind}` → crea KioskSession
- `POST /api/kiosk/sessions/:id/events` `{step, event, data}` → telemetría (batch ok,
  cap defensivo del array). **`KioskSession.step` es SOLO telemetría de funnel** — toda
  transición de negocio pasa por checkoutSessionService; al resumir, la verdad se deriva
  del checkout-session, nunca de `step` (cero dual-state-machine drift).
- `POST /api/kiosk/sessions/:id/lookup` `{confirmationNumber | lastName+phone}` → stub
  MÍNIMO (nombre enmascarado, ventana, clase); N intentos por device → lockout + Help
- `POST /api/kiosk/sessions/:id/attach-reservation` `{reservationId}` → valida pickup
  hoy/ventana, status NEW o CONFIRMED (ack de Hector 2026-07-05: paridad con el counter,
  que solo bloquea CANCELLED/NO_SHOW — ID verify + pago gatean igual), misma location →
  resumen + canal + qué prepagó
- `POST /api/kiosk/sessions/:id/verify-id` `{aamvaFields, licensePhoto, selfiePhoto}` →
  responde SOLO booleans de match + razones de fallo (NUNCA ecoa DOB/license de la
  reserva a la pantalla del lobby); edad ≥ mínimo del tenant + expiry; mismatch → escalate
- `POST /api/kiosk/sessions/:id/assign-vehicle` → auto-pick server-side del pool
  AVAILABLE de la clase, **transaccional**: pick + `updateMany` condicional sobre
  `reservation.vehicleId IS NULL` + re-check de conflicto; si pierde el race, cae al
  siguiente candidato. (El cliente nunca escoge unidad; upgrade comprado cambia la clase
  del pick.) Después de esto: `createForReservation` (checkout-session) — el guard
  NO_VEHICLE_ASSIGNED 422 ya no dispara. **Upgrade comprado DESPUÉS del assign** (paso
  upsell): el swap NO puede usar el write condicional sobre NULL — reusar
  `vehicle-swap.service.js` existente (maneja cambios mid-session de forma segura).
- `GET  /api/kiosk/sessions/:id/offers` → paquetes+addons de UpsellRule(channel del
  `Reservation.bookingChannel` normalizado) × AdditionalService × días — precios SIEMPRE
  del backend. OJO producción HOY solo tiene channels WEBSITE/STAFF/FRANCHISE_TL/
  CAR_SHARING/MIGRATION — las reglas EXPEDIA/PRICELINE solo matchean cuando el conector
  TSD/OTA estampe `bookingChannel` normalizado (**acceptance item del conector TSD**);
  mientras tanto el fallback `*` degrada seguro y el admin UI no debe implicar que una
  regla EXPEDIA funciona ya
- `POST /api/kiosk/sessions/:id/offers` `{acceptedServiceIds[]}` → ReservationCharge
  selected (source 'KIOSK_UPSELL') → totales vía syncAgreementCharges
- `POST /api/kiosk/sessions/:id/payment-link` → `{url, qrPayload, paymentId}` extendiendo
  el patrón `paymentRequestToken`/`/customer/pay` existente con opción iPOS HPP;
  `GET .../payment-status` → poll. **PAID se estampa SOLO tras verificación server-side
  del gateway** (patrón `postAuthNetPaymentToReservation`: status check + reference
  dedupe) — nunca del poll del cliente ni de un redirect. Si nombre de la tarjeta ≠
  nombre de la licencia → escalate (vector #1 de fraude en kiosks de rental).
- `GET  /api/kiosk/sessions/:id/agreement` → contrato; `POST .../sign` `{signature}` →
  firma + cascade del checkout-session a CLOSED (métricas, recordMileageEntrySafe,
  vehicle-status-sync a ON_RENT)
- `POST /api/kiosk/sessions/:id/complete` → llaves (**código lockbox se revela SOLO con
  checkout-session CLOSED**), email contrato, link inspección beta.160 opcional
- Walk-up: `GET /api/kiosk/availability?returnAt=` → clases+precio estimado+counts (reusa
  create-options); `POST /api/kiosk/sessions/:id/walkup-reservation` `{vehicleTypeId,
  returnAt, customer{...del scan}}` → POST /api/reservations (source 'KIOSK_WALKUP') +
  pricing quote → mismo flujo (assign-vehicle temprano resuelve el race de clase)
- `POST /api/kiosk/sessions/:id/escalate` `{reason}` → outcome ESCALATED + notificación
  staff (v1); Remote Agent video = Fase F

### Integración con la state machine del checkout-session (anti beta.152)
`ENTRY_REQUIRES` exige `tcCompletedAt`, `inspectionCompletedAt` y `customerSignedAt`
antes de CLOSED, y el kiosk tiene UN paso de firma y CERO paso de inspección:
- **T&C**: el kiosk renderiza el flujo de initials por sección (terms-signing) dentro del
  paso de firma, O usa pre-stamp sancionado (precedente: el loaner path pre-stampa
  `paymentCompletedAt`). Decidir en B1 con diff a la vista; default = renderizar initials.
- **Métricas de checkout sin inspección**: odometer/fuel se estampan desde
  `Vehicle.mileage` + valores de staging del staff (columna del agreement) y SIEMPRE se
  llama `recordMileageEntrySafe` — beta.152 existe porque el cascade cerró sin copiar
  métricas (contratos "-" y gap de mileage). Test de regresión obligatorio.

### Compensación de dinero huérfano (MONEY safety)
Cliente que paga y abandona (o escala) deja sale capturado + hold vivo sin contrato
firmado. **Sweep del worker** (convención del repo: vehicle-status-sweep,
inventory-reconciliation): sesiones IN_PROGRESS con pago y sin firma pasado un TTL →
void/rollback con el patrón exacto de spin-charge + entrada en cola de staff + outcome
ABANDONED (KPIs honestos). El idle-wipe de 2 min del cliente es higiene de UI, no
garantía de servidor.

Admin (auth normal + `requireModuleAccess('kiosk')`):
- `GET/POST /api/kiosk/devices` (+ `POST /:id/revoke`, `POST /:id/pairing-code`)
- `GET /api/kiosk/sessions` (lista + KPIs: completadas/escaladas/abandonadas, attach rate, revenue extras)
- `GET/PUT /api/kiosk/upsell-rules`, `GET/PUT /api/kiosk/packages`

## Frontend
- `/kiosk` (Next.js, mismo repo): KioskShell fullscreen sin AppShell, touch-first,
  i18n en/es existente, idle-reset (30s en DONE, 2 min inactividad → wipe de sesión +
  WELCOME). Pantallas = mockups K1-K10. Device token en localStorage tras pairing.
- Admin: `/kiosks` (devices+sessions), Settings → Upsell catalog & rules. Pantallas A1-A3.
- Nav + MODULE_DEFINITIONS + pathnameToModule('/kiosk*'→kiosk — OJO: la página pública
  del kiosk NO se gatea por usuario; el gate de módulo aplica al admin y al backend).

## Reglas duras que aplican
- **Pago = MONEY**: todo el código de payment-link/Transact lo aprueba Hector línea a
  línea ANTES de mergear. Sandbox iPOS hasta Fase D. El cliente paga en SU teléfono —
  el kiosk nunca captura número de tarjeta.
- Precios SIEMPRE server-side (el AI/UI nunca inventa; lee de offers).
- Migraciones additive-only. Ship scripts con FILES[] explícito.
- El kiosk NO toca access control existente; módulo nuevo default OFF por tenant
  (decisión pendiente de Hector — beta.212 usó default ON).

## Fases de build (cada una = ship script + tests + QA gate)
- **B1 — Backend core**: migración (KioskDevice/KioskSession/UpsellRule) + pairing/
  device-auth middleware (hash + constant-time + lockout) + sessions/lookup/attach +
  assign-vehicle atómico + integración checkout-session (decisión T&C initials vs
  pre-stamp, con diff a la vista) + module key 'kiosk'. Tests: device auth
  (revoked/rotated/expired pairing), lookup scoping/lockout POR DEVICE (columnas
  lookupMisses/lookupLockedUntil — cross-session), session-device binding, race de
  assign-vehicle. NOTA: la regresión anti-beta.152 (métricas del contrato + mileage)
  se MUEVE a B3 — B1 para en la creación del checkout-session, el cascade de cierre
  no existe hasta que B3 implemente /sign y /complete.
- **B2 — Upsell engine**: offers (UpsellRule × AdditionalService × días × canal) +
  packages config + accept→ReservationCharge/sync + validación de serviceIds al guardar
  reglas. Tests canónicos estilo test:fees (Expedia vs Priceline vs walk-up; prepaid
  nunca se ofrece). **Riders del QA de B1**: (a) guard de colisión de pairing-code al
  mintear (regenerar si el hash ya existe en una fila ACTIVE — hoy dos tenants con el
  mismo código de 6 dígitos podrían cruzarse, ~1e-6); (b) ~5 unit tests de
  module-access para el fail-closed de kiosk (no existe suite y la línea es load-bearing);
  (c) limpiar/documentar `pairingAttempts` vestigial.
- **B3 — Kiosk app v1 (sin pago real)**: /kiosk wizard completo K1-K10+K-E con pago
  sandbox + firma + contrato + admin /kiosks (con alerta de heartbeat/offline) +
  Settings Upsell. **Acceptance heredado de B1**: test de regresión anti-beta.152 en el
  cascade de /sign→/complete (métricas del contrato + recordMileageEntrySafe) + la
  notificación de escalación a staff + banner en dashboard (decisión #4 — en B1 quedó
  TODO; la superficie v1 es GET /api/kiosk/sessions?outcome=ESCALATED). Convención de
  cliente: cero input crudo del cliente en telemetría (events.data) ni en
  escalatedReason (botones canónicos — RESUELTO en B3a: enum server-side con 422).
  **Riders del QA de B3a**: (a) test que pinee el resume del /sign tras fallo parcial
  (transition N lanza → retry reanuda sin wedge) — hoy verificado por traza, no por test;
  (b) contrato cliente: /sign tras CLOSED devuelve 409 CHECKOUT_TERMINAL → el wizard
  avanza a /complete (el frontend B3b ya lo implementa — mantenerlo).
  Demo con Manuel (Orlando 1). ID verify v1 = match AAMVA vs reserva
  (selfie se guarda con retención/disclosure definidos; face-match = v2). Tablet
  hardening: kiosk mode pinned/Guided Access. GATE: el downsell (estrategia #4) NO se
  construye sin su propio mockup aprobado por Hector — fuera de B3.
- **B3c — Staff Assist en el kiosk** (pedido de Hector 2026-07-06, smoke iPad; mockup
  K-S1..S3): guest trancado en ID scan → staff se autentica EN el kiosk → teclea el ID a
  mano + foto FRENTE y ATRÁS de la licencia (ambas obligatorias) → bypass auditado del
  scan → la sesión continúa. Diseño: auth staff reusa el **lock-PIN existente**
  (`/lock-pin/verify`) — el kiosk lista staff del tenant (nombres solamente) → pick +
  PIN → endpoint device-authed verifica contra el hash del user (rate-limit 5/min +
  lockout por device, mismo patrón del lookup). El override: guarda campos + fotos
  (patrón de ID photos existente), stampa `idVerifiedAt` con `method: 'STAFF_OVERRIDE'`
  + `staffUserId`, AuditLog, telemetría STAFF_ASSIST, saca la sesión de ESCALATED →
  IN_PROGRESS. **Las reglas NO se relajan**: edad/expiry se validan server-side igual
  (underage = hard stop aunque sea staff). El grant de staff es single-session y expira
  al continuar. Camera fixes iPad/WebKit (beta.288): facingMode frontal en kiosk,
  teardown de stream antes del selfie, upload siempre visible, hint de upload a los 12s.
- **B3d — ID por FOTO + OCR (decisión Hector 2026-07-15, tras re-test iPad: el scan
  pdf417 sigue problemático en tablet)**: el path PRIMARIO de ID pasa a foto del FRENTE
  de la licencia. Flujo: instrucción "aguanta tu ID frente a la cámara" → botón "estoy
  listo" → countdown de 5 segundos (dígitos grandes) → captura del frame crudo → POST
  `/api/kiosk/sessions/:id/id-photo-extract` {photo} → extracción de texto con el patrón
  de **citation-ocr.extract.js** (Claude vision, API key del tenant en Settings + fallback
  ANTHROPIC_API_KEY, modelo haiku default) → pantalla de confirmación al cliente con los
  campos extraídos ("¿Está correcto?") → Confirmar llama al verify-id EXISTENTE con
  fields + licensePhoto (misma validación server-side: name-match vs reserva, edad,
  expiry, DOB plausible; la foto va al profile del cliente vía el write-through existente
  y los datos llenan la reserva) → selfie como hoy. Retake ilimitado visual, extracción
  capeada por sesión (~5 intentos, costo de API) con fallback a staff-assist. El scan de
  barcode queda como opción secundaria (Android kiosks). La extracción es ADVISORY —
  nunca stampa nada; solo verify-id stampa tras confirmar.
- **B3e — Name-mismatch: self-service seguro + staff bypass ligero (aprobado por Hector
  2026-07-15, tras su caso real: licencia FL "PADILLA LUNA HECTOR EDUARDO JR" vs reserva
  "Hector Padilla")**. TRES capas:
  (1) **Matcher por token-subset**: los tokens de la reserva contenidos en los tokens de
  la licencia (orden-agnóstico, sufijos JR/SR/II-IV ignorados, acentos normalizados) =
  MATCH — el caso de Hector pasa sin fricción. Dirección segura: forma corta del booking
  ⊆ nombre legal completo de la licencia; NUNCA al revés con un solo token.
  (2) **Self-service con código**: mismatch real → "¿La reserva está a otro nombre?" →
  código 6 díg. (hasheado, TTL 10 min, 5 intentos → lockout del device) al email/teléfono
  DE LA RESERVA (destino enmascarado en pantalla) → código OK = prueba de posesión del
  booking → el nombre del driver se actualiza AL NOMBRE VERIFICADO DE LA LICENCIA (los
  fields del OCR confirmados — jamás texto libre del guest) con AuditLog (nombre viejo
  preservado) → verify-id re-corre y sigue. OJO diseño: cómo actualizar el nombre sin
  corromper un Customer compartido con otras reservas (analizar convención del counter;
  guard si el customer tiene historial).
  (3) **Staff bypass ligero del name-match**: en la pantalla de mismatch, entrada
  discreta de staff → PIN (reusa el unlock/grant de B3c) → el staff CONFIRMA que verificó
  la licencia físicamente → verify-id re-corre con skip del name-match bajo el grant
  (idVerifyMethod 'STAFF_NAME_OVERRIDE', AuditLog) — SIN re-teclear campos ni re-fotos
  (la licencia ya está OCR-verificada; el staff solo avala el nombre). Edad/expiry siguen
  hard-stop.
- **B3f — Get Help ↔ VozIA embed (handoff 2026-07-19; contrato canónico:
  `voice-ai-customer-service/KIOSK-EMBED.md` v2; lado VozIA TERMINADO y probado)**:
  el botón Get Help abre el chat de VozIA (Chloe) en un iframe overlay
  (`allow="camera; microphone"` obligatorio para video); escalación AI → agente humano
  por chat/video (LiveKit) con CO-PRESENCIA (el agente ve el paso del check-in) y
  comandos del agente al kiosk. Lado kiosk: (1) iframe con
  `?embed=1&kiosk=1&location=<locationId>&res=<RES opcional>&key=<KIOSK_WIDGET_KEY>&
  parentOrigin=<origin>`; (2) listener postMessage con verificación de e.origin —
  identidad de conversación {conversationId, secret} (descartar AL INSTANTE en
  reset/null; secret stale jamás escribe en la conversación del próximo cliente) +
  comandos re-entregados cada ~2s hasta ack (idempotentes por command.id, ack
  `POST /api/conversations/:id/kiosk-ack` header x-conversation-secret); (3)
  co-presencia: en CADA transición de step `POST .../kiosk-state` con ENUMS estrictos
  (find_reservation · verify_identity · license_scan · additional_drivers · upsells ·
  signature · payment · done; errores GLARE_ERROR · SCAN_TIMEOUT · CARD_DECLINED ·
  SIGNATURE_TIMEOUT · ID_MISMATCH · UNKNOWN) — mapping nuestro: LOOKUP/SUMMARY→
  find_reservation, ID foto/scan→license_scan, SELFIE/NAME_UPDATE/STAFF_ASSIST→
  verify_identity, OFFERS→upsells, PAYMENT→payment, SIGN→signature, DONE→done
  (additional_drivers no aplica); (4) comandos: retry_step · skip_step(reason; rechazar
  client-side skip de signature/payment — server también lo rechaza) · restart_flow ·
  show_message · flow_completed→pantalla final; comandos con conversationId ≠ activo →
  descartar; (5) video = 100% del iframe; (6) config server-provided
  `voziaKioskConfig` por tenant {host, widgetKey} expuesta en el bootstrap del device —
  **FAIL-SOFT/DARK: sin config, Get Help mantiene el comportamiento actual** (escalate +
  staff). El kiosk NO persiste nada del cliente (iframe memory-only, auto-reset 90s).
  El 🔧 staff-assist local queda intacto (canal paralelo). Infra pendiente de Hector:
  hosting prod de VozIA antes del go-live.
- **B3g — Smart lookup de confirmación (S30 handoff 2026-07-19; problema: OTA da
  `ZE40809640BA`, el import lo tiene `TL-ZE40809640BA` u otro formato por booking-source →
  exact-match falla y mata el check-in autónomo)**. EL MATCHER LO ENTREGA S30/VozIA:
  `backend/src/lib/reservation-smart-match.js` (`generateCodeVariants(raw)` +
  `smartMatchReservation({code?, name?, dateWindow?, tenantId})` → candidatos rankeados
  `{reservation, matchType:'exact'|'variant'|'name', confidence}`, tenant-scoped, read-only).
  **REGLA DURA: el kiosk NO inventa su propio normalizador** (una sola fuente de verdad,
  como vehicle-status-sync). Lado kiosk: (1) `lookupReservation` usa el matcher — exact
  (como hoy) → variantes → fallback por nombre+fecha de pickup; **runtime interino
  EXACT-ONLY** hasta que el lib esté en el árbol (cero fork; un solo wire-in point cuando
  llegue; mock del contrato SOLO en tests). (2) Desambiguación: varios candidatos → pedir
  UN dato más (fecha pickup o apellido completo), NUNCA lista de reservas. (3) PRIVACIDAD:
  match no-exact-por-código → solo datos ENMASCARADOS pre-verify ("Reserva de Juan P*** ·
  pickup mañana · MCO"); jamás número completo/phone/email/vehículo pre-verify; el gate
  `idVerifiedAt` NO se relaja NADA (extiende el stub enmascarado de B1). (4) Anti-enum: YA
  existe `MAX_LOOKUP_MISSES=5` per-DEVICE (sobrevive resets, más fuerte que per-session —
  B1); el lookup por NOMBRE alimenta el MISMO lockout (mayor riesgo de enumeración); al cap
  → Get Help/staff. (5) Telemetría: `matchType` (exact/variant/name/fail) por lookup para
  afinar patrones con data real. (6) Get Help ya monta VozIA con `res=` vacío (B3f) — Chloe
  tendrá el MISMO matcher vía su service account, el guest no repite la pelea.
  **Coordinación:** el kiosk produce sus NECESIDADES de contrato para S30 (qué shape/campos
  consume) → informa el freeze del contrato; patrones de variantes nuevos que descubramos →
  al doc compartido, NO forks locales; additive, read-only, tenant-scoped.
- **B4 — Walk-up**: availability + walkup-reservation + quote (K9). Tests: no crea
  reserva sin clase disponible; precios = pricing service.
- **B5 — Pago real (MONEY, gate Hector doble)**: (pre-código) resolver contra docs iPOS
  el token del HPP para deposit-PreAuth + card-on-file **y la semántica void-vs-refund en
  transacciones SETTLED** (lección beta.155: los voids enmascaraban refunds rotos) — el
  sweep de dinero huérfano debe branchear void→refund según settlement; (código) extender
  paymentRequestToken//customer/pay con opción iPOS HPP + rollback patrón spin-charge +
  verificación server-side → PAID + **sweep del worker para dinero huérfano** +
  **sweep de retención de fotos de ID/selfie** (rider del QA de B3a: PII at rest sin
  política de expiración — NO puede caerse de este checklist). OJO
  presupuesto de rate-limit: el guard kiosk-device es 120/min POR IP y todas las tablets
  de un local comparten NAT — el polling de payment-status debe caber ahí (re-presupuestar
  o mover el poll a intervalo largo/webhook). Piloto horas valle con staff al lado.
- **B6 — Telemetría/dashboard**: KPIs attach-rate + funnel por paso (A1/A3 completos).
  **Decisión Hector 2026-07-05**: los upsells del kiosk SÍ cuentan en el serviceRevenue
  del agreement (reportes honestos, incluir aquí con cuidado — hoy rental-agreements
  filtra source==='ADDITIONAL_SERVICE' y no ve KIOSK_UPSELL) pero NUNCA generan comisión
  de empleado (no hay vendedor). Riders de B2→B3/B4: soporte completo de linked fees
  (reemplaza la exclusión fail-closed) + guard de acceptOffers post-pago (a más tardar B5)
  + extraer serviceOfferLine/computeAdditionalServiceLine a lib pura compartida cuando se
  toque booking-engine.
- **Fase E/F/G del plan de junio** (AI conversacional, Remote Agent video, hardware v2)
  quedan detrás del piloto.

## ⚠️ Nota de DEPLOY — migración editada in-place (para el ship script del kiosk)
`20260705_kiosk_core/migration.sql` se extendió DESPUÉS de su creación (lookupMisses/
lookupLockedUntil/idVerifiedAt). Si alguna DB longeva (staging o un prod que recibió B1
antes) ya la tiene registrada en `_prisma_migrations`, `prisma migrate deploy` la SALTA
— esa DB solo recibe las columnas nuevas pegando los `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS` guardeados a mano por el puerto de SESIÓN 5432. Incluir esta línea en las notas
post-deploy del ship script.

## ⚠️ Coordinación de merge pendiente — fuel v2 (2026-07-05)
`fix/v2-cascade-fuel-reading` (sobre release@0603e29, PENDIENTE aprobación de Hector —
toca el checkout close path) añade `recordFuelReadingSafe` a la cascada CLOSED del v2 en
`checkout-session.service.js`. El kiosk NO modificó ese archivo (solo lo consume) → merge
limpio esperado. PERO al integrar: correr `npm run test:kiosk` — los stubs in-memory de
los tests del kiosk ejercitan la cascada real y puede que necesiten un stub/noop de
`vehicleFuelReading`/`recordFuelReadingSafe` para la lectura nueva. Bonus: con ese fix,
los checkouts del kiosk también quedan con fuel timeline completo. Backfill histórico de
fuel v2 = pendiente opcional de aquella rama.

## ⚠️ Coordinación de merge pendiente — tolls (2026-07-05)
La sesión aparte del fix de precheckin tolls (task_36eac013, PENDIENTE aprobación de
Hector — es código de dinero) extrajo el filtro de sources a
`backend/src/modules/tolls/tolls-billing-policy.service.js`:
`SERVICE_CHARGE_SOURCES = ['ADDITIONAL_SERVICE','ADDITIONAL_SERVICE_PRECHECKIN','SERVICE']`
+ `selectedServiceIdsFromCharges(charges)`. Nuestro B2 añadió 'KIOSK_UPSELL' al helper
`tollPackageCandidateServiceIds` INLINE en tolls.service.js → **conflicto seguro al
integrar**. Al mergear (DESPUÉS de que Hector apruebe aquel fix):
1. Añadir `'KIOSK_UPSELL'` a `SERVICE_CHARGE_SOURCES` en tolls-billing-policy.service.js
   (único lugar; el comentario del archivo lo exige para todo source nuevo).
2. Resolver tolls.service.js a favor de `selectedServiceIdsFromCharges()` — NO restaurar
   el filtro inline ni nuestro `tollPackageCandidateServiceIds` (borrar nuestro helper y
   migrar su test).
3. Añadir test en tolls-billing-policy.test.mjs: cargo source 'KIOSK_UPSELL' → cuenta
   para coverage (patrón del test de precheckin).
4. ✅ YA VERIFICADO (2026-07-05): el kiosk escribe sourceRefId = AdditionalService.id
   (kiosk-offers.service.js:319) — compatible con el count del policy.
Regla dura: toll billing = código de dinero → diff mínimo + aprobación explícita de
Hector antes de deploy.

## Acks de producto B3c/B3d (Hector, 2026-07-15)
- **A1**: staff-verify SIN name-match automático (paridad counter + más controles: PIN
  bcrypt, 2 fotos obligatorias, doble AuditLog, STAFF_OVERRIDE persistido; edad/expiry
  siguen hard-stop).
- **A2**: selfie se SALTA en sesiones STAFF_OVERRIDE (empleado presente autenticado >
  liveness de selfie); el disclosure no promete selfie en ese path.
- **A3**: foto de licencia → API de Anthropic para extracción APROBADO (precedente
  citation-OCR, misma key del tenant; cero PII en telemetría/logs; disclosure del paso
  de ID menciona procesamiento automático del documento).

## Decisiones (Hector, 2026-07-04; sign-offs: Graphic Design OK + Innovation OK)
1. **Mockup Rev 2 APROBADO** — gate de build cumplido; arranca B1. (Downsell K5b tendrá
   su propio mockup-gate antes de implementarse.)
2. **Módulo kiosk default OFF** por tenant (opt-in).
3. **Walk-up requiere teléfono + email** obligatorios.
4. **Escalación v1 → staff del location** (patrón de notificaciones existente + banner
   en dashboard).
5. Depósito (ACTUALIZADO Hector 2026-07-16): el kiosk FUERZA un depósito vía
   `kioskDepositConfig` por location (ej. $250 default) cuando la reserva trae
   `securityDepositAmount` = 0; si la reserva ya trae depósito, ese gana (paridad counter).
   Se construye con B5.
6. **B5 GREENLIT (Hector 2026-07-16)** tras validar en prod que taxes cuadran (verificado:
   tax = 11.5% del subtotal taxable en el motor real; la prueba RES-480304 dio $1.49 en
   $12.99 toll — correcta, base $0 solo porque dailyRate era 0). PAGO REAL iPOS con QR.
   Gate #1 (PRE-CÓDIGO, para OK de Hector antes de escribir nada): verificar contra docs
   iPOSpays HPP — (a) el token del HPP sirve para deposit PreAuth (mismo orden rollback/
   void que spin-charge) Y card-on-file post-renta (tolls/daños/citations); (b) void-vs-
   refund en SETTLED (lección beta.155 — el sweep de dinero huérfano branchea según
   settlement). Gate #2: review línea por línea del diff. Extiende paymentRequestToken/
   /customer/pay con opción iPOS HPP (nunca form propio). Incluye: deposit auth por
   kioskDepositConfig + captura de extras + webhook/poll → PAID (verificación server-side)
   + sweep de dinero huérfano + retention sweep de fotos ID (rider pendiente de B3a).
6. T&C en kiosk: renderizar initials por sección (recomendado) — decisión final en B1
   con diff a la vista.
