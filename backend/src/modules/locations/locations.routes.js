import { Router } from 'express';
import { locationsService } from './locations.service.js';
import { scopeFor } from '../../lib/tenant-scope.js';
import { locationDocumentsService } from './location-documents.service.js';

export const locationsRouter = Router();

locationsRouter.get('/', async (_req, res, next) => {
  try { res.json(await locationsService.list(scopeFor(_req))); } catch (e) { next(e); }
});

locationsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await locationsService.getById(req.params.id, scopeFor(req));
    if (!row) return res.status(404).json({ error: 'Location not found' });
    res.json(row);
  } catch (e) { next(e); }
});

locationsRouter.post('/', async (req, res, next) => {
  try {
    const required = ['code', 'name'];
    const missing = required.filter((k) => !req.body?.[k]);
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    const row = await locationsService.create(req.body, scopeFor(req));
    res.status(201).json(row);
  } catch (e) {
    if (e?.code === 'P2002') return res.status(409).json({ error: 'A location with that code already exists in this tenant' });
    next(e);
  }
});

locationsRouter.patch('/:id', async (req, res, next) => {
  try { res.json(await locationsService.update(req.params.id, req.body || {}, scopeFor(req))); }
  catch (e) {
    if (e?.code === 'P2002') return res.status(409).json({ error: 'A location with that code already exists in this tenant' });
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Location not found' });
    next(e);
  }
});

locationsRouter.delete('/:id', async (req, res) => {
  try { await locationsService.remove(req.params.id, scopeFor(req)); res.status(204).send(); }
  catch { res.status(404).json({ error: 'Location not found' }); }
});


// ---------------------------------------------------------------------------
// Business documents (2026-07-28): the paperwork a branch needs to trade —
// permits, registrations, insurance, licences — with the date each stops being
// valid so the operator is warned before one lapses.
//
// Location scoping is enforced inside the service and is fail-closed: a user
// restricted to some branches gets 404 (not 403) for a branch outside their
// scope, so the API never confirms that a branch they cannot see exists.
//
// NOTE ordering: /documents/expiring must be declared BEFORE /:id/documents,
// otherwise Express would match "expiring" as a location id.
// ---------------------------------------------------------------------------
function docError(res, e, next) {
  if (e && Number.isInteger(e.statusCode)) return res.status(e.statusCode).json({ error: e.message });
  return next(e);
}

// Dashboard feed: what is expiring soon or already lapsed, across the branches
// this user can see.
locationsRouter.get('/documents/expiring', async (req, res, next) => {
  try {
    res.json(await locationDocumentsService.expiringSoon(req.user, { days: req.query.days }));
  } catch (e) { docError(res, e, next); }
});

// Short-lived signed URL — the file is never served from a permanent link.
locationsRouter.get('/documents/:docId/url', async (req, res, next) => {
  try { res.json(await locationDocumentsService.signedUrl(req.user, req.params.docId)); }
  catch (e) { docError(res, e, next); }
});

locationsRouter.patch('/documents/:docId', async (req, res, next) => {
  try { res.json(await locationDocumentsService.update(req.user, req.params.docId, req.body || {})); }
  catch (e) { docError(res, e, next); }
});

// Archive, never hard-delete: an audit may still need to see what was on file
// on a given date.
locationsRouter.delete('/documents/:docId', async (req, res, next) => {
  try { res.json(await locationDocumentsService.archive(req.user, req.params.docId)); }
  catch (e) { docError(res, e, next); }
});

locationsRouter.get('/:id/documents', async (req, res, next) => {
  try {
    res.json(await locationDocumentsService.list(req.user, req.params.id, {
      includeArchived: String(req.query.includeArchived || '') === 'true',
    }));
  } catch (e) { docError(res, e, next); }
});

locationsRouter.post('/:id/documents', async (req, res, next) => {
  try { res.status(201).json(await locationDocumentsService.upload(req.user, req.params.id, req.body || {})); }
  catch (e) { docError(res, e, next); }
});
