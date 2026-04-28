# Loaner Module — Premier-Product Scoping

**Date:** 2026-04-28
**Owner:** Hector
**Goal:** Match category leaders (Loaner Manager, Star Loaner, Modera, TSD) feature-for-feature so the dealership-loaner offering competes head-to-head with established players. Scoping doc only — no commits in this PR.

---

## 1. Context

The dealership-loaner mode is already a first-class workflow alongside `RENTAL` and `CAR_SHARING` — it's not a Phase-0 problem. The system has a real intake form, six operational queues (intake, active, returns, advisor, billing, alerts), a billing lifecycle, and HTML/CSV export pipelines. The question is: **what's still missing between what we have and what a service manager evaluating us against TSD or Loaner Manager would expect to see?**

The answer is mostly captured in three buckets:

1. **In-bay capture** — physical signature, photos, OCR, damage maps. The borrower packet today is a checklist of booleans; the industry expects a tablet experience that produces a signed legal document with photographic evidence.
2. **Integrations** — DMS (Reynolds & Reynolds, CDK, Dealertrack), manufacturer warranty programs (Toyota Care, Lexus Plus, BMW Loaner), accounting (QuickBooks, Sage). These are table-stakes for a dealership stack.
3. **Customer-facing** — self-service status / extension / return scheduling, SMS reminders, recall awareness. We have an email; competitors have a portal.

This doc lists what we have, what's missing, and a phased plan to close the gap.

---

## 2. Current state — what we already have

### 2.1 Schema (28 Reservation columns + 3 enums)

**Identity / lifecycle:**

- `workflowMode = DEALERSHIP_LOANER` (`schema.prisma:272-276`) — first-class enum value.
- `dealershipLoanerEnabled` feature flag on `Tenant` (`schema.prisma:361`).

**Liability / packet:**

- `loanerLiabilityAccepted`, `loanerLiabilityAcceptedAt` (`schema.prisma:661-662`).
- `loanerBorrowerPacketJson`, `loanerBorrowerPacketCompletedAt`, `loanerBorrowerPacketCompletedBy` (`schema.prisma:664-666`). Packet is a JSON blob holding 5 booleans (`driverLicenseChecked`, `insuranceCardCollected`, `registrationConfirmed`, `walkaroundCompleted`, `fuelAndMileageCaptured`) + free-text `notes`.

**Billing:**

- `loanerBillingMode` enum: `COURTESY | CUSTOMER_PAY | WARRANTY | INSURANCE | INTERNAL` (`schema.prisma:278-284`).
- `loanerBillingStatus` enum: `DRAFT | PENDING_APPROVAL | APPROVED | INVOICED | SETTLED | DENIED` (`schema.prisma:286-293`).
- `loanerBillingContact{Name,Email,Phone}`, `loanerBillingAuthorizationRef`, `loanerBillingNotes`.
- `loanerBillingSubmittedAt`, `loanerBillingSettledAt`.

**Service-advisor / lifecycle:**

- `serviceAdvisorName`, `serviceAdvisorEmail`, `serviceAdvisorPhone`, `serviceAdvisorNotes`, `serviceAdvisorUpdatedAt`.
- `serviceVehicle{Year,Make,Model,Plate,Vin}`.
- `serviceStartAt`, `estimatedServiceCompletionAt`.
- `loanerServiceCompletedAt`, `loanerServiceCompletedBy`, `loanerCloseoutNotes`.
- `repairOrderNumber`, `claimNumber`.

**Accounting closeout:**

- `loanerPurchaseOrderNumber`, `loanerDealerInvoiceNumber`.
- `loanerAccountingNotes`, `loanerAccountingClosedAt`, `loanerAccountingClosedBy`.

**Return management:**

- `loanerReturnExceptionFlag`, `loanerReturnExceptionNotes`.
- `loanerLastExtendedAt`, `loanerLastVehicleSwapAt`.

There are **no standalone loaner models** — everything extends `Reservation`. That's a tactical choice that keeps the operations engine unified, and it works today.

