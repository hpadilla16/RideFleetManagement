import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../modules/auth/auth.config.js';
import { authService } from '../modules/auth/auth.service.js';
import { isAllowedForServiceAccount } from '../lib/service-account-allowlist.js';

// First-login onboarding (2026-07-25): while User.mustChangePassword is
// true (temp password at create, admin reset), a human session may reach
// ONLY these endpoints. Everything else 403s with PASSWORD_CHANGE_REQUIRED,
// which the frontend AuthGate turns into the forced-change screen. The list
// is deliberately tiny: change-password (the way out), me (session
// hydration), refresh (token keep-alive so the forced screen doesn't expire
// mid-typing). Default-deny, mirroring the service-account allowlist.
const PASSWORD_GATE_ALLOWLIST = new Set([
  'POST /api/auth/change-password',
  'GET /api/auth/me',
  'POST /api/auth/refresh'
]);

export async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const payload = jwt.verify(token, getJwtSecret());
    const hydrated = await authService.getSessionUser(payload?.sub || null);
    if (!hydrated) return res.status(401).json({ error: 'Invalid token' });

    // VozIA Fase 3 (2026-07-03): service accounts get two extra gates.
    // Humans (no isServiceAccount, no tv claim) are completely unaffected.
    if (hydrated.isServiceAccount) {
      // 1) Token-version check — revokeServiceTokens bumps User.tokenVersion,
      //    invalidating every token minted with an older tv claim.
      if (payload?.tv !== (hydrated.tokenVersion ?? 0)) {
        return res.status(401).json({ error: 'Token revoked' });
      }
      // 2) Default-deny allowlist — only the endpoints enumerated in
      //    lib/service-account-allowlist.js are reachable. This is what
      //    guarantees no refunds/voids/deposits/status-changes and blocks
      //    the payment ALIAS routes for the VozIA account.
      const path = String(req.originalUrl || req.url || '').split('?')[0];
      if (!isAllowedForServiceAccount(req.method, path)) {
        return res.status(403).json({ error: 'Endpoint not available for service accounts' });
      }
    }

    // First-login onboarding (2026-07-25): humans with a temp password are
    // boxed into the change-password allowlist. Service accounts are exempt
    // (no interactive login; their own default-deny allowlist governs them).
    if (!hydrated.isServiceAccount && hydrated.mustChangePassword) {
      const gatePath = String(req.originalUrl || req.url || '').split('?')[0];
      if (!PASSWORD_GATE_ALLOWLIST.has(`${req.method} ${gatePath}`)) {
        return res.status(403).json({
          error: 'You must change your temporary password before using the app',
          code: 'PASSWORD_CHANGE_REQUIRED'
        });
      }
    }

    req.user = { ...payload, ...hydrated, sub: hydrated.id, id: hydrated.id };
    next();
  } catch (e) {
    if (/JWT_SECRET must be configured/i.test(String(e?.message || ''))) {
      return res.status(500).json({ error: 'Authentication is not configured' });
    }
    res.status(401).json({ error: 'Invalid token' });
  }
}

export function isSuperAdmin(user) {
  return String(user?.role || '').toUpperCase() === 'SUPER_ADMIN';
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (isSuperAdmin(req.user)) return next();
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

export function requireModuleAccess(moduleKey) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (isSuperAdmin(req.user)) return next();
    if (req.user?.moduleAccess?.[moduleKey] === false) {
      return res.status(403).json({ error: `Access to ${moduleKey} is disabled for this user` });
    }
    next();
  };
}
