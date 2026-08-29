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
import { requireRole, isSuperAdmin } from '../../middleware/auth.js';
import { userAllowedLocationIds } from '../../lib/tenant-scope.js';
import { prisma } from '../../lib/prisma.js';
import { shuttleTrackerService, storeCustomerLocation } from './shuttle-tracker.service.js';
import { shuttleRequestsService } from './shuttle-requests.service.js';
import { parseIntakeConfig, validateIntake, validateIntakeInput } from './shuttle-intake.js';
import { validateCustomerFix } from './shuttle-customer-location.js';

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

    // Phase 3 intake (Screen 7): validated against the LOCATION's config.
    // Flag off — the pre-Phase-3 contract, byte-for-byte (partySize passes
    // through to the same legacy clamp; bags stores only when incidentally
    // valid). Flag on — party+bags REQUIRED within the sede's caps, and the
    // 400 says which and what range, nothing about the token.
    const intakeCfg = parseIntakeConfig(ctx.config);
    const intake = validateIntake(req.body || {}, intakeCfg);
    if (!intake.ok) return res.status(400).json({ error: intake.error });

    // Which pickup spot intake pointed the customer at. Fail-closed to null:
    // only an ACTIVE pickup-spot zone of THIS tenant at THIS sede may be
    // referenced — anything else (foreign id, deleted zone, garbage) is
    // dropped, never stored and never an oracle.
    let pickupSpotZoneId = null;
    const claimedSpot = String(req.body?.pickupSpotZoneId || '').trim();
    if (claimedSpot) {
      const spot = await prisma.shuttleZone.findFirst({
        where: {
          id: claimedSpot,
          tenantId: ctx.reservation.tenantId,
          locationId: ctx.reservation.pickupLocationId,
          isPickupSpot: true,
          active: true,
        },
        select: { id: true },
      }).catch(() => null);
      pickupSpotZoneId = spot?.id || null;
    }

    const customerName = `${ctx.reservation.customer?.firstName || ''} ${ctx.reservation.customer?.lastName || ''}`.trim() || 'Customer';
    const { request, deduplicated } = await shuttleRequestsService.create({
      tenantId: ctx.reservation.tenantId,
      locationId: ctx.reservation.pickupLocationId,
      reservationId: ctx.reservation.id,
      customerName,
      customerPhone: ctx.reservation.customer?.phone || '',
      partySize: intake.values.partySize,
      bags: intake.values.bags,
      pickupSpotZoneId,
      pickupNote: String(req.body?.pickupNote || '').slice(0, 280),
      source: 'PUBLIC_LINK',
      // Phase 2 arrival SMS consent (approved #21): a bare boolean is the
      // only thing the body may say about it — identity still comes from the
      // token, and the SMS goes to the RESERVATION's phone, never a typed
      // one. Absent (an older page) = undefined, so a repeat tap without the
      // field never silently clears an earlier opt-in.
      smsOptIn: typeof req.body?.smsOptIn === 'boolean' ? req.body.smsOptIn : undefined,
    });

    res.setHeader('Cache-Control', 'no-store');
    // Whitelisted like every public payload: enough for the page to say "on
    // its way" and absorb double-taps, nothing about the queue behind it.
    res.json({ ok: true, deduplicated, status: request.status });
  } catch (e) { next(e); }
});

const locationGuards = [
  attachPublicRequestMeta('public-shuttle-location'),
  // The consented page pushes a fix every ~10s while sharing — a real
  // customer is ~6/min, same envelope as the tracker poll. 60/min per IP.
  createPublicRateLimitGuard({ name: 'public-shuttle-location', maxRequests: 60, windowMs: 60 * 1000 }),
];

/**
 * Phase 3 (Screen 9, privacy constraints binding): the customer's own
 * ephemeral fix. Token-validated exactly like the tracker GET, and requires
 * an OPEN request — sharing exists only while someone waits. The fix goes to
 * Redis with a 5-minute TTL and NOWHERE else: no DB row, no log line, no
 * audit metadata; the response confirms and echoes NOTHING back.
 */
shuttleTrackerPublicRouter.post('/:token/location', locationGuards, async (req, res, next) => {
  try {
    const ctx = await shuttleTrackerService.publicLocationContext(req.params.token);
    if (!ctx) return res.status(404).json({ error: 'Not found' });

    const fix = validateCustomerFix(req.body || {});
    if (!fix.ok) return res.status(400).json({ error: fix.error });

    const stored = await storeCustomerLocation(ctx.request.id, fix.fix);
    res.setHeader('Cache-Control', 'no-store');
    // `active: false` = Redis is down — the page can fall back to "sharing
    // unavailable" instead of pretending. Nothing else crosses.
    res.json({ ok: true, active: stored === true });
  } catch (e) { next(e); }
});

