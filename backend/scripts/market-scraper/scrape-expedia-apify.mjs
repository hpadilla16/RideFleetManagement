#!/usr/bin/env node
/**
 * Expedia car-rental market scraper — Apify variant.
 *
 * Calls the `shahidirfan/Expedia-Car-Rental-Scraper` actor on Apify, which
 * runs a maintained Expedia scraper with built-in anti-bot bypass (residential
 * proxy routing, request recovery, etc.). We feed it one carsearch URL per
 * pickup day, get a structured JSON response, aggregate per (date, SIPP),
 * and write the suggestion-report XLSX.
 *
 * Why this exists:
 *   - Bright Data: confirmed dead end (robots.txt enforced by their
 *     compliance team, can't whitelist Expedia). See feedback memory.
 *   - ScrapingBee + stealth_proxy: zero car-offer-cards in the rendered HTML
 *     — Expedia detects the fingerprint and serves an empty shell page.
 *   - Apify community actors: maintained by people who specifically built
 *     anti-bot workarounds for Expedia and update them when the site changes.
 *
 * Cost (as of 2026-05-14):
 *   - Actor start: ~$0.0005 (rounded to $0.001)
 *   - Per result: $0.00149
 *   - 15-day scrape × ~25 results/day = ~$0.56 per full run.
 *
 * Usage:
 *   export APIFY_TOKEN='apify_api_...'
 *   node scripts/market-scraper/scrape-expedia-apify.mjs \
 *     --airport sju --look-ahead 15 --lor 3 \
 *     --strategy cheapest_minus --strategy-amount 1 \
 *     --output ~/Desktop/sju-apify.xlsx
 */
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ----- CLI args -----------------------------------------------------------

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

const APIFY_TOKEN = process.env.APIFY_TOKEN || args['token'] || '';
const ACTOR_ID = args['actor'] || 'shahidirfan~Expedia-Car-Rental-Scraper';
const AIRPORT = String(args.airport || 'sju').toLowerCase();
const LOOK_AHEAD_DAYS = Number(args['look-ahead'] || 15);
const LOR_DAYS = Number(args.lor || 3);
const STRATEGY = String(args.strategy || 'cheapest_minus').toLowerCase();
const STRATEGY_AMOUNT = Number(args['strategy-amount'] ?? 1);
const STRATEGY_PCT = Number(args['strategy-pct'] ?? 5);
const STRATEGY_FLOOR = Number(args['strategy-floor'] ?? 0);
const RESULTS_WANTED = Number(args['results-wanted'] || 30);
const MAX_PAGES = Number(args['max-pages'] || 8);
const OUTPUT_PATH = args.output || resolve(__dirname, `apify-${AIRPORT}-${Date.now()}.xlsx`);
const REQUEST_TIMEOUT_MS = Number(args['request-timeout'] || 300_000); // Apify sync runs cap at 300s
const DELAY_MIN_MS = Number(args['delay-min'] || 1_000);
const DELAY_MAX_MS = Number(args['delay-max'] || 3_000);
const DEBUG = args.debug === true;

if (!APIFY_TOKEN) {
  console.error('FAIL: set $APIFY_TOKEN or pass --token');
  process.exit(2);
}
if (LOOK_AHEAD_DAYS < 1 || LOOK_AHEAD_DAYS > 90) {
  console.error('FAIL: --look-ahead must be 1..90');
  process.exit(2);
}

// ----- Shared helpers (SIPP map + strategy) -------------------------------

const sippMap = JSON.parse(readFileSync(join(__dirname, 'category-sipp-map.json'), 'utf8'));

function categoryToSipp(category) {
  if (!category) return null;
  const norm = category.trim();
  for (const [k, v] of Object.entries(sippMap.exact)) {
    if (k.toLowerCase() === norm.toLowerCase()) return v;
  }
  const low = norm.toLowerCase();
  const sorted = [...sippMap.keyword_fallback].sort((a, b) => b[0].length - a[0].length);
  for (const [kw, sipp] of sorted) {
    if (low.includes(kw)) return sipp;
  }
  return null;
}

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
  if (STRATEGY_FLOOR > 0 && suggested < STRATEGY_FLOOR) suggested = STRATEGY_FLOOR;
  return Number(suggested.toFixed(2));
}

// ----- URL building (same anti-detection rules as Playwright + Bee variants)

function pad2(n) { return String(n).padStart(2, '0'); }

