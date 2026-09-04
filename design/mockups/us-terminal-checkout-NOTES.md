# US terminal checkout (iPOSpays / SPIn) — design notes

Design pass, 2026-09-04. Requested by Hector the same day.

**Deliverables**

| File | What it draws |
|---|---|
| `us-terminal-checkout.html` | The four-step US checkout session, plus where inspection sits in both settings |
| `us-terminal-states.html` | The agent's terminal-state vocabulary and the failure/fallback matrix |
| `us-precheckin-id-scan.html` | Pre-check-in ID capture with per-field provenance, agent-assisted and self-serve |
| `us-terminal-settings.html` | What a US/iPOS tenant configures |

All four are self-contained HTML, flat (no glass), brand `#8752FE`, tabular-nums, 40px targets, 11px text floor, EN/ES laid out at Spanish length — the same house pattern as `tolls-redesign-A.html`.

**Scope discipline: design only. No application code was touched.** Every claim below cites the code it came from so the build phase does not re-derive it.

Hector's brief, verbatim (2026-09-04):

> "Set up LAX payment gateway with IPOS… since we are in the US the AutoRental API portion works here and we can trigger the terminal to scan the driver's license (they have the QD2) and be able to sign the agreement on the terminal. No need for interactive contract signing for our US tenants for step 2 in checkout — they can now do that on the terminal. So let's construct a checkout session dedicated for US tenants using IPOS… We also need to ensure we are sending L2 and L3 data with our transactions. Very important that we are now using the scanner to scan IDs to prefill customer information, which is done PRIOR to the checkout session in the PRE-CHECK-IN, which agents fill out for a customer if they did not do it themselves. So for the US tenants using IPOS the new checkout should be: **Step 1 verify info, Step 2 initialling and signing contract on terminal, then payment with card on file and tokenization, then security deposit capture.** Inspection can still be altered to be done by the agent or pushed to the customer in the settings."

---

## 1. The single most important finding: most of this already exists

The brief reads as a new integration. It is not. RFM already drives a Dejavoo terminal in production.

| Capability | Status | Where |
|---|---|---|
| SPIn terminal client (Sale, Auth, Capture, Void, GetCard, TerminalStatus, Abort) | **Shipped, live** | `backend/src/modules/payment-gateway/spin-client.js` |
| Per-tenant terminal resolution, fail-closed | **Shipped** | `backend/src/modules/payment-gateway/tenant-terminal-config.js` |
| Card-present sale → token → CNP deposit hold, with rollback | **Shipped** | `backend/src/modules/checkout-session/spin-charge.service.js` |
| Transact CNP rail (PreAuth type 5, token charge type 1, void by RRN) | **Shipped** | `backend/src/modules/payment-gateway/ipos-transact-client.js` |
| Level 3 / VISA CEDP block | **Shipped, one line** | `autoRentalL3Data()` in `ipos-transact-client.js:305` |
| Licence-photo OCR → customer fields + confidence | **Shipped** | `backend/src/modules/kiosk/kiosk-id-ocr.extract.js` |
| Six-clause T&C with per-section initials | **Shipped, on the phone** | `backend/src/modules/checkout-session/terms-content.js` |
| Deposit rules (local/non-local, debit uplift) | **Shipped** | `spin-charge.service.js:166,211` |
| HPP payment links, fail-closed | **Shipped** | `backend/src/modules/payment-gateway/ipos-hpp-*.js` |

**What is genuinely new** is four things, and only four:

1. Moving contract signature and initials from the renter's phone onto the QD2 (`/v2/Common/Disclaimer` + `/v2/Common/GetSignature`).
2. Expanding the L3 block from one synthetic line to real agreement line items, and populating the AutoRental block.
3. Switching the sale/auth endpoints from `/v2/Payment/*` to `/v2/AutoRental/*`.
4. Surfacing terminal state to the agent as a first-class vocabulary rather than a thrown error string.

Sizing the work against that table, rather than against the brief, is the difference between a phase and a project.

---

## 2. Design decisions, with reasons

### D1 — The backend state machine does not change

