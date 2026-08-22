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
 * BEHAVIOUR NOTE (deliberate): the self-service account-deletion flow now
 * DELEGATES here (dryRun:false), so it too is gated by GDPR_ERASURE_ENABLED.
 * Until an operator flips the flag on, NO erasure path mutates — that is the
 * point of invariant #1.
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
  classifyStorageRef,
  REDACTION,
} from './customer-pii-map.js';

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
// Build the Prisma `data` patch for one map entry.
//   redact   → REDACTION sentinel (required, non-null identity columns)
//   null     → null
//   zero     → 0
//   jsonEmpty→ the given empty JSON value
//   storage.requiredRedact → REDACTION (a required column whose object we reap)
// ---------------------------------------------------------------------------
function buildEraseData(spec) {
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
  return data;
}

// Compact, safe OR builder — drops empty/undefined branches and returns null
// when nothing can match (caller then skips the model entirely).
function orWhere(branches) {
  const kept = branches.filter(Boolean);
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  return { OR: kept };
}

function inClause(ids) {
  return { in: Array.isArray(ids) ? ids : [] };
}

/**
 * Resolve the where-clause that selects THIS customer's rows for a map entry.
 * Returns null when the entry cannot match anything (so the caller skips it).
 */
function whereForSpec(spec, ctx) {
  const m = spec.match;
  const tenantScope = ctx.tenantId ? { tenantId: ctx.tenantId } : {};
  switch (m.kind) {
    case 'self':
      return { id: ctx.customerId };
    case 'customerFk':
      return { [m.field]: ctx.customerId };
    case 'reservationRelation':
    case 'reservationScalar':
      return ctx.reservationIds.length ? { [m.field]: inClause(ctx.reservationIds) } : null;
    case 'agreementRelation':
      return ctx.agreementIds.length ? { [m.field]: inClause(ctx.agreementIds) } : null;
    case 'loanerRelation':
      return ctx.loanerAgreementIds.length ? { [m.field]: inClause(ctx.loanerAgreementIds) } : null;
    case 'tripRelation':
      return ctx.tripIds.length ? { [m.field]: inClause(ctx.tripIds) } : null;
    case 'tripIncidentRelation':
      return ctx.tripIncidentIds.length ? { [m.field]: inClause(ctx.tripIncidentIds) } : null;
    case 'citationDocument':
      return ctx.citationIds.length ? { citationId: inClause(ctx.citationIds) } : null;
    case 'quote': {
      const or = orWhere([
        { customerId: ctx.customerId },
        ctx.email ? { contactEmail: { equals: ctx.email, mode: 'insensitive' } } : null,
        ctx.phone ? { contactPhone: ctx.phone } : null,
      ]);
      return or ? { ...tenantScope, ...or } : null;
    }
    case 'loanerRequest': {
      const or = orWhere([
        ctx.email ? { email: { equals: ctx.email, mode: 'insensitive' } } : null,
        ctx.phone && ctx.fullName
          ? { AND: [{ phone: ctx.phone }, { name: { equals: ctx.fullName, mode: 'insensitive' } }] }
          : null,
      ]);
      return or ? { ...tenantScope, ...or } : null;
    }
    case 'externalReservation': {
      const or = orWhere([
        ctx.reservationIds.length ? { promotedToReservationId: inClause(ctx.reservationIds) } : null,
        ctx.email ? { customerEmail: { equals: ctx.email, mode: 'insensitive' } } : null,
      ]);
      return or ? { ...tenantScope, ...or } : null;
    }
    default:
      return null;
  }
}

/**
 * Read the rows a storage-bearing spec matches and collect the deletable
 * Storage objects, BEFORE any nulling. Returns [{ bucket, path, source }].
 */
async function collectStorageRefs(prisma, spec, where) {
  // Storage refs may sit under columns.storage (anonymised rows) or at the spec
  // top level (HARD_DELETE rows whose bytes we reap before deleting the row).
  const storageCols = spec.columns?.storage || spec.storage || [];
  if (!storageCols.length || !where) return [];
  const select = { id: true };
  for (const s of storageCols) select[s.column] = true;
  const rows = await prisma[spec.model].findMany({ where, select });
  const refs = [];
  for (const row of rows) {
    for (const s of storageCols) {
      const cls = classifyStorageRef(row[s.column], { defaultBucket: s.defaultBucket });
      if (cls.kind === 'object') {
        refs.push({ bucket: cls.bucket, path: cls.path, source: `${spec.label}.${s.column}` });
      }
    }
  }
  return refs;
}

/**
 * Resolve every id-set needed to reach this customer's PII, from the master
 * Customer row outward.
 */
