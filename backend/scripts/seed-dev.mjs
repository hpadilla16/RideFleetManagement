/**
 * Local dev seed — populates the docker-postgres dev DB with a usable
 * scenario for end-to-end testing of the new checkout-wizard-v2.
 *
 * Creates:
 *   • Tenant: 'Dev Tenant' (slug: dev)
 *   • User: admin@dev.local / admin (role SUPER_ADMIN so all routes work)
 *   • Location: 'Dev Lot'
 *   • VehicleType: 'Compact'
 *   • Vehicle: 2025 Toyota Corolla · plate DEV-001 (status AVAILABLE)
 *   • Customer: Erick Bou
 *   • Reservation: RES-DEV-001 (CONFIRMED, pickupAt now+15min, returnAt now+3d)
 *   • RentalAgreement: DRAFT linked to the reservation
 *
 * Usage:
 *   DATABASE_URL="postgresql://postgres:devpass@localhost:5433/ridefleet_dev" \
 *     node backend/scripts/seed-dev.mjs
 *
 * Idempotent — run repeatedly without crashing. Existing rows are
 * skipped, only missing ones are created. Use --reset to drop the
 * dev fixtures and reseed clean.
 */

import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const RESET = process.argv.includes('--reset');

const IDS = {
  tenant:      'dev-tenant',
  user:        'dev-admin',
  location:    'dev-loc',
  vehicleType: 'dev-vt-compact',
  vehicle:     'dev-veh-001',
  customer:    'dev-cust-001',
  reservation: 'dev-res-001',
  agreement:   'dev-agr-001',
};

async function ensureTenant() {
  const existing = await prisma.tenant.findUnique({ where: { id: IDS.tenant } });
  if (existing) return existing;
  return prisma.tenant.create({
    data: {
      id: IDS.tenant,
      name: 'Dev Tenant',
      slug: 'dev',
      status: 'ACTIVE',
      plan: 'BETA',
    },
  });
}

async function ensureUser() {
  const existing = await prisma.user.findUnique({ where: { id: IDS.user } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      id: IDS.user,
      tenantId: IDS.tenant,
      email: 'admin@dev.local',
      passwordHash: bcrypt.hashSync('admin', 10),
      fullName: 'Dev Admin',
      role: 'SUPER_ADMIN',
      isActive: true,
    },
  });
}

async function ensureLocation() {
  const existing = await prisma.location.findUnique({ where: { id: IDS.location } });
  if (existing) return existing;
  return prisma.location.create({
    data: {
      id: IDS.location,
      tenantId: IDS.tenant,
      code: 'DEV',
      name: 'Dev Lot',
      address: '123 Test Ave, San Juan, PR',
      city: 'San Juan',
      state: 'PR',
      country: 'US',
      taxRate: 11.5,
      isActive: true,
      // Locations carry their tz inside locationConfig (JSON), not a
      // dedicated column. Same shape the existing settings UI writes.
      locationConfig: JSON.stringify({ tz: 'America/Puerto_Rico', gracePeriodMin: 30 }),
    },
  });
}

async function ensureVehicleType() {
  const existing = await prisma.vehicleType.findUnique({ where: { id: IDS.vehicleType } });
  if (existing) return existing;
  return prisma.vehicleType.create({
    data: {
      id: IDS.vehicleType,
      tenantId: IDS.tenant,
      code: 'CDAR',
      name: 'Compact',
    },
  });
}

async function ensureVehicle() {
  const existing = await prisma.vehicle.findUnique({ where: { id: IDS.vehicle } });
  if (existing) return existing;
  return prisma.vehicle.create({
    data: {
      id: IDS.vehicle,
      tenantId: IDS.tenant,
      internalNumber: 'DEV-001',
      vin: 'DEVVIN0000000001',
      plate: 'DEV-001',
      make: 'Toyota',
      model: 'Corolla',
      year: 2025,
      color: 'Silver',
      mileage: 12500,
      status: 'AVAILABLE',
      vehicleTypeId: IDS.vehicleType,
      homeLocationId: IDS.location,
    },
  });
}

async function ensureCustomer() {
  const existing = await prisma.customer.findUnique({ where: { id: IDS.customer } });
  if (existing) return existing;
  return prisma.customer.create({
    data: {
      id: IDS.customer,
      tenantId: IDS.tenant,
      firstName: 'Erick',
      lastName: 'Bou',
      email: 'erick@dev.local',
      phone: '7875550142',
      licenseNumber: 'TEST-DL-001',
      licenseState: 'PR',
      dateOfBirth: new Date('1990-05-15'),
    },
  });
}

async function ensureReservation() {
  const existing = await prisma.reservation.findUnique({ where: { id: IDS.reservation } });
  if (existing) return existing;
  return prisma.reservation.create({
    data: {
      id: IDS.reservation,
      tenantId: IDS.tenant,
      reservationNumber: 'RES-DEV-001',
      status: 'CONFIRMED',
      customerId: IDS.customer,
      vehicleId: IDS.vehicle,
      vehicleTypeId: IDS.vehicleType,
      pickupAt: new Date(Date.now() + 15 * 60 * 1000),
      returnAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      pickupLocationId: IDS.location,
      returnLocationId: IDS.location,
      estimatedTotal: 250.00,
      dailyRate: 50.00,
    },
  });
}

