/**
 * DB-backed regression for the TollBridge follow-ups (2026-07-26). MONEY-ADJACENT.
 * Requires DATABASE_URL.
 *
 * (a) SEDE SCOPE: a toll stamped with a locationId must never match a vehicle
 *     homed at a different sede (CA toll vs FL car in one tenant), and imports
 *     inherit the stamp from the provider account.
 * (b) RE-MATCH WINDOW: the sweep retries unmatched tolls inside the toll's own
 *     sede window (locationConfig.tolls.rematchWindowDays, LAX 45) while a
 *     stamp-less/short-window toll of the same age is left alone.
 * (9) STAFF ALERT: a billable toll landing on a contract claims
 *     staffNotifiedAt exactly once (idempotent across re-syncs), shows in the
 *     alerts bandeja flagged closed-contract-first, and ack clears it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { tollsService, resolveTollLocationSettings } from './tolls.service.js';

const prisma = new PrismaClient();
const TAG = `TOLLLOC-${Date.now()}`;
const ids = {
  tenant: null, locLax: null, locFl: null, customer: null,
  vLax: null, vFl: null, res: null, agr: null
};

test.after(async () => {
  await prisma.tollAssignment.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.tollTransaction.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.tollImportRun.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.tollProviderAccount.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreement: { tenantId: ids.tenant } } }).catch(() => {});
  await prisma.rentalAgreement.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.reservationCharge.deleteMany({ where: { reservation: { tenantId: ids.tenant } } }).catch(() => {});
  await prisma.reservation.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.vehicle.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.vehicleType.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  await prisma.location.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

test('setup: two-sede tenant, LAX window 45, one CLOSED rental on the LAX car', async () => {
  const tenant = await prisma.tenant.create({
    data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase(), tollsEnabled: true }
  });
  ids.tenant = tenant.id;

  const locLax = await prisma.location.create({
    data: {
      tenantId: tenant.id,
      code: `LX${TAG.slice(-6)}`,
      name: 'LAX Test',
      locationConfig: JSON.stringify({ tolls: { rematchWindowDays: 45 } })
    }
  });
  ids.locLax = locLax.id;
  const locFl = await prisma.location.create({
    data: { tenantId: tenant.id, code: `FL${TAG.slice(-6)}`, name: 'FL Test' }
  });
  ids.locFl = locFl.id;

  const customer = await prisma.customer.create({
    data: { tenantId: tenant.id, firstName: 'Toll', lastName: 'Sede', email: `sede-${TAG}@x.test`.toLowerCase(), phone: '5550003333' }
  });
  ids.customer = customer.id;

  const vehicleType = await prisma.vehicleType.create({
    data: { tenantId: tenant.id, code: `VT-${TAG}`.slice(0, 12), name: 'Sede Test Type' }
  });
  const vLax = await prisma.vehicle.create({
    data: { tenantId: tenant.id, vehicleTypeId: vehicleType.id, internalNumber: `LAX-${TAG}`, plate: `CA${TAG.slice(-5)}`, homeLocationId: locLax.id }
  });
  ids.vLax = vLax.id;
  const vFl = await prisma.vehicle.create({
    data: { tenantId: tenant.id, vehicleTypeId: vehicleType.id, internalNumber: `FL-${TAG}`, plate: `FL${TAG.slice(-5)}`, homeLocationId: locFl.id }
  });
  ids.vFl = vFl.id;

  const res = await prisma.reservation.create({
    data: {
      tenantId: tenant.id,
      reservationNumber: `R-${TAG}`,
      customerId: customer.id,
      vehicleId: vLax.id,
      pickupLocationId: locLax.id,
      returnLocationId: locLax.id,
      pickupAt: new Date('2026-07-01T10:00:00Z'),
      returnAt: new Date('2026-07-03T10:00:00Z'),
      status: 'CHECKED_IN'
    }
  });
  ids.res = res.id;
  const agr = await prisma.rentalAgreement.create({
    data: {
      tenantId: tenant.id,
      agreementNumber: `AGR-${TAG}`,
      reservationId: res.id,
      vehicleId: vLax.id,
      pickupAt: res.pickupAt,
      returnAt: res.returnAt,
      pickupLocationId: locLax.id,
      returnLocationId: locLax.id,
      customerFirstName: 'Toll',
      customerLastName: 'Sede',
      status: 'CLOSED',
      total: 0,
      balance: 0
    }
  });
  ids.agr = agr.id;

  // Provider account bound to the LAX sede: every import through it stamps.
  await prisma.tollProviderAccount.create({
    data: {
      tenantId: tenant.id,
      provider: 'AUTOEXPRESO',
      isActive: true,
      locationId: locLax.id,
      lastSyncStatus: 'READY'
    }
  });
  assert.ok(ids.vLax && ids.vFl);
});

test('pure: resolveTollLocationSettings clamps and defaults', () => {
  assert.equal(resolveTollLocationSettings({}).rematchWindowDays, 14);
  assert.equal(resolveTollLocationSettings({ tolls: { rematchWindowDays: 45 } }).rematchWindowDays, 45);
  assert.equal(resolveTollLocationSettings({ tolls: { rematchWindowDays: 9999 } }).rematchWindowDays, 120);
  assert.equal(resolveTollLocationSettings({ tolls: { alertEmail: 'not-an-email' } }).alertEmail, null);
  assert.equal(resolveTollLocationSettings({ tolls: { alertEmail: ' cobros@x.test ' } }).alertEmail, 'cobros@x.test');
  // The normal case: the sede's own email (Settings -> Locations) is the
  // recipient; tolls.alertEmail only overrides it.
  assert.equal(resolveTollLocationSettings({ locationEmail: 'sede@x.test' }).alertEmail, 'sede@x.test');
  assert.equal(
    resolveTollLocationSettings({ locationEmail: 'sede@x.test', tolls: { alertEmail: 'cobros@x.test' } }).alertEmail,
    'cobros@x.test'
  );
});

test('(a) import stamps the sede and never offers a vehicle homed elsewhere', async () => {
  const scope = { tenantId: ids.tenant };
  const out = await tollsService.createManualTransactions([
    {
      transactionAt: '2026-07-02T12:00:00Z',
      amount: 2.5,
      location: 'SR-73 Sede Test',
      plate: `FL${TAG.slice(-5)}`,
      externalId: `EXT-${TAG}-CROSS`
    },
    {
      transactionAt: '2026-07-02T13:00:00Z',
      amount: 3.1,
      location: 'SR-73 Sede Test',
      plate: `CA${TAG.slice(-5)}`,
      externalId: `EXT-${TAG}-HOME`
    }
  ], scope, null);
  assert.ok(Array.isArray(out?.created));

  const cross = await prisma.tollTransaction.findFirst({
    where: { tenantId: ids.tenant, externalId: `EXT-${TAG}-CROSS` }
  });
  assert.equal(cross.locationId, ids.locLax, 'stamp inherited from the provider account');
  assert.equal(cross.vehicleId, null, 'FL-homed car must not be offered for a LAX-stamped toll');
  assert.match(String(cross.reviewNotes || ''), /vehicle-outside-location/, 'distinct hold reason for staff');

  const home = await prisma.tollTransaction.findFirst({
    where: { tenantId: ids.tenant, externalId: `EXT-${TAG}-HOME` }
  });
  assert.equal(home.locationId, ids.locLax);
  assert.equal(home.vehicleId, ids.vLax, 'in-sede vehicle still matches normally');
});

test('(b) re-match sweep honors the per-sede window', async () => {
  const now = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

  // Same age, same shape - only the sede stamp differs. LAX window (45) makes
  // the first eligible; the stamp-less one falls under the default (14) and
  // must be left untouched.
  const seed = {
    tenantId: ids.tenant,
    transactionAt: thirtyDaysAgo,
    amount: 1.75,
    plateRaw: `CA${TAG.slice(-5)}`,
    plateNormalized: `CA${TAG.slice(-5)}`,
    status: 'NEEDS_REVIEW',
    needsReview: true,
    billingStatus: 'PENDING',
    reviewNotes: 'seeded-for-rematch',
    staffNotifiedAt: new Date(),
    staffAckAt: new Date()
  };
  const inWindow = await prisma.tollTransaction.create({
    data: { ...seed, externalId: `EXT-${TAG}-REMATCH-LAX`, locationId: ids.locLax }
  });
  const outOfWindow = await prisma.tollTransaction.create({
    data: { ...seed, externalId: `EXT-${TAG}-REMATCH-NONE`, locationId: null }
  });

  const result = await tollsService.rematchTenantWithinWindow(ids.tenant);
  assert.equal(result.ok, true);
  assert.ok(result.eligible >= 1);

  const inAfter = await prisma.tollTransaction.findUnique({ where: { id: inWindow.id } });
  assert.notEqual(inAfter.reviewNotes, 'seeded-for-rematch', 'LAX toll re-evaluated inside its 45-day window');

  const outAfter = await prisma.tollTransaction.findUnique({ where: { id: outOfWindow.id } });
  assert.equal(outAfter.reviewNotes, 'seeded-for-rematch', 'stamp-less toll stays under the conservative default window');
});

test('QA-1: RESET_MATCH parks the toll and the sweep keeps its hands off', async () => {
  const scope = { tenantId: ids.tenant };
  const home = await prisma.tollTransaction.findFirst({
    where: { tenantId: ids.tenant, externalId: `EXT-${TAG}-HOME` }
  });

  await tollsService.applyReviewAction(home.id, { action: 'RESET_MATCH', note: 'human parked this' }, scope, null);
  const held = await prisma.tollTransaction.findUnique({ where: { id: home.id } });
  assert.ok(held.manualHoldAt, 'RESET_MATCH sets the manual hold');
  assert.equal(held.needsReview, true);
  assert.match(String(held.reviewNotes || ''), /human parked this/);

  // Without the hold this row IS sweep bait: LAX stamp, 45-day window,
  // in-window transactionAt, needsReview+PENDING — and the sweep would
  // re-derive the exact match the human just rejected and re-bill it.
  await tollsService.rematchTenantWithinWindow(ids.tenant);
  const afterSweep = await prisma.tollTransaction.findUnique({ where: { id: home.id } });
  assert.ok(afterSweep.manualHoldAt, 'sweep must not clear a human hold');
  assert.equal(afterSweep.status, 'NEEDS_REVIEW', 'sweep must not resurrect the rejected match');
  assert.equal(afterSweep.reservationId, null);
  assert.match(String(afterSweep.reviewNotes || ''), /human parked this/, 'human audit note survives the sweep');
});

test('QA-4: a second sweep over a stable backlog writes NOTHING', async () => {
  const inWindow = await prisma.tollTransaction.findFirst({
    where: { tenantId: ids.tenant, externalId: `EXT-${TAG}-REMATCH-LAX` }
  });
  const assignmentsBefore = await prisma.tollAssignment.count({ where: { tenantId: ids.tenant } });

  await tollsService.rematchTenantWithinWindow(ids.tenant);

  const after = await prisma.tollTransaction.findUnique({ where: { id: inWindow.id } });
  assert.equal(
    new Date(after.updatedAt).getTime(),
    new Date(inWindow.updatedAt).getTime(),
    'unchanged suggestion must be a persistence no-op (no updatedAt churn)'
  );
  const assignmentsAfter = await prisma.tollAssignment.count({ where: { tenantId: ids.tenant } });
  assert.equal(assignmentsAfter, assignmentsBefore, 'no junk REJECT+recreate assignment rows per pass');
});

test('QA-2: multi-account tenant refuses to guess the sede on unattributed imports', async () => {
  const scope = { tenantId: ids.tenant };
  // Second account (inactive, FL-bound): resolveActiveProvider still picks the
  // AUTOEXPRESO/LAX account, but the guess is now ambiguous — an unattributed
  // import must NOT inherit LAX and bulk-hold what might be FL tolls.
  await prisma.tollProviderAccount.create({
    data: {
      tenantId: ids.tenant,
      provider: 'SUNPASS',
      isActive: false,
      locationId: ids.locFl,
      lastSyncStatus: 'READY'
    }
  });

  await tollsService.createManualTransactions([
    { transactionAt: '2026-07-02T14:00:00Z', amount: 1.25, plate: `CA${TAG.slice(-5)}`, externalId: `EXT-${TAG}-AMBIG` }
  ], scope, null);
  const ambiguous = await prisma.tollTransaction.findFirst({
    where: { tenantId: ids.tenant, externalId: `EXT-${TAG}-AMBIG` }
  });
  assert.equal(ambiguous.locationId, null, 'no stamp when the source account is a guess');

  // Explicit account: binding is authoritative even in a multi-account tenant.
  const laxAccount = await prisma.tollProviderAccount.findFirst({
    where: { tenantId: ids.tenant, provider: 'AUTOEXPRESO' }
  });
  await tollsService.createManualTransactions([
    { transactionAt: '2026-07-02T15:00:00Z', amount: 1.5, plate: `CA${TAG.slice(-5)}`, externalId: `EXT-${TAG}-EXPLICIT` }
  ], scope, null, { providerAccountId: laxAccount.id, sourceType: 'MANUAL_ENTRY' });
  const explicit = await prisma.tollTransaction.findFirst({
    where: { tenantId: ids.tenant, externalId: `EXT-${TAG}-EXPLICIT` }
  });
  assert.equal(explicit.locationId, ids.locLax, 'explicit providerAccountId still stamps');
});

test('(9) staff alert claims once, lists closed-first, ack clears', async () => {
  const scope = { tenantId: ids.tenant };
  const toll = await prisma.tollTransaction.create({
    data: {
      tenantId: ids.tenant,
      externalId: `EXT-${TAG}-ALERT`,
      transactionAt: new Date('2026-07-02T16:30:00Z'),
      amount: 4.5,
      location: 'SR-73 Alert Plaza',
      plateRaw: `CA${TAG.slice(-5)}`,
      plateNormalized: `CA${TAG.slice(-5)}`,
      locationId: ids.locLax,
      vehicleId: ids.vLax,
      reservationId: ids.res,
      status: 'MATCHED',
      billingStatus: 'PENDING'
    }
  });

  await tollsService.syncReservationCharges(ids.res, scope);
  const afterFirst = await prisma.tollTransaction.findUnique({ where: { id: toll.id } });
  assert.ok(afterFirst.staffNotifiedAt, 'first sync claims the notification');

  await tollsService.syncReservationCharges(ids.res, scope);
  const afterSecond = await prisma.tollTransaction.findUnique({ where: { id: toll.id } });
  assert.equal(
    new Date(afterSecond.staffNotifiedAt).getTime(),
    new Date(afterFirst.staffNotifiedAt).getTime(),
    'second sync must NOT re-claim (one alert per toll, ever)'
  );

  const list = await tollsService.listStaffTollAlerts(scope);
  const alert = list.alerts.find((row) => row.id === toll.id);
  assert.ok(alert, 'unacked billable toll shows in the bandeja');
  assert.equal(alert.agreementClosed, true, 'closed contract is flagged - the risk case');
  assert.equal(list.alerts[0].agreementClosed, true, 'closed contracts sort first');

  const ack = await tollsService.acknowledgeTollAlert(toll.id, scope, null);
  assert.equal(ack.ok, true);
  const listAfter = await tollsService.listStaffTollAlerts(scope);
  assert.ok(!listAfter.alerts.some((row) => row.id === toll.id), 'ack removes it from the bandeja');
});