**Decision.** No new `CheckoutStep` values. `CONFIRMING → TC_PENDING → TC_SIGNED → PAYMENT_PENDING → PAID → …` is untouched.

**Why.** `state-machine.js` is small, strict, and load-bearing: `ENTRY_REQUIRES` guards `TC_SIGNED` on `tcCompletedAt` and `PAID` on `paymentCompletedAt`, and `checkout-cas-transition.test.mjs` / `checkout-stale-version.test.mjs` pin the CAS behaviour. A parallel US state graph would double every one of those guards and every test that covers them, for zero user-visible benefit. Hector's four steps are a *presentation*; the machine underneath is already the right shape.

**How the four steps map.**

| Hector's step | Backend state | Renderer |
|---|---|---|
| 1 · Verify info | `CONFIRMING` | `Step1Confirm`, extended with provenance badges |
| 2 · Contract on terminal | `TC_PENDING → TC_SIGNED` | **New** `Step2TerminalContract`, chosen by tenant config |
| 3 · Payment + tokenization | `PAYMENT_PENDING` | `Step3PaymentPending`, sale row only |
| 4 · Security deposit | `PAYMENT_PENDING → PAID` | Same component, deposit row promoted to its own tracker step |

Steps 3 and 4 are two tracker entries over one backend state. `Step3PaymentPending` already runs sale and deposit as two separately-triggered actions with independent status; the tracker simply stops pretending that is one step. Splitting the state would break the `paymentCompletedAt` entry guard for no gain.

### D2 — Contract mode is a renderer switch, not a fork

**Decision.** A tenant/location setting selects which component `TC_PENDING` renders. Both write `tcCompletedAt` and both write `AgreementSectionInitial` rows.

**Why.** This is what makes the fallback trustworthy. When the terminal dies mid-contract the agent presses one button and the *same session* continues on the phone — no state migration, no divergent audit trail, no second finalize path. It also means the terminal path inherits every guard, test and finalize behaviour the web path already has.

**Consequence.** Clauses accepted on the terminal must persist as they are accepted, not in one batch at the end, so a fallback resumes at clause 4 rather than clause 1.

### D3 — Six terminal prompts, one per clause

**Decision.** Each of the six `TC_SECTIONS` becomes its own `Disclaimer` op, with a `4 / 6` progress marker; one `GetSignature` at the end.

**Why.** `AgreementSectionInitial` is keyed by `sectionKey`, and the agreement PDF renders per-section initials. Collapsing to one prompt would silently empty that table and change what the tenant's contract looks like — a legal artefact, altered by an integration detail.

**The risk, named.** Six prompts is a lot of taps on a 4.3″ screen, and long clause bodies may not scroll. The fallback design (one combined Disclaimer, initials moved to the printed receipt) is drawn as a *setting*, not a default, because it degrades the audit trail. See §7 Q4.

### D4 — The terminal-state vocabulary is the feature

**Decision.** Eleven named states, each resolving to exactly one of five verdicts (Wait / Retry / Fall back / Stop / Continue), with at most two buttons.

**Why.** A web form fails one way: the request errored. A terminal fails eleven ways, and the agent's correct action differs in each. Today `Step3PaymentPending` renders `err?.message || 'Sale failed'` — a raw gateway string, in a queue, to someone who has thirty seconds. The vocabulary is what turns that into an instruction.

**The rule the matrix encodes.** *A failure whose money condition is known gets a button. A failure whose money condition is unknown gets a status query first and no button at all.* This is the same posture the HPP rail already enforces ("never trust the redirect — record only after a server-side `queryPaymentStatus`"). The cell that tests it is **sale timeout**: the tap may have captured, so offering "retry" there is how a renter gets charged twice.

### D5 — Fall back as a unit, not per-step

**Decision.** One control — "Switch this checkout to the web flow" — moves contract, payment and deposit together.

**Why.** Three independent fallbacks produce a checkout signed on the terminal, paid by link, holding no deposit, with nobody noticing until the car comes back damaged. The states that trigger fallback (terminal offline, gateway rejected) affect all three operations anyway.

