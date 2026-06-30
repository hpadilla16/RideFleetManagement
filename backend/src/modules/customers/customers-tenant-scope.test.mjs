/**
 * DB-backed tenant-isolation tests for the customers module (P0 security fix).
 * Requires DATABASE_URL. Seeds two tenants, each with one customer.
 *
 * Asserts the FAIL-CLOSED contract introduced when the local scopeFor was
 * replaced with the shared lib/tenant-scope.js helper:
 *   (a) a scoped tenant only sees its OWN customers;
 *   (b) a request with NO tenant scope (non-super-admin, no tenantId) does NOT
 *       return another tenant's customers (deny-all sentinel, not global);
 *   (c) create() ignores a body-supplied tenantId and uses the scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { customersService } from './customers.service.js';
import { scopeFor } from '../../lib/tenant-scope.js';

const prisma = new PrismaClient();
const TAG = `CTS-${Date.now()}`;
const ids = { tenantA: null, tenantB: null, custA: null, custB: null, created: [] };

test.after(async () => {
  for (const id of ids.created) await prisma.customer.delete({ where: { id } }).catch(() => {});
  if (ids.custA) await prisma.customer.delete({ where: { id: ids.custA } }).catch(() => {});
  if (ids.custB) await prisma.customer.delete({ where: { id: ids.custB } }).catch(() => {});
  if (ids.tenantA) await prisma.tenant.delete({ where: { id: ids.tenantA } }).catch(() => {});
  if (ids.tenantB) await prisma.tenant.delete({ where: { id: ids.tenantB } }).catch(() => {});
  await prisma.$disconnect();
});

async function seed() {
  const a = await prisma.tenant.create({ data: { name: `TA ${TAG}`, slug: `ta-${TAG}`.toLowerCase() } });
  const b = await prisma.tenant.create({ data: { name: `TB ${TAG}`, slug: `tb-${TAG}`.toLowerCase() } });
  ids.tenantA = a.id; ids.tenantB = b.id;
  const ca = await prisma.customer.create({ data: { firstName: 'Alice', lastName: `A-${TAG}`, phone: `787000${String(Date.now()).slice(-4)}`, tenantId: a.id } });
  const cb = await prisma.customer.create({ data: { firstName: 'Bob', lastName: `B-${TAG}`, phone: `939000${String(Date.now()).slice(-4)}`, tenantId: b.id } });
  ids.custA = ca.id; ids.custB = cb.id;
}

// Build a scope the way the routes do: scopeFor(req) from the shared helper.
function scopeForUser(user, query = {}) {
  return scopeFor({ user, query });
}

test('seed two tenants', async () => {
  await seed();
  assert.ok(ids.custA && ids.custB);
});

test('(a) scoped tenant only sees its own customers', async () => {
  const scopeA = scopeForUser({ role: 'ADMIN', tenantId: ids.tenantA });
  const rows = await customersService.list(scopeA, { limit: 5000 });
  const idsReturned = rows.map((r) => r.id);
  assert.ok(idsReturned.includes(ids.custA), 'tenant A sees its own customer');
  assert.ok(!idsReturned.includes(ids.custB), 'tenant A must NOT see tenant B customer');

  // getById across tenants is denied
  const cross = await customersService.getById(ids.custB, scopeA);
  assert.equal(cross, null, 'tenant A cannot fetch tenant B customer by id');
});

test('(b) no-tenant request is denied, not global', async () => {
  // non-super-admin with NO tenantId -> deny-all sentinel scope
  const scopeNone = scopeForUser({ role: 'ADMIN' /* no tenantId */ });
  assert.equal(scopeNone.tenantId, '__no_tenant__', 'fail-closed sentinel scope');
  const rows = await customersService.list(scopeNone, { limit: 5000 });
  const idsReturned = rows.map((r) => r.id);
  assert.ok(!idsReturned.includes(ids.custA), 'no-tenant request does not leak tenant A');
  assert.ok(!idsReturned.includes(ids.custB), 'no-tenant request does not leak tenant B');

  const got = await customersService.getById(ids.custA, scopeNone);
  assert.equal(got, null, 'no-tenant request cannot fetch any customer by id');
});

test('(c) create ignores a body-supplied tenantId', async () => {
  const scopeA = scopeForUser({ role: 'ADMIN', tenantId: ids.tenantA });
  // Attacker tries to plant the customer into tenant B via the body.
  const created = await customersService.create(
    { firstName: 'Mallory', lastName: `M-${TAG}`, phone: `111000${String(Date.now()).slice(-4)}`, tenantId: ids.tenantB },
    scopeA
  );
  ids.created.push(created.id);
  assert.equal(created.tenantId, ids.tenantA, 'create uses scope tenant, not the body tenantId');
});
