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
import { loadStopSaleClosures, STOP_SALE_DAILY as SHARED_STOP_SALE_DAILY } from '../booking-source/stop-sale-closures.js';
import { loadDailyOverrides, resolvePricePolicy, makeConnectionRebaser } from '../booking-source/price-source.js';
import { resolvePushFranchiseId, selectRatesForFranchise, isFranchiseSpecific } from '../booking-source/rate-franchise.js';

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
 * The close-out price (Hector, 2026-08-06: "si nosotros ponemos un stop sales
 * en el sistema de Ride que automaticamente para la proxima corrida subir todo
 * los precios a 999.99, y calculalo por semana mensual"). MEX has no
 * availability API, so a class closed in Ride is closed on the portal by
 * pricing it out: daily 999.99, weekly ×7, monthly ×28, x-day = daily — the
 * same formula as every other write, so the portal's own arithmetic stays
 * consistent. The constant and the closure loader live in
 * booking-source/stop-sale-closures.js so EVERY writeback integration answers
 * "is this class closed on this date" identically.
 */
export const STOP_SALE_DAILY = SHARED_STOP_SALE_DAILY;

/**
 * RFM's per-class pricing for one Ride location ACROSS A DATE WINDOW — the
 * truth the booking engine itself quotes from (Hector, 2026-08-06: "tiene que
 * mirar los 28 dias de precio ya que sube y baja los precios").
 *
 * Per class: the base daily from the active rate's RateItem, PLUS the per-date
 * RateDailyPrice overrides the SEDE has chosen to publish (deps.priceSource —
 * MANUAL keeps Market Intelligence off the portal, MARKET lets it through; see
 * booking-source/price-source.js). The effective price for a date is
 * override-wins — the exact semantics of rates.service resolveForRental, so
 * what MEX charges on a date is what our own booking engine would have charged
 * from the same source.
 *
 * Two ACTIVE items disagreeing on one class is ambiguity, not a choice we
 * make silently — the class is excluded and reported.
 */
export async function loadDesiredMexRates(tenantId, locationId, deps = {}) {
  const db = deps.prisma || prisma;
  const from = deps.from ? new Date(deps.from) : null;
  const to = deps.to ? new Date(deps.to) : null;
  const allRates = await db.rate.findMany({
    where: { tenantId, locationId, active: true },
    select: {
      id: true, name: true, franchiseId: true,
      rateItems: { select: { id: true, daily: true, vehicleTypeId: true, vehicleType: { select: { code: true } } } },
    },
  });

  // Whose shelf is this? A rate carrying no franchise is SHARED, which is what
  // every rate is today — so with nothing split this narrows to `allRates` and
  // the behaviour below is byte-identical to what it has always been. See
  // booking-source/rate-franchise.js for why publishing another brand's prices
  // is the failure this prevents.
  const franchiseId = deps.franchiseId !== undefined
    ? deps.franchiseId
    : await resolvePushFranchiseId(db, { tenantId, provider: 'MEX' });
  const rates = selectRatesForFranchise(allRates, franchiseId);

  // Two ACTIVE rates disagreeing on one class is ambiguity, and the class is
  // excluded rather than guessed at. That rule holds WITHIN a tier; ACROSS
  // tiers it does not apply, because a brand's own rate beating the house one
  // is not a disagreement, it is the whole point of splitting them.
  const fold = (list) => {
    const byClass = new Map();
    const conflicts = [];
    for (const rate of list) {
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
        if (!prior) {
          byClass.set(code, {
            daily, sourceRateItemId: item.id,
            rateId: rate.id, vehicleTypeId: item.vehicleTypeId,
            byDate: new Map(),
          });
        }
      }
    }
    return { byClass, conflicts };
  };

  const mine = fold(rates.filter((r) => isFranchiseSpecific(r, franchiseId)));
  const shared = fold(rates.filter((r) => !isFranchiseSpecific(r, franchiseId)));

  const byClass = mine.byClass;
  const conflicts = [...mine.conflicts];
  // A class this brand did not price falls back to the shared rate. A class the
  // brand's OWN rates disagreed about stays excluded — letting the house rate
  // fill it would hide a real misconfiguration behind a plausible number.
  const brandConflicted = new Set(mine.conflicts.map((c) => c.classCode));
  for (const [code, v] of shared.byClass) {
    if (byClass.has(code) || brandConflicted.has(code)) continue;
    byClass.set(code, v);
  }
  for (const c of shared.conflicts) {
    if (!byClass.has(c.classCode) && !brandConflicted.has(c.classCode)) conflicts.push(c);
  }

  // Per-date overrides for the window, keyed the way the booking engine keys
  // them: (rateId, vehicleTypeId, date). A class whose base was excluded above
  // stays excluded — an override cannot resurrect an ambiguous class.
  if (from && to && byClass.size) {
    const pairs = [...byClass.values()].map((v) => ({ rateId: v.rateId, vehicleTypeId: v.vehicleTypeId }));
    const overrides = await loadDailyOverrides(db, { pairs, from, to, priceSource: deps.priceSource });
    for (const [code, v] of byClass.entries()) {
      const byDate = overrides.get(`${v.rateId}:${v.vehicleTypeId}`);
      if (!byDate) continue;
      for (const [iso, daily] of byDate) byClass.get(code).byDate.set(iso, round2(daily));
    }
  }

  // STOP SALES beat everything (Hector, 2026-08-06). A class closed in Ride is
  // closed on the portal by price: every closed date overlays STOP_SALE_DAILY,
  // ON TOP of base and MI overrides. Deliberately able to CREATE a class entry
  // — a class with no RFM rate still deserves its closure; leaving it open at
  // the portal's own price because we could not price it would sell cars Ride
  // has declared unsellable. Shared loader: every writeback integration reads
  // the same closures the same way.
  if (from && to) {
    const closures = await loadStopSaleClosures(db, { tenantId, from, to });
    for (const [code, days] of closures) {
      if (!byClass.has(code)) byClass.set(code, { daily: null, sourceRateItemId: null, byDate: new Map() });
      const entry = byClass.get(code);
      for (const iso of days) entry.byDate.set(iso, STOP_SALE_DAILY);
    }
  }

  // The portal sells classes RFM does not stock under those codes (ECAR is a
  // NISSAN VERSA; IRC's economy class is CCAR). The tenant's AcrissCategoryMap
  // already encodes that redirect for imports — reuse it in reverse rather
  // than invent a second mapping that can drift.
  // Same-sede, different-connection re-solve (2026-09-08). Applied to the base
  // AND to every per-date override, but NEVER to a stop-sale: STOP_SALE_DAILY is
  // a sentinel that closes a class by pricing it out, not a price, and running
  // it through a gross-up would turn a closure into an oddly specific number.
  const rebase = await makeConnectionRebaser(db, {
    tenantId, locationId, connectionType: deps.connectionType,
  });
  for (const entry of byClass.values()) {
    if (entry.daily != null) entry.daily = rebase(entry.daily);
    for (const [iso, v] of entry.byDate) {
      if (v !== STOP_SALE_DAILY) entry.byDate.set(iso, rebase(v));
    }
  }

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

/** Desired pricing for one PORTAL class: exact match first, map redirect second. */
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

/** Effective daily for a class ON A DATE: the override wins, the base backs it. */
export function effectiveDailyOn(entry, isoDate) {
  if (!entry) return null;
  const byDate = entry.byDate;
  if (byDate && byDate.has(isoDate)) return byDate.get(isoDate);
  // A stop-sale-only entry has no base — its open days simply have no price.
  const base = Number(entry.daily);
  return Number.isFinite(base) && base > 0 ? round2(base) : null;
}

/** ISO date list [from, from+days). Pure. */
export function isoDates(from, days) {
  const start = new Date(new Date(from).toISOString().slice(0, 10));
  const out = [];
  for (let i = 0; i < days; i += 1) {
    out.push(new Date(start.getTime() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Pure. Split the window into contiguous BANDS where every class's effective
 * price is constant, because the portal writes date RANGES, not per-day cells.
 * A flat window (no overrides) collapses to exactly one band — the pre-per-date
 * behavior. Each band: { fromDate, toDate (inclusive), prices: Map<class, daily> }.
 */
export function buildPushBands(desired, portalClasses, dates) {
  const bands = [];
  let current = null;
  for (const iso of dates) {
    const prices = new Map();
    for (const cls of portalClasses) {
      const entry = resolveDesiredForClass(desired, cls);
      const daily = effectiveDailyOn(entry, iso);
      if (daily != null) prices.set(cls, daily);
    }
    const key = JSON.stringify([...prices.entries()].sort());
    if (current && current.key === key) {
      current.toDate = iso;
    } else {
      current = { key, fromDate: iso, toDate: iso, prices };
      bands.push(current);
    }
  }
  return bands.map(({ key, ...band }) => band);
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
    // A stop-sale close-out bypasses the delta guard: 999.99 against any real
    // price is always out of band, and holding it for review would leave a
    // class Ride has CLOSED still selling on the portal overnight.
    const isStopSale = want.daily === STOP_SALE_DAILY;
    const curDaily = Number(cur.daily);
    if (!force && !isStopSale && Number.isFinite(curDaily) && curDaily > 0) {
      const deltaPct = Math.abs(want.daily - curDaily) / curDaily * 100;
      if (deltaPct > maxPct) {
        return { ...row, decision: DECISION.HELD_DELTA, desired: want, source, deltaPct: round2(deltaPct) };
      }
    }
    return { ...row, decision: DECISION.WRITE, desired: want, source, ...(isStopSale ? { stopSale: true } : {}) };
  });
}

/**
 * Adapt one band for buildRatePlan: its prices are already resolved PER PORTAL
 * CLASS (buildPushBands applied the redirect), so the redirect map is empty by
 * construction — resolving twice would double-hop.
 */
export function bandToDesired(desired, band) {
  const byClass = new Map();
  for (const [cls, daily] of band.prices) {
    const src = resolveDesiredForClass(desired, cls);
    byClass.set(cls, { daily, sourceRateItemId: src?.sourceRateItemId || null });
  }
  return { byClass, redirect: new Map(), conflicts: desired.conflicts };
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
  const windowDays = opts.toDate
    ? Math.max(1, Math.round((new Date(opts.toDate) - fromDate) / DAY_MS) + 1)
    : pushWindowDays();
  const dates = isoDates(fromDate, windowDays);
  const toExclusive = new Date(new Date(dates[0]).getTime() + windowDays * DAY_MS);

  const summary = { mode, trigger, fromDate: dates[0], toDate: dates[dates.length - 1], configs: [] };

  for (const config of configs) {
    const { tsdNumber, branch, locationId } = config;
    const externalLocationCode = `${tsdNumber}/${branch}`;
    // Does this sede push rates at all, and whose? Resolved per config, not
    // per tenant: two sedes of the same tenant may legitimately disagree.
    //
    // Until 2026-09-07 MEX had no rate-push switch of its own — the only way to
    // stop a sede writing prices was to disable its MexLocationConfig, which
    // also stopped the INBOUND reservation sync. Two unrelated things behind
    // one switch, and the reason a sede could not be paused for testing without
    // losing its bookings.
    const policy = await resolvePricePolicy(db, { tenantId, locationId, provider: PROVIDER });
    const { priceSource } = policy;
    if (!policy.ratePushEnabled) {
      summary.configs.push({ tsdNumber, branch, priceSource, skipped: 'sede_disabled', codes: [] });
      continue;
    }
    // The whole window's pricing, the chosen overrides included — the series
    // MEX has to mirror, not just today's number.
    const desired = await loadDesiredMexRates(tenantId, locationId, {
      prisma: db, from: dates[0], to: toExclusive, priceSource,
      connectionType: policy.connectionType,
    });
    // Reported so a dry run says which prices it planned from. Reading a plan
    // without knowing the source is how you approve MI's numbers thinking they
    // are yours.
    const cfgOut = { tsdNumber, branch, priceSource, conflicts: desired.conflicts, codes: [] };
    summary.configs.push(cfgOut);

    for (const rateCode of codes) {
      const codeOut = { rateCode, bands: [], error: null };
      cfgOut.codes.push(codeOut);
      try {
        // One preload up front — the window's dates are part of the preload
        // (rates live per date window; a Preload without dates loads nothing).
        // Gives the classes the grid renders and the current values for the
        // full window.
        let preload = await preloadRateGrid(tenantId, {
          rateCode, tsdNumber, branch,
          fromDate: dates[0], toDate: dates[dates.length - 1], userAgent: ua,
        });
        const portalClasses = preload.rows.map((r) => r.classCode).filter(Boolean);

        // Days where every class prices the same collapse into ONE portal
        // write; a price change on any class starts a new band. A flat window
        // is exactly one band.
        const bands = buildPushBands(desired, portalClasses, dates);

        for (let i = 0; i < bands.length; i += 1) {
          const band = bands[i];
          // Each submit consumes the screen (the portal redirects to the
          // report), and each band has its OWN date window — so every band
          // beyond a lone full-window one re-preloads with its dates.
          if (i > 0 || bands.length > 1) {
            preload = await preloadRateGrid(tenantId, {
              rateCode, tsdNumber, branch,
              fromDate: band.fromDate, toDate: band.toDate, userAgent: ua,
            });
          }

          const plan = buildRatePlan(preload.rows, bandToDesired(desired, band), { maxDeltaPct: maxDeltaPct(), force });
          const bandOut = {
            fromDate: band.fromDate, toDate: band.toDate,
            plan: plan.map(({ rowPrefix, ...rest }) => rest),
            verified: null,
          };
          codeOut.bands.push(bandOut);

          const writes = plan.filter((r) => r.decision === DECISION.WRITE);
          const logRow = (row, tier, status, skipReason = null) => ({
            tenantId, provider: PROVIDER, locationId, externalLocationCode,
            classCode: String(row.classCode || '?'), rateDate: dateOnly(band.fromDate),
            plan: TIER_PLAN[tier], rateCode,
            priorValue: row.current?.[tier] != null ? round2(row.current[tier]) : null,
            pushedValue: row.desired ? row.desired[tier] : 0,
            sourceRateItemId: row.source?.sourceRateItemId || null,
            // Whose number this was. Reviewing a push without it means judging
            // a price with no idea whether a person or the pricing engine
            // proposed it.
            priceSource,
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
            preload, rateCode, tsdNumber, branch,
            gridOverrides: buildGridOverrides(plan), userAgent: ua,
          });
          const verdicts = verifyReport(reportRows, {
            rateCode, writtenClasses: writes.map((r) => r.classCode),
          });
          bandOut.verified = Object.fromEntries(
            [...verdicts.entries()].map(([cls, v]) => [cls, { verified: v.verified, reason: v.reason }])
          );

          for (const log of logs) {
            if (log.status !== 'SENT') continue;
            const verdict = verdicts.get(log.classCode);
            log.status = verdict?.verified ? 'VERIFIED' : 'MISMATCH';
            if (!verdict?.verified) log.skipReason = verdict?.reason || 'not confirmed by the portal report';
          }
          await db.ratePushLog.createMany({ data: logs }).catch((e) => {
            logger.warn('[mex-rate-push] could not persist result logs', { tenantId, rateCode, message: e.message });
          });

          const bad = [...verdicts.values()].filter((v) => !v.verified);
          if (bad.length) {
            logger.warn('[mex-rate-push] portal did not confirm every class', {
              tenantId, rateCode, band: `${band.fromDate}..${band.toDate}`, failed: bad.length,
            });
          }
        }
      } catch (err) {
        codeOut.error = err.message;
        logger.error('[mex-rate-push] code failed', { tenantId, rateCode, message: err.message });
        await db.ratePushLog.create({
          data: {
            tenantId, provider: PROVIDER, locationId, externalLocationCode,
            classCode: '*', rateDate: dateOnly(fromDate), plan: 'DY', rateCode,
            pushedValue: 0, priceSource, trigger, mode, status: 'FAILED', skipReason: err.message.slice(0, 500),
          },
        }).catch(() => {});
      }
    }
  }

  return summary;
}
