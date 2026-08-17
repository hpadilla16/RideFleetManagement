import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../../lib/prisma.js';
import { getJwtExpiresIn, getJwtSecret } from './auth.config.js';
import { getEffectiveModuleAccessForUser } from '../../lib/module-access.js';
import { cache } from '../../lib/cache.js';
import { globalKey } from '../../lib/cache/tenantKey.js';

// 30s TTL bounds cross-worker staleness: role/module-access invalidations only
// clear the current worker's cache, so siblings keep stale permissions until TTL expires.
// 30s is short enough that a demoted user can't retain admin rights for long, and the
// extra user-table lookups are negligible (primary-key reads on an indexed column).
// Revisit when Redis is added — see docs/SCALING_ROADMAP.md.
const SESSION_CACHE_TTL_MS = 30 * 1000;

const LOCK_PIN_SALT_ROUNDS = 10;

function signToken(user, options = {}) {
  const claims = { sub: user.id, email: user.email, role: user.role, tenantId: user.tenantId || null };
  // VozIA Fase 3 (2026-07-03): service accounts carry svc + tv (tokenVersion)
  // claims so requireAuth can enforce the allowlist + one-shot revocation.
  // Only added for service accounts — human JWTs stay byte-compatible.
  if (user.isServiceAccount) {
    claims.svc = true;
    claims.tv = user.tokenVersion ?? 0;
  }
  return jwt.sign(claims, getJwtSecret(), { expiresIn: options.expiresIn || getJwtExpiresIn() });
}

/**
 * Ride University practice mode (2026-08-16): a short-lived token for the
 * shared practice user on the DEMO tenant. Exported narrowly so signToken
 * itself stays private — callers hand over a user ROW, never claims. Four
 * hours: long enough to rehearse a full counter cycle, short enough that a
 * forgotten kiosk tab does not stay signed into anything overnight.
 */
export function issueTrainingPracticeToken(user, { forUserId = null, forTenantId = null } = {}) {
  // `prac: true` is the security model (QA, 2026-08-16): /auth/refresh refuses
  // it (so 4h means 4h — AuthGate's silent refresh cannot stretch it to the
  // 12h default) and /training/practice-session refuses it (a practice session
  // cannot mint further practice sessions). Without the claim, a copied token
  // was renewable forever and survived offboarding.
  //
  // `pracFor` / `pracTenant` name the REAL trainee behind the practice user,
  // so what they do in the demo lands on THEIR training record (Hector,
  // 2026-08-17: practice is the learning environment, it should count).
  const claims = {
    sub: user.id, email: user.email, role: user.role, tenantId: user.tenantId || null,
    prac: true, pracFor: forUserId, pracTenant: forTenantId,
  };
  return jwt.sign(claims, getJwtSecret(), { expiresIn: '4h' });
}

// VozIA Fase 3 (2026-07-03) — service-token expiry policy. Default 90d,
// hard cap 365d. Pure + exported for unit tests. Accepts vercel/ms-style
// "<n>s|m|h|d" strings or bare digits (seconds, per jsonwebtoken).
export const SERVICE_TOKEN_DEFAULT_EXPIRES_IN = '90d';
export const SERVICE_TOKEN_MAX_EXPIRES_IN = '365d';
const SERVICE_TOKEN_MAX_MS = 365 * 24 * 60 * 60 * 1000;
const EXPIRES_IN_UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

export function clampServiceTokenExpiresIn(expiresIn) {
  if (expiresIn === undefined || expiresIn === null || String(expiresIn).trim() === '') {
    return SERVICE_TOKEN_DEFAULT_EXPIRES_IN;
  }
  const raw = String(expiresIn).trim();
  const match = raw.match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!match) throw new Error('Invalid expiresIn — use e.g. "30d", "12h", "90d"');
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const ms = amount * EXPIRES_IN_UNIT_MS[unit];
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('Invalid expiresIn — must be a positive duration');
  if (ms > SERVICE_TOKEN_MAX_MS) return SERVICE_TOKEN_MAX_EXPIRES_IN;
  return `${amount}${match[2] ? unit : 's'}`;
}

