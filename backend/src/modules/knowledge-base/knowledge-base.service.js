import { prisma } from '../../lib/prisma.js';
import { ValidationError, NotFoundError } from '../../lib/errors.js';
import { cache } from '../../lib/cache.js';
import { tenantKey, globalKey } from '../../lib/cache/tenantKey.js';
import { DEFAULT_ARTICLES, articlesMissingFrom } from './default-articles.js';

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
      // KB articles are either tenant-scoped (per-tenant overrides) or global
      // (the default knowledge corpus visible to tenants with no overrides).
      // Mirror that in the cache key.
      const cacheKey = tenantId
        ? tenantKey(tenantId, 'kb', 'list', category || 'all', status, page, limit)
        : globalKey('kb', 'list', category || 'all', status, page, limit);
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
      // KB articles are either tenant-scoped (per-tenant overrides) or global
      // (the default knowledge corpus visible to tenants with no overrides).
      // Mirror that in the cache key.
      const cacheKey = tenantId
        ? tenantKey(tenantId, 'kb', 'list', category || 'all', status, page, limit)
        : globalKey('kb', 'list', category || 'all', status, page, limit);
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
   * Put the default corpus in place for a scope, WITHOUT touching what is
   * already there.
   *
   * Per-article, on purpose (2026-08-28). The previous version counted the
   * scope's articles and bailed if there were any, so it could only ever run
   * once: every article added afterwards reached nobody who had already
   * seeded. Matching on slug instead means a new article lands for everyone
   * and an existing one is left alone — including one a tenant has edited,
   * which must never be overwritten by a deploy.
   *
   * @param {{tenantId: string|null, userId?: string|null}} scope
   */
  async seedDefaults({ tenantId, userId }) {
    const where = tenantId ? { tenantId } : { tenantId: null };
    const present = await prisma.knowledgeArticle.findMany({
      where, select: { slug: true },
    });
    const missing = articlesMissingFrom(present.map((a) => a.slug));
    if (missing.length === 0) return { seeded: 0 };

    await prisma.knowledgeArticle.createMany({
      data: missing.map((d) => ({ ...d, tenantId: tenantId || null, createdBy: userId || null })),
      // Belt and braces: (tenantId, slug) is unique, but Postgres does not
      // dedupe NULLs, so the GLOBAL corpus has no unique index protecting it.
      // Two workers booting together would otherwise both insert.
      skipDuplicates: true,
    });
    cache.invalidate('kb:list:');
    return { seeded: missing.length, slugs: missing.map((a) => a.slug) };
  },

  /**
   * Top up the platform-wide corpus at boot.
   *
   * This is what makes a written article deploy like a tour step instead of
   * waiting for somebody to press a button they will never see — the "Seed
   * defaults" button only renders for a scope with zero articles.
   *
   * Global (tenantId = null) only. Tenant overrides are somebody's deliberate
   * copy and are never created behind their back.
   */
  async ensureGlobalArticles() {
    return this.seedDefaults({ tenantId: null, userId: null });
  }
};
