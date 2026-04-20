# Checkout Performance — Implementation Plan

**Status:** Proposed · **Owner:** solution-architect · **Created:** 2026-04-18

## Problem statement

Users report the rental check-out flow is slow. Live measurement in prod
(reservation RES-905905) confirms **~12 seconds** user-perceived latency between
the click on "Complete Check-out" and the redirect back to the reservation
detail screen.

### Measured breakdown (baseline)

| # | Endpoint                                                     | Time    | % total |
|---|--------------------------------------------------------------|--------:|--------:|
| 1 | `PATCH /api/reservations/:id`                                | 887 ms  | 7%      |
| 2 | `POST /api/reservations/:id/start-rental`                    | 1913 ms | 16%     |
| 3 | `PUT  /api/rental-agreements/:id/rental`                     | 619 ms  | 5%      |
| 4 | `GET  /api/rental-agreements/:id/inspection-report`          | 694 ms  | 6%      |
| 5 | `POST /api/rental-agreements/:id/signature`                  | 1414 ms | 12%     |
| 6 | `POST /api/rental-agreements/:id/finalize`                   | 1570 ms | 13%     |
| 7 | `POST /api/rental-agreements/:id/email-agreement`            | 4945 ms | **41%** |
|   | **Total (sequential, blocking user)**                        | ~12 s   |         |

### Root causes (confirmed by code + measurement)

- **`email-agreement`** launches a fresh Puppeteer Chromium per request
  (`rental-agreements.service.js:2164`), waits for `networkidle0`, renders the
  PDF, then sends SMTP — all inside the HTTP handler with `await`. 4.9 s.
- **`start-rental`** re-syncs the entire agreement on every call: 15+ sequential
  Prisma queries (`findFirst` with 6 includes → `findUnique` → `deleteMany` +
  `createMany` for charges → 2× `findMany` for auto-fees → `update`). None
  wrapped in a transaction.
- **`finalize`** performs 3-5 serialized writes (update agreement → update
  reservation → optional create payment → optional customer credit update).
- Response payloads for `start-rental`, `signature`, `finalize` are **~475-481
  KB each** because they return the agreement with every relation included.

## Approach

Four independent, mergeable PRs in order of ROI. Each PR is validated in
staging before prod.

---

## PR 1 — Async email + Puppeteer singleton

**Impact:** ~12 s → ~6-7 s (saves ~5 s).
**Risk:** Low.
**Owner:** `senior-backend-developer` + `senior-react-developer` (parallel).

### Backend changes

**New file: `backend/src/lib/puppeteer-browser.js`**

Exports `getBrowser()` returning a singleton `Browser` instance. On first call,
`puppeteer.launch({ headless: 'new', executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args: ['--no-sandbox','--disable-setuid-sandbox'] })`. Subsequent
calls return the cached instance. Export `closeBrowser()` for SIGTERM cleanup.
If the browser disconnects (crash), the next `getBrowser()` re-launches.

**Edit: `backend/src/main.js`**

- Import `closeBrowser` and wire into existing SIGINT/SIGTERM handlers alongside
  the schedulers cleanup.

**Edit: `backend/src/modules/rental-agreements/rental-agreements.service.js`**

