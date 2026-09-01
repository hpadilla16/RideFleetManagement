/**
 * Staff 2FA (TOTP) policy resolution + enforcement kill-switch — 2026-08-22.
 *
 * SAFETY INVARIANTS (QA will try to break these):
 *  1. ZERO behavior change until a policy exists. With no `twoFactorPolicy`
 *     AppSetting (global or tenant) and the kill-switch unset, requiresTwoFactor
 *     returns false for a non-enrolled user, so login() issues the full token
 *     exactly as before.
 *  2. Kill-switch works instantly. isEnforcementKilled() reads the env var
 *     TWO_FACTOR_ENFORCEMENT_DISABLED at CALL TIME (never cached) so flipping
 *     it recovers prod on the next request with no redeploy.
 *
 * Policy shape (stored as AppSetting JSON):
 *   { enabled: boolean, requiredRoles: string[], graceUntil: string|null }
 *
 * Resolution order: the tenant override (`tenant:<id>:twoFactorPolicy`) wins
 * over the global default (`twoFactorPolicy`) when present; otherwise the
 * global default applies; otherwise the disabled default.
 */

import { prisma } from './prisma.js';

export const VALID_TWO_FACTOR_ROLES = ['SUPER_ADMIN', 'ADMIN', 'OPS', 'AGENT'];

const DISABLED_POLICY = { enabled: false, requiredRoles: [], graceUntil: null };

function normalizePolicy(raw) {
  if (!raw || typeof raw !== 'object') return { ...DISABLED_POLICY };
  const requiredRoles = Array.isArray(raw.requiredRoles)
    ? raw.requiredRoles
        .map((r) => String(r || '').toUpperCase())
        .filter((r) => VALID_TWO_FACTOR_ROLES.includes(r))
    : [];
  let graceUntil = null;
  if (raw.graceUntil) {
    const d = new Date(raw.graceUntil);
    if (!Number.isNaN(d.getTime())) graceUntil = d.toISOString();
  }
  return { enabled: !!raw.enabled, requiredRoles, graceUntil };
}

async function readPolicySetting(key, deps) {
  const db = deps.prisma || prisma;
  const row = await db.appSetting.findUnique({ where: { key } });
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

/**
 * Resolve the effective policy for a tenant. Tenant override wins over the
 * global default. Returns the disabled default when neither is set — this is
 * the property that keeps login untouched for tenants that never opted in.
 */
export async function resolveTwoFactorPolicy(tenantId, deps = {}) {
  const globalRaw = await readPolicySetting('twoFactorPolicy', deps);
  let effective = globalRaw;
  if (tenantId) {
    const tenantRaw = await readPolicySetting(`tenant:${tenantId}:twoFactorPolicy`, deps);
    if (tenantRaw !== null) effective = tenantRaw;
  }
  return normalizePolicy(effective);
}

/**
 * Instant prod recovery. Read at call time so `TWO_FACTOR_ENFORCEMENT_DISABLED=true`
 * takes effect on the very next login with no redeploy. Accepts the common
 * truthy spellings.
 */
export function isEnforcementKilled() {
  const raw = String(process.env.TWO_FACTOR_ENFORCEMENT_DISABLED || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * Is the grace window still open? A future (or absent-but-enabled) graceUntil
 * means a required-but-not-yet-enrolled user is still allowed to log in via the
 * ENROLL challenge rather than being hard-blocked. Once graceUntil passes, the
 * requirement still applies (the user must enroll to get in) — grace only ever
 * governs UX copy, never whether TOTP is required. Kept as a helper so the
 * login branch and tests share one definition.
 */
export function isGraceWindowOpen(policy, now = new Date()) {
  const p = normalizePolicy(policy);
  if (!p.graceUntil) return true;
  return new Date(p.graceUntil).getTime() > now.getTime();
}

/**
 * Does this user need to satisfy a TOTP challenge at login, given the policy?
 *
 * True when the policy is enabled AND the user's role is in requiredRoles.
 * An already-enrolled user is handled by the CALLER (login checks
 * user.twoFactorEnabled directly and always challenges the enrolled) — this
 * function answers only "does the POLICY compel this user", which drives the
 * ENROLL branch for not-yet-enrolled required users.
 *
 * Grace note: enforcement of the requirement does NOT lapse when grace expires
 * — an expired grace window means the required user is still compelled to
 * enroll. isGraceWindowOpen is exposed separately for messaging.
 */
export function requiresTwoFactor(user, policy) {
  const p = normalizePolicy(policy);
  if (!p.enabled) return false;
  const role = String(user?.role || '').toUpperCase();
  if (!p.requiredRoles.length) return false;
  return p.requiredRoles.includes(role);
}

export { normalizePolicy };
