import crypto from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import { ValidationError, NotFoundError } from '../../lib/errors.js';
import { broadcastToConversation } from './chat-events.js';

const CHAT_TOKEN_EXPIRY_DAYS = 14;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://ride-carsharing.com';
const MAX_MESSAGE_LENGTH = 5000;

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeName(name) {
  return String(name || '').replace(/[\r\n\t]/g, '').trim().slice(0, 200);
}

/**
 * Resolve conversation + role from a token. Validates expiry on every call.
 */
async function resolveTokenContext(token) {
  const clean = String(token || '').trim();
  if (!clean) throw new ValidationError('Token is required');

  let conv = await prisma.conversation.findUnique({ where: { hostToken: clean }, include: chatInclude });
  if (conv) {
    if (conv.hostTokenExpiresAt && conv.hostTokenExpiresAt < new Date()) throw new NotFoundError('This chat link has expired');
    return { conv, role: 'HOST' };
  }

  conv = await prisma.conversation.findUnique({ where: { guestToken: clean }, include: chatInclude });
  if (conv) {
    if (conv.guestTokenExpiresAt && conv.guestTokenExpiresAt < new Date()) throw new NotFoundError('This chat link has expired');
    return { conv, role: 'GUEST' };
  }

  throw new NotFoundError('Invalid or expired chat link');
}

/**
 * Lightweight token resolve (no message include) with expiry check.
 */
async function resolveTokenLight(token) {
  const clean = String(token || '').trim();
  if (!clean) throw new ValidationError('Token is required');

  let conv = await prisma.conversation.findUnique({
    where: { hostToken: clean },
    select: { id: true, closedAt: true, hostTokenExpiresAt: true, hostProfile: { select: { displayName: true } }, customer: { select: { firstName: true, lastName: true } }, trip: { select: { tripCode: true } } }
  });
  if (conv) {
    if (conv.hostTokenExpiresAt && conv.hostTokenExpiresAt < new Date()) throw new NotFoundError('This chat link has expired');
    return { conv, role: 'HOST', senderName: sanitizeName(conv.hostProfile?.displayName || 'Host') };
  }

  conv = await prisma.conversation.findUnique({
    where: { guestToken: clean },
    select: { id: true, closedAt: true, guestTokenExpiresAt: true, customer: { select: { firstName: true, lastName: true } }, hostProfile: { select: { displayName: true } }, trip: { select: { tripCode: true } } }
  });
  if (conv) {
    if (conv.guestTokenExpiresAt && conv.guestTokenExpiresAt < new Date()) throw new NotFoundError('This chat link has expired');
    return { conv, role: 'GUEST', senderName: sanitizeName([conv.customer?.firstName, conv.customer?.lastName].filter(Boolean).join(' ') || 'Guest') };
  }

  throw new NotFoundError('Invalid or expired chat link');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function tokenExpiresAt() {
  const d = new Date();
  d.setDate(d.getDate() + CHAT_TOKEN_EXPIRY_DAYS);
  return d;
}

const chatInclude = {
  messages: { orderBy: [{ createdAt: 'asc' }], take: 100 },
  hostProfile: { select: { id: true, displayName: true } },
  customer: { select: { id: true, firstName: true, lastName: true } },
  trip: {
    select: {
      id: true, tripCode: true, status: true,
      scheduledPickupAt: true, scheduledReturnAt: true,
      listing: { select: { id: true, title: true, vehicle: { select: { year: true, make: true, model: true } } } }
    }
  }
};

function formatChatRoom(conv, role) {
  const isHost = role === 'HOST';
  return {
    id: conv.id,
    role,
    tripCode: conv.trip?.tripCode || '',
    tripStatus: conv.trip?.status || '',
    scheduledPickupAt: conv.trip?.scheduledPickupAt || null,
    scheduledReturnAt: conv.trip?.scheduledReturnAt || null,
    listingTitle: conv.trip?.listing?.title || '',
    vehicleLabel: conv.trip?.listing?.vehicle ? [conv.trip.listing.vehicle.year, conv.trip.listing.vehicle.make, conv.trip.listing.vehicle.model].filter(Boolean).join(' ') : '',
    hostName: conv.hostProfile?.displayName || '',
    guestName: [conv.customer?.firstName, conv.customer?.lastName].filter(Boolean).join(' ') || '',
    subject: conv.subject || '',
    pickupAddress: conv.pickupAddress || '',
    pickupLat: conv.pickupLat ? Number(conv.pickupLat) : null,
    pickupLng: conv.pickupLng ? Number(conv.pickupLng) : null,
    pickupInstructions: conv.pickupInstructions || '',
    pickupPhotoUrl: conv.pickupPhotoUrl || '',
    closedAt: conv.closedAt,
    messages: (conv.messages || []).map((m) => ({
      id: m.id,
      senderType: m.senderType,
      senderName: m.senderName || '',
      body: m.body,
      messageType: m.messageType || 'TEXT',
      readAt: m.readAt,
      createdAt: m.createdAt
    })),
    unreadCount: (conv.messages || []).filter((m) => {
      if (isHost) return m.senderType !== 'HOST' && !m.readAt;
      return m.senderType !== 'GUEST' && !m.readAt;
    }).length
  };
}

async function addSystemMessage(conversationId, body) {
  const msg = await prisma.message.create({
    data: { conversationId, senderType: 'SYSTEM', senderName: 'Ride', body, messageType: 'SYSTEM' }
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date(), lastMessageText: body.slice(0, 200) }
  });
  broadcastToConversation(conversationId, 'message', {
    id: msg.id, senderType: 'SYSTEM', senderName: 'Ride', body: msg.body, messageType: 'SYSTEM', createdAt: msg.createdAt
  });
  return msg;
}

