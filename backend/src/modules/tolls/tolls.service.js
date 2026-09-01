import { prisma } from '../../lib/prisma.js';
import { issueCenterService } from '../issue-center/issue-center.service.js';
import { evaluateTollBillingPolicy } from './tolls-billing-policy.service.js';
import {
  DISPATCH_CONFIRMATION_REVIEW_CATEGORY,
  appendReviewCategory,
  clearDispatchConfirmationReview,
  inferReviewCategory,
  reservationReferencesVehicle,
  resolveReservationResponsibility
} from './tolls-responsibility.service.js';
import { parseLocationConfig } from '../../lib/location-config.js';
import { countQueues } from './tolls-queue-counts.js';
import { buildTollListWhere, buildTollExportWhere, tollsToCsv, tollExportFilename, TOLL_EXPORT_MAX_ROWS } from './tolls-export.js';
import { scopeAllowedLocationIds, reservationLocationWhere, systemScope } from '../../lib/tenant-scope.js';
import { sendEmail } from '../../lib/mailer.js';
// beta.357 latent fix: the agreement-mirror catch already called logger.error
// but the import was missing - a mirror failure would have thrown
// ReferenceError out of the sync instead of logging. Only the failure path
// was affected, which is why tests (mirror succeeds) never tripped it.
import logger from '../../lib/logger.js';

const DEFAULT_PRE_PICKUP_GRACE_MINUTES = 120;
const DEFAULT_POST_RETURN_GRACE_MINUTES = 180;
const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
// Per-location re-match window (TollBridge finding (b)): CA statements post up
// to a month late, so LAX needs ~45 days — but raising the window GLOBALLY
// would reopen months-closed contracts at other sedes. The default stays
// conservative; each sede opts into a wider window via
// locationConfig.tolls.rematchWindowDays.
const DEFAULT_REMATCH_WINDOW_DAYS = 14;
const MAX_REMATCH_WINDOW_DAYS = 120;

/** Pure: per-sede toll settings from a parsed locationConfig. */
export function resolveTollLocationSettings(locationConfig = {}) {
  const cfg = locationConfig && typeof locationConfig === 'object' ? locationConfig : {};
  const raw = cfg.tolls || {};
  const windowDays = Number(raw.rematchWindowDays);
  const pickEmail = (value) => {
    const email = String(value || '').trim();
    return email && email.includes('@') ? email : null;
  };
  return {
    rematchWindowDays: Number.isFinite(windowDays) && windowDays > 0
      ? Math.min(Math.floor(windowDays), MAX_REMATCH_WINDOW_DAYS)
      : DEFAULT_REMATCH_WINDOW_DAYS,
    // Recipient: tolls.alertEmail is a specific override; the normal case
    // (Hector, 2026-07-26) is the sede's own email — locationConfig
    // .locationEmail, already editable in Settings -> Locations. No separate
    // config needed for LAX: set the location's email and alerts flow there.
    alertEmail: pickEmail(raw.alertEmail) || pickEmail(cfg.locationEmail)
  };
}
const AUTOEXPRESO_LOGIN_URL = 'https://www.autoexpreso.com/login?v=0.0.1';
const AUTOEXPRESO_BALANCE_URL = 'https://www.autoexpreso.com/dashboard/balance';
const SUNPASS_LOGIN_URL = 'https://www.sunpass.com/vector/account/home/accountLogin.do';
const SUNPASS_ACTIVITY_URL = 'https://www.sunpass.com/vector/account/transactions/webtransactionSearch.do';
const AUTOEXPRESO_USERNAME_SELECTOR = "input[placeholder='Usuario o Correo Electronico'], input[placeholder='Usuario o Correo Electrónico'], input[placeholder*='Usuario'], input[placeholder*='Correo'], input[type='email'], input[type='text']";
const AUTOEXPRESO_PASSWORD_SELECTOR = "input[formcontrolname='password'], input[type='password']";
const AUTOEXPRESO_ACTIVITY_SELECTOR = 'div.az-media-list-activity';
const tollSyncLocks = new Set();

// Phase 0 (2026-06-09): toll scrapers no longer launch their own throwaway
// Chromium per run. They go through the shared singleton browser + the
// process-wide concurrent-page cap in lib/puppeteer-browser.js (see
// PUPPETEER_MAX_CONCURRENT_PAGES). Lazy import preserves the old friendly
// error on environments without puppeteer installed.
let _tollWithPage = null;
async function resolveTollWithPage() {
  if (_tollWithPage) return _tollWithPage;
  try {
    const mod = await import('../../lib/puppeteer-browser.js');
    _tollWithPage = mod.withPage;
  } catch {
    throw new Error('Puppeteer is not installed on backend for live toll sync');
  }
  return _tollWithPage;
}

async function resolveActiveProvider(tenantId) {
  if (!tenantId) return 'AUTOEXPRESO';
  const accounts = await prisma.tollProviderAccount.findMany({
    where: { tenantId, isActive: true },
    select: { provider: true },
    orderBy: [{ updatedAt: 'desc' }]
  });
  if (accounts.length) return accounts[0].provider;
  // Fallback: check any account even if inactive
  const any = await prisma.tollProviderAccount.findFirst({
    where: { tenantId },
    select: { provider: true },
    orderBy: [{ updatedAt: 'desc' }]
  });
  return any?.provider || 'AUTOEXPRESO';
}

function tenantWhereForScope(scope = {}) {
  return scope?.tenantId ? { tenantId: scope.tenantId } : {};
}

/**
 * Location scoping for tolls (2026-07-24). Exact mirror of
 * `citationLocationWhere` in the citations module, and for the same reason: a
 * TollTransaction has NO Location FK — its `location` column is the free-text
 * plaza name off the provider feed ("PLAZA TEODORO MOSCOSO") — so the only
 * reliable link to an RFM location is the vehicle the toll was matched to. We
 * scope through `vehicle.homeLocationId`.
 *
 * UNMATCHED tolls (vehicleId = null) have no resolvable location and are
 * therefore hidden from a location-scoped caller — fail-closed, and the same
 * rule citations use. They stay visible to tenant-wide admins, who are the ones
 * that triage and match them anyway. This matters more here than in citations:
 * the needsReview queue is mostly unmatched rows, so a branch user sees an empty
 * review list rather than another branch's plates.
 *
 * Returns {} when the caller is unrestricted, so it composes into any `where`.
 *
 * NOT applied to the money paths (`syncReservationTollCharges`,
 * `voidTollTransaction`) — see the note on those.
 */
export function tollLocationWhere(scope = {}) {
  const ids = scopeAllowedLocationIds(scope);
  if (!ids) return {};
  return { vehicle: { is: { homeLocationId: { in: ids } } } };
}

function toMoney(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : fallback;
}

function normalizeToken(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
}

function normalizeComparableText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function clickAutoExpresoLoginButton(page) {
  const clicked = await page.evaluate(() => {
    const normalize = (value = '') => String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const candidates = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button']"));
    const target = candidates.find((element) => {
      const text = normalize(element.textContent || element.value || '');
      return text.includes('iniciar sesion') || text.includes('login') || text.includes('entrar');
    });
    if (!target) return false;
    target.click();
    return true;
  });

  if (!clicked) {
    await page.click("button[type='submit'], input[type='submit'], button");
  }
}

async function captureAutoExpresoPageState(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const hint = await page.evaluate(() => {
    const text = String(document.body?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 280);
    return text;
  }).catch(() => '');

  return {
    url,
    title: String(title || '').trim(),
    hint: String(hint || '').trim()
  };
}

async function waitForAutoExpresoTransactionState(page, timeoutMs = 30000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await page.$(AUTOEXPRESO_ACTIVITY_SELECTOR)) return 'transactions';

    const state = await page.evaluate(({ usernameSelector, passwordSelector }) => {
      const normalize = (value = '') => String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const bodyText = normalize(document.body?.innerText || '');
      const hasUsername = !!document.querySelector(usernameSelector);
      const hasPassword = !!document.querySelector(passwordSelector);
      const pathname = window.location.pathname || '';

      if ((hasUsername && hasPassword) || pathname.includes('/login')) {
        return 'login';
      }
      if (pathname.includes('/dashboard/balance') || bodyText.includes('ultimas transacciones') || bodyText.includes('últimas transacciones') || bodyText.includes('transacciones pendientes')) {
        return 'transactions';
      }
      if (bodyText.includes('estado de cuenta') || bodyText.includes('seleccione el mes y ano deseado') || bodyText.includes('seleccione el mes y año deseado')) {
        return 'account-statements';
      }
      if (bodyText.includes('captcha') || bodyText.includes('robot')) {
        return 'captcha';
      }
      if (bodyText.includes('credenciales') || bodyText.includes('incorrect') || bodyText.includes('intente nuevamente')) {
        return 'auth-error';
      }
      if (bodyText.includes('dashboard') || bodyText.includes('transacciones')) {
        return 'dashboard-loading';
      }
      return '';
    }, {
      usernameSelector: AUTOEXPRESO_USERNAME_SELECTOR,
      passwordSelector: AUTOEXPRESO_PASSWORD_SELECTOR
    }).catch(() => '');

    if (state) return state;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return 'timeout';
}

async function waitForAutoExpresoRows(page, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const hasRows = await page.evaluate(() => {
      const text = String(document.body?.innerText || '');
      return /Tablilla:\s*[A-Z0-9-]+/i.test(text) && /Peaje:/i.test(text);
    }).catch(() => false);
    if (hasRows) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function scrapeAutoExpresoBalanceRows(page) {
  return page.evaluate(() => {
    const normalize = (value = '') => String(value).replace(/\s+/g, ' ').trim();
    const amountFromText = (value = '') => {
      const match = String(value).match(/\$\s*-?\s*\d[\d,]*\.?\d*/);
      if (!match) return null;
      const parsed = Number(match[0].replace(/[^0-9.-]/g, ''));
      return Number.isFinite(parsed) ? Math.abs(parsed) : null;
    };

    const rows = [];
    const seen = new Set();
    const addCandidate = (raw) => {
      const plateRaw = normalize(raw.plateRaw || '');
      const selloRaw = normalize(raw.selloRaw || '');
      const datetimeFull = normalize(raw.datetimeFull || '');
      const location = normalize(raw.location || '');
      const amountRaw = normalize(raw.amountRaw || '');
      const key = `${plateRaw}|${selloRaw}|${datetimeFull}|${amountRaw}|${location}`;
      if (!plateRaw || !datetimeFull || !amountRaw || seen.has(key)) return;
      seen.add(key);
      rows.push({
        plateRaw,
        selloRaw,
        amountRaw,
        location,
        datetimeFull,
        rawText: normalize(raw.rawText || '')
      });
    };

    const bodyText = String(document.body?.innerText || '');
    const recordRegex = /(?:VEH[IÍ]CULO:\s*([^\n\r]+)\s*[\r\n]+)?Tablilla:\s*([A-Z0-9-]+)\s*[\r\n]+Sello:\s*([A-Z0-9-]+)\s*[\r\n]+\$\s*(-?\d[\d,]*\.?\d*)\s*[\r\n]+Peaje:\s*([^\n\r]+)\s*[\r\n]+(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*[AP]M)/gi;
    for (const match of bodyText.matchAll(recordRegex)) {
      addCandidate({
        plateRaw: match[2] || '',
        selloRaw: match[3] || '',
        amountRaw: `$${match[4] || ''}`,
        location: match[5] || '',
        datetimeFull: match[6] || '',
        rawText: match[0] || ''
      });
    }

    const blocks = Array.from(document.querySelectorAll('div, li, article, section'));

    for (const node of blocks) {
      const rawText = String(node.innerText || '').trim();
      const text = normalize(rawText);
      if (!text) continue;
      if (!/tablilla:/i.test(text)) continue;
      if (!/peaje:/i.test(text)) continue;
      if (!/\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*[AP]M/i.test(text)) continue;

      const plateMatch = rawText.match(/Tablilla:\s*([A-Z0-9-]+)/i);
      const selloMatch = rawText.match(/Sello:\s*([A-Z0-9-]+)/i);
      const peajeMatch = rawText.match(/Peaje:\s*([^\n\r]+)/i);
      const dateMatch = rawText.match(/\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*[AP]M/i);
      const amountMatch = rawText.match(/\$\s*-?\s*\d[\d,]*\.?\d*/i);

      addCandidate({
        plateRaw: plateMatch ? plateMatch[1] : '',
        selloRaw: selloMatch ? selloMatch[1] : '',
        amountRaw: amountMatch ? amountMatch[0] : '',
        location: peajeMatch ? peajeMatch[1] : '',
        datetimeFull: dateMatch ? dateMatch[0] : '',
        rawText
      });
    }

    const chunks = bodyText.split(/(?=Tablilla:\s*[A-Z0-9-]+)/i);
    for (const chunk of chunks) {
      const rawText = String(chunk || '').trim();
      if (!rawText) continue;
      if (!/tablilla:/i.test(rawText) || !/peaje:/i.test(rawText)) continue;
      const plateMatch = rawText.match(/Tablilla:\s*([A-Z0-9-]+)/i);
      const selloMatch = rawText.match(/Sello:\s*([A-Z0-9-]+)/i);
      const peajeMatch = rawText.match(/Peaje:\s*([^\n\r]+)/i);
      const dateMatch = rawText.match(/\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*[AP]M/i);
      const amountLines = String(rawText)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^\$\s*-?\s*\d[\d,]*\.?\d*$/.test(line));
      const amountMatch = amountLines.length
        ? [amountLines[amountLines.length - 1]]
        : rawText.match(/\$\s*-?\s*\d[\d,]*\.?\d*/i);
      addCandidate({
        plateRaw: plateMatch ? plateMatch[1] : '',
        selloRaw: selloMatch ? selloMatch[1] : '',
        amountRaw: amountMatch ? amountMatch[0] : '',
        location: peajeMatch ? peajeMatch[1] : '',
        datetimeFull: dateMatch ? dateMatch[0] : '',
        rawText
      });
    }

    return rows
      .map((row) => ({
        ...row,
        amount: amountFromText(row.amountRaw)
      }))
      .filter((row) => row.plateRaw && row.datetimeFull && row.amount !== null);
  });
}

async function clickAutoExpresoNextPage(page) {
  return page.evaluate(() => {
    const normalize = (value = '') => String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    const candidates = Array.from(document.querySelectorAll('a, button'));
    const next = candidates.find((element) => {
      const text = normalize(element.textContent || element.value || '');
      const aria = normalize(element.getAttribute('aria-label') || '');
      const parentClass = normalize(element.parentElement?.className || '');
      const disabled = element.hasAttribute('disabled') || parentClass.includes('disabled');
      if (disabled) return false;
      return aria.includes('next') || text === '»' || text === '›' || text === 'siguiente';
    });

    if (!next) return false;
    next.click();
    return true;
  });
}

function normalizeNullableToken(value) {
  const normalized = normalizeToken(value);
  return normalized || null;
}

function normalizeDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('transactionAt is invalid');
  return date;
}

function safeJsonParse(value, fallback) {
  try {
    if (!value) return fallback;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

function startOfDay(date) {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
}

function mergeChargeNotes(existing, nextNote) {
  const base = String(existing || '').trim();
  const incoming = String(nextNote || '').trim();
  if (!incoming) return base || null;
  if (!base) return incoming;
  if (base.includes(incoming)) return base;
  return `${base}\n${incoming}`;
}

function transactionCoveredByTollPackage(row = {}) {
  return String(row?.reviewNotes || '').toLowerCase().includes('covered by prepaid toll package');
}

function transactionUsageOnly(row = {}) {
  return transactionCoveredByTollPackage(row);
}

function transactionStatusLabel(status) {
  return String(status || '').replaceAll('_', ' ').toLowerCase();
}

function encodeSecret(value) {
  return value ? Buffer.from(String(value), 'utf8').toString('base64') : null;
}

function decodeSecret(value) {
  if (!value) return '';
  try {
    return Buffer.from(String(value), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function serializeProviderAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    isActive: !!row.isActive,
    locationId: row.locationId || null,
    username: row.username || '',
    settings: safeJsonParse(row.settingsJson, {}),
    lastSyncAt: row.lastSyncAt,
    lastSyncStatus: row.lastSyncStatus || '',
    lastSyncMessage: row.lastSyncMessage || '',
    hasPassword: !!row.passwordEncrypted
  };
}

function serializeImportRun(row) {
  return {
    id: row.id,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    sourceType: row.sourceType || '',
    status: row.status || '',
    importedCount: Number(row.importedCount || 0),
    matchedCount: Number(row.matchedCount || 0),
    reviewCount: Number(row.reviewCount || 0),
    errorMessage: row.errorMessage || '',
    metadata: safeJsonParse(row.metadataJson, {})
  };
}

function buildSyncSummaryMessage(summary = {}) {
  const scrapedCount = Number(summary.scrapedCount || 0);
  const dedupedInRunCount = Number(summary.dedupedInRunCount || 0);
  const duplicateExistingCount = Number(summary.duplicateExistingCount || 0);
  const importedCount = Number(summary.importedCount || 0);
  if (scrapedCount > 0 || dedupedInRunCount > 0 || duplicateExistingCount > 0) {
    return `Scraped ${scrapedCount} | Imported ${importedCount} | Existing duplicates ${duplicateExistingCount} | Deduped in run ${dedupedInRunCount}`;
  }
  return `Imported ${importedCount}`;
}

function parseAutoExpresoDateTime(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('AutoExpreso transaction date/time missing');
  const match = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(.+)/);
  if (!match) throw new Error(`Unsupported AutoExpreso date/time: ${text}`);
  const [, day, month, year, timePart] = match;
  const parsed = new Date(`${month}/${day}/${year} ${timePart}`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Unsupported AutoExpreso date/time: ${text}`);
  return parsed;
}

// ─── SunPass scraper helpers ───

async function sunpassLogin(page, username, password) {
  await page.goto(SUNPASS_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 45000 });
  // The SunPass (Conduent "vector") portal was redesigned: the old ids
  // loginUsername/loginPassword are gone. The page now renders TWO responsive copies
  // of the login form (desktop ids tt_username/tt_loginPassword, mobile ids
  // tt_username1/tt_loginPassword1, names loginName/password and login/loginPassword),
  // plus an unrelated FAQ search box (name="sy"). Resolve robustly by visibility +
  // context so a future id rename can't break us again: pick the VISIBLE password
  // input, then the username text input in its form (by acct/user placeholder/name,
  // never the FAQ search), then the "Login" submit in that same form.
  await page.waitForSelector('input[type="password"]', { timeout: 25000 });
  const resolved = await page.evaluate(() => {
    const isVisible = (el) => !!el && el.offsetParent !== null && el.getBoundingClientRect().height > 0;
    const pw = Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible)
      || document.querySelector('input[type="password"]');
    if (!pw) return null;
    const form = pw.closest('form');
    const scope = form || document;
    const texts = Array.from(scope.querySelectorAll('input[type="text"], input:not([type])'))
      .filter((i) => (i.name || '') !== 'sy' && !/search/i.test(i.placeholder || ''));
    let user = texts.filter(isVisible).find((i) => /acct|user|login/i.test(`${i.placeholder || ''} ${i.name || ''}`))
      || texts.find(isVisible) || texts[0];
    const btn = Array.from(scope.querySelectorAll('button[type="submit"], input[type="submit"], button'))
      .find((b) => /log\s*in/i.test(b.textContent || b.value || ''));
    if (btn) btn.setAttribute('data-rf-login', '1');
    const sel = (el) => (el ? (el.id ? `#${el.id}` : (el.name ? `[name="${el.name}"]` : null)) : null);
    return { user: sel(user), pass: sel(pw), userName: user && user.name, passName: pw && pw.name, hasBtn: !!btn };
  });
  if (!resolved || !resolved.user || !resolved.pass) {
    throw new Error('SunPass login fields not found (login page layout changed)');
  }
  await page.click(resolved.user, { clickCount: 3 }).catch(() => null);
  await page.type(resolved.user, username);
  await page.click(resolved.pass, { clickCount: 3 }).catch(() => null);
  await page.type(resolved.pass, password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null),
    page.evaluate(() => {
      const btn = document.querySelector('[data-rf-login="1"]')
        || Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"], button'))
          .find((b) => /log\s*in/i.test(b.textContent || b.value || ''));
      if (btn) btn.click();
    })
  ]);
}

