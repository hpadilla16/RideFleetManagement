/**
 * The configurable contract clause editor (2026-09-04) — pure layer.
 *
 * WHAT THIS PINS, and why each one is load-bearing:
 *
 *  1. The 250 the editor shows is the SAME 250 the terminal sequencer
 *     enforces. If those two numbers could drift, the editor would be telling
 *     admins a comfortable lie about a limit it does not own.
 *  2. A clause over 250 is reported, NOT blocked. A tenant may legitimately
 *     prefer a long clause and the phone flow; silently shortening a legal
 *     instrument is the one thing this editor must never do.
 *  3. Restore-to-standard is ONE action (an absent/null key), and it is
 *     distinguishable from a failed save.
 *  4. An unknown sectionKey is a 400, never a quiet drop — a key outside the
 *     canonical set can never take effect, so silence would hide a typo and
 *     leave an admin believing wording is live that never will be.
 *  5. Audit metadata carries keys and lengths and NEVER the clause text.
 *
 * Pure: no DB. The DB-facing half of locationClausesService is exercised by
 * the route/service tests that have a database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TERMINAL_TITLE_MAX,
  TERMINAL_WARN_AT,
  CLAUSE_MAX_BODY,
  CLAUSE_MAX_LABEL,
  CLAUSE_SCOPE,
  clauseCatalog,
  knownClauseKeys,
  inspectStoredOverrides,
  buildClauseView,
  validateClauseOverrides,
  clauseChangeSummary,
  ClauseValidationError,
} from './location-clauses.service.js';
import {
  USER_CHOICE_TITLE_MAX,
  assertClausesFitTerminal,
  clauseTitle,
} from '../checkout-session/terminal-contract.service.js';
import {
  TC_SECTIONS,
  DECLINED_INSURANCE_SECTION,
  DAMAGE_ACKNOWLEDGEMENT_SECTION,
  sectionsForAgreement,
  parseSectionOverrides,
} from '../checkout-session/terms-content.js';

const LAX_DEPOSIT = 'I authorize a security deposit hold on my credit card of up to $1,000.00. '
  + 'If I hold a California licence or am a California resident, the hold is up to $2,000.00.';

/** Build a body of exactly n characters. */
const bodyOfLength = (n) => 'x'.repeat(n);

