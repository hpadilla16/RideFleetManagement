import { Router } from 'express';
import { locationsService } from './locations.service.js';
import { scopeFor } from '../../lib/tenant-scope.js';
import { parseLocationConfig } from '../../lib/location-config.js';

/**
 * VozIA Fase 2 (2026-07-03) — GET /api/locations/:id/hours
 *
 * Read-only operating-hours + pickup-instructions view of a location, safe
 * for ANY authenticated user (the VozIA AGENT service account has no
 * `settings` module, which gates the full locations router). Mounted in
 * main.js BEFORE the gated /api/locations router; non-matching paths fall
 * through to it.
 */
export const locationHoursRouter = Router();

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/**
 * Pure shape builder — unit-tested in location-hours.test.mjs.
 * Per-day semantics mirror resolveHoursForDate (reservations.service.js) and
 * customer-portal-self-service.js: `enabled` defaults to true when the day
 * entry is absent, and open/close fall back to the legacy single-window
 * operationsOpenTime/operationsCloseTime config keys. Malformed/absent
 * locationConfig parses to {} (parseLocationConfig), yielding all-days
 * enabled with empty times — "hours not configured", not an error.
 */
export function buildLocationHoursPayload(location) {
  const cfg = parseLocationConfig(location?.locationConfig);
  const rawWeekly = cfg?.weeklyHours && typeof cfg.weeklyHours === 'object' ? cfg.weeklyHours : {};
  const fallbackOpen = String(cfg?.operationsOpenTime || '').trim();
  const fallbackClose = String(cfg?.operationsCloseTime || '').trim();
  const weeklyHours = {};
  for (const day of DAY_KEYS) {
    const raw = rawWeekly?.[day] && typeof rawWeekly[day] === 'object' ? rawWeekly[day] : null;
    weeklyHours[day] = {
      enabled: raw?.enabled != null ? !!raw.enabled : true,
      open: String(raw?.open || fallbackOpen || '').trim(),
      close: String(raw?.close || fallbackClose || '').trim()
    };
  }
  return {
    id: location?.id ?? null,
    code: location?.code ?? null,
    name: location?.name ?? null,
    weeklyHours,
    pickupInstructions: String(cfg?.pickupInstructions || '').trim(),
    // Where to STAND for the shuttle (2026-08-07): its own field because the
    // shared pickupInstructions serves the customer portal too, where "call
    // us when you arrive" is right — and exactly wrong when Chloe reads it to
    // a customer who JUST called and whose bus is already dispatched. Falls
    // back to pickupInstructions so nothing regresses until a sede fills it.
    shuttlePickupInstructions: String(cfg?.shuttlePickupInstructions || cfg?.pickupInstructions || '').trim()
  };
}

locationHoursRouter.get('/:id/hours', async (req, res, next) => {
  try {
    const row = await locationsService.getById(req.params.id, scopeFor(req));
    if (!row) return res.status(404).json({ error: 'Location not found' });
    res.json(buildLocationHoursPayload(row));
  } catch (e) {
    next(e);
  }
});
