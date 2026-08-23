/**
 * customer-erasure.service.js — GDPR Article 17 erasure primitive for a single
 * customer. THE HIGHEST-RISK CODE IN THE PROJECT: it destroys customer data.
 *
 * TWO SACRED INVARIANTS (QA attacks these):
 *   1. OFF BY DEFAULT. Env flag GDPR_ERASURE_ENABLED (default false). While
 *      false the service REFUSES to mutate — a dryRun:false call throws
 *      ErasureNotEnabledError (HTTP 503). Dry-run still computes a plan.
 *   2. DRY-RUN BY DEFAULT. eraseCustomer(id, { dryRun = true }). Dry-run
 *      computes and RETURNS the full plan and mutates NOTHING. Only an explicit
 *      dryRun:false — AND the flag on — mutates.
 *
 * HARD RULES:
 *   - NEVER hard-delete Reservation, RentalAgreement, LoanerAgreement, any
 *     payment model, or any damage/incident model. Those are RETAIN_STATUTORY:
 *     anonymise-in-place (null erasable PII, redact required identity columns,
 *     reap person-document bytes) and KEEP the row + money + timestamps +
 *     last name + vehicle photos.
 *   - ALL DB work runs in ONE prisma.$transaction. Storage deletes and the
 *     Authorize.Net sub-processor delete happen AFTER commit, per-object
 *     try/catch, best-effort.
 *   - IDEMPOTENT: safe to re-run. A second run finds nothing left to change.
 *
 * WHAT/WHERE is driven entirely by ./customer-pii-map.js so this service, the
 * Phase B export, and the Phase C sweep cannot drift apart.
 *
 * RETENTION MODE is config-driven (GDPR_RETENTION_MODE): CONSERVATIVE (default,
 * keeps customerLastName on agreements) or FULL_DELETE (erases it too). The
 * legal set is being researched separately — the code must not hard-code one
 * answer, so the switch lives in the map.
 *
 * SCOPE NOTE: this is the ADMIN-only gated path. The self-service
 * account-deletion flow keeps its own in-place anonymiser for now (it must not
 * break while this engine is dark); it migrates onto eraseCustomer at go-live
 * when GDPR_ERASURE_ENABLED is flipped on.
 *
 * TRANSACTION SAFETY: all DB work runs in ONE $transaction with a raised
 * timeout, and every `WHERE id IN (...)` list is chunked so a customer with
 * thousands of rentals cannot blow the interactive-transaction limit.
 *
 * ESM. No new npm deps. `prisma`, `deleteObject`, `logger`, and the AuthNet
 * delete are injectable (deps arg) so the suite runs DB-free.
 */

import { prisma as defaultPrisma } from '../../lib/prisma.js';
import defaultLogger from '../../lib/logger.js';
import { deleteObject as defaultDeleteObject } from '../../lib/storage/index.js';
import {
  CUSTOMER_PII_MAP,
  SUBPROCESSOR,
  RETENTION_MODES,
  getRetentionMode,
  classifyStorageRef,
  REDACTION,
} from './customer-pii-map.js';
// Reach resolution is SHARED with Phase B export so the two cannot drift — see
// customer-pii-reach.js. This service does not carry its own copy.
import {
  OR_MATCH_KINDS,
  chunk,
  buildWheres,
  resolveTargets,
} from './customer-pii-reach.js';

// Interactive-transaction guards. The default Prisma interactive-transaction
// timeout is 5s; a customer with thousands of rentals needs more headroom, and
// id-IN lists are chunked to keep each statement bounded.
const TX_TIMEOUT_MS = 30_000;
const TX_MAX_WAIT_MS = 10_000;

export class ErasureNotEnabledError extends Error {
  constructor(message = 'Customer erasure is not enabled (GDPR_ERASURE_ENABLED is off).') {
    super(message);
    this.name = 'ErasureNotEnabledError';
    this.statusCode = 503;
    this.code = 'ERASURE_NOT_ENABLED';
  }
}

export class CustomerNotFoundError extends Error {
  constructor(message = 'Customer not found.') {
    super(message);
    this.name = 'CustomerNotFoundError';
    this.statusCode = 404;
    this.code = 'CUSTOMER_NOT_FOUND';
  }
}