function isoToMDY(date) {
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const BUSINESS_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const NON_DEFAULT_MINUTES = [15, 30, 45];

function randomBusinessTime() {
  const hour24 = BUSINESS_HOURS[Math.floor(Math.random() * BUSINESS_HOURS.length)];
  const min = NON_DEFAULT_MINUTES[Math.floor(Math.random() * NON_DEFAULT_MINUTES.length)];
  const isPm = hour24 >= 12;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}${pad2(min)}${isPm ? 'PM' : 'AM'}`;
}

/**
 * Canonical Expedia airport configs.
 *
 * The Apify actor "auto-heals" minimal URLs like `?locn=sju` by resolving
 * them to a canonical form. That resolution step trips Expedia's anti-bot
 * (observed 2026-05-15: `?locn=sju` 429s; full URL with `dpln` + long
 * `locn` + `olat`/`olon` returns 201). So we always send the canonical form.
 *
 * To add a new airport:
 *   1. Open https://www.expedia.com/carsearch in a real browser
 *   2. Search for the airport, copy the resulting URL query params
 *   3. Extract dpln, locn, olat, olon and add an entry here
 */
const AIRPORT_CONFIGS = {
  sju: {
    locn: 'San Juan, Puerto Rico (SJU-Luis Munoz Marin Intl.)',
    dpln: '5589587',
    olat: '18.438444',
    olon: '-66.006586'
  },
  mco: {
    locn: 'Orlando, FL (MCO-Orlando Intl.)',
    dpln: '178286',
    olat: '28.4312',
    olon: '-81.3081'
  }
  // Add more airports as needed
};

function buildExpediaUrl(airport, pickupDate, returnDate) {
  const cfg = AIRPORT_CONFIGS[airport.toLowerCase()];
  if (!cfg) {
    // Fallback: minimal URL with just airport code. Risky — Expedia may
    // 429 the auto-heal step — but lets unknown airports still run.
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
    return `https://www.expedia.com/carsearch?${params.toString()}`;
  }
  // Canonical form — matches what a real browser sends after location resolution.
  const params = new URLSearchParams({
    paandi: 'true',
    fdrp: '0',
    styp: '1',
    kind: '1',
    dagv: '1',
    subm: '1',
    locn: cfg.locn,
    dpln: cfg.dpln,
    date1: isoToMDY(pickupDate),
    date2: isoToMDY(returnDate),
    time1: randomBusinessTime(),
    time2: randomBusinessTime(),
    olat: cfg.olat,
    olon: cfg.olon,
    loc2: '',
    drid1: '',
    aarpcr: 'off'
  });
  return `https://www.expedia.com/carsearch?${params.toString()}`;
}

// ----- Apify actor invocation --------------------------------------------

/**
 * Run the actor synchronously and return the dataset items it produced.
 *   POST /v2/acts/<actorId>/run-sync-get-dataset-items?token=...&timeout=...
 * Body: the actor's input JSON.
 *
 * Apify keeps the connection open until the run finishes (max 5 min for the
 * sync endpoint) and streams back the dataset items as a JSON array. No
 * polling, no separate dataset fetch.
 */
