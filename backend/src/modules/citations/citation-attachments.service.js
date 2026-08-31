/**
 * citation-attachments.service — supporting documents attached TO a citation.
 * Plan: doc/citations-documents-export-plan-2026-08-28.md
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS IS NOT CitationDocument, AND MUST NEVER BECOME IT.
 * ══════════════════════════════════════════════════════════════════════════
 * CitationDocument is the OCR INTAKE queue: a scanned notice arrives,
 * citation-ocr.scheduler.js claims it with `where: { status: 'PENDING' }`,
 * ships its bytes to an AI provider, and CREATES a Citation from what comes
 * back. The direction is document → becomes → citation.
 *
 * This table is the opposite: citation → has many → documents, attached after
 * the fact. Correspondence with the agency, proof of payment, a dispute
 * letter, the renter's signed acknowledgement.
 *
 * Writing these rows into CitationDocument would hand a payment receipt to an
 * AI provider to be parsed as if it were a new citation, carrying the renter's
 * name, licence details and address with it. Corpusa's citation OCR was
 * switched off on 2026-08-27 for the TL International data-protection
 * disclosure, and we have said in writing that AI-assisted processing is off
 * for that tenant. So the isolation is STRUCTURAL, not a matter of care: rows
 * here have no `status: 'PENDING'` and live in a table the scheduler never
 * queries. Pinned by citation-attachments-ocr-isolation.test.mjs.
 *
 * Everything else follows the proven LocationDocument attachment shape
 * (locations/location-documents.service.js): private bucket, signed reads,
 * archive rather than hard-delete, fail-closed location scoping.
 *
 * Tenant + location scoping reuses citationLocationWhere() from
 * citations.service.js, so an attachment is reachable exactly when its
 * citation is — no second, weaker rule to drift out of step.
 */
import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { uploadObject, getSignedUrl, safePath, StorageError } from '../../lib/storage/index.js';
import { isStorageEnabled } from '../rental-agreements/inspection-photos.js';
import { citationLocationWhere } from './citations.service.js';
import {
  ATTACHMENT_DOC_TYPES, ATTACHMENT_MAX_BYTES, ATTACHMENT_STATUS,
  normalizeDocType, isAllowedMime, extForMime, mayContainCardData,
  CARD_WARNING_CODE, CARD_WARNING_MESSAGE,
} from './citation-attachments.js';

export const CITATION_ATTACHMENT_BUCKET =
  process.env.SUPABASE_STORAGE_CITATION_DOCS_BUCKET || 'citation-documents';

function err(message, status, extra = {}) {
  const e = new Error(message);
  e.status = status;
  e.statusCode = status;
  Object.assign(e, extra);
  return e;
}

/**
 * Resolve the citation the caller is allowed to act on, or 404.
 *
 * Fail-closed and scoped exactly like citationsService.getDetail: a
 * location-restricted user gets the same 404 for another branch's citation as
 * for one that does not exist. No existence oracle, and no way to attach a
 * document to — or export — a citation they cannot already open.
 */
async function assertCitationAllowed(citationId, scope, db = prisma) {
  if (!scope?.tenantId) throw err('tenantId is required', 400);
  const citation = await db.citation.findFirst({
    where: { id: String(citationId), tenantId: scope.tenantId, ...citationLocationWhere(scope) },
    select: { id: true, tenantId: true, citationNo: true },
  });
  if (!citation) throw err('Citation not found', 404);
  return citation;
}

/** Split "<bucket>:<path>" — the storage convention CitationDocument uses. */
export function parseStorageRef(ref) {
  const s = String(ref || '');
  const idx = s.indexOf(':');
  if (idx <= 0) return null;
  return { bucket: s.slice(0, idx), path: s.slice(idx + 1) };
}

