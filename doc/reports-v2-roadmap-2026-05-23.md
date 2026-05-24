# Reports v2 — module roadmap

**Date:** 2026-05-23 (updated end-of-day)
**Status of /reports-v2 today:** **16 of 18 reports AVAILABLE**, 2 deferred on schema work.

This doc captures (a) the architecture as built across Rounds 24–31 and (b) what's left.

---

## Architecture recap (don't change unless you have a reason)

Every report is a single file under `backend/src/modules/reports/<slug>.report.js` that calls `registerReport({...})`. Each registered report automatically gets three sub-routes under `/api/reports/<slug>`:

| Route               | Purpose                                           | Hook            |
| ------------------- | ------------------------------------------------- | --------------- |
| `GET /<slug>`       | JSON data payload                                 | `computeData`   |
| `GET /<slug>/pdf`   | Server-rendered PDF download (landscape Letter)   | `renderHtml`    |
| `GET /<slug>/excel` | Server-rendered .xlsx download                    | `buildExcelSpec`|

Reports can also declare optional **`subRoutes`** for drill-downs or slices. Each sub-route mounts at `/api/reports/<slug><path>` (see `availability-forecast.report.js` → `/cell` for the canonical example).

Frontend conventions:

- One Next.js page per report at `frontend/src/app/reports-v2/<slug>/page.js`
- Wrap the body in `ReportPageLayout` (don't reinvent breadcrumb, date picker, PDF/Excel buttons)
- Optional location filter goes in the `extraFilters` slot
- Snapshot-style reports (no date range) pass `hideDateRange` + a `leftSlot` for the "As of …" label
- Charts use Chart.js via `frontend/src/components/reports/charts/chartjs-setup.js`
  - `UtilizationBarChart` — single-series bar (replaced inline SVG)
  - `UtilizationLineChart` — line with LY-overlay toggle
  - `BookingPaceChart` — cumulative lead-time curve
  - `SoldOutIncidenceChart` — monthly bar
  - `StackedDayBarChart` — generic stacked daily bar
  - `CategoryDonutChart` — category mix donut with center-text plugin
- Drill-down drawers compose `ListDrawer` (generic chrome + fetch) with a record-specific card:
  - `cards/ReservationCard.js`
  - `cards/PaymentCard.js`
  - `cards/ChargeCard.js`
  - `cards/VehicleCard.js`
  - `cards/TollTransactionCard.js`
  - `cards/CommissionCard.js`
  - Thin wrappers (`ReservationListDrawer`, `PaymentListDrawer`, `ChargeListDrawer`, `VehicleListDrawer`, `TollTransactionListDrawer`, `CommissionListDrawer`) plug the right card into `ListDrawer`.

Registry lives in `reports-v2.service.js → REPORT_REGISTRY`. Flipping a report to AVAILABLE = change `status: 'AVAILABLE'` **and** import the file in `register-all-reports.js`.

---

## Status snapshot

### AVAILABLE (16)

**Management** (3)
- ✅ `reservations-by-day`     — Round 27, status-stacked daily bar + drill to reservations
- ✅ `payments-by-day`         — Round 27, cash/card/digital/other split + drill to payments
- ✅ `rental-status`           — Round 27, right-now triage (overdue / due today / picking up / unpaid at checkin)

**Fleet** (5)
- ✅ `availability-forecast`   — Round 24d, Hybrid layout (At a glance / Forecast / Trends)
- ✅ `availability`            — Round 29, right-now per-class status snapshot with vehicle drill
- ✅ `fleet-status`            — Round 29, flat sortable vehicle list with status + search filters
- ✅ `utilization`             — Round 29, time-series with auto-bucketed granularity + LY overlay
- ✅ `upcoming-vehicle-sales`  — Round 29, mileage/age threshold candidates with reasons
- ✅ `toll-per-vehicle`        — Round 30, tolls grouped by vehicle + unmatched bucket
- ✅ `toll-per-location`       — Round 30, tolls grouped by plaza + top-3 vehicles per plaza

**Operations** (3)
- ✅ `commission-sales-performance` — Round 24b
- ✅ `agent-track-record`           — Round 24c
- ✅ `commission`                   — Round 31, dollars-out-the-door per employee from AgreementCommission ledger

**Revenue** (3)
- ✅ `sales`                   — Round 28, by line-item with Top-N + Other, separate tax line
- ✅ `unpaid-balance`          — Round 28, AR aging (Current / 1-30 / 31-60 / 61-90 / 90+)
- ✅ `taxes`                   — Round 31, tax collected + taxable base + effective rate

### Deferred · schema work pending (2)

| Slug          | Category | Blocker                                                                 |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `damage`      | Fleet    | Damage findings + repair cost data model not finalized.                  |
| `chargeback`  | Revenue  | No way today to mark a reservation as having a chargeback. Needs a status field (or a separate `Chargeback` table linked to `RentalAgreementPayment`/`Reservation`) before the report has data to read. |

Both stay in `REPORT_REGISTRY` as `COMING_SOON`. The landing-page tile remains dimmed. Wire them up once the schema lands:

1. **`damage`** — once the `DamageFinding` / repair-cost model exists, build a report that groups findings by vehicle and surfaces repair-cost totals + open vs closed findings.
2. **`chargeback`** — once payments can be flagged as chargeback, build a report that lists disputed payments with the customer/vehicle/agreement details and bundles the evidence pack (signed agreement PDF + payment receipt + inspection photos).

---

## Test coverage

`node --test backend/src/modules/reports/*.test.mjs` runs **~200 tests** across 14 files:

| File                                              | Tests |
| ------------------------------------------------- | ----- |
| `reports-v2.service.test.mjs`                     |     8 |
| `availability-forecast.report.test.mjs`           |    14 |
| `reservations-by-day.report.test.mjs`             |    11 |
| `payments-by-day.report.test.mjs`                 |    13 |
| `rental-status.report.test.mjs`                   |    13 |
| `sales.report.test.mjs`                           |    16 |
| `unpaid-balance.report.test.mjs`                  |    14 |
| `availability.report.test.mjs`                    |    11 |
| `fleet-status.report.test.mjs`                    |    10 |
| `utilization.report.test.mjs`                     |    18 |
| `upcoming-vehicle-sales.report.test.mjs`          |    17 |
| `toll-per-vehicle.report.test.mjs`                |    14 |
| `toll-per-location.report.test.mjs`               |    15 |
| `commission.report.test.mjs`                      |    19 |
| `taxes.report.test.mjs`                           |    15 |

The combined run sometimes hits a wall-clock limit (~30+ files of Prisma client init add up). Run halves if needed — every individual file passes cleanly.

---

## Bonus: diagnostic scripts shipped

- `backend/scripts/audit-commissions.mjs` — reports why `AgreementCommission` rows might not be getting created. Walks the same three gates that `syncAgreementCommissionSnapshot()` applies and reports counts + samples for each. Run with `node backend/scripts/audit-commissions.mjs [--tenantId=<id>]`.

---

## Things to fix opportunistically

- The two slug pairs that read awkwardly together on the landing page: `availability` vs `availability-forecast`, `commission` vs `commission-sales-performance`. Consider renaming the simpler ones (`availability` → `availability-now`? `commission` → `commission-payouts`?) on a UX pass.
- The `url` field returned by `listReports` (`/reports-v2/<slug>`) is no longer consumed on the frontend (the landing page builds URLs directly via `router.push`). Delete it once nothing else uses it.
- Caching: `utilization`, `availability-forecast.soldOutByMonth`, and any report that scans 12+ months of reservations should land in Redis with a ~5-minute TTL keyed on `tenantId:slug:from:to:locationId`.
- Extract the `backwardPresets()` helper repeated in `utilization` and the two toll pages into the `DateRangePicker` module as a named preset pack so we stop copy-pasting it.
- Run `audit-commissions.mjs` against production to figure out whether the commission gap Hector noticed is gate-2 (no actor/owner), gate-3 (tenant-user mismatch), or missing rules.

---

## How to add a new report (checklist — unchanged)

1. Create `backend/src/modules/reports/<slug>.report.js`. Export by calling `registerReport({...})`.
2. Add `import './<slug>.report.js';` to `backend/src/modules/reports/register-all-reports.js`.
3. Flip the registry entry in `reports-v2.service.js` to `status: 'AVAILABLE'`.
4. Create `frontend/src/app/reports-v2/<slug>/page.js`. Wrap body in `ReportPageLayout`.
5. Write at least one test under the same backend folder (`<slug>.report.test.mjs`) — model after any existing one (`reservations-by-day` is the smallest, `availability-forecast` is the most feature-rich).
6. Update the existing-availability assertion in `reports-v2.service.test.mjs`.
7. Smoke check: `GET /api/reports/<slug>?from=...&to=...` returns JSON; the landing tile lights up; PDF + Excel download from the chrome.
