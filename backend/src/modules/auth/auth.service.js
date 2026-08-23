import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../../lib/prisma.js';
import { getJwtExpiresIn, getJwtSecret } from './auth.config.js';
import { getEffectiveModuleAccessForUser } from '../../lib/module-access.js';
import { cache } from '../../lib/cache.js';
import { globalKey } from '../../lib/cache/tenantKey.js';
import logger from '../../lib/logger.js';
import {
  resolveTwoFactorPolicy,
  requiresTwoFactor,
  isEnforcementKilled
} from '../../lib/two-factor-policy.js';
import { twoFactorService } from './two-factor.service.js';

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
  // Wave 3 (2026-08-24): impersonation traceability. `imp` names the super-admin
  // operating behind an impersonated session; middleware/auth.js surfaces it on
  // req.user.imp so every audited action carries WHO is really acting. CONDITIONAL,
  // exactly like svc/tv/mfa/prac — absent for a normal login, so a
  // non-impersonation token stays BYTE-IDENTICAL to before this change.
  if (options.impersonatedBy) {
    claims.imp = options.impersonatedBy;
  }
  return jwt.sign(claims, getJwtSecret(), { expiresIn: options.expiresIn || getJwtExpiresIn() });
}

// Staff 2FA (2026-08-22): a SHORT-LIVED challenge token issued between the
// password step and the TOTP step. It carries `mfa: 'VERIFY' | 'ENROLL'` — the
// SAME conditional-claim pattern as svc/prac above, so human non-2FA JWTs stay
// byte-compatible. requireAuth's TWO_FACTOR_PENDING_ALLOWLIST restricts a token
// bearing this claim to only the verify-login + enroll endpoints + /me;
// /refresh refuses it (like prac) so it can't be stretched past its 5m life.
function signPendingToken(user, mode) {
  const claims = {
    sub: user.id,
    email: user.email,
    role: user.role,
    tenantId: user.tenantId || null,
    mfa: mode === 'ENROLL' ? 'ENROLL' : 'VERIFY'
  };
  return jwt.sign(claims, getJwtSecret(), { expiresIn: '5m' });
}

/**
 * Pure 2FA login decision — SINGLE source of truth for which of the three
 * outcomes a password-verified login takes. Exported so the login-branch tests
 * can exercise every path without a database.
 *
 *   'FULL'   → issue the full session token exactly as before (no challenge).
 *   'VERIFY' → already-enrolled user must present a live TOTP/backup code.
 *   'ENROLL' → policy compels this role but the user isn't enrolled yet.
 *
 * Order is load-bearing:
 *   1. kill-switch wins over everything (instant prod recovery, even enrolled).
 *   2. an enrolled user always verifies (independent of policy).
 *   3. otherwise the policy decides; a disabled/absent policy ⇒ 'FULL'.
 */
export function loginTwoFactorOutcome({ user, policy, killed }) {
  if (killed) return 'FULL';
  if (user?.twoFactorEnabled) return 'VERIFY';
  if (requiresTwoFactor(user, policy)) return 'ENROLL';
  return 'FULL';
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
    // Staff 2FA (2026-08-22): non-secret status for the UI (Security settings +
    // /me). The secret itself is never loaded here.
    twoFactorEnabled: !!user.twoFactorEnabled,
    twoFactorEnrolledAt: user.twoFactorEnrolledAt || null,
    moduleAccess: moduleAccess.effective,
    tenantModuleAccess: moduleAccess.tenantConfig,
    userModuleAccess: moduleAccess.userConfig
  };
}

