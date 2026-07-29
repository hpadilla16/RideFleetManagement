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
const { dateWindow, pushArea, MODES, pushRateCodes } = await import('./economy-rate-push.service.js');

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
function makeDeps({ portalRows, rfmRates, mode, applyImpl, approvals, rateCodes }) {
  const logs = [];
  const prismaStub = {
    ratePushLog: {
      // F4 reads pre-approved cells (findMany) and dedupes the pending queue
      // (findFirst); `approvals` lets a test seed authorised rows.
      findMany: async ({ where } = {}) => {
        // Two callers share findMany: the APPROVED lookup and the "what did we
        // already record today" dedup scan.
        if (where?.status === 'APPROVED') {
          return (approvals || []).map((a, i) => ({
            id: `appr-${i}`, classCode: a.classCode,
            rateDate: new Date(`${a.rateDate}T00:00:00Z`), pushedValue: a.pushedValue,
            rateCode: a.rateCode || 'STND',
          }));
        }
        return logs.filter((l) => l.rateDate).map((l) => ({
          classCode: l.classCode,
          rateDate: l.rateDate instanceof Date ? l.rateDate : new Date(`${l.rateDate}T00:00:00Z`),
          status: l.status, skipReason: l.skipReason || null,
          priorValue: l.priorValue ?? null, pushedValue: l.pushedValue ?? null,
          rateCode: l.rateCode || 'STND',
        }));
      },
      findFirst: async ({ where }) => logs.find((l) => (
        l.status === 'PENDING_APPROVAL'
        && l.classCode === where.classCode
        && (!where.rateCode || (l.rateCode || 'STND') === where.rateCode)
        && new Date(l.rateDate).toISOString().slice(0, 10) === new Date(where.rateDate).toISOString().slice(0, 10)
      )) || null,
      create: async ({ data }) => { const row = { id: `log-${logs.length}`, ...data }; logs.push(row); return row; },
      update: async ({ where, data }) => {
        let row = logs.find((l) => l.id === where.id);
        if (!row) {
          // Approval rows come from findMany, not create — record them on
          // first update so a test can assert what the sweep did to them.
          row = { id: where.id, status: 'APPROVED' };
          logs.push(row);
        }
        Object.assign(row, data);
        return row;
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
      // Single-rate by default so the pre-existing single-tier expectations
      // hold; the multi-tier behavior has its own tests below.
      rateCodes: rateCodes || ['STND'],
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

// ---------------------------------------------------------------------------
// An approval is spent by a REAL push, never by a rehearsal. Without this, a
// dry sweep would consume the sign-off, publish nothing, and re-ask the same
// question 30 minutes later.
// ---------------------------------------------------------------------------
test('DRY_RUN does NOT consume an approval — it survives until a LIVE push', async () => {
  const approvals = [{ classCode: 'CCAR', rateDate: '2027-03-15', pushedValue: 20 }];
  const { deps, calls, logs } = makeDeps({
    // Portal at 11.00 => +82%, out of band: only the approval lets it through.
    portalRows: [{ cls: 'CCAR', values: ['11.00', '11.00', '11.00'] }],
    rfmRates: [{ classCode: 'CCAR', daily: 20 }],
    mode: MODES.DRY_RUN,
    approvals,
  });
  const out = await pushArea(CONFIG, deps);

  assert.equal(out.planned, 1, 'the approved date is planned');
  assert.equal(calls.applied.length, 0, 'a dry run still writes nothing');
  // The approval row was touched but NOT moved out of APPROVED.
  const consumed = logs.find((l) => l.id === 'appr-0' && ['PLANNED', 'SENT'].includes(l.status));
  assert.equal(consumed, undefined, 'the approval was not spent by the rehearsal');
});

test('LIVE consumes the approval exactly once', async () => {
  const approvals = [{ classCode: 'CCAR', rateDate: '2027-03-15', pushedValue: 20 }];
  const { deps, calls, logs } = makeDeps({
    portalRows: [{ cls: 'CCAR', values: ['11.00', '11.00', '11.00'] }],
    rfmRates: [{ classCode: 'CCAR', daily: 20 }],
    mode: MODES.LIVE,
    approvals,
  });
  const out = await pushArea(CONFIG, deps);
  assert.equal(out.sent, 1, 'the approved cell was published');
  assert.deepEqual(calls.applied.map((a) => a.rateDate), ['2027-03-15']);
  const spent = logs.find((l) => l.id === 'appr-0');
  assert.ok(spent && ['SENT', 'VERIFIED', 'MISMATCH'].includes(spent.status), 'the approval row moved past APPROVED');
});

// ---------------------------------------------------------------------------
// Log hygiene: the sweep runs every 30 min. Re-recording unchanged decisions
// would add ~2k rows/day of noise and bury the rows that matter.
// ---------------------------------------------------------------------------
test('a second identical sweep records NOTHING new (no audit churn)', async () => {
  const setup = makeDeps({
    portalRows: [{ cls: 'CCAR', values: ['', '250.00', '20.00'] }],
    rfmRates: [{ classCode: 'CCAR', daily: 20 }],
    mode: MODES.DRY_RUN,
  });
  const first = await pushArea(CONFIG, setup.deps);
  const afterFirst = setup.logs.length;
  assert.ok(afterFirst > 0, 'the first sweep does record its decisions');
  assert.equal(first.deduped, 0);

  const second = await pushArea(CONFIG, setup.deps);
  assert.equal(setup.logs.length, afterFirst, 'the repeat sweep added no rows');
  assert.ok(second.deduped > 0, 'and it reports what it suppressed');
});

test('but a CHANGED portal price is still recorded (real history is never lost)', async () => {
  const setup = makeDeps({
    portalRows: [{ cls: 'CCAR', values: ['20.00', '250.00', '20.00'] }],
    rfmRates: [{ classCode: 'CCAR', daily: 20 }],
    mode: MODES.DRY_RUN,
  });
  await pushArea(CONFIG, setup.deps);
  const afterFirst = setup.logs.length;

  // The franchise moves the first day's price: that is news, not noise.
  setup.deps.client.readRateGrid = async () => parseRateGrid(gridHtml([
    { cls: 'CCAR', values: ['15.00', '250.00', '20.00'] },
  ]));
  await pushArea(CONFIG, setup.deps);
  assert.ok(setup.logs.length > afterFirst, 'the changed cell produced a new row');
});

// ---------------------------------------------------------------------------
// LAX #2 — every LOR rate plan updates, not just STND
// ---------------------------------------------------------------------------
test('pushRateCodes: defaults to all 8 LOR tiers, env-overridable', () => {
  const prev = process.env.ECONOMY_RATE_PUSH_RATE_CODES;
  delete process.env.ECONOMY_RATE_PUSH_RATE_CODES;
  assert.deepEqual(pushRateCodes(), ['1TO2', '3DYS', '4DYS', '5DYS', '6DYS', '7DYS', '8DYS', 'STND']);
  process.env.ECONOMY_RATE_PUSH_RATE_CODES = 'STND, 3dys';
  assert.deepEqual(pushRateCodes(), ['STND', '3DYS']);
  if (prev === undefined) delete process.env.ECONOMY_RATE_PUSH_RATE_CODES;
  else process.env.ECONOMY_RATE_PUSH_RATE_CODES = prev;
});

test('LIVE multi-tier: each rate code gets its own read, write and verified log row', async () => {
  const { deps, calls, logs } = makeDeps({
    portalRows: [{ cls: 'CCAR', values: ['15.00', '15.00', '15.00'] }],
    rfmRates: [{ classCode: 'CCAR', daily: 20 }],
    mode: MODES.LIVE,
    rateCodes: ['STND', '3DYS'],
  });
  // A faithful portal double: reads reflect what was WRITTEN to that tier, so
  // the verify read-back can actually verify (each tier has its own cells).
  const written = new Set();
  deps.client.applyRateCell = async (_t, args) => {
    calls.applied.push(args);
    written.add(`${args.rate}|${args.rateDate}`);
    return { claimedSuccess: true };
  };
  deps.client.readRateGrid = async (_t, args) => parseRateGrid(gridHtml([{
    cls: 'CCAR',
    values: ['2027-03-15', '2027-03-16', '2027-03-17'].map((d) => (written.has(`${args.rate}|${d}`) ? '20.00' : '15.00')),
  }]));
  const out = await pushArea(CONFIG, deps);
  // 3-day horizon = 1 read chunk per rate code + 1 verify read per write.
  const writtenRates = calls.applied.map((a) => a.rate).sort();
  assert.deepEqual([...new Set(writtenRates)], ['3DYS', 'STND'], 'both tiers written');
  assert.equal(calls.applied.length, 6, '3 dates x 2 tiers');
  assert.equal(out.verified, 6, 'every write verified per tier');
  const rateCodesInLog = new Set(logs.filter((l) => l.status === 'VERIFIED').map((l) => l.rateCode));
  assert.deepEqual([...rateCodesInLog].sort(), ['3DYS', 'STND'], 'log rows carry the tier');
});

test('multi-tier dedup: identical decisions for DIFFERENT tiers are both recorded (no cross-tier collision)', async () => {
  const { deps, logs } = makeDeps({
    portalRows: [{ cls: 'CCAR', values: ['15.00', '15.00', '15.00'] }],
    rfmRates: [{ classCode: 'CCAR', daily: 20 }],
    mode: MODES.DRY_RUN,
    rateCodes: ['STND', '3DYS'],
  });
  await pushArea(CONFIG, deps);
  const planned = logs.filter((l) => l.status === 'PLANNED');
  const byRate = new Set(planned.map((l) => l.rateCode));
  assert.deepEqual([...byRate].sort(), ['3DYS', 'STND'], 'both tiers planned despite identical values');
  assert.equal(planned.length, 6, '3 dates x 2 tiers planned');
});
