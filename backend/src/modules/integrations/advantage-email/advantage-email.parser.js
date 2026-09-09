/**
 * advantage-email.parser.js — the verbatim Advantage/TSD confirmation email →
 * a structured object.
 *
 * PURE. Its only import is the shared wall-clock→UTC converter. No prisma, no
 * network, no env beyond the timezone the caller passes in. That is what lets
 * the whole shape of this integration be tested from one fixture on a laptop
 * with no database (advantage-email-parse.test.mjs).
 *
 * THE DOCUMENT. Ryan White supplied one full sample on 2026-09-08. It is a
 * fixed-column text report with a two-line masthead, a label:value header block
 * and then a series of ALL-CAPS sections:
 *
 *     Advantage Orlando (61302)          ← brand + TSD account number
 *     AMADEUS ***CONFIRMATION***         ← channel + the DOCUMENT TYPE banner
 *
 *     Confirmation #    : AEXP141D54
 *     ...
 *     Booking Source    : 11617270
 *                       EXPEDIA.COM      ← indented continuation of the value
 *     Phone             : 1404728-8787   ← the AGENCY's phone, NOT the renter's
 *
 *     RESERVATION HISTORY
 *     RENTAL AGREEMENT DETAILS
 *     RENTAL.NET CHARGE DETAILS
 *     RENTAL.NET PAYMENT DETAILS
 *     RENTAL.NET ACTIVITY
 *
 * TWO TRAPS THIS PARSER IS SHAPED AROUND.
 *
 * 1. `Phone` IS NOT THE RENTER'S PHONE. It sits directly under the Booking
 *    Source block and belongs to the travel agency (1404728-8787 = EXPEDIA.COM
 *    in Atlanta). The renter's number is `Home Phone`. Reading the wrong one
 *    would stage an OTA's switchboard as a customer's number and hand the
 *    shared matcher a key that matches hundreds of unrelated bookings. The
 *    parser keys strictly on labels and never on position, and the agency block
 *    is kept in its own `bookingSource` object where it cannot be mistaken for
 *    contact data.
 *
 * 2. THE DOCUMENT IS A SNAPSHOT, NOT AN EVENT. The sample is banner-dated at
 *    booking time (2026/08/07) yet already carries a RENTAL AGREEMENT DETAILS
 *    block for a pickup that happened 2026/09/03, with the unit assigned, the
 *    fuel read and a 381.80 deposit taken. So the same confirmation number can
 *    arrive repeatedly with more filled in each time. Everything below the
 *    header is parsed and returned, and the caller upserts — a later copy
 *    enriches, it does not duplicate.
 *
 * WHAT IT REFUSES TO DO. It never infers the document type. The banner token is
 * looked up in a closed vocabulary; anything unrecognised comes back as
 * docType UNKNOWN with the raw token preserved, and the worker quarantines the
 * message. Reading an unfamiliar banner as a confirmation is how a cancelled
 * booking comes back to life on the planner.
 */

import { parseDateTimeInTz } from '../../../lib/date-utils.js';
import { DOC_TYPES, DOC_TYPE_TOKENS, TIME_ZONE } from './advantage-email.constants.js';