**Cost, shown on screen.** HPP mints with `requestCardToken: false` and carries no L3 block, so a fallback payment loses card-on-file *and* the interchange benefit. The agent should be told they are choosing that, not discover it later.

### D6 — Deposit stays a separate operation and keeps its rollback

**Decision.** Step 4 remains a distinct PreAuth on the token from step 3, and the existing rollback (sale + failed hold → `Void`) stands.

**Why.** It is already correct and already tested (`spin-charge.test.mjs`, `stale-preauth-flag.test.mjs`). The temptation in a "simplified" US flow is to fold the deposit into the sale or skip it when it fails; both leave the tenant carrying uninsured risk on a car that has already driven away.

**Addition.** The deposit *arithmetic* is shown, not just the total: base → local/non-local rule → debit uplift. Both rules only ever raise, both fire after the reservation was priced, and a renter who sees $300 on their booking and $500 on their bank app will call. The agent needs the sentence that explains it.

### D7 — Provenance is the heart of the pre-check-in screen

**Decision.** Every customer field carries a badge: Scanned / Confirmed / Corrected / Typed / Unread. Confirmation is an explicit human act that promotes Scanned → Confirmed with the agent's user id.

**Why.** RFM's extraction is advisory by construction — `idPhotoExtract()` "stamps NOTHING", and the prompt forbids guessing (*"If a field is not CLEARLY readable, use null. NEVER guess or invent a value."*). That is the right posture, and it creates an obligation: if the machine is allowed to be unsure, the UI must show where it was. A licence number OCR'd at confidence 71 and a licence number a human read off the card are different facts, and only one of them should end up on a signed contract unexamined.

**Unread fields are a normal state, not an error.** A red empty row means the system was honest. Styling it as a failure teaches agents to make the red go away, which is exactly the wrong instinct.

### D8 — Manual entry is a peer of the photo path, always

**Decision.** "Type everything" sits next to the primary action at equal visual weight, from the first render, on both the agent and customer surfaces.

**Why.** Three distinct failures (`OCR_UNAVAILABLE` 503, `EXTRACT_FAILED` 502, `EXTRACT_LIMIT` 429) plus "no licence in hand" plus "camera won't focus" all land in one place. Making that place a *fallback* implies the flow is broken; making it a *peer* means the flow is complete either way. The renter sees one message for all three error codes — they cannot act on the difference. The agent sees the distinction, because `OCR_UNAVAILABLE` means "tell an admin to configure a key".

### D9 — Credentials are panel-only, write-only, masked

**Decision.** No env vars for a configured tenant, no chat, no read-back. Saving returns booleans and a masked TPN; the audit log records *that* a key changed.

**Why.** This is already RFM's posture and it was learned expensively — `tenant-terminal-config.js` exists because every tenant was silently charging through the platform's env terminal. The design adds nothing here except making the *three credential families* legible, because they are genuinely confusing and a mismatched pair produces a 401 nobody can diagnose.

### D10 — Inspection is untouched

**Decision.** The existing `GET /api/settings/customer-inspection` `{ enabled, checkinModel }` setting continues to decide, unchanged.

**Why.** Hector asked for it to remain configurable, and it already is. The one US-specific consequence: on the terminal path the renter signed in step 2, so the second signature at `CUSTOMER_SIGN_PENDING` is redundant. It should be raised only when the walkthrough finds **new** damage — and then it goes back to the QD2, not to a phone.

### D11 — Terminal-side ID scanning is out

**Decision.** Not drawn in any mockup.

**Why.** Dejavoo's Scanner Reader SDK is an **Android SDK for apps running on the terminal** (`ScannerActivity`, `IScannerResult`, `startScan()`, `onSuccess(String result)`) — not a REST operation RFM can trigger — and it returns an opaque string rather than parsed licence fields. Using it means shipping an RFM Android app onto every terminal, parsing AAMVA ourselves, and building a terminal→backend transport. Hector already demoted a pdf417 scanner in favour of photo + OCR after an iPad re-test. Cost is recorded in §7 as a future option; it is not a phase of this work.

---

## 3. Terminal state vocabulary — reference

