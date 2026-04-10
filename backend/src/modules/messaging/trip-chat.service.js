import crypto from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';

const CHAT_TOKEN_EXPIRY_DAYS = 30;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://ride-carsharing.com';

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
  hostProfile: { select: { id: true, displayName: true, email: true, phone: true } },
  customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
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
    if (!token) throw new Error('Token is required');
    const clean = String(token).trim();

    // Try host token first
    let conv = await prisma.conversation.findUnique({
      where: { hostToken: clean },
      include: chatInclude
    });
    if (conv) {
      if (conv.hostTokenExpiresAt && conv.hostTokenExpiresAt < new Date()) throw new Error('This chat link has expired');
      return formatChatRoom(conv, 'HOST');
    }

    // Try guest token
    conv = await prisma.conversation.findUnique({
      where: { guestToken: clean },
      include: chatInclude
    });
    if (conv) {
      if (conv.guestTokenExpiresAt && conv.guestTokenExpiresAt < new Date()) throw new Error('This chat link has expired');
      return formatChatRoom(conv, 'GUEST');
    }

    throw new Error('Invalid or expired chat link');
  },

  /**
   * Send a message via token.
   */
  async sendMessageByToken(token, { body }) {
    if (!body || !String(body).trim()) throw new Error('Message is required');
    const clean = String(token).trim();

    let conv = await prisma.conversation.findUnique({ where: { hostToken: clean }, select: { id: true, closedAt: true, hostProfile: { select: { displayName: true } } } });
    let senderType = 'HOST';
    let senderName = conv?.hostProfile?.displayName || 'Host';

    if (!conv) {
      conv = await prisma.conversation.findUnique({ where: { guestToken: clean }, select: { id: true, closedAt: true, customer: { select: { firstName: true, lastName: true } } } });
      senderType = 'GUEST';
      senderName = conv ? [conv.customer?.firstName, conv.customer?.lastName].filter(Boolean).join(' ') || 'Guest' : 'Guest';
    }

    if (!conv) throw new Error('Invalid or expired chat link');
    if (conv.closedAt) throw new Error('This chat has been closed');

    const now = new Date();
    const [msg] = await prisma.$transaction([
      prisma.message.create({
        data: { conversationId: conv.id, senderType, senderName, body: String(body).trim(), messageType: 'TEXT' }
      }),
      prisma.conversation.update({
        where: { id: conv.id },
        data: { lastMessageAt: now, lastMessageText: String(body).trim().slice(0, 200) }
      })
    ]);

    return { id: msg.id, senderType, senderName, body: msg.body, messageType: 'TEXT', createdAt: msg.createdAt };
  },

  /**
   * Mark messages as read via token.
   */
  async markReadByToken(token) {
    const clean = String(token).trim();

    let conv = await prisma.conversation.findUnique({ where: { hostToken: clean }, select: { id: true } });
    let readerType = 'HOST';
    if (!conv) {
      conv = await prisma.conversation.findUnique({ where: { guestToken: clean }, select: { id: true } });
      readerType = 'GUEST';
    }
    if (!conv) throw new Error('Invalid chat link');

    const otherSenderType = readerType === 'HOST' ? 'GUEST' : 'HOST';
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
    const clean = String(token).trim();
    const conv = await prisma.conversation.findUnique({ where: { hostToken: clean }, select: { id: true } });
    if (!conv) throw new Error('Only the host can update pickup details');

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
    const clean = String(token).trim();
    let conv = await prisma.conversation.findUnique({
      where: { guestToken: clean },
      select: { id: true, hostProfile: { select: { displayName: true, email: true } }, customer: { select: { firstName: true, lastName: true } }, trip: { select: { tripCode: true } } }
    });
    let senderType = 'GUEST';
    let senderName = '';

    if (!conv) {
      conv = await prisma.conversation.findUnique({
        where: { hostToken: clean },
        select: { id: true, customer: { select: { firstName: true, lastName: true, email: true } }, hostProfile: { select: { displayName: true } }, trip: { select: { tripCode: true } } }
      });
      senderType = 'HOST';
    }
    if (!conv) throw new Error('Invalid chat link');

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

    senderName = senderType === 'GUEST'
      ? [conv.customer?.firstName, conv.customer?.lastName].filter(Boolean).join(' ') || 'Guest'
      : conv.hostProfile?.displayName || 'Host';

    const body = `${hotAction.emoji} ${senderName}: ${hotAction.text}`;
    const now = new Date();

    const [msg] = await prisma.$transaction([
      prisma.message.create({
        data: { conversationId: conv.id, senderType, senderName, body, messageType: 'TEXT' }
      }),
      prisma.conversation.update({
        where: { id: conv.id },
        data: { lastMessageAt: now, lastMessageText: body.slice(0, 200) }
      })
    ]);

    // Email notification to the other party
    const otherEmail = senderType === 'GUEST' ? conv.hostProfile?.email : conv.customer?.email;
    const otherName = senderType === 'GUEST' ? conv.hostProfile?.displayName : [conv.customer?.firstName, conv.customer?.lastName].filter(Boolean).join(' ');
    if (otherEmail) {
      const otherToken = senderType === 'GUEST'
        ? (await prisma.conversation.findUnique({ where: { id: conv.id }, select: { hostToken: true } }))?.hostToken
        : (await prisma.conversation.findUnique({ where: { id: conv.id }, select: { guestToken: true } }))?.guestToken;
      sendEmail({
        to: otherEmail,
        subject: `Trip ${conv.trip?.tripCode || ''} — ${senderName} sent an update`,
        text: `${body}\n\nOpen your trip chat to respond: ${SITE_URL}/chat/${otherToken || ''}`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;padding:24px"><h2 style="color:#1e2847;margin:0 0 12px">Trip Chat Update</h2><div style="padding:16px;border-radius:12px;background:#f4f1ff;margin-bottom:16px"><strong>${senderName}</strong><p style="margin:8px 0 0;color:#53607b">${hotAction.text}</p></div><a href="${SITE_URL}/chat/${otherToken || ''}" style="display:inline-block;padding:12px 24px;border-radius:12px;background:linear-gradient(135deg,#8752FE,#6d3df2);color:#fff;text-decoration:none;font-weight:700">Open Trip Chat</a></div>`
      }).catch(() => {});
    }

    return { id: msg.id, senderType, senderName, body: msg.body, messageType: 'TEXT', createdAt: msg.createdAt };
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
    const unreadFromHost = conv.messages.filter((m) => m.senderType === 'HOST' || m.senderType === 'SYSTEM');

    // Notify host about unread guest messages
    if (unreadFromGuest.length > 0 && conv.hostProfile?.email && conv.hostToken) {
      const preview = unreadFromGuest.map((m) => m.body).join('\n');
      await sendEmail({
        to: conv.hostProfile.email,
        subject: `You have ${unreadFromGuest.length} unread message${unreadFromGuest.length > 1 ? 's' : ''} — Trip ${conv.trip?.tripCode || ''}`,
        text: `Your guest sent you messages:\n\n${preview}\n\nReply here: ${SITE_URL}/chat/${conv.hostToken}`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;padding:24px"><h2 style="color:#1e2847;margin:0 0 12px">${unreadFromGuest.length} Unread Message${unreadFromGuest.length > 1 ? 's' : ''}</h2><p style="color:#6b7a9a;margin:0 0 16px">Trip ${conv.trip?.tripCode || ''}</p>${unreadFromGuest.map((m) => `<div style="padding:12px 16px;border-radius:12px;background:#f4f1ff;margin-bottom:8px"><strong>${m.senderName || 'Guest'}</strong><p style="margin:6px 0 0;color:#53607b">${m.body}</p></div>`).join('')}<a href="${SITE_URL}/chat/${conv.hostToken}" style="display:inline-block;margin-top:12px;padding:12px 24px;border-radius:12px;background:linear-gradient(135deg,#8752FE,#6d3df2);color:#fff;text-decoration:none;font-weight:700">Open Trip Chat</a></div>`
      }).catch(() => {});
      sent++;
    }

    // Notify guest about unread host messages
    if (unreadFromHost.length > 0 && conv.customer?.email && conv.guestToken) {
      const preview = unreadFromHost.filter((m) => m.senderType === 'HOST').map((m) => m.body).join('\n');
      if (preview) {
        await sendEmail({
          to: conv.customer.email,
          subject: `Your host sent you a message — Trip ${conv.trip?.tripCode || ''}`,
          text: `Messages from your host:\n\n${preview}\n\nReply here: ${SITE_URL}/chat/${conv.guestToken}`,
          html: `<div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;padding:24px"><h2 style="color:#1e2847;margin:0 0 12px">Message from Your Host</h2><p style="color:#6b7a9a;margin:0 0 16px">Trip ${conv.trip?.tripCode || ''}</p>${unreadFromHost.filter((m) => m.senderType === 'HOST').map((m) => `<div style="padding:12px 16px;border-radius:12px;background:#f4f1ff;margin-bottom:8px"><strong>${m.senderName || 'Host'}</strong><p style="margin:6px 0 0;color:#53607b">${m.body}</p></div>`).join('')}<a href="${SITE_URL}/chat/${conv.guestToken}" style="display:inline-block;margin-top:12px;padding:12px 24px;border-radius:12px;background:linear-gradient(135deg,#8752FE,#6d3df2);color:#fff;text-decoration:none;font-weight:700">Open Trip Chat</a></div>`
        }).catch(() => {});
        sent++;
      }
    }

    return { sent };
  },

  /**
   * Host reports issue with chat transcript attached.
   */
  async reportIssueWithTranscript(token, { issueType, description }) {
    const clean = String(token).trim();
    const conv = await prisma.conversation.findUnique({
      where: { hostToken: clean },
      include: {
        messages: { orderBy: [{ createdAt: 'asc' }] },
        hostProfile: { select: { id: true, displayName: true, email: true, userId: true, tenantId: true } },
        customer: { select: { id: true, firstName: true, lastName: true, email: true } },
        trip: { select: { id: true, tripCode: true, status: true, tenantId: true, reservationId: true, hostProfileId: true } }
      }
    });
    if (!conv) throw new Error('Only the host can report issues from this chat');
    if (!conv.trip) throw new Error('No trip associated with this chat');
    if (!description || !String(description).trim()) throw new Error('Please describe the issue');

    // Build transcript
    const transcript = conv.messages.map((m) => {
      const time = new Date(m.createdAt).toISOString().slice(0, 16).replace('T', ' ');
      const sender = m.senderType === 'SYSTEM' ? '[SYSTEM]' : `[${m.senderType}] ${m.senderName || ''}`;
      return `${time} ${sender}: ${m.body}`;
    }).join('\n');

    // Create incident via issue center
    const incident = await prisma.tripIncident.create({
      data: {
        tenantId: conv.trip.tenantId || conv.hostProfile?.tenantId || null,
        tripId: conv.trip.id,
        reservationId: conv.trip.reservationId || null,
        hostProfileId: conv.trip.hostProfileId || conv.hostProfile?.id || null,
        customerId: conv.customer?.id || null,
        title: `${String(issueType || 'GENERAL').replace(/_/g, ' ')} — Trip ${conv.trip.tripCode}`,
        description: String(description).trim(),
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
  }
};
