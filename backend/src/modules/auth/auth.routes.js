import { Router } from 'express';
import { authService } from './auth.service.js';
import { twoFactorService } from './two-factor.service.js';
import { isPublicRegisterEnabled } from './auth.config.js';
import { isSuperAdmin, requireAuth, requireRole } from '../../middleware/auth.js';
import { createPublicRateLimitGuard, attachPublicRequestMeta } from '../../middleware/public-endpoint-guards.js';
import logger from '../../lib/logger.js';

export const authRouter = Router();

const authRateLimit = [
  attachPublicRequestMeta('auth'),
  createPublicRateLimitGuard({ name: 'auth-login', maxRequests: 5, windowMs: 60 * 1000 })
];
const pinRateLimit = [
  attachPublicRequestMeta('auth-pin'),
  createPublicRateLimitGuard({ name: 'auth-pin', maxRequests: 5, windowMs: 60 * 1000 })
];

const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{12,}$/;

function validatePassword(password) {
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (!PASSWORD_REGEX.test(password)) {
    return 'Password must include uppercase, lowercase, a number, and a special character';
  }
  return null;
}

function scopeFor(req) {
  if (isSuperAdmin(req.user)) return {};
  return { tenantId: req.user?.tenantId || null };
}

authRouter.post('/register', authRateLimit, async (req, res) => {
  try {
    if (!isPublicRegisterEnabled()) {
      return res.status(403).json({ error: 'Public registration is disabled' });
    }
    const { email, password, fullName } = req.body || {};
    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'email, password, and fullName are required' });
    }
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    const result = await authService.register({ email, password, fullName });
    res.status(201).json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

authRouter.post('/login', authRateLimit, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    const result = await authService.login({ email, password });
    res.json(result);
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// First-login onboarding (2026-07-25). Reachable while the
// PASSWORD_CHANGE_REQUIRED gate is up (allowlisted in requireAuth). Enforces
// the same policy as /register; returns a fresh token so the client swaps
// its stored JWT and the gate lifts without re-login.
authRouter.post('/change-password', requireAuth, pinRateLimit, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    const pwError = validatePassword(newPassword);
    if (pwError) return res.status(400).json({ error: pwError });
    const result = await authService.changePassword({
      userId: req.user?.id || req.user?.sub,
      currentPassword,
      newPassword
    });
    logger.info('[auth] password changed', { userId: req.user?.id || req.user?.sub });
    res.json(result);
  } catch (e) {
    const msg = String(e?.message || '');
    if (/current password is incorrect|must be different/i.test(msg)) {
      return res.status(400).json({ error: msg });
    }
    if (/service accounts/i.test(msg)) return res.status(403).json({ error: msg });
    res.status(400).json({ error: msg || 'Unable to change password' });
  }
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    res.json({ user: req.user });
  } catch (e) {
    next(e);
  }
});

authRouter.post('/refresh', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) return res.status(401).json({ error: 'Invalid session' });
    // Practice sessions (Ride University) are hard-capped at their minted 4h:
    // refresh would silently convert them into 12h tokens, renewable forever.
    if (req.user?.prac) return res.status(403).json({ error: 'Practice sessions cannot be refreshed' });
    // Staff 2FA (2026-08-22): a pending challenge token must NOT be refreshable
    // into a longer-lived credential — it would sidestep the TOTP step. Mirror
    // the `prac` guard exactly.
    if (req.user?.mfa) return res.status(403).json({ error: 'Complete two-factor authentication before refreshing' });
    res.json(await authService.refreshToken(userId));
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// ── Staff 2FA (TOTP) — 2026-08-22 ─────────────────────────────────────────
// verify-login is the SECOND LEG of login. The client presents the pending
// VERIFY challenge token (allowlisted in requireAuth) plus a TOTP or backup
// code; on success we mint the full session token. authRateLimit throttles
// brute force, same as /login. `mfa` must be present — a full session has no
// business here.
authRouter.post('/2fa/verify-login', requireAuth, authRateLimit, async (req, res) => {
  try {
    if (!req.user?.mfa) return res.status(400).json({ error: 'No pending sign-in to verify' });
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code is required' });
    const result = await authService.verifyLogin({ userId: req.user.id || req.user.sub, code });
    logger.info('[auth] 2fa login verified', { userId: req.user.id || req.user.sub });
    res.json(result);
  } catch (e) {
    const msg = String(e?.message || '');
    if (/invalid authentication code/i.test(msg)) return res.status(401).json({ error: msg, code: 'INVALID_2FA_CODE' });
    res.status(401).json({ error: msg || 'Unable to verify code' });
  }
});

