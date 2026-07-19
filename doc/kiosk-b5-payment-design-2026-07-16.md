# Ride Kiosk — Fase B5 Payment Design + Gate (2026-07-16)

Status: **PRE-CODE. MONEY.** Requiere aprobación línea por línea de Hector antes de
implementar. Gate #1 = este doc; Gate #2 = review del diff. Ninguna línea de código de
pago escrita — todos los archivos payment-gateway/spin/ipos/checkout-session se abrieron
READ-ONLY.

## 0. Scope
Reemplazar el pago demo del kiosk (`POST /api/kiosk/sessions/:id/sandbox-payment`, que
solo stampa `paymentCompletedAt` detrás de `KIOSK_PAYMENT_SANDBOX`, fail-closed en prod)
por un flujo real: QR en pantalla → **iPOSpays Hosted Payment Page (HPP)** que el cliente
paga en su teléfono → verificación server-side → deposit PreAuth → card-on-file →
sweep de dinero huérfano.

## 1. Respuestas del gate (G1–G4)

**G1 — Token del HPP → deposit PreAuth separado con el mismo void-rollback: SÍ
arquitectónicamente, con UNA dependencia de vendor por confirmar.** El HPP `Sale`
(transactionType 1) con `preferences.requestCardToken=true` devuelve `cardToken` +
`consumerId`. El counter YA hace el patrón de dos operaciones que B5 necesita, y la
segunda NO es otra sesión HPP: `spin-charge` corre `runSale` (captura el token iPOS) →
`runDepositHold` → `iposTransactClient.preAuthDeposit({ cardToken })` (Transact type 5,
CNP, sin segundo tap) con rollback void-sale-si-preauth-falla. B5 espeja esto: **un HPP
Sale para los extras, luego un Transact PreAuth para el depósito con el `cardToken` del
HPP.** Sin segunda sesión HPP ni segunda interacción del cliente.
→ **UNKNOWN (rep de Hector):** confirmar que el `cardToken` del HPP es el mismo tipo de
iPOS Token que acepta la Transact API (los docs solo prometen portabilidad SPIn→Transact;
el canal Transact/card-on-file tiene que estar provisto en el TPN — por eso hoy existe
`IPOS_FORCE_CARD_PRESENT_DEPOSIT` y aparece `DEJ_ERR_003`). Si NO son compatibles, el
depósito tiene que ser una **sesión HPP PreAuth separada** (segundo QR — UX peor).

**G2 — Token del HPP para card-on-file post-renta (tolls/daños/citations): SÍ si la
portabilidad de G1 se sostiene — MISMA dependencia.** `chargeWithToken` (Transact type 1)
ya potencia el card-on-file del counter. Si el `cardToken` del HPP es Transact-usable, el
kiosk tiene **paridad completa** (persiste a `RentalAgreement.cardOnFileToken/...`). **Si
NO, el kiosk PIERDE card-on-file** — tolls/daños/citations post-checkout no se auto-cobran.
Regresión operativa real vs counter → decisión explícita de Hector.

**G3 — Void vs refund en SETTLED: el sweep DEBE branchear, y el brazo de refund NO existe.**
Hoy `iposTransactClient` tiene `voidByRrn` pero **ningún método de refund/return**. Los
voids solo funcionan pre-settlement; ya settleado, hay que hacer refund (exactamente la
forma de beta.155 — los refunds settled de Auth.Net fallaban en silencio y los voids lo
enmascaraban). **Hallazgo crítico:** el `voidStalePreauths()` actual solo MARCA
`depositHoldVoidedAt`, nunca llama al gateway ("Spin integration lands in Phase 2"). Así
que el sweep de B5 sería **el PRIMER void/refund real de gateway en la app** — sube las
apuestas. Debe: consultar settlement (`queryPaymentStatus`), branchear unsettled→void /
settled→refund, añadir un `refundByRrn` NUEVO y testeado, ser idempotente + dejar fila en
cola de staff ante cualquier fallo (nunca dejar fondos varados en silencio).

