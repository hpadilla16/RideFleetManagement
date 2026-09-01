import cluster from 'node:cluster';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import logger, { requestLogger } from './lib/logger.js';
import { flushSecurityEvents, stopSecurityLogForwarder } from './lib/security-log-forwarder.js';
import { reservationsRouter } from './modules/reservations/reservations.routes.js';
import { reservationExtendRouter } from './modules/reservations/reservation-extend.routes.js';
import { reservationOverrideRouter } from './modules/admin/reservation-override.routes.js';
import { idempotencyAdminRouter } from './modules/admin/idempotency-admin.routes.js';
import { customerErasureRouter } from './modules/admin/customer-erasure.routes.js';
import { customerExportRouter } from './modules/admin/customer-export.routes.js';
import { customersRouter } from './modules/customers/customers.routes.js';
import { publicVehicleTelematicsRouter, vehiclesRouter } from './modules/vehicles/vehicles.routes.js';
import { inventoryRouter } from './modules/inventory/inventory.routes.js';
import { locationsRouter } from './modules/locations/locations.routes.js';
import { locationsSelectableRouter } from './modules/locations/locations-selectable.routes.js';
import { vehicleTypesSelectableRouter } from './modules/vehicle-types/vehicle-types-selectable.routes.js';
import { ratesBookingRouter } from './modules/rates/rates-booking.routes.js';
import { locationHoursRouter } from './modules/locations/location-hours.routes.js';
import { vehicleTypesRouter } from './modules/vehicle-types/vehicle-types.routes.js';
import { additionalServicesRouter } from './modules/additional-services/additional-services.routes.js';
import { feesRouter } from './modules/fees/fees.routes.js';
import { stopSalesRouter } from './modules/stop-sales/stop-sales.routes.js';
import { ratesRouter } from './modules/rates/rates.routes.js';
import { marketScraperRouter } from './modules/market-scraper/market-scraper.routes.js';
import { marketObservationsRouter } from './modules/market-observations/market-observations.routes.js';
import { marketOnboardingRouter } from './modules/market-onboarding/market-onboarding.routes.js';
import {
  pricingRulesRouter,
  pricingSuggestionsRouter,
  pricingEngineInternalRouter,
} from './modules/pricing-suggestions/pricing-suggestions.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { rentalAgreementsRouter } from './modules/rental-agreements/rental-agreements.routes.js';
import { addendumSignaturePublicRouter } from './modules/rental-agreements/addendum-signature-public.routes.js';
import { checkoutSessionRouter, checkoutSessionPublicRouter } from './modules/checkout-session/checkout-session.routes.js';
import { termsSigningPublicRouter } from './modules/checkout-session/terms-signing.routes.js';
import { mobileInspectionPublicRouter } from './modules/checkout-session/mobile-inspection.routes.js';
import { customerInspectionPublicRouter, customerInspectionRouter } from './modules/customer-inspection/customer-inspection.routes.js';
import { citationsRouter, citationsInternalRouter } from './modules/citations/citations.routes.js';
import { repairOrdersRouter, maintenanceRouter } from './modules/maintenance/maintenance.routes.js';
import { kioskRouter } from './modules/kiosk/kiosk.routes.js';
import { kioskAdminRouter } from './modules/kiosk/kiosk-admin.routes.js';
import { storeBoardRouter } from './modules/store-board/store-board.routes.js';
import { storeBoardPublicRouter } from './modules/store-board/store-board-public.routes.js';
import { assertAuthConfig } from './modules/auth/auth.config.js';
import { settingsRouter, paymentCapabilitiesRouter } from './modules/settings/settings.routes.js';
import { feeRatesRouter } from './modules/fees/fee-rates.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { checkinAuditRouter } from './modules/checkin-audit/checkin-audit.routes.js';
import { requireAuth, requireRole, requireModuleAccess } from './middleware/auth.js';
import { tenantRateLimit } from './middleware/tenant-rate-limit.js';
import { resolvePublicTenantToken } from './middleware/public-tenant-token.js';
import { endpointLoadSampler } from './middleware/endpoint-load-sampler.js';
import { prisma } from './lib/prisma.js';
import { customerPortalRouter } from './modules/customer-portal/customer-portal.routes.js';
import { tenantsRouter } from './modules/tenants/tenants.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
// 2026-05-25 — Reports v2 module. Mounted BEFORE legacy reportsRouter so
// the new /api/reports/list endpoint wins; legacy paths fall through.
// register-all-reports.js is a side-effect import that triggers each
// individual report file's registerReport() call against reportsV2Router.
import { reportsV2Router } from './modules/reports/reports-v2.routes.js';
// The dashboard tile every user is meant to see — mounted before the reports
// module gate below, which an AGENT never passes. See today-kpis.routes.js.
import { todayKpisRouter } from './modules/reports/today-kpis.routes.js';
import './modules/reports/register-all-reports.js';
import { commissionsRouter } from './modules/commissions/commissions.routes.js';
import { carSharingRouter } from './modules/car-sharing/car-sharing.routes.js';
import { peopleRouter } from './modules/people/people.routes.js';
import { publicBookingRouter } from './modules/public-booking/public-booking.routes.js';
import { accountDeletionRouter } from './modules/public-booking/account-deletion.routes.js';
import { hostAppRouter } from './modules/host-app/host-app.routes.js';
import { employeeAppRouter } from './modules/employee-app/employee-app.routes.js';
import { dealershipLoanerRouter } from './modules/dealership-loaner/dealership-loaner.routes.js';
import { loanerAgreementRouter, loanerSignaturePublicRouter, loanerPortalPublicRouter } from './modules/dealership-loaner/loaner-agreement.routes.js';
import { publicLoanerRouter } from './modules/dealership-loaner/public-loaner.routes.js';
import { loanerRateRouter } from './modules/dealership-loaner/loaner-rate.routes.js';
import { longTermRouter } from './modules/long-term/long-term.routes.js';
import { incidentReportRouter } from './modules/incident-report/incident-report.routes.js';
import { reportDamageRouter } from './modules/report-damage/report-damage.routes.js';
import { issueCenterRouter, publicIssueCenterRouter } from './modules/issue-center/issue-center.routes.js';
import { tollsRouter, tollsInternalRouter } from './modules/tolls/tolls.routes.js';
import { fleetInternalRouter } from './modules/vehicles/fleet-internal.routes.js';
import { customReportsRouter } from './modules/reports/custom/custom-reports.routes.js';
import { globalSearchRouter } from './modules/search/global-search.routes.js';
import { plannerRouter } from './modules/planner/planner.routes.js';
import { shuttleRequestsRouter } from './modules/shuttle/shuttle-requests.routes.js';
import { quotesRouter } from './modules/quotes/quotes.routes.js';
import { paymentGatewayRouter } from './modules/payment-gateway/payment-gateway.routes.js';
// Phase 0 (2026-06-09): the toll auto-sync scheduler MOVED to the worker
// process (src/worker.js) — its sweeps spawn headless Chromium pages and that
// RAM/CPU no longer belongs in the API container. Manual per-tenant syncs
// triggered from the API still run here, under the global page cap.
import { startHandoffReminderScheduler, stopHandoffReminderScheduler } from './modules/car-sharing/car-sharing.scheduler.js';
import { startCheckoutSessionCleanupScheduler, stopCheckoutSessionCleanupScheduler } from './modules/checkout-session/checkout-session.scheduler.js';
// GDPR Wave 2 Phase C — automatic retention sweep. OFF BY DEFAULT: the
// scheduler no-ops unless RETENTION_SWEEP_ENABLED=true, and even then runs in
// PREVIEW (mutates nothing) unless RETENTION_SWEEP_APPLY=true.
import { startRetentionSweepScheduler, stopRetentionSweepScheduler } from './modules/retention/retention.scheduler.js';
import { buildOpenApiSpec, swaggerHtml } from './docs/openapi.js';
import { smsRouter } from './modules/sms/sms.routes.js';
import { knowledgeBaseRouter } from './modules/knowledge-base/knowledge-base.routes.js';
import { trainingRouter } from './modules/training/training.routes.js';
import { shuttleTrackerPublicRouter, shuttleTrackerAdminRouter } from './modules/shuttle/shuttle-tracker.routes.js';
import { shuttleDriverPublicRouter } from './modules/shuttle/shuttle-driver.routes.js';
import { billingPublicRouter } from './modules/billing/billing-public.routes.js';
import { billingWebhookRouter } from './modules/billing/billing-webhook.routes.js';
import { billingSelfRouter } from './modules/billing/billing-self.routes.js';
import { shuttleMonitorRouter } from './modules/shuttle/shuttle-monitor.routes.js';
import { shuttleZonesRouter } from './modules/shuttle/shuttle-zones.routes.js';
import { tlInternationalRouter } from './modules/integrations/tl-international/tl-international.routes.js';
import { economyRouter } from './modules/integrations/economy/economy.routes.js';
import { nuRouter } from './modules/integrations/nu/nu.routes.js';
import { flexwaysRouter } from './modules/integrations/flexways/flexways.routes.js';
import { advantageRouter } from './modules/integrations/advantage/advantage.routes.js';
import { mexRouter } from './modules/integrations/mex/mex.routes.js';
import { onestepgpsRouter } from './modules/integrations/onestepgps/onestepgps.routes.js';
import { captureBackendException, flushSentry, initSentry, isSentryEnabled } from './lib/sentry.js';
import { appErrorHandler } from './lib/errors.js';
import { closeBrowser } from './lib/puppeteer-browser.js';

