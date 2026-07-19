/**
 * VozIA gap #4 — Customer.phoneNormalized end-to-end (embedded-postgres).
 *
 * Proves against a REAL Postgres that:
 *   - the customerPhoneNormalize Prisma extension derives phoneNormalized on create/update;
 *   - customersService.list() matches a digits-only query against the stored formatted phone;
 *   - a non-phone update leaves phoneNormalized untouched.
 *
 * Run:  npm install --no-save embedded-postgres  (once)
 *       node --test --test-force-exit src/modules/customers/customer-phone-normalize.embedded.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootEmbeddedPg } from '../../../scripts/embedded-pg-boot.mjs';

// Imported dynamically AFTER bootEmbeddedPg sets DATABASE_URL (the shared prisma
// singleton binds its URL at import time).
let prisma;
let customersService;
let pgHandle;

let T; // tenant id (created in before)
let custId;

describe('Customer.phoneNormalized (embedded pg)', () => {
  before(async () => {
    pgHandle = await bootEmbeddedPg();
    ({ prisma } = await import('../../lib/prisma.js')); // extended singleton -> embedded DB
    ({ customersService } = await import('./customers.service.js'));
    const slug = `pn-${Date.now()}`;
    const tenant = await prisma.tenant.create({ data: { name: 'PhoneNorm Test', slug } });
    T = tenant.id;
  });

  after(async () => {
    if (pgHandle) await pgHandle.stop();
  });

  it('derives phoneNormalized on create (via the extension)', async () => {
    const created = await prisma.customer.create({
      data: { firstName: 'Voice', lastName: 'Caller', phone: '(787) 555-1234', tenantId: T },
    });
    custId = created.id;
    const row = await prisma.customer.findUnique({ where: { id: custId } });
    assert.equal(row.phoneNormalized, '7875551234');
  });

  it('search finds the customer by a formatted digits query', async () => {
    const rows = await customersService.list({ tenantId: T }, { query: '787-555-1234' });
    assert.ok(rows.some((r) => r.id === custId), 'formatted-digits query should match');
  });

  it('search finds the customer by a partial digit run', async () => {
    const rows = await customersService.list({ tenantId: T }, { query: '5551234' });
    assert.ok(rows.some((r) => r.id === custId), 'partial digits should match via substring');
  });

  it('search does NOT match an unrelated digit string', async () => {
    const rows = await customersService.list({ tenantId: T }, { query: '9990000' });
    assert.equal(rows.some((r) => r.id === custId), false);
  });

  it('re-derives phoneNormalized on a phone update', async () => {
    await prisma.customer.update({ where: { id: custId }, data: { phone: '+1 (305) 000-1111' } });
    const row = await prisma.customer.findUnique({ where: { id: custId } });
    assert.equal(row.phoneNormalized, '13050001111');
  });

  it('leaves phoneNormalized untouched on a non-phone update', async () => {
    await prisma.customer.update({ where: { id: custId }, data: { city: 'San Juan' } });
    const row = await prisma.customer.findUnique({ where: { id: custId } });
    assert.equal(row.phoneNormalized, '13050001111'); // unchanged from previous test
  });
});
