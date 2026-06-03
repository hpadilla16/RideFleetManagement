# Check-in fees ↔ Dejavoo checkout — alignment review (2026-06-02)

Hector's question: once Dejavoo is the checkout rail, will check-in still work the
same way — specifically, will the inspection fees (gas / cleaning / late / smoking)
still get computed and collected correctly, and in the same format as the new
Dejavoo checkout? This is the answer, with the gaps and the fix plan.

## Good news first: fee COMPUTATION is provider-agnostic and keeps working

The check-in fee math does **not** care which payment provider you use. It will
keep working unchanged after Dejavoo lands:

- `checkin-close.service.js` calls `feeEngineService.computeCheckinFees()` with the
  inspection deltas (odometer, fuel out/in, cleanliness, smoking flag, scheduled vs
  actual return time).
- `fee-engine.service.js` computes each fee and writes `RentalAgreementCharge` rows
  with `source = 'FEE_ENGINE_CHECKIN'` and `sourceRefId` = the fee type:
  `FUEL_REFILL`, `CLEANING_LIGHT/MEDIUM/HEAVY`, `SMOKING`, `LATE_RETURN`,
  `EXCESS_MILEAGE`.
- Rates resolve location-first, then tenant default, then hardcoded fallback
  (e.g. fuel $7.00/gal, cleaning $50/100/200, late $25/hr, smoking $250). A
  tenant/location can disable any fee (`FeeRate.isActive = false`).
- Totals recompute (`subtotal` / `taxes` / `fees` / `balance`); FEE_ENGINE_* rows
  bucket into `fees`.

None of that touches a payment gateway, so **the fees you've programmed for gas,
cleaning, late, etc. will keep being assessed exactly as today.**

## The real gap: fee COLLECTION at check-in is hard-wired to Authorize.Net

When check-in produces an unpaid balance (balance > 0), the flow is:

1. `checkin-close.service.js` sets `Reservation.status = CHECKED_IN_UNPAID`,
   stamps `autochargeAt = now + 24h`, and enqueues the BullMQ job
   `reservation.autocharge-after-checkin`.
2. `autocharge.worker.js` fires 24h later and calls
   `rentalAgreementsService.chargeCardOnFile(agreementId, { amount: balance })`.
3. `chargeCardOnFile()` (rental-agreements.service.js) is **hard-coded to
   Authorize.Net**: it requires `customer.authnetCustomerProfileId` +
   `authnetPaymentProfileId` and calls `authNetRequest({ ...authCaptureTransaction
   ... profile ... })`. There is **no SPIn/Dejavoo branch.** On success it records
   a `RentalAgreementPayment` with `method='CARD'`, `reference='AUTHNET:<id>'`.

### What breaks when checkout becomes Dejavoo

If the customer paid the rental on the **Dejavoo terminal** at checkout, they very
likely have **no Authorize.Net card profile** on file. So at check-in:

- Fees compute fine → balance > 0 → autocharge enqueued.
- Autocharge worker runs → "Customer has no CIM tokens on file" → marks failure,
  notifies staff "collect manually," **never charges the customer.**

So gas/cleaning/late fees would silently fall to manual collection for every
Dejavoo customer. That's the misalignment to fix before Dejavoo goes wide.

## "Same format" gap: RentalAgreementPayment has no `gateway` field

`ReservationPayment` already has a `gateway String?` field (stores `'authnet'` /
`'SPIN'`). `RentalAgreementPayment` does **not** — it only has `method` +
`reference`. So today a check-in charge can't be cleanly labeled by provider. To
make check-in payments match the Dejavoo checkout format and stay reconcilable,
add `gateway` to `RentalAgreementPayment` too (additive, low-risk migration).

## Fix plan — make check-in collection match the Dejavoo checkout rail

### A. Make the charge rail provider-aware (core fix)
Refactor `chargeCardOnFile()` (and the autocharge worker) to **dispatch by the
reservation's payment rail** instead of always Authorize.Net:

- Determine the rail: how was this reservation paid at checkout? Prefer an explicit
  signal (e.g. the checkout payment's `gateway`, or the tenant's active gateway:
  `dejavooCounter` flag / SPIn config present).
- Authorize.Net rail → existing CIM path (unchanged).
- Dejavoo rail → charge the **Dejavoo-tokenized card** via
  `paymentGatewayService` (SPIn). This is exactly the pending "preauth from
  tokenized card" work — the stored token is what lets you charge later without a
  re-swipe, the same way Authorize.Net CIM works today.
- Neither available → current behavior (notify staff to collect manually).

### B. Store the Dejavoo card token at checkout (prerequisite for A)
The Dejavoo checkout must `getCard()` / tokenize at the terminal and persist the
token (on the Customer, like the Authorize.Net profile, or on the reservation/
payment). Without a stored token there's nothing to auto-charge at check-in.

### C. Add `gateway` to RentalAgreementPayment (format consistency)
Additive migration mirroring `ReservationPayment.gateway`. Record `'SPIN'` for
Dejavoo charges and `'authnet'` for Authorize.Net so checkout and check-in
payments read consistently and reconcile.

### D. Decide the collection moment (operational choice — needs Hector)
Two viable models for Dejavoo check-in fees:

1. **Charge fees on the terminal at check-in** (customer usually present at the
   counter return). Simplest, no token needed, immediate — but requires the agent
   to run the terminal at return and the customer to be there.
2. **Background autocharge via the stored Dejavoo token** (mirrors today's 24h
   Authorize.Net flow). Better for remote/after-hours returns, but depends on the
   tokenized-preauth work (B) being solid.

A reasonable target: do (1) when the customer is at the counter, fall back to (2)
when they're not. But pick the default before building.

## Sequencing (folds into the Dejavoo readiness review)

This sits alongside `doc/dejavoo-readiness-review-2026-06-02.md`. Suggested order
when Dejavoo work resumes:

1. Port the Dejavoo checkout orchestrator onto release (cherry-pick) and add the
   `syncVehicleStatusForReservation` hook (readiness-review item 1).
2. Tokenize + store the card at Dejavoo checkout (B).
3. Add `RentalAgreementPayment.gateway` (C) — one additive migration.
4. Make `chargeCardOnFile()` / autocharge provider-aware (A).
5. Decide and implement the collection moment (D).
6. Wire override-rewind to void open Dejavoo holds (readiness-review item 2).
7. End-to-end test on IRC behind the `dejavooCounter` flag: checkout on terminal →
   return with gas/cleaning/late fees → confirm those fees charge via Dejavoo (not a
   failed Authorize.Net attempt) and record with `gateway='SPIN'`.

## Bottom line

- The fees you programmed (gas, cleaning, late, smoking, mileage) **keep computing
  correctly** under Dejavoo — that logic is provider-neutral.
- The **collection** of an unpaid check-in balance is currently Authorize.Net-only;
  left as-is, Dejavoo customers' check-in fees would fail to auto-charge and fall to
  manual collection.
- Closing the gap = store the Dejavoo token at checkout, make the autocharge rail
  provider-aware, and add a `gateway` field so check-in matches the checkout format.
  All of it is additive and should be built as part of the Dejavoo integration, not
  after.