### 2.2 Backend (1 service, 1 route file)

`backend/src/modules/dealership-loaner/dealership-loaner.service.js` exports 19 methods covering: config check, dashboard with 6 queues + metrics, intake-options, intake creation, single-reservation read, three HTML print renderers (handoff, billing, PO), two CSV exports (billing, statement), monthly statement print, borrower-packet save, billing save, accounting closeout, advisor-ops save, return-exception save, extend, vehicle swap, complete-service.

`backend/src/modules/dealership-loaner/dealership-loaner.routes.js` mounts 19 corresponding routes at `/api/dealership-loaner/*`. All require `ADMIN | OPS | AGENT` role; most also gate on the tenant's `dealershipLoanerEnabled` flag.

### 2.3 Frontend

`frontend/src/app/loaner/page.js` (1,127 lines) is the service-lane hub. Sections:

- **Snapshot** — 10 metrics (active loaners, overdue returns, service delays, billing-pending, etc.).
- **Loaner Shift** — priority board pinning the next 4 actions the lane should take.
- **Service Lane Priority Board** — operational guidance.
- **Loaner Lookup** — search + filters.
- **Quick Intake** — full form: customer, billing mode, RO/claim, advisor, service vehicle, loaner vehicle, dates, locations, notes, liability checkbox.
- **Six queues** — INTAKE, ACTIVE, RETURNS, ADVISOR, BILLING, ALERTS, each with appropriate row actions (checkout, open, payments, etc.).
- **Alert escalation** — overdue/SLA visibility.

### 2.4 What's documented

- `docs/architecture/SCALING_ROADMAP.md` mentions dealership-loaner as a competitive category and notes TSD is the incumbent.
- `docs/operations/performance-prep-2026-04-28.md` (just shipped) references this scoping doc.
- No prior loaner-feature requirements docs in the repo.

---

## 3. Competitive landscape (general knowledge baseline)

Dealership service-loaner software is a mature category. The three patterns customers expect, and where the named players sit on each:

### 3.1 In-bay tablet experience

| Capability | Loaner Manager | Star Loaner | TSD | Modera |
|---|---|---|---|---|
| Customer e-signature on tablet | ✅ | ✅ | ✅ | ✅ |
| Driver license scan / OCR | ✅ | ✅ | ✅ | ✅ |
| Walkaround photo capture (8-12 angles, annotated) | ✅ | ✅ | ✅ | ✅ |
| Damage map (clickable diagram) | ✅ | partial | ✅ | partial |
| Insurance card photo capture | ✅ | ✅ | ✅ | ✅ |
| Fuel-out / fuel-in level capture (with photo of gauge) | ✅ | ✅ | ✅ | ✅ |
| Mileage-out / mileage-in (with photo of odometer) | ✅ | ✅ | ✅ | ✅ |
| Print + email signed packet | ✅ | ✅ | ✅ | ✅ |

### 3.2 DMS / manufacturer integrations

| Capability | Loaner Manager | Star Loaner | TSD | Modera |
|---|---|---|---|---|
| Reynolds & Reynolds DMS | ✅ | ✅ | ✅ | partial |
| CDK Global DMS | ✅ | ✅ | ✅ | ✅ |
| Dealertrack DMS | ✅ | ✅ | ✅ | ✅ |
| Toyota Care / Lexus Plus loaner program | ✅ | ✅ | ✅ | partial |
| BMW Loaner program | ✅ | partial | ✅ | partial |
| Recall lookup (NHTSA / OEM) | ✅ | partial | ✅ | partial |
| QuickBooks / Sage accounting export | ✅ | ✅ | ✅ | partial |

### 3.3 Customer-facing surface

| Capability | Loaner Manager | Star Loaner | TSD | Modera |
|---|---|---|---|---|
| Customer self-service portal (status, extend, return-schedule) | ✅ | ✅ | ✅ | partial |
| SMS notifications | ✅ | ✅ | ✅ | ✅ |
| Email reminders (return due, overdue) | ✅ | ✅ | ✅ | ✅ |
| Online appointment scheduling for return | ✅ | partial | ✅ | partial |
| Customer feedback / NPS post-loaner | ✅ | partial | partial | partial |

