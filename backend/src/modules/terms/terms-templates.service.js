/**
 * TermsTemplate service (2026-05-21).
 *
 * Per-tenant T&C templates with named field markers. Each tenant has 0..N
 * templates, exactly one isActive=true at a time. Templates referenced by
 * any ReservationSigning row become immutable — edits require a new version.
 *
 * Marker syntax in contentHtml: `{{markerKey}}` where markerKey matches
 * /^[A-Z0-9_]+$/. Every required field's markerKey MUST appear in
 * contentHtml; every {{...}} marker in contentHtml MUST have a matching
 * TermsTemplateField row. The service validates both directions.
 *
 * Spec: doc/interactive-tc-and-dejavoo-unified-2026-05-21.md §4.1
 */

// Lazy prisma — same pattern as feature-flags lib so tests stay self-contained.
let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

export const FIELD_KINDS = Object.freeze(['INITIAL', 'SIGNATURE', 'CHECKBOX', 'TEXT_FIELD', 'DATE']);
export const CONTENT_LANGUAGES = Object.freeze(['es', 'en', 'both']);

const MARKER_KEY_RE = /^[A-Z0-9_]+$/;
const MARKER_RE = /\{\{([A-Z0-9_]+)\}\}/g;

export class TermsTemplateError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TermsTemplateError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Extract all unique `{{MARKER_KEY}}` strings from a contentHtml blob.
 */
export function extractMarkers(contentHtml) {
  if (!contentHtml || typeof contentHtml !== 'string') return new Set();
  const out = new Set();
  let m;
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(contentHtml)) !== null) {
    out.add(m[1]);
  }
  return out;
}

/**
 * Validate a template payload before write.
 * - All required fields' markerKey must appear in contentHtml as {{markerKey}}.
 * - All {{...}} markers in contentHtml must have a matching field.
 * - markerKey must match /^[A-Z0-9_]+$/.
 * - kind must be one of FIELD_KINDS.
 * - contentLanguage must be one of CONTENT_LANGUAGES.
 *
 * @returns {void} throws TermsTemplateError on any violation.
 */
