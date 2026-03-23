import express from 'express';
import cors from 'cors';
import { reservationsRouter } from './modules/reservations/reservations.routes.js';
import { customersRouter } from './modules/customers/customers.routes.js';
import { vehiclesRouter } from './modules/vehicles/vehicles.routes.js';
import { locationsRouter } from './modules/locations/locations.routes.js';
import { vehicleTypesRouter } from './modules/vehicle-types/vehicle-types.routes.js';
import { additionalServicesRouter } from './modules/additional-services/additional-services.routes.js';
import { feesRouter } from './modules/fees/fees.routes.js';
import { ratesRouter } from './modules/rates/rates.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { rentalAgreementsRouter } from './modules/rental-agreements/rental-agreements.routes.js';
import { assertAuthConfig } from './modules/auth/auth.config.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { requireAuth, requireRole } from './middleware/auth.js';
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
import { buildOpenApiSpec, swaggerHtml } from './docs/openapi.js';

assertAuthConfig();

const app = express();
app.use(cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:3000'] }));
app.use(express.json({ limit: '12mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'fleet-management-backend' });
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
app.use('/api/host-app', requireAuth, hostAppRouter);
app.use('/api/employee-app', requireAuth, employeeAppRouter);
app.use('/api/dealership-loaner', requireAuth, dealershipLoanerRouter);
app.use('/api/issue-center', requireAuth, issueCenterRouter);

app.use('/api/reservations', requireAuth, reservationsRouter);
app.use('/api/customers', requireAuth, customersRouter);
app.use('/api/vehicles', requireAuth, vehiclesRouter);
app.use('/api/locations', requireAuth, requireRole('ADMIN', 'OPS'), locationsRouter);
app.use('/api/vehicle-types', requireAuth, requireRole('ADMIN', 'OPS'), vehicleTypesRouter);
app.use('/api/additional-services', requireAuth, requireRole('ADMIN', 'OPS'), additionalServicesRouter);
app.use('/api/fees', requireAuth, requireRole('ADMIN', 'OPS'), feesRouter);
app.use('/api/rates', requireAuth, requireRole('ADMIN', 'OPS'), ratesRouter);
app.use('/api/rental-agreements', requireAuth, rentalAgreementsRouter);
app.use('/api/reports', requireAuth, reportsRouter);
app.use('/api/commissions', requireAuth, commissionsRouter);
app.use('/api/car-sharing', requireAuth, requireRole('ADMIN', 'OPS'), carSharingRouter);
app.use('/api/people', requireAuth, peopleRouter);
app.use('/api/settings', requireAuth, settingsRouter);
app.use('/api/tenants', requireAuth, tenantsRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Fleet backend listening on http://localhost:${port}`);
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
