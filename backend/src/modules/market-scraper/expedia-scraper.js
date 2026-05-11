/**
 * Pure Expedia scraping helpers — no DB, no CLI, no XLSX.
 *
 * Extracted from scripts/market-scraper/scrape-expedia.mjs so the same
 * extraction + URL-building logic can be reused by:
 *   - the standalone CLI (scripts/market-scraper/scrape-expedia.mjs) for
 *     one-off manual runs
 *   - the DB-driven runner (market-scrape-runner.service.js) which executes a
 *     MarketScrapeProfile and persists MarketObservation rows
 *
 * Anti-detection rules baked in here (from Hector's industry knowledge — see
 * project_market_scraper memory):
 *   - pickup/return times are randomized within business hours (never round
 *     :00 minutes — Expedia inflates prices for the default values as a
 *     tripwire)
 *   - pickup date must be >= today + 1 day (callers enforce this; we don't
 *     validate it here so tests can use fixed past dates)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default location of the category-to-SIPP map shipped in the repo. */
export const DEFAULT_SIPP_MAP_PATH = join(
  __dirname, '..', '..', '..', 'scripts', 'market-scraper', 'category-sipp-map.json'
);

export function loadSippMap(path = DEFAULT_SIPP_MAP_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Map an Expedia category label (e.g. "Mini Van", "Standard SUV") to its SIPP
 * code. Tries exact match first (case-insensitive), then longest-keyword
 * fallback. Returns null when nothing matches — callers store the observation
 * with status=UNMAPPED so we can grow the SIPP map over time.
 */
export function categoryToSipp(category, sippMap) {
  if (!category) return null;
  const norm = category.trim();
  for (const [k, v] of Object.entries(sippMap.exact || {})) {
    if (k.toLowerCase() === norm.toLowerCase()) return v;
  }
  const low = norm.toLowerCase();
  const sorted = [...(sippMap.keyword_fallback || [])]
    .sort((a, b) => b[0].length - a[0].length);
  for (const [kw, sipp] of sorted) {
    if (low.includes(kw.toLowerCase())) return sipp;
  }
  return null;
}

// ----- Time / date helpers -----------------------------------------------

const BUSINESS_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const NON_DEFAULT_MINUTES = [15, 30, 45]; // never :00 (anti-detection)

function pad2(n) { return String(n).padStart(2, '0'); }

export function randomBusinessTime(rand = Math.random) {
  const hour24 = BUSINESS_HOURS[Math.floor(rand() * BUSINESS_HOURS.length)];
  const min = NON_DEFAULT_MINUTES[Math.floor(rand() * NON_DEFAULT_MINUTES.length)];
  const isPm = hour24 >= 12;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}${pad2(min)}${isPm ? 'PM' : 'AM'}`;
}

export function isoToMDY(date) {
  // "M/D/YYYY" with no zero-padding — matches Expedia's expected format.
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`;
}

export function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function buildSearchUrl(airport, pickupDate, returnDate, { rand } = {}) {
  const params = new URLSearchParams({
    locn: airport,
    date1: isoToMDY(pickupDate),
    date2: isoToMDY(returnDate),
    styp: '1',
    fdrp: '0',
    kind: '1',
    time1: randomBusinessTime(rand),
    time2: randomBusinessTime(rand),
    dagv: '1',
    subm: '1',
    paandi: 'true'
  });
  return `https://www.expedia.com/carsearch?${params.toString()}`;
}

// ----- Listing extraction (runs inside the Playwright page) --------------

/**
 * The function injected into the browser page via page.evaluate(). Walks
 * every [data-stid="car-offer-card"], pulls category/model/dailyPrice/
 * totalPrice/vendor, and filters out promo badges (Great Deal, Top Pick,
 * etc.) so the first non-badge line is taken as the category.
 *
 * Exported as a string-able function so the runner + CLI both inject the
 * same body (page.evaluate stringifies the function automatically).
 */
