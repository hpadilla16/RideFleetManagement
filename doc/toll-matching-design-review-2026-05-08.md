# Toll Matching — Design Review & Improvement Plan

Fecha: 2026-05-08
Autor: Claude (review request from Hector)
Contexto: Triangle / loaner workflow generating large Need Review piles; user just asked us to add a Confirm All bulk action and is now asking whether the underlying design is the best we can do.

---

## TL;DR

The current design is **architecturally sound** but **operationally too conservative**. The dispatch-confirmation gate was built to satisfy a real principle ("don't auto-bill a toll that fired before formal checkout") and it does that well. The problem is the gate fires on signals that are missing for legitimate reasons — particularly for the dealership-loaner workflow, which doesn't go through rental-agreement checkout — so we're sending tolls to manual review even when the plate, tag, and trip window all line up perfectly.

The five highest-leverage improvements:

1. **Multi-signal override** — if plate AND tag both match the same vehicle inside the trip window, auto-confirm regardless of dispatch state.
2. **Workflow-aware dispatch policy** — for `DEALERSHIP_LOANER`, treat reservation status `CONFIRMED` (with a vehicle assigned + counter-acknowledged dispatch) as a valid checkout signal.
3. **Split Need Review into typed sub-queues** with their own bulk actions instead of one undifferentiated pile.
4. **Per-tenant policy controls** — surface the score threshold, the dispatch cap, and grace windows as tenant settings instead of hardcoded constants.
5. **Bulk-confirm performance pass** — current implementation is sequential; for 200 tolls it'll take 30+ seconds. Batch the work and consolidate audit/sync side effects.

The rest of this doc walks through the analysis behind each.

---

## Current Design — What It Gets Right

Before critiquing, credit where due. The design has three really good ideas:

1. **Responsibility windows are time-sliced, not reservation-shaped.** When a vehicle gets swapped mid-trip, the system builds per-vehicle ownership windows from the swap log instead of pretending the whole reservation owned the whole vehicle. This is the right model.
2. **Usage vs. billing are kept separate.** Toll-package coverage records usage without creating a charge. That's important for reporting and disputes and is a thoughtful concession to reality.
3. **Match reasoning is preserved on the assignment row.** Every confirmation/suggestion records *why* via `matchReason`. That's auditable.

These are all worth keeping. The improvements below extend this foundation — they don't tear it down.

---

## Weakness 1 — Score Cap on Dispatch Confirmation Is Blunt

**File:** `backend/src/modules/tolls/tolls.service.js`, lines 927–930

```js
if (responsibility.dispatchConfirmationRequired) {
  reasons.push('dispatchConfirmationRequired');
  score = Math.min(score, 79);
}
```

This caps any score at 79 (one below the 85 auto-confirm threshold) when the system can't prove formal checkout. The problem: it ignores how many other signals also independently confirm the match.

A toll on vehicle X with:
- Plate matching X (+25)
- Tag matching X (+20)
- Sello matching X (+20)
- Inside the trip window (+25)
- Inside vehicle responsibility window (+70)

→ raw score 160, capped to 79 → goes to review.

But three independent unique-identifier matches (plate/tag/sello) plus correct time window is overwhelming evidence. The chance this isn't the right vehicle is essentially zero. Forcing a human to confirm dispatch on every one of these is the operational pain you're feeling.

**Fix:** introduce a "multi-signal override" rule that bypasses the dispatch cap when at least two of {plate, tag, sello} match the same vehicle AND the toll is inside the trip window. Pseudocode:

```js
const strongIdentifiers =
  (plate && vehiclePlate && plate === vehiclePlate ? 1 : 0) +
  (tag && vehicleTag && tag === vehicleTag ? 1 : 0) +
  (sello && vehicleSello && sello === vehicleSello ? 1 : 0);

const multiSignalOverride =
  strongIdentifiers >= 2 &&
  withinTripWindow &&
  responsibility.withinEffectiveWindow;

if (responsibility.dispatchConfirmationRequired && !multiSignalOverride) {
  score = Math.min(score, 79);
}
```

This preserves the "don't auto-bill before checkout" principle for ambiguous cases (plate alone, or vehicle ID alone) while letting overwhelming evidence override.

---