| State | Verdict | Trigger | Money |
|---|---|---|---|
| `IDLE` | Continue | `TerminalStatus` OK, no txn | — |
| `PROMPTING` | Wait | op sent, HTTP open | — |
| `CUSTOMER_READING` | Wait | Disclaimer displayed, countdown running | — |
| `CAPTURING_SIGNATURE` | Wait | `GetSignature` open | — |
| `SIGNED` | Continue | all clauses + signature returned | — |
| `DECLINED_BY_RENTER` | Stop | renter chose Decline on a clause | — |
| `TIMED_OUT` | Retry | `proxyTimeout` (120 s) elapsed | **unknown on a sale** |
| `BUSY` | Wait | terminal holds another txn | — |
| `TERMINAL_OFFLINE` | Fall back | `TerminalStatus` unreachable / 130 s client timeout | — |
| `CARD_DECLINED` | Retry | issuer decline | nothing captured |
| `NOT_CONFIGURED` | Stop | `TERMINAL_NOT_CONFIGURED` 409 | nothing attempted |
| `GATEWAY_REJECTED` | Stop / Fall back | `StatusCode 2201` class | nothing captured |

Full per-step matrix with actions and fallbacks: `us-terminal-states.html` §2.

Two states deserve their own line.

**`GATEWAY_REJECTED`.** The 2026-05-30 lesson, recorded in `spin-client.js`: adding `GetToken`, `EnableTip` or `PrintReceipt` produced `StatusCode 2201` with **nothing appearing in the Dejavoo merchant portal** — the gateway rejected the payload before the terminal saw it. Retrying an identical payload cannot help. This matters directly for the AutoRental work: every new field the L3/AutoRental block introduces is a candidate for the same rejection, which is why phase 1 keeps the proven payload and phase 2 adds fields one at a time.

**`BUSY`.** RFM cannot currently produce this state honestly. See §6.

---

## 4. Failure and fallback matrix

Rendered in full in `us-terminal-states.html` §2. The three cells worth repeating:

**Sale timeout — the dangerous one.** Money condition is UNKNOWN. Query `/v2/Payment/Status` on the reference before offering the agent any action at all. No retry button until the query answers.

**Sale OK, token missing.** Sale captured, no card on file. Try `GetCard` to tokenize without re-charging. If that fails, continue with a **persistent** warning, never a toast — the loss is silent and total: tolls, fuel, fines, citations, cleaning, damage and late-return hours all become uncollectable. Raise `CARD_ON_FILE_FAILED` in the payment-ops queue.

**Hold declined *and* void fails.** Renter charged, no deposit, sale not reversed. Do not close the checkout. Raise `ROLLBACK_FAILED` with reference and amount. This is the only cell with no fallback, because there is no software answer to it.

The `PaymentOpsFlag` kinds already exist: `STRANDED_DEPOSIT_HOLD`, `ORPHAN_PAYMENT`, `ROLLBACK_FAILED`, `CARD_ON_FILE_FAILED`, `NAME_MISMATCH_REVIEW`. The design uses them rather than inventing new ones.

---

## 5. L2 / L3 mapping from an RFM agreement

### What exists today

`autoRentalL3Data({ amount, agreementNumber, description, today })` — `ipos-transact-client.js:305` — emits a valid single-line CEDP block:

```
Header : TaxAmount 0, LocalTaxFlag 0, NationalTaxAmount 0, TotalDiscountAmount 0,
         FreightAmount 0, DutyAmount 0, LineItemCount 1,
         PurchaseIdentifier <agreementNumber, 25 chars>, PurchaseIdFormatCode '3', OrderDate
items[]: Description(35), Quantity 1, UnitOfMeasure 'EA', UnitCost, TaxAmount 0,
         TaxRate 0, DiscountAmount 0, ExtLineAmount, NetGrossIndicator false, TaxIndicator 0
```

`PurchaseIdFormatCode: '3'` is already "Auto Rental Agreement Number". `agreementNumber()` produces `RA-<14 digits>-<4 digits>` = 21 chars, inside the 25-char `PurchaseIdentifier` cap. Callers are `preAuthDeposit` and `chargeWithToken`, gated on `autoRental !== false && cfg.autoRental`.