async function sunpassNavigateToActivity(page) {
  await page.goto(SUNPASS_ACTIVITY_URL, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

async function sunpassFilterAndSearch(page, startStr, endStr) {
  // Set the filter controls by their REAL names (confirmed from the redesigned page):
  //   select[name=filterBy]   → "Toll Transaction"
  //   select[name=dateType]   → "Posted Date" (catches late-posting tolls in the window)
  //   input[name=startDateAll] / input[name=endDateAll] → MM/DD/YYYY range
  // Generic label-based fallbacks are kept in case of another rename.
  await page.evaluate(({ startStr, endStr }) => {
    const fire = (el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const pickOption = (sel, rx) => {
      if (!sel) return;
      const opt = Array.from(sel.options).find((o) => rx.test(o.text));
      if (opt) { sel.value = opt.value; fire(sel); }
    };
    const setInput = (el, val) => { if (el) { el.value = val; fire(el); } };

    // Filter By → Toll Transaction
    let filterBy = document.querySelector('select[name="filterBy"]');
    if (!filterBy) {
      filterBy = Array.from(document.querySelectorAll('select')).find((s) => /filter/i.test(`${s.name} ${s.id} ${s.previousElementSibling?.textContent || ''}`));
    }
    pickOption(filterBy, /toll\s*transaction/i);

    // Date Type → Posted Date
    let dateType = document.querySelector('select[name="dateType"]');
    if (!dateType) {
      dateType = Array.from(document.querySelectorAll('select')).find((s) => /date\s*type/i.test(`${s.name} ${s.id} ${s.previousElementSibling?.textContent || ''}`));
    }
    pickOption(dateType, /posted\s*date/i);

    // Date range
    let start = document.querySelector('input[name="startDateAll"]');
    let end = document.querySelector('input[name="endDateAll"]');
    if (!start || !end) {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      start = start || inputs.find((i) => /start|from/i.test(`${i.name} ${i.id} ${i.placeholder || ''}`));
      end = end || inputs.find((i) => /end|to\b/i.test(`${i.name} ${i.id} ${i.placeholder || ''}`));
    }
    setInput(start, startStr);
    setInput(end, endStr);
  }, { startStr, endStr });

  // Click the VIEW (search) button
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null),
    page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"], button, input[type="button"]'));
      const viewBtn = btns.find((b) => /^\s*view\s*$/i.test(String(b.textContent || b.value || '').trim()))
        || btns.find((b) => /view|search|submit/i.test(String(b.textContent || b.value || '')));
      if (viewBtn) viewBtn.click();
    })
  ]);

  await new Promise((resolve) => setTimeout(resolve, 3000));
}

async function scrapeSunPassRows(page) {
  return page.evaluate(() => {
    const normalize = (value = '') => String(value).replace(/\s+/g, ' ').trim();
    const amountFromText = (value = '') => {
      const match = String(value).match(/-?\$?\s*\d[\d,]*\.?\d*/);
      if (!match) return null;
      const parsed = Number(match[0].replace(/[^0-9.-]/g, ''));
      return Number.isFinite(parsed) ? Math.abs(parsed) : null;
    };

    const rows = [];
    const seen = new Set();

    // Redesigned SunPass activity table columns:
    //   PostedDate | TransactionDate | Transaction Details | TransactionTime |
    //   Transponder/License Plate | Description | Debit(-) | Credit(+) | Balance
    // The "Transaction Details" cell carries "Transaction Number: <id> ... Location:
    // ... Transaction Type: Transponder Toll". Detect by transponder/debit/details
    // headers (NOT the old plaza/amount), take the toll charge from Debit(-), the toll
    // id from the details blob, and skip credit/payment rows (blank debit).
    const tables = Array.from(document.querySelectorAll('table'));
    for (const table of tables) {
      const headerCells = Array.from(table.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td'));
      const headers = headerCells.map((cell) => normalize(cell.textContent).toLowerCase());
      const isTollTable = headers.some((h) => h.includes('transponder') || h.includes('debit') || h.includes('detail'));
      if (!isTollTable) continue;

      const colIdx = {
        transactionDate: headers.findIndex((h) => h.includes('transaction') && h.includes('date')),
        postedDate: headers.findIndex((h) => h.includes('posted')),
        details: headers.findIndex((h) => h.includes('detail')),
        time: headers.findIndex((h) => h.includes('time')),
        transponderPlate: headers.findIndex((h) => h.includes('transponder') || h.includes('license') || h.includes('plate')),
        location: headers.findIndex((h) => h.includes('description') || h.includes('location') || h.includes('plaza')),
        debit: headers.findIndex((h) => h.includes('debit') || h.includes('amount') || h.includes('charge'))
      };

      const bodyRows = Array.from(table.querySelectorAll('tbody tr, tr')).filter((tr) => tr.querySelectorAll('td').length >= 3);
      for (const tr of bodyRows) {
        const cells = Array.from(tr.querySelectorAll('td'));
        if (!cells.length) continue;
        const getText = (idx) => (idx >= 0 && idx < cells.length ? normalize(cells[idx].textContent) : '');

        const amount = amountFromText(getText(colIdx.debit));
        if (amount === null || amount <= 0) continue; // credit/payment/blank debit → not a toll charge

        const transactionDate = getText(colIdx.transactionDate) || getText(colIdx.postedDate);
        if (!transactionDate) continue;
        const transactionTime = getText(colIdx.time);
        const transponderPlate = getText(colIdx.transponderPlate);
        const location = getText(colIdx.location);
        const details = getText(colIdx.details);
        // Only real toll transactions (filter is a safety net if "Filter By" let others through).
        if (details && !/toll/i.test(details)) continue;
        const tnMatch = details.match(/transaction\s*number:?\s*(\w+)/i);
        const transactionNumber = tnMatch ? tnMatch[1] : '';

        const key = transactionNumber || `${transponderPlate}|${transactionDate}|${transactionTime}|${amount}|${location}`;
        if (seen.has(key)) continue;
        seen.add(key);

        rows.push({ transactionDate, transactionTime, transponderPlate, location, amount, transactionNumber, details: details.slice(0, 300) });
      }
    }

    return rows;
  });
}

function parseSunPassDateTime(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('SunPass transaction date/time missing');
  // Handle formats: MM/DD/YYYY HH:MM:SS AM/PM or MM/DD/YYYY
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  // Try manual parse for MM/DD/YYYY HH:MM:SS AM
  const match = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(.*)/);
  if (match) {
    const [, month, day, year, timePart] = match;
    const fallback = new Date(`${month}/${day}/${year} ${timePart || '12:00:00 PM'}`);
    if (!Number.isNaN(fallback.getTime())) return fallback;
  }
  throw new Error(`Unsupported SunPass date/time: ${text}`);
}

function serializeIssueIncidentSummary(incident) {
  if (!incident) return null;
  return {
    id: incident.id,
    status: incident.status || '',
    title: incident.title || '',
    createdAt: incident.createdAt || null,
    reservationId: incident.reservationId || incident.trip?.reservationId || null
  };
}

/**
 * Tolls phase 2 (Direction B evidence pane): the OTHER reservations this toll
 * was previously suggested against — the superseded/rejected assignments that
 * replaceSuggestedAssignments left behind when a re-match sweep moved the
 * suggestion. The current match run's losing candidates are NOT persisted
 * (buildMatchSuggestion computes them and stores only the winner), so this is
 * the honest subset we can show without re-running the matcher per row.
 * Purely additive and DB-free: it reads the `assignments` list the dashboard
 * query already includes — no new query fanout per row.
 */
export function serializeCandidateAssignments(assignments = []) {
  const list = Array.isArray(assignments) ? assignments : [];
  if (list.length < 2) return [];
  const latestReservationId = list[0]?.reservation?.id || list[0]?.reservationId || null;
  const seen = new Set();
  const out = [];
  for (const row of list.slice(1)) {
    const reservation = row?.reservation || null;
    if (!reservation?.id) continue;
    if (latestReservationId && reservation.id === latestReservationId) continue;
    if (seen.has(reservation.id)) continue;
    seen.add(reservation.id);
    out.push({
      id: row.id,
      status: row.status,
      confidence: row.confidence == null ? null : Number(row.confidence),
      matchReason: row.matchReason || '',
      reservation: {
        id: reservation.id,
        reservationNumber: reservation.reservationNumber,
        pickupAt: reservation.pickupAt,
        returnAt: reservation.returnAt
      }
    });
    if (out.length >= 3) break;
  }
  return out;
}

function serializeTransaction(row) {
  const latestAssignment = Array.isArray(row.assignments) && row.assignments.length ? row.assignments[0] : null;
  const reviewCategory = inferReviewCategory(row.reviewNotes || latestAssignment?.matchReason || '');
  const coveredByTollPackage = transactionCoveredByTollPackage(row);
  return {
    id: row.id,
    externalId: row.externalId || '',
    transactionAt: row.transactionAt,
    transactionDate: row.transactionDate,
    transactionTimeRaw: row.transactionTimeRaw || '',
    amount: toMoney(row.amount),
    location: row.location || '',
    lane: row.lane || '',
    direction: row.direction || '',
    plateRaw: row.plateRaw || '',
    plateNormalized: row.plateNormalized || '',
    tagRaw: row.tagRaw || '',
    tagNormalized: row.tagNormalized || '',
    selloRaw: row.selloRaw || '',
    selloNormalized: row.selloNormalized || '',
    status: row.status,
    statusLabel: transactionStatusLabel(row.status),
    billingStatus: row.billingStatus,
    needsReview: !!row.needsReview,
    reviewCategory,
    dispatchConfirmationRequired: reviewCategory === DISPATCH_CONFIRMATION_REVIEW_CATEGORY,
    coveredByTollPackage,
    billingMode: coveredByTollPackage ? 'USAGE_ONLY' : 'CHARGEABLE',
    matchConfidence: row.matchConfidence == null ? null : Number(row.matchConfidence),
    reviewNotes: row.reviewNotes || '',
    locationId: row.locationId || null,
    staffNotifiedAt: row.staffNotifiedAt || null,
    staffAckAt: row.staffAckAt || null,
    vehicle: row.vehicle ? {
      id: row.vehicle.id,
      internalNumber: row.vehicle.internalNumber,
      plate: row.vehicle.plate || '',
      tollTagNumber: row.vehicle.tollTagNumber || '',
      tollStickerNumber: row.vehicle.tollStickerNumber || '',
      make: row.vehicle.make || '',
      model: row.vehicle.model || '',
      year: row.vehicle.year || null
    } : null,
    reservation: row.reservation ? {
      id: row.reservation.id,
      reservationNumber: row.reservation.reservationNumber,
      status: row.reservation.status,
      pickupAt: row.reservation.pickupAt,
      returnAt: row.reservation.returnAt,
      workflowMode: row.reservation.workflowMode,
      customer: row.reservation.customer ? {
        id: row.reservation.customer.id,
        firstName: row.reservation.customer.firstName,
        lastName: row.reservation.customer.lastName
      } : null
    } : null,
    latestAssignment: latestAssignment ? {
      id: latestAssignment.id,
      status: latestAssignment.status,
      confidence: latestAssignment.confidence == null ? null : Number(latestAssignment.confidence),
      matchReason: latestAssignment.matchReason || '',
      reservation: latestAssignment.reservation ? {
        id: latestAssignment.reservation.id,
        reservationNumber: latestAssignment.reservation.reservationNumber,
        pickupAt: latestAssignment.reservation.pickupAt,
        returnAt: latestAssignment.reservation.returnAt
      } : null
    } : null,
    // Superseded suggestions pointing at OTHER reservations — the evidence
    // pane's "losing candidate" card (phase 2). See serializeCandidateAssignments.
    candidateAssignments: serializeCandidateAssignments(row.assignments),
    issueIncident: serializeIssueIncidentSummary(row.issueIncident)
  };
}

async function attachIssueIncidents(rows = [], scope = {}) {
  const transactions = Array.isArray(rows) ? rows : [];
  const tollTransactionIds = transactions.map((row) => row.id).filter(Boolean);
  if (!tollTransactionIds.length) return transactions;
  try {
    const incidents = await prisma.tripIncident.findMany({
      where: {
        type: 'TOLL',
        ...(scope?.tenantId ? {
          reservation: {
            is: {
              tenantId: scope.tenantId
            }
          }
        } : {}),
        OR: tollTransactionIds.map((id) => ({
          evidenceJson: { contains: id }
        }))
      },
      select: {
        id: true,
        status: true,
        title: true,
        createdAt: true,
        reservationId: true,
        evidenceJson: true
      },
      orderBy: [{ createdAt: 'desc' }]
    });

    const incidentByTollId = new Map();
    for (const incident of incidents) {
      const source = safeJsonParse(incident.evidenceJson, null);
      const tollTransactionId = source?.tollTransactionId ? String(source.tollTransactionId) : '';
      if (!tollTransactionId || incidentByTollId.has(tollTransactionId)) continue;
      incidentByTollId.set(tollTransactionId, incident);
    }

    return transactions.map((row) => ({
      ...row,
      issueIncident: incidentByTollId.get(row.id) || null
    }));
  } catch (error) {
    console.warn('[tolls] failed to attach issue incidents', error?.message || error);
    return transactions.map((row) => ({
      ...row,
      issueIncident: null
    }));
  }
}

async function ensureTenantAllowsTolls(scope = {}) {
  if (!scope?.tenantId) return;
  const tenant = await prisma.tenant.findUnique({
    where: { id: scope.tenantId },
    select: { tollsEnabled: true }
  });
  if (!tenant?.tollsEnabled) throw new Error('Tolls is not enabled for this tenant');
}

async function getTenantTollsState(scope = {}) {
  if (!scope?.tenantId) {
    return { tenantId: null, tollsEnabled: false };
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: scope.tenantId },
    select: { id: true, tollsEnabled: true }
  });

  return {
    tenantId: tenant?.id || scope.tenantId,
    tollsEnabled: !!tenant?.tollsEnabled
  };
}

/**
 * The tenant's fleet, normalized for identifier matching.
 *
 * PERFORMANCE (2026-08-03): this used to run inside the per-toll matcher, so a
 * sweep loaded and normalized the ENTIRE fleet once per toll — measured at
 * ~2.7s per row against International Rental Corp, which put a 3,532-row
 * recovery run near three hours. The rows are identical for every toll in a
 * run, so callers processing more than one toll load this once and pass it in.
 * Matching semantics are untouched: the same rows, the same filter.
 */
async function loadTenantVehicleMatchCache(scope = {}) {
  const rows = await prisma.vehicle.findMany({
    where: tenantWhereForScope(scope),
    select: {
      id: true,
      tenantId: true,
      internalNumber: true,
      plate: true,
      tollTagNumber: true,
      tollStickerNumber: true,
      homeLocationId: true,
      make: true,
      model: true,
      year: true
    }
  });

  return rows.map((row) => ({
    ...row,
    plateNormalized: normalizeNullableToken(row.plate),
    tollTagNumberNormalized: normalizeNullableToken(row.tollTagNumber),
    tollStickerNumberNormalized: normalizeNullableToken(row.tollStickerNumber)
  }));
}

async function listTenantVehiclesForMatch(scope = {}, transaction = null, vehicleCache = null) {
  const normalizedRows = Array.isArray(vehicleCache)
    ? vehicleCache
    : await loadTenantVehicleMatchCache(scope);

  if (!transaction) return normalizedRows;

  const plate = normalizeNullableToken(transaction.plateRaw || transaction.plateNormalized);
  const tag = normalizeNullableToken(transaction.tagRaw || transaction.tagNormalized);
  const sello = normalizeNullableToken(transaction.selloRaw || transaction.selloNormalized);
  // RES-849093 FIX 1a: a transaction with NO usable identifier (no plate, no tag,
  // no sello) must NOT fall back to "all tenant vehicles" — that let a toll be
  // auto-attributed to a random car on a pure time-window match. Return [] so the
  // toll has zero candidates and lands in needs-review instead.
  if (!plate && !tag && !sello) return [];

  return normalizedRows.filter((row) => (
    (plate && row.plateNormalized && row.plateNormalized === plate)
    || (tag && row.tollTagNumberNormalized && row.tollTagNumberNormalized === tag)
    || (sello && row.tollStickerNumberNormalized && row.tollStickerNumberNormalized === sello)
  ));
}

async function listReservationCandidates(scope = {}, vehicleIds = [], transactionAt = null) {
  if (!vehicleIds.length || !transactionAt) return [];
  const transactionDate = normalizeDateTime(transactionAt);
  const dayWindowStart = new Date(transactionDate.getTime() - 1000 * 60 * 60 * 24 * 3);
  const dayWindowEnd = new Date(transactionDate.getTime() + 1000 * 60 * 60 * 24 * 3);

  return prisma.reservation.findMany({
    where: {
      ...tenantWhereForScope(scope),
      OR: [
        { vehicleId: { in: vehicleIds } },
        {
          rentalAgreement: {
            is: {
              vehicleId: { in: vehicleIds }
            }
          }
        },
        {
          rentalAgreement: {
            is: {
              vehicleSwaps: {
                some: {
                  OR: [
                    { previousVehicleId: { in: vehicleIds } },
                    { nextVehicleId: { in: vehicleIds } }
                  ]
                }
              }
            }
          }
        }
      ],
      pickupAt: { lte: dayWindowEnd },
      returnAt: { gte: dayWindowStart },
      status: { not: 'CANCELLED' }
    },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true } },
      vehicle: {
        select: {
          id: true,
          internalNumber: true,
          plate: true,
          tollTagNumber: true,
          tollStickerNumber: true
        }
      },
      rentalAgreement: {
        select: {
          id: true,
          vehicleId: true,
          finalizedAt: true,
          inspections: {
            where: { phase: 'CHECKOUT' },
            select: { phase: true, capturedAt: true, createdAt: true },
            orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }],
            take: 1
          },
          vehicleSwaps: {
            select: {
              previousVehicleId: true,
              nextVehicleId: true,
              previousCheckedInAt: true,
              nextCheckedOutAt: true,
              createdAt: true
            },
            orderBy: [{ createdAt: 'asc' }]
          }
        }
      }
    },
    orderBy: [{ pickupAt: 'asc' }]
  });
}

