/**
 * Outbound rate push — orchestration (2026-07-28). MONEY-ADJACENT: this writes
 * prices into a franchise's live pricing system.
 *
 * Flow per enabled area:
 *   1. load RFM's rates for the Ride location (RateItem.daily = the truth MI
 *      maintains) and the portal's CURRENT grid for the window,
 *   2. buildPushPlan decides each (class, date) — close-outs preserved, bad
 *      values refused, no-ops skipped (economy-rate-map.js),
 *   3. DRY_RUN records the plan and writes NOTHING; LIVE writes one cell at a
 *      time and RE-READS to verify, because ApplyRates reports success even
 *      when it ignores the value,
 *   4. every decision lands in RatePushLog — pushed, skipped or failed.
 *
 * Refuses to run for an area without ratePushEnabled AND rateCloseoutMin: a
 * location that has not declared its close-out sentinel cannot be protected
 * from having blocked days silently re-opened.
 */
import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { buildPushPlan, verifyPush, SKIP } from './economy-rate-map.js';
import { readRateGrid, applyRateCell } from './economy-rate-client.js';

export const MODES = Object.freeze({ OFF: 'OFF', DRY_RUN: 'DRY_RUN', LIVE: 'LIVE' });
const PROVIDER = 'ECONOMY';

/** Global transport gate. Default OFF — an area's own flag is not enough. */
export function pushMode() {
  const raw = String(process.env.ECONOMY_RATE_PUSH_MODE || 'OFF').toUpperCase();
  return MODES[raw] || MODES.OFF;
}

/** How many days forward each run covers (portal grids are 7 days wide). */
export function pushHorizonDays() {
  const n = Number(process.env.ECONOMY_RATE_PUSH_HORIZON_DAYS || 7);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 90) : 7;
}

/** Largest allowed move against an EXISTING portal price, in percent. */
export function maxDeltaPct() {
  const n = Number(process.env.ECONOMY_RATE_PUSH_MAX_DELTA_PCT || 60);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** yyyy-mm-dd list starting at `from` (UTC), `days` long. Pure, exported. */
export function dateWindow(from, days) {
  const start = from instanceof Date ? from : new Date(from);
  const out = [];
  for (let i = 0; i < days; i += 1) {
    out.push(new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10));
  }
  return out;
}

