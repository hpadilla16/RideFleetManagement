import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../modules/auth/auth.config.js';
import { authService } from '../modules/auth/auth.service.js';

export async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const payload = jwt.verify(token, getJwtSecret());
    const hydrated = await authService.getSessionUser(payload?.sub || null);
    if (!hydrated) return res.status(401).json({ error: 'Invalid token' });
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
