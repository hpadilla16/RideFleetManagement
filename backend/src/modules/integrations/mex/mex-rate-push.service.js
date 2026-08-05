/**
 * MEX rate writeback — orchestration (2026-08-06). MONEY-ADJACENT: this writes
 * prices into MEX's live reservation system (TSD RezCentral).
 *
 * Contract: doc/mex-rate-writeback-recon-2026-08-05.md. Transport lives in
 * mex.service.js (fetchRateUpdateScreen / preloadRateGrid / submitRateGrid);
 * this file decides WHAT to write and records every decision.
 *
 * Flow per eligible rate code:
 *   1. Preload the portal grid (Button2) — the read-back the plan diffs against,
 *      and the source of the row→class mapping (indices shift, never hardcoded).
 *   2. buildRatePlan: RFM's daily per class → Hector's confirmed tier formula
 *      (weekly = daily × 7, monthly = daily × 28, x-day = daily), no-ops
 *      skipped, out-of-band moves HELD, classes without an RFM price left
 *      untouched.
 *   3. DRY_RUN records the plan and writes NOTHING. LIVE submits the grid and
 *      verifies against WebRateReport1.aspx — every written class must come
 *      back "Completed", in the portal's own words.
 *   4. Every (class × tier) decision lands in RatePushLog, provider MEX.
 *
 * WRITE LIST: ONLY mexRatePushEligibleCodes() — the classified non-inclusivo
 * codes from Hector's PDF. The other portal codes are NEVER written
 * ("solo le vas a escribir a los que te dije", 2026-08-05).
 */
import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import {
  preloadRateGrid,
  submitRateGrid,
  pickUserAgent,
  RATE_GRID_FIELD,
} from './mex.service.js';
import { mexRatePushEligibleCodes } from './mex.constants.js';

export const MODES = Object.freeze({ OFF: 'OFF', DRY_RUN: 'DRY_RUN', LIVE: 'LIVE' });
const PROVIDER = 'MEX';

/** Global transport gate. Default OFF — nobody pushes prices by accident. */
export function pushMode() {
  const raw = String(process.env.MEX_RATE_PUSH_MODE || 'OFF').toUpperCase();
  return MODES[raw] || MODES.OFF;
}

