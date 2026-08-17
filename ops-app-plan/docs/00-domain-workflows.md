# 00 — Flujos de dominio que RideOps cubre (verificado contra main @ 6d8173c)

> Derivado del código real del backend. Complementa [00-REGROUND.md](../00-REGROUND.md) y
> [PROJECT_PLAN.md](../PROJECT_PLAN.md); toda referencia es `path:línea` en `backend/`.

## 1. Flujo de checkout — la máquina de 11 estados

Fuente única: `src/modules/checkout-session/state-machine.js`.

### 1.1 Estados y grafo

`CHECKOUT_STEPS` (state-machine.js:41-53), transiciones lineales estrictas (`FORWARD`,
:59-71). `CLOSED` y `CANCELLED` son terminales (:55); cualquier estado no terminal puede ir
a `CANCELLED` (`canCancelFrom`, :99-101). Estado fuera de orden ⇒ 409.

| # | Paso | Significado (comentarios de schema.prisma:5053-5065) |
|---|------|------|
| 1 | `CONFIRMING` | Agente verifica cliente/vehículo/declined-insurance |
| 2 | `TC_PENDING` | Cliente firmando T&C en su teléfono |
| 3 | `TC_SIGNED` | Intermedio antes de pago |
| 4 | `PAYMENT_PENDING` | Terminal Spin espera tap/insert |
| 5 | `PAID` | Sale + preauth + tokenize completos |
| 6 | `INSPECTION_HANDOFF` | QR escaneado para continuar en móvil |
| 7 | `INSPECTION_IN_PROGRESS` | Fotos/métricas en el móvil |
| 8 | `CUSTOMER_SIGN_PENDING` | Teléfono en manos del cliente para firmar |
| 9 | `FINALIZING` | Generando PDF, email |
| 10 | `CLOSED` | Terminal feliz |
| 11 | `CANCELLED` | Aborto explícito |

### 1.2 Entry guards (state-machine.js:77-82)

Campo que DEBE estar estampado en la fila `CheckoutSession` antes de aceptar la transición
de entrada; si falta ⇒ 409 `ENTRY_GUARD` (checkout-session.service.js:393-400):

- `TC_SIGNED` ← `tcCompletedAt`
- `PAID` ← `paymentCompletedAt`
- `CUSTOMER_SIGN_PENDING` ← `inspectionCompletedAt`
- `CLOSED` ← `customerSignedAt`

Los stamps y la transición son llamadas separadas: los side-effects estampan
(`stampSideEffect`, service:621-645, campos permitidos: los 4 de arriba) y la superficie
que renderiza dispara `POST /:id/transition`.

### 1.3 Quién ejecuta cada transición hoy (4 superficies)

- **Mostrador web (wizard del agente)** — dispara `POST /api/checkout-sessions/:id/transition`
  con identidad de usuario (`actorUserId` = req.user.id, routes:84-97). Auto-advance del
  frontend con guard anti-doble-click; el 409 sigue siendo la red (service:380-391).
- **Teléfono del cliente (T&C)** — token `TERMS_SIGNING` (QR, `POST /:id/terms-token`,
  routes:144-155); el flujo público de firma estampa `tcCompletedAt`
  (terms-signing.service.js:168). El agente/wizard hace la transición a `TC_SIGNED`.
- **Pago** — `POST /:id/hold-deposit` (Spin preauth) estampa `paymentCompletedAt`
  (routes:261-281); igual `record-manual-deposit` (routes:309-331). `charge-sale`
  deliberadamente NO estampa (routes:239-258). Con eso el wizard avanza a `PAID`.
- **Mobile-inspection (teléfono del agente)** — token `MOBILE_INSPECTION`; al completar
  estampa `inspectionCompletedAt` **y** `customerSignedAt` en un solo write
  (mobile-inspection.service.js:265-281), y el wizard de escritorio cascadea
  `INSPECTION_HANDOFF → … → CLOSED` solo (comentario :209-219).
