import { prisma } from '../../lib/prisma.js';

const conversationInclude = {
  messages: {
    orderBy: [{ createdAt: 'asc' }],
    take: 50
  },
  hostProfile: {
    select: { id: true, displayName: true, email: true }
  },
  customer: {
    select: { id: true, firstName: true, lastName: true, email: true }
  },
  trip: {
    select: { id: true, tripCode: true, status: true }
  }
};

function conversationSummary(conv) {
  return {
    id: conv.id,
    tripId: conv.tripId,
    tripCode: conv.trip?.tripCode || null,
    tripStatus: conv.trip?.status || null,
    hostProfileId: conv.hostProfileId,
    hostDisplayName: conv.hostProfile?.displayName || '',
    customerId: conv.customerId,
    customerName: [conv.customer?.firstName, conv.customer?.lastName].filter(Boolean).join(' ') || '',
    customerEmail: conv.customer?.email || '',
    subject: conv.subject || '',
    lastMessageAt: conv.lastMessageAt,
    lastMessageText: conv.lastMessageText || '',
    closedAt: conv.closedAt,
    createdAt: conv.createdAt,
    messageCount: conv.messages?.length ?? 0,
    unreadHostCount: (conv.messages || []).filter((m) => m.senderType === 'GUEST' && !m.readAt).length,
    unreadGuestCount: (conv.messages || []).filter((m) => m.senderType === 'HOST' && !m.readAt).length,
    messages: (conv.messages || []).map((m) => ({
      id: m.id,
      senderType: m.senderType,
      senderName: m.senderName || '',
      body: m.body,
      readAt: m.readAt,
      createdAt: m.createdAt
    }))
  };
}

export const messagingService = {
  /**
   * List conversations for a host profile.
   */
  async listHostConversations(hostProfileId) {
    const conversations = await prisma.conversation.findMany({
      where: { hostProfileId },
      include: conversationInclude,
      orderBy: [{ lastMessageAt: 'desc' }]
    });
    return conversations.map(conversationSummary);
  },

  /**
   * List conversations for a guest (by customerId).
   */
  async listGuestConversations(customerId) {
    const conversations = await prisma.conversation.findMany({
      where: { customerId },
      include: conversationInclude,
      orderBy: [{ lastMessageAt: 'desc' }]
    });
    return conversations.map(conversationSummary);
  },

  /**
   * Get a single conversation by ID with ownership check.
   */
  async getConversation(conversationId, { hostProfileId, customerId }) {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: conversationInclude
    });
    if (!conv) throw new Error('Conversation not found');
    if (hostProfileId && conv.hostProfileId !== hostProfileId) throw new Error('Conversation not found');
    if (customerId && conv.customerId !== customerId) throw new Error('Conversation not found');
    return conversationSummary(conv);
  },

  /**
   * Start a new conversation (guest or host initiated).
   */
  async createConversation({ hostProfileId, customerId, tripId, subject, body, senderType, senderName, tenantId }) {
    if (!hostProfileId) throw new Error('hostProfileId is required');
    if (!customerId) throw new Error('customerId is required');
    if (!body || !String(body).trim()) throw new Error('Message body is required');

    const cleanSenderType = String(senderType || 'GUEST').toUpperCase();
    const now = new Date();

    const conv = await prisma.conversation.create({
      data: {
        tenantId: tenantId || null,
        tripId: tripId || null,
        hostProfileId,
        customerId,
        subject: subject || null,
        lastMessageAt: now,
        lastMessageText: String(body).slice(0, 200),
        messages: {
          create: {
            senderType: cleanSenderType,
            senderName: senderName || null,
            body: String(body).trim()
          }
        }
      },
      include: conversationInclude
    });

    return conversationSummary(conv);
  },

  /**
   * Send a message in an existing conversation.
   */
  async sendMessage(conversationId, { senderType, senderName, body }, { hostProfileId, customerId }) {
    if (!body || !String(body).trim()) throw new Error('Message body is required');

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, hostProfileId: true, customerId: true, closedAt: true }
    });
    if (!conv) throw new Error('Conversation not found');
    if (hostProfileId && conv.hostProfileId !== hostProfileId) throw new Error('Conversation not found');
    if (customerId && conv.customerId !== customerId) throw new Error('Conversation not found');
    if (conv.closedAt) throw new Error('This conversation has been closed');

    const cleanSenderType = String(senderType || 'GUEST').toUpperCase();
    const now = new Date();

    const [message] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId,
          senderType: cleanSenderType,
          senderName: senderName || null,
          body: String(body).trim()
        }
      }),
      prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: now,
          lastMessageText: String(body).trim().slice(0, 200)
        }
      })
    ]);

    return {
      id: message.id,
      senderType: message.senderType,
      senderName: message.senderName || '',
      body: message.body,
      createdAt: message.createdAt
    };
  },

  /**
   * Mark messages as read.
   */
  async markRead(conversationId, { readerType, hostProfileId, customerId }) {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, hostProfileId: true, customerId: true }
    });
    if (!conv) throw new Error('Conversation not found');
    if (hostProfileId && conv.hostProfileId !== hostProfileId) throw new Error('Conversation not found');
    if (customerId && conv.customerId !== customerId) throw new Error('Conversation not found');

    const otherSenderType = readerType === 'HOST' ? 'GUEST' : 'HOST';

    const result = await prisma.message.updateMany({
      where: {
        conversationId,
        senderType: otherSenderType,
        readAt: null
      },
      data: { readAt: new Date() }
    });

    return { marked: result.count };
  }
};
