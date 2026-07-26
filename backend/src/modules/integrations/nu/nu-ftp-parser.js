/**
 * NU FTP reservation-file parser (2026-07-26). PURE — no IO, no prisma.
 *
 * Format per "NU FTP Reservation File Format V2026.xlsx" + FTPsample.txt
 * (both committed under doc/nu-ftp/):
 *
 *   - A record is a sequence of fields: `/TAG value` terminated by `\`.
 *   - The FIELD BOUNDARY is the two-character sequence `\/`. Values may
 *     legally contain `/` (dates like `25Jul26/1000`, charge descriptions
 *     like `State S/C`) — NEVER split on `/` alone.
 *   - TAG is exactly 3 characters (alphanumeric: CNF, PUD, 1CL, 1EM, PH1…).
 *   - /ACT action codes: CR create, MR modify, XL cancel, CU customer
 *     record, AD additional-driver record. The feed is TRANSACTIONAL —
 *     cancellations arrive explicitly (better than the portal scrape).
 *   - The charge table repeats: each /1CL starts a charge; /1CM /1CI /1CV
 *     /1CT /1CX /1CN /1CF that follow belong to it until the next /1CL.
 *   - /RMK remarks "can be multiple lines" — a physical line that does not
 *     start with `/` is a continuation of the previous record's line.
 *
 * MONEY NOTE (provisional until NU confirms the /MOP value list): PP/OP does
 * NOT exist in this format. Prepaid is derived from payment signals:
 * /PVA ("voucher amount — treat as bill to NU") > 0 → prepaid true;
 * /MOP = CC (customer's own credit card) → prepaid false; anything else →
 * null (unknown — the promoter already treats null as "no prepaid note").
 * When NU sends the MOP table, isPrepaidFromPayment is the ONE place to fix.
 */

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

export class NuFtpFormatError extends Error {}

/** 'DDMmmYY/HHMM' → { isoDate: 'YYYY-MM-DD', time: 'HH:MM' } | null. */
export function parseNuDateTime(raw) {
  const m = /^(\d{1,2})([A-Za-z]{3})(\d{2})(?:\/(\d{2})(\d{2}))?$/.exec(String(raw || '').trim());
  if (!m) return null;
  const month = MONTHS[m[2].toUpperCase()];
  if (!month) return null;
  const day = Number(m[1]);
  if (!(day >= 1 && day <= 31)) return null;
  const year = 2000 + Number(m[3]);
  const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const time = m[4] != null ? `${m[4]}:${m[5]}` : null;
  return { isoDate, time };
}