/**
 * Is the destructive path enabled? Reads the env flag fresh each call so a
 * test / operator toggle is respected without a restart. Only the exact string
 * 'true' (case-insensitive) turns it on — everything else is OFF.
 */
export function gdprErasureEnabled() {
  return String(process.env.GDPR_ERASURE_ENABLED || '').toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// Build the Prisma `data` patch for one map entry, for the active retention
// mode.
//   redact             → REDACTION sentinel (required, non-null identity columns)
//   null               → null
//   zero               → 0
//   jsonEmpty          → the given empty JSON value
//   storage.requiredRedact → REDACTION (a required column whose object we reap)
//   conservativeRetain → retained in CONSERVATIVE; redacted in FULL_DELETE
// ---------------------------------------------------------------------------
function buildEraseData(spec, mode) {
  const cols = spec.columns || {};
  const data = {};
  for (const c of cols.redact || []) data[c] = REDACTION;
  for (const c of cols.null || []) data[c] = null;
  for (const c of cols.zero || []) data[c] = 0;
  for (const j of cols.jsonEmpty || []) data[j.column] = j.value;
  for (const s of cols.storage || []) {
    if (s.requiredRedact) data[s.column] = REDACTION;
    // non-required storage columns are already covered by cols.null
  }
  // Config-driven retention: columns retained ONLY in CONSERVATIVE mode are
  // redacted when FULL_DELETE is active (the legal switch, flipped via env).
  if (mode === RETENTION_MODES.FULL_DELETE) {
    for (const c of cols.conservativeRetain || []) data[c] = REDACTION;
  }
  return data;
}

/**
 * Read the rows a storage-bearing spec matches (across all chunked/OR wheres)
 * and collect the deletable Storage objects, BEFORE any nulling. De-dupes rows
 * matched by more than one where. Returns [{ bucket, path, source }].
 */
async function collectStorageRefs(prisma, spec, wheres) {
  // Storage refs may sit under columns.storage (anonymised rows) or at the spec
  // top level (HARD_DELETE rows whose bytes we reap before deleting the row).
  const storageCols = spec.columns?.storage || spec.storage || [];
  if (!storageCols.length || !wheres.length) return [];
  const select = { id: true };
  for (const s of storageCols) select[s.column] = true;
  const refs = [];
  const seen = new Set();
  for (const where of wheres) {
    const rows = await prisma[spec.model].findMany({ where, select });
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      for (const s of storageCols) {
        const cls = classifyStorageRef(row[s.column], { defaultBucket: s.defaultBucket });
        if (cls.kind === 'object') {
          refs.push({ bucket: cls.bucket, path: cls.path, source: `${spec.label}.${s.column}` });
        }
      }
    }
  }
  return refs;
}

/**
 * Count matched rows for a spec across its wheres. OR-shaped matches can hit the
 * same row from >1 branch, so those are de-duplicated by id; disjoint id-chunk
 * wheres are summed cheaply via count().
 */
async function countRows(prisma, spec, wheres) {
  if (OR_MATCH_KINDS.has(spec.match.kind)) {
    const ids = new Set();
    for (const where of wheres) {
      const rows = await prisma[spec.model].findMany({ where, select: { id: true } });
      for (const r of rows) ids.add(r.id);
    }
    return ids.size;
  }
  let total = 0;
  for (const where of wheres) total += await prisma[spec.model].count({ where });
  return total;
}

/**
 * eraseCustomer — the primitive.
 *
 * @param {string} customerId
 * @param {object} opts
 * @param {string} opts.actor   - who/what initiated (audit string)
 * @param {string} opts.reason  - required, non-empty
 * @param {boolean} [opts.dryRun=true] - TRUE computes a plan and mutates nothing
 * @param {object} [opts.scope] - tenant scope { tenantId? } (fail-closed lookup)
 * @param {object} [deps] - { prisma, logger, deleteObject, authnetDelete }
 * @returns {Promise<object>} structured erasure report
 */