**G4 — PCI SAQ-A confirmado; verificar PAID por `queryPaymentStatus` server-side, nunca
el redirect.** El cliente teclea la tarjeta solo en la página hosted de iPOS; el kiosk/
servidores nunca tocan el PAN → SAQ-A. Canales de confirmación: webhook `notifyByPOST`,
redirect `notifyByRedirect`, y **`queryPaymentStatus` keyed por `tpn` +
`transactionReferenceId`**. PAID se stampa SOLO tras un check server-side de
`queryPaymentStatus` (espejo de `postAuthNetPaymentToReservation`). El webhook y el
redirect son triggers, no prueba. OJO: `notifyByPOST` solo trae `authHeader` compartido,
**sin HMAC** → el re-fetch de `queryPaymentStatus` es obligatorio.

Endpoints confirmados: crear HPP = `POST /api/v1/external-payment-transaction` → response
`information` = la URL (QR-encodable); status = `GET .../v1/queryPaymentStatus`. Auth =
header `token`, reusable de `ipos-auth.js`.

## 2. Decisión: EXTENDER, no construir página paralela
Reusar el CONTRATO server del `paymentRequestToken` + `/customer/pay` (token model,
`currentGateway()` → añadir branch `ipos`, dedupe por `ReservationPayment.reference`,
verify-before-post de `postAuthNetPaymentToReservation`). El teléfono del cliente abre la
URL hosted de iPOS DIRECTO desde el QR, NO nuestro `/customer/pay`. Reference nueva:
**`IPOS:<transactionReferenceId>`**, deduped igual. Página de tarjeta = HPP de iPOS
SIEMPRE (nunca form propio).

## 3. Endpoints kiosk nuevos (reemplazan sandbox-payment)
- **`POST /api/kiosk/sessions/:id/payment-link`** → `{ url, qrPayload, paymentId }`.
  Monto 100% server-side (Σ cargos owed − paidAmount, nunca del cliente). Mint de
  `transactionReferenceId` (idempotency key, alfanumérico ≤20 — el gateway rechaza guiones).
  HPP create con `requestCardToken=true` + webhook + redirect. Idempotente antes de PAID.
- **`GET /api/kiosk/sessions/:id/payment-status`** → `{ status, paidAmount?, last4?,
  depositHeld? }`. Llama `queryPaymentStatus` server-side; al aprobar+capturar corre
  verify-and-post + depósito, stampa `paymentCompletedAt`. **OJO rate budget:** guard
  120/min por IP + NAT compartido → poll a intervalo largo (4–6s con backoff), webhook
  como trigger primario. Re-presupuestar antes de codear.
- **`POST /api/kiosk/payment-webhook/ipos`** (tokenless, guard por IP). Verifica
  `authHeader`, **re-verifica con `queryPaymentStatus`**, corre el mismo verify-and-post,
  idempotente por reference.

## 4. PAID stamping (espejo de postAuthNetPaymentToReservation)
1. `reference = IPOS:<ref>`; si ya existe ReservationPayment con esa reference → dup,
   return (idempotente). 2. `queryPaymentStatus` → exigir approved/captured. 3. postPayment
   canónico (recomputa balance). 4. Persistir cardOnFile* (dep. G2). 5. Deposit PreAuth
   (§5). 6. Stampar `paymentCompletedAt` solo tras 3–5.

## 5. Depósito (kioskDepositConfig por location + reservation-wins)
Orden de resolución (extiende `resolveDepositAmount`): (1) `securityDepositAmount` de la
reserva — GANA si >0; (2) Σ cargos SECURITY_DEPOSIT; (3) **NUEVO fallback kiosk:**
`kioskDepositConfig` de la location de pickup (ej. $250 default) SOLO cuando 1 y 2 son 0
(regla Hector 2026-07-16); (4) else 0. **Storage propuesto:** `Location.locationConfig`
JSON (donde ya vive `securityDepositAmountDebit`) — sin migración. **Decisión:**
locationConfig vs AppSetting nuevo. **Ejecución:** Transact `preAuthDeposit` con el token
del HPP, CNP. **Rollback (lección beta):** si el PreAuth falla tras capturar el HPP sale →
void del sale (unsettled) o refund (settled, brazo G3), marcar VOID, recomputar, retry
claro. Persistir `depositHoldId` = RRN.

