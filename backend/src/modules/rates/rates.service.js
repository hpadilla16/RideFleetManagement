import { prisma } from '../../lib/prisma.js';
import { settingsService } from '../settings/settings.service.js';

const RATE_INCLUDE = {
  location: true,
  rateItems: {
    orderBy: { sortOrder: 'asc' }
  },
  dailyPrices: {
    orderBy: [{ date: 'asc' }, { vehicleTypeId: 'asc' }],
    include: {
      vehicleType: {
        select: {
          id: true,
          code: true,
          name: true
        }
      }
    }
  }
};

function dayFlagFromDate(dt) {
  const d = new Date(dt).getDay(); // 0 Sun ... 6 Sat
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d];
}

function parseLocationConfig(raw) {
  try {
    if (!raw) return {};
    if (typeof raw === 'string') return JSON.parse(raw);
    if (typeof raw === 'object') return raw;
  } catch {}
  return {};
}

function rentalDays(pickupAt, returnAt, minChargeDays = 1, gracePeriodMin = 0) {
  const ms = new Date(returnAt) - new Date(pickupAt);
  const totalMinutes = Math.max(0, Math.floor(ms / (1000 * 60)));

  const fullDays = Math.floor(totalMinutes / 1440);
  const remainderMin = totalMinutes % 1440;

  let days = fullDays;
  if (remainderMin > 0) {
    days += remainderMin <= Number(gracePeriodMin || 0) ? 0 : 1;
  }

  days = Math.max(1, days);
  return Math.max(days, Number(minChargeDays || 1));
}

function startOfUtcDay(value) {
  const dt = new Date(value);
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
}

function dayKey(value) {
  return startOfUtcDay(value).toISOString().slice(0, 10);
}

function parseDynamicPriceDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const usMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, monthRaw, dayRaw, yearRaw] = usMatch;
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    const year = Number(yearRaw);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const parsed = new Date(Date.UTC(year, month - 1, day));
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : startOfUtcDay(fallback);
}

function buildChargeDates(pickupAt, days) {
  const start = startOfUtcDay(pickupAt);
  return Array.from({ length: Number(days || 0) }, (_, idx) => new Date(start.getTime() + idx * 86400000));
}

