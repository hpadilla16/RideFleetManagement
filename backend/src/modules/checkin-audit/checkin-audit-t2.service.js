/**
 * Post-check-in audit — Tier 2 photo AI (2026-09-02).
 * Design: design/mockups/checkin-audit-NOTES.md §2 Tier 2 (pair prompt, async
 * pipeline, budget/cost story) + damage-baseline-NOTES.md §D2 (ledger as
 * prompt context — ANNOTATE, NEVER SUPPRESS) — both approved.
 *
 * Job mechanism: the citation-ocr.scheduler.js pattern, verbatim — a polling
 * interval worker in worker.js. T1 runs inline at close (arithmetic); T2 is
 * photos + an LLM = seconds per check-in, so it NEVER runs inline. The sweep
 * finds closes that have T1 findings but no T2 verdict yet ("closes missing a
 * T2 verdict") and processes them, newest-audit-first-in-asc-order, under a
 * per-tenant daily budget.
 *
 * Gates, in order (every one fails CLOSED):
 *   1. env CHECKIN_AUDIT_T2_ENABLED !== 'false'   (kill switch, default on)
 *   2. inspection-photo storage enabled            (no photos → nothing to do)
 *   3. tenant checkinAuditConfig.photoAiEnabled    (opt-in per tenant, default OFF)
 *   4. resolveCitationOcrCredential(scope, { feature: 'checkin-audit' })
 *      resolves TENANT or PLATFORM — a NONE resolution makes NO provider call
 *      and the close stays pending for the next sweep (Corpusa rule,
 *      lib/tenant-provider-credential.js).
 *   5. per-tenant dailyPhotoBudget (check-ins/day) — over-budget closes get an
 *      explicit SKIPPED_BUDGET marker, visible in the queue KPIs, never a
 *      silent drop.
 *
 * Storage contract on CheckinAuditFinding (no migration — the T1 table was
 * built for this):
 *   - checkKey 'T2_SCAN', tier T2: one marker row per audited reservation.
 *     status RESOLVED, category PASS, severity NONE; `resolution` says what
 *     happened (ANALYZING → ANALYZED | FAILED, or SKIPPED_BUDGET /
 *     SKIPPED_NO_PHOTOS) and detailsJson carries every pair verdict + token
 *     spend. Its existence is the sweep's idempotence: the unique
 *     (reservationId, checkKey) claim means one verdict per close, ever.
 *   - checkKey 'DAMAGE_SUSPECTED:<angle>', tier T2, category DAMAGE: one OPEN
 *     finding per suspected pair. Severity from confidence: >=70 ERROR (and a
 *     NEEDS_ACTION notification), 40-69 WARN, <40 recorded in the scan's
 *     verdicts but no finding (discard).
 *
 * NON-NEGOTIABLES (NOTES): the AI NEVER creates damage reports, charges, or
 * repair orders — it only queues findings for HUMAN review (the dismiss fork
 * / Report Damage wizard own every consequence). The known-damage ledger
 * context annotates the verdict (KNOWN_DAMAGE + matchedKnownIds, stamped
 * lastVerifiedAt); it never suppresses what the model saw.
 *
 * PII: never logs verdict JSON or image bytes — counts/ids only.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { downloadObject } from '../../lib/storage/index.js';
import { isStorageEnabled, getPhotosBucket } from '../rental-agreements/inspection-photos.js';
import { canonicalPhotoKey } from '../rental-agreements/inspection-photos-normalize.js';
import { settingsService } from '../settings/settings.service.js';
import { emitNotificationSafe } from '../notifications/notifications-emit.js';
import {
  REQUIRED_ANGLES,
  T2_SCAN_CHECK_KEY,
  DAMAGE_SUSPECTED_PREFIX,
  ANGLE_TO_VIEW,
} from './checkin-audit.service.js';
import { analyzePhotoPair, DEFAULT_T2_MODEL } from './checkin-audit-t2.extract.js';

export { T2_SCAN_CHECK_KEY, DAMAGE_SUSPECTED_PREFIX, ANGLE_TO_VIEW };

const INTERVAL_MS = Math.max(60 * 1000, parseInt(process.env.CHECKIN_AUDIT_T2_INTERVAL_MS || String(5 * 60 * 1000), 10) || 5 * 60 * 1000);
const BATCH = Math.max(1, Math.min(parseInt(process.env.CHECKIN_AUDIT_T2_BATCH || '10', 10) || 10, 50));
const LOOKBACK_DAYS = Math.max(1, Math.min(parseInt(process.env.CHECKIN_AUDIT_T2_LOOKBACK_DAYS || '7', 10) || 7, 30));

// ─────────────────────────────────────────────────────────────────────────────
// Contract constants
// ─────────────────────────────────────────────────────────────────────────────

export const T2_SCAN_RESOLUTIONS = Object.freeze([
  'ANALYZING', 'ANALYZED', 'FAILED', 'SKIPPED_BUDGET', 'SKIPPED_NO_PHOTOS',
]);

/** Human angle labels for notification copy ("on the rear", "front seat"). */
export const ANGLE_LABELS = Object.freeze({
  front: 'front', rear: 'rear', left: 'left side', right: 'right side',
  frontSeat: 'front seat', rearSeat: 'rear seat', dashboard: 'dashboard', trunk: 'trunk',
});