/**
 * Staff-side tracker configuration, one row per location.
 *
 * Mounted at /api/shuttle-tracker with requireAuth + tenantRateLimit (main.js);
 * writes gated here to the same author tier as the rest of Settings. The
 * location is verified to belong to the resolved tenant, and every vehicle id
 * is verified too, so a config can never point the public page at another
 * tenant's GPS.
 */
export const shuttleTrackerAdminRouter = Router();
const requireSettingsAuthor = requireRole('SUPER_ADMIN', 'ADMIN', 'OPS');

const MODES = ['OFF', 'ON_DEMAND', 'NON_STOP'];

/**
 * Which tenant this request operates on. IDENTICAL to the sibling
 * shuttle-zones / onestepgps helper, deliberately: a SUPER_ADMIN browsing
 * another tenant's location passes ?tenantId= (or body.tenantId on the PUT)
 * and falls back to their own; ANY other role ignores the parameter entirely
 * and gets req.user.tenantId, so a non-super can never widen scope by
 * appending a query string.
 *
 * Added 2026-08-26: both handlers resolved the tenant from req.user.tenantId
 * only, so a super admin operating inside a tenant got a 404 on GET /config
 * for every location — and the Settings card silently collapsed to a one-line
 * "Shuttle tracker: Location not found" (cost an hour of live debugging).
 */
function resolveTenantId(req) {
  if (isSuperAdmin(req.user)) {
    const t = req.query?.tenantId || req.body?.tenantId || req.user?.tenantId;
    if (!t) throw Object.assign(new Error('tenantId is required (SUPER_ADMIN must pick one)'), { status: 400 });
    return String(t);
  }
  return req.user?.tenantId;
}

/**
 * Tenant AND branch scope (QA, 2026-08-15 — same rule locations.service
 * learned on 2026-07-24): a LAX-scoped admin must not read or rewrite
 * Orlando's tracker. Out-of-scope looks identical to nonexistent.
 */
async function scopedLocation(req, locationId, tenantId) {
  if (!tenantId) return null;
  const location = await prisma.location.findFirst({
    where: { id: locationId, tenantId },
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
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
    if (!(await scopedLocation(req, locationId, tenantId))) return res.status(404).json({ error: 'Location not found' });

    const row = await prisma.shuttleTrackerConfig.findUnique({ where: { locationId } });
    res.json({
      locationId,
      mode: row?.mode || 'OFF',
      vehicleIds: Array.isArray(row?.vehicleIdsJson) ? row.vehicleIdsJson : [],
      headwayMinutes: row?.headwayMinutes ?? 10,
      // Phase 3 intake knobs — parse-normalized, so the UI always sees the
      // effective values (defaults included), never the raw JSON.
      intake: parseIntakeConfig(row),
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

    // Phase 3 intake knobs. ABSENT = keep what is stored (an older Settings
    // page must not silently reset a sede's intake); null = clear; an object
    // is validated. The flag is what keeps every un-opted tenant unchanged.
    let intakeProvided = 'intake' in body;
    let intakeClean = null;
    if (intakeProvided) {
      const v = validateIntakeInput(body.intake);
      if (!v.ok) return res.status(400).json({ error: v.error });
      intakeClean = v.intake;
    }

    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
    if (!(await scopedLocation(req, locationId, tenantId))) return res.status(404).json({ error: 'Location not found' });

    // Ids that no longer resolve to this tenant are DROPPED, not rejected
    // (QA, 2026-08-15): vehicles are hard-deleted when sold, and a stale id
    // the UI can't even render would otherwise brick every save — including
    // the save that turns the tracker OFF.
    let ownedIds = [];
    if (vehicleIds.length) {
      const owned = await prisma.vehicle.findMany({
        where: { id: { in: vehicleIds }, tenantId },
        select: { id: true },
      });
      ownedIds = owned.map((v) => v.id);
    }
    if (mode !== 'OFF' && !ownedIds.length) {
      return res.status(400).json({ error: 'Pick at least one shuttle vehicle before turning the tracker on' });
    }

    const data = { tenantId, locationId, mode, vehicleIdsJson: ownedIds, headwayMinutes };
    const intakePatch = intakeProvided ? { intakeJson: intakeClean } : {};
    const row = await prisma.shuttleTrackerConfig.upsert({
      where: { locationId },
      // tenantId refreshes on update too — a re-tenanted location must not
      // keep a config stamped with the old tenant (it would 404 every link
      // while Settings shows a healthy mode-ON row).
      update: { tenantId: data.tenantId, mode: data.mode, vehicleIdsJson: data.vehicleIdsJson, headwayMinutes: data.headwayMinutes, ...intakePatch },
      create: { ...data, ...intakePatch },
    });
    res.json({
      locationId,
      mode: row.mode,
      vehicleIds: Array.isArray(row.vehicleIdsJson) ? row.vehicleIdsJson : [],
      headwayMinutes: row.headwayMinutes,
      intake: parseIntakeConfig(row),
    });
  } catch (e) { next(e); }
});
