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

assertAuthConfig();

const app = express();
app.use(cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:3000'] }));
app.use(express.json({ limit: '12mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'fleet-management-backend' });
});

app.use('/api/auth', authRouter);
app.use('/api/public', customerPortalRouter);

app.use('/api/reservations', requireAuth, reservationsRouter);
app.use('/api/customers', requireAuth, customersRouter);
app.use('/api/vehicles', requireAuth, vehiclesRouter);
app.use('/api/locations', requireAuth, requireRole('ADMIN', 'OPS'), locationsRouter);
app.use('/api/vehicle-types', requireAuth, requireRole('ADMIN', 'OPS'), vehicleTypesRouter);
app.use('/api/additional-services', requireAuth, requireRole('ADMIN', 'OPS'), additionalServicesRouter);
app.use('/api/fees', requireAuth, requireRole('ADMIN', 'OPS'), feesRouter);
app.use('/api/rates', requireAuth, requireRole('ADMIN', 'OPS'), ratesRouter);
app.use('/api/rental-agreements', requireAuth, rentalAgreementsRouter);
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
