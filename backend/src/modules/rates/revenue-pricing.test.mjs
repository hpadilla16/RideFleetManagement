import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDailyDemandSignals,
  summarizeDailyDemandSignals,
  buildRevenueDailyRecommendations
} from './rates.service.js';

const REVENUE_CONFIG = {
  weekendMarkupPct: 5,
  shortLeadWindowDays: 7,
  shortLeadMarkupPct: 10,
  lastMinuteWindowDays: 2,
  lastMinuteMarkupPct: 18,
  utilizationMediumThresholdPct: 70,
  utilizationMediumMarkupPct: 5,
  utilizationHighThresholdPct: 85,
  utilizationHighMarkupPct: 10,
  utilizationCriticalThresholdPct: 95,
  utilizationCriticalMarkupPct: 18,
  shortageMarkupPct: 12,
  maxAdjustmentPct: 25
};

test('buildDailyDemandSignals calculates date-level pressure by class/location window', () => {
  const dailySignals = buildDailyDemandSignals({
    chargeDates: ['2026-04-10', '2026-04-11', '2026-04-12'].map((value) => new Date(`${value}T00:00:00.000Z`)),
    fleetCount: 2,
    reservations: [
      { pickupAt: '2026-04-10T10:00:00.000Z', returnAt: '2026-04-12T09:00:00.000Z' },
      { pickupAt: '2026-04-11T08:00:00.000Z', returnAt: '2026-04-13T10:00:00.000Z' },
      { pickupAt: '2026-04-11T12:00:00.000Z', returnAt: '2026-04-11T20:00:00.000Z' }
    ],
    revenueConfig: REVENUE_CONFIG
  });

  assert.equal(dailySignals.length, 3);
  assert.deepEqual(dailySignals.map((row) => row.date), ['2026-04-10', '2026-04-11', '2026-04-12']);
  assert.equal(dailySignals[0].demandCount, 1);
  assert.equal(dailySignals[1].demandCount, 3);
  assert.equal(dailySignals[1].shortageUnits, 1);
  assert.equal(dailySignals[1].pressureBand, 'SHORTAGE');
  assert.equal(dailySignals[2].pressureBand, 'CRITICAL');
});

test('summarizeDailyDemandSignals surfaces peak and average pressure metrics', () => {
  const summary = summarizeDailyDemandSignals([
    { date: '2026-04-10', demandCount: 1, availableUnits: 1, shortageUnits: 0, utilizationPct: 50, pressureBand: 'NORMAL' },
    { date: '2026-04-11', demandCount: 3, availableUnits: 0, shortageUnits: 1, utilizationPct: 150, pressureBand: 'SHORTAGE' },
    { date: '2026-04-12', demandCount: 2, availableUnits: 0, shortageUnits: 0, utilizationPct: 100, pressureBand: 'CRITICAL' }
  ], { fleetCount: 2, overlappingDemandCount: 3 });

  assert.equal(summary.peakPressureDate, '2026-04-11');
  assert.equal(summary.peakPressureBand, 'SHORTAGE');
  assert.equal(summary.peakShortageUnits, 1);
  assert.equal(summary.peakUtilizationPct, 150);
  assert.equal(summary.averageDemandCount, 2);
  assert.equal(summary.pressureDaysCount, 2);
});

test('buildRevenueDailyRecommendations produces date-aware adjusted daily rates with cap', () => {
  const pricingPlan = buildRevenueDailyRecommendations({
    baseDailyBreakdown: [
      { date: '2026-04-10', dailyRate: 50 },
      { date: '2026-04-11', dailyRate: 50 },
      { date: '2026-04-12', dailyRate: 50 }
    ],
    dailySignals: [
      { date: '2026-04-10', demandCount: 1, availableUnits: 1, shortageUnits: 0, utilizationPct: 50, pressureBand: 'NORMAL' },
      { date: '2026-04-11', demandCount: 3, availableUnits: 0, shortageUnits: 1, utilizationPct: 150, pressureBand: 'SHORTAGE' },
      { date: '2026-04-12', demandCount: 2, availableUnits: 0, shortageUnits: 0, utilizationPct: 100, pressureBand: 'CRITICAL' }
    ],
    revenueConfig: REVENUE_CONFIG,
    leadTimeDays: 1,
    weekendPickup: true
  });

  assert.equal(pricingPlan.recommendedDailyBreakdown.length, 3);
  assert.equal(pricingPlan.recommendedDailyBreakdown[0].adjustmentPct, 23);
  assert.equal(pricingPlan.recommendedDailyBreakdown[1].adjustmentPct, 25);
  assert.equal(pricingPlan.recommendedDailyBreakdown[1].recommendedDailyRate, 62.5);
  assert.equal(pricingPlan.recommendedDailyBreakdown[2].recommendedDailyRate, 62.5);
  assert.equal(pricingPlan.recommendedBaseTotal, 186.5);
  assert.equal(pricingPlan.recommendedDailyRate, 62.17);
});
