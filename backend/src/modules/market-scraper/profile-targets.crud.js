/**
 * CRUD for a profile's per-brand targets — the panel's half (2026-09-09).
 *
 * Kept apart from `profile-targets.service.js` on purpose: that module is read
 * by the money path on every auto-apply run and should stay small and pure of
 * request handling. This one only ever runs behind a person clicking.
 *
 * Every id that arrives off the wire is re-checked against the caller's tenant.
 * A target is a pointer at a Rate whose prices go live on a portal, so "the
 * client sent it" is not evidence that the client may have it.
 */

import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { resolveProfileTargets, assertTargetIsUnique } from './profile-targets.service.js';

/** The strategies a target may name. NULL means "inherit the profile's". */
export const STRATEGIES = Object.freeze([
  'CHEAPEST_MINUS_AMOUNT', 'MATCH_CHEAPEST', 'CHEAPEST_PLUS_PCT', 'STATIC_FLOOR',
]);

function fail(msg, status) {
  const e = new Error(msg);
  e.httpStatus = status;
  throw e;
}

/** A profile, checked against the caller's tenant. 404s rather than leaking one. */
async function loadProfile(db, profileId, scope) {
  const where = { id: profileId };
  if (scope?.tenantId) where.tenantId = scope.tenantId;
  const profile = await db.marketScrapeProfile.findFirst({
    where,
    select: {
      id: true, tenantId: true, name: true, locationCode: true, targetRateId: true,
      autoApply: true, strategy: true, strategyAmount: true, strategyPct: true, strategyFloor: true,
    },
  });
  if (!profile) fail('Profile not found', 404);
  return profile;
}

/**
 * The sedes a profile's airport code covers.
 *
 * `MarketScrapeProfile.locationCode` is the AIRPORT ("LAX"); `Location.code` is
 * the sede ("LAXA01"). Usually equal, which is why the difference stayed
 * invisible until LAX. Both shapes are accepted so the Rate picker offers the
 * right rates either way.
 */
export async function locationsForProfile(db, profile) {
  const code = String(profile?.locationCode || '').trim().toUpperCase();
  if (!code) return [];
  const all = await db.location.findMany({
    where: { tenantId: profile.tenantId, isActive: true },
    select: { id: true, code: true, name: true },
  });
  return all.filter((l) => {
    const c = String(l.code || '').trim().toUpperCase();
    return c === code || c.startsWith(code);
  });
}

/**
 * Everything the panel needs for one profile: its targets, the brands it could
 * write for, the Rates it could write to, and — importantly — what the engine
 * would ACTUALLY do right now, legacy fallback included, so the panel never has
 * to reproduce that rule and get it subtly wrong.
 */
export async function listProfileTargets(profileId, { scope = {}, prisma: client } = {}) {
  const db = client || defaultPrisma;
  const profile = await loadProfile(db, profileId, scope);

  const [rows, franchises, locations] = await Promise.all([
    db.marketScrapeProfileTarget.findMany({
      where: { profileId: profile.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, franchiseId: true, rateId: true, autoApply: true, active: true,
        strategy: true, strategyAmount: true, strategyPct: true, strategyFloor: true,
        franchise: { select: { code: true, name: true } },
        rate: { select: { rateCode: true, name: true, locationId: true, franchiseId: true } },
      },
    }),
    db.franchise.findMany({
      where: { tenantId: profile.tenantId, isActive: true },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    }),
    locationsForProfile(db, profile),
  ]);

  const rates = locations.length
    ? await db.rate.findMany({
      where: {
        tenantId: profile.tenantId,
        locationId: { in: locations.map((l) => l.id) },
        active: true,
      },
      select: { id: true, rateCode: true, name: true, locationId: true, franchiseId: true },
      orderBy: { rateCode: 'asc' },
    })
    : [];

  return {
    profile,
    effective: await resolveProfileTargets(profile, { prisma: db }),
    targets: rows,
    franchises,
    locations,
    rates,
    strategies: STRATEGIES,
  };
}

