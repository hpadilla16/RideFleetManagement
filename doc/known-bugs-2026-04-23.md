# Known Bugs — Software Backlog

**Started:** 2026-04-23
**Owner:** Hector
**Purpose:** Single running list of bugs surfaced during day-to-day use that are not yet scheduled into a sprint or PR. Each bug has enough detail to reproduce + a hypothesis. Add new entries at the top; move closed entries to the bottom under "Closed" with the fixing PR / commit reference.

---

## Open

_(none — BUG-001 / BUG-002 / BUG-003 / BUG-004 all closed in v0.9.0-beta.6 and v0.9.0-beta.7. Add new bugs at the top of this section as they're discovered.)_

---

## Closed

### BUG-001 — Rental agreement dates do not update when reservation dates change

**Closed:** 2026-04-27 in merge commit `fa045b2` (PR #9), deployed as `v0.9.0-beta.7` on 2026-04-27 22:55 EDT.

**Severity at time of report:** High (legal / compliance — signed contract showed incorrect rental period if reservation dates were edited post-signature).

**Original symptom:**
After a reservation's `pickupAt` / `returnAt` were edited post-signature / post-checkout, the rental agreement contract still rendered the original dates while the charges were silently recalculated for the new period. The customer's signed contract no longer matched the actual rental period.

**Resolution — Option C (Addendum Flow):**
Of the three options identified in the original report (block edit, live render, addendum flow), Option C was implemented. The signed agreement now stays immutable as the legal record. When dates change post-DRAFT, the system creates a `RentalAgreementAddendum` row that captures the new dates, reason, original / new charges snapshot + delta, initiator, and its own signature lifecycle (`PENDING_SIGNATURE` → `SIGNED` → `VOID`). The customer is notified by email at creation; admin signs on the customer's behalf via the authenticated route, or voids and recreates if rejected. Date-edit gate in `reservations.service.js update()` returns 409 with `code: ADDENDUM_PENDING` (when an unsigned addendum exists) or `code: AGREEMENT_IMMUTABLE` (when the caller tries to bypass the flow).

**Closure path:**
1. **2026-04-23 evening** — branched `feature/rental-agreement-addendum`. 3 commits: plan, schema + migration, service methods.
2. **2026-04-27** — merged main into the branch + shipped Commits 3–5: routes + reservations gate + customer email helper, v8 tenant-isolation suite, admin frontend `AgreementAddendumsCard` component.
3. **2026-04-27 ~22:30 EDT** — PR #9 merged as `fa045b2`.
4. **2026-04-27 22:55 EDT** — `v0.9.0-beta.7` deployed; `RentalAgreementAddendum` schema applied to Supabase, addendum routes mounted (verified via `/api/rental-agreements/:id/addendums` returning 401 through nginx).

**Files of note (where the fix lives):**
- `backend/prisma/schema.prisma` — `RentalAgreementAddendum` model + `Tenant.agreementAddendums` relation
- `backend/prisma/migrations/20260423_add_rental_agreement_addendum/migration.sql`
- `backend/src/modules/rental-agreements/rental-agreements.service.js` — 6 addendum service methods
- `backend/src/modules/rental-agreements/rental-agreements.routes.js` — 6 addendum routes
- `backend/src/modules/rental-agreements/addendum-notification.service.js` — customer email
- `backend/src/modules/reservations/reservations.service.js` — date-edit gate in `update()`
- `frontend/src/components/AgreementAddendumsCard.jsx` — admin UI
- `docs/operations/rental-agreement-addendum-plan.md` — implementation plan

**Open follow-ups:** Customer self-service signing via `/customer/sign-agreement?type=addendum` (needs a public token-based endpoint + magic-link issuer). Admin team email at addendum creation (currently customer-only). Unit tests for the addendum service methods (require a small DI refactor to extract standalone TX-accepting functions).

---

### BUG-002 — `calculateShortage` returns extra trailing day past mid-day return

**Closed:** 2026-04-27 in merge commit `694841e` (PR #8), deployed as `v0.9.0-beta.7` on 2026-04-27 22:55 EDT.

**Severity at time of report:** Medium (test failure blocked `npm test` chain; production planner UI may have over-reported phantom shortages on rental return days).

**Original symptom:**
The `calculateShortage` test in `backend/src/modules/planner/planner.service.test.mjs` failed because a 2-day rental returning at 10am on day 3 was being counted as occupying day 3 (phantom shortage). Test expected day 1 + day 2 only.

**Resolution — fix the implementation, not the test:**
The decision matched the rental-industry "rental day" model — a 48-hour rental returning at the same time as pickup is two rental days; the return day is back in inventory by end-of-business. Extracted a new `reservationOccupiesDayForShortage(reservation, nextDayStart)` helper that requires the rental to span past `nextDayStart` (`pickup < nextDay && return > nextDay`). `calculateShortage` now uses this helper instead of the generic `reservationOverlapsRange`. Same-day rentals (pickup and return on the same day) currently under-count under this rule — captured as a comment in the helper; acceptable trade-off for now.

**Closure path:**
1. **2026-04-27 morning** — fixed in commit `e7dd5c9` on `chore/post-beta6-cleanups`.
2. **2026-04-27 ~21:30 EDT** — PR #8 merged as `694841e`.
3. **2026-04-27 22:55 EDT** — `v0.9.0-beta.7` deployed.

`npm test` chain now exits 0; planner test passes 2/2. Production planner shortage forecasts no longer include phantom shortages on return days.

---

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

---

### BUG-004 — `websiteFeesTotal` `useMemo` may undercount fees with `mode: 'PER_DAY'`

**Closed:** 2026-04-27, verified live in `v0.9.0-beta.7` on production.

**Severity at time of report:** Medium (customer-facing display total could differ from what the backend charges — a trust issue, not a financial loss).

**Original symptom:**
The PR #6 review bot flagged a possible discrepancy between the inline `computeFeeLineTotal` in the JSX render block (which uses `days`) and the `websiteFeesTotal` `useMemo` that builds the `checkoutEstimatedTotal` shown to the user. Concern was that PER_DAY fees might be calculated with different day-count rounding in the two paths, leading the displayed total to be lower than what the backend charges.

**Resolution — verified working live, no code change attributable:**
Manual probe on production (`v0.9.0-beta.7`) confirmed the displayed `checkoutEstimatedTotal` matches the backend-calculated total for PER_DAY fees end-to-end. Either the bot's concern was a false positive (the two computation paths use the same `days` value and equivalent line-total logic), or the issue was resolved as a side-effect of the website-fees / fee-channel-filter / stop-sale rollup commits in `b656b8e` (PR #6 / #7).

No code change in any subsequent PR is attributable to BUG-004 specifically. Closing on verification rather than on a fix commit. If the discrepancy resurfaces later, re-open and re-investigate `frontend/src/app/book/page.js` `websiteFeesTotal` `useMemo` vs the inline render block.
