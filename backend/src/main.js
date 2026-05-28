import cluster from 'node:cluster';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import logger, { requestLogger } from './lib/logger.js';
import { reservationsRouter } from './modules/reservations/reservations.routes.js';
import { reservationExtendRouter } from './modules/reservations/reservation-extend.routes.js';
import { customersRouter } from './modules/customers/customers.routes.js';
import { publicVehicleTelematicsRouter, vehiclesRouter } from './modules/vehicles/vehicles.routes.js';
import { locationsRouter } from './modules/locations/locations.routes.js';
import { vehicleTypesRouter } from './modules/vehicle-types/vehicle-types.routes.js';
import { additionalServicesRouter } from './modules/additional-services/additional-services.routes.js';
import { feesRouter } from './modules/fees/fees.routes.js';
import { stopSalesRouter } from './modules/stop-sales/stop-sales.routes.js';
import { ratesRouter } from './modules/rates/rates.routes.js';
import { marketScraperRouter } from './modules/market-scraper/market-scraper.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { rentalAgreementsRouter } from './modules/rental-agreements/rental-agreements.routes.js';
import { addendumSignaturePublicRouter } from './modules/rental-agreements/addendum-signature-public.routes.js';
import { checkoutSessionRouter, checkoutSessionPublicRouter } from './modules/checkout-session/checkout-session.routes.js';
import { termsSigningPublicRouter } from './modules/checkout-session/terms-signing.routes.js';
import { storeBoardRouter } from './modules/store-board/store-board.routes.js';
import { storeBoardPublicRouter } from './modules/store-board/store-board-public.routes.js';
import { assertAuthConfig } from './modules/auth/auth.config.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { feeRatesRouter } from './modules/fees/fee-rates.routes.js';
import { requireAuth, requireRole, requireModuleAccess } from './middleware/auth.js';
import { tenantRateLimit } from './middleware/tenant-rate-limit.js';
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
import { issueCenterRouter, publicIssueCenterRouter } from './modules/issue-center/issue-center.routes.js';
import { tollsRouter } from './modules/tolls/tolls.routes.js';
import { plannerRouter } from './modules/planner/planner.routes.js';
import { paymentGatewayRouter } from './modules/payment-gateway/payment-gateway.routes.js';
import { startTollAutoSyncScheduler, stopTollAutoSyncScheduler } from './modules/tolls/tolls.scheduler.js';
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
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];
app.use(compression({ threshold: 1024 }));
app.use(requestLogger());
// PR-5 PERF telemetry — sampled per-request load observations. Mounted
// here (after request-id, before auth) so it sees public endpoints too;
// tenantId is captured inside res.on("finish") after auth has populated
// req.user (if any). Sample rate via ENDPOINT_LOAD_SAMPLE_RATE (default 1%).
app.use(endpointLoadSampler());
app.use(cors({ origin: allowedOrigins, credentials: true }));
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

app.get('/api/docs/openapi.json', (req, res) => {
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  res.json(buildOpenApiSpec(serverUrl));
});

app.get(['/api/docs', '/api/docs/'], (_req, res) => {
  res.type('html').send(swaggerHtml('/api/docs/openapi.json'));
});

app.use('/api/auth', authRouter);
app.use('/api/public', customerPortalRouter);
app.use('/api/public/booking', publicBookingRouter);
app.use('/api/public/booking', accountDeletionRouter);
app.use('/api/public/addendum-signature', addendumSignaturePublicRouter);
app.use('/api/public/store-board', storeBoardPublicRouter);
app.use('/api/public/issues', publicIssueCenterRouter);
app.use('/api/public/telematics', publicVehicleTelematicsRouter);
app.use('/api/host-app', requireAuth, tenantRateLimit, requireModuleAccess('hostApp'), hostAppRouter);
app.use('/api/employee-app', requireAuth, tenantRateLimit, requireModuleAccess('employeeApp'), employeeAppRouter);
app.use('/api/dealership-loaner', requireAuth, tenantRateLimit, requireModuleAccess('loaner'), dealershipLoanerRouter);
app.use('/api/issue-center', requireAuth, tenantRateLimit, requireModuleAccess('issueCenter'), issueCenterRouter);
app.use('/api/tolls', requireAuth, tenantRateLimit, requireModuleAccess('tolls'), tollsRouter);
app.use('/api/planner', requireAuth, tenantRateLimit, requireModuleAccess('planner'), plannerRouter);
app.use('/api/payment-gateway', requireAuth, tenantRateLimit, requireRole('ADMIN', 'OPS'), paymentGatewayRouter);
app.use('/api/sms', requireAuth, tenantRateLimit, requireRole('ADMIN', 'OPS'), smsRouter);
app.use('/api/knowledge-base', requireAuth, tenantRateLimit, knowledgeBaseRouter);
app.use('/api/admin/integrations/tl-international', tenantRateLimit, tlInternationalRouter);
app.use('/api/store-board', requireAuth, tenantRateLimit, requireRole('SUPER_ADMIN', 'ADMIN', 'OPS'), storeBoardRouter);

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
app.use('/api/market-scraper', requireAuth, tenantRateLimit, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), marketScraperRouter);
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
  app.listen(port, () => {
    console.log(`Fleet backend listening on http://localhost:${port} (pid=${process.pid})`);
    // Only start schedulers in the first worker to avoid duplicate runs
    if (isFirstWorker) {
      startTollAutoSyncScheduler();
      startHandoffReminderScheduler();
      startCheckoutSessionCleanupScheduler();
    }
  });
}

process.on('SIGINT', async () => {
  stopTollAutoSyncScheduler();
  stopHandoffReminderScheduler();
  stopCheckoutSessionCleanupScheduler();
  await closeBrowser();
  await flushSentry();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  stopTollAutoSyncScheduler();
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