export function scoreCandidate({ transaction, vehicle, reservation, siblingCandidates = 1 }) {
  const plate = normalizeNullableToken(transaction.plateRaw || transaction.plateNormalized);
  const tag = normalizeNullableToken(transaction.tagRaw || transaction.tagNormalized);
  const sello = normalizeNullableToken(transaction.selloRaw || transaction.selloNormalized);
  const vehiclePlate = normalizeNullableToken(vehicle?.plate);
  const vehicleTag = normalizeNullableToken(vehicle?.tollTagNumber);
  const vehicleSello = normalizeNullableToken(vehicle?.tollStickerNumber);
  const when = normalizeDateTime(transaction.transactionAt);
  const responsibility = resolveReservationResponsibility({
    reservation,
    vehicleId: vehicle?.id || null,
    transactionAt: when,
    prePickupGraceMinutes: DEFAULT_PRE_PICKUP_GRACE_MINUTES,
    postReturnGraceMinutes: DEFAULT_POST_RETURN_GRACE_MINUTES
  });

  // The rental provably had a DIFFERENT car at that moment — a swap is on
  // record. Disqualify outright instead of scoring it down: a matching plate
  // (+25) plus the toll landing inside the long rental window (+25) was enough
  // to SUGGEST it, and suggestions get swept up by Confirm All. RES-119005 was
  // billed $13.60 of other customers' tolls that way.
  if (responsibility.contradictsHeldVehicle) {
    return {
      score: 0,
      matchReason: 'vehicleNotOnRentalAtThatTime',
      reviewCategory: null,
      dispatchConfirmationRequired: false,
      multiSignalOverride: false,
      strongIdentifierMatches: 0,
      disqualified: true
    };
  }

  let score = 0;
  const reasons = [];
  let withinTripWindow = responsibility.withinTripWindow;
  let strongIdentifierMatches = 0;

  if (responsibility.withinEffectiveWindow && vehicle?.id) {
    score += 70;
    reasons.push('vehicleResponsibilityWindow');
  }
  if (vehicle?.id && reservation?.vehicleId && vehicle.id === reservation.vehicleId) {
    score += 15;
    reasons.push('currentVehicleId');
  }
  if (vehicle?.id && reservation?.rentalAgreement?.vehicleId && vehicle.id === reservation.rentalAgreement.vehicleId) {
    score += 10;
    reasons.push('agreementVehicleId');
  }
  if (plate && vehiclePlate && plate === vehiclePlate) {
    score += 25;
    strongIdentifierMatches += 1;
    reasons.push('plate');
  }
  if (tag && vehicleTag && tag === vehicleTag) {
    score += 20;
    strongIdentifierMatches += 1;
    reasons.push('tag');
  }
  if (sello && vehicleSello && sello === vehicleSello) {
    score += 20;
    strongIdentifierMatches += 1;
    reasons.push('sello');
  }

  const prePickupAt = new Date(reservation.pickupAt.getTime() - DEFAULT_PRE_PICKUP_GRACE_MINUTES * 60 * 1000);
  const postReturnAt = new Date(reservation.returnAt.getTime() + DEFAULT_POST_RETURN_GRACE_MINUTES * 60 * 1000);
  if (responsibility.withinTripWindow || (when >= reservation.pickupAt && when <= reservation.returnAt)) {
    withinTripWindow = true;
    score += 25;
    reasons.push('withinTripWindow');
  } else if (responsibility.withinGraceWindow || (when >= prePickupAt && when <= postReturnAt)) {
    score += 10;
    reasons.push('withinGraceWindow');
  }

  if (withinTripWindow && responsibility.withinEffectiveWindow) {
    score += 20;
    reasons.push('effectiveVehicleTripWindow');
  }

  // Multi-signal override: if 2+ unique identifiers (plate/tag/sello) all match the
  // same vehicle AND the toll falls inside both the trip window and the vehicle's
  // responsibility window, the evidence is overwhelming. Allow bypassing the
  // dispatch-confirmation score cap so loaner-style reservations (which don't go
  // through formal rental-agreement checkout) can still auto-confirm when proof
  // is strong. See doc/toll-matching-design-review-2026-05-08.md.
  const multiSignalOverride =
    strongIdentifierMatches >= 2 &&
    withinTripWindow &&
    responsibility.withinEffectiveWindow;

  if (responsibility.dispatchConfirmationRequired) {
    reasons.push('dispatchConfirmationRequired');
    if (!multiSignalOverride) {
      score = Math.min(score, 79);
    } else {
      reasons.push('multiSignalOverride');
    }
  }

  // RES-849093 FIX 1b: a pure time-window match (+70 responsibilityWindow / +25
  // tripWindow) must NEVER be enough to AUTO_CONFIRM. Auto-confirmation requires
  // at least ONE strong identifier (plate/tag/sello) tying the toll to THIS
  // vehicle. With zero identifier matches, cap the score below the 85
  // AUTO_CONFIRMED threshold (mirrors the existing Math.min(score, 79) cap) so
  // the toll lands as SUGGESTED / needs-review for a human to attribute. When an
  // identifier DOES match, behavior is unchanged.
  if (strongIdentifierMatches === 0) {
    score = Math.min(score, 79);
    reasons.push('noStrongIdentifier');
  }

  if (siblingCandidates > 1) {
    score -= withinTripWindow ? 10 : 30;
    reasons.push('multipleCandidates');
  }

  return {
    score,
    matchReason: reasons.join(',') || 'manual-review',
    // The dispatchConfirmationRequired flag is downstream consumer's signal that the
    // toll fired before formal checkout. With the multi-signal override active we have
    // overwhelming proof that the match is correct, so we suppress the flag (and its
    // matching review category) — the downstream needsReview computation in
    // buildMatchSuggestion will then let this toll auto-confirm cleanly instead of
    // being held in review. See doc/toll-matching-design-review-2026-05-08.md.
    reviewCategory: multiSignalOverride ? null : responsibility.reviewCategory,
    dispatchConfirmationRequired: responsibility.dispatchConfirmationRequired && !multiSignalOverride,
    multiSignalOverride,
    strongIdentifierMatches
  };
}

/** Pure: covered auto-confirm applies only when ONE distinct reservation is in play. */
export function shouldCheckCoveredAutoConfirm(candidates = []) {
  const ids = new Set(
    (Array.isArray(candidates) ? candidates : [])
      .map((c) => c?.reservation?.id)
      .filter(Boolean)
  );
  return ids.size === 1;
}

/** Does the reservation carry a selected, active coversTolls package? */
async function reservationHasTollCoverage(reservationId, scope = {}) {
  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, ...tenantWhereForScope(scope) },
    select: { tenantId: true, charges: { select: { source: true, sourceRefId: true, selected: true } } }
  });
  if (!reservation) return false;
  const serviceIds = tollPackageCandidateServiceIds(reservation.charges);
  if (!serviceIds.length) return false;
  const covered = await prisma.additionalService.count({
    where: { tenantId: reservation.tenantId, id: { in: serviceIds }, isActive: true, coversTolls: true }
  });
  return covered > 0;
}

async function buildMatchSuggestion(transaction, scope = {}, vehicleCache = null) {
  let vehicles = await listTenantVehiclesForMatch(scope, transaction, vehicleCache);

  // TollBridge finding (a), 2026-07-26: when the toll carries a sede stamp,
  // never offer a vehicle homed at a DIFFERENT sede — in a tenant mixing LAX
  // and FL fleets, a CA toll must not evaluate against a FL car. Vehicles with
  // no homeLocationId stay eligible (fail-open for fleets that don't assign
  // homes); a toll with no stamp keeps the pre-existing tenant-wide behavior.
  const tollLocationId = transaction?.locationId ? String(transaction.locationId) : null;
  let locationExcludedCount = 0;
  if (tollLocationId && vehicles.length) {
    const inSede = vehicles.filter((row) => !row.homeLocationId || String(row.homeLocationId) === tollLocationId);
    locationExcludedCount = vehicles.length - inSede.length;
    vehicles = inSede;
  }

  if (!vehicles.length) {
    return {
      vehicle: null,
      reservation: null,
      score: 0,
      matchStatus: null,
      needsReview: true,
      // Distinct reason when identifier-matching vehicles exist but all live at
      // another sede: staff sees WHY the toll was held instead of a generic
      // not-found, and can reassign the account/vehicle sede if it's wrong.
      matchReason: locationExcludedCount > 0 ? 'vehicle-outside-location' : 'vehicle-not-found'
    };
  }

  const vehicleIds = vehicles.map((vehicle) => vehicle.id);
  const reservations = await listReservationCandidates(scope, vehicleIds, transaction.transactionAt);
  if (!reservations.length) {
    return {
      vehicle: vehicles.length === 1 ? vehicles[0] : null,
      reservation: null,
      score: vehicles.length === 1 ? 45 : 0,
      matchStatus: null,
      needsReview: true,
      matchReason: vehicles.length === 1 ? 'vehicle-found-no-reservation-window' : 'multiple-vehicles-no-reservation'
    };
  }

  const candidates = reservations.flatMap((reservation) => vehicles
    .filter((vehicle) => reservationReferencesVehicle(reservation, vehicle.id))
    .map((vehicle) => {
      const siblingCandidates = reservations.filter((item) => reservationReferencesVehicle(item, vehicle.id)).length;
      const scored = scoreCandidate({ transaction, vehicle, reservation, siblingCandidates });
      return {
        vehicle,
        reservation,
        score: scored.score,
        reviewCategory: scored.reviewCategory,
        dispatchConfirmationRequired: scored.dispatchConfirmationRequired,
        matchReason: appendReviewCategory(scored.matchReason, scored.reviewCategory)
      };
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || new Date(a.reservation.pickupAt).getTime() - new Date(b.reservation.pickupAt).getTime());

  if (!candidates.length) {
    return {
      vehicle: vehicles.length === 1 ? vehicles[0] : null,
      reservation: null,
      score: vehicles.length === 1 ? 45 : 0,
      matchStatus: null,
      needsReview: true,
      matchReason: vehicles.length === 1 ? 'vehicle-found-no-responsibility-window' : 'multiple-vehicles-no-responsibility-window'
    };
  }

  const top = candidates[0];
  let matchStatus = top.dispatchConfirmationRequired
    ? 'SUGGESTED'
    : top.score >= 85 ? 'AUTO_CONFIRMED' : top.score >= 60 ? 'SUGGESTED' : null;
  let coveredAutoConfirm = false;
  // 2026-08-05 (Hector): when the ONLY candidate reservation carries a
  // coversTolls package, confirm instead of queueing review. Nothing gets
  // billed either way (USAGE_ONLY), so the worst case of a wrong confirm is a
  // $0 usage record — while every review row costs staff attention. Gated to
  // a single distinct candidate: with competing reservations, attributing to
  // the covered one would let the OTHER customer's real charge escape.
  if (matchStatus === 'SUGGESTED' && shouldCheckCoveredAutoConfirm(candidates) && top.reservation?.id) {
    if (await reservationHasTollCoverage(top.reservation.id, scope)) {
      matchStatus = 'AUTO_CONFIRMED';
      coveredAutoConfirm = true;
    }
  }
  return {
    vehicle: top.vehicle || null,
    reservation: top.reservation || null,
    score: top.score,
    matchStatus,
    needsReview: matchStatus !== 'AUTO_CONFIRMED',
    matchReason: coveredAutoConfirm
      ? 'auto-confirmed-covered-by-toll-package'
      : (top.matchReason || 'manual-review'),
    candidates: candidates.slice(0, 5).map((candidate) => ({
      reservationId: candidate.reservation.id,
      reservationNumber: candidate.reservation.reservationNumber,
      vehicleId: candidate.vehicle?.id || candidate.reservation.vehicleId || null,
      vehicleInternalNumber: candidate.vehicle?.internalNumber || candidate.reservation.vehicle?.internalNumber || '',
      score: candidate.score,
      matchReason: candidate.matchReason,
      reviewCategory: candidate.reviewCategory || null
    }))
  };
}

async function createAssignmentRecord(tx, transaction, suggestion, matchedByUserId = null) {
  if (!suggestion?.reservation?.id) return null;
  return tx.tollAssignment.create({
    data: {
      tenantId: transaction.tenantId,
      tollTransactionId: transaction.id,
      reservationId: suggestion.reservation.id,
      vehicleId: suggestion.vehicle?.id || suggestion.reservation.vehicleId || null,
      status: suggestion.matchStatus || 'SUGGESTED',
      confidence: suggestion.score,
      matchedByUserId: matchedByUserId || null,
      matchReason: suggestion.matchReason || null
    }
  });
}

async function replaceSuggestedAssignments(tx, transaction, suggestion, matchedByUserId = null) {
  await tx.tollAssignment.updateMany({
    where: {
      tollTransactionId: transaction.id,
      status: { in: ['SUGGESTED', 'AUTO_CONFIRMED', 'CONFIRMED'] }
    },
    data: { status: 'REJECTED' }
  });

  if (suggestion?.reservation?.id) {
    await createAssignmentRecord(tx, transaction, suggestion, matchedByUserId);
  }
}

// Shared per-row re-match core: recompute the suggestion and persist it.
// Used by the manual bulk-auto-match route AND the scheduled re-match sweep so
// the two paths can never drift. Returns the suggestion (with `unchanged: true`
// when nothing was written).
async function rematchTransactionRow(transaction, scope, actorUserId = null, vehicleCache = null) {
  const suggestion = await buildMatchSuggestion(transaction, scope, vehicleCache);

  // No-op guard (QA 2026-07-26): the sweep re-processes the same window every
  // few hours, and for a stable backlog the suggestion is identical each time.
  // Writing it anyway would REJECT + recreate an identical TollAssignment per
  // pass (thousands of junk audit rows/day) and clobber reviewNotes for
  // nothing. If the persisted row already says exactly what we'd write, leave
  // it alone entirely. Human-triggered runs still clear a manual hold.
  const targetVehicleId = suggestion.vehicle?.id || null;
  const targetReservationId = suggestion.reservation?.id || null;
  const targetStatus = suggestion.matchStatus === 'AUTO_CONFIRMED' ? 'MATCHED' : 'NEEDS_REVIEW';
  const targetNeedsReview = suggestion.needsReview !== false;
  const targetConfidence = suggestion.score || null;
  const targetNotes = suggestion.matchReason || null;
  const unchanged =
    (transaction.vehicleId || null) === targetVehicleId &&
    (transaction.reservationId || null) === targetReservationId &&
    String(transaction.status || '') === targetStatus &&
    !!transaction.needsReview === targetNeedsReview &&
    (transaction.matchConfidence == null ? null : Number(transaction.matchConfidence)) === targetConfidence &&
    (transaction.reviewNotes || null) === targetNotes &&
    !(actorUserId && transaction.manualHoldAt);
  if (unchanged) {
    return { ...suggestion, unchanged: true };
  }

  await prisma.$transaction(async (tx) => {
    await replaceSuggestedAssignments(tx, transaction, suggestion, actorUserId);

    await tx.tollTransaction.update({
      where: { id: transaction.id },
      data: {
        vehicleId: targetVehicleId,
        reservationId: targetReservationId,
        status: targetStatus,
        needsReview: targetNeedsReview,
        matchConfidence: targetConfidence,
        reviewNotes: targetNotes,
        // Any write through here is either a real state change (new data
        // arrived) or a human bulk-auto-match — both supersede a manual hold.
        manualHoldAt: null
      }
    });
  });
  return suggestion;
}

// Single gateway for every by-id toll mutation (confirmMatch, postToReservation,
// applyReviewAction) — location scoping goes here so all three inherit it and a
// branch user cannot reach another branch's toll by guessing/holding an id.
async function getTransactionOrThrow(id, scope = {}) {
  const row = await prisma.tollTransaction.findFirst({
    where: {
      id,
      ...tenantWhereForScope(scope),
      ...tollLocationWhere(scope)
    },
    include: {
      vehicle: true,
      reservation: {
        include: {
          customer: { select: { id: true, firstName: true, lastName: true } }
        }
      },
      assignments: {
        include: {
          reservation: { select: { id: true, reservationNumber: true, pickupAt: true, returnAt: true } }
        },
        orderBy: [{ createdAt: 'desc' }]
      }
    }
  });
  if (!row) throw new Error('Toll transaction not found');
  return row;
}

async function refreshReservationEstimatedTotal(reservationId) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      charges: { where: { selected: true } }
    }
  });
  if (!reservation) return null;
  const estimatedTotal = Number((reservation.charges || []).reduce((sum, row) => sum + toMoney(row.total), 0).toFixed(2));
  await prisma.reservation.update({
    where: { id: reservationId },
    data: { estimatedTotal }
  });
  return estimatedTotal;
}


function normalizeTollPolicy(config = {}) {
  const mode = String(config?.tollAdditionalFeeMode || 'FIXED').trim().toUpperCase();
  return {
    enabled: !!config?.tollPolicyEnabled,
    taxable: !!config?.tollTaxable,
    additionalFeeEnabled: !!config?.tollAdditionalFeeEnabled,
    additionalFeeMode: ['FIXED', 'PERCENTAGE', 'PER_TOLL'].includes(mode) ? mode : 'FIXED',
    additionalFeeAmount: toMoney(config?.tollAdditionalFeeAmount)
  };
}

function resolveReservationTollPolicy(reservation) {
  const pickup = normalizeTollPolicy(parseLocationConfig(reservation?.pickupLocation?.locationConfig));
  const pickupMeta = {
    ...pickup,
    locationId: reservation?.pickupLocation?.id || null,
    locationName: reservation?.pickupLocation?.name || ''
  };
  if (pickupMeta.enabled) return pickupMeta;

  const dropoff = normalizeTollPolicy(parseLocationConfig(reservation?.returnLocation?.locationConfig));
  return {
    ...dropoff,
    locationId: reservation?.returnLocation?.id || pickupMeta.locationId || null,
    locationName: reservation?.returnLocation?.name || pickupMeta.locationName || ''
  };
}

function buildTollChargeName(transaction) {
  return `Toll Charge${transaction?.location ? ` - ${transaction.location}` : ''}`;
}

function buildTollPolicyChargeName(policy) {
  const suffix = policy?.locationName ? ` - ${policy.locationName}` : '';
  return `Toll Policy Fee${suffix}`;
}

function buildTollPolicyChargeShape(policy, transactions = []) {
  const rows = Array.isArray(transactions) ? transactions : [];
  if (!policy?.enabled || !policy.additionalFeeEnabled || !(policy.additionalFeeAmount > 0) || !rows.length) return null;

  const tollCount = rows.length;
  const tollSubtotal = Number(rows.reduce((sum, row) => sum + toMoney(row.amount), 0).toFixed(2));

  let quantity = 1;
  let rate = policy.additionalFeeAmount;
  let total = policy.additionalFeeAmount;

  if (policy.additionalFeeMode === 'PERCENTAGE') {
    total = Number((tollSubtotal * (policy.additionalFeeAmount / 100)).toFixed(2));
    rate = total;
  } else if (policy.additionalFeeMode === 'PER_TOLL') {
    quantity = tollCount;
    total = Number((policy.additionalFeeAmount * tollCount).toFixed(2));
    rate = policy.additionalFeeAmount;
  }

  if (!(total > 0)) return null;

  return {
    code: 'TOLL_POLICY',
    name: buildTollPolicyChargeName(policy),
    chargeType: 'UNIT',
    quantity,
    rate,
    total,
    taxable: !!policy.taxable,
    selected: true,
    notes: `Auto-applied from toll policy (${policy.additionalFeeMode.toLowerCase()})`
  };
}

