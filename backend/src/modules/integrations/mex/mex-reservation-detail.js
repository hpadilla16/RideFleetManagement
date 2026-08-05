/**
 * MEX reservation DETAIL — the per-booking confirmation text (2026-08-05).
 *
 * WHY: the T&M summary has no contact details and no charge breakdown, so
 * every imported row landed in MANUAL_REVIEW (the matcher cannot identify a
 * customer without an email or phone) and a Pay-at-Destination booking arrived
 * with a single Estimated Total and nothing to explain it. The detail lives
 * behind Reports POS → Reservation View/Cancel: type the Confirm #, press the
 * button whose VALUE is "View/Add", and the portal renders a plain-text
 * confirmation into `txtDetails`.
 *
 * Captured live from three different booking sources so the parser is not
 * fitted to one shape:
 *
 *   MEX RENT A CAR (61306)
 *   BOOKINGGRO ***CONFIRMATION***
 *
 *   Confirmation #    : WMX000F86C
 *   Renter Name       : FIGUEROA, ELIAS
 *   Home Phone        : 442031061826
 *   Email Address     : RESERVATIONS@BOOKINGGROUP.COM
 *   Est Rate Total    : 336.00
 *   Est Tax Total     : 75.31
 *   Est Extra Total   : 318.90
 *   Estimated Total   : 730.21
 *   Confirmed Rate    : 196.00/Month , 70.00/XDay  UNL
 *   Notes/Comments    :  [SI:BASIC PAY ON ARRIVAL B61641265 BASIC PAY ON ARRIVAL]
 *
 *   OPTIONAL SERVICES
 *   5.93 CUSTOMER FACILITY CHARGE
 *   2.50 VEHICLE LICENSE FEE SJU
 *   2.20 SURCHARGE
 *
 * TWO THINGS THIS FILE IS CAREFUL ABOUT
 *
 * 1. The email is NOT always the renter's. An OTA booking carries the AGENCY's
 *    desk (reservations@bookinggroup.com, one address across every booking they
 *    ever send). Importing that as the customer's identity would collapse a
 *    whole channel into one customer record — the same failure we avoided by
 *    hand on the VPH migration sheet. `contactLooksPersonal` marks it, and the
 *    caller decides; the raw value is always preserved.
 *
 * 2. The Notes carry the payment truth in words — "BASIC PREPAID" vs
 *    "BASIC PAY ON ARRIVAL". That is stronger evidence than inferring from a
 *    rate code we may not have on file, and it AGREED with the rate-code map on
 *    all three samples. It is exposed as `paymentSignal`; reconciling it with
 *    the rate code is the caller's job, and a disagreement is worth surfacing
 *    rather than silently picking a winner.
 */

/** Desk/agency mailboxes: a shared inbox, never one traveller's address. */
const AGENCY_EMAIL_PATTERNS = [
  /^reservations?@/i,
  /^bookings?@/i,
  /^info@/i,
  /^noreply@/i,
  /^no-reply@/i,
  /^support@/i,
  /^admin@/i,
  /^ventas@/i,
  /^reservas@/i,
];

const AGENCY_DOMAIN_PATTERNS = [
  /bookinggroup\.com$/i,
  /expedia\.com$/i,
  /priceline\.com$/i,
  /hopper\.com$/i,
  /cartrawler\.com$/i,
  /rentalcars\.com$/i,
];

export function contactLooksPersonal(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value || !value.includes('@')) return false;
  const [local, domain = ''] = value.split('@');
  if (AGENCY_EMAIL_PATTERNS.some((re) => re.test(`${local}@`))) return false;
  if (AGENCY_DOMAIN_PATTERNS.some((re) => re.test(domain))) return false;
  return true;
}