## Weakness 2 — Dispatch Confirmation Is Single-Workflow

**File:** `backend/src/modules/tolls/tolls-responsibility.service.js`, lines 38–50

```js
export function inferDispatchConfirmedAt(reservation = {}) {
  ...
  if (finalizedAt) return finalizedAt;             // signed rental agreement
  if (checkoutCapturedAt) return checkoutCapturedAt; // checkout inspection
  if (CHECKED_OUT_STATUSES.has(status)) return ...;  // status ∈ {CHECKED_OUT, CHECKED_IN}
  return null;
}
```

`CHECKED_OUT_STATUSES = new Set(['CHECKED_OUT', 'CHECKED_IN'])` — meaning **only** these two statuses count. Loaners typically sit in `CONFIRMED` with a vehicle assigned, and the customer drives off; there's no rental agreement and no checkout inspection. Result: every loaner toll triggers `dispatchConfirmationRequired = true`.

This is the root cause of the giant review pile in the loaner-heavy Triangle workflow.

**Fix:** make the dispatch signal workflow-aware. For `DEALERSHIP_LOANER`, accept additional checkout proxies:

- A reservation status of `CONFIRMED` with `vehicleId` set and `pickupAt` in the past
- A loaner-specific dispatch timestamp (we should add `dispatchedAt` to the Reservation model — set when the operator finalizes the loaner handover)

Concretely, add a new helper:

```js
function inferLoanerDispatchedAt(reservation = {}) {
  if (reservation?.workflowMode !== 'DEALERSHIP_LOANER') return null;
  if (reservation?.dispatchedAt) return normalizeDateTime(reservation.dispatchedAt);
  // Fall back: confirmed reservation past pickup with vehicle assigned
  const status = upper(reservation?.status);
  if (status === 'CONFIRMED' && reservation?.vehicleId && reservation?.pickupAt) {
    const pickupAt = normalizeDateTime(reservation.pickupAt);
    if (pickupAt && pickupAt <= new Date()) return pickupAt;
  }
  return null;
}
```

Wire it into `inferDispatchConfirmedAt` as a fallback before returning null. Adding the `dispatchedAt` column is a 1-line schema change + a UI button in the loaner module (we already cleaned that page up).

**Tradeoff to acknowledge:** if a loaner customer shows up to pick up a confirmed reservation but never actually takes the car (fell through, no-show), the fallback above would still treat the reservation as dispatched. The right defense is adding the explicit `dispatchedAt` button so operators can confirm handover happened — and only fall back to "CONFIRMED + past pickup" as a soft signal that doesn't fully clear dispatch but does relax the score cap from 79 to 84.

---

## Weakness 3 — Single Need Review Queue, Multiple Decision Types

The current `Need Review` queue mixes incompatible workloads:

| Reason for review | What the user actually does | Decision time |
|---|---|---|
| Dispatch confirmation required | Click "Yes, dispatched" — rubber-stamp 95% of the time | <1s |
| Multiple candidate reservations | Choose between 2-3 reservations | 30-60s |
| No vehicle matched | Manually look up plate/tag in fleet | 2-5 min |
| Outside trip window | Decide: waive, dispute, or assign anyway | 1-2 min |

We just added "Confirm All" which works well for case 1. But the bulk action is dangerous for cases 3 and 4 because the user might confirm a toll that doesn't actually match anything correctly.

**Fix:** Categorize on the backend (`reviewCategory`) and surface as separate sub-tabs. We already have `dispatchConfirmationRequired` as one category — add three more:

- `MULTIPLE_CANDIDATES`
- `VEHICLE_NOT_FOUND`
- `OUTSIDE_WINDOW`
- `LOW_CONFIDENCE` (single match but score 60-84 with no obvious dominant signal)

Each sub-tab gets only the relevant bulk action:

| Tab | Allowed bulk action |
|---|---|
| Confirm Dispatch | Confirm All (what we have) |
| Multiple Candidates | None — per-row only |
| Vehicle Not Found | Bulk Waive / Bulk Dispute |
| Outside Window | Bulk Waive |
| Low Confidence | Manually triage |

The current `Confirm All (N)` button stays but its eligibility is naturally narrowed because it only counts visible-in-current-tab tolls.