export function pageExtractListings() {
  const carClassRe = /Economy|Compact|Mid-?size|Intermediate|Full[- ]?size|Premium|Luxury|SUV|Minivan|Standard|Mini|Convertible|Sports?|Van|Pickup/i;
  const totalPriceRe = /\$(\d+(?:\.\d{2})?)\s*total/i;
  const promoBadgeRe = /^(great deal|best deal|deal|hot deal|limited time|best match|most popular|recommended|top pick)$/i;

  const cards = document.querySelectorAll('[data-stid="car-offer-card"]');
  const out = [];
  for (const card of cards) {
    const text = (card.innerText || '').trim();
    if (!carClassRe.test(text)) continue;
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);

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

    const amounts = [...text.matchAll(/\$(\d+(?:\.\d{2})?)(?!\s*total)/gi)]
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n) && n > 0);
    const dailyPrice = amounts.length ? amounts[0] : null;

    const totalMatch = text.match(totalPriceRe);
    const totalPrice = totalMatch ? Number(totalMatch[1]) : null;

    let vendor = null;
    const imgs = card.querySelectorAll('img[alt]');
    for (const img of imgs) {
      const alt = (img.getAttribute('alt') || '').trim();
      if (/Hertz|Avis|Enterprise|Budget|National|Alamo|Thrifty|Dollar|Sixt|Payless|Fox|Europcar|Ace|Routes|Easirent|NU|Advantage/i.test(alt)) {
        vendor = alt;
        break;
      }
    }

    out.push({ category, model, dailyPrice, totalPrice, vendor, badge });
  }
  return out;
}

export async function extractListings(page) {
  return page.evaluate(pageExtractListings);
}

/**
 * Scrape a single (airport, pickup, return) search on Expedia. Returns
 *   - { url, listings: [...], elapsedSec } on success
 *   - { url, listings: [], error } on nav timeout / soft-block / no-results
 *
 * Does NOT throw on Expedia errors so the caller can keep iterating through
 * the look-ahead window even when individual days fail.
 */
export async function scrapeOneSearch(page, opts) {
  const {
    airport,
    pickupDate,
    returnDate,
    navTimeoutMs = 90_000,
    priceTimeoutMs = 60_000,
    settleMs = 2000
  } = opts;
  const url = buildSearchUrl(airport, pickupDate, returnDate);
  const tStart = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
  } catch (err) {
    return { url, listings: [], error: `nav: ${err.message}` };
  }

  try {
    await page.waitForFunction(
      () => {
        const t = document.body.innerText || '';
        return /\$\d+/.test(t) || /technical problems|adjust your search|no.*results found/i.test(t);
      },
      { timeout: priceTimeoutMs }
    );
  } catch {
    return { url, listings: [], error: 'timeout waiting for prices or error message' };
  }

  const errSignal = await page.evaluate(() => {
    const t = document.body.innerText || '';
    if (/technical problems/i.test(t)) return 'expedia-technical-problems';
    if (/no.*results found|no.*available/i.test(t)) return 'expedia-no-results';
    return null;
  });
  if (errSignal) return { url, listings: [], error: errSignal };

  if (settleMs > 0) await page.waitForTimeout(settleMs);

  const listings = await extractListings(page);
  const elapsedSec = ((Date.now() - tStart) / 1000).toFixed(1);
  return { url, listings, elapsedSec };
}

/**
 * Connect to a Bright Data Browser API endpoint via CDP and return a
 * Playwright-like session object the runner can use:
 *   { page, scrapeOneSearch, wait, close }
 *
 * playwright-core is a devDependency — we import it lazily so test runs that
 * mock the scraper interface don't pay the cost of loading playwright.
 */
export async function createExpediaSession({ cdpUrl, ...opts } = {}) {
  if (!cdpUrl) {
    const e = new Error('cdpUrl is required (set BRIGHTDATA_SB_URL)');
    e.httpStatus = 400;
    throw e;
  }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();

  return {
    page,
    async scrapeOneSearch(searchOpts) {
      return scrapeOneSearch(page, { ...opts, ...searchOpts });
    },
    async wait(ms) {
      await page.waitForTimeout(ms);
    },
    async close() {
      try { await browser.close(); } catch (_) { /* swallow */ }
    }
  };
}
