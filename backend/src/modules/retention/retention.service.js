/**
 * retention.service.js — GDPR Wave 2 Phase C: the automatic RETENTION SWEEP.
 *
 * THIS DESTROYS DATA. It carries the SAME sacred invariants as the on-request
 * erasure primitive (QA attacks these):
 *   1. OFF BY DEFAULT — the scheduler does not register while
 *      RETENTION_SWEEP_ENABLED is not 'true'. (Enforced in the scheduler.)
 *   2. PREVIEW-ONLY BY DEFAULT — runSweep({ apply }) defaults apply=false. A
 *      preview computes the FULL candidate set, LOGS what it WOULD purge
 *      (counts + sample ids) and mutates NOTHING. Only apply:true mutates, and
 *      even then RETENTION_SWEEP_APPLY must be 'true' at the scheduler edge.
 *   3. BATCH CAP — at most RETENTION_SWEEP_BATCH (default 100) records per
 *      category per run. NEVER an unbounded mass deleteMany.
 *   4. ABORT-ON-ANOMALY — if a category's candidate count exceeds
 *      RETENTION_SWEEP_MAX_PER_RUN (default 5000) the category is ABORTED (logs
 *      LOUD, mutates nothing) and requires a manual override
 *      (RETENTION_SWEEP_FORCE=true) — a clock/query bug must never mass-destroy.
 *   5. KILL-SWITCH — RETENTION_SWEEP_ENABLED=false halts the scheduler on the
 *      next tick. (Enforced in the scheduler.)
 * ALWAYS LOG BEFORE PURGE.
 *
 * TWO-CLOCK MODEL (product-owner decision, all periods env-configurable):
 *   - Identity clock (RETENTION_IDENTITY_YEARS, default 4) — the claims window.
 *     Counted from the rental close: RentalAgreement.returnedAt ?? closedAt;
 *     LoanerAgreement.closedAt. At this clock the IDENTITY snapshot is erased
 *     but the accounting facts are KEPT.
 *   - Accounting clock (RETENTION_ACCOUNTING_YEARS, default 10) — PR Hacienda.
 *     At this clock the accounting residual is anonymised too.
 *   - System/access logs (RETENTION_LOG_MONTHS, default 13) — delete old
 *     ModuleAccessAuditLog / EndpointLoadObservation(+Daily) rows.
 *
 * RECORD-scoped, not customer-scoped (a customer can have old AND recent
 * rentals):
 *   - Per old agreement (identity clock, piiPurgedAt IS NULL): strip the
 *     IDENTITY snapshot ON THAT RECORD + its cascade children, then stamp
 *     piiPurgedAt so re-runs skip it. Does NOT touch the customer master row.
 *   - Per fully-inactive customer (last reservation older than identity clock,
 *     no OPEN incident/claim): reuse the Phase A eraseCustomer primitive.
 *   - NEVER strip identity on a record/customer with a recent (< identity
 *     clock) rental or an OPEN incident/damage/claim.
 *   - Accounting clock: anonymise the accounting residual (money → 0,
 *     agreementNumber → per-row sentinel) where FK-RESTRICT prevents delete.
 *
 * REUSE: erasure primitives are imported, never reimplemented —
 *   - eraseCustomer + gdprErasureEnabled + buildEraseData + collectStorageRefs
 *     from customer-erasure.service.js
 *   - CUSTOMER_PII_MAP identity classification + REDACTION from customer-pii-map.js
 *   - chunk from customer-pii-reach.js
 *
 * Pure / injectable: every dependency (prisma, logger, deleteObject,
 * eraseCustomer, now) is injectable via `deps` so the suite runs DB-free.
 * ESM. No new npm deps.
 */

import { prisma as defaultPrisma } from '../../lib/prisma.js';
import defaultLogger from '../../lib/logger.js';
import { deleteObject as defaultDeleteObject } from '../../lib/storage/index.js';
import {
  eraseCustomer as defaultEraseCustomer,
  gdprErasureEnabled,
  buildEraseData,
  collectStorageRefs,
} from '../customers/customer-erasure.service.js';
import {
  CUSTOMER_PII_MAP,
  RETENTION_MODES,
  classifyStorageRef,
  REDACTION,
} from '../customers/customer-pii-map.js';
import { chunk } from '../customers/customer-pii-reach.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SAMPLE_LIMIT = 10; // ids logged per category in the preview