describe('the 250 is the terminal\'s, not the editor\'s', () => {
  it('CARE 1: TERMINAL_TITLE_MAX IS the sequencer\'s USER_CHOICE_TITLE_MAX', () => {
    // Not "equals 250" — the same value, imported. A local 250 could be edited
    // here and the editor would keep promising a limit the terminal no longer
    // has (or worse, stop warning about one it still does).
    assert.equal(TERMINAL_TITLE_MAX, USER_CHOICE_TITLE_MAX);
    assert.equal(TERMINAL_TITLE_MAX, 250, 'and today that value is 250');
  });

  it('CARE 2: the boundary the editor draws is the boundary the terminal enforces', () => {
    // Exactly at the cap must PASS on both sides; one over must FAIL on both.
    const at = { key: 'rental_period', label: 'L', body: bodyOfLength(TERMINAL_TITLE_MAX) };
    const over = { key: 'rental_period', label: 'L', body: bodyOfLength(TERMINAL_TITLE_MAX + 1) };

    assert.doesNotThrow(() => assertClausesFitTerminal([at]), 'sequencer accepts exactly 250');
    assert.throws(() => assertClausesFitTerminal([over]), /too long for the terminal/i);

    const viewAt = buildClauseView({ rental_period: { body: at.body } });
    const viewOver = buildClauseView({ rental_period: { body: over.body } });
    assert.equal(viewAt.clauses.find((c) => c.key === 'rental_period').fitsTerminal, true);
    assert.equal(viewOver.clauses.find((c) => c.key === 'rental_period').fitsTerminal, false);
    // `declined_insurance` is canonically 274 and is therefore ALWAYS blocked
    // until a branch overrides it — see CARE 5. Asserting the delta rather than
    // the whole list keeps this test about the boundary and not about that.
    assert.ok(!viewAt.terminal.blockedKeys.includes('rental_period'), 'exactly 250 is not blocked');
    assert.ok(viewOver.terminal.blockedKeys.includes('rental_period'), '251 is blocked');
  });

  it('CARE 3: the length counted is the length SENT — clauseTitle, whitespace and all', () => {
    // The sequencer trims before measuring. An editor that counted the raw
    // textarea value would warn at a different place than the device refuses.
    const padded = `   ${bodyOfLength(TERMINAL_TITLE_MAX)}   `;
    const c = buildClauseView({ mileage_fuel: { body: padded } }).clauses.find((x) => x.key === 'mileage_fuel');
    assert.equal(c.length, TERMINAL_TITLE_MAX, 'surrounding whitespace is not charged to the renter');
    assert.equal(c.length, clauseTitle({ body: padded }).length);
    assert.equal(c.fitsTerminal, true);
  });

  it('CARE 4: the warning band sits BELOW the cap and never overlaps it', () => {
    assert.ok(TERMINAL_WARN_AT < TERMINAL_TITLE_MAX);
    const near = buildClauseView({ prohibited_use: { body: bodyOfLength(TERMINAL_WARN_AT + 1) } })
      .clauses.find((c) => c.key === 'prohibited_use');
    assert.equal(near.nearTerminalLimit, true);
    assert.equal(near.fitsTerminal, true, 'warned, not blocked');

    const under = buildClauseView({ prohibited_use: { body: bodyOfLength(TERMINAL_WARN_AT) } })
      .clauses.find((c) => c.key === 'prohibited_use');
    assert.equal(under.nearTerminalLimit, false);

    const over = buildClauseView({ prohibited_use: { body: bodyOfLength(TERMINAL_TITLE_MAX + 1) } })
      .clauses.find((c) => c.key === 'prohibited_use');
    assert.equal(over.nearTerminalLimit, false, 'past the cap is not "near" it — it is over');
    assert.equal(over.fitsTerminal, false);
  });

  it('CARE 5: the canonical corpus is reported honestly — six fit, declined_insurance does not', () => {
    const view = buildClauseView(null);
    const byKey = Object.fromEntries(view.clauses.map((c) => [c.key, c]));

    for (const s of TC_SECTIONS) {
      assert.equal(byKey[s.key].fitsTerminal, true, `${s.key} fits`);
      assert.equal(byKey[s.key].canonicalOverTerminal, false);
      assert.ok(byKey[s.key].length <= TERMINAL_TITLE_MAX);
    }
    // Measured, not assumed: this is why a declined-insurance checkout cannot
    // be signed on the terminal today, and the editor must SAY so rather than
    // inviting an admin to "fix" a legal text they do not own.
    const declined = byKey.declined_insurance;
    assert.equal(declined.canonicalLength, 274);
    assert.equal(declined.fitsTerminal, false);
    assert.equal(declined.canonicalOverTerminal, true);
    assert.deepEqual(view.terminal.blockedKeys, ['declined_insurance']);
    assert.equal(view.terminal.terminalSigningAvailable, false);
  });

  it('CARE 6: damage_acknowledgement is 353 and is NOT measured against the terminal', () => {
    // It never rides UserChoice — it is signed in the Report Damage wizard. An
    // editor that flagged it would be inventing a consequence that does not
    // exist and pushing an admin to shorten a clause for no reason.
    const c = buildClauseView(null).clauses.find((x) => x.key === 'damage_acknowledgement');
    assert.equal(c.scope, CLAUSE_SCOPE.DAMAGE_REPORT);
    assert.equal(c.ridesTerminal, false);
    assert.equal(c.fitsTerminal, null);
    assert.equal(c.nearTerminalLimit, false);
    assert.ok(c.length > TERMINAL_TITLE_MAX, 'even though it is longer than the cap');
    assert.ok(!buildClauseView(null).terminal.blockedKeys.includes('damage_acknowledgement'));
  });
});

