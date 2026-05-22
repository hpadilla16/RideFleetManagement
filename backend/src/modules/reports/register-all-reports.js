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
