import { Router } from 'express';
import { smsService } from './sms.service.js';
import { isSuperAdmin } from '../../middleware/auth.js';

export const smsRouter = Router();

function tenantIdFor(req) {
  if (isSuperAdmin(req.user)) return req.query?.tenantId ? String(req.query.tenantId) : (req.user?.tenantId || null);
  return req.user?.tenantId || null;
}

// Get SMS config status
smsRouter.get('/config', async (req, res, next) => {
  try {
    res.json(await smsService.getConfig({ tenantId: tenantIdFor(req) }));
  } catch (e) { next(e); }
});

// Get available templates
smsRouter.get('/templates', async (req, res) => {
  res.json(smsService.getTemplates());
});

// Send SMS for a reservation
smsRouter.post('/send', async (req, res, next) => {
  try {
    const { reservationId, templateId, customBody } = req.body || {};
    if (!reservationId) return res.status(400).json({ error: 'reservationId is required' });
    res.json(await smsService.sendForReservation({
      reservationId,
      templateId,
      customBody,
      tenantId: tenantIdFor(req),
    }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Send custom SMS
smsRouter.post('/send-custom', async (req, res, next) => {
  try {
    const { to, body } = req.body || {};
    if (!to || !body) return res.status(400).json({ error: 'to and body are required' });
    res.json(await smsService.sendCustom({
      to,
      body,
      tenantId: tenantIdFor(req),
    }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
