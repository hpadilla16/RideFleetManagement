import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { uploadObject, safePath } from '../../lib/storage/index.js';
import { isStorageEnabled, getPhotosBucket } from '../rental-agreements/inspection-photos.js';
import { settingsService } from '../settings/settings.service.js';
import { validateReviewPhoto } from './review-proof.extract.js';
import { normalizeReviewTiers } from '../../lib/review-tiers.js';

function normalizeScope(scope = {}) {
  return scope?.tenantId ? { tenantId: scope.tenantId } : {};
}

function normalizeDecimal(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// LAX #4: plan targeting. Only 'VIRTUAL_AGENT' is meaningful; everything
// else (including 'STANDARD') stores null = standard employees, so the
// sync's standard-plan resolution stays a simple null/not-VIRTUAL_AGENT check.
function normalizePlanPersonKind(value) {
  return String(value || '').trim().toUpperCase() === 'VIRTUAL_AGENT' ? 'VIRTUAL_AGENT' : null;
}

// LAX #5: review tiers on a plan. undefined = untouched; null/[] clears;
// an invalid shape is REJECTED loudly (money must never half-parse — same
// posture as deposit-rules).
function normalizePlanReviewTiers(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || (Array.isArray(raw) && raw.length === 0)) return null;
  const tiers = normalizeReviewTiers(raw);
  if (!tiers) { const e = new Error('reviewTiers must be [{minReviews (int >= 0), pct (0-100)}] with unique thresholds'); e.httpStatus = 400; throw e; }
  return tiers;
}

// QA M3: tiers without sources would silently zero EVERY contract's
// commission (fail-closed qualifier matches nothing). That's a config
// mistake, not a policy — reject it loudly at write time.
function assertTierSourcePair(tiers, sources) {
  if (tiers && (!sources || !sources.length)) {
    const e = new Error('Review tiers require at least one qualifying source (e.g. EXPEDIA, PRICELINE)'); e.httpStatus = 400; throw e;
  }
  return { reviewTiersJson: tiers, reviewTierSourcesJson: sources };
}

function normalizePlanReviewSources(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || (Array.isArray(raw) && raw.length === 0)) return null;
  if (!Array.isArray(raw)) { const e = new Error('reviewTierSources must be an array of channel names'); e.httpStatus = 400; throw e; }
  const out = raw.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean);
  if (!out.length) return null;
  return out;
}

// Per-employee hourly cap on AI validations — a counter agent re-shooting a
// photo 40× is the same abuse/cost vector the kiosk OCR caps guard against.
const REVIEW_EXTRACTS_PER_EMPLOYEE_PER_HOUR = 20;
const reviewExtractBuckets = new Map();
function registerReviewExtract(employeeUserId) {
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `${employeeUserId}:${hour}`;
  if (reviewExtractBuckets.size > 500) {
    for (const k of reviewExtractBuckets.keys()) {
      if (!k.endsWith(`:${hour}`)) reviewExtractBuckets.delete(k);
    }
  }
  const used = (reviewExtractBuckets.get(key) || 0) + 1;
  reviewExtractBuckets.set(key, used);
  return used <= REVIEW_EXTRACTS_PER_EMPLOYEE_PER_HOUR;
}

async function persistReviewProofPhoto(tenantId, proofId, photoDataUrl) {
  const match = /^data:([\w/.+-]+);base64,(.+)$/s.exec(String(photoDataUrl || ''));
  if (!match) { const e = new Error('photo must be a base64 data URL'); e.httpStatus = 400; throw e; }
  const body = Buffer.from(match[2], 'base64');
  if (!body.length) { const e = new Error('photo is empty'); e.httpStatus = 400; throw e; }
  if (body.length > 8 * 1024 * 1024) { const e = new Error('photo exceeds 8MB'); e.httpStatus = 400; throw e; }
  if (isStorageEnabled()) {
    try {
      const ext = match[1].includes('png') ? 'png' : 'jpg';
      const path = safePath('review-proofs', tenantId || 'global', proofId, `photo.${ext}`);
      await uploadObject({ bucket: getPhotosBucket(), path, body, contentType: match[1], upsert: true });
      return {
        json: { storage: true, bucket: getPhotosBucket(), refs: [{ key: 'photo', path, contentType: match[1], size: body.length, uploadedAt: new Date().toISOString() }] },
        buffer: body,
        contentType: match[1]
      };
    } catch (e) {
      logger.warn('[commissions] review-proof photo upload failed, storing inline', { proofId, err: e.message });
    }
  }
  return { json: { storage: false, photos: { photo: photoDataUrl } }, buffer: body, contentType: match[1] };
}

