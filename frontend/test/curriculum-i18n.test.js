/**
 * The curriculum's copy must exist in both languages, and the keys must be
 * derivable from the data — not stored beside it.
 *
 * Spanish is the primary language of the team this trains. A missing key
 * degrades to English, which is readable but wrong for them, and silent. So
 * the parity is asserted rather than trusted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COURSES, allModules } from '../src/lib/training/curriculum.js';
import { courseKey, moduleKey, stepKey, trainingText } from '../src/lib/training/i18n-keys.js';
import { glossaryKeys } from '../src/lib/training/kiosk-glossary.js';
import { figureTextKeys } from '../src/lib/training/figure-text.js';

const LOCALES = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');
const load = (lang) => JSON.parse(readFileSync(join(LOCALES, `${lang}.json`), 'utf8'));

/** Resolve a dotted key against a locale object, or undefined. */
function lookup(obj, key) {
  return key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

/** Every key the curriculum will ask for at render time. */
function expectedKeys() {
  const keys = [];
  for (const course of COURSES) {
    keys.push(courseKey(course, 'title'), courseKey(course, 'summary'));
  }
  for (const m of allModules()) {
    keys.push(moduleKey(m, 'title'), moduleKey(m, 'summary'));
    if (m.gotcha) keys.push(moduleKey(m, 'gotcha'));
    for (const s of m.steps || []) {
      keys.push(stepKey(m, s, 'title'), stepKey(m, s, 'body'));
      // Drawn steps number what the drawing marks; asked steps carry the
      // question, each option and its explanation. All of it is read aloud to
      // a Spanish-speaking team, so all of it is a key.
      (s.callouts || []).forEach((_, i) => keys.push(stepKey(m, s, `callouts.${i}`)));
      if (s.check) {
        keys.push(stepKey(m, s, 'check.question'));
        for (const o of s.check.options || []) {
          keys.push(stepKey(m, s, `check.options.${o.key}.text`), stepKey(m, s, `check.options.${o.key}.why`));
        }
      }
    }
  }
  // Reference material beside the modules (the kiosk button glossary).
  keys.push(...glossaryKeys());
  // The few authored strings drawn inside figures (chat bubbles, eyebrows).
  keys.push(...figureTextKeys());
  return keys;
}

describe('curriculum translations', () => {
  const en = load('en');
  const es = load('es');
  const keys = expectedKeys();

  it('derives a key for every translatable string', () => {
    // 110 → 119 when the shuttle console module landed (2026-08-28): three
    // steps, plus the module's own title, summary and gotcha.
    // 128 → 356 with the kiosk course (2026-09-04): 7 modules, 25 steps with
    // callouts and checks, and the 50-entry button glossary.
    expect(keys.length).toBe(356); // 119 → 128 when the additional-drivers
    // micro-module landed (2026-09-02, copilot Phase 2): three steps plus the
    // module's own title, summary and gotcha.
    expect(new Set(keys).size, 'two entries derive the same key — one would overwrite the other').toBe(keys.length);
  });

  it('every key resolves in English', () => {
    const missing = keys.filter((k) => typeof lookup(en, k) !== 'string' || !lookup(en, k).trim());
    expect(missing, `Missing from en.json:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('every key resolves in Spanish', () => {
    const missing = keys.filter((k) => typeof lookup(es, k) !== 'string' || !lookup(es, k).trim());
    expect(missing, `Missing from es.json — these would silently render in English:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('no Spanish string is just the English copied over', () => {
    // A pasted English string is worse than a missing one: the fallback would
    // have produced the same words, but this looks translated.
    const untranslated = keys.filter((k) => {
      const e = lookup(en, k);
      const s = lookup(es, k);
      return typeof e === 'string' && typeof s === 'string' && e.length > 25 && e === s;
    });
    expect(untranslated, `Identical to English:\n  ${untranslated.join('\n  ')}`).toEqual([]);
  });

  it('English in the locale matches the English in the curriculum', () => {
    // The data file's copy is the i18next default. If the two drift, which one
    // a reader sees depends on whether the key resolved — the worst kind of bug.
    for (const m of allModules()) {
      expect(lookup(en, moduleKey(m, 'title')), `${m.key} title`).toBe(m.title);
      for (const s of m.steps || []) {
        expect(lookup(en, stepKey(m, s, 'body')), `${m.key}/${s.anchor} body`).toBe(s.body);
        (s.callouts || []).forEach((c, i) => expect(lookup(en, stepKey(m, s, `callouts.${i}`)), `${m.key}/${s.anchor} callout ${i}`).toBe(c));
        if (s.check) {
          expect(lookup(en, stepKey(m, s, 'check.question')), `${m.key}/${s.anchor} question`).toBe(s.check.question);
          for (const o of s.check.options || []) {
            expect(lookup(en, stepKey(m, s, `check.options.${o.key}.text`)), `${m.key}/${s.anchor}/${o.key} text`).toBe(o.text);
            expect(lookup(en, stepKey(m, s, `check.options.${o.key}.why`)), `${m.key}/${s.anchor}/${o.key} why`).toBe(o.why);
          }
        }
      }
    }
  });

  it('Spanish callouts have exactly the curriculum’s indexes — positional keys cannot hide an extra', () => {
    for (const m of allModules()) {
      for (const s of m.steps || []) {
        if (!s.callouts) continue;
        const esCallouts = lookup(es, stepKey(m, s, 'callouts')) || {};
        expect(Object.keys(esCallouts).sort(), `${m.key}/${s.anchor} es callouts`).toEqual(s.callouts.map((_, i) => String(i)).sort());
      }
    }
  });

  it('trainingText falls back to the curriculum English when a key is absent', () => {
    const t = (key, fallback) => (key === 'known' ? 'translated' : fallback);
    expect(trainingText(t, 'known', 'English')).toBe('translated');
    expect(trainingText(t, 'training.modules.nope.title', 'English')).toBe('English');
    expect(trainingText(null, 'anything', 'English')).toBe('English');
  });
});
