#!/usr/bin/env node
/**
 * Ride University — keep en.json's `training` block equal to the curriculum.
 *
 * The English copy lives ONCE, in src/lib/training/curriculum.js (and the
 * kiosk glossary). The locale must carry the same strings so the i18n test's
 * "English in the locale matches the English in the curriculum" holds — and
 * hand-copying 300+ keys is how they drift. This writes the English keys from
 * the source of truth, then reports every key Spanish is missing or has left
 * identical to English (both fail the test), so the author knows exactly what
 * to translate.
 *
 * Byte-safe: only the `training` object is re-serialized; everything else in
 * the file is untouched, and CRLF line endings are preserved (both locale files
 * are CRLF and a plain json.dump would rewrite every line).
 *
 *   npm run i18n:training            # write en, report es gaps (exit 1 on gaps)
 *   npm run i18n:training -- --check # write nothing; exit 1 if en is stale or es has gaps
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COURSES, allModules } from '../src/lib/training/curriculum.js';
import { courseKey, moduleKey, stepKey } from '../src/lib/training/i18n-keys.js';
import { KIOSK_GLOSSARY, glossaryKey, glossaryGroupKey, glossaryEntryKey } from '../src/lib/training/kiosk-glossary.js';
import { FIGURE_TEXT, figureTextKey } from '../src/lib/training/figure-text.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = join(ROOT, 'src', 'locales');
const CHECK = process.argv.includes('--check');

/** Every English string the curriculum owns, keyed the way the UI asks for it. */
function englishFromCurriculum() {
  const en = {};
  for (const c of COURSES) { en[courseKey(c, 'title')] = c.title; en[courseKey(c, 'summary')] = c.summary; }
  for (const m of allModules()) {
    en[moduleKey(m, 'title')] = m.title;
    en[moduleKey(m, 'summary')] = m.summary;
    if (m.gotcha) en[moduleKey(m, 'gotcha')] = m.gotcha;
    for (const s of m.steps || []) {
      en[stepKey(m, s, 'title')] = s.title;
      en[stepKey(m, s, 'body')] = s.body;
      (s.callouts || []).forEach((c, i) => { en[stepKey(m, s, `callouts.${i}`)] = c; });
      if (s.check) {
        en[stepKey(m, s, 'check.question')] = s.check.question;
        for (const o of s.check.options || []) {
          en[stepKey(m, s, `check.options.${o.key}.text`)] = o.text;
          en[stepKey(m, s, `check.options.${o.key}.why`)] = o.why;
        }
      }
    }
  }
  en[glossaryKey('title')] = KIOSK_GLOSSARY.title;
  en[glossaryKey('summary')] = KIOSK_GLOSSARY.summary;
  en[glossaryKey('legend')] = KIOSK_GLOSSARY.legend;
  for (const g of KIOSK_GLOSSARY.groups) {
    en[glossaryGroupKey(g)] = g.title;
    for (const e of g.entries) en[glossaryEntryKey(e)] = e.what;
  }
  for (const [id, text] of Object.entries(FIGURE_TEXT)) en[figureTextKey(id)] = text;
  return en;
}

const lookup = (obj, key) => key.split('.').reduce((acc, p) => (acc == null ? undefined : acc[p]), obj);
function setDeep(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts.at(-1)] = value;
}

/** Locate the `"training": {…}` block in the raw file, string-aware. */
function trainingBlock(raw) {
  const at = raw.indexOf('\r\n  "training": {');
  if (at < 0) throw new Error('training block not found (expected CRLF file with a top-level "training")');
  const open = raw.indexOf('{', at + 2);
  let depth = 0, inStr = false, esc = false, i = open;
  for (; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  return { open, close: i };
}

function writeTraining(file, mutate) {
  const raw = readFileSync(file, 'utf8');
  if (!raw.includes('\r\n')) throw new Error(`${file} is not CRLF — refusing to guess`);
  const { open, close } = trainingBlock(raw);
  const training = JSON.parse(raw.slice(open, close + 1).replace(/\r\n/g, '\n'));
  const before = JSON.stringify(training);
  mutate(training);
  if (JSON.stringify(training) === before) return false;
  const body = JSON.stringify(training, null, 2).split('\n').map((l, n) => (n === 0 ? l : `  ${l}`)).join('\r\n');
  const out = raw.slice(0, open) + body + raw.slice(close + 1);
  const a = JSON.parse(raw.replace(/\r\n/g, '\n')); const b = JSON.parse(out.replace(/\r\n/g, '\n'));
  delete a.training; delete b.training;
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('something outside training would change — aborting');
  if (!CHECK) writeFileSync(file, out, 'utf8');
  return true;
}

const en = englishFromCurriculum();
const enFile = join(LOCALES, 'en.json');
const esFile = join(LOCALES, 'es.json');

const enChanged = writeTraining(enFile, (training) => {
  for (const [k, v] of Object.entries(en)) setDeep(training, k.slice('training.'.length), v);
});
console.log(`en.json: ${Object.keys(en).length} curriculum keys ${enChanged ? (CHECK ? 'STALE (would change)' : 'written') : 'already in sync'}`);

const es = JSON.parse(readFileSync(esFile, 'utf8'));
const missing = Object.keys(en).filter((k) => typeof lookup(es, k) !== 'string');
const identical = Object.keys(en).filter((k) => lookup(es, k) === en[k]);
if (missing.length) console.log(`es.json: ${missing.length} MISSING\n  ${missing.join('\n  ')}`);
// Identical is a WARNING, not a failure: brand names ("Ride University") are
// legitimately the same in both languages. The i18n test decides what counts.
if (identical.length) console.log(`es.json: ${identical.length} identical to English (check they are proper nouns)\n  ${identical.join('\n  ')}`);
if (!missing.length && !identical.length) console.log('es.json: complete');
process.exit((CHECK && enChanged) || missing.length ? 1 : 0);
