#!/usr/bin/env node
/**
 * Expedia car-rental market scraper.
 *
 * Connects to Bright Data Browser API via CDP, navigates Expedia carsearch
 * pages for a target airport across the next N look-ahead days for a fixed
 * length-of-rental (LOR), extracts the rendered listings, computes the
 * cheapest price per SIPP/ACRISS car category per day, applies a pricing
 * strategy (e.g. "cheapest minus $1"), and writes the result as an .xlsx
 * file in the suggestion-report format that backend/src/modules/rates/
 * already imports via /api/rates/:id/daily-prices/import.
 *
 * Usage:
 *   export BRIGHTDATA_SB_URL='wss://brd-customer-...@brd.superproxy.io:9222'
 *   node scripts/market-scraper/scrape-expedia.mjs \
 *     --airport sju \
 *     --look-ahead 15 \
 *     --lor 3 \
 *     --strategy cheapest_minus \
 *     --strategy-amount 1 \
 *     --output /tmp/sju-suggestion.xlsx
 *
 * Why a standalone CLI (not integrated into the backend yet):
 *   This is an MVP. Once we validate the XLSX output against Hector's
 *   expected pricing, we wrap this as a scheduled job on a dedicated
 *   droplet and have it POST the XLSX to /daily-prices/import via the
 *   existing API (see project_market_scraper memory for the full pipeline
 *   plan).
 *
 * Anti-detection notes baked in (per Hector's industry knowledge):
 *   - Pickup/return times are RANDOMIZED within business hours, NOT default
 *     round-hour values (10:00 AM/PM etc.). Default times return artificially
 *     INFLATED prices that Expedia uses as an anti-scraping tripwire.
 *   - Pickup date must always be >= today + 1 day. Past dates show a generic
 *     "We're experiencing technical problems" error page, not a useful
 *     validation message.
 *   - Random delay 5-15s between requests, plus session-reuse so cookies
 *     persist across requests (looks like a real user browsing).
 *
 * @see backend/scripts/market-scraper/category-sipp-map.json
 * @see project_market_scraper memory (~/Library/.../memory/)
 */

import { chromium } from 'playwright-core';
import ExcelJS from 'exceljs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ----- CLI argument parsing (zero-dependency) ----------------------------

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

const CDP_URL          = args['cdp-url']         || process.env.BRIGHTDATA_SB_URL || '';
const AIRPORT          = String(args.airport     || 'sju').toLowerCase();
const LOOK_AHEAD_DAYS  = Number(args['look-ahead'] || 15);
const LOR_DAYS         = Number(args.lor         || 3);
const STRATEGY         = String(args.strategy    || 'cheapest_minus').toLowerCase();
const STRATEGY_AMOUNT  = Number(args['strategy-amount'] ?? 1);
const STRATEGY_PCT     = Number(args['strategy-pct']    ?? 5);
const STRATEGY_FLOOR   = Number(args['strategy-floor']  ?? 0);
const OUTPUT_PATH      = args.output || resolve(__dirname, `out-${AIRPORT}-${Date.now()}.xlsx`);
const NAV_TIMEOUT_MS   = Number(args['nav-timeout']    || 90_000);
const PRICE_TIMEOUT_MS = Number(args['price-timeout']  || 60_000);
const DELAY_MIN_MS     = Number(args['delay-min']      || 5_000);
const DELAY_MAX_MS     = Number(args['delay-max']      || 15_000);
// Bright Data Browser API sessions die after ~9 requests / a few minutes
// (observed during 2026-05-13 demo: timeout on iteration 10 of 15, no
// recovery). We proactively recycle the session every N requests so a
// single CLI run can span the full LOOK_AHEAD_DAYS window without crashing.
// 8 is a safe ceiling well below the observed 9-request threshold.
const MAX_REQS_PER_SESSION = Number(args['max-reqs-per-session'] || 8);
const DEBUG            = args.debug === true;

