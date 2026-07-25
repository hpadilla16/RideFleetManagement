// Per-tenant editable T&C — tests for getEffectiveTermsHtmlForTenant.
//
// Run: `node --test src/lib/terms/index.test.mjs` from backend/. No
// Prisma client / DB required — we inject a fake prisma.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getCanonicalTermsHtml,
  getEffectiveTermsHtml,
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

// ── Per-LOCATION override (2026-07-24) ──────────────────────────────────────
//
// WHY THIS LAYER EXISTS: a multi-branch tenant can operate under different terms
// per branch. Corpusa's LAX runs on Rightcars' California agreement while its
// Orlando, Miami and Fort Lauderdale branches do not. With only the tenant slot,
// loading LAX's terms would have silently rebound the other three to a
// California agreement — which is a legal document, not a display string.

function makePrismaWithLocations(tenantsById, locationsById) {
  const pick = (row, select) => {
    if (!row) return null;
    if (!select) return row;
    return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k] ?? null]));
  };
  return {
    tenant: { async findUnique({ where, select }) { return pick(tenantsById[where?.id], select); } },
    location: { async findUnique({ where, select }) { return pick(locationsById[where?.id], select); } }
  };
}

describe('getEffectiveTermsHtml — location → tenant → canonical', () => {
  const TENANTS = { t1: { id: 't1', termsHtml: '<p>TENANT terms.</p>' } };
  const LOCATIONS = {
    lax: { id: 'lax', termsHtml: '<p>LAX branch terms. Decline: {{INITIALS_S4_DECLINE}}</p>' },
    mco: { id: 'mco', termsHtml: null },
    fll: { id: 'fll', termsHtml: '   ' } // whitespace-only must not count as set
  };

  it('CARE 1: the branch override WINS over the tenant override — the actual point', async () => {
    const prisma = makePrismaWithLocations(TENANTS, LOCATIONS);
    const html = await getEffectiveTermsHtml({ tenantId: 't1', locationId: 'lax' }, { prisma });
    assert.ok(html.includes('LAX branch terms.'));
    assert.ok(!html.includes('TENANT terms.'), 'the tenant body must not leak into a branch that overrode it');
    assert.ok(!html.includes('{{INITIALS_S4_DECLINE}}'), 'markers are substituted on the branch path too');
  });

  it('CARE 2: a branch with NO override falls back to the tenant — the other 3 branches', async () => {
    const prisma = makePrismaWithLocations(TENANTS, LOCATIONS);
    for (const loc of ['mco', 'fll']) {
      const html = await getEffectiveTermsHtml({ tenantId: 't1', locationId: loc }, { prisma });
      assert.ok(html.includes('TENANT terms.'), `${loc} must inherit the tenant terms`);
    }
  });

  it('CARE 3: no tenant override either → canonical, unchanged from today', async () => {
    const prisma = makePrismaWithLocations({ t2: { id: 't2', termsHtml: null } }, LOCATIONS);
    const html = await getEffectiveTermsHtml({ tenantId: 't2', locationId: 'mco' }, { prisma });
    assert.equal(html, getCanonicalTermsHtml({}));
  });

  it('CARE 4: an unknown location id does not blow up, it falls through', async () => {
    const prisma = makePrismaWithLocations(TENANTS, LOCATIONS);
    const html = await getEffectiveTermsHtml({ tenantId: 't1', locationId: 'does-not-exist' }, { prisma });
    assert.ok(html.includes('TENANT terms.'));
  });

  it('CARE 5: a DB error on the location lookup fails SOFT to the tenant, never throws', async () => {
    // An agreement that renders slightly generic terms beats one that will not
    // render at all — the customer is standing at the counter.
    const prisma = {
      ...makePrismaWithLocations(TENANTS, LOCATIONS),
      location: { async findUnique() { throw new Error('connection reset'); } }
    };
    const html = await getEffectiveTermsHtml({ tenantId: 't1', locationId: 'lax' }, { prisma });
    assert.ok(html.includes('TENANT terms.'));
  });

  it('CARE 6: omitting locationId reproduces the pre-2026-07-24 behaviour exactly', async () => {
    const prisma = makePrismaWithLocations(TENANTS, LOCATIONS);
    const withoutLoc = await getEffectiveTermsHtml({ tenantId: 't1' }, { prisma });
    const legacy = await getEffectiveTermsHtmlForTenant('t1', { prisma });
    assert.equal(withoutLoc, legacy);
    assert.ok(withoutLoc.includes('TENANT terms.'));
  });

  it('CARE 7: initials are substituted on every path, branch included', async () => {
    const prisma = makePrismaWithLocations(TENANTS, LOCATIONS);
    const initials = Object.fromEntries(INITIALS_KEYS.map((k) => [k, 'HP']));
    const html = await getEffectiveTermsHtml({ tenantId: 't1', locationId: 'lax' }, { prisma }, { initials });
    assert.ok(html.includes('HP'));
    assert.ok(!html.includes('{{INITIALS_S4_DECLINE}}'));
  });

  it('CARE 8: a prisma without a location delegate is tolerated (older callers/tests)', async () => {
    const prisma = { tenant: { async findUnique({ where }) { return TENANTS[where?.id] || null; } } };
    const html = await getEffectiveTermsHtml({ tenantId: 't1', locationId: 'lax' }, { prisma });
    assert.ok(html.includes('TENANT terms.'));
  });
});