// enroll/start + enroll/verify are reachable by (a) a fully-authenticated user
// enabling 2FA from Settings, or (b) a pending-ENROLL login token (policy
// forces enrollment before first entry). A pending-VERIFY token (already
// enrolled) is explicitly refused so possession of the password alone cannot
// re-enroll a new device without the current code.
authRouter.post('/2fa/enroll/start', requireAuth, async (req, res) => {
  try {
    if (req.user?.mfa === 'VERIFY') return res.status(403).json({ error: 'Verify your current code before re-enrolling' });
    const userId = req.user?.id || req.user?.sub;
    const out = await twoFactorService.startEnrollment(userId, req.user?.email, 'Ride Fleet');
    // Never leak the raw secret in logs; the manual-entry secret goes to the
    // client only (for the "can't scan the QR" fallback).
    res.json({ otpauthUri: out.otpauthUri, qrDataUrl: out.qrDataUrl, secret: out.secret });
  } catch (e) {
    const msg = String(e?.message || '');
    if (/encryption key/i.test(msg)) return res.status(503).json({ error: msg });
    res.status(400).json({ error: msg || 'Unable to start enrollment' });
  }
});

authRouter.post('/2fa/enroll/verify', requireAuth, async (req, res) => {
  try {
    if (req.user?.mfa === 'VERIFY') return res.status(403).json({ error: 'Verify your current code before re-enrolling' });
    const userId = req.user?.id || req.user?.sub;
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code is required' });
    const out = await twoFactorService.verifyAndEnable(userId, code);
    logger.info('[auth] 2fa enrolled', { userId });
    // If this completed an ENROLL login (policy-forced), the caller still holds
    // only a pending token — hand back a full session so they enter the app in
    // one round trip. A Settings-driven enrollment already has a full session,
    // so we return just the backup codes.
    if (req.user?.mfa === 'ENROLL') {
      const session = await authService.refreshToken(userId);
      return res.json({ enabled: true, backupCodes: out.backupCodes, token: session.token, user: session.user });
    }
    res.json({ enabled: true, backupCodes: out.backupCodes });
  } catch (e) {
    const msg = String(e?.message || '');
    if (/invalid authentication code/i.test(msg)) return res.status(401).json({ error: msg, code: 'INVALID_2FA_CODE' });
    if (/encryption key/i.test(msg)) return res.status(503).json({ error: msg });
    if (/no pending/i.test(msg)) return res.status(400).json({ error: msg });
    res.status(400).json({ error: msg || 'Unable to verify enrollment' });
  }
});