async function getReservationForTollChargeSync(reservationId, scope = {}) {
  return prisma.reservation.findFirst({
    where: {
      id: reservationId,
      ...tenantWhereForScope(scope)
    },
    include: {
      tenant: { select: { id: true, tollsEnabled: true } },
      pickupLocation: { select: { id: true, name: true, locationConfig: true } },
      returnLocation: { select: { id: true, name: true, locationConfig: true } },
      // For the staff alert email: who rented and which contract to open.
      customer: { select: { firstName: true, lastName: true } },
      rentalAgreement: { select: { id: true, agreementNumber: true, status: true } },
      charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
    }
  });
}

function staffAppBaseUrl() {
  return (process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * Staff alert per newly-synced toll (Hector's request, TollBridge point 9).
 * CA/FL tolls arrive after the renter left; if nobody is told, nobody
 * collects. One email per toll, idempotent via a claim on staffNotifiedAt
 * (updateMany WHERE null — only the caller that flips it sends). Recipient is
 * per sede: locationConfig.tolls.alertEmail of the toll's sede, falling back
 * to the reservation's pickup sede. No configured recipient => no email, but
 * the in-app alert (staffAckAt null) still shows on the contract.
 * Never throws — an alert failure must not break the money sync.
 */
async function notifyStaffOfNewTolls(reservation, transactions = []) {
  const pending = (Array.isArray(transactions) ? transactions : []).filter((row) => row && !row.staffNotifiedAt);
  if (!pending.length) return { notified: 0 };

  const pickupLocationId = reservation?.pickupLocation?.id ? String(reservation.pickupLocation.id) : null;
  const emailByLocation = new Map();
  if (pickupLocationId) {
    emailByLocation.set(
      pickupLocationId,
      resolveTollLocationSettings(parseLocationConfig(reservation.pickupLocation.locationConfig)).alertEmail
    );
  }
  async function alertEmailFor(locationId) {
    const key = locationId ? String(locationId) : pickupLocationId;
    if (!key) return null;
    if (!emailByLocation.has(key)) {
      const location = await prisma.location.findUnique({ where: { id: key }, select: { locationConfig: true } });
      emailByLocation.set(key, location ? resolveTollLocationSettings(parseLocationConfig(location.locationConfig)).alertEmail : null);
    }
    // Toll's own sede first; a sede without a configured inbox falls back to
    // the renting sede so the alert lands somewhere staffed.
    return emailByLocation.get(key) || (key !== pickupLocationId ? emailByLocation.get(pickupLocationId) : null) || null;
  }

  const agreement = reservation?.rentalAgreement || null;
  const agreementClosed = String(agreement?.status || '').toUpperCase() === 'CLOSED';
  const contractLabel = agreement?.agreementNumber || reservation?.reservationNumber || reservation?.id;
  const customerName = [reservation?.customer?.firstName, reservation?.customer?.lastName].filter(Boolean).join(' ') || 'Customer';
  const reservationUrl = `${staffAppBaseUrl()}/reservations/${reservation.id}`;

  let notified = 0;
  for (const toll of pending) {
    const claimed = await prisma.tollTransaction.updateMany({
      where: { id: toll.id, staffNotifiedAt: null },
      data: { staffNotifiedAt: new Date() }
    });
    if (claimed.count !== 1) continue;
    notified += 1;

    const to = await alertEmailFor(toll.locationId);
    if (!to) continue;

    const amount = toMoney(toll.amount).toFixed(2);
    const when = new Date(toll.transactionAt).toISOString().slice(0, 16).replace('T', ' ');
    const subject = `${agreementClosed ? '[CONTRATO CERRADO] ' : ''}Peaje nuevo $${amount} - Contrato ${contractLabel}`;
    const lines = [
      `Un peaje nuevo se adjunto al contrato ${contractLabel}${agreementClosed ? ' (YA CERRADO - requiere cobro manual)' : ''}.`,
      '',
      `Cliente: ${customerName}`,
      `Placa: ${toll.plateRaw || toll.plateNormalized || '-'}`,
      `Monto: $${amount}`,
      `Fecha del peaje: ${when} UTC`,
      `Plaza: ${toll.location || '-'}`,
      '',
      `Abrir el contrato: ${reservationUrl}`
    ];
    // Fire-and-forget (same pattern as booking confirmation emails): the sync
    // must not block or fail on SMTP. On failure, release the claim so the
    // next sync retries the email.
    sendEmail({ tenantId: reservation.tenantId, to, subject, text: lines.join('\n') }).catch(async (err) => {
      logger.error('[tolls] staff alert email FAILED - releasing claim for retry on next sync', {
        tollTransactionId: toll.id,
        err: String(err?.message || err)
      });
      await prisma.tollTransaction.updateMany({
        where: { id: toll.id },
        data: { staffNotifiedAt: null }
      }).catch(() => {});
    });
  }

  return { notified };
}

// Charge sources that can carry a toll-relevant service (an AdditionalService
// referenced via sourceRefId). 'KIOSK_UPSELL' added 2026-07-05 (kiosk B2
// review): kiosk-sold coversTolls services were invisible here, so the
// customer paid per-toll ON TOP of the package they bought at the kiosk.
// 'ADDITIONAL_SERVICE_PRECHECKIN' added 2026-07-28 (LAX #10 review): the SAME
// blind spot existed for packages bought in the customer portal pre-check-in
// upsell — matching lib/sold-items.js SERVICE_CHARGE_SOURCES.
const TOLL_PACKAGE_CHARGE_SOURCES = ['ADDITIONAL_SERVICE', 'SERVICE', 'ADDITIONAL_SERVICE_PRECHECKIN', 'KIOSK_UPSELL'];

/** Pure: the AdditionalService ids referenced by selected package-capable charges. */
export function tollPackageCandidateServiceIds(charges = []) {
  return Array.from(new Set(
    (Array.isArray(charges) ? charges : [])
      .filter((row) => row.selected && TOLL_PACKAGE_CHARGE_SOURCES.includes(String(row.source || '').toUpperCase()) && row.sourceRefId)
      .map((row) => String(row.sourceRefId))
  ));
}

async function syncReservationTollCharges(reservationId, scope = {}, options = {}) {
  if (!reservationId) return null;

  const reservation = await getReservationForTollChargeSync(reservationId, scope);
  if (!reservation) throw new Error('Reservation not found for toll charge sync');

  const tenantId = reservation.tenantId || scope?.tenantId || null;
  if (!reservation?.tenant?.tollsEnabled || !tenantId) {
    return {
      reservationId,
      tollsEnabled: false,
      syncedChargeCount: 0,
      policyFeeApplied: false
    };
  }

  // MONEY PATH — deliberately NOT location-scoped (2026-07-24). This rebuilds the
  // reservation's TOLL_MODULE charges from the transactions it finds and PRUNES
  // any charge whose transaction is missing from that set. Narrowing the query by
  // the acting user's locations would therefore DELETE a real charge the moment a
  // branch employee happened to trigger a pricing recompute on a reservation whose
  // toll belongs to another branch's vehicle. Reservation visibility is the gate
  // here, and it is already location-scoped upstream. Rebuilding scope as
  // tenant-only keeps the reconciliation deterministic regardless of who triggers it.
  const effectiveScope = systemScope({ tenantId });
  const policy = resolveReservationTollPolicy(reservation);
  const selectedServiceIds = tollPackageCandidateServiceIds(reservation.charges);
  // One read resolves BOTH toll-relevant flags (LAX #10 added tollPassthrough).
  const tollServices = selectedServiceIds.length
    ? await prisma.additionalService.findMany({
        where: { tenantId, id: { in: selectedServiceIds }, isActive: true },
        select: { coversTolls: true, tollPassthrough: true }
      })
    : [];
  const prepaidTollServiceCount = tollServices.filter((s) => s.coversTolls).length;
  const tollPassthroughServiceCount = tollServices.filter((s) => s.tollPassthrough).length;
  const transactions = await prisma.tollTransaction.findMany({
    where: {
      reservationId,
      ...tenantWhereForScope(effectiveScope),
      // RES-849093 FIX 2a: status VOID is intentionally NOT in this list, so a
      // toll voided via Admin Corrections (tollsService.voidTollTransaction sets
      // status=VOID, billingStatus=WAIVED) is permanently excluded from the
      // rebuild — the voided charge stays voided and never regenerates.
      status: { in: ['MATCHED', 'BILLED'] },
      // COVERED_BY_PACKAGE stays in the rebuild set on purpose: if the package
      // is later removed from the reservation, the next sync re-bills these.
      billingStatus: { in: ['PENDING', 'POSTED_TO_RESERVATION', 'POSTED_TO_AGREEMENT', 'COVERED_BY_PACKAGE'] }
    },
    orderBy: [{ transactionAt: 'asc' }, { createdAt: 'asc' }]
  });

  const existingCharges = Array.isArray(reservation.charges) ? reservation.charges : [];
  const existingTollCharges = existingCharges.filter((row) => row.source === 'TOLL_MODULE');
  const existingPolicyCharges = existingCharges.filter((row) => row.source === 'TOLL_POLICY');
  const existingTollChargeByRef = new Map(existingTollCharges.map((row) => [String(row.sourceRefId || ''), row]));
  const policySourceRefId = `reservation:${reservationId}`;
  const currentMaxSort = existingCharges.reduce((max, row) => {
    const sortOrder = Number.isInteger(row?.sortOrder) ? row.sortOrder : Number(row?.sortOrder || 0);
    return Math.max(max, sortOrder);
  }, -1);

  let nextSortOrder = currentMaxSort + 1;
  const activeTransactionIds = new Set(transactions.map((row) => String(row.id)));
  const note = String(options?.note || '').trim();
  const billingDecision = evaluateTollBillingPolicy({
    prepaidTollServiceCount,
    tollPassthroughServiceCount,
    transactions
  });

  await prisma.$transaction(async (tx) => {
    // Pre-compute the desired (billingStatus, status, reviewNotes) per
    // transaction, then skip no-ops and group the rest by their target
    // values. This collapses the previous one-UPDATE-per-row pattern into
    // a small number of updateMany calls — typically 1 in the steady state
    // (fresh reconciliation: all rows null reviewNotes → same merged
    // suffix → single group). Sentry "Repeating Spans" / N+1 fix.
    const noteSuffix = billingDecision.coveredByTollPackage
      ? 'Covered by prepaid toll package; usage recorded without billing'
      : billingDecision.tollPassthrough
        ? (note ? `Posted at cost (Toll Activation, no policy fee): ${note}` : 'Posted at cost — Toll Activation service, no policy fee')
        : (note ? `Posted to reservation: ${note}` : 'Posted to reservation automatically');

    const tollUpdateGroups = new Map();
    for (const transaction of transactions) {
      // 2026-08-05 (Hector): prepaid-covered crossings are not money anyone
      // still has to collect — give them their own state instead of letting
      // them masquerade as POSTED_TO_RESERVATION (the pending-tolls KPI and
      // staff alerts counted 900+ prepaid crossings as uncollected for IRC).
      const targetBillingStatus = billingDecision.coveredByTollPackage
        ? 'COVERED_BY_PACKAGE'
        : String(transaction.billingStatus || '').toUpperCase() === 'POSTED_TO_AGREEMENT'
          ? 'POSTED_TO_AGREEMENT'
          : 'POSTED_TO_RESERVATION';
      const targetReviewNotes = mergeChargeNotes(transaction.reviewNotes, noteSuffix);

      // Skip if the row is already in the target state — common when the
      // pricing endpoint is hit repeatedly on a reservation that has
      // already been reconciled. Saves a round-trip per such row.
      const currentStatus = String(transaction.status || '');
      const currentBillingStatus = String(transaction.billingStatus || '');
      const currentReviewNotes = transaction.reviewNotes ?? null;
      if (
        currentStatus === 'BILLED' &&
        currentBillingStatus === targetBillingStatus &&
        currentReviewNotes === (targetReviewNotes ?? null)
      ) {
        continue;
      }

      const key = `${targetBillingStatus}|${targetReviewNotes ?? ''}`;
      let group = tollUpdateGroups.get(key);
      if (!group) {
        group = {
          billingStatus: targetBillingStatus,
          reviewNotes: targetReviewNotes,
          ids: []
        };
        tollUpdateGroups.set(key, group);
      }
      group.ids.push(transaction.id);
    }

    for (const group of tollUpdateGroups.values()) {
      await tx.tollTransaction.updateMany({
        where: { id: { in: group.ids } },
        data: {
          billingStatus: group.billingStatus,
          status: 'BILLED',
          reviewNotes: group.reviewNotes
        }
      });
    }

    if (billingDecision.shouldCreateChargeRows) {
      for (const transaction of transactions) {
        const sourceRefId = String(transaction.id);
        const existing = existingTollChargeByRef.get(sourceRefId);
        const chargeData = {
          code: 'TOLL',
          name: buildTollChargeName(transaction),
          chargeType: 'UNIT',
          quantity: 1,
          rate: toMoney(transaction.amount),
          total: toMoney(transaction.amount),
          taxable: policy.enabled ? !!policy.taxable : false,
          selected: true,
          notes: mergeChargeNotes(existing?.notes, note || null)
        };

        if (existing?.id) {
          await tx.reservationCharge.update({
            where: { id: existing.id },
            data: chargeData
          });
        } else {
          await tx.reservationCharge.create({
            data: {
              reservationId,
              ...chargeData,
              sortOrder: nextSortOrder++,
              source: 'TOLL_MODULE',
              sourceRefId
            }
          });
        }
      }
    }

    const staleTollChargeIds = existingTollCharges
      .filter((row) => billingDecision.coveredByTollPackage || !activeTransactionIds.has(String(row.sourceRefId || '')))
      .map((row) => row.id);
    if (staleTollChargeIds.length) {
      await tx.reservationCharge.deleteMany({
        where: {
          reservationId,
          id: { in: staleTollChargeIds }
        }
      });
    }

    const policyCharge = billingDecision.shouldApplyPolicyFee ? buildTollPolicyChargeShape(policy, transactions) : null;
    const existingPolicyCharge = existingPolicyCharges.find((row) => String(row.sourceRefId || '') === policySourceRefId) || existingPolicyCharges[0] || null;

    if (policyCharge) {
      const policyChargeData = {
        ...policyCharge,
        source: 'TOLL_POLICY',
        sourceRefId: policySourceRefId,
        notes: mergeChargeNotes(existingPolicyCharge?.notes, policyCharge.notes)
      };

      if (existingPolicyCharge?.id) {
        await tx.reservationCharge.update({
          where: { id: existingPolicyCharge.id },
          data: policyChargeData
        });
      } else {
        await tx.reservationCharge.create({
          data: {
            reservationId,
            ...policyChargeData,
            sortOrder: nextSortOrder++,
            source: 'TOLL_POLICY',
            sourceRefId: policySourceRefId
          }
        });
      }
    }

    const stalePolicyChargeIds = existingPolicyCharges
      .filter((row) => !policyCharge || row.id !== existingPolicyCharge?.id)
      .map((row) => row.id);
    if (stalePolicyChargeIds.length) {
      await tx.reservationCharge.deleteMany({
        where: {
          reservationId,
          id: { in: stalePolicyChargeIds }
        }
      });
    }
  });

  await refreshReservationEstimatedTotal(reservationId);

  // 2026-07-26 (found by the TollBridge team reading this module; verified
  // by us): this function used to stop at the reservation — it NEVER
  // mirrored the toll charges into the RentalAgreement, and the counter
  // reads RentalAgreement.balance. Since CA/FL tolls almost always post
  // AFTER the rental closed (SunPass 2+ weeks late, CA statements up to a
  // month), the charge existed on the reservation but the counter never saw
  // it and nobody collected it — SILENT LOSS with today's providers, not
  // just future ones. allowClosed:true is the established post-close mirror
  // pattern (manual charges, corrections, extensions all use it). Dynamic
  // import: reservation-pricing imports this module statically — a static
  // import back would be a cycle. Failure is LOUD but does not abort the
  // toll sync: the ReservationCharge is already written and the next sync
  // retries the mirror.
  // skipAgreementMirror: getPricing already runs syncAgreementCharges in the
  // SAME Promise.all as this sync — mirroring from here too would race two
  // concurrent agreement rebuilds on one reservation. That caller opts out;
  // every ingest/match path mirrors.
  if (!options.skipAgreementMirror) {
    try {
      const { reservationPricingService } = await import('../reservations/reservation-pricing.service.js');
      await reservationPricingService.syncAgreementCharges(reservationId, scope, { allowClosed: true });
    } catch (err) {
      logger.error('[tolls] agreement mirror after toll sync FAILED — counter balance is stale until the next sync', {
        reservationId,
        err: String(err?.message || err)
      });
    }
  }

  // Staff alert per new BILLABLE toll (TollBridge point 9). Package-covered
  // tolls are usage-only — nothing to collect, nothing to alert. Failure here
  // must never break the money sync above.
  if (billingDecision.shouldCreateChargeRows) {
    try {
      await notifyStaffOfNewTolls(reservation, transactions);
    } catch (err) {
      logger.error('[tolls] staff toll alert pass FAILED after sync', {
        reservationId,
        err: String(err?.message || err)
      });
    }
  }

  return {
    reservationId,
    tollsEnabled: true,
    syncedChargeCount: transactions.length,
    usageOnlyCount: billingDecision.usageOnlyCount,
    chargeableCount: billingDecision.chargeableCount,
    policyFeeApplied: billingDecision.shouldApplyPolicyFee && !!buildTollPolicyChargeShape(policy, transactions),
    coveredByTollPackage: billingDecision.coveredByTollPackage,
    tollPassthrough: billingDecision.tollPassthrough,
    billingMode: billingDecision.billingMode,
    policy
  };
}

function getAutoSyncIntervalMinutes() {
  const raw = Number(process.env.TOLLS_AUTO_SYNC_INTERVAL_MINUTES || DEFAULT_AUTO_SYNC_INTERVAL_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUTO_SYNC_INTERVAL_MINUTES;
}

// SunPass runs on its OWN cadence, independent of AutoExpreso (Florida tolls post
// daily-ish, no need for 15-min polling). Default 12h.
function getSunPassSyncIntervalMinutes() {
  const raw = Number(process.env.TOLLS_SUNPASS_SYNC_INTERVAL_MINUTES || 720);
  return Number.isFinite(raw) && raw > 0 ? raw : 720;
}

function getAutoSyncStatus(providerAccount, latestAutoSyncRun = null, pendingReviewCount = 0) {
  const enabled = String(process.env.TOLLS_AUTO_SYNC_ENABLED || 'true').toLowerCase() !== 'false';
  const intervalMinutes = getAutoSyncIntervalMinutes();
  const startupDelaySeconds = Number(process.env.TOLLS_AUTO_SYNC_STARTUP_DELAY_SECONDS || 45);
  const lastAutomaticRunAt = providerAccount?.lastSyncAt || null;
  const lastSweepMeta = safeJsonParse(latestAutoSyncRun?.metadataJson, {});
  const nextRunAt = enabled
    ? new Date((lastAutomaticRunAt ? new Date(lastAutomaticRunAt).getTime() : Date.now() + (Number.isFinite(startupDelaySeconds) ? startupDelaySeconds : 45) * 1000) + intervalMinutes * 60 * 1000)
    : null;

  return {
    enabled,
    intervalMinutes,
    startupDelaySeconds: Number.isFinite(startupDelaySeconds) ? startupDelaySeconds : 45,
    lastAutomaticRunAt,
    nextRunAt,
    lastSweep: latestAutoSyncRun ? {
      importRunId: latestAutoSyncRun.id,
      startedAt: latestAutoSyncRun.startedAt,
      completedAt: latestAutoSyncRun.completedAt,
      importedCount: Number(lastSweepMeta?.autoSync?.importedCount ?? latestAutoSyncRun.importedCount ?? 0),
      autoMatchedCount: Number(lastSweepMeta?.autoSync?.autoMatchedCount ?? 0),
      suggestedCount: Number(lastSweepMeta?.autoSync?.suggestedCount ?? 0),
      pendingReviewCount: Number(lastSweepMeta?.autoSync?.pendingReviewCount ?? pendingReviewCount ?? 0)
    } : null
  };
}

function reviewActionLabel(action) {
  switch (String(action || '').toUpperCase()) {
    case 'RESET_MATCH':
      return 'match reset';
    case 'CONFIRM_DISPATCHED':
      return 'dispatch confirmed';
    case 'MARK_NOT_DISPATCHED':
      return 'marked not dispatched';
    case 'MARK_DISPUTED':
      return 'marked disputed';
    case 'MARK_NOT_BILLABLE':
      return 'marked not billable';
    default:
      return 'review updated';
  }
}

export const tollsService = {
  async getDashboard(scope = {}, filters = {}) {
    const tollState = await getTenantTollsState(scope);
    if (scope?.tenantId && !tollState.tollsEnabled) {
      return {
        tollsEnabled: false,
        metrics: {
          importedToday: 0,
          matched: 0,
          needsReview: 0,
          postedToBilling: 0,
          disputed: 0
        },
        providerAccount: null,
        autoSync: {
          enabled: false,
          intervalMinutes: 0,
          startupDelaySeconds: 0,
          lastAutomaticRunAt: null,
          nextRunAt: null,
          lastSweep: null
        },
        importRuns: [],
        transactions: []
      };
    }

    await ensureTenantAllowsTolls(scope);
    // Location scoping (2026-07-24). Applied to the list AND to every metric
    // count below — the tiles are separate queries, and a scoped list under a
    // tenant-wide tile is exactly the contradiction the maintenance board hit.
    const locWhere = tollLocationWhere(scope);

    // The list where is built by the SAME pure builder the CSV export uses
    // (tolls-export.js) so the spreadsheet can never disagree with the screen.
    const where = buildTollListWhere(scope, filters);

    const [transactions, importedToday, matchedCount, reviewCount, billedCount, disputedCount, providerAccount, importRuns] = await Promise.all([
      prisma.tollTransaction.findMany({
        where,
        include: {
          vehicle: true,
          reservation: {
            include: {
              customer: { select: { id: true, firstName: true, lastName: true } }
            }
          },
          assignments: {
            include: {
              reservation: { select: { id: true, reservationNumber: true, pickupAt: true, returnAt: true } }
            },
            orderBy: [{ createdAt: 'desc' }]
          }
        },
        orderBy: [{ needsReview: 'desc' }, { transactionAt: 'desc' }],
        take: 200
      }),
      prisma.tollTransaction.count({
        where: {
          ...tenantWhereForScope(scope),
          ...locWhere,
          createdAt: { gte: startOfDay(new Date()) }
        }
      }),
      prisma.tollTransaction.count({
        where: {
          ...tenantWhereForScope(scope),
          ...locWhere,
          status: 'MATCHED'
        }
      }),
      prisma.tollTransaction.count({
        where: {
          ...tenantWhereForScope(scope),
          ...locWhere,
          needsReview: true
        }
      }),
      prisma.tollTransaction.count({
        where: {
          ...tenantWhereForScope(scope),
          ...locWhere,
          billingStatus: { in: ['POSTED_TO_RESERVATION', 'POSTED_TO_AGREEMENT'] }
        }
      }),
      prisma.tollTransaction.count({
        where: {
          ...tenantWhereForScope(scope),
          ...locWhere,
          billingStatus: 'DISPUTED'
        }
      }),
      scope?.tenantId ? prisma.tollProviderAccount.findFirst({
        where: {
          tenantId: scope.tenantId
        },
        orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
      }) : null,
      scope?.tenantId ? prisma.tollImportRun.findMany({
        where: {
          tenantId: scope.tenantId
        },
        orderBy: [{ startedAt: 'desc' }],
        take: 10
      }) : []
    ]);

    // The tab counts come from the DATABASE, not from the 200 rows above.
    // Counting the page is what made the queue climb from 19 to 21 when staff
    // confirmed 19 (Hector, 2026-08-07) — see tolls-queue-counts.js.
    const queueCounts = await countQueues(prisma, where);

    const latestAutoSyncRun = (importRuns || []).find((run) => String(run.sourceType || '').toUpperCase() === 'AUTOEXPRESO_SYNC') || null;
    const transactionsWithIssues = await attachIssueIncidents(transactions, scope);

    return {
      tollsEnabled: true,
      metrics: {
        importedToday,
        matched: matchedCount,
        needsReview: reviewCount,
        // Of everything flagged for review, how much a human can actually act
        // on. International's 3,579 was 189 with a suggestion and 3,390 with
        // no match candidate at all — one number for both read as a backlog.
        needsReviewActionable: queueCounts.NEEDS_REVIEW,
        needsReviewNoSuggestion: queueCounts.NO_SUGGESTION,
        postedToBilling: billedCount,
        disputed: disputedCount
      },
      queueCounts,
      // How much of the queue this payload actually contains, so the page can
      // say so instead of implying it has everything.
      returnedCount: transactions.length,
      totalCount: queueCounts.ALL,
      providerAccount: serializeProviderAccount(providerAccount),
      autoSync: getAutoSyncStatus(providerAccount, latestAutoSyncRun, reviewCount),
      importRuns: (importRuns || []).map(serializeImportRun),
      transactions: transactionsWithIssues.map(serializeTransaction)
    };
  },

  /**
   * CSV export of the CURRENT filtered queue view (Tolls redesign A). Honors
   * the exact same tenant scope, location scope, and filters (q / status /
   * needsReview / reservationId) as the dashboard list, PLUS the active queue
   * view (`filters.view` — same keys as queueCounts). Read-only and additive:
   * no other consumer's contract changes.
   */
  async exportTransactionsCsv(scope = {}, filters = {}) {
    await ensureTenantAllowsTolls(scope);
    const where = buildTollExportWhere(scope, filters);
    const rows = await prisma.tollTransaction.findMany({
      where,
      include: {
        vehicle: true,
        reservation: {
          include: {
            customer: { select: { id: true, firstName: true, lastName: true } }
          }
        },
        assignments: {
          include: {
            reservation: { select: { id: true, reservationNumber: true, pickupAt: true, returnAt: true } }
          },
          orderBy: [{ createdAt: 'desc' }]
        }
      },
      orderBy: [{ needsReview: 'desc' }, { transactionAt: 'desc' }],
      take: TOLL_EXPORT_MAX_ROWS
    });
    return { csv: tollsToCsv(rows), filename: tollExportFilename(filters), rowCount: rows.length };
  },

  async getProviderAccount(scope = {}) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for toll provider setup');
    const row = await prisma.tollProviderAccount.findFirst({
      where: {
        tenantId: scope.tenantId,
        provider: 'AUTOEXPRESO'
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
    });
    return serializeProviderAccount(row);
  },

  async saveProviderAccount(payload = {}, scope = {}) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for toll provider setup');

    const provider = ['AUTOEXPRESO', 'SUNPASS'].includes(String(payload.provider || '').toUpperCase())
      ? String(payload.provider).toUpperCase()
      : 'AUTOEXPRESO';
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '').trim();
    const isActive = payload.isActive !== false;
    const settings = {
      loginUrl: String(payload.loginUrl || '').trim(),
      notes: String(payload.notes || '').trim()
    };

    // Sede binding (TollBridge finding (a)). Only accept a location that
    // belongs to THIS tenant — a cross-tenant id would silently mis-scope
    // every future import. undefined = leave as-is, '' / null = clear.
    let locationIdPatch;
    if (payload.locationId !== undefined) {
      const requested = String(payload.locationId || '').trim();
      if (!requested) {
        locationIdPatch = null;
      } else {
        const location = await prisma.location.findFirst({
          where: { id: requested, tenantId: scope.tenantId },
          select: { id: true }
        });
        if (!location) throw new Error('locationId does not belong to this tenant');
        locationIdPatch = location.id;
      }
    }

    const existing = await prisma.tollProviderAccount.findFirst({
      where: {
        tenantId: scope.tenantId,
        provider
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
    });

    // If switching providers, deactivate the old one
    if (isActive) {
      await prisma.tollProviderAccount.updateMany({
        where: {
          tenantId: scope.tenantId,
          provider: { not: provider },
          isActive: true
        },
        data: { isActive: false }
      });
    }

    const row = existing
      ? await prisma.tollProviderAccount.update({
          where: { id: existing.id },
          data: {
            username: username || null,
            passwordEncrypted: password ? encodeSecret(password) : existing.passwordEncrypted,
            isActive,
            settingsJson: JSON.stringify(settings),
            ...(locationIdPatch !== undefined ? { locationId: locationIdPatch } : {}),
            lastSyncStatus: existing.lastSyncStatus || 'READY'
          }
        })
      : await prisma.tollProviderAccount.create({
          data: {
            tenantId: scope.tenantId,
            provider,
            username: username || null,
            passwordEncrypted: password ? encodeSecret(password) : null,
            isActive,
            settingsJson: JSON.stringify(settings),
            ...(locationIdPatch !== undefined ? { locationId: locationIdPatch } : {}),
            lastSyncStatus: 'READY'
          }
        });

    return serializeProviderAccount(row);
  },

  async runProviderHealthCheck(scope = {}, requestedProvider = null) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for toll provider setup');
    const provider = requestedProvider || await resolveActiveProvider(scope.tenantId);
    const row = await prisma.tollProviderAccount.findFirst({
      where: {
        tenantId: scope.tenantId,
        provider
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
    });
    if (!row) throw new Error(`${provider} provider account is not configured`);

    const missing = [];
    if (!String(row.username || '').trim()) missing.push('username');
    if (!decodeSecret(row.passwordEncrypted)) missing.push('password');
    const ready = missing.length === 0 && !!row.isActive;

    const providerLabel = provider === 'SUNPASS' ? 'SunPass' : 'AutoExpreso';
    const updated = await prisma.tollProviderAccount.update({
      where: { id: row.id },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: ready ? 'READY' : 'MISSING_CONFIG',
        lastSyncMessage: ready ? `Provider account looks ready for ${providerLabel} sync` : `Missing: ${missing.join(', ')}${row.isActive ? '' : ' | account inactive'}`
      }
    });

    return {
      ready,
      missing,
      provider,
      providerAccount: serializeProviderAccount(updated)
    };
  },

  async _runSunPassSync(providerAccount, scope, actorUserId, syncLockKey) {
    const withPage = await resolveTollWithPage();

    const username = String(providerAccount.username || '').trim();
    const password = decodeSecret(providerAccount.passwordEncrypted);
    // Pull a ROLLING WINDOW, not just today: SunPass posts transactions with a multi-day
    // lag (posted date trails transaction date), so a today-only filter almost always
    // returns nothing. A lookback window catches late-posting tolls; dedup by externalId
    // makes re-importing the overlap a no-op. Default 14 days (env-tunable).
    const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
    const lookbackDays = Number(process.env.TOLLS_SUNPASS_LOOKBACK_DAYS || 14) > 0 ? Number(process.env.TOLLS_SUNPASS_LOOKBACK_DAYS || 14) : 14;
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const startStr = fmt(startDate);
    const endStr = fmt(endDate);

    try {
      // Scrape under the shared singleton browser + global page cap. Only the
      // scrape holds the semaphore — the Prisma writes below run after the
      // page is closed and the permit released.
      const { pageRows, debug } = await withPage(async (page) => {
        // Login
        await sunpassLogin(page, username, password);
        // Navigate to activity
        await sunpassNavigateToActivity(page);
        // Filter + search over the rolling lookback window
        await sunpassFilterAndSearch(page, startStr, endStr);
        // Scrape rows
        const pageRows = await scrapeSunPassRows(page);
        // Diagnostic snapshot of what the headless page actually shows at scrape time
        // (debugging blind: surfaces URL, tables, filter state, body text into the run).
        const debug = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          tableCount: document.querySelectorAll('table').length,
          trCount: document.querySelectorAll('table tr').length,
          tableHeaders: Array.from(document.querySelectorAll('table')).slice(0, 6).map((t) =>
            Array.from(t.querySelectorAll('tr:first-child th, tr:first-child td')).map((c) => String(c.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 10)),
          selects: Array.from(document.querySelectorAll('select')).map((s) => ({ name: s.name, value: s.value, text: s.options[s.selectedIndex] && s.options[s.selectedIndex].text })),
          dates: Array.from(document.querySelectorAll('input[name="startDateAll"], input[name="endDateAll"]')).map((i) => ({ name: i.name, value: i.value })),
          bodySnippet: String(document.body && document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 700)
        })).catch((e) => ({ error: String(e && e.message || e) }));
        return { pageRows, debug };
      });

      const rows = [];
      const seenExternalIds = new Set();
      let dedupedInRunCount = 0;

      for (const raw of pageRows) {
        try {
          const dateTimeStr = `${raw.transactionDate || ''} ${raw.transactionTime || ''}`.trim();
          const transactionAt = parseSunPassDateTime(dateTimeStr || raw.transactionDate);
          const amount = Number(raw.amount);
          if (!Number.isFinite(amount) || amount <= 0 || amount > 500) continue;
          // "Transponder/License Plate" column holds EITHER a transponder number (all
          // digits) OR a license plate (e.g. "ABC123" / "ABC123-FL"). Vehicles carry the
          // transponder in Vehicle.tollTagNumber (loaded for the fleet), so transponder
          // rows match by tag and video/plate rows match by plate.
          const tpClean = String(raw.transponderPlate || '').trim().toUpperCase().replace(/\s+/g, '');
          let plate = '';
          let tag = '';
          if (/^\d{6,}$/.test(tpClean)) {
            tag = tpClean;
          } else {
            plate = tpClean.replace(/[-\s]?FL$/, '').replace(/[^A-Z0-9]/g, '');
          }
          // The SunPass transaction number is the stable id and MUST match the manual
          // backfill's externalId so re-scrapes dedup instead of duplicating.
          const externalId = String(raw.transactionNumber || '').trim()
            || normalizeToken(`${plate}|${tag}|${transactionAt.toISOString()}|${amount}|${raw.location}`);
          if (!externalId) continue;
          if (seenExternalIds.has(externalId)) {
            dedupedInRunCount += 1;
            continue;
          }
          seenExternalIds.add(externalId);
          rows.push({
            transactionAt: transactionAt.toISOString(),
            amount,
            location: String(raw.location || '').trim(),
            lane: '',
            direction: '',
            plate,
            tag,
            sello: '',
            transactionTimeRaw: String(raw.transactionTime || '').trim(),
            externalId
          });
        } catch {
          // Skip malformed rows
        }
      }

      if (!rows.length) {
        const startedAt = new Date();
        const run = await prisma.tollImportRun.create({
          data: {
            tenantId: scope.tenantId,
            providerAccountId: providerAccount.id,
            sourceType: 'SUNPASS_SYNC',
            status: 'COMPLETED',
            importedCount: 0,
            matchedCount: 0,
            reviewCount: 0,
            startedAt,
            completedAt: startedAt,
            metadataJson: JSON.stringify({
              liveSync: true,
              provider: 'SUNPASS',
              actorUserId: actorUserId || null,
              note: 'SunPass sync completed with no new rows',
              autoSync: { scrapedCount: 0, dedupedInRunCount, duplicateExistingCount: 0, importedCount: 0 },
              debug
            })
          }
        });

        await prisma.tollProviderAccount.update({
          where: { id: providerAccount.id },
          data: {
            lastSyncAt: startedAt,
            lastSyncStatus: 'SYNC_OK',
            lastSyncMessage: buildSyncSummaryMessage({ scrapedCount: 0, dedupedInRunCount, duplicateExistingCount: 0, importedCount: 0 })
          }
        });

        return { ok: true, createdCount: 0, importRun: serializeImportRun(run) };
      }

      const created = await this.createManualTransactions(rows, scope, actorUserId, {
        sourceType: 'SUNPASS_SYNC',
        providerAccountId: providerAccount.id,
        importMeta: { scrapedCount: rows.length, dedupedInRunCount, debug }
      });

      await prisma.tollProviderAccount.update({
        where: { id: providerAccount.id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'SYNC_OK',
          lastSyncMessage: buildSyncSummaryMessage(created?.summary || { scrapedCount: rows.length, dedupedInRunCount, importedCount: Array.isArray(created?.created) ? created.created.length : 0 })
        }
      });

      return {
        ok: true,
        createdCount: Array.isArray(created?.created) ? created.created.length : 0,
        summary: created?.summary || null,
        importRun: created?.importRun || null
      };
    } catch (error) {
      await prisma.tollProviderAccount.update({
        where: { id: providerAccount.id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'SYNC_FAILED',
          lastSyncMessage: String(error?.message || 'SunPass sync failed')
        }
      });
      throw error;
    } finally {
      tollSyncLocks.delete(syncLockKey);
    }
  },

  async runMockSync(scope = {}, actorUserId = null) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for toll provider setup');
    const provider = await resolveActiveProvider(scope.tenantId);
    const row = await prisma.tollProviderAccount.findFirst({
      where: {
        tenantId: scope.tenantId,
        provider
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
    });
    if (!row) throw new Error(`${provider} provider account is not configured`);

    const health = await this.runProviderHealthCheck(scope);
    if (!health.ready) throw new Error(`Provider not ready: ${(health.missing || []).join(', ')}`);

    const startedAt = new Date();
    const run = await prisma.tollImportRun.create({
      data: {
        tenantId: scope.tenantId,
        providerAccountId: row.id,
        sourceType: 'AUTOEXPRESO_MOCK_SYNC',
        status: 'COMPLETED',
        importedCount: 0,
        matchedCount: 0,
        reviewCount: 0,
        startedAt,
        completedAt: startedAt,
        metadataJson: JSON.stringify({
          mock: true,
          actorUserId: actorUserId || null,
          note: 'Mock sync completed without scraping'
        })
      }
    });

    await prisma.tollProviderAccount.update({
      where: { id: row.id },
      data: {
        lastSyncAt: startedAt,
        lastSyncStatus: 'MOCK_SYNC_OK',
        lastSyncMessage: 'Mock sync completed. Ready for real scraper integration.'
      }
    });

    return {
      ok: true,
      importRun: serializeImportRun(run)
    };
  },

  async runLiveSync(scope = {}, actorUserId = null, options = {}) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for toll provider setup');
    // Provider can be pinned by the caller (the decoupled per-provider sweep passes it
    // explicitly) so a tenant with BOTH a SunPass and an AutoExpreso account syncs the
    // intended one — otherwise fall back to the tenant's active provider.
    const provider = options.provider
      ? String(options.provider).toUpperCase()
      : await resolveActiveProvider(scope.tenantId);
    // Lock per (tenant, provider) so SunPass and AutoExpreso never block one another.
    const syncLockKey = `${scope.tenantId}:${provider}`;
    if (tollSyncLocks.has(syncLockKey)) {
      throw new Error('Toll sync already running for this tenant');
    }

    tollSyncLocks.add(syncLockKey);
    const row = await prisma.tollProviderAccount.findFirst({
      where: {
        tenantId: scope.tenantId,
        provider
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
    });
    if (!row) throw new Error(`${provider} provider account is not configured`);

    const health = await this.runProviderHealthCheck(scope, provider);
    if (!health.ready) throw new Error(`Provider not ready: ${(health.missing || []).join(', ')}`);

    if (provider === 'SUNPASS') {
      return this._runSunPassSync(row, scope, actorUserId, syncLockKey);
    }

    const withPage = await resolveTollWithPage();

    const settings = safeJsonParse(row.settingsJson, {});
    const loginUrl = String(settings.loginUrl || AUTOEXPRESO_LOGIN_URL).trim() || AUTOEXPRESO_LOGIN_URL;
    const transactionUrl = String(settings.transactionUrl || AUTOEXPRESO_BALANCE_URL).trim() || AUTOEXPRESO_BALANCE_URL;
    const maxPages = Number(settings.maxPages || 25) > 0 ? Number(settings.maxPages || 25) : 25;
    const username = String(row.username || '').trim();
    const password = decodeSecret(row.passwordEncrypted);

    try {
      // Scrape (login + pagination) under the shared singleton browser and
      // the global page cap. Only the scrape holds the semaphore — the Prisma
      // writes below run after the page is closed and the permit released.
      const { rows, dedupedInRunCount } = await withPage(async (page) => {
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        await page.waitForSelector(AUTOEXPRESO_USERNAME_SELECTOR, { timeout: 30000 });
        await page.waitForSelector(AUTOEXPRESO_PASSWORD_SELECTOR, { timeout: 30000 });
        await page.click(AUTOEXPRESO_USERNAME_SELECTOR, { clickCount: 3 }).catch(() => null);
        await page.type(AUTOEXPRESO_USERNAME_SELECTOR, username);
        await page.click(AUTOEXPRESO_PASSWORD_SELECTOR, { clickCount: 3 }).catch(() => null);
        await page.type(AUTOEXPRESO_PASSWORD_SELECTOR, password);

        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null),
          clickAutoExpresoLoginButton(page)
        ]);

        await page.goto(transactionUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        const transactionState = await waitForAutoExpresoTransactionState(page, 30000);
        if (transactionState !== 'transactions') {
          const pageState = await captureAutoExpresoPageState(page);
          const accountStatementHint = transactionState === 'account-statements'
            ? ' | This AutoExpreso account is landing on monthly account statements instead of the legacy live transaction feed. Use manual/CSV import for now or add monthly statement ingestion for this tenant.'
            : '';
          throw new Error(`AutoExpreso sync could not open transactions (${transactionState}). URL: ${pageState.url || 'unknown'} | Title: ${pageState.title || 'unknown'}${pageState.hint ? ` | Hint: ${pageState.hint}` : ''}${accountStatementHint}`);
        }
        await waitForAutoExpresoRows(page, 20000);

        const rows = [];
        const seenExternalIds = new Set();
        let dedupedInRunCount = 0;
        let pageNumber = 0;
        while (pageNumber < maxPages) {
          const pageRows = await scrapeAutoExpresoBalanceRows(page);
          for (const raw of pageRows) {
            try {
              const transactionAt = parseAutoExpresoDateTime(raw.datetimeFull);
              const amount = Number(raw.amount);
              if (!Number.isFinite(amount) || amount <= 0 || amount > 100) continue;
              const externalId = normalizeToken(`${raw.plateRaw}|${raw.selloRaw}|${transactionAt.toISOString()}|${amount}|${raw.location}`);
              if (!externalId) continue;
              if (seenExternalIds.has(externalId)) {
                dedupedInRunCount += 1;
                continue;
              }
              seenExternalIds.add(externalId);
              rows.push({
                transactionAt: transactionAt.toISOString(),
                amount,
                location: String(raw.location || '').trim(),
                lane: '',
                direction: '',
                plate: String(raw.plateRaw || '').trim(),
                tag: '',
                sello: String(raw.selloRaw || '').trim(),
                transactionTimeRaw: String(raw.datetimeFull || '').split(/\s+/).slice(1).join(' '),
                externalId
              });
            } catch {
              // Skip malformed rows but continue sync.
            }
          }

          const beforeSnapshot = await page.evaluate(() => String(document.body?.innerText || '').slice(0, 2000)).catch(() => '');
          const moved = await clickAutoExpresoNextPage(page);
          if (!moved) break;
          await page.waitForFunction((previous) => String(document.body?.innerText || '').slice(0, 2000) !== previous, { timeout: 15000 }, beforeSnapshot).catch(() => null);
          await waitForAutoExpresoRows(page, 10000);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          pageNumber += 1;
        }

        return { rows, dedupedInRunCount };
      });

      if (!rows.length) {
        const startedAt = new Date();
        const run = await prisma.tollImportRun.create({
          data: {
            tenantId: scope.tenantId,
            providerAccountId: row.id,
            sourceType: 'AUTOEXPRESO_SYNC',
            status: 'COMPLETED',
            importedCount: 0,
            matchedCount: 0,
            reviewCount: 0,
            startedAt,
            completedAt: startedAt,
            metadataJson: JSON.stringify({
              liveSync: true,
              actorUserId: actorUserId || null,
              note: 'AutoExpreso sync completed with no new rows',
              autoSync: {
                scrapedCount: 0,
                dedupedInRunCount,
                duplicateExistingCount: 0,
                importedCount: 0
              }
            })
          }
        });

        await prisma.tollProviderAccount.update({
          where: { id: row.id },
          data: {
            lastSyncAt: startedAt,
            lastSyncStatus: 'SYNC_OK',
            lastSyncMessage: buildSyncSummaryMessage({
              scrapedCount: 0,
              dedupedInRunCount,
              duplicateExistingCount: 0,
              importedCount: 0
            })
          }
        });

        return {
          ok: true,
          createdCount: 0,
          importRun: serializeImportRun(run)
        };
      }

      const created = await this.createManualTransactions(rows, scope, actorUserId, {
        sourceType: 'AUTOEXPRESO_SYNC',
        providerAccountId: row.id,
        importMeta: {
          scrapedCount: rows.length,
          dedupedInRunCount
        }
      });

      await prisma.tollProviderAccount.update({
        where: { id: row.id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'SYNC_OK',
          lastSyncMessage: buildSyncSummaryMessage(created?.summary || {
            scrapedCount: rows.length,
            dedupedInRunCount,
            importedCount: Array.isArray(created?.created) ? created.created.length : 0
          })
        }
      });

      return {
        ok: true,
        createdCount: Array.isArray(created?.created) ? created.created.length : 0,
        summary: created?.summary || null,
        importRun: created?.importRun || null
      };
    } catch (error) {
      await prisma.tollProviderAccount.update({
        where: { id: row.id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'SYNC_FAILED',
          lastSyncMessage: String(error?.message || 'AutoExpreso sync failed')
        }
      });
      throw error;
    } finally {
      tollSyncLocks.delete(syncLockKey);
    }
  },

  async autoMatchPendingTransactions(scope = {}, actorUserId = null, options = {}) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for toll auto-match');

    const limit = Number(options.limit || 200) > 0 ? Number(options.limit || 200) : 200;
    const rows = await prisma.tollTransaction.findMany({
      where: {
        ...tenantWhereForScope(scope),
        needsReview: true,
        billingStatus: 'PENDING'
      },
      include: {
        assignments: true
      },
      orderBy: [{ transactionAt: 'desc' }],
      take: limit
    });

    // Same fleet for every row in this batch — load it once, not per toll.
    const bulkVehicleCache = await loadTenantVehicleMatchCache(scope);

    let autoConfirmed = 0;
    let suggested = 0;
    let reviewed = 0;
    const reservationIdsToSync = new Set();

    for (const transaction of rows) {
      const suggestion = await rematchTransactionRow(transaction, scope, actorUserId, bulkVehicleCache);

      reviewed += 1;
      if (suggestion.matchStatus === 'AUTO_CONFIRMED') {
        autoConfirmed += 1;
        if (suggestion.reservation?.id) reservationIdsToSync.add(String(suggestion.reservation.id));
      } else if (suggestion.reservation?.id) {
        suggested += 1;
      }
    }

    for (const reservationId of reservationIdsToSync) {
      await syncReservationTollCharges(reservationId, scope);
    }

    const pendingReviewCount = await prisma.tollTransaction.count({
      where: {
        ...tenantWhereForScope(scope),
        needsReview: true,
        billingStatus: 'PENDING'
      }
    });

    return {
      reviewed,
      autoConfirmed,
      suggested,
      pendingReviewCount
    };
  },

  // Scheduled re-match sweep (TollBridge finding (b), 2026-07-26). CA tolls
  // post up to a month after the crossing, when the reservation data they
  // should match (agreement, swaps, plates) may not have been complete at
  // import time. Before this sweep, a toll that failed to match at import was
  // retried ONLY when someone pressed bulk-auto-match by hand — late tolls
  // could sit unmatched forever, silent loss. The window is PER SEDE
  // (locationConfig.tolls.rematchWindowDays, default 14): LAX sets 45 without
  // reopening months-closed contracts at other sedes. Runs on its own worker
  // timer, independent of the scraper sweeps.
  async runRematchSweep() {
    const tenants = await prisma.tenant.findMany({
      where: { tollsEnabled: true },
      select: { id: true }
    });

    const results = [];
    for (const tenant of tenants) {
      try {
        results.push(await this.rematchTenantWithinWindow(tenant.id));
      } catch (error) {
        logger.error('[tolls] re-match sweep failed for tenant', {
          tenantId: tenant.id,
          err: String(error?.message || error)
        });
        results.push({ tenantId: tenant.id, ok: false, error: String(error?.message || 'Re-match failed') });
      }
    }

    return { processedTenants: results.length, results };
  },

  /**
   * The recurring sweep: re-match this tenant's held tolls inside each sede's
   * own re-match window (default 14 days).
   */
  async rematchTenantWithinWindow(tenantId) {
    return this.rematchTenant(tenantId, {});
  },

  /**
   * Re-match a tenant's needs-review tolls.
   *
   * Default behaviour is the recurring sweep: each toll is fenced by its own
   * sede's rematchWindowDays. Pass `ignoreWindow` to reach further back — that
   * is the recovery path for a toll whose reservation was created AFTER the
   * toll was imported, which the window can never catch up with once the toll
   * ages past it.
   *
   * WHY THIS EXISTS (International Rental Corp, 2026-08-03): 3,478 of their
   * 3,532 unmatched tolls sat outside the 14-day window, so the sweep could
   * not see them at all. 204 of those DO fall inside a reservation — typically
   * the toll was imported in March and the reservation row was created in May
   * covering a window that had already started. Nothing short of clicking each
   * one could recover them.
   *
   * Paginates by cursor instead of the old single `take: 500`. That cap was
   * silent: with thousands of held rows everything past the 500 most recent
   * was skipped on every pass, and the summary still read like a clean run.
   */
  async rematchTenant(tenantId, {
    ignoreWindow = false,
    since = null,
    batchSize = 250,
    maxRows = 5000,
    dryRun = false,
  } = {}) {
    if (!tenantId) throw new Error('tenantId is required for toll re-match');
    const scope = systemScope({ tenantId });

    const locations = await prisma.location.findMany({
      where: { tenantId },
      select: { id: true, locationConfig: true }
    });
    const windowByLocation = new Map(locations.map((row) => [
      String(row.id),
      resolveTollLocationSettings(parseLocationConfig(row.locationConfig)).rematchWindowDays
    ]));
    const widestWindowDays = Math.max(DEFAULT_REMATCH_WINDOW_DAYS, ...windowByLocation.values());

    const now = Date.now();
    const sinceDate = since ? new Date(since) : null;
    const lowerBound = ignoreWindow
      ? (sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : null)
      : new Date(now - widestWindowDays * DAY_MS);

    // Load the fleet ONCE for the whole run — see loadTenantVehicleMatchCache.
    const vehicleCache = await loadTenantVehicleMatchCache(scope);

    let scanned = 0;
    let eligibleCount = 0;
    let autoConfirmed = 0;
    let changed = 0;
    let truncated = false;
    let cursor = null;
    const reservationIdsToSync = new Set();

    for (;;) {
      const remaining = maxRows - scanned;
      if (remaining <= 0) { truncated = true; break; }
      const rows = await prisma.tollTransaction.findMany({
        where: {
          tenantId,
          needsReview: true,
          billingStatus: 'PENDING',
          // A human parked these via RESET_MATCH — the machine keeps its hands
          // off until a human acts again (bulk-auto-match clears the hold).
          manualHoldAt: null,
          ...(lowerBound ? { transactionAt: { gte: lowerBound } } : {})
        },
        orderBy: [{ transactionAt: 'desc' }, { id: 'desc' }],
        take: Math.min(batchSize, remaining),
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
      });
      if (!rows.length) break;
      scanned += rows.length;
      cursor = rows[rows.length - 1].id;

      // On the recurring sweep the DB fence above uses the WIDEST window in the
      // tenant; this per-row fence applies each toll's own sede window. A toll
      // without a sede stamp gets the conservative default, never the widest.
      // A windowless recovery run skips the fence entirely.
      const eligible = ignoreWindow ? rows : rows.filter((row) => {
        const windowDays = row.locationId
          ? (windowByLocation.get(String(row.locationId)) ?? DEFAULT_REMATCH_WINDOW_DAYS)
          : DEFAULT_REMATCH_WINDOW_DAYS;
        return new Date(row.transactionAt).getTime() >= now - windowDays * DAY_MS;
      });
      eligibleCount += eligible.length;

      for (const transaction of eligible) {
        if (dryRun) {
          const suggestion = await buildMatchSuggestion(transaction, scope, vehicleCache);
          if (suggestion.matchStatus === 'AUTO_CONFIRMED' && suggestion.reservation?.id) autoConfirmed += 1;
          continue;
        }
        const suggestion = await rematchTransactionRow(transaction, scope, null, vehicleCache);
        if (!suggestion.unchanged) changed += 1;
        if (suggestion.matchStatus === 'AUTO_CONFIRMED' && suggestion.reservation?.id) {
          autoConfirmed += 1;
          reservationIdsToSync.add(String(suggestion.reservation.id));
        }
      }
    }

    // Charge sync mirrors to the agreement (allowClosed) and fires the staff
    // alert — the full "late toll lands on a closed contract" pipeline.
    if (!dryRun) {
      for (const reservationId of reservationIdsToSync) {
        await syncReservationTollCharges(reservationId, scope);
      }
    }

    // Never let a bounded run read as a complete one.
    if (truncated) {
      logger.warn('[tolls] re-match stopped at maxRows — more rows remain unprocessed', {
        tenantId, scanned, maxRows
      });
    }

    return {
      tenantId,
      ok: true,
      scanned,
      eligible: eligibleCount,
      autoConfirmed,
      changed,
      reservationsSynced: reservationIdsToSync.size,
      truncated,
      dryRun,
      ignoreWindow
    };
  },

  // Bandeja "peajes por cobrar": unacknowledged matched/billed tolls, closed
  // contracts first (that's the risk case — the customer already left).
  // Location-scoped like every other toll read; any authenticated staff can
  // see it (same posture as the tolls dashboard).
  async listStaffTollAlerts(scope = {}, filters = {}) {
    const state = await getTenantTollsState(scope);
    if (!state.tollsEnabled) return { tollsEnabled: false, alerts: [] };

    const rows = await prisma.tollTransaction.findMany({
      where: {
        ...tenantWhereForScope(scope),
        ...tollLocationWhere(scope),
        ...(filters.reservationId ? { reservationId: String(filters.reservationId) } : {}),
        staffAckAt: null,
        reservationId: { not: null },
        status: { in: ['MATCHED', 'BILLED'] },
        billingStatus: { in: ['PENDING', 'POSTED_TO_RESERVATION', 'POSTED_TO_AGREEMENT'] }
      },
      include: {
        reservation: {
          select: {
            id: true,
            reservationNumber: true,
            status: true,
            customer: { select: { firstName: true, lastName: true } },
            rentalAgreement: { select: { id: true, agreementNumber: true, status: true } }
          }
        }
      },
      orderBy: [{ transactionAt: 'desc' }],
      take: 100
    });

    const alerts = rows.map((row) => {
      const agreement = row.reservation?.rentalAgreement || null;
      return {
        id: row.id,
        amount: toMoney(row.amount),
        transactionAt: row.transactionAt,
        location: row.location || '',
        plate: row.plateRaw || row.plateNormalized || '',
        staffNotifiedAt: row.staffNotifiedAt,
        reservationId: row.reservation?.id || null,
        reservationNumber: row.reservation?.reservationNumber || '',
        customerName: [row.reservation?.customer?.firstName, row.reservation?.customer?.lastName].filter(Boolean).join(' '),
        agreementNumber: agreement?.agreementNumber || '',
        agreementClosed: String(agreement?.status || '').toUpperCase() === 'CLOSED'
      };
    });
    alerts.sort((a, b) => Number(b.agreementClosed) - Number(a.agreementClosed)
      || new Date(b.transactionAt).getTime() - new Date(a.transactionAt).getTime());

    return { tollsEnabled: true, alerts };
  },

  // Mark a toll alert as seen/collected. Goes through getTransactionOrThrow so
  // a branch user cannot ack another branch's toll by holding an id.
  async acknowledgeTollAlert(id, scope = {}, actorUserId = null) {
    const row = await getTransactionOrThrow(id, scope);
    if (row.staffAckAt) return { ok: true, alreadyAcknowledged: true };
    await prisma.tollTransaction.update({
      where: { id: row.id },
      data: { staffAckAt: new Date(), staffAckByUserId: actorUserId || null }
    });
    return { ok: true, alreadyAcknowledged: false };
  },

  // AutoExpreso (PR) sweep — kept as a thin wrapper for backward-compat. The worker
  // calls this on its own timer.
  async runAutomaticSyncSweep() {
    return this._runSyncSweepForProvider('AUTOEXPRESO', getAutoSyncIntervalMinutes());
  },

  // SunPass (FL) sweep — runs on a SEPARATE worker timer with its OWN interval gate, so
  // SunPass and AutoExpreso never share a cycle: a slow/failed run of one cannot delay
  // or block the other (they only share the capped Chromium singleton at the page level).
  async runSunPassSyncSweep() {
    return this._runSyncSweepForProvider('SUNPASS', getSunPassSyncIntervalMinutes());
  },

  // Provider-parametric sweep core. Iterates every ACTIVE TollProviderAccount of the
  // given provider whose tenant has tolls enabled, gated by per-account lastSyncAt.
  async _runSyncSweepForProvider(provider, intervalMinutes) {
    const providerAccounts = await prisma.tollProviderAccount.findMany({
      where: {
        provider,
        isActive: true,
        tenant: {
          tollsEnabled: true
        }
      },
      select: {
        id: true,
        tenantId: true,
        username: true,
        passwordEncrypted: true,
        settingsJson: true,
        lastSyncAt: true
      },
      orderBy: [{ updatedAt: 'asc' }]
    });

    const now = Date.now();
    const results = [];

    for (const providerAccount of providerAccounts) {
      const tenantId = providerAccount.tenantId;
      const password = decodeSecret(providerAccount.passwordEncrypted);
      if (!tenantId || !String(providerAccount.username || '').trim() || !password) {
        results.push({ tenantId, ok: false, skipped: true, reason: 'provider-not-ready' });
        continue;
      }

      const lastSyncAt = providerAccount.lastSyncAt ? new Date(providerAccount.lastSyncAt).getTime() : 0;
      if (lastSyncAt && now - lastSyncAt < intervalMinutes * 60 * 1000) {
        results.push({ tenantId, ok: true, skipped: true, reason: 'within-sync-interval' });
        continue;
      }

      try {
        const liveSync = await this.runLiveSync({ tenantId }, null, { provider });
        const autoMatch = await this.autoMatchPendingTransactions({ tenantId }, null);
        const importedCount = Number(liveSync?.createdCount || 0);
        const autoMatchedCount = Number(autoMatch?.autoConfirmed || 0);
        const suggestedCount = Number(autoMatch?.suggested || 0);
        const pendingReviewCount = Number(autoMatch?.pendingReviewCount || 0);
        const syncSummary = liveSync?.summary || {};

        if (liveSync?.importRun?.id) {
          const currentRun = await prisma.tollImportRun.findUnique({
            where: { id: liveSync.importRun.id },
            select: { id: true, metadataJson: true }
          });
          if (currentRun) {
            const existingMeta = safeJsonParse(currentRun.metadataJson, {});
            await prisma.tollImportRun.update({
              where: { id: currentRun.id },
              data: {
                metadataJson: JSON.stringify({
                  ...existingMeta,
                  autoSync: {
                    scrapedCount: Number(syncSummary?.scrapedCount || 0),
                    dedupedInRunCount: Number(syncSummary?.dedupedInRunCount || 0),
                    duplicateExistingCount: Number(syncSummary?.duplicateExistingCount || 0),
                    importedCount,
                    autoMatchedCount,
                    suggestedCount,
                    pendingReviewCount
                  }
                })
              }
            });
          }
        }

        const providerAccount = await prisma.tollProviderAccount.findFirst({
          where: { tenantId, provider, isActive: true },
          orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
        });
        if (providerAccount) {
          const syncMessage = buildSyncSummaryMessage({
            scrapedCount: Number(syncSummary?.scrapedCount || 0),
            dedupedInRunCount: Number(syncSummary?.dedupedInRunCount || 0),
            duplicateExistingCount: Number(syncSummary?.duplicateExistingCount || 0),
            importedCount
          });
          await prisma.tollProviderAccount.update({
            where: { id: providerAccount.id },
            data: {
              lastSyncAt: new Date(),
              lastSyncStatus: 'SYNC_OK',
              lastSyncMessage: `${syncMessage} | Auto-matched ${autoMatchedCount} | Suggested ${suggestedCount} | Pending review ${pendingReviewCount}`
            }
          });
        }

        results.push({
          tenantId,
          ok: true,
          createdCount: importedCount,
          scrapedCount: Number(syncSummary?.scrapedCount || 0),
          duplicateExistingCount: Number(syncSummary?.duplicateExistingCount || 0),
          autoMatched: autoMatchedCount,
          suggested: suggestedCount,
          pendingReviewCount
        });
      } catch (error) {
        results.push({
          tenantId,
          ok: false,
          error: String(error?.message || 'Auto toll sync failed')
        });
      }
    }

    return {
      processedTenants: results.length,
      results
    };
  },

  async createManualTransactions(rows = [], scope = {}, actorUserId = null, options = {}) {
    await ensureTenantAllowsTolls(scope);
    if (!scope?.tenantId) throw new Error('tenantId is required for manual toll imports');
    const inputRows = (Array.isArray(rows) ? rows : []).filter(Boolean);
    if (!inputRows.length) throw new Error('rows are required');

    const activeProvider = await resolveActiveProvider(scope.tenantId);
    const providerAccount = await prisma.tollProviderAccount.findFirst({
      where: {
        tenantId: scope.tenantId,
        provider: activeProvider
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
    });

    const effectiveProviderAccount = providerAccount || await prisma.tollProviderAccount.create({
      data: {
        tenantId: scope.tenantId,
        provider: activeProvider,
        isActive: false,
        lastSyncStatus: 'PENDING_SETUP',
        lastSyncMessage: 'Created automatically from manual toll import'
      }
    });

    // Sede stamp (TollBridge finding (a)): every transaction inherits the
    // sede of the account it came through, so matching and the re-match
    // window can scope per location. Explicit options.locationId wins (used
    // by feed clients that know the sede per row); otherwise the account's —
    // but ONLY when the source account is unambiguous. Null keeps the
    // pre-existing tenant-wide behavior.
    let stampLocationId = null;
    if (options.locationId) {
      // Tenant-validate like saveProviderAccount does — a cross-tenant id
      // would silently mis-scope every row of the import (QA 2026-07-26).
      const requested = await prisma.location.findFirst({
        where: { id: String(options.locationId), tenantId: scope.tenantId },
        select: { id: true }
      });
      if (!requested) throw new Error('locationId does not belong to this tenant');
      stampLocationId = requested.id;
    } else if (options.providerAccountId) {
      // Explicit source account (live/mock sync, future feed clients): its
      // binding is authoritative whether or not it happens to be the one
      // resolveActiveProvider picked.
      if (options.providerAccountId === effectiveProviderAccount.id) {
        stampLocationId = effectiveProviderAccount.locationId || null;
      } else {
        const stampAccount = await prisma.tollProviderAccount.findFirst({
          where: { id: options.providerAccountId, tenantId: scope.tenantId },
          select: { locationId: true }
        });
        stampLocationId = stampAccount?.locationId || null;
      }
    } else if (effectiveProviderAccount.locationId) {
      // QA 2026-07-26: callers that DON'T say which account they're importing
      // for (internal droplet ingest, staff manual import) fall back to
      // resolveActiveProvider = "most recently updated account". In a
      // multi-account tenant (the exact LAX+FL case) that guess can be WRONG,
      // and a wrong stamp bulk-holds the whole batch as
      // vehicle-outside-location. Only inherit the stamp when the resolved
      // account is the tenant's ONLY provider account; otherwise import
      // unstamped (tenant-wide matching, the pre-feature behavior).
      const accountCount = await prisma.tollProviderAccount.count({
        where: { tenantId: scope.tenantId }
      });
      if (accountCount === 1) {
        stampLocationId = effectiveProviderAccount.locationId;
      } else {
        logger.warn('[tolls] import without explicit providerAccountId in a multi-account tenant - NOT stamping a sede', {
          tenantId: scope.tenantId,
          resolvedAccountId: effectiveProviderAccount.id
        });
      }
    }

    const importRun = await prisma.tollImportRun.create({
      data: {
        tenantId: scope.tenantId,
        providerAccountId: options.providerAccountId || effectiveProviderAccount.id,
        sourceType: options.sourceType || (inputRows.length > 1 ? 'CSV_PASTE' : 'MANUAL_ENTRY'),
        status: 'RUNNING'
      }
    });

    const created = [];
    let duplicateExistingCount = 0;
    const reservationIdsToSync = new Set();
    for (const raw of inputRows) {
      const transactionAt = normalizeDateTime(raw.transactionAt);
      const plateRaw = String(raw.plate || raw.plateRaw || '').trim();
      const tagRaw = String(raw.tag || raw.tagRaw || raw.tollTagNumber || '').trim();
      const selloRaw = String(raw.sello || raw.selloRaw || raw.tollStickerNumber || '').trim();
      const amount = toMoney(raw.amount);
      if (!(amount > 0)) throw new Error('amount must be > 0');

      const draft = {
        transactionAt,
        transactionDate: startOfDay(transactionAt),
        transactionTimeRaw: String(raw.transactionTimeRaw || '').trim() || transactionAt.toISOString().slice(11, 16),
        amount,
        location: String(raw.location || '').trim() || null,
        lane: String(raw.lane || '').trim() || null,
        direction: String(raw.direction || '').trim() || null,
        plateRaw: plateRaw || null,
        plateNormalized: normalizeNullableToken(plateRaw),
        tagRaw: tagRaw || null,
        tagNormalized: normalizeNullableToken(tagRaw),
        selloRaw: selloRaw || null,
        selloNormalized: normalizeNullableToken(selloRaw),
        externalId: String(raw.externalId || '').trim() || null,
        // On the draft too (not just the row) so buildMatchSuggestion applies
        // the sede filter to the pre-create suggestion, not only on re-match.
        locationId: stampLocationId,
        sourcePayloadJson: JSON.stringify(raw || {})
      };

      if (draft.externalId) {
        const existing = await prisma.tollTransaction.findFirst({
          where: {
            tenantId: scope.tenantId,
            externalId: draft.externalId
          },
          select: { id: true }
        });
        if (existing) {
          duplicateExistingCount += 1;
          continue;
        }
      }

      const suggestion = await buildMatchSuggestion(draft, scope);
      const row = await prisma.$transaction(async (tx) => {
        const createdTransaction = await tx.tollTransaction.create({
          data: {
            tenantId: scope.tenantId,
            providerAccountId: options.providerAccountId || effectiveProviderAccount.id,
            importRunId: importRun.id,
            externalId: draft.externalId,
            transactionAt: draft.transactionAt,
            transactionDate: draft.transactionDate,
            transactionTimeRaw: draft.transactionTimeRaw,
            amount: draft.amount,
            location: draft.location,
            lane: draft.lane,
            direction: draft.direction,
            plateRaw: draft.plateRaw,
            plateNormalized: draft.plateNormalized,
            tagRaw: draft.tagRaw,
            tagNormalized: draft.tagNormalized,
            selloRaw: draft.selloRaw,
            selloNormalized: draft.selloNormalized,
            locationId: stampLocationId,
            vehicleId: suggestion.vehicle?.id || null,
            reservationId: suggestion.reservation?.id || null,
            status: suggestion.matchStatus === 'AUTO_CONFIRMED' ? 'MATCHED' : 'NEEDS_REVIEW',
            matchConfidence: suggestion.score || null,
            needsReview: suggestion.needsReview !== false,
            billingStatus: 'PENDING',
            sourcePayloadJson: draft.sourcePayloadJson,
            reviewNotes: suggestion.matchReason || null
          }
        });

        if (suggestion.reservation?.id) {
          await createAssignmentRecord(tx, createdTransaction, suggestion, actorUserId);
        }

        return createdTransaction;
      });

      // POST-WRITE HYDRATION, not a read — the row was just created above and is
      // already committed. It must NOT go through the caller's location filter:
      // an imported toll whose plate matches no vehicle lands with vehicleId =
      // null, which `tollLocationWhere` excludes by design, so a location-scoped
      // staffer pasting a CSV would throw on the first unmatched row — after the
      // row committed, leaving the import run stuck at RUNNING.
      const hydrated = await getTransactionOrThrow(row.id, systemScope(scope));
      created.push(hydrated);
      if (hydrated?.reservationId && String(hydrated.status || '').toUpperCase() === 'MATCHED') {
        reservationIdsToSync.add(String(hydrated.reservationId));
      }
    }

    for (const reservationId of reservationIdsToSync) {
      await syncReservationTollCharges(reservationId, scope);
    }

    const summary = {
      scrapedCount: Number(options?.importMeta?.scrapedCount || inputRows.length || 0),
      dedupedInRunCount: Number(options?.importMeta?.dedupedInRunCount || 0),
      duplicateExistingCount,
      importedCount: created.length
    };

    await prisma.tollImportRun.update({
      where: { id: importRun.id },
      data: {
        completedAt: new Date(),
        status: 'COMPLETED',
        importedCount: created.length,
        matchedCount: created.filter((row) => String(row.status || '').toUpperCase() === 'MATCHED').length,
        reviewCount: created.filter((row) => !!row.needsReview).length,
        metadataJson: JSON.stringify({
          ...(options?.importMeta || {}),
          duplicateExistingCount,
          importedCount: created.length
        })
      }
    });

    return {
      created: created.map(serializeTransaction),
      summary,
      importRun: serializeImportRun(await prisma.tollImportRun.findUnique({ where: { id: importRun.id } }))
    };
  },

  async confirmMatch(id, payload = {}, scope = {}, actorUserId = null) {
    await ensureTenantAllowsTolls(scope);
    const transaction = await getTransactionOrThrow(id, scope);
    const reservationId = payload.reservationId ? String(payload.reservationId) : null;
    const reservationNumber = payload.reservationNumber ? String(payload.reservationNumber).trim() : '';

    // The TARGET reservation is free-choice input, so the by-id gateway above
    // does not cover it: without this gate a scoped caller could take an in-scope
    // toll and post its money onto another branch's reservation, which they
    // cannot even read. Same fragment listReservationTolls uses.
    const resLocWhere = reservationLocationWhere(scope);
    let reservation = null;
    if (reservationId) {
      reservation = await prisma.reservation.findFirst({
        where: { id: reservationId, ...tenantWhereForScope(scope), ...resLocWhere },
        include: { vehicle: true, customer: { select: { id: true, firstName: true, lastName: true } } }
      });
    } else if (reservationNumber) {
      reservation = await prisma.reservation.findFirst({
        where: { reservationNumber, ...tenantWhereForScope(scope), ...resLocWhere },
        include: { vehicle: true, customer: { select: { id: true, firstName: true, lastName: true } } }
      });
    }
    if (!reservation) throw new Error('Reservation not found for toll match');

    const vehicle = reservation.vehicle || (reservation.vehicleId
      ? await prisma.vehicle.findUnique({ where: { id: reservation.vehicleId } })
      : null);

    const suggestion = {
      vehicle,
      reservation,
      score: payload.confidence != null ? Number(payload.confidence) : 100,
      matchStatus: 'CONFIRMED',
      matchReason: String(payload.matchReason || 'manual-confirmed').trim() || 'manual-confirmed'
    };

    await prisma.$transaction(async (tx) => {
      if (transaction.assignments?.length) {
        await tx.tollAssignment.updateMany({
          where: { tollTransactionId: transaction.id, status: { in: ['SUGGESTED', 'AUTO_CONFIRMED'] } },
          data: { status: 'REJECTED' }
        });
      }

      await tx.tollTransaction.update({
        where: { id: transaction.id },
        data: {
          vehicleId: reservation.vehicleId || vehicle?.id || null,
          reservationId: reservation.id,
          status: 'MATCHED',
          needsReview: false,
          matchConfidence: suggestion.score,
          reviewNotes: suggestion.matchReason
        }
      });

      await createAssignmentRecord(tx, transaction, suggestion, actorUserId);
    });

    await syncReservationTollCharges(reservation.id, scope);

    // POST-WRITE HYDRATION. The update above may have re-pointed this toll at the
    // reservation's vehicle, which can be homed at a different branch — re-reading
    // through the caller's filter would 404 AFTER the match and the charge sync
    // already committed.
    return serializeTransaction(await getTransactionOrThrow(transaction.id, systemScope(scope)));
  },

  async postToReservation(id, payload = {}, scope = {}, actorUserId = null) {
    await ensureTenantAllowsTolls(scope);
    const transaction = await getTransactionOrThrow(id, scope);
    if (!transaction.reservationId) throw new Error('Reservation match is required before posting a toll');
    const note = String(payload.note || '').trim();
    await syncReservationTollCharges(transaction.reservationId, scope, { note, actorUserId });

    await prisma.auditLog.create({
      data: {
        tenantId: transaction.tenantId,
        reservationId: transaction.reservationId,
        actorUserId: actorUserId || null,
        action: 'UPDATE',
        metadata: JSON.stringify({
          tollPostedToReservation: true,
          tollTransactionId: transaction.id,
          amount: toMoney(transaction.amount)
        })
      }
    });

    return serializeTransaction(await getTransactionOrThrow(transaction.id, scope));
  },

  async applyReviewAction(id, payload = {}, scope = {}, actorUserId = null) {
    await ensureTenantAllowsTolls(scope);
    const transaction = await getTransactionOrThrow(id, scope);
    const action = String(payload.action || '').toUpperCase();
    const note = String(payload.note || '').trim();
    if (!['RESET_MATCH', 'CONFIRM_DISPATCHED', 'MARK_NOT_DISPATCHED', 'MARK_DISPUTED', 'MARK_NOT_BILLABLE'].includes(action)) {
      throw new Error('Unsupported toll review action');
    }

    await prisma.$transaction(async (tx) => {
      if (action === 'RESET_MATCH') {
        await tx.tollAssignment.updateMany({
          where: {
            tollTransactionId: transaction.id,
            status: { in: ['SUGGESTED', 'AUTO_CONFIRMED', 'CONFIRMED'] }
          },
          data: { status: 'REJECTED' }
        });

        await tx.tollTransaction.update({
          where: { id: transaction.id },
          data: {
            reservationId: null,
            status: 'NEEDS_REVIEW',
            needsReview: true,
            matchConfidence: null,
            billingStatus: transaction.billingStatus === 'DISPUTED' ? 'DISPUTED' : 'PENDING',
            // A human parked this toll. The scheduled re-match sweep excludes
            // held rows — otherwise it would re-derive the exact suggestion
            // the human just rejected and silently re-bill it within hours
            // (QA blocker, 2026-07-26). Bulk-auto-match (human) clears it.
            manualHoldAt: new Date(),
            reviewNotes: mergeChargeNotes(transaction.reviewNotes, note || 'Match reset for manual review')
          }
        });
      }

      if (action === 'CONFIRM_DISPATCHED') {
        if (!transaction.reservationId) {
          throw new Error('Reservation match is required before confirming dispatch');
        }

        const reservation = await tx.reservation.findUnique({
          where: { id: transaction.reservationId },
          include: { vehicle: true }
        });
        if (!reservation) throw new Error('Reservation not found for dispatch confirmation');

        await tx.tollAssignment.updateMany({
          where: {
            tollTransactionId: transaction.id,
            status: { in: ['SUGGESTED', 'AUTO_CONFIRMED', 'CONFIRMED'] }
          },
          data: { status: 'REJECTED' }
        });

        await tx.tollTransaction.update({
          where: { id: transaction.id },
          data: {
            vehicleId: transaction.vehicleId || reservation.vehicleId || reservation.vehicle?.id || null,
            status: 'MATCHED',
            needsReview: false,
            billingStatus: transaction.billingStatus === 'DISPUTED' ? 'DISPUTED' : 'PENDING',
            reviewNotes: mergeChargeNotes(
              clearDispatchConfirmationReview(transaction.reviewNotes),
              note || 'Dispatch confirmed without formal checkout'
            )
          }
        });

        await createAssignmentRecord(tx, transaction, {
          vehicle: reservation.vehicle || null,
          reservation,
          score: transaction.matchConfidence != null ? Number(transaction.matchConfidence) : 100,
          matchStatus: 'CONFIRMED',
          matchReason: 'dispatch-confirmed'
        }, actorUserId);
      }

      if (action === 'MARK_NOT_DISPATCHED') {
        await tx.tollAssignment.updateMany({
          where: {
            tollTransactionId: transaction.id,
            status: { in: ['SUGGESTED', 'AUTO_CONFIRMED', 'CONFIRMED'] }
          },
          data: { status: 'REJECTED' }
        });

        await tx.tollTransaction.update({
          where: { id: transaction.id },
          data: {
            reservationId: null,
            status: 'VOID',
            needsReview: false,
            billingStatus: 'WAIVED',
            reviewNotes: mergeChargeNotes(transaction.reviewNotes, note || 'Vehicle was not dispatched to this customer')
          }
        });
      }

      if (action === 'MARK_DISPUTED') {
        await tx.tollTransaction.update({
          where: { id: transaction.id },
          data: {
            status: 'DISPUTED',
            billingStatus: 'DISPUTED',
            needsReview: true,
            reviewNotes: mergeChargeNotes(transaction.reviewNotes, note || 'Marked disputed')
          }
        });
      }

      if (action === 'MARK_NOT_BILLABLE') {
        await tx.tollTransaction.update({
          where: { id: transaction.id },
          data: {
            status: 'VOID',
            billingStatus: 'WAIVED',
            needsReview: false,
            reviewNotes: mergeChargeNotes(transaction.reviewNotes, note || 'Marked not billable')
          }
        });
      }

      if (transaction.reservationId) {
        await tx.auditLog.create({
          data: {
            tenantId: transaction.tenantId,
            reservationId: transaction.reservationId,
            actorUserId: actorUserId || null,
            action: 'UPDATE',
            metadata: JSON.stringify({
              tollReviewAction: action,
              tollTransactionId: transaction.id,
              note: note || null
            })
          }
        });
      }
    });

    let issueIncident = null;
    if (action === 'MARK_DISPUTED' && transaction.reservationId) {
      const issueResult = await issueCenterService.createTollDisputeIncident({
        id: actorUserId || null,
        sub: actorUserId || null,
        tenantId: transaction.tenantId || scope?.tenantId || null
      }, {
        reservationId: transaction.reservationId,
        tollTransactionId: transaction.id,
        title: `Toll dispute - ${transaction.location || transaction.plateRaw || transaction.id}`,
        description: [
          note || '',
          transaction.location ? `Location: ${transaction.location}` : '',
          transaction.plateRaw ? `Plate: ${transaction.plateRaw}` : '',
          transaction.selloRaw ? `Sticker: ${transaction.selloRaw}` : '',
          transaction.transactionAt ? `Transaction at: ${new Date(transaction.transactionAt).toISOString()}` : ''
        ].filter(Boolean).join('\n'),
        amountClaimed: toMoney(transaction.amount),
        location: transaction.location || '',
        transactionAt: transaction.transactionAt || null
      });
      issueIncident = issueResult?.incident || null;

      if (issueIncident?.id) {
        await prisma.tollTransaction.update({
          where: { id: transaction.id },
          data: {
            reviewNotes: mergeChargeNotes(transaction.reviewNotes, `Issue Center case ${issueIncident.id} ${issueResult?.created ? 'opened' : 'linked'} for toll dispute`)
          }
        });
      }
    }

    if (transaction.reservationId) {
      await syncReservationTollCharges(transaction.reservationId, scope);
    }

    return {
      action,
      actionLabel: reviewActionLabel(action),
      issueIncident,
      transaction: serializeTransaction(await getTransactionOrThrow(transaction.id, scope))
    };
  },

  async bulkConfirmMatches(ids = [], scope = {}, actorUserId = null, options = {}) {
    await ensureTenantAllowsTolls(scope);
    const list = Array.isArray(ids)
      ? ids.filter((value) => value != null && value !== '').map((value) => String(value))
      : [];
    if (!list.length) {
      return { confirmed: 0, dispatchConfirmed: 0, skipped: 0, failed: 0, total: 0, results: [], elapsedMs: 0 };
    }

    const startedAt = Date.now();
    const noteHint = String(options?.note || 'Bulk confirm');
    const chunkSize = Number.isFinite(options?.chunkSize) && options.chunkSize > 0 ? options.chunkSize : 10;

    // ---- Phase 1: single batched fetch of all transactions in scope -----------
    const transactions = await prisma.tollTransaction.findMany({
      where: {
        id: { in: list },
        ...tenantWhereForScope(scope),
        ...tollLocationWhere(scope)
      },
      include: {
        vehicle: true,
        reservation: {
          include: {
            customer: { select: { id: true, firstName: true, lastName: true } }
          }
        },
        assignments: {
          include: {
            reservation: { select: { id: true, reservationNumber: true, pickupAt: true, returnAt: true, vehicleId: true } }
          },
          orderBy: [{ createdAt: 'desc' }]
        }
      }
    });
    const transactionById = new Map(transactions.map((row) => [row.id, row]));

    // ---- Phase 2: classify each requested ID and collect required reservations
    const plans = [];
    const reservationIdsNeeded = new Set();
    for (const id of list) {
      const transaction = transactionById.get(id);
      if (!transaction) {
        plans.push({ id, kind: 'SKIP', message: 'Transaction not found in scope' });
        continue;
      }
      const latestAssignment = Array.isArray(transaction.assignments) && transaction.assignments.length
        ? transaction.assignments[0]
        : null;
      const reviewCategory = inferReviewCategory(transaction.reviewNotes || latestAssignment?.matchReason || '');
      const dispatchRequired = reviewCategory === DISPATCH_CONFIRMATION_REVIEW_CATEGORY;
      const coveredByPackage = transactionCoveredByTollPackage(transaction);

      if (coveredByPackage) {
        plans.push({ id, transaction, kind: 'SKIP', message: 'Usage-only — covered by toll package' });
        continue;
      }

      if (dispatchRequired && transaction.reservationId) {
        reservationIdsNeeded.add(String(transaction.reservationId));
        plans.push({ id, transaction, kind: 'DISPATCH', reservationId: transaction.reservationId });
        continue;
      }

      if (latestAssignment?.reservation?.id && transaction.needsReview) {
        reservationIdsNeeded.add(String(latestAssignment.reservation.id));
        plans.push({
          id,
          transaction,
          kind: 'MATCH',
          reservationId: latestAssignment.reservation.id,
          latestAssignment
        });
        continue;
      }

      plans.push({
        id,
        transaction,
        kind: 'SKIP',
        message: !transaction.needsReview ? 'Already confirmed' : 'No suggested reservation to confirm'
      });
    }

    // ---- Phase 3: load all referenced reservations + vehicles in one go --------
    // Location-gated with the SAME fragment confirmMatch uses. This is the bulk
    // door to the identical money path: a transaction can be in scope (its
    // vehicle is homed here) while the reservation its assignment suggests is
    // NOT, and confirming posts TOLL_MODULE charges onto that reservation. With
    // only the tenant filter, bulk-confirm did what confirmMatch refuses —
    // billed a rental the caller cannot even read. A reservation that fails this
    // gate simply drops out of the map, and Phase 4 then reports the row as a
    // SKIP rather than acting on it (same fail-closed shape as an out-of-scope
    // transaction id).
    //
    // KNOWN GAP, deliberately not papered over here: a toll whose vehicle is
    // homed at branch A but whose rental ran out of branch B is now confirmable
    // by NEITHER — A sees the toll but not the reservation, B sees the
    // reservation but not the toll (tollLocationWhere is vehicle-home only).
    // Tenant-wide admins are unaffected. The real fix is to make toll visibility
    // two-axis (vehicle home OR rental endpoints); that is a product decision
    // about who owns a toll, so it is written up for Hector rather than decided
    // here. Consistency + money safety first.
    const reservationsById = reservationIdsNeeded.size
      ? new Map(
        (await prisma.reservation.findMany({
          where: {
            id: { in: Array.from(reservationIdsNeeded) },
            ...tenantWhereForScope(scope),
            ...reservationLocationWhere(scope)
          },
          include: {
            vehicle: true,
            customer: { select: { id: true, firstName: true, lastName: true } }
          }
        })).map((row) => [row.id, row])
      )
      : new Map();

    // ---- Phase 4: process actionable plans in parallel chunks ------------------
    const results = new Array(plans.length);
    const touchedReservationIds = new Set();
    let confirmedCount = 0;
    let dispatchConfirmedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    const actionable = plans
      .map((plan, index) => ({ plan, index }))
      .filter((entry) => entry.plan.kind === 'DISPATCH' || entry.plan.kind === 'MATCH');

    // Account for SKIPs up-front
    plans.forEach((plan, index) => {
      if (plan.kind === 'SKIP') {
        skippedCount += 1;
        results[index] = { id: plan.id, action: 'SKIP', message: plan.message };
      }
    });

    for (let offset = 0; offset < actionable.length; offset += chunkSize) {
      const chunk = actionable.slice(offset, offset + chunkSize);
      // eslint-disable-next-line no-await-in-loop -- chunked parallel execution by design
      await Promise.all(chunk.map(async ({ plan, index }) => {
        try {
          const reservation = reservationsById.get(plan.reservationId);
          if (!reservation) {
            results[index] = { id: plan.id, action: 'ERROR', message: 'Reservation not found for confirm' };
            failedCount += 1;
            return;
          }
          const vehicle = reservation.vehicle
            || (reservation.vehicleId ? await prisma.vehicle.findUnique({ where: { id: reservation.vehicleId } }) : null);

          if (plan.kind === 'DISPATCH') {
            await prisma.$transaction(async (tx) => {
              await tx.tollAssignment.updateMany({
                where: {
                  tollTransactionId: plan.transaction.id,
                  status: { in: ['SUGGESTED', 'AUTO_CONFIRMED', 'CONFIRMED'] }
                },
                data: { status: 'REJECTED' }
              });
              await tx.tollTransaction.update({
                where: { id: plan.transaction.id },
                data: {
                  vehicleId: plan.transaction.vehicleId || reservation.vehicleId || vehicle?.id || null,
                  status: 'MATCHED',
                  needsReview: false,
                  billingStatus: plan.transaction.billingStatus === 'DISPUTED' ? 'DISPUTED' : 'PENDING',
                  reviewNotes: mergeChargeNotes(
                    clearDispatchConfirmationReview(plan.transaction.reviewNotes),
                    noteHint
                  )
                }
              });
              await createAssignmentRecord(tx, plan.transaction, {
                vehicle: vehicle || null,
                reservation,
                score: plan.transaction.matchConfidence != null ? Number(plan.transaction.matchConfidence) : 100,
                matchStatus: 'CONFIRMED',
                matchReason: 'bulk-dispatch-confirmed'
              }, actorUserId);
            });
            touchedReservationIds.add(String(reservation.id));
            dispatchConfirmedCount += 1;
            results[index] = { id: plan.id, action: 'CONFIRM_DISPATCHED', message: 'Dispatch confirmed' };
            return;
          }

          // plan.kind === 'MATCH'
          const suggestion = {
            vehicle,
            reservation,
            score: plan.latestAssignment.confidence != null ? Number(plan.latestAssignment.confidence) : 100,
            matchStatus: 'CONFIRMED',
            matchReason: plan.latestAssignment.matchReason || 'bulk-confirmed'
          };

          await prisma.$transaction(async (tx) => {
            if (Array.isArray(plan.transaction.assignments) && plan.transaction.assignments.length) {
              await tx.tollAssignment.updateMany({
                where: { tollTransactionId: plan.transaction.id, status: { in: ['SUGGESTED', 'AUTO_CONFIRMED'] } },
                data: { status: 'REJECTED' }
              });
            }
            await tx.tollTransaction.update({
              where: { id: plan.transaction.id },
              data: {
                vehicleId: reservation.vehicleId || vehicle?.id || null,
                reservationId: reservation.id,
                status: 'MATCHED',
                needsReview: false,
                matchConfidence: suggestion.score,
                reviewNotes: suggestion.matchReason
              }
            });
            await createAssignmentRecord(tx, plan.transaction, suggestion, actorUserId);
          });
          touchedReservationIds.add(String(reservation.id));
          confirmedCount += 1;
          results[index] = {
            id: plan.id,
            action: 'CONFIRM_MATCH',
            message: `Matched to ${reservation.reservationNumber || reservation.id}`
          };
        } catch (error) {
          failedCount += 1;
          results[index] = { id: plan.id, action: 'ERROR', message: String(error?.message || 'Failed') };
        }
      }));
    }

    // ---- Phase 5: deferred reservation sync (one call per touched reservation)
    const reservationSyncErrors = [];
    for (const reservationId of touchedReservationIds) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential to avoid pool storm
        await syncReservationTollCharges(reservationId, scope);
      } catch (error) {
        reservationSyncErrors.push({ reservationId, message: String(error?.message || 'Sync failed') });
      }
    }

    // ---- Phase 6: consolidated audit log entry ---------------------------------
    // AuditLog.reservationId is REQUIRED by the schema, and this write omitted
    // it — so every bulk confirm since the feature shipped threw
    // "Argument `reservation` is missing" into the empty catch below. The
    // money always posted; the trail never did. Found 2026-08-07 while bulk
    // confirming 186 tolls for International: 186 confirmed, 0 audit rows.
    //
    // One row PER touched reservation, which is also the shape the reservation
    // audit tab reads — a single tenant-level row would have been invisible
    // there anyway.
    if (touchedReservationIds.size && (confirmedCount + dispatchConfirmedCount) > 0) {
      const tenantId = transactions[0]?.tenantId || scope?.tenantId || null;
      if (tenantId) {
        const metadata = JSON.stringify({
          bulkTollConfirm: true,
          requested: list.length,
          confirmed: confirmedCount,
          dispatchConfirmed: dispatchConfirmedCount,
          skipped: skippedCount,
          failed: failedCount,
          touchedReservationIds: Array.from(touchedReservationIds),
          note: noteHint
        });
        try {
          await prisma.auditLog.createMany({
            data: Array.from(touchedReservationIds).map((reservationId) => ({
              tenantId,
              reservationId,
              actorUserId: actorUserId || null,
              action: 'UPDATE',
              metadata
            }))
          });
        } catch (auditErr) {
          // Still best-effort — a money operation must not fail on its trail —
          // but it is LOUD now, because a silent audit gap is the thing this
          // block exists to prevent.
          console.warn('[tolls] bulk confirm audit log failed', auditErr?.message);
        }
      }
    }

    return {
      confirmed: confirmedCount,
      dispatchConfirmed: dispatchConfirmedCount,
      skipped: skippedCount,
      failed: failedCount,
      total: list.length,
      touchedReservations: touchedReservationIds.size,
      reservationSyncErrors,
      elapsedMs: Date.now() - startedAt,
      results
    };
  },

  async syncReservationCharges(reservationId, scope = {}, options = {}) {
    return syncReservationTollCharges(reservationId, scope, options);
  },

  // RES-849093 FIX 2a: void the underlying TollTransaction when its TOLL_MODULE /
  // TOLL_POLICY agreement/reservation charge is voided via Admin Corrections.
  // Without this, the next syncReservationTollCharges would re-create the charge
  // from the still-MATCHED transaction and the void would silently "un-stick".
  // Setting status=VOID drops it from the sync's transaction query
  // (status in [MATCHED, BILLED]) AND billingStatus=WAIVED keeps the ledger honest.
  // `transactionId` is the TOLL_MODULE charge's sourceRefId; the TOLL_POLICY charge
  // (sourceRefId `reservation:<id>`) has no single transaction, so callers void by
  // reservation instead (handled in voidAgreementCharge by re-syncing).
  // MONEY PATH — deliberately NOT location-scoped, same reasoning as
  // syncReservationTollCharges (2026-07-24). Adding the filter here would make a
  // branch employee's void silently no-op (`voided: 0`) and the very next
  // syncReservationTollCharges would re-create the charge from the still-MATCHED
  // transaction — the "un-stick" this function exists to prevent.
  //
  // DO NOT read that as "the caller already passed a location check". The only
  // caller is reservation-pricing.service.js:531, and its gate is
  // `scopedReservationWhere` = `{ id, tenantId }` — TENANT-ONLY, no location
  // clause (reservation-pricing.service.js:41). So a location admin can void a
  // charge on a reservation whose detail page 404s for them, since
  // reservationsService.getById IS location-gated. That asymmetry is
  // PRE-EXISTING — Fase 2b never reached the pricing service, and before this
  // ship an ADMIN bypassed location scoping everywhere anyway, so no new access
  // is granted — but it is a real gap, not a covered one. The fix belongs in the
  // pricing service (one place, all its money paths), not bolted on here where
  // it would resurrect the un-stick bug. Tracked as follow-up.
  async voidTollTransaction(transactionId, scope = {}, options = {}) {
    if (!transactionId) return { voided: 0 };
    const note = String(options?.note || '').trim();
    const res = await prisma.tollTransaction.updateMany({
      where: {
        id: String(transactionId),
        ...tenantWhereForScope(scope),
        status: { in: ['IMPORTED', 'MATCHED', 'NEEDS_REVIEW', 'BILLED', 'DISPUTED'] }
      },
      data: {
        status: 'VOID',
        billingStatus: 'WAIVED',
        needsReview: false,
        reviewNotes: note ? `VOIDED via Admin Corrections: ${note}`.slice(0, 500) : 'VOIDED via Admin Corrections'
      }
    });
    return { voided: res.count };
  },

  async listReservationTolls(reservationId, scope = {}) {
    // THE RESERVATION IS THE GATE. Authorize once, here, on the reservation's own
    // rule (pickup OR return in the allowed set) — otherwise a branch user could
    // confirm a neighbouring branch's reservation exists, and read its
    // reservationNumber, by id.
    const reservation = await prisma.reservation.findFirst({
      where: {
        id: reservationId,
        ...tenantWhereForScope(scope),
        ...reservationLocationWhere(scope)
      },
      select: {
        id: true,
        reservationNumber: true
      }
    });
    if (!reservation) throw new Error('Reservation not found');

    // Deliberately NOT filtered by tollLocationWhere. `reservationId` already
    // binds every row to the reservation authorized above, so the filter adds no
    // safety — but it filters on a DIFFERENT axis (vehicle home vs. rental
    // endpoints), so on a one-way rental, or any car garaged outside the renting
    // branch, it would blank this tab while TOLL_MODULE charges sit on the
    // agreement. That is the screen an agent needs when a renter disputes a toll.
    const rows = await prisma.tollTransaction.findMany({
      where: {
        reservationId,
        ...tenantWhereForScope(scope)
      },
      include: {
        vehicle: true,
        reservation: {
          include: {
            customer: { select: { id: true, firstName: true, lastName: true } }
          }
        },
        assignments: {
          include: {
            reservation: { select: { id: true, reservationNumber: true, pickupAt: true, returnAt: true } }
          },
          orderBy: [{ createdAt: 'desc' }]
        }
      },
      orderBy: [{ transactionAt: 'desc' }]
    });
    const rowsWithIssues = await attachIssueIncidents(rows, scope);

    const totalAmount = Number(rowsWithIssues.reduce((sum, row) => sum + toMoney(row.amount), 0).toFixed(2));
    const postedAmount = Number(rowsWithIssues
      .filter((row) => ['POSTED_TO_RESERVATION', 'POSTED_TO_AGREEMENT'].includes(String(row.billingStatus || '').toUpperCase()))
      .filter((row) => !transactionUsageOnly(row))
      .reduce((sum, row) => sum + toMoney(row.amount), 0)
      .toFixed(2));
    const usageOnlyAmount = Number(rowsWithIssues
      .filter((row) => transactionUsageOnly(row))
      .reduce((sum, row) => sum + toMoney(row.amount), 0)
      .toFixed(2));

    return {
      reservationId,
      reservationNumber: reservation.reservationNumber,
      totals: {
        totalAmount,
        postedAmount,
        usageOnlyAmount,
        reviewCount: rowsWithIssues.filter((row) => row.needsReview).length,
        usageOnlyCount: rowsWithIssues.filter((row) => transactionUsageOnly(row)).length
      },
      transactions: rowsWithIssues.map(serializeTransaction)
    };
  }
};