// ── Branch RIDER (2026-07-24) ───────────────────────────────────────────────
//
// WHY A RIDER AND NOT THE REPLACEMENT: Corpusa's LAX source document is
// Rightcars' "Country Level Rental Policies" — a policy sheet covering mileage,
// deposits, driver age, fuel and fees. It contains NONE of the canonical
// agreement's 24 sections: no authorized use, no §11 card-on-file
// pre-authorization (the legal basis the tolls/citations modules rely on to bill
// after a rental closes), no liability release, no indemnification, no governing
// law. Loading it as a REPLACEMENT would have had every LAX renter sign an
// agreement that cannot support a post-rental charge. So the branch keeps the
// canonical base and appends only what varies locally.
describe('getEffectiveTermsHtml — branch rider', () => {
  const TENANTS = { t1: { id: 't1', termsHtml: '<p>TENANT terms.</p>' }, t2: { id: 't2', termsHtml: null } };
  const RIDER = '<h2>LAX LOCAL POLICIES</h2><p>Deposit up to $2,000.</p>';
  const LOCATIONS = {
    lax:  { id: 'lax',  termsHtml: null, termsRiderHtml: RIDER },
    both: { id: 'both', termsHtml: '<p>BRANCH replacement.</p>', termsRiderHtml: RIDER },
    bare: { id: 'bare', termsHtml: null, termsRiderHtml: null },
    ws:   { id: 'ws',   termsHtml: null, termsRiderHtml: '   ' },
  };

  it('CARE 1: rider is APPENDED to the canonical base, not a replacement', async () => {
    const prisma = makePrismaWithLocations(TENANTS, LOCATIONS);
    const html = await getEffectiveTermsHtml({ tenantId: 't2', locationId: 'lax' }, { prisma });
    // The canonical agreement must survive in full — this is the whole point.
    assert.ok(html.includes('CARD-ON-FILE PRE-AUTHORIZATION'), 'the §11 card-on-file authorization must still be there');
    assert.ok(html.includes('INDEMNIFICATION'), 'indemnification must still be there');
    assert.ok(html.includes('Deposit up to $2,000.'), 'and the branch rider is appended');
    assert.ok(html.includes('tc-location-rider'), 'wrapped so the reader can see where local policy starts');
    // Order matters: the rider reads last, so a branch figure restating a
    // general term is the one the customer reads second.
    assert.ok(html.indexOf('CARD-ON-FILE') < html.indexOf('Deposit up to $2,000.'));
  });

  it('CARE 2: rider is appended to a TENANT override too', async () => {
    const prisma = makePrismaWithLocations(TENANTS, LOCATIONS);
    const html = await getEffectiveTermsHtml({ tenantId: 't1', locationId: 'lax' }, { prisma });
    assert.ok(html.includes('TENANT terms.'));
    assert.ok(html.includes('Deposit up to $2,000.'));
  });

  it('CARE 3: rider is appended even when the branch ALSO replaces the base', async () => {
    const prisma = makePrismaWithLocations(TENANTS, LOCATIONS);
    const html = await getEffectiveTermsHtml({ tenantId: 't1', locationId: 'both' }, { prisma });
    assert.ok(html.includes('BRANCH replacement.'));
    assert.ok(html.includes('Deposit up to $2,000.'), 'replacement + rider compose');
    assert.ok(!html.includes('TENANT terms.'));
  });

  it('CARE 4: no rider (null or whitespace) changes nothing at all', async () => {
    const prisma = makePrismaWithLocations(TENANTS, LOCATIONS);
    const canonical = getCanonicalTermsHtml({});
    for (const loc of ['bare', 'ws']) {
      const html = await getEffectiveTermsHtml({ tenantId: 't2', locationId: loc }, { prisma });
      assert.equal(html, canonical, `${loc} must render byte-identical canonical`);
      assert.ok(!html.includes('tc-location-rider'), 'no empty wrapper is emitted');
    }
  });

  it('CARE 5: markers inside a rider are substituted — a rider may carry its own initials', async () => {
    const prisma = makePrismaWithLocations(TENANTS, {
      m: { id: 'm', termsHtml: null, termsRiderHtml: '<p>Local initials: {{INITIALS_S4_DECLINE}}</p>' },
    });
    const html = await getEffectiveTermsHtml({ tenantId: 't2', locationId: 'm' }, { prisma }, { initials: { INITIALS_S4_DECLINE: 'HP' } });
    assert.ok(!html.includes('{{INITIALS_S4_DECLINE}}'), 'marker substituted in the rider');
    assert.ok(html.includes('Local initials: HP'));
  });

  it('CARE 6: a DB error still yields a usable document, and no rider', async () => {
    const prisma = {
      ...makePrismaWithLocations(TENANTS, LOCATIONS),
      location: { async findUnique() { throw new Error('connection reset'); } },
    };
    const html = await getEffectiveTermsHtml({ tenantId: 't1', locationId: 'lax' }, { prisma });
    assert.ok(html.includes('TENANT terms.'), 'falls back to the tenant base');
    assert.ok(!html.includes('tc-location-rider'), 'and no half-applied rider');
  });
});
