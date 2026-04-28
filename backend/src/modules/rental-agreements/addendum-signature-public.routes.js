import { Router } from 'express';
import {
  findAddendumByToken,
  submitAddendumSignature
} from './addendum-signature-public.service.js';

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

addendumSignaturePublicRouter.get('/:token', async (req, res, next) => {
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

addendumSignaturePublicRouter.post('/:token/signature', async (req, res, next) => {
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
