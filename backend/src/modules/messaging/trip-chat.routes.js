import { Router } from 'express';
import { tripChatService } from './trip-chat.service.js';

/**
 * Public trip chat routes — token-based, no auth required.
 * Mounted at /api/public/booking/trip-chat
 */
export const tripChatRouter = Router();

// Get chat room by token
tripChatRouter.get('/:token', async (req, res, next) => {
  try {
    res.json(await tripChatService.getChatRoomByToken(req.params.token));
  } catch (e) {
    if (/invalid|expired|required/i.test(e?.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// Send message via token
tripChatRouter.post('/:token/messages', async (req, res, next) => {
  try {
    res.status(201).json(await tripChatService.sendMessageByToken(req.params.token, req.body || {}));
  } catch (e) {
    if (/invalid|expired|closed|required/i.test(e?.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// Mark as read via token
tripChatRouter.post('/:token/read', async (req, res, next) => {
  try {
    res.json(await tripChatService.markReadByToken(req.params.token));
  } catch (e) {
    next(e);
  }
});

// Update pickup details (host token only)
tripChatRouter.patch('/:token/pickup', async (req, res, next) => {
  try {
    res.json(await tripChatService.updatePickupDetails(req.params.token, req.body || {}));
  } catch (e) {
    if (/only the host|invalid/i.test(e?.message)) return res.status(403).json({ error: e.message });
    next(e);
  }
});
