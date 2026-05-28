# Dejavoo Spin Checkout Redesign — Architecture & Execution Plan

**Date:** 2026-05-28
**Author:** Working notes for International Rental Corp Phase 1
**Status:** Draft — ready for review

---

## 1. Goals

1. Replace the current single-screen checkout wizard with a **six-step orchestrated flow** that runs across three surfaces simultaneously: agent screen, customer view (counter tablet), and agent's mobile (during inspection).
2. Drop the AutoRental Dejavoo feature pack. Use only the **Spin REST API** for charges, security-deposit pre-auth, and card-on-file enrollment.
3. Persist initials and signatures captured during the interactive T&C signing so they appear on the final agreement PDF and stay queryable in the database.
4. Add three cross-cutting helpers: change-vehicle mid-flow, declined-insurance flow, and "last odometer wins" persistence on Vehicle.

## 2. The Six Steps

| Step | Surface | Agent does | Customer does |
|---|---|---|---|
| 1. Confirm | Agent screen + customer view | Verifies customer info, vehicle assignment, declined-insurance toggle, clicks Start Checkout | Watches summary on tablet |
| 2. Terms & Conditions | Agent: QR + email fallback. Customer: phone | Waits | Scans QR, signs T&C on phone, initials each section, taps Complete |
| 3. Payment | Agent + customer view + Dejavoo terminal | Reviews invoice, presses Charge | Reviews invoice + CNP disclaimers on tablet, taps/inserts/swipes on terminal |
| 4. Inspection handoff | Agent screen: handoff QR. Customer view: "follow me" | Scans QR on phone, walks out with customer | Walks out |
| 5. Vehicle metrics | Agent's mobile | Confirms autopopulated odometer (from last check-in), fuel level, cleanliness, captures photos, annotates damage | — |
| 6. Customer sign + finalize | Agent's mobile (handed to customer) | Hands phone over; on Finish, agreement PDF is built and emailed | Reviews inspection summary, signs |

## 3. State machine

The wizard is no longer a linear React component. It's a **persisted state machine** stored in a new `CheckoutSession` row tied 1:1 to the reservation. Each step transition is an explicit backend mutation that:

- Updates `CheckoutSession.currentStep`
- Persists any data captured in that step
- Optionally broadcasts to listeners (customer view, mobile)

States:

```
NEW → CONFIRMING → TC_PENDING → TC_SIGNED →
PAYMENT_PENDING → PAID → INSPECTION_HANDOFF →
INSPECTION_IN_PROGRESS → CUSTOMER_SIGN_PENDING →
FINALIZING → CLOSED
```

Each state has exactly one valid transition out (with rollback exceptions). A `CheckoutSession.events[]` JSON column logs every transition with `{ from, to, actorUserId, at, metadata }` for audit.

## 4. Cross-device coordination

Three coordination needs, three different mechanisms:

### 4a. Agent screen ↔ customer view (same building, separate tabs/devices)

The current `customer-view/page.js` polls every 8s. **Keep polling** but add `?session=<id>` so it polls the CheckoutSession (not the reservation). 1.5s poll interval during active steps. This is fine — no infrastructure change needed.

Optional upgrade later: SSE endpoint pushing state changes.

### 4b. Customer phone (T&C signing) ↔ backend

When the agent enters step 2, backend mints a short-lived `TermsSigningToken` (15 min TTL, 24 random bytes, scoped to reservationId). QR encodes `https://app.ridefleetmanager.com/sign/<token>`. Customer's phone opens an authenticated session via the token alone (no login). When they tap Complete, we:

1. Persist each section's initial as `AgreementSectionInitial { agreementId, sectionKey, initialDataUrl, signedAt, customerIp }`
2. Persist the final signature as `agreement.tcSignatureDataUrl`
3. Mark `CheckoutSession.tcCompletedAt = now`
4. The agent screen's poll picks this up on the next 1.5s tick and advances to step 3

### 4c. Agent's main screen → agent's mobile (inspection handoff)

Same `TermsSigningToken` pattern but a different scope — `CheckoutHandoffToken`. QR encodes `https://app.ridefleetmanager.com/checkout/mobile/<token>`. The agent's phone opens the inspection wizard with the same `CheckoutSession.id` mapped to the token. When agent submits step 6 on mobile, the desktop session listening for state transitions advances to FINALIZING and the agent's main screen shows the success state.