function toMoney(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

/** 99999 = unlimited per the spec (FMH/FMD/FMW/FMM/FME/FAD). */
function parseFreeMiles(raw) {
  if (raw == null || raw === '') return { miles: null, unlimited: false };
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return { miles: null, unlimited: false };
  if (n >= 99999) return { miles: null, unlimited: true };
  return { miles: n, unlimited: false };
}

/** 'LAST,FIRST,MIDDLE' → { lastName, firstName }. */
function parseName(raw) {
  const parts = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { lastName: parts[0] || '', firstName: parts[1] || '' };
}

// Provisional prepaid derivation — see MONEY NOTE in the header.
export function isPrepaidFromPayment({ voucherAmount, mop }) {
  if (voucherAmount != null && voucherAmount > 0) return true;
  if (String(mop || '').trim().toUpperCase() === 'CC') return false;
  return null;
}

/**
 * One record line → { action, confirmation, tags, charges, reservation }.
 * `tags` keeps EVERY field as arrays (repeats preserved) for forensics;
 * `reservation` is the normalized shape the worker mapper consumes.
 */
export function parseNuFtpRecord(line) {
  const raw = String(line || '').trim();
  if (!raw.startsWith('/')) throw new NuFtpFormatError('record must start with "/"');

  // Split on the FIELD BOUNDARY `\/`; strip the leading '/' of the first
  // field and any trailing terminator `\` of the last.
  const body = raw.replace(/^\//, '').replace(/\\$/, '');
  const rawFields = body.split('\\/');

  const tags = {};
  const fieldSeq = [];
  for (const f of rawFields) {
    if (f.length < 3) continue;
    const tag = f.slice(0, 3).toUpperCase();
    const value = f.slice(3).trim();
    (tags[tag] ||= []).push(value);
    fieldSeq.push({ tag, value });
  }

  const one = (tag) => (tags[tag] && tags[tag][0] !== undefined ? tags[tag][0] : null);

  const action = String(one('ACT') || '').toUpperCase();
  if (!['CR', 'MR', 'XL', 'CU', 'AD'].includes(action)) {
    throw new NuFtpFormatError(`unknown /ACT action code: ${action || '(missing)'}`);
  }
  const confirmation = one('CNF');
  if (!confirmation) throw new NuFtpFormatError('missing /CNF confirmation');

  // Charge table: each /1CL opens a charge, following 1C* fields attach to it.
  const charges = [];
  let current = null;
  for (const { tag, value } of fieldSeq) {
    if (tag === '1CL') {
      current = { description: value, method: null, included: null, amount: null, total: null, taxable: null, chargeNumber: null, classification: null };
      charges.push(current);
    } else if (current) {
      if (tag === '1CM') current.method = value.toUpperCase() || null;        // P | R | D
      else if (tag === '1CI') current.included = value.toUpperCase() === 'Y';
      else if (tag === '1CV') current.amount = toMoney(value);
      else if (tag === '1CT') current.total = toMoney(value);
      else if (tag === '1CX') current.taxable = value.toUpperCase() === 'Y';
      else if (tag === '1CN') current.chargeNumber = value || null;
      else if (tag === '1CF') current.classification = value || null;
    }
  }

  const { lastName, firstName } = parseName(one('NAM') || one('DRN'));
  const pickup = parseNuDateTime(one('PUD'));
  const dropoff = parseNuDateTime(one('DOD'));
  const booked = parseNuDateTime(one('BDT'));
  const freeMilesDay = parseFreeMiles(one('FMD'));
  const voucherAmount = toMoney(one('PVA'));
  const mop = one('MOP');
  const emails = String(one('1EM') || '').split(';').map((s) => s.trim()).filter(Boolean);

  const reservation = {
    action,
    confirmation,
    chain: one('CHN'),
    lastName,
    firstName,
    pickupLocation: one('PUL'),
    dropoffLocation: one('DOL'),
    pickupStation: one('CTO'),
    returnStation: one('CTI'),
    pickupDate: pickup?.isoDate || null,
    pickupTime: pickup?.time || null,
    dropoffDate: dropoff?.isoDate || null,
    dropoffTime: dropoff?.time || null,
    bookedDate: booked?.isoDate || null,
    bookedTime: booked?.time || null,
    vehicleClass: one('VTP'),
    ratePlan: one('RAT'),
    rateIndicator: one('RTI'),
    currency: one('CUR') || 'USD',
    baseRate: toMoney(one('1BR')) ?? toMoney(one('PNC')),
    mandatoryCharges: toMoney(one('1MC')),
    totalPrice: toMoney(one('1TP')),
    dailyRate: toMoney(one('RTD')),
    freeMilesPerDay: freeMilesDay.miles,
    unlimitedMileage: freeMilesDay.unlimited,
    mileOverageRate: toMoney(one('MIL')),
    mop,
    voucherAmount,
    prepayVoucher: one('1VC'),
    isPrepaid: isPrepaidFromPayment({ voucherAmount, mop }),
    emails,
    phone: (one('PH1') || '').replace(/^-$/, '') || null,
    contact: (one('CON') || '').replace(/^-$/, '') || null,
    licenseState: one('DLS'),
    licenseNumber: one('DLN'),
    dateOfBirth: parseNuDateTime(one('DOB'))?.isoDate || null,
    address1: one('AD1'),
    city: one('CTY'),
    state: one('STF'),
    zip: one('ZIP'),
    insuranceFlags: one('INS'),
    remarks: tags.RMK ? tags.RMK.join('\n') : null,
    guaranteed: String(one('GUA') || '').toUpperCase() === 'Y',
  };

  return { action, confirmation, tags, charges, reservation };
}

/**
 * Whole file → { records, errors }. One record per physical line; a line
 * not starting with '/' is a continuation of the previous line (multiline
 * /RMK per the spec). A malformed record is collected into `errors` and
 * never aborts the batch — the same row-level fail-soft the ingest uses.
 */
export function parseNuFtpFile(content) {
  const physical = String(content || '').split(/\r?\n/);
  const logical = [];
  for (const line of physical) {
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('/') || logical.length === 0) logical.push(line.trim());
    else logical[logical.length - 1] += `\n${line.trim()}`;
  }
  const records = [];
  const errors = [];
  logical.forEach((line, idx) => {
    try {
      records.push(parseNuFtpRecord(line));
    } catch (e) {
      errors.push({ line: idx + 1, error: String(e?.message || e), snippet: line.slice(0, 80) });
    }
  });
  return { records, errors };
}