**So the work is expanding a working payload, not building one.**

### Source of the line items

`RentalAgreementCharge` rows (`schema.prisma:2607`): `code, name, chargeType, quantity, rate, total, taxable, selected, sortOrder, source, sourceRefId`. `ChargeType = UNIT | DAILY | TAX | PERCENT | DEPOSIT`.

The canonical read is `reservationPricingService.getPricing()` (`reservation-pricing.service.js:741`) → `{ snapshot, charges, totals: { subtotal, taxes, total } }`, after `syncAgreementCharges` mirrors reservation charges onto the agreement.

### Field mapping

| L3 field | RFM source | Notes |
|---|---|---|
| `Description` | `RentalAgreementCharge.name` | Truncate to 35. Names already carry their group: `"Insurance: Full Protection"`, `"Service: GPS Navigation"`, `"Fee: Airport Surcharge"`, `"Toll Charge - <plaza>"` |
| `Quantity` | `.quantity` | |
| `UnitOfMeasure` | derived from `.chargeType` | `DAILY → 'DAY'`, `UNIT → 'EA'`, `PERCENT → 'EA'`. **New derivation** — see gap 2 |
| `UnitCost` | `.rate` | |
| `ExtLineAmount` | `.total` | |
| `TaxRate` | resolved location/snapshot tax rate when `.taxable`, else 0 | **Allocated, not stored** — see gap 1 |
| `TaxAmount` (line) | 0 | Tax stays in the header; RFM has no per-line tax amount |
| `DiscountAmount` | `abs(.total)` on the discount line | Identified by `name === 'Discount'` — see gap 6 |
| `DiscountIndicator` | true on that line | |
| `LineItemCount` | count of non-deposit selected charges | |
| **Header** `TaxAmount` | the single `chargeType:'TAX'` row's total | |
| **Header** `LocalTaxFlag` | 1 when a tax row exists | RFM models one rate, no state/local split |
| **Header** `TotalDiscountAmount` | sum of negative-total lines | |
| **Header** `PurchaseIdentifier` | `RentalAgreement.agreementNumber` | 21 chars, fits |
| **Header** `PurchaseIdFormatCode` | `'3'` | already correct |
| **Header** `OrderDate` | agreement create date | |

### The real charge groups, by `source`

Observed across `booking-engine.service.js:1871`, `rental-agreements.service.js:3207+`, and the fee engine:

`BASE_RATE` / `DAILY` · `MANDATORY_FEE` · `UNDERAGE_FEE` · `WEBSITE_FEE` · `SERVICE` / `ADDITIONAL_SERVICE` / `ADDITIONAL_SERVICE_PRECHECKIN` / `KIOSK_UPSELL` · `SERVICE_LINKED_FEE` · `INSURANCE` · `TAX` / `TAX_RECALC` · `DEPOSIT` / `DEPOSIT_DUE` / `SECURITY_DEPOSIT` · `TOLL_MODULE` / `TOLL_POLICY` · `DAMAGE_CHARGE` · `FEE_ENGINE_CHECKIN` · `ADMIN_CORRECTION` · `ISSUE_CENTER` · `OTA_PREPAID_VOUCHER` · `MEX_IMPORT` · `HOST_ADDON` · `MONTHLY_CYCLE`

For a check-out sale, the ones that appear are `BASE_RATE`, `INSURANCE`, `SERVICE`, `MANDATORY_FEE`, `UNDERAGE_FEE`, `WEBSITE_FEE`, `SERVICE_LINKED_FEE`, `TOLL_POLICY`, `TAX`, and the unsourced `Discount` line.

**Excluded from L3 entirely:** everything `isDepositCharge()` matches — `chargeType:'DEPOSIT'`, or `source ∈ {DEPOSIT_DUE, SECURITY_DEPOSIT}`, or `name ∈ {'SECURITY DEPOSIT', 'DEPOSIT (DUE NOW)'}`. These are not purchases; they ride the separate PreAuth.

