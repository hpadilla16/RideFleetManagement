import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';

/**
 * Public booking website tenant scoping via the `X-Tenant-Token` header (2026-06-24).
 * Plan: doc/public-website-token-scoping-plan-2026-06-24.md
 *
 * The public booking site (Rent & Go by VPH Motors) sends a server-only shared secret
 * on EVERY /api/public/booking request. We store only the sha256 hash on Tenant
 * (websiteTokenHash); here we hash the header and resolve the tenant.
 *
 * Design (backward-compatible + fail-closed):
 *   - Header ABSENT  → next() unchanged → existing ?tenantSlug resolution still serves
 *     other clients (the Flutter guest app, etc.). The site never sends a slug, so a
 *     site request WITHOUT the token resolves no tenant → empty (fail-closed).
 *   - Header PRESENT + valid → FORCE the tenant: overwrite req.query/req.body tenantId
 *     and strip any tenantSlug, so every downstream endpoint scopes to THIS tenant only
 *     (a caller can't pass a different slug). Also exposes req.publicTokenTenant.
 *   - Header PRESENT + invalid → 401 (never falls through to data).
 */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export async function resolvePublicTenantToken(req, res, next) {
  try {
    const raw = req.headers['x-tenant-token'];
    const token = (Array.isArray(raw) ? raw[0] : raw) || '';
    if (!String(token).trim()) return next(); // no token → legacy slug behavior

    const tenant = await prisma.tenant.findFirst({
      where: { websiteTokenHash: sha256(String(token).trim()), status: 'ACTIVE' },
      select: { id: true, slug: true, name: true, companyLogoUrl: true }
    });
    if (!tenant) {
      return res.status(401).json({ error: 'Invalid tenant token' });
    }

    req.publicTokenTenantId = tenant.id;
    req.publicTokenTenant = tenant;
    // Force downstream tenant resolution to this tenant (Express 4 query/body are mutable).
    if (req.query && typeof req.query === 'object') {
      req.query.tenantId = tenant.id;
      delete req.query.tenantSlug;
    }
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      req.body.tenantId = tenant.id;
      delete req.body.tenantSlug;
    }
    return next();
  } catch (err) {
    // Fail-closed: any error while a token was supplied → 401, never serve data.
    return res.status(401).json({ error: 'Tenant token resolution failed' });
  }
}
