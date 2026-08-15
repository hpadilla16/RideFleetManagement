/**
 * Public shuttle tracker endpoint.
 *
 * Mounted at /api/public/shuttle — NO auth, so the surface is deliberately
 * one GET, one token, one whitelisted payload. Everything unusable (unknown
 * token, expired, revoked, tracker off) is the same bare 404: an
 * unauthenticated caller learns nothing from WHY a token failed, and an
 * enumerator gets no oracle to tell "never existed" from "expired last week".
 */
import { Router } from 'express';
import {
  attachPublicRequestMeta,
  createPublicRateLimitGuard,
} from '../../middleware/public-endpoint-guards.js';
import { shuttleTrackerService } from './shuttle-tracker.service.js';

export const shuttleTrackerPublicRouter = Router();

const guards = [
  attachPublicRequestMeta('public-shuttle-tracker'),
  // The page polls every 10–15s, so a real customer is ~6/min. 60/min per IP
  // leaves room for a family on hotel NAT without letting one IP scrape.
  createPublicRateLimitGuard({ name: 'public-shuttle-tracker', maxRequests: 60, windowMs: 60 * 1000 }),
];

shuttleTrackerPublicRouter.get('/:token', guards, async (req, res, next) => {
  try {
    const state = await shuttleTrackerService.publicState(req.params.token);
    if (!state) return res.status(404).json({ error: 'Not found' });
    // Positions go stale in seconds — never let a proxy cache one.
    res.setHeader('Cache-Control', 'no-store');
    res.json(state);
  } catch (e) { next(e); }
});
