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

  // ── Telematics connectors ──
  // Provider-AGNOSTIC on purpose: the acting connector (ONESTEPGPS,
  // VOLTSWITCH, …) goes in metadata.provider so future connectors reuse
  // these actions instead of minting per-vendor ones. Call sites must NEVER
  // put the API key — or any fragment of it — in metadata; redactSensitive
  // is a safety net, not a license.
  TELEMATICS_KEY_SET: 'TELEMATICS_KEY_SET',
  TELEMATICS_KEY_CLEAR: 'TELEMATICS_KEY_CLEAR',
  TELEMATICS_MAPPING_CREATE: 'TELEMATICS_MAPPING_CREATE',
  TELEMATICS_MAPPING_DEACTIVATE: 'TELEMATICS_MAPPING_DEACTIVATE',

  // ── Shuttle geofence zones (Phase 2, 2026-08-24) ──
  // Zone CRUD is ADMIN-gated and shapes what triggers customer-facing
  // notifications, so every mutation is audited; metadata carries provider +
  // zone identifiers only (never geometry dumps, never credentials).
  ZONE_CREATE: 'ZONE_CREATE',
  ZONE_UPDATE: 'ZONE_UPDATE',
  ZONE_DELETE: 'ZONE_DELETE',
  ALERT_RECIPIENTS_CHANGE: 'ALERT_RECIPIENTS_CHANGE',

  // ── Shuttle assignment (Phase 3, 2026-08-25) ──
  // Pinning a vehicle to a request decides WHICH shuttle's GPS a customer's
  // public page follows, so both directions leave a trail. Metadata carries
  // request/vehicle/location ids only — never customer PII, never coordinates.
  SHUTTLE_ASSIGN: 'SHUTTLE_ASSIGN',
  SHUTTLE_UNASSIGN: 'SHUTTLE_UNASSIGN',

  // ── QR self-return (2026-09-02) ──
  // Enabling/disabling a location's return QR opens/closes a PUBLIC write
  // surface, and voiding a customer return stamp changes which timestamp
  // check-in close feeds the late-fee engine — money-adjacent, ADMIN-class
  // only (SELF_RETURN_VOID_ROLES). Metadata carries ids, the stamp time and
  // the stated reason — never customer PII.
  SELF_RETURN_QR_ENABLE: 'SELF_RETURN_QR_ENABLE',
  SELF_RETURN_QR_DISABLE: 'SELF_RETURN_QR_DISABLE',
  SELF_RETURN_VOID: 'SELF_RETURN_VOID',

  // ── Shuttle driver shifts (Phase 3 driver surface, 2026-08-25) ──
  // Minting hands out a public token that reads waiting customers' shared
  // coordinates and closes their requests — a real credential, so issue and
  // revoke leave a trail exactly like SERVICE_TOKEN_ISSUE/REVOKE. Metadata
  // carries shift/vehicle/location ids and expiry only — NEVER the token.
  DRIVER_SHIFT_ISSUE: 'DRIVER_SHIFT_ISSUE',
  DRIVER_SHIFT_REVOKE: 'DRIVER_SHIFT_REVOKE',

  // ── Checkout payment policy (2026-08-26) ──
  // Turning the wizard's payment step off for a tenant changes whether staff
  // are ever prompted to collect at the counter, so "who made check-out stop
  // asking for money, and when" has to be answerable. Metadata carries the new
  // boolean + tenantId ONLY — no amounts, no customer or card data.
  CHECKOUT_PAYMENT_POLICY_CHANGE: 'CHECKOUT_PAYMENT_POLICY_CHANGE',

  // ── Payment terminal / gateway configuration (2026-08-26) ──
  // Editing this row decides WHICH merchant account a tenant's card charges
  // settle into. "Who repointed the terminal, and when" has to be answerable
  // from the trail alone. Metadata carries the gateway, the enabled flags, a
  // MASKED TPN and booleans about the auth key — NEVER the auth key itself,
  // nor any fragment of it. The shared redactor is a safety net, not a licence.
  PAYMENT_TERMINAL_CONFIG_CHANGE: 'PAYMENT_TERMINAL_CONFIG_CHANGE',

  // ── Tenant subscriptions: RIDE billing its own tenants (2026-08-27) ──
  // Money flowing TO US, on the BILLING_AUTHNET_* merchant account — not the
  // per-tenant rental gateway (AUTHNET_*), which bills a renter on the
  // tenant's account. Do not reuse these for rental payments.
  //
  // METADATA RULE, following the PAYMENT_TERMINAL_CONFIG_CHANGE precedent:
  // ids, amounts, plan codes, transId, card brand and last4 ONLY.
  // customerProfileId is fine — it is useless without the transaction key and
  // support needs it to look a customer up in the Authorize.Net portal.
  // NEVER the invite token (not one character beyond the stored tokenPrefix),
  // never the transaction or signature key, never a card number. The shared
  // redactor is a safety net, not a licence.
  //
  // The audit row is ATTRIBUTION, not the ledger. recordAudit is best-effort
  // and swallows its own failures, which is right for a trail and wrong for
  // money — so the record of money is TenantSubscriptionCharge, a hard write.
  // Neither depends on the other.
  //
  // The plan-change / cancel / refund / suspend actions from the design land
  // with the phases that can perform them; a constant for an action nothing
  // can take would just be a promise the trail does not keep.
  AUTOPAY_INVITE_SEND: 'AUTOPAY_INVITE_SEND',
  // ── Phase 7 (2026-08-28) — the platform DELIVERS the link, so delivery is
  // its own audited act.
  //
  // Separate from AUTOPAY_INVITE_SEND on purpose: minting and delivering are
  // now two things that can succeed independently, and collapsing them would
  // make "we sent it" unfalsifiable — the trail would say a link was issued
  // and leave the far more useful question, whether it ever left the building
  // and at what address, unanswered. `outcome` is the ordinary FAILURE for a
  // mailer outage, so a link that was minted but never delivered is visible in
  // the trail rather than inferred from its absence.
  //
  // METADATA EXCEPTION, STATED DELIBERATELY: this row carries the RECIPIENT
  // ADDRESS, which the ids-and-amounts rule above would otherwise exclude. It
  // is the one fact the action is about. The recovery path for a mistyped
  // billing contact is "look at where it actually went", and an address the
  // invite row already stores is not new exposure. Still never the token, not
  // one character past tokenPrefix, and never the URL that contains it.
  AUTOPAY_INVITE_EMAIL: 'AUTOPAY_INVITE_EMAIL',
  AUTOPAY_INVITE_REVOKE: 'AUTOPAY_INVITE_REVOKE',
  // The customer completed the return leg: a card is on file and an ARB
  // subscription now exists. This is the row that answers "who authorised
  // this recurring charge, when, and from where".
  AUTOPAY_ENROLL: 'AUTOPAY_ENROLL',
  AUTOPAY_METHOD_UPDATE: 'AUTOPAY_METHOD_UPDATE',
  SUBSCRIPTION_CREATE: 'SUBSCRIPTION_CREATE',
  // ── Phase 2 (webhooks + reconciliation), 2026-08-27 ──
  // ONE action for every status transition, with from/to/source in metadata,
  // rather than an action per destination status. The question a trail has to
  // answer here is "what moved this subscription, and what moved it there" —
  // and a SUBSCRIPTION_PAST_DUE constant answers only half of it while making
  // the from-status somebody's optional metadata habit. `source` is WEBHOOK |
  // RECONCILE | ADMIN, which is the part that matters in a dispute: a status
  // Authorize.Net told us is a different kind of fact from one we inferred
  // because a charge never appeared.
  //
  // NO ACTOR on these. They are written from a public webhook and from an
  // unattended sweep; there is no user, and filling actorUserId with the
  // platform owner because he owns the platform would be a lie about who acted.
  SUBSCRIPTION_STATE_CHANGE: 'SUBSCRIPTION_STATE_CHANGE',
  // Authorize.Net and our row disagreed and we adopted Authorize.Net's answer.
  // Separate from a plain state change because the interesting fact is not the
  // new status but that we were WRONG — which almost always means a webhook
  // never arrived, and that is a systems problem, not a billing one.
  SUBSCRIPTION_RECONCILE_DRIFT: 'SUBSCRIPTION_RECONCILE_DRIFT',
  // Editing the catalog now edits PRICES. Not itself a charge, but it decides
  // what the next invite offers, so "who changed the price list" has to be
  // answerable from the trail alone.
  BILLING_PLAN_CATALOG_CHANGE: 'BILLING_PLAN_CATALOG_CHANGE',
  // ── Phase 4 (the SUPER_ADMIN billing panel), 2026-08-27 ──
  // Each of these now has a caller, which is the bar set above: a constant for
  // an action nothing can take is a promise the trail does not keep.
  //
  // Written TWICE for one click when Authorize.Net refuses or times out — once
  // with outcome FAILURE, and never with a state change beside it, because the
  // whole invariant of the cancel path is that our row is not marked CANCELLED
  // until ARB has confirmed. A trail that showed only successes would hide the
  // exact case (a timeout, state unknown) that a human most needs to see.
  SUBSCRIPTION_CANCEL: 'SUBSCRIPTION_CANCEL',
  // Access cut / restored by a human from the billing panel. Distinct from
  // SUBSCRIPTION_STATE_CHANGE because the subject is the TENANT, not the
  // subscription: what changed is whether their software works, and the reason
  // is a sentence a person typed. `billingSuspendedAt` is what separates these
  // from a suspension somebody set by hand for an unrelated reason.
  TENANT_SUSPEND: 'TENANT_SUSPEND',
  TENANT_RESTORE: 'TENANT_RESTORE',
  // Moving Tenant.plan (the ENTITLEMENT key) to match the subscription's
  // planCode (the BILLING key). Billing never does this on its own — the owner's
  // rule — so every occurrence is a deliberate click, and this is the only
  // action that ever reconciles the two. Metadata carries from/to plus the caps
  // the new plan implies, since a downgrade can leave a tenant over them.
  TENANT_PLAN_APPLY: 'TENANT_PLAN_APPLY',
  // Tenant.status changed by hand from the Tenants screen (PATCH /api/tenants/:id),
  // NOT from the billing panel. Deliberately distinct from TENANT_SUSPEND /
  // TENANT_RESTORE above: those two mean "billing cut or restored access" and are
  // paired with billingSuspendedAt, which is the marker that lets automation know
  // it may only lift a suspension it set itself. Folding hand edits into them would
  // blur exactly that line. Metadata carries previousStatus/newStatus so the trail
  // answers "what was it before" for a screen that can also darken a tenant.
  TENANT_STATUS_CHANGE: 'TENANT_STATUS_CHANGE',
  // ── Phase 6 (plan changes + proration), 2026-08-30 ──
  // A plan change is THREE distinct facts and gets three actions, because each
  // answers a different dispute question. SCHEDULE: who decided the price would
  // change, to what, effective when — carries the actor. APPLY: the moment the
  // change actually took effect — written by the unattended boundary sweep
  // (no actor, source RECONCILE) or by an immediate admin apply (actor, source
  // ADMIN). CANCEL: a scheduled change undone before it applied, with what was
  // discarded and what was kept. Metadata is ids, plan codes and amounts only.
  SUBSCRIPTION_PLAN_CHANGE_SCHEDULE: 'SUBSCRIPTION_PLAN_CHANGE_SCHEDULE',
  SUBSCRIPTION_PLAN_CHANGE_APPLY: 'SUBSCRIPTION_PLAN_CHANGE_APPLY',
  SUBSCRIPTION_PLAN_CHANGE_CANCEL: 'SUBSCRIPTION_PLAN_CHANGE_CANCEL',
  // The mid-cycle proration charge — the one action in the module that mints a
  // NOVEL amount and moves money outside the ARB schedule. Written on SUCCESS
  // and on FAILURE both: a declined or unknown-state attempt is exactly the row
  // a human most needs to find later, with the refId that makes it findable at
  // Authorize.Net. Never the transaction key, never more card than brand+last4.
  SUBSCRIPTION_PRORATION_CHARGE: 'SUBSCRIPTION_PRORATION_CHARGE',
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