---

## Weakness 4 — Hardcoded Thresholds Are Tenant-Hostile

These constants are baked into the code:

```js
score >= 85 ? 'AUTO_CONFIRMED' : score >= 60 ? 'SUGGESTED' : null
score = Math.min(score, 79); // dispatch cap
DEFAULT_PRE_PICKUP_GRACE_MINUTES = 120;
DEFAULT_POST_RETURN_GRACE_MINUTES = 180;
```

A high-volume short-rental tenant might want a higher auto-confirm threshold (95) and tighter grace windows (30 minutes) because mistakes are costly. A loaner tenant wants the opposite: lower threshold, generous grace, because their customer interactions are less transactional.

**Fix:** move these to the `Tenant` table as nullable fields with defaults at the application layer:

```prisma
model Tenant {
  ...
  tollAutoConfirmScore    Int?  // default 85
  tollSuggestedScore      Int?  // default 60
  tollDispatchCapScore    Int?  // default 79
  tollPrePickupGraceMin   Int?  // default 120
  tollPostReturnGraceMin  Int?  // default 180
  tollMultiSignalOverride Boolean?  // default true
}
```

Surface in Settings → Tolls. No UI gymnastics — a five-field form. SUPER_ADMIN can edit them per-tenant.

---

## Weakness 5 — Bulk-Confirm Sequential Performance

**File:** `backend/src/modules/tolls/tolls.service.js`, the `bulkConfirmMatches` method we just added.

The loop is sequential and each iteration does:

1. `getTransactionOrThrow` (DB roundtrip with includes)
2. `applyReviewAction` or `confirmMatch` (which itself does a `prisma.$transaction` with multiple writes)
3. `syncReservationTollCharges` (separate transaction, multiple queries)
4. `auditLog.create` (separate insert)
5. `getTransactionOrThrow` again (re-fetch for serialization — though we discard the result)

For 200 tolls that's somewhere around 1500-2000 DB roundtrips. Optimistically 30-60 seconds end-to-end.

**Fix:** Three changes that compose:

a. **Parallelize the loop** with `Promise.all` in batches of 10. Cuts wall time roughly 10x with no correctness risk because each toll is independent.

b. **Defer reservation sync to the end.** Right now each toll triggers `syncReservationTollCharges`. If 50 tolls all belong to the same reservation, we sync 50 times. Build a Set of touched reservation IDs and sync once each at the end.

c. **Single audit log entry summarizing the bulk action.** Instead of N entries each saying "tollReviewAction: BULK_CONFIRM", emit one entry with the list of toll IDs and the actor. Easier to read in audit history too.

Estimated speedup: 200 tolls in 3-5 seconds instead of 30-60.

---

## Weakness 6 — `matchReason` Is a Comma-Joined String

```js
matchReason: reasons.join(',') || 'manual-review'
// e.g. "vehicleResponsibilityWindow,plate,withinTripWindow,dispatchConfirmationRequired"
```

This is fine for human display but useless for analytics. We can't easily ask "what % of dispatch-confirmation-required tolls had plate matches?" because the data is unstructured strings.

**Fix:** add a parallel `matchSignals` JSON array column on `TollAssignment`:

```prisma
model TollAssignment {
  ...
  matchReason  String?
  matchSignals Json?     // ["vehicleResponsibilityWindow", "plate", ...]
}
```

Keep `matchReason` for backward compatibility. Set both on write. Query off `matchSignals` for reports.

This unlocks future analytics like "tolls that were auto-confirmed and then later disputed by customer" — letting us tune scoring rules with data.

---

## Weakness 7 — Multiple-Candidate Penalty Is Too Sharp

```js
if (siblingCandidates > 1) {
  score -= withinTripWindow ? 10 : 30;
  reasons.push('multipleCandidates');
}
```

This punishes overlapping reservations across the whole vehicle history. But "siblings" in the current code includes any reservation that touches the vehicle in the day window, even if they don't overlap with the toll time. Two back-to-back reservations on the same vehicle (one ending at 10am, next starting at 10:15am) should not penalize a toll at 11am — only the second reservation should be a candidate, with no sibling.

**Fix:** count siblings as reservations whose window *also* covers the transaction time, not all reservations on the vehicle that day. The current code over-penalizes the common case.

