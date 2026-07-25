/**
 * Unit tests for the local vs non-local renter deposit rules (2026-07-25).
 * MONEY: these pin the LAX contract semantics — CA licence OR CA resident →
 * $2,000 / 150 mi/day; everyone else → $1,000 / unlimited; unknown renter →
 * LOCAL (the conservative, higher-deposit tier). And the loud-failure rule:
 * a malformed depositRules blob must make the whole rule inert (standard
 * deposit config applies), never half-apply.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDepositRules,
  classifyRenterLocality,
  evaluateDepositRule,
  parseDepositRuleDecision,
  decideIncludedMilesPerDay,
  normalizeStateCode,
  UNLIMITED_MILES
} from './deposit-rules.js';

const LAX_RULES = {
  depositRules: {
    localStates: ['CA'],
    local: { securityDeposit: 2000, milesPerDay: 150 },
    nonLocal: { securityDeposit: 1000, unlimitedMileage: true }
  }
};

describe('parseDepositRules', () => {
  it('normalizes a valid config', () => {
    const rules = parseDepositRules(LAX_RULES, { locationId: 'loc-lax' });
    assert.deepEqual(rules.localStates, ['CA']);
    assert.equal(rules.local.securityDeposit, 2000);
    assert.equal(rules.local.milesPerDay, 150);
    assert.equal(rules.nonLocal.securityDeposit, 1000);
    assert.equal(rules.nonLocal.unlimitedMileage, true);
  });

  it('absent config is null and NOT an error', () => {
    assert.equal(parseDepositRules({}, {}), null);
    assert.equal(parseDepositRules(null, {}), null);
    assert.equal(parseDepositRules({ securityDepositAmount: 500 }, {}), null);
  });

  it('malformed config makes the WHOLE rule inert (money must not half-parse)', () => {
    const bad = [
      { depositRules: 'nope' },
      { depositRules: [] },
      { depositRules: { localStates: [], local: LAX_RULES.depositRules.local, nonLocal: LAX_RULES.depositRules.nonLocal } },
      { depositRules: { localStates: 'CA', local: LAX_RULES.depositRules.local, nonLocal: LAX_RULES.depositRules.nonLocal } },
      // missing nonLocal tier
      { depositRules: { localStates: ['CA'], local: LAX_RULES.depositRules.local } },
      // negative deposit
      { depositRules: { localStates: ['CA'], local: { securityDeposit: -5 }, nonLocal: { securityDeposit: 1000 } } },
      // non-numeric deposit
      { depositRules: { localStates: ['CA'], local: { securityDeposit: 'lots' }, nonLocal: { securityDeposit: 1000 } } },
      // contradictory mileage
      { depositRules: { localStates: ['CA'], local: { securityDeposit: 2000, milesPerDay: 150, unlimitedMileage: true }, nonLocal: { securityDeposit: 1000 } } },
      // unknown keys are a config typo waiting to silently change money
      { depositRules: { localStates: ['CA'], local: { securityDeposit: 2000 }, nonLocal: { securityDeposit: 1000 }, extra: 1 } },
      { depositRules: { localStates: ['CA'], local: { securityDeposit: 2000, deposit: 99 }, nonLocal: { securityDeposit: 1000 } } }
    ];
    for (const cfg of bad) {
      assert.equal(parseDepositRules(cfg, { locationId: 'loc-x' }), null, JSON.stringify(cfg));
    }
  });

  it('a zero deposit tier is valid (a location may waive one side)', () => {
    const rules = parseDepositRules({
      depositRules: { localStates: ['CA'], local: { securityDeposit: 2000 }, nonLocal: { securityDeposit: 0 } }
    }, {});
    assert.equal(rules.nonLocal.securityDeposit, 0);
  });
});

describe('normalizeStateCode / classifyRenterLocality', () => {
  it('normalizes full state names — the portal captures free text', () => {
    assert.equal(normalizeStateCode('California'), 'CA');
    assert.equal(normalizeStateCode(' california  '), 'CA');
    assert.equal(normalizeStateCode('ca'), 'CA');
    assert.equal(normalizeStateCode('Puerto Rico'), 'PR');
    assert.equal(normalizeStateCode(''), '');
    assert.equal(normalizeStateCode(null), '');
  });

  it('placeholder junk is EMPTY (must fall to UNKNOWN → LOCAL, never the lower tier)', () => {
    for (const junk of ['N/A', 'n/a', 'NA', 'N.A.', 'none', 'NULL', 'unknown', '-', '--', '?', 'X', 'XX', 'TBD']) {
      assert.equal(normalizeStateCode(junk), '', junk);
    }
    // Junk licence + no address → LOCAL/UNKNOWN, the conservative tier.
    assert.deepEqual(classifyRenterLocality({ licenseState: 'N/A' }, ['CA']),
      { locality: 'LOCAL', basis: 'UNKNOWN' });
  });

  it('common CA abbreviations do not misclassify a real local as non-local', () => {
    assert.equal(normalizeStateCode('Calif.'), 'CA');
    assert.equal(normalizeStateCode('CALIF'), 'CA');
    assert.equal(normalizeStateCode('Cali'), 'CA');
    // 'ND' stays North Dakota, not a placeholder.
    assert.deepEqual(classifyRenterLocality({ licenseState: 'ND' }, ['CA']),
      { locality: 'NON_LOCAL', basis: 'LICENSE' });
  });

  it('CA licence → LOCAL by licence', () => {
    assert.deepEqual(classifyRenterLocality({ licenseState: 'CA' }, ['CA']),
      { locality: 'LOCAL', basis: 'LICENSE' });
    assert.deepEqual(classifyRenterLocality({ licenseState: 'California' }, ['CA']),
      { locality: 'LOCAL', basis: 'LICENSE' });
  });

  it('out-of-state licence → NON_LOCAL, even if the address is local (licence wins)', () => {
    assert.deepEqual(classifyRenterLocality({ licenseState: 'FL', addressState: 'CA' }, ['CA']),
      { locality: 'NON_LOCAL', basis: 'LICENSE' });
  });

  it('foreign licence text that maps to no US state → NON_LOCAL', () => {
    assert.deepEqual(classifyRenterLocality({ licenseState: 'Ontario' }, ['CA']),
      { locality: 'NON_LOCAL', basis: 'LICENSE' });
  });

  it('no licence but a CA address → LOCAL by address (contract: "or CA resident")', () => {
    assert.deepEqual(classifyRenterLocality({ licenseState: '', addressState: 'CA' }, ['CA']),
      { locality: 'LOCAL', basis: 'ADDRESS' });
  });

  it('nothing known → LOCAL (conservative: higher deposit, capped miles)', () => {
    assert.deepEqual(classifyRenterLocality({}, ['CA']),
      { locality: 'LOCAL', basis: 'UNKNOWN' });
  });
});

describe('evaluateDepositRule — the LAX contract end to end', () => {
  const rules = parseDepositRules(LAX_RULES, {});

  it('local renter: $2,000 and 150 mi/day', () => {
    const d = evaluateDepositRule({ rules, renter: { licenseState: 'CA' } });
    assert.equal(d.locality, 'LOCAL');
    assert.equal(d.securityDepositAmount, 2000);
    assert.equal(d.milesPerDay, 150);
    assert.equal(d.unlimitedMileage, false);
  });

  it('non-local renter: $1,000 and unlimited mileage', () => {
    const d = evaluateDepositRule({ rules, renter: { licenseState: 'TX' } });
    assert.equal(d.locality, 'NON_LOCAL');
    assert.equal(d.securityDepositAmount, 1000);
    assert.equal(d.milesPerDay, null);
    assert.equal(d.unlimitedMileage, true);
  });

  it('unknown renter gets the LOCAL tier', () => {
    const d = evaluateDepositRule({ rules, renter: {} });
    assert.equal(d.basis, 'UNKNOWN');
    assert.equal(d.securityDepositAmount, 2000);
  });

  it('null rules → null (no decision, standard config applies)', () => {
    assert.equal(evaluateDepositRule({ rules: null, renter: { licenseState: 'CA' } }), null);
  });

  it('the decision survives the JSON freeze/thaw round trip the snapshot does', () => {
    const d = evaluateDepositRule({ rules, renter: { licenseState: 'NV' } });
    const thawed = parseDepositRuleDecision(JSON.stringify({ ...d, evaluatedAt: '2026-07-25T00:00:00.000Z' }));
    assert.equal(thawed.locality, 'NON_LOCAL');
    assert.equal(thawed.securityDepositAmount, 1000);
    assert.equal(decideIncludedMilesPerDay({ decision: thawed }), UNLIMITED_MILES);
  });
});

describe('decideIncludedMilesPerDay + parseDepositRuleDecision', () => {
  it('unlimited → Infinity sentinel', () => {
    assert.equal(decideIncludedMilesPerDay({ decision: { unlimitedMileage: true } }), Infinity);
  });

  it('capped → the cap', () => {
    assert.equal(decideIncludedMilesPerDay({ decision: { milesPerDay: 150 } }), 150);
  });

  it('no mileage info → null (caller falls back to vehicle type / 200)', () => {
    assert.equal(decideIncludedMilesPerDay({ decision: {} }), null);
    assert.equal(decideIncludedMilesPerDay({ decision: null }), null);
    assert.equal(decideIncludedMilesPerDay({ decision: { milesPerDay: 0 } }), null);
  });

  it('garbage snapshot JSON parses to null, never throws', () => {
    assert.equal(parseDepositRuleDecision('not json'), null);
    assert.equal(parseDepositRuleDecision('"a string"'), null);
    assert.equal(parseDepositRuleDecision(null), null);
    assert.equal(parseDepositRuleDecision(''), null);
  });
});
