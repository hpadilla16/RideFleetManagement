/**
 * The written half of Ride University — shape, and the top-up rule.
 *
 * No database: default-articles.js is pure data plus one pure decision, which
 * is the whole reason the decision was pulled out of the service.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ARTICLES,
  articlesMissingFrom,
  articlesToUpgrade,
  bodyFingerprint,
} from './default-articles.js';

// Must match CATEGORIES in knowledge-base.service.js — a category outside this
// list is invisible in the knowledge-base filter, so the article is unreachable.
const CATEGORIES = [
  'CHECKOUT', 'CHECKIN', 'PAYMENTS', 'INSPECTIONS', 'DISPUTES',
  'CAR_SHARING', 'TOLLS', 'AGREEMENTS', 'PLANNER', 'GENERAL',
];

// The six that shipped before the corpus moved into code. They were
// English-only in production until 2026-08-29; each now carries a Spanish half
// and a `supersedes` entry so the translation can actually reach the row.
const ORIGINAL_SIX = [
  'how-to-checkout', 'how-to-checkin', 'handling-damage-disputes',
  'processing-toll-charges', 'car-sharing-trip-workflow', 'payment-processing',
];

test('every article is shaped for the database', () => {
  for (const a of DEFAULT_ARTICLES) {
    assert.ok(a.title && typeof a.title === 'string', `title missing: ${a.slug}`);
    assert.ok(a.body && a.body.trim().length > 120, `body too thin: ${a.slug}`);
    assert.match(a.slug, /^[a-z0-9-]+$/, `slug not url-safe: ${a.slug}`);
    assert.ok(CATEGORIES.includes(a.category), `unknown category ${a.category} on ${a.slug}`);
    assert.ok(Array.isArray(a.tags) && a.tags.length, `no tags: ${a.slug}`);
    assert.equal(typeof a.sortOrder, 'number', `sortOrder not a number: ${a.slug}`);
  }
});

test('slugs are unique — the slug IS the identity the top-up matches on', () => {
  const slugs = DEFAULT_ARTICLES.map((a) => a.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

test('sort order is unique, so the list has one stable order', () => {
  const orders = DEFAULT_ARTICLES.map((a) => a.sortOrder);
  assert.equal(new Set(orders).size, orders.length);
});

test('EVERY article carries both languages', () => {
  // The counter is in Puerto Rico. KnowledgeArticle has no locale column, so
  // Spanish lives in the body under its own heading. No exemptions: the
  // original six were the last English-only ones and were translated on
  // 2026-08-29.
  assert.ok(DEFAULT_ARTICLES.length >= 16);
  for (const a of DEFAULT_ARTICLES) {
    assert.match(a.body, /\(Español\)/, `no Spanish section: ${a.slug}`);
    assert.ok(a.body.includes('---'), `no separator between languages: ${a.slug}`);
  }
});

test('the original six are still here, and now translated', () => {
  for (const slug of ORIGINAL_SIX) {
    const a = DEFAULT_ARTICLES.find((x) => x.slug === slug);
    assert.ok(a, `dropped: ${slug}`);
    // Without a supersedes entry the translation would sit in this file and
    // never reach the row that already exists — exactly the state the two
    // citation articles were found in.
    assert.ok(a.supersedes?.length, `translated but undeployable: ${slug}`);
  }
});

test('citations are covered, which is why the corpus moved into code', () => {
  const slugs = DEFAULT_ARTICLES.map((a) => a.slug);
  assert.ok(slugs.includes('handling-citations'));
  assert.ok(slugs.includes('citation-documents-and-export'));
});

test('a fresh scope gets everything', () => {
  assert.equal(articlesMissingFrom([]).length, DEFAULT_ARTICLES.length);
});

test('a scope that already has them all gets nothing', () => {
  assert.equal(articlesMissingFrom(DEFAULT_ARTICLES.map((a) => a.slug)).length, 0);
});

test('THE BUG THIS REPLACED: a scope with the old six still receives the rest', () => {
  // The previous seed counted articles and bailed if there were any, so
  // article number seven shipped to nobody who had already seeded.
  const missing = articlesMissingFrom(ORIGINAL_SIX);
  assert.equal(missing.length, DEFAULT_ARTICLES.length - ORIGINAL_SIX.length);
  assert.ok(missing.some((a) => a.slug === 'handling-citations'));
  assert.ok(!missing.some((a) => ORIGINAL_SIX.includes(a.slug)));
});

test('an edited article is left alone', () => {
  // Presence is by slug. A tenant who rewrote a body still "has" it.
  const missing = articlesMissingFrom(['how-to-checkout']);
  assert.ok(!missing.some((a) => a.slug === 'how-to-checkout'));
});

test('unknown slugs in the scope do not disturb the result', () => {
  const missing = articlesMissingFrom(['something-a-tenant-wrote-themselves']);
  assert.equal(missing.length, DEFAULT_ARTICLES.length);
});

// ── Upgrading a body that already shipped ──────────────────────────────────
//
// The narrow permission that lets a correction deploy. Everything here is
// about what it must REFUSE to touch.

test('every supersedes entry is a sha256, and never the current body', () => {
  for (const a of DEFAULT_ARTICLES) {
    if (!a.supersedes) continue;
    const current = bodyFingerprint(a.body);
    for (const h of a.supersedes) {
      assert.match(h, /^[0-9a-f]{64}$/, `not a sha256 on ${a.slug}: ${h}`);
      // Listing the current body would make the row eligible to be rewritten
      // with itself forever.
      assert.notEqual(h, current, `${a.slug} supersedes its own current body`);
    }
    assert.equal(new Set(a.supersedes).size, a.supersedes.length, `duplicate hash on ${a.slug}`);
  }
});

test('a row holding a body we shipped IS upgraded', () => {
  // sha256 has no preimage, so this needs a catalog whose predecessor hash we
  // can compute here — hence the injectable catalog. The function under test
  // is the real one.
  const previous = 'the body this article used to have';
  const catalog = [{
    slug: 'how-to-checkout',
    body: 'the corrected body',
    supersedes: [bodyFingerprint(previous)],
  }];
  const out = articlesToUpgrade([{ slug: 'how-to-checkout', body: previous }], catalog);
  assert.equal(out.length, 1);
  assert.equal(out[0].slug, 'how-to-checkout');
  assert.equal(out[0].body, 'the corrected body');
  assert.equal(out[0].from, bodyFingerprint(previous));
});

test('a row two versions behind still upgrades — nobody is stranded', () => {
  const v1 = 'first body';
  const v2 = 'second body';
  const catalog = [{
    slug: 'how-to-checkout',
    body: 'third body',
    supersedes: [bodyFingerprint(v1), bodyFingerprint(v2)],
  }];
  assert.equal(articlesToUpgrade([{ slug: 'how-to-checkout', body: v1 }], catalog).length, 1);
  assert.equal(articlesToUpgrade([{ slug: 'how-to-checkout', body: v2 }], catalog).length, 1);
});

test('a row someone EDITED is never touched', () => {
  const rows = DEFAULT_ARTICLES
    .filter((a) => a.supersedes?.length)
    .map((a) => ({ slug: a.slug, body: 'the tenant rewrote this in their own words' }));
  assert.equal(articlesToUpgrade(rows).length, 0);
});

test('a row already at the current body is not rewritten with itself', () => {
  const rows = DEFAULT_ARTICLES.map((a) => ({ slug: a.slug, body: a.body }));
  assert.equal(articlesToUpgrade(rows).length, 0);
});

test('an article with no supersedes is never upgraded, whatever the body says', () => {
  const noPath = DEFAULT_ARTICLES.filter((a) => !a.supersedes?.length);
  assert.ok(noPath.length, 'expected articles with no declared upgrade path');
  const rows = noPath.map((a) => ({ slug: a.slug, body: 'anything at all' }));
  assert.equal(articlesToUpgrade(rows).length, 0);
});

test('a slug we do not own is ignored', () => {
  assert.equal(articlesToUpgrade([{ slug: 'tenant-wrote-this', body: 'x' }]).length, 0);
});

test('an empty scope produces no upgrades — that is what seeding is for', () => {
  assert.equal(articlesToUpgrade([]).length, 0);
});

test('THE TWO STRANDED CITATION ARTICLES have an upgrade path', () => {
  // They were inserted into production by hand as English-only drafts, then
  // rewritten bilingually in this file, and the two could not meet. Losing
  // these entries would silently re-strand them.
  for (const slug of ['handling-citations', 'citation-documents-and-export']) {
    const a = DEFAULT_ARTICLES.find((x) => x.slug === slug);
    assert.ok(a.supersedes?.length, `no upgrade path: ${slug}`);
  }
});
