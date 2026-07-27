/**
 * TollBridge partner-feed constants (2026-07-27). RFM POLLS TollBridge's
 * GET /api/partner/tolls with a long-lived read-only API key they issue.
 *
 * All defaults are code-side so env-diff-check stays green — the droplet only
 * needs these when activating. The API KEY is NEVER hardcoded; it lives in the
 * droplet env (TOLLBRIDGE_PARTNER_KEY) and is read at call time.
 */
export const TOLLBRIDGE_IMPORT_ENABLED =
  String(process.env.TOLLBRIDGE_IMPORT_ENABLED || 'false').toLowerCase() === 'true';

export const TOLLBRIDGE_BASE =
  (process.env.TOLLBRIDGE_PARTNER_BASE || 'https://tollbridge.ridefleetmanager.com').replace(/\/+$/, '');

export const TOLLBRIDGE_PARTNER_PATH =
  process.env.TOLLBRIDGE_PARTNER_PATH || '/api/partner/tolls';

// Their key. Read lazily so the module loads without it; a missing key is a
// hard error only when the poller actually runs.
export function tollbridgePartnerKey() {
  return String(process.env.TOLLBRIDGE_PARTNER_KEY || '').trim();
}

// Rolling window we re-poll each run. externalId dedup makes re-polling
// idempotent, and re-polling is REQUIRED to catch status flips to VOID
// (their point 5: refresh imported rows, not just consume new). CA statements
// post up to a month late, so the default reaches back far enough.
export const TOLLBRIDGE_LOOKBACK_DAYS =
  Number(process.env.TOLLBRIDGE_IMPORT_LOOKBACK_DAYS || 45) || 45;

// Their suggested rate limit is 60 req/min; page size 500 default, 1000 max.
export const TOLLBRIDGE_PAGE_LIMIT =
  Math.min(Number(process.env.TOLLBRIDGE_PAGE_LIMIT || 500) || 500, 1000);

// Sync interval + startup stagger for the poller's own worker timer.
export const TOLLBRIDGE_INTERVAL_MINUTES =
  Number(process.env.TOLLBRIDGE_IMPORT_INTERVAL_MINUTES || 30) || 30;
export const TOLLBRIDGE_STARTUP_DELAY_SECONDS =
  Number(process.env.TOLLBRIDGE_IMPORT_STARTUP_DELAY_SECONDS || 210) || 210;