- **Kiosk** — cuarta superficie; su `sign` recorre TODAS las transiciones restantes hasta
  `CLOSED` en loop secuencial sin transacción (kiosk-checkout.service.js:764-775 según
  REGROUND §2); 409 `CHECKOUT_TERMINAL` si ya es terminal (kiosk-checkout.service.js:690,825).

RideOps será la superficie #4-bis usando el router autenticado, nunca el de kiosk (ADR / REGROUND §2).

### 1.4 Guards al crear/reanudar sesión (`createForReservation`, service:109-227)

Idempotente por `reservationId @unique` (schema.prisma:5069). En orden:
1. 404 si no existe la reserva; 422 `NO_VEHICLE_ASSIGNED` sin vehículo (:128-134).
2. 409 `VEHICLE_CONFLICT` si el vehículo está en otro rental abierto (:136-147; re-chequeado
   en finalize, :474-488, y ahí falla el finalize "loudly", :562-570).
3. Gates por ubicación (`ensureCheckoutGates`, :67-101): 422 `PRECHECKIN_REQUIRED` si
   `requirePrecheckinBeforeCheckout` y no hay `customerInfoCompletedAt`; 422 `AGE_RULES_*`
   si las reglas de edad bloquean. Se re-corren al CLOSED (:473).
4. 409 `SESSION_TERMINAL` si ya existe sesión terminal (:155-161).
5. Auto-crea el `RentalAgreement` si falta (:194, `ensureAgreementExists` :238-274 —
   fallo ⇒ `AGREEMENT_AUTO_CREATE_FAILED`).
6. Loaner (`DEALERSHIP_LOANER`): pre-estampa `paymentCompletedAt` para saltar el paso de
   pago (:214-220).

Al transicionar a `CLOSED` (service:437-575): email del contrato fire-and-forget
(`maybeSendFinalizeEmail` :589-613, guard `autoEmailedAt`), reserva → `CHECKED_OUT`,
agreement → `FINALIZED` (+ copia odómetro/fuel de la inspección a `odometerOut/fuelOut`,
:498-526), vehículo → ON_RENT (`syncVehicleStatusForReservation` :548), LoanerAgreement
DRAFT→ACTIVE (:530-533), mileage history (:536-546), audit log (:551-557).

### 1.5 Endpoints (`checkout-session.routes.js`; montaje main.js:359 bajo
`requireAuth + tenantRateLimit + requireModuleAccess('reservations')`)

| Endpoint | Línea | Nota |
|---|---|---|
| `POST /api/checkout-sessions` | :33 | body `{reservationId}`; 201 |
| `GET /:id` | :51 | lectura/polling |
| `GET /by-reservation/:reservationId` | :66 | fuente de verdad del wizard; self-heal tenantId/agreementId (service:282-359) |
| `POST /:id/transition` | :84 | `{toStep, metadata?}` |
| `POST /:id/stamp` | :106 | `{field, value?}` — solo los 4 side-effects |
| `POST /:id/customer-signature` | :125 | firma en escritorio; estampa `customerSignedAt` (service:655-692) |
| `POST /:id/terms-token` | :144 | QR `TERMS_SIGNING`, TTL 15 min |
| `POST /:id/handoff-token` | :161 | QR `MOBILE_INSPECTION`, TTL 15 min |
| `POST /:id/send-customer-inspection` | :182 | link 24h por email (tenant setting) |
| `POST /:id/vehicle` | :201 | swap atómico; rechaza pasado `INSPECTION_IN_PROGRESS` (vehicle-swap.service.js:48) |
| `POST /:id/charge` | :223 | legacy one-shot sale+preauth |
| `POST /:id/charge-sale` | :246 | two-tap 3a; NO estampa payment |
| `POST /:id/hold-deposit` | :269 | two-tap 3b; estampa `paymentCompletedAt` |
| `POST /:id/record-manual-payment` | :291 | failsafe CASH/CHECK/CARD/OTHER |
| `POST /:id/record-manual-deposit` | :316 | failsafe; `reason` obligatorio; estampa payment |
| `GET /:id/terminal-status` | :339 | poll de terminal Spin `{online,message,raw}` |
| `POST /:id/declined-insurance` | :362 | flag para addendum en T&C/PDF |
| `POST /:id/abandon` | :380 | Save & pause del agente |
| `GET /api/public/checkout-handoff/:token` | :398-407 | intercambio público (main.js:360) |

