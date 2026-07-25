# Ride Kiosk — Fase B5 Payment Design + Gate — **v2** (rev. 2026-07-24)

Status: **PRE-CODE. MONEY. STILL BLOCKED.** Requiere aprobación línea por línea de Hector
antes de implementar. Gate #1 = este doc; Gate #2 = review del diff. Ninguna línea de
código de pago escrita — todos los archivos payment-gateway/spin/ipos/checkout-session se
abrieron READ-ONLY.

> **v2 = resultado del pre-code gate.** Dos reviewers (Innovation + QA) verificaron el v1
> contra los docs vivos de iPOS y contra el código de producción. **Varias premisas del v1
> fueron REFUTADAS.** Este doc las corrige. No se puede empezar a codear el brazo de
> settlement ni el depósito hasta cerrar "BLOCKED ON REP".

---

## CHANGELOG v1 → v2 (qué se refutó y qué se corrigió)

| # | v1 decía | Verificado | v2 dice |
|---|---|---|---|
| 1 | Campos `respStatus`, `hrc`, `ChdToken`, `MaskedPan`, `txnSettleStatus` | **REFUTADO** — no existen en el response del HPP/queryPaymentStatus | Vocabulario real: `responseCode`, `responseMessage`, `errResponseCode/Message`, `transactionId`, `transactionNumber`, `batchNumber`, `cardType`, `cardLast4Digit`, `amount`/`totalAmount`, `responseApprovalCode`, `rrn`, `cardToken`, `consumerId`, `avsRespMsg`, `avs`, `l2l3Flag` (§2A, §4) |
| 2 | Poll: "todavía no Approved = seguir esperando" | **REFUTADO** — cuelga para siempre en decline/cancel | Poll de 3 vías: 200 → verify+PAID; 400/401/402 → TERMINAL; otro → esperar con ventana acotada → escalate (§4A) |
| 3 | Fallback "segunda sesión HPP PreAuth / segundo QR" | **REFUTADO** — HPP solo soporta transactionType 1 (SALE) y 2 (CARD VALIDATION); **no hay PreAuth en HPP** | No hay degradación elegante. Provisioning del TPN = go/no-go duro (§1) |
| 4 | Sweep cubre el dinero huérfano | **INCOMPLETO** — `expiry` mínimo del HPP es **1 DÍA**; un QR fotografiado se paga horas después, con la sesión ya borrada | Binding reference→session server-side + late-payment handler + expiry mínimo permitido (§6A) |
| 5 | "Deposit falla → void del sale" | **CONTRADICE PRODUCCIÓN** (`spin-charge.service.js:555-558`) y destruye la autenticación 3DS | **Decisión Hector: paridad con el counter.** El sale se queda; retry/skip del hold; escalate a staff (§5) |
| 6 | "El depósito hereda el liability-shift 3DS" | **NO VERIFICABLE** — cero soporte documental, la industria va al revés, y un shift es inobservable desde un auth aprobado | Se marca "per Hector/rep — NOT doc-verified, NOT test-validatable". El QR único se re-justifica por UX + inexistencia de PreAuth en HPP (§8.5) |
| 7 | "Posible blocker: 3DS destacado en Elavon, TPN es Fiserv" | **INFERENCIA INVÁLIDA** — el release note base es processor-agnostic | Queda como pregunta abierta al rep. **NUEVO:** 3DS es **PER-BRAND** — sin BINs/MIDs por marca, esa marca corre SIN 3DS en silencio (§2A) |
| 8 | `invoiceNumber`, auth por header `token` para queryPaymentStatus | **REFUTADO** | `txReferenceTag1-3` (≤25 chars); `queryPaymentStatus` vive en **otro host** (`api.ipospays.com`) con `Authorization` API key — esquema **UNVERIFIED** (§2B) |
| 9 | (no mencionado) | **HALLAZGO QA** — `voidStalePreauths()` marca `depositHoldVoidedAt` sin llamar al gateway | Colisión de fondos varados: hay que arreglar/desactivar ese stub **en el mismo ship** (§9A) |
| 10 | Dedupe por `ReservationPayment.reference` | **INSUFICIENTE** — es `String?` con solo `@@index` (verificado en schema) → findFirst-then-create = TOCTOU | Unique aditivo `(reservationId, reference)` + catch P2002 + single-flight (§4B) |
| 11 | payment-link idempotente | **INCOMPLETO** | Un solo payment intent por sesión: reusar el `transactionReferenceId` persistido, jamás mintear un segundo (§3) |
| 12 | Refund "brazo nuevo a construir" | **BLOQUEANTE** | Refund debe shipear **CON** el void, no después; shape del request UNPUBLISHED → dependencia dura del rep (§6) |
| 13 | Sweep branchea unsettled→void / settled→refund | **NO CONSTRUIBLE HOY** — `queryPaymentStatus` solo expone `batchNumber`, no settle status | Bloqueado hasta que el rep confirme cómo se observa el settlement (§6) |

