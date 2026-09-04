# US terminal checkout on iPOSpays AutoRental — technical execution plan (2026-09-04)

**Status:** PLAN ONLY. No app code was written for this document.
**Target:** a dedicated counter checkout session for US tenants, starting LAX / International
Rental Corp, driven by an iPOS QD2 terminal, using the iPOSpays **AutoRental** transaction
family with Level 2 / Level 3 data on every transaction.
**Branch:** `plan/us-terminal-checkout` (do not push, do not merge).

Hector's shape, verbatim:

> Step 1 verify info → Step 2 initial + sign the rental contract ON THE TERMINAL →
> Step 3 payment with card on file + tokenization → Step 4 security-deposit capture.
> Inspection stays configurable (agent-led or customer-led). ID scanning on the terminal
> prefills the customer during PRE-CHECK-IN. L2/L3 data must ride on every transaction.

---

## 0. Read this before anything else

### 0.1 We built AutoRental on SPIn once. It was live-tested and deliberately removed.

This is not a green-field integration and not a first attempt. In May 2026 RFM implemented
`v2/AutoRental/Sale` and `/Auth` against IRC's live terminal, ran **five** real attempts in one
night, and dropped the whole feature pack.

Primary record: `doc/round-26-followups-2026-05-23.md` (session 2, beta.71/72 smoke,
2026-05-24 ~03:30–04:55). The decision:
`doc/architecture/2026-05-28-dejavoo-spin-checkout-redesign.md:12` —
*"Drop the AutoRental Dejavoo feature pack. Use only the **Spin REST API** for charges,
security-deposit pre-auth, and card-on-file enrollment."*

