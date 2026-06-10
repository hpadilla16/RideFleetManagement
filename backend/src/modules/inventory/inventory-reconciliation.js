/**
 * Inventory reconciliation — auto-resolution of deferred status mismatches
 * (2026-06-09, Phase D). Puppeteer-free (only prisma + the pure mismatch rule)
 * so it's safe to import into the worker's status-sweep poll.
 *
 * A FleetReconciliationFlag is OPEN while a vehicle's stored status disagrees
 * with reservation truth. reEvaluateOpenFlags re-checks each OPEN flag and, when
 * the underlying condition has cleared (e.g. the rental was checked in, or the
 * drift sweep fixed the status), marks it RESOLVED (reason SWEEP). Called lazily
 * when the dashboard/reconciliation list loads, and hourly by the worker sweep.
 */
import { prisma } from '../../lib/prisma.js';
import { detectMismatch } from './inventory-logic.js';

export async function reEvaluateOpenFlags(client = prisma, { tenantId } = {}) {
  const where = { status: 'OPEN', ...(tenantId ? { tenantId } : {}) };
  const flags = await client.fleetReconciliationFlag.findMany({ where, select: { id: true, vehicleId: true, type: true } });
  if (!flags.length) return { resolved: 0 };

  const vehicleIds = [...new Set(flags.map((f) => f.vehicleId))];
  const vehicles = await client.vehicle.findMany({
    where: { id: { in: vehicleIds } },
    select: {
      id: true,
      status: true,
      reservations: { where: { status: 'CHECKED_OUT' }, select: { returnAt: true }, orderBy: { returnAt: 'asc' }, take: 1 },
    },
  });
  const byId = new Map(vehicles.map((v) => [v.id, v]));
  const now = new Date();

  let resolved = 0;
  for (const f of flags) {
    const v = byId.get(f.vehicleId);
    const current = v ? detectMismatch({ status: v.status, checkedOutReservation: v.reservations?.[0] || null }, now) : null;
    // Cleared (or no longer the same mismatch) → resolve.
    if (current !== f.type) {
      await client.fleetReconciliationFlag.update({
        where: { id: f.id },
        data: { status: 'RESOLVED', resolvedAt: now, resolvedReason: 'SWEEP', lastSeenAt: now },
      });
      resolved += 1;
    } else {
      await client.fleetReconciliationFlag.update({ where: { id: f.id }, data: { lastSeenAt: now } });
    }
  }
  return { resolved };
}
