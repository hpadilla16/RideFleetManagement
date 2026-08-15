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
  createOptionalIdempotencyGuard,
} from '../../middleware/public-endpoint-guards.js';
import { requireRole } from '../../middleware/auth.js';
import { userAllowedLocationIds } from '../../lib/tenant-scope.js';
import { prisma } from '../../lib/prisma.js';
import { shuttleTrackerService } from './shuttle-tracker.service.js';
import { shuttleRequestsService } from './shuttle-requests.service.js';

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

const requestGuards = [
  attachPublicRequestMeta('public-shuttle-request'),
  // One real customer presses the button once, maybe twice. 5/min per IP is
  // generous for humans and useless for a flooder — and the service itself is
  // idempotent per reservation (an open request absorbs repeats), so even the
  // 5 collapse into ONE bus.
  createPublicRateLimitGuard({ name: 'public-shuttle-request', maxRequests: 5, windowMs: 60 * 1000 }),
  createOptionalIdempotencyGuard({ name: 'public-shuttle-request' }),
];

/**
 * "I'm at the curb — send the shuttle." ON_DEMAND locations only.
 *
 * Everything identifying comes from the TOKEN (reservation → name, phone);
 * the body may only size the party and describe where they stand. Failures
 * are the same bare 404 as the GET — an unusable token never explains itself.
 */
shuttleTrackerPublicRouter.post('/:token/request', requestGuards, async (req, res, next) => {
  try {
    const ctx = await shuttleTrackerService.publicRequestContext(req.params.token);
    if (!ctx) return res.status(404).json({ error: 'Not found' });

    const customerName = `${ctx.reservation.customer?.firstName || ''} ${ctx.reservation.customer?.lastName || ''}`.trim() || 'Customer';
    const { request, deduplicated } = await shuttleRequestsService.create({
      tenantId: ctx.reservation.tenantId,
      locationId: ctx.reservation.pickupLocationId,
      reservationId: ctx.reservation.id,
      customerName,
      customerPhone: ctx.reservation.customer?.phone || '',
      partySize: req.body?.partySize,
      pickupNote: String(req.body?.pickupNote || '').slice(0, 280),
      source: 'PUBLIC_LINK',
    });

    res.setHeader('Cache-Control', 'no-store');
    // Whitelisted like every public payload: enough for the page to say "on
    // its way" and absorb double-taps, nothing about the queue behind it.
    res.json({ ok: true, deduplicated, status: request.status });
  } catch (e) { next(e); }
});

/**
 * Staff-side tracker configuration, one row per location.
 *
 * Mounted at /api/shuttle-tracker with requireAuth + tenantRateLimit (main.js);
 * writes gated here to the same author tier as the rest of Settings. Tenant
 * always comes from the TOKEN — the location is verified to belong to it, and
 * every vehicle id is verified too, so a config can never point the public
 * page at another tenant's GPS.
 */
export const shuttleTrackerAdminRouter = Router();
const requireSettingsAuthor = requireRole('SUPER_ADMIN', 'ADMIN', 'OPS');

const MODES = ['OFF', 'ON_DEMAND', 'NON_STOP'];

/**
 * Tenant AND branch scope (QA, 2026-08-15 — same rule locations.service
 * learned on 2026-07-24): a LAX-scoped admin must not read or rewrite
 * Orlando's tracker. Out-of-scope looks identical to nonexistent.
 */
async function scopedLocation(req, locationId) {
  const location = await prisma.location.findFirst({
    where: { id: locationId, tenantId: req.user.tenantId },
    select: { id: true },
  });
  if (!location) return null;
  const allowed = userAllowedLocationIds(req.user);
  if (Array.isArray(allowed) && allowed.length && !allowed.includes(locationId)) return null;
  return location;
}

shuttleTrackerAdminRouter.get('/config', requireSettingsAuthor, async (req, res, next) => {
  try {
    const locationId = String(req.query?.locationId || '').trim();
    if (!locationId) return res.status(400).json({ error: 'locationId is required' });
    if (!(await scopedLocation(req, locationId))) return res.status(404).json({ error: 'Location not found' });

    const row = await prisma.shuttleTrackerConfig.findUnique({ where: { locationId } });
    res.json({
      locationId,
      mode: row?.mode || 'OFF',
      vehicleIds: Array.isArray(row?.vehicleIdsJson) ? row.vehicleIdsJson : [],
      headwayMinutes: row?.headwayMinutes ?? 10,
    });
  } catch (e) { next(e); }
});

shuttleTrackerAdminRouter.put('/config', requireSettingsAuthor, async (req, res, next) => {
  try {
    const body = req.body || {};
    const locationId = String(body.locationId || '').trim();
    const mode = String(body.mode || 'OFF').toUpperCase();
    const headwayMinutes = Number(body.headwayMinutes);
    const vehicleIds = Array.isArray(body.vehicleIds)
      ? [...new Set(body.vehicleIds.map((v) => String(v || '').trim()).filter(Boolean))]
      : [];

    if (!locationId) return res.status(400).json({ error: 'locationId is required' });
    if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });
    if (!Number.isFinite(headwayMinutes) || headwayMinutes < 1 || headwayMinutes > 120) {
      return res.status(400).json({ error: 'headwayMinutes must be between 1 and 120' });
    }

    if (!(await scopedLocation(req, locationId))) return res.status(404).json({ error: 'Location not found' });

    // Ids that no longer resolve to this tenant are DROPPED, not rejected
    // (QA, 2026-08-15): vehicles are hard-deleted when sold, and a stale id
    // the UI can't even render would otherwise brick every save — including
    // the save that turns the tracker OFF.
    let ownedIds = [];
    if (vehicleIds.length) {
      const owned = await prisma.vehicle.findMany({
        where: { id: { in: vehicleIds }, tenantId: req.user.tenantId },
        select: { id: true },
      });
      ownedIds = owned.map((v) => v.id);
    }
    if (mode !== 'OFF' && !ownedIds.length) {
      return res.status(400).json({ error: 'Pick at least one shuttle vehicle before turning the tracker on' });
    }

    const data = { tenantId: req.user.tenantId, locationId, mode, vehicleIdsJson: ownedIds, headwayMinutes };
    const row = await prisma.shuttleTrackerConfig.upsert({
      where: { locationId },
      // tenantId refreshes on update too — a re-tenanted location must not
      // keep a config stamped with the old tenant (it would 404 every link
      // while Settings shows a healthy mode-ON row).
      update: { tenantId: data.tenantId, mode: data.mode, vehicleIdsJson: data.vehicleIdsJson, headwayMinutes: data.headwayMinutes },
      create: data,
    });
    res.json({
      locationId,
      mode: row.mode,
      vehicleIds: Array.isArray(row.vehicleIdsJson) ? row.vehicleIdsJson : [],
      headwayMinutes: row.headwayMinutes,
    });
  } catch (e) { next(e); }
});
