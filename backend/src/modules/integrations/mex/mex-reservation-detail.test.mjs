/**
 * MEX reservation-detail parser.
 *
 * The three fixtures below are VERBATIM captures from the live portal
 * (2026-08-05, TSD 61306/SJU) across three different booking sources, so the
 * parser is pinned to real shapes rather than one convenient sample.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReservationDetail,
  contactLooksPersonal,
  splitRenterName,
  formatDetailBreakdown,
} from './mex-reservation-detail.js';

// BookingGroup OTA — agency mailbox, pay on arrival, three optional services.
const BOOKINGGROUP = `MEX RENT A CAR (61306)
BOOKINGGRO ***CONFIRMATION***

Confirmation #    : WMX000F86C
Transmission      : EMAIL.20260525111125. info@gokarrental.com
Renter IP         : BKG01
Renter Name       : FIGUEROA, ELIAS
Home Phone        : 442031061826
Email Address     : RESERVATIONS@BOOKINGGROUP.COM
Date Booked       : 2026/05/25 11:11 (ET)
Booked By         : : BookingGroup
Pickup Date       : 2026/08/11 16:30
Return Date       : 2026/09/10 16:00
Pickup/Return     : SJU - SJU
Vehicle Type      : CFAR
Rate Code         : BPABR
Est Rate Total    : 336.00
Est Tax Total     : 75.31
Est Extra Total   : 318.90
Estimated Total   : 730.21
PNR Locator       : B61641265
Confirmed Rate    : 196.00/Month , 70.00/XDay  UNL
Trading Partner:  : BookingGroup.com
Booking Source    : Economy Booking
Notes/Comments    :  [SI:BASIC PAY ON ARRIVAL B61641265 BASIC PAY ON ARRIVAL]

OPTIONAL SERVICES
5.93 CUSTOMER FACILITY CHARGE
2.50 VEHICLE LICENSE FEE SJU
2.20 SURCHARGE


RESERVATION HISTORY
2026/05/25 11:11:03 Created WebLink
2026/05/25 11:11:25 Email Transmission Email Server`;

// MEX's own website — a REAL traveller's contact.
const WEBLINK = `MEX RENT A CAR (61306)
WEBLINK ***CONFIRMATION***

Confirmation #    : WMX000FAD4
Renter Name       : KONIECZNY, MARIUSZ
Home Phone        : +48665006500
Email Address     : MK@SCHP.COM.PL
Date Booked       : 2026/07/12 12:53 (ET)
Pickup Date       : 2026/08/06 13:30
Return Date       : 2026/08/16 13:00
Vehicle Type      : FFAR
Rate Code         : MEXWEB
Est Rate Total    : 1180.00
Est Tax Total     : 147.92
Est Extra Total   : 106.30
Estimated Total   : 1434.22
Confirmed Rate    : 826.00/Week , 118.00/XDay  UNL
Trading Partner:  : MEX RENT A CAR
Booking Source    : MEX RAC WEBSITE
Notes/Comments    :  [SI:BASIC PAY ON ARRIVAL [NOTAS DE CLIENTE]: || BASIC PAY ON ARRIVAL]

OPTIONAL SERVICES
5.93 CUSTOMER FACILITY CHARGE
2.50 VEHICLE LICENSE FEE SJU
2.20 SURCHARGE`;

// Amadeus/Hopper — PREPAID, and a Booking Source that WRAPS onto a second line.
const AMADEUS = `MEX RENT A CAR (61306)
AMADEUS ***CONFIRMATION***

Confirmation #    : ATSD0B9426
Renter Name       : CORDERO, JORGE
Home Phone        : 17875568633
Email Address     : AMBOSSALON@GMAIL.COM
Pickup Date       : 2026/08/06 10:00
Return Date       : 2026/08/10 10:00
Vehicle Type      : FVAR
Rate Code         : PPEXR
Est Rate Total    : 1012.00
Est Tax Total     : 121.27
Est Extra Total   : 42.52
Estimated Total   : 1175.79
PNR Locator       : CFTKC5
Confirmed Rate    : 253.00/Day  for 4 day(s) , 253.00/Extra Day  UNL
Booking Source    : 22660713
                  HOPPER
Notes/Comments    : [SI: BASIC PREPAID ]

OPTIONAL SERVICES
2.50 VEHICLE LICENSE FEE SJU
2.20 SURCHARGE
5.93 CUSTOMER FACILITY CHARGE`;

test('parses contact, identifiers and the charge breakdown', () => {
  const d = parseReservationDetail(BOOKINGGROUP);
  assert.equal(d.confirmation, 'WMX000F86C');
  assert.equal(d.renterFirstName, 'ELIAS');
  assert.equal(d.renterLastName, 'FIGUEROA');
  assert.equal(d.homePhone, '442031061826');
  assert.equal(d.email, 'RESERVATIONS@BOOKINGGROUP.COM');
  assert.equal(d.rateCode, 'BPABR');
  assert.equal(d.pnr, 'B61641265');
  assert.deepEqual(d.charges, {
    rateTotal: 336, taxTotal: 75.31, extraTotal: 318.9, estimatedTotal: 730.21,
  });
  assert.equal(d.confirmedRate, '196.00/Month , 70.00/XDay  UNL');
});

test('optional services come back as line items, and RESERVATION HISTORY is not one', () => {
  const d = parseReservationDetail(BOOKINGGROUP);
  assert.deepEqual(d.optionalServices, [
    { amount: 5.93, description: 'CUSTOMER FACILITY CHARGE' },
    { amount: 2.5, description: 'VEHICLE LICENSE FEE SJU' },
    { amount: 2.2, description: 'SURCHARGE' },
  ]);
  // The history block sits below and MUST NOT be read as services or fields.
  assert.ok(!d.optionalServices.some((s) => /Email Transmission|Created/i.test(s.description)));
});

test('the notes carry the payment truth in words', () => {
  assert.equal(parseReservationDetail(BOOKINGGROUP).paymentSignal, 'PAY_ON_ARRIVAL');
  assert.equal(parseReservationDetail(WEBLINK).paymentSignal, 'PAY_ON_ARRIVAL');
  assert.equal(parseReservationDetail(AMADEUS).paymentSignal, 'PREPAID');
  // And it AGREES with the rate-code map on all three — which is why a
  // disagreement is worth surfacing rather than silently resolving.
  assert.equal(parseReservationDetail(AMADEUS).rateCode, 'PPEXR');
});

test('an agency mailbox is flagged; a traveller address is not', () => {
  assert.equal(parseReservationDetail(BOOKINGGROUP).emailLooksPersonal, false,
    'reservations@bookinggroup.com is one desk behind every booking they send');
  assert.equal(parseReservationDetail(WEBLINK).emailLooksPersonal, true);
  assert.equal(parseReservationDetail(AMADEUS).emailLooksPersonal, true);

  assert.equal(contactLooksPersonal('info@gokarrental.com'), false);
  assert.equal(contactLooksPersonal('NOREPLY@anything.com'), false);
  assert.equal(contactLooksPersonal('someone@expedia.com'), false);
  assert.equal(contactLooksPersonal('mk@schp.com.pl'), true);
  assert.equal(contactLooksPersonal(''), false);
  assert.equal(contactLooksPersonal(null), false);
  assert.equal(contactLooksPersonal('not-an-email'), false);
});

test('a wrapped field keeps its continuation line', () => {
  const d = parseReservationDetail(AMADEUS);
  assert.match(d.bookingSource, /22660713/);
  assert.match(d.bookingSource, /HOPPER/);
});

test('splitRenterName handles the portal shape and degrades sanely', () => {
  assert.deepEqual(splitRenterName('FIGUEROA, ELIAS'), { first: 'ELIAS', last: 'FIGUEROA' });
  assert.deepEqual(splitRenterName('CORDERO, JORGE'), { first: 'JORGE', last: 'CORDERO' });
  assert.deepEqual(splitRenterName('MADONNA'), { first: null, last: 'MADONNA' });
  assert.deepEqual(splitRenterName('ANA MARIA PEREZ'), { first: 'ANA MARIA', last: 'PEREZ' });
  assert.deepEqual(splitRenterName(''), { first: null, last: null });
});

test('formatDetailBreakdown reads like something a counter agent can act on', () => {
  const out = formatDetailBreakdown(parseReservationDetail(BOOKINGGROUP));
  assert.match(out, /Rate \$336\.00/);
  assert.match(out, /Tax \$75\.31/);
  assert.match(out, /Extras \$318\.90/);
  assert.match(out, /Total \$730\.21/);
  assert.match(out, /Confirmed rate: 196\.00\/Month/);
  assert.match(out, /\$5\.93 CUSTOMER FACILITY CHARGE/);
});

test('empty or junk input yields null, never a half-built object', () => {
  assert.equal(parseReservationDetail(''), null);
  assert.equal(parseReservationDetail(null), null);
  assert.equal(parseReservationDetail('   \n  '), null);
});
