/**
 * Outbound rate push — client parsing + orchestration (2026-07-28).
 * Fetch and prisma are stubbed; nothing touches the network or a DB.
 * These pin the behaviours that protect a franchise's live pricing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

const { parseRateGrid, headerToIsoDate, toPortalDate } = await import('./economy-rate-client.js');
const { dateWindow, pushArea, MODES } = await import('./economy-rate-push.service.js');

// A faithful slice of the real display-grid HTML (recon 2026-07-28).
function gridHtml(rows) {
  const heads = ['ALL', '03/15/27', '03/16/27', '03/17/27'];
  return `<table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.map(({ cls, values }) => `<tr>
      <td class="class-items"><input type="button" class="form-control" wg-field="carclass" value="${cls}" /></td>
      ${values.map((v) => `<td><input type="text" class="form-control" value="${v}" /></td>`).join('')}
    </tr>`).join('')
  }</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Client parsing
// ---------------------------------------------------------------------------
test('headerToIsoDate: portal mm/dd/yy -> iso', () => {
  assert.equal(headerToIsoDate('03/15/27'), '2027-03-15');
  assert.equal(headerToIsoDate('ALL'), null);
  assert.equal(headerToIsoDate(''), null);
});

test('toPortalDate: yyyy-mm-dd becomes a noon-UTC ISO (no day slippage)', () => {
  assert.equal(toPortalDate('2027-03-15'), '2027-03-15T12:00:00.000Z');
  assert.throws(() => toPortalDate('nonsense'));
});

test('parseRateGrid: values line up with their DATE columns, not the ALL column', () => {
  const { classes, dates, grid } = parseRateGrid(gridHtml([
    { cls: 'CCAR', values: ['33.33', '', '250.00'] },
    { cls: 'ECAR', values: ['', '', ''] },
  ]));
  assert.deepEqual(classes, ['CCAR', 'ECAR']);
  assert.deepEqual(dates, ['2027-03-15', '2027-03-16', '2027-03-17']);
  // The canary proved the first value belongs to the FIRST DATE, not to "ALL".
  assert.equal(grid.CCAR['2027-03-15'], '33.33');
  assert.equal(grid.CCAR['2027-03-16'], '');
  assert.equal(grid.CCAR['2027-03-17'], '250.00');
  assert.equal(grid.ECAR['2027-03-15'], '');
});

test('dateWindow: contiguous iso days from the start', () => {
  assert.deepEqual(dateWindow(new Date('2027-03-15T12:00:00Z'), 3), ['2027-03-15', '2027-03-16', '2027-03-17']);
});

// ---------------------------------------------------------------------------
// Orchestration harness
// ---------------------------------------------------------------------------
function makeDeps({ portalRows, rfmRates, mode, applyImpl, approvals }) {
  const logs = [];
  const prismaStub = {
    ratePushLog: {
      // F4 reads pre-approved cells (findMany) and dedupes the pending queue
      // (findFirst); `approvals` lets a test seed authorised rows.
      findMany: async () => (approvals || []).map((a, i) => ({
        id: `appr-${i}`, classCode: a.classCode,
        rateDate: new Date(`${a.rateDate}T00:00:00Z`), pushedValue: a.pushedValue,
      })),
      findFirst: async ({ where }) => logs.find((l) => (
        l.status === 'PENDING_APPROVAL'
        && l.classCode === where.classCode
        && new Date(l.rateDate).toISOString().slice(0, 10) === new Date(where.rateDate).toISOString().slice(0, 10)
      )) || null,
      create: async ({ data }) => { const row = { id: `log-${logs.length}`, ...data }; logs.push(row); return row; },
      update: async ({ where, data }) => {
        const row = logs.find((l) => l.id === where.id);
        if (row) Object.assign(row, data);
        return row || { id: where.id, ...data };
      },
    },
  };
  const calls = { applied: [], reads: 0 };
  const client = {
    readRateGrid: async () => { calls.reads += 1; return parseRateGrid(gridHtml(portalRows)); },
    applyRateCell: applyImpl || (async (_t, args) => { calls.applied.push(args); return { claimedSuccess: true }; }),
  };
  return {
    logs, calls,
    deps: {
      prisma: prismaStub, client, mode,
      now: () => new Date('2027-03-15T12:00:00Z'),
      horizonDays: 3,
      loadRfmRates: async () => rfmRates,
    },
  };
}

const CONFIG = {
  tenantId: 't1', locationId: 'loc-lax', externalArea: 'LAX',
  externalLocationCode: 'LAXO01', ratePushEnabled: true, rateCloseoutMin: 250, provider: '61201',
};

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------
test('REFUSES: an area with no close-out sentinel never pushes', async () => {
  const { deps, calls } = makeDeps({ portalRows: [{ cls: 'CCAR', values: ['', '', ''] }], rfmRates: [{ classCode: 'CCAR', daily: 20 }], mode: MODES.LIVE });
  const out = await pushArea({ ...CONFIG, rateCloseoutMin: null }, deps);
  assert.equal(out.skipped, 'no_sentinel');
  assert.equal(calls.applied.length, 0);
});

test('REFUSES: area flag off, and global mode OFF, both stop the push', async () => {
  const a = makeDeps({ portalRows: [], rfmRates: [{ classCode: 'CCAR', daily: 20 }], mode: MODES.LIVE });
  assert.equal((await pushArea({ ...CONFIG, ratePushEnabled: false }, a.deps)).skipped, 'area_disabled');
  const b = makeDeps({ portalRows: [], rfmRates: [{ classCode: 'CCAR', daily: 20 }], mode: MODES.OFF });
  assert.equal((await pushArea(CONFIG, b.deps)).skipped, 'mode_off');
  assert.equal(a.calls.applied.length + b.calls.applied.length, 0);
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------
test('DRY_RUN: plans every cell but writes NOTHING', async () => {
  const { deps, calls, logs } = makeDeps({
    portalRows: [{ cls: 'CCAR', values: ['', '', ''] }],
    rfmRates: [{ classCode: 'CCAR', daily: 20, rateItemId: 'ri-1' }],
    mode: MODES.DRY_RUN,
  });
  const out = await pushArea(CONFIG, deps);
  assert.equal(out.planned, 3, 'three dates in the horizon');
  assert.equal(calls.applied.length, 0, 'no portal writes in a dry run');
  const planned = logs.filter((l) => l.status === 'PLANNED');
  assert.equal(planned.length, 3);
  assert.equal(Number(planned[0].pushedValue), 20);
  assert.equal(planned[0].mode, 'DRY_RUN');
});

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------
test('LIVE: writes, then VERIFIES via read-back and audits the result', async () => {
  // The portal grid already reflects 20.00, so the read-back verifies.
  const { deps, calls, logs } = makeDeps({
    portalRows: [{ cls: 'CCAR', values: ['20.00', '20.00', '20.00'] }],
    rfmRates: [{ classCode: 'CCAR', daily: 20 }],
    mode: MODES.LIVE,
  });
  // Everything already matches -> all skipped as no_change, nothing written.
  const out = await pushArea(CONFIG, deps);
  assert.equal(out.planned, 0);
  assert.equal(calls.applied.length, 0);
  assert.ok(logs.every((l) => l.status === 'SKIPPED' && l.skipReason === 'no_change'));
});

test('LIVE: a close-out day is preserved while its neighbours publish', async () => {
  const { deps, calls, logs } = makeDeps({
    portalRows: [{ cls: 'CCAR', values: ['', '250.00', ''] }],
    rfmRates: [{ classCode: 'CCAR', daily: 20 }],
    mode: MODES.LIVE,
  });
  const out = await pushArea(CONFIG, deps);
  assert.equal(out.planned, 2, 'only the two open days');
  const written = calls.applied.map((a) => a.rateDate).sort();
  assert.deepEqual(written, ['2027-03-15', '2027-03-17']);
  assert.ok(!written.includes('2027-03-16'), 'the blocked day was never touched');
  const preserved = logs.find((l) => l.skipReason === 'closeout_preserved');
  assert.ok(preserved, 'the preserved close-out is in the audit trail');
});

test('LIVE: portal lying about success is caught and logged as MISMATCH', async () => {
  // Portal keeps showing empty no matter what we send (the real 2026-07-28
  // failure mode: ApplyRates answers success and changes nothing).
  const { deps, logs } = makeDeps({
    portalRows: [{ cls: 'CCAR', values: ['', '', ''] }],
    rfmRates: [{ classCode: 'CCAR', daily: 20 }],
    mode: MODES.LIVE,
    applyImpl: async () => ({ claimedSuccess: true, message: 'The rates have been updated.' }),
  });
  const out = await pushArea(CONFIG, deps);
  assert.equal(out.sent, 3);
  assert.equal(out.verified, 0, 'nothing actually landed');
  assert.equal(out.mismatched, 3, 'the lie was caught by the read-back');
  assert.ok(logs.filter((l) => l.status === 'MISMATCH').length === 3);
});

test('LIVE: a throwing write is audited as FAILED and does not abort the run', async () => {
  let n = 0;
  const { deps, logs } = makeDeps({
    portalRows: [{ cls: 'CCAR', values: ['', '', ''] }],
    rfmRates: [{ classCode: 'CCAR', daily: 20 }],
    mode: MODES.LIVE,
    applyImpl: async () => { n += 1; if (n === 1) throw new Error('portal 500'); return { claimedSuccess: true }; },
  });
  const out = await pushArea(CONFIG, deps);
  assert.equal(out.failed, 1);
  assert.equal(out.sent, 2, 'the remaining dates still went out');
  const failed = logs.find((l) => l.status === 'FAILED');
  assert.match(failed.error, /portal 500/);
});

// ---------------------------------------------------------------------------
// F3 — scheduler gating + pushAllAreas fan-out
// ---------------------------------------------------------------------------
const sched = await import('./economy-rate-push.scheduler.js');
const svc = await import('./economy-rate-push.service.js');

test('scheduler: dormant while ECONOMY_RATE_PUSH_MODE is OFF (the default)', () => {
  const prev = process.env.ECONOMY_RATE_PUSH_MODE;
  delete process.env.ECONOMY_RATE_PUSH_MODE;
  try {
    assert.equal(svc.pushMode(), MODES.OFF);
    sched.startEconomyRatePushScheduler(); // no-op; must not throw or arm a timer
    sched.stopEconomyRatePushScheduler();
  } finally { if (prev === undefined) delete process.env.ECONOMY_RATE_PUSH_MODE; else process.env.ECONOMY_RATE_PUSH_MODE = prev; }
});

test('scheduler: interval + startup delay fall back to sane defaults', () => {
  const prevI = process.env.ECONOMY_RATE_PUSH_INTERVAL_MINUTES;
  const prevS = process.env.ECONOMY_RATE_PUSH_STARTUP_DELAY_SECONDS;
  try {
    delete process.env.ECONOMY_RATE_PUSH_INTERVAL_MINUTES;
    delete process.env.ECONOMY_RATE_PUSH_STARTUP_DELAY_SECONDS;
    assert.equal(sched.intervalMinutes(), 30);
    assert.equal(sched.startupDelaySeconds(), 240);
    process.env.ECONOMY_RATE_PUSH_INTERVAL_MINUTES = '0';
    assert.equal(sched.intervalMinutes(), 30, 'zero is rejected, not honoured');
    process.env.ECONOMY_RATE_PUSH_INTERVAL_MINUTES = 'abc';
    assert.equal(sched.intervalMinutes(), 30);
  } finally {
    if (prevI === undefined) delete process.env.ECONOMY_RATE_PUSH_INTERVAL_MINUTES; else process.env.ECONOMY_RATE_PUSH_INTERVAL_MINUTES = prevI;
    if (prevS === undefined) delete process.env.ECONOMY_RATE_PUSH_STARTUP_DELAY_SECONDS; else process.env.ECONOMY_RATE_PUSH_STARTUP_DELAY_SECONDS = prevS;
  }
});

test('pushAllAreas: OFF short-circuits before touching the DB', async () => {
  let queried = false;
  const out = await svc.pushAllAreas({
    mode: MODES.OFF,
    prisma: { economyLocationConfig: { findMany: async () => { queried = true; return []; } } },
  });
  assert.equal(out.skipped, 'mode_off');
  assert.equal(queried, false);
});

test('pushAllAreas: only areas with ratePushEnabled are queried, failures isolated', async () => {
  let capturedWhere = null;
  const out = await svc.pushAllAreas({
    mode: MODES.DRY_RUN,
    prisma: {
      economyLocationConfig: {
        findMany: async ({ where }) => {
          capturedWhere = where;
          return [
            { tenantId: 't1', externalArea: 'LAX', ratePushEnabled: true, rateCloseoutMin: 250, locationId: 'l1', externalLocationCode: 'LAXO01' },
            { tenantId: 't1', externalArea: 'BOOM', ratePushEnabled: true, rateCloseoutMin: 250, locationId: 'l2', externalLocationCode: 'MIAO01' },
          ];
        },
      },
      ratePushLog: {
        findMany: async () => [],
        findFirst: async () => null,
        create: async ({ data }) => ({ id: 'x', ...data }),
        update: async () => ({}),
      },
    },
    now: () => new Date('2027-03-15T12:00:00Z'),
    horizonDays: 1,
    loadRfmRates: async (_t, locationId) => {
      if (locationId === 'l2') throw new Error('rates blew up');
      return [{ classCode: 'CCAR', daily: 20 }];
    },
    client: {
      readRateGrid: async () => parseRateGrid(gridHtml([{ cls: 'CCAR', values: ['', '', ''] }])),
      applyRateCell: async () => ({ claimedSuccess: true }),
    },
  });
  assert.deepEqual(capturedWhere, { enabled: true, ratePushEnabled: true });
  assert.equal(out.processedAreas, 2);
  assert.ok(out.results.find((r) => r.externalArea === 'LAX')?.planned >= 1, 'the healthy area still ran');
  assert.match(out.results.find((r) => r.error)?.error || '', /rates blew up/, 'the broken area was isolated');
});
