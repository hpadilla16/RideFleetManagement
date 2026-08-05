/**
 * MEX rate writeback — the pure decision layer.
 *
 * The contract these tests defend is doc/mex-rate-writeback-recon-2026-08-05.md,
 * captured from a REAL successful portal write. The numbers in the fixtures are
 * the portal's own (BPABR Preload + the WebRateReport1 confirmation row).
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:5432/none';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  mexTierValues, buildRatePlan, buildGridOverrides, verifyReport,
  resolveDesiredForClass, DECISION, STOP_SALE_DAILY,
  effectiveDailyOn, isoDates, buildPushBands, bandToDesired,
} = await import('./mex-rate-push.service.js');
const { parseRateGridRows, parseRateReport, rateRowValues, isRateUpdateScreen, dayCheckboxOverrides } =
  await import('./mex.service.js');
const { mexRatePushEligibleCodes } = await import('./mex.constants.js');

// ---------------------------------------------------------------------------
// Tier formula
// ---------------------------------------------------------------------------

describe('pushWindowDays', () => {
  it('defaults to 28 days — each push covers the next four weeks, not a year', async () => {
    const { pushWindowDays } = await import('./mex-rate-push.service.js');
    const prev = process.env.MEX_RATE_PUSH_WINDOW_DAYS;
    delete process.env.MEX_RATE_PUSH_WINDOW_DAYS;
    try {
      assert.equal(pushWindowDays(), 28);
      process.env.MEX_RATE_PUSH_WINDOW_DAYS = '90';
      assert.equal(pushWindowDays(), 90);
      process.env.MEX_RATE_PUSH_WINDOW_DAYS = 'garbage';
      assert.equal(pushWindowDays(), 28, 'a bad value falls back, never to zero or a year');
    } finally {
      if (prev === undefined) delete process.env.MEX_RATE_PUSH_WINDOW_DAYS;
      else process.env.MEX_RATE_PUSH_WINDOW_DAYS = prev;
    }
  });
});

describe('mexTierValues', () => {
  it('is d / d×7 / d×28 / d — the portal-confirmed formula, ×28 not ×30', () => {
    // Live BPABR rows: ECAR 64/448/1792/64, FFAR 118/826/3304/118.
    assert.deepEqual(mexTierValues(64), { daily: 64, weekly: 448, monthly: 1792, xday: 64 });
    assert.deepEqual(mexTierValues(118), { daily: 118, weekly: 826, monthly: 3304, xday: 118 });
    // MI-priced decimals round to cents, not floats.
    assert.deepEqual(mexTierValues(19.6), { daily: 19.6, weekly: 137.2, monthly: 548.8, xday: 19.6 });
    assert.deepEqual(mexTierValues(14.38), { daily: 14.38, weekly: 100.66, monthly: 402.64, xday: 14.38 });
  });
});

// ---------------------------------------------------------------------------
// Grid parsing (row → class is scraped, never hardcoded)
// ---------------------------------------------------------------------------

const GRID_HTML = `
<form name="aspnetForm" action="rcUpdateRates1a.aspx?id=abc123" method="post">
<select name="_ctl0:cphMaster1:lstRateCode" multiple><option value="BPABR" selected>BPABR</option></select>
<table id="_ctl0_cphMaster1_dgRates">
<tr><td>Class</td><td>Daily</td></tr>
<tr><td>CFAR HYUNDAI KONA SE OR SIMILAR</td>
  <td><input name="_ctl0:cphMaster1:dgRates:_ctl2:txtDGDailyRate" value="70.00"/></td>
  <td><input name="_ctl0:cphMaster1:dgRates:_ctl2:txtDGWeeklyRate" value="490.00"/></td>
  <td><input name="_ctl0:cphMaster1:dgRates:_ctl2:txtDGMonthlyRate" value="1960.00"/></td>
  <td><input name="_ctl0:cphMaster1:dgRates:_ctl2:txtDGXDayRate" value="70.00"/></td></tr>
<tr><td>ECAR NISSAN VERSA OR SIMILAR</td>
  <td><input name="_ctl0:cphMaster1:dgRates:_ctl3:txtDGDailyRate" value="64.00"/></td>
  <td><input name="_ctl0:cphMaster1:dgRates:_ctl3:txtDGWeeklyRate" value="448.00"/></td>
  <td><input name="_ctl0:cphMaster1:dgRates:_ctl3:txtDGMonthlyRate" value="1792.00"/></td>
  <td><input name="_ctl0:cphMaster1:dgRates:_ctl3:txtDGXDayRate" value="64.00"/></td></tr>
</table></form>`;

describe('parseRateGridRows', () => {
  it('maps each row prefix to the class label scraped from the row itself', () => {
    const rows = parseRateGridRows(GRID_HTML);
    assert.deepEqual(rows, [
      { rowPrefix: '_ctl0:cphMaster1:dgRates:_ctl2', classCode: 'CFAR' },
      { rowPrefix: '_ctl0:cphMaster1:dgRates:_ctl3', classCode: 'ECAR' },
    ]);
  });

  it('recognises the screen', () => {
    assert.equal(isRateUpdateScreen(GRID_HTML), true);
    assert.equal(isRateUpdateScreen('<html>Main Menu</html>'), false);
  });

  it('reads current values off the parsed form', async () => {
    const { parseWebFormsForm } = await import('./mex.service.js');
    const { fields } = parseWebFormsForm(GRID_HTML);
    assert.deepEqual(rateRowValues(fields, '_ctl0:cphMaster1:dgRates:_ctl2'),
      { daily: 70, weekly: 490, monthly: 1960, xday: 70 });
  });
});

// ---------------------------------------------------------------------------
// Plan decisions
// ---------------------------------------------------------------------------

function desiredFixture() {
  return {
    byClass: new Map([
      ['CFAR', { daily: 19.6, sourceRateItemId: 'ri-cfar' }],
      ['CCAR', { daily: 14.38, sourceRateItemId: 'ri-ccar' }],
    ]),
    redirect: new Map([['ECAR', 'CCAR'], ['ICAR', 'SCAR']]),
    conflicts: [],
  };
}

describe('buildRatePlan', () => {
  const rows = [
    { rowPrefix: 'p:_ctl2', classCode: 'CFAR', current: { daily: 70, weekly: 490, monthly: 1960, xday: 70 } },
    { rowPrefix: 'p:_ctl3', classCode: 'ECAR', current: { daily: 64, weekly: 448, monthly: 1792, xday: 64 } },
    { rowPrefix: 'p:_ctl5', classCode: 'FJAR', current: { daily: 157, weekly: 1099, monthly: 4396, xday: 157 } },
  ];

  it('writes with the redirect, holds huge deltas, and skips classes RFM cannot price', () => {
    const plan = buildRatePlan(rows, desiredFixture(), { maxDeltaPct: 80 });
    const by = Object.fromEntries(plan.map((r) => [r.classCode, r]));

    // CFAR 70 → 19.60 is −72%: inside the 80% band, written.
    assert.equal(by.CFAR.decision, DECISION.WRITE);
    assert.deepEqual(by.CFAR.desired, { daily: 19.6, weekly: 137.2, monthly: 548.8, xday: 19.6 });

    // ECAR prices from CCAR via the tenant's AcrissCategoryMap — the same
    // redirect the import uses, in reverse.
    assert.equal(by.ECAR.decision, DECISION.WRITE);
    assert.equal(by.ECAR.desired.daily, 14.38);
    assert.equal(by.ECAR.source.via, 'CCAR');

    // FJAR has no RFM price: LEFT ALONE. Writing 0 would make a Jeep free.
    assert.equal(by.FJAR.decision, DECISION.SKIP_NO_SOURCE);
  });

  it('holds a move beyond maxDeltaPct for a human instead of writing it', () => {
    const plan = buildRatePlan(rows, desiredFixture(), { maxDeltaPct: 50 });
    const cfar = plan.find((r) => r.classCode === 'CFAR');
    assert.equal(cfar.decision, DECISION.HELD_DELTA, '-72% exceeds the 50% band');
    assert.equal(typeof cfar.deltaPct, 'number');

    // force is the human saying yes.
    const forced = buildRatePlan(rows, desiredFixture(), { maxDeltaPct: 50, force: true });
    assert.equal(forced.find((r) => r.classCode === 'CFAR').decision, DECISION.WRITE);
  });

  it('skips a row the portal already has right — all four tiers must match', () => {
    const inSync = [{
      rowPrefix: 'p:_ctl2', classCode: 'CFAR',
      current: { daily: 19.6, weekly: 137.2, monthly: 548.8, xday: 19.6 },
    }];
    assert.equal(buildRatePlan(inSync, desiredFixture())[0].decision, DECISION.SKIP_SAME);

    // Same daily but a stale monthly (the live typo: 196.00 for a month in a
    // Kona) must still be rewritten.
    const staleMonthly = [{
      rowPrefix: 'p:_ctl2', classCode: 'CFAR',
      current: { daily: 19.6, weekly: 137.2, monthly: 196, xday: 19.6 },
    }];
    assert.equal(buildRatePlan(staleMonthly, desiredFixture())[0].decision, DECISION.WRITE);
  });
});

describe('buildGridOverrides', () => {
  it('emits money strings for WRITE rows only, all four tiers', () => {
    const plan = buildRatePlan(
      [{ rowPrefix: 'p:_ctl2', classCode: 'CFAR', current: { daily: 70, weekly: 490, monthly: 1960, xday: 70 } },
       { rowPrefix: 'p:_ctl5', classCode: 'FJAR', current: { daily: 157, weekly: 1099, monthly: 4396, xday: 157 } }],
      desiredFixture(), { maxDeltaPct: 90 },
    );
    const overrides = buildGridOverrides(plan);
    assert.deepEqual(overrides, {
      'p:_ctl2:txtDGDailyRate': '19.60',
      'p:_ctl2:txtDGWeeklyRate': '137.20',
      'p:_ctl2:txtDGMonthlyRate': '548.80',
      'p:_ctl2:txtDGXDayRate': '19.60',
    });
  });
});

// ---------------------------------------------------------------------------
// Report verification — the portal's own words, not our optimism
// ---------------------------------------------------------------------------

const REPORT_HTML = `
<table><tr><th>Requested</th><th>System</th><th>TSD#</th><th>Branch</th><th>Code</th>
<th>Cat</th><th>Class</th><th>Rate</th><th>Result</th><th>Allow Undo</th></tr>
<tr><td>2026/08/04 20:45:52</td><td>WebLink</td><td>61306</td><td>SJU-SJU</td><td>BPABR</td>
<td>S</td><td>CFAR</td><td>1960.00/MY  UNL [STD]</td><td>Completed 2026/08/04 20:45:52</td><td>Yes</td></tr>
<tr><td>2026/08/04 20:45:52</td><td>WebLink</td><td>61306</td><td>SJU-SJU</td><td>BPABR</td>
<td>S</td><td>CFAR</td><td>70.00/DY  UNL [STD]</td><td>Completed 2026/08/04 20:45:52</td><td>Yes</td></tr>
<tr><td>2026/08/04 20:45:52</td><td>WebLink</td><td>61306</td><td>SJU-SJU</td><td>BPABR</td>
<td>S</td><td>ECAR</td><td>64.00/DY  UNL [STD]</td><td>Rejected: overlapping window</td><td>No</td></tr>
</table>`;

describe('parseRateReport / verifyReport', () => {
  it('parses the confirmation rows with class, tier and the portal Result', () => {
    const rows = parseRateReport(REPORT_HTML);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => [r.classCode, r.tier, r.completed]),
      [['CFAR', 'MY', true], ['CFAR', 'DY', true], ['ECAR', 'DY', false]],
    );
    assert.equal(rows[0].rateCode, 'BPABR');
  });

  it('a class is verified only when EVERY row for it says Completed', () => {
    const verdicts = verifyReport(parseRateReport(REPORT_HTML), {
      rateCode: 'BPABR', writtenClasses: ['CFAR', 'ECAR', 'SFAR'],
    });
    assert.equal(verdicts.get('CFAR').verified, true);
    assert.equal(verdicts.get('ECAR').verified, false, 'a Rejected row fails the class');
    assert.match(verdicts.get('ECAR').reason, /Rejected/);
    assert.equal(verdicts.get('SFAR').verified, false, 'a class missing from the report is NOT a success');
    assert.match(verdicts.get('SFAR').reason, /missing/);
  });
});

describe('dayCheckboxOverrides', () => {
  it('forces all eight day checkboxes ON, keyed by full field name', () => {
    // First live push wrote ZERO rows: the checkboxes render unchecked, an
    // unchecked checkbox is never posted, and "no days selected" made the
    // portal update nothing while answering 302 → report as if all was well.
    const out = dayCheckboxOverrides('_ctl0:cphMaster1:Button1');
    assert.equal(Object.keys(out).length, 8);
    assert.equal(out['_ctl0:cphMaster1:chkAllDays'], 'on');
    assert.equal(out['_ctl0:cphMaster1:chkSunday'], 'on');
    assert.equal(out['_ctl0:cphMaster1:chkSaturday'], 'on');
    assert.equal(Object.keys(out).every((k) => k.startsWith('_ctl0:cphMaster1:chk')), true);
  });
});

// ---------------------------------------------------------------------------
// Per-date pricing → date bands (Hector, 2026-08-06: "tiene que mirar los 28
// dias de precio ya que sube y baja los precios")
// ---------------------------------------------------------------------------

describe('per-date pricing bands', () => {
  function desiredWithOverrides() {
    const d = desiredFixture();
    d.byClass.get('CFAR').byDate = new Map([
      // Weekend surge Aug 8–9, back to base after.
      ['2026-08-08', 29.99],
      ['2026-08-09', 29.99],
    ]);
    d.byClass.get('CCAR').byDate = new Map();
    return d;
  }

  it('effectiveDailyOn: the override wins, the base backs it — resolveForRental semantics', () => {
    const entry = desiredWithOverrides().byClass.get('CFAR');
    assert.equal(effectiveDailyOn(entry, '2026-08-07'), 19.6, 'no override → base');
    assert.equal(effectiveDailyOn(entry, '2026-08-08'), 29.99, 'override wins');
    assert.equal(effectiveDailyOn(null, '2026-08-08'), null);
  });

  it('collapses the window into contiguous bands, one portal write each', () => {
    const dates = isoDates('2026-08-06', 7); // Aug 6..12
    const bands = buildPushBands(desiredWithOverrides(), ['CFAR', 'ECAR'], dates);
    assert.deepEqual(
      bands.map((b) => [b.fromDate, b.toDate, b.prices.get('CFAR'), b.prices.get('ECAR')]),
      [
        ['2026-08-06', '2026-08-07', 19.6, 14.38],   // base until the surge
        ['2026-08-08', '2026-08-09', 29.99, 14.38],  // the surge, its own write
        ['2026-08-10', '2026-08-12', 19.6, 14.38],   // base again after
      ],
      'a price change on any class starts a new band; equal days merge',
    );
  });

  it('a flat window is exactly one band — the pre-per-date behavior', () => {
    const dates = isoDates('2026-08-06', 28);
    const bands = buildPushBands(desiredFixture(), ['CFAR', 'ECAR'], dates);
    assert.equal(bands.length, 1);
    assert.equal(bands[0].fromDate, '2026-08-06');
    assert.equal(bands[0].toDate, '2026-09-02');
    assert.equal(bands[0].prices.get('ECAR'), 14.38, 'redirect applies inside bands too');
  });

  it('bandToDesired feeds buildRatePlan the band price, keeping the source id', () => {
    const desired = desiredWithOverrides();
    const dates = isoDates('2026-08-08', 2);
    const [band] = buildPushBands(desired, ['CFAR'], dates);
    const plan = buildRatePlan(
      [{ rowPrefix: 'p:_ctl2', classCode: 'CFAR', current: { daily: 19.6, weekly: 137.2, monthly: 548.8, xday: 19.6 } }],
      bandToDesired(desired, band),
      { maxDeltaPct: 90 },
    );
    assert.equal(plan[0].decision, DECISION.WRITE, 'surge differs from the portal → write');
    assert.deepEqual(plan[0].desired, mexTierValues(29.99));
    assert.equal(plan[0].source.sourceRateItemId, 'ri-cfar', 'audit trail survives the band adapter');
  });

  it('isoDates spans exactly the window, UTC-stable', () => {
    const dates = isoDates('2026-08-06', 28);
    assert.equal(dates.length, 28);
    assert.equal(dates[0], '2026-08-06');
    assert.equal(dates[27], '2026-09-02');
  });
});

// ---------------------------------------------------------------------------
// Stop sales → 999.99 close-out (Hector, 2026-08-06: "si nosotros ponemos un
// stop sales en el sistema de Ride que automaticamente para la proxima corrida
// subir todo los precios a 999.99, y calculalo por semana mensual")
// ---------------------------------------------------------------------------

describe('stop-sale close-out', () => {
  function desiredWithStopSale() {
    const d = desiredFixture();
    // CFAR closed Aug 8–9 (the loader overlays STOP_SALE_DAILY on those days).
    d.byClass.get('CFAR').byDate = new Map([
      ['2026-08-08', STOP_SALE_DAILY],
      ['2026-08-09', STOP_SALE_DAILY],
    ]);
    return d;
  }

  it('the closed days become their own band at 999.99, weekly/monthly by the formula', () => {
    const bands = buildPushBands(desiredWithStopSale(), ['CFAR'], isoDates('2026-08-06', 6));
    assert.deepEqual(
      bands.map((b) => [b.fromDate, b.toDate, b.prices.get('CFAR')]),
      [
        ['2026-08-06', '2026-08-07', 19.6],
        ['2026-08-08', '2026-08-09', STOP_SALE_DAILY],
        ['2026-08-10', '2026-08-11', 19.6],
      ],
    );
    // "calculalo por semana mensual": the same tier formula as any write.
    assert.deepEqual(mexTierValues(STOP_SALE_DAILY),
      { daily: 999.99, weekly: 6999.93, monthly: 27999.72, xday: 999.99 });
  });

  it('the close-out bypasses the delta guard — a closed class must not sit HELD overnight', () => {
    const desired = desiredWithStopSale();
    const [, closedBand] = buildPushBands(desired, ['CFAR'], isoDates('2026-08-06', 6));
    const plan = buildRatePlan(
      [{ rowPrefix: 'p:_ctl2', classCode: 'CFAR', current: { daily: 19.6, weekly: 137.2, monthly: 548.8, xday: 19.6 } }],
      bandToDesired(desired, closedBand),
      { maxDeltaPct: 60 }, // 19.60 → 999.99 is +5000%, far beyond the band
    );
    assert.equal(plan[0].decision, DECISION.WRITE);
    assert.equal(plan[0].stopSale, true, 'flagged for the audit trail');
    assert.equal(plan[0].desired.daily, STOP_SALE_DAILY);
  });

  it('a class with NO RFM rate still closes — and its open days stay untouched', () => {
    // The loader creates a base-less entry for a stop-sale on an unpriced
    // class. Closed day → 999.99; open day → no price → SKIP_NO_SOURCE.
    const desired = {
      byClass: new Map([['FJAR', { daily: null, sourceRateItemId: null, byDate: new Map([['2026-08-08', STOP_SALE_DAILY]]) }]]),
      redirect: new Map(),
      conflicts: [],
    };
    assert.equal(effectiveDailyOn(desired.byClass.get('FJAR'), '2026-08-08'), STOP_SALE_DAILY);
    assert.equal(effectiveDailyOn(desired.byClass.get('FJAR'), '2026-08-07'), null, 'no base → open days have no price');

    const bands = buildPushBands(desired, ['FJAR'], ['2026-08-07', '2026-08-08']);
    assert.equal(bands.length, 2);
    assert.equal(bands[0].prices.has('FJAR'), false, 'open day: class absent → left alone');
    assert.equal(bands[1].prices.get('FJAR'), STOP_SALE_DAILY, 'closed day: priced out');
  });
});

// ---------------------------------------------------------------------------
// The write list is a fence, not a default
// ---------------------------------------------------------------------------

describe('eligible codes', () => {
  it('inclusivo codes are never on the write list', () => {
    const codes = mexRatePushEligibleCodes();
    assert.equal(codes.length, 7);
    for (const banned of ['IPMEXS', 'PPEXI', 'MEXWEB', 'INCPOA', 'MEXPKG']) {
      assert.equal(codes.includes(banned), false, `${banned} must never be written`);
    }
  });

  it('resolveDesiredForClass never invents a price', () => {
    const desired = desiredFixture();
    assert.equal(resolveDesiredForClass(desired, 'ICAR'), null, 'redirect target SCAR has no price → null');
    assert.equal(resolveDesiredForClass(desired, 'ZZZZ'), null);
    assert.equal(resolveDesiredForClass(desired, ''), null);
  });
});
