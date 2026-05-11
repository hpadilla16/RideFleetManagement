#!/usr/bin/env node
/**
 * Run a MarketScrapeProfile end-to-end against Bright Data Browser API and
 * persist the resulting MarketScrapeRun + MarketObservation rows in the DB.
 *
 * This is the thin wrapper the scheduled job on the scraper droplet invokes
 * (one process per profile, sequentially). It does no orchestration of its
 * own — all logic lives in market-scrape-runner.service.js so the same code
 * can also be invoked from a future "Run now" route or a background queue.
 *
 * Usage:
 *   export BRIGHTDATA_SB_URL='wss://brd-customer-...@brd.superproxy.io:9222'
 *   export DATABASE_URL='postgres://...'
 *   node scripts/market-scraper/run-profile.mjs --profile-id <cuid>
 *
 * Optional flags:
 *   --nav-timeout    ms (default 90000)
 *   --price-timeout  ms (default 60000)
 *   --delay-min      ms (default 5000)
 *   --delay-max      ms (default 15000)
 *   --sipp-map       absolute path to a custom category-sipp-map.json
 *
 * Exit codes:
 *   0  run completed (status SUCCESS or PARTIAL)
 *   1  run completed but every request failed (status FAILED)
 *   2  bad arguments / missing env / profile not found
 */
import { runProfile } from '../../src/modules/market-scraper/market-scrape-runner.service.js';
import {
  createExpediaSession,
  loadSippMap,
  categoryToSipp,
  DEFAULT_SIPP_MAP_PATH
} from '../../src/modules/market-scraper/expedia-scraper.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.replace(/^--/, '');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const PROFILE_ID = args['profile-id'];
const CDP_URL = process.env.BRIGHTDATA_SB_URL || args['cdp-url'];
const NAV_TIMEOUT_MS = Number(args['nav-timeout'] || 90_000);
const PRICE_TIMEOUT_MS = Number(args['price-timeout'] || 60_000);
const DELAY_MIN_MS = Number(args['delay-min'] || 5_000);
const DELAY_MAX_MS = Number(args['delay-max'] || 15_000);
const SIPP_MAP_PATH = args['sipp-map'] || DEFAULT_SIPP_MAP_PATH;

if (!PROFILE_ID) {
  console.error('FAIL: --profile-id is required');
  process.exit(2);
}
if (!CDP_URL) {
  console.error('FAIL: set BRIGHTDATA_SB_URL env or pass --cdp-url');
  process.exit(2);
}

async function main() {
  console.log(`[run-profile] profileId=${PROFILE_ID}`);
  console.log('[run-profile] connecting to Bright Data Browser API...');
  const sippMap = loadSippMap(SIPP_MAP_PATH);
  const session = await createExpediaSession({
    cdpUrl: CDP_URL,
    navTimeoutMs: NAV_TIMEOUT_MS,
    priceTimeoutMs: PRICE_TIMEOUT_MS
  });

  const result = await runProfile(PROFILE_ID, {
    scraper: session,
    sippMap,
    categoryToSipp,
    delayMinMs: DELAY_MIN_MS,
    delayMaxMs: DELAY_MAX_MS
  });

  console.log('[run-profile] done:', JSON.stringify(result, null, 2));

  if (result.status === 'FAILED') {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[run-profile] FATAL:', err.stack || err.message || err);
  process.exit(err.httpStatus === 404 ? 2 : 1);
});