if (!CDP_URL) {
  console.error('FAIL: set $BRIGHTDATA_SB_URL or pass --cdp-url');
  process.exit(2);
}
if (LOOK_AHEAD_DAYS < 1 || LOOK_AHEAD_DAYS > 90) {
  console.error('FAIL: --look-ahead must be 1..90');
  process.exit(2);
}
if (LOR_DAYS < 1 || LOR_DAYS > 30) {
  console.error('FAIL: --lor must be 1..30');
  process.exit(2);
}

// ----- Category → SIPP map -----------------------------------------------

const sippMap = JSON.parse(readFileSync(join(__dirname, 'category-sipp-map.json'), 'utf8'));

function categoryToSipp(category) {
  if (!category) return null;
  const norm = category.trim();
  // Try exact case-insensitive match
  for (const [k, v] of Object.entries(sippMap.exact)) {
    if (k.toLowerCase() === norm.toLowerCase()) return v;
  }
  // Keyword fallback (longer keywords first to prefer "Midsize SUV" over "Midsize")
  const low = norm.toLowerCase();
  const sorted = [...sippMap.keyword_fallback].sort((a, b) => b[0].length - a[0].length);
  for (const [kw, sipp] of sorted) {
    if (low.includes(kw)) return sipp;
  }
  return null;
}

// ----- Pricing strategy ---------------------------------------------------

function applyStrategy(cheapestPrice) {
  if (cheapestPrice == null || !Number.isFinite(cheapestPrice)) return null;
  let suggested;
  switch (STRATEGY) {
    case 'cheapest_minus':
      suggested = cheapestPrice - STRATEGY_AMOUNT;
      break;
    case 'match_cheapest':
      suggested = cheapestPrice;
      break;
    case 'cheapest_plus_pct':
      suggested = cheapestPrice * (1 + STRATEGY_PCT / 100);
      break;
    case 'static_floor':
      suggested = Math.max(cheapestPrice, STRATEGY_FLOOR);
      break;
    default:
      throw new Error(`Unknown strategy: ${STRATEGY}`);
  }
  // Never recommend below floor (defense in depth: if cheapest_minus produces a
  // negative or unreasonably low price, clamp to a floor).
  if (STRATEGY_FLOOR > 0 && suggested < STRATEGY_FLOOR) suggested = STRATEGY_FLOOR;
  return Number(suggested.toFixed(2));
}

// ----- URL construction ---------------------------------------------------

function pad2(n) { return String(n).padStart(2, '0'); }

function isoToMDY(date) {
  // Returns "M/D/YYYY" (no zero-padding on month/day, per Expedia's format).
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// Pick a random time within business hours, no zero-padding, no minutes that
// are :00 (Expedia inflates prices for default round-hour values per Hector's
// industry note). Format: HMMam/HMMpm or HHMMam/HHMMpm.
const BUSINESS_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const NON_DEFAULT_MINUTES = [15, 30, 45]; // never :00

function randomBusinessTime() {
  const hour24 = BUSINESS_HOURS[Math.floor(Math.random() * BUSINESS_HOURS.length)];
  const min = NON_DEFAULT_MINUTES[Math.floor(Math.random() * NON_DEFAULT_MINUTES.length)];
  const isPm = hour24 >= 12;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}${pad2(min)}${isPm ? 'PM' : 'AM'}`;
}

function buildSearchUrl(airport, pickupDate, returnDate) {
  const params = new URLSearchParams({
    locn: airport,
    date1: isoToMDY(pickupDate),
    date2: isoToMDY(returnDate),
    styp: '1',
    fdrp: '0',
    kind: '1',
    time1: randomBusinessTime(),
    time2: randomBusinessTime(),
    dagv: '1',
    subm: '1',
    paandi: 'true'
  });
  // URLSearchParams encodes "/" as "%2F" which is what Expedia expects in
  // its date1/date2. The other params are simple.
  return `https://www.expedia.com/carsearch?${params.toString()}`;
}

// ----- Listing extraction (runs inside the browser page) ------------------

