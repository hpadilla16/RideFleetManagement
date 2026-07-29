/**
 * Side-effect barrel that loads every individual report module so its
 * registerReport() call runs at startup. Add a new report = add an import
 * line here. The actual route wiring lives inside each report file via
 * registerReport().
 *
 * Loaded by main.js AFTER reports-v2.routes.js is mounted.
 */

import './commission-sales-performance.report.js';
import './agent-track-record.report.js';
import './availability-forecast.report.js';
import './reservations-by-day.report.js';
import './payments-by-day.report.js';
import './rental-status.report.js';
import './sales.report.js';
import './unpaid-balance.report.js';
import './availability.report.js';
import './fleet-status.report.js';
import './utilization.report.js';
import './upcoming-vehicle-sales.report.js';
import './fleet-value.report.js';
import './toll-per-vehicle.report.js';
import './toll-per-location.report.js';
// 2026-07-25 (LAX #5): commission.report.js RESURRECTED — the "eventual
// approve workflow" the 2026-05-26 retirement note anticipated now exists
// (approve/mark-paid/void endpoints + review-tier commissions), and this
// ledger-backed report is its surface. commission-sales-performance stays
// the catalog-attach view; this one is the PAYOUTS view (what the ledger
// actually owes/paid, with monthly validated-review counts).
import './commission.report.js';
import './taxes.report.js';
import './pre-paid-reservations.report.js';
// 2026-07-29 — LAWA airport-concession compliance export (Hector's ask,
// matches the RAReporting sample column-for-column).
import './airport-lawa.report.js';
