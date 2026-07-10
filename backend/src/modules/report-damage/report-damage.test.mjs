/**
 * DB-backed tests for the Report Damage orchestrator (Feature 3, 2026-07-10).
 * Requires DATABASE_URL. Seeds its own tenant/vehicle/customer/location/reservation/agreement.
 *
 * Asserts the MONEY + access-control contract:
 *  - creates a HARD_APPROVED VehicleDamageReport (reservation context on it),
 *  - puts EXACTLY ONE DAMAGE_CHARGE on the contract (balance moves by the cost for
 *    CUSTOMER/CUSTOMER_INSURANCE, by the deductible for OUR_INSURANCE),
 *  - sets the vehicle status,
 *  - auto-creates an incident DRAFT that REFERENCES the charge (chargeIdsJson) and
 *    does NOT double-bill (still one DAMAGE_CHARGE, balance unchanged),
 *  - the DAMAGE_CHARGE survives a recompute (syncAgreementCharges carve-out),
 *  - ≥1 photo is required (0 photos rejected),
 *  - existing addManualCharge callers are unaffected (default source ADMIN_CORRECTION),
 *  - admin delete failsafe voids the linked charge + removes the record.
 *
 * Review-fix additions (2026-07-10):
 *  - FIX D: a charge over the configurable ceiling is rejected with NO writes,
 *  - FIX E: a duplicate submit (same reservation + amount, <60s) returns the prior
 *    result and does NOT create a second charge,
 *  - FIX F: editing the cost re-syncs the contract (old DAMAGE_CHARGE voided, new one
 *    added, balance moves by the delta),
 *  - FIX B: OUR_INSURANCE records BOTH the full repair and the deductible but bills
 *    only the deductible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reportDamageService } from './report-damage.service.js';
import { reservationPricingService } from '../reservations/reservation-pricing.service.js';

const prisma = new PrismaClient();
const TAG = `RD-${Date.now()}`;
// 1x1 png data URL (valid base64) — persistDamagePhoto stores it inline when storage is off.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ids = { tenant: null, location: null, vehicleType: null, vehicle: null, customer: null, reservation: null, agreement: null };

test.after(async () => {
  if (ids.reservation) {
    const incidents = await prisma.reservationIncident.findMany({ where: { reservationId: ids.reservation }, select: { id: true } }).catch(() => []);
    for (const inc of incidents) { await prisma.incidentEvidence.deleteMany({ where: { incidentId: inc.id } }).catch(() => {}); }
    await prisma.reservationIncident.deleteMany({ where: { reservationId: ids.reservation } }).catch(() => {});
  }
  if (ids.vehicle) await prisma.vehicleDamageReport.deleteMany({ where: { vehicleId: ids.vehicle } }).catch(() => {});
  if (ids.agreement) await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: ids.agreement } }).catch(() => {});
  if (ids.agreement) await prisma.rentalAgreement.delete({ where: { id: ids.agreement } }).catch(() => {});
  if (ids.reservation) await prisma.auditLog.deleteMany({ where: { reservationId: ids.reservation } }).catch(() => {});
  if (ids.reservation) await prisma.reservationCharge.deleteMany({ where: { reservationId: ids.reservation } }).catch(() => {});
  if (ids.reservation) await prisma.reservation.delete({ where: { id: ids.reservation } }).catch(() => {});
  if (ids.vehicle) await prisma.vehicle.delete({ where: { id: ids.vehicle } }).catch(() => {});
  if (ids.customer) await prisma.customer.delete({ where: { id: ids.customer } }).catch(() => {});
  if (ids.vehicleType) await prisma.vehicleType.delete({ where: { id: ids.vehicleType } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

async function seed() {
  const t = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } }); ids.tenant = t.id;
  const loc = await prisma.location.create({ data: { code: `L-${TAG}`.slice(0, 12), name: 'Loc', tenantId: t.id } }); ids.location = loc.id;
  const vt = await prisma.vehicleType.create({ data: { tenantId: t.id, code: `VT-${TAG}`.slice(0, 10), name: 'Compact SUV' } }); ids.vehicleType = vt.id;
  const veh = await prisma.vehicle.create({ data: { tenant: { connect: { id: t.id } }, internalNumber: `V-${TAG}`.slice(0, 18), plate: `P${TAG}`.slice(0, 10), status: 'ON_RENT', vehicleType: { connect: { id: vt.id } } } }); ids.vehicle = veh.id;
  const cust = await prisma.customer.create({ data: { firstName: 'Dana', lastName: 'Damage', phone: '7875551234', email: `c-${TAG}@x.com`, tenantId: t.id } }); ids.customer = cust.id;
  const pickupAt = new Date(Date.now() - 3 * 86400e3); const returnAt = new Date(Date.now() - 1 * 86400e3);
  const r = await prisma.reservation.create({ data: { reservationNumber: `R-${TAG}`, tenantId: t.id, customerId: cust.id, vehicleId: veh.id, pickupLocationId: loc.id, returnLocationId: loc.id, pickupAt, returnAt, status: 'CHECKED_IN' } }); ids.reservation = r.id;
  const ag = await prisma.rentalAgreement.create({ data: {
    agreementNumber: `RA-${TAG}`, reservationId: r.id, tenantId: t.id, vehicleId: veh.id,
    pickupAt, returnAt, pickupLocationId: loc.id, returnLocationId: loc.id,
    customerFirstName: 'Dana', customerLastName: 'Damage', status: 'FINALIZED',
    total: 0, paidAmount: 0, balance: 0
  } }); ids.agreement = ag.id;
  return { scope: { tenantId: t.id }, user: { id: null, role: 'AGENT', tenantId: t.id } };
}

let seeded = null;
test('setup', async () => { seeded = await seed(); assert.ok(seeded.scope.tenantId); });

test('CUSTOMER pays → HARD_APPROVED damage + single DAMAGE_CHARGE (cost) + vehicle status + incident DRAFT referencing the charge (no double-bill)', async () => {
  const out = await reportDamageService.reportDamage(ids.reservation, {
    view: 'FRONT', xPct: 32, yPct: 70,
    description: 'Front bumper scrape',
    damagePhotos: [PNG],
    responsibleParty: 'CUSTOMER',
    damageCostCents: 125000, // $1,250.00
    vehicleStatus: 'IN_MAINTENANCE',
  }, seeded);

  assert.ok(out.damageReportId, 'damage report id returned');
  assert.ok(out.chargeId, 'charge id returned');
  assert.equal(out.chargeAmount, 1250, 'charge amount = full cost for CUSTOMER');
  assert.equal(out.vehicleStatus, 'IN_MAINTENANCE');

  // 1. Damage report is HARD_APPROVED with reservation + who-pays context + charge link.
  const dmg = await prisma.vehicleDamageReport.findUnique({ where: { id: out.damageReportId } });
  assert.equal(dmg.status, 'HARD_APPROVED');
  assert.equal(dmg.reservationId, ids.reservation);
  assert.equal(dmg.responsibleParty, 'CUSTOMER');
  assert.equal(dmg.damageCostCents, 125000);
  assert.equal(dmg.reservationChargeId, out.chargeId);

  // 2. EXACTLY ONE DAMAGE_CHARGE on the contract, equal to the cost.
  const dmgCharges = await prisma.rentalAgreementCharge.findMany({ where: { rentalAgreementId: ids.agreement, source: 'DAMAGE_CHARGE', selected: true } });
  assert.equal(dmgCharges.length, 1, 'exactly one DAMAGE_CHARGE row');
  assert.equal(Number(dmgCharges[0].total), 1250);

  // 3. Balance moved by exactly the cost.
  const ag = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { balance: true } });
  assert.ok(Math.abs(Number(ag.balance) - 1250) < 0.01, `balance should be 1250, got ${ag.balance}`);

  // 4. Vehicle status set.
  const veh = await prisma.vehicle.findUnique({ where: { id: ids.vehicle }, select: { status: true } });
  assert.equal(veh.status, 'IN_MAINTENANCE');

  // 5. Incident DRAFT created, references the charge, and did NOT write a second charge.
  assert.ok(out.incidentId, 'incident draft created');
  const inc = await prisma.reservationIncident.findUnique({ where: { id: out.incidentId } });
  assert.equal(inc.status, 'DRAFT');
  assert.equal(inc.type, 'DAMAGE');
  assert.deepEqual(JSON.parse(inc.chargeIdsJson || '[]'), [out.chargeId], 'incident references the charge (document-only)');
  const stillOne = await prisma.rentalAgreementCharge.count({ where: { rentalAgreementId: ids.agreement, source: 'DAMAGE_CHARGE', selected: true } });
  assert.equal(stillOne, 1, 'incident referencing the charge did NOT re-bill');
});

test('DAMAGE_CHARGE survives a recompute (syncAgreementCharges carve-out)', async () => {
  // A plain recompute must NOT wipe the damage charge (it lives only on the agreement).
  await reservationPricingService.getPricing(ids.reservation, { tenantId: ids.tenant }, { allowClosed: true });
  const rows = await prisma.rentalAgreementCharge.findMany({ where: { rentalAgreementId: ids.agreement, source: 'DAMAGE_CHARGE', selected: true } });
  assert.equal(rows.length, 1, 'DAMAGE_CHARGE preserved through recompute');
  const ag = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { balance: true } });
  assert.ok(Math.abs(Number(ag.balance) - 1250) < 0.01, 'balance still 1250 after recompute');
});

test('admin delete failsafe voids the linked charge and removes the record', async () => {
  const dmg = await prisma.vehicleDamageReport.findFirst({ where: { reservationId: ids.reservation, source: 'MANUAL' }, select: { id: true, reservationChargeId: true } });
  const res = await reportDamageService.deleteDamageReport(dmg.id, { reason: 'entered by mistake' }, { user: { id: null, role: 'ADMIN', tenantId: ids.tenant }, scope: { tenantId: ids.tenant } });
  assert.equal(res.ok, true);
  assert.equal(res.chargeVoided, dmg.reservationChargeId, 'linked charge voided on delete');
  // record gone
  const gone = await prisma.vehicleDamageReport.findUnique({ where: { id: dmg.id } });
  assert.equal(gone, null, 'damage record deleted');
  // charge no longer live → balance back to 0
  const live = await prisma.rentalAgreementCharge.count({ where: { rentalAgreementId: ids.agreement, source: 'DAMAGE_CHARGE', selected: true } });
  assert.equal(live, 0, 'no live DAMAGE_CHARGE after void');
  const ag = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { balance: true } });
  assert.ok(Math.abs(Number(ag.balance)) < 0.01, `balance back to 0 after void, got ${ag.balance}`);
});

test('OUR_INSURANCE → charge = deductible only, not the full repair', async () => {
  const out = await reportDamageService.reportDamage(ids.reservation, {
    view: 'REAR', xPct: 50, yPct: 40,
    description: 'Rear quarter panel',
    damagePhotos: [PNG],
    responsibleParty: 'OUR_INSURANCE',
    damageCostCents: 300000, // full repair $3,000 — filed on our policy, NOT billed
    ourDeductibleCents: 50000, // $500 deductible → the only thing billed
    vehicleStatus: 'OUT_OF_SERVICE',
  }, seeded);
  assert.equal(out.chargeAmount, 500, 'only the deductible hits the contract');
  const charge = await prisma.rentalAgreementCharge.findUnique({ where: { id: out.chargeId }, select: { total: true, name: true } });
  assert.equal(Number(charge.total), 500);
  assert.match(charge.name, /deductible/i);
  const veh = await prisma.vehicle.findUnique({ where: { id: ids.vehicle }, select: { status: true } });
  assert.equal(veh.status, 'OUT_OF_SERVICE');
  // clean up this record + its charge so later assertions stay isolated
  await reportDamageService.deleteDamageReport(out.damageReportId, { reason: 'test cleanup' }, { user: { id: null, role: 'ADMIN', tenantId: ids.tenant }, scope: { tenantId: ids.tenant } });
});

test('at least one photo is required (0 photos rejected, no writes)', async () => {
  const before = await prisma.vehicleDamageReport.count({ where: { vehicleId: ids.vehicle } });
  await assert.rejects(
    () => reportDamageService.reportDamage(ids.reservation, { view: 'FRONT', xPct: 10, yPct: 10, responsibleParty: 'CUSTOMER', damageCostCents: 1000, damagePhotos: [] }, seeded),
    /at least one damage photo/i
  );
  const after = await prisma.vehicleDamageReport.count({ where: { vehicleId: ids.vehicle } });
  assert.equal(after, before, 'no damage record written when photo missing');
});

test('existing addManualCharge callers unaffected — default source stays ADMIN_CORRECTION', async () => {
  const out = await reservationPricingService.addManualCharge(
    ids.reservation,
    { name: 'Parking ticket reimbursement', amount: 85 },
    { reason: 'admin correction', actorUserId: null },
    { tenantId: ids.tenant }
  );
  // default return shape is the pricing object (NOT the returnMeta object)
  assert.ok(out && typeof out === 'object' && !('chargeId' in out), 'default return is unchanged pricing object');
  const admin = await prisma.rentalAgreementCharge.findFirst({ where: { rentalAgreementId: ids.agreement, source: 'ADMIN_CORRECTION', selected: true } });
  assert.ok(admin, 'manual charge still lands with source ADMIN_CORRECTION');
  assert.equal(Number(admin.total), 85);
});

// FIX D — ceiling. Default is $10,000; an over-limit request is refused BEFORE any
// write (no orphan damage record, no charge).
test('charge over the damage-charge ceiling is rejected with no writes (FIX D)', async () => {
  const before = await prisma.vehicleDamageReport.count({ where: { vehicleId: ids.vehicle } });
  const liveBefore = await prisma.rentalAgreementCharge.count({ where: { rentalAgreementId: ids.agreement, source: 'DAMAGE_CHARGE', selected: true } });
  await assert.rejects(
    () => reportDamageService.reportDamage(ids.reservation, {
      view: 'FRONT', xPct: 10, yPct: 10, description: 'catastrophic — over cap',
      damagePhotos: [PNG], responsibleParty: 'CUSTOMER',
      damageCostCents: 1500000, // $15,000 > $10,000 default ceiling
      vehicleStatus: 'IN_MAINTENANCE',
    }, seeded),
    /exceeds the damage-charge limit/i
  );
  const after = await prisma.vehicleDamageReport.count({ where: { vehicleId: ids.vehicle } });
  const liveAfter = await prisma.rentalAgreementCharge.count({ where: { rentalAgreementId: ids.agreement, source: 'DAMAGE_CHARGE', selected: true } });
  assert.equal(after, before, 'no damage record written when over the ceiling');
  assert.equal(liveAfter, liveBefore, 'no DAMAGE_CHARGE written when over the ceiling');
});

// FIX E — idempotency. A duplicate submit (same reservation + amount) inside the
// 60s window returns the PRIOR result; the contract is billed exactly once.
test('duplicate submit within the window returns the prior result — no second charge (FIX E)', async () => {
  const amountCents = 77700; // $777 — distinct from every other test
  const first = await reportDamageService.reportDamage(ids.reservation, {
    view: 'LEFT', xPct: 20, yPct: 20, description: 'Idempotency probe',
    damagePhotos: [PNG], responsibleParty: 'CUSTOMER',
    damageCostCents: amountCents, vehicleStatus: 'IN_MAINTENANCE',
  }, seeded);
  assert.ok(first.chargeId, 'first submit created a charge');

  const second = await reportDamageService.reportDamage(ids.reservation, {
    view: 'LEFT', xPct: 20, yPct: 20, description: 'Idempotency probe (retry)',
    damagePhotos: [PNG], responsibleParty: 'CUSTOMER',
    damageCostCents: amountCents, vehicleStatus: 'IN_MAINTENANCE',
  }, seeded);
  assert.equal(second.duplicate, true, 'second submit flagged as a duplicate');
  assert.equal(second.chargeId, first.chargeId, 'the prior charge is returned, not a new one');
  assert.equal(second.damageReportId, first.damageReportId, 'the prior damage report is returned');

  const live = await prisma.rentalAgreementCharge.count({ where: { rentalAgreementId: ids.agreement, source: 'DAMAGE_CHARGE', selected: true, total: amountCents / 100 } });
  assert.equal(live, 1, 'exactly one $777 DAMAGE_CHARGE — no double bill');

  await reportDamageService.deleteDamageReport(first.damageReportId, { reason: 'test cleanup' }, { user: { id: null, role: 'ADMIN', tenantId: ids.tenant }, scope: { tenantId: ids.tenant } });
});

// FIX F — edit re-sync. Correcting the cost voids the old DAMAGE_CHARGE and adds a
// new one so the balance always matches the corrected damage cost.
test('editing the cost re-syncs the contract charge and balance (FIX F)', async () => {
  const out = await reportDamageService.reportDamage(ids.reservation, {
    view: 'RIGHT', xPct: 40, yPct: 40, description: 'Resync probe',
    damagePhotos: [PNG], responsibleParty: 'CUSTOMER',
    damageCostCents: 90000, // $900
    vehicleStatus: 'IN_MAINTENANCE',
  }, seeded);
  const originalChargeId = out.chargeId;
  const agBefore = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { balance: true } });
  const balBefore = Number(agBefore.balance);

  const res = await reportDamageService.editDamageReport(
    out.damageReportId,
    { damageCostCents: 200000, reason: 'estimate revised up to $2,000' },
    { user: { id: null, role: 'ADMIN', tenantId: ids.tenant }, scope: { tenantId: ids.tenant } }
  );
  assert.ok(res.chargeResync, 'edit performed a charge re-sync');
  assert.notEqual(res.chargeResync.newChargeId, originalChargeId, 'a NEW charge id was issued');

  const oldCharge = await prisma.rentalAgreementCharge.findUnique({ where: { id: originalChargeId }, select: { selected: true } });
  assert.equal(oldCharge.selected, false, 'the old DAMAGE_CHARGE was voided');
  const newCharge = await prisma.rentalAgreementCharge.findUnique({ where: { id: res.chargeResync.newChargeId }, select: { total: true, selected: true, source: true } });
  assert.equal(Number(newCharge.total), 2000, 'new charge is the corrected $2,000');
  assert.equal(newCharge.selected, true);
  assert.equal(newCharge.source, 'DAMAGE_CHARGE');

  const dmg = await prisma.vehicleDamageReport.findUnique({ where: { id: out.damageReportId }, select: { reservationChargeId: true, damageCostCents: true } });
  assert.equal(dmg.reservationChargeId, res.chargeResync.newChargeId, 'record re-pointed at the new charge');
  assert.equal(dmg.damageCostCents, 200000, 'record stores the corrected cost');

  const agAfter = await prisma.rentalAgreement.findUnique({ where: { id: ids.agreement }, select: { balance: true } });
  assert.ok(Math.abs((Number(agAfter.balance) - balBefore) - 1100) < 0.01, `balance should rise by 1100 ($900→$2000); before ${balBefore}, after ${agAfter.balance}`);

  await reportDamageService.deleteDamageReport(out.damageReportId, { reason: 'test cleanup' }, { user: { id: null, role: 'ADMIN', tenantId: ids.tenant }, scope: { tenantId: ids.tenant } });
});

// FIX B — OUR_INSURANCE records BOTH figures, bills only the deductible.
test('OUR_INSURANCE records BOTH the full repair and the deductible, bills only the deductible (FIX B)', async () => {
  const out = await reportDamageService.reportDamage(ids.reservation, {
    view: 'INTERIOR', xPct: 55, yPct: 55, description: 'Both-figures probe',
    damagePhotos: [PNG], responsibleParty: 'OUR_INSURANCE',
    damageCostCents: 480000,   // $4,800 full repair (filed on our policy, NOT billed)
    ourDeductibleCents: 75000, // $750 deductible (the only thing billed)
    vehicleStatus: 'OUT_OF_SERVICE',
  }, seeded);
  assert.equal(out.chargeAmount, 750, 'only the deductible hits the contract');
  assert.equal(out.damageCostCents, 480000, 'full repair returned for reconciliation');
  assert.equal(out.ourDeductibleCents, 75000, 'deductible returned for reconciliation');

  const dmg = await prisma.vehicleDamageReport.findUnique({ where: { id: out.damageReportId }, select: { damageCostCents: true, ourDeductibleCents: true, responsibleParty: true } });
  assert.equal(dmg.damageCostCents, 480000, 'record stores the FULL repair');
  assert.equal(dmg.ourDeductibleCents, 75000, 'record stores the deductible');
  assert.equal(dmg.responsibleParty, 'OUR_INSURANCE');

  const charge = await prisma.rentalAgreementCharge.findUnique({ where: { id: out.chargeId }, select: { total: true } });
  assert.equal(Number(charge.total), 750, 'contract billed only the $750 deductible');

  await reportDamageService.deleteDamageReport(out.damageReportId, { reason: 'test cleanup' }, { user: { id: null, role: 'ADMIN', tenantId: ids.tenant }, scope: { tenantId: ids.tenant } });
});