| # | Result |
|---|---|
| 1 | Wizard routed to the legacy signing endpoint — frontend had cached `/api/me/feature-flags`. Hard refresh fixed it (followup #14, still open) |
| 2 | Sale submitted **$339.20** = $89.20 rental **+ $250 deposit**, with the $250 *also* held as an AUTH. Aborted before swipe. Double-charge (bug #10, fixed) |
| 3 | SPIn rejected **every** `AutoRental/Sale` with `2201`: *"Rental Class Id must be 4 Digit value or Rental Class Id is not between 0001-0032 and 9999"*. **The terminal never showed anything** (bug #11, fixed) |
| 4 | `1012 "Canceled"` in 2.4 s — terminal stuck from prior aborts. Power-cycle would unstick it |
| 5 | **Terminal showed the itemized cart and the pay screen.** Aborted before swiping. **No disclaimer screen. No signature prompt** (issues #12 and #13, both still open) |

Three of the brief's open questions are answered by this record, not by speculation:

- **`RentalClassId` is solved.** It must be 4-digit numeric in `0001`–`0032`, or the catch-all
  `9999`. Our codes are ACRISS *letter* codes (`SFAR`, `ECAR`) or empty — exactly what produced
  the 2201. The fix, `normalizeRentalClassId()`, is preserved in that doc (§4.6) and **no
  longer exists in the current `spin-client.js`.**
- **The 2201 risk is real and it hit AutoRental specifically.** An invalid field rejects the
  request *at SPIn, before the terminal*, so the customer and the agent see nothing at all.
- **A hung terminal stays hung.** `1012` after aborts; power-cycle is the documented remedy.

### 0.2 Issue #12 — and the finding that unblocks it

**During AutoRental the terminal never showed the disclaimer.** The round-25 design relied on
the **iPOSpays portal config** attaching a disclaimer to the Sale Type so it would render as
the first screen of an AutoRental Sale. It did not fire, and the leading hypothesis in the doc
was that *the terminal firmware doesn't support inline disclaimer on AutoRental, only on plain
Sale.* Never resolved.

**The docs research for this plan found a different mechanism entirely, which was never
tried.** `POST /v2/Common/Disclaimer` is an API-driven terminal prompt:

> *"Disclaimer displays a disclaimer text on the terminal screen and prompts the customer to
> provide a signature."*
> Request: **`Title` (string, REQUIRED)** — "Disclaimer text displayed to the customer on the
> terminal" — plus the common credential block.
> Response: **`Signature` (string, base64 PNG)** + `GeneralResponse`.
> https://docs.ipospays.com/spin-specification/RestApi/spin-rest-api-methods/v2/common/disclaimer/post

That is text-on-screen **and** an ink signature back, in one call, driven by our backend rather
than by portal configuration. It is a completely separate code path from the inline
Sale-Type disclaimer that failed in May.

**This makes Hector's Step 2 buildable** — see §2.10 and §10 Phase 4. It does not make it free:
see the length constraint in §2.10 and open question D-20.

Issue #13 (signature capture on the *transaction* via `CaptureSignature: true`) remains
unverified, because every 2026-05 test was aborted before the swipe and Dejavoo's transaction
signature prompt comes *after* card auth. The current client sends the opposite —
`spin-client.js:239`, `CaptureSignature: false`. With `/v2/Common/Disclaimer` and
`/v2/Common/GetSignature` available as explicit calls, #13 stops being a blocker and becomes an
optimization.

### 0.3 What this project actually is

| # | The real delta | Size |
|---|---|---|
| D1 | Restore `v2/AutoRental/*` + `normalizeRentalClassId` + real L2/L3 lines | Medium |
| D2 | Terminal signing via `/v2/Common/Disclaimer` + `/GetSignature` | Medium (was "large/gated") |
| D3 | Add a US profile to the shipped session (step order is already correct) | Small |
| D4 | Pluggable identity ingest at pre-check-in | Small — both code paths already exist |

### 0.4 …and none of it matters unless the merchant account is eligible

AutoRental over SPIn has **account-level prerequisites that no amount of correct code can
satisfy**: an auto-rental MCC (`7512`/`7513`/`7519`/`3390`), the **TSYS** processor, and terminal
POS build ≥ `10177`. **Nobody checked any of these in May 2026** — the investigation stopped at
the payload format bug.

If the MCC is wrong, every field can be perfect and the interchange saving that is the entire
economic case simply never arrives. If the processor is not TSYS, AutoRental may be unavailable
outright. **§9 is the checklist, and it runs before any code.**

---

## 1. The API surface — now confirmed against the docs

Base: `https://spinpos.net` (prod) / `https://test.spinpos.net` (sandbox). Full REST surface:

- **Payment (14):** Sale, Return, TipAdjust, Auth, Capture, Void, Status, StatusList,
  OfflineStatus, Settle, AbortTransaction, Cart, GetCard, Balance
- **AutoRental (3):** Sale, Auth, Capture — **and only these three**
- **CEDP (3):** `/v2/Payment/CEDP/Sale`, `/CEDP/Capture`, `/v2/Logs/UploadTransaction`
- **L2L3 (3):** `/v2/L3Data/AddLevel3Item`, `/RemoveLevel3Item`, `/ViewLevel3Item`
- **Gift (8)** · **Common (6)** · **IntermediateStatus (2)** · **Report (2)** · **TableApp (2)**
  · **CGI (2)**
- **Callback (2):** `/Callback/PostCallback`, `/Callback/GetLastCallback` — **no `/v2` prefix**

### 1.1 Host discrepancy — settled

The docs say `spinpos.net`. The shipped client uses `https://api.spinpos.net`
(`spin-client.js:20`), and the 2026-05 AutoRental attempts reached the terminal through it.
`spin-client.js:9-18` records that all sandbox plumbing (`SPIN_SANDBOX`, `SPIN_ENV`,
`test.spinpos.net`) was deliberately deleted 2026-05-29.

**Both hosts evidently work; ours is proven on this TPN.** Keep `api.spinpos.net`, confirm as
D-1, and do not add a second base URL.

### 1.2 The AutoRental payload — corrected against the spec

Several fields are **not** what the working assumption said. These corrections matter:

| Field | Actual contract |
|---|---|
| `AutoRentalAgreement.RentalPeriod` | **An enum: `"Daily" \| "Weekly" \| "Monthly"`.** Not a date range |
| `AutoRentalAgreement.RentalDuration` | **Required.** The count that pairs with `RentalPeriod` |
| `AutoRentalAgreement.AutoRentalAdjustment` | `{ AdjustmentAmount, AdjustmentAuditIndicatorCode: "X"\|"Y"\|"Z" }` |
| `AutoRentalPricing.ExtraCharges` | **`array<string>`, required.** Strings, not objects — this is *not* where line items go |
| `AutoRentalDistance.AutoRentalDistanceUnitofMeasure` | Enum `"Miles" \| "Kilometers"` |
| `AutoRentalPickup/Return.DateTime` | **Required.** Typed `date-time` but the description says *"Expected format: yyyy-MM-dd, for example: 2025-10-17"* |
| `LocalTaxFlag` | **An enum: `"NotProvided" \| "LocalOrSales" \| "TaxExempt"`.** Not a boolean |
| `PurchaseIdFormatCode` | Mandatory; `3` = Auto Rental Agreement Number |
| `TaxAmount`, `LocalTaxFlag` | **Mandatory at the top level of every AutoRental call** |
| `AutoRental` (the object) | **Required** on all three endpoints |
| `TipAmount` | Present on `AutoRental/Sale`; **absent on `AutoRental/Auth`** |

### 1.3 Credentials and addressing — settled by the docs

| Field | Contract |
|---|---|
| `Authkey` | "Merchant's authorization password", **exactly 10 characters**, **in the JSON body**. Never a header. No `Authorization` header exists on any `spinpos.net` endpoint |
| `Tpn` | "Terminal profile number", 10–12 chars. The **preferred, current** identifier |
| `RegisterId` | **Marked `[Obsolete]` on every endpoint.** 2–50 chars. "Required if no Tpn" |
| `MerchantNumber` | int, `1 <= value <= 5`, a separate multi-MID axis. *"If not present in multi-merchant environment, transaction will be cancelled"* |
| `SPInProxyTimeout` | int, **`1 <= value <= 720`** seconds, nullable |
| `SPInToken` | **Appears exactly once in the entire spec** — inside the `Authkey` description ("Required if no SPInToken"). Never declared as a field, header or schema property. **NOT DOCUMENTED** |

Portal path to generate the SPIn credentials: **S.T.E.A.M → Edit Parameters → select TPN →
Edit Parameter → Integrations → Type of Integrations = SPIn → Spin Mode = Cloud → copy Register
ID and Auth Key**, then download parameters on the device.

**This settles the credential question (§6.2): keep `Authkey`. Do not chase `SPInToken`.**

### 1.4 Status codes — the union of two incomplete lists

`ResultCode`: `0` success · `1` terminal error · `2` SPIn proxy error. (The schema enum reads
`"Ok"|"TerminalError"|"ApiError"` while every example emits `"0"` — **code against the
digits**, which is what `spin-client.js:180-194` already does.)

`StatusCode` families: `0xxx` success from the terminal app · `1xxx` terminal-app error ·
`2xxx` SPIn Proxy error (*"the response did not reach the terminal"*).

The ones that matter here:

| Code | Meaning |
|---|---|
| `0000` / `0001` | Approved / Partial approval |
| `1004` | Not Allowed — incl. **"A Void Auth requested for a processor that does not allow Void Auth"**, "a tip amount sent in an Auth request", "a custom fee sent in an Auth or EBT request" |
| `1009` | Authentication Failed — auth-key mismatch; pull parameters on the terminal |
| `1011` | Duplicate Reference ID |
| `1012` | **Cancelled** — "User cancelled the transaction, or it was interrupted for an unknown reason" |
| `1500` | **Signature Not Captured** |
| `2002` / `2003` / `2004` | Active AuthKey not found / Register not found (TPN wrong) / Route not found (TPN has no SPIn proxy config) |
| `2005` | **Active route not found — "Two or more devices used the same TPN"** (see §7) |
| `2007` | Timed out — **"Default timeout is 120 seconds. Settlement default timeout is 420 seconds"** |
| `2008` | **Terminal in use** — returns `DelayBeforeNextRequest`, "time in seconds recommended to wait before sending the next request" |
| `2201` | **Invalid request data** — the code that killed AutoRental in May |

⚠️ Neither published list is complete: `1014, 1018, 1021, 1022, 1023` appear only in the prose
table; `1024, 1030, 1040, 1100, 1101, 1500, 1999, 2201, 2301` only in the per-endpoint enum.
**Union them.**

⚠️ `DelayBeforeNextRequest` is typed `number|null` in success schemas, `integer|null` in 400
schemas, and `string` in the Error Codes table. **Parse loosely.**

### 1.5 The `/v2/Common/*` prompt endpoints — full contracts

All six share the credential block (`Tpn`, `RegisterId`, `Authkey`, `SPInProxyTimeout`,
`CustomFields`). There are exactly six; no others exist.

| Endpoint | Request beyond the common block | Response |
|---|---|---|
| `POST /v2/Common/GetSignature` | *(nothing)* | `Signature` (base64 PNG) + `GeneralResponse` |
| `POST /v2/Common/Disclaimer` | **`Title` (REQUIRED)** — the text shown | **`Signature`** + `GeneralResponse` |
| `POST /v2/Common/UserChoice` | **`Title` (REQUIRED, ≤250)**, **`ChoiceOptions` (REQUIRED, `array<string>`)** | `SelectedOption` + `GeneralResponse` |
| `POST /v2/Common/UserInput` | **`Title` (REQUIRED)**, **`Type` (REQUIRED: `Number\|Letters\|NumberAndLetters\|Currency\|InfoOnly`)**, `Timeout` (s), `MaxLength`, `HiddenInput` | `InputedString` (sic) + `GeneralResponse` |
| `POST /v2/Common/Printer` | **`Printer` (REQUIRED)** — receipt markup: `<L> <C> <R> <B> <LG> <CD> <INV> <BR/> <IMG>base64</IMG> <QR>url</QR>` | `GeneralResponse` |
| **`GET`** `/v2/Common/TerminalStatus` | Query params **with a `request.` prefix**: `request.tpn`, `request.registerId`, `request.authkey` | `TerminalStatus: "Offline"\|"Online"\|"NotFound"`, `Tpn`, `ErrorDescription` — **no `GeneralResponse`** |

Our existing `terminalStatus()` (`spin-client.js:396-401`) already uses the correct
`request.tpn` / `request.authkey` query form — it just bypasses `spinRequest`, so it has no
timeout and no error normalization, and it does not decode the `TerminalStatus` enum.

---

## 2. What already exists in RFM

### 2.1 The session and its state machine

`backend/src/modules/checkout-session/state-machine.js:41-82`:

```
CONFIRMING → TC_PENDING → TC_SIGNED → PAYMENT_PENDING → PAID
   → INSPECTION_HANDOFF → INSPECTION_IN_PROGRESS → CUSTOMER_SIGN_PENDING
   → FINALIZING → CLOSED
```

Strictly linear, one successor per step (`:59-71`); `CANCELLED` from any non-terminal step
(`:99-101`). Entry guards (`:77-82`): `TC_SIGNED` needs `tcCompletedAt`, `PAID` needs
`paymentCompletedAt`, `CUSTOMER_SIGN_PENDING` needs `inspectionCompletedAt`, `CLOSED` needs
`customerSignedAt`. Out-of-order → 409. Every transition appends to an events log with an actor
(`:111-117`). Server-side CAS retry loop (`checkout-session.service.js:561-707`) plus an opt-in
`expectedVersion` guard producing `409 STALE_VERSION`.

**State lives on the backend, not in React** (`page.js:11-17`): no reducer, no context, no URL
state. Progression happens three ways, all landing on `POST /api/checkout-sessions/:id/
transition`: agent click (`advance()`, `page.js:333-379`); **auto-advance when the 1.5 s poll
observes a side-effect stamp** (`page.js:307-331` — this is how the customer's phone, the Spin
response and the mobile inspection drive the desktop); and `StepBridge` auto-advance out of
intermediate states after 500 ms (`:2112-2120`).

**Hector's four steps already are this graph.** No new state machine.

### 2.2 The seam for a profile — already built, for a different reason

`paymentStepMode()` (`frontend/src/lib/checkout-session.js:76-82`) returns `LOANER`, `SKIP` or
`COLLECT`, dispatched at `page.js:773-788`. The skip is a **data-level pre-stamp, not a graph
change**: `resolvePaymentPrestampReason()` (`checkout-session.service.js:191-195`) runs at
session create (`:326-339`) and pre-stamps `paymentCompletedAt`. The rationale
(`settings/checkout-payment-policy.js:10-18`) is explicit: the state machine, the entry guards
and the Spin/iPOS clients are deliberately untouched.

**This is the seam the US profile uses.** A US terminal session is a mode, not a fork.

### 2.3 The terminal charge orchestrator

`spin-charge.service.js:1-31` — the live happy path: SPIn `/sale` → response carries a
tokenized card (`GetExtendedData=true`) → token persisted to `RentalAgreement.cardOnFileToken`
→ SPIn `/auth` for the deposit **using that token** (no second tap) → hold id + expiry
persisted (`:584-586`, `:1069-1071`) → `paymentCompletedAt` stamped.

Failure modes already handled (`:16-27`): sale fails → nothing to roll back; tokenize returns
null → sale persists with a warning; **deposit auth fails after a successful sale → CRITICAL
ROLLBACK, void the sale**, return `rollbackPerformed: true`.

The fail-closed terminal gate is here, not in the resolver (`:280-290`), guarded three times
against reintroduction (`:395-397`, `:756-758`, `:934-936`):

> ```js
> // No .catch() here on purpose. Swallowing this into {} is exactly how the
> // charge used to fall through to the platform terminal; TERMINAL_NOT_CONFIGURED
> // must reach the wizard.
> ```

### 2.4 The shipped SPIn client

`spin-client.js` (499 lines). Envelope (`:123-129`) — `Authkey` in the **body**, and **no
`RegisterId` anywhere in the repo** (which the docs now confirm is correct, since it is
obsolete):

```js
const payload = {
  Authkey: config.authKey,
  Tpn: config.tpn,
  MerchantNumber: config.merchantNumber,
  SPInProxyTimeout: config.proxyTimeout,
  ...body,
};
```

Methods: `sale` (`:227`), `auth` (`:249`), `capture` (`:262`), `void` (`:280`, `ReferenceId`
only), `refund` → `v2/Payment/Return` (`:289`), `tipAdjust` (`:300`), `getCard` (`:310`),
`preAuthDeposit` (`:324`), `chargeWithToken` (`:350`), `balance` (`:370`), `status` (`:380`),
`settle` (`:389`), `terminalStatus` (`:396`), `summaryReport` (`:406`), `abort` (`:413`).

Characteristics:

- **No retry** — single-shot, correct for a card-present rail.
- **No polling.** One long-lived synchronous call held open up to `SPInProxyTimeout` (120 s)
  with a 130 s client `AbortController` backstop (`:36-40`, `:142-143`).
- **`abort()` and `status()` exist but nothing in the repo calls them.** No cancel button is
  wired to `AbortTransaction`. This project must wire it (§14 F7).
- **`terminalStatus()` bypasses `spinRequest`** (`:396-401`) — no timeout, no normalization,
  raw `res.json()`, and it does not decode the `Online/Offline/NotFound` enum.
- Success detection is deliberately permissive (`:169-194`) after a 2026-05-28 incident where
  strict `!== 0` rejected a genuine approval and logged *"Sale declined: Approved"*.
- **`capture()` sends only `ReferenceId` + optional `Amount`. The docs require `AuthCode` too**
  — "Authorization code returned from the original pre-authorization". Today's capture is
  therefore incomplete; it has evidently never been exercised. → fix in Phase 2.
- Errors: `err.spinStatusCode`, `err.spinResponse`; timeouts set `err.spinTimeout` (`:158`).
- Logs only `{ spinPath }` (`:135`) — never the payload, never `Authkey`. Boot audit masks the
  TPN (`:67`).

### 2.5 THE 2201 LESSON

`spin-client.js:210-222`, repeated at `:271-276`, `:339-346`, `:365-368`:

> Reverted to the minimal field set after a live test hit **StatusCode 2201 / ResultCode 2**.
> The added flags (`GetToken`, `EnableTip`, `PrintReceipt`) appear to be unrecognized by this
> merchant's Spin proxy, and including them causes the gateway to **reject the request before
> forwarding to the terminal** (confirmed: nothing appeared in the Dejavoo merchant portal).

With §0.1 attempt 3 — where AutoRental 2201'd on one bad field — this is the governing
constraint of the project.

### 2.6 Per-tenant terminal resolution — already solved

`tenant-terminal-config.js`, header `:1-76`:

- **One home:** `AppSetting` key `tenant:<tenantId>:paymentGatewayConfig`, `spin` block
  (`:85-90`). Two other candidate homes deliberately not read (`:24-31`).
- **Precedence is money-safety order** (`:33-44`): TENANT (both `authKey` and `tpn`) → **fail
  closed if half-configured** (`:254-260`, logs ERROR) → ENV fallback only if the tenant has
  *no* config → NONE.
- **`spin.enabled` is deliberately not part of resolution** (`:46-51`) — an unchecked box would
  route that tenant's charge to the ENV terminal, i.e. cause the exact wrong-merchant charge
  the module exists to prevent.
- **Never a silent fallback** (`:64-66`).
- **`authKey` encrypted at rest** as `enci:` AES-256-GCM, dual-read forever (`:68-75`). **TPN is
  not a secret** — the operator must eyeball it — so it stays plaintext, masked in logs
  (`maskTpn`, `:120`).
- Audit metadata is a tested function (`:328`): booleans and a masked TPN only.
- 60 s cache (`:97`), invalidated by the settings service so *every* writer invalidates
  (`settings.service.js:1594-1598`).

### 2.7 `SPIN_DRY_RUN`

`spin-client.js:80-111`: `SPIN_DRY_RUN=true` short-circuits every call to a synthetic approved
response with an `IPosToken`, `Last4:'4242'`, `CardType:'VISA'`, so the whole orchestrator,
persistence and state machine run end to end with no terminal. `spin-charge.service.js:280`
exempts dry-run from the fail-closed gate. An ERROR fires if dry-run is on in production
(`:54-55`).

### 2.8 The deposit lifecycle

- Amount **always** from the reservation — `securityDepositAmount` or the sum of
  `SECURITY_DEPOSIT` charges. If unspecified, hold **$0**, never a generic $500
  (`spin-charge.service.js:45-49`).
- **Deposit lines must be excluded from the Sale.** `isDepositCharge()`
  (`reservation-pricing.service.js:282-291`) matches `chargeType === 'DEPOSIT'` OR
  `source ∈ {DEPOSIT_DUE, SECURITY_DEPOSIT}` OR name `/^security deposit/i` — the third signal
  exists because production had legacy rows with null `code` and `source`. **This is the fix
  for the $339.20 double-charge and any AutoRental cart builder must use it.**
- Hold key differs by rail (`:972-974`): Transact stores the RRN, SPIn the `ReferenceId`.
  Expiry 7 days (`:50`).
- `RentalAgreement.depositHoldId / depositHoldAmount / depositHoldExpiresAt /
  depositHoldVoidedAt` (`schema.prisma:2362-2368`), `securityDeposit*` (`:2337-2342`),
  `AgreementPaymentMethod.AUTH_HOLD` (`:151-155`).
- Nightly sweep (`checkout-session.scheduler.js:1-22`) flags sessions stuck >4 h and pushes
  holds older than 24 h into the payment ops queue. Its 2026-07-24 header correction: it used
  to stamp `depositHoldVoidedAt` **without calling any gateway**, falsely claiming the money was
  released. Preserve that honesty.
- **LAX deposit rules exist** (`lib/deposit-rules.js:1-36`): a CA-licence or CA-resident renter
  leaves up to $2,000 capped at 150 mi/day; everyone else pre-authorizes up to $1,000 with
  unlimited mileage; undeterminable ⇒ LOCAL. **Frozen** on
  `ReservationPricingSnapshot.securityDepositRuleJson` at reservation time — read it, never
  re-derive.

### 2.9 Deposit release — now a documented constraint

`https://docs.ipospays.com/spin-specification/RestApi/transaction-types-scheme`:

> Sale root: Sale → Tip adjust, Void
> Refund/Return root: Refund → Void
> Auth-capture root: Auth → Capture, Void, Tip Adjust

**There is no `/v2/AutoRental/Void`, `/Return`, `/Refund` or `/Adjust`, and no incremental
authorization anywhere in the spec** ("incremental" returns zero hits across the whole REST
tree). A deposit hold is released by **`POST /v2/Payment/Void` with the original Auth's
`ReferenceId`** — which is exactly what `spin-client.js:280` already does.

⚠️ **`1004 Not Allowed` fires when "A Void Auth requested for a processor that does not allow
Void Auth."** Hold release is processor-dependent. If IRC's processor is one of those, the only
release is expiry, and the customer's money sits held for the issuer's window. → D-18.

⚠️ **No incremental auth means a rental that grows past its original hold has no documented
top-up.** The options are a fresh `Auth` or an at-return `Sale`. → D-24.

⚠️ `AutoRental/Capture` exists but, like `/v2/Payment/Capture`, **requires `AuthCode` as well
as `ReferenceId`** — a field our client does not currently send.

### 2.10 Contract signing — today, and what the terminal can actually do

**Today the customer signs on their own phone** via a tokenized public URL:

- `terms-signing.service.js:1-11` — `/api/sign/:token/*`, the token *is* the auth.
  `complete()` (`:217-289`) rejects a blank canvas via `analyzeSignatureInk()` (`:226-229`),
  verifies **every** expected section has an initial or throws `400 INITIALS_INCOMPLETE`
  (`:236-246`), then one `$transaction` writes the signature, stamps
  `CheckoutSession.tcCompletedAt`, bumps `stateVersion` and consumes the token.
- Sections (`terms-content.js:20-69`): six canonical — `rental_period`, `mileage_fuel`,
  `insurance_coverage`, `liability_damages`, `deposit_post_charges`, `prohibited_use` — plus a
  conditional 7th, `DECLINED_INSURANCE_SECTION` (`:74-81`), injected after
  `insurance_coverage` when `declinedInsurance` is true (`sectionsForAgreement()`, `:188-203`).
  **A declined-insurance checkout genuinely presents seven initial pads plus one full
  signature.**
- Storage: `AgreementSectionInitial` (`schema.prisma:5832-5847`), `initialDataUrl @db.Text`,
  unique on `[agreementId, sectionKey]`. Base64 PNG data URLs; no object storage. Final:
  `RentalAgreement.tcSignatureDataUrl / tcSignedAt / tcSignerName / tcCustomerIp` (`:2370-2378`).
- Per-branch text: `Location.termsSectionsJson` (`:746-756`) replaces text by key but cannot
  add, remove or reorder. **No admin UI, and `PATCH /api/locations/:id` validates nothing**
  (`terms-content.js:128-131`) — a truncated blob silently falls back to canonical text.
- Sections resolve from the **agreement's** pickup location, not the reservation's
  (`terms-signing.service.js:46-56`), because `reservations.service.js:1921` can move
  `Reservation.pickupLocationId` with no sync back. `:96-115` documents a known, unfixed
  divergence: the PDF resolves its header from `agreement.reservation.pickupLocation` while the
  phone uses the agreement's own, so moving the location after agreement creation makes the
  phone and the PDF print different business names.

**What the terminal can do, per §1.5.** `/v2/Common/Disclaimer` renders text and returns an ink
signature. So a per-section "initial" on the terminal is one `Disclaimer` call per section,
each returning a `Signature` PNG — the same artifact type
`AgreementSectionInitial.initialDataUrl` already stores. A final `/v2/Common/GetSignature` gives
the consolidated signature for `tcSignatureDataUrl`. **The data model needs no change at all.**

**The constraint that decides the design:** the docs give no explicit length cap on
`Disclaimer.Title` (its sibling `UserChoice.Title` is capped at 250), and the disclaimer text
RFM drafted for the portal in 2026-05 was **255 ASCII characters**. Our T&C sections are
substantially longer. A QD2 screen also cannot comfortably render a full section.

So terminal signing is viable **only** with per-section text that is short enough to display —
which means either short binding summaries beside the full text shown elsewhere, or an
acknowledgement model. That is a legal decision, not an engineering one. → H-1, D-20.

Note also that `backend/src/lib/terms/index.js:43-49` defines **five** `{{INITIALS_*}}` markers
for the canonical 24-section agreement — `INITIALS_S4_DECLINE`, `INITIALS_S11_CARD_ON_FILE`,
`INITIALS_S11_CNP`, `INITIALS_S11_NO_CHARGEBACK`, `INITIALS_S13_POST_RENTAL` — a **different,
older set** from the six `TC_SECTIONS` keys. Reconcile before building on either (H-13).

### 2.11 Charges — already shaped like Level 3 lines

`RentalAgreementCharge` (`schema.prisma:2607-2630`): `code`, `name`, `chargeType`
(`UNIT|DAILY|TAX|PERCENT|DEPOSIT`), `quantity Decimal(10,2)`, `rate`, `total`, `taxable`,
`selected`, `sortOrder`, `source`, `sourceRefId`.

Charges live in two mirrored tables: `ReservationCharge` (editable source of truth) mirrored
into `RentalAgreementCharge` by `syncAgreementCharges()`
(`reservation-pricing.service.js:333-470`). The rollup (`:426-467`):

```
subtotal   = Σ selected charges (chargeType ≠ TAX, not a deposit, source not FEE_ENGINE*)
taxes      = Σ chargeType === 'TAX'
fees       = Σ source startsWith 'FEE_ENGINE'
total      = subtotal + taxes + fees
paidAmount = Σ payments status PAID, method ≠ AUTH_HOLD
balance    = max(0, total − paidAmount)
```

**The real charge groups** (`source` is free-form `String?`; the taxonomy is the set of write
sites): `BASE_RATE` / code `DAILY` (`:1078`, `:1100`) · `INSURANCE` (`quotes.service.js:848`) ·
`SERVICE` / `ADDITIONAL_SERVICE` · `ADDITIONAL_SERVICE_PRECHECKIN` · `MANDATORY_FEE` (`:579`) ·
`UNDERAGE_FEE` (`:582`) · `TAX` · `QUOTE_TAXES_FEES` (`:1087`) · `SECURITY_DEPOSIT` /
`DEPOSIT_DUE` (**excluded**) · `TOLL_MODULE` / `TOLL_POLICY` · `CITATION_MODULE` /
`CITATION_ADMIN` · `DAMAGE_CHARGE` · `ADMIN_CORRECTION` (can be a **credit**) ·
`FEE_ENGINE_CHECKIN` · `EXTENSION_DEFAULT` · `KIOSK_UPSELL` · `MEX_IMPORT` (externally owned,
`:193-201`) · `MONTHLY_CYCLE`.

**Tax is summary-only.** `taxable` exists on every row but the rollup never reads it — tax is a
separate synthetic row with `chargeType: 'TAX'` and `taxable: false`, and even the base-rate row
is written `taxable: false` (`:1078-1090`). Rate input is `Location.taxRate Decimal(5,2)` (a
percent) with the frozen copy `ReservationPricingSnapshot.taxRate`; computation is
`taxes = money(base * (taxRate / 100))` (`lib/rental-money.js:29-34`).

The separate **check-in** fee engine (`fees/fee-engine.service.js`) runs at return:
`EXCESS_MILEAGE` $0.50/mi, `FUEL_REFILL` $7.00/gal, `CLEANING_LIGHT/MEDIUM/HEAVY`
$50/$100/$200, `SMOKING` $250, `LATE_RETURN` $25/hr, `CITATION_ADMIN` $35 (`:43-52`), resolved
location → tenant → hardcoded (`:112`), with `FeeRate.isActive = false` skipping a fee entirely.

### 2.12 Level 3 already exists — as a stub, on the other rail

`ipos-transact-client.js:305-344` — `autoRentalL3Data()` builds a VISA CEDP block with
`PurchaseIdFormatCode: '3'`, **enabled by default** (`:99-103`). It sends `LineItemCount: 1`
and a **single synthetic line item** ("Vehicle rental") with `TaxAmount: 0`, `TaxRate: 0`, and
header taxes hardcoded zero (`:310-315`).

RFM is *already* sending L3 on its Transact CNP transactions — badly. Two consequences:

1. **This work has a second beneficiary.** Replacing the synthetic line with real
   `RentalAgreementCharge` rows improves the existing CNP path and can be built and validated
   **with no terminal at all**.
2. `:330-341` records that Dejavoo's L3 validator can **hard-fail** transactions
   (`l2l3Flag "E"`), and an unresolved docs discrepancy on `NetGrossIndicator` (string `'N'`
   rejected, boolean accepted).

### 2.13 Route surface

`checkout-session.routes.js`: `POST /` (46), `GET /:id` (64), `GET /by-reservation/:id` (81),
`POST /:id/transition` (100), `/presence` (126), `/stamp` (150), `/customer-signature` (170),
`/terms-token` (190), `/handoff-token` (207), `/send-customer-inspection` (228), `/vehicle`
(247), `/charge` (269, legacy), `/charge-sale` (292), `/hold-deposit` (315),
`/record-manual-payment` (337), `/record-manual-deposit` (362), `GET /:id/terminal-status`
(385), `/declined-insurance` (408), `/abandon` (426).

`payment-gateway.routes.js`: `/charge` (14), `/auth-hold` (30), `/capture` (45), `/void` (60),
`/refund` (71), `/tokenize` (86), `/terminal-status` (95), `/settle` (104), `/summary` (113),
**`/callback` (122, an inert TODO stub)**, `/ops-queue` (148), `/ops-queue/:id/resolve` (163).

### 2.14 Three live defects that predate this plan

**(a) A wrong-merchant path is still open.** `rental-agreements.service.js:51-62`:

```js
async function loadTenantSpinConfig(tenantId) {
  if (!tenantId) return {};
  try {
    const row = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    return row ? {} : {};
  } catch { return {}; }
}
```

Returns `{}` unconditionally, so **every** call falls through to platform env credentials. Used
at `:4953` (card-on-file charge), `:5050` (deposit release / `voidByRrn`), `:5147` (deposit
re-auth). Exactly the defect `tenant-terminal-config.js` was written to kill, still live in a
module that was never migrated. **Not caused by this project, but this project must not build
on top of it.** → H-9.

**(b) `POST /api/payment-gateway/callback` is inert** (`payment-gateway.routes.js:122-137`).
Relevant now that we know `CallbackInfo.Url` is a real, documented mechanism on every
`/v2/Payment/*` and `/v2/AutoRental/*` request, with its own error codes (`2101` callback URL
not specified, `2102` invalid XML, `2110` internal exception). `spin-client.js:130-132` already
attaches `CallbackInfo` when a `callbackUrl` is configured — pointing at a stub.

**(c) `ipos-auth.js`'s token cache is a process-wide module singleton** (`:39-41`), flagged
in-file as single-tenant and needing to become a `Map` keyed by tenant + credential hash.

---

## 3. Architecture

**Do not create a parallel checkout.** Add a transaction-family adapter plus a profile.

```
backend/src/modules/checkout-session/          ← unchanged home of the session
  ├── state-machine.js                          ← unchanged
  ├── checkout-session.service.js               ← + resolve checkoutProfile (reuse the
  │                                                 resolvePaymentPrestampReason seam, §2.2)
  ├── spin-charge.service.js                    ← + dispatch to the AutoRental builder
  └── us-terminal/                              ← NEW, thin
       ├── autorental-payload.builder.js        ← RFM → AutoRental object (PURE)
       ├── autorental-l3.builder.js             ← charges → Level3LineItems (PURE, shared
       │                                            with ipos-transact-client, §2.12)
       ├── rental-class.js                      ← normalizeRentalClassId (restored, §4.6)
       ├── autorental-validation.js             ← validation-error decoding + the flat→nested
       │                                            field-name map (PURE, §5.4)
       ├── terminal-prompts.service.js          ← /v2/Common/* orchestration
       └── us-terminal.profile.js               ← steps, prompts, fallbacks

backend/src/modules/payment-gateway/
  ├── spin-client.js                            ← + autoRentalSale/Auth/Capture, + common.*
  └── tenant-terminal-config.js                 ← + autoRental sub-block (§6.3)

backend/src/modules/identity/                   ← NEW, §12.3
  └── identity-ingest.service.js                ← one door, pluggable sources
```

Design rules:

1. **The builders are pure functions.** In → a loaded agreement graph; out → a plain object.
   No DB, no fetch. This is what makes §11 work without a terminal.
2. **`spin-charge.service.js` keeps ownership of the money sequence.** The change swaps *which
   client method* runs — never the sale → tokenize → hold → rollback ordering, never the
   persistence.
3. **One flag decides the family, per tenant.** No per-request choice, no automatic downgrade
   (M-3).
4. **`autorental-l3.builder.js` is shared with `ipos-transact-client.js`** so the CNP rail gets
   real line items too and the L3 mapping has exactly one implementation.
5. **Normalize amounts at the client boundary** (§8.3) — one decimal type, once.
6. **Frontend:** extend the wizard page as another mode (`page.js:773-788`), not a new route.
   The CLOSED-trap logic alone (`page.js:250-299`) is not worth re-deriving.

---

## 4. Field-by-field mapping: RFM → AutoRental

### 4.1 Top-level and L2 summary

| AutoRental field | RFM source | Status |
|---|---|---|
| `Amount` | resolved sale, `spin-charge.service.js:774-777` (`Σ selected non-deposit charges − paidSoFar`) | EXISTS |
| `ReferenceId` | existing builder. **Alphanumeric, unique within the batch, ≤50.** `shortRef()` strips non-alphanumerics after a live `904 FORMAT ERROR` (`ipos-transact-client.js:162-171`); `1011 Duplicate Reference ID` is the collision code | EXISTS |
| `InvoiceNumber` | `RentalAgreement.agreementNumber` — `RA-YYYYMMDDHHMMSS-NNNN`, 22 chars (`rental-agreements.service.js:192-196`) | EXISTS |
| `TaxAmount` | `RentalAgreement.taxes Decimal(10,2)` (`schema.prisma:2334`) | EXISTS — **mandatory** |
| `LocalTaxFlag` | enum: `Location.taxRate > 0 ? 'LocalOrSales' : 'NotProvided'` | **DERIVE** — mandatory |
| `LineItemCount` | `Level3LineItems.Group.length` | COMPUTED |
| `PurchaseIdFormatCode` | `'3'` — already used on the Transact rail (`ipos-transact-client.js:317-318`) | **KNOWN** |
| `PoNumber` | only `Reservation.loanerPurchaseOrderNumber` (`:1453`), loaner-only | **N/A** — omit |
| `DestZipCode` | none. `customerZip` is the renter's *home* zip | **DOES NOT EXIST** — omit |
| `SummaryCommodityCode` | none anywhere in the schema | **DOES NOT EXIST** — §6.3 setting |
| `CustomFields.CustomerEmail` | `RentalAgreement.customerEmail` (`:2306`) | EXISTS |
| `CustomFields.CustomerMobile` | **`Customer.phoneNormalized`** (`:1350-1353`), digits-only, auto-derived on write — **not** `customerPhone`, which holds `(787) 555-1234` | EXISTS |
| `Tpn` | resolver (`tenant-terminal-config.js:213`) | EXISTS |
| `MerchantNumber` | already sent, default `1`; valid range 1–5 | EXISTS |
| `RegisterId` | **obsolete per the docs** | **do not add** |

⚠️ `CustomFields` carries a docs warning: *"Numeric fields must contain a decimal point.
For example: `"CustomFee": 1.0` or `1.00` or `"1.00"`."*

### 4.2 `AutoRentalAgreement`

| Field | RFM source | Status |
|---|---|---|
| `AgreementReferenceNumber` | `RentalAgreement.agreementNumber @unique` (`:2286`) | EXISTS |
| `PurchaseIdentifier` | same value; the Transact rail already does this and slices to 25 (`ipos-transact-client.js:317`). 22 chars fits intact | EXISTS |
| `RentalPeriod` | **enum `Daily\|Weekly\|Monthly`** — derive from duration: <7 d → `Daily`, <30 d → `Weekly`, else `Monthly`. Note `Reservation` has a `MONTHLY_CYCLE` charge source and a long-term module, so `Monthly` is real | **DERIVE** |
| `RentalDuration` | count in `RentalPeriod` units from `pickupAt`/`returnAt`. **No stored duration column exists** | COMPUTED — required |
| `AutoRentalAdjustment` | `{AdjustmentAmount, AdjustmentAuditIndicatorCode: X\|Y\|Z}` — indicator semantics undocumented | **OMIT at checkout** (nothing to adjust yet); D-4 |

⚠️ **`DateTime` values are timezone-naive.** No per-tenant or per-location timezone column
exists; the code constant is `DEFAULT_TENANT_TIMEZONE = 'America/Puerto_Rico'`
(`lib/date-utils.js:5`), with one optional `locationConfig.timezone` key read in exactly one
place (`kiosk-session.service.js:300`). **For a Los Angeles counter this is wrong by three
hours** and will misdate a `yyyy-MM-dd` pickup near midnight. → H-10.

### 4.3 `AutoRentalRenter` / `AutoRentalVehicle` / `AutoRentalPricing`

| Field | RFM source | Status |
|---|---|---|
| `RenterName` | `customerFirstName` + `customerLastName` (`:2304-2305`, both required). No full-name column | EXISTS — **transliterate** (M-5) |
| `ServiceMobile` | `Customer.phoneNormalized` | EXISTS |
| `VehicleMake` | `Vehicle.make String?` (`:837`) | EXISTS, **nullable** |
| `VehicleModel` | `Vehicle.model String?` (`:838`) | EXISTS, **nullable** |
| `RentalClassId` | **`0001`–`0032` or `9999`** | **SOLVED — §4.6** |
| `RentalRate` | the `rate` on the `chargeType = DAILY` line. `RentalAgreement` has **no `dailyRate` column**; `Reservation.dailyRate` (`:1570`) and `ReservationPricingSnapshot.dailyRate` (`:2981`) exist | EXISTS (derived) |
| `ExtraCharges` | **`array<string>`, required.** Not line items — a list of extra-charge *labels*. Map from the non-base, non-deposit `RentalAgreementCharge.name` values. The itemization goes in `Level3LineItems`, not here | EXISTS (derived) |

### 4.4 `AutoRentalPickup` / `AutoRentalReturn`

Both locations are recorded separately — `pickupLocationId` and `returnLocationId`, each a
required `Location` relation (`:2298-2302`). But `Location` (`:701-792`) is thin:

| AutoRental field | RFM source | Status |
|---|---|---|
| `DateTime` (yyyy-MM-dd) | `pickupAt` / `returnAt` | EXISTS — **required**; see the timezone note |
| `Address` | `Location.address String?` (`:708`) | EXISTS — **one free-text line** |
| `City` | `Location.city String?` (`:709`) | EXISTS |
| `State` | `Location.state String?` (`:710`) | EXISTS — free text, not a code |
| `Country` | `Location.country String?` (`:711`) | EXISTS — free text |
| `LocationId` | `Location.code` (`:706`, `@@unique([tenantId, code])`) | EXISTS — semantics unclear (D-5) |
| `RegionCode` | — | **DOES NOT EXIST** |
| `CountryCode` | — **no `countryCode` column anywhere in the schema** | **DOES NOT EXIST** |
| postal code | — not on `Location` at all | **DOES NOT EXIST** |

`LocationCodeMap` (`:5013-5023`) maps `externalCode` ↔ `locationId` per tenant — the right home
if Dejavoo assigns its own location identifiers.

### 4.5 Gaps and how to close them

| Missing | Recommended source |
|---|---|
| `Location` postal code | Add `postalCode String?`. Additive, nullable |
| `Location` ISO country code | Add `countryCode String?` (ISO-3166 alpha-2), default `'US'` for US tenants |
| `RegionCode` | Blocked on D-5. **Omit until answered** — an invented value is a 2201 waiting to happen |
| `SummaryCommodityCode` | Per-tenant setting in the `autoRental` block (§6.3) — a merchant attribute |
| `DestZipCode` | Omit. RFM does not model a destination |
| `RentalDistance` | §4.7 |
| Timezone | H-10 — needed for a US rollout regardless of this project |

### 4.6 `RentalClassId` — the answer, recovered from the 2026-05 test

SPIn requires a **4-digit numeric in `0001`–`0032`, or the catch-all `9999`**. Our
`VehicleType.code` values are ACRISS *letter* codes or empty — which produced the 2201.

The fix existed and must be restored (`doc/round-26-followups-2026-05-23.md`):

```js
export function normalizeRentalClassId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (/^\d{4}$/.test(s)) {
    const n = parseInt(s, 10);
    if ((n >= 1 && n <= 32) || n === 9999) return s;
  }
  return '9999';
}
```

It had 7 dedicated tests and **is not in the current `spin-client.js`.**

`9999` works but loses reporting granularity for chargeback evidence. The recorded followup:
map internal classes to ACRISS-numeric `0001`–`0032` via a `numericClassCode` column plus a
migration — *"probably half a day of work."*

Existing infrastructure: `AcrissCategoryMap` (`schema.prisma:5002-5011`, `acrissCode` ↔
`vehicleCategory`, `@@unique([tenantId, acrissCode])`, tenantId nullable for a global mapping)
— an import-side lookup built for the TL International feed, **not** a field on the vehicle.
Also `ExternalReservation.vehicleAcriss String?` (`:4929`), populated only on imports.

⚠️ The schema comment at `:5007` claims `vehicleCategory` matches
`VehicleType.classCode / category`. **Both are stale references — neither field exists.**

**Recommendation:** restore `normalizeRentalClassId` with `9999` as the shipping default
(Phase 2); add the numeric class map as Phase 5 polish.

### 4.7 `AutoRentalDistance` — an ordering conflict

`RentalAgreement.odometerOut Int?` (`:2326`) **is** written at checkout — confirmed by the
`Vehicle.lastOdometerSource` provenance comment (`:873-878`), which stamps
`"CHECKOUT_RES-742838"`. A second source is `RentalAgreementInspection.odometer` with
`phase CHECKOUT|CHECKIN` (`:2932`, unique on `[rentalAgreementId, phase]`).

**But the odometer is read during the inspection step, which comes *after* payment**
(`PAID → INSPECTION_HANDOFF`). At the moment the Sale fires, `odometerOut` may be null. And
`odometerIn` only exists at return, so *actual distance* is not computable at checkout at all.

`AutoRentalDistanceUnitofMeasure` is a documented enum `"Miles" | "Kilometers"` — so the unit
is at least unambiguous, even though **no distance-unit field is stored anywhere in RFM**
(miles are implied by `freeMilesPerDay`, `extraMileCharge`, `milesPerDay`, but never declared;
the only metric field is the unrelated `Location.geofenceRadiusKm`).

Options: (1) send the **mileage allowance** (`freeMilesPerDay × days`, omit when
`unlimitedMileage`) with `"Miles"`; (2) omit `AutoRentalDistance` on the opening Sale; (3) move
odometer capture before payment — **rejected**, reordering a shipped flow for a reporting field
is not a trade worth making. Recommend (1), fall back to (2). → D-7.

---

## 5. Level 3 line items

### 5.1 The mapping

Source: `RentalAgreementCharge` where `selected = true`, ordered by `sortOrder`, **excluding
deposits via `isDepositCharge()`** (§2.8) and excluding `chargeType = 'TAX'`.

| L3 field | Source | Notes |
|---|---|---|
| `Description` | `.name` | Truncate (D-8); transliterate (M-5) |
| `Quantity` | `.quantity Decimal(10,2)` | For `chargeType='DAILY'` this is rental days |
| `UnitOfMeasure` | derived from `chargeType`. The Transact stub hardcodes `'EA'` (`ipos-transact-client.js:321`) | Confirm allowed codes — D-9 |
| `UnitCost` | `.rate` | `number/double`, **dollars** (§8) |
| `TaxRate` | **derived** — see §5.2 | DERIVED |
| `DiscountAmount` | `0` — no per-line discount exists | Negative-total charges need a rule (D-10) |
| `DiscountIndicator` | `'N'` while `DiscountAmount` is 0 | Confirm values (D-10) |
| `ExtLineAmount` | `.total` | `number/double`, **dollars** |

Note the spec also exposes `QuantityExpIndicator` and `UnitPriceDecimal` (both appear as
`L2L3ValidationError` keys), and there are standalone `/v2/L3Data/AddLevel3Item`,
`/RemoveLevel3Item`, `/ViewLevel3Item` endpoints — an alternative to inlining the group, worth
knowing but not needed here.

### 5.2 Tax — the honest position

RFM computes tax at the **location** and stores one total. Charges carry a `taxable` boolean
**which the rollup never reads**, and even the base-rate row is written `taxable: false`
(`reservation-pricing.service.js:1078-1090`).

- Summary `TaxAmount` = `RentalAgreement.taxes`. **Authoritative**, and mandatory.
- Per-line `TaxRate` must be **synthesized**. With `taxable` unreliable, the only defensible
  synthesis is: apply `Location.taxRate` to non-deposit, non-fee-engine lines and `0` to the
  rest — reproducing the base the summary tax was computed from.
- **Per-line rates will not always re-sum exactly to `TaxAmount`** (rounding, PERCENT charges,
  `TAX_RECALC` adjustments). → D-11.

Making `taxable` meaningful is a pricing-engine change and is **explicitly out of scope**. → H-11.

### 5.3 The invariant that must hold before anything is sent

```
Amount == Σ ExtLineAmount (non-deposit, non-tax) + TaxAmount
```

If this does not hold, **do not send.** Fail the step with a clear agent-facing error. Given
both the 2201 history and the documented fact that Dejavoo's L3 validator can hard-fail a
transaction (`l2l3Flag "E"`, `ipos-transact-client.js:330-341`), it would likely be rejected
anyway. This check lives in `autorental-l3.builder.js` and is unit-testable with no terminal.

### 5.4 `L2L3ValidationError` / `AutoRentalValidationError` — shape confirmed, and it bites

**They are objects keyed by field name, not arrays**, and — critically —

> **they are returned inside a 200 OK on the AutoRental response.** The transaction can be
> **approved while the L3/AutoRental enrichment silently fails.**

A valid AutoRental transaction returns `ExtData` containing **`ARLFlag=Y`**.

Verbatim from the AutoRental Sale 200 sample:

```json
"L2L3ValidationError": {
  "Description": "", "PoNumber": "", "PurchaseIdentifier": "", "SummaryCommodityCode": "",
  "LineItemCount": "", "TaxAmount": "", "Quantity": "", "UnitOfMeasure": "", "UnitCost": "",
  "TaxRate": "", "DiscountAmount": "", "DebitCreditIndicator": "", "ExtLineAmount": "",
  "QuantityExpIndicator": "", "UnitPriceDecimal": ""
},
"AutoRentalValidationError": {
  "AdjustmentAmount": "", "AdjustmentAuditIndicatorCode": "", "AgreementReferenceNumber": "",
  "PickupAddress": "", "PickupCity": "", "PickupCountry": "", "PickupCountryCode": "",
  "PickupDate": "", "PickupLocation": "", "PickupRegionCode": "", "PickupState": "",
  "RentalDistance": "", "RentalDistanceUnitofMeasure": "", "RentalDuration": "",
  "RentalPeriod": "", "RentalRate": "", "RentalTime": "", "ReturnAddress": "", "ReturnDate": "",
  "ReturnLocationId": "", "ReturnRegionCode": "", "ReturnStateCountry": "", "ReturnTime": "",
  "ServiceMobile": "", "VehicleMake": "", "VehicleModel": ""
}
```

Value vocabulary, from the legacy SOAP spec's populated form: **`"Is invalid"` / `"Is
missing"`**.

⚠️ **The error keys use flat legacy XML names that do not match the nested REST request
paths.** `PickupAddress` ↛ `AutoRental.AutoRentalPickup.Address`; `PickupDate` ↛
`.DateTime`; `RentalDistanceUnitofMeasure` ↛
`AutoRental.AutoRentalDistance.AutoRentalDistanceUnitofMeasure`. And `RentalTime` /
`ReturnTime` keys exist although the REST request has **no separate time fields**.

**`autorental-validation.js` must therefore own an explicit flat→nested mapping table** so an
error routes back to the field we actually sent. That table is pure data and fully
unit-testable.

**Handling rules:**

- **Any non-empty value in either object is a failure of the L3 enrichment.** The money may
  have moved; the interchange qualification did not. Do **not** treat the transaction as fully
  successful.
- **What to do when the sale approved but validation failed** is a policy decision, not an
  engineering one: the customer has paid. Recommendation — **record the payment (the money is
  real), and raise a `PaymentOpsFlag` naming the fields**, so the enrichment gap is visible and
  fixable rather than silent. Do **not** void a good sale over a reporting defect. → H-14.
- Assert `ExtData.ARLFlag === 'Y'` as the positive signal.
- Log normalized field names at WARN; **never** the payload (renter PII).

---

## 6. Credentials and settings

### 6.1 The inventory

RFM already runs **four** Dejavoo/iPOSpays surfaces:

| Surface | File | Base URL | Card presence |
|---|---|---|---|
| **SPIn** (terminal) | `spin-client.js` | `https://api.spinpos.net` | card-present |
| **Transact** (cloud CNP w/ iPOS token) | `ipos-transact-client.js` | `payment.ipospays.com/api/v{1,2,3}/iposTransact` | card-not-present |
| **Auth Token API** | `ipos-auth.js` | `auth.ipospays.com/v1/{authenticate-token,refresh-token}` | n/a |
| **HPP** (hosted pages) | `ipos-hpp-client.js` | `payment.ipospays.com` + `api.ipospays.com` | customer-entered |

The split (`ipos-transact-client.js:8-27`): SPIn drives the terminal and returns an iPOS Token;
Transact spends that token in the cloud.

The docs confirm these are **three separate credential systems**:

1. **SPIn `Authkey` + `Tpn`** — body only, never a header. Portal: S.T.E.A.M → Edit Parameters
   → TPN → Integrations → SPIn → Cloud.
2. **Per-TPN ecom token** — hosted pages only, carried in the `Authorization` header. Portal:
   Settings → Merchant Keys/Ecom Token → select TPN → Generate Token.
3. **`apiKey` + `secretKey` → JWT** — an **ISO-admin-level** system.
   `POST auth.ipospays.tech/v1/authenticate-token` with `apiKey`/`secretKey` **headers**
   (matching `ipos-auth.js:117-134`, which records that body-only returns
   `AUTH_ERR_001 "API Key is required."`). Portal: **ISO Admin account** → Settings → Generate
   API & Secret Key.

**For a Node backend driving a QD2 over SPIn you need only TPN + Authkey, both in the JSON
body.** The JWT and ecom token are irrelevant to `spinpos.net`.

**Everything in RFM is per-TENANT. Nothing is per-location or per-terminal.** One `spin.tpn`,
one `spin.authKey`. `Location.locationConfig` holds deposit settings
(`spin-charge.service.js:174-176`) but no terminal fields. **§7 says why that has to change.**

Note `gateway: 'ipos'` selects the **customer-facing link rail only**; the counter path does
not consult it.

### 6.2 `SPInToken` — settled

`SPInToken` appears **exactly once in the entire spec**, inside the `Authkey` description
("Required if no SPInToken"). It is never declared as a field, header or schema property, and
never explained. **NOT DOCUMENTED.**

**Decision: keep `Authkey`.** It is proven against AutoRental on this very TPN (§0.1 attempt 5).
No fifth credential. D-13 remains only to confirm nothing has changed.

### 6.3 The settings delta

Extend the existing `spin` block. **No new AppSetting key** — one home, one resolver.

```jsonc
{
  "spin": {
    "enabled": true,
    "environment": "production",
    "authKey": "enci:…",           // encrypted, existing — exactly 10 chars
    "tpn": "8160…9362",            // plaintext, existing — 10-12 chars
    "merchantNumber": "1",         // 1-5
    "callbackUrl": "",
    "proxyTimeout": "120",         // 1-720

    "autoRental": {                 // NEW — all non-secret
      "enabled": false,             // the family switch, per tenant
      "summaryCommodityCode": "",   // merchant attribute
      "amountUnitsVerified": false, // §8 — the gate
      "signingMode": "PHONE",       // "PHONE" | "TERMINAL" | "HYBRID"  (H-1)
      "captureSignature": false     // transaction-level signature (#13)
    }
  }
}
```

**No `registerId`** — the docs mark it obsolete (§1.3). Every field is **non-secret**, so
nothing new needs encryption; deliberately, to keep the change inside the already-audited crypto
contract. `buildTerminalAuditMetadata` (`tenant-terminal-config.js:328`) gains booleans.

Terminal identity moves to the Location (§7), not into this block.

### 6.4 Secrets discipline — inherited unchanged

- **Encrypted at rest:** `enci:v1:<base64(iv||authTag||ciphertext)>`, AES-256-GCM under
  `INTEGRATION_ENC_KEY` (`lib/setting-secret-crypto.js:40-41`, `:57-67`).
  `encryptSettingSecret()` **throws** rather than store a new live credential in plaintext
  (`:61-65`); `carrySettingSecret()` is blank-means-keep and **never** decrypts to re-encrypt,
  so a missing key can never turn a save into an erase (`:29-32`, `:81-87`);
  `decryptSettingSecret()` is dual-read forever and returns `''` on failure, never raw
  ciphertext (`:99-115`).
- **Masked on read:** `spinBlockForRead()` (`settings.service.js:642-647`) returns
  `authKey: ''` + `hasAuthKey`. Design statement (`:633-640`): *"the settings page is not a
  credential vault"* — not the plaintext, and not the ciphertext either.
- **Write returns a re-read, never `next`** (`:1599-1601`).
- **No env defaults for tenant credentials** (`:580-584`).
- **Never in the audit trail** (`tenant-terminal-config.js:328-339`); **never in chat or a
  commit.**
- `GET /payment-capabilities` (`settings.routes.js:466-474`) is booleans-only;
  `settings.service.js:684-686` warns never to add credential material or TPNs there.

### 6.5 The registry

`backend/src/lib/tenant-provider-credential.js` — `PLATFORM_CREDENTIAL_FEATURES` (`:99-139`),
entries carrying `envVar`, `label`, `settingsPath`. Its rule (`:90-93`): *"Adding a provider
call without adding it here is the bug coming back — the registry IS the inventory."*

The AutoRental path needs **no** new entry: it inherits the tenant's own SPIn credential and
never falls back to a platform AI-style key. The **identity ingest** in §12 does use it, via
the already-registered `kiosk-id-ocr` feature. Note `:76-80` says `SPIN_ALLOW_ENV_FALLBACK`
**"is not the pattern to copy forward."**

---

## 7. Terminal addressing — settled, and it forces a schema change

**A TPN is per physical terminal.** The docs make this unambiguous via the error table:

> **`2005` Active route not found** — *"Connection was blocked on the server side. Terminal is
> not active. **Two or more devices used the same TPN.**"*

Sharing one TPN across two devices is an **error condition that blocks the connection server-
side**, not a fan-out mechanism. Supporting codes: `2003 Register not found` ("TPN wrong or does
not exist"), `2004 Route not found` ("TPN does not have configuration for SPIn proxy").

`RegisterId` is marked **`[Obsolete]`** on every endpoint. `MerchantNumber` (1–5) is a separate
multi-MID axis, not a terminal selector.

**Therefore: to run two terminals at one counter you provision two TPNs and address each by its
own `Tpn`. There is no other mechanism.**

**The consequence for RFM.** Terminal credentials are currently **per-tenant**
(`resolveTenantTerminalConfig(tenantId)`). One tenant = one TPN = one physical terminal. LAX is
one location of a multi-location tenant, so:

- A second terminal anywhere in the tenant is **impossible** today.
- The resolver must gain a **location-scoped override**, resolved **location-first, then
  tenant** — the same precedence RFM already uses for fee rates (`fee-engine.service.js:112`)
  and deposit rules.
- A session resolves its terminal from the reservation's **pickup location**. That also makes
  "which terminal do I tap" answerable in the UI.

⚠️ `Location.locationConfig` is an **unvalidated free-form JSON blob** parsed by a 12-line
tolerant parser that swallows every error and returns `{}` (`lib/location-config.js`). **A
terminal credential must not live behind a tolerant parser.** Either add real
`Location.terminalTpn` / `terminalAuthKeyEnc` columns, or give the blob an explicit validator
for this key and fail closed on a parse error. Recommend real columns — this is money.

**Preflight:** before any dual-terminal deployment, call `GET /:id/terminal-status`
(`routes:385`) per configured terminal and assert distinct devices and `TerminalStatus:
"Online"`.

---

## 8. Amount units — resolved, with a different trap than expected

### 8.1 The docs are explicit: **dollars, request and response**

Verbatim examples:

- Request — Sale: `"Amount": 25, "TipAmount": 2.5, "CustomFee": 25`; Void: `"Amount": 1`;
  Capture: `"Amount": 10, "AuthCode": "AXS854"`; Auth: `"Amount": 1`.
- Response — Sale: `"Amounts": {"TotalAmount": 1.34, "Amount": 1, "TipAmount": null,
  "FeeAmount": 0.04, "TaxAmount": 0.6}`.
- Capture: request `"Amount": 10` → response `"TotalAmount": 10.5, "Amount": 10`.

**A $1.00 sale is `"Amount": 1` (or `1.00`), never `100`.** All schema types are
`number / format: double`, including L3 `UnitCost`, `ExtLineAmount` and `TaxAmount`.

This matches what `spin-client.js` already sends — `Amount: Number(amount)` at `:232, :251,
:265, :291, :328, :353`, with no scaling anywhere in the file. **The shipped SPIn client is
correct.**

### 8.2 The real trap — three of them, none of which is cents-vs-dollars on SPIn

**(a) Number vs string, in the same response.** `Amounts.*` are JSON **numbers** (`1`, `10`,
`1.05`, `0.6`) while `ExtendedDataByApplication.*` are **strings with fixed 2 decimals**
(`"1.00"`, `"10.00"`, `"0.60"`, `"TotalAmt": "1.34"`). Same value, different JSON type and
formatting. Naive `===` comparison breaks. **This is the single most likely source of an
amount-reconciliation bug in a Node client.**

**(b) The legacy SOAP Cart really does use integer minor units.**
`https://docs.ipospays.com/spin-specification/apidocs` shows
`<Amount><Name>Total</Name><Value>2753</Value></Amount>` and `<Item><Price>807</Price>`. In the
**REST** `Cart` object the same fields are typed `number/double`. **Porting an XML Cart payload
to REST verbatim sends 100× the intended amount.** The SOAP L3 sample is itself internally
inconsistent (`<UnitCost>20.00</UnitCost>` beside `<ExtLineAmount>25</ExtLineAmount>` and
`<AltTaxAmount>1225</AltTaxAmount>`) — which is very likely the origin of the whole
cents-vs-dollars confusion.

**(c) RFM's own rails still disagree with each other.**

| Rail | Convention | Evidence |
|---|---|---|
| **SPIn** | **Dollars, number** | `spin-client.js:232` etc. — correct per the docs |
| **Transact** | **Cents, string.** `$500.00 → "50000"` | `ipos-transact-client.js:156-160` `toCents()`, applied at `:370`, `:408` — **but L3 `UnitCost`/`ExtLineAmount` stay dollars in the same payload** (`:325`, `:329`) |
| **HPP** | cents-string out; **response echoes cents** | `ipos-hpp-client.js:106-112`, `:384`; the live $1.12 → $112.00 incident |

So a shared L3 builder feeding both SPIn and Transact must emit **dollars** for L3 in both
cases — which is what Transact already does — while each client keeps its own convention for
the top-level amount. Encode that explicitly; do not let it be folklore.

### 8.3 What to build

1. **Normalize at the client boundary.** One helper converts any of `1`, `1.00`, `"1.00"` to a
   single decimal type, used for every amount read out of a SPIn response. Never compare raw.
2. **Keep the units gate, downgraded from blocker to verification.** `amountUnitsVerified`
   stays in config and the probe (§8.4) still runs — but it now *confirms* a documented answer
   rather than discovering an unknown one. It is cheap and the HPP scar earns it.
3. **Mint-anchored reconciliation on every transaction, permanently** (§8.5).

### 8.4 The probe

One SUPER_ADMIN-only diagnostic against the live IRC terminal, folded into Phase 1b:

1. One `AutoRental/Sale` for **$1.12** — the distinctive value from the HPP hunt; cents/dollars
   confusion is visually obvious ($1.12 vs $112.00) and it is already a known test amount.
2. One L3 line: `Description: "RFM UNIT PROBE"`, `Quantity: 1`, `UnitCost` = `ExtLineAmount`,
   `TaxAmount: 0`, `LocalTaxFlag: "NotProvided"`, `LineItemCount: 1`, `RentalClassId: '9999'`.
3. Record unaltered: request amounts, the whole `Amounts{}`, the whole
   `ExtendedDataByApplication`, `GeneralResponse`, both validation-error objects, and
   `ExtData.ARLFlag`.
4. **Confirm in the merchant portal what settled.** The portal is the arbiter — §2.5's lesson
   is that a request can be rejected at the gateway and never appear there.
5. Void it.
6. Write `amountUnitsVerified: true` through Settings, by hand.

### 8.5 Mint-anchored reconciliation

Mirror the HPP fix. `ipos-hpp-payment.service.js:183-205`:

> ```js
> // AMOUNT RECONCILIATION — the first live recording booked $112.00 for a
> // $1.12 charge (2026-08-30) … Units are decided by AGREEMENT with the minted
> // amount, never by guessing … An echo matching NEITHER reading is refused —
> // recording a number the gateway and the mint cannot agree on is how books
> // diverge from banks.
> ```

"Mint" = creating the payment session and recording the amount it was created for. The anchor
is written at mint time into an `AuditLog` row (`:115-128`) and read back at verify time
(`:159-171`), doing double duty as a **replay guard** and a **units anchor**.

For AutoRental: compute the intended amount once before the call; normalize the response with
§8.3(1); on disagreement **refuse to record the payment** and raise `AMOUNT_MISMATCH` into the
payment ops queue. Never record the response's number; never record the intended number as if
confirmed.

⚠️ **This reconciliation exists only on the HPP path today.** `iposTransactClient.
normalizeResponse` (`:498`) does a bare `Number(r.amount || r.totalAmount || 0)` with no units
check while the rail sends cents. **Carrying the pattern forward is part of this project.**

---

## 9. Account-level prerequisites — the Phase 0 gate

Source: `https://releases.ipospays.com/reduce-processing-costs-for-auto-rental-merchants`
(Hector, 2026-09-04).

Everything up to this point is about sending the right bytes. **This section is about whether
the merchant account is eligible to receive them.** Three account-level conditions govern
AutoRental over SPIn. None is visible from the API, none is something code can detect or work
around, and each one independently nullifies the entire project.

### 9.0 A second, independent explanation for why May 2026 failed

The 2026-05 investigation (§0.1) stopped at the `RentalClassId` format bug, because fixing it
made the terminal render the itemized cart — which looked like progress, and was. But
**rendering a cart is not the same as qualifying for auto-rental interchange**, and nothing in
`doc/round-26-followups-2026-05-23.md` records anyone checking the MCC, the processor or the POS
build. The whole night went on payload format.

So there are now two candidate root causes, and they are not mutually exclusive:

1. the `RentalClassId` format bug — **confirmed, and fixed in code**; and
2. an ineligible merchant account — **never checked, on any of the three axes below**.

**Treat the `RentalClassId` fix as necessary but possibly not sufficient.** If the account is
ineligible, restoring `normalizeRentalClassId()` will stop the 2201 and the terminal will
happily process a transaction that is *still* not identified as auto-rental — the failure
becomes silent and economic rather than loud and technical. That is a worse failure mode than
the one we had, and §9.1 is what prevents it.

### 9.1 The verification checklist — Hector runs this before any code is written

A portal read and one email. It gates Phases 1b, 2 and 4.

| # | Verify | Where | If it fails |
|---|---|---|---|
| **1** | **MCC is an auto-rental MCC: `7512`, `7513`, `7519` or `3390`** | iPOSpays portal → **Merchants → Search Merchant → Select Merchant (DBA) → Edit Store** | Transactions are **not identified as auto-rental**. Every field in §4 and §5 can be perfect and **the interchange benefit — the entire economic case for this project — never arrives.** Fixable, but an MCC change is an underwriting-level change to the merchant record, not a toggle: it goes through Dejavoo and takes as long as it takes |
| **2** | **Processor is TSYS** | **Not visible in the portal — ask Dejavoo** (D-0) | **Potential hard blocker, not a checkbox.** Dejavoo's own certification material also names **RS2, EPX, Elavon and Fiserv Rapid Connect**, and a merchant sitting on any of those may have **no AutoRental support at all**. If IRC is not on TSYS, Phases 1b/2/4 may be unbuildable regardless of how correct our code is, and the honest fallback is the existing `v2/Payment` rail carrying whatever L2/L3 that processor does accept |
| **3** | **Terminal POS build ≥ `10177`** | On the device itself | AutoRental is unavailable on that terminal. Lowest-risk of the three and self-service to fix — but it is **per device**, so a second terminal (§7) must be checked separately, and a field swap or RMA can silently regress it |

**Order of operations: run #2 first.** It is the one that can end the project, it costs one
email, and there is no point auditing MCCs on an account that cannot transact AutoRental at all.

### 9.2 Two account settings that are not blockers but must be right

| # | Setting | Detail |
|---|---|---|
| **4** | **`AgreementReferenceNumber` accepts up to 26 characters** | RFM's format is `RA-YYYYMMDDHHMMSS-NNNN` — **22 characters** (`rental-agreements.service.js:192-196`); the release note's own example, `RA-2026-0041188`, is 15. **Both fit with room to spare.** Stated explicitly so nobody truncates defensively: a truncated agreement number is a broken join between the card statement and the rental record, which is precisely the chargeback evidence the L3 data exists to provide. **Do not slice this field** |
| **5** | **Receipt toggle "Auto Rental Details" = Yes/No** | **S.T.E.A.M → Edit Parameters → Select Merchant → Edit Parameter → Receipt.** Controls whether the agreement number prints on the customer receipt. **Recommend Yes** — the printed agreement number is what lets a counter agent tie a disputed card charge to a rental without opening RFM, and it is the customer-visible half of the same evidence trail |

### 9.3 What this changes about the build order

- **Phase 1a is unaffected and should proceed regardless.** Real L3 line items on the existing
  Transact CNP path (§10) improve data quality on transactions that already run today; they do
  not depend on auto-rental interchange, on the MCC, or on the processor. Another reason it is
  the right first slice.
- **Phases 1b, 2 and 4 do not start until §9.1 passes**, because a green result there is the
  difference between "we shipped an interchange optimization" and "we shipped risk for no
  benefit".
- **If §9.1 #2 fails, the project's shape changes entirely**: it becomes a merchant-account
  conversation with Dejavoo, and the engineering fallback is Phase 1a plus whatever L2/L3 the
  incumbent processor accepts on the existing rail. Say that to Hector plainly rather than
  building toward a benefit that cannot land.

---

## 10. Build order — smallest shippable slice first

Every phase is independently revertible and behind `autoRental.enabled` per tenant.

### Phase 0 — Paper and portal (no code)
**Run the §9.1 account-eligibility checklist first — MCC, processor, POS build.** It can end or
reshape the project, and it costs one portal read and one email.

Then confirm D-1 (host), **D-17 (is this TPN provisioned for AutoRental + L2/L3)**, D-18 (does
the processor allow Void Auth), D-5 (`RegionCode`/`CountryCode`/`LocationId` semantics), and
D-20 (`Disclaimer.Title` length). Get H-1 (signing model) and H-2 (inspection default) from
Hector.

**Do not start Phase 1b without D-0 and D-17.**

### Phase 1a — Real L3 on the rail that needs no terminal *(the true smallest slice)*
Build `autorental-l3.builder.js` + `autorental-validation.js` (including the flat→nested map)
and wire them into the **existing** `autoRentalL3Data()` on the Transact CNP path
(`ipos-transact-client.js:305-344`), replacing the single synthetic line and the hardcoded zero
taxes. Ships real interchange value, exercises the whole L3 mapping and the §5.3 invariant, and
**touches no terminal.** Verifiable against CNP charges that already run today.

### Phase 1b — The terminal probe
Minimal `autorental-payload.builder.js`, restored `normalizeRentalClassId`, `AuthCode` added to
`capture()`, a SUPER_ADMIN diagnostic route, and the §8.4 probe. **Ships nothing to agents.**
Answers: does AutoRental 2201 on IRC's proxy today? Do amounts behave as documented? What do the
validation objects contain? Does `ExtData.ARLFlag` come back `Y`? And — on a single **complete,
non-aborted** transaction — does `CaptureSignature: true` return `SignatureData` (#13)?

Separately and cheaply: call `/v2/Common/Disclaimer` and `/v2/Common/GetSignature` directly
against the terminal to confirm they render and return a PNG. **That is the experiment that
unblocks Step 2, and it needs no card and no money.**

If AutoRental 2201s, the project stops here and becomes a Dejavoo provisioning ticket.

### Phase 2 — AutoRental behind the flag, money path only
`autoRentalSale` / `autoRentalAuth` / `autoRentalCapture` on `spin-client.js`; dispatch in
`spin-charge.service.js` on `autoRental.enabled`. **Same sequence, same persistence, same
rollback** — only the endpoint and payload change. Deposit lines filtered via
`isDepositCharge()`. Full L2/L3 from the Phase 1a builder with the §5.3 invariant, the §5.4
validation handling, and mint-anchored reconciliation.

Ship to IRC only. **The checkout UX is identical to today.** This is the slice a customer
touches, and it proves L2/L3 in production with no UX risk.

### Phase 3 — Pluggable identity ingest at pre-check-in
§12.3. Fully independent; could ship earlier.

### Phase 4 — Terminal prompts and terminal signing
`terminal-prompts.service.js` over `/v2/Common/*`, and whichever signing model H-1 selects.
Gated on Phase 1b's Disclaimer/GetSignature experiment and on the text-length answer (D-20).
Every failure falls back to today's phone signing.

### Phase 5 — Polish and scale
Location-scoped terminals + second-TPN support (§7); ACRISS-numeric class map replacing `9999`
(§4.6); `Location.timezone` (H-10); implement the `/callback` receiver if any flow needs it.

---

## 11. Test strategy — most of it needs no terminal

Tests are `node:test` + `node:assert/strict`.

| Layer | How | Terminal? |
|---|---|---|
| Payload builders | Pure-function unit tests: fixture agreement graphs → expected object, field by field, **including the `RentalPeriod`/`LocalTaxFlag`/`ExtraCharges` enums and array-of-strings shape** | No |
| L3 invariant §5.3 | Property test over randomized charge sets: `Amount == ΣExtLineAmount + TaxAmount` or the builder throws | No |
| `normalizeRentalClassId` | Restore the 7 original cases: letter codes, empty, out-of-range, `0001`, `0032`, `9999`, non-numeric | No |
| Deposit exclusion | `isDepositCharge()` on all three signals (`code`, `source`, legacy `name`) — the $339.20 regression | No |
| Amount normalization | `1`, `1.00`, `"1.00"`, `"0.60"` all normalize equal; `Amounts` vs `ExtendedDataByApplication` agree | No |
| Validation decoding | Populated `L2L3ValidationError` / `AutoRentalValidationError` with `"Is invalid"` / `"Is missing"`; assert a populated object is a failure **even at `ResultCode: 0`**; assert every flat key maps to a real nested request path | No |
| `ARLFlag` | Assert a missing/non-`Y` `ExtData.ARLFlag` is surfaced | No |
| Mint reconciliation | Inject a mismatched echo; assert `AMOUNT_MISMATCH` and **no payment row written** | No |
| Status codes | Assert `2005` surfaces a "two devices on one TPN" message, `2008` honours `DelayBeforeNextRequest` (parsed loosely — number, integer or string), `1004` on a void surfaces "processor does not allow Void Auth", `1500`/`1012` map to the walk-away path | No |
| Wire shape | `global.fetch` spy capturing `{url, method, headers, body}` (the `ipos-transact-client.test.mjs:19-53` idiom). Pins endpoint path, `Tpn`, `Authkey`-in-body, amount units, **absence of `RegisterId`** | No |
| Full orchestrator | `SPIN_DRY_RUN=true` — synthetic approvals drive sale → tokenize → hold → persist → transitions end to end | **No** |
| Rollback | Force deposit-auth failure in dry-run; assert the sale is voided and `rollbackPerformed: true` | No |
| Credential resolution | Extend `tenant-terminal-config.test.mjs`: location-first override, half-configured fails closed, **no secret in any log line** (`loggedText()` idiom, `:140-156`) | No |
| **Phase 1a L3** | Live CNP charges that already run today | **No** |
| **`/v2/Common/Disclaimer` + `GetSignature`** | Direct calls — **no card, no money** | **Yes, but free** |
| **2201 / provisioning** | One live request | **Yes — once** |
| **Amount confirmation** | Live $1.12 + portal check | **Yes — once** |
| **#13 signature-on-transaction** | **One complete, non-aborted transaction with a real card** — every 2026-05 test was aborted before the swipe, which is exactly why it is still unknown | **Yes** |
| Full checkout | Live at the IRC counter, override panel as recovery | **Yes** |

Prefer the **dependency-injection** idiom the HPP client uses (`ipos-hpp-client.js:319`,
`ipos-hpp-payment.service.js:83-85`) for anything new — no global mutation, parallel-safe.

**Gaps to close along the way:** nothing exercises the timeout/abort branch
(`spin-client.js:152-162`); nothing calls `abort()` or `status()`; `terminalStatus()` is
untested, unnormalized and does not decode its enum; no SPIn amount reconciliation exists.

**The recovery tool.** The SUPER_ADMIN override panel rewinds a reservation cleanly. It did not
exist during the 2026-05 tests, which is why stuck terminals left half-checked-out reservations
(`doc/dejavoo-readiness-review-2026-06-02.md` item 4).

**Its sharp edge** (same doc, item 2): the rewind **deletes `RentalAgreementPayment` rows
without voiding the hold on the terminal** — the customer's money stays held. Until the override
enumerates open holds or voids them itself, treat "override rewind on a terminal-paid
reservation" as a **manual-void situation** and say so in the runbook.

---

## 12. Identity capture at pre-check-in

### 12.1 Terminal ID scanning is not available over the API

The iPOSpays **Scanner Reader SDK** (https://docs.ipospays.com/scanner-reader-sdk) is an
**Android SDK for apps that run on the terminal** — Kotlin/Java, `ScannerActivity`,
`IScannerResult` with `startScan()`/`stopScan()`, results via `onSuccess(String result)` /
`onFailure(String errorMessage)`, branching on `Build.MODEL == "P18"`. It is **not**
REST-callable, and it does **not** parse licences — it returns an opaque string, which for a US
licence is the raw AAMVA PDF417 payload someone still has to parse.

Confirmed by the docs research: **there is no documented transport carrying a terminal-side
app's result to an external POS/backend.** `onSuccess(String)` is an in-process Android
callback; the page documents no HTTP client, no callback URL, no push.

What *does* move data terminal → integrator, none of which the scanner SDK is wired into:
`CallbackInfo.Url` (transaction results only); `/Callback/PostCallback` and
`/Callback/GetLastCallback` (documented with a completely **untyped** schema — request
`[key: string]: any`, response `{}`, no field list published); `/v2/IntermediateStatus/GetStatus`
(progress text only, gated by `IsReadyForIS`); terminal-configured custom prompts surfacing as
`ExtendedDataByApplication.Cust1/Cust1Value` … `Cust3/Cust3Value` (free text); and
`/v2/Common/UserInput`, the only API-callable way to get arbitrary typed data off the screen —
manual keying, no scan.

### 12.2 RFM already has two working ID paths

**(a) AAMVA PDF417 barcode parser — `frontend/src/lib/aamva.js`.** `parseAamva(text)` at `:73`,
element map at `:13-27`, handling both MMDDYYYY (US) and CCYYMMDD date encodings (`:41-59`).
Consumed today only by `frontend/src/components/loaner/LicenseScanner.jsx` via
`aamvaToLoanerForm()` (`:107`). Its header (`:6-8`) notes barcode decoding is far more reliable
than front-face OCR.

**(b) Vision-LLM OCR — `backend/src/modules/kiosk/kiosk-id-ocr.extract.js`.**
`extractLicenseFront({ buffer, contentType, apiKey, model })` at `:77`; prompt forbids guessing
(`:14`); ISO-8601 dates; `licenseState` as a 2-letter code including PR (`:28`); `null` for
anything not clearly readable. Credential via
`resolveCitationOcrCredential(scope, { feature: 'kiosk-id-ocr' })`, registered in
`lib/tenant-provider-credential.js`.

Its header records the decision already taken:

> *"Fase B3d: after Hector's iPad re-test the pdf417 scanner is demoted — photo + OCR becomes
> the PRIMARY ID path; the extraction is ADVISORY and the customer confirms on screen."*

**Coverage.** Pre-check-in's required fields (`backend/src/lib/precheckin-fields.js:18-34`,
hand-mirrored in `frontend/src/lib/precheckin-fields.js` — `:10-11` warns they must stay in
lockstep): `firstName, lastName, email, phone, dateOfBirth, licenseNumber, licenseState,
address1, city, state, zip, country`.

| Source | Fills |
|---|---|
| AAMVA barcode | `firstName, lastName, dateOfBirth, licenseNumber, licenseExpiry, address1, city, state, zip, country` — **10 of 12** |
| Vision OCR | `firstName, lastName, dateOfBirth, licenseNumber, licenseState, licenseExpiry` |

Either clears the pre-check-in gate for an agent-assisted checkout. Both fill `dateOfBirth` —
the field `AgeGateBlocker` exists to capture (`page.js:911-926`) — and `licenseState`, which
feeds `lib/deposit-rules.js` and therefore the LAX local/non-local deposit tier. Better licence
data means the deposit is decided on real data instead of the conservative "undeterminable ⇒
LOCAL" default.

### 12.3 The design: one door, pluggable sources

**This is the architecturally important part, and it is what keeps the terminal-app decision
cheap and reversible.**

A single backend entry point accepts an identity payload **plus its provenance**. Adding the
terminal app later is then a new *source* behind an existing door — no redesign of pre-check-in,
checkout, or the agreement.

```
POST /api/reservations/:id/identity-ingest

{
  source: 'OCR_PHOTO' | 'TERMINAL_SCAN' | 'AAMVA_BARCODE' | 'MANUAL',
  capturedAt: ISO8601,
  capturedByUserId: string | null,      // null when the customer self-served
  deviceRef: string | null,             // TPN, kiosk id, or null
  confidence: number | null,            // 0-100; null for MANUAL
  fields: {                             // the kiosk-id-ocr output shape, verbatim
    firstName: string | null,
    lastName: string | null,
    dateOfBirth: string | null,         // ISO 8601
    licenseNumber: string | null,
    licenseState: string | null,        // 2-letter, PR included
    licenseExpiry: string | null,       // ISO 8601
  },
  notes: string | null
}
```

Contract, non-negotiable in all four source cases:

1. **Same field shape.** The `kiosk-id-ocr` output shape is the canonical one; every source
   adapts to it, never the reverse. A barcode source simply fills more of it.
2. **Always advisory.** Ingest **stages** values; it never writes `Customer` or
   `RentalAgreement` directly. A human confirms on screen, and that confirmation is the write.
   This is already how the kiosk behaves and it is what makes an OCR misread a non-event.
3. **Provenance persisted per field**, so "where did this DOB come from" is answerable a year
   later during a dispute. Source, device, confidence, actor, timestamp.
4. **One confirmation UI** for every source. The agent's screen does not care whether the data
   came from a photo, a barcode or a terminal.
5. **Nothing about the source leaks downstream.** Checkout, the agreement and the deposit rules
   read confirmed `Customer` fields, exactly as today.

Existing pieces this reuses: the agent-assisted route already exists —
`POST /api/reservations/:id/precheckin/staff-complete`
(`reservations.routes.js:2321`, wrapped in `idempotency({ kind: 'vozia-precheckin' })`), which
stamps `customerInfoCompletedAt` at `:2447` and clears the checkout gate. The wizard's
`PrecheckinGateBlocker` already points the agent there (`page.js:856-858`). Target fields exist
on `Customer` (`schema.prisma:1346-1368`) and the `RentalAgreement` snapshot (`:2304-2313`),
including `dateOfBirthEnc` (encrypted `encf:v1`; when set, `dateOfBirth` is null).

**Phase 3 ships sources `OCR_PHOTO`, `AAMVA_BARCODE` and `MANUAL` behind this door.**
`TERMINAL_SCAN` is a later addition that changes nothing else.

### 12.4 Terminal ID scanning — a later accelerator, not a dependency

**It is buildable, and the gate is DvStore.** The Scanner Reader SDK's own prerequisites are a
**DvStore listing, a valid TPN, and merchant onboarding** — a custom app is published to
Dejavoo's app store and deployed from there, so it needs **Dejavoo's approval on Dejavoo's
timeline**. Contact: devsupport@dejavoo.io. Dejavoo also offers **DvPayLite** (an SDK for taking
payments from inside a terminal app) — worth knowing it exists, but it is **not** this plan's
path; SPIn semi-integration is.

**The honest cost:**

1. Build and sign a native Android app for the QD2/P18.
2. Implement AAMVA PDF417 parsing on-device — the SDK returns the raw string. (`aamva.js`
   already does this in JS and could be ported, which lowers this considerably.)
3. Build and secure a **terminal→RFM transport**: per-device auth, TLS, replay protection, and
   **reservation pairing** — the terminal must know *which* reservation a scan belongs to.
   There is no documented supported channel (§12.1), so this is entirely ours.
4. **DvStore listing and approval**, on Dejavoo's schedule, before a single device can install
   it.
5. Ongoing updates pushed through the store to physical devices in the field, with a rollback
   story.
6. Handle terminals that are not P18 (the SDK branches on model).

**The honest advantage, which is real:**

- A PDF417 read is **exact data, not a reading**. No confidence score, no misread digit in a
  licence number, no glare, no bad angle. For a legal record that is a genuine quality
  difference, not a convenience.
- It is **instant** — no photo, no upload, no model round-trip. At a high-volume counter like
  LAX, seconds per customer compound.
- It fills **10 of 12** required fields versus OCR's 6.
- The customer is already standing at the terminal, which they are not necessarily standing at
  a tablet.

**Recommendation:** ship §12.3 now with OCR and barcode-on-device sources. Open the DvStore
conversation with Dejavoo in parallel (D-25/26/27) so the option stays live. If it is
straightforward, `TERMINAL_SCAN` becomes a new source behind an existing door and everything
else is unchanged — which is exactly what §12.3 exists to guarantee.

---

## 13. Money invariants — inherited, not re-litigated

**M-1 — Never a silent fallback.** `source` is always reported and logged; a `NONE` resolution
fails the operation **before** any provider call (`tenant-terminal-config.js:64-66`). A
half-configured block fails closed exactly like a half-configured `spin` block (`:254-260`).
Location-first resolution (§7) inherits the same rule: a half-configured *location* terminal
must never be paired with the tenant's other half.

**M-2 — Mint-anchored reconciliation on every transaction.** §8.5.

**M-3 — No automatic family downgrade.** If AutoRental fails, RFM does **not** silently retry as
a plain `v2/Payment/Sale`. Two transaction families with different L2/L3 data recording against
one rental is a reconciliation nightmare and an interchange-qualification lie. Fall back to the
*manual* path, which a human authorizes.

**M-4 — Secrets are panel-only.** §6.4.

**M-5 — Transliterate customer-facing strings; keep references alphanumeric.** iPOSpays rejected
an accented customer name on the HPP path ("Héctor" broke the first mint). `RenterName`, every
L3 `Description` and every `ExtraCharges` entry get the same treatment. References must be
alphanumeric — `shortRef()` exists because of a live `904 FORMAT ERROR` on hyphens, and
`agreementNumber` is `RA-YYYYMMDDHHMMSS-NNNN`. `ReferenceId` must also be **unique within the
batch** or you get `1011`.

**M-6 — Never claim money was released without a gateway call.**
`checkout-session.scheduler.js:9-13`. Sharpened by §2.9: if the processor does not allow Void
Auth (`1004`), the honest state is "held until expiry", not "released".

**M-7 — Deposits come from the reservation, and never enter the Sale.**
`spin-charge.service.js:45-49`; `isDepositCharge()` (§2.8) — the $339.20 lesson. The LAX
local/non-local decision is read from the frozen
`ReservationPricingSnapshot.securityDepositRuleJson`, never re-derived.

**M-8 — Success codes are not sufficient.** A populated `L2L3ValidationError` or
`AutoRentalValidationError` is a failure of the enrichment **inside a 200 OK** (§5.4). The HPP
`queryPaymentStatus` fails soft — HTTP 200 with an `AuthenticationError` in the body — and that
crowned a false winner once. Equally, an unrecognised envelope must never parse to `{}` → `NaN`
→ "failed" on an approved charge (`ipos-transact-client.js:275-280`, the documented
double-charge path).

**M-9 — Vehicle status sync.** Any path setting `Reservation.status = CHECKED_OUT` **must** call
`syncVehicleStatusForReservation(...)`. The #1 blocker flagged for the original Dejavoo
orchestrator (`doc/dejavoo-readiness-review-2026-06-02.md` item 1); skipping it re-introduces
bug #44. The plan reuses the existing finalize path precisely so this cannot be forgotten.

**M-10 — CLOSED does not mean finalized.** `isFinalizeComplete()` requires **both**
`reservation.status === 'CHECKED_OUT'` **and** `rentalAgreement.status === 'FINALIZED'`
(`frontend/src/lib/checkout-session.js:300-303`), because the agreement-finalize write is
best-effort and can fail while `transition()` still returns 200
(`checkout-session.service.js:895-904`). Preserve the four-valued verdict (`page.js:273-299`).

**M-11 — Identity data is advisory until a human confirms it.** §12.3. No OCR or scan result is
ever written straight to a legal record.

---

## 14. Step machine, failure states, and fallbacks

| Hector | Session step | What runs |
|---|---|---|
| 1 Verify info | `CONFIRMING` | Agent confirms renter details (prefilled per §12) |
| 2 Initial + sign | `TC_PENDING` → `TC_SIGNED` | Per `signingMode`: PHONE (today), TERMINAL (`Disclaimer` × N + `GetSignature`), or HYBRID. Guard: `tcCompletedAt` |
| 3 Payment + tokenize | `PAYMENT_PENDING` → `PAID` | `AutoRental/Sale`, token persisted. Guard: `paymentCompletedAt` |
| 4 Deposit capture | inside the same step | `AutoRental/Auth` using the step-3 token |
| — Inspection | `INSPECTION_HANDOFF` → `INSPECTION_IN_PROGRESS` → `CUSTOMER_SIGN_PENDING` | Agent-led or customer-led (§14.2) |
| — Close | `FINALIZING` → `CLOSED` | Guard: `customerSignedAt` |

### 14.1 Failure states

**Every failure falls back to today's flow, never to a different money rail** (M-3), and every
fallback is a human decision.

| # | Failure | Detection | Behaviour | Fallback |
|---|---|---|---|---|
| F1 | Terminal offline | `TerminalStatus: "Offline"\|"NotFound"` on the preflight (routes:385) | Block step 3 before any charge | HPP payment link, or `record-manual-payment` (routes:337) |
| F2 | Gateway rejects the payload (`2201`) | `ResultCode ≠ 0` and **nothing in the portal**. Customer and agent see nothing | Hard fail. Do **not** retry as plain Sale (M-3) | Agent switches the tenant flag off; today's `v2/Payment` path |
| F3 | Validation object populated | §5.4 decoder, inside a **200 OK** | If the sale approved: **record the payment**, raise a `PaymentOpsFlag` naming the fields. Never void a good sale over a reporting defect (H-14) | Fields corrected, flag resolved by staff |
| F4 | L3 invariant §5.3 fails locally | Builder throws pre-flight | Never sent. Agent-facing error naming the discrepancy | Agent fixes charges, or falls back |
| F5 | `2008 Terminal in use` | Status code | Honour `DelayBeforeNextRequest` (parse loosely — number/integer/string), show the wait to the agent | Retry after the delay |
| F6 | Amount mismatch on response | M-2 | No payment row. `AMOUNT_MISMATCH` → ops queue | Manual reconciliation by reference |
| F7 | Customer walks away mid-signature | `1500 Signature Not Captured`, `1012 Cancelled`, or `2007` timeout (120 s default; `SPInProxyTimeout` 1–720) | Call `abort()` — **currently unwired; this project must wire it.** Session stays in its step; nothing captured | Re-prompt, or fall back to phone signing |
| F8 | **Terminal stuck after an abort** | Subsequent call returns `1012` in ~2 s | Surface a specific agent message: **power-cycle the terminal** | The documented remedy from the round-26 log |
| F9 | `1011 Duplicate Reference ID` | Status code | Regenerate the reference; never reuse within a batch | Automatic, one retry with a fresh ref |
| F10 | Sale OK, tokenize null | `extractCardOnFile` returns null (`spin-client.js:486`) | Sale persists, **warning** surfaced, card-on-file null. `PaymentOpsKind.CARD_ON_FILE_FAILED` | Deposit falls back to a second tap; autocharges go manual |
| F11 | Sale OK, deposit auth fails | Existing rollback (`spin-charge.service.js:22-27`) | **Void the sale.** `rollbackPerformed: true` | Agent retries or collects manually |
| F12 | Void of the rollback fails | Void response | **Escalate loudly** → ops queue (`ROLLBACK_FAILED`). Customer charged with no deposit | Manual void in the Dejavoo portal. Runbook |
| F13 | **`1004` — processor does not allow Void Auth** | Status code on a hold release | The hold **cannot** be released by API. Say so plainly; do **not** stamp `depositHoldVoidedAt` (M-6) | Tell the customer the hold expires on the issuer's schedule. → D-18 |
| F14 | Session abandoned with an open hold | Nightly sweep (scheduler:6-13) | Record outstanding work — never stamp released. `STRANDED_DEPOSIT_HOLD` | Staff releases via the ops queue |
| F15 | `Disclaimer` / `GetSignature` fails or is unsupported | Phase 1b experiment, or a live `ResultCode ≠ 0` | Set `signingMode: 'PHONE'`; do not ship terminal signing | Today's phone signing (`POST /:id/terms-token`, routes:190) — fully shipped |
| F16 | Section text too long for `Disclaimer.Title` | Build-time length check against the confirmed cap (D-20) | Refuse to enter TERMINAL mode for that tenant; log which section | HYBRID or PHONE |
| F17 | Override rewind on a terminal-paid reservation | Manual action | **Hold is not voided by the rewind** (§11) | Manual void; runbook |
| F18 | Two terminals, wrong one prompts, or `2005` | `2005 Active route not found` = two devices on one TPN | Preflight distinctness check (§7) | Provision a second TPN; location-scoped resolution |
| F19 | Finalize cascade fails while `transition()` returns 200 | M-10 | Closed card shows `failed`, offers retry | `retryFinalize()` re-POSTs `CLOSED → CLOSED` (`page.js:393-406`) — self-heals only reservations in `['NEW','CONFIRMED']` (`checkout-session.service.js:793`) |

### 14.2 Inspection stays configurable — no change needed

Already tenant-configurable via AppSetting `tenant:<id>:customerInspectionConfig`, shape
`{ enabled: boolean, checkinModel: 'AGENT' | 'CUSTOMER' }`, default
`{ enabled: false, checkinModel: 'AGENT' }` (`settings.service.js:998-1015`), edited at
`GET/PUT /api/settings/customer-inspection` (`settings.routes.js:254-269`, PUT is
`requireRole('ADMIN')`).

`Step4Handoff` (`page.js:1812-1948`) reads it on mount; unreadable → falls back to the old flow
(`:1829`). `enabled: false` → the historical QR-only screen. `enabled: true` → a fork offering
**"Send inspection link to customer"** (`POST /:id/send-customer-inspection`, routes:228 — the
backend emails a 24 h link and walks the session to `CLOSED` itself, with the 1.5 s poll picking
it up) or **"Do inspection for customer"**. Two further escapes exist: "Do the inspection on
this device" (`:1925-1935`, added 2026-08-19 for tablet-only agents) and "Continue here on
desktop" (`:1944`).

**The US profile sets the default and stops.** No code change.

---

## 15. Open questions

### For Dejavoo (devsupport@dejavoo.io)

| # | Question |
|---|---|
| **D-0** | **THE GATING QUESTION — ask this first, before any other. Which processor is each of our merchant accounts on, and is the MCC already one of the four auto-rental codes (`7512`, `7513`, `7519`, `3390`)?** AutoRental over SPIn is documented as requiring **TSYS**; your certification material also names RS2, EPX, Elavon and Fiserv Rapid Connect, so we need to know whether International Rental Corp (TPN `…9362`, LAX) can transact AutoRental **at all**. This single answer determines whether the AutoRental phases are buildable. If the MCC is wrong, what is the process and timeline to change it? (§9) |
| D-1 | **Host.** Is AutoRental served from `api.spinpos.net` (where our live traffic goes, and where our 2026-05 AutoRental attempts reached the terminal) as well as `spinpos.net`? Same service? |
| D-4 | Full semantics of `AutoRentalAdjustment` — when is it required, and what do `AdjustmentAuditIndicatorCode` values `X`/`Y`/`Z` mean? |
| D-5 | `LocationId`, `RegionCode`, `CountryCode` in Pickup/Return: Dejavoo-assigned, industry codes, or merchant-defined? What happens if each is omitted? |
| D-6 | Is there a published mapping from ACRISS letter codes to the `0001`–`0032` `RentalClassId` range? What does `9999` cost us in chargeback-evidence quality? |
| D-7 | `AutoRentalDistance` on an **opening** Sale: mileage allowance or actual distance (unknown at checkout)? May it be omitted and supplied later? |
| D-8 | Max length and allowed character set for L3 `Description` and for `ExtraCharges` entries — do they reject accents like the HPP endpoint did? |
| D-9 | Valid `UnitOfMeasure` codes. Is there a code for a rental day? |
| D-10 | `DiscountIndicator` allowed values, and the correct representation of a **negative** line (we have credit-style `ADMIN_CORRECTION` charges). Is that what `DebitCreditIndicator` is for? |
| D-11 | Must per-line `TaxRate` re-sum exactly to summary `TaxAmount`, or is `TaxAmount` authoritative? |
| D-13 | Confirm `Authkey` in the body is fully supported for AutoRental. What *is* `SPInToken` — it appears once in the spec, inside the `Authkey` description, and is never defined? |
| D-15 | Is there **any** supported channel by which data captured by a terminal-side app reaches an external POS/backend? Related: `/Callback/PostCallback` and `/Callback/GetLastCallback` are documented with a completely untyped schema — what is the actual payload contract? |
| D-16 | `/v2/Payment/AbortTransaction`: what exactly happens to the in-flight transaction? Does the original caller receive `1012`? What is the guarantee if the card was already authorized when the abort lands? |
| D-17 | **Is TPN `…9362` provisioned for AutoRental and L2/L3 at all?** In May 2026 our AutoRental requests reached the terminal only after we fixed `RentalClassId`; unrecognized fields have separately produced `2201` at the gateway on plain Sale. |
| D-18 | **Does IRC's processor allow Void Auth?** `1004 Not Allowed` documents *"A Void Auth requested for a processor that does not allow Void Auth."* If ours does not, how is a security-deposit hold released, and on what timetable does it expire? |
| D-19 | Confirm amounts are decimal dollars on both request and response for AutoRental including L3 `UnitCost`/`ExtLineAmount`/`TaxAmount`. Why do `Amounts.*` come back as JSON numbers while `ExtendedDataByApplication.*` come back as 2-decimal strings? |
| **D-20** | **`/v2/Common/Disclaimer`: what is the maximum length of `Title`, and how does the QD2 render long text — scroll, paginate, or truncate?** (`UserChoice.Title` is capped at 250; `Disclaimer.Title` has no documented cap.) This decides whether contract sections can be shown on the terminal. |
| **D-21** | Does `/v2/Common/Disclaimer` **require** a signature, or can the customer decline? What is returned if they refuse — `1500`, `1012`, or an empty `Signature`? |
| **D-22** | **Why did the portal-configured inline disclaimer never appear on `v2/AutoRental/Sale` in May 2026** (it did not fire, though the itemized cart and pay screen did)? Does the firmware support an inline disclaimer on AutoRental, or only on plain Sale? Is `/v2/Common/Disclaimer` the supported route for AutoRental? |
| **D-23** | Does AutoRental honour `CaptureSignature: true`? Where does the signature appear in the response? Does the TPN need signature capture enabled? |
| D-24 | **There is no incremental authorization in the spec.** For a rental that grows past its original hold, what is the supported pattern — a second `Auth`, an `AutoRental/Capture` for more than the authorized amount, or an at-return `Sale`? |
| **D-25** | **DvStore:** what does listing a custom terminal app require, and how long does approval typically take? |
| **D-26** | Can a QD2 run a third-party app **alongside** the payment app, and can our app be launched from, or launch, a SPIn transaction? |
| **D-27** | Does Dejavoo already ship an **ID-scan app** that can POST results to a merchant webhook, so we would not have to build one? |
| D-28 | `NetGrossIndicator` — the docs say string `'N'`; our validator rejects the string and accepts a boolean (`ipos-transact-client.js:330-341`). Which is correct? |

### For Hector

| # | Question |
|---|---|
| **H-0** | **Run the §9.1 checklist against the real LAX / IRC merchant record before we write any code** — MCC is `7512`/`7513`/`7519`/`3390` (Merchants → Search Merchant → Select Merchant (DBA) → Edit Store), processor is TSYS (ask Dejavoo, D-0), terminal POS build ≥ `10177`. Also set the "Auto Rental Details" receipt toggle (§9.2 #5). This is a portal read plus one email, and it decides whether Phases 1b/2/4 happen at all. Nobody checked any of it in May 2026 (§9.0). |
| **H-1** | **Signing model.** `/v2/Common/Disclaimer` shows text **and returns an ink signature**, so per-section initials on the terminal are technically possible — one call per section. But the text must be short enough for a QD2 screen (D-20), and our sections are not. Options: **(A) HYBRID** — terminal shows a short binding summary per section and captures each initial, with the full text on the printed/emailed agreement; **(B) TERMINAL** — full sections, only if D-20 allows; **(C) PHONE** — status quo. This is a legal call, not an engineering one. |
| **H-2** | Inspection default for the US profile: agent-led or customer-led? Both already work. |
| H-3 | Is a **second terminal** at LAX in scope now? Note it needs a **second TPN** — there is no other mechanism (§7). |
| H-4 | Who runs the Phase 1b experiments, and when? The `Disclaimer`/`GetSignature` test needs no card or money; the amount and #13 tests need a real card and a **completed, non-aborted** transaction. |
| **H-5** | Ship **Phase 1a** (real L3 on the existing Transact CNP path) before touching the terminal? Recommended: yes — interchange value today, zero terminal risk. |
| H-6 | Ship Phase 2 (AutoRental behind the flag, UX unchanged) before Phase 4 (terminal signing)? Recommended: yes. |
| H-7 | Phase 3 (identity ingest) is independent. Ship it earlier? We have **two** existing paths; the AAMVA barcode parser fills 10 of 12 required fields. |
| H-8 | The **$112.00 phantom payment** on RES-282260 is still unvoided. It will confuse reconciliation during testing. Clear it first? |
| **H-9** | **`rental-agreements.service.js:51-62` still routes three money paths to the platform terminal via a stub that always returns `{}`** — card-on-file charge, deposit release, deposit re-auth. This is the wrong-merchant defect `tenant-terminal-config.js` was written to kill, in an unmigrated module. Fix before or alongside Phase 2? |
| **H-10** | **Timezone.** No per-location timezone column exists; the constant is `America/Puerto_Rico`. For a Los Angeles counter, `yyyy-MM-dd` pickup/return dates will be wrong by three hours near midnight — on a financial record. Add `Location.timezone` in this project, or as its own? |
| H-11 | `RentalAgreementCharge.taxable` is written but never read; L3 per-line tax must be synthesized (§5.2). Fix `taxable` properly (a pricing-engine change), or leave it synthesized? |
| H-12 | `RentalAgreementPayment` still has **no `gateway` field** (schema:2632; flagged 2026-06-02, never done). Add it in Phase 2? Additive, low risk. Note the existing casing inconsistency: `'ipos'` vs `'SPIN'` vs `'spin'`. |
| H-13 | The canonical agreement's five `{{INITIALS_*}}` markers (`lib/terms/index.js:43-49`) are a different, older set from the six `TC_SECTIONS` keys. Reconcile before building terminal signing on either? |
| **H-14** | **Policy: the sale approves but `L2L3ValidationError` is populated.** The customer has paid; the interchange qualification is lost. Recommended: record the payment and raise a `PaymentOpsFlag` naming the fields — never void a good sale over a reporting defect. Confirm. |
| H-15 | Open the **DvStore** conversation with Dejavoo now (D-25/26/27) so terminal scanning stays a live option, even though §12.3 makes it a later addition rather than a dependency? |

---

## 16. Things this plan deliberately does not do

- **No new checkout wizard.** The existing session, state machine and 2 549-line page absorb a
  profile through the `paymentStepMode` seam (§2.2).
- **No new state machine.** Hector's four steps already are the shipped graph.
- **No new credential system.** `Authkey` + `Tpn` are the only SPIn credentials, confirmed by
  the docs (§1.3, §6.2). `SPInToken` is undocumented and is not being chased.
- **No `RegisterId`.** The docs mark it obsolete on every endpoint.
- **No sandbox re-introduction.** Removed on purpose 2026-05-29 (`spin-client.js:9-18`). Use
  `SPIN_DRY_RUN`.
- **No terminal-side Android app in this project.** §12.4 documents the cost, the DvStore gate
  and the real advantages; §12.3 makes adding it later a new source behind an existing door.
- **No DvPayLite.** It exists; SPIn semi-integration is our path.
- **No automatic fallback between transaction families.** M-3.
- **No re-derivation of the LAX deposit decision.** Frozen at reservation time (M-7).
- **No pricing-engine rework to make `taxable` meaningful.** H-11.
- **No revival of `counter-orchestrator.service.js`.** That module no longer exists; the
  `checkout-session` module is its successor and is better. Only two artifacts from the old
  branch are worth recovering: `normalizeRentalClassId()` (§4.6) and the `isDepositCharge()`
  filtering discipline (which already survives in `reservation-pricing.service.js`).

---

## Appendix A — file index

| Path | Why it matters |
|---|---|
| `doc/round-26-followups-2026-05-23.md` | **The live AutoRental test log.** `2201`/`RentalClassId`, `1012` stuck terminal, the $339.20 double-charge, open issues #12 (disclaimer) and #13 (signature) |
| `doc/architecture/2026-05-28-dejavoo-spin-checkout-redesign.md` | **The decision to drop AutoRental** (`:12`); the six-step flow and `CheckoutSession` design |
| `backend/src/modules/checkout-session/state-machine.js` | The step graph, guards, event log |
| `backend/src/modules/checkout-session/spin-charge.service.js` | The live sale → tokenize → hold → rollback orchestrator; the fail-closed terminal gate |
| `backend/src/modules/checkout-session/checkout-session.service.js` | CAS transitions, `resolvePaymentPrestampReason` (the profile seam), finalize cascade |
| `backend/src/modules/checkout-session/checkout-session.scheduler.js` | Nightly sweep; the "never claim released" lesson |
| `backend/src/modules/checkout-session/terms-signing.service.js` | Phone signing; branch-correct section resolution |
| `backend/src/modules/checkout-session/terms-content.js` | Six sections + the conditional declined-insurance seventh |
| `backend/src/modules/payment-gateway/spin-client.js` | The SPIn client, the envelope, the 2201 lesson, unwired `abort()`, `capture()` missing `AuthCode` |
| `backend/src/modules/payment-gateway/ipos-transact-client.js` | The CNP rail; **`autoRentalL3Data()` stub**; cents-as-strings; `shortRef`; envelope fallback |
| `backend/src/modules/payment-gateway/ipos-auth.js` | JWT minting; **process-wide cache singleton** |
| `backend/src/modules/payment-gateway/ipos-hpp-payment.service.js` | **Mint-anchored reconciliation** (`:183-205`) — the pattern to copy |
| `backend/src/modules/payment-gateway/tenant-terminal-config.js` | Per-tenant terminal resolution, fail-closed precedence, masking, audit |
| `backend/src/modules/settings/settings.service.js` | The write-only credential contract; `customerInspectionConfig` |
| `backend/src/lib/setting-secret-crypto.js` | `enci:` AES-256-GCM, dual-read, blank-means-keep |
| `backend/src/modules/reservations/reservation-pricing.service.js` | Charge groups, the money rollup, `isDepositCharge()` |
| `backend/src/modules/kiosk/kiosk-id-ocr.extract.js` | Identity source (b) — the field shape §12.3 standardizes on |
| `frontend/src/lib/aamva.js` | Identity source (a) — AAMVA PDF417 parser, already written |
| `backend/src/lib/tenant-provider-credential.js` | The per-tenant credential registry |
| `backend/src/lib/deposit-rules.js` | LAX local/non-local deposit tiers, frozen at booking |
| `backend/src/lib/precheckin-fields.js` | The 12 required identity fields (hand-mirrored in the frontend) |
| `backend/prisma/schema.prisma` | `RentalAgreement`, `RentalAgreementCharge`, `Location`, `VehicleType`, `AcrissCategoryMap` |
| `frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js` | The wizard; step `switch` at 767-826; the CLOSED trap at 250-299 |
| `frontend/src/lib/checkout-session.js` | `paymentStepMode`, `isFinalizeComplete`, 409 swallow allow-list |
| `backend/src/modules/rental-agreements/rental-agreements.service.js` | **The unmigrated `loadTenantSpinConfig` stub at `:51-62`** (H-9) |
| `doc/dejavoo-readiness-review-2026-06-02.md` | Vehicle-status sync blocker; override/hold interaction |
| `doc/checkin-fee-collection-dejavoo-alignment-2026-06-02.md` | Check-in fee groups; the missing `gateway` column |

## Appendix B — external references

| URL | What it settles |
|---|---|
| `docs.ipospays.com/spin-specification/RestApi` | The REST spec root; the full endpoint inventory |
| `.../RestApi/autorental/v2/autorental/{sale,auth,capture}/post` | The three AutoRental endpoints and the nested payload contract |
| `.../RestApi/spin-rest-api-methods/v2/common/{getsignature,disclaimer,userchoice,userinput,printer}/post` and `.../terminalstatus/get` | The six prompt endpoints (§1.5) |
| `.../RestApi/transaction-types-scheme` | Sale → Void; Auth → Capture/Void/TipAdjust. No AutoRental void, no incremental auth |
| `.../RestApi/error-codes-and-messages` | Status codes, the 120 s / 420 s timeouts, and `2005` "two devices used the same TPN" |
| `.../RestApi/extended-data-for-responses` | `ExtendedDataByApplication`, the `Cust1..3` custom prompts |
| `docs.ipospays.com/spin-specification/apidocs` | The legacy SOAP/XML API — **integer minor units in the Cart**, the origin of the units confusion; also the portal path to the Auth Key |
| `releases.ipospays.com/reduce-processing-costs-for-auto-rental-merchants` | **The account-level prerequisites (§9)** — auto-rental MCC `7512`/`7513`/`7519`/`3390`, TSYS processor, POS build ≥ `10177`, the 26-char `AgreementReferenceNumber` limit, and the "Auto Rental Details" receipt toggle |
| `docs.ipospays.com/scanner-reader-sdk` | Android-only, on-terminal, returns an opaque string; DvStore prerequisite |
| `docs.ipospays.com/hosted-payment-page/api-docs/*` | The ecom-token system (unrelated to SPIn) |
| `docs.ipospays.com/transaction-status-check/api-docs/generateAuthToken` | The ISO-admin apiKey/secretKey → JWT system (unrelated to SPIn) |

**Doc-access notes for whoever picks this up:** every page is JS-rendered — plain fetches return
only index shells, so a real browser is needed. `sitemap.xml`, `llms.txt` and `.md` page
variants all **404**. There is **no public OpenAPI/Swagger JSON** and no public Postman
collection for SPIn REST. `uatdocs.ipospays.tech/spin-specification/RestApi` 404s (only the SOAP
`/apidocs` exists there). REST index last updated 2026-07-14; error codes, extended data and the
transaction scheme 2026-07-13.