Minteo de tokens (`mintHandoffToken`, service:700-771): idempotente dentro del TTL — reusa
el token vigente si le quedan >2 min (:717-734); TTL 15 min salvo `CUSTOMER_INSPECTION`
(24h, :739). El exchange público es **tolerante a reload**: consumible hasta `expiresAt`,
`consumedAt` solo registra primer uso (:792-806).

## 2. Flujo de inspección móvil (handoff `MOBILE_INSPECTION`)

Módulo: `src/modules/checkout-session/mobile-inspection.{routes,service}.js`. Router
**público** montado en `/api/mobile-inspection` (main.js:367) — el token ES la auth; body
limit propio de 15 MB para data-URLs de fotos (routes:21).

- **Validación de token** (`loadToken`, service:46-69): 410 `TOKEN_INVALID` /
  `TOKEN_WRONG_KIND` / `TOKEN_EXPIRED` / `TOKEN_CONSUMED`; 409 si la reserva no tiene
  agreement. OJO: aquí `consumedAt` SÍ invalida — el token se consume en `complete()`
  (:282-284), no en el exchange; hasta entonces fotos y GET pueden repetirse.
- **`GET /:token`** (routes:37) → `{reservationNumber, agreementNumber, vehicle,
  angles[8]{key,label,captured}, expiresAt}` (service:118-143). Los 8 ángulos canónicos:
  front, rear, left, right, front_seat, rear_seat, dash, trunk (service:35-44).
- **`POST /:token/photo`** (routes:48) body `{angleKey, photoDataUrl, notes?}`; upsert por
  key en `RentalAgreementInspection.photosJson` (fase CHECKOUT, única por agreement,
  service:145-179); crea la fila al primer photo y estampa `actorUserId` = quien minteó el
  token (atribución de comisión, :85-116). Respuesta `{angleKey, captured:true}`.
- **`POST /:token/complete`** (routes:66) body `{signatureDataUrl?, signerName?, odometer?,
  fuelLevel?, cleanliness?, notes?}`. Requiere fotos con mínimo front+rear
  (`REQUIRED_ANGLES_MISSING`, service:199-207). En una transacción (:251-313):
  odómetro/fuel/notas en la inspección; `inspectionCompletedAt` (+`customerSignedAt` si hay
  firma >200 chars) en la CheckoutSession + evento `INSPECTION_COMPLETED_VIA_MOBILE`;
  consume el token; firma → `tcSignature*` del agreement (:293-303); cleanliness 1..5
  write-through solo si la columna estaba null (:236-249, 306-311). Respuesta
  `{ok, photoCount, hasSignature}`.

Implicación RideOps: la captura nativa reemplaza esta página web, pero el contrato del
backend es este; la bandeja offline choca con el TTL de 15 min (spike M0-1b) y con el
consumo del token en `complete`.

## 3. Dashboard de employee-app — 9 colas + 11 métricas

`GET /api/employee-app/dashboard[?q=]` — main.js:236 (`requireAuth + tenantRateLimit +
requireModuleAccess('employeeApp')`), y `requireRole('ADMIN','OPS','AGENT')` en el router
(employee-app.routes.js:7-17). Todo sale de `employee-app.service.js:getDashboard`
(:184-498) en un solo `Promise.all`. Scope: tenant (:5-9) + programa del empleado
(`reservationProgramWhereForScope`, :200-207 — para RENTAL_ONLY las colas loaner devuelven
vacío por contradicción); `loanerWhere` = scope + `workflowMode: 'DEALERSHIP_LOANER'`
(:208-211). Cada cola `take: 8`; búsqueda `take: 12`.

