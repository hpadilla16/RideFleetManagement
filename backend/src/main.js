import cluster from 'node:cluster';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import logger, { requestLogger } from './lib/logger.js';
import { reservationsRouter } from './modules/reservations/reservations.routes.js';
import { reservationExtendRouter } from './modules/reservations/reservation-extend.routes.js';
import { reservationOverrideRouter } from './modules/admin/reservation-override.routes.js';
import { customersRouter } from './modules/customers/customers.routes.js';
import { publicVehicleTelematicsRouter, vehiclesRouter } from './modules/vehicles/vehicles.routes.js';
import { inventoryRouter } from './modules/inventory/inventory.routes.js';
import { locationsRouter } from './modules/locations/locations.routes.js';
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
import { storeBoardRouter } from './modules/store-board/store-board.routes.js';
import { storeBoardPublicRouter } from './modules/store-board/store-board-public.routes.js';
import { assertAuthConfig } from './modules/auth/auth.config.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { feeRatesRouter } from './modules/fees/fee-rates.routes.js';
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
import { issueCenterRouter, publicIssueCenterRouter } from './modules/issue-center/issue-center.routes.js';
import { tollsRouter, tollsInternalRouter } from './modules/tolls/tolls.routes.js';
import { plannerRouter } from './modules/planner/planner.routes.js';
import { paymentGatewayRouter } from './modules/payment-gateway/payment-gateway.routes.js';
// Phase 0 (2026-06-09): the toll auto-sync scheduler MOVED to the worker
// process (src/worker.js) — its sweeps spawn headless Chromium pages and that
// RAM/CPU no longer belongs in the API container. Manual per-tenant syncs
// triggered from the API still run here, under the global page cap.
import { startHandoffReminderScheduler, stopHandoffReminderScheduler } from './modules/car-sharing/car-sharing.scheduler.js';
import { startCheckoutSessionCleanupScheduler, stopCheckoutSessionCleanupScheduler } from './modules/checkout-session/checkout-session.scheduler.js';
import { buildOpenApiSpec, swaggerHtml } from './docs/openapi.js';
import { smsRouter } from './modules/sms/sms.routes.js';
import { knowledgeBaseRouter } from './modules/knowledge-base/knowledge-base.routes.js';
import { tlInternationalRouter } from './modules/integrations/tl-international/tl-international.routes.js';
import { captureBackendException, flushSentry, initSentry, isSentryEnabled } from './lib/sentry.js';
import { appErrorHandler } from './lib/errors.js';
import { closeBrowser } from './lib/puppeteer-browser.js';

assertAuthConfig();
initSentry();

const app = express();

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

