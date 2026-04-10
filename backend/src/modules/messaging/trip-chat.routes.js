import { Router } from 'express';
import { tripChatService } from './trip-chat.service.js';
import { addConnection, broadcastToConversation } from './chat-events.js';
import { prisma } from '../../lib/prisma.js';
import { attachPublicRequestMeta, createPublicRateLimitGuard } from '../../middleware/public-endpoint-guards.js';

const chatReadGuard = [
  attachPublicRequestMeta('chat-read'),
  createPublicRateLimitGuard({ name: 'chat-read', maxRequests: 30, windowMs: 60 * 1000 })
];
const chatWriteGuard = [
  attachPublicRequestMeta('chat-write'),
  createPublicRateLimitGuard({ name: 'chat-write', maxRequests: 10, windowMs: 60 * 1000 })
];
const chatNotifyGuard = [
  attachPublicRequestMeta('chat-notify'),
  createPublicRateLimitGuard({ name: 'chat-notify', maxRequests: 3, windowMs: 60 * 1000 })
];

/**
 * Public trip chat routes — token-based, no auth required.
 * Mounted at /api/public/booking/trip-chat
 */
export const tripChatRouter = Router();

// Get chat room by token
tripChatRouter.get('/:token', chatReadGuard, async (req, res, next) => {
  try {
    res.json(await tripChatService.getChatRoomByToken(req.params.token));
  } catch (e) {
    if (/invalid|expired|required/i.test(e?.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// Send message via token
tripChatRouter.post('/:token/messages', chatWriteGuard, async (req, res, next) => {
  try {
    res.status(201).json(await tripChatService.sendMessageByToken(req.params.token, req.body || {}));
  } catch (e) {
    if (/invalid|expired|closed|required/i.test(e?.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// Mark as read via token
tripChatRouter.post('/:token/read', chatWriteGuard, async (req, res, next) => {
  try {
    res.json(await tripChatService.markReadByToken(req.params.token));
  } catch (e) {
    next(e);
  }
});

// Update pickup details (host token only)
tripChatRouter.patch('/:token/pickup', chatWriteGuard, async (req, res, next) => {
  try {
    res.json(await tripChatService.updatePickupDetails(req.params.token, req.body || {}));
  } catch (e) {
    if (/only the host|invalid/i.test(e?.message)) return res.status(403).json({ error: e.message });
    next(e);
  }
});

// Hot action button (arrived, running late, etc.)
tripChatRouter.post('/:token/action', chatWriteGuard, async (req, res, next) => {
  try {
    res.status(201).json(await tripChatService.sendHotAction(req.params.token, req.body || {}));
  } catch (e) {
    if (/invalid|expired|action/i.test(e?.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// Notify other party about unread messages via email
tripChatRouter.post('/:token/notify', chatNotifyGuard, async (req, res, next) => {
  try {
    const clean = String(req.params.token).trim();
    let conv = await (await import('../../lib/prisma.js')).prisma.conversation.findUnique({ where: { hostToken: clean }, select: { id: true } });
    if (!conv) conv = await (await import('../../lib/prisma.js')).prisma.conversation.findUnique({ where: { guestToken: clean }, select: { id: true } });
    if (!conv) return res.status(400).json({ error: 'Invalid chat link' });
    res.json(await tripChatService.notifyUnreadMessages(conv.id));
  } catch (e) {
    next(e);
  }
});

// Report issue with transcript (host only)
tripChatRouter.post('/:token/report-issue', chatWriteGuard, async (req, res, next) => {
  try {
    res.status(201).json(await tripChatService.reportIssueWithTranscript(req.params.token, req.body || {}));
  } catch (e) {
    if (/only the host|invalid|describe/i.test(e?.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// SSE stream for real-time updates
tripChatRouter.get('/:token/stream', async (req, res) => {
  try {
    const room = await tripChatService.getChatRoomByToken(req.params.token);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ role: room.role })}\n\n`);

    // Resolve conversationId
    const clean = String(req.params.token).trim();
    let conv = await prisma.conversation.findUnique({ where: { hostToken: clean }, select: { id: true } });
    if (!conv) conv = await prisma.conversation.findUnique({ where: { guestToken: clean }, select: { id: true } });
    if (!conv) { res.end(); return; }

    const removeConn = addConnection(conv.id, res, room.role);

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeConn();
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Typing indicator
tripChatRouter.post('/:token/typing', chatWriteGuard, async (req, res) => {
  try {
    const clean = String(req.params.token).trim();
    let conv = await prisma.conversation.findUnique({ where: { hostToken: clean }, select: { id: true } });
    let role = 'HOST';
    if (!conv) {
      conv = await prisma.conversation.findUnique({ where: { guestToken: clean }, select: { id: true } });
      role = 'GUEST';
    }
    if (!conv) return res.status(400).json({ error: 'Invalid chat link' });
    broadcastToConversation(conv.id, 'typing', { role }, role);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Block/mute the other party
tripChatRouter.post('/:token/block', chatWriteGuard, async (req, res, next) => {
  try {
    res.json(await tripChatService.blockConversation(req.params.token));
  } catch (e) {
    if (/invalid|expired/i.test(e?.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// Get host message templates
tripChatRouter.get('/:token/templates', chatReadGuard, async (req, res) => {
  try {
    res.json(tripChatService.getHostMessageTemplates());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Send template message (host only)
tripChatRouter.post('/:token/template', chatWriteGuard, async (req, res, next) => {
  try {
    res.status(201).json(await tripChatService.sendTemplateMessage(req.params.token, req.body || {}));
  } catch (e) {
    if (/invalid|expired|closed|only hosts|not found/i.test(e?.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// Send image/file message
tripChatRouter.post('/:token/image', chatWriteGuard, async (req, res, next) => {
  try {
    res.status(201).json(await tripChatService.sendImageMessage(req.params.token, req.body || {}));
  } catch (e) {
    if (/invalid|expired|closed|required|too long/i.test(e?.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});
