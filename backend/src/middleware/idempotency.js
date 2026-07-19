/**
 * VozIA Fase 4 (2026-07-03) — Idempotency-Key middleware.
 *
 * Wraps write endpoints consumed by the VozIA voice agent so a retried call
 * (network blip, agent restart) can never double-apply. Ledger lives in the
 * IdempotencyKey table (prisma/schema.prisma), one row per (userId, key).
 *
 * Contract:
 *   - No Idempotency-Key header:
 *       service account → 400 (Hector decision 2026-07-03: hard requirement)
 *       human           → passthrough (staff UI unaffected)
 *   - Bad key format (^[A-Za-z0-9._:-]{8,128}$) → 400
 *   - First sight of a key → INSERT IN_PROGRESS + run the handler; res.json
 *     is wrapped to persist statusCode+body (including 4xx/5xx) on completion.
 *   - Same key + same payload, COMPLETED → replay stored response with
 *     header `Idempotency-Replayed: true`; handler does NOT run again.
 *   - Same key + same payload, IN_PROGRESS → 409 (request in flight).
 *   - Same key + DIFFERENT payload (sha256 of JSON body) → 422.
 *   - Rows expire after 24h; expired rows are opportunistically deleted on
 *     each insert.
 *
 * Factory takes injectable deps (same pattern as createTenantRateLimit in
 * tenant-rate-limit.js): `deps.prisma` for tests, `deps.now` for clocks.
 * Prisma is lazily imported in prod so unit tests never need the query
 * engine binary.
 */

import crypto from 'node:crypto';
import logger from '../lib/logger.js';

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

// NON-RECYCLE kinds — a stuck IN_PROGRESS key past its TTL must NOT be
// auto-recycled; it surfaces a 409 reconcile so a human resolves it (via the
// SUPER_ADMIN idempotency-resolve endpoint) instead of the op silently re-running.
//   - 'payment' / 'refund': a died-mid-flight op may have moved money at the
//     gateway while the ledger row never reached COMPLETED — recycling risks a
//     double-charge / double-refund.
//   - 'charge': a credit/service line is a CUMULATIVE balance mutation. Unlike a
//     'note' (re-appending the same line is cosmetic), re-applying a −$500 credit
//     moves the balance again = a $500 giveaway. The idempotency key only de-dupes
//     WITHIN the TTL; a same-key retry >24h later (agent restart, queue replay)
//     would double-apply. So 'charge' is NON-recyclable too (Innovation review
//     2026-07-04). Only truly benign, content-idempotent kinds ('note') recycle.
// S27 W-D (Innovation 2026-07-19): 'vozia-extend' creates cumulative charge
// rows — same class as 'charge'. The extend service self-guards (newReturnAt
// must be after the current return), but that guard lives in another module;
// the one-line hedge here costs nothing.
const NO_RECYCLE_KINDS = new Set(['payment', 'refund', 'charge', 'vozia-extend']);

async function defaultGetPrisma() {
  const mod = await import('../lib/prisma.js');
  return mod.prisma;
}

export function idempotency({ kind }, deps = {}) {
  const _getPrisma = deps.prisma ? async () => deps.prisma : defaultGetPrisma;
  const _now = deps.now || (() => Date.now());

  return async function idempotencyMiddleware(req, res, next) {
    try {
      const rawHeader = req.headers['idempotency-key'];
      const key = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

      if (!key) {
        if (req.user?.isServiceAccount) {
          return res.status(400).json({ error: 'Idempotency-Key header is required' });
        }
        return next();
      }
      if (!IDEMPOTENCY_KEY_RE.test(String(key))) {
        return res.status(400).json({ error: 'Invalid Idempotency-Key — expected 8-128 chars of A-Za-z0-9._:-' });
      }

      const userId = req.user?.id || req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const prisma = await _getPrisma();
      const now = new Date(_now());
      const requestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(req.body ?? {}))
        .digest('hex');

      // Opportunistic cleanup — frees keys past their TTL so they can be reused.
      //
      // MONEY-SAFETY (VozIA Fase 6, 2026-07-04): for MONEY kinds (payment/refund)
      // we MUST NOT auto-recycle a key that is still IN_PROGRESS past the TTL. If a
      // process died mid-op, the gateway may have moved funds while the ledger row
      // never reached COMPLETED — silently freeing that key would let a post-TTL
      // retry DOUBLE-charge / DOUBLE-refund the customer. So for money kinds we only
      // reap COMPLETED expired rows here and surface any stuck IN_PROGRESS row as a
      // 409 reconcile (below). Notes and charges (pure balance mutations, no gateway)
      // keep the original blanket cleanup.
      try {
        const where = NO_RECYCLE_KINDS.has(kind)
          ? { expiresAt: { lt: now }, status: 'COMPLETED' }
          : { expiresAt: { lt: now } };
        await prisma.idempotencyKey.deleteMany({ where });
      } catch (err) {
        logger.warn('[idempotency] expired-row cleanup failed (continuing)', { message: err?.message, kind });
      }

      let created = false;
      try {
        await prisma.idempotencyKey.create({
          data: {
            tenantId: req.user?.tenantId || null,
            userId,
            key: String(key),
            kind,
            requestHash,
            status: 'IN_PROGRESS',
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS)
          }
        });
        created = true;
      } catch (err) {
        if (err?.code !== 'P2002') throw err; // unique violation on (userId, key)
      }

      if (!created) {
        const existing = await prisma.idempotencyKey.findUnique({
          where: { userId_key: { userId, key: String(key) } }
        });
        if (!existing) {
          // Raced a concurrent delete — treat as in-flight; the client retries.
          return res.status(409).json({ error: 'Request with this Idempotency-Key is already in flight' });
        }
        if (existing.requestHash !== requestHash) {
          return res.status(422).json({ error: 'Idempotency-Key reused with a different payload' });
        }
        if (existing.status === 'COMPLETED') {
          res.setHeader('Idempotency-Replayed', 'true');
          let body = null;
          try {
            body = existing.responseBody ? JSON.parse(existing.responseBody) : null;
          } catch {
            body = null;
          }
          return res.status(existing.statusCode || 200).json(body);
        }
        // MONEY-SAFETY (VozIA Fase 6, 2026-07-04): a MONEY key (payment/refund)
        // still IN_PROGRESS PAST its TTL was never freed by the cleanup above (we
        // only reap COMPLETED money rows). It means a prior op crashed mid-flight
        // and its true outcome is unknown — return an explicit reconcile signal so
        // support can check the gateway rather than the client re-submitting.
        if (NO_RECYCLE_KINDS.has(kind) && existing.expiresAt && new Date(existing.expiresAt) < now) {
          return res.status(409).json({ error: 'Payment is being reconciled, contact support', reconcile: true });
        }
        return res.status(409).json({ error: 'Request with this Idempotency-Key is already in flight' });
      }

      // Persist the handler's outcome — success AND error responses alike —
      // so replays return exactly what the first attempt produced.
      const originalJson = res.json.bind(res);
      let persisted = false;
      res.json = (body) => {
        if (!persisted) {
          persisted = true;
          let responseBody = null;
          try {
            responseBody = JSON.stringify(body);
          } catch {
            responseBody = null;
          }
          prisma.idempotencyKey
            .update({
              where: { userId_key: { userId, key: String(key) } },
              data: { statusCode: res.statusCode || 200, responseBody, status: 'COMPLETED' }
            })
            .catch((err) => logger.warn('[idempotency] failed to persist response', { message: err?.message, kind }));
        }
        return originalJson(body);
      };

      return next();
    } catch (e) {
      return next(e);
    }
  };
}
