/**
 * VozIA Fase 6 RE-SCOPE (Hector, 2026-07-04) — service-account operation guards.
 *
 * VozIA (the voice-agent service account) NEVER captures a card directly. It can
 * only:
 *   1. send the customer a self-pay link  (no money moves — guarded in the route)
 *   2. REFUND an existing payment          → assertServiceAccountRefundAllowed
 *   3. add a service/fee (+) or credit (-) → assertServiceAccountChargeAllowed
 *
 * Every write is authorized on VozIA's side by the human "ticket owner" (or an
 * admin) who approves it. RFM CANNOT validate ticket ownership — that is VozIA's
 * responsibility. RFM's contract here is narrow but strict: every service-account
 * write MUST carry `author` + `ticketId`, RFM RECORDS them on an AuditLog row, and
 * RFM caps the per-transaction magnitude with a configurable AppSetting ceiling.
 *
 * Each guard is:
 *   - a strict NO-OP for humans (returns immediately when !user.isServiceAccount),
 *     so staff behavior is byte-identical to before;
 *   - PURE + I/O-free in its decision core (checkServiceAccount*), unit-tested in
 *     service-payment-guards.test.mjs without Express or prisma;
 *   - throwing an Error carrying a numeric `.statusCode` (+ optional `.details`)
 *     so the route can `res.status(err.statusCode).json({ error, details })`.
 *
 * The native service caps STAY the primary money-safety line (refundPayment
 * already enforces refund<=original and cumulative<=original; addManualCharge
 * writes its own ADMIN_OVERRIDE AuditLog and recomputes the balance). These
 * guards are defense-in-depth ON TOP of that, scoped to the service account only.
 */

// Cents-safe rounding: work in integer cents so float drift can never let an
// over-ceiling amount slip past a boundary comparison.
function toCents(n) {
  return Math.round(Number(n) * 100);
}

const AUTHOR_MAX = 120;
const NAME_MAX = 120;
const TICKET_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Shared provenance check: author (<=120) + ticketId (ticket-id shape) required.
// Returns null when OK, or an error descriptor when a field is missing/malformed.
function checkProvenance({ author, ticketId }) {
  const authorStr = typeof author === 'string' ? author.trim() : '';
  if (!authorStr || authorStr.length > AUTHOR_MAX) {
    return { ok: false, statusCode: 400, error: 'author is required (<=120 chars)' };
  }
  const ticketStr = typeof ticketId === 'string' ? ticketId.trim() : '';
  if (!ticketStr || !TICKET_RE.test(ticketStr)) {
    return { ok: false, statusCode: 400, error: 'ticketId is required (^[A-Za-z0-9._-]{1,64}$)' };
  }
  return null;
}

/**
 * VozIA agreement-email (2026-08-03) — NON-MONEY, but same provenance bar as
 * every service-account write: author + ticketId or 400. Pure so the truth
 * table lives in service-payment-guards.test.mjs like its siblings.
 */
export function checkServiceAccountAgreementEmail({ author, ticketId }) {
  const bad = checkProvenance({ author, ticketId });
  if (bad) return bad;
  return { ok: true };
}

/**
 * Bounded in-memory send cooldown (one send per key per window). In-memory on
 * purpose — a restart forgives, which is fine for an anti-spam guard; no
 * cross-process state needed at current scale. Pure factory for testability
 * (callers inject the clock in tests).
 */
export function makeSendCooldown(windowMs) {
  const last = new Map();
  return function check(key, now = Date.now()) {
    const prev = last.get(key) || 0;
    if (now - prev < windowMs) return false;
    if (last.size > 5000) last.clear(); // bounded
    last.set(key, now);
    return true;
  };
}

/**
 * CAP 2 — REFUND. Pure decision function.
 *
 * @param {object}  a
 * @param {string=} a.author     req.body.author   (required, <=120)
 * @param {string=} a.ticketId   req.body.ticketId (required, ticket-id shape)
 * @param {number=} a.amount     req.body.amount   (OPTIONAL: if omitted the
 *                                                  service refunds the FULL original;
 *                                                  if provided it must be >0 and
 *                                                  within the ceiling)
 * @param {number}  a.maxRefund  absolute per-transaction ceiling (AppSetting)
 */
export function checkServiceAccountRefund({ author, ticketId, amount, maxRefund }) {
  const prov = checkProvenance({ author, ticketId });
  if (prov) return prov;

  // amount is OPTIONAL for refunds (native refundPayment defaults to the full
  // original). But IF the caller specifies one, it must be a positive number
  // within the ceiling. The refund<=original / cumulative<=original caps live in
  // the service and are NOT re-implemented here.
  if (amount !== undefined && amount !== null) {
    const amountCents = toCents(amount);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return { ok: false, statusCode: 400, error: 'amount must be greater than 0' };
    }
    const maxCents = toCents(maxRefund);
    if (Number.isFinite(maxCents) && amountCents > maxCents) {
      return {
        ok: false,
        statusCode: 400,
        error: 'Amount exceeds the per-transaction refund limit for this account',
        details: { max: Number(maxRefund) }
      };
    }
  }

  return { ok: true };
}

