# Pillar 2 Wizards — Audit & Implementation Plan

**Date:** 2026-05-19
**Branch:** `feature/pillar2-wizards`
**Status:** Pre-implementation audit. Do not write wizard code until this doc is acknowledged.

---

## Why this doc exists

On 2026-05-18 we attempted to ship multi-step checkout/checkin wizards directly on `main`. We hit 9 distinct integration bugs and burned hours in `edit → push → deploy → test → repeat` cycles. The wizards were eventually reverted; the foundation (DB schemas, BullMQ, fee engine, emails) stayed deployed.

This document captures **what the legacy flow actually does, what the wizards got wrong, and the exact sequence the new wizards must follow** to behave identically.

---

## The killer insight

**The legacy `/checkout` page calls `POST /api/reservations/:id/start-rental` early in its submit flow. That single call is the magic that makes finalize() succeed.**

`start-rental` invokes `rentalAgreementsService.startFromReservation()`, which:
1. Creates the `RentalAgreement` row if it doesn't exist
2. **Populates `RentalAgreementCharge` rows with `selected: true` from one of three paths** — structured reservation charges, reservation pricing snapshot, or default daily-rate + auto-fees fallback
3. Imports any pre-existing reservation payments to the agreement
4. Computes subtotal / taxes / total / paidAmount / balance

The wizards we built yesterday **skipped this step** and tried to write to `/rental` directly, then `/finalize`. Finalize hard-rejects when there are no selected charges on the agreement → 400 error → user blocked.

Every other bug we saw downstream (phantom $3.33 balance, vehicle not synced, photos showing as 0) was a separate problem stacked on top of this missing call.

---

## Reservation → Agreement → Finalize state machine

```
Reservation.status     Agreement.status     Where charges live
─────────────────     ─────────────────    ──────────────────────────────
CONFIRMED              (none)              Frontend chargeModel (in memory),
                                           OR ReservationCharge[] (if pricing saved),
                                           OR ReservationPricingSnapshot fields
        │
        │ POST /reservations/:id/start-rental
        │ (or GET /reservations/:id/agreement — same handler)
        ▼
CONFIRMED              DRAFT               RentalAgreementCharge[]
                                           (with selected: true)
        │
        │ PUT /rental-agreements/:id/rental
        │ POST /rental-agreements/:id/signature  (writes to RESERVATION, not agreement)
        │
        ▼
CONFIRMED              DRAFT               Same
        │
        │ POST /rental-agreements/:id/finalize
        │ ↓ validates selectedCharges count >= 1
        │ ↓ auto-applies customer.creditBalance if balance > 0
        │ ↓ Tx: agreement.status=FINALIZED, reservation.status=CHECKED_OUT
        ▼
CHECKED_OUT            FINALIZED           Frozen on the agreement
        │
        │ POST /rental-agreements/:id/email-agreement  (fire-and-forget, 202)
        │
        ▼ (much later — checkin time)
        │
        │ POST /rental-agreements/:id/inspection (CHECKIN phase, photos)
        │ POST /rental-agreements/:id/checkin-close (Pillar 2 fee engine)
        ▼
CHECKED_IN or CHECKED_IN_UNPAID    (closed)    Plus fee engine charges if Pillar 2 enabled
```

**Source of truth files:**
- Reservation status enum: `backend/prisma/schema.prisma:18-26`
- `startFromReservation`: `backend/src/modules/rental-agreements/rental-agreements.service.js:1615-2100`
- `finalize`: `backend/src/modules/rental-agreements/rental-agreements.service.js:4013-4131`
- Legacy checkout call sequence: `frontend/src/app/reservations/[id]/checkout/page.js:95-169`
- Legacy checkin call sequence: `frontend/src/app/reservations/[id]/checkin/page.js:55-94`

---

## Where charges actually live (and why we got confused)

