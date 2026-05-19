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
 * V1: only `locationId: null` (tenant-default) rows. The per-row response
 * carries `locationId: null` for forward-compat with V2 (per-location overrides).
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { HARDCODED_RATES } from './fee-engine.service.js';
import { ValidationError } from '../../lib/errors.js';

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

function buildRow(feeType, dbRow, editable) {
  const meta = FEE_TYPE_METADATA[feeType];
  const fallback = HARDCODED_RATES[feeType] || { amount: null, unit: meta.unit };
  return {
    feeType,
    label: meta.label,
    description: meta.description,
    unit: meta.unit,
    currentAmount: dbRow ? Number(dbRow.amount) : null,
    currentSource: dbRow ? 'tenant_default' : 'hardcoded',
    defaultAmount: fallback.amount,
    defaultUnit: meta.unit,
    validRange: { min: meta.min, max: meta.max, step: meta.step },
    rateId: dbRow?.id || null,
    locationId: null,
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

  const dbRows = await prisma.feeRate.findMany({
    where: { tenantId, locationId: null }
  });
  const byFeeType = new Map(dbRows.map((r) => [r.feeType, r]));

  return FEE_TYPE_ORDER.map((feeType) => buildRow(feeType, byFeeType.get(feeType) || null, editable));
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

    cleaned.push({ feeType, amount, notes, unit: meta.unit });
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
export async function bulkUpsert(body, scope, { actorUserId = null, editable = true } = {}) {
  const tenantId = assertScopedTenant(scope);

  const result = validateBulkPayload(body);
  if (!result.ok) {
    const err = new ValidationError('Invalid fee rate payload');
    err.details = result.errors;
    throw err;
  }

  await prisma.$transaction(async (tx) => {
    for (const r of result.rates) {
      const existing = await tx.feeRate.findFirst({
        where: { tenantId, locationId: null, feeType: r.feeType }
      });
      if (existing) {
        await tx.feeRate.update({
          where: { id: existing.id },
          data: {
            amount: r.amount,
            unit: r.unit,
            notes: r.notes,
            isActive: true
          }
        });
      } else {
        await tx.feeRate.create({
          data: {
            tenantId,
            locationId: null,
            feeType: r.feeType,
            unit: r.unit,
            amount: r.amount,
            isActive: true,
            notes: r.notes
          }
        });
      }
    }
  });

  // FeeRate has no `updatedById` column today — log the audit trail via
  // winston instead. If the column is added later, this is where to populate it.
  logger.info('[fee-rates] tenant=%s user=%s updated %d rates: %j',
    tenantId,
    actorUserId || 'unknown',
    result.rates.length,
    result.rates.map((r) => ({ feeType: r.feeType, amount: r.amount }))
  );

  return listForScope({ tenantId }, { editable });
}

export const feeRatesService = {
  FEE_TYPE_METADATA,
  FEE_TYPE_ORDER,
  listForScope,
  validateBulkPayload,
  bulkUpsert
};