describe('the editor never disagrees with the signing flow', () => {
  it('CARE 7: every clause body the editor shows is the body sectionsForAgreement resolves', () => {
    const overrides = { deposit_post_charges: { body: LAX_DEPOSIT }, mileage_fuel: { label: 'Mileage (LAX)' } };
    const view = buildClauseView(overrides);
    const signing = sectionsForAgreement({ declinedInsurance: true, sectionOverrides: overrides });
    for (const s of signing) {
      const c = view.clauses.find((x) => x.key === s.key);
      assert.ok(c, `${s.key} is in the editor`);
      assert.equal(c.body, s.body, `${s.key} body matches what the renter will read`);
      assert.equal(c.label, s.label, `${s.key} label matches`);
    }
  });

  it('CARE 8: the effective map matches parseSectionOverrides exactly, junk included', () => {
    for (const raw of [
      null, undefined, '', '   ', 'not json', '[]', '42',
      '{"mileage_fuel":"short form"}',
      { deposit_post_charges: { body: LAX_DEPOSIT } },
      { nope: { body: 'x' }, mileage_fuel: { body: 'y' } },
    ]) {
      assert.deepEqual(
        inspectStoredOverrides(raw).overrides,
        parseSectionOverrides(raw),
        `${JSON.stringify(raw)} resolves identically`,
      );
    }
  });

  it('CARE 9: the catalog is the canonical key set — the editor cannot invent a clause', () => {
    assert.deepEqual(
      clauseCatalog().map((c) => c.key),
      [...TC_SECTIONS.map((s) => s.key), DECLINED_INSURANCE_SECTION.key, DAMAGE_ACKNOWLEDGEMENT_SECTION.key],
    );
    assert.equal(clauseCatalog().filter((c) => c.scope === CLAUSE_SCOPE.ALWAYS).length, 6);
  });

  it('CARE 10: the catalog is a COPY — the editor cannot mutate the canonical constants', () => {
    const before = TC_SECTIONS.find((s) => s.key === 'mileage_fuel').body;
    clauseCatalog()[1].body = 'vandalised';
    assert.equal(TC_SECTIONS.find((s) => s.key === 'mileage_fuel').body, before);
    // And a view built afterwards still shows the real canonical text.
    assert.equal(buildClauseView(null).clauses.find((c) => c.key === 'mileage_fuel').canonicalBody, before);
  });
});

