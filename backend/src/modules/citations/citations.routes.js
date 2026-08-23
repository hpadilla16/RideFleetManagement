// Citations module — routes.
// Plan: doc/citations-tolls-fase-a-spec-2026-06-12.md
//
//   Authed (ADMIN/OPS, tenant-scoped):
//     GET    /api/citations                 (list + filters)
//     GET    /api/citations/:id             (detail)
//     POST   /api/citations/:id/review      (CONFIRM|REJECT|DISPUTE|VOID)
//     POST   /api/citations/manual-import   (staff manual rows)
//     GET    /api/citations/vehicle/:vehicleId
//
//   Internal (droplet scraper push, shared secret):
//     POST   /api/internal/citations/ingest
//     GET    /api/internal/citations/plates?tenantId=   (active plate list)
//
// Billing/charge posting is NOT here — that is Phase E (money-gated).

import { Router } from 'express';
import { scopeFor, userAllowedLocationIds } from '../../lib/tenant-scope.js';
import { citationsService } from './citations.service.js';
import { affidavitPdfBuffer } from './citations-affidavit.service.js';

export const citationsRouter = Router();
export const citationsInternalRouter = Router();

function handle(err, res) {
  // Malformed input reaches Prisma as a known client error — map to a GENERIC
  // 400 and NEVER echo its message (DAST 2026-08-23: a null byte leaked a raw
  // Prisma ConnectorError here because its "...invalid byte sequence..." text
  // matched the /invalid/ heuristic below). Deliberate app 4xx keep their
  // message; unknown/Prisma errors stay opaque.
  const code = err?.code;
  if (err?.name === 'PrismaClientValidationError' || code === 'P2023' || code === 'P2009' || code === 'P2000') {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const isPrisma = typeof err?.name === 'string' && err.name.startsWith('Prisma');
  const status = err?.status || (!isPrisma && /required|invalid|must be/i.test(String(err?.message || '')) ? 400 : 500);
  if (status >= 500) return res.status(500).json({ error: 'Internal error' });
  return res.status(status).json({ error: err.message });
}

// ── Authed routes ──────────────────────────────────────────────────────────
citationsRouter.get('/', async (req, res) => {
  try {
    res.json(await citationsService.list(req.query || {}, scopeFor(req)));
  } catch (err) {
    handle(err, res);
  }
});

citationsRouter.get('/vehicle/:vehicleId', async (req, res) => {
  try {
    res.json(await citationsService.getVehicleHistory(req.params.vehicleId, scopeFor(req)));
  } catch (err) {
    handle(err, res);
  }
});

// Dashboard tile summary — registered before GET /:id so "summary" isn't an :id.
citationsRouter.get('/summary', async (req, res) => {
  try {
    res.json(await citationsService.dashboardSummary(scopeFor(req)));
  } catch (err) {
    handle(err, res);
  }
});

// ── OCR mail intake — Fase A document plumbing (authed, tenant-scoped) ──────
// Registered BEFORE GET /:id so "/documents" isn't captured as an :id. Upload a
// scanned/emailed notice (base64 data URL) → Supabase + CitationDocument(PENDING)
// for the Fase B OCR worker. No money, no matching here.
// Gated for the SAME reason as /manual-import, which it feeds: the OCR worker
// hands every uploaded notice to `ingestBatch` (citation-ocr.scheduler.js:80),
// which posts money tenant-wide. Gating the manual door and leaving this one
// open would read as covered while the async half of the money path stayed
// open. It also removes a black hole: a scoped user's upload lands with
// citationId = null, which the scoped document reads below exclude, so they
// used to get a 201 for a document they could then never see, retry or
// download. An explicit 403 is the honest answer.
citationsRouter.post('/documents', rejectLocationScopedUsers, async (req, res) => {
  try {
    const scope = scopeFor(req);
    const doc = await citationsService.saveDocument({
      tenantId: scope.tenantId,
      dataUrl: req.body?.dataUrl,
      sourceChannel: req.body?.sourceChannel,
      uploadedByUserId: req.user?.sub || null,
    });
    res.status(201).json(doc);
  } catch (err) {
    handle(err, res);
  }
});

citationsRouter.get('/documents', async (req, res) => {
  try {
    res.json(await citationsService.listDocuments(scopeFor(req), req.query || {}));
  } catch (err) {
    handle(err, res);
  }
});

citationsRouter.get('/documents/:id/download', async (req, res) => {
  try {
    res.json(await citationsService.getDocumentSignedUrl(req.params.id, scopeFor(req)));
  } catch (err) {
    handle(err, res);
  }
});

// Retry a FAILED/REVIEW notice document — resets it to PENDING for the OCR worker.
citationsRouter.post('/documents/:id/retry', async (req, res) => {
  try {
    res.json(await citationsService.retryDocument(req.params.id, scopeFor(req)));
  } catch (err) {
    handle(err, res);
  }
});

citationsRouter.get('/:id', async (req, res) => {
  try {
    res.json(await citationsService.getDetail(req.params.id, scopeFor(req)));
  } catch (err) {
    handle(err, res);
  }
});

// Signed URL to view the scanned notice behind a citation (from its documentPath).
citationsRouter.get('/:id/document', async (req, res) => {
  try {
    res.json(await citationsService.getDocumentUrl(req.params.id, scopeFor(req)));
  } catch (err) {
    handle(err, res);
  }
});

// Affidavit of Transfer of Liability (PDF) — Fase D #4. NOT money. Streams a printable,
// notarizable affidavit with the renter's identifying info (name/address/DOB/DL#) for the
// owner to submit to the issuing authority. 400 if the citation has no matched renter.
citationsRouter.get('/:id/affidavit/pdf', async (req, res) => {
  try {
    const { buffer, citationNo } = await affidavitPdfBuffer(req.params.id, scopeFor(req));
    const safeNo = String(citationNo || 'citation').replace(/[^A-Za-z0-9_-]+/g, '-');
    const filename = `Affidavit-${safeNo}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.byteLength);
    res.end(buffer);
  } catch (err) {
    handle(err, res);
  }
});

citationsRouter.post('/:id/review', async (req, res) => {
  try {
    const { decision, note } = req.body || {};
    res.json(await citationsService.review(req.params.id, { decision, note, userId: req.user?.id }, scopeFor(req)));
  } catch (err) {
    handle(err, res);
  }
});

/**
 * Location scoping (2026-07-24). Exact twin of `rejectLocationScopedUsers` in
 * tolls.routes.js, gating the same class of operation for the same reason:
 * `ingestBatch` builds a TENANT-WIDE plate map and auto-posts money
 * (syncCitationCharges, "Fase D") onto matched reservations at ANY branch. A
 * location-restricted caller importing here creates charges across the whole
 * tenant and then cannot see what they created — the citation list, detail,
 * documents and affidavit are all location-scoped.
 *
 * Guards BOTH intake doors: POST /manual-import (the synchronous one) and
 * POST /documents (the asynchronous one — the OCR worker feeds every uploaded
 * notice to the same `ingestBatch`). Gating only the first would leave the money
 * path open through the second while looking closed.
 *
 * Matching is deliberately tenant-wide (the plate map ignores location so an
 * import yields the same result whoever runs it), so this cannot be narrowed to
 * a branch — it is refused instead.
 */
function rejectLocationScopedUsers(req, res, next) {
  if (userAllowedLocationIds(req.user)) {
    return res.status(403).json({
      error: 'Citation intake is a tenant-wide operation and is not available for location-restricted accounts',
    });
  }
  next();
}

// Staff manual entry / OCR upload result — scoped to the caller's tenant.
citationsRouter.post('/manual-import', rejectLocationScopedUsers, async (req, res) => {
  try {
    const scope = scopeFor(req);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const result = await citationsService.ingestBatch({
      tenantId: scope.tenantId,
      source: req.body?.source || 'MANUAL',
      sourceType: 'MANUAL_IMPORT',
      rows,
    });
    res.status(201).json(result);
  } catch (err) {
    handle(err, res);
  }
});

// ── Internal ingest (droplet) ────────────────────────────────────────────────
function requireInternalToken(req, res, next) {
  const expected = process.env.BACKEND_INTERNAL_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Internal endpoints disabled (no BACKEND_INTERNAL_TOKEN)' });
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got !== expected) return res.status(401).json({ error: 'Invalid internal token' });
  next();
}

// Active plate list for the droplet adapters — keeps the scraper's search set in
// sync with the live fleet (no hand-seeded file). Two modes:
//   ?source=CITATION_PROCESSING_CENTER  → ALL tenants that have an active source
//        account for that source (plug-and-play across tenants/locations). Returns
//        { source, tenantCount, tenants:[{tenantId,count,plates:[{plate,state}]}] }.
//   ?tenantId=<id>                      → single tenant (pilot / manual).
//        Returns { tenantId, count, plates:[{plate,state}] }.
// State per plate comes from the vehicle's home location (not hardcoded).
citationsInternalRouter.get('/plates', requireInternalToken, async (req, res) => {
  try {
    const source = String(req.query?.source || '').trim();
    const tenantId = String(req.query?.tenantId || '').trim();
    if (source) {
      return res.json(await citationsService.listPlatesForSource(source));
    }
    if (tenantId) {
      // Single-tenant path respects the settings toggle (citationsEnabled).
      const plates = await citationsService.listActivePlates(tenantId, { requireEnabled: true });
      return res.json({ tenantId, count: plates.length, plates });
    }
    return res.status(400).json({ error: 'source or tenantId required' });
  } catch (err) {
    handle(err, res);
  }
});

// Body: { tenantId, source, sourceAccountId?, sourceType?, rows: [...] }
citationsInternalRouter.post('/ingest', requireInternalToken, async (req, res) => {
  try {
    const { tenantId, source, sourceAccountId, sourceType, rows } = req.body || {};
    const result = await citationsService.ingestBatch({
      tenantId,
      source,
      sourceAccountId: sourceAccountId || null,
      sourceType: sourceType || 'DROPLET_SCRAPE',
      rows: Array.isArray(rows) ? rows : [],
    });
    res.json(result);
  } catch (err) {
    handle(err, res);
  }
});
