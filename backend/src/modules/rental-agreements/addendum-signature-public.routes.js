import { Router } from 'express';
import {
  findAddendumByToken,
  submitAddendumSignature
} from './addendum-signature-public.service.js';
import {
  attachPublicRequestMeta,
  createPublicRateLimitGuard
} from '../../middleware/public-endpoint-guards.js';

/**
 * Public token-based endpoints for customer self-service signing of rental
 * agreement addendums. No JWT — the URL token is the auth.
 *
 * Mounted at `/api/public/addendum-signature` from main.js, mirroring the
 * existing public-booking router pattern.
 *
 *   GET  /api/public/addendum-signature/:token             — load context
 *   POST /api/public/addendum-signature/:token/signature   — submit signature
 */
export const addendumSignaturePublicRouter = Router();

// Per-IP rate-limit guards for the public addendum-signature endpoints.
// Token is 192-bit so brute force is infeasible, but uncapped routes
// enable DoS amplification + token-existence enumeration.
// See doc/security-audit-2026-05-19.md §H3.
const addendumRead = [
  attachPublicRequestMeta('addendum-signature-read'),
  createPublicRateLimitGuard({ name: 'addendum-signature-read', maxRequests: 60, windowMs: 60 * 1000 })
];
const addendumWrite = [
  attachPublicRequestMeta('addendum-signature-write'),
  createPublicRateLimitGuard({ name: 'addendum-signature-write', maxRequests: 20, windowMs: 60 * 1000 })
];

addendumSignaturePublicRouter.get('/:token', addendumRead, async (req, res, next) => {
  try {
    const data = await findAddendumByToken(req.params.token);
    res.json(data);
  } catch (e) {
    const msg = String(e?.message || '');
    if (/invalid|expired|not found|required/i.test(msg)) {
      return res.status(404).json({ error: msg });
    }
    next(e);
  }
});

addendumSignaturePublicRouter.post('/:token/signature', addendumWrite, async (req, res, next) => {
  try {
    const result = await submitAddendumSignature(req.params.token, req.body || {}, {
      ip: req.ip
    });
    res.json(result);
  } catch (e) {
    const msg = String(e?.message || '');
    if (/already signed|voided/i.test(msg)) {
      return res.status(409).json({ error: msg });
    }
    if (/invalid|expired|not found/i.test(msg)) {
      return res.status(404).json({ error: msg });
    }
    if (/required|too large/i.test(msg)) {
      return res.status(400).json({ error: msg });
    }
    next(e);
  }
});