assertAuthConfig();
initSentry();

const app = express();

// SECURITY (DAST 2026-08-23): don't advertise the framework. Express sets
// `X-Powered-By: Express` by default — a free fingerprint for an attacker and a
// standard DAST finding. Nothing depends on it.
app.disable('x-powered-by');

// SECURITY (P0): trust exactly ONE proxy hop. In production the droplet runs
// nginx (and/or the docker bridge) in front of this process, so the real client
// IP arrives in X-Forwarded-For. With `trust proxy` set, Express derives req.ip
// from the RIGHTMOST untrusted XFF entry rather than the attacker-controllable
// leftmost value — which is what our rate-limit / idempotency keys rely on.
// One hop matches our single-nginx topology; raising this would re-trust
// client-supplied XFF. In local/dev (no proxy) req.ip simply falls back to the
// socket address, so this is a safe no-op there.
app.set('trust proxy', 1);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

// In production we strictly match ALLOWED_ORIGINS. In dev we additionally
// accept any LAN IP on port 3000 so the agent's phone (scanning a QR
// rendered on the Mac browser at http://192.168.x.x:3000) can hit the
// backend without manually whitelisting every interface IP. The check
// covers RFC1918 ranges + link-local + .local mDNS aliases.
const LAN_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)(?::\d+)?$/i;
const corsOriginFn = (origin, cb) => {
  // Same-origin / curl / Postman send no Origin header — always allow.
  if (!origin) return cb(null, true);
  if (allowedOrigins.includes(origin)) return cb(null, true);
  if (process.env.NODE_ENV !== 'production' && LAN_ORIGIN_RE.test(origin)) {
    return cb(null, true);
  }
  return cb(new Error(`CORS: origin not allowed: ${origin}`));
};