async function ensureAgreement() {
  const existing = await prisma.rentalAgreement.findUnique({ where: { id: IDS.agreement } });
  if (existing) return existing;
  return prisma.rentalAgreement.create({
    data: {
      id: IDS.agreement,
      tenantId: IDS.tenant,
      agreementNumber: 'RA-DEV-001',
      status: 'DRAFT',
      reservationId: IDS.reservation,
      vehicleId: IDS.vehicle,
      pickupAt: new Date(Date.now() + 15 * 60 * 1000),
      returnAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      pickupLocationId: IDS.location,
      returnLocationId: IDS.location,
      customerFirstName: 'Erick',
      customerLastName: 'Bou',
      customerPhone: '7875550142',
      customerEmail: 'erick@dev.local',
      subtotal: 250,
      taxes: 28.75,
      fees: 0,
      total: 278.75,
      paidAmount: 0,
      balance: 278.75,
    },
  });
}

async function resetDevFixtures() {
  console.log('[seed-dev] --reset: dropping fixtures…');
  // Wipe child rows in FK-safe order BEFORE deleting parents. Without
  // this Postgres rejects the parent delete (cascades aren't set on all
  // relations) AND any orphan rows (e.g. AgreementSectionInitial from a
  // previous test session) get re-attached to a fresh agreement with
  // the same ID, which is why staff were seeing "step 2 already had
  // initials" after a reset.
  await prisma.agreementSectionInitial.deleteMany({ where: { agreementId: IDS.agreement } }).catch(() => {});
  await prisma.rentalAgreementAddendum.deleteMany({ where: { rentalAgreementId: IDS.agreement } }).catch(() => {});
  // VehicleInspectionAnnotation cascades from RentalAgreementInspection, but
  // do it explicitly first to avoid relying on FK cascade settings.
  await prisma.vehicleInspectionAnnotation.deleteMany({
    where: { inspection: { rentalAgreementId: IDS.agreement } }
  }).catch(() => {});
  await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: IDS.agreement } }).catch(() => {});
  await prisma.reservationCharge.deleteMany({ where: { reservationId: IDS.reservation } }).catch(() => {});
  await prisma.rentalAgreementPayment.deleteMany({ where: { rentalAgreementId: IDS.agreement } }).catch(() => {});
  await prisma.reservationPayment.deleteMany({ where: { reservationId: IDS.reservation } }).catch(() => {});
  await prisma.rentalAgreementInspection.deleteMany({ where: { rentalAgreementId: IDS.agreement } }).catch(() => {});
  await prisma.agreementDriver.deleteMany({ where: { rentalAgreementId: IDS.agreement } }).catch(() => {});
  await prisma.reservationAdditionalDriver.deleteMany({ where: { reservationId: IDS.reservation } }).catch(() => {});
  await prisma.checkoutSession.deleteMany({ where: { reservationId: IDS.reservation } }).catch(() => {});
  await prisma.handoffToken.deleteMany({ where: { reservationId: IDS.reservation } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { reservationId: IDS.reservation } }).catch(() => {});
  await prisma.rentalAgreement.delete({ where: { id: IDS.agreement } }).catch(() => {});
  await prisma.reservation.delete({ where: { id: IDS.reservation } }).catch(() => {});
  await prisma.customer.delete({ where: { id: IDS.customer } }).catch(() => {});
  await prisma.vehicle.delete({ where: { id: IDS.vehicle } }).catch(() => {});
  await prisma.vehicleType.delete({ where: { id: IDS.vehicleType } }).catch(() => {});
  await prisma.location.delete({ where: { id: IDS.location } }).catch(() => {});
  await prisma.user.delete({ where: { id: IDS.user } }).catch(() => {});
  await prisma.tenant.delete({ where: { id: IDS.tenant } }).catch(() => {});
}

async function main() {
  if (RESET) await resetDevFixtures();

  console.log('[seed-dev] ensuring fixtures…');
  await ensureTenant();
  await ensureUser();
  await ensureLocation();
  await ensureVehicleType();
  await ensureVehicle();
  await ensureCustomer();
  await ensureReservation();
  await ensureAgreement();

  console.log('\n[seed-dev] ✓ ready');
  console.log('  Login:           admin@dev.local / admin');
  console.log('  Reservation id:  ' + IDS.reservation);
  console.log('  Wizard URL:      http://localhost:3000/reservations/' + IDS.reservation + '/checkout-wizard-v2');
  console.log('  Customer view:   http://localhost:3000/reservations/' + IDS.reservation + '/customer-view');
}

main()
  .catch((err) => { console.error('[seed-dev] FAILED', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
