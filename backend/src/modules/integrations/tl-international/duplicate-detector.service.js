/**
 * Shim — the duplicate detector moved to ../booking-source/ (R0 extraction,
 * 2026-07-13) because it was always source-agnostic: TL, Economy and NU all
 * consume it unchanged. This re-export keeps every existing import path
 * (tl worker/routes, economy, nu, tests, scripts) working byte-identically.
 * New code should import from '../booking-source/duplicate-detector.service.js'.
 */
export * from '../booking-source/duplicate-detector.service.js';
