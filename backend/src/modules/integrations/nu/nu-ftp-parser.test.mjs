/**
 * NU FTP parser tests (2026-07-26). The first fixture is NU's REAL sample
 * record, verbatim from doc/nu-ftp/FTPsample.txt — if NU's format drifts
 * from their own sample, these fail before money does.
 *
 * Fixture note: a JS template literal cannot END in a backslash (it escapes
 * the closing backtick), so every record's trailing field terminator is
 * appended as + BS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNuFtpRecord, parseNuFtpFile, parseNuDateTime, isPrepaidFromPayment, NuFtpFormatError } from './nu-ftp-parser.js';

const BS = '\\';

// Verbatim from FTPsample.txt (String.raw keeps the interior backslashes;
// the trailing one is concatenated).
const SAMPLE = String.raw`/ACTMR\/CNF6170105480NU\/NAMMARRYSHAW,LESROY\/PULFLL\/CTOFLL\/CHNNU\/PUD25Jul26/1000\/DOLFLL\/CTIFLL\/DOD28Jul26/1000\/VTPCFAR\/RTIS\/RATSYS3\/BCD2470ARC\/CMPNU CAR RENTALS\/MOPBC\/SORAA\/CON-\/INSNNNN\/BDT24Jul26/0019\/STN88\/CURUSD\/GINY\/RTSE\/MNP1D\/RTH12.75\/RTD5.96\/RTE5.96\/RAH12.75\/RAD5.96\/FMH99999\/FMD99999\/FME99999\/FMW99999\/FMM99999\/FAD99999\/MIL0.00\/GUAN\/AGT9997\/TXD24Jul26/0019\/PNC17.88\/CDMN\/1TE3\/1CD2470ARC\/1BR17.88\/1MC0.00\/1TP17.88\/1RC11609942ARC\/KIFN\/PH1-\/P1TY\/PVA17.88\/1CL LRF\/1CMD\/1CIY\/1CV3.29\/1CT0.00\/1CLState S/C\/1CMD\/1CIY\/1CV2.05\/1CT0.00\/1CLFacility F\/1CMD\/1CIY\/1CV3.50\/1CT0.00\/1CLAP Concess\/1CMP\/1CIY\/1CV10.00\/1CT0.00\/1CLSales Tax\/1CMP\/1CIY\/1CV7.00\/1CT0.00` + BS;

test('parses NU\'s real sample record end to end', () => {
  const { action, confirmation, reservation: r, charges } = parseNuFtpRecord(SAMPLE);
  assert.equal(action, 'MR');
  assert.equal(confirmation, '6170105480NU');
  assert.equal(r.lastName, 'MARRYSHAW');
  assert.equal(r.firstName, 'LESROY');
  assert.equal(r.pickupLocation, 'FLL');
  assert.equal(r.vehicleClass, 'CFAR');
  assert.equal(r.ratePlan, 'SYS3');
  assert.equal(r.currency, 'USD');
  // Dates: DDMmmYY/HHMM with a '/' INSIDE the value — the split on the
  // backslash-slash boundary must keep it intact.
  assert.equal(r.pickupDate, '2026-07-25');
  assert.equal(r.pickupTime, '10:00');
  assert.equal(r.dropoffDate, '2026-07-28');
  assert.equal(r.bookedDate, '2026-07-24');
  assert.equal(r.bookedTime, '00:19');
  // Money.
  assert.equal(r.baseRate, 17.88);
  assert.equal(r.mandatoryCharges, 0);
  assert.equal(r.totalPrice, 17.88);
  assert.equal(r.dailyRate, 5.96);
  // Mileage: 99999 = unlimited.
  assert.equal(r.unlimitedMileage, true);
  assert.equal(r.freeMilesPerDay, null);
  // Payment: PVA 17.88 (billed to NU) → provisional prepaid TRUE, MOP BC.
  assert.equal(r.mop, 'BC');
  assert.equal(r.voucherAmount, 17.88);
  assert.equal(r.isPrepaid, true);
  // '-' placeholders read as empty.
  assert.equal(r.phone, null);
  assert.equal(r.contact, null);
  // Charge table: 5 charges; 'State S/C' survives with its inner slash.
  assert.equal(charges.length, 5);
  assert.deepEqual(charges.map((c) => c.description), ['LRF', 'State S/C', 'Facility F', 'AP Concess', 'Sales Tax']);
  assert.equal(charges[0].method, 'D');
  assert.equal(charges[0].included, true);
  assert.equal(charges[0].amount, 3.29);
  assert.equal(charges[3].method, 'P');
  assert.equal(charges[3].amount, 10);
});

test('cancellation record (ACT XL) parses with its action', () => {
  const xl = String.raw`/ACTXL\/CNF8017654321NU\/NAMSPURGIN,JAMES,EDWARD\/PUD01Mar26/1105` + BS;
  const out = parseNuFtpRecord(xl);
  assert.equal(out.action, 'XL');
  assert.equal(out.confirmation, '8017654321NU');
  assert.equal(out.reservation.lastName, 'SPURGIN');
  assert.equal(out.reservation.firstName, 'JAMES');
  assert.equal(out.reservation.pickupDate, '2026-03-01');
});

test('emails split on ";", license state and DOB land where the deposit rule reads', () => {
  const cu = String.raw`/ACTCR\/CNF1234567890NU\/NAMDOE,JANE\/1EMa@x.com; b@y.com\/DLSCA\/DLN12345678\/DOB14Apr56\/STFTX` + BS;
  const { reservation: r } = parseNuFtpRecord(cu);
  assert.deepEqual(r.emails, ['a@x.com', 'b@y.com']);
  assert.equal(r.licenseState, 'CA');
  // YY→2000+ is the spec's convention for reservation dates; DOBs need a
  // century pivot rule — flagged as an open item, pinned here so a change
  // is deliberate.
  assert.equal(r.dateOfBirth, '2056-04-14');
  assert.equal(r.state, 'TX');
});

test('prepaid derivation — NU definitive MOP/PVA rules (2026-07-27)', () => {
  // PVA > 0 = NU collected = prepaid, whatever the MOP.
  assert.equal(isPrepaidFromPayment({ voucherAmount: 17.88, mop: 'BC' }), true);
  // Broker billed via NU (BC/CC) = prepaid, counter does NOT collect.
  assert.equal(isPrepaidFromPayment({ voucherAmount: null, mop: 'CC' }), true);
  assert.equal(isPrepaidFromPayment({ voucherAmount: 0, mop: 'BC' }), true);
  // Customer's own card (MC/VS/AX) = pay at destination, counter collects.
  assert.equal(isPrepaidFromPayment({ voucherAmount: null, mop: 'MC' }), false);
  assert.equal(isPrepaidFromPayment({ voucherAmount: null, mop: 'VS' }), false);
  assert.equal(isPrepaidFromPayment({ voucherAmount: null, mop: 'AX' }), false);
  // Unknown → never guess.
  assert.equal(isPrepaidFromPayment({ voucherAmount: 0, mop: 'ZZ' }), null);
  assert.equal(isPrepaidFromPayment({}), null);
});

test('file parsing: one record per line, continuations attach, bad rows collected not thrown', () => {
  const xlLine = String.raw`/ACTXL\/CNF9999999999NU\/NAMX,Y\/RMKfirst remark line` + BS;
  const badLine = String.raw`/ACTZZ\/CNF0000000000NU` + BS;
  const file = [
    SAMPLE,
    xlLine,
    'second remark line without a leading slash — folds into the XL record',
    badLine,
  ].join('\n');
  const { records, errors } = parseNuFtpFile(file);
  assert.equal(records.length, 2);
  assert.equal(records[1].action, 'XL');
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /unknown \/ACT/);
});

test('date parser edges', () => {
  assert.deepEqual(parseNuDateTime('01Mar22/1105'), { isoDate: '2022-03-01', time: '11:05' });
  assert.deepEqual(parseNuDateTime('24Jul26'), { isoDate: '2026-07-24', time: null });
  assert.equal(parseNuDateTime('99Xyz99'), null);
  assert.equal(parseNuDateTime(''), null);
});

test('malformed records throw NuFtpFormatError (missing CNF, bad start)', () => {
  assert.throws(() => parseNuFtpRecord(String.raw`/ACTCR\/NAMX,Y` + BS), NuFtpFormatError);
  assert.throws(() => parseNuFtpRecord('ACTCR no leading slash'), NuFtpFormatError);
});
