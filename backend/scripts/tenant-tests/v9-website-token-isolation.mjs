import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { base, summary } from './_api.mjs';

// V9 — X-Tenant-Token public scoping (2026-06-24). The public booking site sends a
// server-only X-Tenant-Token; the backend must FORCE that tenant and never leak another.
// Asserts: valid token scopes to its tenant; a different ?tenantSlug can't override it;
// an invalid token fails closed (401); no token + no slug returns no tenant data.

const prisma = new PrismaClient();
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

async function getPublic(path, { token, slug } = {}) {
  const qs = slug ? (path.includes('?') ? '&' : '?') + 'tenantSlug=' + encodeURIComponent(slug) : '';
  const res = await fetch(base + path + qs, {
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Tenant-Token': token } : {}) }
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  const a = await prisma.tenant.findFirst({ where: { slug: 'beta-a' }, select: { id: true, websiteTokenHash: true } });
  const b = await prisma.tenant.findFirst({ where: { slug: 'beta-b' }, select: { id: true } });
  if (!a || !b) throw new Error('beta-a / beta-b tenants missing — run tenant-seed-beta first');

  const prevHash = a.websiteTokenHash ?? null;
  const tokenA = 'v9-' + crypto.randomBytes(24).toString('hex');
  await prisma.tenant.update({ where: { id: a.id }, data: { websiteTokenHash: sha256(tokenA) } });

  let results;
  try {
    const tokenNoSlug = await getPublic('/public/booking/website-fees', { token: tokenA });
    const tokenSlugB  = await getPublic('/public/booking/website-fees', { token: tokenA, slug: 'beta-b' });
    const badToken    = await getPublic('/public/booking/website-fees', { token: 'wrong-token-v9' });
    const noTokenSlug = await getPublic('/public/booking/website-fees', {});
    const bootstrapNoCtx = await getPublic('/public/booking/bootstrap', {});

    results = [
      { test: 'bootstrap with no token/slug -> fail-closed (empty roster + locations, never cross-tenant)',
        pass: (bootstrapNoCtx.data?.tenants?.length || 0) === 0 && (bootstrapNoCtx.data?.locations?.length || 0) === 0 },
      { test: 'valid token (no slug) -> scoped to tenant A',
        pass: tokenNoSlug.ok && tokenNoSlug.data?.tenantId === a.id },
      { test: 'valid token + ?tenantSlug=beta-b -> STILL tenant A (override), never B',
        pass: tokenSlugB.ok && tokenSlugB.data?.tenantId === a.id && tokenSlugB.data?.tenantId !== b.id },
      { test: 'invalid token -> 401 fail-closed',
        pass: badToken.status === 401 },
      { test: 'no token + no slug -> no tenant data (400/empty, never cross-tenant)',
        pass: noTokenSlug.status === 400 || (Array.isArray(noTokenSlug.data?.fees) && noTokenSlug.data.fees.length === 0) }
    ];

    console.log(JSON.stringify(summary('V9', results, {
      tokenNoSlugStatus: tokenNoSlug.status, tokenNoSlugTenant: tokenNoSlug.data?.tenantId,
      tokenSlugBTenant: tokenSlugB.data?.tenantId,
      badTokenStatus: badToken.status, noTokenStatus: noTokenSlug.status,
      tenantA: a.id, tenantB: b.id
    }), null, 2));
  } finally {
    await prisma.tenant.update({ where: { id: a.id }, data: { websiteTokenHash: prevHash } });
  }
}

main()
  .catch((e) => { console.error(JSON.stringify({ step: 'V9', error: String(e?.message || e) })); process.exit(1); })
  .finally(() => prisma.$disconnect());