| Field path | Filled when | Empty when |
|---|---|---|
| `reservation.charges` (top-level) | After `PUT /reservations/:id/pricing` is called | Never explicitly called yet |
| `pricing.charges` (from `GET /reservations/:id/pricing`) | Same — reads `ReservationCharge[]` rows | Same |
| `pricing.snapshot.dailyRate` | Captured at reservation creation | Reservation has no dailyRate set |
| `agreement.charges` (from `GET /rental-agreements/:id`) | After `start-rental` runs | Fresh agreement created without start-rental |
| `reservation.rentalAgreement.charges` (via reservation getById include) | Same — same DB table | Same |

The **frontend reservation-detail page** at `page.js:1380-1420` computes Daily + Tax client-side from `chargeModel.dailyRate × breakdown.days` + `taxRate`. It does NOT call `PUT /pricing` automatically on load — that's a manual save action. So a freshly created reservation that hasn't had pricing saved will show $24.63 on screen (computed) but have ZERO rows in `ReservationCharge`.

**Implication:** The wizard cannot rely on `pricing.charges` being populated. It must trigger `start-rental` which has its own fallback that computes from `dailyRate` + `taxRate` even when `ReservationCharge` is empty.

---

## The 9 bugs from 2026-05-18 — root causes

### Bug 1 — Wizard route at `/checkout-wizard` instead of `/checkout`
**Status:** Resolved by re-export shim. Skip.

### Bug 2 — Worker handler `count: 0`
**Status:** Resolved by commit `f9c7a85` (await handler registration before `startWorkers`). Skip.

### Bug 3 — Photos persist as 0 even with `photoCount: 2` in state ⭐
**Root cause:** Not a save bug. Photos ARE saved to `photosJson`. The display bug is in `frontend/src/app/reservations/[id]/inspection-report/page.js:10-32` — it filters by lowercase keys (`front`, `rear`, `left`, `right`, `frontSeat`, `rearSeat`, `dashboard`, `trunk`) but the wizard's `STANDARD_ANGLES` keys are UPPERCASE/abbreviated (`FRONT`, `FL`, `LEFT`, `RL`, `REAR`, `RR`, `RIGHT`, `FR`).

**Fix:** Align wizard photo keys to the existing camelCase scheme used by the inspection-report renderer. Update `frontend/src/components/wizard/PhotoCapture.jsx` `STANDARD_ANGLES` array.

### Bug 4 — `agreement.balance: "0"` (string!) and `agreement.charges: []` on fresh agreement
**Root cause (part 1, string):** Prisma `Decimal @db.Decimal(10,2)` fields serialize as strings via `JSON.stringify`. The reservation-detail page already does `Number(row?.rentalAgreement?.balance ?? row?.balance ?? row?.amountDue ?? 0)` to coerce.

**Fix (part 1):** Wrap `getById` response (or use a thin presenter) to coerce `balance`, `subtotal`, `total`, `taxes`, `paidAmount` to numbers before returning JSON.

**Root cause (part 2, empty array):** The fresh agreement HAD NOT had `start-rental` called yet. The wizard fetched the agreement directly via `GET /rental-agreements/:id` instead of going through `GET /reservations/:id/agreement` (which calls `startFromReservation`). The direct fetch returns whatever's in the DB, which for a fresh agreement is empty.

**Fix (part 2):** Wizard load **must** call `GET /reservations/:id/agreement` (the syncing endpoint), not `GET /rental-agreements/:id` directly.

### Bug 5 — Phantom $3.33 balance after sync ⭐
**Root cause:** `startFromReservation` recomputes subtotal/taxes/total when the reservation's pricing differs from what was originally saved. Rounding accumulates: `subtotal × (taxRate / 100)` then `total = subtotal + taxes`. If the reservation page computed using a different precision/order, the totals can drift by a few cents.

Concrete scenario: reservation has explicit `paidAmount = $24.63 - $3.33 = $21.30` captured at booking. When startFromReservation reruns and gets `total = $24.63`, balance = $24.63 - $21.30 = $3.33. Reservation page may be showing `0` because it's comparing against a different (stale or differently-rounded) snapshot.

