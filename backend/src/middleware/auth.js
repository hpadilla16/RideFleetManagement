import jwt from 'jsonwebtoken';
import { applyViewLocation, VIEW_LOCATION_HEADER } from '../lib/view-location.js';
import { getJwtSecret } from '../modules/auth/auth.config.js';
import { authService } from '../modules/auth/auth.service.js';
import { isAllowedForServiceAccount } from '../lib/service-account-allowlist.js';
import { MODULE_LABELS, MODULE_DENIED_HINTS } from '../lib/module-access.js';

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

    // Location switcher (2026-08-11): x-view-location narrows the user's
    // location scope to ONE location for this request, the way a super admin
    // views one tenant. Applied HERE, at the single place every request
    // passes, so every endpoint that respects userAllowedLocationIds filters
    // without knowing the feature exists. The override only ever SHRINKS what
    // the user could already see (fail-closed by construction); a restricted
    // user picking outside their set is a hard 403, not an empty page.
    const viewResult = applyViewLocation({
      user: req.user,
      requested: req.headers[VIEW_LOCATION_HEADER],
    });
    if (!viewResult.ok) return res.status(403).json({ error: viewResult.error });
    if (viewResult.locationIds !== undefined) {
      req.user = { ...req.user, locationIds: viewResult.locationIds, viewLocationId: viewResult.locationIds[0] };
    }
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

/**
 * Human-readable denial. The old text interpolated the RAW key, so a user was
 * told "Access to paymentActions is disabled for this user" — the message falls
 * straight through to the banner on the payments screen. Uses the same labels
 * the Settings/People toggles show, so what the admin switched off and what the
 * user is told match. Benefits all modules, not just this one.
 */
function moduleDeniedMessage(moduleKey) {
  const label = MODULE_LABELS[moduleKey] || moduleKey;
  const hint = MODULE_DENIED_HINTS[moduleKey];
  return `${label} is turned off for your account.${hint ? ` ${hint}` : ''}`;
}

export function requireModuleAccess(moduleKey) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (isSuperAdmin(req.user)) return next();
    if (req.user?.moduleAccess?.[moduleKey] === false) {
      return res.status(403).json({ error: moduleDeniedMessage(moduleKey) });
    }
    next();
  };
}

/**
 * FAIL-CLOSED variant of requireModuleAccess — requires an explicit `true`.
 *
 * requireModuleAccess denies only on `=== false`, so a MISSING key PERMITS the
 * request. That is safe today because buildSessionUser emits every MODULE_KEY
 * as a boolean, but it makes the money gate depend on an invariant enforced
 * nowhere. This review found two separate fail-open traps in a single pass
 * (hostRoleModuleMap, and the People create-form default map), and a parallel
 * workstream is minting sessions for the employee mobile app. For a gate that
 * authorizes charging and refunding a card, absence must mean NO.
 *
 * Zero behavior change today: for every real session the key is present.
 * Use this for capabilities; requireModuleAccess stays the nav-module gate.
 */
export function requireCapability(moduleKey) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (isSuperAdmin(req.user)) return next();
    if (req.user?.moduleAccess?.[moduleKey] !== true) {
      return res.status(403).json({ error: moduleDeniedMessage(moduleKey) });
    }
    next();
  };
}
