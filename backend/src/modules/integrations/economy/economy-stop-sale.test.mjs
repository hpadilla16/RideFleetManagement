/**
 * Ride stop sale → Economy close-out (Hector, 2026-08-06: "esa regla del stop
 * sale aplica para todas las integraciones que tienen writeback").
 *
 * Economy's own guardrail refuses to CREATE a close-out as a side effect of a
 * pricing sync — correct for prices, wrong for closures. A stop sale IS the
 * operator decision that rule protects, so decideCell gets an explicit lane:
 * write STOP_SALE_DAILY, bypass the delta band, leave already-closed cells
 * alone.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:5432/none';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { decideCell, buildPushPlan, SKIP, STOP_SALE_DAILY } = await import('./economy-rate-map.js');
const { isClassClosedOn } = await import('../booking-source/stop-sale-closures.js');

describe('decideCell stopSale lane', () => {
  it('closes an open cell at 999.99, bypassing the delta band', () => {
    // 24.00 → 999.99 is a ~4000% move; the band must not hold a closure.
    const out = decideCell({ rfmValue: 24, portalValue: 24, closeoutMin: 250, maxDeltaPct: 60, stopSale: true });
    assert.deepEqual(out, { push: true, value: STOP_SALE_DAILY, reason: null, stopSale: true });
  });

  it('a cell the portal already shows closed is left alone, whatever value closed it', () => {
    assert.equal(decideCell({ portalValue: 250, closeoutMin: 250, stopSale: true }).reason, SKIP.CLOSEOUT_PRESERVED);
    assert.equal(decideCell({ portalValue: 999.99, closeoutMin: 250, stopSale: true }).reason, SKIP.CLOSEOUT_PRESERVED);
  });

  it('no sentinel still refuses everything — including closures', () => {
    // Without the sentinel we cannot read the grid safely at all.
    assert.equal(decideCell({ portalValue: 24, closeoutMin: null, stopSale: true }).reason, SKIP.NO_SENTINEL);
  });

  it('a normal price push STILL cannot create a close-out by accident', () => {
    assert.equal(decideCell({ rfmValue: 900, portalValue: 24, closeoutMin: 250 }).reason, SKIP.OUT_OF_BAND,
      'the original refusal is untouched — only the explicit stopSale lane closes cells');
  });
});

describe('buildPushPlan with closedDates', () => {
  const closures = new Map([['CCAR', new Set(['2026-08-08', '2026-08-09'])], ['XFAR', new Set(['2026-08-08'])]]);

  it('closed dates push 999.99, open dates keep the normal price flow', () => {
    const { pushes } = buildPushPlan({
      rfmRates: [{ classCode: 'CCAR', daily: 24, rateItemId: 'ri1' }],
      dates: ['2026-08-07', '2026-08-08', '2026-08-09'],
      portalGrid: { CCAR: { '2026-08-07': 30, '2026-08-08': 30, '2026-08-09': 30 } },
      portalClasses: ['CCAR'],
      closeoutMin: 250,
      closedDates: closures,
    });
    assert.deepEqual(
      pushes.map((p) => [p.rateDate, p.pushedValue, p.stopSale === true]),
      [
        ['2026-08-07', 24, false],            // open day: RFM price
        ['2026-08-08', STOP_SALE_DAILY, true], // closed
        ['2026-08-09', STOP_SALE_DAILY, true], // closed
      ],
    );
  });

  it('a portal class with NO RFM rate still closes on its closed dates', () => {
    const { pushes, skips } = buildPushPlan({
      rfmRates: [],
      dates: ['2026-08-07', '2026-08-08'],
      portalGrid: { XFAR: { '2026-08-08': 45 } },
      portalClasses: ['XFAR'],
      closeoutMin: 250,
      closedDates: closures,
    });
    assert.deepEqual(pushes.map((p) => [p.classCode, p.rateDate, p.pushedValue]),
      [['XFAR', '2026-08-08', STOP_SALE_DAILY]]);
    // The open day still reports the pricing gap.
    assert.equal(skips.some((s) => s.reason === SKIP.NO_RFM_RATE), false,
      'a class that closed at least one date is handled, not reported as a bare gap');
  });

  it('the closure map answers under the RFM code even when the portal code differs', () => {
    // classOverrides: RFM SFAR aliases to portal IFAR (the LAX shape).
    const closed = new Map([['SFAR', new Set(['2026-08-08'])]]);
    const { pushes } = buildPushPlan({
      rfmRates: [{ classCode: 'SFAR', daily: 30 }],
      dates: ['2026-08-08'],
      portalGrid: { IFAR: { '2026-08-08': 28 } },
      portalClasses: ['IFAR'],
      classOverrides: { SFAR: 'IFAR' },
      closeoutMin: 250,
      closedDates: closed,
    });
    assert.deepEqual(pushes.map((p) => [p.classCode, p.pushedValue]), [['IFAR', STOP_SALE_DAILY]],
      'the override must not open a hole in the closure');
  });

  it('isClassClosedOn is the shared truth', () => {
    assert.equal(isClassClosedOn(closures, 'CCAR', '2026-08-08'), true);
    assert.equal(isClassClosedOn(closures, 'ccar', '2026-08-08'), true, 'case never decides a closure');
    assert.equal(isClassClosedOn(closures, 'CCAR', '2026-08-10'), false);
    assert.equal(isClassClosedOn(null, 'CCAR', '2026-08-08'), false);
  });
});