**Fix:** Two options:
1. **Don't display balance in the wizard at all.** Agent has already verified payment on the reservation page before starting checkout. Wizard just executes.
2. **Read balance from one canonical source.** Always use `agreement.balance` (after `startFromReservation` syncs) and never compare to reservation values.

Going with option 1 for the new wizard.

### Bug 6 — `At least one selected charge is required before finalizing` ⭐
**Root cause:** Wizard never called `start-rental`. Without it, the fresh agreement has zero `RentalAgreementCharge` rows. Finalize rejects.

**Fix:** Wizard MUST call `POST /api/reservations/:id/start-rental` early in submit (or even at load time). This matches the legacy flow exactly.

### Bug 7 — Vehicle assigned to agreement but not to reservation
**Root cause:** Wizard only called `PUT /rental-agreements/:id/rental` with `vehicleId`. That sets the agreement's vehicleId. The reservation row's `reservation.vehicleId` stayed null because no PATCH was sent to `/api/reservations/:id`. The legacy flow at `checkout/page.js:116-123` does call `PATCH /api/reservations/:id` first with `vehicleId`.

**Fix:** Mirror the legacy order — PATCH reservation FIRST with `{vehicleId, franchiseId, notes}`, then `start-rental`, then `/rental`.

### Bug 8 — Camera viewfinder blank
**Status:** Resolved in `PhotoCapture.jsx` with two-step useEffect (stream-acquire then attach when both video and stream are ready). Keep.

### Bug 9 — OTC payment requiring receipt for CARD
**Status:** Resolved in `backend/src/modules/rental-agreements/rental-agreements.service.js:2962-2987` — receipt optional when `method === 'CARD' && reference != ''`. Keep.

---

## The minimal correct call sequence

Both wizards must mirror the legacy sequence exactly. Anything beyond this is a feature on top.

### Checkout wizard (CONFIRMED → CHECKED_OUT)

```
LOAD:
  GET /api/reservations/:id                       → reservation data
  GET /api/reservations/:id/agreement             → triggers startFromReservation, syncs charges
  GET /api/reservations/:id/pricing               → canonical pricing object (charges array + snapshot)
                                                    Same source the reservation-detail page reads.
  GET /api/reservations/:id/payments              → existing payments to show paid/due
  GET /api/reservations/:id/available-vehicles    → for vehicle picker (if no vehicle assigned)
  GET /api/reservations/:id/pricing-options       → franchise list if tenant requires

USER STEPS (front-end only):
  1. Confirm vehicle (picker if needed) + customer summary
  2. Capture exterior photos (8 angles, camelCase keys to match display)
  3. Capture metrics: odometerOut, fuelOut, cleanlinessOut
  4. Review charges & total (READ-ONLY display from /pricing endpoint —
     Daily × days, services, fees, insurance, taxes, subtotal, paid,
     balance due. "Edit on reservation page" link if pricing needs change.
     No edit-in-wizard. This step ensures customer + staff confirm the
     numbers before signature.)
  5. Customer signature on glass
  6. Success

SUBMIT (in this exact order):
  1. PATCH /api/reservations/:id
       body: { vehicleId, franchiseId?, notes: '<append checkout audit line>' }
  2. POST /api/rental-agreements/:agreementId/inspection
       body: { phase: 'CHECKOUT', odometer, fuelLevel, photos: {front, rear, left, right, frontSeat, rearSeat, dashboard, trunk} }
  3. POST /api/reservations/:id/start-rental
       body: {}
       → returns agreement with synced charges
  4. PUT /api/rental-agreements/:agreementId/rental
       body: { vehicleId, odometerOut, fuelOut, cleanlinessOut }
  5. POST /api/rental-agreements/:agreementId/signature
       body: { signerName, signatureDataUrl }
  6. POST /api/rental-agreements/:agreementId/finalize
       body: { odometerOut, fuelOut, cleanlinessOut }
       → transitions reservation to CHECKED_OUT, agreement to FINALIZED
  7. POST /api/rental-agreements/:agreementId/email-agreement
       body: {}
       fire-and-forget, do not await
```

