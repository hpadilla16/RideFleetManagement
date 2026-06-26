# Loaner Program — flow analysis & redesign plan (2026-06-26)

Status: **DRAFT for review.** Goal (Hector): make the loaner flow as simple as the reservation module, fix the post-intake redirect, and make sure customer-initiated extension / scheduled-return requests actually reach the advisor. Based on a full codebase trace + research on how dealership service-loaner systems work.

---

## 1. How the loaner flow works today

- **Admin intake** — `/loaner` → "＋ New Check-Out" toggles an inline 30+-field panel (`page.js`). On submit it `POST /api/dealership-loaner/intake` → creates a `Reservation` (`workflowMode:DEALERSHIP_LOANER`, `status:CONFIRMED`).
- **Post-intake (the complaint)** — on success the UI immediately `router.push('/loaner/checkout/{id}')` (`page.js:543-546`), dropping the advisor into the **6-step checkout wizard** instead of a reservation/detail view.
- **Checkout** — `/loaner/checkout/{id}` 6 steps (license → vehicle → photos → fuel/odometer → billing → signature). Sign → `Reservation CHECKED_OUT` + `LoanerAgreement ACTIVE`.
- **Check-in** — `/loaner/checkin/{id}` 3 steps → `Reservation CHECKED_IN` + `LoanerAgreement RETURNED` → optional `CLOSED`.
- **Self-service** — public `reserve()` assigns a vehicle + creates a `DRAFT` agreement + signature, but stays `CONFIRMED`; the advisor still runs the full 6-step checkout. The self-service flag (`loanerSelfServiceSubmittedAt`) is **not surfaced** in the queue.
- **Extension / scheduled return** — the customer portal writes `requestedReturnAt` / `returnScheduledAt` to the agreement and tells the customer "the service team will confirm by text."

## 2. The three concrete problems

1. **Post-intake redirect is wrong (confirmed root cause).** `page.js:543-546` pushes straight into the checkout wizard. This collapses *create* and *check-out* into one forced flow — even when the customer isn't present or no vehicle is assigned yet. (It was added 2026-06-06 to stop duplicate-submit, but overshot.) Reservations don't do this: `reservations/new` → `router.push('/reservations/{id}')` (the **detail hub**), and check-out is a separate, explicit action.

2. **Extension / scheduled-return requests notify nobody (confirmed).** `requestExtensionByToken()` and `scheduleReturnByToken()` do a bare `prisma.loanerAgreement.update()` — **no email, SMS, in-app alert, dashboard badge, or scheduler sweep.** The customer is told "we'll confirm by text," but **no code sends that text.** The advisor only finds out by manually opening the record. This is a real hole.

3. **The loaner flow is heavier than reservations.** No detail "hub" page; intake is a giant inline panel vs a clean wizard+summary; four overlapping state dimensions (`Reservation.status` × `LoanerAgreement.status` × `loanerBillingStatus` × packet flags); self-service reservations look identical to advisor-created ones in the queue.

## 3. What the rest of the industry does (research takeaways)

- **Reservation and check-out are always two separate steps** — every platform (Dealerware, Kimoby, RentCentric, etc.). Only the *physical* fields (odometer, fuel, photos, keys) are captured at check-out; everything else is pre-filled. Nobody collapses create→checkout the way we currently do.
- **Pre-arrival digital package** (license + insurance + e-signature via SMS link at booking) is the modern simplifier — check-out becomes "confirm + odometer/fuel/photos/keys." Dealerware targets a ~60-second counter flow.
- **Required condition photos** (we already gate 4) — good; industry says optional photos get skipped 60–70%.
- **Advisor alerts are table stakes**: RO-complete → "loaner still out," overdue escalation, returned. We have outbound customer reminders only.
- **Customer-initiated extension/return is rare** — if we wire the advisor notification, our self-service is *ahead* of the documented field. We're 90% there; we just never told the advisor.

## 4. Redesign plan (phased)

### Phase A — Quick wins (low risk, high impact)
A1. **Fix the post-intake redirect.** After intake, land on a confirmation/hub with an explicit **"Check out now"** button instead of force-pushing the wizard. Two options (decision D1): (a) a new loaner **detail/hub page** `/loaner/{id}` mirroring the reservation detail; (b) interim: return to `/loaner` with a success card + a "Check out" CTA on that reservation. Recommend (a) long-term, (b) as the immediate fix.
A2. **Notify the advisor of extension / scheduled-return requests.** When the portal writes `requestedReturnAt`/`returnScheduledAt`: (i) surface them in a dashboard **"Customer Requests" alert queue** (like the Returns/Alerts boards), (ii) send the advisor a notification (in-app + optional SMS/email), and (iii) actually send the customer the promised confirmation text. Make the "we'll confirm" message true.
A3. **Flag self-service reservations in the queue** — show a "Web self-serve" badge (using `loanerSelfServiceSubmittedAt`) + "signature on file (DRAFT)" so the advisor knows checkout is partially done.