/** Photo-AI defaults (echoed in settings.service.js getCheckinAuditConfig,
 *  same convention as the T1 numbers). OFF by default — T2 is opt-in per
 *  tenant (DPA posture from the NOTES). */
export const DEFAULT_T2_CONFIG = Object.freeze({
  photoAiEnabled: false,
  dailyPhotoBudget: 100,
  photoAiModel: DEFAULT_T2_MODEL,
});

export function normalizeCheckinAuditT2Config(cfg = {}) {
  const budgetRaw = Number(cfg?.dailyPhotoBudget);
  return {
    photoAiEnabled: cfg?.photoAiEnabled === true,
    dailyPhotoBudget: Number.isFinite(budgetRaw) && budgetRaw >= 1
      ? Math.floor(budgetRaw)
      : DEFAULT_T2_CONFIG.dailyPhotoBudget,
    photoAiModel: (cfg?.photoAiModel && String(cfg.photoAiModel).trim()) || DEFAULT_T2_CONFIG.photoAiModel,
  };
}

/** Severity from confidence (the task contract): >=70 ERROR (notification),
 *  40-69 WARN, <40 null = no finding (still recorded in the scan verdicts). */
export function severityForConfidence(confidence) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return null;
  if (c >= 70) return 'ERROR';
  if (c >= 40) return 'WARN';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing — pure (angle-keyed dictionary join, NOTES §1 "not a matching
// problem")
// ─────────────────────────────────────────────────────────────────────────────

function refsByAngle(insp) {
  const map = {};
  const refs = insp?.photoStorageRefs;
  if (!Array.isArray(refs)) return map;
  for (const r of refs) {
    if (!r || !r.path || r.external) continue; // external URLs aren't downloadable bytes
    const key = canonicalPhotoKey(r.key || '');
    if (!map[key]) map[key] = r; // first photo per slot is the canonical one
  }
  return map;
}

/**
 * Pair checkout↔checkin storage refs by canonical angle. Angles missing on
 * either side are skipped and NAMED (NOTES: "skipped · N angles missing"),
 * never guessed.
 */
export function pairInspectionRefs(checkoutInsp, checkinInsp) {
  const out = refsByAngle(checkoutInsp);
  const inn = refsByAngle(checkinInsp);
  const pairs = [];
  const missing = [];
  for (const angle of REQUIRED_ANGLES) {
    if (out[angle] && inn[angle]) pairs.push({ angle, checkoutRef: out[angle], checkinRef: inn[angle] });
    else missing.push(angle);
  }
  return { pairs, missing };
}

/** Known-damage prompt entries for one angle: the vehicle's ACTIVE ledger
 *  (HARD_APPROVED, not FIXED) filtered to the angle's view. Capped short —
 *  the baseline NOTES' own mitigation for prompt over-anchoring. */
export function knownDamagesForAngle(ledgerRows = [], angle) {
  const view = ANGLE_TO_VIEW[angle] || null;
  if (!view) return [];
  return ledgerRows
    .filter((d) => d && d.view === view)
    .slice(0, 6)
    .map((d) => ({
      id: String(d.id),
      description: d.description || null,
      sinceDate: d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : null,
    }));
}

function slimRef(ref) {
  if (!ref) return null;
  return {
    key: ref.key || null,
    path: ref.path || null,
    contentType: ref.contentType || null,
    uploadedAt: ref.uploadedAt || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// One check-in
// ─────────────────────────────────────────────────────────────────────────────

function defaultDeps() {
  return {
    db: prisma,
    getConfig: (scope) => settingsService.getCheckinAuditConfig(scope),
    resolveCredential: (scope) => settingsService.resolveCitationOcrCredential(scope, { feature: 'checkin-audit' }),
    analyze: analyzePhotoPair,
    emit: emitNotificationSafe,
    download: downloadObject,
    storageEnabled: isStorageEnabled,
    bucket: null, // resolved lazily so tests never need storage env
  };
}

function commonFindingFields(candidate) {
  return {
    tenantId: candidate.tenantId,
    reservationId: String(candidate.reservationId),
    rentalAgreementId: candidate.rentalAgreementId ? String(candidate.rentalAgreementId) : null,
    vehicleId: candidate.vehicleId ? String(candidate.vehicleId) : null,
    locationId: candidate.locationId || null,
    reservationNumber: candidate.reservationNumber || null,
    vehicleLabel: candidate.vehicleLabel || null,
    closedByUserId: candidate.closedByUserId || null,
    closedByName: candidate.closedByName || null,
    returnedAt: candidate.returnedAt ? new Date(candidate.returnedAt) : null,
  };
}

async function finishScan(db, scanId, resolution, details) {
  await db.checkinAuditFinding.update({
    where: { id: scanId },
    data: { resolution, detailsJson: JSON.stringify(details || {}) },
  });
}

/**
 * Analyze one close. The T2_SCAN row was already claimed (created with
 * resolution ANALYZING) by the sweep — this fills it in. Never throws; a
 * failure lands on the scan row as FAILED with a reason (citation-ocr
 * processDoc posture) and the check-in itself is long since closed.
 */
export async function runT2ForReservationSafe(candidate, ctx, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const db = d.db;
  const scanId = ctx.scanId;
  try {
    if (!candidate.rentalAgreementId) {
      await finishScan(db, scanId, 'SKIPPED_NO_PHOTOS', { reason: 'no rental agreement on the audit rows' });
      return { skipped: 'NO_PHOTOS' };
    }

    const inspections = await db.rentalAgreementInspection.findMany({
      where: { rentalAgreementId: String(candidate.rentalAgreementId) },
      select: { phase: true, photoStorageRefs: true, capturedAt: true },
    });
    const checkoutInsp = inspections.find((i) => i.phase === 'CHECKOUT') || null;
    const checkinInsp = inspections.find((i) => i.phase === 'CHECKIN') || null;
    const { pairs, missing } = pairInspectionRefs(checkoutInsp, checkinInsp);

    if (!pairs.length) {
      await finishScan(db, scanId, 'SKIPPED_NO_PHOTOS', {
        reason: 'no angle has a photo on both sides',
        missingAngles: missing,
      });
      return { skipped: 'NO_PHOTOS' };
    }

    // The vehicle's ACTIVE damage ledger (HARD_APPROVED, not FIXED) — the
    // known/pre-existing context injected into every pair prompt.
    let ledger = [];
    if (candidate.vehicleId) {
      ledger = await db.vehicleDamageReport.findMany({
        where: { vehicleId: String(candidate.vehicleId), status: 'HARD_APPROVED' },
        select: { id: true, view: true, description: true, createdAt: true },
      }).catch(() => []);
    }

    const bucket = d.bucket || getPhotosBucket();
    const verdicts = [];
    let aiCalls = 0; let inputTokens = 0; let outputTokens = 0; let costUsd = 0;
    let suspected = 0;

    for (const pair of pairs) {
      const knownDamages = knownDamagesForAngle(ledger, pair.angle);
      // eslint-disable-next-line no-await-in-loop
      const [outPhoto, inPhoto] = await Promise.all([
        d.download({ bucket, path: pair.checkoutRef.path }),
        d.download({ bucket, path: pair.checkinRef.path }),
      ]);
      // eslint-disable-next-line no-await-in-loop
      const v = await d.analyze({
        checkoutBuffer: outPhoto.body,
        checkoutContentType: pair.checkoutRef.contentType || outPhoto.contentType,
        checkinBuffer: inPhoto.body,
        checkinContentType: pair.checkinRef.contentType || inPhoto.contentType,
        angle: pair.angle,
        knownDamages,
        apiKey: ctx.apiKey,
        provider: ctx.provider,
        model: ctx.model,
      });
      aiCalls += 1;
      inputTokens += v.usage?.inputTokens || 0;
      outputTokens += v.usage?.outputTokens || 0;
      costUsd += v.estimatedCostUsd || 0;

      const severity = v.verdict === 'POSSIBLE_DAMAGE' ? severityForConfidence(v.confidence) : null;
      // The scan record keeps EVERY verdict — including <40 discards and
      // known-damage matches. Annotate, never suppress.
      verdicts.push({
        angle: pair.angle,
        verdict: v.verdict,
        confidence: v.confidence,
        kind: v.kind,
        matchedKnownIds: v.matchedKnownIds,
        finding: !!severity,
      });

      // KNOWN_DAMAGE matches are free verification events (baseline NOTES
      // §D3 "Ages") — stamp lastVerifiedAt on the matched ledger entries.
      const matched = (v.matchedKnownIds || []).filter((id) => ledger.some((l) => String(l.id) === id));
      if (matched.length) {
        await db.vehicleDamageReport.updateMany({
          where: { id: { in: matched }, vehicleId: String(candidate.vehicleId) },
          data: {
            lastVerifiedAt: new Date(),
            lastVerifiedPhotoRef: slimRef(pair.checkinRef),
          },
        }).catch(() => {});
      }

      if (v.verdict === 'POSSIBLE_DAMAGE' && severity) {
        suspected += 1;
        const checkKey = `${DAMAGE_SUSPECTED_PREFIX}${pair.angle}`;
        // eslint-disable-next-line no-await-in-loop
        await db.checkinAuditFinding.upsert({
          where: { reservationId_checkKey: { reservationId: String(candidate.reservationId), checkKey } },
          update: {},
          create: {
            ...commonFindingFields(candidate),
            checkKey,
            category: 'DAMAGE',
            severity,
            tier: 'T2',
            status: 'OPEN',
            detailsJson: JSON.stringify({
              angle: pair.angle,
              view: ANGLE_TO_VIEW[pair.angle] || null,
              confidence: v.confidence,
              description: v.description,
              region: v.region,
              kind: v.kind,
              knownDamageMatched: v.matchedKnownIds,
              checkoutPhoto: slimRef(pair.checkoutRef),
              checkinPhoto: slimRef(pair.checkinRef),
              model: ctx.model || DEFAULT_T2_MODEL,
            }),
          },
        });

        if (severity === 'ERROR') {
          const angleLabel = ANGLE_LABELS[pair.angle] || pair.angle;
          // eslint-disable-next-line no-await-in-loop
          await d.emit({
            tenantId: candidate.tenantId,
            locationId: candidate.locationId || null,
            severity: 'NEEDS_ACTION',
            sourceType: 'CHECKIN_AUDIT',
            sourceRefId: String(candidate.reservationId),
            title: `Possible damage — ${candidate.reservationNumber || candidate.reservationId}${candidate.vehicleLabel ? ` · ${candidate.vehicleLabel}` : ''}. New mark suspected on the ${angleLabel} (${v.confidence}%).`,
            body: 'AI suggestion — a staff member confirms. Nothing is charged automatically.',
            deepLink: `/checkin-audit?reservationId=${candidate.reservationId}`,
            dedupeKey: `checkin-audit:${candidate.reservationId}:${checkKey}`,
            templateKey: 'checkinAuditDamage',
            paramsJson: {
              res: candidate.reservationNumber || candidate.reservationId,
              angle: angleLabel,
              conf: v.confidence,
            },
          });
        }
      }
    }

    await finishScan(db, scanId, 'ANALYZED', {
      pairsAnalyzed: pairs.length,
      missingAngles: missing,
      suspected,
      aiCalls,
      inputTokens,
      outputTokens,
      estimatedCostUsd: Number(costUsd.toFixed(6)),
      model: ctx.model || DEFAULT_T2_MODEL,
      credentialSource: ctx.credentialSource || null,
      verdicts,
    });
    logger.info('[checkin-audit-t2] check-in analyzed', {
      tenantId: candidate.tenantId,
      reservationId: candidate.reservationId,
      pairs: pairs.length,
      suspected,
      aiCalls,
    });
    return { analyzed: true, pairs: pairs.length, suspected, aiCalls };
  } catch (err) {
    await finishScan(db, scanId, 'FAILED', { error: String(err?.message || err).slice(0, 500) })
      .catch(() => {});
    logger.warn('[checkin-audit-t2] check-in analysis failed', {
      tenantId: candidate.tenantId,
      reservationId: candidate.reservationId,
      message: String(err?.message || err),
    });
    return { failed: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The sweep
// ─────────────────────────────────────────────────────────────────────────────

let timerHandle = null;
let running = false;

export function isT2KillSwitchOff() {
  return String(process.env.CHECKIN_AUDIT_T2_ENABLED ?? 'true').toLowerCase() === 'false';
}

/** Tenants whose checkinAuditConfig has photoAiEnabled=true (AppSetting rows
 *  `tenant:<id>:checkinAuditConfig`). The UNSCOPED key is ignored on purpose:
 *  photo AI has no global default — it is per-tenant opt-in only. */
async function photoAiTenants(db) {
  const rows = await db.appSetting.findMany({
    where: { key: { endsWith: ':checkinAuditConfig' } },
    select: { key: true, value: true },
  });
  const tenants = [];
  for (const row of rows) {
    const m = /^tenant:(.+):checkinAuditConfig$/.exec(row.key || '');
    if (!m) continue;
    try {
      const cfg = JSON.parse(row.value || '{}');
      if (cfg?.photoAiEnabled === true) {
        tenants.push({ tenantId: m[1], config: normalizeCheckinAuditT2Config(cfg) });
      }
    } catch { /* unparseable config reads as OFF — fail closed */ }
  }
  return tenants;
}

/** One sweep, synchronously awaitable (exported for tests). */
export async function runT2SweepOnce(deps = {}) {
  if (running && !deps.db) return null;
  const d = { ...defaultDeps(), ...deps };
  if (isT2KillSwitchOff()) return null;
  if (!d.storageEnabled()) return null;
  running = true;
  try {
    const db = d.db;
    const tenants = await photoAiTenants(db);
    if (!tenants.length) return { tenants: 0 };

    const now = deps.now ? new Date(deps.now) : new Date();
    const lookback = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const summary = { tenants: tenants.length, analyzed: 0, skippedBudget: 0, skippedNoPhotos: 0, failed: 0, waitingOnCredential: 0 };

    for (const t of tenants) {
      // Credential gate — feature 'checkin-audit', the T1 comments' promise.
      // NONE → no provider call, closes stay pending until a key exists
      // (citation-ocr posture: nothing lost, loudly logged below).
      // eslint-disable-next-line no-await-in-loop
      const cred = await d.resolveCredential({ tenantId: t.tenantId }).catch(() => null);
      const apiKey = cred?.credential?.source === 'NONE' ? null : (cred?.credential?.credential || null);
      if (!apiKey) {
        summary.waitingOnCredential += 1;
        logger.warn('[checkin-audit-t2] tenant has photo AI ON but no credential it may use — no provider call was made, closes stay pending', {
          tenantId: t.tenantId,
          action: 'Add the tenant’s own Anthropic key in Settings, or opt it in to the platform key deliberately.',
        });
        continue;
      }
      const model = t.config.photoAiModel || cred?.model || DEFAULT_T2_MODEL;

      // Budget: model-call-bearing scans already made today (ANALYZING /
      // ANALYZED / FAILED all count — a failed scan may have called out).
      // eslint-disable-next-line no-await-in-loop
      let usedToday = await db.checkinAuditFinding.count({
        where: {
          tenantId: t.tenantId,
          checkKey: T2_SCAN_CHECK_KEY,
          createdAt: { gte: dayStart },
          resolution: { notIn: ['SKIPPED_BUDGET', 'SKIPPED_NO_PHOTOS'] },
        },
      });

      // Closes missing a T2 verdict: audited reservations (T1 rows) in the
      // lookback window with no T2_SCAN row yet.
      // eslint-disable-next-line no-await-in-loop
      const audited = await db.checkinAuditFinding.findMany({
        where: { tenantId: t.tenantId, tier: 'T1', createdAt: { gte: lookback } },
        orderBy: { createdAt: 'asc' },
        distinct: ['reservationId'],
        select: {
          tenantId: true, reservationId: true, rentalAgreementId: true, vehicleId: true,
          locationId: true, reservationNumber: true, vehicleLabel: true,
          closedByUserId: true, closedByName: true, returnedAt: true,
        },
      });
      if (!audited.length) continue;
      // eslint-disable-next-line no-await-in-loop
      const scanned = await db.checkinAuditFinding.findMany({
        where: {
          tenantId: t.tenantId,
          checkKey: T2_SCAN_CHECK_KEY,
          reservationId: { in: audited.map((a) => a.reservationId) },
        },
        select: { reservationId: true },
      });
      const done = new Set(scanned.map((s) => s.reservationId));
      const pending = audited.filter((a) => !done.has(a.reservationId)).slice(0, BATCH);

      for (const candidate of pending) {
        const overBudget = usedToday >= t.config.dailyPhotoBudget;
        // Atomic claim: create the T2_SCAN row. The unique
        // (reservationId, checkKey) makes a concurrent duplicate impossible —
        // one verdict per close, ever.
        let scan = null;
        try {
          // eslint-disable-next-line no-await-in-loop
          scan = await db.checkinAuditFinding.create({
            data: {
              ...commonFindingFields(candidate),
              checkKey: T2_SCAN_CHECK_KEY,
              category: 'PASS',
              severity: 'NONE',
              tier: 'T2',
              status: 'RESOLVED',
              resolution: overBudget ? 'SKIPPED_BUDGET' : 'ANALYZING',
              detailsJson: overBudget
                ? JSON.stringify({ reason: 'daily photo budget reached', budget: t.config.dailyPhotoBudget })
                : null,
            },
          });
        } catch {
          continue; // already claimed elsewhere — idempotence in action
        }
        if (overBudget) {
          summary.skippedBudget += 1;
          continue;
        }
        usedToday += 1;
        // eslint-disable-next-line no-await-in-loop
        const r = await runT2ForReservationSafe(candidate, {
          scanId: scan.id,
          apiKey,
          provider: cred?.provider || 'anthropic',
          model,
          credentialSource: cred?.credential?.source || null,
        }, d);
        if (r?.analyzed) summary.analyzed += 1;
        else if (r?.skipped) summary.skippedNoPhotos += 1;
        else if (r?.failed) summary.failed += 1;
      }
    }

    if (summary.analyzed || summary.failed || summary.skippedBudget || summary.skippedNoPhotos) {
      logger.info('[checkin-audit-t2] sweep done', summary);
    }
    return summary;
  } catch (err) {
    logger.warn('[checkin-audit-t2] sweep failed', { message: String(err?.message || err) });
    return null;
  } finally {
    running = false;
  }
}

export function startCheckinAuditT2Scheduler() {
  if (timerHandle) return;
  if (isT2KillSwitchOff()) {
    logger.info('[checkin-audit-t2] disabled via CHECKIN_AUDIT_T2_ENABLED=false — scheduler idle');
    return;
  }
  if (!isStorageEnabled()) {
    logger.info('[checkin-audit-t2] inspection-photo storage disabled — scheduler idle');
    return;
  }
  setTimeout(() => { runT2SweepOnce().catch(() => {}); }, 60 * 1000);
  timerHandle = setInterval(() => { runT2SweepOnce().catch(() => {}); }, INTERVAL_MS);
  logger.info('[checkin-audit-t2] started', { intervalMs: INTERVAL_MS, batch: BATCH, lookbackDays: LOOKBACK_DAYS });
}

export function stopCheckinAuditT2Scheduler() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}