This is a small tweak in `listReservationCandidates` / `buildMatchSuggestion` but cuts out a class of false reviews.

---

## Weakness 8 — No Learning Loop

When a user confirms or rejects a match, that's signal. The system should track:

- Which match-signal combinations are reliably confirmed (e.g., "tag-only" — does the user accept these?)
- Which patterns are reliably rejected (e.g., "plate-only with multiple candidates" — does the user usually reject?)
- Per-customer trust profile (a customer with 100 confirmed tolls and zero disputes is a lower-risk auto-confirm)

I'm not proposing we build this now — it's a non-trivial ML-adjacent project. But we should at least *log* the signal so we can build it later. Concretely: add a `tollMatchOutcome` table that records `{tollTransactionId, signals, finalAction, actorId, confirmedByUser, ...}`.

Without this audit-grade record, we can't tune the scoring with any rigor — we'd just be guessing at the constants.

---

## Implementation Plan, Prioritized

This is what I'd actually do, in order, with rough effort estimates.

### P0 — Multi-signal override (1 day)
- Add the override check to `scoreCandidate`
- Add a unit test in `tolls-billing-policy.test.mjs`
- Verify on the Triangle data

This alone should cut the loaner review pile by 70-90%.

### P0 — Bulk-confirm performance (½ day)
- Batch parallelism + reservation sync deduplication + consolidated audit log
- Re-test the 200-row case

These two together give immediate operational relief.

### P1 — Workflow-aware dispatch (1.5 days)
- Schema: add `dispatchedAt` to `Reservation`
- Update `inferDispatchConfirmedAt` with loaner fallback
- Add "Mark Dispatched" action on the loaner page
- Test: a loaner toll with `dispatchedAt` set should NOT trigger review

### P1 — Per-tenant tolerances (½ day)
- Schema: 6 nullable fields on `Tenant`
- Read them at scoring time with defaults
- Settings UI form

### P2 — Categorized review queues (1.5 days)
- Backend: enrich `reviewCategory` with the 5 categories
- Frontend: add 4 sub-tabs alongside the existing "All / Dispatch Review / Usage Only / Ready To Post"
- Per-tab bulk actions: Confirm All, Bulk Waive, Bulk Dispute

### P2 — Multiple-candidate penalty fix (¼ day)
- Tighten the sibling definition to time-overlap

### P3 — Structured matchSignals + outcome log (1 day)
- Schema additions
- Write paths updated
- No UI yet — just the data foundation for future tuning

### Total estimated effort
P0 + P1 + P2 + P3 ≈ 6 engineer-days.

The P0 items alone (1.5 days) should solve the immediate Triangle pain.

---

## What Should NOT Change

A few things I considered and decided to leave alone:

- **The 85/60 thresholds themselves** (other than making them tenant-configurable). The current values feel right for the underlying scoring formula. Tweaking them without first adding the multi-signal override is just rearranging deck chairs.
- **The responsibility-window model.** Time-sliced per-vehicle responsibility is the right abstraction and is well-implemented. Don't touch.
- **The "usage vs. billing" split with `coversTolls`.** Working as intended. Don't touch.
- **Issue Center integration for disputes.** The hand-off is clean. Don't touch.

---

## Open Questions

1. Should `multiSignalOverride` count plate matches alone if the plate database is high-quality? (Today: no — needs 2+ identifiers. Probably keep that conservative bar.)
2. For the `dispatchedAt` button on loaner reservations: who's allowed to set it? OPS only, or also the customer-facing dispatcher? (Probably OPS only, with audit trail.)
3. Do we want a "dry run" mode for `Confirm All` that shows what *would* happen without committing? (Nice-to-have but not P0.)
4. Should we surface the per-toll *raw* score to operators in the UI? Currently we hide it — but for a power user it could speed triage. (Tradeoff: more cognitive load. Default to hidden, allow expansion.)

---

## Recommendation

Start with **P0** items this week. They're cheap, isolated, and give Hector the operational relief he needs immediately. Defer everything else until we see how those land. If they cut the review pile by the expected 70-90%, P1+P2 may not even be urgent — they become "polish for next year" rather than "needed for 100 users."