describe('"this location uses the standard text" is a visible, restorable state', () => {
  it('CARE 11: with no overrides every clause reports isOverridden false and carries the canonical body', () => {
    for (const c of buildClauseView(null).clauses) {
      assert.equal(c.isOverridden, false);
      assert.equal(c.bodyOverridden, false);
      assert.equal(c.labelOverridden, false);
      assert.equal(c.body, c.canonicalBody);
      assert.equal(c.label, c.canonicalLabel);
    }
  });

  it('CARE 12: an override is visible AS an override, beside the text it replaced', () => {
    const view = buildClauseView({ deposit_post_charges: { body: LAX_DEPOSIT } });
    const dep = view.clauses.find((c) => c.key === 'deposit_post_charges');
    assert.equal(dep.isOverridden, true);
    assert.equal(dep.bodyOverridden, true);
    assert.equal(dep.labelOverridden, false, 'a body override does not claim the label');
    assert.equal(dep.body, LAX_DEPOSIT);
    assert.ok(dep.canonicalBody.includes('$500'), 'the standard text is still shown for comparison');
    assert.notEqual(dep.canonicalLength, dep.length);
    // Every other clause is untouched and still says "standard".
    for (const c of view.clauses) {
      if (c.key === 'deposit_post_charges') continue;
      assert.equal(c.isOverridden, false, `${c.key} untouched`);
    }
  });

  it('CARE 13: restore-to-standard is ONE action — an absent or null key', () => {
    const current = { deposit_post_charges: { body: LAX_DEPOSIT }, mileage_fuel: { body: 'branch mileage' } };
    // Absent.
    assert.deepEqual(validateClauseOverrides({ mileage_fuel: { body: 'branch mileage' } }), {
      mileage_fuel: { body: 'branch mileage' },
    });
    // Explicitly null — the same outcome, so a UI that sends the whole map and
    // one that sends only what survives agree.
    assert.deepEqual(
      validateClauseOverrides({ deposit_post_charges: null, mileage_fuel: { body: 'branch mileage' } }),
      { mileage_fuel: { body: 'branch mileage' } },
    );
    // And clearing everything is legal and explicit.
    assert.deepEqual(validateClauseOverrides({}), {});
    assert.deepEqual(clauseChangeSummary(current, {}).map((c) => [c.key, c.change]).sort(), [
      ['deposit_post_charges', 'CLEARED'],
      ['mileage_fuel', 'CLEARED'],
    ]);
  });

  it('CARE 14: an emptied textarea is a REJECTION, not a silent restore', () => {
    // This is the difference between "restore to standard" and "my save
    // failed". `{ body: '' }` would be dropped by parseSectionOverrides and the
    // admin could not tell which of the two happened.
    assert.throws(() => validateClauseOverrides({ mileage_fuel: { body: '   ' } }), (err) => {
      assert.ok(err instanceof ClauseValidationError);
      assert.equal(err.statusCode, 400);
      assert.deepEqual(err.details, [{ key: 'mileage_fuel', field: 'body', error: 'EMPTY' }]);
      return true;
    });
    // And an entry with no fields at all is not a restore either.
    assert.throws(() => validateClauseOverrides({ mileage_fuel: {} }), /invalid/i);
  });
});

describe('validation rejects; it does not strip', () => {
  it('CARE 15: an unknown sectionKey is a 400 naming it and the valid set', () => {
    assert.throws(() => validateClauseOverrides({ deposit_post_chargez: { body: 'typo' } }), (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /deposit_post_chargez/);
      assert.match(err.message, /deposit_post_charges/, 'the message names the valid keys');
      assert.deepEqual(err.details, [{ key: 'deposit_post_chargez', error: 'UNKNOWN_SECTION_KEY' }]);
      return true;
    });
    // Even alongside perfectly good ones — the good ones do NOT sneak through.
    assert.throws(
      () => validateClauseOverrides({ mileage_fuel: { body: 'fine' }, nope: { body: 'x' } }),
      /Unknown clause key/,
    );
  });

  it('CARE 16: every catalog key is accepted, and only those', () => {
    for (const key of knownClauseKeys()) {
      assert.deepEqual(validateClauseOverrides({ [key]: { body: 'branch wording' } }), { [key]: { body: 'branch wording' } });
    }
    for (const key of ['key', 'body', '__proto__', 'insurance', 'rental_period ']) {
      assert.throws(() => validateClauseOverrides({ [key]: { body: 'x' } }), /Unknown clause key/, `${key} rejected`);
    }
  });

  it('CARE 17: over the SANITY bound is a 400 — over the TERMINAL cap is not', () => {
    // The two limits mean different things and the editor must not conflate
    // them. 251 characters is a lawful clause that costs terminal signing;
    // 2001 is a paste accident.
    assert.doesNotThrow(() => validateClauseOverrides({
      rental_period: { body: bodyOfLength(TERMINAL_TITLE_MAX + 1) },
    }), 'over the terminal cap still saves');

    assert.throws(() => validateClauseOverrides({
      rental_period: { body: bodyOfLength(CLAUSE_MAX_BODY + 1) },
    }), (err) => {
      assert.deepEqual(err.details, [{
        key: 'rental_period', field: 'body', error: 'TOO_LONG',
        length: CLAUSE_MAX_BODY + 1, max: CLAUSE_MAX_BODY,
      }]);
      return true;
    });
    assert.ok(CLAUSE_MAX_BODY > TERMINAL_TITLE_MAX * 4, 'the sanity bound is nowhere near the real limit');
  });

  it('CARE 18: labels are bounded too, and a non-string is rejected rather than coerced', () => {
    assert.throws(() => validateClauseOverrides({ mileage_fuel: { label: bodyOfLength(CLAUSE_MAX_LABEL + 1) } }), /invalid/i);
    assert.throws(() => validateClauseOverrides({ mileage_fuel: { body: 42 } }), /invalid/i);
    assert.throws(() => validateClauseOverrides({ mileage_fuel: [] }), /invalid/i);
    assert.throws(() => validateClauseOverrides([]), /must be an object/i);
    assert.throws(() => validateClauseOverrides(undefined), /required/i);
  });

  it('CARE 19: the bare-string shorthand the column already supports still works', () => {
    assert.deepEqual(validateClauseOverrides({ mileage_fuel: '150 mi/day.' }), { mileage_fuel: { body: '150 mi/day.' } });
  });

  it('CARE 20: whitespace is trimmed, and that is the ONLY normalisation', () => {
    const messy = '  Line one.\n\n  Line two.  ';
    const out = validateClauseOverrides({ mileage_fuel: { body: messy } });
    assert.equal(out.mileage_fuel.body, 'Line one.\n\n  Line two.');
    assert.ok(out.mileage_fuel.body.includes('\n\n'), 'internal shape is the author\'s, not ours');
  });
});