async function runActorSync(input) {
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(ACTOR_ID)}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal
    });
  } catch (err) {
    return { items: [], error: `fetch: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { items: [], error: `apify-${r.status}: ${body.slice(0, 300)}` };
  }

  let items;
  try {
    items = await r.json();
  } catch (err) {
    return { items: [], error: `json-parse: ${err.message}` };
  }
  if (!Array.isArray(items)) {
    return { items: [], error: `expected array, got ${typeof items}` };
  }
  return { items };
}

/**
 * Map an Apify dataset item to the shape the aggregator expects:
 *   { category, model, dailyPrice, totalPrice, vendor }
 *
 * `vendor_image_url` looks like `https://images.trvl-media.com/cars/<vendor>-logo.png`
 * for many suppliers. We try to derive a vendor name from the URL filename;
 * falls back to null if the URL doesn't follow that convention.
 */
function mapApifyItemToListing(item) {
  const category = item.vehicle_category || item.offer_heading || null;
  const model = item.vehicle_description || null;

  // Pull a number out of the price text. "$46/day" -> 46. "$184 total" -> 184.
  const priceFromText = (s) => {
    if (!s) return null;
    const m = String(s).match(/\$(\d+(?:\.\d{2})?)/);
    return m ? Number(m[1]) : null;
  };
  const dailyPrice = priceFromText(item.price_lead);
  const totalPrice = priceFromText(item.price_total);

  // Vendor: the actor exposes `vendor_brand` directly (confirmed with MCO
  // test 2026-05-15). Older versions of the actor didn't, so fall back to
  // parsing the vendor logo URL filename or scanning accessibility_string.
  let vendor = item.vendor_brand || null;
  if (!vendor && item.vendor_image_url) {
    const last = String(item.vendor_image_url).split('/').pop() || '';
    const base = last.replace(/\.(png|jpg|jpeg|webp|svg)(\?.*)?$/i, '');
    const head = base.split(/[-_]/)[0];
    if (head && /^[A-Za-z]{2,}$/.test(head)) {
      vendor = head.charAt(0).toUpperCase() + head.slice(1).toLowerCase();
    }
  }
  if (!vendor && item.accessibility_string) {
    const m = String(item.accessibility_string)
      .match(/from\s+(Hertz|Avis|Enterprise|Budget|National|Alamo|Thrifty|Dollar|Sixt|Payless|Fox|Europcar|Ace|Routes|Easirent|NU|Advantage)/i);
    if (m) vendor = m[1];
  }

  return { category, model, dailyPrice, totalPrice, vendor };
}

// ----- XLSX output (identical to other variants) --------------------------

async function writeXlsx(outputPath, rows, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RideFleet market scraper (Apify)';
  wb.created = new Date();
  const ws = wb.addWorksheet('Suggestion Report');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- Main ---------------------------------------------------------------

async function main() {
  const runStart = Date.now();
  console.log('=== Market scraper (Apify) ===');
  console.log(`Actor:         ${ACTOR_ID}`);
  console.log(`Airport:       ${AIRPORT.toUpperCase()}`);
  console.log(`Look-ahead:    ${LOOK_AHEAD_DAYS} days`);
  console.log(`LOR:           ${LOR_DAYS} days`);
  console.log(`Strategy:      ${STRATEGY} amount=${STRATEGY_AMOUNT} pct=${STRATEGY_PCT} floor=${STRATEGY_FLOOR}`);
  console.log(`results_wanted: ${RESULTS_WANTED}, max_pages: ${MAX_PAGES}`);
  console.log(`Output:        ${OUTPUT_PATH}`);
  console.log('');

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const startPickup = addDays(today, 1);

  const agg = {};
  let okCount = 0;
  let errCount = 0;
  let totalResults = 0;

  for (let i = 0; i < LOOK_AHEAD_DAYS; i += 1) {
    const pickup = addDays(startPickup, i);
    const ret = addDays(pickup, LOR_DAYS);
    const pickupISO = pickup.toISOString().slice(0, 10);
    const expediaUrl = buildExpediaUrl(AIRPORT, pickup, ret);

    process.stdout.write(`[${i + 1}/${LOOK_AHEAD_DAYS}] ${pickupISO} -> ${ret.toISOString().slice(0, 10)} ... `);
    const tStart = Date.now();
    const { items, error } = await runActorSync({
      startUrl: expediaUrl,
      results_wanted: RESULTS_WANTED,
      max_pages: MAX_PAGES,
      proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        // Force US residential pool — Expedia treats foreign IPs more
        // aggressively. Test 2026-05-15: combination of canonical URL +
        // US proxy returned 201, while default config 429'd repeatedly.
        apifyProxyCountry: 'US'
      }
    });
    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);

    if (error) {
      errCount += 1;
      console.log(`ERR: ${error} (${elapsed}s)`);
    } else {
      okCount += 1;
      totalResults += items.length;
      console.log(`${items.length} listings (${elapsed}s)`);

      if (DEBUG && items[0]) {
        console.log(`    sample item keys: ${Object.keys(items[0]).join(', ')}`);
      }

      const bySipp = {};
      for (const item of items) {
        const listing = mapApifyItemToListing(item);
        const sipp = categoryToSipp(listing.category);
        if (!sipp) {
          if (DEBUG) console.log(`    SKIP unmapped category: "${listing.category}"`);
          continue;
        }
        if (listing.dailyPrice == null) continue;
        const effectiveDaily = (listing.totalPrice != null && LOR_DAYS > 0)
          ? listing.totalPrice / LOR_DAYS
          : null;
        if (!bySipp[sipp]) {
          bySipp[sipp] = {
            cheapest: listing.dailyPrice,
            cheapestTotal: listing.totalPrice,
            cheapestVendor: listing.vendor,
            effectiveDailySum: effectiveDaily != null ? effectiveDaily : 0,
            effectiveDailyCount: effectiveDaily != null ? 1 : 0,
            sampled: 1
          };
        } else {
          if (listing.dailyPrice < bySipp[sipp].cheapest) {
            bySipp[sipp].cheapest = listing.dailyPrice;
            bySipp[sipp].cheapestTotal = listing.totalPrice;
            bySipp[sipp].cheapestVendor = listing.vendor;
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

    if (i < LOOK_AHEAD_DAYS - 1) {
      const delay = DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
      await sleep(delay);
    }
  }

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
  console.log(`=== Done in ${totalElapsed}s — ${okCount} ok, ${errCount} err, ${totalResults} raw results, ${rows.length} pricing rows ===`);

  await writeXlsx(OUTPUT_PATH, rows, {
    provider: 'apify',
    actor: ACTOR_ID,
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
    totalResults,
    totalRows: rows.length
  });
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