// Guest JWTs are issued at magic-link redeem time so native mobile clients
// (see the ride-fleet-car-sharing-app repo) can treat the redeem as a
// sign-in completion. They're signed against the same secret as User JWTs
// but carry role='GUEST' + customerId claim; middleware/auth.js treats
// role='GUEST' as unauthenticated for internal routes (only public-booking
// endpoints that already accept magic-link tokens are reachable with it),
// so there's no path-escalation risk. Expiry is tied to the magic-link
// window so a new magic link resets the clock.
const GUEST_JWT_EXPIRES_IN = '7d';

function signGuestToken(customer) {
  return jwt.sign(
    {
      sub: customer.id,
      customerId: customer.id,
      email: customer.email || null,
      role: 'GUEST',
      tenantId: customer.tenantId || null
    },
    getJwtSecret(),
    { expiresIn: GUEST_JWT_EXPIRES_IN }
  );
}

// Parse User.locationIds (JSON array string) → array of ids, or null = ALL locations.
function parseLocationIds(raw) {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) return arr.map((x) => String(x));
  } catch { /* malformed → treat as all */ }
  return null;
}

async function buildSessionUser(user) {
  if (!user) return null;
  const moduleAccess = await getEffectiveModuleAccessForUser(user);
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    tenantId: user.tenantId || null,
    createdByUserId: user.createdByUserId || null,
    hostProfileId: user.hostProfileId || user.hostProfile?.id || null,
    screenLockExempt: !!user.screenLockExempt,
    locationIds: parseLocationIds(user.locationIds),
    // Program scoping (2026-07-02): raw enum value (RENTAL_ONLY | LOANER_ONLY
    // | BOTH). Consumers resolve the ADMIN/SUPER_ADMIN bypass via
    // userProgramScope() in lib/tenant-scope.js — same split as locationIds.
    programScope: user.programScope || 'BOTH',
    // VozIA Fase 3 (2026-07-03): exposed so requireAuth can enforce the
    // service-account allowlist + tv revocation check on hydrated sessions.
    isServiceAccount: !!user.isServiceAccount,
    tokenVersion: user.tokenVersion ?? 0,
    // First-login onboarding (2026-07-25): requireAuth gates on this and the
    // frontend AuthGate renders the forced-change screen while it is true.
    mustChangePassword: !!user.mustChangePassword,
    moduleAccess: moduleAccess.effective,
    tenantModuleAccess: moduleAccess.tenantConfig,
    userModuleAccess: moduleAccess.userConfig
  };
}