authRouter.get('/2fa/status', requireAuth, async (req, res, next) => {
  try {
    res.json(await twoFactorService.status(req.user?.id || req.user?.sub));
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

authRouter.post('/2fa/backup-codes/regenerate', requireAuth, async (req, res) => {
  try {
    const out = await twoFactorService.regenerateBackupCodes(req.user?.id || req.user?.sub);
    logger.info('[auth] 2fa backup codes regenerated', { userId: req.user?.id || req.user?.sub });
    res.json(out);
  } catch (e) {
    const msg = String(e?.message || '');
    if (/not enabled/i.test(msg)) return res.status(400).json({ error: msg });
    res.status(400).json({ error: msg || 'Unable to regenerate backup codes' });
  }
});

// Self-service disable requires BOTH the account password AND a current code —
// a walked-away unlocked session must not be able to strip 2FA off the account.
authRouter.post('/2fa/disable', requireAuth, pinRateLimit, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.sub;
    const { password, code } = req.body || {};
    if (!password || !code) return res.status(400).json({ error: 'password and current code are required' });
    // Reuse changePassword's password check indirectly via a dedicated verify.
    const passwordOk = await authService.verifyPassword({ userId, password });
    if (!passwordOk) return res.status(401).json({ error: 'Password is incorrect' });
    let codeOk = await twoFactorService.verifyCode(userId, code);
    if (!codeOk) codeOk = await twoFactorService.consumeBackupCode(userId, code);
    if (!codeOk) return res.status(401).json({ error: 'Invalid authentication code', code: 'INVALID_2FA_CODE' });
    const out = await twoFactorService.disableFor(userId);
    logger.info('[auth] 2fa disabled (self-service)', { userId });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Unable to disable 2FA' });
  }
});

// Admin reset — clears a user's 2FA entirely. If tenant policy still requires
// their role, their next login re-enters the ENROLL flow (no manual step). No
// AuditLog row (its reservationId FK can't hold auth events); logger.info per
// the service-token precedent.
authRouter.post('/users/:id/reset-2fa', requireAuth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const out = await authService.resetTwoFactorForUser(req.params.id, scopeFor(req));
    logger.info('[auth] 2fa reset by admin', {
      targetUserId: req.params.id,
      actorUserId: req.user?.id || req.user?.sub || null
    });
    res.json(out);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// VozIA Fase 3 (2026-07-03) — mint / revoke long-lived tokens for service
// accounts (User.isServiceAccount). SUPER_ADMIN only. Mint/revoke events go
// to the app logger — AuditLog requires a reservationId, so it doesn't fit
// here. A service account itself can never reach these paths: the
// requireAuth allowlist gate 403s anything not explicitly allowed.
authRouter.post('/service-token', requireAuth, requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    const { userId, expiresIn } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const out = await authService.issueServiceToken({ userId, expiresIn });
    logger.info('[auth] service token minted', {
      targetUserId: out.userId,
      targetEmail: out.email,
      expiresIn: out.expiresIn,
      tokenVersion: out.tokenVersion,
      actorUserId: req.user?.id || req.user?.sub || null
    });
    res.status(201).json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

authRouter.post('/service-token/revoke', requireAuth, requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const out = await authService.revokeServiceTokens(userId);
    logger.info('[auth] service tokens revoked', {
      targetUserId: out.userId,
      tokenVersion: out.tokenVersion,
      actorUserId: req.user?.id || req.user?.sub || null
    });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

authRouter.get('/users', requireAuth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await authService.listUsers(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

authRouter.post('/users/:id/reset-lock-pin', requireAuth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await authService.resetLockPin(req.params.id, scopeFor(req)));
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

authRouter.post('/users/:id/screen-lock-exempt', requireAuth, requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await authService.setScreenLockExempt(req.params.id, !!req.body?.exempt, scopeFor(req)));
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

authRouter.get('/lock-pin/status', requireAuth, async (req, res, next) => {
  try {
    res.json(await authService.lockPinStatus(req.user?.id, scopeFor(req)));
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

authRouter.post('/lock-pin/set', requireAuth, pinRateLimit, async (req, res, next) => {
  try {
    res.json(await authService.setLockPin(req.user?.id, req.body?.pin, scopeFor(req)));
  } catch (e) {
    if (/at least 4/i.test(String(e?.message || ''))) return res.status(400).json({ error: e.message });
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

authRouter.post('/lock-pin/verify', requireAuth, pinRateLimit, async (req, res, next) => {
  try {
    res.json(await authService.verifyLockPin(req.user?.id, req.body?.pin, scopeFor(req)));
  } catch (e) {
    if (/invalid pin|pin not set/i.test(String(e?.message || ''))) return res.status(400).json({ error: e.message });
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

authRouter.post('/lock-pin/reset', requireAuth, async (req, res, next) => {
  try {
    res.json(await authService.resetLockPin(req.user?.id, scopeFor(req)));
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});
