import { Router } from 'express';
import { knowledgeBaseService } from './knowledge-base.service.js';
import { isSuperAdmin } from '../../middleware/auth.js';

export const knowledgeBaseRouter = Router();

function scopeFor(req) {
  if (isSuperAdmin(req.user)) return req.query?.tenantId ? { tenantId: String(req.query.tenantId) } : {};
  return { tenantId: req.user?.tenantId || null };
}

// List categories
knowledgeBaseRouter.get('/categories', (req, res) => {
  res.json(knowledgeBaseService.getCategories());
});

// List articles (search, filter by category)
knowledgeBaseRouter.get('/', async (req, res, next) => {
  try {
    res.json(await knowledgeBaseService.list({
      ...scopeFor(req),
      category: req.query?.category ? String(req.query.category) : undefined,
      status: req.query?.status ? String(req.query.status) : 'PUBLISHED',
      search: req.query?.q ? String(req.query.q) : undefined,
      page: req.query?.page,
      limit: req.query?.limit,
    }));
  } catch (e) { next(e); }
});

// Get single article by slug
knowledgeBaseRouter.get('/article/:slug', async (req, res, next) => {
  try {
    res.json(await knowledgeBaseService.getBySlug(req.params.slug, scopeFor(req)));
  } catch (e) {
    if (/not found/i.test(e?.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// Create article (admin only)
knowledgeBaseRouter.post('/', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    res.status(201).json(await knowledgeBaseService.create(req.body || {}, {
      tenantId: scope.tenantId || null,
      userId: req.user?.id || req.user?.sub || null,
    }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Update article
knowledgeBaseRouter.patch('/:id', async (req, res, next) => {
  try {
    res.json(await knowledgeBaseService.update(req.params.id, req.body || {}, scopeFor(req)));
  } catch (e) {
    if (/not found/i.test(e?.message)) return res.status(404).json({ error: e.message });
    res.status(400).json({ error: e.message });
  }
});

// Delete article
knowledgeBaseRouter.delete('/:id', async (req, res, next) => {
  try {
    res.json(await knowledgeBaseService.delete(req.params.id, scopeFor(req)));
  } catch (e) {
    if (/not found/i.test(e?.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// Mark article as helpful
knowledgeBaseRouter.post('/:id/helpful', async (req, res, next) => {
  try {
    res.json(await knowledgeBaseService.markHelpful(req.params.id));
  } catch (e) { next(e); }
});

// Seed default articles
knowledgeBaseRouter.post('/seed', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    res.json(await knowledgeBaseService.seedDefaults({
      tenantId: scope.tenantId || null,
      userId: req.user?.id || req.user?.sub || null,
    }));
  } catch (e) { next(e); }
});