- In `agreementPdfBuffer(id)` (line ~2162):
  - Replace `puppeteer.launch(...)` with `getBrowser()`.
  - Change `waitUntil: ['load','networkidle0']` to `'domcontentloaded'` — the
    template inlines all assets; no network wait needed.
  - Keep `page.close()` but **do not** `browser.close()` (it's the singleton).

**Edit: `backend/src/modules/rental-agreements/rental-agreements.routes.js`**

- In the `POST /:id/email-agreement` handler: respond `202 Accepted` immediately
  and schedule the actual `emailAgreement` call with
  `setImmediate(() => rentalAgreementsService.emailAgreement(req.params.id, req.body || {}, req.user?.sub || null).catch((e) => captureBackendException(e, { context: 'emailAgreement async', agreementId: req.params.id })))`.
- The job handler already writes an `auditLog` entry on success; extend to
  write `EMAIL FAILED` on error so ops can retry from the UI.

### Frontend changes

**Edit: `frontend/src/app/reservations/[id]/checkout/page.js`**

- In the `complete()` function, remove the `await` from the `email-agreement`
  call (line ~159). The existing `try { ... } catch {}` wrapper stays but is
  effectively dead code now since backend is fire-and-forget.
- The `router.push(\`/reservations/\${id}\`)` happens immediately after
  `finalize`.

### Tests (qa-engineer)

- **New:** `backend/src/modules/rental-agreements/rental-agreements-email-async.test.mjs`
  - Fake `rentalAgreementsService.emailAgreement` to return after 100 ms.
  - Assert the route handler returns 202 in <50 ms.
  - Assert the fake was called (fire-and-forget reached).
- **New:** `backend/src/lib/puppeteer-browser.test.mjs`
  - `getBrowser()` returns the same instance on two calls.
  - `closeBrowser()` followed by `getBrowser()` creates a fresh one.
- Run existing: `npm test` must pass. `tenant-isolation-suite` still green.

### Staging validation

- Trigger a checkout on a real reservation. Measure click → redirect with
  DevTools Performance tab.
- Expected: ~6-7 s (down from 12).
- Check the `auditLog` for the agreement 30-60 s after: `EMAIL SENT` entry
  should appear.

### Risk mitigation

- **Puppeteer crash leaves singleton dead:** `getBrowser()` checks
  `browser.isConnected()`; if false, re-launches transparently.
- **Email job fails silently:** `captureBackendException` routes errors to
  Sentry with `agreementId` tag. Staff can re-send from the agreement detail
  view (button "Email Agreement" already exists).
- **Shutdown during in-flight email:** worst case an in-flight SMTP send is
  interrupted; the auditLog will not get `EMAIL SENT`. Staff can retry. Not
  worth complex job-persistence until Redis is deployed.

---

## PR 2 — Transactions for start-rental + finalize

**Impact:** ~1 s additional (saves ~0.5-1 s from `start-rental` + ~0.3-0.5 s
from `finalize`).
**Risk:** Medium (changes write semantics; a failing tx now rolls back rather
than leaving partial state — which is the correct behavior but changes the
observable story).
**Owner:** `senior-backend-developer`.

### Backend changes

**Edit: `backend/src/modules/rental-agreements/rental-agreements.service.js`**

- In `startFromReservation` → the branch where `existing` agreement is found
  and charges need to be re-synced (line ~1342-1354 block):
  - Wrap `deleteMany + createMany + update` in
    `prisma.$transaction(async (tx) => { ... }, { timeout: 10000 })`.
  - Do the same for the second sync branch around line ~1399-1416.
  - Leave the initial `findFirst` + `findUnique` reads outside the tx (they
    don't need it).
- In `finalize` (line ~3462):
  - Wrap the trailing writes in `prisma.$transaction(async (tx) => { ... })`:
    the agreement `update`, the reservation `update`, the optional
    `rentalAgreementPayment.create` (explicit paid amount), and the optional
    credit `rentalAgreementPayment.create`. The customer credit
    `customer.update` also goes inside the same tx since it's logically atomic
    with "agreement finalized".
  - The initial validation/lookup block (agreement fetch, charge count,
    customer credit lookup) stays outside.

### Tests (qa-engineer)

- **New:** `backend/src/modules/rental-agreements/rental-agreements-finalize-tx.test.mjs`
  - Fake prisma where the second write (reservation.update) throws.
  - Assert the agreement is NOT marked `FINALIZED` (tx rolled back).
- **New:** `backend/src/modules/rental-agreements/rental-agreements-start-rental-tx.test.mjs`
  - Fake prisma where `createMany` fails after `deleteMany`.
  - Assert the original charges were not deleted (tx rolled back).
- Run full `npm test` and `tenant-isolation-suite`.

### Risk mitigation

- **Tx timeout:** pass `{ timeout: 10000 }` explicitly. Prisma default (5 s) is
  marginal for this code path.
- **Longer lock time on `rentalAgreement` rows:** acceptable trade-off; these
  mutations happen one at a time per reservation.

---

## PR 3 — Trim response payloads

**Impact:** ~300-500 ms (mostly network transfer).
**Risk:** Low, but requires frontend grep before merge.
**Owner:** `senior-backend-developer` + `senior-react-developer`.

### Backend changes

**Edit: `backend/src/modules/rental-agreements/rental-agreements.routes.js`**

- In `POST /:id/signature`, `POST /:id/finalize`, `POST /:id/start-rental`:
  after the service call, before `res.json`, trim to
  `{ id, status, balance, total, finalizedAt, agreementNumber }`. If the
  frontend needs more, it refetches with `GET /:id`.

### Frontend changes

**Edit: `frontend/src/app/reservations/[id]/checkout/page.js` and any component
that consumes the trimmed responses.**

- Grep for usages of `agreement.charges`, `agreement.payments`, `agreement.reservation`
  right after those three mutations. Anywhere that breaks, either:
  - Use the already-present local state, or
  - Refetch via `GET /api/rental-agreements/:id`.

### Tests (qa-engineer)

- Run `cd frontend && npm run verify` — must pass.
- Add a component test for any view that depends on trimmed response.

### Risk mitigation

- **Hidden consumer breaks silently:** the grep + component tests catch the
  obvious cases. Run staging smoke tests covering checkout, agreement detail,
  email resend.

---

## PR 3.2 — Pin slim response contracts (contract-union test)

**Impact:** Test coverage only — no runtime change.
**Risk:** Very low (new pure helper extraction + tests; no semantics change).
**Owner:** `senior-backend-developer` (refactor) + `qa-engineer` (tests), in parallel.

### Problem

After PR 3 (`786f4b6`) shipped `compactAgreementResponse()` for `POST /:id/signature` and `POST /:id/finalize`, and commit `e9e2c5f` shipped an inline slim response for `POST /reservations/:id/start-rental`, we have three hot-path checkout endpoints each returning a minimal-fields envelope:

- `/signature` and `/finalize`: 6 fields — `id, agreementNumber, status, total, balance, finalizedAt` — via `compactAgreementResponse()`.
- `/start-rental`: 7 fields — `id, agreementNumber, reservationId, status, total, paidAmount, balance` — inline in `reservations.routes.js`.

Intersection is 5 fields (`id, agreementNumber, status, total, balance`); each endpoint has unique fields beyond that. Nothing in the repo pins these shapes as contract, so a future schema change or refactor could silently add or drop a field. Frontend / mobile would only notice at runtime. QA flagged this gap during review of PR 3 (YELLOW-deferred).

### Backend changes (senior-backend-developer)

**New file: `backend/src/modules/reservations/start-rental-compact.js`**

Pure helper `compactStartRentalResponse(row)` returning exactly the 7 contract fields. Mirrors the structure of `rental-agreements-compact.js` with the same defensive passthrough for `null`/non-object inputs.

**Edit: `backend/src/modules/reservations/reservations.routes.js`**

Import the helper. Replace the inline object literal in `POST /:id/start-rental` (lines ~733-741) with `res.status(201).json(compactStartRentalResponse(agreement))`. Keep the 201 status code and the comment block explaining the slim rationale.

### Tests (qa-engineer)

**New file: `backend/src/modules/reservations/start-rental-compact.test.mjs`**

Unit tests for `compactStartRentalResponse`. Mirrors `rental-agreements-compact-response.test.mjs` pattern: 7-keys-exact, preserves values, strips relations, strips out-of-contract fields, passthrough for null/undefined/primitives, tolerant of missing optional fields.

**New file: `backend/src/modules/rental-agreements/slim-response-contracts.test.mjs`**

Contract-union test that pins both envelopes together:

- Declares the two field lists as frozen constants.
- Asserts the intersection (5 fields) and the symmetric difference (3 fields) against the expected values — any drift fails loudly with a named-field error message.
- Runs both `compactAgreementResponse` and `compactStartRentalResponse` against a common "fat" agreement row fixture and asserts each returns only its declared field list.
- Produces a single union-set of allowed fields across all three endpoints (8 fields total) so a reviewer can see the full contract at a glance.

### Acceptance

- `node --test backend/src/modules/reservations/start-rental-compact.test.mjs` passes.
- `node --test backend/src/modules/rental-agreements/slim-response-contracts.test.mjs` passes.
- `cd backend && npm test` still green end-to-end.
- `grep -n compactStartRentalResponse backend/src/modules/reservations/reservations.routes.js` finds exactly one call site.
- Tenant-isolation suite not affected (no route-level behavior change).

### Risk mitigation

- **Refactor regression:** the route change is literal → function call. Pure field mapping, no semantic change. The new unit test + the existing `npm test` cover it.
- **Schema drift:** the entire point of this PR. The contract-union test is the guard.

### Out of scope

- No frontend changes. The slim response shapes are already shipped; we're only pinning them.
- No change to `compactAgreementResponse`. The new sibling helper is additive.

---

## PR 4 — Parallelize safe UI steps

**Impact:** 300-600 ms.
**Risk:** Low.
**Owner:** `senior-react-developer`.

### Frontend changes

**Edit: `frontend/src/app/reservations/[id]/checkout/page.js`**

- After `start-rental` completes, run the next two calls in parallel:
  - `PUT /rental-agreements/:id/rental` (odometer, fuel, cleanliness).
  - `GET /rental-agreements/:id/inspection-report` (ensureCheckoutInspectionComplete).
  Using `Promise.all([...])`. These don't depend on each other.
- `signature` and `finalize` stay sequential (finalize needs signature
  attached).

### Tests (qa-engineer)

- Component test verifies both requests are fired before awaiting any.
- No backend changes, so `tenant-isolation-suite` not relevant.

---

## Release order

1. **Week 1:** PR 1 on `develop` → stage validation 24 h → merge to `main` →
   tag `v0.9.0-beta.N+1`. Monitor Sentry P95 for `email-agreement` and
   checkout total.
2. **Week 2:** PR 2 after PR 1 settles. Run full `tenant-isolation-suite` in
   staging before merging.
3. **Week 3:** PR 3 + PR 4 together (low risk, small diffs).
4. **Week 4:** `performance-engineer` runs post-release validation: measure
   P95 of each endpoint against this document's baseline. Report delta to
   the architect.

## Out of scope (future work)

- **Redis-backed job queue** for `email-agreement` (BullMQ). Needed when email
  volume grows or when we want retries. Depends on Redis rollout per
  `docs/architecture/SCALING_ROADMAP.md`.
- **Refactor `startFromReservation`** to diff charges instead of
  delete+create. Significant work, separate proposal.
- **Schema-level cascade for agreement child tables** to reduce round-trips
  in deletion flows.

## Rollback

Each PR tagged separately (`v0.9.0-beta.N+1`, `+2`, `+3`, `+4`). Rollback via
`ops/rollback-beta.ps1 -Tag <prev-tag>` if Sentry shows regressions.

## Success metric

Checkout total (click → redirect) P95 goes from ~12 s to ≤4 s within 4 weeks,
with no increase in checkout-related error rate.
