/**
 * Per-branch overrides for the acknowledgement sections the customer initials
 * (2026-07-24). Pure — no DB, no Prisma.
 *
 * WHY THIS EXISTS. These sections were hardcoded, and they are not decoration:
 * the customer initials each one on their phone or at the kiosk, and the same
 * text is then re-printed inside the agreement PDF beside the captured initial
 * image. Corpusa's LAX runs on Rightcars' California policies — a deposit of up
 * to $2,000 for California licence holders and 150 miles/day — while
 * `deposit_post_charges` said "$500". Loading LAX's rider without this would have
 * produced ONE signed PDF asserting $2,000 in the body and $500 on the page
 * carrying the renter's own initials.
 *
 * THE INVARIANT PINNED HERE: overrides replace TEXT ONLY, never the key set.
 * `sectionKey` is persisted to AgreementSectionInitial and re-matched when the
 * PDF re-prints, so a branch-specific key would orphan initials a customer has
 * already signed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TC_SECTIONS,
  DECLINED_INSURANCE_SECTION,
  sectionsForAgreement,
  parseSectionOverrides,
} from './terms-content.js';
import logger from '../../lib/logger.js';

const LAX_DEPOSIT = 'I authorize a security deposit hold on my credit card of up to $1,000.00. '
  + 'If I hold a California licence or am a California resident, the hold is up to $2,000.00.';

describe('parseSectionOverrides', () => {
  it('accepts a JSON string, an object, and the bare-string shorthand', () => {
    assert.deepEqual(
      parseSectionOverrides('{"deposit_post_charges":{"body":"x"}}'),
      { deposit_post_charges: { body: 'x' } },
    );
    assert.deepEqual(
      parseSectionOverrides({ deposit_post_charges: { body: 'x' } }),
      { deposit_post_charges: { body: 'x' } },
    );
    assert.deepEqual(
      parseSectionOverrides({ deposit_post_charges: 'x' }),
      { deposit_post_charges: { body: 'x' } },
      'a bare string is shorthand for { body }',
    );
  });

  it('is tolerant of garbage — a bad blob must not strand a customer mid-signing', () => {
    for (const bad of [null, undefined, '', '   ', 'not json', '[]', '42', [], 0]) {
      assert.deepEqual(parseSectionOverrides(bad), {}, `${JSON.stringify(bad)} → {}`);
    }
  });

  it('drops empty and non-string values instead of blanking a section', () => {
    // An override that blanked a body would silently remove an acknowledgement
    // the customer is supposed to read.
    assert.deepEqual(parseSectionOverrides({ a: { body: '   ' } }), {});
    assert.deepEqual(parseSectionOverrides({ a: { body: 42 } }), {});
    assert.deepEqual(parseSectionOverrides({ a: {} }), {});
    assert.deepEqual(parseSectionOverrides({ a: null }), {});
  });
});

describe('sectionsForAgreement — per-branch overrides', () => {
  it('CARE 1: no overrides returns the canonical text, unchanged', () => {
    const out = sectionsForAgreement({});
    assert.deepEqual(out.map((s) => s.key), TC_SECTIONS.map((s) => s.key));
    assert.deepEqual(out.map((s) => s.body), TC_SECTIONS.map((s) => s.body));
  });

  it('CARE 2: an override replaces the body of the keyed section only — the LAX case', () => {
    const out = sectionsForAgreement({
      sectionOverrides: { deposit_post_charges: { body: LAX_DEPOSIT } },
    });
    const deposit = out.find((s) => s.key === 'deposit_post_charges');
    assert.equal(deposit.body, LAX_DEPOSIT);
    assert.ok(!deposit.body.includes('$500'), 'the $500 that contradicted the branch body is gone');
    assert.equal(deposit.label, 'Deposit and post-rental charges', 'label untouched when not overridden');
    // Every other section is byte-identical.
    for (const s of out) {
      if (s.key === 'deposit_post_charges') continue;
      const canonical = [...TC_SECTIONS, DECLINED_INSURANCE_SECTION].find((c) => c.key === s.key);
      assert.equal(s.body, canonical.body, `${s.key} must not be touched`);
    }
  });

  it('CARE 3: THE INVARIANT — overrides can never change the key set', () => {
    const out = sectionsForAgreement({
      sectionOverrides: {
        deposit_post_charges: { body: 'a' },
        // An override that tried to smuggle a key in must be ignored...
        a_branch_only_section: { body: 'should not appear' },
        // ...and one that tried to rewrite `key` must not be able to.
        mileage_fuel: { body: 'b', key: 'renamed_key', label: 'Mileage (LAX)' },
      },
    });
    assert.deepEqual(
      out.map((s) => s.key),
      TC_SECTIONS.map((s) => s.key),
      'the key set is exactly canonical — AgreementSectionInitial rows stay matched',
    );
    assert.ok(!out.some((s) => s.body === 'should not appear'), 'unknown keys are ignored');
    const mileage = out.find((s) => s.key === 'mileage_fuel');
    assert.equal(mileage.body, 'b');
    assert.equal(mileage.label, 'Mileage (LAX)', 'label CAN be overridden');
    assert.equal(mileage.key, 'mileage_fuel', 'but key survives a hostile override');
  });

  it('CARE 4: overrides compose with the declined-insurance addendum', () => {
    const out = sectionsForAgreement({
      declinedInsurance: true,
      sectionOverrides: { declined_insurance: { body: 'LAX decline wording.' } },
    });
    const keys = out.map((s) => s.key);
    assert.ok(keys.includes('declined_insurance'), 'the addendum is still injected');
    assert.equal(keys.indexOf('declined_insurance'), keys.indexOf('insurance_coverage') + 1,
      'and still sits right after insurance_coverage');
    assert.equal(out.find((s) => s.key === 'declined_insurance').body, 'LAX decline wording.');
  });

  it('CARE 5: a JSON string works — that is what the DB column actually holds', () => {
    const out = sectionsForAgreement({
      sectionOverrides: JSON.stringify({ mileage_fuel: 'Unlimited for non-local licences; 150 mi/day otherwise.' }),
    });
    assert.equal(out.find((s) => s.key === 'mileage_fuel').body,
      'Unlimited for non-local licences; 150 mi/day otherwise.');
  });

  it('CARE 6: the canonical constants are not mutated — overrides must not leak between branches', () => {
    const before = TC_SECTIONS.find((s) => s.key === 'deposit_post_charges').body;
    sectionsForAgreement({ sectionOverrides: { deposit_post_charges: { body: LAX_DEPOSIT } } });
    const after = TC_SECTIONS.find((s) => s.key === 'deposit_post_charges').body;
    assert.equal(after, before, 'a LAX rental must not rewrite the text an Orlando rental then reads');
    // And the very next call with no overrides must be clean.
    const clean = sectionsForAgreement({});
    assert.equal(clean.find((s) => s.key === 'deposit_post_charges').body, before);
  });
});

// ── Bad config must be LOUD, not silent (QA M4, 2026-07-24) ─────────────────
//
// There is no admin UI for Location.termsSectionsJson and
// PATCH /api/locations/:id validates nothing, so a truncated blob or a typo'd
// key would otherwise leave every renter at that branch signing the CANONICAL
// text while ops believes the branch wording is live. The resolver in
// lib/terms/index.js already refuses to swallow its lookup failure for exactly
// this reason; this is the same principle one layer down.
describe('parseSectionOverrides — logs instead of failing silently', () => {
  function capture(fn) {
    const errors = [];
    const orig = logger.error;
    logger.error = (msg, meta) => errors.push({ msg, meta });
    try { fn(); } finally { logger.error = orig; }
    return errors;
  }

  it('logs when the blob is not valid JSON', () => {
    const errs = capture(() => parseSectionOverrides('{"deposit_post_charges": {"body": "trunc'));
    assert.equal(errs.length, 1, 'exactly one error');
    assert.match(errs[0].msg, /not valid JSON/i);
  });

  it('logs when the blob is the wrong shape', () => {
    for (const bad of ['[]', '42', '"a string"']) {
      const errs = capture(() => parseSectionOverrides(bad));
      assert.equal(errs.length, 1, `${bad} logs`);
      assert.match(errs[0].msg, /keyed by sectionKey/i);
    }
  });

  it('logs the unknown keys — a typo must not vanish', () => {
    const errs = capture(() => parseSectionOverrides({
      deposit_post_chargez: { body: 'typo' },   // note the z
      mileage_fuel: { body: 'fine' },
    }));
    assert.equal(errs.length, 1);
    assert.deepEqual(errs[0].meta.unknownKeys, ['deposit_post_chargez']);
    assert.ok(errs[0].meta.validKeys.includes('deposit_post_charges'), 'the log names the valid keys');
  });

  it('stays SILENT on the happy path and on an absent override', () => {
    for (const ok of [undefined, null, '', '   ', { mileage_fuel: { body: 'x' } }, '{"prohibited_use":"y"}']) {
      assert.equal(capture(() => parseSectionOverrides(ok)).length, 0, `${JSON.stringify(ok)} is quiet`);
    }
  });

  it('an unknown key is dropped, and the known ones still apply', () => {
    const out = capture(() => {
      const sections = sectionsForAgreement({
        sectionOverrides: { nope: { body: 'x' }, mileage_fuel: { body: 'branch mileage' } },
      });
      assert.equal(sections.find((s) => s.key === 'mileage_fuel').body, 'branch mileage');
      assert.equal(sections.length, 6, 'and the key set is untouched');
    });
    assert.equal(out.length, 1, 'while still logging the typo');
  });
});
