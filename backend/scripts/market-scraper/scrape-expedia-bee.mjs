#!/usr/bin/env node
/**
 * Expedia car-rental market scraper — ScrapingBee variant.
 *
 * Replacement for scrape-expedia.mjs (which used Bright Data Browser API via
 * Playwright/CDP) after Bright Data support confirmed on 2026-05-14 that
 * they enforce Expedia's robots.txt at the proxy level and cannot whitelist
 * the site. See memory entry `feedback_brightdata_expedia_dead_end.md`.
 *
 * ScrapingBee doesn't enforce robots.txt — they ship a managed headless
 * browser as an HTTP endpoint. We GET their API, they return the rendered
 * HTML, we extract listings with cheerio. No CDP, no websocket, no session
 * recycling needed.
 *
 * Usage:
 *   export SCRAPINGBEE_API_KEY='R5...'
 *   node scripts/market-scraper/scrape-expedia-bee.mjs \
 *     --airport sju --look-ahead 15 --lor 3 \
 *     --strategy cheapest_minus --strategy-amount 1 \
 *     --output /tmp/sju.xlsx
 *
 * Cost (as of signup tier $49/mo Freelance — 150K credits):
 *   - One render_js + premium_proxy request = ~75 credits
 *   - 15-day scrape = 15 * 75 = 1,125 credits = ~$0.37
 *   - Compare to Bright Data Browser API $0.18-0.25, similar order of magnitude
 *
 * @see backend/scripts/market-scraper/category-sipp-map.json (shared SIPP map)
 * @see project_market_scraper memory
 */

import * as cheerio from 'cheerio';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
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

const API_KEY = process.env.SCRAPINGBEE_API_KEY || args['api-key'] || '';
const AIRPORT = String(args.airport || 'sju').toLowerCase();
const LOOK_AHEAD_DAYS = Number(args['look-ahead'] || 15);
const LOR_DAYS = Number(args.lor || 3);
const STRATEGY = String(args.strategy || 'cheapest_minus').toLowerCase();
const STRATEGY_AMOUNT = Number(args['strategy-amount'] ?? 1);
const STRATEGY_PCT = Number(args['strategy-pct'] ?? 5);
const STRATEGY_FLOOR = Number(args['strategy-floor'] ?? 0);
const OUTPUT_PATH = args.output || resolve(__dirname, `out-${AIRPORT}-${Date.now()}.xlsx`);
// 60s default — ScrapingBee's headless browser takes longer than direct CDP
// because we're going through their queue. Real timeout per request observed
// at 35-55s on render_js=true + premium_proxy=true requests.
const REQUEST_TIMEOUT_MS = Number(args['request-timeout'] || 90_000);
const DELAY_MIN_MS = Number(args['delay-min'] || 2_000);
const DELAY_MAX_MS = Number(args['delay-max'] || 8_000);
const PREMIUM_PROXY = args['no-premium-proxy'] !== true; // default ON for Expedia
const DEBUG = args.debug === true;

if (!API_KEY) {
  console.error('FAIL: set $SCRAPINGBEE_API_KEY or pass --api-key');
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

// ----- Category → SIPP map (shared with the legacy Playwright script) -----

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
  if (STRATEGY_FLOOR > 0 && suggested < STRATEGY_FLOOR) suggested = STRATEGY_FLOOR;
  return Number(suggested.toFixed(2));
}

// ----- Date + URL helpers (same anti-detection rules as legacy script) ----

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