---

## ✅ RESPUESTAS DE HECTOR 2026-07-24 (cierra parte del bloqueo)

| # | Pregunta | Respuesta de Hector | Estado |
|---|---|---|---|
| 1 | 3DS en Fiserv + BINs/MIDs por marca | **SÍ** | Confirmado por Hector. VERIFICAR en el portal que estén las marcas que acepta (3DS es per-brand y falla en silencio). |
| 2 | Liability shift del depósito | **SÍ** | **Aserción del rep/Hector — NO doc-verificable y NO validable por el test** (un shift solo se materializa en disputa). Se construye asumiendo que aplica; si un día hay chargeback en un hold, esta línea es el registro de la decisión. Ideal: tenerlo por email del rep. |
| 3 | Canal Transact CNP + card-on-file provisto | **SÍ** | Desbloquea el depósito + card-on-file. **Igual se exige el pre-flight probe** (§9B) antes de dinero vivo: si sale `DEJ_ERR_003` el kiosk NO tiene fallback. |
| 4 | Shape del request de Refund | *"lo que tú recomiendas"* | **Recomendación (§6):** v1 = refund por **RRN** (espeja `voidByRrn`, que ya funciona) y **solo monto completo**, sin parciales. Rationale: el void ya keyea por RRN, el sweep siempre reembolsa el total, y menos superficie = menos que salga mal en el único brazo que históricamente falla en silencio (beta.155). **El contrato exacto se verifica en el portal/docs antes de codear ese brazo.** |
| 5 | Observabilidad del settlement | **SÍ** | Falta el CÓMO — se busca en el portal (§7 de esta tabla). |
| 6 | Hora de corte del batch | **5:30 PM EST** | **Dato duro.** Define la ventana del void: toda prueba tiene que anularse ANTES de las 5:30 PM EST del mismo día, o pasa a refund. El sweep debe usar esta hora para decidir el branch void↔refund. |
| 7 | Auth + host de `queryPaymentStatus` | *"abre iPOS, yo doy login"* | Se resuelve leyendo el portal (read-only, Hector teclea el login). |

### Verificación EN EL PORTAL (sesión de Hector, read-only, 2026-07-24)
- **TPN confirmado: `816026739983`** (12 dígitos — formato correcto para `merchantAuthentication.merchantId`).
- **CloudPOS → Payments (Send Payment Link) ofrece Transaction Type: Sale · Pre Auth · Refund,
  pero Pre Auth y Refund están DESHABILITADOS y — confirmado por Hector — NO se pueden
  habilitar.** ⇒ **Se CONFIRMA el hallazgo del research: no hay PreAuth por link/HPP.**
  El depósito depende 100% del canal **Transact CNP con el token del HPP**. **NO HAY PLAN B**
  (§1 se sostiene tal cual). Si un día `DEJ_ERR_003` aparece en vivo, las únicas salidas son
  kiosk-sin-depósito o depósito asistido en counter.
- **Settlement = modelo de batches**: el portal expone **"Open Batch"** vs **"Closed Batches
  (previous day)"**. Transacción en batch abierto = anulable (void); batch cerrado = solo
  refund. Encaja con el corte de **5:30 PM EST**. Falta el equivalente por API (§5 abierto).
- **3DS: "es para todos" (Hector)** — todas las marcas cubiertas. ⚠️ No verificable desde este
  login: el rol es **Merchant** y el toggle de 3DS vive en Add-On Features de nivel **ISO**.
  Queda como aserción de Hector/rep, no verificada en pantalla.
