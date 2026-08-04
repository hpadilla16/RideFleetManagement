/**
 * Dashboard v2 fleet table (2026-08-04, phase 6 of design/DASHBOARD-V2.md).
 *
 * The rows behind the product shot's PLATE / VEHICLE / STATUS / LOCATION /
 * TURN-READY / NEXT ACTION table. Turn-Ready comes from the same
 * buildVehicleOperationalSignalsMap as the planner, the vehicle profile and
 * the hero KPIs — one scoring path, everywhere.
 *
 * Sorting is worst-score-first: the table's job on a dashboard is "what needs
 * a human", not an inventory list (that is /vehicles). `limit` caps the rows
 * returned but `totalCount` always reports the real fleet size, so the UI can
 * say "8 of 127" instead of pretending the list is complete.
 *
 * NEXT ACTION is derived, in priority order, from data already in reach:
 *   1. an active hold          → { kind: 'block',  blockType, until }
 *   2. currently checked out   → { kind: 'return', at }   (soonest open return)
 *   3. an upcoming assignment  → { kind: 'pickup', at }
 *   4. READY and idle          → { kind: 'assign' }
 *   5. anything else           → { kind: 'review' }
 * The endpoint returns raw kinds + timestamps; wording and locale belong to
 * the frontend.
 */
import { prisma } from '../../lib/prisma.js';
import { buildVehicleOperationalSignalsMap } from '../vehicles/vehicle-intelligence.service.js';

function activeAvailabilityBlock(blocks = [], now = new Date()) {
  const nowValue = now.getTime();
  return blocks.find((block) => {
    const releasedAt = block?.releasedAt ? new Date(block.releasedAt).getTime() : null;
    const blockedFrom = block?.blockedFrom ? new Date(block.blockedFrom).getTime() : nowValue;
    const availableFrom = block?.availableFrom ? new Date(block.availableFrom).getTime() : null;
    return !releasedAt && blockedFrom <= nowValue && availableFrom && availableFrom > nowValue;
  }) || null;
}

export async function computeDashboardV2Fleet(tenantId, { limit = 8, now = new Date(), deps = {} } = {}) {
  if (!tenantId) throw new Error('tenantId required');
  const db = deps.prisma || prisma;
  const signalsMap = deps.buildVehicleOperationalSignalsMap || buildVehicleOperationalSignalsMap;
  const cappedLimit = Math.min(50, Math.max(1, Number(limit) || 8));

  const vehicles = await db.vehicle.findMany({
    where: { tenantId, status: { not: 'SOLD' } },
    select: {
      id: true,
      plate: true,
      internalNumber: true,
      make: true,
      model: true,
      year: true,
      status: true,
      homeLocation: { select: { id: true, name: true } },
      availabilityBlocks: {
        where: { releasedAt: null },
        select: { blockType: true, blockedFrom: true, availableFrom: true, releasedAt: true }
      }
    }
  });
  const vehicleIds = vehicles.map((v) => v.id);

  const activeBlocksByVehicleId = new Map(
    vehicles
      .map((v) => [v.id, activeAvailabilityBlock(v.availabilityBlocks, now)])
      .filter(([, block]) => !!block)
  );

  const [signals, openReturns, upcomingPickups] = await Promise.all([
    signalsMap(vehicleIds, { tenantId }, { activeBlocksByVehicleId }),
    vehicleIds.length
      ? db.reservation.findMany({
          where: { tenantId, status: 'CHECKED_OUT', vehicleId: { in: vehicleIds } },
          select: { vehicleId: true, returnAt: true },
          orderBy: { returnAt: 'asc' }
        })
      : [],
    vehicleIds.length
      ? db.reservation.findMany({
          where: {
            tenantId,
            status: { in: ['NEW', 'CONFIRMED'] },
            vehicleId: { in: vehicleIds },
            pickupAt: { gte: now }
          },
          select: { vehicleId: true, pickupAt: true },
          orderBy: { pickupAt: 'asc' }
        })
      : []
  ]);

  // orderBy asc + first-wins keeps the SOONEST return/pickup per vehicle.
  const returnByVehicleId = new Map();
  for (const r of openReturns) {
    if (r.vehicleId && !returnByVehicleId.has(r.vehicleId)) returnByVehicleId.set(r.vehicleId, r.returnAt);
  }
  const pickupByVehicleId = new Map();
  for (const r of upcomingPickups) {
    if (r.vehicleId && !pickupByVehicleId.has(r.vehicleId)) pickupByVehicleId.set(r.vehicleId, r.pickupAt);
  }

  const rows = vehicles.map((v) => {
    const turnReady = signals.get(v.id)?.turnReady || null;
    const block = activeBlocksByVehicleId.get(v.id) || null;
    let nextAction;
    if (block) {
      nextAction = { kind: 'block', blockType: block.blockType, until: block.availableFrom };
    } else if (returnByVehicleId.has(v.id)) {
      nextAction = { kind: 'return', at: returnByVehicleId.get(v.id) };
    } else if (pickupByVehicleId.has(v.id)) {
      nextAction = { kind: 'pickup', at: pickupByVehicleId.get(v.id) };
    } else if (String(turnReady?.status || '').toUpperCase() === 'READY' && v.status === 'AVAILABLE') {
      nextAction = { kind: 'assign' };
    } else {
      nextAction = { kind: 'review' };
    }
    return {
      id: v.id,
      plate: v.plate || null,
      internalNumber: v.internalNumber || null,
      make: v.make || null,
      model: v.model || null,
      year: v.year || null,
      status: v.status,
      location: v.homeLocation ? { id: v.homeLocation.id, name: v.homeLocation.name } : null,
      turnReady: turnReady
        ? { score: turnReady.score, status: turnReady.status, summary: turnReady.summary }
        : null,
      nextAction
    };
  });

  // Worst first; unscored units sink to the end (they carry no signal, and a
  // dashboard slot is too scarce to spend on "we know nothing").
  rows.sort((a, b) => (a.turnReady?.score ?? 101) - (b.turnReady?.score ?? 101));

  return {
    asOf: now.toISOString(),
    totalCount: rows.length,
    rows: rows.slice(0, cappedLimit)
  };
}