export function validateTemplatePayload({ contentHtml, contentLanguage, fields }) {
  if (!contentHtml || typeof contentHtml !== 'string' || !contentHtml.trim()) {
    throw new TermsTemplateError('contentHtml is required', 400);
  }
  if (contentLanguage && !CONTENT_LANGUAGES.includes(contentLanguage)) {
    throw new TermsTemplateError(
      `contentLanguage must be one of ${CONTENT_LANGUAGES.join(', ')}`,
      400
    );
  }
  if (!Array.isArray(fields)) {
    throw new TermsTemplateError('fields must be an array', 400);
  }

  // Validate every field row
  const markerKeysSeen = new Set();
  for (const f of fields) {
    if (!f || typeof f !== 'object') {
      throw new TermsTemplateError('each field must be an object', 400);
    }
    if (!FIELD_KINDS.includes(f.kind)) {
      throw new TermsTemplateError(
        `field.kind must be one of ${FIELD_KINDS.join(', ')} (got '${f.kind}')`,
        400
      );
    }
    if (!f.markerKey || !MARKER_KEY_RE.test(f.markerKey)) {
      throw new TermsTemplateError(
        `field.markerKey must match /^[A-Z0-9_]+$/ (got '${f.markerKey}')`,
        400
      );
    }
    if (markerKeysSeen.has(f.markerKey)) {
      throw new TermsTemplateError(
        `Duplicate markerKey '${f.markerKey}' — each marker must be unique within the template`,
        400
      );
    }
    markerKeysSeen.add(f.markerKey);
    if (!f.label || !String(f.label).trim()) {
      throw new TermsTemplateError(`field.label is required (markerKey=${f.markerKey})`, 400);
    }
  }

  // Cross-check markers ↔ fields
  const markers = extractMarkers(contentHtml);
  const requiredMarkers = new Set(
    fields.filter((f) => f.required !== false).map((f) => f.markerKey)
  );
  const allMarkerKeys = new Set(fields.map((f) => f.markerKey));

  const missingInHtml = [...requiredMarkers].filter((k) => !markers.has(k));
  if (missingInHtml.length > 0) {
    throw new TermsTemplateError(
      `Required fields missing from contentHtml as {{...}}: ${missingInHtml.join(', ')}`,
      400
    );
  }
  const unknownInHtml = [...markers].filter((m) => !allMarkerKeys.has(m));
  if (unknownInHtml.length > 0) {
    throw new TermsTemplateError(
      `HTML references {{markerKey}} with no matching field: ${unknownInHtml.join(', ')}`,
      400
    );
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * List templates for a tenant. Newest first. Includes field counts.
 */
export async function listTemplatesForTenant({ tenantId, prisma } = {}) {
  if (!tenantId) throw new TermsTemplateError('tenantId required', 400);
  prisma = prisma || (await resolveDefaultPrisma());
  return prisma.termsTemplate.findMany({
    where: { tenantId },
    orderBy: [{ isActive: 'desc' }, { effectiveDate: 'desc' }],
    include: {
      _count: { select: { fields: true, signings: true } },
    },
  });
}

/**
 * Get a single template with all its fields, in order.
 */
export async function getTemplateById({ id, tenantId, prisma } = {}) {
  if (!id) throw new TermsTemplateError('id required', 400);
  prisma = prisma || (await resolveDefaultPrisma());
  const row = await prisma.termsTemplate.findFirst({
    where: { id, ...(tenantId ? { tenantId } : {}) },
    include: {
      fields: { orderBy: { order: 'asc' } },
      _count: { select: { signings: true } },
    },
  });
  if (!row) throw new TermsTemplateError('Template not found', 404);
  return row;
}

/**
 * Create a template + its fields atomically. Does NOT activate by default.
 */
export async function createTemplate({
  tenantId,
  name,
  version,
  contentHtml,
  contentLanguage = 'both',
  effectiveDate,
  fields = [],
  createdByUserId,
  prisma,
} = {}) {
  if (!tenantId) throw new TermsTemplateError('tenantId required', 400);
  if (!name) throw new TermsTemplateError('name required', 400);
  if (!version) throw new TermsTemplateError('version required', 400);
  if (!effectiveDate) throw new TermsTemplateError('effectiveDate required', 400);
  validateTemplatePayload({ contentHtml, contentLanguage, fields });

  prisma = prisma || (await resolveDefaultPrisma());
  return prisma.$transaction(async (tx) => {
    // Reject duplicate (tenantId, version) explicitly so the error is friendly.
    const existing = await tx.termsTemplate.findUnique({
      where: { tenantId_version: { tenantId, version } },
    });
    if (existing) {
      throw new TermsTemplateError(
        `Template version '${version}' already exists for this tenant`,
        409
      );
    }
    const template = await tx.termsTemplate.create({
      data: {
        tenantId,
        name,
        version,
        contentHtml,
        contentLanguage,
        effectiveDate: new Date(effectiveDate),
        createdByUserId: createdByUserId || null,
        isActive: false,
        fields: {
          create: fields.map((f, idx) => ({
            kind: f.kind,
            label: f.label,
            markerKey: f.markerKey,
            required: f.required !== false,
            order: typeof f.order === 'number' ? f.order : idx,
            terminalContextText: f.terminalContextText || null,
            terminalPromptText: f.terminalPromptText || null,
          })),
        },
      },
      include: { fields: { orderBy: { order: 'asc' } } },
    });
    return template;
  });
}

/**
 * Update a template. Blocked (409) if any ReservationSigning references it.
 * Replaces the full fields array.
 */
export async function updateTemplate({
  id,
  tenantId,
  name,
  contentHtml,
  contentLanguage,
  effectiveDate,
  fields,
  prisma,
} = {}) {
  if (!id) throw new TermsTemplateError('id required', 400);
  prisma = prisma || (await resolveDefaultPrisma());
  return prisma.$transaction(async (tx) => {
    const existing = await tx.termsTemplate.findFirst({
      where: { id, ...(tenantId ? { tenantId } : {}) },
      include: { _count: { select: { signings: true } } },
    });
    if (!existing) throw new TermsTemplateError('Template not found', 404);
    if (existing._count.signings > 0) {
      throw new TermsTemplateError(
        'Template is referenced by signed reservations — create a new version instead',
        409
      );
    }
    const nextHtml = contentHtml ?? existing.contentHtml;
    const nextLanguage = contentLanguage ?? existing.contentLanguage;
    if (fields !== undefined) {
      validateTemplatePayload({
        contentHtml: nextHtml,
        contentLanguage: nextLanguage,
        fields,
      });
      // Replace all field rows
      await tx.termsTemplateField.deleteMany({ where: { templateId: id } });
      await tx.termsTemplateField.createMany({
        data: fields.map((f, idx) => ({
          templateId: id,
          kind: f.kind,
          label: f.label,
          markerKey: f.markerKey,
          required: f.required !== false,
          order: typeof f.order === 'number' ? f.order : idx,
          terminalContextText: f.terminalContextText || null,
          terminalPromptText: f.terminalPromptText || null,
        })),
      });
    } else if (contentHtml !== undefined) {
      // Re-validate markers against existing fields
      const currentFields = await tx.termsTemplateField.findMany({
        where: { templateId: id },
        select: { kind: true, label: true, markerKey: true, required: true },
      });
      validateTemplatePayload({
        contentHtml: nextHtml,
        contentLanguage: nextLanguage,
        fields: currentFields,
      });
    }
    return tx.termsTemplate.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(contentHtml !== undefined ? { contentHtml: nextHtml } : {}),
        ...(contentLanguage !== undefined ? { contentLanguage: nextLanguage } : {}),
        ...(effectiveDate !== undefined ? { effectiveDate: new Date(effectiveDate) } : {}),
      },
      include: { fields: { orderBy: { order: 'asc' } } },
    });
  });
}

