/**
 * Shuttle intake — DB-free (Phase 3, 2026-08-25; mockup Screen 7).
 *
 * The rule this suite exists to pin: THE FLAG IS THE CONTRACT. With
 * intakeJson absent/false/garbage, validateIntake must reproduce the
 * pre-Phase-3 endpoint's behavior exactly — VozIA, Valet and every printed
 * QR link call without the new fields, and a deploy must not opt anyone in.
 * Enforcement (required + caps) exists only behind enabled: true.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIntakeConfig, validateIntake, validateIntakeInput,
  PARTY_SIZE_CAP_DEFAULT, BAGS_CAP_DEFAULT, CAP_MIN, CAP_MAX,
} from './shuttle-intake.js';

// ─── parseIntakeConfig ──────────────────────────────────────────────────────

test('defaults: absent/garbage intakeJson = disabled with 50/20 — the fail-safe direction', () => {
  for (const raw of [undefined, null, 'garbage', 42, [], { intakeJson: null }]) {
    const cfg = parseIntakeConfig(typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : { intakeJson: raw });
    assert.deepEqual(cfg, { enabled: false, partySizeCap: PARTY_SIZE_CAP_DEFAULT, bagsCap: BAGS_CAP_DEFAULT });
  }
  assert.equal(PARTY_SIZE_CAP_DEFAULT, 50, 'must match the historical Math.min(50) service clamp');
  assert.equal(BAGS_CAP_DEFAULT, 20);
});

test('enabled is strictly opt-in: only literal true counts', () => {
  assert.equal(parseIntakeConfig({ intakeJson: { enabled: true } }).enabled, true);
  for (const v of ['true', 1, 'yes', {}, []]) {
    assert.equal(parseIntakeConfig({ intakeJson: { enabled: v } }).enabled, false, `enabled=${JSON.stringify(v)}`);
  }
});

test('caps: in-range values stick, out-of-range/garbage fall back to defaults', () => {
  const cfg = parseIntakeConfig({ intakeJson: { enabled: true, partySizeCap: 12, bagsCap: 6 } });
  assert.equal(cfg.partySizeCap, 12);
  assert.equal(cfg.bagsCap, 6);
  for (const bad of [0, CAP_MAX + 1, -3, 2.5, 'lots', null]) {
    const c = parseIntakeConfig({ intakeJson: { enabled: true, partySizeCap: bad, bagsCap: bad } });
    assert.equal(c.partySizeCap, PARTY_SIZE_CAP_DEFAULT, `partySizeCap=${bad}`);
    assert.equal(c.bagsCap, BAGS_CAP_DEFAULT, `bagsCap=${bad}`);
  }
});

// ─── validateIntake, flag OFF — the legacy contract ─────────────────────────

test('FLAG OFF: partySize passes through UNTOUCHED — the service legacy clamp stays the only judge', () => {
  const off = parseIntakeConfig(null);
  // Every historically-possible shape, including the ones the old endpoint
  // tolerated: absent, garbage, huge — all pass through as-is.
  for (const p of [undefined, null, 3, '4', 0, -1, 9999, 'many']) {
    const out = validateIntake({ partySize: p }, off);
    assert.equal(out.ok, true, `partySize=${p} must not fail with the flag off`);
    assert.equal(out.values.partySize, p, 'pass-through, not normalization');
  }
});

test('FLAG OFF: an absent body validates — old callers send nothing new', () => {
  const out = validateIntake({}, parseIntakeConfig(null));
  assert.equal(out.ok, true);
  assert.equal(out.values.partySize, undefined);
  assert.equal(out.values.bags, null);
});

test('FLAG OFF: bags stores only when incidentally valid, silently drops otherwise', () => {
  const off = parseIntakeConfig(null);
  assert.equal(validateIntake({ bags: 4 }, off).values.bags, 4);
  assert.equal(validateIntake({ bags: 0 }, off).values.bags, 0);
  // Garbage/hostile values NEVER fail an old-contract call — they drop.
  for (const b of [-1, 1e9, 'many', 2.5, null, undefined]) {
    const out = validateIntake({ bags: b }, off);
    assert.equal(out.ok, true, `bags=${b}`);
    assert.equal(out.values.bags, null, `bags=${b} must drop, not store`);
  }
});

// ─── validateIntake, flag ON — Screen 7 required + caps ─────────────────────

test('FLAG ON: party and bags are REQUIRED integers within the caps', () => {
  const on = parseIntakeConfig({ intakeJson: { enabled: true } });
  const ok = validateIntake({ partySize: 3, bags: 4 }, on);
  assert.deepEqual(ok, { ok: true, values: { partySize: 3, bags: 4 } });
  // Boundary values are legal: 1 person no bags, and exactly the caps.
  assert.equal(validateIntake({ partySize: 1, bags: 0 }, on).ok, true);
  assert.equal(validateIntake({ partySize: 50, bags: 20 }, on).ok, true);
});

test('FLAG ON: refusals — absent, zero party, over-cap, non-integers', () => {
  const on = parseIntakeConfig({ intakeJson: { enabled: true } });
  for (const body of [
    {}, { partySize: 3 }, { bags: 2 }, // missing halves
    { partySize: 0, bags: 1 }, { partySize: 51, bags: 1 },
    { partySize: 2, bags: -1 }, { partySize: 2, bags: 21 },
    { partySize: 2.5, bags: 1 }, { partySize: 2, bags: 'many' },
  ]) {
    const out = validateIntake(body, on);
    assert.equal(out.ok, false, JSON.stringify(body));
    assert.equal(typeof out.error, 'string');
  }
});

test('FLAG ON: the sede\'s own caps bind, and the error names the range', () => {
  const on = parseIntakeConfig({ intakeJson: { enabled: true, partySizeCap: 8, bagsCap: 5 } });
  assert.equal(validateIntake({ partySize: 8, bags: 5 }, on).ok, true);
  const party = validateIntake({ partySize: 9, bags: 2 }, on);
  assert.equal(party.ok, false);
  assert.match(party.error, /1\.\.8/);
  const bags = validateIntake({ partySize: 2, bags: 6 }, on);
  assert.equal(bags.ok, false);
  assert.match(bags.error, /0\.\.5/);
});

// ─── validateIntakeInput (the Settings PUT) ─────────────────────────────────

test('settings input: null clears, valid objects normalize, junk refuses', () => {
  assert.deepEqual(validateIntakeInput(null), { ok: true, intake: null });
  assert.deepEqual(
    validateIntakeInput({ enabled: true, partySizeCap: 10, bagsCap: 4 }),
    { ok: true, intake: { enabled: true, partySizeCap: 10, bagsCap: 4 } },
  );
  // Absent caps take the defaults; enabled anything-but-true is false.
  assert.deepEqual(
    validateIntakeInput({ enabled: 'yes' }),
    { ok: true, intake: { enabled: false, partySizeCap: PARTY_SIZE_CAP_DEFAULT, bagsCap: BAGS_CAP_DEFAULT } },
  );
  for (const bad of [[], 'on', { partySizeCap: 0 }, { bagsCap: CAP_MAX + 1 }, { partySizeCap: 2.5 }]) {
    assert.equal(validateIntakeInput(bad).ok, false, JSON.stringify(bad));
  }
});
