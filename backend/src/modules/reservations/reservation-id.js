/**
 * VozIA Fase 1 (2026-07-03): resolve a reservation route param to a Prisma
 * where fragment. Human-facing reservation numbers carry a short alphabetic
 * prefix + hyphen ("RES-00123", "TL-ZE40809640BA"); cuids never contain a
 * hyphen in the first 7 chars. Pure and dependency-free — lives in its own
 * module so reservation-id-resolver.test.mjs can import it without pulling
 * the reservations.service.js graph (whose cache/settings imports hold the
 * event loop open under `node --test` without --test-force-exit).
 * Re-exported from reservations.service.js for service-side callers.
 */
export function reservationIdWhere(param) {
  const value = String(param ?? '');
  return /^[A-Za-z]{2,6}-/.test(value)
    ? { reservationNumber: value }
    : { id: value };
}