function monthKey(value = new Date()) {
  const d = new Date(value);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export const commissionsService = {
  // ── LAX #5: review proofs + payout workflow ────────────────────────────

  /**
   * Employee submits a review photo. The AI validates automatically:
   * VALIDATED / REJECTED; a provider failure leaves PENDING_AI for a human
   * (never auto-validates — fail-closed for money).
   */
  async submitReviewProof({ employeeUserId, tenantId, reservationId, photoDataUrl }) {
    if (!employeeUserId) { const e = new Error('employeeUserId required'); e.httpStatus = 400; throw e; }
    if (!registerReviewExtract(employeeUserId)) {
      const e = new Error('Too many review validations this hour — try again later'); e.httpStatus = 429; throw e;
    }
    const month = monthKey(new Date());
    const proof = await prisma.reviewProof.create({
      data: {
        tenantId: tenantId || null,
        employeeUserId,
        monthKey: month,
        reservationId: reservationId || null,
        photoJson: {},
        status: 'PENDING_AI',
        uploadedByUserId: employeeUserId
      }
    });
    const photo = await persistReviewProofPhoto(tenantId, proof.id, photoDataUrl).catch(async (e) => {
      await prisma.reviewProof.delete({ where: { id: proof.id } }).catch(() => {});
      throw e;
    });

    // Duplicate-photo farming (QA M2): the same bytes re-uploaded — the
    // cheapest way to turn one real review into a whole tier — auto-REJECTS
    // tenant-wide, no AI spend.
    const photoSha256 = crypto.createHash('sha256').update(photo.buffer).digest('hex');
    const duplicate = await prisma.reviewProof.findFirst({
      where: { tenantId: tenantId || null, photoSha256, id: { not: proof.id } },
      select: { id: true, employeeUserId: true }
    });
    if (duplicate) {
      return prisma.reviewProof.update({
        where: { id: proof.id },
        data: {
          photoJson: photo.json,
          photoSha256,
          status: 'REJECTED',
          aiNotes: 'Duplicate of an already-submitted review photo'
        }
      });
    }

    let verdict = null;
    let status = 'PENDING_AI';
    try {
      const cfg = await settingsService
        .resolveCitationOcrCredential({ tenantId: tenantId || null }, { feature: 'review-proof' })
        .catch(() => ({ credential: { source: 'NONE' }, model: '' }));
      // Fail-closed, as before — but the "no key" branch is now reached by a
      // tenant that simply has not configured one, instead of being papered
      // over by the platform key. The employee's uploaded photo (a review
      // screenshot, often carrying their own name) stays inside the platform.
      const apiKey = cfg?.credential?.source === 'NONE' ? null : (cfg?.credential?.credential || null);
      if (!apiKey) throw new Error('no API key configured');
      // Business-name resolution is FAIL-CLOSED (QA m2): a transient DB
      // error must not let the model judge against a placeholder name — a
      // review for a DIFFERENT business could validate.
      const tenant = tenantId
        ? await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })
        : null;
      if (tenantId && !tenant?.name) throw new Error('tenant name unavailable for validation');
      verdict = await validateReviewPhoto({
        buffer: photo.buffer,
        contentType: photo.contentType,
        businessName: tenant?.name || 'the rental company',
        apiKey,
        model: cfg.model || undefined
      });
      status = (verdict.isReview && verdict.businessNameMatches && (verdict.confidence ?? 0) >= 70)
        ? 'VALIDATED'
        : 'REJECTED';
    } catch (e) {
      logger.warn('[commissions] review-proof AI validation unavailable — proof left PENDING_AI for manual review', {
        proofId: proof.id, err: e.message
      });
    }

    return prisma.reviewProof.update({
      where: { id: proof.id },
      data: {
        photoJson: photo.json,
        photoSha256,
        status,
        aiConfidence: verdict?.confidence ?? null,
        aiPlatform: verdict?.platform ?? null,
        aiBusinessName: verdict?.businessName ?? null,
        aiRating: verdict?.rating ?? null,
        aiReviewerName: verdict?.reviewerName ?? null,
        aiNotes: verdict?.notes ?? null,
        validatedAt: status === 'VALIDATED' ? new Date() : null
      }
    });
  },

  listReviewProofs({ employeeUserId, monthKey: month, status } = {}, scope = {}) {
    return prisma.reviewProof.findMany({
      where: {
        ...normalizeScope(scope),
        ...(employeeUserId ? { employeeUserId: String(employeeUserId) } : {}),
        ...(month ? { monthKey: String(month) } : {}),
        ...(status ? { status: String(status).toUpperCase() } : {})
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      // Never haul photo blobs into a LIST (inline-fallback rows carry the
      // full base64 — QA m5). The single-proof admin view can fetch by id.
      omit: { photoJson: true }
    });
  },

  /** ADMIN manual override of the AI verdict (soft gate — always audited on the row). */
  async setReviewProofStatus(id, status, actorUserId, scope = {}) {
    const next = String(status || '').toUpperCase();
    if (!['VALIDATED', 'REJECTED'].includes(next)) { const e = new Error('status must be VALIDATED or REJECTED'); e.httpStatus = 400; throw e; }
    const row = await prisma.reviewProof.findFirst({ where: { id: String(id), ...normalizeScope(scope) }, select: { id: true } });
    if (!row) { const e = new Error('Review proof not found'); e.httpStatus = 404; throw e; }
    return prisma.reviewProof.update({
      where: { id: row.id },
      data: {
        status: next,
        reviewedByUserId: actorUserId || null,
        validatedAt: next === 'VALIDATED' ? new Date() : null
      }
    });
  },

  validatedReviewCount({ tenantId, employeeUserId, monthKey: month }) {
    return prisma.reviewProof.count({
      where: { tenantId: tenantId || null, employeeUserId, monthKey: month, status: 'VALIDATED' }
    });
  },

  /**
   * The approve / mark-paid workflow (never existed before — every row was
   * permanently PENDING despite comments claiming otherwise). SOFT gate
   * (Hector): nothing blocks; the payout screen shows the review context and
   * the action is audited via AuditLog on the agreement's reservation.
   */
  async setCommissionStatus(id, nextStatus, { actorUserId, note } = {}, scope = {}) {
    const next = String(nextStatus || '').toUpperCase();
    const ALLOWED = { APPROVED: ['PENDING'], PAID: ['APPROVED', 'PENDING'], VOID: ['PENDING', 'APPROVED'] };
    if (!ALLOWED[next]) { const e = new Error('status must be APPROVED, PAID, or VOID'); e.httpStatus = 400; throw e; }
    const row = await prisma.agreementCommission.findFirst({
      where: { id: String(id), ...normalizeScope(scope) },
      select: { id: true, status: true, tenantId: true, employeeUserId: true, commissionAmount: true, rentalAgreement: { select: { reservationId: true } } }
    });
    if (!row) { const e = new Error('Commission not found'); e.httpStatus = 404; throw e; }
    if (!ALLOWED[next].includes(String(row.status).toUpperCase())) {
      const e = new Error(`Cannot move a ${row.status} commission to ${next}`); e.httpStatus = 409; throw e;
    }
    const updated = await prisma.agreementCommission.update({
      where: { id: row.id },
      data: {
        status: next,
        ...(next === 'APPROVED' ? { approvedAt: new Date() } : {}),
        ...(next === 'PAID' ? { paidAt: new Date() } : {}),
        ...(note ? { notes: String(note).slice(0, 500) } : {})
      }
    });
    if (row.rentalAgreement?.reservationId) {
      await prisma.auditLog.create({
        data: {
          tenantId: row.tenantId || null,
          reservationId: row.rentalAgreement.reservationId,
          action: 'ADMIN_OVERRIDE',
          actorUserId: actorUserId || null,
          reason: note || null,
          metadata: JSON.stringify({
            kind: 'commission_status',
            agreementCommissionId: row.id,
            employeeUserId: row.employeeUserId,
            from: row.status,
            to: next,
            commissionAmount: Number(row.commissionAmount || 0)
          })
        }
      }).catch((e) => logger.warn('[commissions] status audit write failed', { id: row.id, err: e.message }));
    }
    return updated;
  },

  listPlans(scope = {}) {
    return prisma.commissionPlan.findMany({
      where: normalizeScope(scope),
      include: {
        rules: {
          orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
          include: { service: true }
        }
      },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }]
    });
  },

  getPlan(id, scope = {}) {
    return prisma.commissionPlan.findFirst({
      where: { id, ...normalizeScope(scope) },
      include: {
        rules: {
          orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
          include: { service: true }
        }
      }
    });
  },

  createPlan(data = {}, scope = {}) {
    return prisma.commissionPlan.create({
      data: {
        tenantId: scope?.tenantId || data.tenantId || null,
        name: String(data.name || '').trim(),
        isActive: data.isActive ?? true,
        // LAX #4: 'VIRTUAL_AGENT' targets the plan at virtual agents
        // (percent of sold items, catalog never consulted). Anything else
        // normalizes to null = standard employees.
        personKind: normalizePlanPersonKind(data.personKind),
        ...assertTierSourcePair(
          normalizePlanReviewTiers(data.reviewTiers ?? data.reviewTiersJson) ?? null,
          normalizePlanReviewSources(data.reviewTierSources ?? data.reviewTierSourcesJson) ?? null
        ),
        defaultValueType: data.defaultValueType || null,
        defaultPercentValue: normalizeDecimal(data.defaultPercentValue),
        defaultFixedAmount: normalizeDecimal(data.defaultFixedAmount)
      }
    });
  },

  async updatePlan(id, patch = {}, scope = {}) {
    const current = await prisma.commissionPlan.findFirst({
      where: { id, ...normalizeScope(scope) },
      select: { id: true, reviewTiersJson: true, reviewTierSourcesJson: true }
    });
    if (!current) throw new Error('Commission plan not found');

    const data = { ...patch };
    delete data.tenantId;
    delete data.reviewTiers;
    delete data.reviewTierSources;

    // Validate the pair against the FINAL values (a patch may touch one side).
    const nextTiers = (patch.reviewTiers ?? patch.reviewTiersJson) !== undefined
      ? normalizePlanReviewTiers(patch.reviewTiers ?? patch.reviewTiersJson)
      : normalizeReviewTiers(current.reviewTiersJson);
    const nextSources = (patch.reviewTierSources ?? patch.reviewTierSourcesJson) !== undefined
      ? normalizePlanReviewSources(patch.reviewTierSources ?? patch.reviewTierSourcesJson)
      : (Array.isArray(current.reviewTierSourcesJson) && current.reviewTierSourcesJson.length ? current.reviewTierSourcesJson : null);
    assertTierSourcePair(nextTiers, nextSources);

    return prisma.commissionPlan.update({
      where: { id },
      data: {
        ...data,
        reviewTiersJson: (patch.reviewTiers ?? patch.reviewTiersJson) !== undefined
          ? nextTiers
          : undefined,
        reviewTierSourcesJson: (patch.reviewTierSources ?? patch.reviewTierSourcesJson) !== undefined
          ? nextSources
          : undefined,
        personKind: patch.personKind !== undefined ? normalizePlanPersonKind(patch.personKind) : undefined,
        defaultPercentValue: patch.defaultPercentValue !== undefined ? normalizeDecimal(patch.defaultPercentValue) : undefined,
        defaultFixedAmount: patch.defaultFixedAmount !== undefined ? normalizeDecimal(patch.defaultFixedAmount) : undefined
      }
    });
  },

  async removePlan(id, scope = {}) {
    const current = await prisma.commissionPlan.findFirst({
      where: { id, ...normalizeScope(scope) },
      select: { id: true }
    });
    if (!current) throw new Error('Commission plan not found');
    return prisma.commissionPlan.delete({ where: { id } });
  },

  async listRules(planId, scope = {}) {
    const plan = await prisma.commissionPlan.findFirst({
      where: { id: planId, ...normalizeScope(scope) },
      select: { id: true }
    });
    if (!plan) throw new Error('Commission plan not found');

    return prisma.commissionRule.findMany({
      where: { commissionPlanId: planId },
      include: { service: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }]
    });
  },

  async createRule(planId, data = {}, scope = {}) {
    const plan = await prisma.commissionPlan.findFirst({
      where: { id: planId, ...normalizeScope(scope) },
      select: { id: true, tenantId: true }
    });
    if (!plan) throw new Error('Commission plan not found');

    return prisma.commissionRule.create({
      data: {
        commissionPlanId: planId,
        tenantId: plan.tenantId || null,
        name: String(data.name || '').trim(),
        serviceId: data.serviceId || null,
        chargeCode: data.chargeCode ? String(data.chargeCode).trim() : null,
        chargeType: data.chargeType || null,
        valueType: data.valueType,
        percentValue: normalizeDecimal(data.percentValue),
        fixedAmount: normalizeDecimal(data.fixedAmount),
        priority: Number.isInteger(data.priority) ? data.priority : Number(data.priority || 0),
        isActive: data.isActive ?? true
      },
      include: { service: true }
    });
  },

  async updateRule(id, patch = {}, scope = {}) {
    const current = await prisma.commissionRule.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true }
    });
    if (!current) throw new Error('Commission rule not found');

    const data = { ...patch };
    delete data.tenantId;
    delete data.commissionPlanId;

    return prisma.commissionRule.update({
      where: { id },
      data: {
        ...data,
        serviceId: patch.serviceId === '' ? null : patch.serviceId,
        chargeCode: patch.chargeCode === '' ? null : patch.chargeCode,
        chargeType: patch.chargeType === '' ? null : patch.chargeType,
        percentValue: patch.percentValue !== undefined ? normalizeDecimal(patch.percentValue) : undefined,
        fixedAmount: patch.fixedAmount !== undefined ? normalizeDecimal(patch.fixedAmount) : undefined,
        priority: patch.priority !== undefined ? (Number.isInteger(patch.priority) ? patch.priority : Number(patch.priority || 0)) : undefined
      },
      include: { service: true }
    });
  },

  async removeRule(id, scope = {}) {
    const current = await prisma.commissionRule.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true }
    });
    if (!current) throw new Error('Commission rule not found');
    return prisma.commissionRule.delete({ where: { id } });
  },

  async ledger(query = {}, scope = {}) {
    const start = query?.start ? new Date(query.start) : null;
    const end = query?.end ? new Date(query.end) : null;
    const employeeUserId = query?.employeeUserId ? String(query.employeeUserId) : null;
    const month = query?.month ? String(query.month) : monthKey(new Date());

    const where = {
      ...normalizeScope(scope),
      ...(employeeUserId ? { employeeUserId } : {}),
      ...(start || end
        ? {
            calculatedAt: {
              ...(start && !Number.isNaN(start.getTime()) ? { gte: start } : {}),
              ...(end && !Number.isNaN(end.getTime()) ? { lte: end } : {})
            }
          }
        : { monthKey: month })
    };

    return prisma.agreementCommission.findMany({
      where,
      include: {
        employeeUser: { select: { id: true, fullName: true, email: true, role: true } },
        rentalAgreement: { select: { id: true, agreementNumber: true, reservationId: true, closedAt: true, total: true } },
        lines: {
          include: { service: { select: { id: true, name: true, code: true } } },
          orderBy: { createdAt: 'asc' }
        }
      },
      orderBy: [{ calculatedAt: 'desc' }, { createdAt: 'desc' }]
    });
  },

  async listEmployees(scope = {}) {
    return prisma.user.findMany({
      where: {
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
        role: { in: ['ADMIN', 'OPS', 'AGENT'] },
        isActive: true
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        tenantId: true,
        commissionPlanId: true,
        commissionPlan: {
          select: { id: true, name: true, isActive: true }
        }
      },
      orderBy: [{ role: 'asc' }, { fullName: 'asc' }, { email: 'asc' }]
    });
  },

  async assignEmployeePlan(userId, commissionPlanId, scope = {}) {
    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      },
      select: { id: true, tenantId: true }
    });
    if (!user) throw new Error('Employee not found');

    if (!commissionPlanId) {
      return prisma.user.update({
        where: { id: userId },
        data: { commissionPlanId: null },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          tenantId: true,
          commissionPlanId: true,
          commissionPlan: {
            select: { id: true, name: true, isActive: true }
          }
        }
      });
    }

    const plan = await prisma.commissionPlan.findFirst({
      where: {
        id: commissionPlanId,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      },
      select: { id: true, tenantId: true }
    });
    if (!plan) throw new Error('Commission plan not found');
    if ((plan.tenantId || null) !== (user.tenantId || null)) throw new Error('Employee and commission plan must belong to the same tenant');

    return prisma.user.update({
      where: { id: userId },
      data: { commissionPlanId: plan.id },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        tenantId: true,
        commissionPlanId: true,
        commissionPlan: {
          select: { id: true, name: true, isActive: true }
        }
      }
    });
  }
};
