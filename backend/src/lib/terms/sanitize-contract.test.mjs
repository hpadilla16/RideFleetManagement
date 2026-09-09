/**
 * Contract HTML sanitizer (2026-09-09).
 *
 * The load-bearing test is the FIRST one: the canonical contract that ships in
 * this repo must survive a round trip with its tag census unchanged. An
 * allowlist I reasoned about is a guess; an allowlist measured against the real
 * document is a fact. If a future contract needs a tag, this test is where it
 * fails, loudly, instead of silently deleting a clause on save.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { sanitizeContractHtml, describeSanitizerImpact, ALLOWED_TAGS } =
  await import('./sanitize-contract.js');
const { TC_HTML_FILENAME } = await import('./version.js');

const here = dirname(fileURLToPath(import.meta.url));
const CANONICAL = readFileSync(join(here, TC_HTML_FILENAME), 'utf8');

function census(html) {
  const out = new Map();
  for (const m of String(html).matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)/g)) {
    const t = m[1].toLowerCase();
    out.set(t, (out.get(t) || 0) + 1);
  }
  return out;
}

test('THE REAL DOCUMENT survives with every tag intact', () => {
  const before = census(CANONICAL);
  const after = census(sanitizeContractHtml(CANONICAL));
  const lost = [];
  for (const [tag, n] of before) {
    const kept = after.get(tag) || 0;
    if (kept < n) lost.push(`${tag}: ${n} -> ${kept}`);
  }
  assert.deepEqual(lost, [], 'the shipped contract must not lose a single tag');
});

/**
 * Decode entities so `&oacute;` and `ó` compare equal — sanitize-html turns the
 * named forms into literal characters, which shortens the file without changing
 * a single word a renter reads.
 */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', iexcl: '¡', iquest: '¿',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  mdash: '—', ndash: '–', hellip: '…', deg: '°',
  uuml: 'ü', Uuml: 'Ü',
};

function wording(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (ENTITIES[name] !== undefined ? ENTITIES[name] : m))
    .replace(/\s+/g, ' ')
    .trim();
}

test('NOT ONE WORD of the contract changes — the property that actually matters', () => {
  // Stronger than the tag census above: a document can keep every tag and still
  // lose a clause. Measured in production, both sides come to 49,906 characters
  // of identical wording; the file shrinks ~5KB only because comments go and
  // `&oacute;` becomes `ó`.
  assert.equal(wording(sanitizeContractHtml(CANONICAL)), wording(CANONICAL));
});

test('a clause hidden behind an attribute becomes VISIBLE, never dropped', () => {
  const html = '<p style="display:none">The Customer waives nothing.</p>';
  assert.equal(wording(sanitizeContractHtml(html)), wording(html));
});

test('the bilingual markup survives — lang and class are what carry it', () => {
  const out = sanitizeContractHtml('<div class="es" lang="es"><p>Hola</p></div>');
  assert.match(out, /lang="es"/);
  assert.match(out, /class="es"/);
});

test('tables survive, including spans and scope', () => {
  const html = '<table><thead><tr><th scope="col" colspan="2">A</th></tr></thead><tbody><tr><td rowspan="2">B</td></tr></tbody></table>';
  const out = sanitizeContractHtml(html);
  for (const bit of ['<table', '<thead', '<th', 'colspan="2"', 'rowspan="2"', 'scope="col"']) {
    assert.ok(out.includes(bit), `${bit} must survive`);
  }
});

// ---------------------------------------------------------------------------
// What must NOT survive
// ---------------------------------------------------------------------------
test('a script is removed WITH its contents', () => {
  const out = sanitizeContractHtml('<p>Clause</p><script>steal(document.cookie)</script>');
  assert.equal(out.includes('<script'), false);
  assert.equal(out.includes('steal'), false, 'the code itself must not survive as text');
  assert.match(out, /Clause/, 'the clause around it is untouched');
});

