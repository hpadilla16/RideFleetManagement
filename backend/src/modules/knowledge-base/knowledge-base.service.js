import { prisma } from '../../lib/prisma.js';
import { ValidationError, NotFoundError } from '../../lib/errors.js';
import { cache } from '../../lib/cache.js';

function slugify(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
}

const CATEGORIES = [
  { id: 'CHECKOUT', label: 'Checkout Process' },
  { id: 'CHECKIN', label: 'Check-in & Returns' },
  { id: 'PAYMENTS', label: 'Payments & Billing' },
  { id: 'INSPECTIONS', label: 'Inspections' },
  { id: 'DISPUTES', label: 'Disputes & Issues' },
  { id: 'CAR_SHARING', label: 'Car Sharing' },
  { id: 'TOLLS', label: 'Tolls' },
  { id: 'AGREEMENTS', label: 'Agreements & Documents' },
  { id: 'PLANNER', label: 'Fleet Planner' },
  { id: 'GENERAL', label: 'General' },
];

export const knowledgeBaseService = {
  getCategories() {
    return CATEGORIES;
  },

  async list({ tenantId, category, status = 'PUBLISHED', search, page = 1, limit = 50 }) {
    // Cache non-search list queries for 2 minutes
    if (!search) {
      const cacheKey = `kb:list:${tenantId || 'global'}:${category || 'all'}:${status}:${page}:${limit}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;
    }
    const take = Math.min(Math.max(1, Number(limit) || 50), 200);
    const skip = (Math.max(1, Number(page) || 1) - 1) * take;
    const where = {
      ...(tenantId ? { OR: [{ tenantId }, { tenantId: null }] } : { tenantId: null }),
      ...(status ? { status: String(status).toUpperCase() } : {}),
      ...(category ? { category: String(category).toUpperCase() } : {}),
      ...(search ? {
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { body: { contains: search, mode: 'insensitive' } },
          { tags: { hasSome: [search.toLowerCase()] } },
        ]
      } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.knowledgeArticle.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip,
        take,
        select: {
          id: true, title: true, slug: true, category: true, tags: true,
          status: true, sortOrder: true, viewCount: true, helpfulCount: true,
          createdAt: true, updatedAt: true,
        }
      }),
      prisma.knowledgeArticle.count({ where })
    ]);

    const result = { items, total, page: Number(page), limit: take, pages: Math.ceil(total / take) };
    if (!search) {
      const cacheKey = `kb:list:${tenantId || 'global'}:${category || 'all'}:${status}:${page}:${limit}`;
      cache.set(cacheKey, result, 2 * 60 * 1000); // 2 min
    }
    return result;
  },

  async getBySlug(slug, { tenantId }) {
    const article = await prisma.knowledgeArticle.findFirst({
      where: {
        slug: String(slug),
        status: 'PUBLISHED',
        ...(tenantId ? { OR: [{ tenantId }, { tenantId: null }] } : { tenantId: null }),
      }
    });
    if (!article) throw new NotFoundError('Article not found');

    // Increment view count (fire and forget)
    prisma.knowledgeArticle.update({
      where: { id: article.id },
      data: { viewCount: { increment: 1 } }
    }).catch(() => {});

    return article;
  },

  async create(data, { tenantId, userId }) {
    const title = String(data.title || '').trim();
    if (!title) throw new ValidationError('Title is required');
    const body = String(data.body || '').trim();
    if (!body) throw new ValidationError('Body is required');

    const slug = data.slug ? slugify(data.slug) : slugify(title);
    const category = String(data.category || 'GENERAL').toUpperCase();
    const tags = Array.isArray(data.tags) ? data.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean) : [];

    const created = await prisma.knowledgeArticle.create({
      data: {
        tenantId: tenantId || null,
        title,
        slug,
        body,
        category,
        tags,
        status: data.status || 'PUBLISHED',
        sortOrder: Number(data.sortOrder || 0),
        createdBy: userId || null,
      }
    });
    cache.invalidate('kb:list:');
    return created;
  },

  async update(id, data, { tenantId }) {
    const article = await prisma.knowledgeArticle.findFirst({
      where: { id, ...(tenantId ? { tenantId } : {}) }
    });
    if (!article) throw new NotFoundError('Article not found');

    const updateData = {};
    if (data.title !== undefined) updateData.title = String(data.title).trim();
    if (data.body !== undefined) updateData.body = String(data.body).trim();
    if (data.slug !== undefined) updateData.slug = slugify(data.slug);
    if (data.category !== undefined) updateData.category = String(data.category).toUpperCase();
    if (data.tags !== undefined) updateData.tags = Array.isArray(data.tags) ? data.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean) : [];
    if (data.status !== undefined) updateData.status = String(data.status).toUpperCase();
    if (data.sortOrder !== undefined) updateData.sortOrder = Number(data.sortOrder || 0);

    const updated = await prisma.knowledgeArticle.update({ where: { id }, data: updateData });
    cache.invalidate('kb:list:');
    return updated;
  },

  async delete(id, { tenantId }) {
    const article = await prisma.knowledgeArticle.findFirst({
      where: { id, ...(tenantId ? { tenantId } : {}) }
    });
    if (!article) throw new NotFoundError('Article not found');
    await prisma.knowledgeArticle.delete({ where: { id } });
    cache.invalidate('kb:list:');
    return { ok: true };
  },

  async markHelpful(id) {
    await prisma.knowledgeArticle.update({
      where: { id },
      data: { helpfulCount: { increment: 1 } }
    });
    return { ok: true };
  },

  /**
   * Seed default articles for a tenant (first-time setup).
   */
  async seedDefaults({ tenantId, userId }) {
    const existing = await prisma.knowledgeArticle.count({
      where: tenantId ? { tenantId } : { tenantId: null }
    });
    if (existing > 0) return { seeded: 0 };

    const defaults = [
      { title: 'How to Check Out a Vehicle', slug: 'how-to-checkout', category: 'CHECKOUT', sortOrder: 1, body: '## Checkout Process\n\n1. Open the reservation in the Reservations page\n2. Click "Start Check-out"\n3. Verify customer ID and payment\n4. Complete the vehicle inspection (take photos)\n5. Hand over the keys and confirm\n\nThe system will automatically:\n- Create the rental agreement\n- Send the customer a confirmation email\n- Update the vehicle status to "Checked Out"\n- Start the billing period', tags: ['checkout', 'process', 'vehicle'] },
      { title: 'How to Check In a Vehicle', slug: 'how-to-checkin', category: 'CHECKIN', sortOrder: 2, body: '## Check-in Process\n\n1. Open the reservation and click "Check In"\n2. Complete the return inspection (compare with checkout photos)\n3. Note fuel level and mileage\n4. Calculate any additional charges (late return, fuel, damage)\n5. Process final payment\n6. Close the rental agreement\n\nThe system will:\n- Update the vehicle status to "Available"\n- Generate the return receipt\n- Send the customer their receipt via email', tags: ['checkin', 'return', 'vehicle'] },
      { title: 'Handling Damage Disputes', slug: 'handling-damage-disputes', category: 'DISPUTES', sortOrder: 3, body: '## Dispute Resolution Steps\n\n1. Go to the Issue Center\n2. Find the incident linked to the trip\n3. Review checkout and checkin inspection photos side by side\n4. Check the chat transcript if available\n5. Make a liability decision based on evidence\n6. Process the charge or waive the claim\n\n**Tips:**\n- Always take clear photos at checkout and checkin\n- Inspection photos are your best evidence\n- The chat transcript can show if damage was discussed', tags: ['dispute', 'damage', 'claims'] },
      { title: 'Processing Toll Charges', slug: 'processing-toll-charges', category: 'TOLLS', sortOrder: 4, body: '## Toll Management\n\n1. Go to the Tolls module\n2. Import toll transactions from your toll provider\n3. The system will auto-match tolls to reservations based on vehicle plate and dates\n4. Review matched and unmatched tolls\n5. Manually assign any unmatched transactions\n6. Bill the customer for toll charges\n\n**Auto-match logic:**\n- Matches by plate number + transaction date within reservation window\n- Handles vehicle swaps during the reservation period', tags: ['tolls', 'billing', 'charges'] },
      { title: 'Car Sharing Trip Workflow', slug: 'car-sharing-trip-workflow', category: 'CAR_SHARING', sortOrder: 5, body: '## Car Sharing Trip Flow\n\n1. Guest books a listing on the website\n2. Trip is created in PENDING_APPROVAL or CONFIRMED status\n3. Trip chat room is automatically created\n4. Host and guest coordinate pickup via chat\n5. Host confirms vehicle is ready\n6. Guest picks up the vehicle\n7. Trip moves to IN_PROGRESS\n8. Guest returns the vehicle\n9. Trip moves to COMPLETED\n10. Review requests are sent to the guest\n\n**Hot buttons in chat:**\n- Guest: "I\'m at pickup", "I\'m at return", "Running late"\n- Host: "Vehicle ready", "Inspection done"', tags: ['car-sharing', 'trip', 'workflow'] },
      { title: 'Payment Processing Guide', slug: 'payment-processing', category: 'PAYMENTS', sortOrder: 6, body: '## Payment Methods\n\n### Authorize.Net\n- Primary payment gateway for hosted payments\n- Supports saved cards and security deposit holds\n\n### iPOSPays/SPIn Terminal\n- Physical terminal processing via SPIn REST API\n- Sale, auth/capture, void, refund supported\n- Card-on-file tokenization available\n\n### Payment Flow\n1. Customer receives payment link via email/SMS\n2. Customer enters card details on hosted payment page\n3. Payment is processed and recorded\n4. Receipt is sent automatically\n\n**Security deposits** are held as auth-only transactions and captured or voided at return.', tags: ['payments', 'billing', 'gateway'] },
    ];

    await prisma.knowledgeArticle.createMany({
      data: defaults.map((d) => ({ ...d, tenantId: tenantId || null, createdBy: userId || null }))
    });

    return { seeded: defaults.length };
  }
};
