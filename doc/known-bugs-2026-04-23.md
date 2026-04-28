# Known Bugs — Software Backlog

**Started:** 2026-04-23
**Owner:** Hector
**Purpose:** Single running list of bugs surfaced during day-to-day use that are not yet scheduled into a sprint or PR. Each bug has enough detail to reproduce + a hypothesis. Add new entries at the top; move closed entries to the bottom under "Closed" with the fixing PR / commit reference.

---

## Open

### BUG-002 — `calculateShortage` returns extra trailing day past mid-day return

**Severity:** Medium (test failure blocks `npm test`; downstream impact on planner shortage forecast unknown)
**Discovered:** 2026-04-23 by backend `npm test` failing on `test:planner`
**File:** `backend/src/modules/planner/planner.service.test.mjs` line 16+, `backend/src/modules/planner/planner.service.js` `calculateShortage`

**Symptom:**
The test "calculateShortage returns peak shortage by date, type, and location" fails. Test inputs use **fixed dates** (no `new Date()` / today drift):
- Window: `start='2026-04-06T00:00Z'`, `end='2026-04-09T00:00Z'`
- Reservation: `pickupAt='2026-04-06T10:00Z'`, `returnAt='2026-04-08T10:00Z'` (rental ends mid-day on 4/8)

Expected output: shortage on 4/6 and 4/7 only (rental occupies 4/6 + 4/7 fully, returns mid-day 4/8 so 4/8 is free).

Actual output: includes an extra `{ date: '2026-04-08', carsNeeded: 1 }` entry.

**Hypothesis:**
Boundary logic in `calculateShortage` treats `returnAt 4/8 10:00` as "occupies 4/8" instead of "rental ends 4/8 mid-day so the rest of 4/8 is free". Either the implementation changed (regression) or the test expectation was always optimistic about half-days.

**Impact:**
- `npm test` halts at this point (uses `&&` chain), blocking all downstream test runs.
- Production planner UI may be reporting phantom shortages on the return day, leading to incorrect "we don't have enough cars" alerts.