/** The document did not have the shape we know how to read. */
export class AdvantageEmailLayoutError extends Error {
  constructor(message, { missing = [] } = {}) {
    super(message);
    this.name = 'AdvantageEmailLayoutError';
    this.missing = missing;
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Label → lookup key: lowercase, keep [a-z0-9/ ], collapse spaces. */
export function normalizeLabel(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9/ ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "1,234.56" → 1234.56; anything unparseable → null. */
export function toAmount(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/[,$\s]/g, '');
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * A TSD timestamp in either of the two shapes the document mixes:
 *   "2026/09/03 09:00"            (header block, YYYY/MM/DD — unambiguous)
 *   "9/3/2026 10:22:00 AM"        (RENTAL AGREEMENT DETAILS, US M/D/YYYY)
 * → a naive ISO wall-clock string, or null.
 *
 * The second shape IS ambiguous in principle (3/9 could be March 9th or the
 * 3rd of September). It is read as US month-first because the first shape,
 * which is unambiguous, appears in the same document for the same rental:
 * "Pickup Date : 2026/09/03" against "Date Out : 9/3/2026" fixes the order
 * beyond doubt. If a non-US Advantage account ever sends day-first, the two
 * fields will disagree — which is exactly why `agreement.dateOut` is kept
 * separate from `pickupAt` and never used to promote.
 */
export function toNaiveIso(raw) {
  const s = String(raw || '').trim().replace(/\s*\((ET|EST|EDT|CT|CST|CDT|MT|PT|UTC|GMT)\)\s*$/i, '');
  if (!s) return null;

  const pad = (n, w = 2) => String(Number(n)).padStart(w, '0');

  const ymd = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (ymd) {
    const [, y, mo, d, h = '0', mi = '0', se = '0'] = ymd;
    return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(se)}`;
  }

  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/);
  if (mdy) {
    const [, mo, d, y, h = '0', mi = '0', se = '0', ampm] = mdy;
    let hour = Number(h);
    if (ampm) {
      const pm = ampm.toLowerCase() === 'pm';
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(hour)}:${pad(mi)}:${pad(se)}`;
  }

  return null;
}

/** Naive ISO in the branch timezone → a UTC Date, or null. */
export function toDate(raw, timeZone = TIME_ZONE) {
  const iso = toNaiveIso(raw);
  if (!iso) return null;
  const d = parseDateTimeInTz(iso, timeZone);
  return d instanceof Date && Number.isFinite(d.valueOf()) ? d : null;
}

/**
 * Is this line an ALL-CAPS section heading? Column 0, no colon, and only the
 * characters TSD uses in its headings — which is what keeps
 * "TOTAL CHARGES: 0.00" (has a colon) and "AMADEUS ***CONFIRMATION***" (has
 * asterisks) out.
 */
export function isSectionHeading(line) {
  const s = String(line ?? '');
  if (!s.trim() || s !== s.replace(/^\s+/, '')) return false;
  if (s.includes(':')) return false;
  if (s.trim().length > 60) return false;
  return /^[A-Z0-9][A-Z0-9 .&/'()+-]*$/.test(s.trim()) && /[A-Z]/.test(s);
}

/**
 * Split the body into the preamble (everything before the first heading) and
 * the named sections, preserving order and raw lines.
 */
export function splitSections(lines) {
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (isSectionHeading(line)) {
      current = { heading: line.trim(), lines: [] };
      sections.push(current);
      continue;
    }
    (current ? current.lines : preamble).push(line);
  }
  return { preamble, sections };
}

/**
 * Read a `label : value` block, joining indented continuation lines onto the
 * value they belong to.
 *
 * @returns {{ fields: Map<string, {label: string, value: string, lines: string[]}>, order: string[] }}
 */
export function readFieldBlock(lines) {
  const fields = new Map();
  const order = [];
  let currentKey = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    const indented = /^\s/.test(line);
    if (indented && currentKey) {
      // A continuation of the field above (the Booking Source address block).
      fields.get(currentKey).lines.push(line.trim());
      continue;
    }

    // A label may not itself contain a colon, so the first colon splits.
    const m = line.match(/^([^:]{1,40}?)\s*:\s?(.*)$/);
    if (!m) continue;

    const key = normalizeLabel(m[1]);
    if (!key) continue;
    // "Booked By : : Amadeus" — TSD doubles the separator on this one field.
    const value = m[2].replace(/^\s*:\s*/, '').trim();

    if (!fields.has(key)) {
      fields.set(key, { label: m[1].trim(), value, lines: [] });
      order.push(key);
    } else {
      // A repeated label: keep the first, remember the rest as continuation
      // rather than silently dropping it.
      fields.get(key).lines.push(value);
    }
    currentKey = key;
  }

  return { fields, order };
}

// ---------------------------------------------------------------------------
// Header pieces
// ---------------------------------------------------------------------------

/** Brand + parenthesised TSD account number: "Advantage Orlando (61302)". */
const MASTHEAD_RE = /^(.*?)\s*\((\d{2,10})\)\s*$/;

/** Channel + the document-type banner: "AMADEUS ***CONFIRMATION***". */
const BANNER_RE = /^(.*?)\s*\*{2,}\s*([A-Za-z ]+?)\s*\*{2,}\s*$/;

/** "Advantage Orlando (61302)" → { brand, tsdNumber } */
export function parseMasthead(line) {
  const s = String(line || '').trim();
  const m = s.match(MASTHEAD_RE);
  if (!m) return { brand: s || null, tsdNumber: null };
  return { brand: m[1].trim() || null, tsdNumber: m[2] };
}

/**
 * Where the report actually starts.
 *
 * The parser was written against the clean sample Ryan supplied on 2026-09-08,
 * which begins at the masthead. The first REAL message, on 2026-09-09, was a
 * forward: Outlook put his signature and a "From:/Sent:/To:/Subject:" block
 * above the report, so the two leading non-blank lines were "Thank you," and
 * "Ryan". Every required field was reported missing while the whole report sat
 * intact twenty lines further down.
 *
 * The anchor is the PAIR — a masthead line immediately followed (blank lines
 * skipped) by a banner line. Requiring both is what makes it safe to search the
 * whole body: an address line can perfectly well end in a parenthesised number
 * (this sample's own "ATLANTA, GA (30319)" does), but it is never followed by a
 * ***BANNER***. Matching a masthead alone would have picked that up instead.
 *
 * The FIRST pair wins. Outlook stacks a forwarded chain newest-first, so when a
 * modification is forwarded on top of the confirmation it replaced, the first
 * pair is the current one.
 *
 * @returns {{mastheadIndex: number, bannerIndex: number}|null}
 */
export function findReportStart(lines) {
  const rows = Array.isArray(lines) ? lines : [];
  for (let i = 0; i < rows.length; i += 1) {
    const line = String(rows[i] ?? '').trim();
    if (!line || !MASTHEAD_RE.test(line)) continue;
    // The banner is the next line with content on it.
    for (let j = i + 1; j < rows.length; j += 1) {
      const next = String(rows[j] ?? '').trim();
      if (!next) continue;
      if (BANNER_RE.test(next)) return { mastheadIndex: i, bannerIndex: j };
      break; // content, but not a banner — this masthead was a false positive
    }
  }
  return null;
}

/**
 * "AMADEUS ***CONFIRMATION***" → { channel, docType, docTypeRaw }
 *
 * docType is UNKNOWN — never a guess — when the banner is missing or the token
 * is not in the closed vocabulary. The caller quarantines on that.
 */
export function parseBanner(line) {
  const s = String(line || '').trim();
  const m = s.match(BANNER_RE);
  if (!m) {
    return { channel: s || null, docType: DOC_TYPES.UNKNOWN, docTypeRaw: null };
  }
  const channel = m[1].trim() || null;
  const raw = m[2].trim().toUpperCase().replace(/\s+/g, ' ');
  // Match on the whole token first, then on any word inside it, so
  // "***RESERVATION CANCELLATION***" resolves rather than falling to UNKNOWN.
  const direct = DOC_TYPE_TOKENS[raw];
  if (direct) return { channel, docType: direct, docTypeRaw: raw };
  const words = raw.split(' ').filter(Boolean);
  // Scan right-to-left: the qualifier that carries the meaning comes last
  // ("RESERVATION CANCELLATION" is a cancellation, not a reservation).
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const hit = DOC_TYPE_TOKENS[words[i]];
    if (hit) return { channel, docType: hit, docTypeRaw: raw };
  }
  return { channel, docType: DOC_TYPES.UNKNOWN, docTypeRaw: raw };
}