/** Largest allowed move against the portal's EXISTING daily, in percent. */
export function maxDeltaPct() {
  const n = Number(process.env.MEX_RATE_PUSH_MAX_DELTA_PCT || 60);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/**
 * How far forward each write applies, in days. 28 by Hector's instruction
 * (2026-08-06): each push covers the next four weeks and the next day's push
 * slides the window forward — today's MI price must not be locked onto dates
 * a year out, where it would flatten seasonal pricing MEX may carry.
 */
export function pushWindowDays() {
  const n = Number(process.env.MEX_RATE_PUSH_WINDOW_DAYS || 28);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 360) : 28;
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Hector's tier formula, CONFIRMED 2026-08-05 against the portal's own data:
 * every existing (daily, weekly, monthly, x-day) tuple on BPABR read exactly
 * d / d×7 / d×28 / d. ×28, not ×30 — his correction after the Preload.
 */
export function mexTierValues(daily) {
  const d = round2(daily);
  return { daily: d, weekly: round2(d * 7), monthly: round2(d * 28), xday: d };
}

/** Tier → RatePushLog.plan code (Economy's vocabulary: DY/WY/MY/ED). */
export const TIER_PLAN = Object.freeze({ daily: 'DY', weekly: 'WY', monthly: 'MY', xday: 'ED' });

export const DECISION = Object.freeze({
  WRITE: 'WRITE',
  SKIP_SAME: 'SKIP_SAME',
  SKIP_NO_SOURCE: 'SKIP_NO_SOURCE',
  HELD_DELTA: 'HELD_DELTA',
});

/**
 * RFM's per-class daily for one Ride location — the truth MI maintains.
 * Same source Economy pushes from: active rates' rateItems (daily > 0).
 * Two ACTIVE items disagreeing on one class is ambiguity, not a choice we
 * make silently — the class is excluded and reported.
 */
export async function loadDesiredMexRates(tenantId, locationId, deps = {}) {
  const db = deps.prisma || prisma;
  const rates = await db.rate.findMany({
    where: { tenantId, locationId, active: true },
    select: { id: true, name: true, rateItems: { select: { id: true, daily: true, vehicleType: { select: { code: true } } } } },
  });

  const byClass = new Map();
  const conflicts = [];
  for (const rate of rates) {
    for (const item of rate.rateItems || []) {
      const code = String(item?.vehicleType?.code || '').trim().toUpperCase();
      const daily = Number(item?.daily);
      if (!code || !Number.isFinite(daily) || daily <= 0) continue;
      const prior = byClass.get(code);
      if (prior && prior.daily !== daily) {
        conflicts.push({ classCode: code, values: [prior.daily, daily] });
        byClass.delete(code);
        continue;
      }
      if (!prior) byClass.set(code, { daily, sourceRateItemId: item.id });
    }
  }

  // The portal sells classes RFM does not stock under those codes (ECAR is a
  // NISSAN VERSA; IRC's economy class is CCAR). The tenant's AcrissCategoryMap
  // already encodes that redirect for imports — reuse it in reverse rather
  // than invent a second mapping that can drift.
  const maps = await db.acrissCategoryMap.findMany({
    where: { OR: [{ tenantId }, { tenantId: null }] },
    select: { acrissCode: true, vehicleCategory: true, tenantId: true },
  }).catch(() => []);
  const redirect = new Map();
  for (const m of maps) {
    const from = String(m.acrissCode || '').toUpperCase();
    const to = String(m.vehicleCategory || '').toUpperCase();
    if (!from || !to || from === to) continue;
    // Tenant row wins over a global one.
    if (!redirect.has(from) || m.tenantId) redirect.set(from, to);
  }

  return { byClass, redirect, conflicts };
}

/** Desired daily for one PORTAL class: exact match first, map redirect second. */
export function resolveDesiredForClass(desired, portalClass) {
  const code = String(portalClass || '').trim().toUpperCase();
  if (!code) return null;
  const direct = desired.byClass.get(code);
  if (direct) return { ...direct, via: code };
  const mapped = desired.redirect.get(code);
  if (mapped) {
    const hit = desired.byClass.get(mapped);
    if (hit) return { ...hit, via: mapped };
  }
  return null;
}

/**
 * Pure. One decision per grid row.
 *
 * A class the portal shows but RFM has no price for is LEFT ALONE (skip, not
 * zero — writing 0 would make a Kona free). A move beyond maxDeltaPct against
 * the portal's existing daily is HELD for a human unless `force` — the same
 * posture as MI's autoMaxDeltaPct, because a huge delta is either a market
 * event or bad data, and only a person knows which.
 */
export function buildRatePlan(rows, desired, { maxDeltaPct: maxPct = 60, force = false } = {}) {
  return (rows || []).map((row) => {
    const source = resolveDesiredForClass(desired, row.classCode);
    if (!source) {
      return { ...row, decision: DECISION.SKIP_NO_SOURCE, desired: null, source: null };
    }
    const want = mexTierValues(source.daily);
    const cur = row.current || {};
    const same = ['daily', 'weekly', 'monthly', 'xday']
      .every((k) => cur[k] != null && round2(cur[k]) === want[k]);
    if (same) {
      return { ...row, decision: DECISION.SKIP_SAME, desired: want, source };
    }
    const curDaily = Number(cur.daily);
    if (!force && Number.isFinite(curDaily) && curDaily > 0) {
      const deltaPct = Math.abs(want.daily - curDaily) / curDaily * 100;
      if (deltaPct > maxPct) {
        return { ...row, decision: DECISION.HELD_DELTA, desired: want, source, deltaPct: round2(deltaPct) };
      }
    }
    return { ...row, decision: DECISION.WRITE, desired: want, source };
  });
}

/** The grid override map for the WRITE rows — full field name → "70.00" string. */
export function buildGridOverrides(plan) {
  const out = {};
  for (const row of plan) {
    if (row.decision !== DECISION.WRITE) continue;
    out[`${row.rowPrefix}:${RATE_GRID_FIELD.DAILY}`] = row.desired.daily.toFixed(2);
    out[`${row.rowPrefix}:${RATE_GRID_FIELD.WEEKLY}`] = row.desired.weekly.toFixed(2);
    out[`${row.rowPrefix}:${RATE_GRID_FIELD.MONTHLY}`] = row.desired.monthly.toFixed(2);
    out[`${row.rowPrefix}:${RATE_GRID_FIELD.XDAY}`] = row.desired.xday.toFixed(2);
  }
  return out;
}

/**
 * Pure. Did WebRateReport1 confirm every class we wrote?
 * The contract: every written class must show ONLY "Completed" rows for this
 * code. A missing class or any other Result text = failed write for that class.
 */
export function verifyReport(reportRows, { rateCode, writtenClasses }) {
  const rows = (reportRows || []).filter(
    (r) => !rateCode || String(r.rateCode || '').toUpperCase() === String(rateCode).toUpperCase()
  );
  const byClass = new Map();
  for (const r of rows) {
    const cls = String(r.classCode || '').toUpperCase();
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(r);
  }
  const out = new Map();
  for (const cls of writtenClasses) {
    const hits = byClass.get(String(cls).toUpperCase()) || [];
    out.set(cls, {
      verified: hits.length > 0 && hits.every((r) => r.completed),
      rows: hits,
      reason: !hits.length ? 'class missing from the portal report'
        : hits.every((r) => r.completed) ? null
          : `portal result: ${hits.find((r) => !r.completed)?.result || 'unknown'}`,
    });
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight (UTC date value) for the log's rateDate column. */
function dateOnly(d) {
  return new Date(new Date(d).toISOString().slice(0, 10));
}

/**
 * Push RFM's current rates to the portal for every enabled MEX config.
 *
 * Modes: caller may force DRY_RUN below the env gate but can never exceed it —
 * LIVE requires MEX_RATE_PUSH_MODE=LIVE in the environment AND the caller
 * asking for it. Returns a full per-code, per-class account of what happened.
 */
export async function runMexRatePush(tenantId, opts = {}) {
  const db = opts.prisma || prisma;
  const envMode = pushMode();
  const wantLive = opts.live === true;
  if (envMode === MODES.OFF) return { skipped: 'mode_off', mode: envMode };
  const mode = wantLive && envMode === MODES.LIVE ? MODES.LIVE : MODES.DRY_RUN;

  const trigger = opts.trigger || 'MANUAL';
  const actorUserId = opts.actorUserId || null;
  const force = opts.force === true;
  const ua = pickUserAgent();

  const codes = (opts.rateCodes && opts.rateCodes.length
    ? opts.rateCodes.map((c) => String(c).toUpperCase())
    : mexRatePushEligibleCodes());
  const eligible = new Set(mexRatePushEligibleCodes());
  const refused = codes.filter((c) => !eligible.has(c));
  if (refused.length) {
    // Not a warning — a hard refusal. The non-eligible codes are inclusivo or
    // unclassified, and Hector's instruction was explicit.
    throw new Error(`rate codes not on the write list: ${refused.join(', ')}`);
  }

  const configs = await db.mexLocationConfig.findMany({
    where: { tenantId, enabled: true },
    select: { tsdNumber: true, branch: true, locationId: true },
  });
  if (!configs.length) return { skipped: 'no_enabled_config', mode };

  const now = opts.now ? new Date(opts.now) : new Date();
  const fromDate = opts.fromDate ? new Date(opts.fromDate) : now;
  const toDate = opts.toDate ? new Date(opts.toDate) : new Date(fromDate.getTime() + pushWindowDays() * DAY_MS);

  const summary = { mode, trigger, fromDate: fromDate.toISOString().slice(0, 10), toDate: toDate.toISOString().slice(0, 10), configs: [] };

  for (const config of configs) {
    const { tsdNumber, branch, locationId } = config;
    const externalLocationCode = `${tsdNumber}/${branch}`;
    const desired = await loadDesiredMexRates(tenantId, locationId, { prisma: db });
    const cfgOut = { tsdNumber, branch, conflicts: desired.conflicts, codes: [] };
    summary.configs.push(cfgOut);

    for (const rateCode of codes) {
      const codeOut = { rateCode, plan: [], verified: null, error: null };
      cfgOut.codes.push(codeOut);
      try {
        const preload = await preloadRateGrid(tenantId, { rateCode, tsdNumber, branch, userAgent: ua });
        const plan = buildRatePlan(preload.rows, desired, { maxDeltaPct: maxDeltaPct(), force });
        codeOut.plan = plan.map(({ rowPrefix, ...rest }) => rest);

        const writes = plan.filter((r) => r.decision === DECISION.WRITE);
        const logRow = (row, tier, status, skipReason = null) => ({
          tenantId, provider: PROVIDER, locationId, externalLocationCode,
          classCode: String(row.classCode || '?'), rateDate: dateOnly(fromDate),
          plan: TIER_PLAN[tier], rateCode,
          priorValue: row.current?.[tier] != null ? round2(row.current[tier]) : null,
          pushedValue: row.desired ? row.desired[tier] : 0,
          sourceRateItemId: row.source?.sourceRateItemId || null,
          trigger, mode, status, skipReason,
          ...(actorUserId ? { createdByUserId: actorUserId } : {}),
        });

        const logs = [];
        for (const row of plan) {
          for (const tier of ['daily', 'weekly', 'monthly', 'xday']) {
            if (row.decision === DECISION.WRITE) {
              logs.push(logRow(row, tier, mode === MODES.LIVE ? 'SENT' : 'PLANNED'));
            } else if (row.decision === DECISION.HELD_DELTA) {
              logs.push(logRow(row, tier, 'SKIPPED', `delta ${row.deltaPct}% > ${maxDeltaPct()}%`));
            } else if (row.decision === DECISION.SKIP_SAME && tier === 'daily') {
              logs.push(logRow(row, tier, 'SKIPPED', 'portal already matches'));
            } else if (row.decision === DECISION.SKIP_NO_SOURCE && tier === 'daily') {
              logs.push(logRow(row, tier, 'SKIPPED', 'no RFM rate for this class'));
            }
          }
        }

        if (!writes.length || mode !== MODES.LIVE) {
          if (logs.length) await db.ratePushLog.createMany({ data: logs }).catch((e) => {
            logger.warn('[mex-rate-push] could not persist plan logs', { tenantId, rateCode, message: e.message });
          });
          continue;
        }

        const { reportRows } = await submitRateGrid(tenantId, {
          preload, rateCode, tsdNumber, branch, fromDate, toDate,
          gridOverrides: buildGridOverrides(plan), userAgent: ua,
        });
        const verdicts = verifyReport(reportRows, {
          rateCode, writtenClasses: writes.map((r) => r.classCode),
        });
        codeOut.verified = Object.fromEntries(
          [...verdicts.entries()].map(([cls, v]) => [cls, { verified: v.verified, reason: v.reason }])
        );

        for (const log of logs) {
          if (log.status !== 'SENT') continue;
          const verdict = verdicts.get(log.classCode) || verdicts.get(String(log.classCode));
          log.status = verdict?.verified ? 'VERIFIED' : 'MISMATCH';
          if (!verdict?.verified) log.skipReason = verdict?.reason || 'not confirmed by the portal report';
        }
        await db.ratePushLog.createMany({ data: logs }).catch((e) => {
          logger.warn('[mex-rate-push] could not persist result logs', { tenantId, rateCode, message: e.message });
        });

        const bad = [...verdicts.values()].filter((v) => !v.verified);
        if (bad.length) {
          logger.warn('[mex-rate-push] portal did not confirm every class', {
            tenantId, rateCode, failed: bad.length,
          });
        }
      } catch (err) {
        codeOut.error = err.message;
        logger.error('[mex-rate-push] code failed', { tenantId, rateCode, message: err.message });
        await db.ratePushLog.create({
          data: {
            tenantId, provider: PROVIDER, locationId, externalLocationCode,
            classCode: '*', rateDate: dateOnly(fromDate), plan: 'DY', rateCode,
            pushedValue: 0, trigger, mode, status: 'FAILED', skipReason: err.message.slice(0, 500),
          },
        }).catch(() => {});
      }
    }
  }

  return summary;
}
