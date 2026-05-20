/**
 * Pillar 2 — Per-tenant Fee Rate settings service (16q).
 *
 * Surfaces the 7 checkin-fee rates used by `fee-engine.service.js` so a tenant
 * ADMIN can view + edit them. Always returns ALL 7 rows: tenant DB overrides
 * merged with HARDCODED_RATES defaults so the UI has a stable shape regardless
 * of whether the seeded rows were ever inserted.
 *
 * Multi-tenancy: every Prisma call here filters by `tenantId`. We additionally
 * require `tenantId` to be present (the `scopeFor()` deny-all sentinel
 * '__no_tenant__' is rejected via ValidationError below — fee rates are
 * inherently per-tenant, there is no cross-tenant view).
 *
 * V1: tenant-default rows (locationId IS NULL).
 * V2 (Pillar 2 follow-up): per-location overrides (locationId = X). Selected
 * via the optional `locationId` field on scope. When provided:
 *   - listForScope returns the location overrides merged with the tenant
 *     default and HARDCODED defaults so the UI can show 3-tier context.
 *   - bulkUpsert writes rows with that locationId.
 *   - deleteOverride deletes a single (locationId, feeType) row.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { HARDCODED_RATES } from './fee-engine.service.js';
import { ValidationError } from '../../lib/errors.js';
import {
  recordChange as recordFeeRateAuditChange,
  snapshotFeeRate,
  classifyChange
} from './fee-rate-audit.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// Metadata table — labels, descriptions, units, and validation ranges.
// Drives both the GET response and the PUT validation. `unit` here is the
// server-of-record unit; any client-supplied `unit` is ignored.
// ─────────────────────────────────────────────────────────────────────────────

export const FEE_TYPE_METADATA = {
  FUEL_REFILL: {
    label: 'Fuel refill',
    description: 'Charged when the vehicle returns with less fuel than at checkout.',
    unit: 'PER_GALLON',
    min: 1,    max: 20,    step: 0.01
  },
  CLEANING_LIGHT: {
    label: 'Cleaning · light',
    description: 'Returned with light dust, food crumbs, sand. One-tier drop in cleanliness.',
    unit: 'FLAT',
    min: 25,   max: 500,   step: 1
  },
  CLEANING_MEDIUM: {
    label: 'Cleaning · medium',
    description: 'Stains, spills, or noticeable mess. Two-tier drop in cleanliness.',
    unit: 'FLAT',
    min: 25,   max: 500,   step: 1
  },
  CLEANING_HEAVY: {
    label: 'Cleaning · heavy',
    description: 'Vomit, biohazard, deep upholstery damage. Three-tier-or-more drop.',
    unit: 'FLAT',
    min: 25,   max: 500,   step: 1
  },
  SMOKING: {
    label: 'Smoking penalty',
    description: 'Tobacco residue or smoke odor detected at return.',
    unit: 'FLAT',
    min: 100,  max: 1000,  step: 1
  },
  EXCESS_MILEAGE: {
    label: 'Excess mileage',
    description: 'Per mile driven beyond the daily allowance.',
    unit: 'PER_MILE',
    min: 0.10, max: 2.00,  step: 0.01
  },
  LATE_RETURN: {
    label: 'Late return',
    description: 'Per hour past the scheduled return time after a 30-minute grace.',
    unit: 'PER_HOUR',
    min: 5,    max: 200,   step: 1
  }
};

// Stable ordering for the response array. Mirrors the order the fee engine
// resolves rates in, which is roughly "most common first".
const FEE_TYPE_ORDER = [
  'FUEL_REFILL',
  'CLEANING_LIGHT',
  'CLEANING_MEDIUM',
  'CLEANING_HEAVY',
  'SMOKING',
  'EXCESS_MILEAGE',
  'LATE_RETURN'
];

const VALID_FEE_TYPES = new Set(FEE_TYPE_ORDER);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function assertScopedTenant(scope) {
  // scopeFor() returns either { tenantId } for a tenanted user, {} for a
  // super-admin without ?tenantId=, or { tenantId: '__no_tenant__' } for the
  // deny-all sentinel. We reject the first two: this endpoint requires a
  // concrete tenant id.
  if (!scope || !scope.tenantId || scope.tenantId === '__no_tenant__') {
    throw new ValidationError('tenantId required for fee rates');
  }
  return scope.tenantId;
}

function buildRow(feeType, dbRow, editable, { tenantDefault = null, locationId = null } = {}) {
  const meta = FEE_TYPE_METADATA[feeType];
  const fallback = HARDCODED_RATES[feeType] || { amount: null, unit: meta.unit };
  // currentSource describes where the *currentAmount* on this row comes from:
  //   - 'location'        : dbRow is a per-location override
  //   - 'tenant_default'  : dbRow is a tenant default
  //   - 'hardcoded'       : no dbRow at all (UI shows fallback)
  let currentSource = 'hardcoded';
  if (dbRow) currentSource = locationId ? 'location' : 'tenant_default';

  // tenantDefaultAmount is exposed for the per-location UI: when editing a
  // location override the UI shows the tenant default as a faded reference
  // value. When listing tenant defaults this equals defaultAmount/currentAmount.
  const tenantDefaultAmount = tenantDefault
    ? Number(tenantDefault.amount)
    : (fallback.amount ?? null);
  const tenantDefaultSource = tenantDefault ? 'tenant_default' : 'hardcoded';

  return {
    feeType,
    label: meta.label,
    description: meta.description,
    unit: meta.unit,
    currentAmount: dbRow ? Number(dbRow.amount) : null,
    currentSource,
    defaultAmount: fallback.amount,
    defaultUnit: meta.unit,
    // Tenant-level default (next layer in the precedence chain). When viewing
    // tenant-default rows this duplicates `currentAmount`/`defaultAmount`, but
    // when viewing per-location overrides it's the actual fallback if the
    // override is cleared.
    tenantDefaultAmount,
    tenantDefaultSource,
    validRange: { min: meta.min, max: meta.max, step: meta.step },
    rateId: dbRow?.id || null,
    locationId: locationId || null,
    isActive: dbRow ? !!dbRow.isActive : true,
    notes: dbRow?.notes ?? null,
    updatedAt: dbRow?.updatedAt ? new Date(dbRow.updatedAt).toISOString() : null,
    updatedBy: null,
    editable: !!editable
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Service API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all 7 fee-rate rows for a tenant. Always returns 7 rows in stable order;
 * rows without a DB override fall back to HARDCODED_RATES defaults.
 *
 * Multi-tenancy: filters by `tenantId, locationId: null`.
 */
