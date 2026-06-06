# Long-Term / Monthly Reservations — Competitive Analysis + Module Plan
2026-06-03 · drafted while loaner reimagine (beta.112) deploys

## 1 · How the competition does it

| | Enterprise (Subscribe / Month-or-More) | Sixt+ / Sixt long-term | Hertz monthly | PR locals (Charlie, Global, etc.) |
|---|---|---|---|---|
| Term | 30+ days, auto-renews monthly | 30-day minimum subscription; classic long-term billed in **28-day cycles** | Multi-month | Month blocks; "billed each month, no contract renewal" |
| Price shape | One flat auto-renewing payment, incl. insurance + maintenance + roadside | ~15 tiers by class ($459 subcompact → $979 large SUV) + $199 enrollment | Negotiated monthly | Discounted monthly rates by class |
| Mileage | 3,000 mi/mo, unused miles roll over, $0.40/mi overage reconciled yearly | 1,000 or 2,000 mi/mo packages, rollover | 2,000 mi/mo, $0.35/mi overage | Usually unlimited or per-agreement |
| Payment | Auto-charge card on file each cycle | Card on file; deposit authorized by vehicle category | Card on file | Card/cash at counter monthly |
| Swaps | Up to 4 vehicle swaps/month | Allowed | — | Informal |
| Deposit | — | By vehicle category | Standard | CDW required (PR law holds renter liable); $16.95–$19.95/day CDW typical |

**Industry mechanics worth copying**
- The **28-day cycle** is the rental classic (13 cycles/yr, no calendar drift); subscriptions trend to true-month. Either way the invariant is: *a recurring billing period with a rate, a mileage allowance, and an auto-charge.*
- **Mileage caps + overage at cycle close** (and optional rollover) are universal — they protect fleet value.
- **Auto-renew on card-on-file** is the engine of the whole product.
- **Swap entitlements** keep long-term vehicles serviceable (maintenance rotation).
- **Deposit by vehicle category**, re-authorized periodically (card holds expire in 7–30 days — a monthly product MUST re-auth or convert the hold).

## 2 · What Ride Fleet already has (build on, don't rebuild)

| Capability | Where | Monthly-module use |
|---|---|---|
| Card-on-file + CNP charges (credit working; debit pending Dejavoo) | iposTransactClient.chargeWithToken, beta.103–110 | **The recurring billing rail** |
| Autocharge worker + tenant AUTO/MANUAL + delay config | autocharge.worker.js, beta.65 | Pattern + infra for the cycle-close sweep |
| Extensions | reservation-extend.service.js | Auto-extend returnAt each renewed cycle |
| Vehicle swap (updates agreement too) | reservations.service swapVehicle | Swap entitlements |
| Ledger discipline (paid = payments, balance = non-deposit charges − paid) | beta.109/110 recompute | Cycle invoices are just new charges; balance math holds |
| Per-location deposit config | Settings → Locations | Monthly deposit defaults |
| Odometer at checkout/check-in + telematics (Zubie) | metrics steps, telematicsDevices | Mileage cap measurement mid-rental |
| Agreement addendums | rental-agreements addendums | Cycle renewals as addendum records on the PDF |
| Rate engine | Rate / RateItem / RateDailyPrice | **Daily-only today** — monthly tier must be added (only AdditionalService has monthlyRate) |

## 3 · Proposed design

