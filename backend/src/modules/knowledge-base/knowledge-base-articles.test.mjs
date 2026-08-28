/**
 * The written half of Ride University — shape, and the top-up rule.
 *
 * No database: default-articles.js is pure data plus one pure decision, which
 * is the whole reason the decision was pulled out of the service.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ARTICLES, articlesMissingFrom } from './default-articles.js';

// Must match CATEGORIES in knowledge-base.service.js — a category outside this
// list is invisible in the knowledge-base filter, so the article is unreachable.
const CATEGORIES = [
  'CHECKOUT', 'CHECKIN', 'PAYMENTS', 'INSPECTIONS', 'DISPUTES',
  'CAR_SHARING', 'TOLLS', 'AGREEMENTS', 'PLANNER', 'GENERAL',
];

// The six that shipped before the corpus moved into code. Their bodies are
// deliberately English-only and are left exactly as they were.
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

test('every article added since 2026-08-28 carries both languages', () => {
  // The counter is in Puerto Rico. KnowledgeArticle has no locale column, so
  // Spanish lives in the body under its own heading.
  const added = DEFAULT_ARTICLES.filter((a) => !ORIGINAL_SIX.includes(a.slug));
  assert.ok(added.length >= 10, 'expected the 2026-08-28 additions');
  for (const a of added) {
    assert.match(a.body, /\(Español\)/, `no Spanish section: ${a.slug}`);
    assert.ok(a.body.includes('---'), `no separator between languages: ${a.slug}`);
  }
});

test('the original six are left exactly as they shipped', () => {
  // Rewriting them here would reach no tenant that already has them — the
  // top-up never updates — so it would only create drift.
  for (const slug of ORIGINAL_SIX) {
    assert.ok(DEFAULT_ARTICLES.some((a) => a.slug === slug), `dropped: ${slug}`);
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
