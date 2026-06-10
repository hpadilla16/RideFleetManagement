/**
 * Inventory Helper — service (2026-06-09). Phase A: session lifecycle.
 *
 * One resumable IN_PROGRESS session per tenant. startSession snapshots the whole
 * fleet into InventoryItem rows and flags status mismatches. Agents confirm
 * items (at-lot checklist / maintenance note / exception); deferred mismatches
 * ("resolve with note") persist as a FleetReconciliationFlag so they surface on
 * the dashboard until truly fixed. completeSession gates on every item being
 * handled and every mismatch resolved. PDF generation + report storage land in
 * Phase C; mismatch dashboard wiring + auto-resolution in Phase D.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { detectMismatch, canCompleteSession, computeTotals } from './inventory-logic.js';

function err(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

function requireTenant(scope) {
  const tenantId = scope?.tenantId;
  if (!tenantId || tenantId === '__no_tenant__') {
    throw err('A specific tenant is required to run inventory', 'TENANT_REQUIRED', 400);
  }
  return tenantId;
}

const SESSION_INCLUDE = {
  items: {
    orderBy: [{ state: 'asc' }, { createdAt: 'asc' }],
    // Vehicle display fields the wizard needs to render the fleet list grouped
    // by lot (internal #, plate, VIN, current mileage, home location name).
    include: {
      vehicle: {
        select: {
          id: true,
          internalNumber: true,
          plate: true,
          vin: true,
          make: true,
          model: true,
          year: true,
          mileage: true,
          status: true,
          homeLocation: { select: { id: true, name: true } },
        },
      },
    },
  },
  report: true,
};

async function refreshTotals(tx, sessionId) {
  const items = await tx.inventoryItem.findMany({ where: { sessionId } });
  const totals = computeTotals(items);
  await tx.inventorySession.update({
    where: { id: sessionId },
    data: { totalsJson: totals, lastActivityAt: new Date() },
  });
  return totals;
}

export const inventoryService = {
  async getActiveSession(scope = {}) {
    const tenantId = requireTenant(scope);
    return prisma.inventorySession.findFirst({
      where: { tenantId, status: 'IN_PROGRESS' },
      orderBy: { startedAt: 'desc' },
      include: SESSION_INCLUDE,
    });
  },

  async getSession(id, scope = {}) {
    const tenantId = requireTenant(scope);
    const session = await prisma.inventorySession.findFirst({
      where: { id, tenantId },
      include: SESSION_INCLUDE,
    });
    if (!session) throw err('Inventory session not found', 'NOT_FOUND', 404);
    return session;
  },

  /**
   * Start a new session. If one is already IN_PROGRESS and wipeExisting is
   * false, returns it with { resumed: true } (the launch modal offers
   * Continue / Wipe & start new). With wipeExisting, the old one is CANCELLED.
   */
  async startSession(scope = {}, actorUserId = null, { wipeExisting = false } = {}) {
    const tenantId = requireTenant(scope);

    const existing = await prisma.inventorySession.findFirst({
      where: { tenantId, status: 'IN_PROGRESS' },
      orderBy: { startedAt: 'desc' },
      include: SESSION_INCLUDE,
    });
    if (existing && !wipeExisting) {
      return { session: existing, resumed: true };
    }

    // Snapshot the fleet (exclude SOLD — out of the rental fleet) with each
    // vehicle's current checkout (if any) so we can flag mismatches.
    const vehicles = await prisma.vehicle.findMany({
      where: { tenantId, status: { not: 'SOLD' } },
      select: {
        id: true,
        status: true,
        mileage: true,
        reservations: {
          where: { status: 'CHECKED_OUT' },
          select: { id: true, returnAt: true },
          orderBy: { returnAt: 'asc' },
          take: 1,
        },
      },
    });

    const now = new Date();
    const session = await prisma.$transaction(async (tx) => {
      if (existing && wipeExisting) {
        await tx.inventorySession.update({
          where: { id: existing.id },
          data: { status: 'CANCELLED', abandonedAt: now, abandonedReason: 'Wiped to start a new inventory' },
        });
      }
      const created = await tx.inventorySession.create({
        data: { tenantId, status: 'IN_PROGRESS', startedByUserId: actorUserId, startedAt: now, lastActivityAt: now },
      });
      if (vehicles.length) {
        await tx.inventoryItem.createMany({
          data: vehicles.map((v) => {
            const res = v.reservations?.[0] || null;
            const mismatchType = detectMismatch({ status: v.status, checkedOutReservation: res }, now);
            return {
              sessionId: created.id,
              tenantId,
              vehicleId: v.id,
              expectedStatus: v.status,
              expectedMileage: v.mileage ?? null,
              mismatchType: mismatchType || null,
              reservationId: mismatchType ? (res?.id || null) : null,
            };
          }),
        });
      }
      await refreshTotals(tx, created.id);
      return created;
    });

    const full = await prisma.inventorySession.findUnique({ where: { id: session.id }, include: SESSION_INCLUDE });
    logger.info('[inventory] session started', { tenantId, sessionId: session.id, vehicles: vehicles.length, wiped: !!(existing && wipeExisting) });
    return { session: full, resumed: false };
  },

  // Internal: load an item for mutation, validating session active + ownership.
  async _loadItem(sessionId, itemId, tenantId) {
    const session = await prisma.inventorySession.findFirst({ where: { id: sessionId, tenantId } });
    if (!session) throw err('Inventory session not found', 'NOT_FOUND', 404);
    if (session.status !== 'IN_PROGRESS') throw err(`Session is ${session.status}, not in progress`, 'SESSION_NOT_ACTIVE', 409);
    const item = await prisma.inventoryItem.findFirst({ where: { id: itemId, sessionId } });
    if (!item) throw err('Inventory item not found', 'NOT_FOUND', 404);
    return { session, item };
  },

  /**
   * Confirm a vehicle.
   *   - locatedStatus AT_LOT (default): scan required (QR/PLATE/VIN; MANUAL needs
   *     a reason — the fallback when the scanner fails) + condition checklist.
   *   - locatedStatus ON_RENT: the car is legitimately out on the road, so no
   *     scan and no checklist — just record that it was accounted for.
   */
  async confirmItem(sessionId, itemId, payload = {}, actorUserId = null, scope = {}) {
    const tenantId = requireTenant(scope);
    await this._loadItem(sessionId, itemId, tenantId);

    const located = String(payload.locatedStatus || 'AT_LOT').toUpperCase();
    if (!['AT_LOT', 'ON_RENT'].includes(located)) {
      throw err('locatedStatus must be AT_LOT or ON_RENT', 'BAD_LOCATED_STATUS', 400);
    }

    const data = {
      state: 'CONFIRMED',
      locatedStatus: located,
      note: payload.note ? String(payload.note).slice(0, 1000) : null,
      confirmedByUserId: actorUserId,
      confirmedAt: new Date(),
    };

    if (located === 'AT_LOT') {
      const method = String(payload.confirmMethod || '').toUpperCase();
      if (!['QR', 'PLATE', 'VIN', 'MANUAL'].includes(method)) {
        throw err('A scan method is required (QR, PLATE, VIN, or MANUAL with a reason)', 'SCAN_REQUIRED', 400);
      }
      if (method === 'MANUAL' && !String(payload.confirmReason || '').trim()) {
        throw err('A reason is required to confirm manually', 'MANUAL_REASON_REQUIRED', 400);
      }
      Object.assign(data, {
        confirmMethod: method,
        confirmReason: payload.confirmReason ? String(payload.confirmReason).slice(0, 500) : null,
        tiresOk: payload.tiresOk ?? null,
        brakesOk: payload.brakesOk ?? null,
        lightsOk: payload.lightsOk ?? null,
        fluidsOk: payload.fluidsOk ?? null,
        cleanOk: payload.cleanOk ?? null,
        mileageConfirmed: payload.mileageConfirmed ?? null,
        reportedMileage: Number.isFinite(Number(payload.reportedMileage)) ? Math.round(Number(payload.reportedMileage)) : null,
        photosJson: payload.photosJson ?? undefined,
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.inventoryItem.update({ where: { id: itemId }, data });
      await refreshTotals(tx, sessionId);
    });
    return this.getSession(sessionId, scope);
  },

  /** Confirm a maintenance / out-of-service vehicle with a required status note. */
  async addMaintenanceNote(sessionId, itemId, payload = {}, actorUserId = null, scope = {}) {
    const tenantId = requireTenant(scope);
    const { item } = await this._loadItem(sessionId, itemId, tenantId);
    const note = String(payload.note || '').trim();
    if (!note) throw err('A status note is required for maintenance vehicles', 'NOTE_REQUIRED', 400);

    const located = item.expectedStatus === 'OUT_OF_SERVICE' ? 'OUT_OF_SERVICE' : 'IN_MAINTENANCE';
    await prisma.$transaction(async (tx) => {
      await tx.inventoryItem.update({
        where: { id: itemId },
        data: { state: 'CONFIRMED', locatedStatus: located, maintenanceNote: note.slice(0, 1000), confirmedByUserId: actorUserId, confirmedAt: new Date() },
      });
      await refreshTotals(tx, sessionId);
    });
    return this.getSession(sessionId, scope);
  },

  /** Mark a vehicle that couldn't be located as an exception (with a reason). */
  async markException(sessionId, itemId, payload = {}, actorUserId = null, scope = {}) {
    const tenantId = requireTenant(scope);
    await this._loadItem(sessionId, itemId, tenantId);
    const reason = String(payload.reason || '').trim();
    if (!reason) throw err('A reason is required to mark an exception', 'REASON_REQUIRED', 400);

    await prisma.$transaction(async (tx) => {
      await tx.inventoryItem.update({
        where: { id: itemId },
        data: { state: 'EXCEPTION', locatedStatus: 'NOT_FOUND', confirmReason: reason.slice(0, 500), note: payload.note ? String(payload.note).slice(0, 1000) : null, confirmedByUserId: actorUserId, confirmedAt: new Date() },
      });
      await refreshTotals(tx, sessionId);
    });
    return this.getSession(sessionId, scope);
  },

  /**
   * Resolve a flagged mismatch "with a note" so the agent can finish. The
   * underlying problem persists, so we create/refresh an OPEN
   * FleetReconciliationFlag (one per vehicle+type) — surfaced on the dashboard
   * (Phase D) until truly fixed. Does NOT change Vehicle.status.
   */
  async resolveMismatch(sessionId, itemId, payload = {}, actorUserId = null, scope = {}) {
    const tenantId = requireTenant(scope);
    const { item } = await this._loadItem(sessionId, itemId, tenantId);
    if (!item.mismatchType) throw err('This item has no mismatch to resolve', 'NO_MISMATCH', 400);
    const note = String(payload.note || '').trim();
    if (!note) throw err('A note is required to resolve a mismatch', 'NOTE_REQUIRED', 400);

    await prisma.$transaction(async (tx) => {
      await tx.inventoryItem.update({
        where: { id: itemId },
        data: { mismatchResolved: true, mismatchResolutionNote: note.slice(0, 1000) },
      });
      // One OPEN flag per vehicle+type — refresh if it exists, else create.
      const open = await tx.fleetReconciliationFlag.findFirst({
        where: { tenantId, vehicleId: item.vehicleId, type: item.mismatchType, status: 'OPEN' },
      });
      if (open) {
        await tx.fleetReconciliationFlag.update({
          where: { id: open.id },
          data: { note: note.slice(0, 1000), lastSeenAt: new Date(), raisedByInventorySessionId: sessionId, raisedByUserId: actorUserId },
        });
      } else {
        await tx.fleetReconciliationFlag.create({
          data: {
            tenantId,
            vehicleId: item.vehicleId,
            reservationId: item.reservationId || null,
            type: item.mismatchType,
            status: 'OPEN',
            note: note.slice(0, 1000),
            raisedByInventorySessionId: sessionId,
            raisedByUserId: actorUserId,
          },
        });
      }
      await refreshTotals(tx, sessionId);
    });
    logger.info('[inventory] mismatch deferred with note', { tenantId, sessionId, itemId, vehicleId: item.vehicleId, type: item.mismatchType });
    return this.getSession(sessionId, scope);
  },

  /**
   * Complete the session. Gated: every item CONFIRMED/EXCEPTION and every
   * mismatch resolved. (PDF + InventoryReport land in Phase C.)
   */
  async completeSession(sessionId, actorUserId = null, scope = {}) {
    const tenantId = requireTenant(scope);
    const session = await prisma.inventorySession.findFirst({ where: { id: sessionId, tenantId }, include: { items: true } });
    if (!session) throw err('Inventory session not found', 'NOT_FOUND', 404);
    if (session.status !== 'IN_PROGRESS') throw err(`Session is ${session.status}, not in progress`, 'SESSION_NOT_ACTIVE', 409);

    const gate = canCompleteSession(session.items);
    if (!gate.ok) {
      throw err(`Cannot complete inventory: ${gate.reasons.join('; ')}`, 'INCOMPLETE', 409);
    }

    const totals = computeTotals(session.items);
    await prisma.inventorySession.update({
      where: { id: sessionId },
      data: { status: 'COMPLETED', completedAt: new Date(), completedByUserId: actorUserId, totalsJson: totals, lastActivityAt: new Date() },
    });
    logger.info('[inventory] session completed', { tenantId, sessionId, totals });
    return this.getSession(sessionId, scope);
  },

  async listReports(scope = {}) {
    const tenantId = requireTenant(scope);
    return prisma.inventoryReport.findMany({
      where: { tenantId },
      orderBy: { generatedAt: 'desc' },
      take: 100,
    });
  },
};