Tokens are single-use (we delete on consume). If the device dies mid-inspection, the agent reissues from the main screen.

## 5. Spin API integration

The existing `backend/src/modules/payment-gateway/spin-client.js` covers `sale`, `auth`, `capture`, `void`, `refund`. Missing pieces:

### 5a. Methods to add

| Method | Spin endpoint | Used in |
|---|---|---|
| `chargeWithCardCapture` | `/sale` + capture flags for tokenization | Step 3 charge |
| `preAuthDeposit` | `/auth` with `holdOnly=true` | Step 3 deposit pre-auth |
| `tokenizeCard` | usually returned in the `/sale` response | Step 3 (parallel) |
| `chargeWithToken` | `/sale` with stored token, `cardNotPresent=true` | Future autocharges (already partially wired in checkin-close) |

### 5b. Flow in step 3

```
Customer dips card on terminal
  ↓
chargeWithCardCapture(amount: 317.78, captureToken: true)
  ↓ returns { authCode, last4, token, brand }
preAuthDeposit(amount: 500.00, token: from above)
  ↓ returns { holdId, expiresAt }
persistPayment + persistDepositHold + persistCardOnFile
  ↓
CheckoutSession → PAID
```

Failures roll back: if pre-auth fails after the sale captured, void the sale and reset to PAYMENT_PENDING with a retry banner.

### 5c. Configuration

Reuse the existing tenant.spin* fields. Add `tenant.spinDepositPreauthEnabled` boolean (default false) so the deposit pre-auth can be staged behind a flag during rollout.

## 6. Schema changes

### 6a. New tables

```prisma
model CheckoutSession {
  id              String   @id @default(cuid())
  reservationId   String   @unique
  reservation     Reservation @relation(fields: [reservationId], references: [id])
  agreementId    String?
  agreement      RentalAgreement? @relation(fields: [agreementId], references: [id])
  currentStep    CheckoutStep  @default(CONFIRMING)
  events         String   @db.Text   // JSON array of { from, to, actor, at, metadata }
  tcCompletedAt  DateTime?
  paymentCompletedAt DateTime?
  inspectionCompletedAt DateTime?
  customerSignedAt DateTime?
  startedAt      DateTime @default(now())
  finishedAt     DateTime?
  abandonedAt    DateTime?  // if agent closes without finishing
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@index([reservationId])
  @@index([currentStep])
}

enum CheckoutStep {
  CONFIRMING
  TC_PENDING
  TC_SIGNED
  PAYMENT_PENDING
  PAID
  INSPECTION_HANDOFF
  INSPECTION_IN_PROGRESS
  CUSTOMER_SIGN_PENDING
  FINALIZING
  CLOSED
}

model AgreementSectionInitial {
  id           String   @id @default(cuid())
  agreementId  String
  agreement    RentalAgreement @relation(fields: [agreementId], references: [id])
  sectionKey   String   // 'rental_period', 'insurance', 'liability', etc.
  sectionLabel String
  initialDataUrl String @db.Text
  signedAt     DateTime
  customerIp   String?
  @@unique([agreementId, sectionKey])
}

model HandoffToken {
  id            String   @id @default(cuid())
  reservationId String
  reservation   Reservation @relation(fields: [reservationId], references: [id])
  kind          HandoffTokenKind  // TERMS_SIGNING | MOBILE_INSPECTION
  token         String   @unique
  expiresAt     DateTime
  consumedAt    DateTime?
  createdByUserId String?
  createdAt     DateTime @default(now())
  @@index([token, expiresAt])
}

enum HandoffTokenKind {
  TERMS_SIGNING
  MOBILE_INSPECTION
}

model VehicleInspectionAnnotation {
  id           String   @id @default(cuid())
  inspectionId String
  inspection   RentalAgreementInspection @relation(fields: [inspectionId], references: [id])
  photoUrl     String   // which photo this annotation pins to
  x            Float    // normalized 0-1
  y            Float
  note         String   @db.Text
  createdAt    DateTime @default(now())
}
```

### 6b. Additions to existing tables