test('style, iframe, object and form are removed', () => {
  for (const bad of [
    '<style>body{display:none}</style>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x"></object>',
    '<form action="https://evil.example"><input name="card"></form>',
  ]) {
    const out = sanitizeContractHtml(`<p>Clause</p>${bad}`);
    assert.match(out, /Clause/);
    for (const tag of ['<style', '<iframe', '<object', '<form', '<input']) {
      assert.equal(out.includes(tag), false, `${tag} must not survive`);
    }
  }
});

test('event handlers are stripped from tags that stay', () => {
  const out = sanitizeContractHtml('<div onclick="steal()" onmouseover="x()"><p>Clause</p></div>');
  assert.match(out, /<div/);
  assert.equal(/onclick|onmouseover/i.test(out), false);
});

test('javascript: and data: links do not survive', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', '//evil.example']) {
    const out = sanitizeContractHtml(`<a href="${href}">click</a>`);
    assert.equal(out.includes(href), false, `${href} must not survive`);
    assert.match(out, /click/, 'the text stays even when the link goes');
  }
});

test('an allowed link is kept and hardened', () => {
  const out = sanitizeContractHtml('<a href="https://ridefleetmanager.com">terms</a>');
  assert.match(out, /href="https:\/\/ridefleetmanager\.com"/);
  assert.match(out, /rel="noopener noreferrer"/);
});

test('style attributes are dropped — they can hide a whole clause', () => {
  const out = sanitizeContractHtml('<p style="display:none">You owe $10,000</p>');
  assert.equal(/style=/.test(out), false);
  assert.match(out, /You owe/, 'and the clause becomes visible rather than vanishing');
});

test('an unknown tag loses the tag but KEEPS its wording', () => {
  // Losing a sentence from a document somebody signs is worse than losing its
  // formatting.
  const out = sanitizeContractHtml('<marquee>The Customer is liable for tolls.</marquee>');
  assert.equal(out.includes('<marquee'), false);
  assert.match(out, /The Customer is liable for tolls\./);
});

// ---------------------------------------------------------------------------
// Emptiness is a meaningful value here
// ---------------------------------------------------------------------------
test('empty in, empty out — that is how a branch says "use the tenant\'s"', () => {
  for (const v of ['', '   ', '\n\t', null, undefined]) {
    assert.equal(sanitizeContractHtml(v), '', 'whitespace must not become a fake override');
  }
});

test('the initials markers are text and pass through untouched', () => {
  const out = sanitizeContractHtml('<p>Initials: {{INITIALS_S11_CARD_ON_FILE}}</p>');
  assert.match(out, /\{\{INITIALS_S11_CARD_ON_FILE\}\}/);
});

test('sanitizing twice changes nothing the second time', () => {
  const once = sanitizeContractHtml(CANONICAL);
  assert.equal(sanitizeContractHtml(once), once, 'a re-save must not erode the document');
});

test('never throws on junk', () => {
  for (const v of [{}, [], 42, '<<<>>>', '<p unclosed']) {
    assert.equal(typeof sanitizeContractHtml(v), 'string');
  }
});

// ---------------------------------------------------------------------------
// The impact description shown to an author before they save
// ---------------------------------------------------------------------------
test('impact names what would be removed', () => {
  const impact = describeSanitizerImpact('<p>Clause</p><script>x()</script><style>y</style>');
  assert.equal(impact.changed, true);
  const tags = impact.removedTags.map((r) => r.tag);
  assert.ok(tags.includes('script') && tags.includes('style'));
});

test('impact on a clean document reports no change', () => {
  assert.equal(describeSanitizerImpact(sanitizeContractHtml(CANONICAL)).changed, false);
  assert.equal(describeSanitizerImpact('').changed, false);
});

test('the allowlist is exported so the panel can explain itself', () => {
  assert.ok(ALLOWED_TAGS.includes('table') && ALLOWED_TAGS.includes('section'));
  assert.equal(ALLOWED_TAGS.includes('script'), false);
});