// Sentinel PREFIX written into a required @unique agreementNumber when the
// accounting residual is anonymised (past the accounting clock). Per-row so it
// never collides with the @unique constraint, and used as the idempotency
// marker (a re-run skips already-anonymised rows).
export const ACCOUNTING_REDACT_PREFIX = '[erased:';
const acctNumber = (id) => `${ACCOUNTING_REDACT_PREFIX}${id}]`;

// ---------------------------------------------------------------------------
// PERIOD TABLE — the single source of truth, env-driven, read FRESH each call
// so an operator toggle needs no restart. Counsel will confirm the numbers —
// nothing is hard-coded as immutable.
// ---------------------------------------------------------------------------
function num(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getPeriods() {
  return Object.freeze({
    identityYears: num('RETENTION_IDENTITY_YEARS', 4),
    accountingYears: num('RETENTION_ACCOUNTING_YEARS', 10),
    logMonths: num('RETENTION_LOG_MONTHS', 13),
  });
}

export function getLimits() {
  return Object.freeze({
    batch: Math.max(1, Math.trunc(num('RETENTION_SWEEP_BATCH', 100))),
    maxPerRun: Math.max(1, Math.trunc(num('RETENTION_SWEEP_MAX_PER_RUN', 5000))),
    force: String(process.env.RETENTION_SWEEP_FORCE || '').toLowerCase() === 'true',
  });
}

// Whole-calendar-year / month subtraction from a reference instant.
function yearsAgo(now, years) {
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}
function monthsAgo(now, months) {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

export function computeCutoffs(now = new Date(), periods = getPeriods()) {
  return {
    identity: yearsAgo(now, periods.identityYears),
    accounting: yearsAgo(now, periods.accountingYears),
    logs: monthsAgo(now, periods.logMonths),
  };
}

// ---------------------------------------------------------------------------
// Which map specs are the cascade CHILDREN of an agreement, derived from the
// shared PII map's match.kind so the two cannot drift. Vehicle-photo specs
// (RETAIN_PHOTOS) are excluded — those are retained evidence.
// ---------------------------------------------------------------------------
const RENTAL_CHILD_SPECS = Object.values(CUSTOMER_PII_MAP).filter(
  (s) => s.match?.kind === 'agreementRelation' && s.retention !== 'RETAIN_PHOTOS',
);
const LOANER_CHILD_SPECS = Object.values(CUSTOMER_PII_MAP).filter(
  (s) => s.match?.kind === 'loanerRelation' && s.retention !== 'RETAIN_PHOTOS',
);

// OPEN incident/claim status sets — the claims window is the whole basis for
// the identity clock, so a record with any of these is NEVER swept. Anything
// terminal (resolved/closed/void/fixed) is not open.
const OPEN_RESERVATION_INCIDENT = ['DRAFT', 'ISSUED', 'DISPUTED'];
const OPEN_TRIP_INCIDENT = ['OPEN', 'UNDER_REVIEW'];
const OPEN_DAMAGE_REPORT = ['REPORTED', 'HARD_APPROVED'];

// Accounting-residual column table (money zeroed, number sentinel, notes cols
// nulled). Kept small + explicit; the numbers are structural, not PII-classified.
const ACCOUNTING_MODELS = {
  rentalAgreement: {
    money: ['subtotal', 'taxes', 'fees', 'total', 'deposit', 'paidAmount', 'balance', 'securityDepositAmount'],
    nullCols: ['paymentReference'],
  },
  loanerAgreement: {
    money: [],
    nullCols: [],
  },
};

// ---------------------------------------------------------------------------
// CANDIDATE COMPUTATION — the SAME code path feeds preview and apply, so the
// two produce IDENTICAL candidate lists (sacred invariant #2). Pure reads.
// ---------------------------------------------------------------------------

async function agreementIdentityCandidates(prisma, model, cutoff) {
  const where = model === 'rentalAgreement'
    ? {
        piiPurgedAt: null,
        OR: [
          { returnedAt: { lt: cutoff } },
          { returnedAt: null, closedAt: { lt: cutoff } },
        ],
      }
    : { piiPurgedAt: null, closedAt: { lt: cutoff } };
  const rows = await prisma[model].findMany({ where, select: { id: true, reservationId: true } });
  // Freeze the identity clock while a claim is still open. The 4-year identity
  // window IS the claims-limitations window, and disputes/subrogation/litigation
  // routinely outlive it — stripping the renter's identity off the contract that
  // backs an OPEN claim would destroy evidence needed to defend it. Mirrors the
  // customer-level hasOpenClaim guard, which the record-level path was missing.
  const reservationIds = rows.map((r) => r.reservationId).filter(Boolean);
  const openClaims = await openClaimReservationIds(prisma, reservationIds);
  return rows.filter((r) => !r.reservationId || !openClaims.has(r.reservationId)).map((r) => r.id);
}

async function agreementAccountingCandidates(prisma, model, cutoff) {
  const base = model === 'rentalAgreement'
    ? { OR: [{ returnedAt: { lt: cutoff } }, { returnedAt: null, closedAt: { lt: cutoff } }] }
    : { closedAt: { lt: cutoff } };
  // Skip rows already anonymised (idempotency): agreementNumber not sentinel-prefixed.
  const where = { AND: [base, { agreementNumber: { not: { startsWith: ACCOUNTING_REDACT_PREFIX } } }] };
  const rows = await prisma[model].findMany({ where, select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * Fully-inactive customers: last reservation returnAt older than the identity
 * clock AND no OPEN incident/damage/claim on any of their reservations. Skips
 * customers with zero reservations (no rental close to anchor the clock) and
 * customers already suppressed by a prior erasure (doNotRent = true).
 */
async function inactiveCustomerCandidates(prisma, cutoff) {
  const customers = await prisma.customer.findMany({
    where: { doNotRent: false },
    select: { id: true },
  });
  const out = [];
  for (const c of customers) {
    const reservations = await prisma.reservation.findMany({
      where: { customerId: c.id },
      select: { id: true, returnAt: true },
    });
    if (reservations.length === 0) continue; // no rental history to anchor the clock
    let lastReturn = null;
    for (const r of reservations) {
      const t = r.returnAt ? new Date(r.returnAt).getTime() : null;
      if (t != null && (lastReturn == null || t > lastReturn)) lastReturn = t;
    }
    if (lastReturn == null || lastReturn >= cutoff.getTime()) continue; // recent / open-ended
    const reservationIds = reservations.map((r) => r.id);
    if (await hasOpenClaim(prisma, reservationIds)) continue; // claims window still open
    out.push(c.id);
  }
  return out;
}

// The subset of the given reservation ids that carry an OPEN incident/damage/
// claim. Used by the record-level identity sweep to skip agreements whose
// dispute window is still live. Same status vocab + chunking as hasOpenClaim.
async function openClaimReservationIds(prisma, reservationIds) {
  const open = new Set();
  if (!reservationIds.length) return open;
  for (const ids of chunk(reservationIds)) {
    const collect = (rows) => rows.forEach((r) => open.add(r.reservationId));
    collect(await prisma.reservationIncident.findMany({
      where: { reservationId: { in: ids }, status: { in: OPEN_RESERVATION_INCIDENT } },
      select: { reservationId: true },
    }));
    collect(await prisma.tripIncident.findMany({
      where: { reservationId: { in: ids }, status: { in: OPEN_TRIP_INCIDENT } },
      select: { reservationId: true },
    }));
    collect(await prisma.vehicleDamageReport.findMany({
      where: { reservationId: { in: ids }, status: { in: OPEN_DAMAGE_REPORT } },
      select: { reservationId: true },
    }));
  }
  return open;
}

async function hasOpenClaim(prisma, reservationIds) {
  if (!reservationIds.length) return false;
  for (const ids of chunk(reservationIds)) {
    const resInc = await prisma.reservationIncident.count({
      where: { reservationId: { in: ids }, status: { in: OPEN_RESERVATION_INCIDENT } },
    });
    if (resInc > 0) return true;
    const tripInc = await prisma.tripIncident.count({
      where: { reservationId: { in: ids }, status: { in: OPEN_TRIP_INCIDENT } },
    });
    if (tripInc > 0) return true;
    const dmg = await prisma.vehicleDamageReport.count({
      where: { reservationId: { in: ids }, status: { in: OPEN_DAMAGE_REPORT } },
    });
    if (dmg > 0) return true;
  }
  return false;
}

async function logCandidates(prisma, model, field, cutoff) {
  const rows = await prisma[model].findMany({
    where: { [field]: { lt: cutoff } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Compute the full candidate set for every category. Pure reads — no mutation.
 * Returns { [category]: { model, kind, ids } }.
 */
export async function computeCandidates(deps, { now = new Date(), periods = getPeriods() } = {}) {
  const { prisma = defaultPrisma } = deps || {};
  const cutoffs = computeCutoffs(now, periods);
  return {
    rentalAgreementIdentity: {
      kind: 'identity', model: 'rentalAgreement',
      ids: await agreementIdentityCandidates(prisma, 'rentalAgreement', cutoffs.identity),
    },
    loanerAgreementIdentity: {
      kind: 'identity', model: 'loanerAgreement',
      ids: await agreementIdentityCandidates(prisma, 'loanerAgreement', cutoffs.identity),
    },
    inactiveCustomer: {
      kind: 'customer', model: 'customer',
      ids: await inactiveCustomerCandidates(prisma, cutoffs.identity),
    },
    rentalAgreementAccounting: {
      kind: 'accounting', model: 'rentalAgreement',
      ids: await agreementAccountingCandidates(prisma, 'rentalAgreement', cutoffs.accounting),
    },
    loanerAgreementAccounting: {
      kind: 'accounting', model: 'loanerAgreement',
      ids: await agreementAccountingCandidates(prisma, 'loanerAgreement', cutoffs.accounting),
    },
    moduleAccessLog: {
      kind: 'log', model: 'moduleAccessAuditLog',
      ids: await logCandidates(prisma, 'moduleAccessAuditLog', 'changedAt', cutoffs.logs),
    },
    endpointLoadObservation: {
      kind: 'log', model: 'endpointLoadObservation',
      ids: await logCandidates(prisma, 'endpointLoadObservation', 'observedAt', cutoffs.logs),
    },
    endpointLoadObservationDaily: {
      kind: 'log', model: 'endpointLoadObservationDaily',
      ids: await logCandidates(prisma, 'endpointLoadObservationDaily', 'day', cutoffs.logs),
    },
  };
}

// ---------------------------------------------------------------------------
// PURGE PRIMITIVES (apply-mode only). Each reuses the shared identity map /
// erasure primitives; none reimplements erasure.
// ---------------------------------------------------------------------------

/** Strip the IDENTITY snapshot on a batch of agreement rows + their cascade
 * children, then stamp piiPurgedAt. Storage bytes reaped best-effort after. */
async function purgeIdentityBatch(deps, model, ids, now) {
  const { prisma = defaultPrisma, deleteObject = defaultDeleteObject, logger = defaultLogger } = deps;
  const agreementSpec = model === 'rentalAgreement' ? CUSTOMER_PII_MAP.rentalAgreement : CUSTOMER_PII_MAP.loanerAgreement;
  const childSpecs = model === 'rentalAgreement' ? RENTAL_CHILD_SPECS : LOANER_CHILD_SPECS;
  const mode = RETENTION_MODES.CONSERVATIVE; // keep last name on statutory records

  // Reap person-document storage BEFORE nulling the columns (mirrors erasure).
  let storageRefs = [];
  for (const c of chunk(ids)) {
    storageRefs = storageRefs.concat(
      await collectStorageRefs(prisma, agreementSpec, [{ id: { in: c } }]),
    );
  }

  await prisma.$transaction(async (tx) => {
    // Agreement row itself.
    const agData = buildEraseData(agreementSpec, mode);
    if (Object.keys(agData).length) {
      for (const c of chunk(ids)) await tx[model].updateMany({ where: { id: { in: c } }, data: agData });
    }
    // Cascade children (identity classification from the shared map).
    for (const spec of childSpecs) {
      const data = buildEraseData(spec, mode);
      if (!Object.keys(data).length) continue;
      const field = spec.match.field;
      for (const c of chunk(ids)) await tx[spec.model].updateMany({ where: { [field]: { in: c } }, data });
    }
    // Idempotency marker.
    for (const c of chunk(ids)) {
      await tx[model].updateMany({ where: { id: { in: c } }, data: { piiPurgedAt: now } });
    }
  });

  // Best-effort storage delete after commit.
  for (const ref of storageRefs) {
    try {
      await deleteObject({ bucket: ref.bucket, path: ref.path });
    } catch (err) {
      try {
        logger.warn('[retention] storage delete failed', { source: ref.source, message: err?.message || String(err) });
      } catch { /* logging must never throw */ }
    }
  }
}

/** Anonymise the accounting residual on a batch of agreement rows (money → 0,
 * agreementNumber → per-row sentinel, notes cols nulled). Per-row because
 * agreementNumber is @unique. */
async function purgeAccountingBatch(deps, model, ids) {
  const { prisma = defaultPrisma } = deps;
  const cfg = ACCOUNTING_MODELS[model];
  await prisma.$transaction(async (tx) => {
    for (const id of ids) {
      const data = { agreementNumber: acctNumber(id) };
      for (const m of cfg.money) data[m] = 0;
      for (const n of cfg.nullCols) data[n] = null;
      await tx[model].update({ where: { id }, data });
    }
  });
}

/** Delete a batch of log rows by id (bounded — never an unbounded deleteMany). */
async function purgeLogBatch(deps, model, ids) {
  const { prisma = defaultPrisma } = deps;
  let deleted = 0;
  for (const c of chunk(ids)) {
    const { count } = await prisma[model].deleteMany({ where: { id: { in: c } } });
    deleted += count;
  }
  return deleted;
}

/** Reuse the Phase A eraseCustomer primitive for a batch of fully-inactive
 * customers. In apply mode this needs GDPR_ERASURE_ENABLED too (defence in
 * depth); when that is off we fall back to a per-customer dry-run so the sweep
 * never throws and the outstanding work stays visible. */
async function purgeInactiveCustomers(deps, ids, { apply }) {
  const { logger = defaultLogger, eraseCustomer = defaultEraseCustomer } = deps;
  const customerErasureOn = gdprErasureEnabled();
  const effectiveApply = apply && customerErasureOn;
  if (apply && !customerErasureOn) {
    try {
      logger.warn('[retention] inactive-customer erase requested but GDPR_ERASURE_ENABLED is off — running dry-run only for this category');
    } catch { /* ignore */ }
  }
  let processed = 0;
  for (const id of ids) {
    try {
      await eraseCustomer(id, {
        actor: 'retention-sweep',
        reason: 'Automatic retention sweep — fully-inactive customer past the identity/claims clock',
        dryRun: !effectiveApply,
        retentionMode: RETENTION_MODES.CONSERVATIVE,
      });
      if (effectiveApply) processed += 1;
    } catch (err) {
      try {
        logger.error('[retention] eraseCustomer failed', { customerId: id, message: err?.message || String(err) });
      } catch { /* ignore */ }
    }
  }
  return processed;
}

// ---------------------------------------------------------------------------
// THE SWEEP.
// ---------------------------------------------------------------------------
/**
 * runSweep — compute candidates, enforce batch cap + abort threshold, LOG the
 * preview, and (only when apply) purge via the erasure primitives; then write a
 * RetentionSweepRun row.
 *
 * @param {object} args
 * @param {boolean} [args.apply=false]  FALSE = preview (mutates nothing).
 * @param {number}  [args.batch]        batch cap override (else env).
 * @param {number}  [args.maxPerRun]    abort threshold override (else env).
 * @param {boolean} [args.force]        bypass the abort threshold (manual override).
 * @param {Date}    [args.now]
 * @param {object}  [args.periods]      period override (else env).
 * @param {object}  [args.deps]         { prisma, logger, deleteObject, eraseCustomer }
 */
export async function runSweep(args = {}) {
  const deps = args.deps || {};
  const { prisma = defaultPrisma, logger = defaultLogger } = deps;
  const apply = args.apply === true;
  const now = args.now || new Date();
  const periods = args.periods || getPeriods();
  const limits = getLimits();
  const batch = args.batch != null ? Math.max(1, Math.trunc(args.batch)) : limits.batch;
  const maxPerRun = args.maxPerRun != null ? Math.max(1, Math.trunc(args.maxPerRun)) : limits.maxPerRun;
  const force = args.force != null ? args.force === true : limits.force;
  const mode = apply ? 'APPLY' : 'PREVIEW';
  const startedAt = now;

  const candidates = await computeCandidates(deps, { now, periods });

  const perCategoryCounts = {};
  let anyAborted = false;

  for (const [category, info] of Object.entries(candidates)) {
    const total = info.ids.length;
    const aborted = total > maxPerRun && !force;
    const willProcess = aborted ? [] : info.ids.slice(0, batch);
    perCategoryCounts[category] = {
      total,
      cap: batch,
      selected: willProcess.length,
      processed: 0,
      aborted,
      forcedOverThreshold: total > maxPerRun && force,
    };

    // ALWAYS LOG BEFORE PURGE (counts + sample ids).
    const sampleIds = willProcess.slice(0, SAMPLE_LIMIT);
    try {
      if (aborted) {
        anyAborted = true;
        logger.error('[retention] ABORT — candidate count over safety threshold; category skipped, manual override required', {
          category, model: info.model, total, maxPerRun,
          hint: 'set RETENTION_SWEEP_FORCE=true to override after confirming this is not a clock/query bug',
        });
      } else {
        logger.warn(`[retention] ${mode} ${category}: would purge ${willProcess.length}/${total} (${info.kind})`, {
          category, model: info.model, kind: info.kind, total, selected: willProcess.length, sampleIds,
        });
      }
    } catch { /* logging must never throw */ }

    if (aborted || willProcess.length === 0) continue;

    // PURGE (apply only). Preview stops here — it has already logged and mutates nothing.
    if (!apply) continue;

    try {
      let processed = 0;
      switch (info.kind) {
        case 'identity':
          await purgeIdentityBatch(deps, info.model, willProcess, now);
          processed = willProcess.length;
          break;
        case 'accounting':
          await purgeAccountingBatch(deps, info.model, willProcess);
          processed = willProcess.length;
          break;
        case 'customer':
          processed = await purgeInactiveCustomers(deps, willProcess, { apply });
          break;
        case 'log':
          processed = await purgeLogBatch(deps, info.model, willProcess);
          break;
        default:
          break;
      }
      perCategoryCounts[category].processed = processed;
    } catch (err) {
      try {
        logger.error('[retention] category purge failed', { category, message: err?.message || String(err) });
      } catch { /* ignore */ }
    }
  }

  const finishedAt = new Date();
  const notes = `mode=${mode} identityYears=${periods.identityYears} accountingYears=${periods.accountingYears} logMonths=${periods.logMonths} batch=${batch} maxPerRun=${maxPerRun}${force ? ' force=true' : ''}`;

  // Run-history row (operational metadata, NOT purge-target data — written in
  // BOTH modes so a preview run is itself auditable). Best-effort.
  let runRow = null;
  try {
    runRow = await prisma.retentionSweepRun.create({
      data: { startedAt, finishedAt, mode, perCategoryCounts, aborted: anyAborted, notes },
    });
  } catch (err) {
    try { logger.warn('[retention] failed to write RetentionSweepRun', { message: err?.message || String(err) }); } catch { /* ignore */ }
  }

  try {
    logger.info(`[retention] sweep ${mode} done`, { perCategoryCounts, aborted: anyAborted });
  } catch { /* ignore */ }

  return {
    ok: true,
    mode,
    apply,
    aborted: anyAborted,
    startedAt,
    finishedAt,
    periods,
    limits: { batch, maxPerRun, force },
    candidates: Object.fromEntries(Object.entries(candidates).map(([k, v]) => [k, { model: v.model, kind: v.kind, ids: v.ids }])),
    perCategoryCounts,
    runId: runRow?.id || null,
  };
}

export default {
  runSweep,
  computeCandidates,
  computeCutoffs,
  getPeriods,
  getLimits,
  ACCOUNTING_REDACT_PREFIX,
};
