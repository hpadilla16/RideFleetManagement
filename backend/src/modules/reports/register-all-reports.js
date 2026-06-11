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
// 2026-05-26: commission.report.js (slug 'commission' / "Commission Payouts")
// was retired. commission-sales-performance.report.js is the single source
// of truth for per-agent commission. The module file + sync logic + backfill
// script remain in the repo for the eventual approve workflow on the
// surviving report.
import './taxes.report.js';
import './pre-paid-reservations.report.js';
