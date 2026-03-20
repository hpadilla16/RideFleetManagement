import { PrismaClient } from '@prisma/client';
import { bookingEngineService } from '../src/modules/booking-engine/booking-engine.service.js';

const prisma = new PrismaClient();

const TENANT_SLUG = process.env.BOOKING_TEST_TENANT_SLUG || 'beta-b-tenant';
const PREFIX = String(process.env.BOOKING_TEST_PREFIX || 'BBT').trim().toUpperCase();

function toIsoAtHour(daysFromNow, hour = 10) {
  const dt = new Date();
  dt.setDate(dt.getDate() + daysFromNow);
  dt.setHours(hour, 0, 0, 0);
  return dt.toISOString();
}

async function main() {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: TENANT_SLUG },
    select: { id: true, name: true, slug: true, carSharingEnabled: true }
  });
  if (!tenant) throw new Error(`Tenant ${TENANT_SLUG} not found`);

  const location = await prisma.location.findFirst({
    where: { tenantId: tenant.id, code: `${PREFIX}-LOC-A` },
    select: { id: true, code: true, name: true }
  });
  const carSharingLocation = await prisma.location.findFirst({
    where: { tenantId: tenant.id, code: `${PREFIX}-LOC-B` },
    select: { id: true, code: true, name: true }
  });
  if (!location) throw new Error(`Location ${PREFIX}-LOC-A not found`);
  if (!carSharingLocation) throw new Error(`Location ${PREFIX}-LOC-B not found`);

  const rentalSearch = await bookingEngineService.searchRental({
    tenantSlug: tenant.slug,
    pickupLocationId: location.id,
    pickupAt: toIsoAtHour(1, 10),
    returnAt: toIsoAtHour(4, 10)
  });

  const carSharingSearch = await bookingEngineService.searchCarSharing({
    tenantSlug: tenant.slug,
    locationId: carSharingLocation.id,
    pickupAt: toIsoAtHour(2, 11),
    returnAt: toIsoAtHour(5, 11)
  }).catch(() => ({ results: [] }));

  const fleetCounts = await prisma.vehicle.groupBy({
    by: ['fleetMode'],
    where: { tenantId: tenant.id },
    _count: { fleetMode: true }
  });

  const publishedListings = await prisma.hostVehicleListing.count({
    where: { tenantId: tenant.id, status: 'PUBLISHED' }
  });

  const output = {
    ok: rentalSearch.results.length > 0 && (carSharingSearch.results || []).length > 0 && publishedListings > 0,
    tenant,
    rentalResults: rentalSearch.results.map((result) => ({
      vehicleType: result.vehicleType.name,
      availableUnits: result.availability.availableUnits,
      total: result.quote.total
    })),
    carSharingResults: (carSharingSearch.results || []).map((result) => ({
      title: result.listing.title,
      total: result.quote.total,
      instantBook: result.listing.instantBook
    })),
    fleetCounts: fleetCounts.map((row) => ({ fleetMode: row.fleetMode, count: row._count.fleetMode })),
    publishedListings
  };

  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) {
    process.exitCode = 1;
  }
}

main()
  .catch(async (error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