### 3.1 Data model (additive)
```prisma
enum BillingCycleStatus { DUE PAID FAILED WAIVED }

model LongTermPlan {            // one per long-term reservation
  id                  String   @id @default(cuid())
  tenantId            String?
  reservationId       String   @unique
  cycleLengthDays     Int      @default(30)        // 28 or 30 — tenant setting
  cycleRate           Decimal  @db.Decimal(10, 2)  // flat per-cycle price
  includedMilesPerCycle Int?                       // null = unlimited
  overagePerMile      Decimal? @db.Decimal(10, 2)
  milesRollOver       Boolean  @default(false)
  autoRenew           Boolean  @default(true)
  swapsPerCycle       Int      @default(1)
  nextCycleStartsAt   DateTime
  status              String   @default("ACTIVE")  // ACTIVE | PAUSED | ENDED
}

model BillingCycle {            // one row per period — the recurring invoice
  id              String   @id @default(cuid())
  longTermPlanId  String
  periodStart     DateTime
  periodEnd       DateTime
  amount          Decimal  @db.Decimal(10, 2)      // cycleRate + overage + extras
  milesStart      Int?
  milesEnd        Int?
  overageMiles    Int      @default(0)
  status          BillingCycleStatus @default(DUE)
  chargeId        String?  // RentalAgreementCharge created for this cycle
  paymentId       String?  // RentalAgreementPayment when collected
  attempts        Int      @default(0)
  lastError       String?
}
```
New charge `source: 'MONTHLY_CYCLE'` (non-deposit → flows through existing balance math untouched).

### 3.2 Flows
1. **Booking** — reservation create gains a "Monthly" rate option (per vehicle type: cycle rate, included miles, overage). Checkout is UNCHANGED: same wizard, first cycle = the sale, deposit = the hold.
2. **Cycle-close worker** (sibling of autocharge worker, daily sweep):
   - For plans with `nextCycleStartsAt <= now`: snapshot odometer (telematics if present, else last known), compute overage, create the `MONTHLY_CYCLE` charge + `BillingCycle` row, extend `returnAt` by one cycle (reuse extension service), then charge card-on-file (AUTO) or queue for the counter (MANUAL) — exactly the tenant autocharge config semantics.
   - Failures: retry ladder (e.g., +24h ×3) → flag reservation `PAYMENT_OVERDUE`, notify staff (reuse autocharge failure notifier). Never silently repossess.
3. **Deposit refresh** — monthly re-auth on the saved card when the prior hold nears expiry (CNP PreAuth — same call as the checkout hold). Until Dejavoo fixes debit CNP: debit customers get counter re-auth or a charged-refundable deposit (tenant choice).
4. **Early return** — prorate the open cycle: configurable policy (no refund / daily-rate proration / pro-rata). Check-in flow unchanged otherwise.
5. **Swaps** — existing swapVehicle + entitlement counter on the plan; addendum on the agreement.
6. **Renewal comms** — SMS/email N days before each cycle (reuse loaner reminders scheduler pattern), receipt after each successful cycle charge.

### 3.3 Reports & ops
- Monthly Recurring Revenue + active-plans report (reports-v2 slug `long-term-plans`).
- Availability forecast: long-term reservations already occupy capacity day-by-day — works as-is; add a "long-term" badge in the grid drill-down.
- Dashboard tile: cycles due today / failed charges (Command Center candidate).

### 3.4 Phasing
- **P1 (1–2 days):** schema + monthly rate option + manual cycle billing button in View Payments (staff-triggered cycle close). No worker. Low risk, ships value immediately.
- **P2 (2–3 days):** cycle-close worker + auto-charge + retry/dunning + configurable email templates + **overdue pay-link** (token-scoped /pay/{token} page → iPOSpays Hosted Payment Page with requestCardToken=true → records payment, marks cycle PAID, REPLACES the card on file with the newly entered card, auto-clears overdue + stops emails; ask Dejavoo to confirm HPP is enabled on the TPN) + charged-deposit handling.
- **P3 (later):** customer portal integration, telematics mileage automation, rollover miles, swap entitlements UI, MRR reports, booking-engine monthly plans.

## 4 · Decisions needed from Hector
1. **Cycle length:** 28-day (industry classic, 13/yr) vs 30-day (customer-intuitive). Recommend: tenant setting, default 30.
2. **Mileage policy default:** cap (e.g. 2,000–3,000 mi/cycle) + overage $/mi, or unlimited like PR locals? Recommend: configurable per rate, default 3,000 @ $0.25.
3. **Deposit strategy for monthly:** rolling re-auth vs one-time charged refundable deposit. (Debit CNP gap makes charged-deposit attractive until Dejavoo fixes it.)
4. **Early-return proration policy.**
5. **Dunning:** how many days grace after a failed cycle charge before the reservation flags overdue and staff intervene?
