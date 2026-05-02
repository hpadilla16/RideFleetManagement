import { Router } from 'express';
import { storeBoardService } from './store-board.service.js';

/**
 * Public token-based endpoint for the in-store kiosk display. NO JWT —
 * the URL token is the authentication.
 *
 * Mounted at `/api/public/store-board` from main.js.
 *
 *   GET /api/public/store-board/:token
 *     Optional query: ?date=YYYY-MM-DD&tz=America/Puerto_Rico
 *     The kiosk frontend sends both based on its browser's timezone.
 *     Returns: { generatedAt, date, timezone, tenant, location, kiosk,
 *                pickups, tomorrowAmPickups, returns, summary }
 */
export const storeBoardPublicRouter = Router();

storeBoardPublicRouter.get('/:token', async (req, res, next) => {
  try {
    const out = await storeBoardService.getBoardByToken({
      token: req.params.token,
      date: req.query?.date,
      tz: req.query?.tz
    });
    res.json(out);
  } catch (e) {
    const status = e?.statusCode || (/(not found|invalid|revoked)/i.test(String(e?.message || '')) ? 404 : 500);
    if (status === 403) return res.status(403).json({ error: e.message });
    if (status === 404) return res.status(404).json({ error: e.message });
    if (status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});
