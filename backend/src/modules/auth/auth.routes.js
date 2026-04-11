import { Router } from 'express';
import { authService } from './auth.service.js';
import { isPublicRegisterEnabled } from './auth.config.js';
import { isSuperAdmin, requireAuth, requireRole } from '../../middleware/auth.js';
import { createPublicRateLimitGuard, attachPublicRequestMeta } from '../../middleware/public-endpoint-guards.js';

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
    res.json(await authService.refreshToken(userId));
  } catch (e) {
    res.status(401).json({ error: e.message });
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