/**
 * "TRUITT, ANDYD" → { firstName: 'ANDYD', lastName: 'TRUITT' }
 *
 * The comma is REQUIRED. Without it the whole string becomes the last name and
 * the first name stays null, which lands the row in review as
 * customer_not_found. Splitting an uncommaed "MARIA GARCIA LOPEZ" on
 * whitespace would guess at where a compound surname begins, and guessing a
 * person's name wrong is how an import promotes onto a stranger's customer
 * record — the exact failure the phone-placeholder work already fought.
 */
export function parseRenterName(raw) {
  const s = String(raw || '').trim();
  if (!s) return { firstName: null, lastName: null };
  const comma = s.indexOf(',');
  if (comma === -1) return { firstName: null, lastName: s };
  const lastName = s.slice(0, comma).trim() || null;
  const firstName = s.slice(comma + 1).trim() || null;
  return { firstName, lastName };
}

/** "MCO - MCO" → { pickup: 'MCO', dropoff: 'MCO' } */
export function parsePickupReturn(raw) {
  const s = String(raw || '').trim();
  if (!s) return { pickup: null, dropoff: null };
  const parts = s.split(/\s*-\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { pickup: null, dropoff: null };
  if (parts.length === 1) return { pickup: parts[0], dropoff: parts[0] };
  return { pickup: parts[0], dropoff: parts[parts.length - 1] };
}

/**
 * "14.72/Day  for 5 day(s) , 14.72/Extra Day  UNL"
 *   → { amount: 14.72, unit: 'DAY', days: 5, extraDay: 14.72, mileage: 'UNL' }
 *
 * `unit` is captured rather than assumed. A weekly or monthly rate cannot be
 * multiplied by a day count, so when the unit is anything but DAY the estimate
 * is refused (null) instead of being invented.
 */
export function parseConfirmedRate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  const out = { raw: s, amount: null, unit: null, days: null, extraDay: null, mileage: null };

  const rate = s.match(/([\d,]+\.?\d*)\s*\/\s*(day|week|wk|month|mo)\b/i);
  if (rate) {
    out.amount = toAmount(rate[1]);
    const u = rate[2].toUpperCase();
    out.unit = u === 'WK' ? 'WEEK' : (u === 'MO' ? 'MONTH' : u);
  }

  const days = s.match(/for\s+(\d+)\s*day/i);
  if (days) out.days = Number(days[1]);

  const extra = s.match(/([\d,]+\.?\d*)\s*\/\s*extra\s*day/i);
  if (extra) out.extraDay = toAmount(extra[1]);

  const mileage = s.match(/\b(UNL|UNLIMITED|LTD|LIMITED)\b/i);
  if (mileage) out.mileage = mileage[1].toUpperCase();

  return out;
}