// SECURITY HEADERS (DAST 2026-08-23): set on EVERY response (JSON + HTML). These
// three are safe everywhere — they restrict neither framing nor resource loading,
// so they cannot break the Flutter WebView payment bridge or the processor
// hosted-fields pages. Clickjacking protection (X-Frame-Options / CSP
// frame-ancestors) is added PER-PAGE on terminal HTML routes instead of globally,
// because some public HTML pages (payarc-bridge / accept-hosted) legitimately
// embed third-party content and must not get a blanket CSP. COOP/COEP/CORP are
// deliberately omitted — COEP/CORP can break cross-origin resource loads.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self)');
  // HSTS — only when the request actually reached us over HTTPS (nginx sets
  // X-Forwarded-Proto; `trust proxy` makes req.secure reflect it). Browsers
  // ignore HSTS over plain HTTP anyway, but gating keeps local/dev http clean
  // and avoids asserting HSTS on a connection that wasn't secure. 1 year +
  // includeSubDomains; no `preload` yet (one-way commitment). Hardening 2026-08-23.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(compression({ threshold: 1024 }));
app.use(requestLogger());
// PR-5 PERF telemetry — sampled per-request load observations. Mounted
// here (after request-id, before auth) so it sees public endpoints too;
// tenantId is captured inside res.on("finish") after auth has populated
// req.user (if any). Sample rate via ENDPOINT_LOAD_SAMPLE_RATE (default 1%).
app.use(endpointLoadSampler());
app.use(cors({ origin: corsOriginFn, credentials: true }));
app.use(express.json({
  limit: '50mb',
  verify: (req, _res, buf) => {
    req.rawBodyBuffer = buf?.length ? Buffer.from(buf) : Buffer.alloc(0);
    req.rawBody = buf?.length ? Buffer.from(buf).toString('utf8') : '';
  }
}));

// '/api/health' alias: the droplet's nginx only proxies /api/ to the backend,
// so the public health URL is /api/health. Bare /health stays for the
// container healthcheck and internal curls (localhost:4000/health).
app.get(['/health', '/api/health'], async (_req, res) => {
  const checks = { database: false };
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch {}
  const ok = checks.database;
  res.status(ok ? 200 : 503).json({
    ok,
    service: 'fleet-management-backend',
    uptime: Math.floor(process.uptime()),
    checks,
    sentryEnabled: isSentryEnabled()
  });
});