export async function listForScope(scope, { editable = false } = {}) {
  const tenantId = assertScopedTenant(scope);
  const locationId = scope?.locationId || null;

  // We always need to know the tenant default for each feeType so the row
  // payload can show "what would apply if this override is cleared". When
  // listing tenant defaults this is the same query as the main one.
  const tenantDefaultRows = await prisma.feeRate.findMany({
    where: { tenantId, locationId: null }
  });
  const tenantDefaultsByType = new Map(tenantDefaultRows.map((r) => [r.feeType, r]));

  let dbRows;
  if (locationId) {
    dbRows = await prisma.feeRate.findMany({ where: { tenantId, locationId } });
  } else {
    dbRows = tenantDefaultRows;
  }
  const byFeeType = new Map(dbRows.map((r) => [r.feeType, r]));

  return FEE_TYPE_ORDER.map((feeType) => buildRow(
    feeType,
    byFeeType.get(feeType) || null,
    editable,
    { tenantDefault: tenantDefaultsByType.get(feeType) || null, locationId }
  ));
}

/**
 * Validate the PUT body. Returns { ok: true, rates: [...] } on success or
 * { ok: false, errors: [{ feeType, message }] } on failure. Pure function —
 * no DB calls.
 */
export function validateBulkPayload(body) {
  const errors = [];
  const rates = Array.isArray(body?.rates) ? body.rates : null;

  if (!rates) {
    return { ok: false, errors: [{ feeType: null, message: 'rates must be an array' }] };
  }
  if (rates.length === 0) {
    return { ok: false, errors: [{ feeType: null, message: 'rates must not be empty' }] };
  }

  const seen = new Set();
  const cleaned = [];

  for (const raw of rates) {
    const feeType = String(raw?.feeType || '').trim();
    if (!feeType) {
      errors.push({ feeType: null, message: 'feeType is required' });
      continue;
    }
    if (!VALID_FEE_TYPES.has(feeType)) {
      errors.push({ feeType, message: `Unknown feeType: ${feeType}` });
      continue;
    }
    if (seen.has(feeType)) {
      errors.push({ feeType, message: `Duplicate feeType in payload: ${feeType}` });
      continue;
    }
    seen.add(feeType);

    const meta = FEE_TYPE_METADATA[feeType];
    const amount = Number(raw?.amount);
    if (!Number.isFinite(amount) || Number.isNaN(amount)) {
      errors.push({ feeType, message: `amount must be a finite number (got ${raw?.amount})` });
      continue;
    }
    if (amount < 0) {
      errors.push({ feeType, message: `amount must be >= 0 (got ${amount})` });
      continue;
    }
    if (amount < meta.min || amount > meta.max) {
      errors.push({ feeType, message: `amount ${amount} out of range [${meta.min}, ${meta.max}]` });
      continue;
    }

    let notes = null;
    if (raw?.notes !== undefined && raw?.notes !== null) {
      notes = String(raw.notes);
      if (notes.length > 280) {
        errors.push({ feeType, message: 'notes must be 280 characters or fewer' });
        continue;
      }
    }

    // isActive toggle — when false the engine SKIPS this fee type entirely
    // (does not fall back to hardcoded). Default true to preserve existing
    // behavior for callers that omit the field.
    const isActive = raw?.isActive === false ? false : true;

    cleaned.push({ feeType, amount, notes, unit: meta.unit, isActive });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, rates: cleaned };
}

