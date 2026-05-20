// Per-tenant editable T&C — tests for getEffectiveTermsHtmlForTenant.
//
// Run: `node --test src/lib/terms/index.test.mjs` from backend/. No
// Prisma client / DB required — we inject a fake prisma.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getCanonicalTermsHtml,
  getEffectiveTermsHtmlForTenant,
  INITIALS_KEYS
} from './index.js';

function makePrisma(tenantsById) {
  return {
    tenant: {
      async findUnique({ where, select }) {
        const row = tenantsById[where?.id];
        if (!row) return null;
        if (!select) return row;
        return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k] ?? null]));
      }
    }
  };
}

describe('getEffectiveTermsHtmlForTenant', () => {
  it('returns tenant.termsHtml verbatim (markers substituted) when set', async () => {
    const prisma = makePrisma({
      't1': { id: 't1', termsHtml: '<p>Custom tenant terms.</p><p>Decline: {{INITIALS_S4_DECLINE}}</p>' }
    });
    const html = await getEffectiveTermsHtmlForTenant('t1', { prisma });
    assert.ok(html.includes('Custom tenant terms.'));
    // marker placeholder must be replaced
    assert.ok(!html.includes('{{INITIALS_S4_DECLINE}}'));
    // default blank ___ underscores rendered
    assert.ok(html.includes('___'));
  });

  it('substitutes supplied initials in the override path', async () => {
    const prisma = makePrisma({
      't1': { id: 't1', termsHtml: 'A {{INITIALS_S4_DECLINE}} B {{INITIALS_S11_CARD_ON_FILE}}' }
    });
    const html = await getEffectiveTermsHtmlForTenant('t1', { prisma }, {
      initials: {
        INITIALS_S4_DECLINE: 'HP',
        INITIALS_S11_CARD_ON_FILE: 'HP'
      }
    });
    assert.ok(html.includes('A HP B HP'));
  });

  it('html-escapes supplied initials in the override path', async () => {
    const prisma = makePrisma({
      't1': { id: 't1', termsHtml: 'x {{INITIALS_S4_DECLINE}} y' }
    });
    const html = await getEffectiveTermsHtmlForTenant('t1', { prisma }, {
      initials: { INITIALS_S4_DECLINE: '<script>x</script>' }
    });
    assert.ok(!html.includes('<script>x</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('falls back to canonical when tenant.termsHtml is null', async () => {
    const prisma = makePrisma({ 't1': { id: 't1', termsHtml: null } });
    const html = await getEffectiveTermsHtmlForTenant('t1', { prisma });
    assert.equal(html, getCanonicalTermsHtml());
  });

  it('falls back to canonical when tenant.termsHtml is an empty string', async () => {
    const prisma = makePrisma({ 't1': { id: 't1', termsHtml: '   ' } });
    const html = await getEffectiveTermsHtmlForTenant('t1', { prisma });
    assert.equal(html, getCanonicalTermsHtml());
  });

  it('falls back to canonical when the tenant row does not exist', async () => {
    const prisma = makePrisma({});
    const html = await getEffectiveTermsHtmlForTenant('missing', { prisma });
    assert.equal(html, getCanonicalTermsHtml());
  });

  it('falls back to canonical when tenantId is falsy', async () => {
    const prisma = makePrisma({ 't1': { id: 't1', termsHtml: 'override' } });
    const html = await getEffectiveTermsHtmlForTenant(null, { prisma });
    assert.equal(html, getCanonicalTermsHtml());
  });

  it('falls back to canonical when prisma is missing', async () => {
    const html = await getEffectiveTermsHtmlForTenant('t1');
    assert.equal(html, getCanonicalTermsHtml());
  });

  it('falls back to canonical when prisma.tenant.findUnique throws', async () => {
    const prisma = {
      tenant: { findUnique: async () => { throw new Error('boom'); } }
    };
    const html = await getEffectiveTermsHtmlForTenant('t1', { prisma });
    assert.equal(html, getCanonicalTermsHtml());
  });

  it('canonical fallback still substitutes initials correctly', async () => {
    const prisma = makePrisma({});
    const html = await getEffectiveTermsHtmlForTenant('missing', { prisma }, {
      initials: {
        INITIALS_S4_DECLINE: 'HP',
        INITIALS_S11_CARD_ON_FILE: 'HP',
        INITIALS_S11_CNP: 'HP',
        INITIALS_S11_NO_CHARGEBACK: 'HP',
        INITIALS_S13_POST_RENTAL: 'HP'
      }
    });
    for (const key of INITIALS_KEYS) {
      assert.ok(!html.includes(`{{${key}}}`), `marker ${key} should be substituted`);
    }
    assert.ok((html.match(/\bHP\b/g) || []).length >= 5);
  });
});