export async function eraseCustomer(customerId, opts = {}, deps = {}) {
  const {
    actor = 'unknown',
    reason,
    dryRun = true,
    scope = {},
    retentionMode = getRetentionMode(),
  } = opts;
  const {
    prisma = defaultPrisma,
    logger = defaultLogger,
    deleteObject = defaultDeleteObject,
    authnetDelete, // optional injection; else lazy-imported from rental-agreements
  } = deps;

  if (!customerId || typeof customerId !== 'string') {
    const err = new Error('customerId is required');
    err.statusCode = 400;
    throw err;
  }
  if (!reason || !String(reason).trim()) {
    const err = new Error('reason is required (non-empty) — erasure is audited');
    err.statusCode = 400;
    throw err;
  }

  const willMutate = dryRun === false;
  const gdprEnabled = gdprErasureEnabled();

  // SACRED INVARIANT #1 — refuse to mutate while the flag is off. Checked
  // BEFORE any read/write so a disabled service cannot touch data.
  if (willMutate && !gdprEnabled) {
    throw new ErasureNotEnabledError();
  }

  // Fail-closed tenant lookup.
  const tenantWhere = scope?.tenantId ? { tenantId: String(scope.tenantId) } : {};
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, ...tenantWhere },
  });
  if (!customer) throw new CustomerNotFoundError();

  const ctx = await resolveTargets(prisma, customer);

  // Build the per-model plan: where-clause, data patch, storage refs, count.
  const entries = Object.values(CUSTOMER_PII_MAP);
  const plan = [];
  let storageToDelete = [];

  for (const spec of entries) {
    // The master customer row is handled explicitly below (it also owns the
    // suppression flag and its storage refs come from the already-loaded row).
    if (spec.match.kind === 'self') continue;

    const wheres = buildWheres(spec, ctx);
    if (!wheres.length) continue;

    // Collect storage bytes to reap (person documents only — vehicle photos
    // are retained and never listed under columns.storage).
    const refs = await collectStorageRefs(prisma, spec, wheres);
    storageToDelete = storageToDelete.concat(refs);

    const count = await countRows(prisma, spec, wheres);
    plan.push({ spec, wheres, count });
  }

  // Master customer storage refs (from the row we already hold).
  const customerSpec = CUSTOMER_PII_MAP.customer;
  for (const s of customerSpec.columns.storage || []) {
    const cls = classifyStorageRef(customer[s.column], { defaultBucket: s.defaultBucket });
    if (cls.kind === 'object') {
      storageToDelete.push({ bucket: cls.bucket, path: cls.path, source: `Customer.${s.column}` });
    }
  }

  const tables = {};
  for (const p of plan) tables[p.spec.model] = p.count;
  tables.customer = 1;

  // AuthNet profile to erase (from the loaded customer).
  const authnetProfileId = customer[SUBPROCESSOR.authnet.profileIdColumn]
    ? String(customer[SUBPROCESSOR.authnet.profileIdColumn]).trim()
    : null;

  const retainedDisclosure = buildRetainedDisclosure(retentionMode);

  // ---- DRY RUN: return the plan, mutate NOTHING -------------------------
  if (!willMutate) {
    return {
      ok: true,
      dryRun: true,
      customerId,
      actor,
      reason: String(reason).trim(),
      gdprEnabled,
      retentionMode,
      tables,
      storageToDelete,
      authnetProfile: authnetProfileId
        ? { profileId: authnetProfileId, action: 'WOULD_DELETE' }
        : null,
      retainedDisclosure,
    };
  }

  // ---- LIVE MUTATION ----------------------------------------------------
  // ALL DB work in ONE transaction. Anonymise/redact retained + non-retained
  // rows; hard-delete Cascade-safe non-retained rows; anonymise the master
  // Customer with the complete column set + set the suppression flag.
  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      const { spec, wheres } = p;
      if (spec.retention === 'RETAIN_PHOTOS') {
        continue; // vehicle photos retained — nothing to mutate
      }
      if (spec.retention === 'HARD_DELETE') {
        // Cascade children explicitly (do not rely on DB cascade), then delete.
        // Both sides chunked so no statement carries an unbounded id list.
        if (spec.model === 'conversation') {
          for (const c of chunk(ctx.conversationIds)) {
            await tx.message.deleteMany({ where: { conversationId: { in: c } } });
          }
        }
        for (const where of wheres) await tx[spec.model].deleteMany({ where });
        continue;
      }
      // RETAIN_STATUTORY + ANONYMISE both anonymise-in-place.
      const data = buildEraseData(spec, retentionMode);
      if (Object.keys(data).length > 0) {
        for (const where of wheres) await tx[spec.model].updateMany({ where, data });
      }
    }

    // Master Customer — complete column set + suppression flag.
    const customerData = buildEraseData(customerSpec, retentionMode);
    customerData.doNotRent = true;
    customerData.doNotRentReason = `Erased: ${String(reason).trim()} (by ${actor})`;
    await tx.customer.update({ where: { id: customerId }, data: customerData });
  }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS });

  // ---- AFTER COMMIT: storage + sub-processor (best-effort) --------------
  const storageDeleted = [];
  const storageFailed = [];
  for (const ref of storageToDelete) {
    try {
      const res = await deleteObject({ bucket: ref.bucket, path: ref.path });
      storageDeleted.push({ ...ref, result: res });
    } catch (err) {
      storageFailed.push({ ...ref, error: err?.message || String(err) });
      try {
        logger.warn('customer-erasure-storage-delete-failed', {
          customerId, source: ref.source, message: err?.message || String(err),
        });
      } catch { /* logging must never throw */ }
    }
  }

  let authnetResult = null;
  if (authnetProfileId) {
    try {
      let del = authnetDelete;
      if (typeof del !== 'function') {
        ({ authNetDeleteCustomerProfile: del } = await import(
          '../rental-agreements/rental-agreements.service.js'
        ));
      }
      const res = await del(authnetProfileId, scope);
      authnetResult = { profileId: authnetProfileId, action: res?.code || 'UNKNOWN', ok: !!res?.ok, message: res?.message || '' };
      if (!res?.ok) {
        logger.warn('customer-erasure-authnet-delete-failed', {
          customerId, profileId: authnetProfileId, code: res?.code, message: res?.message,
        });
      }
    } catch (err) {
      authnetResult = { profileId: authnetProfileId, action: 'EXCEPTION', ok: false, message: err?.message || String(err) };
      try {
        logger.warn('customer-erasure-authnet-delete-exception', {
          customerId, profileId: authnetProfileId, message: err?.message || String(err),
        });
      } catch { /* ignore */ }
    }
  }

  // AuditLog.reservationId is REQUIRED non-null, so a customer-level erasure
  // event cannot be an AuditLog row — log to the structured logger instead.
  try {
    logger.info('customer-erasure-completed', {
      customerId, actor, reason: String(reason).trim(),
      tables, storageDeleted: storageDeleted.length, storageFailed: storageFailed.length,
      authnet: authnetResult?.action || 'none',
    });
  } catch { /* ignore */ }

  return {
    ok: true,
    dryRun: false,
    customerId,
    actor,
    reason: String(reason).trim(),
    gdprEnabled,
    retentionMode,
    tables,
    storageToDelete,
    storageDeleted,
    storageFailed,
    authnetProfile: authnetResult,
    retainedDisclosure,
  };
}

function buildRetainedDisclosure(mode) {
  const lastNameClause = mode === RETENTION_MODES.FULL_DELETE
    ? 'In FULL_DELETE mode even the customer LAST name is erased on these records.'
    : 'In CONSERVATIVE mode the customer LAST name is retained on agreements (money ' +
      'columns, timestamps, agreement numbers and vehicle/location IDs are always kept).';
  return [
    `Retention mode: ${mode}.`,
    'A minimised suppression record is retained: Customer.doNotRent is set to true ' +
      'with a reason, so a future sign-up with the same details cannot silently ' +
      're-onboard. This is NOT total erasure.',
    'Statutory records are retained in anonymised form: Reservations, RentalAgreements, ' +
      'LoanerAgreements, payments and damage/incident reports keep their non-identifying ' +
      'accounting facts. Personal identifiers, signature images, licence/insurance ' +
      'documents, addresses, IPs and card data on those records are erased. ' + lastNameClause,
    'Vehicle-condition photos (inspection walkarounds, loaner and damage photos) are ' +
      'retained as evidence on the retained contracts.',
  ];
}

export default { eraseCustomer, gdprErasureEnabled, ErasureNotEnabledError, CustomerNotFoundError };