function addUtcDays(value, days) {
  return new Date(startOfUtcDay(value).getTime() + (Number(days || 0) * 86400000));
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function dayDiffFromNow(dateValue) {
  const diffMs = new Date(dateValue).getTime() - Date.now();
  return diffMs / 86400000;
}

function intervalOverlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function isWeekendDate(value) {
  const day = new Date(value).getUTCDay();
  return day === 0 || day === 6;
}

export function classifyRevenuePressure({ utilizationPct = 0, shortageUnits = 0 } = {}, revenueConfig = {}) {
  if (Number(shortageUnits || 0) > 0) {
    return {
      code: 'SHORTAGE',
      label: 'Fleet shortage',
      markupPct: Number(revenueConfig?.shortageMarkupPct || 0),
      pressureBand: 'SHORTAGE'
    };
  }
  if (Number(utilizationPct || 0) >= Number(revenueConfig?.utilizationCriticalThresholdPct || 0)) {
    return {
      code: 'UTILIZATION_CRITICAL',
      label: 'Critical utilization',
      markupPct: Number(revenueConfig?.utilizationCriticalMarkupPct || 0),
      pressureBand: 'CRITICAL'
    };
  }
  if (Number(utilizationPct || 0) >= Number(revenueConfig?.utilizationHighThresholdPct || 0)) {
    return {
      code: 'UTILIZATION_HIGH',
      label: 'High utilization',
      markupPct: Number(revenueConfig?.utilizationHighMarkupPct || 0),
      pressureBand: 'HIGH'
    };
  }
  if (Number(utilizationPct || 0) >= Number(revenueConfig?.utilizationMediumThresholdPct || 0)) {
    return {
      code: 'UTILIZATION_MEDIUM',
      label: 'Medium utilization',
      markupPct: Number(revenueConfig?.utilizationMediumMarkupPct || 0),
      pressureBand: 'MEDIUM'
    };
  }
  return {
    code: 'NORMAL',
    label: 'Normal demand',
    markupPct: 0,
    pressureBand: 'NORMAL'
  };
}

export function buildDailyDemandSignals({ chargeDates = [], reservations = [], fleetCount = 0, revenueConfig = {} } = {}) {
  const normalizedFleetCount = Math.max(0, Number(fleetCount || 0));
  const rows = Array.isArray(reservations) ? reservations : [];
  return chargeDates.map((chargeDate) => {
    const dayStart = startOfUtcDay(chargeDate);
    const dayEnd = addUtcDays(dayStart, 1);
    const demandCount = rows.reduce((sum, reservation) => {
      const pickup = new Date(reservation?.pickupAt);
      const ret = new Date(reservation?.returnAt);
      if (Number.isNaN(pickup.getTime()) || Number.isNaN(ret.getTime())) return sum;
      return sum + (intervalOverlaps(pickup, ret, dayStart, dayEnd) ? 1 : 0);
    }, 0);
    const availableUnits = Math.max(0, normalizedFleetCount - demandCount);
    const shortageUnits = Math.max(0, demandCount - normalizedFleetCount);
    const utilizationPct = normalizedFleetCount > 0 ? roundMoney((demandCount / normalizedFleetCount) * 100) : 0;
    const pressure = classifyRevenuePressure({ utilizationPct, shortageUnits }, revenueConfig);
    return {
      date: dayKey(dayStart),
      weekend: isWeekendDate(dayStart),
      demandCount,
      availableUnits,
      shortageUnits,
      utilizationPct,
      pressureBand: pressure.pressureBand,
      pressureCode: pressure.code,
      pressureMarkupPct: roundMoney(pressure.markupPct)
    };
  });
}

export function summarizeDailyDemandSignals(dailySignals = [], { fleetCount = 0, overlappingDemandCount = 0 } = {}) {
  const rows = Array.isArray(dailySignals) ? dailySignals : [];
  const peakSignal = rows.reduce((best, current) => {
    if (!best) return current;
    if (Number(current.shortageUnits || 0) > Number(best.shortageUnits || 0)) return current;
    if (Number(current.utilizationPct || 0) > Number(best.utilizationPct || 0)) return current;
    return best;
  }, null);
  const totalDemand = rows.reduce((sum, row) => sum + Number(row.demandCount || 0), 0);
  const totalAvailable = rows.reduce((sum, row) => sum + Number(row.availableUnits || 0), 0);
  const averageDemandCount = rows.length ? roundMoney(totalDemand / rows.length) : 0;
  const averageAvailableUnits = rows.length ? roundMoney(totalAvailable / rows.length) : Math.max(0, Number(fleetCount || 0));
  const averageUtilizationPct = rows.length ? roundMoney(rows.reduce((sum, row) => sum + Number(row.utilizationPct || 0), 0) / rows.length) : 0;
  const pressureDaysCount = rows.filter((row) => String(row.pressureBand || 'NORMAL') !== 'NORMAL').length;
  return {
    overlappingDemandCount: Number(overlappingDemandCount || 0),
    availableUnits: Math.max(0, Number(fleetCount || 0) - Number(overlappingDemandCount || 0)),
    utilizationPct: peakSignal ? Number(peakSignal.utilizationPct || 0) : 0,
    shortageUnits: peakSignal ? Number(peakSignal.shortageUnits || 0) : 0,
    averageDemandCount,
    averageAvailableUnits,
    averageUtilizationPct,
    peakDemandCount: peakSignal ? Number(peakSignal.demandCount || 0) : 0,
    peakAvailableUnits: peakSignal ? Number(peakSignal.availableUnits || 0) : Math.max(0, Number(fleetCount || 0)),
    peakUtilizationPct: peakSignal ? Number(peakSignal.utilizationPct || 0) : 0,
    peakShortageUnits: peakSignal ? Number(peakSignal.shortageUnits || 0) : 0,
    peakPressureDate: peakSignal?.date || null,
    peakPressureBand: peakSignal?.pressureBand || 'NORMAL',
    pressureDaysCount
  };
}

export function buildRevenueDailyRecommendations({
  baseDailyBreakdown = [],
  dailySignals = [],
  revenueConfig = {},
  leadTimeDays = 0,
  weekendPickup = false
} = {}) {
  const leadAdjustmentPct = leadTimeDays <= Number(revenueConfig?.lastMinuteWindowDays || 0) && Number(revenueConfig?.lastMinuteMarkupPct || 0) > 0
    ? Number(revenueConfig.lastMinuteMarkupPct || 0)
    : leadTimeDays <= Number(revenueConfig?.shortLeadWindowDays || 0) && Number(revenueConfig?.shortLeadMarkupPct || 0) > 0
      ? Number(revenueConfig.shortLeadMarkupPct || 0)
      : 0;
  const weekendAdjustmentPct = weekendPickup && Number(revenueConfig?.weekendMarkupPct || 0) > 0
    ? Number(revenueConfig.weekendMarkupPct || 0)
    : 0;

  const recommendedDailyBreakdown = (Array.isArray(baseDailyBreakdown) ? baseDailyBreakdown : []).map((row) => {
    const signal = (Array.isArray(dailySignals) ? dailySignals : []).find((entry) => entry.date === row.date) || null;
    const pressure = classifyRevenuePressure({
      utilizationPct: signal?.utilizationPct || 0,
      shortageUnits: signal?.shortageUnits || 0
    }, revenueConfig);
    const pressureAdjustmentPct = roundMoney(pressure.markupPct || 0);
    const adjustmentPct = Math.min(
      Number(revenueConfig?.maxAdjustmentPct || 0),
      roundMoney(leadAdjustmentPct + weekendAdjustmentPct + pressureAdjustmentPct)
    );
    return {
      date: row.date,
      baseDailyRate: roundMoney(row.dailyRate),
      recommendedDailyRate: roundMoney(Number(row.dailyRate || 0) * (1 + (adjustmentPct / 100))),
      adjustmentPct,
      leadAdjustmentPct: roundMoney(leadAdjustmentPct),
      weekendAdjustmentPct: roundMoney(weekendAdjustmentPct),
      pressureAdjustmentPct,
      pressureBand: signal?.pressureBand || 'NORMAL',
      demandCount: Number(signal?.demandCount || 0),
      availableUnits: Number(signal?.availableUnits || 0),
      shortageUnits: Number(signal?.shortageUnits || 0),
      utilizationPct: Number(signal?.utilizationPct || 0)
    };
  });

  const recommendedBaseTotal = roundMoney(recommendedDailyBreakdown.reduce((sum, row) => sum + Number(row.recommendedDailyRate || 0), 0));
  const recommendedDailyRate = roundMoney(
    recommendedDailyBreakdown.length ? recommendedBaseTotal / recommendedDailyBreakdown.length : 0
  );

  return {
    leadAdjustmentPct: roundMoney(leadAdjustmentPct),
    weekendAdjustmentPct: roundMoney(weekendAdjustmentPct),
    recommendedDailyBreakdown,
    recommendedBaseTotal,
    recommendedDailyRate
  };
}

async function getRateForScope(id, scope = {}) {
  return prisma.rate.findFirst({
    where: {
      id,
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
    },
    include: RATE_INCLUDE
  });
}

async function normalizeDailyPriceRows(rateId, rows = [], scope = {}) {
  const rate = await prisma.rate.findFirst({
    where: {
      id: rateId,
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
    },
    select: {
      id: true,
      tenantId: true,
      rateCode: true
    }
  });
  if (!rate) {
    throw new Error('Rate not found');
  }

  const vehicleTypes = await prisma.vehicleType.findMany({
    where: {
      ...(rate.tenantId ? { tenantId: rate.tenantId } : {}),
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
    },
    select: {
      id: true,
      code: true,
      name: true
    }
  });

  const vehicleTypeMap = new Map(vehicleTypes.map((row) => [String(row.code || '').trim().toUpperCase(), row]));
  const errors = [];
  const normalized = [];
  const dedupe = new Map();

  rows.forEach((raw, index) => {
    const line = index + 2;
    const dateRaw = String(raw?.date || raw?.Date || '').trim();
    const vehicleTypeCodeRaw = String(raw?.vehicleTypeCode || raw?.vehicle_type_code || raw?.vehicleType || '').trim().toUpperCase();
    const dailyRateRaw = String(raw?.dailyRate || raw?.daily || raw?.rate || '').trim();

    if (!dateRaw && !vehicleTypeCodeRaw && !dailyRateRaw) return;

    if (!dateRaw) {
      errors.push({ line, field: 'date', message: 'Date is required' });
      return;
    }
    if (!vehicleTypeCodeRaw) {
      errors.push({ line, field: 'vehicleTypeCode', message: 'Vehicle type code is required' });
      return;
    }
    const vehicleType = vehicleTypeMap.get(vehicleTypeCodeRaw);
    if (!vehicleType) {
      errors.push({ line, field: 'vehicleTypeCode', message: `Vehicle type code ${vehicleTypeCodeRaw} was not found in this tenant` });
      return;
    }

    const parsedDate = parseDynamicPriceDate(dateRaw);
    if (!parsedDate) {
      errors.push({ line, field: 'date', message: `Invalid date ${dateRaw}. Use YYYY-MM-DD or MM/DD/YYYY.` });
      return;
    }

    const daily = Number(dailyRateRaw);
    if (!Number.isFinite(daily) || daily < 0) {
      errors.push({ line, field: 'dailyRate', message: `Invalid daily rate ${dailyRateRaw}` });
      return;
    }

    const key = `${vehicleType.id}|${dayKey(parsedDate)}`;
    const row = {
      date: startOfUtcDay(parsedDate),
      dateKey: dayKey(parsedDate),
      vehicleTypeId: vehicleType.id,
      vehicleTypeCode: vehicleType.code,
      vehicleTypeName: vehicleType.name,
      daily: Number(daily.toFixed(2))
    };
    dedupe.set(key, row);
  });

  normalized.push(...dedupe.values());
  normalized.sort((a, b) => {
    if (a.dateKey === b.dateKey) return String(a.vehicleTypeCode).localeCompare(String(b.vehicleTypeCode));
    return a.dateKey.localeCompare(b.dateKey);
  });

  return {
    rate,
    rows: normalized,
    errors,
    totalRows: rows.length,
    validCount: normalized.length,
    errorCount: errors.length
  };
}

export const ratesService = {
  list({ query } = {}, scope = {}) {
    return prisma.rate.findMany({
      where: {
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
        ...(query
          ? {
              OR: [
                { rateCode: { contains: query, mode: 'insensitive' } },
                { name: { contains: query, mode: 'insensitive' } }
              ]
            }
          : {})
      },
      include: RATE_INCLUDE,
      orderBy: [{ createdAt: 'desc' }]
    });
  },

  async create(data, scope = {}) {
    const { rateItems = [], ...header } = data || {};
    const created = await prisma.rate.create({
      data: {
        tenantId: scope?.tenantId || header.tenantId || null,
        rateCode: header.rateCode,
        name: header.name ?? null,
        locationId: header.locationId || null,
        locationIds: Array.isArray(header.locationIds) ? JSON.stringify(header.locationIds) : (header.locationIds ?? null),
        rateType: header.rateType ?? 'MULTIPLE_CLASSES',
        calculationBy: header.calculationBy ?? '24_HOUR_TIME',
        averageBy: header.averageBy ?? 'DATE_RANGE',
        daily: header.daily ?? 0,
        fuelChargePerGallon: header.fuelChargePerGallon ?? null,
        minChargeDays: header.minChargeDays ?? null,
        minChargeHours: header.minChargeHours ?? null,
        grossFlatNumber: header.grossFlatNumber ?? null,
        extraMileCharge: header.extraMileCharge ?? null,
        graceMinutes: header.graceMinutes ?? null,
        useHourlyRates: header.useHourlyRates ?? false,
        active: header.active ?? true,
        displayOnline: header.displayOnline ?? false,
        variesPricing: header.variesPricing ?? false,
        sameSpecialRates: header.sameSpecialRates ?? false,
        rencarscom: header.rencarscom ?? false,
        monday: header.monday ?? true,
        tuesday: header.tuesday ?? true,
        wednesday: header.wednesday ?? true,
        thursday: header.thursday ?? true,
        friday: header.friday ?? true,
        saturday: header.saturday ?? true,
        sunday: header.sunday ?? true,
        effectiveDate: header.effectiveDate ? new Date(header.effectiveDate) : null,
        endDate: header.endDate ? new Date(header.endDate) : null,
        isActive: header.isActive ?? true
      }
    });

    if (Array.isArray(rateItems) && rateItems.length) {
      await prisma.rateItem.createMany({
        data: rateItems.map((x, idx) => ({
          rateId: created.id,
          vehicleTypeId: x.vehicleTypeId,
          hourly: x.hourly ?? 0,
          daily: x.daily ?? 0,
          extraDaily: x.extraDaily ?? 0,
          weekly: x.weekly ?? 0,
          monthly: x.monthly ?? 0,
          minHourly: x.minHourly ?? 0,
          minDaily: x.minDaily ?? 0,
          minWeekly: x.minWeekly ?? 0,
          minMonthly: x.minMonthly ?? 0,
          extraMileCharge: x.extraMileCharge ?? 0,
          sortOrder: x.sortOrder ?? idx
        }))
      });
    }

    return prisma.rate.findUnique({ where: { id: created.id }, include: RATE_INCLUDE });
  },

  async resolveForRental({ vehicleTypeId, pickupLocationId, pickupAt, returnAt }, scope = {}, options = {}) {
    if (!vehicleTypeId || !pickupAt || !returnAt) return null;

    const pickup = new Date(pickupAt);
    const ret = new Date(returnAt);
    if (!(pickup instanceof Date) || Number.isNaN(pickup.getTime())) return null;
    if (!(ret instanceof Date) || Number.isNaN(ret.getTime())) return null;
    if (ret <= pickup) return null;

    const dayFlag = dayFlagFromDate(pickup);

    let gracePeriodMin = 0;
    if (pickupLocationId) {
      const location = await prisma.location.findFirst({ where: { id: pickupLocationId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { locationConfig: true } });
      const cfg = parseLocationConfig(location?.locationConfig);
      gracePeriodMin = Number(cfg?.gracePeriodMin || 0);
    }

    const candidates = await prisma.rate.findMany({
      where: {
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
        ...(options?.displayOnline ? { displayOnline: true } : {}),
        isActive: true,
        active: true,
        [dayFlag]: true,
        AND: [
          {
            OR: [
              { locationId: pickupLocationId || null },
              { locationId: null }
            ]
          },
          {
            OR: [
              { effectiveDate: null },
              { effectiveDate: { lte: pickup } }
            ]
          },
          {
            OR: [
              { endDate: null },
              { endDate: { gte: pickup } }
            ]
          }
        ]
      },
      include: {
        rateItems: {
          where: { vehicleTypeId },
          take: 1
        },
        dailyPrices: {
          where: {
            vehicleTypeId
          },
          orderBy: { date: 'asc' }
        }
      },
      orderBy: [
        { locationId: 'desc' },
        { effectiveDate: 'desc' },
        { createdAt: 'desc' }
      ]
    });

    const scoped = candidates.filter((r) => {
      if (!pickupLocationId) return true;
      if (r.locationId && r.locationId === pickupLocationId) return true;
      if (!r.locationIds) return !r.locationId;
      try {
        const ids = JSON.parse(r.locationIds);
        if (Array.isArray(ids)) {
          return ids.length ? ids.includes(pickupLocationId) : !r.locationId;
        }
        return !r.locationId;
      } catch {
        return !r.locationId;
      }
    });

    const chosen = scoped.find((r) => (r.rateItems || []).length > 0) || scoped[0] || null;
    if (!chosen) return null;

    const item = (chosen.rateItems || [])[0] || null;
    const days = rentalDays(pickup, ret, chosen.minChargeDays, gracePeriodMin);
    const baseDailyRate = Number(item?.daily ?? chosen.daily ?? 0);
    const chargeDates = buildChargeDates(pickup, days);
    const overrideMap = new Map(
      (chosen.dailyPrices || []).map((row) => [dayKey(row.date), Number(row.daily || 0)])
    );
    const dynamicBreakdown = chargeDates.map((date) => {
      const dateKey = dayKey(date);
      const daily = chosen.sameSpecialRates && overrideMap.has(dateKey)
        ? Number(overrideMap.get(dateKey) || 0)
        : baseDailyRate;
      return {
        date: dateKey,
        dailyRate: Number(daily.toFixed(2)),
        overridden: chosen.sameSpecialRates && overrideMap.has(dateKey)
      };
    });
    const baseTotal = Number(dynamicBreakdown.reduce((sum, row) => sum + Number(row.dailyRate || 0), 0).toFixed(2));
    const dailyRate = Number((days > 0 ? baseTotal / days : 0).toFixed(2));

    return {
      rateId: chosen.id,
      rateCode: chosen.rateCode,
      dailyRate,
      baseDailyRate,
      days,
      baseTotal,
      dynamicPricingApplied: dynamicBreakdown.some((row) => row.overridden),
      dailyBreakdown: dynamicBreakdown,
      gracePeriodMin,
      source: chosen.locationId ? 'LOCATION' : 'GLOBAL'
    };
  },

  async getRevenueRecommendation({ vehicleTypeId, pickupLocationId, pickupAt, returnAt }, scope = {}, options = {}) {
    const baseQuote = await this.resolveForRental(
      { vehicleTypeId, pickupLocationId, pickupAt, returnAt },
      scope,
      { displayOnline: !!options?.displayOnline }
    );
    if (!baseQuote) return null;

    const revenueConfig = await settingsService.getRevenuePricingConfig(scope).catch(() => null);
    if (!revenueConfig?.enabled) {
      const chargeDates = buildChargeDates(pickupAt, Number(baseQuote.days || 0));
      return {
        enabled: false,
        baseQuote,
        recommendedDailyBreakdown: (baseQuote.dailyBreakdown || []).map((row) => ({
          date: row.date,
          baseDailyRate: Number(row.dailyRate || 0),
          recommendedDailyRate: Number(row.dailyRate || 0),
          adjustmentPct: 0,
          leadAdjustmentPct: 0,
          weekendAdjustmentPct: 0,
          pressureAdjustmentPct: 0,
          pressureBand: 'NORMAL'
        })),
        recommendedDailyRate: baseQuote.dailyRate,
        recommendedBaseTotal: baseQuote.baseTotal,
        adjustmentPct: 0,
        factors: [],
        metrics: {
          leadTimeDays: roundMoney(dayDiffFromNow(pickupAt)),
          weekendPickup: [0, 5, 6].includes(new Date(pickupAt).getDay()),
          tripDays: chargeDates.length,
          fleetCount: 0,
          overlappingDemandCount: 0,
          availableUnits: 0,
          utilizationPct: 0,
          shortageUnits: 0,
          averageDemandCount: 0,
          averageAvailableUnits: 0,
          averageUtilizationPct: 0,
          peakDemandCount: 0,
          peakAvailableUnits: 0,
          peakUtilizationPct: 0,
          peakShortageUnits: 0,
          peakPressureDate: null,
          peakPressureBand: 'NORMAL',
          pressureDaysCount: 0,
          dailySignals: []
        },
        summary: 'Revenue pricing is disabled for this tenant, so the base rate remains unchanged.'
      };
    }

    const [fleetCount, overlappingReservations] = await Promise.all([
      prisma.vehicle.count({
        where: {
          ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
          ...(vehicleTypeId ? { vehicleTypeId } : {}),
          ...(pickupLocationId ? { homeLocationId: pickupLocationId } : {}),
          isActive: true
        }
      }),
      prisma.reservation.findMany({
        where: {
          ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
          ...(vehicleTypeId ? { vehicleTypeId } : {}),
          ...(pickupLocationId ? { pickupLocationId } : {}),
          status: { notIn: ['CANCELLED', 'NO_SHOW'] },
          pickupAt: { lt: new Date(returnAt) },
          returnAt: { gt: new Date(pickupAt) }
        },
        select: {
          id: true,
          pickupAt: true,
          returnAt: true
        }
      })
    ]);

    const overlappingDemandCount = overlappingReservations.length;
    const chargeDates = buildChargeDates(pickupAt, Number(baseQuote.days || 0));
    const dailySignals = buildDailyDemandSignals({
      chargeDates,
      reservations: overlappingReservations,
      fleetCount,
      revenueConfig
    });
    const demandSummary = summarizeDailyDemandSignals(dailySignals, {
      fleetCount,
      overlappingDemandCount
    });
    const leadTimeDays = roundMoney(dayDiffFromNow(pickupAt));
    const weekendPickup = [0, 5, 6].includes(new Date(pickupAt).getDay());
    const factors = [];

    if (weekendPickup && revenueConfig.weekendMarkupPct > 0) {
      factors.push({
        code: 'WEEKEND',
        label: 'Weekend demand',
        adjustmentPct: revenueConfig.weekendMarkupPct,
        reason: 'Pickup lands on a higher-demand weekend day.'
      });
    }

    if (leadTimeDays <= revenueConfig.lastMinuteWindowDays && revenueConfig.lastMinuteMarkupPct > 0) {
      factors.push({
        code: 'LAST_MINUTE',
        label: 'Last-minute lead time',
        adjustmentPct: revenueConfig.lastMinuteMarkupPct,
        reason: `Pickup is within ${revenueConfig.lastMinuteWindowDays} day(s).`
      });
    } else if (leadTimeDays <= revenueConfig.shortLeadWindowDays && revenueConfig.shortLeadMarkupPct > 0) {
      factors.push({
        code: 'SHORT_LEAD',
        label: 'Short lead time',
        adjustmentPct: revenueConfig.shortLeadMarkupPct,
        reason: `Pickup is within ${revenueConfig.shortLeadWindowDays} day(s).`
      });
    }

    const peakPressure = classifyRevenuePressure({
      utilizationPct: demandSummary.peakUtilizationPct,
      shortageUnits: demandSummary.peakShortageUnits
    }, revenueConfig);
    if (peakPressure.code !== 'NORMAL' && peakPressure.markupPct > 0) {
      factors.push({
        code: peakPressure.code,
        label: peakPressure.label,
        adjustmentPct: roundMoney(peakPressure.markupPct),
        reason: peakPressure.code === 'SHORTAGE'
          ? `Peak shortage hits ${demandSummary.peakShortageUnits} unit(s) on ${demandSummary.peakPressureDate || 'the busiest day'} across ${demandSummary.pressureDaysCount} pressured day(s).`
          : `Peak utilization reaches ${demandSummary.peakUtilizationPct.toFixed(2)}% on ${demandSummary.peakPressureDate || 'the busiest day'} across ${demandSummary.pressureDaysCount} pressured day(s).`
      });
    }

    const pricingPlan = buildRevenueDailyRecommendations({
      baseDailyBreakdown: baseQuote.dailyBreakdown || [],
      dailySignals,
      revenueConfig,
      leadTimeDays,
      weekendPickup
    });
    const recommendedDailyBreakdown = pricingPlan.recommendedDailyBreakdown;
    const recommendedBaseTotal = pricingPlan.recommendedBaseTotal;
    const recommendedDailyRate = pricingPlan.recommendedDailyRate || baseQuote.dailyRate;
    const adjustmentPct = baseQuote.baseTotal > 0
      ? roundMoney(((recommendedBaseTotal - Number(baseQuote.baseTotal || 0)) / Number(baseQuote.baseTotal || 0)) * 100)
      : 0;

    return {
      enabled: true,
      recommendationMode: revenueConfig.recommendationMode,
      applyToPublicQuotes: !!revenueConfig.applyToPublicQuotes,
      baseQuote,
      recommendedDailyBreakdown,
      recommendedDailyRate,
      recommendedBaseTotal,
      adjustmentPct,
      factors,
      metrics: {
        leadTimeDays,
        weekendPickup,
        tripDays: chargeDates.length,
        fleetCount,
        ...demandSummary,
        dailySignals
      },
      summary: factors.length
        ? `Recommended +${adjustmentPct.toFixed(2)}% versus base rate using date-aware demand pressure, lead-time, and class/location signals.`
        : 'No dynamic pricing uplift is recommended for this request.'
    };
  },

  async update(id, patch, scope = {}) {
    const current = await prisma.rate.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) return null;
    const { rateItems, ...header } = patch || {};
    delete header.tenantId;

    if (header && Object.keys(header).length) {
      const data = {};
      const assign = (key, value) => { if (Object.prototype.hasOwnProperty.call(header, key)) data[key] = value; };

      assign('rateCode', header.rateCode);
      assign('name', header.name ?? null);
      if (Object.prototype.hasOwnProperty.call(header, 'locationIds')) {
        data.locationIds = Array.isArray(header.locationIds) ? JSON.stringify(header.locationIds) : (header.locationIds ?? null);
      }
      assign('rateType', header.rateType);
      assign('calculationBy', header.calculationBy);
      assign('averageBy', header.averageBy);
      assign('daily', header.daily);
      assign('fuelChargePerGallon', header.fuelChargePerGallon);
      assign('minChargeDays', header.minChargeDays);
      assign('minChargeHours', header.minChargeHours);
      assign('grossFlatNumber', header.grossFlatNumber);
      assign('extraMileCharge', header.extraMileCharge);
      assign('graceMinutes', header.graceMinutes);
      assign('useHourlyRates', header.useHourlyRates);
      assign('active', header.active);
      assign('displayOnline', header.displayOnline);
      assign('variesPricing', header.variesPricing);
      assign('sameSpecialRates', header.sameSpecialRates);
      assign('rencarscom', header.rencarscom);
      assign('monday', header.monday);
      assign('tuesday', header.tuesday);
      assign('wednesday', header.wednesday);
      assign('thursday', header.thursday);
      assign('friday', header.friday);
      assign('saturday', header.saturday);
      assign('sunday', header.sunday);
      assign('isActive', header.isActive);

      if (Object.prototype.hasOwnProperty.call(header, 'locationId')) data.locationId = header.locationId === '' ? null : header.locationId;
      if (Object.prototype.hasOwnProperty.call(header, 'effectiveDate')) data.effectiveDate = header.effectiveDate ? new Date(header.effectiveDate) : null;
      if (Object.prototype.hasOwnProperty.call(header, 'endDate')) data.endDate = header.endDate ? new Date(header.endDate) : null;

      await prisma.rate.update({ where: { id }, data });
    }

    if (Array.isArray(rateItems)) {
      await prisma.rateItem.deleteMany({ where: { rateId: id } });
      if (rateItems.length) {
        await prisma.rateItem.createMany({
          data: rateItems.map((x, idx) => ({
            rateId: id,
            vehicleTypeId: x.vehicleTypeId,
            hourly: x.hourly ?? 0,
            daily: x.daily ?? 0,
            extraDaily: x.extraDaily ?? 0,
            weekly: x.weekly ?? 0,
            monthly: x.monthly ?? 0,
            minHourly: x.minHourly ?? 0,
            minDaily: x.minDaily ?? 0,
            minWeekly: x.minWeekly ?? 0,
            minMonthly: x.minMonthly ?? 0,
            extraMileCharge: x.extraMileCharge ?? 0,
            sortOrder: x.sortOrder ?? idx
          }))
        });
      }
    }

    return prisma.rate.findUnique({ where: { id }, include: RATE_INCLUDE });
  },

  async remove(id, scope = {}) {
    const current = await prisma.rate.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Rate not found');
    return prisma.rate.delete({ where: { id } });
  },

  async validateDailyPrices(rateId, rows = [], scope = {}) {
    const report = await normalizeDailyPriceRows(rateId, rows, scope);
    return {
      rateId: report.rate.id,
      rateCode: report.rate.rateCode,
      totalRows: report.totalRows,
      validCount: report.validCount,
      errorCount: report.errorCount,
      rows: report.rows,
      errors: report.errors
    };
  },

  async importDailyPrices(rateId, rows = [], scope = {}) {
    const report = await normalizeDailyPriceRows(rateId, rows, scope);
    if (!report.rows.length) {
      return {
        imported: 0,
        rate: await getRateForScope(rateId, scope),
        errors: report.errors
      };
    }

    await prisma.$transaction(async (tx) => {
      await tx.rate.update({
        where: { id: rateId },
        data: {
          sameSpecialRates: true,
          variesPricing: true
        }
      });

      for (const row of report.rows) {
        await tx.rateDailyPrice.upsert({
          where: {
            rateId_vehicleTypeId_date: {
              rateId,
              vehicleTypeId: row.vehicleTypeId,
              date: row.date
            }
          },
          update: {
            daily: row.daily
          },
          create: {
            rateId,
            vehicleTypeId: row.vehicleTypeId,
            date: row.date,
            daily: row.daily
          }
        });
      }
    });

    return {
      imported: report.rows.length,
      errors: report.errors,
      rate: await getRateForScope(rateId, scope)
    };
  },

  async removeDailyPrice(rateId, dailyPriceId, scope = {}) {
    const rate = await prisma.rate.findFirst({
      where: {
        id: rateId,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      },
      select: { id: true }
    });
    if (!rate) throw new Error('Rate not found');

    const current = await prisma.rateDailyPrice.findFirst({
      where: {
        id: dailyPriceId,
        rateId
      },
      select: { id: true }
    });
    if (!current) throw new Error('Daily price not found');

    await prisma.rateDailyPrice.delete({
      where: { id: dailyPriceId }
    });

    return getRateForScope(rateId, scope);
  }
};
