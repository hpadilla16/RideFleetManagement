import { Router } from 'express';
import { marketObservationsService } from './market-observations.service.js';
import { scopeFor } from '../../lib/tenant-scope.js';

/**
 * Read-only API surface for the Market Intelligence UI:
 *   GET /api/market/summary?airport=SJU
 *   GET /api/market/history?airport=SJU&sipp=IFAR&days=14
 *
 * Both endpoints feed off MarketObservation rows produced by the Browserbase
 * scraper (droplet cron, see /root/ridefleet-scraper/run_all_profiles.sh).
 * All queries tenant-scoped via scopeFor(req).
 */
export const marketObservationsRouter = Router();

function handle(err, res, next) {
  if (err?.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
  return next(err);
}

marketObservationsRouter.get('/summary', async (req, res, next) => {
  try {
    const out = await marketObservationsService.getMarketSummary({
      airport: req.query.airport,
      scope: scopeFor(req),
    });
    res.json(out);
  } catch (e) {
    handle(e, res, next);
  }
});

// RateHighway-style Excel for the whole airport (latest run): prices + suggested by
// vehicle class (SIPP) and by day. Discoverable from the /market dashboard.
marketObservationsRouter.get('/export.xlsx', async (req, res, next) => {
  try {
    const { buffer, filename } = await marketObservationsService.buildAirportExportWorkbook({
      airport: req.query.airport,
      scope: scopeFor(req),
    });
    const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', body.byteLength);
    res.end(body);
  } catch (e) {
    handle(e, res, next);
  }
});

marketObservationsRouter.get('/history', async (req, res, next) => {
  try {
    const out = await marketObservationsService.getMarketHistory({
      airport: req.query.airport,
      sipp: req.query.sipp,
      days: req.query.days,
      mode: req.query.mode,
      scope: scopeFor(req),
    });
    res.json(out);
  } catch (e) {
    handle(e, res, next);
  }
});
