import express from 'express';
import cors from 'cors';
import compression from 'compression';
import logger, { requestLogger } from './lib/logger.js';
import { reservationsRouter } from './modules/reservations/reservations.routes.js';
import { customersRouter } from './modules/customers/customers.routes.js';
import { publicVehicleTelematicsRouter, vehiclesRouter } from './modules/vehicles/vehicles.routes.js';
import { locationsRouter } from './modules/locations/locations.routes.js';
import { vehicleTypesRouter } from './modules/vehicle-types/vehicle-types.routes.js';
import { additionalServicesRouter } from './modules/additional-services/additional-services.routes.js';
import { feesRouter } from './modules/fees/fees.routes.js';
import { ratesRouter } from './modules/rates/rates.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { rentalAgreementsRouter } from './modules/rental-agreements/rental-agreements.routes.js';
import { assertAuthConfig } from './modules/auth/auth.config.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { requireAuth, requireRole, requireModuleAccess } from './middleware/auth.js';
import { prisma } from './lib/prisma.js';
import { customerPortalRouter } from './modules/customer-portal/customer-portal.routes.js';
import { tenantsRouter } from './modules/tenants/tenants.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { commissionsRouter } from './modules/commissions/commissions.routes.js';
import { carSharingRouter } from './modules/car-sharing/car-sharing.routes.js';
import { peopleRouter } from './modules/people/people.routes.js';
import { publicBookingRouter } from './modules/public-booking/public-booking.routes.js';
import { hostAppRouter } from './modules/host-app/host-app.routes.js';
import { employeeAppRouter } from './modules/employee-app/employee-app.routes.js';
import { dealershipLoanerRouter } from './modules/dealership-loaner/dealership-loaner.routes.js';
import { issueCenterRouter, publicIssueCenterRouter } from './modules/issue-center/issue-center.routes.js';
import { tollsRouter } from './modules/tolls/tolls.routes.js';
import { plannerRouter } from './modules/planner/planner.routes.js';
import { paymentGatewayRouter } from './modules/payment-gateway/payment-gateway.routes.js';
import { startTollAutoSyncScheduler, stopTollAutoSyncScheduler } from './modules/tolls/tolls.scheduler.js';
import { startHandoffReminderScheduler, stopHandoffReminderScheduler } from './modules/car-sharing/car-sharing.scheduler.js';
import { buildOpenApiSpec, swaggerHtml } from './docs/openapi.js';
import { smsRouter } from './modules/sms/sms.routes.js';
import { captureBackendException, flushSentry, initSentry, isSentryEnabled } from './lib/sentry.js';
import { appErrorHandler } from './lib/errors.js';

assertAuthConfig();
initSentry();

const app = express();
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];
app.use(compression({ threshold: 1024 }));
app.use(requestLogger());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({
  limit: '12mb',
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
app.use('/api/public/issues', publicIssueCenterRouter);
app.use('/api/public/telematics', publicVehicleTelematicsRouter);
app.use('/api/host-app', requireAuth, requireModuleAccess('hostApp'), hostAppRouter);
app.use('/api/employee-app', requireAuth, requireModuleAccess('employeeApp'), employeeAppRouter);
app.use('/api/dealership-loaner', requireAuth, requireModuleAccess('loaner'), dealershipLoanerRouter);
app.use('/api/issue-center', requireAuth, requireModuleAccess('issueCenter'), issueCenterRouter);
app.use('/api/tolls', requireAuth, requireModuleAccess('tolls'), tollsRouter);
app.use('/api/planner', requireAuth, requireModuleAccess('planner'), plannerRouter);
app.use('/api/payment-gateway', requireAuth, requireRole('ADMIN', 'OPS'), paymentGatewayRouter);
app.use('/api/sms', requireAuth, requireRole('ADMIN', 'OPS'), smsRouter);

app.use('/api/reservations', requireAuth, requireModuleAccess('reservations'), reservationsRouter);
app.use('/api/customers', requireAuth, requireModuleAccess('customers'), customersRouter);
app.use('/api/vehicles', requireAuth, requireModuleAccess('vehicles'), vehiclesRouter);
app.use('/api/locations', requireAuth, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), locationsRouter);
app.use('/api/vehicle-types', requireAuth, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), vehicleTypesRouter);
app.use('/api/additional-services', requireAuth, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), additionalServicesRouter);
app.use('/api/fees', requireAuth, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), feesRouter);
app.use('/api/rates', requireAuth, requireModuleAccess('settings'), requireRole('ADMIN', 'OPS'), ratesRouter);
app.use('/api/rental-agreements', requireAuth, requireModuleAccess('reservations'), rentalAgreementsRouter);
app.use('/api/reports', requireAuth, requireModuleAccess('reports'), reportsRouter);
app.use('/api/commissions', requireAuth, requireModuleAccess('reports'), commissionsRouter);
app.use('/api/car-sharing', requireAuth, requireModuleAccess('carSharing'), requireRole('ADMIN', 'OPS'), carSharingRouter);
app.use('/api/people', requireAuth, requireModuleAccess('people'), peopleRouter);
app.use('/api/settings', requireAuth, requireModuleAccess('settings'), settingsRouter);
app.use('/api/tenants', requireAuth, requireModuleAccess('tenants'), tenantsRouter);

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
app.listen(port, () => {
  console.log(`Fleet backend listening on http://localhost:${port}`);
  startTollAutoSyncScheduler();
  startHandoffReminderScheduler();
});

process.on('SIGINT', async () => {
  stopTollAutoSyncScheduler();
  stopHandoffReminderScheduler();
  await flushSentry();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  stopTollAutoSyncScheduler();
  stopHandoffReminderScheduler();
  await flushSentry();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('unhandledRejection', async (reason) => {
  captureBackendException(reason instanceof Error ? reason : new Error(String(reason)), {
    lifecycle: 'unhandledRejection'
  });
  await flushSentry();
});

process.on('uncaughtException', async (error) => {
  captureBackendException(error, { lifecycle: 'uncaughtException' });
  await flushSentry();
});