// API docs are password-protected via HTTP Basic Auth (DOCS_USER / DOCS_PASS in the env).
// Constant-time credential compare; if the creds aren't configured the docs are disabled (503)
// rather than left open.
function docsSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
function requireDocsAuth(req, res, next) {
  const user = process.env.DOCS_USER;
  const pass = process.env.DOCS_PASS;
  if (!user || !pass) {
    return res.status(503).type('text').send('API docs are not configured (set DOCS_USER and DOCS_PASS).');
  }
  const m = (req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
  if (m) {
    const idx = Buffer.from(m[1], 'base64').toString('utf8').indexOf(':');
    const u = idx >= 0 ? Buffer.from(m[1], 'base64').toString('utf8').slice(0, idx) : '';
    const p = idx >= 0 ? Buffer.from(m[1], 'base64').toString('utf8').slice(idx + 1) : '';
    // Compare both so a wrong username can't short-circuit the timing of the password check.
    const okUser = docsSafeEqual(u, user);
    const okPass = docsSafeEqual(p, pass);
    if (okUser && okPass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Ride Fleet API Docs", charset="UTF-8"');
  return res.status(401).type('text').send('Authentication required.');
}

app.get('/api/docs/openapi.json', requireDocsAuth, (req, res) => {
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  res.json(buildOpenApiSpec(serverUrl));
});

app.get(['/api/docs', '/api/docs/'], requireDocsAuth, (req, res) => {
  // Embed the spec inline (instead of a url:) so Swagger UI doesn't make a second fetch that the
  // Basic-Auth gate would block. The page itself is already authenticated.
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  res.type('html').send(swaggerHtml(buildOpenApiSpec(serverUrl)));
});

app.use('/api/auth', authRouter);
app.use('/api/public', customerPortalRouter);
// X-Tenant-Token scoping for the public booking website (2026-06-24). Absent header →
// no-op (legacy ?tenantSlug clients unaffected); present+valid → forces this tenant;
// present+invalid → 401. See middleware/public-tenant-token.js.
app.use('/api/public/booking', resolvePublicTenantToken);
app.use('/api/public/booking', publicBookingRouter);
app.use('/api/public/booking', accountDeletionRouter);
// Public loaner self-service (2026-06-25) — same X-Tenant-Token scoping as booking, fail-closed.
app.use('/api/public/loaner', resolvePublicTenantToken);
app.use('/api/public/loaner', publicLoanerRouter);
app.use('/api/public/addendum-signature', addendumSignaturePublicRouter);
app.use('/api/public/store-board', storeBoardPublicRouter);
app.use('/api/public/issues', publicIssueCenterRouter);
app.use('/api/public/telematics', publicVehicleTelematicsRouter);
// Shuttle tracker: token-only public read, one whitelisted payload. The
// token resolves everything; unusable tokens are a uniform 404.
app.use('/api/public/shuttle', shuttleTrackerPublicRouter);
// Driver mode (Phase 3): per-shift token-only surface — same bare-404 rule.
// Staff mint/revoke lives on /api/shuttle-monitor behind requireAuth.
app.use('/api/public/driver', shuttleDriverPublicRouter);
// Autopay enrollment (tenant subscriptions Phase 1): the tokenized surface a
// TENANT's owner opens to put a card on file for their Ride Fleet Manager
// subscription. Same bare-404 rule. Note this is RIDE's billing account
// (BILLING_AUTHNET_*) — the per-tenant rental gateway lives under
// /api/public/payment-gateway and uses AUTHNET_*; they must never be confused.
app.use('/api/public/billing', billingPublicRouter);
// Authorize.Net's webhook receiver for RIDE'S OWN billing account (Phase 2).
// POST /api/public/billing/authorizenet/webhook — unauthenticated by design:
// the X-ANET-Signature HMAC is the credential, verified over req.rawBodyBuffer
// (captured by the express.json verify hook above) before anything is parsed.
//
// SEPARATE ROUTER, SEPARATE KEY, ON PURPOSE. The rental receiver at
// /api/public/payment-gateway/authorizenet/webhook belongs to the per-tenant
// gateway and reads its Signature Key from per-tenant AppSettings; this one
// reads BILLING_AUTHNET_SIGNATURE_KEY from env. One route holding both
// credential sets would have to guess which merchant an event belonged to.
app.use('/api/public/billing', billingWebhookRouter);
// The TENANT's own billing page (Phase 5) — the one surface a suspended tenant
// is never locked out of, because it is where they pay. Both of its routes are
// entries in SUSPENSION_ALLOWLIST (lib/tenant-suspension.js); if this mount
// path ever changes, those entries must change with it or the suspension gate
// becomes a trap. Tenant-ADMIN gating lives on the router itself.
app.use('/api/billing', requireAuth, tenantRateLimit, billingSelfRouter);
app.use('/api/host-app', requireAuth, tenantRateLimit, requireModuleAccess('hostApp'), hostAppRouter);
app.use('/api/employee-app', requireAuth, tenantRateLimit, requireModuleAccess('employeeApp'), employeeAppRouter);
app.use('/api/dealership-loaner', requireAuth, tenantRateLimit, requireModuleAccess('loaner'), dealershipLoanerRouter);
// Loaner reimagine (2026-06-03 port) — in-bay wizard agreement API
app.use('/api/loaner-agreements', requireAuth, tenantRateLimit, requireModuleAccess('loaner'), loanerAgreementRouter);
// Long-Term (Monthly) reservations — P1 (2026-06-03)
app.use('/api/long-term', requireAuth, tenantRateLimit, requireModuleAccess('reservations'), longTermRouter);
// Token-scoped public routers: borrower remote signing + self-service portal
app.use('/api/public/loaner-signature', loanerSignaturePublicRouter);
app.use('/api/public/loaner-portal', loanerPortalPublicRouter);
app.use('/api/incident-reports', requireAuth, tenantRateLimit, incidentReportRouter);
// Report Damage flow (Feature 3, 2026-07-10) — a reservation-launched wizard that
// orchestrates the existing vehicle-damage + contract-charge + incident modules.
// Per-route role gates live INSIDE the router (POST = AGENT/OPS/ADMIN/SUPER_ADMIN
// with the scoped charge exception; PATCH/DELETE failsafe = ADMIN/SUPER_ADMIN).
app.use('/api/report-damage', requireAuth, tenantRateLimit, requireModuleAccess('reservations'), reportDamageRouter);
app.use('/api/issue-center', requireAuth, tenantRateLimit, requireModuleAccess('issueCenter'), issueCenterRouter);
app.use('/api/tolls', requireAuth, tenantRateLimit, requireModuleAccess('tolls'), tollsRouter);
app.use('/api/citations', requireAuth, tenantRateLimit, requireModuleAccess('citations'), citationsRouter);
app.use('/api/planner', requireAuth, tenantRateLimit, requireModuleAccess('planner'), plannerRouter);
// Shuttle Requests (Valet arc 2026-08-05) — Chloe writes via service account
// (allowlisted POST), floor staff read/close. Rides on the reservations module.
app.use('/api/shuttle-requests', requireAuth, tenantRateLimit, requireModuleAccess('reservations'), shuttleRequestsRouter);
// Shuttle tracker settings (2026-08-15) — per-location config for the public
// tracker page; same module gate as the shuttle queue it feeds.
app.use('/api/shuttle-tracker', requireAuth, tenantRateLimit, requireModuleAccess('reservations'), shuttleTrackerAdminRouter);
// Staff Shuttle Monitor (2026-08-24) — house-stored positions + open queues
// on one map. Same gate as the shuttle queue it summarizes; no public path.
app.use('/api/shuttle-monitor', requireAuth, tenantRateLimit, requireModuleAccess('reservations'), shuttleMonitorRouter);
// Shuttle zones + alert recipients (Phase 2, 2026-08-24) — ADMIN-tier CRUD
// (requireAuth + requireRole inside the router, same shape as the OneStepGPS
// connector panel): zone geometry decides what notifies customers, so it is
// NOT opened to the wider OPS tier. Every mutation is audited.
app.use('/api/shuttle-zones', tenantRateLimit, shuttleZonesRouter);
// Quotes module (2026-07-17) — doc/quotes-module-plan-2026-07-17.md
app.use('/api/quotes', requireAuth, tenantRateLimit, requireModuleAccess('quotes'), quotesRouter);
app.use('/api/payment-gateway', requireAuth, tenantRateLimit, requireRole('ADMIN', 'OPS'), paymentGatewayRouter);
app.use('/api/sms', requireAuth, tenantRateLimit, requireRole('ADMIN', 'OPS'), smsRouter);
app.use('/api/knowledge-base', requireAuth, tenantRateLimit, knowledgeBaseRouter);
// Ride University progress. No module gate: training is not a paid feature,
// and a person must always be able to see where they stand.
app.use('/api/training', requireAuth, tenantRateLimit, trainingRouter);
app.use('/api/admin/integrations/tl-international', tenantRateLimit, tlInternationalRouter);
// Economy (RezLight) booking-source integration (Fase 5, 2026-07-09) — mounted
// identically to TL. Routes/config always available; ECONOMY_INTEGRATION_ENABLED
// gates only the autonomous scheduler (economy.scheduler.js), which stays dark
// until the flag is flipped.
app.use('/api/admin/integrations/economy', tenantRateLimit, economyRouter);
// NU Car Rentals booking-source integration (Fase 5, 2026-07-09) — mounted
// identically to TL/Economy. Routes/config always available; NU_INTEGRATION_ENABLED
// gates only the autonomous scheduler (nu.scheduler.js), which stays dark until
// the flag is flipped. NU is location 1:1 (single NuLocationConfig mapping).
app.use('/api/admin/integrations/nu', tenantRateLimit, nuRouter);
// Flexways (MobilityPS) booking-source integration (Fase 5, 2026-07-13) — mounted
// identically to TL/Economy/NU. Routes/config always available;
// FLEXWAYS_INTEGRATION_ENABLED gates only the autonomous scheduler
// (flexways.scheduler.js), which stays dark until the flag is flipped. Flexways is
// MULTI-SEDE (per-idSede FlexwaysLocationConfig rows).
app.use('/api/admin/integrations/flexways', tenantRateLimit, flexwaysRouter);
// Advantage (TSD RezCentral) booking-source integration (Fase 5, 2026-07-16) —
// mounted identically to TL/Economy/NU/Flexways. Routes/config always available;
// ADVANTAGE_INTEGRATION_ENABLED gates only the autonomous scheduler
// (advantage.scheduler.js), which stays dark until the flag is flipped. Advantage
// is MULTI-CONFIG keyed by a PAIR: AdvantageLocationConfig rows are unique on
// (tenantId, tsdNumber, branch) — the portal's `Loc` column, "61302.MCO".
app.use('/api/admin/integrations/advantage', tenantRateLimit, advantageRouter);
// MEX Rent a Car (2026-07-26): same TSD RezCentral portal as Advantage, own
// module/flag/queue. Routes always available; MEX_INTEGRATION_ENABLED gates
// only the autonomous scheduler.
app.use('/api/admin/integrations/mex', tenantRateLimit, mexRouter);
// OneStepGPS telematics connector (2026-08-24) — API key + device→vehicle
// mappings for the shuttle tracker's fast poll. No scheduler flag: the stored
// key IS the readiness gate (no key → the fast poll never calls the provider).
app.use('/api/admin/integrations/onestepgps', tenantRateLimit, onestepgpsRouter);
// Round 26 (2026-06-01) — reservation status override + smart rewind.
// 2026-07-10: widened from SUPER_ADMIN-only to ADMIN + SUPER_ADMIN (Hector). ADMIN
// gets the same power (all target statuses + the smart rewind); SUPER_ADMIN still
// auto-passes via requireRole's isSuperAdmin bypass, so ADMIN is the only addition.
app.use('/api/admin/reservations', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), reservationOverrideRouter);
// VozIA Fase 6 re-scope (2026-07-04) — SUPER_ADMIN ops: free a wedged idempotency key.
app.use('/api/admin/idempotency', requireAuth, requireRole('SUPER_ADMIN'), idempotencyAdminRouter);
// GDPR Wave 2 Phase A — customer erasure (dry-run by default; gated by
// GDPR_ERASURE_ENABLED which ships OFF). Tenant-scoped via scopeFor.
app.use('/api/admin/customers', requireAuth, requireRole('ADMIN'), tenantRateLimit, customerErasureRouter);
// GDPR Wave 2 Phase B — per-customer data-subject EXPORT (read-only). Same base,
// same guards, same tenant scope as erase; walks the same PII map.
app.use('/api/admin/customers', requireAuth, requireRole('ADMIN'), tenantRateLimit, customerExportRouter);
app.use('/api/store-board', requireAuth, tenantRateLimit, requireRole('SUPER_ADMIN', 'ADMIN', 'OPS'), storeBoardRouter);
app.use('/api/inventory', requireAuth, tenantRateLimit, requireModuleAccess('vehicles'), inventoryRouter);
app.use('/api/repair-orders', requireAuth, tenantRateLimit, requireModuleAccess('maintenance'), repairOrdersRouter);
app.use('/api/maintenance', requireAuth, tenantRateLimit, requireModuleAccess('maintenance'), maintenanceRouter);
// Ride Kiosk Fase B1+B2 (2026-07-05). Device router FIRST: X-Kiosk-Token auth
// + per-IP public guards (tenant-rate-limit runs after requireAuth and never
// covers it). Its paths (/pair, POST /sessions, /sessions/:id/*) never match
// the admin ones (/devices*, /upsell-rules, /packages, GET /sessions exact),
// so admin requests fall through to the authed router mounted right below.
app.use('/api/kiosk', kioskRouter);
app.use('/api/kiosk', requireAuth, tenantRateLimit, requireModuleAccess('kiosk'), kioskAdminRouter);

app.use('/api/reservations', requireAuth, tenantRateLimit, requireModuleAccess('reservations'), reservationsRouter);
app.use('/api/reservations', requireAuth, tenantRateLimit, requireModuleAccess('reservations'), reservationExtendRouter);
app.use('/api/customers', requireAuth, tenantRateLimit, requireModuleAccess('customers'), customersRouter);
app.use('/api/vehicles', requireAuth, tenantRateLimit, requireModuleAccess('vehicles'), vehiclesRouter);
// VozIA Fase 2 (2026-07-03): GET /:id/hours mounted BEFORE the gated locations
// router, DELIBERATELY without requireModuleAccess('settings')/requireRole —
// the VozIA AGENT service account has no settings module, and operating hours
// + pickup instructions are operational info any authenticated user may read.
// The hours router only defines GET /:id/hours; every other /api/locations
// path falls through (Express router next()) to the gated router below.
app.use('/api/locations', requireAuth, tenantRateLimit, locationHoursRouter);
// The branch list a booking form needs — any authenticated staff, mounted
// before the ADMIN/OPS configuration gate below. See
// locations-selectable.routes.js: agents were getting a 403 rendered as an
// empty dropdown and could not create reservations at all.
app.use('/api/locations', requireAuth, tenantRateLimit, locationsSelectableRouter);
app.use('/api/locations', requireAuth, tenantRateLimit, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), locationsRouter);
// The class list the booking form needs — any authenticated staff, mounted
// before the ADMIN/OPS configuration gate below. Same fix, same reason as
// locations-selectable above: a 403 was rendering as an empty dropdown and
// no agent could pick a car (2026-08-17).
app.use('/api/vehicle-types', requireAuth, tenantRateLimit, vehicleTypesSelectableRouter);
app.use('/api/vehicle-types', requireAuth, tenantRateLimit, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), vehicleTypesRouter);
app.use('/api/additional-services', requireAuth, tenantRateLimit, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), additionalServicesRouter);
app.use('/api/fees', requireAuth, tenantRateLimit, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), feesRouter);
app.use('/api/stop-sales', requireAuth, tenantRateLimit, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), stopSalesRouter);
// The one rate READ the booking form needs: how short a rental may be. Any
// authenticated staff, before the ADMIN/OPS pricing gate below (2026-08-17).
app.use('/api/rates', requireAuth, tenantRateLimit, ratesBookingRouter);
app.use('/api/rates', requireAuth, tenantRateLimit, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), ratesRouter);
app.use('/api/market-scraper', requireAuth, tenantRateLimit, requireModuleAccess('marketIntelligence'), requireRole('ADMIN', 'OPS'), marketScraperRouter);
app.use('/api/market', requireAuth, tenantRateLimit, requireModuleAccess('marketIntelligence'), requireRole('ADMIN', 'OPS'), marketObservationsRouter);
app.use('/api/pricing-rules', requireAuth, tenantRateLimit, requireModuleAccess('marketIntelligence'), requireRole('ADMIN', 'OPS'), pricingRulesRouter);
app.use('/api/pricing-suggestions', requireAuth, tenantRateLimit, requireModuleAccess('marketIntelligence'), requireRole('ADMIN', 'OPS'), pricingSuggestionsRouter);
app.use('/api/market-onboarding', requireAuth, tenantRateLimit, requireModuleAccess('marketIntelligence'), requireRole('ADMIN', 'OPS'), marketOnboardingRouter);
// Internal endpoint hit by the droplet cron after every successful scrape.
// Auth is via BACKEND_INTERNAL_TOKEN shared secret, not user session.
app.use('/api/internal/pricing-engine', pricingEngineInternalRouter);
// Internal endpoint hit by the citations scraper droplet to push ingested rows.
app.use('/api/internal/citations', citationsInternalRouter);
// Internal endpoint for the tolls scraper droplet (SunPass/E-PASS, etc.) — keeps
// heavy headless scraping OFF the worker so connectors don't block each other.
app.use('/api/internal/tolls', tollsInternalRouter);
// Internal fleet feed for TollBridge (their point 6, Hector's decision: RFM is
// the fleet source of truth). DEDICATED token (TOLLBRIDGE_FLEET_TOKEN), not
// BACKEND_INTERNAL_TOKEN, so revoking TollBridge never breaks the scrapers.
app.use('/api/internal/fleet', fleetInternalRouter);
app.use('/api/rental-agreements', requireAuth, tenantRateLimit, requireModuleAccess('reservations'), rentalAgreementsRouter);
// Dejavoo Spin checkout redesign (Phase 1.2). The auth'd router is for
// the agent's wizard; the public router below is for the QR token
// exchange from a customer's phone or the agent's mobile after a handoff.
app.use('/api/checkout-sessions', requireAuth, tenantRateLimit, requireModuleAccess('reservations'), checkoutSessionRouter);
app.use('/api/public/checkout-handoff', checkoutSessionPublicRouter);
// Token-scoped T&C signing — no auth, token in URL is the auth.
// JSON body limit raised on the parent app already; signature images
// are ~50KB each so default Express limit (100KB) is fine for now.
// Public-endpoint meta + per-IP rate limits live INSIDE the router, per
// route, the way addendum-signature-public.routes.js does it — reads and
// writes need different ceilings, which a single app.use() cannot express.
app.use('/api/sign', termsSigningPublicRouter);
// Token-scoped mobile inspection — same trust model as /api/sign. Photos
// can run 1-2MB each, so the router applies its own express.json({limit: '15mb'}).
app.use('/api/mobile-inspection', mobileInspectionPublicRouter);
// 2026-06-11 — customer-led inspection (token = auth, 24h TTL). Same trust
// model and body-limit strategy as /api/mobile-inspection.
app.use('/api/customer-inspection', customerInspectionPublicRouter);
// Fase B (2026-06-11) — agent review queue for customer damage reports.
app.use('/api/customer-inspections', requireAuth, tenantRateLimit, customerInspectionRouter);
// 2026-05-25 — mount Reports v2 router FIRST so the new /list and per-slug
// data/pdf/excel endpoints win. The legacy reportsRouter stays mounted as
// a fallthrough for any path the v2 router doesn't define.
// Report Builder (2026-07-26): saved custom reports. Mounted BEFORE the v2
// router so /custom/* never falls through to a report slug.
app.use('/api/reports/custom', requireAuth, tenantRateLimit, requireModuleAccess('reports'), customReportsRouter);
// Global search for the Cmd/Ctrl+K palette (2026-07-27): any authenticated
// staff; results only link to pages that keep their own guards.
app.use('/api/search', requireAuth, tenantRateLimit, globalSearchRouter);
app.use('/api/reports', requireAuth, tenantRateLimit, todayKpisRouter);
app.use('/api/reports', requireAuth, tenantRateLimit, requireModuleAccess('reports'), reportsV2Router);
app.use('/api/reports', requireAuth, tenantRateLimit, requireModuleAccess('reports'), reportsRouter);
app.use('/api/commissions', requireAuth, tenantRateLimit, requireModuleAccess('reports'), commissionsRouter);
app.use('/api/car-sharing', requireAuth, tenantRateLimit, requireModuleAccess('carSharing'), requireRole('ADMIN', 'OPS'), carSharingRouter);
app.use('/api/people', requireAuth, tenantRateLimit, requireModuleAccess('people'), peopleRouter);
// Fee rates: GET is open to any authed user (the checkin wizard's live fee
// preview needs to read tenant overrides even when run by OPS/AGENT who
// don't have the 'settings' module). PUT is gated by requireRole('ADMIN')
// inside the router file. DO NOT add requireModuleAccess here — would
// break the preview hook in /reservations/:id/checkin-wizard.
app.use('/api/settings/fee-rates', requireAuth, tenantRateLimit, feeRatesRouter);
// Payment capabilities: GET is open to any authed user (the View Payments
// screen needs the tenant's gateway booleans even for OPS/AGENT who don't
// have the 'settings' module — an iPOS tenant must not see Auth.Net buttons).
// Booleans only, derived server-side; never credentials. DO NOT add
// requireModuleAccess here — it would 403 exactly the counter staff the
// endpoint exists for.
app.use('/api/settings/payment-capabilities', requireAuth, tenantRateLimit, paymentCapabilitiesRouter);
// Notification Center (2026-09-01): readable by EVERY authenticated staff
// role — an AGENT without the 'tolls' or 'settings' module still needs the
// bell (guest waiting at a kiosk, vehicle outside geofence). Same precedent
// as payment-capabilities above. DO NOT add requireModuleAccess here; role-
// gated categories (billing → ADMIN) filter inside the service instead.
app.use('/api/notifications', requireAuth, tenantRateLimit, notificationsRouter);
// Check-in audit (2026-09-03): the post-return T1 review queue. Same
// no-module-gate posture as notifications — the agents who close check-ins
// are exactly the audience; every read is tenant-scoped inside the service.
app.use('/api/checkin-audit', requireAuth, tenantRateLimit, checkinAuditRouter);
app.use('/api/settings/loaner-rates', requireAuth, tenantRateLimit, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), loanerRateRouter);
app.use('/api/settings', requireAuth, tenantRateLimit, requireModuleAccess('settings'), settingsRouter);
app.use('/api/tenants', requireAuth, tenantRateLimit, requireModuleAccess('tenants'), tenantsRouter);