export const authService = {
  issueTokenForUser(user) {
    return signToken(user);
  },

  // Wave 3 (2026-08-24): mint a session token for `user` that CARRIES the
  // impersonation marker — the super-admin id in `impersonatedBy` lands in the
  // token's conditional `imp` claim. Kept separate from issueTokenForUser so a
  // normal login path can never accidentally stamp `imp`, and so the normal
  // token stays byte-compatible. `impersonatedBy` falsy ⇒ a plain token.
  issueImpersonationToken(user, { impersonatedBy } = {}) {
    return signToken(user, { impersonatedBy });
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
          // Staff 2FA (2026-08-22): non-secret status only — NEVER select
          // twoFactorSecret / twoFactorPendingSecret into a session.
          twoFactorEnabled: true,
          twoFactorEnrolledAt: true,
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

    // ── Staff 2FA (2026-08-22) — SURGICAL, order matters. ──────────────────
    // The decision is a pure function (loginTwoFactorOutcome, exported + unit-
    // tested for every branch). We resolve the tenant policy ONLY when it can
    // actually change the outcome — i.e. not killed and not already enrolled —
    // so the enrolled/killed short-circuits cost no settings read.
    const killed = isEnforcementKilled();
    let policy = null;
    if (!killed && !user.twoFactorEnabled) {
      // FAIL OPEN (QA, 2026-08-22): a DB/settings read that THROWS must never
      // propagate out of login() — that would 401 every non-enrolled user
      // (mass lockout). resolveTwoFactorPolicy already swallows JSON.parse
      // errors, but a connection/query failure would escape; on ANY failure we
      // treat the policy as absent (⇒ 'FULL', password-only) rather than deny.
      // An enrolled user never reaches here, so their challenge is unaffected.
      try {
        policy = await resolveTwoFactorPolicy(user.tenantId || null);
      } catch (e) {
        logger.warn('[auth] 2FA policy resolution failed — failing open (password-only)', {
          userId: user.id, error: e?.message
        });
        policy = null;
      }
    }
    const outcome = loginTwoFactorOutcome({ user, policy, killed });
    if (outcome === 'VERIFY') {
      return { mfaRequired: true, mode: 'VERIFY', challengeToken: signPendingToken(user, 'VERIFY') };
    }
    if (outcome === 'ENROLL') {
      return { mfaRequired: true, mode: 'ENROLL', challengeToken: signPendingToken(user, 'ENROLL') };
    }
    // outcome === 'FULL' — the zero-behavior-change path: no policy + kill-switch
    // off ⇒ byte-identical login to before this feature.
    // ───────────────────────────────────────────────────────────────────────

    const token = signToken(user);
    return { token, user: await buildSessionUser(user) };
  },

  // Staff 2FA (2026-08-22) — second leg of login. The client presents the
  // short-lived challenge token (VERIFY mode) plus a TOTP code OR a single-use
  // backup code. On success we mint the FULL token via the existing signToken,
  // so downstream is identical to a password-only login. The session cache is
  // busted so the fresh session hydrates immediately on this worker.
  async verifyLogin({ userId, code }) {
    const user = await prisma.user.findUnique({
      where: { id: String(userId || '') },
      include: { hostProfile: { select: { id: true } } }
    });
    if (!user || !user.isActive) throw new Error('Invalid credentials');
    if (!user.twoFactorEnabled) throw new Error('Two-factor authentication is not enabled for this account');
    const cleaned = String(code || '').trim();
    if (!cleaned) throw new Error('Authentication code is required');

    let ok = await twoFactorService.verifyCode(user.id, cleaned);
    if (!ok) ok = await twoFactorService.consumeBackupCode(user.id, cleaned);
    if (!ok) {
      const err = new Error('Invalid authentication code');
      err.code = 'INVALID_2FA_CODE';
      throw err;
    }

    cache.del(globalKey('session', user.id));
    const token = signToken(user);
    return { token, user: await buildSessionUser(user) };
  },

  // Staff 2FA (2026-08-22): confirm the caller's own password (self-service
  // disable requires it). Returns boolean; the caller has already passed
  // requireAuth, so this only gates the sensitive disable action.
  async verifyPassword({ userId, password }) {
    const user = await prisma.user.findUnique({
      where: { id: String(userId || '') },
      select: { passwordHash: true, isActive: true }
    });
    if (!user || !user.isActive || !user.passwordHash) return false;
    return bcrypt.compare(String(password || ''), user.passwordHash);
  },

  // Staff 2FA (2026-08-22): admin reset — wipe a user's 2FA secret + backup
  // codes + flags (via twoFactorService.disableFor) within the caller's tenant
  // scope, then bust the session cache so the cleared status hydrates. If the
  // tenant policy still requires the role, their next login re-enters ENROLL.
  async resetTwoFactorForUser(targetUserId, scope = {}) {
    const target = await prisma.user.findFirst({
      where: { id: String(targetUserId || ''), ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true }
    });
    if (!target) throw new Error('User not found');
    const out = await twoFactorService.disableFor(target.id);
    cache.del(globalKey('session', target.id));
    return out;
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