## 6. Sweep de dinero huérfano (worker; branch void→refund)
Cliente paga y abandona antes de firmar → sale capturado + hold vivo sin agreement CLOSED.
Worker sweep (convención vehicle-status-sweep; NO el stub mark-only del scheduler nocturno):
sesiones IN_PROGRESS/ESCALATED pasado un TTL con pago y sin `customerSignedAt` →
`queryPaymentStatus` → **unsettled→`voidByRrn`; settled→`refundByRrn` (NUEVO, testeado)**.
Idempotente; ante cualquier fallo de gateway → fila en cola de staff + outcome ABANDONED,
nunca swallow silencioso. **+ retention sweep de fotos ID/selfie** (rider pendiente de B3a).

## 7. Card-name vs license mismatch
El `iposHPResponse` trae `cardLast4Digit`/`cardType` pero no siempre el nombre del
tarjetahabiente. Diseño: si el gateway devuelve nombre usable, comparar con el nombre OCR
de la licencia usando el **matcher token-subset de B3e** (reusar). Mismatch → escalar a
staff, NO auto-stampar PAID. **Decisión Hector:** ¿hard-block o escalate-and-approve? ¿check
requerido o best-effort dado que el HPP puede omitir el nombre?

## 8. Decisiones que necesita Hector ANTES de codear
1. **Path del depósito si el token HPP NO es Transact-compatible (G1/G2):** aceptar perder
   card-on-file, o exigir sesión HPP PreAuth separada (segundo QR). Depende del rep.
2. **Política name-mismatch (§7):** hard-block vs escalate-approve; requerido vs best-effort.
3. **Storage de `kioskDepositConfig`:** locationConfig (recomendado) vs AppSetting.
4. **Aprobar el sweep void→refund** como el primer void/refund real de gateway + añadir un
   `refundByRrn` testeado a la Transact client.

## 9. UNKNOWN — confirmar con la cuenta/rep de iPOS antes de codear
- ¿El plan/TPN de Hector incluye el **producto Hosted Payment Page**?
- ¿El **`cardToken` del HPP es un iPOS Token usable por Transact**? (linchpin G1/G2)
- ¿El canal **Transact/card-on-file está provisto en el TPN**? (hoy dudoso — DEJ_ERR_003)
- **Credenciales sandbox del HPP** (`payment.ipospays.tech`/`api.ipospays.tech`) para
  construir+testear sin fondos reales (el spec exige sandbox iPOS hasta go-live).
- ¿`notifyByPOST` soporta algo más fuerte que el `authHeader` compartido? (sin HMAC en docs)
- **Shape del API de refund/return** de Transact para settled (tipo, key RRN o ref,
  parcial) — para construir el brazo G3/§6.

## 10. Checklist de build (que este doc gatea, tras el OK)
Tests de regresión: deposit-fail→void rollback; settled→refund; doble-webhook idempotente;
poll-nunca-stampa; PAID solo post-verify; name-mismatch escalation; kioskDepositConfig
fallback solo con reserva depósito 0 (reservation-wins). Ship script FILES[] con todo
import nuevo de main.js/worker.js (regla de boot-crash). Gate #2 = review línea por línea.

## Fuentes
- iPOSpays HPP API docs: https://docs.ipospays.com/hosted-payment-page/apidocs
- iPOSpays HPP overview: https://docs.ipospays.com/hosted-payment-page
- iPOSpays Transact: https://docs.ipospays.com/ipos-transact
- iPOSpays Auth Token API: https://docs.ipospays.com/ipos-pays-authentication-token-api