/**
 * Upsert a batch of fee rates inside a single transaction. Each row is keyed
 * on { tenantId, locationId: null, feeType }. No compound unique constraint
 * exists on FeeRate, so we use findFirst + create/update.
 *
 * Multi-tenancy: every query inside the transaction filters by `tenantId`.
 *
 * Returns the fresh list (same shape as listForScope) post-write.
 */
export async function bulkUpsert(body, scope, { actorUserId = null, actor = null, editable = true } = {}) {
  const tenantId = assertScopedTenant(scope);
  const locationId = scope?.locationId || null;

  const result = validateBulkPayload(body);
  if (!result.ok) {
    const err = new ValidationError('Invalid fee rate payload');
    err.details = result.errors;
    throw err;
  }

  // Resolve a per-call audit actor — prefer the structured `actor` argument
  // (id+email+role) when present, fall back to the legacy `actorUserId` so
  // older callers (no audit context) still work.
  const auditActor = actor || (actorUserId ? { id: actorUserId } : null);

  // Collect audit-write payloads inside the transaction; write them AFTER
  // the upsert tx commits. If an audit insert ran inside the tx and threw
  // (e.g., FeeRateAuditLog migration not applied, transient DB error),
  // Prisma would re-raise the error at commit time, rolling back the
  // user-facing change — recordChange's inner try/catch isn't enough.
  // Audit MUST be best-effort. HOTFIX (fee-rate-toggle-500).
  const pendingAudits = [];

  await prisma.$transaction(async (tx) => {
    for (const r of result.rates) {
      const existing = await tx.feeRate.findFirst({
        where: { tenantId, locationId: locationId || null, feeType: r.feeType }
      });
      const before = existing ? snapshotFeeRate(existing) : null;
      let updated;
      if (existing) {
        updated = await tx.feeRate.update({
          where: { id: existing.id },
          data: {
            amount: r.amount,
            unit: r.unit,
            notes: r.notes,
            isActive: r.isActive
          }
        });
      } else {
        updated = await tx.feeRate.create({
          data: {
            tenantId,
            locationId: locationId || null,
            feeType: r.feeType,
            unit: r.unit,
            amount: r.amount,
            isActive: r.isActive,
            notes: r.notes
          }
        });
      }
      const after = snapshotFeeRate(updated);
      const changeType = classifyChange(before, after);

      pendingAudits.push({
        tenantId,
        feeRateId: updated?.id || null,
        feeType: r.feeType,
        locationId: locationId || null,
        actor: auditActor,
        changeType,
        before,
        after
      });
    }
  });

  // Audit inserts are best-effort and live OUTSIDE the upsert transaction so
  // a failure here cannot roll back the user-facing change. recordChange
  // already swallows DB errors; the try/catch is defense-in-depth.
  for (const payload of pendingAudits) {
    try {
      await recordFeeRateAuditChange(payload);
    } catch (auditErr) {
      logger.warn('[fee-rates] audit insert failed (tenant=%s feeType=%s): %s',
        tenantId, payload.feeType, auditErr?.message || auditErr);
    }
  }

  logger.info('[fee-rates] tenant=%s location=%s user=%s updated %d rates: %j',
    tenantId,
    locationId || 'tenant_default',
    actorUserId || 'unknown',
    result.rates.length,
    result.rates.map((r) => ({ feeType: r.feeType, amount: r.amount }))
  );

  return listForScope({ tenantId, locationId }, { editable });
}