**Existing grouping seam.** `backend/src/modules/reports/daily-business.math.js` exports `SECTION { TIME, MISC, TAX, DEPOSIT, RECEIPT }` and `groupOf(charge)`, which already parses the `"Insurance: x"` / `"Service: x"` / `"Fee: x"` / `"Toll Charge - x"` name conventions. It is the only place in the codebase that decides what belongs together, and it is the natural place to hang L3 grouping rather than writing a second classifier.

### AutoRental block mapping

| AutoRental field | RFM source |
|---|---|
| agreement reference | `RentalAgreement.agreementNumber` |
| `RentalPeriod` / `RentalDuration` | `Reservation` pickup/return datetimes; duration in days |
| renter name / mobile | `Customer.firstName/lastName`, `.phone` |
| vehicle make / model | `Vehicle.make`, `.model` |
| `RentalClassId` | `VehicleType.code` — **not** ACRISS; ACRISS lives in `AcrissCategoryMap.acrissCode` and only on integration paths |
| pickup / return DateTime + address | `Location.address/city/state/country` |
| `LocationId` | `Location.id` — or the Dejavoo-side location code if they require their own; **open question** |
| `RentalDistance` + unit | `RentalAgreement.odometerOut` at check-out; distance is derived (`odometerIn − odometerOut`), so at check-out it is 0 / not yet known |
| `RentalRate` | `Reservation.dailyRate` |
| `ExtraCharges[]` | the non-`BASE_RATE`, non-tax, non-deposit charge rows |
| adjustment amount | `Discount` line, or `ADMIN_CORRECTION` rows |

### Gaps that must be closed before L3 can be built

1. **No per-line tax.** A charge row carries `taxable Boolean` only; tax is one synthesized `chargeType:'TAX'` row named `"Sales Tax (9.50%)"`. L3 wants `TaxRate` per item. **Proposed rule:** stamp the resolved location/snapshot rate onto every `taxable:true` line, leave line `TaxAmount` at 0, and carry the real total in the header `TaxAmount`. Header and lines then reconcile without adding columns. Confirm with Dejavoo that a non-zero `TaxRate` with a zero line `TaxAmount` is accepted (§7 Q6).
2. **No unit-of-measure vocabulary.** `AdditionalService.unitLabel` is free text ("Unit", "Seat", "Tank"). Derive `UnitOfMeasure` from `chargeType` rather than from the label.
3. **`feeType` lives only in `sourceRefId`.** Fee-engine lines are all `chargeType:'UNIT'`, `source:'FEE_ENGINE_CHECKIN'`, with the discriminator in `sourceRefId`. Fine for description text, not a group key.
4. **Counter-path `Fee` lines carry `source: null`** (`rental-agreements.service.js:3242`). They can only be grouped by name convention.
5. **`CITATION_ADMIN`** exists in `HARDCODED_RATES` but has no `FEE_TYPE_METADATA` row — no label, not editable. Unrelated to L3, worth a cleanup ticket.
6. **No `Discount` source constant.** The discount line is `name: 'Discount'` with a negative total and no `source`, so `TotalDiscountAmount` has to be found by name. Fragile; adding `source: 'DISCOUNT'` is a one-line fix that should ride with this work.
7. **Deposits are charge rows but excluded from `total`/`balance`.** Already handled by `isDepositCharge()` — the L3 builder must reuse that predicate rather than re-implement it.

---

## 6. Structural gaps in RFM that this feature exposes

**G1 — One terminal per tenant.** There is no `Terminal`, `Register`, `Device` or `PosDevice` model. A terminal is an `(authKey, tpn)` pair in `AppSetting`, with no location or register dimension. Two LAX counters on one tenant collide on one QD2, and RFM cannot say who holds it — which is why the `BUSY` state cannot currently be drawn honestly. The settings mockup shows a Registers panel marked *proposed, phase 3*.

**G2 — `ipos-auth.js` token cache is a process-wide singleton**, self-documented as single-tenant: *"if/when we go multi-tenant this becomes a Map keyed by tenantId+credentials hash."* The deposit hold runs through Transact, so a second US tenant with their own iPOS credentials would collide on this cache. **This must be fixed before the second US tenant, not before the first.**