async function resolveTargets(prisma, customer) {
  const customerId = customer.id;

  const reservations = await prisma.reservation.findMany({
    where: { customerId },
    select: { id: true },
  });
  const reservationIds = reservations.map((r) => r.id);

  const agreements = reservationIds.length
    ? await prisma.rentalAgreement.findMany({
        where: { reservationId: inClause(reservationIds) },
        select: { id: true },
      })
    : [];
  const agreementIds = agreements.map((a) => a.id);

  const loanerAgreements = reservationIds.length
    ? await prisma.loanerAgreement.findMany({
        where: { reservationId: inClause(reservationIds) },
        select: { id: true },
      })
    : [];
  const loanerAgreementIds = loanerAgreements.map((a) => a.id);

  const trips = await prisma.trip.findMany({
    where: { guestCustomerId: customerId },
    select: { id: true },
  });
  const tripIds = trips.map((t) => t.id);

  const conversations = await prisma.conversation.findMany({
    where: { customerId },
    select: { id: true, pickupPhotoUrl: true },
  });
  const conversationIds = conversations.map((c) => c.id);

  // TripIncident links via reservation OR trip.
  const tripIncidents = (reservationIds.length || tripIds.length)
    ? await prisma.tripIncident.findMany({
        where: orWhere([
          reservationIds.length ? { reservationId: inClause(reservationIds) } : null,
          tripIds.length ? { tripId: inClause(tripIds) } : null,
        ]),
        select: { id: true },
      })
    : [];
  const tripIncidentIds = tripIncidents.map((t) => t.id);

  const citations = reservationIds.length
    ? await prisma.citation.findMany({
        where: { reservationId: inClause(reservationIds) },
        select: { id: true },
      })
    : [];
  const citationIds = citations.map((c) => c.id);

  const fullName = [customer.firstName, customer.lastName]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ') || null;

  return {
    customerId,
    tenantId: customer.tenantId || null,
    email: customer.email ? String(customer.email).trim() : null,
    phone: customer.phone ? String(customer.phone).trim() : null,
    fullName,
    reservationIds,
    agreementIds,
    loanerAgreementIds,
    tripIds,
    conversationIds,
    conversationPickupPhotos: conversations.map((c) => c.pickupPhotoUrl).filter(Boolean),
    tripIncidentIds,
    citationIds,
  };
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

    const where = whereForSpec(spec, ctx);
    if (!where) continue;

    // Collect storage bytes to reap (person documents only — vehicle photos
    // are retained and never listed under columns.storage).
    const refs = await collectStorageRefs(prisma, spec, where);
    storageToDelete = storageToDelete.concat(refs);

    const count = await prisma[spec.model].count({ where });
    plan.push({ spec, where, count });
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

  const retainedDisclosure = buildRetainedDisclosure();

  // ---- DRY RUN: return the plan, mutate NOTHING -------------------------
  if (!willMutate) {
    return {
      ok: true,
      dryRun: true,
      customerId,
      actor,
      reason: String(reason).trim(),
      gdprEnabled,
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
      const { spec, where } = p;
      if (spec.retention === 'RETAIN_PHOTOS') {
        continue; // vehicle photos retained — nothing to mutate
      }
      if (spec.retention === 'HARD_DELETE') {
        // Cascade children explicitly (do not rely on DB cascade), then delete.
        if (spec.model === 'conversation') {
          await tx.message.deleteMany({
            where: { conversationId: inClause(ctx.conversationIds) },
          });
        }
        await tx[spec.model].deleteMany({ where });
        continue;
      }
      // RETAIN_STATUTORY + ANONYMISE both anonymise-in-place.
      const data = buildEraseData(spec);
      if (Object.keys(data).length > 0) {
        await tx[spec.model].updateMany({ where, data });
      }
    }

    // Master Customer — complete column set + suppression flag.
    const customerData = buildEraseData(customerSpec);
    customerData.doNotRent = true;
    customerData.doNotRentReason = `Erased: ${String(reason).trim()} (by ${actor})`;
    await tx.customer.update({ where: { id: customerId }, data: customerData });
  });

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
    tables,
    storageToDelete,
    storageDeleted,
    storageFailed,
    authnetProfile: authnetResult,
    retainedDisclosure,
  };
}

function buildRetainedDisclosure() {
  return [
    'A minimised suppression record is retained: Customer.doNotRent is set to true ' +
      'with a reason, so a future sign-up with the same details cannot silently ' +
      're-onboard. This is NOT total erasure.',
    'Statutory records are retained in anonymised form: Reservations, RentalAgreements, ' +
      'LoanerAgreements, payments and damage/incident reports keep their money columns, ' +
      'timestamps, agreement numbers, vehicle/location IDs and the customer LAST name. ' +
      'Personal identifiers, signature images, licence/insurance documents, addresses and ' +
      'card data on those records are erased.',
    'Vehicle-condition photos (inspection walkarounds, loaner and damage photos) are ' +
      'retained as evidence on the retained contracts.',
  ];
}

export default { eraseCustomer, gdprErasureEnabled, ErasureNotEnabledError, CustomerNotFoundError };