- `RentalAgreement.tcSignatureDataUrl` (TEXT, nullable) — final T&C signature
- `RentalAgreement.tcSignedAt` (DateTime, nullable)
- `RentalAgreement.declinedInsurance` (Boolean, default false)
- `RentalAgreement.declinedInsuranceSignatureDataUrl` (TEXT, nullable)
- `RentalAgreement.depositHoldId` (String, nullable) — Spin pre-auth hold id
- `RentalAgreement.depositHoldExpiresAt` (DateTime, nullable)
- `RentalAgreement.cardOnFileToken` (String, nullable) — Spin tokenized card
- `RentalAgreement.cardOnFileBrand` (String, nullable)
- `RentalAgreement.cardOnFileLast4` (String, nullable)
- `Vehicle.lastOdometerSource` (String, nullable) — `CHECKIN_RES-12345` or `CHECKOUT_RES-67890`, for traceability

### 6c. Migration sequence

1. Add new tables (no FK constraints flipped yet)
2. Add new columns to existing tables (all nullable / default false)
3. Backfill is not needed — existing agreements stay as-is

## 7. New backend endpoints

| Method + path | Purpose |
|---|---|
| `POST /api/checkout-sessions` | Start a session for a reservation |
| `GET /api/checkout-sessions/:id` | Read state (used by customer-view + main screen polls) |
| `POST /api/checkout-sessions/:id/transition` | Advance state. Body: `{ to, payload }`. Validates legal transitions. |
| `POST /api/checkout-sessions/:id/terms-token` | Mint TermsSigning QR token |
| `POST /api/checkout-sessions/:id/handoff-token` | Mint MobileInspection QR token |
| `POST /api/checkout-sessions/:id/vehicle` | Change vehicle mid-flow (locks both old + new in a transaction) |
| `POST /api/checkout-sessions/:id/charge` | Trigger Spin sale + preAuth + tokenize (server orchestrates, terminal polls) |
| `GET  /api/checkout-sessions/:id/terminal-status` | Poll Spin terminal status during charge |
| `POST /api/sign/:token/initials` | Public endpoint (no auth, token-scoped) for customer T&C section initials |
| `POST /api/sign/:token/complete` | Public endpoint, customer finalizes T&C |
| `POST /api/checkout/mobile/:token/inspection` | Public endpoint, agent's mobile submits photos/metrics |
| `POST /api/checkout/mobile/:token/customer-sign` | Public endpoint, customer signs inspection on mobile |
| `POST /api/checkout-sessions/:id/finalize` | Build PDF, email, mark CLOSED |

## 8. Frontend changes

### 8a. New routes

- `/reservations/[id]/checkout-wizard/page.js` — full rewrite. State machine UI mirroring the backend session. 6-step view. Polls session every 1.5s during waiting states.
- `/sign/[token]/page.js` — customer-facing T&C signing on their phone. Walks through each T&C section with an initial pad and a final signature pad.
- `/checkout/mobile/[token]/page.js` — agent's mobile inspection page. Camera-first UI for capturing photos, an annotation overlay, the odometer/fuel/cleanliness form, and the customer signature pad.
- `/customer-view/[reservationId]/page.js` — already exists. Add the per-step rendering shown in the mockup. The customer view subscribes to the CheckoutSession via the existing 8s poll (drop to 1.5s during active flow).

### 8b. Shared components

- `<CustomerViewHero>` — step tracker + title
- `<TermsSigningPad>` — used on both `/sign/:token` (multi-section walker) and the PDF generator (passive rendering of saved initials)
- `<MobileInspectionCamera>` — reuses the existing inspection-photos.js capture flow
- `<TerminalChargeProgress>` — polls Spin terminal status during step 3

## 9. Cross-cutting helpers

### 9a. Change vehicle mid-flow

Top-right of the wizard at every step (steps 1–5): a "Change vehicle" button. Modal lists vehicles by type with availability filter (excludes any vehicle with an overlapping active reservation). On confirm:

```js
POST /api/checkout-sessions/:id/vehicle
{ newVehicleId: "veh_abc" }
```