async function extractListings(page) {
  return page.evaluate(() => {
    const carClassRe = /Economy|Compact|Mid-?size|Intermediate|Full[- ]?size|Premium|Luxury|SUV|Minivan|Standard|Mini|Convertible|Sports?|Van|Pickup/i;
    const dailyPriceRe = /\$(\d+(?:\.\d{2})?)/;
    const totalPriceRe = /\$(\d+(?:\.\d{2})?)\s*total/i;

    // Promotional/marketing badges Expedia injects as the FIRST line of some
    // car-offer-cards before the real category. We need to skip them to pull
    // the actual category from line 1 or 2 in those cases. Keep this list
    // narrow — anything that LOOKS like a real category (e.g. "Special SUV")
    // should fall through to the real category detection below.
    const promoBadgeRe = /^(great deal|best deal|deal|hot deal|limited time|best match|most popular|recommended|top pick)$/i;

    const cards = document.querySelectorAll('[data-stid="car-offer-card"]');
    const out = [];
    for (const card of cards) {
      const text = (card.innerText || '').trim();
      if (!carClassRe.test(text)) continue;

      const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);

      // Pick the first line that's NOT a promo badge AND matches a car-class
      // pattern. Falls back to the first non-badge line if nothing matches
      // (so we can still log unmapped categories for the user to extend the
      // SIPP map with).
      let category = null;
      let model = null;
      let badge = null;
      for (let j = 0; j < Math.min(5, lines.length); j += 1) {
        const line = lines[j];
        if (promoBadgeRe.test(line)) { badge = line; continue; }
        if (!category) {
          category = line;
          model = lines[j + 1] || null;
          break;
        }
      }
      if (!category) {
        category = lines[0] || null;
        model = lines[1] || null;
      }

      // Daily price is the FIRST $ amount in the card text, except when it
      // appears right next to "total" (those are the LOR-aggregate prices).
      // Find all $ amounts and filter.
      const amounts = [...text.matchAll(/\$(\d+(?:\.\d{2})?)(?!\s*total)/gi)]
        .map((m) => Number(m[1]))
        .filter((n) => Number.isFinite(n) && n > 0);
      const dailyPrice = amounts.length ? amounts[0] : null;

      const totalMatch = text.match(totalPriceRe);
      const totalPrice = totalMatch ? Number(totalMatch[1]) : null;

      // Vendor: look for image alt text inside the card (Expedia uses logos
      // for vendor branding; alt text usually contains the vendor name).
      let vendor = null;
      const imgs = card.querySelectorAll('img[alt]');
      for (const img of imgs) {
        const alt = (img.getAttribute('alt') || '').trim();
        // Skip generic "Car image" / "Logo" type alts.
        if (/Hertz|Avis|Enterprise|Budget|National|Alamo|Thrifty|Dollar|Sixt|Payless|Fox|Europcar|Ace|Routes|Easirent|NU|Advantage/i.test(alt)) {
          vendor = alt;
          break;
        }
      }

      out.push({ category, model, dailyPrice, totalPrice, vendor, badge });
    }
    return out;
  });
}

// ----- Scrape one search ---------------------------------------------------