/** "48880 - 48880" → { out: 48880, in: 48880 }; "F -" → { out: 'F', in: null } */
export function parseOutIn(raw, { numeric = false } = {}) {
  const s = String(raw || '').trim();
  if (!s) return { out: null, in: null };
  const idx = s.indexOf('-');
  const left = (idx === -1 ? s : s.slice(0, idx)).trim();
  const right = (idx === -1 ? '' : s.slice(idx + 1)).trim();
  const conv = (v) => {
    if (!v) return null;
    return numeric ? toAmount(v) : v;
  };
  return { out: conv(left), in: conv(right) };
}

// ---------------------------------------------------------------------------
// Sections below the header
// ---------------------------------------------------------------------------

const TS_LINE = /^(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+(.*)$/;

/** RESERVATION HISTORY / RENTAL.NET ACTIVITY → timestamped entries. */
export function parseTimestampedLines(lines, timeZone) {
  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    const m = s.match(TS_LINE);
    if (!m) { out.push({ at: null, atRaw: null, detail: s }); continue; }
    out.push({ at: toDate(m[1], timeZone), atRaw: m[1], detail: m[2].trim() });
  }
  return out;
}

/**
 * RENTAL.NET ACTIVITY entries carry the counter's work in slash-delimited
 * shorthand. Two shapes are worth structuring:
 *
 *   "7 PSP / PRE-PAID SUNPASS / Kit / Daily / 16.99"   → an EXTRA sold
 *   "7 381.80 / CARD DEPOSIT / DRIVER"                 → a money EVENT
 *
 * Everything else stays as a raw line. This is READ-ONLY intelligence: the
 * extras and the deposit are recorded so a human can see what the counter did,
 * and NOTHING here becomes a charge, a fee or a card movement in RFM.
 */
export function classifyActivity(entries) {
  const extras = [];
  const moneyEvents = [];
  const other = [];

  for (const entry of entries) {
    const detail = String(entry.detail || '');
    const sp = detail.indexOf(' ');
    const actor = sp === -1 ? detail : detail.slice(0, sp);
    const rest = sp === -1 ? '' : detail.slice(sp + 1).trim();

    if (!rest.includes('/')) { other.push(entry); continue; }
    const parts = rest.split('/').map((p) => p.trim());

    if (parts.length === 5 && toAmount(parts[4]) != null) {
      extras.push({
        at: entry.at,
        atRaw: entry.atRaw,
        actor,
        code: parts[0] || null,
        description: parts[1] || null,
        method: parts[2] || null,
        frequency: parts[3] || null,
        amount: toAmount(parts[4]),
      });
      continue;
    }

    if (parts.length === 3 && toAmount(parts[0]) != null) {
      moneyEvents.push({
        at: entry.at,
        atRaw: entry.atRaw,
        actor,
        amount: toAmount(parts[0]),
        type: parts[1] || null,
        party: parts[2] || null,
      });
      continue;
    }

    other.push(entry);
  }

  return { extras, moneyEvents, other };
}