Backend transaction:
1. Verify the new vehicle is available for the reservation's pickup/return window
2. Update `Reservation.vehicleId` AND `RentalAgreement.vehicleId` (the drift bug from earlier today's late-fee work)
3. Update `VehicleAvailabilityBlock` rows if any were holding the old vehicle for this reservation
4. Append CheckoutSession event `{ kind: 'VEHICLE_SWAP', from, to }`
5. If pre-checkout photos were taken on the old vehicle, prompt agent to retake

Blocked if `CheckoutSession.currentStep >= INSPECTION_IN_PROGRESS` (photos already locked to a specific car). At that point the agent must finalize the current session as cancelled and start a new one.

### 9b. Declined insurance

Mirror the pre-check-in `declinedInsurance` toggle in step 1. If declined:

1. Set `RentalAgreement.declinedInsurance = true`
2. Add a "Declined insurance acknowledgement" T&C section (only appears on the customer's signing flow when `declined === true`)
3. Capture customer initial on that section into `AgreementSectionInitial`
4. PDF generator emits the decline-insurance addendum page

### 9c. Last odometer wins on Vehicle

After step 6 (CLOSED), the backend's finalize step:

```js
await prisma.vehicle.update({
  where: { id: vehicleId },
  data: {
    mileage: odometerOut,                       // value from step 5
    lastOdometerSource: `CHECKOUT_${reservationNumber}`,
  }
});
```

Symmetric update in check-in close (already partially there) — make sure both flows write through.

## 10. PDF generation

Current Puppeteer template gets new sections appended after the existing first page:

1. **Page 1 (unchanged):** rental agreement summary
2. **Section A — Terms & Conditions:** rendered HTML of the T&C with each section's initial image embedded inline next to its heading, plus the final signature at the bottom
3. **Section B — Declined insurance addendum** (only if `declinedInsurance`): standard CNP / no-coverage acknowledgement with the customer's initial
4. **Section C — Checkout inspection:** grid of photos with annotation pins, metrics table (odometer, fuel, cleanliness), customer signature at bottom, agent name and timestamp
5. **Section D — Receipts:** Spin sale receipt + deposit pre-auth confirmation

Template lives in `backend/src/templates/rental-agreement.html`. New partials: `_terms-and-conditions.html`, `_inspection.html`, `_receipts.html`.

Email body links to this PDF as attachment plus a hosted version at `/agreements/:id/view` (authenticated).

## 11. Phased rollout

### Phase 1 — Scaffolding (1 sprint)

- CheckoutSession model + base CRUD
- New checkout wizard route shell (no Spin yet) — steps 1, 2 (T&C UI but no real signing), 6 (finalize stub)
- HandoffToken + public `/sign/:token` and `/checkout/mobile/:token` skeleton pages
- Vehicle change endpoint + UI
- Customer view re-wired to subscribe to CheckoutSession

**Acceptance:** Agent can drive through all 6 steps end-to-end with mock data, customer view updates in real time, no Spin/PDF yet.

### Phase 2 — Spin integration (1 sprint)

- Spin client extensions (preAuth, tokenize, charge-with-token already there)
- Step 3 wired to real Spin terminal
- Card-on-file persistence
- Failure handling and retry UX

**Acceptance:** Live tap-to-pay → charge captured → deposit pre-auth → card saved, all reflected in DB.

### Phase 3 — Signatures + PDF (1 sprint)

- `<TermsSigningPad>` multi-section walker on customer phone
- `AgreementSectionInitial` persistence
- PDF generator extended with the three new sections
- Email delivery of finalized agreement

**Acceptance:** Customer signs on phone, finalized PDF includes initials + signature; email arrives within 60s of step 6.

### Phase 4 — Mobile inspection (1 sprint)

- Mobile camera capture
- Photo annotation
- Customer signature on mobile
- Smooth handoff back to desktop

**Acceptance:** Full real-customer dry-run with two agents at the lot, no manual data entry.

### Phase 5 — Polish + rollout (1 sprint)

- Edge cases: timeouts, agent abandonment, partial failures
- Production deploy behind `tenant.dejavoouSpinCheckoutEnabled` flag
- Train counter staff (5-min video)

## 12. Files touched (rough estimate)

**New files**

- `backend/src/modules/checkout-session/checkout-session.service.js`
- `backend/src/modules/checkout-session/checkout-session.routes.js`
- `backend/src/modules/checkout-session/state-machine.js`
- `backend/src/modules/checkout-session/handoff-tokens.service.js`
- `backend/src/modules/payment-gateway/spin-preauth.js`
- `backend/src/modules/payment-gateway/spin-tokenize.js`
- `backend/src/templates/rental-agreement-full.html` (replaces current)
- `backend/src/templates/_terms-and-conditions.html`
- `backend/src/templates/_inspection.html`
- `backend/src/templates/_receipts.html`
- `frontend/src/app/sign/[token]/page.js`
- `frontend/src/app/checkout/mobile/[token]/page.js`
- `frontend/src/components/checkout/CustomerViewHero.jsx`
- `frontend/src/components/checkout/TermsSigningPad.jsx`
- `frontend/src/components/checkout/MobileInspectionCamera.jsx`
- `frontend/src/components/checkout/TerminalChargeProgress.jsx`

**Rewritten**

- `frontend/src/app/reservations/[id]/checkout-wizard/page.js` (full rewrite — current 6-step flow is replaced by the new state-machine-driven UI)
- `frontend/src/app/reservations/[id]/customer-view/page.js` (subscribe to CheckoutSession, render per-step screens)

**Extended**

- `backend/src/modules/payment-gateway/spin-client.js` (add preAuth, tokenize, charge-with-token)
- `backend/src/modules/rental-agreements/checkin-close.service.js` (write Vehicle.mileage)
- `backend/prisma/schema.prisma` (new models + columns from §6)
- `backend/src/modules/agreements/agreement-pdf.service.js` (template extensions)

## 13. Resolved decisions (2026-05-28)

1. **Customer view device.** Counter station has a permanent second display per workstation. The existing "Show on Customer Display" button on each reservation already opens the customer view on that secondary screen. We don't need QR for the customer view itself — we just extend the existing component to render per-step content driven by `CheckoutSession.currentStep`. T&C signing in step 2 still uses a separate QR because that goes to the customer's own phone (so they can initial/sign).

2. **Spin environment.** Production terminal — no sandbox available. Implications: (a) Phase 2 development must happen in a staging tenant against a real terminal, ideally outside business hours. (b) Every Spin call gets aggressive logging from day one. (c) `tenant.spinDryRun` flag for development that no-ops Spin calls and returns synthetic success responses.

3. **Card-on-file.** Yes — store brand + last4 + token. The POS captures the token during step 3 so later charges (overage tolls, damage, fuel) can run card-not-present via Spin's stored-token flow. We already have a partial implementation; this fix extends it.

4. **Email failure handling.** Do NOT block finalize on email failure. The finalize commits regardless, surfaces an "Email failed — agreement was still saved" toast with an OK button, and the reservation page exposes two buttons (next to the existing Print): **Email agreement** and **Resend signed copy**. The reservation page already has Print; we mirror that pattern.

5. **Wizard abandonment.** Sessions that don't reach CLOSED get flagged. The CheckoutSession model already has `abandonedAt`; we surface the flag in two places: (a) a new **Stuck checkouts** KPI tile on the dashboard, click-through to the list; (b) per-row badge in the reservations table. A nightly job runs at 03:00 local to auto-void any preAuth older than 24h on abandoned sessions and to flip `abandonedAt` for sessions stuck in PAYMENT_PENDING+ for more than 4 hours.

## 14. Phase 1 commit plan

Now that the decisions are locked, Phase 1 (1 sprint) breaks down into commits:

| # | Commit | Files | LOC est. |
|---|---|---|---|
| 1 | `feat(schema): CheckoutSession + HandoffToken models` | schema.prisma migration | ~80 |
| 2 | `feat(checkout-session): service + routes` | new module | ~350 |
| 3 | `feat(checkout-wizard): rewrite with state-machine UI` | wizard page rewrite | ~600 |
| 4 | `feat(customer-view): per-step rendering driven by session` | customer view extension | ~250 |
| 5 | `feat(checkout): change-vehicle mid-flow endpoint + modal` | new endpoint + modal | ~200 |
| 6 | `feat(checkout): declined-insurance section` | toggle + audit row | ~80 |
| 7 | `feat(vehicle): persist last odometer on checkin AND checkout` | extend checkin-close + new checkout-close | ~50 |
| 8 | `feat(dashboard): Stuck checkouts tile` | reports.service.js + page.js | ~120 |

Phase 1 is feature-complete when an agent can drive the wizard from start to finish using mock data for Spin and T&C, the customer view updates in real time on the second display, and stuck sessions show up on the dashboard.

---

**Next action:** I scaffold Phase 1 starting with commit #1 (schema migration). After your green-light, I'll write the migration, generate the Prisma client, and check the diff into the repo. Phase 1 in total is ~1700 LOC across 8 commits — manageable as a single sprint.