### Checkin wizard (CHECKED_OUT → CHECKED_IN or CHECKED_IN_UNPAID)

```
LOAD:
  GET /api/reservations/:id                       → reservation data (must be CHECKED_OUT)
  GET /api/rental-agreements/:agreementId         → for prior metrics (fuelOut, odometerOut, cleanlinessOut)
                                                    + existing charges (frozen from checkout)

USER STEPS:
  1. Return summary (vehicle, customer, prior baseline metrics)
  2. Photo capture (8 angles, same camelCase keys as checkout)
  3. Metrics: odometerIn, fuelIn, cleanlinessIn, smokingDetected
  4. Live fee preview (Pillar 2 killer feature — uses useFeePreview hook)
     Plus a "Final invoice preview" panel showing existing agreement
     charges + new fees, with grand total.
  5. Customer signature
  6. Success (shows what was charged or what's pending auto-charge)

SUBMIT:
  1. POST /api/rental-agreements/:agreementId/inspection
       body: { phase: 'CHECKIN', odometer, fuelLevel, photos: {front, rear, left, right, ...} }
  2. POST /api/rental-agreements/:agreementId/signature
       body: { signerName, signatureDataUrl }
  3. POST /api/rental-agreements/:agreementId/checkin-close
       body: { odometerIn, fuelIn, cleanlinessIn, smokingDetected, signerName, signatureDataUrl, manualPayment? }
       → fee engine computes + persists fees as charges
       → routes status: balance=0 → CHECKED_IN, balance>0 → CHECKED_IN_UNPAID + enqueue autocharge
       → sends invoice or receipt email automatically
```

---

## Implementation order (deployment-safe)

### Phase 1 — Backend hygiene (1-2 hours, isolated, low risk)

These prep changes are independent of the wizard and improve correctness everywhere.

1. **Decimal coercion in agreement responses.** In `rental-agreements.service.js`, the `getById` function returns Decimal fields. Add a presenter wrapper that converts `balance / subtotal / total / taxes / paidAmount / depositAmount` to numbers before responding. Use existing client convention as fallback so old callers keep working.
   File: `backend/src/modules/rental-agreements/rental-agreements.service.js:2080-2103`

2. **Rounding consistency in `startFromReservation`.** All total/tax computations should use `Number((x).toFixed(2))` rounding at every layer. This eliminates the $3.33 drift between reservation page totals and agreement totals.
   File: `backend/src/modules/rental-agreements/rental-agreements.service.js:1670-1680, 1815-1840`

3. **Verify PATCH /reservations/:id accepts vehicleId.** Already does per route at line 728. No change needed.

### Phase 2 — Frontend foundation fixes (1 hour)

4. **Align photo keys** in `frontend/src/components/wizard/PhotoCapture.jsx` `STANDARD_ANGLES`:
   ```js
   STANDARD_ANGLES = [
     { key: 'front',     label: 'Front',    abbr: 'Front' },
     { key: 'rear',      label: 'Rear',     abbr: 'Rear' },
     { key: 'left',      label: 'Left',     abbr: 'L' },
     { key: 'right',     label: 'Right',    abbr: 'R' },
     { key: 'frontSeat', label: 'Front seat',  abbr: 'FS' },
     { key: 'rearSeat',  label: 'Rear seat',   abbr: 'RS' },
     { key: 'dashboard', label: 'Dashboard',   abbr: 'Dash' },
     { key: 'trunk',     label: 'Trunk',       abbr: 'Trunk' }
   ];
   ```

   This matches the keys the inspection-report page already renders. Photos saved with these keys will display correctly without further changes.

### Phase 3 — Rewrite wizard submit sequences (2-3 hours)

5. **Checkout wizard submit** rewritten to mirror legacy order exactly. The wizard's job is multi-step UX; the call sequence is identical to the legacy single-form.

6. **Checkin wizard submit** routes through `/checkin-close` which already exists from Pillar 2 backend.