### Phase B — Flow simplification (match reservations)
B1. **Loaner detail = the hub.** A `/loaner/{id}` page (or reuse the reservation detail with loaner-aware sections) where the advisor reviews, edits, then triggers Check-out / Check-in / Extend / Bill — exactly like the reservation detail. Decouple intake from checkout.
B2. **Clarify the status model** for the advisor: present ONE customer-facing stage (Reserved → Out → Returned → Closed) derived from the underlying states, instead of exposing all four dimensions.
B3. **Consistent checkout entry** — make every "check out" link go to the loaner wizard (today the reservation detail's checkout link points at the rental `/agreements` flow, a different path).

### Phase C — Best-practice enhancements (optional, later)
C1. Pre-arrival digital package (license/insurance/e-sign via SMS at intake) → faster counter check-out.
C2. RO-complete → "loaner still out" advisor alert (ties loaner to the service record).
C3. Overdue escalation cadence (we have due-soon/overdue customer SMS; add advisor escalation).

## 5. Decisions to confirm
- **D1:** Quick redirect fix — interim (return to dashboard + CTA) now, plus build the `/loaner/{id}` hub (Phase B)? Or jump straight to the hub page?
- **D2:** Extension/return notification channel — in-app dashboard queue only, or also SMS/email to the advisor? And should the customer get an automatic confirmation text now?
- **D3:** Scope for this round — Phase A only (quick wins), or A+B (the real "make it like reservations" redesign)?

## 5b. Decisions — LOCKED 2026-06-26
- **Scope:** Phase A + B (full "make it like reservations" redesign).
- **Notifications:** dashboard Customer Requests queue + advisor SMS/email + automatic customer confirmation text.
- **Redirect:** build the real `/loaner/{id}` detail hub; intake lands there (not the checkout wizard).

## 5c. NEW requirement (2026-06-26): unify loaner checkout/check-in with the reservation flow
Hector: loaners must use the SAME checkout/check-in as reservations — the multi-step **checkout-session** with **QR handoff** and the **Settings toggle to push the inspection to the customer** — not a separate loaner wizard.

**Findings (from a full trace of the reservation checkout-session):**
- The reservation flow is a server-side state machine (`CheckoutSession`: CONFIRMING → TC_SIGNED → PAID → INSPECTION_HANDOFF → … → CLOSED) with QR tokens for terms-signing and mobile inspection.
- The **customer-pushed inspection already exists** and is gated by an existing tenant setting **`customerInspectionConfig` { enabled, checkinModel }** (`GET/PUT /api/settings/customer-inspection`). Step 4 mints a QR or emails the customer an `/inspect/:token` link.
- **`HandoffToken` and `CustomerInspection` are reservation-scoped (not RentalAgreement-scoped)** → the QR + customer-inspection path works for a loaner reservation with **no model changes**.
- The loaner today uses a totally separate 6-step checkout + 3-step check-in (local React state, `LoanerAgreement`, `LoanerPhoto`/`LoanerDamagePoint`) — this is what we replace.

**Coupling points to converge (branch on `reservation.workflowMode === 'DEALERSHIP_LOANER'`):**
1. `checkout-session.ensureAgreementExists` always creates a `RentalAgreement` → for loaners, create a **loaner-flavored agreement** (recommended: a companion/“lite” RentalAgreement with $0 charges + loaner T&C; `LoanerAgreement` stays as the 1:1 companion for portalToken/license images/billing mode).
2. **Payment step (Spin)** → bypass for loaner billing modes (COURTESY/WARRANTY/INSURANCE/INTERNAL auto-advance; only CUSTOMER_PAY upgrade differential, no gateway), show a billing-mode confirm screen.
3. **CLOSED finalize cascade** writes RentalAgreement-specific columns → add a loaner-aware finalize branch.
4. Frontend wizard: hide declined-insurance (step 1) + Spin payment (step 3) for loaners; everything else (QR, inspection, signature) reused as-is.

## 6. Recommendation
Do **Phase A now** (small, high-value: fixes the redirect, closes the notification hole, flags self-serve), then **Phase B** as the structured "make it feel like reservations" redesign. Phase C is a roadmap item. Each phase shipped + verified the same way as the recent loaner work (sandbox Postgres tests → ship → deploy).