app.get('/health', async (_req, res) => {
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
app.use('/api/issue-center', requireAuth, tenantRateLimit, requireModuleAccess('issueCenter'), issueCenterRouter);
app.use('/api/tolls', requireAuth, tenantRateLimit, requireModuleAccess('tolls'), tollsRouter);
app.use('/api/citations', requireAuth, tenantRateLimit, requireModuleAccess('citations'), citationsRouter);
app.use('/api/planner', requireAuth, tenantRateLimit, requireModuleAccess('planner'), plannerRouter);
app.use('/api/payment-gateway', requireAuth, tenantRateLimit, requireRole('ADMIN', 'OPS'), paymentGatewayRouter);
app.use('/api/sms', requireAuth, tenantRateLimit, requireRole('ADMIN', 'OPS'), smsRouter);
app.use('/api/knowledge-base', requireAuth, tenantRateLimit, knowledgeBaseRouter);
app.use('/api/admin/integrations/tl-international', tenantRateLimit, tlInternationalRouter);
// Round 26 (2026-06-01) — SUPER_ADMIN reservation status override + smart rewind
app.use('/api/admin/reservations', requireAuth, requireRole('SUPER_ADMIN'), reservationOverrideRouter);
app.use('/api/store-board', requireAuth, tenantRateLimit, requireRole('SUPER_ADMIN', 'ADMIN', 'OPS'), storeBoardRouter);
app.use('/api/inventory', requireAuth, tenantRateLimit, requireModuleAccess('vehicles'), inventoryRouter);
app.use('/api/repair-orders', requireAuth, tenantRateLimit, requireModuleAccess('maintenance'), repairOrdersRouter);
app.use('/api/maintenance', requireAuth, tenantRateLimit, requireModuleAccess('maintenance'), maintenanceRouter);

app.use('/api/reservations', requireAuth, tenantRateLimit, requireModuleAccess('reservations'), reservationsRouter);
app.use('/api/reservations', requireAuth, tenantRateLimit, requireModuleAccess('reservations'), reservationExtendRouter);
app.use('/api/customers', requireAuth, tenantRateLimit, requireModuleAccess('customers'), customersRouter);
app.use('/api/vehicles', requireAuth, tenantRateLimit, requireModuleAccess('vehicles'), vehiclesRouter);
app.use('/api/locations', requireAuth, tenantRateLimit, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), locationsRouter);
app.use('/api/vehicle-types', requireAuth, tenantRateLimit, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), vehicleTypesRouter);
app.use('/api/additional-services', requireAuth, tenantRateLimit, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), additionalServicesRouter);
app.use('/api/fees', requireAuth, tenantRateLimit, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), feesRouter);
app.use('/api/stop-sales', requireAuth, tenantRateLimit, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), stopSalesRouter);
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
app.use('/api/rental-agreements', requireAuth, tenantRateLimit, requireModuleAccess('reservations'), rentalAgreementsRouter);
// Dejavoo Spin checkout redesign (Phase 1.2). The auth'd router is for
// the agent's wizard; the public router below is for the QR token
// exchange from a customer's phone or the agent's mobile after a handoff.
app.use('/api/checkout-sessions', requireAuth, tenantRateLimit, requireModuleAccess('reservations'), checkoutSessionRouter);
app.use('/api/public/checkout-handoff', checkoutSessionPublicRouter);
// Token-scoped T&C signing — no auth, token in URL is the auth.
// JSON body limit raised on the parent app already; signature images
// are ~50KB each so default Express limit (100KB) is fine for now.
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
app.use('/api/settings/loaner-rates', requireAuth, tenantRateLimit, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), loanerRateRouter);
app.use('/api/settings', requireAuth, tenantRateLimit, requireModuleAccess('settings'), settingsRouter);
app.use('/api/tenants', requireAuth, tenantRateLimit, requireModuleAccess('tenants'), tenantsRouter);

// Map AppError subclasses (ValidationError, NotFoundError, etc.) to their status codes
app.use(appErrorHandler);

// Catch-all: log to Sentry + return 500
app.use((err, req, res, _next) => {
  captureBackendException(err, {
    request: {
      method: req.method,
      path: req.originalUrl || req.url,
      tenantId: req.user?.tenantId || null
    },
    user: req.user?.sub ? { id: req.user.sub, tenantId: req.user?.tenantId || null, role: req.user?.role || null } : undefined
  });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 4000;
const isFirstWorker = !cluster.isWorker || cluster.worker.id === 1;

// SKIP_LISTEN=1 lets the CI's backend-check job import this module to walk
// the full transitive import graph (catching ERR_MODULE_NOT_FOUND on missing
// files — the class of bug behind BUG-003) without actually opening a port
// or starting schedulers. Production / dev / docker-compose all leave it
// unset, so the listener starts as before.
if (process.env.SKIP_LISTEN !== '1') {
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
      // Surface Spin misconfiguration (missing TPN/key, sandbox on,
      // dry-run on) at boot rather than at the moment a customer taps
      // their card. Lazy-load so the unit-test harness doesn't pull
      // logger into a side-effecting import chain.
      import('./modules/payment-gateway/spin-client.js')
        .then(({ auditSpinConfig }) => auditSpinConfig())
        .catch(() => {});
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
  await closeBrowser();
  await flushSentry();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  stopHandoffReminderScheduler();
  stopCheckoutSessionCleanupScheduler();
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
