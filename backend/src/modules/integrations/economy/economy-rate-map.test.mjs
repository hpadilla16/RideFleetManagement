/**
 * Outbound rate-push mapping + guardrails (2026-07-28). PURE — no DB, no
 * network. These tests pin the MONEY decisions: what we publish into a
 * franchise's live pricing system and, more importantly, what we refuse to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapClassCode, toAmount, isCloseout, decideCell, buildPushPlan, verifyPush, SKIP,
} from './economy-rate-map.js';

const LAX_PORTAL_CLASSES = ['CCAR', 'ECAR', 'FCAR', 'FFAR', 'ICAR', 'IFAR', 'MVAR', 'SCAR', 'XXAR'];
const CLOSEOUT = 250;

// ---------------------------------------------------------------------------
// Class mapping
// ---------------------------------------------------------------------------
test('mapClassCode: identity by default, case-insensitive', () => {
  assert.equal(mapClassCode('ccar'), 'CCAR');
  assert.equal(mapClassCode(' IFAR '), 'IFAR');
  assert.equal(mapClassCode(''), null);
  assert.equal(mapClassCode(null), null);
});

test('mapClassCode: overrides win; classes the portal lacks map to null', () => {
  assert.equal(mapClassCode('CFAR', { overrides: { CFAR: 'FCAR' }, portalClasses: LAX_PORTAL_CLASSES }), 'FCAR');
  // SFAR has no LAX counterpart and no override -> not pushable.
  assert.equal(mapClassCode('SFAR', { portalClasses: LAX_PORTAL_CLASSES }), null);
  assert.equal(mapClassCode('CCAR', { portalClasses: LAX_PORTAL_CLASSES }), 'CCAR');
});

// ---------------------------------------------------------------------------
// Money parsing + close-out detection
// ---------------------------------------------------------------------------
test('toAmount: parses portal strings, refuses garbage, keeps 2dp', () => {
  assert.equal(toAmount('250.00'), 250);
  assert.equal(toAmount('$43.67'), 43.67);
  assert.equal(toAmount(20), 20);
  assert.equal(toAmount(''), null);
  assert.equal(toAmount(null), null);
  assert.equal(toAmount('abc'), null);
});

test('isCloseout: at or above the sentinel counts as a deliberate block', () => {
  assert.equal(isCloseout('250.00', CLOSEOUT), true);
  assert.equal(isCloseout('999.00', CLOSEOUT), true);
  assert.equal(isCloseout('249.99', CLOSEOUT), false);
  assert.equal(isCloseout('', CLOSEOUT), false);   // unset is not a close-out
  assert.equal(isCloseout('250.00', null), false); // no sentinel declared
});

// ---------------------------------------------------------------------------
// The single-cell decision — the money guardrails
// ---------------------------------------------------------------------------
test('GUARDRAIL: a close-out is NEVER overwritten (would re-open blocked days)', () => {
  const d = decideCell({ rfmValue: 20, portalValue: '250.00', closeoutMin: CLOSEOUT });
  assert.equal(d.push, false);
  assert.equal(d.reason, SKIP.CLOSEOUT_PRESERVED);
});

test('GUARDRAIL: no sentinel declared -> the location may not push at all', () => {
  const d = decideCell({ rfmValue: 20, portalValue: '11.00', closeoutMin: null });
  assert.equal(d.push, false);
  assert.equal(d.reason, SKIP.NO_SENTINEL);
});

test('GUARDRAIL: never publish 0, negative, or missing prices', () => {
  for (const bad of [0, -5, null, '', 'abc']) {
    const d = decideCell({ rfmValue: bad, portalValue: '11.00', closeoutMin: CLOSEOUT });
    assert.equal(d.push, false, `expected refusal for ${JSON.stringify(bad)}`);
    assert.equal(d.reason, SKIP.INVALID_VALUE);
  }
});

test('GUARDRAIL: a push may never itself create a close-out', () => {
  const d = decideCell({ rfmValue: 250, portalValue: '11.00', closeoutMin: CLOSEOUT });
  assert.equal(d.push, false);
  assert.equal(d.reason, SKIP.OUT_OF_BAND);
});

test('GUARDRAIL: swings beyond the band are held against an EXISTING price', () => {
  // 11.00 -> 20.00 is +81%, beyond the 60% default.
  const held = decideCell({ rfmValue: 20, portalValue: '11.00', closeoutMin: CLOSEOUT });
  assert.equal(held.push, false);
  assert.equal(held.reason, SKIP.OUT_OF_BAND);
  // Same move is allowed with a wider band.
  const allowed = decideCell({ rfmValue: 20, portalValue: '11.00', closeoutMin: CLOSEOUT, maxDeltaPct: 100 });
  assert.equal(allowed.push, true);
  assert.equal(allowed.value, 20);
});

test('an UNSET cell has no baseline, so the band cannot block a first publish', () => {
  const d = decideCell({ rfmValue: 20, portalValue: '', closeoutMin: CLOSEOUT });
  assert.equal(d.push, true);
  assert.equal(d.value, 20);
});

test('an already-correct cell is skipped (no wasted write, no audit churn)', () => {
  const d = decideCell({ rfmValue: 22, portalValue: '22.00', closeoutMin: CLOSEOUT });
  assert.equal(d.push, false);
  assert.equal(d.reason, SKIP.NO_CHANGE);
});

test('a normal in-band correction pushes', () => {
  const d = decideCell({ rfmValue: 22, portalValue: '20.00', closeoutMin: CLOSEOUT });
  assert.deepEqual(d, { push: true, value: 22, reason: null });
});

// ---------------------------------------------------------------------------
// Whole-location plan — modelled on the REAL LAX data (2026-07-28 recon)
// ---------------------------------------------------------------------------
test('buildPushPlan: real LAX shape — maps 5, flags RFM-only and portal-only gaps', () => {
  const rfmRates = [
    { classCode: 'CCAR', daily: 20.00, rateItemId: 'ri-ccar' },
    { classCode: 'ECAR', daily: 20.00, rateItemId: 'ri-ecar' },
    { classCode: 'ICAR', daily: 22.00, rateItemId: 'ri-icar' },
    { classCode: 'IFAR', daily: 32.67, rateItemId: 'ri-ifar' },
    { classCode: 'FFAR', daily: 68.67, rateItemId: 'ri-ffar' },
    { classCode: 'CFAR', daily: 43.67, rateItemId: 'ri-cfar' }, // no LAX counterpart
    { classCode: 'SFAR', daily: 57.33, rateItemId: 'ri-sfar' }, // no LAX counterpart
  ];
  const dates = ['2027-03-15'];
  const portalGrid = { CCAR: { '2027-03-15': '' } }; // everything else unset

  const { pushes, skips } = buildPushPlan({
    rfmRates, dates, portalGrid, portalClasses: LAX_PORTAL_CLASSES, closeoutMin: CLOSEOUT,
  });

  assert.equal(pushes.length, 5, 'the 5 classes that exist on both sides');
  assert.deepEqual(pushes.map((p) => p.classCode).sort(), ['CCAR', 'ECAR', 'FFAR', 'ICAR', 'IFAR']);
  assert.equal(pushes.find((p) => p.classCode === 'CCAR').pushedValue, 20);
  assert.equal(pushes.find((p) => p.classCode === 'CCAR').sourceRateItemId, 'ri-ccar');

  const noMap = skips.filter((s) => s.reason === SKIP.NO_CLASS_MAP).map((s) => s.classCode).sort();
  assert.deepEqual(noMap, ['CFAR', 'SFAR'], 'RFM classes the portal does not offer');

  const noRate = skips.filter((s) => s.reason === SKIP.NO_RFM_RATE).map((s) => s.classCode).sort();
  assert.deepEqual(noRate, ['FCAR', 'MVAR', 'SCAR', 'XXAR'], 'portal classes we hold no rate for');
});

test('buildPushPlan: close-out days are carved out per DATE, not per class', () => {
  const { pushes, skips } = buildPushPlan({
    rfmRates: [{ classCode: 'CCAR', daily: 20 }],
    dates: ['2026-08-01', '2026-08-02', '2026-08-03'],
    portalGrid: { CCAR: { '2026-08-01': '', '2026-08-02': '250.00', '2026-08-03': '20.00' } },
    portalClasses: ['CCAR'],
    closeoutMin: CLOSEOUT,
  });
  assert.deepEqual(pushes.map((p) => p.rateDate), ['2026-08-01'], 'only the unset day is published');
  const byReason = Object.fromEntries(skips.map((s) => [s.rateDate, s.reason]));
  assert.equal(byReason['2026-08-02'], SKIP.CLOSEOUT_PRESERVED);
  assert.equal(byReason['2026-08-03'], SKIP.NO_CHANGE);
});

test('buildPushPlan: CFAR becomes pushable once an alias is configured', () => {
  const { pushes } = buildPushPlan({
    rfmRates: [{ classCode: 'CFAR', daily: 43.67 }],
    dates: ['2027-03-15'],
    portalGrid: {},
    portalClasses: LAX_PORTAL_CLASSES,
    classOverrides: { CFAR: 'FCAR' },
    closeoutMin: CLOSEOUT,
  });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].classCode, 'FCAR');
  assert.equal(pushes[0].rfmClassCode, 'CFAR');
});

// ---------------------------------------------------------------------------
// Verification — ApplyRates lies, so only the read-back counts
// ---------------------------------------------------------------------------
test('verifyPush: read-back is the only proof (ApplyRates fakes success)', () => {
  assert.deepEqual(verifyPush({ pushedValue: 20, readBackValue: '20.00' }), { status: 'VERIFIED', verifiedValue: 20 });
  // The live 2026-07-28 canary: portal answered success but kept the old value.
  assert.deepEqual(verifyPush({ pushedValue: 20, readBackValue: '33.33' }), { status: 'MISMATCH', verifiedValue: 33.33 });
  // Value silently dropped entirely.
  assert.deepEqual(verifyPush({ pushedValue: 20, readBackValue: '' }), { status: 'MISMATCH', verifiedValue: null });
});
