/**
 * PARITY PIN for composeRentalMoney (src/lib/rental-money.js).
 *
 * The staff rate override recomputes a quote through this helper. That is only
 * safe if the helper is the SAME arithmetic booking-engine.service.js's
 * searchRental() used to inline. This suite freezes the original expression —
 * copied verbatim from the pre-refactor source below — and asserts the helper
 * agrees with it on every fixture, including the rounding-boundary ones where
 * "tidying" the operand order would visibly change a cent.
 *
 * If someone rewrites composeRentalMoney and this suite fails, the helper is
 * wrong, not the pin. The pin IS the engine.
 *
 * Run: npm run test:quote-rate-override
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeRentalMoney } from './rental-money.js';
import { money } from './money.js';

/**
 * The exact three lines searchRental carried before the extraction:
 *
 *   const taxes = money(Number(quote.baseTotal || 0) * (Number(location.taxRate || 0) / 100));
 *   const mandatoryFeesTotal = money((mandatoryFees || []).reduce((sum, fee) => sum + Number(fee.total || 0), 0));
 *   const total = money(Number(quote.baseTotal || 0) + taxes + mandatoryFeesTotal);
 *   ... quote.subtotal = money(quote.baseTotal)
 */
function engineOriginal(baseTotal, taxRate, mandatoryFees) {
  const taxes = money(Number(baseTotal || 0) * (Number(taxRate || 0) / 100));
  const mandatoryFeesTotal = money((mandatoryFees || []).reduce((sum, fee) => sum + Number(fee.total || 0), 0));
  const total = money(Number(baseTotal || 0) + taxes + mandatoryFeesTotal);
  return { subtotal: money(baseTotal), fees: mandatoryFeesTotal, taxes, total };
}

const FIXTURES = [
  // [label, baseTotal, taxRate, mandatoryFees]
  ['plain 5 x 45 @ 11.5% with a fixed fee', 225, 11.5, [{ total: 15 }]],
  ['no fees, no tax', 180, 0, []],
  ['null fee list', 180, 7, null],
  ['percentage-ish fee totals with cents', 233.31, 10.5, [{ total: 11.67 }, { total: 3.33 }]],
  // Rounding boundaries — where operand order and money() placement show up.
  ['half-cent tax boundary', 100.05, 7.5, [{ total: 0.005 }]],
  ['long repeating tax', 333.33, 6.625, [{ total: 12.345 }]],
  ['tiny base', 0.01, 11.5, [{ total: 0.01 }]],
  ['big base', 98765.43, 11.5, [{ total: 1234.56 }, { total: 0.99 }]],
  // Degenerate inputs the engine tolerates via its `|| 0` guards.
  ['undefined base', undefined, 11.5, [{ total: 5 }]],
  ['fee row with no total', 200, 9, [{ total: undefined }, { total: 4 }]],
  ['string-ish numbers', '225', '11.5', [{ total: '15' }]],
];

for (const [label, baseTotal, taxRate, fees] of FIXTURES) {
  test(`composeRentalMoney matches the engine's original math — ${label}`, () => {
    assert.deepEqual(
      composeRentalMoney({ baseTotal, taxRate, mandatoryFees: fees }),
      engineOriginal(baseTotal, taxRate, fees)
    );
  });
}

test('composeRentalMoney: total is subtotal + taxes + fees to the cent', () => {
  const out = composeRentalMoney({ baseTotal: 225, taxRate: 11.5, mandatoryFees: [{ total: 15 }] });
  assert.equal(out.subtotal, 225);
  assert.equal(out.fees, 15);
  assert.equal(out.taxes, 25.88); // money(225 * 0.115) = 25.875 -> 25.88
  assert.equal(out.total, 265.88);
  assert.equal(money(out.subtotal + out.taxes + out.fees), out.total);
});

test('composeRentalMoney tolerates a missing argument object', () => {
  assert.deepEqual(composeRentalMoney(), { subtotal: 0, fees: 0, taxes: 0, total: 0 });
});