/**
 * CAP 3+4 — CHARGE (add service/fee) or CREDIT (negative amount). Pure.
 *
 * Positive amount = added service/fee (raises balance); negative = credit
 * (lowers balance). BOTH are allowed — that is the feature. The ceiling applies
 * to the ABSOLUTE value so a huge credit is capped just like a huge charge.
 *
 * @param {object}  a
 * @param {string=} a.author    req.body.author   (required, <=120)
 * @param {string=} a.ticketId  req.body.ticketId (required, ticket-id shape)
 * @param {string=} a.name      req.body.name     (required, <=120)
 * @param {number}  a.amount    req.body.amount   (finite, non-zero, |amount|<=ceiling)
 * @param {number}  a.maxLine   absolute per-line ceiling (AppSetting)
 */
export function checkServiceAccountCharge({ author, ticketId, name, amount, maxLine }) {
  const prov = checkProvenance({ author, ticketId });
  if (prov) return prov;

  const nameStr = typeof name === 'string' ? name.trim() : '';
  if (!nameStr || nameStr.length > NAME_MAX) {
    return { ok: false, statusCode: 400, error: 'name is required (<=120 chars)' };
  }

  const amountCents = toCents(amount);
  if (!Number.isFinite(amountCents) || amountCents === 0) {
    return { ok: false, statusCode: 400, error: 'amount must be a non-zero number' };
  }

  // Ceiling on the ABSOLUTE magnitude — a credit of -9999 is refused the same as
  // a charge of +9999.
  const maxCents = toCents(maxLine);
  if (Number.isFinite(maxCents) && Math.abs(amountCents) > maxCents) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Amount exceeds the per-line limit for this account',
      details: { max: Number(maxLine) }
    };
  }

  return { ok: true };
}

function throwIfNotOk(result) {
  if (!result.ok) {
    const err = new Error(result.error);
    err.statusCode = result.statusCode;
    if (result.details) err.details = result.details;
    throw err;
  }
}

/**
 * Route-facing REFUND guard. NO-OP for humans; throws (with .statusCode) for a
 * service account that violates provenance or the ceiling.
 */
export function assertServiceAccountRefundAllowed({ user, body = {}, amount, maxRefund }) {
  if (!user?.isServiceAccount) return; // humans: strict no-op
  throwIfNotOk(checkServiceAccountRefund({
    author: body.author,
    ticketId: body.ticketId,
    // Prefer an explicit `amount` arg (route may have already coerced it); fall
    // back to the body so the guard is convenient to call either way.
    amount: amount !== undefined ? amount : body.amount,
    maxRefund
  }));
}

/**
 * Route-facing CHARGE/CREDIT guard. NO-OP for humans; throws for a service
 * account that violates provenance, the name rule, or the ceiling.
 */
export function assertServiceAccountChargeAllowed({ user, body = {}, maxLine }) {
  if (!user?.isServiceAccount) return; // humans: strict no-op
  throwIfNotOk(checkServiceAccountCharge({
    author: body.author,
    ticketId: body.ticketId,
    name: body.name,
    amount: body.amount,
    maxLine
  }));
}

// Default absolute per-transaction ceiling (USD) when the tenant has not set an
// override. Deliberately conservative (fail-safe LOW) for an autonomous agent.
export const DEFAULT_VOZIA_CEILING = 2000;

/**
 * Generalized per-tenant ceiling resolver. Reads an AppSetting keyed exactly like
 * module-access.js's scopedSettingKey pattern:
 *   `tenant:<tenantId>:<settingKey>`     (or bare `<settingKey>` when tenantId is null)
 * Stored value may be a bare number or JSON-wrapped; anything non-numeric, <=0,
 * or a read failure falls back to `defaultAmt` (fail-safe LOW, never fail-open to
 * a huge ceiling).
 *
 * `deps.prisma` is injectable for unit tests; prod lazily imports the client so
 * pure guard tests never need the query-engine binary.
 *
 * Concrete callers:
 *   resolveVoziaCeiling(tenantId, 'voziaMaxRefundAmount',   2000, deps)  // CAP 2
 *   resolveVoziaCeiling(tenantId, 'voziaMaxChargeLineAmount', 2000, deps)  // CAP 3+4
 */
export async function resolveVoziaCeiling(tenantId, settingKey, defaultAmt = DEFAULT_VOZIA_CEILING, deps = {}) {
  const key = tenantId ? `tenant:${tenantId}:${settingKey}` : settingKey;
  try {
    const prisma = deps.prisma || (await import('../../lib/prisma.js')).prisma;
    const row = await prisma.appSetting.findUnique({ where: { key } });
    if (!row?.value) return defaultAmt;
    let parsed = row.value;
    // Tolerate both a bare "2000" and a JSON-encoded number/string.
    try {
      parsed = JSON.parse(row.value);
    } catch {
      parsed = row.value;
    }
    const n = Number(parsed);
    return Number.isFinite(n) && n > 0 ? n : defaultAmt;
  } catch {
    return defaultAmt; // read failure → conservative default
  }
}
