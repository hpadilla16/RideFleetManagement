/**
 * DB-backed tests for LOCATION scoping of locationsService.update (2026-07-24).
 * Requires DATABASE_URL.
 *
 * WHY THIS EXISTS: `update()` filtered by tenantId alone, so a branch-restricted
 * ADMIN — a role that has existed since beta.338 — could PATCH ANY location in
 * the tenant. That was already wrong for `taxRate` and `locationConfig`. It got
 * sharper when `termsHtml` landed on this row, because that column REPLACES the
 * entire rental agreement body for the branch: a LAX admin could have rewritten
 * Orlando's contract.
 *
 * It also pins the shape of the guard. The first version of this fix spread the
 * allowed ids into the Prisma `where` as a second `id` key — which silently
 * OVERWRITES the first, turning "this location, if allowed" into "any allowed
 * location". CARE 2 is what catches that: it asserts the row that actually
 * changed is the requested one, not merely that the call succeeded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { locationsService } from './locations.service.js';

const prisma = new PrismaClient();
const TAG = `LOCSCOPE-${Date.now()}`;
const ids = { tenant: null, lax: null, mco: null };

let scopedToLax = null;   // branch admin, restricted to LAX
let unrestricted = null;  // tenant admin

test.after(async () => {
  for (const l of [ids.lax, ids.mco]) if (l) await prisma.location.delete({ where: { id: l } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

test('setup: one tenant, two branches', async () => {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = t.id;
  const [lax, mco] = await Promise.all([
    prisma.location.create({ data: { tenantId: t.id, code: `LAX-${TAG}`.slice(0, 12), name: 'Los Angeles' } }),
    prisma.location.create({ data: { tenantId: t.id, code: `MCO-${TAG}`.slice(0, 12), name: 'Orlando' } })
  ]);
  ids.lax = lax.id; ids.mco = mco.id;
  scopedToLax = { tenantId: t.id, allowedLocationIds: [lax.id] };
  unrestricted = { tenantId: t.id, allowedLocationIds: null };
  assert.ok(ids.lax && ids.mco);
});

test('CARE 1: a branch admin CANNOT rewrite another branch terms', async () => {
  await assert.rejects(
    () => locationsService.update(ids.mco, { termsHtml: '<p>HIJACKED</p>' }, scopedToLax),
    /not found/i,
    'a LAX admin must not be able to PATCH Orlando'
  );
  const mco = await prisma.location.findUnique({ where: { id: ids.mco }, select: { termsHtml: true } });
  assert.equal(mco.termsHtml, null, 'and nothing must have been written');
});

test('CARE 2: the guard targets the REQUESTED row, not just any allowed one', async () => {
  // The bug this catches: putting the allowed ids into the `where` as a second
  // `id` key overwrites the first, so update(mco) would happily resolve to lax.
  await assert.rejects(
    () => locationsService.update(ids.mco, { name: 'Renamed by the wrong branch' }, scopedToLax),
    /not found/i
  );
  const [lax, mco] = await Promise.all([
    prisma.location.findUnique({ where: { id: ids.lax }, select: { name: true } }),
    prisma.location.findUnique({ where: { id: ids.mco }, select: { name: true } })
  ]);
  assert.equal(lax.name, 'Los Angeles', 'the ALLOWED branch must not absorb an update aimed at another');
  assert.equal(mco.name, 'Orlando');
});

test('CARE 3: a branch admin CAN still edit its own branch', async () => {
  const out = await locationsService.update(ids.lax, { termsHtml: '<p>LAX terms</p>' }, scopedToLax);
  assert.ok(out, 'own-branch update succeeds');
  const lax = await prisma.location.findUnique({ where: { id: ids.lax }, select: { termsHtml: true } });
  assert.equal(lax.termsHtml, '<p>LAX terms</p>');
});

test('CARE 4: an unrestricted tenant admin still edits any branch — no regression', async () => {
  await locationsService.update(ids.mco, { termsHtml: '<p>MCO terms</p>' }, unrestricted);
  const mco = await prisma.location.findUnique({ where: { id: ids.mco }, select: { termsHtml: true } });
  assert.equal(mco.termsHtml, '<p>MCO terms</p>');
});
