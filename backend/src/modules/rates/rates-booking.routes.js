/**
 * GET /api/rates/rental-minimum — the minimum rental a branch will sell.
 *
 * Third instance of the same shape (2026-08-17). /api/rates is ADMIN/OPS +
 * settings because rate PLANS are pricing configuration. But the booking
 * wizard asks this endpoint how short a rental may be, and an AGENT was
 * getting a 403 — which the form caught and replaced with a hardcoded 24-hour
 * default. So every agent, at every tenant, has been booking against a
 * made-up minimum instead of the branch's own: a tenant selling 4-hour
 * hourly rentals could not, and one requiring 48 hours was not enforced.
 *
 * Quieter than the empty dropdowns it sits next to, and worse in a way: the
 * screen looked fine and the RULE was wrong.
 *
 * The answer is a policy number the person is about to be held to, not
 * configuration. Mounted before the gate, same as locations-selectable and
 * vehicle-types-selectable.
 */
import { Router } from 'express';
import { scopeFor } from '../../lib/tenant-scope.js';
import { ratesService } from './rates.service.js';

export const ratesBookingRouter = Router();

ratesBookingRouter.get('/rental-minimum', async (req, res, next) => {
  try {
    res.json(await ratesService.rentalMinimumFor({
      pickupLocationId: req.query.pickupLocationId ? String(req.query.pickupLocationId) : null,
      vehicleTypeId: req.query.vehicleTypeId ? String(req.query.vehicleTypeId) : null,
      at: req.query.pickupAt ? String(req.query.pickupAt) : null,
    }, scopeFor(req)));
  } catch (e) { next(e); }
});

export default ratesBookingRouter;