| Cola | Criterio (línea) |
|---|---|
| `precheckin` | status NEW/CONFIRMED y (`customerInfoCompletedAt` ≠ null O `customerInfoToken` ≠ null) — pre-checkin enviado o completado (:235-247) |
| `checkout` | NEW/CONFIRMED con `pickupAt` entre hoy-00:00 y +72h, asc (:248-257) |
| `returns` | CHECKED_OUT con `returnAt` entre hoy-00:00 y +72h (:258-267) |
| `active` | CHECKED_OUT (todas), orden `returnAt` asc (:268-276) |
| `loanerReady` | loaner NEW/CONFIRMED con `readyForPickupAt` ≠ null (:277-286) |
| `loanerAdvisorFollowup` | loaner NEW/CONFIRMED con: packet sin completar, O sin ready y `estimatedServiceCompletionAt` vencido, O billing DENIED (:287-300) |
| `loanerBillingReview` | loaner no cancelado, `loanerBillingMode` ∈ CUSTOMER_PAY/WARRANTY/INSURANCE y `loanerBillingStatus` ≠ SETTLED (:301-311) |
| `loanerReturns` | loaner CHECKED_OUT con `returnAt` ≤ +72h (:312-321) |
| `issueEscalations` | `TripIncident` OPEN/UNDER_REVIEW del tenant (:322-333), shape `incidentCard` (:124-174) |

Métricas (`counts[0..10]` :343-391 → nombres :472-484): `openReservations` (NEW/CONFIRMED),
`activeRentals` (CHECKED_OUT), `precheckinQueue` (criterio de la cola), `readyForPickup`
(`readyForPickupAt` ≠ null, NEW/CONFIRMED — sin filtro loaner), `dueBackToday`
(CHECKED_OUT con returnAt hoy), `loanerOpen` (NEW/CONFIRMED/CHECKED_OUT loaner),
`loanerReady`, `loanerBillingAttention`, `loanerOverdue` (loaner CHECKED_OUT con
`returnAt < now`), `issueOpen`, `issueUnderReview`.

Payload completo (:451-497): `{ query, self: { profile (id, fullName, email, role,
isActive, commissionPlan), commissions (monthKey, commissionAmount, agreements, pending,
approved, paid, recent[12]) }, metrics(11), queues(9), searchResults }`. Las cards de
reserva usan `reservationCard` (:66-122) — ver DTO en 02-flutter-blueprint.

## 4. Flujo de return / check-in

Endpoint: `POST /api/rental-agreements/:id/checkin-close`
(rental-agreements.routes.js:425-428) → `closeAgreementWithCheckinFees`
(`src/modules/rental-agreements/checkin-close.service.js:85-516`). Payload:
`{ odometerIn, fuelIn (0..1), cleanlinessIn (1..5), smokingDetected, signerName,
signatureDataUrl, manualPayment?, returnedAt?, waiveLateFee? }`.

Pasos (en el orden real del código):
1. **Métricas** en el agreement (`odometerIn/fuelIn/cleanlinessIn`, :129-140) + historial
   de millas y fuel del vehículo, best-effort (:148-175).
2. **Fee engine** (`feeEngineService.computeCheckinFees`, :229-249): EXCESS_MILEAGE,
   FUEL_REFILL, CLEANING_*, SMOKING, LATE_RETURN; persiste `RentalAgreementCharge` con
   `source='FEE_ENGINE_CHECKIN'`. `returnedAt` parseado en TZ del tenant (:203-206);
   backdate validado por rol (`validateBackdatedReturn`, :210-219, 403 si no procede);
   `waiveLateFee` salta el late fee con rastro de auditoría (:227,241). Millas incluidas:
   snapshot de regla de depósito → vehicleType (unlimited/freeMilesPerDay) → 200/día
   (:554-596); capacidad de tanque real o fallback 15 gal (:531-552).
