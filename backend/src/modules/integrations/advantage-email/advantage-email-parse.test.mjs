/**
 * advantage-email-parse.test.mjs — the Advantage confirmation email → a
 * structured document.
 *
 * DB-FREE and dependency-free: the parser's only import is the shared
 * wall-clock converter, so this whole suite runs on a laptop in the npm chain.
 *
 * THE FIXTURE IS THE REAL DOCUMENT WITH THE RENTER SCRUBBED. Ryan White (IT
 * Manager, Advantage Car Rental) supplied one full sample on 2026-09-08 and it
 * is reproduced here byte-for-byte in its column alignment — EXCEPT the three
 * fields that identify a person: Renter Name, Home Phone and Email Address.
 * A test fixture lives in git forever; the renter did not consent to that, and
 * nothing in the parser cares what the name says. The booking references
 * (confirmation number, PNR, unit, TSD account) are kept so the fixture stays
 * recognisably the sample Hector has in the thread.
 *
 * WHAT THESE CASES ARE ACTUALLY DEFENDING
 *   - `Phone` is the travel agency's switchboard and `Home Phone` is the
 *     renter's. Reading the wrong one stages an OTA's number as a customer's
 *     and hands the shared matcher a key that collides with every other
 *     booking that agency ever sold.
 *   - estimatedTotal is 73.60 (14.72 x 5) and NOT 381.80. The larger number is
 *     a card deposit the counter took, and it is on this document. Anything
 *     that starts writing it into the reservation should fail here.
 *   - The banner is a closed vocabulary. An unrecognised token must come back
 *     UNKNOWN so the worker quarantines the message, because reading a strange
 *     banner as a confirmation resurrects cancelled bookings.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseAdvantageEmail,
  AdvantageEmailLayoutError,
  parseMasthead,
  parseBanner,
  parseRenterName,
  parsePickupReturn,
  parseConfirmedRate,
  parseOutIn,
  isSectionHeading,
  findReportStart,
  toNaiveIso,
  normalizeLabel,
} = await import('./advantage-email.parser.js');

const { senderAllowed, extractAddress, DOC_TYPES } = await import('./advantage-email.constants.js');

// ---------------------------------------------------------------------------
// The fixture (see the header note on scrubbing).
// ---------------------------------------------------------------------------

const SAMPLE = `Advantage Orlando (61302)
AMADEUS ***CONFIRMATION***

Confirmation #    : AEXP141D54
Transmission      : XML.20260807135316.10.1.4.98-128
Renter IP         : SSEA
Renter Name       : SAMPLE, TESTER
Home Phone        : 17875550142
Email Address     : TESTER.SAMPLE@EXAMPLE.COM
Date Booked       : 2026/08/07 13:52 (ET)
Booked By         : : Amadeus
Pickup Date       : 2026/09/03 09:00
Return Date       : 2026/09/07 18:30
Pickup/Return     : MCO - MCO
Vehicle Type      : IFAR
Rate Code         : D5
PNR Locator       : A8CDJM
Confirmed Rate    : 14.72/Day  for 5 day(s) , 14.72/Extra Day  UNL
Booking Source    : 11617270
                  EXPEDIA.COM
                  STE 107
                  ATLANTA, GA 30329-2132
Phone             : 1404728-8787

Notes/Comments    :

RESERVATION HISTORY
2026/08/07 13:52:15 Amadeus Sell Amadeus
2026/08/07 13:52:17 Amadeus ET Amadeus
2026/08/07 13:52:17 Created  Amadeus
2026/08/07 13:52:46 Email Transmission Email Server
2026/08/07 13:53:16 REZACK XMLPOST

RENTAL AGREEMENT DETAILS
Contract Number: MCO-8845
Date Out       : 9/3/2026 10:22:00 AM
Expected Date  : 9/7/2026 6:30:00 PM
Date In        :
Rate           : 14.72/DAY
Unit Number    : RASU33
Year/Make/Model: 2024 NISSAN ROGUE
Mileage Out/In : 48880 - 48880
Fuel Out/In    : F -

RENTAL.NET CHARGE DETAILS
TOTAL CHARGES: 0.00

RENTAL.NET PAYMENT DETAILS
2026/09/03 10:23     381.80 CARD DEPOSIT
TOTAL PAYMENTS: 381.80

RENTAL.NET ACTIVITY
2026/08/07 13:53:16 RezCentral
2026/08/07 13:53:16 RezCentral R D@14.72 FM=0 [5] D@14.72 FM=0 PM=0.00 H
2026/08/07 13:53:16 RezCentral EXPEDIA.COM
2026/09/03 10:22:00 7 Unit Override [RASU33]Unit Assigned To: MCOA01 You Are At: MCO
2026/09/03 10:22:00 7 Unit Override [RASU33]Unit is flagged as requiring cleaning...
2026/09/03 10:22:31 7 PSP / PRE-PAID SUNPASS / Kit / Daily / 16.99
2026/09/03 10:22:36 7 (Rez)From:  To: RASU33
2026/09/03 10:22:51 7 DW / DEPOSIT WAIVER / Coupon / Daily / 39.99
2026/09/03 10:23:31 7 1.00 / AUTHORIZATION / DRIVER
2026/09/03 10:24:46 7 381.80 / AUTHORIZATION / DRIVER
2026/09/03 10:24:55 7 381.80 / CARD DEPOSIT / DRIVER
2026/09/03 10:25:11 7 From Rez - 154 Second(s)
2026/09/03 10:26:44 7 (Signed)Agreement
`;

const doc = parseAdvantageEmail(SAMPLE);

// ---------------------------------------------------------------------------

describe('advantage email — routing identity', () => {
  it('reads the TSD account off the masthead and the branch off Pickup/Return', () => {
    // These two ARE the routing key: AdvantageLocationConfig is unique on
    // (tenantId, tsdNumber, branch), which is the portal's "61302.MCO" cell.
    assert.equal(doc.tsdNumber, '61302');
    assert.equal(doc.brand, 'Advantage Orlando');
    assert.equal(doc.pickupBranch, 'MCO');
    assert.equal(doc.dropoffBranch, 'MCO');
  });

  it('reads the confirmation number, the GDS channel and the PNR', () => {
    assert.equal(doc.externalRef, 'AEXP141D54');
    assert.equal(doc.channel, 'AMADEUS');
    assert.equal(doc.pnr, 'A8CDJM');
    assert.equal(doc.rateCode, 'D5');
    assert.equal(doc.vehicleAcriss, 'IFAR');
  });

  it('handles a one-sided Pickup/Return and a differing drop-off', () => {
    assert.deepEqual(parsePickupReturn('MCO'), { pickup: 'MCO', dropoff: 'MCO' });
    assert.deepEqual(parsePickupReturn('MCO - TPA'), { pickup: 'MCO', dropoff: 'TPA' });
    assert.deepEqual(parsePickupReturn(''), { pickup: null, dropoff: null });
  });
});

describe('advantage email — the renter, and the phone that is NOT the renter', () => {
  it('splits "LAST, FIRST"', () => {
    assert.equal(doc.customerLastName, 'SAMPLE');
    assert.equal(doc.customerFirstName, 'TESTER');
  });

  it('stages Home Phone as the renter phone', () => {
    assert.equal(doc.customerPhone, '17875550142');
    assert.equal(doc.customerEmail, 'TESTER.SAMPLE@EXAMPLE.COM');
  });

  it('keeps the Booking Source block — including its Phone — away from contact data', () => {
    // THE TRAP. `Phone : 1404728-8787` sits under Booking Source and belongs to
    // EXPEDIA.COM in Atlanta. If it ever leaks into customerPhone, every
    // Expedia booking shares one matcher key.
    assert.notEqual(doc.customerPhone, '1404728-8787');
    assert.equal(doc.bookingSource.phone, '1404728-8787');
    assert.equal(doc.bookingSource.code, '11617270');
    assert.equal(doc.bookingSource.name, 'EXPEDIA.COM');
    assert.deepEqual(doc.bookingSource.addressLines, ['STE 107', 'ATLANTA, GA 30329-2132']);
  });

  it('refuses to guess a name that has no comma', () => {
    // "MARIA GARCIA LOPEZ" has no single right split. The whole string becomes
    // the surname and the row lands in review, rather than promoting onto a
    // stranger's customer record.
    assert.deepEqual(parseRenterName('MARIA GARCIA LOPEZ'), { firstName: null, lastName: 'MARIA GARCIA LOPEZ' });
    assert.deepEqual(parseRenterName('TRUITT, ANDYD'), { firstName: 'ANDYD', lastName: 'TRUITT' });
    assert.deepEqual(parseRenterName(''), { firstName: null, lastName: null });
  });
});

describe('advantage email — dates', () => {
  it('reads the header dates as branch-local Eastern', () => {
    // 2026/09/03 09:00 EDT = 13:00 UTC.
    assert.equal(doc.pickupAt.toISOString(), '2026-09-03T13:00:00.000Z');
    assert.equal(doc.dropoffAt.toISOString(), '2026-09-07T22:30:00.000Z');
    assert.equal(doc.bookedAt.toISOString(), '2026-08-07T17:52:00.000Z');
  });

  it('strips the "(ET)" suffix rather than choking on it', () => {
    assert.equal(toNaiveIso('2026/08/07 13:52 (ET)'), '2026-08-07T13:52:00');
  });

  it('reads the agreement block\'s US M/D/YYYY h:mm:ss AM/PM shape', () => {
    assert.equal(toNaiveIso('9/3/2026 10:22:00 AM'), '2026-09-03T10:22:00');
    assert.equal(toNaiveIso('9/7/2026 6:30:00 PM'), '2026-09-07T18:30:00');
    // Midnight and noon are where a naive AM/PM conversion goes wrong.
    assert.equal(toNaiveIso('1/1/2026 12:00:00 AM'), '2026-01-01T00:00:00');
    assert.equal(toNaiveIso('1/1/2026 12:00:00 PM'), '2026-01-01T12:00:00');
  });

  it('leaves an empty Date In null instead of inventing one', () => {
    assert.equal(doc.agreement.dateIn, null);
    assert.equal(doc.agreement.dateOut.toISOString(), '2026-09-03T14:22:00.000Z');
  });
});

describe('advantage email — the money, and what it is NOT', () => {
  it('computes estimatedTotal as daily rate x days, and labels the basis', () => {
    assert.equal(doc.estimatedTotal, 73.6);
    assert.equal(doc.estimatedTotalBasis, 'daily_rate_x_days_pre_tax');
    assert.deepEqual(
      { amount: doc.rate.amount, unit: doc.rate.unit, days: doc.rate.days, extraDay: doc.rate.extraDay, mileage: doc.rate.mileage },
      { amount: 14.72, unit: 'DAY', days: 5, extraDay: 14.72, mileage: 'UNL' },
    );
  });

  it('does NOT put the 381.80 card deposit anywhere near the estimate', () => {
    // 381.80 is a deposit the counter took, and it includes extras (PSP 16.99/day
    // + DW 39.99/day) that RFM did not sell. It is recorded, and it is not money.
    assert.notEqual(doc.estimatedTotal, 381.8);
    assert.equal(doc.payments.total, 381.8);
    assert.equal(doc.payments.entries.length, 1);
    assert.equal(doc.payments.entries[0].type, 'CARD DEPOSIT');
    assert.equal(doc.charges.total, 0);
  });

  it('refuses an estimate it cannot compute honestly', () => {
    // A weekly rate cannot be multiplied by a day count. Better no number than
    // a wrong one on a screen the counter reads.
    const weekly = SAMPLE.replace(
      'Confirmed Rate    : 14.72/Day  for 5 day(s) , 14.72/Extra Day  UNL',
      'Confirmed Rate    : 210.00/Week  for 5 day(s)  UNL',
    );
    const d = parseAdvantageEmail(weekly);
    assert.equal(d.estimatedTotal, null);
    assert.equal(d.estimatedTotalBasis, 'rate_unit_week_not_multipliable');
  });

  it('reports "unavailable" when there is no Confirmed Rate at all', () => {
    const noRate = SAMPLE.replace(/^Confirmed Rate.*$/m, 'Confirmed Rate    :');
    const d = parseAdvantageEmail(noRate);
    assert.equal(d.estimatedTotal, null);
    assert.equal(d.estimatedTotalBasis, 'unavailable');
  });
});

describe('advantage email — the counter detail, parsed and inert', () => {
  it('reads the assigned unit, the vehicle, mileage and fuel', () => {
    assert.equal(doc.agreement.unitNumber, 'RASU33');
    assert.equal(doc.agreement.yearMakeModel, '2024 NISSAN ROGUE');
    assert.equal(doc.agreement.contractNumber, 'MCO-8845');
    assert.equal(doc.agreement.mileageOut, 48880);
    assert.equal(doc.agreement.mileageIn, 48880);
    assert.equal(doc.agreement.fuelOut, 'F');
    assert.equal(doc.agreement.fuelIn, null, 'the car is still out — Fuel In is blank');
  });

  it('structures the extras the counter sold, with their prices', () => {
    assert.deepEqual(
      doc.activity.extras.map((e) => [e.code, e.description, e.frequency, e.amount]),
      [
        ['PSP', 'PRE-PAID SUNPASS', 'Daily', 16.99],
        ['DW', 'DEPOSIT WAIVER', 'Daily', 39.99],
      ],
    );
  });

  it('structures the authorizations and the deposit as money EVENTS, not charges', () => {
    assert.deepEqual(
      doc.activity.moneyEvents.map((m) => [m.amount, m.type, m.party]),
      [
        [1, 'AUTHORIZATION', 'DRIVER'],
        [381.8, 'AUTHORIZATION', 'DRIVER'],
        [381.8, 'CARD DEPOSIT', 'DRIVER'],
      ],
    );
  });

  it('keeps the unstructured activity lines rather than dropping them', () => {
    const details = doc.activity.other.map((o) => o.detail);
    assert.ok(details.some((d) => d.includes('Unit Assigned To: MCOA01')));
    assert.ok(details.some((d) => d.includes('(Signed)Agreement')));
    assert.equal(doc.history.length, 5);
    assert.equal(doc.history[0].detail, 'Amadeus Sell Amadeus');
  });

  it('reads an Out/In pair with a missing right-hand side', () => {
    assert.deepEqual(parseOutIn('F -'), { out: 'F', in: null });
    assert.deepEqual(parseOutIn('48880 - 48910', { numeric: true }), { out: 48880, in: 48910 });
    assert.deepEqual(parseOutIn(''), { out: null, in: null });
  });
});

describe('advantage email — the document-type banner is a closed vocabulary', () => {
  it('reads a confirmation', () => {
    assert.equal(doc.docType, DOC_TYPES.CONFIRMATION);
    assert.equal(doc.docTypeRaw, 'CONFIRMATION');
  });

  it('recognises a cancellation and a modification', () => {
    assert.equal(parseBanner('AMADEUS ***CANCELLATION***').docType, DOC_TYPES.CANCELLATION);
    assert.equal(parseBanner('SABRE ***MODIFICATION***').docType, DOC_TYPES.MODIFICATION);
    // The qualifier that carries the meaning comes LAST.
    assert.equal(parseBanner('WEB ***RESERVATION CANCELLATION***').docType, DOC_TYPES.CANCELLATION);
  });

  it('returns UNKNOWN — never a guess — for a banner it has not seen', () => {
    // The worker quarantines on this. Reading an unfamiliar banner as a
    // confirmation is how a cancelled booking comes back onto the planner.
    const weird = parseBanner('AMADEUS ***NO SHOW***');
    assert.equal(weird.docType, DOC_TYPES.UNKNOWN);
    assert.equal(weird.docTypeRaw, 'NO SHOW');

    const missing = parseBanner('AMADEUS');
    assert.equal(missing.docType, DOC_TYPES.UNKNOWN);
    assert.equal(missing.docTypeRaw, null);
  });

  it('carries an unknown banner all the way through the parse', () => {
    const d = parseAdvantageEmail(SAMPLE.replace('***CONFIRMATION***', '***NO SHOW***'));
    assert.equal(d.docType, DOC_TYPES.UNKNOWN);
    assert.equal(d.docTypeRaw, 'NO SHOW');
    // Still fully parsed — the worker needs the confirmation number to name the
    // message it is refusing.
    assert.equal(d.externalRef, 'AEXP141D54');
  });
});

describe('advantage email — refusing a document it cannot read', () => {
  it('names EVERY missing required field at once', () => {
    // One quarantined message should diagnose a format change, not five.
    const gutted = 'Something Else (   )\nWEB ***CONFIRMATION***\n\nFoo : bar\n';
    assert.throws(
      () => parseAdvantageEmail(gutted),
      (err) => {
        assert.ok(err instanceof AdvantageEmailLayoutError);
        assert.deepEqual(err.missing.sort(), [
          'Confirmation #', 'Pickup Date', 'Pickup/Return', 'Return Date', 'TSD account number (masthead)',
        ].sort());
        return true;
      },
    );
  });

  it('refuses a confirmation with no pickup date', () => {
    const noPickup = SAMPLE.replace(/^Pickup Date.*$/m, 'Pickup Date       :');
    assert.throws(() => parseAdvantageEmail(noPickup), AdvantageEmailLayoutError);
  });

  it('survives CRLF line endings', () => {
    const d = parseAdvantageEmail(SAMPLE.replace(/\n/g, '\r\n'));
    assert.equal(d.externalRef, 'AEXP141D54');
    assert.equal(d.estimatedTotal, 73.6);
  });

  it('records a section it does not recognise instead of silently ignoring it', () => {
    const extra = `${SAMPLE}\nBRAND NEW SECTION\nsomething : else\n`;
    const d = parseAdvantageEmail(extra);
    assert.deepEqual(d.unknownSections, ['BRAND NEW SECTION']);
  });
});

describe('advantage email — the small pure pieces', () => {
  it('detects section headings without swallowing value lines', () => {
    assert.equal(isSectionHeading('RESERVATION HISTORY'), true);
    assert.equal(isSectionHeading('RENTAL.NET CHARGE DETAILS'), true);
    assert.equal(isSectionHeading('TOTAL CHARGES: 0.00'), false, 'has a colon — it is a field');
    assert.equal(isSectionHeading('AMADEUS ***CONFIRMATION***'), false, 'the banner is not a section');
    assert.equal(isSectionHeading('Advantage Orlando (61302)'), false, 'mixed case — not a heading');
    assert.equal(isSectionHeading('  INDENTED'), false);
  });

  it('normalizes labels the way the field lookup expects', () => {
    assert.equal(normalizeLabel('Confirmation #'), 'confirmation');
    assert.equal(normalizeLabel('Pickup/Return'), 'pickup/return');
    assert.equal(normalizeLabel('Year/Make/Model'), 'year/make/model');
    assert.equal(normalizeLabel('Mileage Out/In'), 'mileage out/in');
  });

  it('handles the doubled separator on "Booked By : : Amadeus"', () => {
    assert.equal(doc.bookedBy, 'Amadeus');
  });

  it('parses the masthead account number', () => {
    assert.deepEqual(parseMasthead('Advantage Orlando (61302)'), { brand: 'Advantage Orlando', tsdNumber: '61302' });
    assert.deepEqual(parseMasthead('Advantage Orlando'), { brand: 'Advantage Orlando', tsdNumber: null });
  });

  it('parses a Confirmed Rate with no extra-day clause', () => {
    const r = parseConfirmedRate('29.99/Day  for 3 day(s)  LTD');
    assert.deepEqual(
      { amount: r.amount, unit: r.unit, days: r.days, extraDay: r.extraDay, mileage: r.mileage },
      { amount: 29.99, unit: 'DAY', days: 3, extraDay: null, mileage: 'LTD' },
    );
  });
});

describe('advantage email — the sender allowlist', () => {
  it('accepts anything when unset, because that is the documented default', () => {
    assert.equal(senderAllowed('anyone@wherever.test', []), true);
  });

  it('matches a domain and its subdomains, and an exact address', () => {
    assert.equal(senderAllowed('Rez <rez@advantage.com>', ['advantage.com']), true);
    assert.equal(senderAllowed('rez@mail.advantage.com', ['advantage.com']), true);
    assert.equal(senderAllowed('rez@notadvantage.com', ['advantage.com']), false);
    assert.equal(senderAllowed('rez@advantage.com', ['rez@advantage.com']), true);
    assert.equal(senderAllowed('other@advantage.com', ['rez@advantage.com']), false);
  });

  it('rejects a message with no parseable From when a list is set', () => {
    assert.equal(senderAllowed('', ['advantage.com']), false);
    assert.equal(senderAllowed(null, ['advantage.com']), false);
  });

  it('extracts the address out of a display-name header', () => {
    assert.equal(extractAddress('"Advantage Rez" <rez@advantage.com>'), 'rez@advantage.com');
    assert.equal(extractAddress('REZ@ADVANTAGE.COM'), 'rez@advantage.com');
    assert.equal(extractAddress('not an address'), null);
  });
});

// ---------------------------------------------------------------------------
// Forwarded messages (2026-09-09).
//
// The parser was written against the clean sample Ryan supplied. The first REAL
// message was a FORWARD, so Outlook put his signature and a From:/Sent:/To:/
// Subject: block above the report and the two leading non-blank lines were
// "Thank you," and "Ryan". Every required field came back missing while the
// whole report sat intact below. These pin that a forward parses identically to
// a direct send.
// ---------------------------------------------------------------------------
describe('a forwarded message parses the same as a direct one', () => {
  // The real shape of the 2026-09-09 quarantine, around the existing fixture.
  const forwarded = [
    '',
    'Thank you,',
    '',
    'Ryan',
    '',
    'Ryan White',
    '',
    'Advantage Car Rental',
    '',
    'IT Manager',
    '',
    'M. 407-555-0134',
    '',
    'rwhite@advantage.com<mailto:rwhite@advantage.com>',
    '',
    '________________________________',
    'From: Ryan White',
    'Sent: Tuesday, September 8, 2026 4:28 PM',
    'To: advantagerez@ridefleetmanager.com <advantagerez@ridefleetmanager.com>',
    'Subject: AEXP141D54',
    '',
    SAMPLE,
  ].join('\n');

  it('finds the report below the signature and the forward header', () => {
    const d = parseAdvantageEmail(forwarded);
    assert.equal(d.tsdNumber, doc.tsdNumber);
    assert.equal(d.externalRef, doc.externalRef);
    assert.equal(d.docType, doc.docType);
    assert.equal(d.pickupAt.toISOString(), doc.pickupAt.toISOString());
    assert.equal(d.dropoffAt.toISOString(), doc.dropoffAt.toISOString());
    assert.equal(d.pickupLocation, doc.pickupLocation);
  });

  it('the signature above it is not mistaken for the masthead', () => {
    assert.equal(parseAdvantageEmail(forwarded).brand, doc.brand);
  });

  it('an address line ending in a parenthesised number is not a masthead', () => {
    // The sample's own agency block carries "ATLANTA, GA (30319)". Matching a
    // masthead alone — rather than the masthead/banner PAIR — would anchor
    // there and lose the report.
    const withAgencyAddress = SAMPLE.replace(
      /^Booking Source.*$/m,
      'Booking Source    : 11617270\n                  EXPEDIA.COM\n                  ATLANTA, GA (30319)',
    );
    const d = parseAdvantageEmail(withAgencyAddress);
    assert.equal(d.tsdNumber, doc.tsdNumber);
    assert.equal(d.externalRef, doc.externalRef);
  });

  it('a direct (unforwarded) message is unaffected', () => {
    assert.equal(parseAdvantageEmail(SAMPLE).externalRef, doc.externalRef);
  });
});

describe('findReportStart', () => {
  it('requires the pair, not just a parenthesised number', () => {
    assert.equal(findReportStart(['ATLANTA, GA (30319)', 'Phone : 1404728-8787']), null);
    assert.deepEqual(
      findReportStart(['Advantage Orlando (61302)', 'AMADEUS ***CONFIRMATION***']),
      { mastheadIndex: 0, bannerIndex: 1 },
    );
  });

  it('skips blank lines between the masthead and the banner', () => {
    assert.deepEqual(
      findReportStart(['Advantage Orlando (61302)', '', '  ', 'AMADEUS ***CONFIRMATION***']),
      { mastheadIndex: 0, bannerIndex: 3 },
    );
  });

  it('takes the FIRST pair — Outlook stacks a chain newest first', () => {
    const lines = [
      'noise',
      'Advantage Orlando (61302)',
      'AMADEUS ***MODIFICATION***',
      'body',
      'Advantage Orlando (61302)',
      'AMADEUS ***CONFIRMATION***',
    ];
    assert.deepEqual(findReportStart(lines), { mastheadIndex: 1, bannerIndex: 2 });
  });

  it('is null on a message with no report at all, and never throws', () => {
    assert.equal(findReportStart(['Thank you,', 'Ryan']), null);
    assert.equal(findReportStart([]), null);
    assert.equal(findReportStart(null), null);
    assert.equal(findReportStart([null, undefined, '']), null);
  });
});