export const tripChatService = {
  /**
   * Create a trip chat room when payment is confirmed.
   * Returns the conversation with host + guest tokens.
   */
  async createTripChatRoom({ tripId, hostProfileId, customerId, tenantId }) {
    if (!tripId) throw new Error('tripId is required');
    if (!hostProfileId) throw new Error('hostProfileId is required');
    if (!customerId) throw new Error('customerId is required');

    // Check if chat room already exists for this trip
    const existing = await prisma.conversation.findFirst({
      where: { tripId },
      include: chatInclude
    });
    if (existing) return { conversation: formatChatRoom(existing, 'SYSTEM'), hostToken: existing.hostToken, guestToken: existing.guestToken };

    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      select: { tripCode: true, listing: { select: { title: true } } }
    });

    const hostToken = generateToken();
    const guestToken = generateToken();
    const expiresAt = tokenExpiresAt();

    const conv = await prisma.conversation.create({
      data: {
        tenantId,
        tripId,
        hostProfileId,
        customerId,
        subject: `Trip ${trip?.tripCode || ''} — ${trip?.listing?.title || 'Car Sharing'}`,
        hostToken,
        guestToken,
        hostTokenExpiresAt: expiresAt,
        guestTokenExpiresAt: expiresAt,
        lastMessageAt: new Date(),
        lastMessageText: 'Trip chat room created',
        messages: {
          create: {
            senderType: 'SYSTEM',
            senderName: 'Ride',
            body: `Welcome to your trip chat! This is a secure space to coordinate pickup and return details for trip ${trip?.tripCode || ''}. All messages are saved for your records.`,
            messageType: 'SYSTEM'
          }
        }
      },
      include: chatInclude
    });

    return { conversation: formatChatRoom(conv, 'SYSTEM'), hostToken, guestToken };
  },

  /**
   * Access chat room via token (no login required).
   */
  async getChatRoomByToken(token) {
    const { conv, role } = await resolveTokenContext(token);
    return formatChatRoom(conv, role);
  },

  /**
   * Send a message via token.
   */
  async sendMessageByToken(token, { body }) {
    if (!body || !String(body).trim()) throw new ValidationError('Message is required');
    const cleanBody = String(body).trim();
    if (cleanBody.length > MAX_MESSAGE_LENGTH) throw new Error(`Message cannot exceed ${MAX_MESSAGE_LENGTH} characters`);

    const { conv, role, senderName } = await resolveTokenLight(token);
    if (conv.closedAt) throw new ValidationError('This chat has been closed');

    const now = new Date();
    const [msg] = await prisma.$transaction([
      prisma.message.create({
        data: { conversationId: conv.id, senderType: role, senderName, body: cleanBody, messageType: 'TEXT' }
      }),
      prisma.conversation.update({
        where: { id: conv.id },
        data: { lastMessageAt: now, lastMessageText: cleanBody.slice(0, 200) }
      })
    ]);

    const result = { id: msg.id, senderType: role, senderName, body: msg.body, messageType: 'TEXT', createdAt: msg.createdAt };
    broadcastToConversation(conv.id, 'message', result, role);
    return result;
  },

  /**
   * Mark messages as read via token.
   */
  async markReadByToken(token) {
    const { conv, role } = await resolveTokenLight(token);
    const otherSenderType = role === 'HOST' ? 'GUEST' : 'HOST';
    const result = await prisma.message.updateMany({
      where: { conversationId: conv.id, senderType: { in: [otherSenderType, 'SYSTEM'] }, readAt: null },
      data: { readAt: new Date() }
    });
    return { marked: result.count };
  },

  /**
   * Update pickup details (host only).
   */
  async updatePickupDetails(token, { pickupAddress, pickupLat, pickupLng, pickupInstructions, pickupPhotoUrl }) {
    const { conv, role } = await resolveTokenLight(token);
    if (role !== 'HOST') throw new Error('Only the host can update pickup details');

    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        pickupAddress: pickupAddress || undefined,
        pickupLat: pickupLat != null ? pickupLat : undefined,
        pickupLng: pickupLng != null ? pickupLng : undefined,
        pickupInstructions: pickupInstructions || undefined,
        pickupPhotoUrl: pickupPhotoUrl || undefined,
      }
    });

    await addSystemMessage(conv.id,
      `📍 Pickup details updated: ${pickupAddress || 'Location shared'}${pickupInstructions ? ` — ${pickupInstructions}` : ''}`
    );

    return { ok: true };
  },

  /**
   * Send auto-messages at key trip moments.
   */
  async sendAutoMessage(tripId, trigger) {
    const conv = await prisma.conversation.findFirst({
      where: { tripId },
      select: { id: true, trip: { select: { tripCode: true, scheduledPickupAt: true, scheduledReturnAt: true } } }
    });
    if (!conv) return null;

    const messages = {
      PAYMENT_CONFIRMED: `Payment confirmed! Your host will share pickup details soon. You can use this chat to coordinate.`,
      PICKUP_24H: `Reminder: Your trip starts in less than 24 hours. Make sure pickup details are confirmed above.`,
      PICKUP_DAY: `Today is pickup day! Check the pickup details and message your host if you need anything.`,
      RETURN_24H: `Reminder: Your trip ends tomorrow. Please plan your return accordingly.`,
      TRIP_STARTED: `Trip is now active. Drive safe and enjoy your ride!`,
      TRIP_COMPLETED: `Trip completed! Thank you for choosing Ride. You'll receive a review link shortly.`,
    };

    const body = messages[trigger];
    if (!body) return null;

    return addSystemMessage(conv.id, body);
  },

  /**
   * Hot action buttons — guest announces arrival at pickup/return.
   */
  async sendHotAction(token, { action }) {
    const { conv, role, senderName } = await resolveTokenLight(token);

    const actions = {
      ARRIVED_PICKUP: { emoji: '📍', text: 'I\'ve arrived at the pickup location!' },
      ARRIVED_RETURN: { emoji: '📍', text: 'I\'ve arrived at the return location!' },
      RUNNING_LATE: { emoji: '⏰', text: 'I\'m running a few minutes late. On my way!' },
      NEED_HELP: { emoji: '🆘', text: 'I need assistance. Please check the chat.' },
      VEHICLE_READY: { emoji: '✅', text: 'The vehicle is ready for pickup!' },
      VEHICLE_INSPECTED: { emoji: '🔍', text: 'Vehicle inspection is complete.' },
    };

    const hotAction = actions[String(action || '').toUpperCase()];
    if (!hotAction) throw new Error('Invalid action');

    const body = `${hotAction.emoji} ${escapeHtml(senderName)}: ${hotAction.text}`;
    const now = new Date();

    const [msg] = await prisma.$transaction([
      prisma.message.create({
        data: { conversationId: conv.id, senderType: role, senderName, body, messageType: 'TEXT' }
      }),
      prisma.conversation.update({
        where: { id: conv.id },
        data: { lastMessageAt: now, lastMessageText: body.slice(0, 200) }
      })
    ]);

    // Email notification to the other party
    const fullConv = await prisma.conversation.findUnique({
      where: { id: conv.id },
      select: {
        hostToken: true, guestToken: true,
        hostProfile: { select: { email: true } },
        customer: { select: { email: true } },
        trip: { select: { tripCode: true } }
      }
    });
    const otherEmail = role === 'GUEST' ? fullConv?.hostProfile?.email : fullConv?.customer?.email;
    const otherToken = role === 'GUEST' ? fullConv?.hostToken : fullConv?.guestToken;
    if (otherEmail && otherToken) {
      const safeName = escapeHtml(senderName);
      const safeText = escapeHtml(hotAction.text);
      sendEmail({
        to: otherEmail,
        subject: `Trip ${sanitizeName(fullConv?.trip?.tripCode)} — ${sanitizeName(senderName)} sent an update`,
        text: `${senderName}: ${hotAction.text}\n\nOpen your trip chat: ${SITE_URL}/chat/${otherToken}`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;padding:24px"><h2 style="color:#1e2847;margin:0 0 12px">Trip Chat Update</h2><div style="padding:16px;border-radius:12px;background:#f4f1ff;margin-bottom:16px"><strong>${safeName}</strong><p style="margin:8px 0 0;color:#53607b">${safeText}</p></div><a href="${SITE_URL}/chat/${otherToken}" style="display:inline-block;padding:12px 24px;border-radius:12px;background:linear-gradient(135deg,#8752FE,#6d3df2);color:#fff;text-decoration:none;font-weight:700">Open Trip Chat</a></div>`
      }).catch(() => {});
    }

    const actionResult = { id: msg.id, senderType: role, senderName, body: msg.body, messageType: 'TEXT', createdAt: msg.createdAt };
    broadcastToConversation(conv.id, 'message', actionResult, role);
    return actionResult;
  },

  /**
   * Notify other party via email when they have unread messages.
   */
  async notifyUnreadMessages(conversationId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        messages: { where: { readAt: null }, orderBy: [{ createdAt: 'desc' }], take: 5 },
        hostProfile: { select: { displayName: true, email: true } },
        customer: { select: { firstName: true, lastName: true, email: true } },
        trip: { select: { tripCode: true } }
      }
    });
    if (!conv || !conv.messages.length) return { sent: 0 };

    let sent = 0;
    const unreadFromGuest = conv.messages.filter((m) => m.senderType === 'GUEST');
    const unreadFromHost = conv.messages.filter((m) => m.senderType === 'HOST');

    if (unreadFromGuest.length > 0 && conv.hostProfile?.email && conv.hostToken) {
      const msgHtml = unreadFromGuest.map((m) => `<div style="padding:12px 16px;border-radius:12px;background:#f4f1ff;margin-bottom:8px"><strong>${escapeHtml(m.senderName || 'Guest')}</strong><p style="margin:6px 0 0;color:#53607b">${escapeHtml(m.body)}</p></div>`).join('');
      await sendEmail({
        to: conv.hostProfile.email,
        subject: sanitizeName(`${unreadFromGuest.length} unread message${unreadFromGuest.length > 1 ? 's' : ''} — Trip ${conv.trip?.tripCode || ''}`),
        text: `Your guest sent you messages:\n\n${unreadFromGuest.map((m) => m.body).join('\n')}\n\nReply: ${SITE_URL}/chat/${conv.hostToken}`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;padding:24px"><h2 style="color:#1e2847;margin:0 0 12px">${unreadFromGuest.length} Unread Message${unreadFromGuest.length > 1 ? 's' : ''}</h2>${msgHtml}<a href="${SITE_URL}/chat/${conv.hostToken}" style="display:inline-block;margin-top:12px;padding:12px 24px;border-radius:12px;background:linear-gradient(135deg,#8752FE,#6d3df2);color:#fff;text-decoration:none;font-weight:700">Open Trip Chat</a></div>`
      }).catch(() => {});
      sent++;
    }

    if (unreadFromHost.length > 0 && conv.customer?.email && conv.guestToken) {
      const msgHtml = unreadFromHost.map((m) => `<div style="padding:12px 16px;border-radius:12px;background:#f4f1ff;margin-bottom:8px"><strong>${escapeHtml(m.senderName || 'Host')}</strong><p style="margin:6px 0 0;color:#53607b">${escapeHtml(m.body)}</p></div>`).join('');
      await sendEmail({
        to: conv.customer.email,
        subject: sanitizeName(`Your host sent you a message — Trip ${conv.trip?.tripCode || ''}`),
        text: `Messages from your host:\n\n${unreadFromHost.map((m) => m.body).join('\n')}\n\nReply: ${SITE_URL}/chat/${conv.guestToken}`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;padding:24px"><h2 style="color:#1e2847;margin:0 0 12px">Message from Your Host</h2>${msgHtml}<a href="${SITE_URL}/chat/${conv.guestToken}" style="display:inline-block;margin-top:12px;padding:12px 24px;border-radius:12px;background:linear-gradient(135deg,#8752FE,#6d3df2);color:#fff;text-decoration:none;font-weight:700">Open Trip Chat</a></div>`
      }).catch(() => {});
      sent++;
    }

    return { sent };
  },

  /**
   * Host reports issue with chat transcript attached.
   */
  async reportIssueWithTranscript(token, { issueType, description }) {
    const clean = String(token || '').trim();
    if (!clean) throw new ValidationError('Token is required');
    const conv = await prisma.conversation.findUnique({
      where: { hostToken: clean },
      include: {
        messages: { orderBy: [{ createdAt: 'asc' }] },
        hostProfile: { select: { id: true, displayName: true, tenantId: true } },
        customer: { select: { id: true, firstName: true, lastName: true } },
        trip: { select: { id: true, tripCode: true, status: true, tenantId: true, reservationId: true, hostProfileId: true } }
      }
    });
    if (!conv) throw new Error('Only the host can report issues from this chat');
    if (conv.hostTokenExpiresAt && conv.hostTokenExpiresAt < new Date()) throw new NotFoundError('This chat link has expired');
    if (!conv.trip) throw new Error('No trip associated with this chat');
    const cleanDescription = String(description || '').trim().slice(0, 2000);
    if (!cleanDescription) throw new Error('Please describe the issue');

    // Build transcript (escaped, capped at 50KB)
    const transcript = conv.messages.map((m) => {
      const time = new Date(m.createdAt).toISOString().slice(0, 16).replace('T', ' ');
      const sender = m.senderType === 'SYSTEM' ? '[SYSTEM]' : `[${m.senderType}] ${sanitizeName(m.senderName)}`;
      return `${time} ${sender}: ${String(m.body || '').slice(0, 500)}`;
    }).join('\n').slice(0, 50000);

    // Create incident via issue center
    const incident = await prisma.tripIncident.create({
      data: {
        tenantId: conv.trip.tenantId || conv.hostProfile?.tenantId || null,
        tripId: conv.trip.id,
        reservationId: conv.trip.reservationId || null,
        hostProfileId: conv.trip.hostProfileId || conv.hostProfile?.id || null,
        customerId: conv.customer?.id || null,
        title: `${String(issueType || 'GENERAL').replace(/_/g, ' ')} — Trip ${conv.trip.tripCode}`,
        description: cleanDescription,
        type: String(issueType || 'SERVICE').toUpperCase(),
        status: 'OPEN',
        priority: 'MEDIUM',
        severity: 'MEDIUM',
        source: 'TRIP_CHAT',
        notes: `Reported by host ${conv.hostProfile?.displayName || ''} via trip chat.\n\n--- CHAT TRANSCRIPT ---\n${transcript}`,
      }
    });

    // Add system message to chat
    await addSystemMessage(conv.id, `🎫 Issue reported by host. Ticket #${incident.id.slice(-6).toUpperCase()} has been created. Our support team will review it shortly.`);

    return {
      ok: true,
      ticketId: incident.id,
      ticketRef: incident.id.slice(-6).toUpperCase(),
      message: `Issue ticket created. Reference: ${incident.id.slice(-6).toUpperCase()}`
    };
  },

  /**
   * Get pre-built message templates for hosts.
   */
  getHostMessageTemplates() {
    return [
      { id: 'PICKUP_INSTRUCTIONS', label: 'Pickup Instructions', body: 'Hi! Here are the pickup details for your trip. Please arrive at the location shown above and look for the vehicle. Text me when you arrive!' },
      { id: 'RETURN_REMINDER', label: 'Return Reminder', body: 'Hi! Just a reminder that your trip ends soon. Please return the vehicle to the same location and ensure the tank is at the same level as pickup. Thanks!' },
      { id: 'FUEL_REMINDER', label: 'Fuel Reminder', body: 'Please make sure to refuel before returning the vehicle. The tank should be at the same level as when you picked up. Thank you!' },
      { id: 'WELCOME', label: 'Welcome Message', body: 'Welcome! I hope you enjoy your trip. Feel free to reach out if you have any questions about the vehicle. Drive safe!' },
      { id: 'LATE_RETURN', label: 'Late Return Notice', body: 'Hi, I noticed the return time has passed. Please let me know your status. Late returns may incur additional charges.' },
      { id: 'CUSTOM_THANKS', label: 'Thank You', body: 'Thank you for taking great care of the vehicle! It was a pleasure hosting you. Please leave a review if you have a moment!' },
    ];
  },

  /**
   * Send a template message from host.
   */
  async sendTemplateMessage(token, { templateId, customBody }) {
    const { conv, role, senderName } = await resolveTokenLight(token);
    if (role !== 'HOST') throw new Error('Only hosts can use message templates');
    if (conv.closedAt) throw new ValidationError('This chat has been closed');

    const templates = this.getHostMessageTemplates();
    const template = templates.find((t) => t.id === templateId);
    const body = customBody ? String(customBody).trim().slice(0, MAX_MESSAGE_LENGTH) : template?.body;
    if (!body) throw new Error('Template not found or empty');

    const now = new Date();
    const [msg] = await prisma.$transaction([
      prisma.message.create({
        data: { conversationId: conv.id, senderType: 'HOST', senderName, body, messageType: 'TEXT' }
      }),
      prisma.conversation.update({
        where: { id: conv.id },
        data: { lastMessageAt: now, lastMessageText: body.slice(0, 200) }
      })
    ]);

    const result = { id: msg.id, senderType: 'HOST', senderName, body: msg.body, messageType: 'TEXT', createdAt: msg.createdAt };
    broadcastToConversation(conv.id, 'message', result, 'HOST');
    return result;
  },

  /**
   * Block conversation — closes chat and notifies the other party.
   */
  async blockConversation(token) {
    const { conv, role } = await resolveTokenLight(token);
    if (conv.closedAt) return { ok: true, alreadyClosed: true };

    await prisma.conversation.update({
      where: { id: conv.id },
      data: { closedAt: new Date() }
    });

    const blocker = role === 'HOST' ? 'The host' : 'The guest';
    await addSystemMessage(conv.id, `${blocker} has ended this conversation.`);

    return { ok: true };
  },

  /**
   * Send image/file message via token.
   */
  async sendImageMessage(token, { imageUrl, caption }) {
    if (!imageUrl || !String(imageUrl).trim()) throw new Error('Image URL is required');
    const cleanUrl = String(imageUrl).trim();
    if (cleanUrl.length > 2000) throw new Error('Image URL too long');
    const cleanCaption = String(caption || '').trim().slice(0, 500);

    const { conv, role, senderName } = await resolveTokenLight(token);
    if (conv.closedAt) throw new ValidationError('This chat has been closed');

    const body = cleanCaption ? `📷 ${cleanCaption}` : '📷 Shared an image';
    const now = new Date();

    const [msg] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId: conv.id,
          senderType: role,
          senderName,
          body: `${body}\n${cleanUrl}`,
          messageType: 'IMAGE'
        }
      }),
      prisma.conversation.update({
        where: { id: conv.id },
        data: { lastMessageAt: now, lastMessageText: body.slice(0, 200) }
      })
    ]);

    const result = { id: msg.id, senderType: role, senderName, body: msg.body, messageType: 'IMAGE', createdAt: msg.createdAt };
    broadcastToConversation(conv.id, 'message', result, role);
    return result;
  }
};