// Map AppError subclasses (ValidationError, NotFoundError, etc.) to their status codes
app.use(appErrorHandler);

// Catch-all: log to Sentry + return 500
app.use((err, req, res, _next) => {
  /**
   * A 4xx a service DELIBERATELY threw is information for the caller, not an
   * incident. This handler used to flatten everything to "Internal server
   * error", so "No demo tenant is configured" (a 404 with a fix attached)
   * reached the screen as an opaque 500 and cost an afternoon of debugging a
   * feature that was working correctly (2026-08-17). 121 sites across the app
   * throw AppError/.status 4xx and every one of them was being buried.
   *
   * 5xx keeps the old behavior exactly — opaque message, Sentry, console —
   * because an UNEXPECTED error must never leak internals.
   */
  // `httpStatus` is honored too (DAST 2026-08-23): 19 service files across the
  // app throw typed 4xx as `e.httpStatus = 400` (e.g. settings market-pricing
  // validation), a convention this handler used to silently drop — every one of
  // them was surfacing as a 500. All three shapes are deliberate 4xx.
  const status = Number(err?.status || err?.statusCode || err?.httpStatus) || 500;
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: err?.message || 'Request failed' });
  }
  // MALFORMED CLIENT INPUT (DAST 2026-08-23): a bad path id or wrong-typed query
  // arg reaches Prisma as a known client error, not a server fault. These were
  // surfacing as opaque 500s (e.g. /host-app/listings/:id/availability,
  // /knowledge-base/:id/helpful, /citations/documents, /issue-center/dashboard
  // when fed a non-cuid id / junk query). Map to 4xx and SKIP Sentry. The
  // message is deliberately GENERIC — a raw Prisma message names columns/types
  // (schema leak), which is exactly what we don't want a scanner to see.
  const prismaCode = err?.code;
  if (
    err?.name === 'PrismaClientValidationError' ||
    prismaCode === 'P2023' || // inconsistent column data (malformed id)
    prismaCode === 'P2009' || // failed to validate the query
    prismaCode === 'P2000'    // value too long for column
  ) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  if (prismaCode === 'P2025') { // required record(s) not found
    return res.status(404).json({ error: 'Not found' });
  }
  captureBackendException(err, {
    request: {
      method: req.method,
      path: req.originalUrl || req.url,
      tenantId: req.user?.tenantId || null
    },
    user: req.user?.sub ? { id: req.user.sub, tenantId: req.user?.tenantId || null, role: req.user?.role || null } : undefined
  });
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 4000;
const isFirstWorker = !cluster.isWorker || cluster.worker.id === 1;