function serialize(row) {
  return {
    id: row.id,
    citationId: row.citationId,
    docType: row.docType,
    label: row.label,
    notes: row.notes,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    uploadedByUserId: row.uploadedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Decode a base64 data URL into bytes + a TRUSTED content type.
 *
 * The declared mime is checked against the allowlist and then against the
 * file's own magic header where we have one. A .docx renamed to .pdf would
 * otherwise be appended to an export as a corrupt page; worse, trusting the
 * caller's mime is how an allowlist becomes decorative.
 */
export function decodeAttachment(dataUrl) {
  const match = /^data:([\w/.+-]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!match) throw err('file must be a base64 data URL', 400);
  const declared = String(match[1] || '').toLowerCase();
  if (!isAllowedMime(declared)) throw err(`Unsupported file type: ${declared}`, 415);

  let buffer;
  try {
    buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  } catch {
    throw err('file is not valid base64', 400);
  }
  if (!buffer?.byteLength) throw err('file is empty', 400);
  if (buffer.byteLength > ATTACHMENT_MAX_BYTES) {
    throw err(`file exceeds the ${Math.floor(ATTACHMENT_MAX_BYTES / (1024 * 1024))}MB limit`, 413);
  }

  // Magic-header cross-check for the two types the export actually embeds.
  // Only correct a LIE we can prove; unknown headers keep the declared type.
  const head = buffer.subarray(0, 12);
  const isPdfBytes = head.subarray(0, 4).toString('latin1') === '%PDF';
  const isJpegBytes = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isPngBytes = head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';

  let contentType = declared;
  if (isPdfBytes) contentType = 'application/pdf';
  else if (isJpegBytes) contentType = 'image/jpeg';
  else if (isPngBytes) contentType = 'image/png';
  else if (declared === 'application/pdf' || declared === 'image/jpeg' || declared === 'image/png') {
    // Claimed to be an embeddable type but the bytes say otherwise. Refuse
    // rather than store something the export would render as a broken page.
    throw err('file contents do not match its declared type', 400);
  }

  return { buffer, contentType, ext: extForMime(contentType) };
}

export const citationAttachmentsService = {
  DOC_TYPES: ATTACHMENT_DOC_TYPES,

  /** ACTIVE attachments on a citation, oldest first (the order they arrived). */
  async list(citationId, scope = {}, { includeArchived = false } = {}, db = prisma) {
    await assertCitationAllowed(citationId, scope, db);
    const rows = await db.citationAttachment.findMany({
      where: {
        tenantId: scope.tenantId,
        citationId: String(citationId),
        ...(includeArchived ? {} : { status: ATTACHMENT_STATUS.ACTIVE }),
      },
      orderBy: [{ createdAt: 'asc' }],
    });
    return { rows: rows.map(serialize), total: rows.length };
  },

  /**
   * Attach a document. `file` is a base64 data URL so the browser posts plain
   * JSON — same shape the citation-notice uploader already accepts, and no
   * multipart dependency.
   *
   * `acknowledgedCardWarning` is the operator having SEEN the payment-card
   * prompt and confirmed. Without it, a likely-card document is refused with
   * 409 + CARD_DATA_CONFIRMATION_REQUIRED so the UI can ask. That is a
   * confirmation, not a block — confirming always succeeds.
   */
  async upload(citationId, payload = {}, scope = {}, deps = {}, db = prisma) {
    const citation = await assertCitationAllowed(citationId, scope, db);
    if (!isStorageEnabled()) throw err('Document storage is not enabled', 503);

    const label = String(payload.label || '').trim();
    if (!label) throw err('label is required', 400);
    const docType = normalizeDocType(payload.docType);
    const fileName = payload.fileName ? String(payload.fileName).slice(0, 255) : null;

    // The PCI prompt — before we decode or store a single byte.
    if (!payload.acknowledgedCardWarning && mayContainCardData({ docType, fileName, label })) {
      throw err(CARD_WARNING_MESSAGE, 409, { code: CARD_WARNING_CODE, requiresConfirmation: true });
    }

    const decoded = decodeAttachment(payload.file);

    const path = safePath(
      'tenants', scope.tenantId, 'citations', citation.id, 'attachments',
      `${crypto.randomUUID()}.${decoded.ext}`,
    );
    try {
      await (deps.uploadObject || uploadObject)({
        bucket: CITATION_ATTACHMENT_BUCKET,
        path,
        body: decoded.buffer,
        contentType: decoded.contentType,
        upsert: false,
      });
    } catch (e) {
      logger.error('[citation-attachments] upload failed', {
        tenantId: scope.tenantId, citationId: citation.id, message: String(e?.message || e),
      });
      throw err('Could not store the document — please try again', 502);
    }

    const row = await db.citationAttachment.create({
      data: {
        tenantId: scope.tenantId,
        citationId: citation.id,
        docType,
        label: label.slice(0, 255),
        notes: payload.notes ? String(payload.notes).slice(0, 1000) : null,
        storagePath: `${CITATION_ATTACHMENT_BUCKET}:${path}`,
        fileName,
        mimeType: decoded.contentType,
        sizeBytes: decoded.buffer.byteLength,
        uploadedByUserId: scope.userId || null,
      },
    });
    // Counts and ids only — never the label, filename or contents (PII).
    logger.info('[citation-attachments] attached', {
      tenantId: scope.tenantId, citationId: citation.id, attachmentId: row.id, docType,
    });
    return serialize(row);
  },

  /**
   * Archive an attachment. Deliberately NOT a hard delete: a citation dispute
   * is a contested record, and "what was on file when we replied to the
   * agency" must survive somebody tidying up. The retention sweep is what
   * eventually removes both the row and the bytes, on the 4-year identity
   * clock.
   */
  async remove(id, scope = {}, db = prisma) {
    if (!scope?.tenantId) throw err('tenantId is required', 400);
    const row = await db.citationAttachment.findFirst({
      where: { id: String(id), tenantId: scope.tenantId },
      select: { id: true, citationId: true, status: true },
    });
    if (!row) throw err('Attachment not found', 404);
    // Re-check through the citation so location scoping applies to the delete
    // door exactly as it does to the read door.
    await assertCitationAllowed(row.citationId, scope, db);
    if (row.status === ATTACHMENT_STATUS.ARCHIVED) return { id: row.id, status: row.status };
    const updated = await db.citationAttachment.update({
      where: { id: row.id },
      data: { status: ATTACHMENT_STATUS.ARCHIVED },
      select: { id: true, status: true },
    });
    logger.info('[citation-attachments] archived', {
      tenantId: scope.tenantId, citationId: row.citationId, attachmentId: row.id,
    });
    return updated;
  },

  /** Short-lived signed URL. Never persisted, never logged. */
  async signedUrl(id, scope = {}, deps = {}, db = prisma) {
    if (!scope?.tenantId) throw err('tenantId is required', 400);
    const row = await db.citationAttachment.findFirst({
      where: { id: String(id), tenantId: scope.tenantId },
      select: { id: true, citationId: true, storagePath: true, fileName: true, mimeType: true, label: true },
    });
    if (!row) throw err('Attachment not found', 404);
    await assertCitationAllowed(row.citationId, scope, db);
    const ref = parseStorageRef(row.storagePath);
    if (!ref) return { url: null };
    try {
      const url = await (deps.getSignedUrl || getSignedUrl)({ ...ref, expiresIn: 300 });
      return { url, fileName: row.fileName || row.label, mimeType: row.mimeType };
    } catch (e) {
      if (e instanceof StorageError) throw err('Document is not retrievable right now', 502);
      throw e;
    }
  },
};

export default citationAttachmentsService;