**Recommended scope:**
- `git log -p backend/src/modules/planner/planner.service.js` to find what recently changed in shortage logic.
- Either fix the implementation to honor mid-day returns OR update the test expectation if the new behavior is correct (depending on what business wants — it's a real product question).
- While that's being decided: add `node --test` `--test-skip-pattern="calculateShortage returns peak shortage"` to a `test:planner:safe` variant, or move the failing test under a `// TODO unblock` skip so the rest of `npm test` can run.

---

### BUG-001 — Rental agreement dates do not update when reservation dates change

**Severity:** High (legal / compliance — signed contract shows incorrect rental period)
**Discovered:** 2026-04-23 by Hector
**Reservation:** RES-077038 / Agreement RA-20260422191224-3003 (local repro)

**Symptom:**
After a reservation's `pickupAt` / `returnAt` are edited (post-signature, post-checkout), the rental agreement contract still renders the **original** dates while the **charges were correctly recalculated** for the new period.

| Field | Reservation page | Contract page |
|---|---|---|
| Pickup | 04/16/2027 05:27 AM | 12/4/2026 5:27 AM |
| Return | 05/16/2027 05:27 AM | 12/5/2026 5:27 AM |
| Daily charges | 30 × $50 = $1500 | 30 × $50 = $1500 (matches new period) |
| Total | $1705.94 | $1705.94 (matches) |

The fact that the charges line shows the correct day count (30, matching the *new* April-May 2027 period) but the dates printed in the contract header show the *original* December 2026 period suggests the agreement persists `pickupAt` / `returnAt` denormalized at finalize time, and the HTML render reads from that snapshot — never refreshed when the source reservation is edited.

**Repro (in local Docker):**
1. Create a reservation with pickup=Date X, return=Date X+1.
2. Sign + check out via the customer flow, generating a rental agreement.
3. Open the reservation in admin, change Pickup Date to a much later date and Return Date to +30 days from new Pickup. Save.
4. Open the agreement PDF / page (`/agreements/<id>`).
5. **Bug:** Header shows old (X / X+1) dates; charges block shows recalculated 30 × daily rate.

**Hypothesis (file pointers):**
- Template: `backend/src/templates/agreement-modern.html` lines 197–198 render `{{pickupAt}}` / `{{returnAt}}` from substituted variables.
- Substitution source: likely `backend/src/modules/rental-agreements/rental-agreements.service.js` (where the template is filled). Need to grep where `pickupAt` is sourced — probably from the `RentalAgreement` row, which stores its own copy at finalize time, not from `Reservation` joined live.
- Compare: `backend/src/modules/rental-agreements/rental-agreements-compact.js` for the data shape, and `rental-agreements-finalize-tx.test.mjs` for the snapshot pattern.

**Open questions before fixing:**
1. Is the snapshot intentional for legal reasons (signed contract is immutable)? If yes, then editing reservation dates post-signature should be **blocked** (or trigger a re-sign flow), not silently allowed.
2. If editing pre-signature is allowed, then the agreement render should pull from `Reservation` live (or sync the snapshot on every edit).
3. What's the policy when status is `CHECKED_OUT` (as in this repro)? Mid-rental extensions are common in car rental — they typically generate an "addendum" rather than rewriting the original contract.

**Recommended scope:**
- Decide policy with Hector first (block edit / allow live render / addendum flow).
- For the "block edit" path: add a guard in `reservations.service.js` PATCH handler that refuses date changes when `RentalAgreement.status === 'SIGNED'` or `Reservation.status === 'CHECKED_OUT'`, returning a 409 with a useful message.
- For the "live render" path: change agreement template substitution to read `Reservation.pickupAt` / `Reservation.returnAt` instead of `RentalAgreement.pickupAt` / `RentalAgreement.returnAt`, and add a test asserting that an edit to reservation dates is reflected in the regenerated PDF.

---

## Closed

### BUG-003 — Commit `7cd3efc` orphaned imports / 7 PayArc + AuthorizeNet files missing from `main`

**Closed:** 2026-04-25 in merge commit `a88f0ea` (PR #7), deployed as `v0.9.0-beta.6` on 2026-04-25 00:30 EDT.

**Severity at time of report:** High (production backend would fail to boot if anyone ran a clean install — `import` from `public-booking.routes.js` / `public-booking.service.js` resolved to missing modules). Live droplet was unaffected because it had been built before the orphaning and ran the cached image.

**Original symptom:**
Commit `7cd3efc feat(public-booking): Sprint 4/5/6 backend + guestToken` added `public-booking.routes.js` and `public-booking.service.js` with imports to 7 files that existed in git history (in commits `00109b8` PayArc and `cefd819` AuthorizeNet/payment-session) but were never included in `7cd3efc` itself — likely a rebase or squash that absorbed implementations but dropped the files. `main` had broken transitive imports for several hours before the gap was noticed.

**Files restored:**
- `backend/src/modules/public-booking/authnet-accept-hosted.js` (from `cefd819`)
- `backend/src/modules/public-booking/payarc-bridge-html.js` (from `00109b8`)
- `backend/src/modules/public-booking/payarc-hosted-fields.js` (from `00109b8`)
- `backend/src/modules/public-booking/payarc-hosted-fields.test.mjs` (from `00109b8`)
- `backend/src/modules/public-booking/payarc-session.service.js` (from `00109b8`)
- `backend/src/modules/public-booking/payment-session.service.js` (from `cefd819`)
- `backend/src/modules/public-booking/payment-session.test.mjs` (from `cefd819`)

**Closure path:**
1. **2026-04-23 evening** — 1 file (`payment-session.service.js`) restored to `main` via commit `02e5d56` while diagnosing the issue.
2. **2026-04-23 late** — remaining 6 files restored in tag-only commit `bab596d`; `v0.9.0-beta.5` was placed at that commit. The 6 files were **not** also pushed back to `main` at this point — a partial closure that wasn't caught at the time.
3. **2026-04-24** — building the beta.6 rollup branch surfaced the gap: docker-bootstrapped backend on the rollup branch failed with `ERR_MODULE_NOT_FOUND` for `payarc-session.service.js`. Fix: cherry-picked `bab596d` onto the rollup branch as `25210dd`.
4. **2026-04-25 00:00 EDT** — PR #7 merged via GitHub UI as `a88f0ea`, which contains the cherry-pick. All 7 files now tracked on `main`.
5. **2026-04-25 00:30 EDT** — `v0.9.0-beta.6` deployed to production droplet, all three new feature surfaces (website-fees channel enforcement, Stop Sale tab, Review Email Automation) verified live.

**Open follow-up (separate task):** CI gap — `backend-check` runs only `node --check src/main.js` (syntax check, no transitive import resolution). A future commit with a broken import would pass `backend-check` and only fail when docker boots in `tenant-isolation-suite`. Add a resolver check (e.g., `node -e "import('./src/main.js')"`) so this class of bug is caught before merge.
