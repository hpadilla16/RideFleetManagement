import crypto from 'crypto';
import { prisma } from '../../lib/prisma.js';

const CHAT_TOKEN_EXPIRY_DAYS = 30;

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
  }
};
