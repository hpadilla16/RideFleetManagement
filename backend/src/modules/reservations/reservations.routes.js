import crypto from 'node:crypto';
import { Router } from 'express';
import { reservationsService } from './reservations.service.js';
import { validateReservationCreate, validateReservationPatch } from './reservations.rules.js';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import { rentalAgreementsService } from '../rental-agreements/rental-agreements.service.js';
import { reservationPricingService } from './reservation-pricing.service.js';
import { reservationAdditionalDriversService } from './reservation-additional-drivers.service.js';
import { settingsService } from '../settings/settings.service.js';
import { additionalServicesService } from '../additional-services/additional-services.service.js';
import { feesService } from '../fees/fees.service.js';
import { ratesService } from '../rates/rates.service.js';
import { locationsService } from '../locations/locations.service.js';
import { vehicleTypesService } from '../vehicle-types/vehicle-types.service.js';
import { activeVehicleBlockOverlapWhere } from '../vehicles/vehicle-blocks.js';
import { isSuperAdmin } from '../../middleware/auth.js';
import { crossTenantScopeFor as scopeFor } from '../../lib/tenant-scope.js';

export const reservationsRouter = Router();

function parseLocationConfig(raw) {
  try {
    if (!raw) return {};
    if (typeof raw === 'string') return JSON.parse(raw);
    if (typeof raw === 'object') return raw;
  } catch {}
  return {};
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

function buildPrecheckinChecklist(reservation) {
  const customer = reservation?.customer || {};
  const items = [
    { key: 'contact', label: 'Contact Info', done: !!(customer.firstName && customer.lastName && customer.email && customer.phone) },
    { key: 'dob', label: 'Date of Birth', done: !!customer.dateOfBirth },
    { key: 'license', label: 'Driver License', done: !!(customer.licenseNumber && customer.licenseState) },
    { key: 'address', label: 'Address', done: !!(customer.address1 && customer.city && customer.state && customer.zip) },
    { key: 'idPhoto', label: 'ID / License Photo', done: !!customer.idPhotoUrl },
    { key: 'insuranceDoc', label: 'Insurance Document', done: !!customer.insuranceDocumentUrl }
  ];
  return {
    items,
    complete: items.every((item) => item.done),
    missingItems: items.filter((item) => !item.done).map((item) => item.label)
  };
}

reservationsRouter.get('/', async (req, res, next) => {
  try {
    res.json(await reservationsService.list(scopeFor(req), { page: req.query?.page, limit: req.query?.limit }));
  } catch (e) {
    next(e);
  }
});

reservationsRouter.get('/page', async (req, res, next) => {
  try {
    res.json(await reservationsService.listPage({
      query: req.query?.q,
      limit: req.query?.limit,
      offset: req.query?.offset
    }, scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

reservationsRouter.get('/summary', async (req, res, next) => {
  try {
    res.json(await reservationsService.summary(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

reservationsRouter.get('/create-options', async (req, res, next) => {
  try {
    const tenantScope = scopeFor(req);
    const [locationsResult, vehicleTypesResult, servicesResult, feesResult, insurancePlansResult] = await Promise.allSettled([
      locationsService.list(tenantScope),
      vehicleTypesService.list(tenantScope),
      additionalServicesService.list({
        activeOnly: true,
        tenantId: tenantScope.tenantId
      }),
      feesService.list(tenantScope),
      settingsService.getInsurancePlans(tenantScope)
    ]);

    res.json({
      locations: locationsResult.status === 'fulfilled' && Array.isArray(locationsResult.value) ? locationsResult.value : [],
      vehicleTypes: vehicleTypesResult.status === 'fulfilled' && Array.isArray(vehicleTypesResult.value) ? vehicleTypesResult.value : [],
      services: servicesResult.status === 'fulfilled' && Array.isArray(servicesResult.value) ? servicesResult.value : [],
      fees: feesResult.status === 'fulfilled' && Array.isArray(feesResult.value) ? feesResult.value : [],
      insurancePlans: insurancePlansResult.status === 'fulfilled' && Array.isArray(insurancePlansResult.value) ? insurancePlansResult.value : []
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
    res.json(out);
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

reservationsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!row) return res.status(404).json({ error: 'Reservation not found' });
    res.json(row);
  } catch (e) {
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
    const reservationCharges = await prisma.reservationCharge.findMany({
      where: { reservationId: row.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
    });
    row.charges = reservationCharges;
    const [insurancePlans, additionalServices, rentalSettings] = await Promise.all([
      tenantId ? settingsService.getInsurancePlans({ tenantId }) : [],
      tenantId ? prisma.additionalService.findMany({
        where: { tenantId, isActive: true, displayOnline: true },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true, code: true, name: true, description: true, rate: true, dailyRate: true, weeklyRate: true, monthlyRate: true,
          chargeType: true, unitLabel: true, mandatory: true, taxable: true, defaultQty: true, coversTolls: true,
          displayDescription: true, displayPriority: true,
          linkedFee: { select: { id: true, name: true, amount: true, description: true, mode: true } }
        }
      }) : [],
      tenantId ? settingsService.getRentalAgreementConfig({ tenantId }) : {}
    ]);
    res.json({
      reservation: row,
      insurancePlans: (insurancePlans || []).filter(p => p.isActive !== false),
      additionalServices,
      branding: {
        companyName: rentalSettings?.companyName || 'Ride Fleet',
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

reservationsRouter.get('/:id/pricing-options', async (req, res, next) => {
  try {
    const reservation = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    const tenantScope = reservation?.tenantId ? { tenantId: reservation.tenantId } : scopeFor(req);
    const [locationsResult, servicesResult, feesResult, insurancePlansResult] = await Promise.allSettled([
      locationsService.list(tenantScope),
      additionalServicesService.list({
        locationId: reservation.pickupLocationId || undefined,
        activeOnly: true,
        tenantId: tenantScope.tenantId
      }),
      feesService.list(tenantScope),
      settingsService.getInsurancePlans(tenantScope)
    ]);
    const locations = locationsResult.status === 'fulfilled' ? locationsResult.value : [];
    const services = servicesResult.status === 'fulfilled' ? servicesResult.value : [];
    const fees = feesResult.status === 'fulfilled' ? feesResult.value : [];
    const insurancePlans = insurancePlansResult.status === 'fulfilled' ? insurancePlansResult.value : [];
    res.json({
      locations: Array.isArray(locations) ? locations : [],
      services: Array.isArray(services) ? services : [],
      fees: Array.isArray(fees) ? fees : [],
      insurancePlans: Array.isArray(insurancePlans) ? insurancePlans : []
    });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.put('/:id/pricing', async (req, res, next) => {
  try {
    if (!canManagePricingOverrides(req)) {
      return res.status(403).json({ error: 'User role not allowed to edit pricing overrides' });
    }
    const out = await reservationPricingService.replacePricing(req.params.id, req.body || {}, scopeFor(req));
    res.json(out);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    if (/role not allowed/i.test(String(e?.message || ''))) return res.status(403).json({ error: e.message });
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
    if (/amount must be > 0|invalid/i.test(String(e?.message || ''))) return res.status(400).json({ error: e.message });
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

    const out = await reservationAdditionalDriversService.replace(
      req.params.id,
      Array.isArray(req.body?.drivers) ? req.body.drivers : [],
      scopeFor(req)
    );

    if (current.rentalAgreement?.id) {
      await rentalAgreementsService.startFromReservation(req.params.id, scopeFor(req));
    }

    await prisma.auditLog.create({
      data: {
        tenantId: current.tenantId || req.user?.tenantId || null,
        reservationId: req.params.id,
        actorUserId: req.user?.sub || null,
        action: 'UPDATE',
        metadata: JSON.stringify({
          additionalDriversUpdated: true,
          count: out.length
        })
      }
    });

    res.json(out);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

reservationsRouter.get('/:id/available-vehicles', async (req, res, next) => {
  try {
    const reservation = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    const tenantScope = reservation?.tenantId ? { tenantId: reservation.tenantId } : scopeFor(req);

    try {
      const pickupAt = req.query?.pickupAt ? new Date(String(req.query.pickupAt)) : reservation.pickupAt;
      const returnAt = req.query?.returnAt ? new Date(String(req.query.returnAt)) : reservation.returnAt;

      const overlaps = await prisma.reservation.findMany({
        where: {
          ...(tenantScope.tenantId ? { tenantId: tenantScope.tenantId } : {}),
          id: { not: reservation.id },
          vehicleId: { not: null },
          status: { in: ['NEW', 'CONFIRMED', 'CHECKED_OUT'] },
          pickupAt: { lt: returnAt },
          returnAt: { gt: pickupAt }
        },
        select: { vehicleId: true }
      });

      const blockedIds = overlaps.map((x) => x.vehicleId).filter(Boolean);
      const blockedAvailability = await prisma.vehicleAvailabilityBlock.findMany({
        where: {
          ...(tenantScope.tenantId ? { tenantId: tenantScope.tenantId } : {}),
          vehicleId: { not: null },
          ...activeVehicleBlockOverlapWhere({ start: pickupAt, end: returnAt })
        },
        select: { vehicleId: true }
      });
      blockedAvailability.forEach((row) => {
        if (row?.vehicleId) blockedIds.push(row.vehicleId);
      });

      const vehicleSelect = {
        id: true, tenantId: true, internalNumber: true, vin: true, plate: true,
        make: true, model: true, year: true, color: true, mileage: true,
        status: true, fleetMode: true, vehicleTypeId: true, homeLocationId: true,
        vehicleType: { select: { id: true, name: true } },
        homeLocation: { select: { id: true, name: true, city: true, state: true } }
      };
      const vehicleOrder = [{ make: 'asc' }, { model: 'asc' }, { internalNumber: 'asc' }];
      const maxResults = 200;

      let vehicles = await prisma.vehicle.findMany({
        where: {
          ...(tenantScope.tenantId ? { tenantId: tenantScope.tenantId } : {}),
          OR: [
            reservation.vehicleId ? { id: reservation.vehicleId } : undefined,
            {
              status: 'AVAILABLE',
              id: { notIn: blockedIds.length ? blockedIds : ['__none__'] }
            }
          ].filter(Boolean)
        },
        select: vehicleSelect,
        orderBy: vehicleOrder,
        take: maxResults
      });

      if (!vehicles.length) {
        vehicles = await prisma.vehicle.findMany({
          where: {
            ...(tenantScope.tenantId ? { tenantId: tenantScope.tenantId } : {}),
            status: { notIn: ['IN_MAINTENANCE', 'OUT_OF_SERVICE'] },
            ...(reservation.vehicleTypeId ? { vehicleTypeId: reservation.vehicleTypeId } : {}),
            ...(reservation.pickupLocationId ? {
              OR: [
                { homeLocationId: reservation.pickupLocationId },
                { homeLocationId: null }
              ]
            } : {})
          },
          select: vehicleSelect,
          orderBy: vehicleOrder,
          take: maxResults
        });
      }

      if (!vehicles.length) {
        vehicles = await prisma.vehicle.findMany({
          where: {
            ...(tenantScope.tenantId ? { tenantId: tenantScope.tenantId } : {}),
            status: { notIn: ['IN_MAINTENANCE', 'OUT_OF_SERVICE'] }
          },
          select: vehicleSelect,
          orderBy: vehicleOrder,
          take: maxResults
        });
      }

      return res.json(vehicles);
    } catch (error) {
      console.error('[reservations] available-vehicles fallback activated', {
        reservationId: reservation.id,
        tenantId: tenantScope.tenantId || null,
        error: String(error?.message || error)
      });

      const fallbackVehicles = await prisma.vehicle.findMany({
        where: {
          ...(tenantScope.tenantId ? { tenantId: tenantScope.tenantId } : {}),
          status: { notIn: ['IN_MAINTENANCE', 'OUT_OF_SERVICE'] }
        },
        select: {
          id: true, tenantId: true, internalNumber: true, vin: true, plate: true,
          make: true, model: true, year: true, color: true, mileage: true,
          status: true, fleetMode: true, vehicleTypeId: true, homeLocationId: true,
          vehicleType: { select: { id: true, name: true } },
          homeLocation: { select: { id: true, name: true, city: true, state: true } }
        },
        orderBy: [{ make: 'asc' }, { model: 'asc' }, { internalNumber: 'asc' }],
        take: 200
      });
      return res.json(fallbackVehicles);
    }
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
    const finalEstimate = Number((Number(quote.baseTotal || 0) + (Number.isFinite(addOnsTotal) && addOnsTotal > 0 ? addOnsTotal : 0)).toFixed(2));

    const pickupLoc = await prisma.location.findFirst({
      where: {
        id: String(req.body.pickupLocationId),
        ...(scopeFor(req).tenantId ? { tenantId: scopeFor(req).tenantId } : {})
      },
      select: { locationConfig: true, taxRate: true }
    });
    const cfg = parseLocationConfig(pickupLoc?.locationConfig);
    const requireDeposit = !!cfg?.requireDeposit;
    const depositMode = String(cfg?.depositMode || 'FIXED').toUpperCase();
    const depositValue = Number(cfg?.depositAmount || 0);
    const basis = Array.isArray(cfg?.depositPercentBasis) && cfg.depositPercentBasis.length ? cfg.depositPercentBasis : ['rate'];
    const requireSecurityDeposit = !!cfg?.requireSecurityDeposit;
    const securityDepositAmount = requireSecurityDeposit ? Number(cfg?.securityDepositAmount || 0) : 0;
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

    const row = await reservationsService.create({
      ...(req.body || {}),
      status: requireDeposit ? 'NEW' : (req.body?.status || 'CONFIRMED'),
      paymentStatus: requireDeposit ? 'PENDING' : (req.body?.paymentStatus || 'PENDING'),
      notes,
      dailyRate: quote.dailyRate,
      estimatedTotal: finalEstimate
    }, scopeFor(req));

    await prisma.reservationPricingSnapshot.upsert({
      where: { reservationId: row.id },
      create: {
        reservationId: row.id,
        dailyRate: quote.dailyRate,
        taxRate: pickupLoc?.taxRate ?? 0,
        depositRequired: requireDeposit,
        depositMode: requireDeposit ? depositMode : null,
        depositValue: requireDeposit ? depositValue : null,
        depositBasisJson: requireDeposit ? JSON.stringify(basis) : null,
        depositAmountDue,
        securityDepositRequired: requireSecurityDeposit || securityDepositAmount > 0,
        securityDepositAmount: securityDepositAmount > 0 ? securityDepositAmount : 0,
        source: 'RESERVATION_CREATE'
      },
      update: {
        dailyRate: quote.dailyRate,
        taxRate: pickupLoc?.taxRate ?? 0,
        depositRequired: requireDeposit,
        depositMode: requireDeposit ? depositMode : null,
        depositValue: requireDeposit ? depositValue : null,
        depositBasisJson: requireDeposit ? JSON.stringify(basis) : null,
        depositAmountDue,
        securityDepositRequired: requireSecurityDeposit || securityDepositAmount > 0,
        securityDepositAmount: securityDepositAmount > 0 ? securityDepositAmount : 0,
        source: 'RESERVATION_CREATE'
      }
    });

    await prisma.auditLog.create({
      data: {
        tenantId: row.tenantId || req.user?.tenantId || null,
        reservationId: row.id,
        action: 'CREATE',
        actorUserId: req.user?.sub || null,
        toStatus: row.status,
        metadata: JSON.stringify({ reservationNumber: row.reservationNumber })
      }
    });

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

reservationsRouter.patch('/:id', async (req, res, next) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });

    const validationErrors = validateReservationPatch(current, req.body || {});
    if (validationErrors.length) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors });
    }

    const row = await reservationsService.update(req.params.id, req.body || {}, scopeFor(req), req.user?.sub || null);

    await prisma.auditLog.create({
      data: {
        tenantId: row.tenantId || req.user?.tenantId || null,
        reservationId: row.id,
        action: req.body?.status && req.body.status !== current.status ? 'STATUS_CHANGE' : 'UPDATE',
        actorUserId: req.user?.sub || null,
        fromStatus: current.status,
        toStatus: row.status,
        metadata: JSON.stringify({ patch: req.body || {} })
      }
    });

    res.json(row);
  } catch (e) {
    if (/vehicle conflict/i.test(e.message)) {
      return res.status(409).json({ error: e.message });
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
    const nextNotes = current.notes ? `${current.notes}\n${noteLine}` : noteLine;

    const row = await reservationsService.update(req.params.id, {
      status,
      notes: nextNotes
    }, scopeFor(req), req.user?.sub || null);

    await prisma.auditLog.create({
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
    });

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
    const logs = await prisma.auditLog.findMany({
      where: {
        reservationId: req.params.id,
        ...(scopeFor(req).tenantId ? { tenantId: scopeFor(req).tenantId } : {})
      },
      orderBy: { createdAt: 'desc' },
      include: { actorUser: { select: { id: true, email: true, fullName: true, role: true } } }
    });
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
    await prisma.auditLog.create({
      data: {
        tenantId: current.tenantId || req.user?.tenantId || null,
        reservationId: req.params.id,
        action: 'UPDATE',
        actorUserId: req.user?.sub || null,
        metadata: JSON.stringify({ startRental: true, agreementId: agreement.id })
      }
    });
    res.status(201).json(agreement);
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

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 2);
    const base = process.env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000';
    const link = `${base.replace(/\/$/, '')}/customer/precheckin?token=${token}`;

    const note = `[REQUEST CUSTOMER INFO ${new Date().toISOString()}] token issued`;
    const notes = current.notes ? `${current.notes}\n${note}` : note;

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

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 2);
    const base = process.env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000';
    const link = `${base.replace(/\/$/, '')}/customer/sign-agreement?token=${token}`;

    const note = `[REQUEST SIGNATURE ${new Date().toISOString()}] token issued`;
    const notes = current.notes ? `${current.notes}\n${note}` : note;

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

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 2);
    const base = process.env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000';
    const link = `${base.replace(/\/$/, '')}/customer/pay?token=${token}`;

    const note = `[REQUEST PAYMENT ${new Date().toISOString()}] token issued`;
    const notes = current.notes ? `${current.notes}\n${note}` : note;

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

    const primary = String(current.customer?.email || '').trim();
    const extras = Array.isArray(req.body?.extraEmails) ? req.body.extraEmails : [];
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
      await sendEmail({
        to: recipients.join(','),
        subject: render(subjectTpl) || `${actionLabel} - Reservation ${current.reservationNumber}`,
        text: render(bodyTpl),
        html: render(htmlTpl || String(bodyTpl || '').replaceAll('\n', '<br/>'))
      });
      const note = `[${notePrefix} ${new Date().toISOString()}] emailed to ${recipients.join(', ')}`;
      await reservationsService.update(req.params.id, { notes: current.notes ? `${current.notes}\n${note}` : note }, scopeFor(req));
      res.json({ ok: true, sentTo: recipients, link, expiresAt, emailSent: true });
    } catch (mailError) {
      const failNote = `[${notePrefix} ${new Date().toISOString()}] email failed for ${recipients.join(', ')} | ${String(mailError?.message || mailError)}`;
      await reservationsService.update(req.params.id, { notes: current.notes ? `${current.notes}\n${failNote}` : failNote }, scopeFor(req));
      await prisma.auditLog.create({
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
      });

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

reservationsRouter.post('/:id/send-detail-email', async (req, res, next) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });

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
    const text = render(tpl.reservationDetailBody || 'Hello {{customerName}},\n\nReservation #: {{reservationNumber}}');
    const html = render(tpl.reservationDetailHtml || String(text).replaceAll('\n', '<br/>'));

    await sendEmail({
      to: recipients.join(','),
      subject,
      text,
      html
    });

    const note = `[RESERVATION DETAIL EMAIL ${new Date().toISOString()}] emailed to ${recipients.join(', ')}`;
    await reservationsService.update(req.params.id, { notes: current.notes ? `${current.notes}\n${note}` : note }, scopeFor(req));

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
    await prisma.auditLog.create({
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
    });

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

    await prisma.auditLog.create({
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
    });

    res.json({
      ok: true,
      readyForPickup: ready,
      reservation: row
    });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post('/:id/precheckin/staff-complete', async (req, res, next) => {
  try {
    if (!canManagePrecheckin(req)) {
      return res.status(403).json({ error: 'Admin or ops role required' });
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
      'idPhotoUrl', 'insuranceDocumentUrl', 'insurancePolicyNumber'
    ];
    for (const key of fields) {
      if (body[key] !== undefined) {
        if (key === 'dateOfBirth' && body[key]) {
          customerUpdate[key] = new Date(body[key]);
        } else {
          customerUpdate[key] = body[key] || null;
        }
      }
    }

    if (Object.keys(customerUpdate).length) {
      await prisma.customer.update({
        where: { id: customerId },
        data: customerUpdate
      });
    }

    const now = new Date();
    const row = await reservationsService.update(req.params.id, {
      customerInfoCompletedAt: now,
      customerInfoReviewedAt: now,
      customerInfoReviewedByUserId: req.user?.sub || null,
      customerInfoReviewNote: 'Completed by staff on behalf of customer'
    }, scopeFor(req));

    await prisma.auditLog.create({
      data: {
        tenantId: row.tenantId || req.user?.tenantId || null,
        reservationId: row.id,
        action: 'ADMIN_OVERRIDE',
        actorUserId: req.user?.sub || null,
        metadata: JSON.stringify({
          staffPrecheckinComplete: true,
          completedAt: now.toISOString(),
          fieldsUpdated: Object.keys(customerUpdate)
        })
      }
    });

    res.json({ ok: true, reservation: row });
  } catch (e) {
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
    next(e);
  }
});

reservationsRouter.post('/:id/agreement/payments/charge-card-on-file', async (req, res, next) => {
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

reservationsRouter.post('/:id/agreement/security-deposit/capture', async (req, res, next) => {
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

reservationsRouter.post('/:id/agreement/security-deposit/release', async (req, res, next) => {
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

reservationsRouter.post('/:id/agreement/customer/card-on-file', async (req, res, next) => {
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
      req.ip || null
    );
    res.json(row);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    if (/required|different vehicle|checked out|assign a vehicle|conflict|available/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

reservationsRouter.post('/:id/agreement/credit', async (req, res, next) => {
  try {
    const amount = Number(req.body?.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be > 0' });
    const out = await reservationsService.adjustCustomerCredit(req.params.id, { amount, reason: req.body?.reason || 'Manual credit from reservation detail' }, req.user?.sub || null);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.delete('/:id', async (req, res) => {
  try {
    const current = await reservationsService.getById(req.params.id, scopeFor(req));
    if (!current) return res.status(404).json({ error: 'Reservation not found' });

    await prisma.auditLog.create({
      data: {
        tenantId: current.tenantId || req.user?.tenantId || null,
        reservationId: current.id,
        action: 'DELETE',
        actorUserId: req.user?.sub || null,
        fromStatus: current.status,
        metadata: JSON.stringify({ reservationNumber: current.reservationNumber })
      }
    });

    await reservationsService.remove(req.params.id, scopeFor(req));
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'Reservation not found' });
  }
});


// Reservation-native payment delete endpoint
reservationsRouter.post('/:id/payments/:paymentId/delete', async (req, res, next) => {
  try {
    const agreementId = await ensureAgreementByReservationId(req.params.id, scopeFor(req));
    if (!agreementId) return res.status(404).json({ error: 'Agreement not found for reservation' });
    const agreement = await prisma.rentalAgreement.findFirst({
      where: { id: agreementId, ...(scopeFor(req).tenantId ? { tenantId: scopeFor(req).tenantId } : {}) },
      select: { id: true, total: true }
    });
    if (!agreement) return res.status(404).json({ error: 'Agreement not found for reservation' });

    const payment = await prisma.rentalAgreementPayment.findUnique({ where: { id: req.params.paymentId } });
    if (!payment || payment.rentalAgreementId !== agreement.id) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    await prisma.rentalAgreementPayment.deleteMany({
      where: {
        rentalAgreementId: agreement.id,
        OR: [
          { reference: 'REFUND:' + req.params.paymentId },
          { notes: { contains: req.params.paymentId } }
        ]
      }
    });

    await prisma.rentalAgreementPayment.delete({ where: { id: req.params.paymentId } });

    const remaining = await prisma.rentalAgreementPayment.findMany({
      where: { rentalAgreementId: agreement.id },
      select: { amount: true, status: true }
    });
    const paidAmount = Number(remaining.filter((x) => String(x.status || '').toUpperCase() !== 'VOIDED').reduce((sum, x) => sum + Number(x.amount || 0), 0).toFixed(2));
    const balance = Number((Number(agreement.total || 0) - paidAmount).toFixed(2));

    await prisma.rentalAgreement.update({ where: { id: agreement.id }, data: { paidAmount, balance } });
    res.json({ ok: true, paidAmount, balance });
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/foreign key|constraint/i.test(e.message)) return res.status(400).json({ error: 'Payment cannot be deleted due to linked records' });
    next(e);
  }
});

reservationsRouter.post('/:id/payments/:paymentId/refund', async (req, res, next) => {
  try {
    const agreementId = await ensureAgreementByReservationId(req.params.id, scopeFor(req));
    if (!agreementId) return res.status(404).json({ error: 'Agreement not found for reservation' });
    const row = await rentalAgreementsService.refundPayment(agreementId, req.params.paymentId, req.body || {}, req.user?.id || null);
    res.json(row);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/cannot|invalid|already|amount/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

reservationsRouter.post('/:id/payments/:paymentId/save-card-on-file', async (req, res, next) => {
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

reservationsRouter.post('/:id/payments/reconcile-authorizenet', async (req, res, next) => {
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

reservationsRouter.post('/:id/payments/charge-card-on-file', async (req, res, next) => {
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



