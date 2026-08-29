/**
 * citation-ocr.scheduler — Fase B worker. Picks up CitationDocument(PENDING),
 * runs the vision-LLM extractor with the TENANT'S OWN AI credentials (from
 * Settings), and feeds the fields into the existing ingestBatch (source
 * MAIL_OCR) so plate→vehicle→reservation matching runs. No money, no scraping.
 * Plan: doc/citations-ocr-mail-intake-plan-2026-06-15.md
 *
 * Gating: runs when storage is enabled; per tenant it only processes docs if
 * that tenant has citationsEnabled AND a credential it is ENTITLED to use —
 * its own key, or the platform key when that tenant has been deliberately
 * opted in (see lib/tenant-provider-credential.js). A tenant that configured
 * nothing is skipped and its documents stay PENDING; the platform key is NOT
 * a fallback here any more. That sentence used to read the other way round,
 * and it is why Corpusa's citations reached api.anthropic.com (2026-08-27).
 * PII: never logs OCR JSON or document contents — counts/ids only.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { downloadObject } from '../../lib/storage/index.js';
import { isStorageEnabled } from '../rental-agreements/inspection-photos.js';
import { citationsService } from './citations.service.js';
import { settingsService } from '../settings/settings.service.js';
import { extractCitationFields } from './citation-ocr.extract.js';

const INTERVAL_MS = Math.max(60 * 1000, parseInt(process.env.CITATION_OCR_INTERVAL_MS || String(5 * 60 * 1000), 10) || 5 * 60 * 1000);
const BATCH = Math.max(1, Math.min(parseInt(process.env.CITATION_OCR_BATCH || '5', 10) || 5, 25));
const CONF_THRESHOLD = Number(process.env.CITATION_OCR_CONFIDENCE_MIN || 70);

let timerHandle = null;
let running = false;

function parseRef(ref) {
  const s = String(ref || '');
  const idx = s.indexOf(':');
  if (idx <= 0) return null;
  return { bucket: s.slice(0, idx), path: s.slice(idx + 1) };
}

async function processDoc(doc, cfg) {
  // Atomic claim so two ticks never grab the same doc.
  const claimed = await prisma.citationDocument.updateMany({
    where: { id: doc.id, status: 'PENDING' },
    data: { status: 'EXTRACTING' },
  });
  if (claimed.count === 0) return null;

  try {
    const ref = parseRef(doc.bucketPath);
    if (!ref) throw new Error('bad bucketPath');
    const { body, contentType } = await downloadObject(ref);
    const result = await extractCitationFields({
      buffer: body,
      contentType: doc.contentType || contentType,
      apiKey: cfg.apiKey,
      provider: cfg.provider,
      model: cfg.model,
    });
    const confidence = result.confidence;

    if (!result.citations.length) {
      await prisma.citationDocument.update({
        where: { id: doc.id },
        data: { status: 'REVIEW', confidence: confidence ?? null, error: 'no citations extracted', ocrJson: null },
      });
      return { extracted: 0 };
    }

    const rows = result.citations.map((c) => ({
      citationNo: c.citationNo,
      plate: c.plate,
      plateState: c.plateState,
      agency: c.agency || 'Mailed notice',
      violationType: c.violationType,
      issuedAt: c.issuedAt,
      dueAt: c.dueAt,
      amount: c.amount,
      fee: c.fee,
      location: c.location,
      externalUrl: c.paymentUrl || null,
      documentPath: doc.bucketPath,
      raw: { source: 'MAIL_OCR', docId: doc.id, paymentFields: c.paymentFields || [], paymentPhone: c.paymentPhone || null },
    }));

    await citationsService.ingestBatch({
      tenantId: doc.tenantId,
      source: 'MAIL_OCR',
      sourceType: 'OCR',
      rows,
    });

    const threshold = Number.isFinite(cfg?.threshold) ? cfg.threshold : CONF_THRESHOLD;
    const lowConfidence = confidence != null && confidence < threshold;
    const created = await prisma.citation.findMany({
      where: { tenantId: doc.tenantId, source: 'MAIL_OCR', citationNo: { in: rows.map((r) => r.citationNo) } },
      select: { id: true },
    });
    if (lowConfidence && created.length) {
      await prisma.citation.updateMany({
        where: { id: { in: created.map((c) => c.id) }, status: { notIn: ['BILLED', 'DISPUTED', 'VOID', 'CLOSED'] } },
        data: { status: 'NEEDS_REVIEW', needsReview: true },
      });
    }

    await prisma.citationDocument.update({
      where: { id: doc.id },
      data: {
        status: lowConfidence ? 'REVIEW' : 'INGESTED',
        confidence: confidence ?? null,
        citationId: created[0]?.id || null,
        error: null,
        ocrJson: JSON.stringify(result.citations).slice(0, 20000),
      },
    });
    return { extracted: rows.length, lowConfidence };
  } catch (err) {
    await prisma.citationDocument.update({
      where: { id: doc.id },
      data: { status: 'FAILED', error: String(err?.message || err).slice(0, 500) },
    }).catch(() => {});
    logger.warn('[citation-ocr] doc failed', { docId: doc.id, message: String(err?.message || err) });
    return { failed: true };
  }
}

/** Exported for tests: one sweep, synchronously awaitable. */
export async function runOnce() {
  if (running) return;
  if (!isStorageEnabled()) return;
  running = true;
  try {
    const tenants = await prisma.tenant.findMany({ where: { citationsEnabled: true }, select: { id: true } });
    let ok = 0; let review = 0; let failed = 0; let processed = 0;
    const skippedTenantIds = [];
    for (const t of tenants) {
      // 2026-08-27. This loop is where the Corpusa incident happened: it
      // selects EVERY tenant with citationsEnabled and used to finish with
      // `cfg.apiKey || process.env.ANTHROPIC_API_KEY`, so a tenant that had
      // configured nothing had its citation documents — driver name, licence
      // details, vehicle, location — sent to the provider under the PLATFORM
      // account, silently, on a timer. A scheduler is the worst possible place
      // for an implicit fallback: there is no request, no user and no response
      // for anyone to notice it in.
      //
      // eslint-disable-next-line no-await-in-loop
      const cfg = await settingsService
        .resolveCitationOcrCredential({ tenantId: t.id }, { feature: 'citation-ocr' })
        .catch(() => null);
      const apiKey = cfg?.credential?.source === 'NONE' ? null : (cfg?.credential?.credential || null);
      if (!apiKey) {
        // No credential this tenant is entitled to use → no provider call, and
        // its documents stay PENDING (not FAILED): nothing is lost, and they
        // process on the next sweep the moment a key is configured.
        skippedTenantIds.push(t.id);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const docs = await prisma.citationDocument.findMany({
        where: { status: 'PENDING', tenantId: t.id },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
        select: { id: true, tenantId: true, bucketPath: true, contentType: true },
      });
      for (const doc of docs) {
        processed += 1;
        // eslint-disable-next-line no-await-in-loop
        const r = await processDoc(doc, { apiKey, provider: cfg.provider, model: cfg.model, threshold: cfg.confidenceMin });
        if (!r) continue;
        if (r.failed) failed += 1;
        else if (r.lowConfidence || r.extracted === 0) review += 1;
        else ok += 1;
      }
    }
    if (processed) logger.info('[citation-ocr] batch done', { processed, ingested: ok, review, failed });

    // Make the fail-closed state VISIBLE. A tenant with no credential is meant
    // to process nothing — but silence is exactly what hid the original bug, so
    // a tenant whose documents are piling up unread gets named every sweep.
    // One grouped count for all skipped tenants, not one query each.
    if (skippedTenantIds.length) {
      const waiting = await prisma.citationDocument.groupBy({
        by: ['tenantId'],
        where: { status: 'PENDING', tenantId: { in: skippedTenantIds } },
        _count: { _all: true },
      }).catch(() => []);
      const backlog = waiting.filter((w) => (w?._count?._all || 0) > 0);
      if (backlog.length) {
        logger.warn('[citation-ocr] documents are WAITING for tenants with no OCR credential — no provider call was made', {
          tenants: backlog.map((w) => ({ tenantId: w.tenantId, pending: w._count._all })),
          action: 'Add that tenant’s own Anthropic key in Settings → Citations → OCR, or opt them in to the platform key deliberately.',
        });
      }
    }
  } catch (err) {
    logger.warn('[citation-ocr] sweep failed', { message: String(err?.message || err) });
  } finally {
    running = false;
  }
}

export function startCitationOcrScheduler() {
  if (timerHandle) return;
  if (!isStorageEnabled()) {
    logger.info('[citation-ocr] storage disabled — scheduler idle');
    return;
  }
  setTimeout(() => { runOnce().catch(() => {}); }, 45 * 1000);
  timerHandle = setInterval(() => { runOnce().catch(() => {}); }, INTERVAL_MS);
  logger.info('[citation-ocr] started', { intervalMs: INTERVAL_MS, batch: BATCH });
}

export function stopCitationOcrScheduler() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}