// SKIP_LISTEN=1 lets the CI's backend-check job import this module to walk
// the full transitive import graph (catching ERR_MODULE_NOT_FOUND on missing
// files — the class of bug behind BUG-003) without actually opening a port
// or starting schedulers. Production / dev / docker-compose all leave it
// unset, so the listener starts as before.
if (process.env.SKIP_LISTEN !== '1') {
  // Resolve the field-encryption DEK before serving traffic. Inert by default
  // (FIELD_ENC_KMS_ENABLED unset → no AWS SDK loaded, no KMS call; field-crypto
  // keeps reading FIELD_ENC_KEY). With KMS enabled it unwraps the DEK via AWS
  // KMS and hands it to field-crypto. ANY failure must STOP the boot — never
  // serve traffic with a broken/half-resolved key, which would corrupt PII
  // reads and writes.
  try {
    const { resolveFieldKey, isKmsEnabled } = await import('./lib/kms-key-provider.js');
    const r = await resolveFieldKey();
    if (isKmsEnabled()) console.log('[field-key] DEK resolved via AWS KMS', { source: r.source });
  } catch (e) {
    console.error('[field-key] FATAL: could not resolve field-encryption key:', e?.message);
    process.exit(1);
  }

  // Apply pending DB migrations before accepting traffic, so a release that adds
  // a column can't go live against a DB missing it (2026-06-27 outage fix).
  // Fail-open + disable via AUTO_MIGRATE_ON_BOOT=false.
  if (String(process.env.AUTO_MIGRATE_ON_BOOT || 'true').toLowerCase() !== 'false') {
    try {
      const { runStartupMigrations } = await import('./lib/startup-migrate.js');
      const r = await runStartupMigrations();
      console.log('[startup-migrate] done', { baselined: r.baselined, applied: r.applied?.length || 0, failed: r.failed?.length || 0 });
    } catch (e) {
      console.error('[startup-migrate] runner error (continuing to boot):', e?.message);
    }
  }
  app.listen(port, () => {
    console.log(`Fleet backend listening on http://localhost:${port} (pid=${process.pid})`);
    // Only start schedulers in the first worker to avoid duplicate runs
    if (isFirstWorker) {
      startHandoffReminderScheduler();
      startCheckoutSessionCleanupScheduler();
      // Self-guarded: registers a timer only when RETENTION_SWEEP_ENABLED=true.
      startRetentionSweepScheduler();
      // Surface Spin misconfiguration (missing TPN/key, sandbox on,
      // dry-run on) at boot rather than at the moment a customer taps
      // their card. Lazy-load so the unit-test harness doesn't pull
      // logger into a side-effecting import chain.
      import('./modules/payment-gateway/spin-client.js')
        .then(({ auditSpinConfig }) => auditSpinConfig())
        .catch(() => {});
      // Ride University's written half. A knowledge-base article used to
      // reach a tenant only if somebody pressed "Seed defaults", a button
      // that renders only when they have NO articles — so article number
      // seven never shipped to anyone and two had to be inserted into
      // production by hand. This tops up the GLOBAL corpus with any article
      // the release added, matching on slug, and rewrites one ONLY when the
      // stored body still hashes to a body we published (see `supersedes`) —
      // so a correction ships while a tenant's own edit never gets flattened.
      // Lazy-loaded and fail-open, like the audits below — training content is
      // not worth failing a boot for.
      import('./modules/knowledge-base/knowledge-base.service.js')
        .then(({ knowledgeBaseService }) => knowledgeBaseService.ensureGlobalArticles())
        .then((r) => { if (r?.seeded || r?.upgraded) console.log('[knowledge-base] published new articles', r); })
        .catch((e) => console.error('[knowledge-base] article top-up skipped:', e?.message));
      // Same audit for the iPOSpays Transact API (CNP token operations).
      import('./modules/payment-gateway/ipos-transact-client.js')
        .then(({ auditIposTransactConfig }) => auditIposTransactConfig())
        .catch(() => {});
      // And the auth module — surfaces "auto-refresh on / off" + scope
      // at boot rather than at first token call.
      import('./modules/payment-gateway/ipos-auth.js')
        .then(({ auditIposAuth }) => auditIposAuth())
        .catch(() => {});
    }
  });
}

