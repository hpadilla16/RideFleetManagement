/**
 * Partnerships module — DB-free suite (2026-09-05). Run: npm run test:partnerships
 *
 *   1. Sanitizer: scripts / handlers / javascript: URLs never survive; the
 *      allowlist does; landing text fields are plain text.
 *   2. Rules: slug / program code normalization, effective status inside the
 *      validity window, publish readiness per vehicle mode, discount math.
 *   3. Module gating: partnerships is tenant opt-in (entitlement is the ceiling),
 *      ADMIN/OPS on by default, agents/hosts off — and the tenant-config selects
 *      carry partnershipsEnabled (the beta.307 trap).
 *   4. Isolation drift guards (source-level, on purpose): every non-partner
 *      AdditionalService catalog filters partnerId: null, and rates.service.js has
 *      no `purpose: { not: 'LOANER' }` left — a partner price book must never be a
 *      candidate on the ordinary quote path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sanitizePartnerHtml,
  sanitizePartnerText,
  sanitizeLocalizedHtml,
  sanitizeLandingJson
} from './partner-sanitize.js';
import {
  normalizeSlug,
  normalizeProgramCode,
  partnerRateCode,
  effectiveStatus,
  publishReadiness,
  applyDiscount,
  hostedUrl,
  qrUrl
} from './partner-rules.js';
import {
  MODULE_KEYS,
  roleAllowedModuleMap,
  defaultTenantModuleConfig
} from '../../lib/module-access.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// ---------------------------------------------------------------- sanitizer
test('sanitizer strips scripts, event handlers and javascript: links, keeps the allowlist', () => {
  const dirty = '<p onclick="x()">Hola <script>alert(1)</script><strong>asegurado</strong> ' +
    '<a href="javascript:alert(1)">mal</a> <a href="https://rentandgopr.com/legal">bien</a> ' +
    '<img src=x onerror=alert(1)> <style>p{}</style></p><h2>Términos</h2><ul><li>uno</li></ul>';
  const out = sanitizePartnerHtml(dirty);
  assert.ok(!/script/i.test(out), 'script tag removed');
  assert.ok(!/onclick|onerror/i.test(out), 'event handlers removed');
  assert.ok(!/javascript:/i.test(out), 'javascript: href removed');
  assert.ok(!/<img|<style/i.test(out), 'img/style removed');
  assert.ok(out.includes('<strong>asegurado</strong>'), 'strong kept');
  assert.ok(out.includes('href="https://rentandgopr.com/legal"'), 'https link kept');
  assert.ok(out.includes('rel="noopener noreferrer"'), 'links get rel');
  assert.ok(out.includes('<h2>Términos</h2>') && out.includes('<li>uno</li>'), 'headings and lists kept');
});

test('sanitizer: text fields are plain text, localized shape is always {es,en}', () => {
  assert.equal(sanitizePartnerText('<b>Hola</b>  <script>x</script> mundo'), 'Hola mundo');
  assert.equal(sanitizePartnerText(null), '');
  // Plain text must come back DECODED: sanitize-html re-escapes text nodes.
  assert.equal(sanitizePartnerText('Seguros Múltiples & Asociados'), 'Seguros Múltiples & Asociados');
  assert.equal(sanitizePartnerText('Tom &amp; Jerry <3'), 'Tom & Jerry <3');
  assert.equal(normalizeSlug(sanitizePartnerText('Seguros & Asociados')), 'seguros-asociados');
  assert.deepEqual(sanitizeLocalizedHtml({ es: '<p>a</p>', fr: 'x' }), { es: '<p>a</p>', en: '' });
  const landing = sanitizeLandingJson({
    es: { heroTitle: '<i>Tarifas</i>', benefits: [{ icon: 'evil', title: '<b>Uno</b>', body: 'b' }, { title: '' }] }
  });
  assert.equal(landing.es.heroTitle, 'Tarifas');
  assert.deepEqual(landing.es.benefits, [{ icon: 'check', title: 'Uno', body: 'b' }]);
  assert.deepEqual(landing.en.benefits, []);
});

// -------------------------------------------------------------------- rules
test('slug / code / rateCode normalization', () => {
  assert.equal(normalizeSlug('  Seguros Isla  '), 'seguros-isla');
  assert.equal(normalizeSlug('Cooperativa Múltiple #1'), 'cooperativa-multiple-1');
  assert.equal(normalizeProgramCode('isla 26'), 'ISLA26');
  assert.equal(normalizeProgramCode('ab'), '', 'too short → empty');
  assert.equal(partnerRateCode('Seguros Isla'), 'PARTNER-SEGUROS-ISLA');
});

test('effectiveStatus honors the validity window only for ACTIVE programs', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  assert.equal(effectiveStatus({ status: 'ACTIVE' }, now), 'ACTIVE');
  assert.equal(effectiveStatus({ status: 'ACTIVE', validFrom: '2026-11-01' }, now), 'NOT_STARTED');
  assert.equal(effectiveStatus({ status: 'ACTIVE', validTo: '2026-10-01' }, now), 'EXPIRED');
  assert.equal(effectiveStatus({ status: 'ACTIVE', validFrom: '2026-10-01', validTo: '2026-12-31' }, now), 'ACTIVE');
  assert.equal(effectiveStatus({ status: 'PAUSED', validFrom: '2026-10-01' }, now), 'PAUSED');
  assert.equal(effectiveStatus({ status: 'DRAFT' }, now), 'DRAFT');
});

test('publishReadiness: what blocks Publish per vehicle mode', () => {
  const base = { name: 'Seguros Isla', slug: 'seguros-isla', code: 'ISLA26', termsJson: { es: '<p>t</p>' }, rateId: 'r1' };
  assert.deepEqual(publishReadiness({ ...base }, { pricedClassCount: 2 }).missing, []);
  assert.deepEqual(publishReadiness({ ...base }, { pricedClassCount: 0 }).missing, ['pricing'], 'a book with no priced class is not a price');
  assert.deepEqual(publishReadiness({ ...base, rateId: null, discountPct: 12 }, {}).missing, []);
  assert.deepEqual(publishReadiness({ ...base, rateId: null }, {}).missing, ['pricing']);
  assert.deepEqual(publishReadiness({ ...base, termsJson: {} }, { pricedClassCount: 1 }).missing, ['terms']);
  // Insurance preference flow: needs INSURANCE kind, ≥1 type, and a disclosure.
  const pref = { ...base, vehicleMode: 'PREFERRED_TYPE', kind: 'INSURANCE', allowedVehicleTypeIds: ['vt1'], coverageDisclosureJson: { es: '<p>x</p>' } };
  assert.deepEqual(publishReadiness(pref, { pricedClassCount: 1 }).missing, []);
  assert.deepEqual(publishReadiness({ ...pref, kind: 'HOTEL' }, { pricedClassCount: 1 }).missing, ['vehicleMode']);
  assert.deepEqual(publishReadiness({ ...pref, allowedVehicleTypeIds: [] }, { pricedClassCount: 1 }).missing, ['vehicles']);
  assert.deepEqual(publishReadiness({ ...pref, coverageDisclosureJson: {} }, { pricedClassCount: 1 }).missing, ['disclosure']);
  // Assign at pickup: needs a default class.
  assert.deepEqual(publishReadiness({ ...base, vehicleMode: 'ASSIGN_AT_PICKUP' }, { pricedClassCount: 1 }).missing, ['vehicles']);
  assert.deepEqual(publishReadiness({ ...base, vehicleMode: 'ASSIGN_AT_PICKUP', defaultVehicleTypeId: 'vt1' }, { pricedClassCount: 1 }).missing, []);
});

test('applyDiscount is an effective daily rate, rounded, never negative', () => {
  assert.equal(applyDiscount(52, 12), 45.76);
  assert.equal(applyDiscount(52, 0), 52);
  assert.equal(applyDiscount(52, 150), 0, 'capped at 100%');
  assert.equal(applyDiscount(0, 12), 0);
  assert.equal(applyDiscount('43.69', '13'), 38.01);
});

test('hostedUrl: tenant domain wins, RFM fallback otherwise; QR carries utm', () => {
  assert.equal(hostedUrl({ hostedBaseUrl: 'https://partners.rentandgopr.com/', tenantSlug: 'rent-by-vphmotors', slug: 'Seguros Isla', appBaseUrl: 'https://ridefleetmanager.com' }), 'https://partners.rentandgopr.com/seguros-isla');
  assert.equal(hostedUrl({ hostedBaseUrl: null, tenantSlug: 'rent-by-vphmotors', slug: 'seguros-isla', appBaseUrl: 'https://ridefleetmanager.com/' }), 'https://ridefleetmanager.com/p/rent-by-vphmotors/seguros-isla');
  assert.equal(qrUrl('https://partners.rentandgopr.com/seguros-isla'), 'https://partners.rentandgopr.com/seguros-isla?utm_source=qr&utm_medium=print');
});

// ------------------------------------------------------------ module gating
test('module gating: partnerships is registered, ADMIN/OPS on, AGENT/host off, tenant opt-in is the ceiling', () => {
  assert.ok(MODULE_KEYS.includes('partnerships'));
  assert.equal(roleAllowedModuleMap('ADMIN').partnerships, true);
  assert.equal(roleAllowedModuleMap('OPS').partnerships, true);
  assert.equal(roleAllowedModuleMap('AGENT').partnerships, false);
  assert.equal(roleAllowedModuleMap({ role: 'AGENT', hostProfileId: 'h1' }).partnerships, false);
  assert.equal(defaultTenantModuleConfig({ partnershipsEnabled: false }).partnerships, false);
  assert.equal(defaultTenantModuleConfig({ partnershipsEnabled: true }).partnerships, true);
  assert.equal(defaultTenantModuleConfig(null).partnerships, false, 'no tenant → off');
});

test('module gating: the tenant-config selects carry partnershipsEnabled (beta.307 trap)', () => {
  const src = read('lib/module-access.js');
  const selects = src.match(/select: \{[^}]*marketIntelligenceEnabled: true[^}]*\}/g) || [];
  assert.ok(selects.length >= 2, 'both getTenantModuleConfig and updateTenantModuleConfig select tenant flags');
  for (const block of selects) assert.ok(block.includes('partnershipsEnabled: true'), `select block is missing partnershipsEnabled: ${block}`);
  assert.ok(/partnerships: !!parsed\.partnerships && !!tenant\?\.partnershipsEnabled/.test(src), 'normalize clamps to the entitlement');
});

// --------------------------------------------------------- isolation guards
test('isolation: every non-partner AdditionalService catalog filters partnerId: null', () => {
  const catalogs = [
    ['modules/booking-engine/booking-engine.service.js', 2],
    ['modules/kiosk/kiosk-offers.service.js', 2],
    ['modules/customer-portal/customer-portal.routes.js', 1],
    ['modules/reservations/reservations.routes.js', 1],
    ['modules/additional-services/additional-services.service.js', 1]
  ];
  for (const [rel, expected] of catalogs) {
    const src = read(rel);
    if (rel.endsWith('additional-services.service.js')) {
      // The admin list builds its `where` in list() and hands it to a wrapper, so
      // the guard sits next to the where-builder, not next to findMany.
      assert.ok(src.includes('includePartnerOnly ? {} : { partnerId: null }'), `${rel}: admin list must hide partner-only services unless asked`);
      continue;
    }
    const hits = src.split('additionalService.findMany(').slice(1);
    const guarded = hits.filter((chunk) => /partnerId:\s*null/.test(chunk.slice(0, 700)));
    assert.ok(guarded.length >= expected, `${rel}: expected ≥${expected} guarded catalogs, found ${guarded.length}`);
  }
});

test('isolation: no rental quote path may consider a PARTNER (or LOANER) price book', () => {
  const src = read('modules/rates/rates.service.js');
  assert.equal((src.match(/purpose: \{ not: 'LOANER' \}/g) || []).length, 0, 'every LOANER-only filter was widened to notIn LOANER+PARTNER');
  assert.ok((src.match(/purpose: \{ notIn: \['LOANER', 'PARTNER'\] \}/g) || []).length >= 4, 'four widened filters present');
  assert.ok(src.includes("{ id: partnerRateId, purpose: 'PARTNER' }"), 'resolveForRental(options.rateId) selects only that PARTNER book');
  assert.ok(src.includes('if (partnerRateId && !scope?.tenantId) return null;'), 'partner quote without a tenant in scope is refused');
});

test('isolation: MI auto-apply, PricingRule and the long-term monthly fallback never target a PARTNER book', () => {
  for (const rel of [
    'modules/market-scraper/market-scrape-profile.service.js',
    'modules/pricing-suggestions/pricing-suggestions.routes.js',
    'modules/long-term/long-term.service.js'
  ]) {
    assert.ok(read(rel).includes("purpose: { notIn: ['LOANER', 'PARTNER'] }"), `${rel} must exclude partner/loaner books`);
  }
});
