/**
 * The reservation detail payload must not carry the customer's IP address.
 *
 * WHAT HAPPENED. reservationsService.getById built its query with `include:`,
 * so Prisma returned EVERY scalar column on the Reservation row — including
 * customerReportedReturnMetaJson, the capped {ip,userAgent} that the QR
 * self-return stamp records for abuse triage. Confirmed in production
 * 2026-09-09 on RES-786140: the detail payload carried
 *   customerReportedReturnMetaJson = {"ip":"143.105.23.194","userAgent":"..."}
 * to a screen that never reads it.
 *
 * WHY A TEST. This is invisible by eye. Nothing renders the field, so nothing
 * looks wrong; the leak lives in the SHAPE of the Prisma query. And an
 * `include:` regresses silently — one edit back to `include` and every future
 * column joins the payload automatically, this one included.
 *
 * DB-FREE by design (same approach as
 * checkout-session/declined-insurance-and-sign-url.test.mjs): stub the prisma
 * singleton's findFirst and assert on the args getById hands it.
 *
 * Run: node --test --test-force-exit \
 *        src/modules/reservations/reservation-detail-select.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prisma } from '../../lib/prisma.js';
import { reservationsService } from './reservations.service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', '..', '..', 'prisma', 'schema.prisma');

// The Reservation scalars getById deliberately leaves out of the payload.
// Both are write-only: the only references anywhere in backend/src or
// frontend/src are the writes in self-return.service.js.
//
//   customerReportedReturnMetaJson       the customer's IP + user agent. It
//     exists so a DISPUTED stamp can be triaged out of the database. It is not
//     display data and it has no business on an agent's screen.
//   customerReportedReturnVoidedByUserId nothing resolves it to a name; the
//     void line on the reservation page renders VoidedAt + VoidReason.
//
// Removing a name from this list means the field is expected in the payload —
// which for the meta column is the exact regression this suite exists to catch.
const OMITTED_BY_DESIGN = new Set([
  'customerReportedReturnMetaJson',
  'customerReportedReturnVoidedByUserId',
]);

// The four self-return columns the reservation page DOES render (the soft
// check-in line, added 2026-09-09 in 09bcadf3). Dropping one of these in a
// future trim blanks that line.
const SELF_RETURN_KEPT = [
  'customerReportedReturnAt',
  'customerReportedReturnLocationId',
  'customerReportedReturnVoidedAt',
  'customerReportedReturnVoidReason',
];

/** Run getById against a stubbed Prisma and return the args it built. */
async function captureGetByIdArgs() {
  const realFindFirst = prisma.reservation.findFirst;
  let captured = null;
  prisma.reservation.findFirst = async (args) => {
    captured = args;
    // customer: null keeps getById off the $queryRaw presence-flag path.
    return { id: 'r1', customer: null, rentalAgreement: null };
  };
  try {
    await reservationsService.getById('r1', {});
  } finally {
    prisma.reservation.findFirst = realFindFirst;
  }
  assert.ok(captured, 'getById did not call prisma.reservation.findFirst');
  return captured;
}

/** Scalar field names on the Reservation model, in schema order. */
function reservationScalars() {
  const src = readFileSync(SCHEMA, 'utf8');
  const model = src.match(/^model Reservation \{[\r]?$([\s\S]*?)^\}[\r]?$/m);
  assert.ok(model, 'could not locate `model Reservation` in schema.prisma');
  const SCALAR = /^(String|Int|Boolean|DateTime|Decimal|Json|Float|BigInt|Bytes|ReservationStatus|ReservationWorkflowMode|LoanerBillingMode|LoanerBillingStatus|PaymentStatus)\b/;
  return model[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('@@'))
    .map((l) => l.split(/\s+/))
    .filter((parts) => parts.length >= 2 && SCALAR.test(parts[1]))
    .map((parts) => parts[0]);
}

test('getById uses an explicit select, never include', async () => {
  const args = await captureGetByIdArgs();
  assert.ok(
    args.select,
    'getById must ask Prisma for a named field list. With `include:` Prisma '
    + 'returns every Reservation scalar, so any column added later — an IP, a '
    + 'token, a note — ships to the detail screen without anyone deciding it should',
  );
  assert.equal(
    args.include, undefined,
    '`include` and `select` are mutually exclusive at the top level; an `include` here means the trim was reverted',
  );
});

test('the detail payload does not carry the customer IP (customerReportedReturnMetaJson)', async () => {
  const { select } = await captureGetByIdArgs();
  assert.equal(
    select.customerReportedReturnMetaJson, undefined,
    'customerReportedReturnMetaJson is back in the reservation detail payload. '
    + 'It holds the customer IP address and user agent from the QR self-return '
    + 'stamp; the detail screen does not read it. Abuse triage reads it from the '
    + 'database. Remove it from the select.',
  );
  // Belt: any future *MetaJson column on Reservation is the same shape of
  // mistake — a raw evidence blob riding along to a screen.
  const metaKeys = Object.keys(select).filter((k) => /MetaJson$/.test(k));
  assert.deepEqual(
    metaKeys, [],
    `raw evidence blob(s) selected into the detail payload: ${metaKeys.join(', ')}`,
  );
});

test('the four self-return fields the page renders are still selected', async () => {
  const { select } = await captureGetByIdArgs();
  for (const field of SELF_RETURN_KEPT) {
    assert.equal(
      select[field], true,
      `${field} is missing from the select — the soft check-in line on the `
      + 'reservation page goes blank, which is exactly the complaint that put it there',
    );
  }
});

test('every Reservation scalar is either selected or omitted on purpose', async () => {
  const { select } = await captureGetByIdArgs();
  const missing = reservationScalars()
    .filter((f) => select[f] !== true && !OMITTED_BY_DESIGN.has(f));
  assert.deepEqual(
    missing, [],
    'these Reservation columns reach neither the select nor the documented '
    + `omission list: ${missing.join(', ')}. A new column is invisible on the `
    + 'detail screen until it is added to getById select — add it there, or '
    + 'add it to OMITTED_BY_DESIGN with the reason it stays server-side.',
  );
});

test('the relations the detail screen reads survived the include -> select move', async () => {
  const { select } = await captureGetByIdArgs();
  for (const rel of [
    'customer', 'vehicleType', 'vehicle', 'pickupLocation', 'returnLocation',
    'franchise', 'additionalDrivers', 'customerInfoReviewedByUser',
    'readyForPickupByUser', 'rentalAgreement',
  ]) {
    assert.ok(select[rel], `relation ${rel} dropped out of the detail payload`);
  }
  // Spot-check the two nested selects that carry their own history.
  assert.equal(select.rentalAgreement.select.declinedInsurance, true);
  assert.equal(select.customer.select.idPhotoUrl, undefined, 'base64 blob must stay out');
});