function normalizeBody(body = {}) {
  const out = {};
  if ('franchiseId' in body) out.franchiseId = body.franchiseId || null;
  if ('rateId' in body) out.rateId = body.rateId || null;
  if ('autoApply' in body) out.autoApply = Boolean(body.autoApply);
  if ('active' in body) out.active = Boolean(body.active);
  if ('strategy' in body) {
    const s = body.strategy || null;
    if (s && !STRATEGIES.includes(s)) fail(`Unknown strategy: ${s}`, 400);
    out.strategy = s;
  }
  for (const k of ['strategyAmount', 'strategyPct', 'strategyFloor']) {
    if (!(k in body)) continue;
    const raw = body[k];
    // Empty means "inherit the profile", which is NOT the same as zero — an
    // amount of 0 turns "cheapest minus a dollar" into "match the cheapest".
    if (raw === '' || raw === null || raw === undefined) { out[k] = null; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n)) fail(`${k} must be a number`, 400);
    if (n < 0) fail(`${k} cannot be negative`, 400);
    out[k] = n;
  }
  return out;
}

/** Both ids must belong to the caller's tenant — never trust them off the wire. */
async function assertOwned(db, profile, data) {
  if (data.rateId) {
    const rate = await db.rate.findFirst({
      where: { id: data.rateId, tenantId: profile.tenantId }, select: { id: true },
    });
    if (!rate) fail('That rate does not belong to this tenant', 400);
  }
  if (data.franchiseId) {
    const f = await db.franchise.findFirst({
      where: { id: data.franchiseId, tenantId: profile.tenantId }, select: { id: true },
    });
    if (!f) fail('That franchise does not belong to this tenant', 400);
  }
}

export async function createProfileTarget(profileId, body, { scope = {}, prisma: client } = {}) {
  const db = client || defaultPrisma;
  const profile = await loadProfile(db, profileId, scope);
  const data = normalizeBody(body);
  if (!data.rateId) fail('rateId is required — a target with no rate writes nowhere', 400);
  await assertOwned(db, profile, data);
  await assertTargetIsUnique(profile.id, data.franchiseId ?? null, data.rateId, { prisma: db });
  return db.marketScrapeProfileTarget.create({
    data: { ...data, profileId: profile.id, franchiseId: data.franchiseId ?? null },
  });
}

export async function updateProfileTarget(targetId, body, { scope = {}, prisma: client } = {}) {
  const db = client || defaultPrisma;
  const existing = await db.marketScrapeProfileTarget.findFirst({
    where: { id: targetId }, select: { id: true, profileId: true, franchiseId: true, rateId: true },
  });
  if (!existing) fail('Target not found', 404);
  const profile = await loadProfile(db, existing.profileId, scope);
  const data = normalizeBody(body);
  if ('rateId' in data && !data.rateId) fail('rateId cannot be cleared — delete the target instead', 400);
  await assertOwned(db, profile, data);
  // Re-check whenever EITHER half of the identity moves — changing only the rate
  // can collide just as easily as changing only the brand.
  const nextFranchise = 'franchiseId' in data ? (data.franchiseId ?? null) : (existing.franchiseId ?? null);
  const nextRate = 'rateId' in data ? data.rateId : existing.rateId;
  if (nextFranchise !== (existing.franchiseId ?? null) || nextRate !== existing.rateId) {
    await assertTargetIsUnique(profile.id, nextFranchise, nextRate, { prisma: db, ignoreId: existing.id });
  }
  return db.marketScrapeProfileTarget.update({ where: { id: existing.id }, data });
}

export async function deleteProfileTarget(targetId, { scope = {}, prisma: client } = {}) {
  const db = client || defaultPrisma;
  const existing = await db.marketScrapeProfileTarget.findFirst({
    where: { id: targetId }, select: { id: true, profileId: true },
  });
  if (!existing) return { ok: true, deleted: 0 };
  await loadProfile(db, existing.profileId, scope); // tenant check
  await db.marketScrapeProfileTarget.delete({ where: { id: existing.id } });
  return { ok: true, deleted: 1 };
}
