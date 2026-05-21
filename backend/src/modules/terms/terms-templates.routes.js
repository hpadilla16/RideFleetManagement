/**
 * TermsTemplate admin routes (2026-05-21).
 *
 * Mounted in main.js as:
 *   app.use('/api/admin/terms-templates',
 *           requireAuth, requireRole('SUPER_ADMIN','ADMIN'),
 *           termsTemplatesRouter);
 *
 * Tenant admins can edit their OWN templates (tenantId from req.user.tenantId).
 * SUPER_ADMIN can target any tenant via ?tenantId= or body.tenantId.
 *
 * Endpoints:
 *   GET    /api/admin/terms-templates
 *   GET    /api/admin/terms-templates/:id
 *   POST   /api/admin/terms-templates
 *   PUT    /api/admin/terms-templates/:id
 *   POST   /api/admin/terms-templates/:id/activate
 *   DELETE /api/admin/terms-templates/:id
 *
 * Spec: doc/interactive-tc-and-dejavoo-unified-2026-05-21.md §8
 */

import { Router } from 'express';
import { isSuperAdmin } from '../../middleware/auth.js';
import {
  listTemplatesForTenant,
  getTemplateById,
  createTemplate,
  updateTemplate,
  activateTemplate,
  deleteTemplate,
  TermsTemplateError,
} from './terms-templates.service.js';

export const termsTemplatesRouter = Router();

function resolveTenantId(req) {
  if (isSuperAdmin(req.user)) {
    return req.query?.tenantId || req.body?.tenantId || req.user?.tenantId || null;
  }
  return req.user?.tenantId || null;
}

function sendError(res, err) {
  if (err instanceof TermsTemplateError) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  return res.status(500).json({ error: err?.message || 'Internal server error' });
}

termsTemplatesRouter.get('/', async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(403).json({ error: 'tenantId required' });
    res.json(await listTemplatesForTenant({ tenantId }));
  } catch (err) {
    sendError(res, err);
  }
});

termsTemplatesRouter.get('/:id', async (req, res) => {
  try {
    const tenantId = isSuperAdmin(req.user) ? null : resolveTenantId(req);
    res.json(await getTemplateById({ id: req.params.id, tenantId }));
  } catch (err) {
    sendError(res, err);
  }
});

termsTemplatesRouter.post('/', async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(403).json({ error: 'tenantId required' });
    const body = req.body || {};
    const created = await createTemplate({
      tenantId,
      name: body.name,
      version: body.version,
      contentHtml: body.contentHtml,
      contentLanguage: body.contentLanguage,
      effectiveDate: body.effectiveDate,
      fields: body.fields || [],
      createdByUserId: req.user?.sub || req.user?.id || null,
    });
    res.status(201).json(created);
  } catch (err) {
    sendError(res, err);
  }
});

termsTemplatesRouter.put('/:id', async (req, res) => {
  try {
    const tenantId = isSuperAdmin(req.user) ? null : resolveTenantId(req);
    const body = req.body || {};
    res.json(
      await updateTemplate({
        id: req.params.id,
        tenantId,
        name: body.name,
        contentHtml: body.contentHtml,
        contentLanguage: body.contentLanguage,
        effectiveDate: body.effectiveDate,
        fields: body.fields,
      })
    );
  } catch (err) {
    sendError(res, err);
  }
});

termsTemplatesRouter.post('/:id/activate', async (req, res) => {
  try {
    const tenantId = isSuperAdmin(req.user) ? null : resolveTenantId(req);
    res.json(await activateTemplate({ id: req.params.id, tenantId }));
  } catch (err) {
    sendError(res, err);
  }
});

termsTemplatesRouter.delete('/:id', async (req, res) => {
  try {
    const tenantId = isSuperAdmin(req.user) ? null : resolveTenantId(req);
    res.json(await deleteTemplate({ id: req.params.id, tenantId }));
  } catch (err) {
    sendError(res, err);
  }
});
