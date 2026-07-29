import { Router } from 'express';
import { marketObservationsService } from './market-observations.service.js';
import { scopeFor } from '../../lib/tenant-scope.js';

/**
 * Read-only API surface for the Market Intelligence UI:
 *   GET /api/market/airports
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

/**
 * `?providers=Expedia,Priceline` → ['Expedia','Priceline']; absent/blank → null
 * (no filtering). DISPLAY ONLY — the pricing/suggestion math never receives
 * this, so narrowing the view can never change what we price against.
 */
function parseProviders(raw) {
  if (raw == null) return null;
  const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

// The airports this tenant scrapes — drives every airport picker in the UI.
// Listed from the tenant's ACTIVE scrape profiles, not from Location, because
// the key is the profile's IATA locationCode. See listMarketAirports().
marketObservationsRouter.get('/airports', async (req, res, next) => {
  try {
    const out = await marketObservationsService.listMarketAirports({ scope: scopeFor(req) });
    res.json(out);
  } catch (e) {
    handle(e, res, next);
  }
});

// The OTAs actually quoting at this airport in the last 7 days, with counts —
// drives the dashboard's provider filter chips. Data-driven on purpose: a
// hardcoded list would rot the moment Kayak surfaces a new booking site.
marketObservationsRouter.get('/providers', async (req, res, next) => {
  try {
    const out = await marketObservationsService.listMarketProviders({
      airport: req.query.airport,
      scope: scopeFor(req),
    });
    res.json(out);
  } catch (e) {
    handle(e, res, next);
  }
});

marketObservationsRouter.get('/summary', async (req, res, next) => {
  try {
    const out = await marketObservationsService.getMarketSummary({
      airport: req.query.airport,
      scope: scopeFor(req),
      providers: parseProviders(req.query.providers),
    });
    res.json(out);
  } catch (e) {
    handle(e, res, next);
  }
});

// RateHighway-style Excel for the whole airport, covering the forward booking window
// (?days=7|14|30 from the dashboard's range selector): cheapest competitor + suggested +
// current rate per (pickup day × SIPP). Discoverable from the /market dashboard.
marketObservationsRouter.get('/export.xlsx', async (req, res, next) => {
  try {
    const { buffer, filename } = await marketObservationsService.buildAirportExportWorkbook({
      airport: req.query.airport,
      days: req.query.days,
      scope: scopeFor(req),
      providers: parseProviders(req.query.providers),
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
      providers: parseProviders(req.query.providers),
    });
    res.json(out);
  } catch (e) {
    handle(e, res, next);
  }
});