**G3 — Transact credentials are env-only.** `IPOS_TRANSACT_API_KEY` / `_SECRET_KEY` / `_AUTH_TOKEN` are read from env or a camelCase `tenantConfig` that nothing writes. The settings panel draws them as tenant fields; wiring them to the `AppSetting` blob is part of phase 3, and is the same change as G2.

**G4 — `SPIN_ALLOW_ENV_FALLBACK` still defaults to allowed.** The platform terminal remains reachable, with a per-charge WARN naming the tenant. Correct as a deploy-safety default; the goal state is `false` once every tenant is configured. Worth tracking as the migration backlog it is.

**G5 — `voidByRrn` may never have executed against the gateway.** Its own comment says so as of 2026-07-25. Deposit release is on the critical path for this feature's credibility ("released within 7 days"). Needs a live test before LAX goes wide.

**G6 — HPP does not tokenize.** `requestCardToken: false` is hardcoded in the mint. A fallback payment therefore produces no card on file. Flipping it is one flag plus a storage target, and would make the fallback materially less lossy.

---

## 7. UNKNOWN — must be answered by Dejavoo before build

Ordered by how much they block.

**Q1 · ID scanning — settled, recorded for completeness.**
*Can RFM trigger a licence scan on the QD2 over REST?* **No.** The Scanner Reader SDK is an Android SDK for apps installed on the terminal, returning an opaque string with no AAMVA parsing. Revisiting it costs: an RFM Android app, AAMVA parsing, a terminal→backend transport, and device deployment across every terminal. Not a phase of this work. The photo + OCR path RFM already ships is the design.

**Q2 · What is the correct AutoRental base URL?**
The brief cites `https://spinpos.net/v2/AutoRental/Sale`; RFM's live client uses `https://api.spinpos.net` and has the sandbox path deliberately removed. Are `AutoRental/*` served from the same host and the same `Authkey`+`Tpn` header pair as `Payment/*`, or a different host/credential? **Blocks phase 2.**

**Q3 · Is `AutoRental/Sale` a drop-in for `Payment/Sale`?**
Same response envelope (`GeneralResponse.StatusCode`, `Token`, `IPosToken`, `CardData`, `EMVData`)? Same `ReferenceId` semantics for `Void` dedupe? Given the `StatusCode 2201` history, are there fields `Payment/Sale` tolerates that `AutoRental/Sale` rejects, or vice versa? **Blocks phase 2.**

**Q4 · Disclaimer ergonomics on a QD2.**
Max body length? Does it scroll? Can the button labels be set (`I agree` / `Acepto`)? Can it capture initials, or only accept/decline? Is there a per-op timeout separate from `proxyTimeout`? Six sequential Disclaimers — is that a supported pattern or an abuse of the op? **Blocks phase 1.** If initials cannot be captured on the terminal, D3 changes shape: accept/decline per clause on the terminal, with initials synthesized from the signature — which needs Hector's and counsel's sign-off.

**Q5 · `GetSignature` output.**
Format and resolution of the returned image? Size limits? Does `CaptureSignature: true` on `Sale`/`Auth` return the same artefact as the standalone `/v2/Common/GetSignature`, and can one signature cover both the agreement and the payment receipt, or are two captures required? **Blocks phase 1.**

**Q6 · L3 tax acceptance.**
Will the rail accept a line with non-zero `TaxRate` and zero line `TaxAmount`, with the real tax total in the header? Is `LocalTaxFlag` meaningful for a jurisdiction RFM models as a single rate? Which fields are genuinely mandatory vs merely rate-qualifying — i.e. what is the minimum block that still earns the interchange benefit? **Blocks phase 2.**

**Q7 · `LocationId` in the AutoRental block.**
Dejavoo's own location identifier, or free text? If theirs, where does an operator get it, and does it need a settings field?

**Q8 · Terminal concurrency.**
Does the gateway reject or queue a second op sent to a busy TPN? What does it answer? This determines whether `BUSY` is a state RFM detects or one it infers from a timeout.

**Q9 · `TerminalStatus` semantics.**
What does it report beyond reachability — idle vs in-transaction, battery, paper? The agent-facing "Terminal ready" chip is only as honest as this answer.