async function scrapeOneSearch(page, airport, pickupDate, returnDate) {
  const url = buildSearchUrl(airport, pickupDate, returnDate);
  const tStart = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    return { url, listings: [], error: `nav: ${err.message}` };
  }

  // Wait for either the first $ price OR a known error message. We wait for
  // EITHER condition so a soft-block / "technical problems" page returns
  // quickly instead of timing out.
  try {
    await page.waitForFunction(
      () => {
        const t = document.body.innerText || '';
        return /\$\d+/.test(t) || /technical problems|adjust your search|no.*results found/i.test(t);
      },
      { timeout: PRICE_TIMEOUT_MS }
    );
  } catch {
    return { url, listings: [], error: 'timeout waiting for prices or error message' };
  }

  // Detect the soft-block error page so we can report it cleanly.
  const errSignal = await page.evaluate(() => {
    const t = document.body.innerText || '';
    if (/technical problems/i.test(t)) return 'expedia-technical-problems';
    if (/no.*results found|no.*available/i.test(t)) return 'expedia-no-results';
    return null;
  });
  if (errSignal) return { url, listings: [], error: errSignal };

  // The first waitForFunction fires as soon as ANY $ amount is on the page,
  // but those early $ matches come from the "Filter by" sidebar (filter
  // counts like "Economy from $54") which renders BEFORE the car cards. If
  // we extract at that point, document.querySelectorAll('[data-stid="car-offer-card"]')
  // returns 0 even though cars eventually appear. So wait specifically for
  // the first car-offer-card before extracting. Falls back to a settle delay
  // if Expedia ever renames the selector.
  try {
    await page.waitForSelector('[data-stid="car-offer-card"]', { timeout: 30_000 });
  } catch {
    // Selector didn't appear — could be a layout change or an empty result.
    // Give one more settle pass then extract whatever we can.
    await page.waitForTimeout(5000);
  }
  // Extra settle so late-loaded cards beyond the first one have time to populate.
  await page.waitForTimeout(2000);

  const listings = await extractListings(page);
  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  return { url, listings, elapsedSec: elapsed };
}

// ----- XLSX output --------------------------------------------------------

async function writeXlsx(outputPath, rows, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RideFleet market scraper';
  wb.created = new Date();
  const ws = wb.addWorksheet('Suggestion Report');

  // The first 4 columns match the headers the existing /daily-prices/import
  // endpoint recognizes (see parseDailyPriceExcel in rates.service.js). The
  // rest are diagnostic/raw data to help Hector decide which price basis to
  // use as the strategy input (base daily vs effective total/LOR).
  ws.columns = [
    { header: 'Sipp',                key: 'sipp',                  width: 8  },
    { header: 'Location',            key: 'location',              width: 10 },
    { header: 'PickUpDate',          key: 'pickupDate',            width: 12 },
    { header: 'SuggestedAmount',     key: 'suggestedAmount',       width: 16 },
    { header: 'CheapestDailyBase',   key: 'cheapest',              width: 18 },
    { header: 'CheapestTotalSeen',   key: 'cheapestTotal',         width: 18 },
    { header: 'EffectiveDailyAvg',   key: 'effectiveDailyAvg',     width: 20 },
    { header: 'CheapestVendor',      key: 'cheapestVendor',        width: 18 },
    { header: 'ListingsSampled',     key: 'sampled',               width: 16 },
    { header: 'Strategy',            key: 'strategy',              width: 22 }
  ];

  for (const row of rows) {
    ws.addRow({
      sipp: row.sipp,
      location: row.location,
      pickupDate: row.pickupDate,
      suggestedAmount: row.suggestedAmount,
      cheapest: row.cheapest,
      cheapestTotal: row.cheapestTotal != null ? row.cheapestTotal : '',
      effectiveDailyAvg: row.effectiveDailyAvg != null ? row.effectiveDailyAvg : '',
      cheapestVendor: row.cheapestVendor || '',
      sampled: row.sampled,
      strategy: row.strategy
    });
  }

  // Metadata sheet for traceability (which run produced this output).
  const metaSheet = wb.addWorksheet('Run Metadata');
  metaSheet.columns = [
    { header: 'Key', key: 'k', width: 30 },
    { header: 'Value', key: 'v', width: 60 }
  ];
  for (const [k, v] of Object.entries(meta)) {
    metaSheet.addRow({ k, v: typeof v === 'object' ? JSON.stringify(v) : String(v) });
  }

  await wb.xlsx.writeFile(outputPath);
}

// ----- Main ---------------------------------------------------------------

// Wraps connect + context + page setup so we can call it again mid-run when
// the Bright Data session dies or we hit MAX_REQS_PER_SESSION.
async function connectSession() {
  const t0 = Date.now();
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();
  return { browser, page, connectMs: Date.now() - t0 };
}

