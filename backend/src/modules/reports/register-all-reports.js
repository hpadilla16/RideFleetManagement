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
import './toll-per-vehicle.report.js';
import './toll-per-location.report.js';
import './commission.report.js';
import './taxes.report.js';
