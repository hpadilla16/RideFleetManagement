/**
 * Business documents per location (2026-07-28).
 *
 * Stores a branch's operating paperwork — permits, registrations, insurance,
 * licences — with the date each stops being valid, so the operator is warned
 * BEFORE one lapses instead of finding out from an inspector.
 *
 * Files go to a PRIVATE Supabase Storage bucket; reads are signed on demand
 * and never returned as permanent URLs. Expiry is computed from expiresAt on
 * every read (see location-documents.js) rather than cached, so a document can
 * never look valid because a status column went stale.
 *
 * Location scoping is fail-closed throughout: a user restricted to certain
 * branches can only ever see, upload to, or archive documents at those
 * branches.
 */
import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { userAllowedLocationIds } from '../../lib/tenant-scope.js';
import { uploadObject, getSignedUrl, safePath, StorageError } from '../../lib/storage/supabase-storage.js';
import { decodeDocumentValue } from '../customers/customer-documents.js';
import {
  DOC_TYPES, DOC_STATUS, DEFAULT_WARN_DAYS,
  documentExpiryStatus, normalizeDocType, sortByUrgency,
} from './location-documents.js';

export const LOCATION_DOCS_BUCKET =
  process.env.SUPABASE_STORAGE_LOCATION_DOCS_BUCKET || 'location-documents';

function err(message, statusCode) { const e = new Error(message); e.statusCode = statusCode; return e; }