// True when an exception came from Playwright after the underlying browser
// session died on Bright Data's side. Indicates "session is gone, recycle".
function isSessionClosed(err) {
  const m = String(err?.message || err || '');
  return /Target page, context or browser has been closed|Browser has been closed|Target closed/i.test(m);
}

// Sleep helper that doesn't depend on the page (so we can sleep between
// iterations even when the page handle is being recycled).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const runStart = Date.now();
  console.log('=== Market scraper ===');
  console.log(`Airport:       ${AIRPORT.toUpperCase()}`);
  console.log(`Look-ahead:    ${LOOK_AHEAD_DAYS} days`);
  console.log(`LOR:           ${LOR_DAYS} days`);
  console.log(`Strategy:      ${STRATEGY} amount=${STRATEGY_AMOUNT} pct=${STRATEGY_PCT} floor=${STRATEGY_FLOOR}`);
  console.log(`Output:        ${OUTPUT_PATH}`);
  console.log(`Delay between: ${DELAY_MIN_MS}-${DELAY_MAX_MS}ms`);
  console.log(`Session cap:   ${MAX_REQS_PER_SESSION} requests then recycle`);
  console.log('');

  console.log('Connecting to Browser API via CDP...');
  let { browser, page, connectMs } = await connectSession();
  console.log(`Connected in ${(connectMs / 1000).toFixed(1)}s`);
  let requestsThisSession = 0;
  let sessionsUsed = 1;

  async function recycleSession(reason) {
    console.log(`  (recycling Bright Data session: ${reason})`);
    try { await browser.close(); } catch (_) { /* best effort */ }
    const r = await connectSession();
    browser = r.browser;
    page = r.page;
    requestsThisSession = 0;
    sessionsUsed += 1;
    console.log(`  (reconnected session #${sessionsUsed} in ${(r.connectMs / 1000).toFixed(1)}s)`);
  }

  // Build pickup dates starting from tomorrow (never today; never past).
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const startPickup = addDays(today, 1);

  // Aggregator: { [pickupISO]: { [sipp]: { cheapest, cheapestVendor, sampled } } }
  const agg = {};

  let okCount = 0;
  let errCount = 0;
  for (let i = 0; i < LOOK_AHEAD_DAYS; i += 1) {
    const pickup = addDays(startPickup, i);
    const ret = addDays(pickup, LOR_DAYS);
    const pickupISO = pickup.toISOString().slice(0, 10);

    // Proactive recycle: don't even let the session reach the failure
    // threshold. Bright Data observed to close at request 9-10 → cap at 8.
    if (requestsThisSession >= MAX_REQS_PER_SESSION) {
      await recycleSession(`hit cap of ${MAX_REQS_PER_SESSION} requests`);
    }

    process.stdout.write(`[${i + 1}/${LOOK_AHEAD_DAYS}] ${pickupISO} -> ${ret.toISOString().slice(0, 10)} ... `);

    let result;
    try {
      result = await scrapeOneSearch(page, AIRPORT, pickup, ret);
    } catch (err) {
      if (isSessionClosed(err)) {
        // Reactive recycle: session died unexpectedly (Bright Data dropped
        // us early, network blip, etc.). Reconnect and retry the same day.
        console.log(`session-closed mid-request — retrying`);
        await recycleSession('caught session-closed error');
        try {
          result = await scrapeOneSearch(page, AIRPORT, pickup, ret);
        } catch (err2) {
          result = { error: `retry-failed: ${err2.message}` };
        }
      } else {
        result = { error: `unexpected: ${err.message}` };
      }
    }
    requestsThisSession += 1;

    if (result.error) {
      errCount += 1;
      console.log(`ERR: ${result.error}`);
    } else {
      okCount += 1;
      console.log(`${result.listings.length} listings (${result.elapsedSec}s)`);

      // Group by SIPP. For each SIPP, track:
      //  - cheapest daily base price (Expedia's prominent number; pre-tax teaser)
      //  - the TOTAL price for the listing that had the cheapest base (= total
      //    that customer actually pays for the full LOR including taxes/fees)
      //  - the average effective daily (mean of total/LOR across all listings)
      //    which is a better signal of the "real" market floor than the teaser
      // The strategy still applies to the cheapest daily base for now; Hector
      // can decide whether to switch to effective-daily after seeing both.
      const bySipp = {};
      for (const l of result.listings) {
        const sipp = categoryToSipp(l.category);
        if (!sipp) {
          if (DEBUG) console.log(`    SKIP unmapped category: "${l.category}"`);
          continue;
        }
        if (l.dailyPrice == null) continue;
        const effectiveDaily = (l.totalPrice != null && LOR_DAYS > 0)
          ? l.totalPrice / LOR_DAYS
          : null;
        if (!bySipp[sipp]) {
          bySipp[sipp] = {
            cheapest: l.dailyPrice,
            cheapestTotal: l.totalPrice,
            cheapestVendor: l.vendor,
            effectiveDailySum: effectiveDaily != null ? effectiveDaily : 0,
            effectiveDailyCount: effectiveDaily != null ? 1 : 0,
            sampled: 1,
            category: l.category
          };
        } else {
          if (l.dailyPrice < bySipp[sipp].cheapest) {
            bySipp[sipp].cheapest = l.dailyPrice;
            bySipp[sipp].cheapestTotal = l.totalPrice;
            bySipp[sipp].cheapestVendor = l.vendor;
          }
          if (effectiveDaily != null) {
            bySipp[sipp].effectiveDailySum += effectiveDaily;
            bySipp[sipp].effectiveDailyCount += 1;
          }
          bySipp[sipp].sampled += 1;
        }
      }
      agg[pickupISO] = bySipp;
    }

    // Random delay between requests (skip on last iteration).
    // Use plain setTimeout instead of page.waitForTimeout so the wait works
    // even if the page handle is about to be recycled (page may be invalid
    // by the time we wake up — recycleSession() handles that next iter).
    if (i < LOOK_AHEAD_DAYS - 1) {
      const delay = DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
      await sleep(delay);
    }
  }

  try { await browser.close(); } catch (_) { /* best effort on final close */ }

  // Build XLSX rows
  const rows = [];
  for (const [pickupISO, bySipp] of Object.entries(agg)) {
    for (const [sipp, info] of Object.entries(bySipp)) {
      const suggested = applyStrategy(info.cheapest);
      const effectiveDailyAvg = info.effectiveDailyCount > 0
        ? Number((info.effectiveDailySum / info.effectiveDailyCount).toFixed(2))
        : null;
      rows.push({
        sipp,
        location: AIRPORT.toUpperCase(),
        pickupDate: pickupISO,
        suggestedAmount: suggested,
        cheapest: info.cheapest,
        cheapestTotal: info.cheapestTotal,
        effectiveDailyAvg,
        cheapestVendor: info.cheapestVendor,
        sampled: info.sampled,
        strategy: `${STRATEGY}(amount=${STRATEGY_AMOUNT})`
      });
    }
  }

  const totalElapsed = ((Date.now() - runStart) / 1000).toFixed(1);
  console.log('');
  console.log(`=== Done in ${totalElapsed}s — ${okCount} ok, ${errCount} err, ${rows.length} pricing rows ===`);

  await writeXlsx(OUTPUT_PATH, rows, {
    airport: AIRPORT,
    lookAheadDays: LOOK_AHEAD_DAYS,
    lor: LOR_DAYS,
    strategy: STRATEGY,
    strategyAmount: STRATEGY_AMOUNT,
    strategyPct: STRATEGY_PCT,
    strategyFloor: STRATEGY_FLOOR,
    runStartedAt: new Date(runStart).toISOString(),
    runElapsedSec: totalElapsed,
    okCount,
    errCount,
    totalRows: rows.length,
    sessionsUsed,
    maxReqsPerSession: MAX_REQS_PER_SESSION
  });
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
