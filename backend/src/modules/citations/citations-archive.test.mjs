/**
 * DB-backed tests for the citations Archive (LAX #11, 2026-07-28).
 * Requires DATABASE_URL. Pins: working list excludes VOID/CLOSED, the archive
 * view returns only them, an explicit valid status filter overrides the view,
 * invalid statuses (the UI used to offer "PAID") are ignored instead of
 * reaching Prisma, CLOSE is a valid review decision, and the dashboard
 * outstanding calc excludes archived money.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { citationsService, ARCHIVED_CITATION_STATUSES } from './citations.service.js';

const prisma = new PrismaClient();
const TAG = `CAR-${Date.now()}`;
const ids = { tenant: null, citations: [] };

test.after(async () => {
  await prisma.citation.deleteMany({ where: { id: { in: ids.citations } } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

async function mkCitation(citationNo, status) {
  const c = await prisma.citation.create({ data: {
    tenantId: ids.tenant, source: 'MANUAL', citationNo: `${citationNo}-${TAG}`,
    agency: 'Test PD', amount: 100, status,
    issuedAt: new Date('2026-07-01T00:00:00Z'),
  } });
  ids.citations.push(c.id);
  return c;
}

test('setup', async () => {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = t.id;
  await mkCitation('C-IMP', 'IMPORTED');
  await mkCitation('C-REV', 'NEEDS_REVIEW');
  await mkCitation('C-BIL', 'BILLED');
  await mkCitation('C-VOI', 'VOID');
  await mkCitation('C-CLO', 'CLOSED');
  assert.deepEqual([...ARCHIVED_CITATION_STATUSES], ['VOID', 'CLOSED']);
});

test('working list (default) excludes VOID and CLOSED', async () => {
  const out = await citationsService.list({}, { tenantId: ids.tenant });
  const statuses = out.rows.map((r) => r.status).sort();
  assert.deepEqual(statuses, ['BILLED', 'IMPORTED', 'NEEDS_REVIEW']);
  assert.equal(out.total, 3, 'total counts the working set only');
});

test('view=archive returns only VOID and CLOSED', async () => {
  const out = await citationsService.list({ view: 'archive' }, { tenantId: ids.tenant });
  const statuses = out.rows.map((r) => r.status).sort();
  assert.deepEqual(statuses, ['CLOSED', 'VOID']);
});

test('an explicit VALID status filter overrides the view default', async () => {
  const out = await citationsService.list({ status: 'VOID' }, { tenantId: ids.tenant });
  assert.deepEqual(out.rows.map((r) => r.status), ['VOID']);
});

test('an INVALID status (the old "PAID" option) is ignored, not sent to Prisma', async () => {
  const out = await citationsService.list({ status: 'PAID' }, { tenantId: ids.tenant });
  assert.equal(out.total, 3, 'falls back to the working default instead of 500ing');
});

test('review CLOSE transitions to CLOSED (and lands in the archive)', async () => {
  const target = await mkCitation('C-TOCLOSE', 'MATCHED');
  const updated = await citationsService.review(target.id, { decision: 'CLOSE', note: 'paid at agency' }, { tenantId: ids.tenant });
  assert.equal(updated.status, 'CLOSED');
  const archive = await citationsService.list({ view: 'archive' }, { tenantId: ids.tenant });
  assert.ok(archive.rows.some((r) => r.id === target.id));
});

test('dashboard outstanding excludes archived money', async () => {
  const summary = await citationsService.dashboardSummary({ tenantId: ids.tenant });
  // Working set after the CLOSE above: IMPORTED + NEEDS_REVIEW + BILLED = 3 x $100.
  assert.equal(summary.outstanding, 300);
});
