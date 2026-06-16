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
import { scopeFor } from '../../lib/tenant-scope.js';
import { citationsService } from './citations.service.js';
import { affidavitPdfBuffer } from './citations-affidavit.service.js';

export const citationsRouter = Router();
export const citationsInternalRouter = Router();

function handle(err, res) {
  const status = err?.status || (/required|invalid|must be/i.test(String(err?.message || '')) ? 400 : 500);
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
citationsRouter.post('/documents', async (req, res) => {
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

// Staff manual entry / OCR upload result — scoped to the caller's tenant.
citationsRouter.post('/manual-import', async (req, res) => {
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
