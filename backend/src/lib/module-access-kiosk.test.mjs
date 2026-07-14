/**
 * Kiosk module-access fail-closed tests (QA rider from Fase B1, 2026-07-05).
 * Run via: npm run test:kiosk
 *
 * The kiosk module is OPT-IN per tenant (Hector, 2026-07-04). The dangerous
 * trap: normalizeBooleanMap treats MISSING keys as true, so a tenant whose
 * stored moduleAccess config predates the kiosk module would silently flip
 * ON without the explicit-true guard. These tests pin that behavior.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from './prisma.js';
import {
  MODULE_KEYS,
  MODULE_LABELS,
  roleAllowedModuleMap,
  defaultTenantModuleConfig,
  getTenantModuleConfig,
} from './module-access.js';

function stubTenantConfig(storedConfig) {
  prisma.tenant.findUnique = async () => ({
    id: 't1',
    carSharingEnabled: false,
    dealershipLoanerEnabled: false,
    tollsEnabled: false,
    marketIntelligenceEnabled: false,
  });
  prisma.appSetting.findUnique = async () => (
    storedConfig === null ? null : { value: JSON.stringify(storedConfig) }
  );
}

test('kiosk is a registered module with a label and a default-OFF tenant default', () => {
  assert.ok(MODULE_KEYS.includes('kiosk'));
  assert.equal(MODULE_LABELS.kiosk, 'Kiosk');
  assert.equal(defaultTenantModuleConfig(null).kiosk, false);
  assert.equal(defaultTenantModuleConfig({ carSharingEnabled: true, tollsEnabled: true }).kiosk, false);
});

test('legacy stored config WITHOUT a kiosk key stays OFF (missing key must not mean true)', async () => {
  stubTenantConfig({ reservations: true, vehicles: true, citations: true });
  const cfg = await getTenantModuleConfig('t1');
  assert.equal(cfg.kiosk, false, 'pre-kiosk stored config must not silently enable kiosk');
  // and the guard does not disturb its neighbors
  assert.equal(cfg.reservations, true);
  assert.equal(cfg.citations, true);
});

test('explicit kiosk:true in the stored config turns it ON; explicit false stays OFF', async () => {
  stubTenantConfig({ kiosk: true });
  assert.equal((await getTenantModuleConfig('t1')).kiosk, true);

  stubTenantConfig({ kiosk: false });
  assert.equal((await getTenantModuleConfig('t1')).kiosk, false);

  // no stored config at all → OFF
  stubTenantConfig(null);
  assert.equal((await getTenantModuleConfig('t1')).kiosk, false);
});

test('tenantless fallback keeps kiosk OFF while other modules stay enabled', async () => {
  const cfg = await getTenantModuleConfig(null);
  assert.equal(cfg.kiosk, false);
  assert.equal(cfg.reservations, true);
  assert.equal(cfg.vehicles, true);
  assert.equal(cfg.carSharing, true);
});

test('role maps: kiosk ON for ADMIN/OPS/SUPER_ADMIN, OFF for staff + hosts; neighbors unchanged', () => {
  assert.equal(roleAllowedModuleMap('ADMIN').kiosk, true);
  assert.equal(roleAllowedModuleMap('OPS').kiosk, true);
  assert.equal(roleAllowedModuleMap('SUPER_ADMIN').kiosk, true);
  assert.equal(roleAllowedModuleMap('AGENT').kiosk, false);
  assert.equal(roleAllowedModuleMap({ role: 'ADMIN', hostProfileId: 'h1' }).kiosk, false);

  // spot-check that adding kiosk didn't shift the existing maps
  assert.equal(roleAllowedModuleMap('ADMIN').citations, true);
  assert.equal(roleAllowedModuleMap('ADMIN').tenants, false);
  assert.equal(roleAllowedModuleMap('OPS').people, false);
  assert.equal(roleAllowedModuleMap('AGENT').reports, false);
  assert.equal(roleAllowedModuleMap('AGENT').reservations, true);
});

test('role maps: marketIntelligence allowed for ADMIN/OPS/AGENT + SUPER_ADMIN, OFF for hosts', () => {
  // Regression for the bug where marketIntelligence was in MODULE_KEYS but omitted
  // from every non-super-admin role map, so an ADMIN could never enable it even
  // when the tenant had marketIntelligenceEnabled=true (2026-07-14).
  assert.equal(roleAllowedModuleMap('SUPER_ADMIN').marketIntelligence, true);
  assert.equal(roleAllowedModuleMap('ADMIN').marketIntelligence, true);
  assert.equal(roleAllowedModuleMap('OPS').marketIntelligence, true);
  assert.equal(roleAllowedModuleMap('AGENT').marketIntelligence, true);
  assert.equal(roleAllowedModuleMap({ role: 'ADMIN', hostProfileId: 'h1' }).marketIntelligence, false);
});