- **Limitación del login:** Batches y Transactions muestran 0 stores / 0 TPNs / "No
  transactions for this user" ⇒ no se pudo inspeccionar el vocabulario real de campos de una
  transacción ni encontrar credenciales de API desde el portal. (Vale arreglarlo por operación
  aparte del kiosk.)
- Docs adicionales provistos por Hector: `https://docs.ipospays.com/` y
  **`https://knowledge.ipospays.com/`** (knowledge base — fuente para el shape del refund,
  auth/host de queryPaymentStatus y observabilidad del settlement).

**Lo que sigue bloqueado tras estas respuestas:** el CONTRATO exacto del refund (#4), el
mecanismo de observabilidad del settlement (#5), y el auth/host de `queryPaymentStatus` (#7)
— los tres se buscan en el portal de iPOS con la sesión de Hector, read-only.

---

## BLOCKED ON REP — 7 preguntas abiertas (nada de código de dinero antes)

**El brazo settled del sweep y TODO el flujo de depósito NO se pueden construir hasta que
estas estén contestadas por escrito.**

1. **3DS en Fiserv + BINs/MIDs por marca.** ¿3DS soportado en el procesador del TPN de
   Hector? ¿Qué marcas tienen BINs/MIDs sometidos? (Sin submission por marca, esa marca
   corre sin 3DS y nadie se entera.)
2. **Liability shift por escrito.** ¿El shift aplica al SALE del HPP? ¿Y hay algún
   mecanismo por el que el PreAuth tokenizado lo herede? (Hoy: aserción del rep, cero doc.)
3. **Provisioning del canal Transact CNP + card-on-file en el TPN.** Go/no-go duro: sin
   esto no hay depósito ni card-on-file en el kiosk (y **no hay fallback HPP** — item 3).
4. **Shape del request de Refund** (Transact type 3): ¿key por RRN o transactionId?
   ¿parciales? — bloquea el brazo settled del sweep.
5. **Observabilidad del settlement.** ¿Cómo se sabe si una tx ya settleó? (`batchNumber` no
   es un estado.) Bloquea el branch void↔refund.
6. **Hora de corte del batch del TPN** — determina la ventana del "void mismo día" del test.
7. **`queryPaymentStatus`: host + esquema de auth.** Docs apuntan a `api.ipospays.com` con
   `Authorization`, distinto del header `token` del create. Confirmar.

---

## UNKNOWNS que SOLO resuelve la primera transacción viva

No son preguntas de rep — son cosas que solo se observan corriendo una tx real:

- Estado exacto de `queryPaymentStatus` con un challenge 3DS **en curso**.
- Si 3DS realmente engancha en este procesador/marca (el response no lo dice explícito).
- Si el `cardToken` del HPP es aceptado por Transact **type 5 (PreAuth) Y type 1 (charge)** —
  un PreAuth exitoso **NO** prueba G2 (card-on-file). Hay que probar los dos.
- Presencia (o no) de ECI/CAVV en el response.
- Cómo se observa el settlement en la práctica.
- **Casing real de las llaves** del response (`iposhpresponse` vs `iposTransactResponse`).
- **Si aparece un nombre del tarjetahabiente** — el check de §7 podría simplemente no
  correr nunca.

---

## 0. Scope

Reemplazar el pago demo del kiosk (`POST /api/kiosk/sessions/:id/sandbox-payment`, que solo
stampa `paymentCompletedAt` detrás de `KIOSK_PAYMENT_SANDBOX`, fail-closed en prod) por un
flujo real: QR en pantalla → **iPOSpays Hosted Payment Page (HPP)** que el cliente paga en su
teléfono → verificación server-side → deposit PreAuth (Transact) → card-on-file → sweep de
dinero huérfano.

---

## 1. Gate G1–G4 (revisado)

**G1 — Depósito con el token del HPP: SÍ arquitectónicamente, PERO sin plan B.**
El HPP Sale (transactionType 1) con `requestCardToken=true` devuelve `cardToken` +
`consumerId`; el counter ya corre el patrón de dos operaciones (`runSale` → `runDepositHold`
→ `preAuthDeposit({ cardToken })`, Transact type 5 CNP).

⚠️ **CORRECCIÓN v2: el fallback del v1 no existe.** El HPP soporta **solo** transactionType
**1 (SALE)** y **2 (CARD VALIDATION)** — **no hay PreAuth en HPP**, así que "segunda sesión
HPP PreAuth / segundo QR" es imposible. Si el canal Transact CNP **no** está provisto en el
TPN, las opciones REALES son:
- **(a)** kiosk sin depósito (hold cero en el kiosk);
- **(b)** HPP **type 2 ($0 / CARD VALIDATION)** para tokenizar + **Transact PreAuth** con ese
  token — **misma dependencia de provisioning**, no resuelve nada por sí sola;
- **(c)** depósito asistido por staff en el counter.

**No hay degradación elegante: el provisioning del TPN es un go/no-go duro.**

**G2 — Card-on-file post-renta (tolls/daños/citations): misma dependencia.**
`chargeWithToken` (Transact type 1) potencia el card-on-file del counter. Si el token del HPP
sirve, el kiosk tiene paridad; si no, **pierde card-on-file** (regresión operativa real vs
counter). Un PreAuth exitoso **no** lo prueba — hay que probar un type 1 con el token.

**G3 — Void vs refund en SETTLED: el brazo de refund NO existe y el settlement no es
observable.** `iposTransactClient` tiene `voidByRrn` pero ningún refund. Además
`queryPaymentStatus` no expone estado de settlement (solo `batchNumber`). → §6.

**G4 — PCI SAQ-A confirmado; PAID solo con verificación server-side.** El cliente teclea la
tarjeta solo en la página hosted → SAQ-A. Webhook y redirect son **triggers, no prueba**;
`notifyByPOST` solo trae un `authHeader` compartido (sin HMAC) → re-fetch obligatorio.

---

## 1B. NO HAY SANDBOX — protocolo de prueba en PROD (decisión Hector 2026-07-24)

El TPN/AuthKey están atados a una terminal de producción viva; el endpoint de sandbox los
rechaza (`spin-client.js:10-13`). **No hay red de seguridad.** Decisión: probar en PROD con
la tarjeta de Hector, monto mínimo, anular el mismo día. Guards obligatorios → §10A.

---

## 2A. 3-D Secure — framing corregido

- **3DS es config del TPN** activada por el ISO en el portal (Add-On Features), **no** un
  flag de request. La llamada `payment-link` NO gana campo 3DS.
- ⚠️ **CORRECCIÓN v2 — 3DS es PER-BRAND.** Requiere BINs/MIDs sometidos **por marca**. Si
  una marca no está sometida, **esa marca corre SIN 3DS y el response no lo grita**. El
  diseño debe dejar de tratar 3DS como booleano global: es por-marca y silencioso.
- ⚠️ **CORRECCIÓN v2 — Fiserv.** El release note base de 3DS es **processor-agnostic**: ni
  confirma ni niega Fiserv. Se elimina "posible blocker" como inferencia documental; queda
  como **pregunta abierta al rep** (BLOCKED #1).
- **El challenge ocurre DENTRO del HPP**, antes del resultado final. No hay estado
  "pending-3DS" nombrado (§4A trata esto correctamente ahora).
- **ECI/CAVV/liability-shift NO están documentados** en el response ni en
  `queryPaymentStatus`. Se persiste lo que SÍ vuelve (§4).

## 2B. Vocabulario real del API (reemplaza todo el v1)

**Response `iposHPResponse` — campos reales:**
`responseCode` (**200** success · **400** declined · **401** cancelled-by-customer · **402**
rejected), `responseMessage`, `errResponseCode`, `errResponseMessage`, `transactionId`,
`transactionNumber`, `batchNumber`, `cardType`, `cardLast4Digit`, `amount`, `totalAmount`,
`responseApprovalCode`, `rrn`, `cardToken`, `consumerId`, `avsRespMsg`, `avs`, `l2l3Flag`.

**NO EXISTEN:** ~~`respStatus`~~, ~~`hrc`~~, ~~`ChdToken`~~, ~~`MaskedPan`~~,
~~`txnSettleStatus`~~. Toda referencia del v1 queda anulada.

⚠️ **Hazard de casing (verificado en código vivo):** `ipos-transact-client.js:275-280`
documenta que el API vivo envuelve en `iposhpresponse` mientras los docs muestran
`iposTransactResponse` — sin el fallback, un cargo APROBADO parsea como `{}` y un retry del
agente **doble-cobra**. → **parsear case-insensitive**, aceptar ambas formas.

**Create HPP — campos requeridos:** `merchantAuthentication.merchantId` (TPN, 12 dígitos
numéricos) + `merchantAuthentication.transactionReferenceId` +
`transactionRequest.transactionType` + `transactionRequest.amount`.
- **`amount` es STRING en centavos** (×100), ≤8 chars.
- **NO existe `invoiceNumber`** → usar `txReferenceTag1-3` (≤25 chars c/u).
- **Notificaciones bajo el wrapper `notificationOption`**: `notifyByRedirect`, `returnUrl`,
  `failureUrl`, `cancelUrl`, `notifyByPOST`, `postAPI`, `authHeader` (≤50 chars).
- **`expiry` mínimo = 1 DÍA** (no minutos) → ver §6A.

**`queryPaymentStatus`:** host **distinto** (`api.ipospays.com`), auth por header
`Authorization` (API key) — **NO** el header `token` del create. **Marcado UNVERIFIED**
pendiente de rep (BLOCKED #7).

---

## 3. Endpoints kiosk nuevos (reemplazan sandbox-payment)

- **`POST /api/kiosk/sessions/:id/payment-link`** → `{ url, qrPayload, paymentId }`.
  Monto 100% server-side (Σ cargos owed − paidAmount, **nunca** del cliente).
  ⚠️ **CORRECCIÓN v2 — un solo payment intent por sesión:** un retry **REUSA** el
  `transactionReferenceId` persistido; **jamás** mintea un segundo intent vivo (dos QRs = dos
  cobros genuinos, y el dedupe por reference es estructuralmente ciego a eso porque las
  references son distintas). Al re-emitir: supersede/expira el link viejo. Si dos llegaran a
  settlear → auto-void del extra + fila en cola de staff.
- **`GET /api/kiosk/sessions/:id/payment-status`** → `{ status, paidAmount?, last4?,
  depositHeld? }`. Llama `queryPaymentStatus` server-side. **Rate budget:** el guard kiosk es
  120/min **por IP** y todas las tablets comparten NAT → poll a intervalo largo (4–6s con
  backoff), webhook como trigger primario. Re-presupuestar antes de codear.
- **`POST /api/kiosk/payment-webhook/ipos`** (tokenless, guard por IP). Verifica `authHeader`
  con **comparación de tiempo constante**, **nunca confía en valores del body**, rate-limit +
  IP-guard, y **re-verifica con `queryPaymentStatus`** antes de tocar dinero.

---

## 4. PAID stamping (espejo de postAuthNetPaymentToReservation)

1. `reference = IPOS:<transactionReferenceId>`.
2. `queryPaymentStatus` server-side → exigir `responseCode === 200`.
3. **⚠️ v2 — el gate de PAID verifica ADEMÁS:**
   - **monto pagado == monto esperado** (tampering / bug de centavos);
   - **el `transactionReferenceId` pertenece a ESTA sesión/reserva** (binding server-side);
   - **el `tpn` coincide**;
   - dedupe por **`reservationId` + `reference`** (no reference sola), con allow-set explícito
     de status — igual que `postAuthNetPaymentToReservation`.
4. postPayment canónico (recomputa balance).
5. Persistir card-on-file (dep. G2) — **si falla: fila en cola de staff + alerta + escalate
   duro**, nunca pérdida silenciosa (§9C).
6. Deposit PreAuth (§5).
7. Stampar `paymentCompletedAt` solo tras 3–6.

**Persistir apenas se parsea una aprobación (antes de cualquier otra cosa):** `rrn`,
`transactionId`, `cardToken`, `responseApprovalCode`, `batchNumber`, `cardLast4Digit`,
`cardType`, `transactionReferenceId`. **No se puede anular lo que nunca se registró.**

## 4C. SECUENCIA OBLIGATORIA de Fase 2 (review R3) — verify → INSERT → PreAuth

El índice único parcial protege la **fila `ReservationPayment`**, NO el hold del
gateway. La protección contra el DOBLE HOLD sólo funciona si el INSERT de la fila
precede a la llamada de PreAuth:

```
1. queryPaymentStatus  → responseCode 200 verificado server-side
2. INSERT ReservationPayment (reference IPOS:<ref>)   ← el índice decide aquí
   └─ P2002 ⇒ YA lo hizo el otro racer → SHORT-CIRCUIT: return, NO tocar el gateway
3. Transact PreAuth (depósito) con el cardToken
4. stamp paymentCompletedAt
```

Si el PreAuth se hiciera antes del INSERT (o en paralelo), webhook y poll
llegarían los dos al gateway y pondrían **dos holds** en la tarjeta del cliente:
el perdedor del P2002 ya habría gastado el hold. El single-flight in-process
colapsa el caso normal; el índice es la red que sobrevive a multi-worker. **El
orden es la parte que hace que ambos sirvan.**

## 4A. Poll de 3 vías (reemplaza la regla rota del v1)

| `responseCode` | Significado | Acción |
|---|---|---|
| **200** | Aprobado | verify server-side → PAID (§4) |
| **400** | Declined | **TERMINAL** → pantalla de decline + retry al guest, liberar el flujo |
| **401** | Cancelado por el cliente | **TERMINAL** → volver a la pantalla de pago |
| **402** | Rejected | **TERMINAL** → decline path |
| otro / sin registro aún | En vuelo (posible challenge 3DS) | **seguir esperando** en ventana larga, con **estado terminal acotado** → escalate a staff + sweep |

El v1 ("todo lo que no sea Approved = seguir esperando") colgaba para siempre en un decline.

## 4B. Idempotencia — a nivel DB, no solo a nivel código

**Verificado:** `ReservationPayment.reference` es `String?` con **solo `@@index([reference])`**
— el dedupe canónico es findFirst-then-create, o sea **TOCTOU**. Con webhook + poll corriendo
a la vez, el v1 se corre a sí mismo hacia **doble fila de pago Y doble PreAuth (dos holds)**.

**Requisito:** constraint **unique aditivo `(reservationId, reference)`** + capturar **P2002**
como duplicado (no como error) + **single-flight guard** alrededor de verify→post→deposit,
espejando el guard `DEPOSIT_ALREADY_HELD` (`spin-charge.service.js:780-785`, verificado).

---

## 5. Depósito — rollback con PARIDAD DE COUNTER (decisión de Hector)

Orden de resolución (⚠️ **corregido**): **(1)** columna `RentalAgreement.securityDepositAmount`
→ **(2)** cargos SECURITY_DEPOSIT **del AGREEMENT** → **(3)** fallback kiosk
`kioskDepositConfig` de la location **solo si 1 y 2 son 0** → **(4)** 0.
El v1 decía "de la reserva"; el counter lee del **agreement**
(`spin-charge.service.js:613-622`, verificado) — alinear o kiosk y counter discrepan.

⚠️ **Nota de reversión deliberada:** forzar un depósito a nivel location **revierte** la
decisión del 2026-05-29 que eliminó el default silencioso de $500
(`spin-charge.service.js:605-612`). Es decisión de Hector, pero queda documentada como
reversión consciente.

### Rollback — v1 REFUTADO
El v1 decía "si el PreAuth falla → void del sale". Eso **contradice producción**:

> `spin-charge.service.js:555-558`: *"A failed deposit hold does NOT void the sale — the sale
> is real money the customer owes for the rental and stays put. The operator can re-try the
> hold from the View Payments page later."*

Y además **voidear un sale 3DS destruye la autenticación** obtenida.

**DECISIÓN HECTOR — paridad con el counter:** el **sale se queda**. El hold se **reintenta o
se salta**, y se **escala a staff**. Nunca se anula un sale bueno por un hold fallido.
Si el rollback mismo falla → fila en cola de staff + alerta + escalate duro (§9C).

---

## 6. Sweep de dinero huérfano — BLOQUEADO en su brazo settled

Diseño: sesiones con pago y sin `customerSignedAt` pasado un TTL → consultar estado →
**unsettled → `voidByRrn`** / **settled → `refundByRrn` (NUEVO)**.

⚠️ **Dos bloqueos duros:**
1. **El settlement no es observable hoy** — `queryPaymentStatus` expone `batchNumber`, no un
   estado de settle. **El branch no se puede construir** hasta que el rep explique cómo se
   observa (BLOCKED #5).
2. **Refund debe shipear CON el void, no después.** El timing del settlement lo decide el
   procesador; si le gana al void del mismo día, **no hay brazo de recuperación** — que es
   exactamente beta.155. Refund = Transact **type 3** según docs, pero el **shape del request
   (RRN vs transactionId, parciales) está SIN PUBLICAR** → dependencia dura del rep
   (BLOCKED #4).

**Reconciliación:** el sweep debe reconciliar contra el **estado del GATEWAY**, nunca contra
el flag de la DB (§9A).

## 6A. Late payment — el hueco de fondos varados (NUEVO en v2)

El `expiry` mínimo del HPP es **1 DÍA**. Un guest puede **fotografiar el QR** y pagarlo horas
después, cuando la sesión del kiosk ya se borró (auto-reset). El sweep del v1 solo barre
**sesiones que TIENEN pago** — no barre **pagos que no tienen sesión viva**. Requisitos:

- **Binding server-side `transactionReferenceId` → sesión/reserva**, persistido, que
  **sobrevive** al wipe de la sesión.
- **Handler de late payment:** llega un pago sin sesión viva → auto **void/refund** + **fila
  en cola de staff**.
- **Expiry = el mínimo permitido** por el API.
- **Ampliar el scope del sweep** a "pagos sin sesión viva", no solo "sesiones con pago".

---

## 7. Card-name vs license mismatch — semántica corregida

⚠️ **CORRECCIÓN v2:** para cuando se conoce el nombre de la tarjeta, **el sale ya está
CAPTURADO**. "No auto-stampar PAID" **no deshace un cargo**. Reframe correcto:
**"el dinero YA se movió; staff decide void/refund vs proceder"** — con fila en cola de staff.
Además el HPP **puede no devolver nombre nunca** → el check de §7 quizás no corra jamás
(UNKNOWN de la primera tx viva).

---

## 8. Decisiones de Hector (revisadas)

1. ✅ **Un solo QR.** ⚠️ Re-justificado en v2 **por UX + porque HPP no tiene PreAuth**
   (§1), **NO** por el liability-shift.
2. ✅ **Name-mismatch = escalar a staff** — con la semántica corregida de §7.
3. ✅ **`kioskDepositConfig` en `Location.locationConfig`** (junto a
   `securityDepositAmountDebit`), sin migración. Reversión deliberada documentada (§5).
4. ✅ **Sweep void→refund aprobado** como el primer void/refund real de gateway de la app —
   **pero bloqueado** en su brazo settled (§6).
5. ⚠️ **8.5 — Liability shift: NO doc-verificado, NO test-validable.**
   El v1 lo daba por cerrado. Ambos reviewers no encontraron soporte documental, y la
   industria va al revés. **Un liability shift es inobservable desde un auth aprobado** — solo
   se materializa en una disputa → **el test en vivo NO puede validarlo**. Se registra como
   **aserción de Hector/rep, pendiente por escrito** (BLOCKED #2). La decisión del QR único
   **no depende** de esto.

---

## 9. Colisiones con el código vivo (hallazgos QA)

### 9A. El stub legacy es una colisión de fondos varados — arreglar EN EL MISMO SHIP
`checkout-session.scheduler.js:86-124` `voidStalePreauths()` **marca `depositHoldVoidedAt`
sin llamar al gateway** (verificado: *"Spin client integration lands in Phase 2 — for now we
just mark depositHoldVoidedAt"*). Un depósito del kiosk quedaría **marcado como liberado
mientras el hold sigue vivo en la tarjeta 7–30 días**.
**Requisito:** arreglarlo o desactivarlo **en el mismo ship**, y que el sweep nuevo reconcilie
contra **estado del gateway**, nunca contra el flag de la DB.

### 9B. `DEJ_ERR_003` no tiene fallback en kiosk
El counter esquiva un canal Transact no provisto con `IPOS_FORCE_CARD_PRESENT_DEPOSIT` (un
segundo tap en la terminal). **Un kiosk no tiene terminal.** Requisito: **probe pre-flight**
que demuestre que una llamada Transact tokenizada funciona en el TPN vivo **ANTES de mover
dinero real**, + manejo explícito de `DEJ_ERR_003`.

### 9C. "Cola de staff" tiene que ser concreta
Nombrar: **el registro persistido**, **la superficie visible** (dashboard/alerta), y un estado
distinto **"llamada al gateway FALLÓ"** vs **"no se intentó todavía"**. Tal como estaba en el
v1 es inaplicable. Aplica a: rollback fallido, card-on-file fallido, late payment,
name-mismatch, cualquier fallo del sweep.

---

## 10. Recomendaciones incorporadas

- **Eliminar el branch especulativo `currentGateway()` → ipos.** El teléfono del guest abre la
  URL de iPOS **directo**; `/customer/pay` nunca renderiza. Reusar solo `postPayment` + el
  dedupe `IPOS:<ref>` + la disciplina verify-before-post.
- **Dry-run mode** para el cliente HPP nuevo, espejando `SPIN_DRY_RUN` / `IPOS_TRANSACT_DRY_RUN`
  (verificado en `ipos-transact-client.js:130-133`) → ejercitar la máquina de estados completa
  incluyendo rollback y sweep **en CI sin dinero**.
- **Webhook hardening:** compare de `authHeader` en tiempo constante, nunca confiar en valores
  del body, rate-limit + IP guard.

## 10A. Guards del test en vivo (más allá del env flag)

1. **Techo de monto server-side (~$5) en el límite de la llamada al gateway.** ⚠️ Crítico:
   la precedencia **reservation-wins DERROTA** bajar `kioskDepositConfig` — el paso manual del
   v1 **NO es un control**.
2. **Allowlist de reserva** + **pin de device + location**.
3. **Flag auto-expirante** (`KIOSK_PAYMENT_LIVE`, doble-key en prod).
4. **Persistir `rrn` + `transactionId` + `cardToken` en el instante en que se parsea la
   aprobación** — no se puede anular lo que no se registró.
5. **Fila de auditoría durable ANTES y DESPUÉS de cada llamada al gateway.**
6. **Runbook manual de unwind** — no depender del sweep recién nacido para liberar el dinero
   de Hector.
7. **Confirmar que NINGÚN email/SMS al cliente dispara** en la reserva de prueba (lección
   beta.335/336).
8. **Neutralizar el stub legacy (§9A) primero.**

## 10B. Protocolo de prueba (consolidado)

- **Test 1 — void mismo día:** renta ~$1, Hector paga con su tarjeta en su teléfono, void del
  sale + del hold **antes del corte del batch** (confirmar la hora — BLOCKED #6).
- **Test 2 — refund (NUEVO, obligatorio):** un sale de ~$1 que se **deja settlear overnight** y
  luego se **refunda**. Es la **única** forma de validar el brazo de refund.
- **Paths de fallo scripted:** decline (400), cancel (401), reject (402).
- **Test de abandono → sweep.**
- **Test de late-payment después del wipe de sesión** (§6A).
- **Replay de webhook duplicado** (§4B).
- **Charge type 1 con el token del HPP** — un PreAuth exitoso **no** prueba G2.
- **Excluir/taggear el pago de prueba** de los reportes de revenue + commission (arco beta.296).

## 10C. Checklist de build (gateado por este doc)

Tests de regresión: rollback con paridad de counter (sale se queda); settled→refund;
doble-webhook idempotente; poll de 3 vías (incl. terminales 400/401/402); PAID solo
post-verify **con monto + binding + tpn**; unique `(reservationId, reference)` + P2002;
un solo payment intent por sesión; late-payment handler; name-mismatch escalation;
`kioskDepositConfig` solo con depósito 0 (agreement-wins); sweep reconciliando contra gateway.
Ship script `FILES[]` con todo import nuevo de `main.js`/`worker.js` (regla de boot-crash).
**Gate #2 = review línea por línea del diff.**

---

## Fuentes
- iPOSpays HPP API docs: https://docs.ipospays.com/hosted-payment-page/apidocs
- iPOSpays HPP overview: https://docs.ipospays.com/hosted-payment-page
- iPOSpays Transact: https://docs.ipospays.com/ipos-transact
- iPOSpays Auth Token API: https://docs.ipospays.com/ipos-pays-authentication-token-api
- Código verificado read-only: `spin-charge.service.js` (555-558 rollback, 605-622 depósito,
  780-785 guard), `checkout-session.scheduler.js` (86-124 stub mark-only),
  `ipos-transact-client.js` (130-133 dry-run, 275-280 casing), `schema.prisma`
  (`ReservationPayment.reference` = `String?` + `@@index`, sin unique).
