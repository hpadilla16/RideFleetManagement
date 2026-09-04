import crypto from 'node:crypto';
import { Router } from 'express';
import { checkRentalSpan, rentalSpanMessage } from '../rates/rental-minimum.js';
import { previewLocationMandatoryFees } from './reservation-pricing.service.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';
import { parseDateTimeInTz } from '../../lib/date-utils.js';
import { reservationsService } from './reservations.service.js';
import { looksLikeXlsx, parseReservationImportWorkbook } from './reservation-import-parse.js';
import { validateReservationCreate, validateReservationPatch } from './reservations.rules.js';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { normalizeCustomerEmail, messageFor, CUSTOMER_EMAIL_INVALID } from '../../lib/customer-email.js';
import { withTenantSchema } from '../../lib/tenant-routing.js';
import { sendEmail } from '../../lib/mailer.js';
import { renderBrandedEmail, resolveEmailBrand } from '../../lib/email-template.js';
import { rentalAgreementsService } from '../rental-agreements/rental-agreements.service.js';
import { reservationPricingService } from './reservation-pricing.service.js';
import { isAdminRole } from './swap-photos.js';
import { reservationAdditionalDriversService } from './reservation-additional-drivers.service.js';
import { settingsService } from '../settings/settings.service.js';
import { additionalServicesService } from '../additional-services/additional-services.service.js';
import { feesService } from '../fees/fees.service.js';
import { ratesService } from '../rates/rates.service.js';
import { locationsService } from '../locations/locations.service.js';
import { vehicleTypesService } from '../vehicle-types/vehicle-types.service.js';
import { activeVehicleBlockOverlapWhere } from '../vehicles/vehicle-blocks.js';
import { isSuperAdmin, requireCapability } from '../../middleware/auth.js';
import { franchiseService } from '../settings/franchise.service.js';
import { crossTenantScopeFor as scopeFor, scopeVisibilityCacheSegment } from '../../lib/tenant-scope.js';
import { vehicleProgramWhereForScope } from '../../lib/program-category.js';
import { parseLocationConfig } from '../../lib/location-config.js';
import { resolveCustomerFacingBrand, resolveBrandLocation } from '../../lib/tenant-brand.js';
import { missingRequiredCustomerFields } from '../../lib/precheckin-fields.js';
import { parseDepositRules, evaluateDepositRule } from '../../lib/deposit-rules.js';
import { cache } from '../../lib/cache.js';
import { globalKey } from '../../lib/cache/tenantKey.js';
import { compactStartRentalResponse } from './start-rental-compact.js';
import { maybeUploadCustomerDocument } from '../customers/customer-documents.js';
import { idempotency } from '../../middleware/idempotency.js';
import { reservationExtendService, assertRepriceable, isBaseRentalRow, isSameRentalWindow } from './reservation-extend.service.js';
import { validateVoziaNotePayload, buildVoziaNoteLine } from './vozia-note.js';
import { smartMatchReservation, maskCandidate, candidateMatchesVerification } from '../../lib/reservation-smart-match.js';
import { verifyProbeThrottle, isFailedVerifyProbe } from '../../lib/verify-probe-throttle.js';
import {
  validateVoziaCancelPayload,
  validateVoziaReschedulePayload,
  assertPrePickup
} from './vozia-reservation-ops.js';
import { quotesService } from '../quotes/quotes.service.js';
import {
  validateVoziaPatchPayload,
  applyVoziaReservationPatch
} from './vozia-reservation-patch.js';
// VozIA Fase 6 re-scope (2026-07-04) — CAP 3+4 charge/credit guard + ceiling.
import {
  assertServiceAccountChargeAllowed,
  resolveVoziaCeiling
} from '../rental-agreements/service-payment-guards.js';

export const reservationsRouter = Router();

/**
 * Honor an explicit 4xx `statusCode` set by the service layer.
 *
 * The service's `ensureNoVehicleConflict` guards both set `err.statusCode = 409`,
 * but the open-rental guard's message ("Vehicle is still out on open rental …")
 * does NOT match the `/vehicle conflict/i` string test the route catches on, so
 * it fell through to `next(e)` -> 500 instead of the intended 409 (Sentry -1P on
 * both the reservations PATCH and pre-check-in staff-complete).
 *
 * Shared rather than duplicated per-handler: the mapping is identical and string
 * -matching on messages is exactly what caused this bug — an explicit statusCode
 * is the contract.
 *
 * @returns {boolean} true if the error was handled and a response was sent.
 */
function sendExplicitStatusError(res, e) {
  // S27 W-D (QA minor-1): quotes.service errors carry `status`, not
  // `statusCode` — honor both conventions so a bad pickupAt on
  // reprice-preview/reschedule is a 400, not a 500 + Sentry noise.
  const sc = Number.isInteger(e?.statusCode)
    ? e.statusCode
    : (Number.isInteger(e?.status) ? e.status : null);
  if (sc !== null && sc >= 400 && sc < 500) {
    res.status(sc).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
    return true;
  }
  return false;
}

// VozIA Fase 6 re-scope — CAP 3+4 uses kind:'charge' idempotency. A charge/credit
// is a balance mutation (no gateway money), so a stuck key past its TTL may be
// safely recycled like a note — only 'payment'/'refund' get the no-recycle 409.
// A retried key within the TTL is still a no-op, so a double-submit can't
// double-apply. requireAuth runs at the mount; humans w/o a key pass through.
const chargeIdempotency = idempotency({ kind: 'charge' });

// VozIA — best-effort AuditLog for a service-account reservation money op. Never
// throws; ADDITIONAL context alongside the service's own ADMIN_OVERRIDE row so
// the VozIA action is tagged with source+ticket. (source:'vozia')
async function writeVoziaReservationAudit(reservation, req, meta = {}, kind = 'charge') {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: reservation?.tenantId || req.user?.tenantId || null,
        reservationId: reservation?.id || null,
        actorUserId: req.user?.sub || null,
        action: 'UPDATE',
        metadata: JSON.stringify({
          source: 'vozia',
          kind,
          ticketId: req.body?.ticketId || null,
          author: req.body?.author || null,
          ...meta
        })
      }
    });
  } catch {
    // audit is best-effort — never block or roll back the operation.
  }
}

// Short cooldown (30s) between customer-facing token issuances for the same reservation/kind.
// Prevents accidental double-clicks and abuse where a staff user could spam a customer's
// inbox or rotate tokens faster than they can be used. Per-worker (in-memory) guard;
// briefly bypassable under heavy cluster load — that's an acceptable trade-off for rate UX.
const TOKEN_ISSUANCE_COOLDOWN_MS = 30 * 1000;
function checkTokenIssuanceCooldown(reservationId, kind) {
  // Reservation IDs are globally-unique cuids; this is a short cross-process
  // cooldown to prevent double-issue/abuse, not a tenant-isolated cache.
  // globalKey makes the opt-out explicit. See PR-3b.
  const key = globalKey('token-issue', kind, reservationId);
  if (cache.get(key) !== undefined) return false;
  cache.set(key, 1, TOKEN_ISSUANCE_COOLDOWN_MS);
  return true;
}

// Caps reservation.notes growth. System events (signature/payment/email/override audit trail)
// append here; without this guard, rows grew unbounded and bloated every detail fetch.
// Keeps the most recent tail so operators still see the latest activity.
const MAX_NOTES_BYTES = 16 * 1024;
function appendSystemNote(existingNotes, line) {
  const base = existingNotes || '';
  const combined = base ? `${base}\n${line}` : line;
  if (combined.length <= MAX_NOTES_BYTES) return combined;
  return combined.slice(combined.length - MAX_NOTES_BYTES);
}

async function latestAgreementByReservationId(reservationId, scope = {}) {
  const row = await prisma.rentalAgreement.findFirst({
    where: {
      reservationId,
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true }
  });
  return row?.id || null;
}

async function ensureAgreementByReservationId(reservationId, scope = {}) {
  const existingId = await latestAgreementByReservationId(reservationId, scope);
  if (existingId) return existingId;
  const agreement = await rentalAgreementsService.startFromReservation(reservationId, scope);
  return agreement?.id || null;
}

function canManagePrecheckin(req) {
  const role = String(req.user?.role || '').toUpperCase();
  return ['SUPER_ADMIN', 'ADMIN', 'OPS', 'AGENT'].includes(role);
}

function canManagePricingOverrides(req) {
  const role = String(req.user?.role || '').toUpperCase();
  return ['SUPER_ADMIN', 'ADMIN', 'OPS', 'AGENT'].includes(role);
}

// Admin Corrections (Fase 1) — money-affecting fixes are ADMIN-only.
// The predicate itself lives in swap-photos.js (`isAdminRole`) so the swap-photo
// override, the dealership-loaner swap, and these routes cannot drift apart on
// what "admin" means. Behavior is unchanged: SUPER_ADMIN or ADMIN.
function canDoAdminCorrections(req) {
  return isAdminRole(req.user?.role);
}

function buildPrecheckinChecklist(reservation) {
  const customer = reservation?.customer || {};
  const items = [
    { key: 'contact', label: 'Contact Info', done: !!(customer.firstName && customer.lastName && customer.email && customer.phone) },
    { key: 'dob', label: 'Date of Birth', done: !!customer.dateOfBirth },
    { key: 'license', label: 'Driver License', done: !!(customer.licenseNumber && customer.licenseState) },
    { key: 'address', label: 'Address', done: !!(customer.address1 && customer.city && customer.state && customer.zip) },
    { key: 'idPhoto', label: 'ID / License Photo', done: !!customer.idPhotoUrl },
    { key: 'licenseBack', label: 'License (back)', done: !!customer.licenseBackUrl },
    { key: 'insuranceDoc', label: 'Insurance Document', done: !!customer.insuranceDocumentUrl }
  ];
  return {
    items,
    complete: items.every((item) => item.done),
    missingItems: items.filter((item) => !item.done).map((item) => item.label)
  };
}

// Reservations list TTL caches.
//
// Phase 2 baseline (2026-05-02 load test, 50 VUs against prod) showed
// /page + /list at p50=1.4s / p95=2.0s with no cache, while /summary held
// at p50=86ms / p95=738ms thanks to its existing TTL cache. Multiple staff
// at one of the 5 stores routinely re-list within seconds of each other
// (refreshing the dashboard, switching between filters, returning to the
// list after editing). 15s TTL means the worst-case "I just made a change
// and don't see it yet" wait is one breath, in exchange for serving the
// other 90% of identical requests from memory.
//
// The cache module already supports Redis pub/sub for cross-worker
// invalidation when REDIS_URL is set; we don't invalidate explicitly here
// (TTL is short enough), but enabling Redis later would make all 4 cluster
// workers share one effective cache instead of running 4 cold caches in
// parallel — which is what the warmup-period mismatch in the load test
// (cold p99 of 2s on summary) hinted at.
const RESERVATIONS_LIST_TTL_MS = 15 * 1000;
const RESERVATIONS_PAGE_TTL_MS = 15 * 1000;

