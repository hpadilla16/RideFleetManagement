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
//
// Staff 2FA deadlock fix (2026-08-22, QA): 2FA is SEQUENCED BEFORE the forced
// password change. When a user is BOTH mustChangePassword AND holding a pending
// 2FA token (an enrolled user gets an admin password reset, or a temp-password
// user whose role requires enrollment), this password gate runs first — so the
// 2FA second-leg endpoints MUST be reachable here too, or the two gates would
// each 403 the other's only way out and brick the account. After 2FA issues
// the full token (no mfa claim), this gate then forces change-password
// normally. The pending gate below still restricts every OTHER route.
const PASSWORD_GATE_ALLOWLIST = new Set([
  'POST /api/auth/change-password',
  'GET /api/auth/me',
  'POST /api/auth/refresh',
  'POST /api/auth/2fa/verify-login',
  'POST /api/auth/2fa/enroll/start',
  'POST /api/auth/2fa/enroll/verify'
]);

// Staff 2FA (2026-08-22): a PENDING challenge token (carries the `mfa` claim,
// minted by signPendingToken between the password and TOTP steps) is NOT a
// full session. It may reach ONLY the second-leg endpoints — verify-login and
// the enrollment pair — plus /me for hydration. Everything else 403s with
// TWO_FACTOR_REQUIRED. Default-deny, mirroring PASSWORD_GATE_ALLOWLIST. Per-mode
// tightening (a VERIFY token cannot drive enrollment) lives at the routes.
const TWO_FACTOR_PENDING_ALLOWLIST = new Set([
  'POST /api/auth/2fa/verify-login',
  'POST /api/auth/2fa/enroll/start',
  'POST /api/auth/2fa/enroll/verify',
  'GET /api/auth/me'
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

    // Staff 2FA (2026-08-22): a pending challenge token (payload.mfa set) is
    // boxed into the two-factor allowlist. The claim lives on the JWT payload,
    // not the hydrated session, so we read it from `payload`.
    if (payload?.mfa) {
      const gatePath = String(req.originalUrl || req.url || '').split('?')[0];
      if (!TWO_FACTOR_PENDING_ALLOWLIST.has(`${req.method} ${gatePath}`)) {
        return res.status(403).json({
          error: 'Two-factor authentication is required to complete sign-in',
          code: 'TWO_FACTOR_REQUIRED'
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
    // RideOps gap #3 (2026-08-17): machine-readable code, like the password
    // gate's PASSWORD_CHANGE_REQUIRED. Without it, a mobile client seeing a
    // bare 403 on a request that carried x-view-location cannot distinguish
    // "your picked location was revoked → offer the switcher" from any other
    // Forbidden. Additive — the web frontend keys off the message/status and
    // ignores unknown fields.
    if (!viewResult.ok) {
      return res.status(403).json({ error: viewResult.error, code: 'VIEW_LOCATION_DENIED' });
    }
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