export const authService = {
  issueTokenForUser(user) {
    return signToken(user);
  },

  issueGuestToken(customer) {
    return signGuestToken(customer);
  },

  guestJwtExpiresIn() {
    return GUEST_JWT_EXPIRES_IN;
  },

  async getSessionUser(userId) {
    // session:<userId> is intentionally GLOBAL — user sessions span tenants
    // (SUPER_ADMIN spans all, regular users have a tenantId on the row already).
    return cache.getOrSet(globalKey('session', userId), async () => {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          tenantId: true,
          createdByUserId: true,
          isActive: true,
          screenLockExempt: true,
          locationIds: true,
          programScope: true,
          isServiceAccount: true,
          tokenVersion: true,
          mustChangePassword: true,
          hostProfile: { select: { id: true } }
        }
      });
      if (!user || !user.isActive) return null;
      return buildSessionUser(user);
    }, SESSION_CACHE_TTL_MS);
  },

  invalidateSessionCache(userId) {
    if (userId) cache.del(globalKey('session', userId));
  },

  // VozIA Fase 3 (2026-07-03) — mint a long-lived token for a service account
  // (SUPER_ADMIN-gated at the route). Target must be an ACTIVE service
  // account; expiry defaults to 90d and is clamped at 365d. `deps.prisma` is
  // injectable for unit tests (same pattern as createTenantRateLimit).
  async issueServiceToken({ userId, expiresIn } = {}, deps = {}) {
    const db = deps.prisma || prisma;
    const user = await db.user.findUnique({
      where: { id: String(userId || '') },
      select: {
        id: true, email: true, role: true, tenantId: true,
        isActive: true, isServiceAccount: true, tokenVersion: true
      }
    });
    if (!user || !user.isServiceAccount) throw new Error('Target user is not a service account');
    if (!user.isActive) throw new Error('Target service account is not active');
    const effectiveExpiresIn = clampServiceTokenExpiresIn(expiresIn);
    const token = signToken(user, { expiresIn: effectiveExpiresIn });
    return {
      token,
      expiresIn: effectiveExpiresIn,
      userId: user.id,
      email: user.email,
      tokenVersion: user.tokenVersion ?? 0
    };
  },

  // VozIA Fase 3 (2026-07-03) — revoke ALL outstanding tokens for a service
  // account by bumping tokenVersion; requireAuth rejects any token whose tv
  // claim no longer matches. Session cache invalidation mirrors
  // invalidateSessionCache above (per-worker; siblings converge within the
  // 30s SESSION_CACHE_TTL_MS — see header comment).
  async revokeServiceTokens(userId, deps = {}) {
    const db = deps.prisma || prisma;
    const user = await db.user.findUnique({
      where: { id: String(userId || '') },
      select: { id: true, isServiceAccount: true }
    });
    if (!user || !user.isServiceAccount) throw new Error('Target user is not a service account');
    const updated = await db.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true }
    });
    cache.del(globalKey('session', user.id));
    return { ok: true, userId: user.id, tokenVersion: updated.tokenVersion };
  },

  async refreshToken(userId) {
    cache.del(globalKey('session', userId));
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { hostProfile: { select: { id: true } } }
    });
    if (!user || !user.isActive) throw new Error('User not found or inactive');
    const token = signToken(user);
    return { token, user: await buildSessionUser(user) };
  },

  async register({ email, password, fullName, tenantId }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) throw new Error('Email already registered');

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        fullName,
        role: 'AGENT',
        tenantId: tenantId || null,
        // Self-registration = the user chose this password themselves.
        passwordChangedAt: new Date()
      }
    });

    const token = signToken(user);
    return { token, user: await buildSessionUser(user) };
  },

  async login({ email, password }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { hostProfile: { select: { id: true } } }
    });
    if (!user || !user.isActive) throw new Error('Invalid credentials');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new Error('Invalid credentials');

    const token = signToken(user);
    return { token, user: await buildSessionUser(user) };
  },

  // First-login onboarding (2026-07-25). Self-service password change — the
  // ONLY endpoint that clears mustChangePassword. Requires the current
  // password even mid-forced-flow: a walked-away unlocked session must not
  // let a passerby take over the account. Re-issues the JWT and busts the
  // session cache so the requireAuth gate lifts immediately on this worker
  // (siblings converge within SESSION_CACHE_TTL_MS, same as every other
  // session mutation).
  async changePassword({ userId, currentPassword, newPassword }) {
    const user = await prisma.user.findUnique({
      where: { id: String(userId || '') },
      include: { hostProfile: { select: { id: true } } }
    });
    if (!user || !user.isActive) throw new Error('User not found or inactive');
    if (user.isServiceAccount) throw new Error('Service accounts cannot change passwords');

    const ok = await bcrypt.compare(String(currentPassword || ''), user.passwordHash);
    if (!ok) throw new Error('Current password is incorrect');
    if (String(currentPassword) === String(newPassword)) {
      throw new Error('New password must be different from the current password');
    }

    const passwordHash = await bcrypt.hash(String(newPassword), 10);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: new Date()
      },
      include: { hostProfile: { select: { id: true } } }
    });

    cache.del(globalKey('session', user.id));
    const token = signToken(updated);
    return { token, user: await buildSessionUser(updated) };
  },

  async listUsers(scope = {}) {
    const rows = await prisma.user.findMany({
      where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
      orderBy: [{ role: 'asc' }, { fullName: 'asc' }, { email: 'asc' }],
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        tenantId: true,
        createdByUserId: true,
        lockPinHash: true,
        lockPinUpdatedAt: true,
        screenLockExempt: true
      }
    });

    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      fullName: row.fullName,
      name: row.fullName,
      role: row.role,
      isActive: row.isActive,
      tenantId: row.tenantId || null,
      createdByUserId: row.createdByUserId || null,
      hasLockPin: !!row.lockPinHash,
      lockPinUpdatedAt: row.lockPinUpdatedAt || null,
      screenLockExempt: !!row.screenLockExempt
    }));
  },

  // 2026-06-04 — per-user idle screen-lock exemption (ops/reporting agent
  // accounts). ADMIN-gated at the route; additive, default remains false.
  async setScreenLockExempt(userId, exempt, scope = {}) {
    const where = { id: userId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) };
    const user = await prisma.user.findFirst({ where, select: { id: true } });
    if (!user) throw new Error('User not found');
    await prisma.user.update({
      where: { id: user.id },
      data: { screenLockExempt: !!exempt }
    });
    cache.del(globalKey('session', user.id));
    return { ok: true, screenLockExempt: !!exempt };
  },

  async setLockPin(userId, pin, scope = {}) {
    const normalizedPin = String(pin || '').trim();
    if (normalizedPin.length < 4) throw new Error('PIN must be at least 4 characters');

    const current = await prisma.user.findFirst({
      where: { id: userId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true }
    });
    if (!current) throw new Error('User not found');

    const lockPinHash = await bcrypt.hash(normalizedPin, LOCK_PIN_SALT_ROUNDS);
    await prisma.user.update({
      where: { id: userId },
      data: { lockPinHash, lockPinUpdatedAt: new Date() }
    });

    return { ok: true, hasPin: true };
  },

  async verifyLockPin(userId, pin, scope = {}) {
    const user = await prisma.user.findFirst({
      where: { id: userId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { lockPinHash: true, lockPinUpdatedAt: true }
    });
    // Machine-readable `code` on each throw (2026-07-06, kiosk B3c review):
    // the kiosk staff-assist dispatch keys on it instead of regexing the
    // message. Messages and status semantics are UNCHANGED — the property
    // is additive.
    if (!user) {
      const err = new Error('User not found');
      err.code = 'USER_NOT_FOUND';
      throw err;
    }
    if (!user.lockPinHash) {
      const err = new Error('PIN not set');
      err.code = 'NO_PIN_SET';
      throw err;
    }

    const ok = await bcrypt.compare(String(pin || ''), user.lockPinHash);
    if (!ok) {
      const err = new Error('Invalid PIN');
      err.code = 'INVALID_PIN';
      throw err;
    }
    return { ok: true, hasPin: true, lockPinUpdatedAt: user.lockPinUpdatedAt || null };
  },

  async resetLockPin(userId, scope = {}) {
    const current = await prisma.user.findFirst({
      where: { id: userId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true }
    });
    if (!current) throw new Error('User not found');

    await prisma.user.update({
      where: { id: userId },
      data: { lockPinHash: null, lockPinUpdatedAt: null }
    });

    return { ok: true, hasPin: false };
  },

  async lockPinStatus(userId, scope = {}) {
    const user = await prisma.user.findFirst({
      where: { id: userId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { lockPinHash: true, lockPinUpdatedAt: true }
    });
    if (!user) throw new Error('User not found');
    return { hasPin: !!user.lockPinHash, lockPinUpdatedAt: user.lockPinUpdatedAt || null };
  }
};