function parseClassMap(json) {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/** RFM's per-class daily rates for a Ride location (the source of truth). */
export async function loadRfmRates(tenantId, locationId, deps = {}) {
  const db = deps.prisma || prisma;
  const rates = await db.rate.findMany({
    where: { tenantId, locationId, displayOnline: true },
    select: { id: true, rateItems: { select: { id: true, daily: true, vehicleType: { select: { code: true } } } } },
  });
  const out = [];
  for (const rate of rates) {
    for (const item of rate.rateItems || []) {
      const code = item?.vehicleType?.code;
      if (!code || item.daily == null) continue;
      out.push({ classCode: String(code).toUpperCase(), daily: Number(item.daily), rateItemId: item.id });
    }
  }
  return out;
}

/**
 * Push one configured area. Returns a summary; every decision is persisted.
 */
export async function pushArea(config, deps = {}) {
  const db = deps.prisma || prisma;
  const mode = deps.mode || pushMode();
  const trigger = deps.trigger || 'MANUAL';
  const actorUserId = deps.actorUserId || null;

  if (mode === MODES.OFF) return { skipped: 'mode_off' };
  if (!config?.ratePushEnabled) return { skipped: 'area_disabled', externalArea: config?.externalArea };
  if (!config?.externalLocationCode) return { skipped: 'no_external_location', externalArea: config?.externalArea };
  // No sentinel => we cannot tell a blocked day from a real price. Refuse.
  if (config?.rateCloseoutMin == null) {
    logger.warn('[economy-rate-push] area has no close-out sentinel — refusing to push', {
      tenantId: config.tenantId, externalArea: config.externalArea,
    });
    return { skipped: SKIP.NO_SENTINEL, externalArea: config.externalArea };
  }

  const { tenantId, locationId, externalLocationCode } = config;
  const closeoutMin = Number(config.rateCloseoutMin);
  const dates = dateWindow(deps.now ? deps.now() : new Date(), deps.horizonDays || pushHorizonDays());

  const rfmRates = await (deps.loadRfmRates || loadRfmRates)(tenantId, locationId, deps);
  if (!rfmRates.length) return { skipped: 'no_rfm_rates', externalArea: config.externalArea };

  // The portal serves 7 days per read, so cover the window in chunks.
  const client = deps.client || { readRateGrid, applyRateCell };
  const portalGrid = {};
  let portalClasses = null;
  for (let i = 0; i < dates.length; i += 7) {
    const chunk = await client.readRateGrid(tenantId, {
      provider: config.provider || process.env.ECONOMY_RATE_PUSH_PROVIDER || '61201',
      location: externalLocationCode,
      startDate: dates[i],
    }, deps);
    portalClasses = portalClasses || chunk.classes;
    for (const [cls, perDate] of Object.entries(chunk.grid || {})) {
      portalGrid[cls] = { ...(portalGrid[cls] || {}), ...perDate };
    }
  }

  // F4: cells a human already authorised. Strictly matched on class+date+value
  // inside buildPushPlan, so a stale approval cannot carry a NEW price through
  // the band.
  const approvals = await db.ratePushLog.findMany({
    where: {
      tenantId, provider: PROVIDER, locationId, status: 'APPROVED',
      rateDate: { gte: new Date(`${dates[0]}T00:00:00Z`), lte: new Date(`${dates[dates.length - 1]}T00:00:00Z`) },
    },
    select: { id: true, classCode: true, rateDate: true, pushedValue: true },
  });
  const approvalRows = approvals.map((a) => ({
    id: a.id,
    classCode: a.classCode,
    rateDate: a.rateDate.toISOString().slice(0, 10),
    pushedValue: Number(a.pushedValue),
  }));

  const { pushes, skips } = buildPushPlan({
    rfmRates, dates, portalGrid, portalClasses,
    classOverrides: parseClassMap(config.rateClassMapJson),
    closeoutMin, maxDeltaPct: deps.maxDeltaPct || maxDeltaPct(),
    approvals: approvalRows,
  });

  const base = {
    tenantId, provider: PROVIDER, locationId, externalLocationCode,
    trigger, mode, createdByUserId: actorUserId,
  };

  // Skips are recorded too — the audit must show what we chose NOT to touch
  // (a preserved close-out is as important as a write).
  //
  // F4: an out-of-band move is a real repricing decision, so it does not just
  // die here — it is queued PENDING_APPROVAL with the value it WOULD publish,
  // unless an identical pending row already waits (the sweep runs every 30 min
  // and must not spam the queue with duplicates).
  let queued = 0;
  for (const s of skips) {
    const isReviewable = s.reason === SKIP.OUT_OF_BAND && s.rateDate;
    const rateDate = s.rateDate ? new Date(`${s.rateDate}T00:00:00Z`) : new Date(`${dates[0]}T00:00:00Z`);

    if (isReviewable) {
      const already = await db.ratePushLog.findFirst({
        where: { tenantId, provider: PROVIDER, locationId, classCode: s.classCode, rateDate, status: 'PENDING_APPROVAL' },
        select: { id: true, pushedValue: true },
      });
      // A pending row for a DIFFERENT value is stale — the target moved, so
      // supersede it rather than leaving two competing asks in the queue.
      if (already && Number(already.pushedValue) === Number(s.intendedValue)) continue;
      if (already) {
        await db.ratePushLog.update({
          where: { id: already.id },
          data: { status: 'SKIPPED', skipReason: 'superseded_by_newer_target' },
        }).catch(() => null);
      }
      await db.ratePushLog.create({
        data: {
          ...base,
          classCode: s.classCode,
          rateDate,
          priorValue: s.priorValue ?? null,
          // The value awaiting sign-off — NOT a zero placeholder, so the queue
          // reads as "portal $11 -> RFM $20" rather than "-> $0".
          pushedValue: s.intendedValue ?? 0,
          sourceRateItemId: s.sourceRateItemId || null,
          status: 'PENDING_APPROVAL',
          skipReason: s.reason,
        },
      }).catch(() => null);
      queued += 1;
      continue;
    }

    await db.ratePushLog.create({
      data: {
        ...base,
        classCode: s.classCode,
        rateDate,
        priorValue: s.priorValue ?? null,
        pushedValue: s.intendedValue ?? 0,
        sourceRateItemId: s.sourceRateItemId || null,
        status: 'SKIPPED',
        skipReason: s.reason,
      },
    }).catch(() => null);
  }

  const results = { planned: pushes.length, sent: 0, verified: 0, mismatched: 0, failed: 0, skipped: skips.length, queued };

  for (const p of pushes) {
    // F4: an approved cell REUSES its approval row, so one row carries the
    // whole lifecycle (PENDING_APPROVAL -> APPROVED -> SENT -> VERIFIED) and
    // the approval is consumed exactly once — it cannot authorise a second
    // sweep. Everything else opens a fresh row as before.
    const approvalRow = p.approved
      ? approvalRows.find((a) => a.classCode === p.classCode && a.rateDate === p.rateDate && a.pushedValue === p.pushedValue)
      : null;

    // An approval is spent by a REAL push, never by a rehearsal. In DRY_RUN the
    // row stays APPROVED (only its observed priorValue refreshes) so the
    // decision survives every dry sweep and is still waiting when the mode
    // finally goes LIVE. Consuming it here would silently discard a human's
    // sign-off and re-queue the same question 30 minutes later.
    const row = approvalRow
      ? await db.ratePushLog.update({
        where: { id: approvalRow.id },
        data: mode === MODES.DRY_RUN
          ? { priorValue: p.priorValue ?? null }
          : { status: 'SENT', trigger, mode, priorValue: p.priorValue ?? null },
      })
      : await db.ratePushLog.create({
        data: {
          ...base,
          classCode: p.classCode,
          rateDate: new Date(`${p.rateDate}T00:00:00Z`),
          priorValue: p.priorValue ?? null,
          pushedValue: p.pushedValue,
          sourceRateItemId: p.sourceRateItemId || null,
          status: mode === MODES.DRY_RUN ? 'PLANNED' : 'SENT',
        },
      });

    if (mode === MODES.DRY_RUN) {
      logger.info('[economy-rate-push] DRY RUN would push', {
        location: externalLocationCode, classCode: p.classCode, rateDate: p.rateDate,
        from: p.priorValue, to: p.pushedValue,
      });
      continue;
    }

    try {
      await client.applyRateCell(tenantId, {
        provider: config.provider || process.env.ECONOMY_RATE_PUSH_PROVIDER || '61201',
        location: externalLocationCode,
        classCode: p.classCode,
        rateDate: p.rateDate,
        dailyValue: p.pushedValue,
      }, deps);
      results.sent += 1;

      // The response body claims success even when the value was ignored, so
      // the read-back is the only evidence that counts.
      const back = await client.readRateGrid(tenantId, {
        provider: config.provider || process.env.ECONOMY_RATE_PUSH_PROVIDER || '61201',
        location: externalLocationCode,
        startDate: p.rateDate,
      }, deps);
      const readBackValue = back?.grid?.[p.classCode]?.[p.rateDate];
      const v = verifyPush({ pushedValue: p.pushedValue, readBackValue });
      if (v.status === 'VERIFIED') results.verified += 1; else results.mismatched += 1;
      await db.ratePushLog.update({
        where: { id: row.id },
        data: { status: v.status, verifiedValue: v.verifiedValue, verifiedAt: new Date() },
      });
      if (v.status !== 'VERIFIED') {
        logger.warn('[economy-rate-push] portal claimed success but the value did not land', {
          location: externalLocationCode, classCode: p.classCode, rateDate: p.rateDate,
          sent: p.pushedValue, readBack: v.verifiedValue,
        });
      }
    } catch (err) {
      results.failed += 1;
      await db.ratePushLog.update({
        where: { id: row.id },
        data: { status: 'FAILED', error: String(err?.message || err) },
      }).catch(() => null);
      logger.error('[economy-rate-push] push failed', {
        location: externalLocationCode, classCode: p.classCode, rateDate: p.rateDate,
        message: String(err?.message || err),
      });
    }
  }

  logger.info('[economy-rate-push] area complete', { externalArea: config.externalArea, mode, ...results });
  return { externalArea: config.externalArea, mode, ...results };
}

/** Sweep every area that is switched on for push. */
export async function pushAllAreas(deps = {}) {
  const db = deps.prisma || prisma;
  const mode = deps.mode || pushMode();
  if (mode === MODES.OFF) return { skipped: 'mode_off' };
  const configs = await db.economyLocationConfig.findMany({ where: { enabled: true, ratePushEnabled: true } });
  const results = [];
  for (const config of configs) {
    try { results.push(await pushArea(config, deps)); }
    catch (err) {
      logger.error('[economy-rate-push] area sweep failed', {
        externalArea: config.externalArea, message: String(err?.message || err),
      });
      results.push({ externalArea: config.externalArea, error: String(err?.message || err) });
    }
  }
  return { processedAreas: results.length, mode, results };
}