function buildExpediaUrl(airport, pickupDate, returnDate) {
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

// ----- ScrapingBee request + cheerio extract ------------------------------

function buildBeeUrl(expediaUrl) {
  const params = new URLSearchParams({
    api_key: API_KEY,
    url: expediaUrl,
    render_js: 'true',
    // premium_proxy uses ScrapingBee's residential pool — needed because
    // Expedia rate-limits / fingerprints datacenter IPs aggressively.
    premium_proxy: PREMIUM_PROXY ? 'true' : 'false',
    country_code: 'us',
    // wait_for blocks the ScrapingBee server until the selector renders,
    // OR until wait_browser=load is reached. Combined, we don't need our
    // own polling — we get HTML with cards already in it.
    wait_for: '[data-stid="car-offer-card"]',
    wait: '3000',
    block_ads: 'true'
  });
  return `https://app.scrapingbee.com/api/v1?${params.toString()}`;
}

function extractListingsFromHtml(html) {
  const $ = cheerio.load(html);
  const carClassRe = /Economy|Compact|Mid-?size|Intermediate|Full[- ]?size|Premium|Luxury|SUV|Minivan|Standard|Mini|Convertible|Sports?|Van|Pickup/i;
  const totalPriceRe = /\$(\d+(?:\.\d{2})?)\s*total/i;
  const promoBadgeRe = /^(great deal|best deal|deal|hot deal|limited time|best match|most popular|recommended|top pick)$/i;
  const vendorRe = /Hertz|Avis|Enterprise|Budget|National|Alamo|Thrifty|Dollar|Sixt|Payless|Fox|Europcar|Ace|Routes|Easirent|NU|Advantage/i;

  const out = [];
  $('[data-stid="car-offer-card"]').each((_, el) => {
    // Pull the card's text content with newlines preserved (cheerio's .text()
    // collapses whitespace by default, so we walk children to keep <br>/<div>
    // boundaries that the legacy Playwright innerText kept).
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    // Use the *unflattened* text from a small DOM walk for line splits.
    const innerText = $(el).find('*').contents().filter(function () {
      return this.type === 'text';
    }).map(function () {
      return $(this).text().trim();
    }).get().filter(Boolean);

    const cardBlob = innerText.join('\n');
    if (!carClassRe.test(cardBlob)) return;

    const lines = innerText;
    let category = null;
    let model = null;
    let badge = null;
    for (let j = 0; j < Math.min(8, lines.length); j += 1) {
      const line = lines[j];
      if (promoBadgeRe.test(line)) { badge = line; continue; }
      if (carClassRe.test(line) && !category) {
        category = line;
        model = lines[j + 1] || null;
        break;
      }
    }
    if (!category) {
      category = lines[0] || null;
      model = lines[1] || null;
    }

    // Daily price: first $ not followed by "total". Search both `text` (one
    // flattened line, easier for regex) and individual lines.
    const amounts = [...cardBlob.matchAll(/\$(\d+(?:\.\d{2})?)(?!\s*total)/gi)]
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n) && n > 0);
    const dailyPrice = amounts.length ? amounts[0] : null;

    const totalMatch = cardBlob.match(totalPriceRe);
    const totalPrice = totalMatch ? Number(totalMatch[1]) : null;

    // Vendor: image alt text inside the card.
    let vendor = null;
    $(el).find('img[alt]').each((_, img) => {
      if (vendor) return;
      const alt = ($(img).attr('alt') || '').trim();
      if (vendorRe.test(alt)) vendor = alt;
    });

    out.push({ category, model, dailyPrice, totalPrice, vendor, badge });
  });
  return out;
}

async function scrapeOneSearchViaBee(expediaUrl) {
  const beeUrl = buildBeeUrl(expediaUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let r;
  try {
    r = await fetch(beeUrl, { signal: controller.signal });
  } catch (err) {
    return { url: expediaUrl, listings: [], error: `fetch: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    // ScrapingBee uses 4xx/5xx for various conditions. 400 often = JS render
    // failed or selector never appeared; 429 = quota; 500 = upstream proxy died.
    return { url: expediaUrl, listings: [], error: `bee-${r.status}: ${body.slice(0, 200)}` };
  }

  const html = await r.text();
  if (DEBUG) console.log(`    (got ${html.length} bytes from ScrapingBee)`);

  // Soft-block detection: Expedia sometimes returns the carsearch shell with
  // a generic "technical problems" banner.
  if (/technical problems/i.test(html)) {
    return { url: expediaUrl, listings: [], error: 'expedia-technical-problems' };
  }
  if (/no\s+results\s+found|no\s+cars\s+available/i.test(html)) {
    return { url: expediaUrl, listings: [], error: 'expedia-no-results' };
  }

  const listings = extractListingsFromHtml(html);
  return { url: expediaUrl, listings };
}

// ----- XLSX output (identical to the legacy script) ----------------------

async function writeXlsx(outputPath, rows, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RideFleet market scraper (ScrapingBee)';
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
  console.log('=== Market scraper (ScrapingBee) ===');
  console.log(`Airport:       ${AIRPORT.toUpperCase()}`);
  console.log(`Look-ahead:    ${LOOK_AHEAD_DAYS} days`);
  console.log(`LOR:           ${LOR_DAYS} days`);
  console.log(`Strategy:      ${STRATEGY} amount=${STRATEGY_AMOUNT} pct=${STRATEGY_PCT} floor=${STRATEGY_FLOOR}`);
  console.log(`Output:        ${OUTPUT_PATH}`);
  console.log(`Premium proxy: ${PREMIUM_PROXY ? 'on' : 'off'}`);
  console.log(`Delay between: ${DELAY_MIN_MS}-${DELAY_MAX_MS}ms`);
  console.log('');

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const startPickup = addDays(today, 1);

  const agg = {};
  let okCount = 0;
  let errCount = 0;

  for (let i = 0; i < LOOK_AHEAD_DAYS; i += 1) {
    const pickup = addDays(startPickup, i);
    const ret = addDays(pickup, LOR_DAYS);
    const pickupISO = pickup.toISOString().slice(0, 10);
    const expediaUrl = buildExpediaUrl(AIRPORT, pickup, ret);

    process.stdout.write(`[${i + 1}/${LOOK_AHEAD_DAYS}] ${pickupISO} -> ${ret.toISOString().slice(0, 10)} ... `);
    const tStart = Date.now();
    const result = await scrapeOneSearchViaBee(expediaUrl);
    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);

    if (result.error) {
      errCount += 1;
      console.log(`ERR: ${result.error} (${elapsed}s)`);
    } else {
      okCount += 1;
      console.log(`${result.listings.length} listings (${elapsed}s)`);

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

    if (i < LOOK_AHEAD_DAYS - 1) {
      const delay = DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
      await sleep(delay);
    }
  }

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
    provider: 'scrapingbee',
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
    premiumProxy: PREMIUM_PROXY
  });
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