/** RENTAL.NET PAYMENT DETAILS → { entries, total }. */
export function parsePayments(lines, timeZone) {
  const entries = [];
  let total = null;
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    const totalMatch = s.match(/^TOTAL\s+PAYMENTS\s*:\s*([\d,.-]+)$/i);
    if (totalMatch) { total = toAmount(totalMatch[1]); continue; }
    const m = s.match(/^(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+([\d,]+\.\d{2})\s+(.*)$/);
    if (m) {
      entries.push({
        at: toDate(m[1], timeZone), atRaw: m[1], amount: toAmount(m[2]), type: m[3].trim(),
      });
      continue;
    }
    entries.push({ at: null, atRaw: null, amount: null, type: s });
  }
  return { entries, total };
}

/** RENTAL.NET CHARGE DETAILS → { lines, total }. */
export function parseCharges(lines) {
  const kept = [];
  let total = null;
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    const m = s.match(/^TOTAL\s+CHARGES\s*:\s*([\d,.-]+)$/i);
    if (m) { total = toAmount(m[1]); continue; }
    kept.push(s);
  }
  return { lines: kept, total };
}

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

const SECTION_KEYS = {
  'RESERVATION HISTORY': 'history',
  'RENTAL AGREEMENT DETAILS': 'agreement',
  'RENTAL.NET CHARGE DETAILS': 'charges',
  'RENTAL.NET PAYMENT DETAILS': 'payments',
  'RENTAL.NET ACTIVITY': 'activity',
};

/**
 * Parse one Advantage confirmation email body.
 *
 * @param {string} text  the text/plain body, exactly as it arrived
 * @param {{timeZone?: string}} opts
 * @returns {object} the structured document (see the shape below)
 * @throws {AdvantageEmailLayoutError} when a field the import cannot do
 *   without is absent. It names every missing field at once, so a format change
 *   is diagnosed from one quarantined message instead of five.
 */
