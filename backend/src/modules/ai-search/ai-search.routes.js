import { Router } from 'express';
import { extractSearchIntent } from './ai-search.service.js';
import { attachPublicRequestMeta, createPublicRateLimitGuard } from '../../middleware/public-endpoint-guards.js';

export const aiSearchRouter = Router();

const aiRateLimit = [
  attachPublicRequestMeta('ai-search'),
  createPublicRateLimitGuard({ name: 'ai-search', maxRequests: 20, windowMs: 60 * 1000 })
];

// Extract search intent from natural language
aiSearchRouter.post('/intent', aiRateLimit, async (req, res, next) => {
  try {
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });
    if (query.length > 500) return res.status(400).json({ error: 'query too long' });
    res.json(await extractSearchIntent(query));
  } catch (e) {
    next(e);
  }
});