7. **Drop the balance display from Step 1** in checkout wizard. Agent verifies balance on the reservation page before starting the wizard. Wizard just executes.

### Phase 4 — Local end-to-end test (1 hour minimum)

8. Run `npm run dev` for both backend and frontend locally. Use a real Postgres dev DB (or Supabase staging if dev is configured).
9. Create test reservations with: (a) no balance, (b) balance > 0, (c) no vehicle pre-assigned.
10. Walk through checkout wizard end-to-end for each. Verify in DB after each step:
    - `reservation.vehicleId` updates after PATCH
    - `RentalAgreementCharge` rows exist after `start-rental`
    - Inspection photos arrive with the right keys
    - `agreement.status` = FINALIZED and `reservation.status` = CHECKED_OUT after finalize
    - Email queued (check logs, not inbox)
11. Repeat for checkin wizard.

### Phase 5 — Single deployment

12. Tag and deploy the whole thing once. Don't iterate on production. If something breaks, fix locally and re-deploy.

---

## Charges & pricing sync contract

The wizard must keep the reservation tab + agreement view + checkout wizard
all showing the same totals. Three rules:

1. **Wizard NEVER writes charges directly.** No POST to `/:id/charges` from
   the wizard. That endpoint exists for the reservation-detail page's pricing
   editor only. The wizard reads pricing for display + lets `start-rental`
   handle the copy to agreement.

2. **Single read source: `/api/reservations/:id/pricing`.** The wizard's
   "Review charges" step reads from this endpoint — same source the
   reservation tab uses. So totals shown in the wizard MUST match the
   reservation tab byte-for-byte. If they don't, that's a P2 backend bug
   (rounding) not a wizard bug.

3. **After finalize, the agreement is the frozen record.** Reservation tab
   continues to render `pricing.charges` for "what they were quoted" — that
   stays stable. Agreement page renders `agreement.charges` (the frozen
   snapshot at finalize time). For an agent reviewing a past rental, both
   should match. If they diverge, it means pricing was edited AFTER finalize,
   which the existing flow already handles by `replaceCharges` on the agreement
   when the user clicks Save in the reservation pricing panel.

This means the wizard's "Review charges" step is **a read-only display, not an
edit point**. If the agent or customer needs to change pricing, they exit the
wizard, edit on the reservation page, then resume.

## Out of scope for this iteration

These remain pending but should NOT be in the first wizard PR:

- Live fee preview animations (the mockup-style FeePreviewPanel)
- AR-guided photo capture overlay
- Manager skip override
- Charge card on file from inside the wizard (separate flow on reservation page already works)
- Supabase Storage for photos (still base64 in DB — known limitation, master plan tracks)
- Voice AI integration
- Edit charges from inside the wizard (always exit to reservation page for that)

Get the boring functional version shipped first. Add polish in PR #2.

---

## Pull request structure

Plan to ship as ONE PR with these commits:

1. `chore(backend): coerce Decimal fields to numbers on rental agreement responses`
2. `fix(backend): consistent rounding in startFromReservation totals`
3. `fix(frontend): align wizard photo keys to inspection-report renderer convention`
4. `feat(frontend): checkout wizard submit sequence (mirror legacy /checkout exactly)`
5. `feat(frontend): checkin wizard submit sequence (uses /checkin-close)`
6. `chore(frontend): drop balance gate from wizard step 1 — agent verifies on reservation page`

CI runs full backend tests + frontend build. No production deploy until CI green AND local end-to-end tested.

---

## How we know this is done

- A staff agent can checkout a real reservation in the wizard without errors
- The reservation page reflects: status CHECKED_OUT, vehicle assigned, signature stored
- The inspection-report page shows the 8 captured photos for the CHECKOUT phase
- The agreement PDF email arrives
- Same for checkin: reservation goes to CHECKED_IN or CHECKED_IN_UNPAID with the right invoice email queued

If any of those fail in QA, the PR doesn't merge.