/**
 * Delete a single (locationId, feeType) override row. Used by the per-location
 * UI "Reset to tenant default" affordance. No-op if the row does not exist.
 * Tenant-default deletion is intentionally NOT supported here — clearing a
 * tenant default should go through bulkUpsert with isActive controls.
 */
export async function deleteOverride(scope, { feeType }, { actorUserId = null } = {}) {
  const tenantId = assertScopedTenant(scope);
  const locationId = scope?.locationId || null;
  if (!locationId) {
    throw new ValidationError('deleteOverride requires a locationId scope');
  }
  if (!VALID_FEE_TYPES.has(String(feeType))) {
    throw new ValidationError(`Unknown feeType: ${feeType}`);
  }
  const existing = await prisma.feeRate.findFirst({
    where: { tenantId, locationId, feeType }
  });
  if (existing) {
    await prisma.feeRate.delete({ where: { id: existing.id } });
    logger.info('[fee-rates] tenant=%s location=%s user=%s deleted override %s',
      tenantId, locationId, actorUserId || 'unknown', feeType);
  }
  return { deleted: !!existing };
}

/**
 * Compute the effective (merged) fee rates for a tenant+location: per-location
 * override > tenant default > HARDCODED fallback. This is what the fee engine
 * actually applies at checkin time, exposed for UI preview.
 */
export async function listEffective(scope, { editable = false } = {}) {
  const tenantId = assertScopedTenant(scope);
  const locationId = scope?.locationId || null;

  const where = locationId
    ? { tenantId, OR: [{ locationId }, { locationId: null }] }
    : { tenantId, locationId: null };
  const dbRows = await prisma.feeRate.findMany({ where });

  // Bucket by feeType, prefer location-specific
  const tenantDefaultsByType = new Map();
  const locationOverridesByType = new Map();
  for (const r of dbRows) {
    if (r.locationId === null) tenantDefaultsByType.set(r.feeType, r);
    else if (r.locationId === locationId) locationOverridesByType.set(r.feeType, r);
  }

  return FEE_TYPE_ORDER.map((feeType) => {
    const meta = FEE_TYPE_METADATA[feeType];
    const fallback = HARDCODED_RATES[feeType] || { amount: null, unit: meta.unit };
    const override = locationId ? locationOverridesByType.get(feeType) : null;
    const tDef = tenantDefaultsByType.get(feeType) || null;

    let effectiveAmount = fallback.amount;
    let effectiveSource = 'hardcoded';
    let effectiveActive = true;
    if (override) {
      effectiveAmount = Number(override.amount);
      effectiveSource = 'location';
      effectiveActive = !!override.isActive;
    } else if (tDef) {
      effectiveAmount = Number(tDef.amount);
      effectiveSource = 'tenant_default';
      effectiveActive = !!tDef.isActive;
    }

    return {
      feeType,
      label: meta.label,
      unit: meta.unit,
      effectiveAmount,
      effectiveSource,
      isActive: effectiveActive,
      tenantDefaultAmount: tDef ? Number(tDef.amount) : (fallback.amount ?? null),
      tenantDefaultSource: tDef ? 'tenant_default' : 'hardcoded',
      locationOverrideAmount: override ? Number(override.amount) : null,
      hardcodedAmount: fallback.amount ?? null,
      locationId: locationId || null,
      editable: !!editable
    };
  });
}

/**
 * Return the distinct location IDs (within the tenant) that have at least one
 * FeeRate override row. Lets the UI flag locations with custom rates without
 * having to N+1-fetch each location's rates.
 */
export async function listLocationsWithOverrides(scope) {
  const tenantId = assertScopedTenant(scope);
  // Use groupBy to get distinct, non-null locationIds.
  const grouped = await prisma.feeRate.groupBy({
    by: ['locationId'],
    where: { tenantId, locationId: { not: null } },
    _count: { _all: true }
  });
  return grouped
    .filter((g) => !!g.locationId)
    .map((g) => ({ locationId: g.locationId, overrideCount: g._count?._all || 0 }));
}

export const feeRatesService = {
  FEE_TYPE_METADATA,
  FEE_TYPE_ORDER,
  listForScope,
  validateBulkPayload,
  bulkUpsert,
  deleteOverride,
  listEffective,
  listLocationsWithOverrides
};
