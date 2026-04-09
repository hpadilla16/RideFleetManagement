import { Router } from 'express';
import { messagingService } from './messaging.service.js';

/**
 * Host messaging routes — mounted under /api/host-app/messages
 * Requires auth + host context.
 */
export const hostMessagingRouter = Router();

hostMessagingRouter.get('/', async (req, res, next) => {
  try {
    const hostProfileId = req.hostProfileId;
    if (!hostProfileId) return res.status(403).json({ error: 'Host profile not found' });
    res.json(await messagingService.listHostConversations(hostProfileId));
  } catch (e) { next(e); }
});

hostMessagingRouter.get('/:id', async (req, res, next) => {
  try {
    const hostProfileId = req.hostProfileId;
    if (!hostProfileId) return res.status(403).json({ error: 'Host profile not found' });
    res.json(await messagingService.getConversation(req.params.id, { hostProfileId }));
  } catch (e) {
    if (/not found/i.test(e?.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

hostMessagingRouter.post('/', async (req, res, next) => {
  try {
    const hostProfileId = req.hostProfileId;
    if (!hostProfileId) return res.status(403).json({ error: 'Host profile not found' });
    res.status(201).json(await messagingService.createConversation({
      ...req.body,
      hostProfileId,
      senderType: 'HOST',
      senderName: req.hostDisplayName || 'Host'
    }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

hostMessagingRouter.post('/:id/messages', async (req, res, next) => {
  try {
    const hostProfileId = req.hostProfileId;
    if (!hostProfileId) return res.status(403).json({ error: 'Host profile not found' });
    res.status(201).json(await messagingService.sendMessage(req.params.id, {
      senderType: 'HOST',
      senderName: req.hostDisplayName || 'Host',
      body: req.body?.body
    }, { hostProfileId }));
  } catch (e) {
    if (/not found|closed/i.test(e?.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

hostMessagingRouter.post('/:id/read', async (req, res, next) => {
  try {
    const hostProfileId = req.hostProfileId;
    if (!hostProfileId) return res.status(403).json({ error: 'Host profile not found' });
    res.json(await messagingService.markRead(req.params.id, { readerType: 'HOST', hostProfileId }));
  } catch (e) { next(e); }
});

/**
 * Guest messaging routes — mounted under /api/public/booking/messages
 * Guest identified by customerId from guest session token.
 */
export const guestMessagingRouter = Router();

guestMessagingRouter.post('/list', async (req, res, next) => {
  try {
    const customerId = req.body?.customerId;
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });
    res.json(await messagingService.listGuestConversations(customerId));
  } catch (e) { next(e); }
});

guestMessagingRouter.post('/conversation', async (req, res, next) => {
  try {
    const { customerId, hostProfileId, tripId, subject, body, senderName } = req.body || {};
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });
    res.status(201).json(await messagingService.createConversation({
      customerId,
      hostProfileId,
      tripId,
      subject,
      body,
      senderType: 'GUEST',
      senderName: senderName || 'Guest'
    }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

guestMessagingRouter.post('/:id/messages', async (req, res, next) => {
  try {
    const customerId = req.body?.customerId;
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });
    res.status(201).json(await messagingService.sendMessage(req.params.id, {
      senderType: 'GUEST',
      senderName: req.body?.senderName || 'Guest',
      body: req.body?.body
    }, { customerId }));
  } catch (e) {
    if (/not found|closed/i.test(e?.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

guestMessagingRouter.post('/:id/read', async (req, res, next) => {
  try {
    const customerId = req.body?.customerId;
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });
    res.json(await messagingService.markRead(req.params.id, { readerType: 'GUEST', customerId }));
  } catch (e) { next(e); }
});
