/**
 * Pure provider-pinning helper for the internal toll ingest (2026-07-27).
 * No imports (no prisma/express) so it stays unit-testable in isolation.
 *
 * The internal /ingest push (droplet scrapers) reuses createManualTransactions,
 * which — absent an explicit providerAccountId — resolves the account via
 * resolveActiveProvider = "most recently updated account". In a multi-account
 * tenant that guess mis-attributes a batch (a SunPass droplet push landing on a
 * freshly-created TollBridge account, QA 2026-07-27) and strips its sede stamp.
 * The route uses this to pin the batch to ITS OWN provider: explicit `provider`
 * wins, else infer from sourceType, else null (fall back to legacy resolution).
 */
const INGEST_SOURCE_PROVIDER = {
  SUNPASS_SYNC: 'SUNPASS',
  AUTOEXPRESO_SYNC: 'AUTOEXPRESO',
  TOLLBRIDGE_POLL: 'TOLLBRIDGE'
};

export function providerForIngest({ provider, sourceType } = {}) {
  if (provider) return String(provider).toUpperCase();
  const st = String(sourceType || '').toUpperCase();
  return INGEST_SOURCE_PROVIDER[st] || null;
}