function money(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** `FIGUEROA, ELIAS` → { first: 'ELIAS', last: 'FIGUEROA' }. */
export function splitRenterName(raw) {
  const value = String(raw || '').trim();
  if (!value) return { first: null, last: null };
  if (value.includes(',')) {
    const [last, first] = value.split(',');
    return { first: (first || '').trim() || null, last: (last || '').trim() || null };
  }
  const parts = value.split(/\s+/);
  if (parts.length === 1) return { first: null, last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

/**
 * Pure. Parse the `LABEL : value` block plus the OPTIONAL SERVICES list.
 * Unknown labels are ignored rather than guessed at — a portal that adds a
 * field should not shift anything we already read correctly.
 */
export function parseReservationDetail(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;

  const lines = raw.split(/\r?\n/);
  const fields = new Map();
  let currentLabel = null;

  let inOptional = false;
  const optionalServices = [];
  const historyIndex = lines.findIndex((l) => /^\s*RESERVATION HISTORY\s*$/i.test(l));

  lines.forEach((line, index) => {
    if (historyIndex > -1 && index >= historyIndex) return;

    if (/^\s*OPTIONAL SERVICES\s*$/i.test(line)) { inOptional = true; currentLabel = null; return; }
    if (inOptional) {
      // "5.93 CUSTOMER FACILITY CHARGE"
      const m = line.match(/^\s*(-?[\d,]+\.?\d*)\s+(.+?)\s*$/);
      if (m) optionalServices.push({ amount: money(m[1]), description: m[2].trim() });
      return;
    }

    const m = line.match(/^\s*([A-Za-z#/ ]+?)\s*:\s?(.*)$/);
    if (m && m[1].trim().length > 2) {
      currentLabel = m[1].trim().replace(/\s+/g, ' ').toLowerCase();
      fields.set(currentLabel, (m[2] || '').trim());
      return;
    }
    // A wrapped continuation ("Booking Source" spilling onto the next line).
    if (currentLabel && line.trim()) {
      fields.set(currentLabel, `${fields.get(currentLabel) || ''} ${line.trim()}`.trim());
    }
  });

  const get = (...labels) => {
    for (const l of labels) {
      const v = fields.get(l);
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return null;
  };

  const notes = get('notes/comments', 'notes comments', 'notes');
  const upperNotes = String(notes || '').toUpperCase();
  // The words the portal itself uses. PREPAID is checked first: a note reading
  // "BASIC PREPAID" must never be read as pay-on-arrival because it contains
  // neither phrase's negation.
  const paymentSignal = /PREPAID/.test(upperNotes)
    ? 'PREPAID'
    : /PAY ON ARRIVAL|PAY AT DESTINATION/.test(upperNotes)
      ? 'PAY_ON_ARRIVAL'
      : null;

  const email = get('email address', 'email');
  const { first, last } = splitRenterName(get('renter name'));

  return {
    confirmation: get('confirmation #', 'confirmation'),
    renterFirstName: first,
    renterLastName: last,
    homePhone: get('home phone', 'phone'),
    email,
    emailLooksPersonal: contactLooksPersonal(email),
    dateBooked: get('date booked'),
    bookedBy: get('booked by'),
    pickupDate: get('pickup date'),
    returnDate: get('return date'),
    pickupReturn: get('pickup/return'),
    vehicleType: get('vehicle type'),
    rateCode: get('rate code'),
    pnr: get('pnr locator'),
    tradingPartner: get('trading partner'),
    bookingSource: get('booking source'),
    confirmedRate: get('confirmed rate'),
    notes,
    paymentSignal,
    charges: {
      rateTotal: money(get('est rate total')),
      taxTotal: money(get('est tax total')),
      extraTotal: money(get('est extra total')),
      estimatedTotal: money(get('estimated total')),
    },
    optionalServices,
  };
}

/**
 * A human-readable breakdown for the reservation's notes. Deliberately plain
 * text: the counter reads this, and every number here came from the portal —
 * nothing is derived, so nothing can drift from what MEX will bill.
 */
export function formatDetailBreakdown(detail) {
  if (!detail) return '';
  const c = detail.charges || {};
  const money2 = (n) => (n == null ? null : `$${Number(n).toFixed(2)}`);
  const parts = [];
  if (c.rateTotal != null) parts.push(`Rate ${money2(c.rateTotal)}`);
  if (c.taxTotal != null) parts.push(`Tax ${money2(c.taxTotal)}`);
  if (c.extraTotal != null) parts.push(`Extras ${money2(c.extraTotal)}`);
  if (c.estimatedTotal != null) parts.push(`Total ${money2(c.estimatedTotal)}`);
  const head = parts.length ? parts.join(' · ') : '';
  const services = (detail.optionalServices || [])
    .map((s) => `${money2(s.amount)} ${s.description}`)
    .join('; ');
  const bits = [];
  if (head) bits.push(head);
  if (detail.confirmedRate) bits.push(`Confirmed rate: ${detail.confirmedRate}`);
  if (services) bits.push(`Optional services: ${services}`);
  return bits.join(' | ');
}

/** The charge `source` that marks a row as owned by MEX, not by our engine. */
export const MEX_CHARGE_SOURCE = 'MEX_IMPORT';

/**
 * The portal's OPTIONAL SERVICES as ReservationCharge rows.
 *
 * These are fees MEX already quoted the customer and WILL bill — a
 * pay-at-destination booking is collected at our counter, so they have to be
 * on the reservation, and they have to survive an unrelated pricing edit
 * (source MEX_IMPORT is preserved by reservation-pricing.service).
 *
 * `sourceRefId` is stable per (confirmation, service) so a re-sync updates a
 * row instead of stacking a second copy of the same fee.
 *
 * taxable:false on purpose — the portal reports Est Tax Total separately, so
 * taxing these again would invent money MEX never charged.
 */
export function buildImportedFeeRows(detail) {
  const services = Array.isArray(detail?.optionalServices) ? detail.optionalServices : [];
  const confirmation = String(detail?.confirmation || '').trim();
  return services
    // Number(null) is 0, and 0 is finite — so an amount-less line would sail
    // through as a phantom $0.00 fee. Reject the absence explicitly.
    .filter((s2) => s2
      && String(s2.description || '').trim()
      && s2.amount !== null && s2.amount !== undefined && s2.amount !== ''
      && Number.isFinite(Number(s2.amount)))
    .map((s2, idx) => ({
      code: 'IMPORTED_FEE',
      name: String(s2.description).trim(),
      chargeType: 'UNIT',
      quantity: 1,
      rate: Number(s2.amount),
      total: Number(s2.amount),
      taxable: false,
      selected: true,
      sortOrder: 900 + idx,
      source: MEX_CHARGE_SOURCE,
      sourceRefId: `${confirmation}:${String(s2.description).trim().toUpperCase()}`,
      notes: 'Quoted by MEX with the booking — collected at the counter.',
    }));
}