process.on('SIGINT', async () => {
  stopHandoffReminderScheduler();
  stopCheckoutSessionCleanupScheduler();
  stopRetentionSweepScheduler();
  // Best-effort drain of any buffered security-audit events before exit (no-op
  // when the forwarder is unconfigured); then cancel its timer.
  await flushSecurityEvents();
  stopSecurityLogForwarder();
  await closeBrowser();
  await flushSentry();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  stopHandoffReminderScheduler();
  stopCheckoutSessionCleanupScheduler();
  stopRetentionSweepScheduler();
  await flushSecurityEvents();
  stopSecurityLogForwarder();
  await closeBrowser();
  await flushSentry();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('unhandledRejection', async (reason) => {
  // Print to stderr so local dev sees it even when Sentry is off.
  console.error('[main] unhandledRejection:', reason);
  captureBackendException(reason instanceof Error ? reason : new Error(String(reason)), {
    lifecycle: 'unhandledRejection'
  });
  await flushSentry();
});

process.on('uncaughtException', async (error) => {
  console.error('[main] uncaughtException:', error);
  captureBackendException(error, { lifecycle: 'uncaughtException' });
  await flushSentry();
});

// Also log right BEFORE listen so we can see how far execution gets if
// SKIP_LISTEN is sneakily set somewhere.
console.log(`[main] reached pre-listen, SKIP_LISTEN=${process.env.SKIP_LISTEN || 'unset'}, port=${process.env.PORT || 4000}`);
