/**
 * citation-ocr.scheduler — Fase B worker. Picks up CitationDocument(PENDING),
 * runs the vision-LLM extractor with the TENANT'S OWN AI credentials (from
 * Settings; env ANTHROPIC_API_KEY is a fallback), and feeds the fields into the
 * existing ingestBatch (source MAIL_OCR) so plate→vehicle→reservation matching
 * runs. No money, no scraping. Plan: doc/citations-ocr-mail-intake-plan-2026-06-15.md
 *
 * Gating: runs when storage is enabled; per tenant it only processes docs if that
 * tenant has citationsEnabled AND a resolvable AI key (tenant Settings or env).
 * Tenants without a key are skipped (their docs stay PENDING until a key is set).
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
      raw: { source: 'MAIL_OCR', docId: doc.id },
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
        where: { id: { in: created.map((c) => c.id) }, status: { notIn: ['BILLED', 'DISPUTED', 'VOID'] } },
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

async function runOnce() {
  if (running) return;
  if (!isStorageEnabled()) return;
  running = true;
  try {
    const tenants = await prisma.tenant.findMany({ where: { citationsEnabled: true }, select: { id: true } });
    let ok = 0; let review = 0; let failed = 0; let processed = 0;
    for (const t of tenants) {
      // eslint-disable-next-line no-await-in-loop
      const cfg = await settingsService.getCitationOcrResolved({ tenantId: t.id }).catch(() => ({ apiKey: null }));
      const apiKey = cfg.apiKey || process.env.ANTHROPIC_API_KEY || null;
      if (!apiKey) continue; // no key for this tenant → leave its docs PENDING
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
