// Administrative / security audit trail — write side (Wave 3, 2026-08-24).
//
// This module is the ONLY writer of the AdminAuditLog table. It records
// admin/security events that AuditLog cannot hold (AuditLog.reservationId is a
// required FK — see the schema header on model AdminAuditLog).
//
// ── LOAD-BEARING: recordAudit is BEST-EFFORT ────────────────────────────────
// A failed audit write must NEVER change a caller's outcome. A login, an
// export, a role change must still succeed even if the audit INSERT fails. The
// whole body is wrapped in try/catch, the failure is logged, and we return —
// exactly mirroring the Sentry-breadcrumb precedent in lib/logger.js
// ("best-effort; never let them break the request"). Call sites therefore never
// need their own try/catch around an audit call, and may fire-and-forget it.
//
// ── THRESHOLD RULE (what gets audited) ──────────────────────────────────────
// Audit: single-record PII detail reads (GET /:id that returns ONE identified
// person's full record), document fetches, ALL auth/admin mutations, and
// exports/erasures. Do NOT audit list / collection / search endpoints — they
// are noise, and a filtered list is not the same disclosure as pulling one
// named person's full PII. The dividing line: an endpoint that returns ONE
// identified person's full PII is audited; a filtered list of many is not.
import { prisma } from '../../lib/prisma.js';
import logger, { redactSensitive } from '../../lib/logger.js';
import { forwardSecurityEvent } from '../../lib/security-log-forwarder.js';

// Known action types. `action` is a plain String column (not a Prisma enum) so
// adding a value here never needs a migration. Grouped by area.
export const AUDIT_ACTIONS = Object.freeze({
  // ── Auth ──
  LOGIN: 'LOGIN',
  LOGIN_FAILURE: 'LOGIN_FAILURE',
  LOGOUT: 'LOGOUT',
  CHANGE_PASSWORD: 'CHANGE_PASSWORD',
  TWO_FACTOR_ENROLL: 'TWO_FACTOR_ENROLL',
  TWO_FACTOR_DISABLE: 'TWO_FACTOR_DISABLE',
  TWO_FACTOR_BACKUP_REGEN: 'TWO_FACTOR_BACKUP_REGEN',
  TWO_FACTOR_VERIFY_LOGIN: 'TWO_FACTOR_VERIFY_LOGIN',
  TWO_FACTOR_ADMIN_RESET: 'TWO_FACTOR_ADMIN_RESET',
  SERVICE_TOKEN_ISSUE: 'SERVICE_TOKEN_ISSUE',
  SERVICE_TOKEN_REVOKE: 'SERVICE_TOKEN_REVOKE',

  // ── User administration ──
  USER_CREATE: 'USER_CREATE',
  USER_ROLE_CHANGE: 'USER_ROLE_CHANGE',
  USER_DEACTIVATE: 'USER_DEACTIVATE',
  USER_REACTIVATE: 'USER_REACTIVATE',
  USER_PASSWORD_RESET: 'USER_PASSWORD_RESET',
  USER_MODULE_ACCESS_CHANGE: 'USER_MODULE_ACCESS_CHANGE',
  TWO_FACTOR_POLICY_CHANGE: 'TWO_FACTOR_POLICY_CHANGE',

  // ── GDPR / DSAR ──
  DSAR_EXPORT: 'DSAR_EXPORT',
  DSAR_ERASE: 'DSAR_ERASE',

  // ── Sensitive reads ──
  CUSTOMER_RECORD_READ: 'CUSTOMER_RECORD_READ',
  CUSTOMER_DOCUMENT_READ: 'CUSTOMER_DOCUMENT_READ',

  // ── Impersonation ──
  IMPERSONATION_START: 'IMPERSONATION_START',
  IMPERSONATION_END: 'IMPERSONATION_END',

  // ── Pricing overrides ──
  // A staff member replaced the engine's quoted daily rate with their own
  // number. Money-adjacent and discretionary, so it is audited even though it
  // is a create (not a read): the row carries the original rate, the new rate
  // and the stated reason.
  QUOTE_RATE_OVERRIDE: 'QUOTE_RATE_OVERRIDE',
});

export const AUDIT_OUTCOME = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
});