describe('a broken stored blob is shown to the admin, not swallowed', () => {
  it('CARE 21: unparseable JSON is reported — the signing flow falls back, the editor confesses', () => {
    const stored = inspectStoredOverrides('{"deposit_post_charges": {"body": "trunc');
    assert.equal(stored.ok, false);
    assert.equal(stored.reason, 'NOT_JSON');
    assert.deepEqual(stored.overrides, {}, 'and the effective text really is canonical');
    assert.equal(buildClauseView('{"a": ').storage.ok, false);
  });

  it('CARE 22: the wrong shape is reported', () => {
    for (const [raw, reason] of [['[]', 'NOT_AN_OBJECT'], ['42', 'NOT_AN_OBJECT'], ['"a string"', 'NOT_AN_OBJECT']]) {
      assert.equal(inspectStoredOverrides(raw).reason, reason, `${raw}`);
    }
  });

  it('CARE 23: keys already stranded in the column are named, not hidden', () => {
    // Somebody edited the column by hand before this editor existed and typo'd.
    // Showing "everything is standard" would hide it, and saving from that
    // screen would erase the evidence before anyone read it.
    const view = buildClauseView('{"deposit_post_chargez":{"body":"typo"},"mileage_fuel":{"body":"ok"}}');
    assert.deepEqual(view.storage.unknownKeys, ['deposit_post_chargez']);
    assert.equal(view.storage.ok, true, 'the blob parses — it is the key that is wrong');
    assert.equal(view.clauses.find((c) => c.key === 'mileage_fuel').body, 'ok');
  });

  it('CARE 24: a healthy blob reports clean', () => {
    for (const ok of [null, undefined, '', '{}', '{"mileage_fuel":{"body":"x"}}']) {
      const s = inspectStoredOverrides(ok);
      assert.equal(s.ok, true, `${JSON.stringify(ok)} is clean`);
      assert.deepEqual(s.unknownKeys, []);
    }
  });
});