/**
 * Activate a template. Atomically flips all other templates in the same
 * tenant to isActive=false.
 */
export async function activateTemplate({ id, tenantId, prisma } = {}) {
  if (!id) throw new TermsTemplateError('id required', 400);
  prisma = prisma || (await resolveDefaultPrisma());
  return prisma.$transaction(async (tx) => {
    const target = await tx.termsTemplate.findFirst({
      where: { id, ...(tenantId ? { tenantId } : {}) },
    });
    if (!target) throw new TermsTemplateError('Template not found', 404);
    // Validate the template has at least one field — activating an empty
    // template would be a misconfiguration.
    const fieldCount = await tx.termsTemplateField.count({ where: { templateId: id } });
    if (fieldCount === 0) {
      throw new TermsTemplateError('Template has no fields — add fields before activating', 422);
    }
    await tx.termsTemplate.updateMany({
      where: { tenantId: target.tenantId, isActive: true, id: { not: id } },
      data: { isActive: false },
    });
    return tx.termsTemplate.update({
      where: { id },
      data: { isActive: true },
      include: { fields: { orderBy: { order: 'asc' } } },
    });
  });
}

/**
 * Delete a template. Blocked if any ReservationSigning references it.
 */
export async function deleteTemplate({ id, tenantId, prisma } = {}) {
  if (!id) throw new TermsTemplateError('id required', 400);
  prisma = prisma || (await resolveDefaultPrisma());
  return prisma.$transaction(async (tx) => {
    const existing = await tx.termsTemplate.findFirst({
      where: { id, ...(tenantId ? { tenantId } : {}) },
      include: { _count: { select: { signings: true } } },
    });
    if (!existing) throw new TermsTemplateError('Template not found', 404);
    if (existing._count.signings > 0) {
      throw new TermsTemplateError(
        'Template is referenced by signed reservations — cannot delete (deactivate instead)',
        409
      );
    }
    await tx.termsTemplate.delete({ where: { id } });
    return { deleted: true, id };
  });
}

/**
 * Resolve the active template for a tenant. Returns null if none active.
 * Used by the counter signing orchestrator to know which template + fields
 * to render.
 */
export async function getActiveTemplateForTenant({ tenantId, prisma } = {}) {
  if (!tenantId) return null;
  prisma = prisma || (await resolveDefaultPrisma());
  return prisma.termsTemplate.findFirst({
    where: { tenantId, isActive: true },
    include: { fields: { orderBy: { order: 'asc' } } },
  });
}