// ip/userAgent extracted with the SAME rules requestLogger() uses in
// lib/logger.js, so an audit row's ip/userAgent match the request log line.
export function auditIpFromReq(req) {
  return req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.ip || null;
}
export function auditUserAgentFromReq(req) {
  const ua = req?.headers?.['user-agent'];
  return ua ? String(ua).slice(0, 120) : null;
}

/**
 * Persist ONE admin-audit row. BEST-EFFORT — never throws into the caller.
 *
 * `deps.prisma` / `deps.logger` are injectable for unit tests (same pattern as
 * issueServiceToken / createTenantRateLimit). `metadata` is run through
 * redactSensitive before persist, so a PII key that slips into metadata (a
 * password, an email, a phone) is masked at rest.
 *
 * Returns a Promise that ALWAYS resolves (to undefined). Callers may await it
 * safely or fire-and-forget; either way it can never reject.
 */
export async function recordAudit(entry = {}, deps = {}) {
  const db = deps.prisma || prisma;
  const log = deps.logger || logger;
  try {
    const {
      tenantId = null,
      actorUserId = null,
      actorEmail = null,
      actorRole = null,
      impersonatedByUserId = null,
      action = null,
      targetType = null,
      targetId = null,
      ip = null,
      userAgent = null,
      metadata = null,
      outcome = AUDIT_OUTCOME.SUCCESS,
    } = entry;

    if (!action) {
      // A row with no action is useless; log and bail (still never throw).
      log.error('[audit] recordAudit called without an action — skipping');
      return;
    }

    // Redact BEFORE persist: metadata must never carry raw PII / secrets.
    const safeMetadata = metadata == null ? null : redactSensitive(metadata);

    const data = {
      tenantId: tenantId ?? null,
      actorUserId: actorUserId ?? null,
      actorEmail: actorEmail ?? null,
      actorRole: actorRole ?? null,
      impersonatedByUserId: impersonatedByUserId ?? null,
      action,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      ip: ip ?? null,
      userAgent: userAgent ? String(userAgent).slice(0, 120) : null,
      metadata: safeMetadata,
      outcome: outcome || AUDIT_OUTCOME.SUCCESS,
    };

    await db.adminAuditLog.create({ data });

    // Best-effort SIEM forward of the SAME already-redacted fields (safeMetadata
    // is the redactSensitive output above — we do NOT re-redact). Inert unless
    // SECURITY_LOG_FORWARD_URL is set; fire-and-forget; can never throw or block
    // here (forwardSecurityEvent swallows everything internally, and this extra
    // try/catch is belt-and-suspenders so a failed forward never changes
    // recordAudit's outcome).
    try {
      forwardSecurityEvent({ ...data, timestamp: new Date().toISOString() });
    } catch { /* forwarder is best-effort; ignore */ }
  } catch (err) {
    // BEST-EFFORT: swallow. A dropped audit row must not fail the request that
    // triggered it. Log so the drop is itself observable.
    try {
      log.error('[audit] recordAudit failed (best-effort, swallowed)', {
        action: entry?.action || null,
        outcome: entry?.outcome || null,
        error: err?.message || String(err),
      });
    } catch {
      // Logging must not throw either — there is nothing left to do.
    }
  }
}

/**
 * Convenience wrapper: build an audit row from `req.user` + request headers,
 * merging any explicit fields on top. Pulls tenantId/actorUserId/actorEmail/
 * actorRole from req.user, impersonatedByUserId from req.user.imp (the token's
 * conditional `imp` claim, surfaced onto req.user by middleware/auth.js), and
 * ip/userAgent from the same headers requestLogger uses.
 *
 * Also best-effort (delegates to recordAudit); safe to fire-and-forget.
 */
export function auditFromReq(req, entry = {}, deps = {}) {
  const u = req?.user || {};
  return recordAudit(
    {
      tenantId: u.tenantId ?? null,
      actorUserId: u.id ?? u.sub ?? null,
      actorEmail: u.email ?? null,
      actorRole: u.role ?? null,
      impersonatedByUserId: u.imp ?? null,
      ip: auditIpFromReq(req),
      userAgent: auditUserAgentFromReq(req),
      ...entry,
    },
    deps,
  );
}

export const auditService = { recordAudit, auditFromReq, AUDIT_ACTIONS, AUDIT_OUTCOME };