export function parseAdvantageEmail(text, { timeZone = TIME_ZONE } = {}) {
  const body = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = body.split('\n');

  // ---- masthead ------------------------------------------------------------
  // Anchor on the masthead/banner PAIR wherever it sits, so a forwarded message
  // parses the same as a direct one (see findReportStart). When there is no
  // pair the message is not a report we recognise: fall back to the first two
  // non-blank lines so the quarantine still names the fields it could not find
  // rather than reporting a confusing "no report" for a genuinely broken email.
  const anchor = findReportStart(lines);
  let i = 0;
  let leading;
  if (anchor) {
    leading = [lines[anchor.mastheadIndex], lines[anchor.bannerIndex]];
    i = anchor.bannerIndex + 1;
  } else {
    leading = [];
    while (i < lines.length && leading.length < 2) {
      if (lines[i].trim()) leading.push(lines[i]);
      i += 1;
    }
  }
  const masthead = parseMasthead(leading[0]);
  const banner = parseBanner(leading[1]);

  // ---- sections ------------------------------------------------------------
  const { preamble, sections } = splitSections(lines.slice(i));
  const byKey = {};
  for (const section of sections) {
    const key = SECTION_KEYS[section.heading.toUpperCase()];
    if (key) byKey[key] = section.lines;
    else (byKey.unknownSections ||= []).push(section);
  }

  // ---- header block --------------------------------------------------------
  const { fields } = readFieldBlock(preamble);
  const get = (key) => (fields.has(key) ? fields.get(key).value : null);
  const getLines = (key) => (fields.has(key) ? fields.get(key).lines : []);

  const externalRef = (get('confirmation') || '').trim() || null;
  const name = parseRenterName(get('renter name'));
  const locs = parsePickupReturn(get('pickup/return'));
  const rate = parseConfirmedRate(get('confirmed rate'));

  const pickupAt = toDate(get('pickup date'), timeZone);
  const dropoffAt = toDate(get('return date'), timeZone);
  const bookedAt = toDate(get('date booked'), timeZone);

  // ---- the money -----------------------------------------------------------
  //
  // ONLY estimatedTotal, and only when it can be computed honestly. The email
  // gives a DAILY RATE and a DAY COUNT — not the "Total Bill" (rate + tax) the
  // portal scraper reads — so 14.72 x 5 = 73.60 is the base rate for the term
  // and NOTHING else: no tax, no airport fees, and none of the counter extras
  // that took the sample's real card deposit to 381.80.
  //
  // `basis` travels with the number into rawJson and into the reservation's
  // notes line, because an estimatedTotal whose basis is invisible is worse
  // than none: someone will read 73.60 as the price of the rental.
  let estimatedTotal = null;
  let estimatedTotalBasis = 'unavailable';
  if (rate && rate.unit === 'DAY' && rate.amount != null && rate.days != null) {
    estimatedTotal = round2(rate.amount * rate.days);
    estimatedTotalBasis = 'daily_rate_x_days_pre_tax';
  } else if (rate && rate.amount != null) {
    estimatedTotalBasis = `rate_unit_${String(rate.unit || 'unknown').toLowerCase()}_not_multipliable`;
  }

  // ---- booking source (the AGENCY — never contact data for the renter) -----
  const bookingSourceLines = getLines('booking source');
  const bookingSource = {
    code: (get('booking source') || '').trim() || null,
    name: bookingSourceLines[0] || null,
    addressLines: bookingSourceLines.slice(1),
    // `Phone` (as opposed to `Home Phone`) is the agency's switchboard.
    phone: (get('phone') || '').trim() || null,
  };

  // ---- RENTAL AGREEMENT DETAILS -------------------------------------------
  let agreement = null;
  if (byKey.agreement) {
    const { fields: af } = readFieldBlock(byKey.agreement);
    const ag = (k) => (af.has(k) ? af.get(k).value : null);
    const mileage = parseOutIn(ag('mileage out/in'), { numeric: true });
    const fuel = parseOutIn(ag('fuel out/in'));
    agreement = {
      contractNumber: ag('contract number') || null,
      dateOut: toDate(ag('date out'), timeZone),
      dateOutRaw: ag('date out') || null,
      expectedDate: toDate(ag('expected date'), timeZone),
      expectedDateRaw: ag('expected date') || null,
      dateIn: toDate(ag('date in'), timeZone),
      dateInRaw: ag('date in') || null,
      rate: ag('rate') || null,
      unitNumber: ag('unit number') || null,
      yearMakeModel: ag('year/make/model') || null,
      mileageOut: mileage.out,
      mileageIn: mileage.in,
      fuelOut: fuel.out,
      fuelIn: fuel.in,
    };
  }

  // ---- activity / payments / charges / history -----------------------------
  const activityEntries = byKey.activity ? parseTimestampedLines(byKey.activity, timeZone) : [];
  const activity = classifyActivity(activityEntries);
  const payments = byKey.payments ? parsePayments(byKey.payments, timeZone) : { entries: [], total: null };
  const charges = byKey.charges ? parseCharges(byKey.charges) : { lines: [], total: null };
  const history = byKey.history ? parseTimestampedLines(byKey.history, timeZone) : [];

  const doc = {
    // identity + routing
    brand: masthead.brand,
    tsdNumber: masthead.tsdNumber,
    channel: banner.channel,
    docType: banner.docType,
    docTypeRaw: banner.docTypeRaw,
    externalRef,
    pickupBranch: locs.pickup,
    dropoffBranch: locs.dropoff,

    // renter
    customerFirstName: name.firstName,
    customerLastName: name.lastName,
    customerEmail: (get('email address') || '').trim() || null,
    customerPhone: (get('home phone') || '').trim() || null,

    // the booking
    bookedAt,
    bookedAtRaw: get('date booked'),
    bookedBy: get('booked by'),
    renterIp: get('renter ip'),
    transmission: get('transmission'),
    pickupAt,
    pickupAtRaw: get('pickup date'),
    dropoffAt,
    dropoffAtRaw: get('return date'),
    vehicleAcriss: (get('vehicle type') || '').trim().toUpperCase() || null,
    rateCode: get('rate code'),
    pnr: get('pnr locator'),
    notes: get('notes/comments') || null,

    // money — estimate only, with its basis attached
    rate,
    estimatedTotal,
    estimatedTotalBasis,
    currency: 'USD',

    // context, imported for visibility and NEVER for money movement
    bookingSource,
    agreement,
    charges,
    payments,
    activity,
    history,
    unknownSections: (byKey.unknownSections || []).map((s) => s.heading),
  };

  // ---- the refusal ---------------------------------------------------------
  const missing = [];
  if (!doc.tsdNumber) missing.push('TSD account number (masthead)');
  if (!doc.externalRef) missing.push('Confirmation #');
  if (!doc.pickupBranch) missing.push('Pickup/Return');
  if (!doc.pickupAt) missing.push('Pickup Date');
  if (!doc.dropoffAt) missing.push('Return Date');
  if (missing.length) {
    throw new AdvantageEmailLayoutError(
      `Advantage email is missing required field(s): ${missing.join(', ')}`,
      { missing },
    );
  }

  return doc;
}

export default { parseAdvantageEmail, AdvantageEmailLayoutError };