describe('the audit trail carries keys and lengths — never the wording', () => {
  const SECRET = 'The renter agrees to a $9,999.00 deposit and forfeits all recourse whatsoever.';

  it('CARE 25: no fragment of the clause text appears anywhere in the summary', () => {
    const changed = clauseChangeSummary({}, { deposit_post_charges: { body: SECRET, label: 'Deposit (LAX)' } });
    const serialized = JSON.stringify(changed);
    assert.ok(!serialized.includes(SECRET), 'the body is absent');
    assert.ok(!serialized.includes('9,999'), 'and so is every distinctive fragment of it');
    assert.ok(!serialized.includes('Deposit (LAX)'), 'the label text is absent too — it is still authored text');
    assert.deepEqual(changed, [{
      key: 'deposit_post_charges',
      change: 'SET',
      bodyLength: SECRET.length,
      previousBodyLength: null,
      labelLength: 'Deposit (LAX)'.length,
      previousLabelLength: null,
    }]);
  });

  it('CARE 26: SET / UPDATED / CLEARED are distinguished, with both lengths', () => {
    const before = { deposit_post_charges: { body: LAX_DEPOSIT }, mileage_fuel: { body: 'old mileage' } };
    const after = { deposit_post_charges: { body: SECRET }, prohibited_use: { body: 'new' } };
    assert.deepEqual(clauseChangeSummary(before, after), [
      {
        key: 'deposit_post_charges', change: 'UPDATED',
        bodyLength: SECRET.length, previousBodyLength: LAX_DEPOSIT.length,
        labelLength: null, previousLabelLength: null,
      },
      {
        key: 'mileage_fuel', change: 'CLEARED',
        bodyLength: null, previousBodyLength: 'old mileage'.length,
        labelLength: null, previousLabelLength: null,
      },
      {
        key: 'prohibited_use', change: 'SET',
        bodyLength: 3, previousBodyLength: null,
        labelLength: null, previousLabelLength: null,
      },
    ]);
  });

  it('CARE 27: an unchanged clause produces NO audit noise', () => {
    const same = { deposit_post_charges: { body: LAX_DEPOSIT } };
    assert.deepEqual(clauseChangeSummary(same, { deposit_post_charges: { body: LAX_DEPOSIT } }), []);
    assert.deepEqual(clauseChangeSummary({}, {}), []);
  });

  it('CARE 28: a label-only edit is still recorded — it is what the renter sees as the heading', () => {
    const changed = clauseChangeSummary(
      { mileage_fuel: { body: 'same' } },
      { mileage_fuel: { body: 'same', label: 'Mileage (LAX)' } },
    );
    assert.equal(changed.length, 1);
    assert.equal(changed[0].change, 'UPDATED');
    assert.equal(changed[0].labelLength, 13);
    assert.equal(changed[0].previousLabelLength, null);
  });
});

describe('language: one body per clause, exactly as the corpus and the terminal do it', () => {
  it('CARE 29: there is no per-language dimension to invent — the catalog has one body per key', () => {
    // terms-content.js is a single English corpus; SignClient.jsx translates its
    // own chrome and serves the clause bodies as-is (its documented KNOWN
    // LIMIT), and the terminal carries both languages inside ONE string
    // ("I agree / Acepto"). So a branch that needs Spanish writes Spanish into
    // the body. An en/es pair here would be a translation model this product
    // does not have, and the two halves would drift out of what was signed.
    for (const c of clauseCatalog()) {
      assert.equal(typeof c.body, 'string');
      assert.ok(!('bodyEs' in c) && !('translations' in c), `${c.key} has no language dimension`);
    }
    for (const c of buildClauseView(null).clauses) {
      assert.deepEqual(
        Object.keys(c).filter((k) => /(_es|Es|lang|locale)$/i.test(k)), [],
        `${c.key} exposes no language-keyed field`,
      );
    }
  });

  it('CARE 30: a Spanish body round-trips byte-for-byte, accents and all', () => {
    const es = 'Autorizo un depósito de garantía de $500.00 sobre mi tarjeta. '
      + 'También autorizo cargos por peajes, multas y limpieza después de la renta.';
    const out = validateClauseOverrides({ deposit_post_charges: { body: es } });
    assert.equal(out.deposit_post_charges.body, es);
    const view = buildClauseView(out).clauses.find((c) => c.key === 'deposit_post_charges');
    assert.equal(view.body, es);
    assert.equal(view.terminalText, es);
    // Characters, not bytes — the terminal's cap is on the Title string, and
    // an accented clause must not be told it is longer than it is.
    assert.equal(view.length, es.length);
    assert.ok(Buffer.byteLength(es, 'utf8') > es.length, 'and it really does have multibyte characters');
  });
});
