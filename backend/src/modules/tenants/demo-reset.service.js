/**
 * Demo tenant reset — the IO half. Decisions live in demo-reset.js.
 *
 * Everything happens inside ONE transaction: a reset that dies halfway would
 * leave the demo in a worse state than the mess it was sent to clean, with
 * agreements pointing at reservations that no longer exist.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import {
  BLOCKING_CHILDREN, TENANT_SCOPED_CLEARS,
  assertResettable, assertConfirmed, summarize,
} from './demo-reset.js';

/** Vehicle states a reset restores. Deliberate holds are left alone. */
const TRANSIENT_VEHICLE_STATES = ['RESERVED', 'ON_RENT'];

/** Deleting thousands of rows can outrun Prisma's 5s interactive default. */
const TX_OPTIONS = { timeout: 120_000, maxWait: 15_000 };

export const demoResetService = {
  /**
   * Wipe the demo tenant's transactional data and put every vehicle back on
   * the lot. Deps injectable for tests.
   *
   * @param {string} tenantId  which tenant (verified to BE the demo below)
   * @param {string} confirm   must match RESET_CONFIRMATION
   * @param {object} actor     { userId, email } — recorded on both log lines
   */
  async reset(tenantId, confirm, actor = {}, deps = {}) {
    const db = deps.prisma || prisma;
    const log = deps.logger || logger;

    assertConfirmed(confirm);

    const tenant = await db.tenant.findUnique({
      where: { id: String(tenantId || '') },
      select: { id: true, name: true, isDemo: true },
    });
    // Throws 404 when absent, 403 when it is not flagged as the demo. The
    // check reads the LOADED row, so no caller can talk their way in.
    assertResettable(tenant);

    log.warn?.('[demo-reset] starting', {
      tenantId: tenant.id, tenantName: tenant.name,
      byUserId: actor.userId || null, byEmail: actor.email || null,
    });

    const counts = await db.$transaction(async (tx) => {
      const reservations = await tx.reservation.findMany({
        where: { tenantId: tenant.id },
        select: { id: true },
      });
      const reservationIds = reservations.map((r) => r.id);
      const out = {};

      if (reservationIds.length) {
        // Blockers first — their FKs are RESTRICT, so the reservation delete
        // below fails loudly if any survive. That is the desired behavior: a
        // new blocking table should stop the reset, not silently orphan rows.
        for (const table of BLOCKING_CHILDREN) {
          const model = tx[table];
          if (!model?.deleteMany) continue; // table predates this client
          const { count } = await model.deleteMany({ where: { reservationId: { in: reservationIds } } });
          if (count) out[table] = count;
        }
        const { count } = await tx.reservation.deleteMany({ where: { tenantId: tenant.id } });
        out.reservation = count;
      }

      for (const table of TENANT_SCOPED_CLEARS) {
        const model = tx[table];
        if (!model?.deleteMany) continue;
        const { count } = await model.deleteMany({ where: { tenantId: tenant.id } });
        if (count) out[table] = count;
      }

      // Back on the lot — but only the states a rental cycle produces.
      // IN_MAINTENANCE / OUT_OF_SERVICE / SOLD are decisions somebody made,
      // not trainee residue, so a reset must not quietly undo them.
      const vehicles = await tx.vehicle.updateMany({
        where: { tenantId: tenant.id, status: { in: TRANSIENT_VEHICLE_STATES } },
        data: { status: 'AVAILABLE' },
      });
      if (vehicles.count) out.vehiclesFreed = vehicles.count;

      return out;
    }, TX_OPTIONS);

    log.warn?.('[demo-reset] done', {
      tenantId: tenant.id, byUserId: actor.userId || null, ...counts,
    });

    return {
      ok: true,
      tenantName: tenant.name,
      counts,
      summary: summarize(counts),
      // Reset deletes the reservations that tokenized shuttle links point at,
      // so any demo link minted earlier is now dead by design.
      shuttleLinksInvalidated: Number(counts.shuttleTrackerLink || 0),
    };
  },
};