### 3.4 Operational depth (where we already compete well)

| Capability | RideFleet | Loaner Manager | Star Loaner |
|---|---|---|---|
| Multi-tenant isolation (franchise / multi-rooftop) | ✅ | ✅ | ✅ |
| Six-queue service-lane workflow | ✅ | ✅ | ✅ |
| Mandatory liability acceptance with timestamp | ✅ | ✅ | ✅ |
| 5-mode billing (Courtesy / Customer / Warranty / Insurance / Internal) | ✅ | ✅ | ✅ |
| Vehicle swap mid-loaner | ✅ | ✅ | ✅ |
| Service-advisor metadata + ready-for-pickup signaling | ✅ | ✅ | ✅ |
| Toll integration (per-vehicle TollTransaction with billing) | ✅ | partial | partial |
| Car-sharing / rental crossover (same vehicle, different mode) | ✅ | ❌ | ❌ |

The toll integration and car-sharing crossover are genuinely **differentiators**, not just feature-parity items.

---

## 4. Gap analysis

Mapped to the three buckets in §1. Each gap tagged by **competitive importance** (table-stakes / catch-up / differentiator) and **effort** (S / M / L).

### 4.1 In-bay tablet experience (HIGHEST priority bucket)

| # | Gap | Importance | Effort | Notes |
|---|---|---|---|---|
| T-1 | **Customer e-signature on the loaner agreement** (canvas, store data URL, render in handoff PDF) | Table-stakes | M (5-7 days incl. tablet UX + PDF rendering) | Mirrors the existing `signatureDataUrl` pattern on `RentalAgreement`. New table `LoanerAgreement` OR add `signatureDataUrl` + signing fields to `Reservation` for `DEALERSHIP_LOANER` rows. |
| T-2 | **Walkaround photo capture** — 8 angle prompts (front, rear, both sides, both bumpers, hood, roof) with required-photo validation | Table-stakes | L (1.5-2 weeks incl. photo storage strategy: S3? Supabase storage? base64 in DB is wrong) | Needs a photo-store decision. Supabase has built-in storage; that's the path of least resistance. Each photo gets metadata: angle label, taken-at, taken-by, optional damage annotation. |
| T-3 | **Damage map** — clickable car diagram, taps drop pin + note + photo per damage point | Catch-up | L (2-3 weeks; SVG-based diagram + state model) | Builds on T-2's photo pipeline. Could ship MVP without diagram (just photos + notes), then add diagram in a later iteration. |
| T-4 | **Driver license OCR** — capture front/back of license, OCR fields (name, DOB, license #, expiry, address), pre-fill borrower packet | Catch-up | M-L (depends on OCR provider — Tesseract vs paid API; expect 1-2 weeks) | Cheaper alternative: just take a photo and store it (skip OCR, manual entry stays). 80% of value at 20% of effort. |
| T-5 | **Insurance card capture** — photo of front + back, OCR carrier/policy number/effective dates | Catch-up | M (1 week if photo-only; 2 weeks with OCR) | Similar trade-off to T-4. |
| T-6 | **Fuel-level + odometer capture with photo** at out and in | Table-stakes | S-M (1-3 days) | Fields exist (`fuelOut`, `fuelIn`, `odometerOut`, `odometerIn` on `RentalAgreement`); just need UI flow + photo attachments. |
| T-7 | **Borrower packet structured fields** — promote the JSON blob's checklist to first-class columns so the dashboard can filter/sort on individual checks | Catch-up | S (1 day migration + service updates) | Cleanup of existing tech debt. |

### 4.2 Integrations (catch-up bucket — competitive but each is a separate project)

| # | Gap | Importance | Effort | Notes |
|---|---|---|---|---|
| I-1 | **CDK Global DMS** integration — RO sync, customer sync, vehicle sync | Table-stakes for franchise dealers | L (4-6 weeks; CDK requires partner agreement + cert) | Highest-volume DMS; pursue first if targeting franchise dealer market. |
| I-2 | **Reynolds & Reynolds DMS** | Table-stakes for franchise dealers | L (4-6 weeks; partner program required) | Second-most-common DMS; tier 2. |
| I-3 | **Dealertrack DMS** | Catch-up | L (4 weeks; web-services-based, easier than CDK/Reynolds) | Used by smaller dealer groups; useful but lower priority than the top 2. |
| I-4 | **Toyota Care / Lexus Plus** loaner program billing | Catch-up | M (2-3 weeks; OEM portal integrations vary) | High-volume program; once supported, drives Toyota dealer adoption. |
| I-5 | **BMW Loaner program** | Catch-up | M (2-3 weeks) | Premium brand; adoption signal. |
| I-6 | **NHTSA recall lookup by VIN** | Catch-up | S (1-2 days; free public API) | Cheap, visible win. Run on intake; flag if open recalls. |
| I-7 | **QuickBooks Online export** | Catch-up | M (1 week; QBO has good API) | Replaces / complements current CSV export. |
| I-8 | **Sage 50 / Sage Intacct accounting** | Catch-up | M (1-2 weeks) | Common for larger dealer groups. |

### 4.3 Customer-facing surface (catch-up)

| # | Gap | Importance | Effort | Notes |
|---|---|---|---|---|
| C-1 | **SMS notifications** — return-due, overdue, ready-for-pickup, service-complete | Table-stakes | M (1 week; needs Twilio / similar provider; tenant settings for opt-in) | Email-only today is a noticeable gap. Hot competitive item. |
| C-2 | **Customer self-service loaner portal** — status, extend (with reason), return-schedule, view invoice | Catch-up | L (2-3 weeks; mirrors the customer-rental portal) | Builds on the same magic-link / token pattern shipped in v0.9.0-beta.8 for addendum signing. |
| C-3 | **Online return-appointment scheduling** | Differentiator | L (2-3 weeks; needs a slot-availability engine) | Uncommon enough to be a marketing point. |
| C-4 | **Post-loaner NPS / feedback collection** | Catch-up | S (2-3 days; one-question survey + email link) | Reuses the customer-portal token pattern. |
| C-5 | **Return-due email + SMS reminder cadence** — automated 24h-before / 1h-before / 1h-after | Table-stakes | S-M (3-5 days; needs scheduled-job runner) | Cron-style task; existing scheduled-tasks infra in `mcp__scheduled-tasks` could be the model. |

---

## 5. Phased plan

The path that maximizes "compete with category leaders" perception per week of effort.

### Phase 1 — In-bay polish (3-4 weeks)

The biggest visual/marketing gap is the tablet experience. Closing it disproportionately raises perceived parity with category leaders.

- T-1 (e-signature) + T-6 (fuel/odometer-with-photo) + T-7 (structured packet fields) — small, complementary, ship as one PR series.
- T-2 (walkaround photos) — ship next, with the photo-store decision (Supabase Storage recommended) made up front.
- C-5 (return-due reminders) in parallel as a small backend task.

**Phase 1 exit criteria:** A dealership service manager opens the loaner UI on a tablet, completes a full intake including signature + walkaround photos + fuel/mileage with photos, and gets a printable signed packet with all artifacts embedded. SMS-style return reminders fire on schedule.

### Phase 2 — Customer self-service + recalls (3-4 weeks)

Parity with the customer-facing competitive bar.

- C-1 (SMS notifications) — first; unblocks C-5's SMS leg if Phase 1 shipped only email.
- C-2 (customer portal for loaners) — biggest single piece. Reuse the addendum-signing public-token pattern (`/api/public/addendum-signature/:token`) as the architectural template.
- C-4 (NPS) — small follow-up.
- I-6 (NHTSA recall lookup) — cheap, ships as a 1-2 day standalone.

**Phase 2 exit criteria:** Customer receives an SMS when their loaner is ready, opens a portal link to see status, can request an extension, and gets a follow-up NPS one-pager after return. NHTSA recall warnings surface in the intake UI.

### Phase 3 — DMS + warranty integrations (8-12 weeks; pick 1-2)

These are big projects each. Don't try to ship more than 2 in a single quarter.

- Pick one **DMS** based on which target customers you're prioritizing (CDK if mass-market franchise; Reynolds if luxury franchise; Dealertrack if independent groups). I-1 / I-2 / I-3.
- Pick one **manufacturer warranty program** based on the same logic. I-4 / I-5.

**Phase 3 exit criteria:** A target customer can plug in their DMS credentials and see RO sync working end-to-end, with at least one OEM warranty program billing flow validated.

### Phase 4 — Damage map + advanced capture (4-6 weeks)

The differentiator polish that earns the "premier" label after the foundation is solid.

- T-3 (damage map) — depends on T-2 (photos) being live.
- T-4 / T-5 (OCR for license + insurance) — pair with a paid OCR provider for accuracy.

---

## 6. Success metrics

Hard to measure "competitive parity" objectively; pair these with field demos and customer interviews.

| Metric | Today | Phase 1 target | Phase 2 target | Phase 3 target |
|---|---|---|---|---|
| % of intakes with e-signature captured | 0% | 95%+ | 95%+ | 95%+ |
| % of intakes with walkaround photos (8 angles) | 0% | 90%+ | 90%+ | 90%+ |
| % of returns with photographic out/in comparison | 0% | 80%+ | 90%+ | 95%+ |
| Customer notification channels | Email only | Email + tablet print | Email + SMS + portal | Email + SMS + portal + DMS push |
| DMS integrations live | 0 | 0 | 0 | 1 |
| OEM warranty program flows live | 0 | 0 | 0 | 1 |
| Median time-to-intake (customer arrives → keys in hand) | unmeasured | < 7 min | < 5 min | < 5 min |
| Service-manager NPS (post-pilot survey) | unknown | unknown | baseline | +10 vs baseline |

---

## 7. Open questions (decide before Phase 1)

1. **Photo storage backend.** Supabase Storage (free tier on existing Supabase project), S3 (more flexibility, more setup), or Cloudflare R2 (cheap egress)? Recommend Supabase Storage for least friction.
2. **E-signature legal weight.** A canvas-captured signature is fine for civil-contract enforceability in most US states; some dealership compliance teams want a Docusign-style audit trail. If a target customer raises this, route to a Docusign integration as a Phase-2 add-on.
3. **Tablet hardware assumption.** Are dealerships using their own iPads / Android tablets, or do we need to recommend a SKU? The `'use client'` Next pages render fine on iPad Safari today; verify on the borrower-packet flow with an actual touch device once T-1 ships.
4. **OEM partner agreements.** Manufacturer warranty program integrations require legal agreements, not just code. Lead with sales conversations 2-3 months ahead of expected ship.
5. **Borrower packet JSON → columns migration.** T-7 promotes the JSON to columns. Existing rows with packets in JSON form need a backfill script. Trivial logic but a real DB migration. Plan a maintenance window or use additive columns + dual-write during cutover.
6. **Standalone `LoanerAgreement` table?** Today the loaner workflow piggybacks on `RentalAgreement`. As loaner-specific signature, photos, damage maps, etc. accumulate, a dedicated table may be cleaner. Decide before Phase 1's T-1 commits — the shape there sets the tone.

---

## 8. References

- Survey: this doc was written from a code survey of `backend/src/modules/dealership-loaner/{service,routes}.js`, `backend/prisma/schema.prisma`, and `frontend/src/app/loaner/page.js`.
- Architectural context: `docs/architecture/SCALING_ROADMAP.md` § "Competitive context" mentions TSD as incumbent.
- Companion scoping doc: `docs/operations/performance-prep-2026-04-28.md`.
- Magic-link / customer-portal token pattern (reusable for C-2): `backend/src/modules/rental-agreements/addendum-signature-public.{service,routes}.js` (shipped in v0.9.0-beta.8).
- Bug backlog: `doc/known-bugs-2026-04-23.md`.