// Build a deterministic cache key from scope + arbitrary query params.
// Sorts keys so different param-orderings on the URL hash to the same key.
// Coerces every value to string and skips empty/null/undefined so '?q='
// vs no q at all collapse to the same cache entry.
//
// 2026-07-02: list()/listPage() results are now shaped by the requesting
// user's programScope + allowedLocationIds, so the key carries a visibility
// segment (scopeVisibilityCacheSegment) — without it a program/location-
// scoped employee and an admin would poison each other's entries.
function reservationsListCacheKey(prefix, scope, params = {}) {
  const tenant = scope?.tenantId || 'global';
  const sup = scope?.includeAllTenants ? '1' : '0';
  const userKey = scope?.userId || scope?.actorId || '';
  const visibility = scopeVisibilityCacheSegment(scope);
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && String(v).length > 0)
    .map(([k, v]) => [k, String(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `reservations:${prefix}:${tenant}:${sup}:${userKey}:${visibility}:${qs}`;
}

reservationsRouter.get('/', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    const params = { page: req.query?.page, limit: req.query?.limit };
    const out = await cache.getOrSet(
      reservationsListCacheKey('list', scope, params),
      () => reservationsService.list(scope, params),
      RESERVATIONS_LIST_TTL_MS
    );
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.get('/page', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    const params = {
      query: req.query?.q,
      limit: req.query?.limit,
      offset: req.query?.offset,
      // Date filter — pickup-date semantics. Accepts ?dateOn=YYYY-MM-DD
      // for a single day, or ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD for
      // a range. Matches reservations whose pickupAt falls within the
      // requested window. (Originally this was rental-window-overlap;
      // changed 2026-04-29 because staff expected "filter by checkout
      // date", not "show me anything active during this window".)
      dateOn: req.query?.dateOn,
      dateFrom: req.query?.dateFrom,
      dateTo: req.query?.dateTo,
      // 2026-06-16 — return-date filter (dashboard Operations Board returns).
      returnDateOn: req.query?.returnDateOn,
      // 2026-05-25 — sort param flows through to the cache key + service.
      // Accepts: created-desc (default), created-asc, pickup-asc,
      // pickup-desc, return-asc, return-desc.
      sort: req.query?.sort,
      // 2026-05-27 — derived filter. Accepts: overdue (CHECKED_OUT past
      // returnAt EOD OR NEW/CONFIRMED past pickupAt EOD).
      filter: req.query?.filter
    };
    const out = await cache.getOrSet(
      reservationsListCacheKey('page', scope, params),
      () => reservationsService.listPage(params, scope),
      RESERVATIONS_PAGE_TTL_MS
    );
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// 60s TTL on dashboard KPI summary. Multiple staff hitting the dashboard
// within a 60s window share one query result. Stale-by-60s is acceptable
// for the next-pickup / next-return widgets — operators will see the same
// numbers refresh on their next dashboard mount.
//
// Bumped from 30s → 60s on 2026-05-03 to halve cache miss frequency
// (the 4 nextItem findFirst queries that always run on miss are the main
// summary cost — see reservations.service.js summary() for the queries
// and the partial+composite indexes in schema.prisma + the matching SQL
// migration for the missing index coverage they need).
const RESERVATIONS_SUMMARY_TTL_MS = 60 * 1000;
// 2026-07-02: summary() is scoped per user (programScope + allowedLocationIds),
// so the key carries the same visibility segment as the list keys above —
// tenant alone would let a scoped employee's numbers get served to an admin
// (and vice versa) inside the 60s TTL window.
function reservationsSummaryCacheKey(scope) {
  return `reservations:summary:${scope?.tenantId || 'global'}:${scopeVisibilityCacheSegment(scope)}`;
}

reservationsRouter.get('/summary', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    const out = await cache.getOrSet(
      reservationsSummaryCacheKey(scope),
      () => reservationsService.summary(scope),
      RESERVATIONS_SUMMARY_TTL_MS
    );
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.get('/create-options', async (req, res, next) => {
  try {
    const tenantScope = scopeFor(req);
    const [locationsResult, vehicleTypesResult, servicesResult, feesResult, insurancePlansResult, franchisesResult] = await Promise.allSettled([
      locationsService.list(tenantScope),
      vehicleTypesService.list(tenantScope),
      additionalServicesService.list({
        activeOnly: true,
        tenantId: tenantScope.tenantId
      }),
      feesService.list(tenantScope),
      settingsService.getInsurancePlans(tenantScope),
      franchiseService.list(tenantScope)
    ]);

    res.json({
      locations: locationsResult.status === 'fulfilled' && Array.isArray(locationsResult.value) ? locationsResult.value : [],
      vehicleTypes: vehicleTypesResult.status === 'fulfilled' && Array.isArray(vehicleTypesResult.value) ? vehicleTypesResult.value : [],
      services: servicesResult.status === 'fulfilled' && Array.isArray(servicesResult.value) ? servicesResult.value : [],
      fees: feesResult.status === 'fulfilled' && Array.isArray(feesResult.value) ? feesResult.value : [],
      insurancePlans: insurancePlansResult.status === 'fulfilled' && Array.isArray(insurancePlansResult.value) ? insurancePlansResult.value : [],
      franchises: franchisesResult.status === 'fulfilled' && Array.isArray(franchisesResult.value) ? franchisesResult.value : []
    });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.get('/resolve-rate', async (req, res, next) => {
  try {
    const vehicleTypeId = String(req.query?.vehicleTypeId || '').trim();
    const pickupLocationId = String(req.query?.pickupLocationId || '').trim();
    const pickupAt = String(req.query?.pickupAt || '').trim();
    const returnAt = String(req.query?.returnAt || '').trim();
    if (!vehicleTypeId || !pickupLocationId || !pickupAt || !returnAt) {
      return res.status(400).json({ error: 'vehicleTypeId, pickupLocationId, pickupAt and returnAt are required' });
    }
    const out = await ratesService.resolveForRental({
      vehicleTypeId,
      pickupLocationId,
      pickupAt,
      returnAt
    });
    if (!out) {
      return res.status(400).json({ error: 'No rate tables found for selected vehicle type, location and dates' });
    }
    // The location's mandatory fees, priced for these dates — shown on the
    // create form so agents stop adding them by hand (VPH double-charge,
    // 2026-08-10). Fail-open: a fee-preview hiccup must not block quoting.
    try {
      const fees = await previewLocationMandatoryFees({
        pickupLocationId,
        baseAmount: Number(out.baseTotal || 0),
        days: Number(out.days || 1),
      }, scopeFor(req));
      out.mandatoryFees = fees.rows;
      out.mandatoryFeesTotal = fees.total;
    } catch { /* quote stands alone */ }
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post('/bulk/parse-file', async (req, res, next) => {
  try {
    const b64 = String(req.body?.fileBase64 || '');
    if (!b64) return res.status(400).json({ error: 'fileBase64 is required' });
    // 15MB decoded — a migration sheet is tens of KB; anything bigger is a
    // mistake, not a fleet.
    if (b64.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'File too large' });
    const buffer = Buffer.from(b64, 'base64');
    if (!looksLikeXlsx(buffer)) {
      return res.status(422).json({ error: 'Not an Excel file. CSV files are parsed in the browser.' });
    }
    const parsed = await parseReservationImportWorkbook(buffer);
    res.json(parsed);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post('/bulk/validate', async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const report = await reservationsService.validateBulk(rows, scopeFor(req));
    res.json(report);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post('/bulk/import', async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const out = await reservationsService.importBulk(rows, scopeFor(req), req.user?.sub || null);
    res.json(out);
  } catch (e) {
    if (/already exists|vehicle conflict/i.test(String(e?.message || ''))) {
      return res.status(409).json({ error: e.message });
    }
    next(e);
  }
});

reservationsRouter.get('/:id/agreement', async (req, res, next) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });
    const agreement = await rentalAgreementsService.startFromReservation(req.params.id, scopeFor(req));
    res.json(agreement);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// S30 (2026-07-19) — SMART LOOKUP: the customer's confirmation code doesn't
// match our stored reservationNumber (OTA hands out the bare source ref,
// imports store it prefixed: ZE… vs TL-ZE…). Shared matcher lib (also consumed
// by the kiosk); read-only. PRIVACY GATE lives HERE, server-side: a non-exact
// match returns a MASKED stub until the caller proves a datum (full lastName
// or exact pickup date) — so a common name can never be used to pull someone
// else's reservation details through Chloe. Registered BEFORE '/:id'.
reservationsRouter.get('/smart-lookup', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    const tenantId = scope.tenantId ? String(scope.tenantId) : null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required (pass ?tenantId= as SUPER_ADMIN)' });
    }
    const code = req.query.code ? String(req.query.code) : null;
    const name = req.query.name ? String(req.query.name) : null;
    if (!code && !(name && name.trim().length >= 3)) {
      return res.status(400).json({ error: 'code or name (3+ chars) is required' });
    }
    const parseDay = (v) => {
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return null;
      const d = new Date(`${v}T00:00:00Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const from = parseDay(req.query.from);
    const to = parseDay(req.query.to);

    // S30 residual (Innovation): a scripted caller could brute-force the
    // verify gate — ~10 verifyPickupDate probes cover the default 31-day
    // window at the matcher's ±1-day tolerance. Per-principal throttle over
    // FAILED verify attempts (10 per 10 min → 429); verified lookups and
    // lookups without verify params never count. Fail-open on slow Redis.
    const verify = {
      lastName: req.query.verifyLastName ? String(req.query.verifyLastName) : undefined,
      pickupDate: req.query.verifyPickupDate ? String(req.query.verifyPickupDate) : undefined
    };
    const hasVerifyParams = Boolean(verify.lastName || verify.pickupDate);
    const throttlePrincipal = { tenantId, principalId: String(req.user?.sub || 'unknown') };
    const throttleApplies = hasVerifyParams && req.user?.role !== 'SUPER_ADMIN';
    if (throttleApplies) {
      const gate = await verifyProbeThrottle.isBlocked(throttlePrincipal);
      if (gate.blocked) {
        res.setHeader('retry-after', String(gate.retryAfterSeconds));
        return res.status(429).json({
          error: 'Too many failed verification attempts. Try again later.',
          retryAfterSeconds: gate.retryAfterSeconds
        });
      }
    }

    const matches = await smartMatchReservation(
      {
        code,
        name,
        tenantId,
        ...(from && to ? { dateWindow: { from, to } } : {})
      },
      { prisma }
    );

    const candidates = matches.map((m) => {
      const verified =
        m.matchType === 'exact' ||
        candidateMatchesVerification(m.reservation, verify, { matchType: m.matchType });
      if (!verified) return { ...maskCandidate(m), verified: false };
      const c = m.reservation.customer || {};
      return {
        id: m.reservation.id,
        matchType: m.matchType,
        confidence: m.confidence,
        verified: true,
        reservationNumber: m.reservation.reservationNumber,
        customerName: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
        pickupAt: m.reservation.pickupAt,
        status: m.reservation.status
      };
    });
    // See isFailedVerifyProbe for the two things this predicate is NOT:
    // "nothing verified" (gives away the pin-and-guess attack) and "charge
    // anything that stayed masked" (bills the honest guest for a verification
    // that could never have succeeded).
    if (throttleApplies && isFailedVerifyProbe(candidates, verify)) {
      // recordFailure is fail-open internally (never throws, times out fast).
      await verifyProbeThrottle.recordFailure(throttlePrincipal);
    }
    res.json({ candidates });
  } catch (e) {
    if (sendExplicitStatusError(res, e)) return;
    next(e);
  }
});

reservationsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!row) return res.status(404).json({ error: 'Reservation not found' });
    res.json(row);
  } catch (e) {
    next(e);
  }
});

// VozIA Fase 4 (2026-07-03) — W2: append a call-transcript note to a
// reservation. requireAuth already runs at the app mount (main.js); the
// idempotency middleware makes retried VozIA calls replay instead of
// double-appending (service accounts MUST send Idempotency-Key — 400 without
// it; humans pass through). :id accepts a cuid OR a reservation number
// (reservationIdWhere via getById). Marker format:
//   [VOZIA <ticketId> <author> @<ISO>] <text>
reservationsRouter.post('/:id/notes', idempotency({ kind: 'note' }), async (req, res, next) => {
  try {
    const { errors, value } = validateVoziaNotePayload(req.body || {});
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });

    const line = buildVoziaNoteLine(value);
    const nextNotes = appendSystemNote(current.notes, line);
    const row = await reservationsService.update(current.id, { notes: nextNotes }, scopeFor(req), req.user?.sub || null);

    await withTenantSchema(req.user.tenantId, (db) => db.auditLog.create({
      data: {
        tenantId: row.tenantId || req.user?.tenantId || null,
        reservationId: current.id,
        action: 'UPDATE',
        actorUserId: req.user?.sub || null,
        reason: `VozIA note appended (${value.ticketId})`,
        metadata: JSON.stringify({
          source: 'vozia',
          ticketId: value.ticketId,
          author: value.author,
          textLength: value.text.length
        })
      }
    }));

    res.status(201).json({ ok: true, reservationId: current.id, notes: row.notes });
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

reservationsRouter.get('/:id/display-data', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    const row = await reservationsService.getById(req.params.id, scope);
    if (!row) return res.status(404).json({ error: 'Reservation not found' });
    const tenantId = row.tenantId || scope.tenantId;
    // Fetch reservation-level charges (not included by getById)
    const reservationCharges = await withTenantSchema(req.user.tenantId, (db) => db.reservationCharge.findMany({
      where: { reservationId: row.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
    }));
    row.charges = reservationCharges;
    const [insurancePlans, additionalServices, rentalSettings, franchiseCfg, brandLocation] = await Promise.all([
      tenantId ? settingsService.getInsurancePlans({ tenantId }) : [],
      tenantId ? withTenantSchema(req.user.tenantId, (db) => db.additionalService.findMany({
        where: { tenantId, isActive: true, displayOnline: true },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true, code: true, name: true, description: true, rate: true, dailyRate: true, weeklyRate: true, monthlyRate: true,
          chargeType: true, unitLabel: true, mandatory: true, taxable: true, defaultQty: true, coversTolls: true,
          displayDescription: true, displayPriority: true,
          linkedFee: { select: { id: true, name: true, amount: true, description: true, mode: true } }
        }
      })) : [],
      tenantId ? settingsService.getRentalAgreementConfig({ tenantId }) : {},
      // WHOSE NAME IS ON THE COUNTER SCREEN (2026-08-17)
      // This payload drives customer-display — the screen that shows the QR the
      // renter scans, and that keeps showing a name while they sign on their
      // phone. It used to fall back to 'Ride Fleet' whenever the tenant had not
      // filled in Settings → Rental agreement, so the counter said OUR name and
      // the phone (which resolves a real cascade) said the tenant's, thirty
      // seconds apart, to the same customer.
      //
      // Both sides now resolve the same BRANCH (resolveBrandLocation: the
      // agreement's, falling back to the reservation's) through the same
      // cascade (lib/tenant-brand.js). companyName may come back null when a
      // tenant has configured nothing AND has no name; the display renders no
      // wordmark rather than ours.
      //
      // Everything the cascade needs is gathered HERE, in the same fan-out, and
      // injected below. This endpoint is polled every 1.5s per open till, so a
      // resolver left to fetch its own settings would re-run an unmemoised
      // appSetting.findMany + tenant.findUnique ~40 times a minute per screen,
      // on top of a sequential round trip before the response could render.
      tenantId ? franchiseService.getAgreementConfig(row?.franchiseId ?? null, { tenantId }) : null,
      resolveBrandLocation(row)
    ]);
    const brand = await resolveCustomerFacingBrand({
      tenantId,
      franchiseId: row?.franchiseId ?? null,
      location: brandLocation,
      globalConfig: rentalSettings,
      franchiseConfig: franchiseCfg
    });
    res.json({
      reservation: row,
      insurancePlans: (insurancePlans || []).filter(p => p.isActive !== false),
      additionalServices,
      branding: {
        companyName: brand.companyName,
        companyLogoUrl: rentalSettings?.companyLogoUrl || '',
        companyPhone: rentalSettings?.companyPhone || ''
      }
    });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.get('/:id/pricing', async (req, res, next) => {
  try {
    const out = await reservationPricingService.getPricing(req.params.id, scopeFor(req));
    res.json(out);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// 60s TTL on the pricing-options payload. Settings-tier data (locations,
// services, fees, insurance plans, franchises) for one reservation. Staff
// opening the same reservation 3x in 5 min hits cache 2/3. Keyed by tenant
// + reservation id + pickup-location so the per-location service filter
// stays correct. Underlying lookups (locationsService.list, feesService.list,
// etc.) are also cached separately at 5min TTL — this layer just avoids the
// 5-fan-out query orchestration cost on cache hit.
//
// IMPORTANT — only cache fully-fulfilled responses. The original implementation
// used cache.getOrSet which would store degraded payloads (with [] for any
// rejected dependency) for the full TTL. A single transient blip in
// locations/services/fees/insurance/franchise would then poison the cache for
// 60s, every staff member opening the reservation seeing missing data. The
// pattern below explicitly checks rejected vs fulfilled and skips cache.set
// on partial failure so the next request can recover immediately.
const PRICING_OPTIONS_TTL_MS = 60 * 1000;
function pricingOptionsCacheKey(tenantId, reservationId, pickupLocationId) {
  return `reservations:pricing-options:${tenantId || 'global'}:${reservationId}:${pickupLocationId || 'no-loc'}`;
}

reservationsRouter.get('/:id/pricing-options', async (req, res, next) => {
  try {
    const reservation = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    const tenantScope = reservation?.tenantId ? { tenantId: reservation.tenantId } : scopeFor(req);
    const cacheKey = pricingOptionsCacheKey(tenantScope.tenantId, reservation.id, reservation.pickupLocationId);

    const cached = cache.get(cacheKey);
    if (cached !== undefined) return res.json(cached);

    const settled = await Promise.allSettled([
      locationsService.list(tenantScope),
      additionalServicesService.list({
        locationId: reservation.pickupLocationId || undefined,
        activeOnly: true,
        tenantId: tenantScope.tenantId
      }),
      feesService.list(tenantScope),
      settingsService.getInsurancePlans(tenantScope),
      franchiseService.list(tenantScope),
      // Pre-check-in discount config (2026-07-25). The Edit-pricing UI rebuilds
      // insurance/service rows from CATALOG prices, which silently reverted a
      // discount the customer had already accepted during pre-check-in (the
      // $38-back-to-$40 bug). To re-apply the discount — including to a NEW
      // plan the agent swaps in, Hector's call — the UI needs the tenant's
      // discount config, which only the customer portal received before this.
      settingsService.getPrecheckinDiscount(tenantScope)
    ]);
    const [locationsResult, servicesResult, feesResult, insurancePlansResult, franchisesResult, precheckinDiscountResult] = settled;

    const allFulfilled = settled.every((r) => r.status === 'fulfilled');

    const locations = locationsResult.status === 'fulfilled' ? locationsResult.value : [];
    const services = servicesResult.status === 'fulfilled' ? servicesResult.value : [];
    const fees = feesResult.status === 'fulfilled' ? feesResult.value : [];
    const insurancePlans = insurancePlansResult.status === 'fulfilled' ? insurancePlansResult.value : [];
    const franchisesOut = franchisesResult.status === 'fulfilled' ? franchisesResult.value : [];
    const precheckinDiscount = precheckinDiscountResult.status === 'fulfilled'
      ? precheckinDiscountResult.value
      : { enabled: false, type: 'PERCENTAGE', value: 0 };
    const payload = {
      locations: Array.isArray(locations) ? locations : [],
      services: Array.isArray(services) ? services : [],
      fees: Array.isArray(fees) ? fees : [],
      insurancePlans: Array.isArray(insurancePlans) ? insurancePlans : [],
      franchises: Array.isArray(franchisesOut) ? franchisesOut : [],
      precheckinDiscount
    };

    // Only cache when nothing failed. Degraded payloads are returned to the
    // caller (preserving the previous behavior on a transient blip) but are
    // NOT persisted, so the next request can recover.
    if (allFulfilled) cache.set(cacheKey, payload, PRICING_OPTIONS_TTL_MS);

    res.json(payload);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.put('/:id/pricing', async (req, res, next) => {
  try {
    if (!canManagePricingOverrides(req)) {
      return res.status(403).json({ error: 'User role not allowed to edit pricing overrides' });
    }
    // Provenance is forced server-side: this route IS the manual pricing
    // edit, and 'UI_MANUAL' is what shields an agent's deliberate deposit
    // from being re-raised by the local/non-local rule's hold-time safety
    // net. A client that omitted (or typo'd) the source used to leave the
    // snapshot unprotected. QA 2026-07-25 (m2).
    const out = await reservationPricingService.replacePricing(req.params.id, { ...(req.body || {}), source: 'UI_MANUAL', actorUserId: req.user?.sub || req.user?.id || null }, scopeFor(req));
    res.json(out);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    if (/role not allowed/i.test(String(e?.message || ''))) return res.status(403).json({ error: e.message });
    next(e);
  }
});

// ── Admin Corrections (Fase 1) — ADMIN only. Void a charge (incl. post-check-in
// fees) or add a manual charge/credit. Both recompute the balance via the engine
// and write an AuditLog. Replaces the manual SQL fixes for floor mistakes.
// The panel MUST list these (RentalAgreementCharge) — NOT /pricing (ReservationCharge,
// different ids) — so the charge ids match what void operates on.
reservationsRouter.get('/:id/agreement-charges', async (req, res, next) => {
  try {
    if (!canDoAdminCorrections(req)) {
      return res.status(403).json({ error: 'Admin role required for corrections' });
    }
    const out = await reservationPricingService.listAgreementCharges(req.params.id, scopeFor(req));
    res.json(out);
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

reservationsRouter.post('/:id/charges/:chargeId/void', async (req, res, next) => {
  try {
    if (!canDoAdminCorrections(req)) {
      return res.status(403).json({ error: 'Admin role required for corrections' });
    }
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    const out = await reservationPricingService.voidAgreementCharge(
      req.params.id,
      req.params.chargeId,
      { reason, actorUserId: req.user?.sub || null },
      scopeFor(req)
    );
    res.json(out);
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// CAP 3+4 (VozIA Fase 6 re-scope, 2026-07-04) — add a service/fee (positive
// amount) OR a credit (negative amount). Recomputes the balance via the pricing
// engine; NO gateway money moves.
//
// ACCESS CONTROL (do NOT widen the human role check): this route stays ADMIN /
// SUPER_ADMIN-only for HUMANS. The service account (VozIA) gets its OWN path
// through its OWN guard. A human AGENT still gets 403 — only the service account
// is admitted, and only after author+ticketId + the per-line ceiling pass:
//   canDoAdminCorrections(req)  OR  (req.user.isServiceAccount && guard OK)
//
// chargeIdempotency (kind:'charge') is REQUIRED for service accounts so a retry
// can't double-apply a balance mutation; it recycles like a note post-TTL (no
// gateway money moved).
reservationsRouter.post('/:id/charges', chargeIdempotency, async (req, res, next) => {
  try {
    const isAdmin = canDoAdminCorrections(req);
    const isService = !!req.user?.isServiceAccount;
    if (!isAdmin && !isService) {
      return res.status(403).json({ error: 'Admin role required for corrections' });
    }

    let current = null;
    if (isService && !isAdmin) {
      // Service-account-only guard: author+ticketId + name + non-zero amount
      // within the tenant's voziaMaxChargeLineAmount ceiling (default 2000).
      const maxLine = await resolveVoziaCeiling(
        req.user?.tenantId || null,
        'voziaMaxChargeLineAmount',
        2000 // fail-safe LOW default
      );
      try {
        assertServiceAccountChargeAllowed({ user: req.user, body: req.body || {}, maxLine });
      } catch (guardErr) {
        return res.status(guardErr.statusCode || 400).json(
          guardErr.details ? { error: guardErr.message, details: guardErr.details } : { error: guardErr.message }
        );
      }
      current = await reservationsService.getById(req.params.id, scopeFor(req));
      if (!current) return res.status(404).json({ error: 'Reservation not found' });
      // Reject a CANCELLED reservation for the autonomous service account:
      // addManualCharge writes the charge row but syncAgreementCharges no-ops on
      // a cancelled agreement, so the balance never recomputes → a silent orphan
      // row. A human admin has context to handle that; VozIA gets a clean 400
      // (Innovation review 2026-07-04).
      if (String(current.status || '').toUpperCase() === 'CANCELLED') {
        return res.status(400).json({ error: 'Cannot adjust charges on a cancelled reservation' });
      }
    }

    // `reason` stays required for HUMAN admin corrections. For the service account
    // we synthesize a reason from the VozIA ticket so the ADMIN_OVERRIDE row is
    // still populated without demanding a redundant field from the agent.
    let reason = String(req.body?.reason || '').trim();
    if (!reason) {
      if (isService && !isAdmin) {
        reason = `VozIA ticket ${String(req.body?.ticketId || '').trim()} (${String(req.body?.author || '').trim()})`;
      } else {
        return res.status(400).json({ error: 'reason is required' });
      }
    }

    const out = await reservationPricingService.addManualCharge(
      req.params.id,
      // kind + sourceRefId ride through for the PRE-CHECKOUT branch (QA B1,
      // 2026-08-11: they were validated by the service and then dropped right
      // here — every VozIA-sold coverage landed as a generic service line, so
      // the counter could not see the customer was covered).
      { name: req.body?.name, amount: req.body?.amount, kind: req.body?.kind, sourceRefId: req.body?.sourceRefId },
      { reason, actorUserId: req.user?.sub || null },
      scopeFor(req)
    );

    // VozIA audit — ADDITIONAL context tagged source:'vozia'. addManualCharge
    // already wrote its own ADMIN_OVERRIDE row; this ties the op to the ticket.
    if (isService && !isAdmin) {
      const amt = Number(req.body?.amount);
      await writeVoziaReservationAudit(
        current,
        req,
        { name: String(req.body?.name || '').slice(0, 120), amount: Number.isFinite(amt) ? amt : null },
        amt >= 0 ? 'add_service' : 'add_credit'
      );
    }

    res.status(201).json(out);
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// ── Admin Corrections — correct checkout/check-in fuel + odometer (+ cleanliness)
// and RE-RUN the check-in fee engine. ADMIN-only. dryRun:true returns a live
// recompute PREVIEW without writing anything. Real save soft-voids the old
// fee-engine rows, persists the corrected readings, recomputes balance, appends
// vehicle fuel/odometer history, and writes an AuditLog(ADMIN_OVERRIDE).
// Returns: { ok, preview:{ before:{fuelRefill,mileageFee,balance},
//   after:{fuelRefill,mileageFee,balance}, balanceDelta } }.
reservationsRouter.post('/:id/correct-readings', async (req, res, next) => {
  try {
    if (!canDoAdminCorrections(req)) {
      return res.status(403).json({ error: 'Admin role required for corrections' });
    }
    const dryRun = req.body?.dryRun === true;
    const reason = String(req.body?.reason || '').trim();
    if (!dryRun && !reason) return res.status(400).json({ error: 'reason is required' });
    const out = await reservationPricingService.correctInspectionValues(
      req.params.id,
      {
        fuelOut: req.body?.fuelOut,
        odometerOut: req.body?.odometerOut,
        fuelIn: req.body?.fuelIn,
        odometerIn: req.body?.odometerIn,
        cleanlinessOut: req.body?.cleanlinessOut,
        cleanlinessIn: req.body?.cleanlinessIn,
        reason,
        dryRun,
        actorUserId: req.user?.sub || null
      },
      scopeFor(req)
    );
    res.json(out);
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    if (/cancelled|refuse/i.test(String(e?.message || ''))) return res.status(400).json({ error: e.message });
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

reservationsRouter.get('/:id/payments', async (req, res, next) => {
  try {
    const out = await reservationPricingService.listPayments(req.params.id, scopeFor(req));
    res.json(out);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

reservationsRouter.post('/:id/payments', async (req, res, next) => {
  try {
    const out = await reservationPricingService.postPayment(req.params.id, req.body || {}, scopeFor(req), req.user?.sub || null);
    res.status(201).json(out);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    if (/amount must be > 0|invalid|reference is required/i.test(String(e?.message || ''))) return res.status(400).json({ error: e.message });
    next(e);
  }
});

reservationsRouter.get('/:id/additional-drivers', async (req, res, next) => {
  try {
    const out = await reservationAdditionalDriversService.list(req.params.id, scopeFor(req));
    res.json(out);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

reservationsRouter.put('/:id/additional-drivers', async (req, res, next) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });

    // S27 W-D: service accounts attribute the change (uniform audit trail);
    // replace-all is content-idempotent so no idempotency middleware needed.
    let voziaDriversMeta = null;
    if (req.user?.isServiceAccount) {
      const author = typeof req.body?.author === 'string' ? req.body.author.trim() : '';
      const ticketId = typeof req.body?.ticketId === 'string' ? req.body.ticketId.trim() : '';
      if (!author || !ticketId || !/^[A-Za-z0-9._-]{1,64}$/.test(ticketId)) {
        return res.status(400).json({
          error: 'author and ticketId are required for service accounts'
        });
      }
      voziaDriversMeta = { author, ticketId };
    }

    const out = await reservationAdditionalDriversService.replace(
      req.params.id,
      Array.isArray(req.body?.drivers) ? req.body.drivers : [],
      scopeFor(req)
    );

    if (current.rentalAgreement?.id) {
      await rentalAgreementsService.startFromReservation(req.params.id, scopeFor(req));
    }

    await withTenantSchema(req.user.tenantId, (db) => db.auditLog.create({
      data: {
        tenantId: current.tenantId || req.user?.tenantId || null,
        reservationId: req.params.id,
        actorUserId: req.user?.sub || null,
        action: 'UPDATE',
        metadata: JSON.stringify({
          additionalDriversUpdated: true,
          count: out.length,
          ...(voziaDriversMeta
            ? { source: 'vozia', author: voziaDriversMeta.author, ticketId: voziaDriversMeta.ticketId }
            : {})
        })
      }
    }));

    res.json(out);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

reservationsRouter.get('/:id/available-vehicles', async (req, res, next) => {
  try {
    const requestScope = scopeFor(req);
    const reservation = await reservationsService.getById(req.params.id, requestScope);
    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    const tenantScope = reservation?.tenantId ? { tenantId: reservation.tenantId } : requestScope;
    const tenantWhere = tenantScope.tenantId ? { tenantId: tenantScope.tenantId } : {};

    const pickupAt = req.query?.pickupAt ? new Date(String(req.query.pickupAt)) : reservation.pickupAt;
    const returnAt = req.query?.returnAt ? new Date(String(req.query.returnAt)) : reservation.returnAt;

    const vehicleSelect = {
      id: true, tenantId: true, internalNumber: true, vin: true, plate: true,
      make: true, model: true, year: true, color: true, mileage: true,
      status: true, fleetMode: true, vehicleTypeId: true, homeLocationId: true,
      vehicleType: { select: { id: true, name: true } },
      homeLocation: { select: { id: true, name: true, city: true, state: true } }
    };
    const vehicleOrder = [{ make: 'asc' }, { model: 'asc' }, { internalNumber: 'asc' }];
    const maxResults = 200;

    // Run all three probes in parallel — overlaps + blocks + broad candidate set.
    // Tiering happens in-memory so we never pay for a second round-trip.
    const [overlaps, blockedAvailability, candidates] = await Promise.all([
      withTenantSchema(req.user.tenantId, (db) => db.reservation.findMany({
        where: {
          ...tenantWhere,
          id: { not: reservation.id },
          vehicleId: { not: null },
          status: { in: ['NEW', 'CONFIRMED', 'CHECKED_OUT'] },
          pickupAt: { lt: returnAt },
          returnAt: { gt: pickupAt }
        },
        select: { vehicleId: true }
      })),
      withTenantSchema(req.user.tenantId, (db) => db.vehicleAvailabilityBlock.findMany({
        where: {
          ...tenantWhere,
          ...activeVehicleBlockOverlapWhere({ start: pickupAt, end: returnAt })
        },
        select: { vehicleId: true }
      })),
      withTenantSchema(req.user.tenantId, (db) => db.vehicle.findMany({
        where: {
          ...tenantWhere,
          // Program scoping (2026-07-02): a program-restricted employee only
          // gets candidates from their program's pool (ANDs with the OR below,
          // so even the already-assigned vehicle is hidden if out-of-program).
          ...vehicleProgramWhereForScope(requestScope),
          OR: [
            reservation.vehicleId ? { id: reservation.vehicleId } : undefined,
            { status: { notIn: ['IN_MAINTENANCE', 'OUT_OF_SERVICE', 'SOLD'] } }
          ].filter(Boolean)
        },
        select: vehicleSelect,
        orderBy: vehicleOrder,
        take: maxResults
      }))
    ]);

    const blockedIds = new Set();
    overlaps.forEach((r) => r.vehicleId && blockedIds.add(r.vehicleId));
    blockedAvailability.forEach((r) => r.vehicleId && blockedIds.add(r.vehicleId));

    const preferredVehicleTypeId = reservation.vehicleTypeId || null;
    const preferredLocationId = reservation.pickupLocationId || null;

    const preferred = [];
    const typeOrLocationMatch = [];
    const others = [];

    for (const v of candidates) {
      if (v.id === reservation.vehicleId) {
        preferred.unshift(v);
        continue;
      }
      if (blockedIds.has(v.id)) continue;

      if (v.status === 'AVAILABLE') {
        preferred.push(v);
      } else if (
        (preferredVehicleTypeId && v.vehicleTypeId === preferredVehicleTypeId) ||
        (preferredLocationId && (v.homeLocationId === preferredLocationId || !v.homeLocationId))
      ) {
        typeOrLocationMatch.push(v);
      } else {
        others.push(v);
      }
    }

    const vehicles = preferred.length
      ? preferred
      : typeOrLocationMatch.length
        ? typeOrLocationMatch
        : others;

    return res.json(vehicles);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post('/', async (req, res, next) => {
  try {
    const required = [
      'reservationNumber',
      'customerId',
      'vehicleTypeId',
      'pickupAt',
      'returnAt',
      'pickupLocationId',
      'returnLocationId'
    ];

    const missing = required.filter((k) => !req.body?.[k]);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const validationErrors = validateReservationCreate(req.body || {});
    if (validationErrors.length) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors });
    }

    // 24 hours minimum unless an hourly rate is configured (Hector,
    // 2026-08-09). Enforced HERE, not only in the form: the old minimum was a
    // `min` attribute on a date input, which a desktop agent could type past
    // and an API caller never saw at all. rental-minimum.js is the single
    // definition; the form asks the same endpoint to shape its picker.
    const span = checkRentalSpan({
      pickupAt: String(req.body.pickupAt),
      returnAt: String(req.body.returnAt),
      offerings: [],
    });
    const minimum = await ratesService.rentalMinimumFor({
      pickupLocationId: String(req.body.pickupLocationId),
      vehicleTypeId: String(req.body.vehicleTypeId),
      at: String(req.body.pickupAt),
    }, scopeFor(req));
    const hours = span.hours;
    if (hours < minimum.minimumHours) {
      return res.status(400).json({
        error: rentalSpanMessage(minimum),
        minimumHours: minimum.minimumHours,
        hours,
      });
    }

    const quote = await ratesService.resolveForRental({
      vehicleTypeId: String(req.body.vehicleTypeId),
      pickupLocationId: String(req.body.pickupLocationId),
      pickupAt: String(req.body.pickupAt),
      returnAt: String(req.body.returnAt)
    });
    if (!quote) {
      return res.status(400).json({ error: 'No rate tables found for selected vehicle type, location and dates' });
    }

    const addOnsTotal = Number(req.body?.addOnsTotal || 0);
    // Include the location's mandatory fees in the stored estimate. Without
    // this the number quoted at creation was silently lower than what the
    // first pricing read would produce — the gap agents kept "fixing" by hand
    // (VPH, 2026-08-10). Fail-open: the estimate stands without them.
    let mandatoryFeesEstimate = 0;
    try {
      const feePreview = await previewLocationMandatoryFees({
        pickupLocationId: String(req.body.pickupLocationId),
        bookingChannel: String(req.body?.bookingChannel || 'STAFF'),
        baseAmount: Number(quote.baseTotal || 0),
        days: Number(quote.days || 1),
      }, scopeFor(req));
      mandatoryFeesEstimate = feePreview.total;
    } catch { /* estimate stands without them */ }
    const finalEstimate = Number((Number(quote.baseTotal || 0) + (Number.isFinite(addOnsTotal) && addOnsTotal > 0 ? addOnsTotal : 0) + mandatoryFeesEstimate).toFixed(2));

    const pickupLoc = await withTenantSchema(req.user.tenantId, (db) => db.location.findFirst({
      where: {
        id: String(req.body.pickupLocationId),
        ...(scopeFor(req).tenantId ? { tenantId: scopeFor(req).tenantId } : {})
      },
      select: { locationConfig: true, taxRate: true }
    }));
    const cfg = parseLocationConfig(pickupLoc?.locationConfig);
    const bookingChannel = String(req.body?.bookingChannel || 'STAFF');
    const isExternalBooking = bookingChannel === 'WEBSITE' || bookingChannel === 'CAR_SHARING';
    const requireDeposit = isExternalBooking && !!cfg?.requireDeposit;
    const depositMode = String(cfg?.depositMode || 'FIXED').toUpperCase();
    const depositValue = Number(cfg?.depositAmount || 0);
    const basis = Array.isArray(cfg?.depositPercentBasis) && cfg.depositPercentBasis.length ? cfg.depositPercentBasis : ['rate'];
    // 2026-07-25 — local vs non-local renter rule (MONEY). When the pickup
    // location configures depositRules, the rule decides the security deposit
    // for EVERY channel — including STAFF, so the counter agent sees the
    // contract amount pre-filled instead of typing it from memory (Hector,
    // 2026-07-25). No rules configured → exact legacy behavior (external
    // bookings only, flat configured amount).
    // MIGRATION imports stay untouched (same exemption depositSnapshot keeps):
    // a migrated reservation's deposit is historical fact, not the rule's call.
    const depositRules = bookingChannel === 'MIGRATION'
      ? null
      : parseDepositRules(cfg, { locationId: String(req.body.pickupLocationId) });
    let depositRuleDecision = null;
    if (depositRules) {
      const renterCustomer = req.body?.customerId
        ? await withTenantSchema(req.user.tenantId, (db) => db.customer.findFirst({
            where: {
              id: String(req.body.customerId),
              ...(scopeFor(req).tenantId ? { tenantId: scopeFor(req).tenantId } : {})
            },
            select: { licenseState: true, state: true }
          }))
        : null;
      depositRuleDecision = evaluateDepositRule({
        rules: depositRules,
        renter: { licenseState: renterCustomer?.licenseState, addressState: renterCustomer?.state }
      });
    }
    const requireSecurityDeposit = depositRuleDecision
      ? Number(depositRuleDecision.securityDepositAmount) > 0
      : (isExternalBooking && !!cfg?.requireSecurityDeposit);
    const securityDepositAmount = depositRuleDecision
      ? Number(depositRuleDecision.securityDepositAmount)
      : (requireSecurityDeposit ? Number(cfg?.securityDepositAmount || 0) : 0);
    const securityDepositRuleJson = depositRuleDecision
      ? JSON.stringify({ ...depositRuleDecision, evaluatedAt: new Date().toISOString() })
      : null;
    let depositAmountDue = 0;
    if (requireDeposit && Number.isFinite(depositValue) && depositValue > 0) {
      if (depositMode === 'PERCENTAGE') {
        const ratePart = basis.includes('rate') ? Number(quote.baseTotal || 0) : 0;
        const servicesPart = basis.includes('services') ? Math.max(0, addOnsTotal) : 0;
        const feesPart = basis.includes('fees') ? 0 : 0;
        const baseForPct = ratePart + servicesPart + feesPart;
        depositAmountDue = Number((baseForPct * (depositValue / 100)).toFixed(2));
      } else {
        depositAmountDue = Number(depositValue.toFixed(2));
      }
    }

    const notes = String(req.body?.notes || '')
      .replace(/\n?\[RES_DEPOSIT_META\]\{[^\n]*\}/g, '')
      .replace(/\n?\[SECURITY_DEPOSIT_META\]\{[^\n]*\}/g, '')
      .trim();

    // Short-window content dedup (2026-08-24). A rapid double/triple-click or a
    // client retry submits the SAME reservation two-to-four times within ~1s;
    // the frontend mints a fresh reservationNumber per submit, so the UNIQUE
    // index on reservationNumber never catches these — production saw one renter
    // produce 3-4 identical reservations inside 0.9-1.3s. Guard: if THIS agent
    // (createdByUserId) already created a reservation for the same customer +
    // pickup + return + vehicle type in the last 10s, return THAT one instead of
    // minting a duplicate. Scoped strictly to the tenant; the single-submit path
    // is behaviorally unchanged (the lookup simply finds nothing). Frontend
    // in-flight guard removes the trigger; this 10s window is the backstop.
    const dedupCreatedByUserId = req.user?.sub || req.user?.id || null;
    const dedupTz = await resolveTenantTimeZone(req.user?.tenantId);
    const dedupPickupAt = parseDateTimeInTz(String(req.body.pickupAt), dedupTz);
    const dedupReturnAt = parseDateTimeInTz(String(req.body.returnAt), dedupTz);
    if (dedupCreatedByUserId && dedupPickupAt && dedupReturnAt) {
      const dedupTenantId = scopeFor(req).tenantId;
      const existingDuplicate = await withTenantSchema(req.user.tenantId, (db) => db.reservation.findFirst({
        where: {
          ...(dedupTenantId ? { tenantId: dedupTenantId } : {}),
          createdByUserId: dedupCreatedByUserId,
          customerId: String(req.body.customerId),
          vehicleTypeId: String(req.body.vehicleTypeId),
          pickupAt: dedupPickupAt,
          returnAt: dedupReturnAt,
          createdAt: { gt: new Date(Date.now() - 10_000) }
        },
        orderBy: { createdAt: 'desc' },
        include: { customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } }
      }));
      if (existingDuplicate) {
        logger.info('[reservation-create] deduped rapid duplicate submit', {
          reservationId: existingDuplicate.id,
          reservationNumber: existingDuplicate.reservationNumber,
          customerId: existingDuplicate.customerId,
          createdByUserId: dedupCreatedByUserId,
          tenantId: existingDuplicate.tenantId || dedupTenantId || null
        });
        return res.status(201).json(existingDuplicate);
      }
    }

    const row = await reservationsService.create({
      ...(req.body || {}),
      status: requireDeposit ? 'NEW' : (req.body?.status || 'CONFIRMED'),
      paymentStatus: requireDeposit ? 'PENDING' : (req.body?.paymentStatus || 'PENDING'),
      notes,
      dailyRate: quote.dailyRate,
      estimatedTotal: finalEstimate,
      // LAX #4: originator attribution — server-derived, never client-sent.
      createdByUserId: req.user?.sub || req.user?.id || null
    }, scopeFor(req));

    // 2026-08-18 (MONEY): `?? null`, not `?? 0`.
    //
    // Location.taxRate is non-null with default 0, so whenever pickupLoc
    // RESOLVED this is byte-for-byte what it always was. The only case that
    // changes is the one this line used to lie about: pickupLoc is null when
    // req.body.pickupLocationId does not resolve inside the caller's tenant
    // scope, and validateLocationWindow() returns silently in that case
    // (reservations.service.js:873) rather than refusing the create — so the
    // reservation lands and this writes a snapshot rate of 0 meaning "I never
    // found the location".
    //
    // Under the convention every reader now shares, a stored 0 is a RATE:
    // precheckin-charges.js#resolveTaxRate, buildReservationBreakdown and
    // rental-agreements.service.js:2844/3241 all read it with `??`, so that
    // invented 0 permanently suppresses sales tax on the reservation instead of
    // falling back to the pickup location. NULL is what "unset" is spelled as
    // here — the column is nullable and reservations.service.js:2340 already
    // leaves it that way for imports.
    await withTenantSchema(req.user.tenantId, (db) => db.reservationPricingSnapshot.upsert({
      where: { reservationId: row.id },
      create: {
        reservationId: row.id,
        dailyRate: quote.dailyRate,
        taxRate: pickupLoc?.taxRate ?? null,
        depositRequired: requireDeposit,
        depositMode: requireDeposit ? depositMode : null,
        depositValue: requireDeposit ? depositValue : null,
        depositBasisJson: requireDeposit ? JSON.stringify(basis) : null,
        depositAmountDue,
        securityDepositRequired: requireSecurityDeposit || securityDepositAmount > 0,
        securityDepositAmount: securityDepositAmount > 0 ? securityDepositAmount : 0,
        securityDepositRuleJson,
        source: 'RESERVATION_CREATE'
      },
      update: {
        dailyRate: quote.dailyRate,
        // Same reason as the create branch above.
        taxRate: pickupLoc?.taxRate ?? null,
        depositRequired: requireDeposit,
        depositMode: requireDeposit ? depositMode : null,
        depositValue: requireDeposit ? depositValue : null,
        depositBasisJson: requireDeposit ? JSON.stringify(basis) : null,
        depositAmountDue,
        securityDepositRequired: requireSecurityDeposit || securityDepositAmount > 0,
        securityDepositAmount: securityDepositAmount > 0 ? securityDepositAmount : 0,
        securityDepositRuleJson,
        source: 'RESERVATION_CREATE'
      }
    }));

    await withTenantSchema(req.user.tenantId, (db) => db.auditLog.create({
      data: {
        tenantId: row.tenantId || req.user?.tenantId || null,
        reservationId: row.id,
        action: 'CREATE',
        actorUserId: req.user?.sub || null,
        toStatus: row.status,
        metadata: JSON.stringify({ reservationNumber: row.reservationNumber })
      }
    }));

    res.status(201).json(row);
  } catch (e) {
    if (/already exists/i.test(e.message) || /vehicle conflict/i.test(e.message)) {
      return res.status(409).json({ error: e.message });
    }
    if (/outside operating hours|location is closed|DO NOT RENT/i.test(e.message)) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

reservationsRouter.patch('/:id', idempotency({ kind: 'vozia-patch' }), async (req, res, next) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });

    // VozIA Cap 6 / W1 (2026-07-19): service accounts get a FIELD-whitelisted
    // path — exactly one of flightNumber/pickupInstructions/contactPhone +
    // author + ticketId (contactEmail EXCLUDED — Hector 2026-07-19: email
    // changes redirect token-gated links; they escalate to a human). Everything
    // else 400s. Humans continue
    // below completely unchanged. The allowlist opens the PATH; this is the
    // field gate (defense in depth — money/status/dates can never ride through).
    if (req.user?.isServiceAccount) {
      // S27 W-D: cancel rides the same PATCH (status: CANCELLED) but through its
      // own validator — reason + attribution mandatory, PRE-PICKUP only
      // (NEW/CONFIRMED; the human/admin flows for later statuses are untouched).
      // Reuses reservationsService.update so vehicle-status-sync releases the
      // car exactly like a staff cancel — no parallel status logic.
      if ((req.body || {}).status !== undefined) {
        const { errors, value } = validateVoziaCancelPayload(req.body || {});
        if (errors.length) {
          return res.status(400).json({ error: 'Validation failed', details: errors });
        }
        const gate = assertPrePickup(current.status, 'cancel');
        if (gate) return res.status(gate.status).json({ error: gate.message, code: gate.code });

        const cancelNote =
          `[CANCELLED ${new Date().toISOString()}] by ${value.author} (VozIA ${value.ticketId}): ${value.reason}`;
        const row = await reservationsService.update(
          req.params.id,
          { status: 'CANCELLED', notes: appendSystemNote(current.notes, cancelNote) },
          scopeFor(req),
          req.user?.sub || null
        );
        await withTenantSchema(req.user.tenantId, (db) => db.auditLog.create({
          data: {
            tenantId: row.tenantId || req.user?.tenantId || null,
            reservationId: row.id,
            action: 'STATUS_CHANGE',
            actorUserId: req.user?.sub || null,
            fromStatus: current.status,
            toStatus: row.status,
            metadata: JSON.stringify({
              source: 'vozia',
              ticketId: value.ticketId,
              author: value.author,
              reason: value.reason
            })
          }
        }));
        return res.json({
          ok: true,
          reservationId: row.id,
          before: current.status,
          after: row.status
        });
      }

      const { errors, value } = validateVoziaPatchPayload(req.body || {});
      if (errors.length) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      try {
        const out = await applyVoziaReservationPatch(
          value, current, scopeFor(req), { prisma }, req.user?.sub || null
        );
        return res.json(out);
      } catch (e) {
        if (Number.isInteger(e?.status) && e.status < 500) {
          return res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
        }
        throw e;
      }
    }

    const patch = { ...(req.body || {}) };
    const validationErrors = validateReservationPatch(current, patch, { role: req.user?.role });
    if (validationErrors.length) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors });
    }

    // Append cancellation reason to notes when cancelling
    if (patch.status === 'CANCELLED' && patch.cancellationReason) {
      const reason = String(patch.cancellationReason).trim();
      const actorName = req.user?.fullName || req.user?.email || 'Unknown';
      const cancelNote = `[CANCELLED ${new Date().toISOString()}] by ${actorName}: ${reason}`;
      patch.notes = appendSystemNote(current.notes, cancelNote);
      delete patch.cancellationReason;
    }

    const row = await reservationsService.update(req.params.id, patch, scopeFor(req), req.user?.sub || null);

    await withTenantSchema(req.user.tenantId, (db) => db.auditLog.create({
      data: {
        tenantId: row.tenantId || req.user?.tenantId || null,
        reservationId: row.id,
        action: req.body?.status && req.body.status !== current.status ? 'STATUS_CHANGE' : 'UPDATE',
        actorUserId: req.user?.sub || null,
        fromStatus: current.status,
        toStatus: row.status,
        metadata: JSON.stringify({ patch: req.body || {} })
      }
    }));

    res.json(row);
  } catch (e) {
    if (sendExplicitStatusError(res, e)) return;
    if (/vehicle conflict/i.test(e.message)) {
      return res.status(409).json({ error: e.message });
    }
    // BUG-001 / addendum flow: date-edit gate violations are 409 conflicts.
    if (e.code === 'ADDENDUM_PENDING' || e.code === 'AGREEMENT_IMMUTABLE') {
      return res.status(409).json({ error: e.message, code: e.code });
    }
    if (/outside operating hours|location is closed|DO NOT RENT/i.test(e.message)) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

reservationsRouter.post('/:id/admin-transition', async (req, res, next) => {
  try {
    if (req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const { status, reason } = req.body || {};
    if (!status) return res.status(400).json({ error: 'status is required' });

    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });

    const noteLine = `[ADMIN OVERRIDE ${new Date().toISOString()}] ${current.status} -> ${status}${reason ? ` | reason: ${reason}` : ''}`;
    const nextNotes = appendSystemNote(current.notes, noteLine);

    const row = await reservationsService.update(req.params.id, {
      status,
      notes: nextNotes
    }, scopeFor(req), req.user?.sub || null);

    await withTenantSchema(req.user.tenantId, (db) => db.auditLog.create({
      data: {
        tenantId: row.tenantId || req.user?.tenantId || null,
        reservationId: row.id,
        action: 'ADMIN_OVERRIDE',
        actorUserId: req.user?.sub || null,
        fromStatus: current.status,
        toStatus: row.status,
        reason: reason || null,
        metadata: JSON.stringify({ override: true })
      }
    }));

    res.json({
      ok: true,
      message: 'Admin override applied',
      reservation: row
    });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.get('/:id/audit-logs', async (req, res, next) => {
  try {
    const logs = await withTenantSchema(req.user.tenantId, (db) => db.auditLog.findMany({
      where: {
        reservationId: req.params.id,
        ...(scopeFor(req).tenantId ? { tenantId: scopeFor(req).tenantId } : {})
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { actorUser: { select: { id: true, email: true, fullName: true, role: true } } }
    }));
    res.json(logs);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post('/:id/start-rental', async (req, res, next) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });
    const agreement = await rentalAgreementsService.startFromReservation(req.params.id, scopeFor(req));
    await withTenantSchema(req.user.tenantId, (db) => db.auditLog.create({
      data: {
        tenantId: current.tenantId || req.user?.tenantId || null,
        reservationId: req.params.id,
        action: 'UPDATE',
        actorUserId: req.user?.sub || null,
        metadata: JSON.stringify({ startRental: true, agreementId: agreement.id })
      }
    }));
    // Slim response: web frontend only needs `id` (to chain into PUT /rental,
    // POST /signature, POST /finalize). Mobile clients refetch via GET /:id
    // when they need the full agreement tree. Cuts ~475 KB → ~200 bytes.
    res.status(201).json(compactStartRentalResponse(agreement));
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/cannot start/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

reservationsRouter.post('/:id/request-customer-info', async (req, res, next) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });
    if (!checkTokenIssuanceCooldown(current.id, 'customer-info')) {
      return res.status(429).json({ error: 'A customer info link was just issued for this reservation. Please wait a moment before issuing another.' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 2);
    const base = process.env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000';
    const link = `${base.replace(/\/$/, '')}/customer/precheckin?token=${token}`;

    const note = `[REQUEST CUSTOMER INFO ${new Date().toISOString()}] token issued`;
    const notes = appendSystemNote(current.notes, note);

    await reservationsService.update(req.params.id, {
      customerInfoToken: token,
      customerInfoTokenExpiresAt: expiresAt,
      notes
    }, scopeFor(req));

    res.json({ ok: true, link, expiresAt });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post('/:id/request-signature', async (req, res, next) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });
    if (!checkTokenIssuanceCooldown(current.id, 'signature')) {
      return res.status(429).json({ error: 'A signature link was just issued for this reservation. Please wait a moment before issuing another.' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 2);
    const base = process.env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000';
    const link = `${base.replace(/\/$/, '')}/customer/sign-agreement?token=${token}`;

    const note = `[REQUEST SIGNATURE ${new Date().toISOString()}] token issued`;
    const notes = appendSystemNote(current.notes, note);

    await reservationsService.update(req.params.id, {
      signatureToken: token,
      signatureTokenExpiresAt: expiresAt,
      notes
    }, scopeFor(req));

    res.json({ ok: true, link, expiresAt });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post('/:id/request-payment', async (req, res, next) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });
    if (!checkTokenIssuanceCooldown(current.id, 'payment')) {
      return res.status(429).json({ error: 'A payment link was just issued for this reservation. Please wait a moment before issuing another.' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 2);
    const base = process.env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000';
    const link = `${base.replace(/\/$/, '')}/customer/pay?token=${token}`;

    const note = `[REQUEST PAYMENT ${new Date().toISOString()}] token issued`;
    const notes = appendSystemNote(current.notes, note);

    await reservationsService.update(req.params.id, {
      paymentRequestToken: token,
      paymentRequestTokenExpiresAt: expiresAt,
      notes
    }, scopeFor(req));

    res.json({ ok: true, link, expiresAt });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post('/:id/send-request-email', async (req, res, next) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });

    const kind = String(req.body?.kind || '').toLowerCase();
    if (!['signature', 'customer-info', 'payment'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be signature|customer-info|payment' });
    }

    // CAP 1 (VozIA Fase 6 re-scope, 2026-07-04) — payment LINK. VozIA never
    // captures a card; it emails the customer a self-pay link. No money moves, so
    // NO amount cap and NO idempotency requirement (a benign re-send). We only
    // require author+ticketId for the service account (400 if missing) and record
    // them on an AuditLog. Human path is UNCHANGED (guard runs only for VozIA).
    if (req.user?.isServiceAccount) {
      const author = String(req.body?.author || '').trim();
      const ticketId = String(req.body?.ticketId || '').trim();
      if (!author || author.length > 120) {
        return res.status(400).json({ error: 'author is required (<=120 chars)' });
      }
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(ticketId)) {
        return res.status(400).json({ error: 'ticketId is required (^[A-Za-z0-9._-]{1,64}$)' });
      }
      // Label derives from the KIND — this wrote 'payment_link' unconditionally,
      // so a VozIA pre-check-in or signature email was recorded in the audit
      // trail as a payment link (found in recon 2026-08-03). requestKind in the
      // metadata always carried the truth; now the action label does too.
      const auditKind = kind === 'payment' ? 'payment_link' : kind === 'signature' ? 'signature_link' : 'precheckin_link';
      await writeVoziaReservationAudit(current, req, { requestKind: kind }, auditKind);
    }
    if (!checkTokenIssuanceCooldown(current.id, `email:${kind}`)) {
      return res.status(429).json({ error: `A ${kind} email was just sent for this reservation. Please wait a moment before resending.` });
    }

    const primary = String(current.customer?.email || '').trim();
    // Service account: IGNORE extraEmails — the link (payable/signable, token-gated)
    // may only go to the reservation's own customer. An autonomous agent emailing a
    // pay link to an arbitrary caller-supplied address is a phishing/redirection
    // surface human staff have context to avoid (Innovation review 2026-07-04).
    const extras = req.user?.isServiceAccount
      ? []
      : (Array.isArray(req.body?.extraEmails) ? req.body.extraEmails : []);
    const recipients = [primary, ...extras].map((x) => String(x || '').trim()).filter(Boolean);
    if (!recipients.length) return res.status(400).json({ error: 'No recipient email found' });

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 2);
    const base = process.env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000';

    let link = '';
    const notePrefix = kind === 'signature' ? 'REQUEST SIGNATURE' : kind === 'customer-info' ? 'REQUEST CUSTOMER INFO' : 'REQUEST PAYMENT';
    if (kind === 'signature') {
      link = `${base.replace(/\/$/, '')}/customer/sign-agreement?token=${token}`;
      await reservationsService.update(req.params.id, { signatureToken: token, signatureTokenExpiresAt: expiresAt }, scopeFor(req));
    } else if (kind === 'customer-info') {
      link = `${base.replace(/\/$/, '')}/customer/precheckin?token=${token}`;
      await reservationsService.update(req.params.id, { customerInfoToken: token, customerInfoTokenExpiresAt: expiresAt }, scopeFor(req));
    } else {
      link = `${base.replace(/\/$/, '')}/customer/pay?token=${token}`;
      await reservationsService.update(req.params.id, { paymentRequestToken: token, paymentRequestTokenExpiresAt: expiresAt }, scopeFor(req));
    }

    const actionLabel = kind === 'signature' ? 'Signature Request' : kind === 'customer-info' ? 'Customer Information Request' : 'Payment Request';
    const customerName = `${current.customer?.firstName || ''} ${current.customer?.lastName || ''}`.trim() || 'Customer';

    const tpl = await settingsService.getEmailTemplates();
    const subjectTpl = kind === 'signature' ? tpl.requestSignatureSubject : kind === 'customer-info' ? tpl.requestCustomerInfoSubject : tpl.requestPaymentSubject;
    const bodyTpl = kind === 'signature' ? tpl.requestSignatureBody : kind === 'customer-info' ? tpl.requestCustomerInfoBody : tpl.requestPaymentBody;

    const companyName = current.pickupLocation?.name || 'Ride Fleet';
    const render = (s = '') => String(s)
      .replaceAll('{{customerName}}', customerName)
      .replaceAll('{{reservationNumber}}', String(current.reservationNumber || ''))
      .replaceAll('{{link}}', link)
      .replaceAll('{{expiresAt}}', expiresAt.toISOString())
      .replaceAll('{{companyName}}', companyName);

    const htmlTpl = kind === 'signature' ? tpl.requestSignatureHtml : kind === 'customer-info' ? tpl.requestCustomerInfoHtml : tpl.requestPaymentHtml;
    try {
      const reqInnerText = render(bodyTpl);
      const reqInnerHtml = render(htmlTpl || String(bodyTpl || '').replaceAll('\n', '<br/>'));
      let reqBrand;
      try { reqBrand = await resolveEmailBrand({ tenantId: current.tenantId || null }); } catch { reqBrand = undefined; }
      const reqHeadings = { signature: 'Please sign your agreement', payment: 'Payment requested', 'customer-info': 'Complete your information' };
      const { html: reqHtml, text: reqText } = renderBrandedEmail({
        brand: reqBrand,
        heading: reqHeadings[kind] || actionLabel,
        bodyHtml: reqInnerHtml,
        bodyText: reqInnerText,
        cta: link ? { label: kind === 'payment' ? 'Pay now' : kind === 'signature' ? 'Review & sign' : 'Complete now', url: link } : undefined,
        preheader: render(subjectTpl) || `${actionLabel} - Reservation ${current.reservationNumber}`,
      });
      await sendEmail({ tenantId: current.tenantId,
        to: recipients.join(','), fromName: companyName,
        subject: render(subjectTpl) || `${actionLabel} - Reservation ${current.reservationNumber}`,
        text: reqText,
        html: reqHtml
      });
      const note = `[${notePrefix} ${new Date().toISOString()}] emailed to ${recipients.join(', ')}`;
      await reservationsService.update(req.params.id, { notes: appendSystemNote(current.notes, note) }, scopeFor(req));
      res.json({ ok: true, sentTo: recipients, link, expiresAt, emailSent: true });
    } catch (mailError) {
      const failNote = `[${notePrefix} ${new Date().toISOString()}] email failed for ${recipients.join(', ')} | ${String(mailError?.message || mailError)}`;
      await reservationsService.update(req.params.id, { notes: appendSystemNote(current.notes, failNote) }, scopeFor(req));
      await withTenantSchema(req.user.tenantId, (db) => db.auditLog.create({
        data: {
          tenantId: current.tenantId || req.user?.tenantId || null,
          reservationId: current.id,
          action: 'UPDATE',
          actorUserId: req.user?.sub || null,
          metadata: JSON.stringify({
            requestEmailFailed: true,
            kind,
            recipients,
            link,
            error: String(mailError?.message || mailError)
          })
        }
      }));

      res.json({
        ok: false,
        warning: `Unable to send ${actionLabel.toLowerCase()} email: ${String(mailError?.message || mailError)}`,
        link,
        expiresAt,
        emailSent: false
      });
    }
  } catch (e) {
    next(e);
  }
});

/**
 * S27 W-D (2026-07-19) — reprice preview for a proposed date/location change.
 * READ-ONLY, side-effect-free (quotesService.preview never writes a row). The
 * agent workspace shows "current $X → new $Y (±$Z)" BEFORE applying; the
 * returned newTotal is what the client must echo back as expectedNewTotal on
 * POST /:id/reschedule (staleness guard). Uses the LIVE engine — tax-aware +
 * revenue pricing — never UI math.
 */
reservationsRouter.get('/:id/reprice-preview', async (req, res, next) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });
    if (!current.vehicleTypeId) {
      return res.status(422).json({
        error: 'Reservation has no vehicle type — cannot reprice', code: 'NO_VEHICLE_TYPE'
      });
    }
    const pickupAt = req.query.pickupAt ? String(req.query.pickupAt) : null;
    const returnAt = req.query.returnAt ? String(req.query.returnAt) : null;
    if (!pickupAt || !returnAt) {
      return res.status(400).json({ error: 'pickupAt and returnAt query params are required' });
    }
    const pickupLocationId = req.query.pickupLocationId
      ? String(req.query.pickupLocationId)
      : current.pickupLocationId;

    const previewOut = await quotesService.preview(
      { pickupLocationId, vehicleTypeId: current.vehicleTypeId, pickupAt, returnAt },
      scopeFor(req)
    );
    const row = (previewOut?.results || [])[0];
    if (!row) {
      return res.status(422).json({
        error: 'No rate available for this vehicle class in the proposed window',
        code: 'NO_RATE'
      });
    }
    const currentTotal = current.estimatedTotal != null ? Number(current.estimatedTotal) : null;
    return res.json({
      reservationId: current.id,
      vehicleTypeId: current.vehicleTypeId,
      current: {
        pickupAt: current.pickupAt, returnAt: current.returnAt,
        pickupLocationId: current.pickupLocationId, total: currentTotal
      },
      proposed: {
        pickupAt: previewOut.pickupAt, returnAt: previewOut.returnAt,
        pickupLocationId, total: row.total, dailyRate: row.dailyRate,
        days: row.days, available: row.available
      },
      difference: currentTotal != null ? Number((row.total - currentTotal).toFixed(2)) : null
    });
  } catch (e) {
    if (sendExplicitStatusError(res, e)) return;
    next(e);
  }
});

/**
 * S27 W-D — apply a date/location change WITH repricing. Pre-pickup only
 * (NEW/CONFIRMED — later statuses go through extend/addendum or a human in
 * RFM). Flow: re-price server-side → 409 REPRICE_DRIFT if it no longer
 * matches what the agent previewed → reservationsService.update (runs the
 * REAL gates: hours, vehicle conflict, agreement-immutable) → stamp
 * dailyRate/estimatedTotal from the engine row → audit with before/after.
 * Idempotency: service accounts must send Idempotency-Key (replay-safe).
 */
reservationsRouter.post('/:id/reschedule', idempotency({ kind: 'vozia-reschedule' }), async (req, res, next) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });

    const { errors, value } = validateVoziaReschedulePayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    const gate = assertPrePickup(current.status, 'reschedule');
    if (gate) return res.status(gate.status).json({ error: gate.message, code: gate.code });
    if (!current.vehicleTypeId) {
      return res.status(422).json({
        error: 'Reservation has no vehicle type — cannot reprice', code: 'NO_VEHICLE_TYPE'
      });
    }

    const pickupLocationId = value.pickupLocationId || current.pickupLocationId;
    // Raw strings straight through (Innovation MC-1): preview() parses them in
    // TENANT wall-clock, exactly like reprice-preview and the staff PATCH do.
    const previewOut = await quotesService.preview(
      {
        pickupLocationId,
        vehicleTypeId: current.vehicleTypeId,
        pickupAt: value.pickupAt,
        returnAt: value.returnAt
      },
      scopeFor(req)
    );
    const row = (previewOut?.results || [])[0];
    if (!row) {
      return res.status(422).json({
        error: 'No rate available for this vehicle class in the proposed window',
        code: 'NO_RATE'
      });
    }
    // ALREADY THERE IS NOT A CHANGE (2026-08-10: rescheduleReservation fired
    // 3x on one live call; the writes converged only because the rebuild is
    // deterministic). If the requested window and location match what the
    // reservation ALREADY holds, there is nothing to apply: re-running the
    // rebuild is charge-row churn, and failing — e.g. REPRICE_DRIFT against a
    // slightly stale expected total for a state that is already true — tells
    // the agent the change FAILED, whose measured response is retrying the
    // write. State is the answer; report it, touch nothing. Deliberately
    // BEFORE the drift check for exactly that reason.
    //
    // The predicate is IMPORTED from reservation-extend.service.js so the test
    // drives the real rule (the house lesson: a copy goes on passing while the
    // original is replaced).
    if (isSameRentalWindow(previewOut, current, pickupLocationId)) {
      return res.json({
        ok: true,
        reservationId: current.id,
        alreadyApplied: true,
        before: {
          pickupAt: current.pickupAt, returnAt: current.returnAt,
          pickupLocationId: current.pickupLocationId,
          estimatedTotal: current.estimatedTotal != null ? Number(current.estimatedTotal) : null,
          dailyRate: current.dailyRate != null ? Number(current.dailyRate) : null
        },
        after: {
          pickupAt: current.pickupAt, returnAt: current.returnAt,
          pickupLocationId: current.pickupLocationId,
          estimatedTotal: current.estimatedTotal != null ? Number(current.estimatedTotal) : null,
          dailyRate: current.dailyRate != null ? Number(current.dailyRate) : null
        }
      });
    }

    if (Math.abs(row.total - value.expectedNewTotal) > 0.01) {
      // Price moved since the agent's preview — surface the fresh number, never
      // silently charge something the customer wasn't shown.
      return res.status(409).json({
        error: `Price changed since preview: now $${row.total.toFixed(2)} (expected $${value.expectedNewTotal.toFixed(2)}). Re-preview and confirm with the customer.`,
        code: 'REPRICE_DRIFT',
        newTotal: row.total
      });
    }

    const before = {
      pickupAt: current.pickupAt,
      returnAt: current.returnAt,
      pickupLocationId: current.pickupLocationId,
      estimatedTotal: current.estimatedTotal != null ? Number(current.estimatedTotal) : null,
      dailyRate: current.dailyRate != null ? Number(current.dailyRate) : null
    };

    // The real gates live in update(): operating hours, vehicle conflict,
    // AGREEMENT_IMMUTABLE/ADDENDUM_PENDING — same errors as the staff PATCH.
    // DATES ONLY. Stamping the quote here used to be the point of this
    // endpoint, but it makes update() a second price writer: if the reprice
    // below then fails, the reservation is left holding an UNVERIFIED total
    // with stale charge rows — precisely the RES-107160 state, which the next
    // read reverts. The rebuild is now the sole writer of price, so a failed
    // reprice leaves a consistent OLD price instead of a phantom new one.
    const patch = {
      pickupAt: value.pickupAt,
      returnAt: value.returnAt
    };
    if (pickupLocationId !== current.pickupLocationId) {
      patch.pickupLocationId = pickupLocationId;
      // Round-trip reservations move BOTH ends together; a true one-way
      // change (distinct return location) escalates to a human in RFM.
      if (current.returnLocationId === current.pickupLocationId) {
        patch.returnLocationId = pickupLocationId;
      }
    }
    // REFUSE BEFORE COMMITTING. The reprice runs after update(), so an
    // unsupported shape discovered there would leave the dates already moved.
    // Check the charge set first: a refusal must cost the caller nothing.
    try {
      const existingCharges = await prisma.reservationCharge.findMany({
        where: { reservationId: current.id }
      });
      // The quantity actually billed, not a re-derived day count — the engine
      // honours grace periods and minimum charges, a plain ceil does not, and
      // the disagreement would refuse ordinary pure-shift requests.
      const billed = existingCharges.find(isBaseRentalRow);
      assertRepriceable(existingCharges, billed ? Number(billed.quantity) || 0 : 0, Number(row.days) || 0, current.bookingChannel, current.workflowMode);
    } catch (e) {
      if (e.status === 409) return res.status(409).json({ error: e.message, code: e.code });
      throw e;
    }

    const row2 = await reservationsService.update(req.params.id, patch, scopeFor(req), req.user?.sub || null);

    // Reprice through the service (see reservation-extend.service.js). Doing
    // this in the route was wrong twice over: it could not be tested against a
    // real charge set, and it wrote estimatedTotal with a DIFFERENT formula
    // than the canonical reader — which is the very bug being fixed.
    let priced;
    try {
      priced = await reservationExtendService.repriceForNewDates(row2.id, row, scopeFor(req));
    } catch (e) {
      // The dates are already committed at this point and the caller has been
      // told they moved; reverting them silently would be worse. Say so
      // loudly, and leave a marker a human can reconcile against.
      logger.error('[reschedule] reprice failed AFTER the dates moved', {
        reservationId: row2.id, code: e.code || null, message: e.message
      });
      return res.status(e.status && e.status < 500 ? e.status : 500).json({
        error: e.status && e.status < 500
          ? e.message
          : 'The dates were changed, but the new price could not be confirmed. Tell the caller their dates are changed and that a colleague will confirm the price — do not quote a number. Do NOT retry this.',
        code: e.code || 'RESCHEDULE_REPRICE_FAILED',
        datesMoved: true
      });
    }

    // LIKE FOR LIKE. The engine's `row.total` is base + tax-on-base + the
    // WEBSITE-channel mandatory fees it happens to model; the reservation's
    // real total also carries insurance, per-day services, tolls and this
    // reservation's own channel's fees. Comparing those two 500s on any
    // ordinary reservation that has a CDW line. What must agree is the BASE
    // component we just wrote against the engine's subtotal.
    if (priced.baseTotal == null || Math.abs(priced.baseTotal - row.subtotal) > 0.01) {
      logger.error('[reschedule] stored base rate does not match the quote', {
        reservationId: row2.id, storedBase: priced.baseTotal, quotedBase: row.subtotal
      });
      return res.status(500).json({
        error: 'The dates were changed, but the stored base rate does not match the price that was quoted. Tell the caller their dates are changed and that a colleague will confirm the price — do not quote a number.',
        code: 'RESCHEDULE_BASE_MISMATCH',
        datesMoved: true,
        storedBase: priced.baseTotal,
        quotedBase: row.subtotal
      });
    }

    await withTenantSchema(req.user.tenantId, (db) => db.auditLog.create({
      data: {
        tenantId: row2.tenantId || req.user?.tenantId || null,
        reservationId: row2.id,
        action: 'UPDATE',
        actorUserId: req.user?.sub || null,
        metadata: JSON.stringify({
          source: req.user?.isServiceAccount ? 'vozia' : 'staff',
          kind: 'reschedule',
          ticketId: value.ticketId,
          author: value.author,
          before,
          // PERSISTED values, not the quote. The audit is the record someone
          // reconciles a disputed price against; reporting what we INTENDED to
          // write makes it useless exactly when it matters.
          after: {
            pickupAt: row2.pickupAt, returnAt: row2.returnAt,
            pickupLocationId,
            estimatedTotal: priced.total, dailyRate: priced.dailyRate
          }
        })
      }
    }));

    return res.json({
      ok: true,
      reservationId: row2.id,
      before,
      after: {
        pickupAt: row2.pickupAt,
        returnAt: row2.returnAt,
        pickupLocationId,
        // What the reservation ACTUALLY holds — this is the number the agent
        // reads to the customer, so it must be the one they will be billed.
        estimatedTotal: priced.total,
        dailyRate: priced.dailyRate
      },
      difference: before.estimatedTotal != null
        ? Number((priced.total - before.estimatedTotal).toFixed(2))
        : null
    });
  } catch (e) {
    if (sendExplicitStatusError(res, e)) return;
    if (/vehicle conflict/i.test(e.message)) return res.status(409).json({ error: e.message });
    if (e.code === 'ADDENDUM_PENDING' || e.code === 'AGREEMENT_IMMUTABLE') {
      return res.status(409).json({ error: e.message, code: e.code });
    }
    if (/outside operating hours|location is closed/i.test(e.message)) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

/**
 * S27 W-D — the additional-services catalog for THIS reservation's pickup
 * location (active only). Read-only; lets the agent workspace list what the
 * local actually offers, with prices, before drafting a charge.
 */
reservationsRouter.get('/:id/available-services', async (req, res, next) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });
    const services = await additionalServicesService.list({
      locationId: current.pickupLocationId || undefined,
      activeOnly: true,
      tenantId: current.tenantId || req.user?.tenantId || null
    });
    return res.json({ reservationId: current.id, services });
  } catch (e) {
    if (sendExplicitStatusError(res, e)) return;
    next(e);
  }
});

reservationsRouter.post('/:id/send-detail-email', async (req, res, next) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });

    // S27 W-D: service accounts send ONLY to the on-file email (extraEmails is
    // the link-redirection surface Fase 6 closed) and must attribute the send.
    let voziaMeta = null;
    if (req.user?.isServiceAccount) {
      const author = typeof req.body?.author === 'string' ? req.body.author.trim() : '';
      const ticketId = typeof req.body?.ticketId === 'string' ? req.body.ticketId.trim() : '';
      if (!author || !ticketId || !/^[A-Za-z0-9._-]{1,64}$/.test(ticketId)) {
        return res.status(400).json({
          error: 'author and ticketId are required for service accounts'
        });
      }
      voziaMeta = { author, ticketId };
      if (req.body) req.body.extraEmails = [];
    }

    const primary = String(current.customer?.email || '').trim();
    const extras = Array.isArray(req.body?.extraEmails) ? req.body.extraEmails : [];
    const recipients = [primary, ...extras].map((x) => String(x || '').trim()).filter(Boolean);
    if (!recipients.length) return res.status(400).json({ error: 'No recipient email found' });

    const customerName = `${current.customer?.firstName || ''} ${current.customer?.lastName || ''}`.trim() || 'Customer';
    const pickup = current.pickupAt ? new Date(current.pickupAt).toLocaleString() : '-';
    const ret = current.returnAt ? new Date(current.returnAt).toLocaleString() : '-';
    const vehicle = current.vehicle ? `${current.vehicle.year || ''} ${current.vehicle.make || ''} ${current.vehicle.model || ''}`.trim() : (current.vehicleType?.name || 'Unassigned');
    const pickupLoc = current.pickupLocation?.name || '-';
    const returnLoc = current.returnLocation?.name || '-';

    const tpl = await settingsService.getEmailTemplates();
    const vars = {
      customerName,
      reservationNumber: String(current.reservationNumber || ''),
      status: String(current.status || '-'),
      pickupAt: pickup,
      returnAt: ret,
      pickupLocation: pickupLoc,
      returnLocation: returnLoc,
      vehicle,
      dailyRate: current.dailyRate != null ? `$${Number(current.dailyRate).toFixed(2)}` : '-',
      estimatedTotal: current.estimatedTotal != null ? `$${Number(current.estimatedTotal).toFixed(2)}` : '-',
      companyName: current.pickupLocation?.name || 'Ride Fleet'
    };
    const render = (s = '') => Object.entries(vars).reduce((out, [k, v]) => out.replaceAll(`{{${k}}}`, String(v ?? '')), String(s || ''));

    const subject = render(tpl.reservationDetailSubject || 'Reservation Details - {{reservationNumber}}');
    const detailInnerText = render(tpl.reservationDetailBody || 'Hello {{customerName}},\n\nReservation #: {{reservationNumber}}');
    const detailInnerHtml = render(tpl.reservationDetailHtml || String(detailInnerText).replaceAll('\n', '<br/>'));

    let detailBrand;
    try { detailBrand = await resolveEmailBrand({ tenantId: current.tenantId || null }); } catch { detailBrand = undefined; }
    const { html, text } = renderBrandedEmail({
      brand: detailBrand,
      heading: 'Your reservation details',
      bodyHtml: detailInnerHtml,
      bodyText: detailInnerText,
      preheader: subject,
    });

    await sendEmail({ tenantId: current.tenantId,
      to: recipients.join(','), fromName: current.pickupLocation?.name || undefined,
      subject,
      text,
      html
    });

    const note = `[RESERVATION DETAIL EMAIL ${new Date().toISOString()}] emailed to ${recipients.join(', ')}`;
    await reservationsService.update(req.params.id, { notes: appendSystemNote(current.notes, note) }, scopeFor(req));

    if (voziaMeta) {
      await withTenantSchema(req.user.tenantId, (db) => db.auditLog.create({
        data: {
          tenantId: current.tenantId || req.user?.tenantId || null,
          reservationId: current.id,
          action: 'UPDATE',
          actorUserId: req.user?.sub || null,
          metadata: JSON.stringify({
            source: 'vozia',
            kind: 'detail-email',
            ticketId: voziaMeta.ticketId,
            author: voziaMeta.author,
            sentTo: recipients
          })
        }
      }));
    }

    res.json({ ok: true, sentTo: recipients });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post('/:id/precheckin/review', async (req, res, next) => {
  try {
    if (!canManagePrecheckin(req)) {
      return res.status(403).json({ error: 'Admin or ops role required' });
    }

    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });

    const note = String(req.body?.note || '').trim() || null;
    const reviewedAt = new Date();
    const row = await reservationsService.update(req.params.id, {
      customerInfoReviewedAt: reviewedAt,
      customerInfoReviewedByUserId: req.user?.sub || null,
      customerInfoReviewNote: note
    }, scopeFor(req));

    const checklist = buildPrecheckinChecklist(current);
    await withTenantSchema(req.user.tenantId, (db) => db.auditLog.create({
      data: {
        tenantId: row.tenantId || req.user?.tenantId || null,
        reservationId: row.id,
        action: 'ADMIN_OVERRIDE',
        actorUserId: req.user?.sub || null,
        metadata: JSON.stringify({
          precheckinReviewed: true,
          reviewedAt: reviewedAt.toISOString(),
          note,
          checklistComplete: checklist.complete,
          missingItems: checklist.missingItems
        })
      }
    }));

    res.json({
      ok: true,
      reviewedAt,
      reservation: row
    });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post('/:id/precheckin/ready', async (req, res, next) => {
  try {
    if (!canManagePrecheckin(req)) {
      return res.status(403).json({ error: 'Admin or ops role required' });
    }

    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });

    const ready = req.body?.ready !== false;
    const note = String(req.body?.note || '').trim() || null;
    const checklist = buildPrecheckinChecklist(current);

    if (ready && !checklist.complete && !note) {
      return res.status(400).json({ error: 'Override note is required when marking ready with missing items' });
    }

    const payload = ready ? {
      readyForPickupAt: new Date(),
      readyForPickupByUserId: req.user?.sub || null,
      readyForPickupOverrideNote: checklist.complete ? null : note
    } : {
      readyForPickupAt: null,
      readyForPickupByUserId: null,
      readyForPickupOverrideNote: note
    };

    const row = await reservationsService.update(req.params.id, payload, scopeFor(req));

    await withTenantSchema(req.user.tenantId, (db) => db.auditLog.create({
      data: {
        tenantId: row.tenantId || req.user?.tenantId || null,
        reservationId: row.id,
        action: 'ADMIN_OVERRIDE',
        actorUserId: req.user?.sub || null,
        metadata: JSON.stringify({
          readyForPickup: ready,
          override: ready && !checklist.complete,
          note,
          checklistComplete: checklist.complete,
          missingItems: checklist.missingItems
        })
      }
    }));

    res.json({
      ok: true,
      readyForPickup: ready,
      reservation: row
    });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post('/:id/precheckin/staff-complete', idempotency({ kind: 'vozia-precheckin' }), async (req, res, next) => {
  try {
    if (!canManagePrecheckin(req)) {
      return res.status(403).json({ error: 'Admin or ops role required' });
    }

    // S28 mini W-D bis (2026-07-19): the VozIA agent workspace completes the
    // kiosk check-in on the customer's behalf ("Complete check-in for
    // customer", video assist). Service accounts must attribute the action,
    // and EMAIL stays excluded here — email changes go through the supervisor
    // approval flow (vozia-customer-patch), never ride a completion payload.
    let voziaPrecheckinMeta = null;
    if (req.user?.isServiceAccount) {
      const author = typeof req.body?.author === 'string' ? req.body.author.trim() : '';
      const ticketId = typeof req.body?.ticketId === 'string' ? req.body.ticketId.trim() : '';
      if (!author || !ticketId || !/^[A-Za-z0-9._-]{1,64}$/.test(ticketId)) {
        return res.status(400).json({ error: 'author and ticketId are required for service accounts' });
      }
      if (req.body?.email !== undefined) {
        return res.status(400).json({
          error: 'email cannot be changed via staff-complete — use the contact approval flow',
          code: 'EMAIL_NEEDS_APPROVAL'
        });
      }
      voziaPrecheckinMeta = { author, ticketId };
      delete req.body.author;
      delete req.body.ticketId;
    }

    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });

    const customerId = current.customerId;
    if (!customerId) return res.status(400).json({ error: 'Reservation has no customer linked' });

    const body = req.body || {};
    const customerUpdate = {};
    const fields = [
      'firstName', 'lastName', 'email', 'phone', 'dateOfBirth',
      'licenseNumber', 'licenseState', 'address1', 'address2',
      'city', 'state', 'zip', 'country',
      'idPhotoUrl', 'licenseBackUrl', 'insuranceDocumentUrl', 'insurancePolicyNumber',
      'insuranceExpiry'
    ];
    for (const key of fields) {
      if (body[key] !== undefined) {
        if (key === 'dateOfBirth' && body[key]) {
          const dob = new Date(body[key]);
          // Guard against unparseable / out-of-range dates (e.g. a mistyped
          // year like 41959) that JS Date accepts but Postgres/Prisma reject:
          // those bubbled up as an unhandled PrismaClientUnknownRequestError 500
          // (Sentry JAVASCRIPT-NEXTJSBACKEND-1M). Reject with a clean 400 instead.
          const dobYear = dob.getUTCFullYear();
          if (Number.isNaN(dob.getTime()) || dobYear < 1900 || dobYear > new Date().getUTCFullYear()) {
            return res.status(400).json({ error: 'Invalid date of birth' });
          }
          customerUpdate[key] = dob;
        } else if (key === 'insuranceExpiry' && body[key]) {
          // LAX #5 — optional "Exp Date"; invalid input → clean 400 like DOB.
          const exp = new Date(body[key]);
          if (Number.isNaN(exp.getTime())) {
            return res.status(400).json({ error: 'Invalid insurance expiration date' });
          }
          customerUpdate[key] = exp;
        } else if (key === 'email') {
          // Writer #4 of the customer-email inventory (lib/customer-email.js).
          // STAFF capture — same shape as the DOB / expiry guards right above:
          // a clean 400 the agent can act on, instead of a string that only
          // fails much later, inside MailerSend, after the contract is sealed.
          const verdict = normalizeCustomerEmail(body[key]);
          if (!verdict.ok) {
            return res.status(400).json({ error: messageFor('staff'), code: CUSTOMER_EMAIL_INVALID });
          }
          customerUpdate[key] = verdict.email;
        } else {
          customerUpdate[key] = body[key] || null;
        }
      }
    }

    // LAX #5 (2026-07-28): staff-complete stamps customerInfoCompletedAt, so
    // it must enforce the same completeness bar as the customer portal — ALL
    // fields mandatory EXCEPT insurance, DL photo included. Validated on the
    // MERGED state (getById's included customer + this patch): staff can fill
    // only the missing pieces, but can't mark a still-incomplete profile as
    // complete. The DL-photo requirement accepts an already-on-file photo
    // (getById exposes hasIdPhoto; the blob column itself is not selected).
    {
      const existingCustomer = current.customer || {};
      const merged = {
        ...existingCustomer,
        ...customerUpdate,
        idPhotoUrl: customerUpdate.idPhotoUrl !== undefined
          ? customerUpdate.idPhotoUrl
          : (existingCustomer.hasIdPhoto ? 'on-file' : (existingCustomer.idPhotoUrl || ''))
      };
      const missing = missingRequiredCustomerFields(merged);
      if (missing.length) {
        return res.status(400).json({
          error: `Complete the required pre-check-in items first: ${missing.join(', ')}`,
          code: 'PRECHECKIN_FIELDS_MISSING',
          missing
        });
      }
    }

    // Blob -> Storage (Phase 1): route inline base64 doc fields to Storage when
    // the flag is ON; fail-safe fall back to inline on any error. Flag OFF ->
    // unchanged. Only fields present in customerUpdate are considered.
    const _docCtx = { tenantId: req.user.tenantId || null, customerId };
    const _docKindByField = { idPhotoUrl: 'id-photo', licenseBackUrl: 'license-back', insuranceDocumentUrl: 'insurance' };
    for (const [field, kind] of Object.entries(_docKindByField)) {
      if (Object.prototype.hasOwnProperty.call(customerUpdate, field)) {
        customerUpdate[field] = await maybeUploadCustomerDocument(customerUpdate[field], { ..._docCtx, kind });
      }
    }

    if (Object.keys(customerUpdate).length) {
      await withTenantSchema(req.user.tenantId, (db) => db.customer.update({
        where: { id: customerId },
        data: customerUpdate
      }));
    }

    const now = new Date();
    const row = await reservationsService.update(req.params.id, {
      customerInfoCompletedAt: now,
      customerInfoReviewedAt: now,
      customerInfoReviewedByUserId: req.user?.sub || null,
      customerInfoReviewNote: 'Completed by staff on behalf of customer'
    }, scopeFor(req));

    await withTenantSchema(req.user.tenantId, (db) => db.auditLog.create({
      data: {
        tenantId: row.tenantId || req.user?.tenantId || null,
        reservationId: row.id,
        action: 'ADMIN_OVERRIDE',
        actorUserId: req.user?.sub || null,
        metadata: JSON.stringify({
          staffPrecheckinComplete: true,
          completedAt: now.toISOString(),
          fieldsUpdated: Object.keys(customerUpdate),
          ...(voziaPrecheckinMeta
            ? { source: 'vozia', author: voziaPrecheckinMeta.author, ticketId: voziaPrecheckinMeta.ticketId }
            : {})
        })
      }
    }));

    res.json({ ok: true, reservation: row });
  } catch (e) {
    // updateReservation re-validates the assigned vehicle on EVERY patch, so
    // completing pre-check-in while the vehicle is still out on an open rental
    // threw the 409 guard here and fell through to next(e) -> 500.
    if (sendExplicitStatusError(res, e)) return;
    next(e);
  }
});

reservationsRouter.post('/:id/agreement/payments/manual', async (req, res, next) => {
  try {
    const agreementId = await ensureAgreementByReservationId(req.params.id, scopeFor(req));
    if (!agreementId) return res.status(400).json({ error: 'No rental agreement exists for this reservation yet' });
    const row = await rentalAgreementsService.addManualPayment(agreementId, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

reservationsRouter.post('/:id/agreement/payments/charge-card-on-file', requireCapability('paymentActions'), async (req, res, next) => {
  try {
    const agreementId = await ensureAgreementByReservationId(req.params.id, scopeFor(req));
    if (!agreementId) return res.status(400).json({ error: 'No rental agreement exists for this reservation yet' });
    const row = await rentalAgreementsService.chargeCardOnFile(agreementId, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    if (/Authorize\.Net|card profile|amount|invalid|missing/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

reservationsRouter.post('/:id/agreement/security-deposit/capture', requireCapability('paymentActions'), async (req, res, next) => {
  try {
    const agreementId = await ensureAgreementByReservationId(req.params.id, scopeFor(req));
    if (!agreementId) return res.status(400).json({ error: 'No rental agreement exists for this reservation yet' });
    const row = await rentalAgreementsService.captureSecurityDeposit(agreementId, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    if (/Authorize\.Net|security deposit|amount|invalid|missing|captured|released/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

reservationsRouter.post('/:id/agreement/security-deposit/release', requireCapability('paymentActions'), async (req, res, next) => {
  try {
    const agreementId = await ensureAgreementByReservationId(req.params.id, scopeFor(req));
    if (!agreementId) return res.status(400).json({ error: 'No rental agreement exists for this reservation yet' });
    const row = await rentalAgreementsService.releaseSecurityDeposit(agreementId, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    if (/Authorize\.Net|security deposit|invalid|missing|captured|released/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

// ── Spin (Dejavoo) operational endpoints ────────────────────────────
// New View Payments operational tools. These run card-not-present
// against the saved iPOS token captured during checkout-wizard-v2's
// Spin sale step. They surface as ReservationPayment rows in the
// payments list so the agent can see them immediately.
reservationsRouter.post('/:id/agreement/spin/charge-card-on-file', requireCapability('paymentActions'), async (req, res, next) => {
  try {
    const agreementId = await ensureAgreementByReservationId(req.params.id, scopeFor(req));
    if (!agreementId) return res.status(400).json({ error: 'No rental agreement exists for this reservation yet' });
    const row = await rentalAgreementsService.spinChargeCardOnFile(agreementId, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    const msg = String(e?.message || '');
    if (/not found/i.test(msg)) return res.status(404).json({ error: e.message });
    // "not configured" / "iPOSpays" added 2026-09-04: a tenant whose CNP rail
    // has no usable credentials was surfacing as a raw 500 at the counter.
    if (/card on file|amount|declined|Spin|missing|invalid|not configured|iPOSpays|terminal/i.test(msg)) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

reservationsRouter.post('/:id/agreement/spin/release-deposit', requireCapability('paymentActions'), async (req, res, next) => {
  try {
    const agreementId = await ensureAgreementByReservationId(req.params.id, scopeFor(req));
    if (!agreementId) return res.status(400).json({ error: 'No rental agreement exists for this reservation yet' });
    const row = await rentalAgreementsService.spinReleaseDepositHold(agreementId, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    const msg = String(e?.message || '');
    if (/not found/i.test(msg)) return res.status(404).json({ error: e.message });
    if (/deposit hold|released|declined|Spin|invalid|not configured|iPOSpays|terminal/i.test(msg)) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

reservationsRouter.post('/:id/agreement/spin/reauth-deposit', requireCapability('paymentActions'), async (req, res, next) => {
  try {
    const agreementId = await ensureAgreementByReservationId(req.params.id, scopeFor(req));
    if (!agreementId) return res.status(400).json({ error: 'No rental agreement exists for this reservation yet' });
    const row = await rentalAgreementsService.spinReauthDepositHold(agreementId, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    const msg = String(e?.message || '');
    if (/not found/i.test(msg)) return res.status(404).json({ error: e.message });
    if (/card on file|amount|declined|Spin|invalid|missing|not configured|iPOSpays|terminal/i.test(msg)) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

reservationsRouter.post('/:id/agreement/customer/card-on-file', requireCapability('paymentActions'), async (req, res, next) => {
  try {
    const agreementId = await ensureAgreementByReservationId(req.params.id, scopeFor(req));
    if (!agreementId) return res.status(400).json({ error: 'No rental agreement exists for this reservation yet' });
    const row = await rentalAgreementsService.captureCustomerCardOnFile(agreementId, req.body || {}, req.user?.sub || null);
    res.json(row);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post('/:id/swap-vehicle', async (req, res, next) => {
  try {
    const row = await reservationsService.swapVehicle(
      req.params.id,
      req.body || {},
      scopeFor(req),
      req.user?.sub || null,
      req.ip || null,
      // The ADMIN photo-override capability, resolved from the AUTHENTICATED user
      // — same gate as Admin Corrections. `payload.photoOverride` only ever says
      // "I am asking"; this says whether the asker is allowed.
      { isAdmin: canDoAdminCorrections(req) }
    );
    res.json(row);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    // resolveSwapPhotoOverride tags its refusals: 403 non-admin, 400 empty reason.
    if (e?.status) return res.status(e.status).json({ error: e.message });
    // "Vehicle swap blocked: ..." covers the mandatory-photo gate (missing/invalid
    // slots, storage disabled, upload shortfall) — all operator-actionable, so they
    // surface as a 400 with the message instead of a generic 500.
    if (/required|different vehicle|checked out|assign a vehicle|conflict|available|swap blocked/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

// RES-849093 FIX 3c: this route called reservationsService.adjustCustomerCredit,
// which DOES NOT EXIST — every call 500'd. It was also a second, invisible credit
// path that bypassed the visible/voidable Admin Corrections charge ledger. Removed.
// The ONE correct way to add a per-rental credit is a NEGATIVE-amount manual charge:
//   POST /api/reservations/:id/charges  { name, amount: -X, reason }  (addManualCharge)
// which creates a visible, voidable RentalAgreementCharge(source='ADMIN_CORRECTION').
reservationsRouter.post('/:id/agreement/credit', async (req, res) => {
  res.status(410).json({
    error: 'Endpoint removed. Use POST /api/reservations/:id/charges with a negative amount to add a credit (visible on the contract and voidable).'
  });
});

reservationsRouter.delete('/:id', async (req, res) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });

    await withTenantSchema(req.user.tenantId, (db) => db.auditLog.create({
      data: {
        tenantId: current.tenantId || req.user?.tenantId || null,
        reservationId: current.id,
        action: 'DELETE',
        actorUserId: req.user?.sub || null,
        fromStatus: current.status,
        metadata: JSON.stringify({ reservationNumber: current.reservationNumber })
      }
    }));

    await reservationsService.remove(req.params.id, scopeFor(req));
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'Reservation not found' });
  }
});


// Reservation-native payment delete endpoint
reservationsRouter.post('/:id/payments/:paymentId/delete', requireCapability('paymentActions'), async (req, res, next) => {
  try {
    const agreementId = await ensureAgreementByReservationId(req.params.id, scopeFor(req));
    if (!agreementId) return res.status(404).json({ error: 'Agreement not found for reservation' });
    const agreement = await withTenantSchema(req.user.tenantId, (db) => db.rentalAgreement.findFirst({
      where: { id: agreementId, ...(scopeFor(req).tenantId ? { tenantId: scopeFor(req).tenantId } : {}) },
      select: { id: true, total: true }
    }));
    if (!agreement) return res.status(404).json({ error: 'Agreement not found for reservation' });

    const payment = await withTenantSchema(req.user.tenantId, (db) => db.rentalAgreementPayment.findUnique({ where: { id: req.params.paymentId } }));
    if (!payment || payment.rentalAgreementId !== agreement.id) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    await withTenantSchema(req.user.tenantId, (db) => db.rentalAgreementPayment.deleteMany({
      where: {
        rentalAgreementId: agreement.id,
        OR: [
          { reference: 'REFUND:' + req.params.paymentId },
          { notes: { contains: req.params.paymentId } }
        ]
      }
    }));

    await withTenantSchema(req.user.tenantId, (db) => db.rentalAgreementPayment.delete({ where: { id: req.params.paymentId } }));

    const remaining = await withTenantSchema(req.user.tenantId, (db) => db.rentalAgreementPayment.findMany({
      where: { rentalAgreementId: agreement.id },
      select: { amount: true, status: true }
    }));
    const paidAmount = Number(remaining.filter((x) => String(x.status || '').toUpperCase() !== 'VOIDED').reduce((sum, x) => sum + Number(x.amount || 0), 0).toFixed(2));
    const balance = Number((Number(agreement.total || 0) - paidAmount).toFixed(2));

    await withTenantSchema(req.user.tenantId, (db) => db.rentalAgreement.update({ where: { id: agreement.id }, data: { paidAmount, balance } }));
    res.json({ ok: true, paidAmount, balance });
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/foreign key|constraint/i.test(e.message)) return res.status(400).json({ error: 'Payment cannot be deleted due to linked records' });
    next(e);
  }
});

// REFUND — moves money OUT to the customer's card via Authorize.Net.
// This route was NEVER gated. It sits directly above the ADMIN-only
// `void-no-refund` block, and its "ADMIN-only" comment made it LOOK protected
// on a casual read (and to a grep) — the handler checked nothing. Measured in
// prod before this change: 43 refunds totalling $9,618.79, 18 of them by
// AGENTs. This is closing an open hole, not tightening an existing permission.
// 2026-09-04 (View Payments refund): gateway-aware — the service routes by the
// ROW's own reference/gateway (SPIn void/return, Transact void by RRN,
// Auth.Net, PayArc, or a bookkeeping-only negative row) and never crosses
// gateways. This route additionally REQUIRES a reason: it is the staff-facing
// refund button, and the reason is what the audit row and the ledger note
// carry into a dispute. (The VozIA service route carries author+ticketId
// instead — its contract is unchanged.)
reservationsRouter.post('/:id/payments/:paymentId/refund', requireCapability('paymentActions'), async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A refund reason is required' });
    const agreementId = await ensureAgreementByReservationId(req.params.id, scopeFor(req));
    if (!agreementId) return res.status(404).json({ error: 'Agreement not found for reservation' });
    const row = await rentalAgreementsService.refundPayment(agreementId, req.params.paymentId, { ...(req.body || {}), reason }, req.user?.id || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    // A SPIn gateway refusal/decline carries spinStatusCode — surface its
    // message to the agent (402, payment-level failure) instead of a blank 500.
    if (e?.spinStatusCode || e?.spinTimeout) return res.status(402).json({ error: e.message });
    if (/cannot|invalid|already|amount|refund|configured|approved|declined/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// ── Admin Corrections — VOID a payment with NO refund (bookkeeping only). ADMIN-only.
// Marks an erroneous payment (+ its linked agreement payment) status=VOID so it drops
// out of collected/balance math. NO gateway call, NO money movement — for a real card
// refund use POST /:id/payments/:paymentId/refund instead. Body: { reason } (required).
// 400 reason missing / AUTH_HOLD; 404 payment not found; 409 already voided.
reservationsRouter.post('/:id/payments/:paymentId/void-no-refund', async (req, res, next) => {
  try {
    if (!canDoAdminCorrections(req)) {
      return res.status(403).json({ error: 'Admin role required for corrections' });
    }
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    const out = await reservationPricingService.voidPaymentNoRefund(
      req.params.id,
      req.params.paymentId,
      { reason, actorUserId: req.user?.sub || null },
      scopeFor(req)
    );
    res.json(out);
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

reservationsRouter.post('/:id/payments/:paymentId/save-card-on-file', requireCapability('paymentActions'), async (req, res, next) => {
  try {
    const agreementId = await ensureAgreementByReservationId(req.params.id, scopeFor(req));
    if (!agreementId) return res.status(404).json({ error: 'Agreement not found for reservation' });
    const row = await rentalAgreementsService.saveCardOnFileFromPayment(agreementId, req.params.paymentId, req.user?.id || null);
    res.json(row);
  } catch (e) {
    const message = String(e?.message || e || 'Unable to save card on file');
    if (/not found/i.test(message)) return res.status(404).json({ error: message });
    return res.status(400).json({ error: message });
  }
});

reservationsRouter.post('/:id/payments/reconcile-authorizenet', requireCapability('paymentActions'), async (req, res, next) => {
  try {
    const row = await rentalAgreementsService.reconcileLatestAuthNetReservationPayment(
      req.params.id,
      req.body || {},
      scopeFor(req),
      req.user?.id || null
    );
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/cannot|invalid|missing|unable|duplicate|captured|recent|amount|payment/i.test(e.message)) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

reservationsRouter.post('/:id/payments/charge-card-on-file', requireCapability('paymentActions'), async (req, res, next) => {
  try {
    const agreementId = await ensureAgreementByReservationId(req.params.id, scopeFor(req));
    if (!agreementId) return res.status(404).json({ error: 'Agreement not found for reservation' });
    const row = await rentalAgreementsService.chargeCardOnFile(agreementId, req.body || {}, req.user?.id || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/cannot|invalid|missing|failed|amount/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});