**Q10 · Printer op.**
Can `/v2/Common/Printer` print an arbitrary agreement summary, or only gateway-generated receipts? Determines whether "print the contract at the counter" is available as a tenant option.

---

## 8. Build order

Sequenced so the first slice is shippable on its own and each phase is independently reversible.

### Phase 0 — Answer Q2–Q5 (no code)

One call with Dejavoo. Nothing below is safe to estimate until Q2 and Q4 are answered, because Q4 can change D3's shape and Q2 decides whether phase 2 is a new client or a new method.

### Phase 1 — **Smallest shippable slice: contract on the terminal**

The whole value of Hector's step 2, with no payment changes at all.

- Tenant/location setting `checkoutContractMode: WEB_QR | TERMINAL` (default `WEB_QR`).
- `Step2TerminalContract` component; `TC_PENDING` renders it when the mode is `TERMINAL`.
- Backend: sequence six `Disclaimer` ops + one `GetSignature`; persist each `AgreementSectionInitial` as it is accepted; stamp `tcCompletedAt`.
- Terminal-state vocabulary and the agent ladder — all eleven states, because they are needed the moment a terminal is in the loop.
- Fallback to `/sign/:token`, resuming at the clause that failed.
- Deposit clause renders the **resolved** deposit amount (fixes the hardcoded $500 in `deposit_post_charges`).

**Ships behind a per-tenant flag, default off.** Payment continues to run exactly as it does today. Reversible by flipping one setting. **This is the slice to build first.**

### Phase 2 — AutoRental endpoints + real L2/L3

- Switch sale and auth to `/v2/AutoRental/*` (pending Q2/Q3).
- Populate the AutoRental block from the agreement.
- Expand `autoRentalL3Data()` from one line to real line items; add the `UnitOfMeasure` derivation and the tax-rate allocation from §5.
- Add `source: 'DISCOUNT'` to the discount line.
- **Add fields incrementally, verifying in the Dejavoo merchant portal after each**, because `StatusCode 2201` is a payload rejection the terminal never sees.

Presentation change: promote the deposit row to its own tracker step. No state-machine change.

### Phase 3 — Multi-terminal and per-tenant Transact credentials

- `Terminal` / `Register` model with a location dimension (G1).
- Key the `ipos-auth` token cache by tenant (G2) and move Transact credentials into `paymentGatewayConfig` (G3).
- Terminal lease so `BUSY` names the holding session.
- Registers panel in Settings.

Required before a **second** US tenant, not before the first.

### Phase 4 — Pre-check-in provenance

- Provenance badges on the staff panel and the customer portal.
- Carry provenance into checkout step 1; confirmation promotes Scanned → Confirmed with the agent's user id.
- Extend the OCR prompt to address fields (a prompt change; verify quality before relying on it).
- Retention disclosure on the staff panel, matching the kiosk's.

Independent of everything above — could ship before phase 1 if the counter wants the typing relief sooner.

### Phase 5 — Cleanups this work exposed

- Remove the Sandbox/Production dropdown from the SPIn settings section (the client is production-only).
- Flip `SPIN_ALLOW_ENV_FALLBACK` to `false` once every tenant is configured (G4).
- Live-test `voidByRrn` deposit release (G5).
- Consider `requestCardToken: true` on HPP mints so the fallback keeps card-on-file (G6).
- `CITATION_ADMIN` metadata row (§5 gap 5).

---

## 9. Open decisions for Hector

1. **If the QD2 cannot capture initials per clause** (Q4), do we accept/decline per clause with one signature at the end, or keep initials and stay on the phone for the contract?
2. **If six prompts prove unusable on a 4.3″ screen**, is one combined disclaimer with initials on the printed receipt acceptable? It weakens the audit trail.
3. **Should the second signature at `CUSTOMER_SIGN_PENDING` be dropped** on the terminal path when the inspection finds no new damage? The design assumes yes.
4. **Deposit waiver** — manager approval plus a typed reason, or agent-discretionary? The mockup assumes manager approval.
5. **Which LAX location(s)** get `checkoutContractMode: TERMINAL` first, and is there a second counter that would hit G1 immediately?