/** Warning window; Hector's ask is 30 days, overridable per deployment. */
export function warnDays() {
  const n = Number(process.env.LOCATION_DOCS_WARN_DAYS || DEFAULT_WARN_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WARN_DAYS;
}

/** yyyy-mm-dd (or anything Date-parseable) → a date-only Date, or null. */
function toDateOnly(v) {
  if (!v) return null;
  const d = new Date(v);
  if (!Number.isFinite(d.valueOf())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Confirm the location belongs to the tenant AND the caller may touch it.
 * Fail-closed: a scoped user gets 404 for a branch outside their scope, the
 * same answer as a branch that does not exist — no existence oracle.
 */
async function assertLocationAllowed(user, tenantId, locationId, db = prisma) {
  const loc = await db.location.findFirst({
    where: { id: String(locationId), tenantId },
    select: { id: true, name: true, code: true },
  });
  if (!loc) throw err('Location not found', 404);
  const allowed = userAllowedLocationIds(user);
  if (allowed && !allowed.includes(loc.id)) throw err('Location not found', 404);
  return loc;
}

function serialize(row, opts = {}) {
  const { status, daysLeft } = documentExpiryStatus(row.expiresAt, {
    now: opts.now, warnDays: opts.warnDays ?? warnDays(),
  });
  return {
    id: row.id,
    locationId: row.locationId,
    location: row.location ? { id: row.location.id, name: row.location.name, code: row.location.code } : undefined,
    docType: row.docType,
    label: row.label,
    notes: row.notes,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    recordStatus: row.status,
    expiryStatus: status,
    daysLeft,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const locationDocumentsService = {
  DOC_TYPES,

  /** Documents on file for one branch (ACTIVE by default). */
  async list(user, locationId, { includeArchived = false } = {}, db = prisma) {
    const tenantId = user?.tenantId;
    if (!tenantId) throw err('tenantId is required', 400);
    await assertLocationAllowed(user, tenantId, locationId, db);

    const rows = await db.locationDocument.findMany({
      where: {
        tenantId,
        locationId: String(locationId),
        ...(includeArchived ? {} : { status: 'ACTIVE' }),
      },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => serialize(r));
  },

  /**
   * Upload a document. `file` is a data: URL or raw base64 (same shape the
   * customer-document uploader accepts), so the browser can post JSON without
   * a multipart dependency.
   */
  async upload(user, locationId, payload = {}, db = prisma, deps = {}) {
    const tenantId = user?.tenantId;
    if (!tenantId) throw err('tenantId is required', 400);
    const loc = await assertLocationAllowed(user, tenantId, locationId, db);

    const label = String(payload.label || '').trim();
    if (!label) throw err('label is required', 400);
    if (!payload.file) throw err('file is required', 400);

    let decoded;
    try {
      decoded = decodeDocumentValue(payload.file);
    } catch (e) {
      throw err(e?.message || 'file could not be read', e?.statusCode || 400);
    }
    // An already-hosted URL is not a document we control; refuse rather than
    // storing a reference that could rot or point anywhere.
    if (decoded.passthrough) throw err('file must be an uploaded document, not a link', 400);

    const expiresAt = toDateOnly(payload.expiresAt);
    const issuedAt = toDateOnly(payload.issuedAt);
    if (payload.expiresAt && !expiresAt) throw err('expiresAt is not a valid date', 400);
    if (issuedAt && expiresAt && expiresAt < issuedAt) {
      throw err('expiresAt cannot be before issuedAt', 400);
    }

    const path = safePath(
      'tenants', tenantId, 'locations', loc.id, 'documents',
      `${crypto.randomUUID()}.${decoded.ext}`,
    );
    try {
      await (deps.uploadObject || uploadObject)({
        bucket: LOCATION_DOCS_BUCKET,
        path,
        body: decoded.buffer,
        contentType: decoded.contentType,
      });
    } catch (e) {
      logger.error('[location-docs] upload failed', {
        tenantId, locationId: loc.id, message: String(e?.message || e),
      });
      throw err('Could not store the document — please try again', 502);
    }

    const row = await db.locationDocument.create({
      data: {
        tenantId,
        locationId: loc.id,
        docType: normalizeDocType(payload.docType),
        label,
        notes: payload.notes ? String(payload.notes).slice(0, 1000) : null,
        storagePath: path,
        fileName: payload.fileName ? String(payload.fileName).slice(0, 255) : null,
        mimeType: decoded.contentType,
        sizeBytes: decoded.buffer?.byteLength ?? null,
        issuedAt,
        expiresAt,
        uploadedByUserId: user?.id || null,
      },
    });
    logger.info('[location-docs] uploaded', {
      tenantId, locationId: loc.id, docId: row.id, docType: row.docType,
    });
    return serialize(row);
  },

  /** Editable metadata. The FILE itself is immutable — replace by re-uploading. */
  async update(user, id, payload = {}, db = prisma) {
    const tenantId = user?.tenantId;
    const row = await db.locationDocument.findFirst({ where: { id: String(id), tenantId } });
    if (!row) throw err('Document not found', 404);
    await assertLocationAllowed(user, tenantId, row.locationId, db);

    const data = {};
    if (payload.label !== undefined) {
      const label = String(payload.label || '').trim();
      if (!label) throw err('label cannot be empty', 400);
      data.label = label;
    }
    if (payload.docType !== undefined) data.docType = normalizeDocType(payload.docType);
    if (payload.notes !== undefined) data.notes = payload.notes ? String(payload.notes).slice(0, 1000) : null;
    if (payload.expiresAt !== undefined) {
      const d = toDateOnly(payload.expiresAt);
      if (payload.expiresAt && !d) throw err('expiresAt is not a valid date', 400);
      data.expiresAt = d;
    }
    if (payload.issuedAt !== undefined) data.issuedAt = toDateOnly(payload.issuedAt);

    const updated = await db.locationDocument.update({ where: { id: row.id }, data });
    return serialize(updated);
  },

  /**
   * Archive (never hard-delete): an audit may still need to see what was on
   * file on a given date, and the stored object is what proves it.
   */
  async archive(user, id, db = prisma) {
    const tenantId = user?.tenantId;
    const row = await db.locationDocument.findFirst({ where: { id: String(id), tenantId } });
    if (!row) throw err('Document not found', 404);
    await assertLocationAllowed(user, tenantId, row.locationId, db);
    const updated = await db.locationDocument.update({
      where: { id: row.id }, data: { status: 'ARCHIVED' },
    });
    return serialize(updated);
  },

  /** Short-lived signed URL. Never persisted, never logged. */
  async signedUrl(user, id, db = prisma, deps = {}) {
    const tenantId = user?.tenantId;
    const row = await db.locationDocument.findFirst({ where: { id: String(id), tenantId } });
    if (!row) throw err('Document not found', 404);
    await assertLocationAllowed(user, tenantId, row.locationId, db);
    try {
      const url = await (deps.getSignedUrl || getSignedUrl)({
        bucket: LOCATION_DOCS_BUCKET, path: row.storagePath, expiresIn: 300,
      });
      return { url, fileName: row.fileName || `${row.label}`, mimeType: row.mimeType };
    } catch (e) {
      if (e instanceof StorageError) throw err('Document is not retrievable right now', 502);
      throw e;
    }
  },

  /**
   * Everything expiring soon or already lapsed, across the branches this user
   * can see. Feeds the dashboard warning.
   */
  async expiringSoon(user, { days, now = new Date() } = {}, db = prisma) {
    const tenantId = user?.tenantId;
    if (!tenantId) return { items: [], expiringCount: 0, expiredCount: 0, warnDays: warnDays() };
    const window = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : warnDays();

    const allowed = userAllowedLocationIds(user);
    const cutoff = new Date(now.getTime() + window * 86400000);

    const rows = await db.locationDocument.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        // NULL expiresAt is perpetual and must never be chased.
        expiresAt: { not: null, lte: cutoff },
        ...(allowed ? { locationId: { in: allowed } } : {}),
      },
      include: { location: { select: { id: true, name: true, code: true } } },
      orderBy: { expiresAt: 'asc' },
      take: 200,
    });

    const items = sortByUrgency(rows, { now, warnDays: window }).map((r) => serialize(r, { now, warnDays: window }));
    return {
      items,
      expiringCount: items.filter((i) => i.expiryStatus === DOC_STATUS.EXPIRING).length,
      expiredCount: items.filter((i) => i.expiryStatus === DOC_STATUS.EXPIRED).length,
      warnDays: window,
    };
  },
};

export default locationDocumentsService;