3. **Pago manual** opcional después de fees (:255-261, `applyManualPayment` :598-708 —
   espejo a `ReservationPayment`, recomputa `paidAmount/balance` excluyendo AUTH_HOLD).
4. **Ruteo por balance** (ε = $0.01, :279-285):
   - `balance ≤ ε` → agreement `CLOSED` + locked + `returnedAt`; reserva `CHECKED_IN`;
     LoanerAgreement → CLOSED; vehículo → AVAILABLE; **email recibo pagado**
     (`sendReceiptPaidInFull`, :362, en checkin-emails.service.js) (:317-371).
   - `balance > ε` → reserva `CHECKED_IN_UNPAID`; política de autocharge del tenant
     (AUTO + delayHours, default 24h, o MANUAL, :378-394); job BullMQ idempotente
     `autocharge-<resId>-<ts>` con enqueue acotado a 2s (:415-441); vehículo → AVAILABLE;
     **email invoice con aviso de card-on-file** (`sendInvoiceAfterCheckin`, :455) (:372-464).
   - En ambas ramas, `locationConfig.checkinEmailDelayHours > 0` difiere el email al
     scheduler, que decide recibo-vs-invoice según el balance AL MOMENTO del envío (:57-68,
     314-315).
5. **Audit log** `STATUS_CHANGE CHECKED_OUT → CHECKED_IN[_UNPAID]` con breakdown de fees y
   rastro de backdate (:471-502).

El recibo/invoice lleva branding del tenant resuelto en servidor
(checkin-emails.service.js:115-125; REGROUND §4) — RideOps no debe hardcodear marca.

## 5. Roles y RBAC

- **Roles** (`enum UserRole`, prisma/schema.prisma:89-94): `SUPER_ADMIN`, `ADMIN`, `OPS`,
  `AGENT`. (Los clientes usan JWT `role:'GUEST'` firmado aparte — auth.service.js:63-75 —
  irrelevante para RideOps.) El dashboard exige ADMIN/OPS/AGENT
  (employee-app.routes.js:7); SUPER_ADMIN bypassa `requireRole` y `requireModuleAccess`
  (middleware/auth.js:88-99, 117).
- **`requireAuth`** (middleware/auth.js:21-86): Bearer JWT + hydrate de sesión; gate de
  contraseña (`PASSWORD_CHANGE_REQUIRED`, allowlist de 3 endpoints, :15-19, 49-60);
  selector de ubicación `x-view-location` aplicado aquí (:71-78, 403 duro **sin `code`**).
- **`requireModuleAccess(key)`** (:114-123): niega solo con `=== false` en
  `req.user.moduleAccess` (mapa emitido por `buildSessionUser`,
  auth.service.js:87-115). **`requireCapability(key)`** (:139-148) es la variante
  fail-closed (exige `true`) — el comentario cita explícitamente "a parallel workstream is
  minting sessions for the employee mobile app": para dinero, ausencia = NO.
- **Módulos** (`MODULE_KEYS`, lib/module-access.js:6-46). Los que gatean superficies de la
  app de staff:
  - `employeeApp` → `/api/employee-app/*` (main.js:236) — el dashboard/colas.
  - `reservations` → `/api/checkout-sessions/*` (main.js:359) y el grueso de
    reservas/agreements (incluye checkin-close).
  - `paymentActions` → capability de dinero (charge card-on-file, capture/release de
    depósito, refund, void, save-card; module-access.js:9-27). Record-only (pagos manuales)
    deliberadamente NO gateado para no trabar el mostrador.
  - `issueCenter`, `loaner`, `vehicles`, `customers`, `dashboard` según pantallas que la
    app exponga; `kiosk` solo para el router admin del kiosco (main.js:314).
- La UI puede leer `user.moduleAccess` para esconder navegación, pero el DoD #4 exige
  verificar contra la API: los 403 de módulo llevan mensaje legible y sin código de máquina
  (`moduleDeniedMessage`, auth.js:108-112).
