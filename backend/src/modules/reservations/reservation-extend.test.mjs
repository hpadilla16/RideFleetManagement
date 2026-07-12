import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reservationExtendService } from './reservation-extend.service.js';
import { reservationPricingService } from './reservation-pricing.service.js';
import { prisma } from '../../lib/prisma.js';

// =============================================================================
// reservation-extend tests (Bug 6, 2026-04-30 — unified extend+addendum flow)
//
// All tests run against an in-memory mock of prisma — no DB required.
// The mock simulates a single reservation with a charges table that
// supports findFirst/findUnique/findMany/create/update/delete so we
// can exercise the full DAILY-rescale + tax-recompute + addendum
// auto-create pipeline.
// =============================================================================

// Captured ONCE at module load — the real reservationPricingService
// .syncAgreementCharges. makeMockDb wraps the public method with a
// call-recording spy that still delegates here, and afterEach restores it.
const originalSyncAgreementCharges = reservationPricingService.syncAgreementCharges;

function makeMockDb({ reservationId = 'res-1', initial = {} } = {}) {
  const state = {
    reservation: {
      id: reservationId,
      tenantId: 'tenant-1',
      status: 'CONFIRMED',
      pickupAt: new Date('2026-05-10T00:00:00Z'),
      returnAt: new Date('2026-05-15T00:00:00Z'), // 5 days
      originalReturnAt: null,
      pickupLocationId: 'loc-1',
      dailyRate: 50,
      estimatedTotal: 250,
      pricingSnapshot: { dailyRate: 50, taxRate: 11.5 },
      rentalAgreement: { id: 'agree-1', status: 'FINALIZED', tenantId: 'tenant-1' },
      ...initial.reservation
    },
    charges: initial.charges || [
      // 5-day base rental @ $50/day
      { id: 'c-base', reservationId, code: null, name: 'Base rental',
        chargeType: 'DAILY', quantity: 5, rate: 50, total: 250,
        taxable: true, selected: true, sortOrder: 0,
        source: 'BASE_RATE', sourceRefId: null,
        createdAt: new Date('2026-05-01T10:00:00Z') },
      // existing TAX row (5d × $50 × 11.5% = $28.75)
      { id: 'c-tax', reservationId, code: null, name: 'Sales Tax (11.50%)',
        chargeType: 'TAX', quantity: 1, rate: 28.75, total: 28.75,
        taxable: false, selected: true, sortOrder: 999,
        source: 'TAX_RECALC', sourceRefId: null,
        createdAt: new Date('2026-05-01T10:00:00Z') }
    ],
    addendums: [],
    auditLogs: []
  };

  let chargeIdCounter = 100;
  let addendumIdCounter = 1;
  let auditIdCounter = 1;
  let agreementChargeIdCounter = 1;

  prisma.reservation.findFirst = async () => ({
    ...state.reservation,
    charges: state.charges.filter((c) => c.selected !== false)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  });
  prisma.reservation.update = async ({ where, data }) => {
    if (where.id !== state.reservation.id) throw new Error('mock: bad reservation id');
    Object.assign(state.reservation, data);
    return { ...state.reservation };
  };

  prisma.reservationCharge = prisma.reservationCharge || {};
  prisma.reservationCharge.findUnique = async ({ where }) =>
    state.charges.find((c) => c.id === where.id) || null;
  prisma.reservationCharge.findMany = async ({ where = {} } = {}) => {
    return state.charges.filter((c) => {
      if (where.reservationId && c.reservationId !== where.reservationId) return false;
      if (where.selected !== undefined && c.selected !== where.selected) return false;
      if (where.chargeType && c.chargeType !== where.chargeType) return false;
      return true;
    }).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  };
  prisma.reservationCharge.create = async ({ data }) => {
    const row = {
      id: `c-${++chargeIdCounter}`,
      createdAt: new Date(),
      ...data
    };
    state.charges.push(row);
    return row;
  };
  prisma.reservationCharge.update = async ({ where, data }) => {
    const idx = state.charges.findIndex((c) => c.id === where.id);
    if (idx < 0) throw new Error('mock: charge not found ' + where.id);
    state.charges[idx] = { ...state.charges[idx], ...data };
    return { ...state.charges[idx] };
  };
  prisma.reservationCharge.delete = async ({ where }) => {
    const idx = state.charges.findIndex((c) => c.id === where.id);
    if (idx < 0) throw new Error('mock: charge not found ' + where.id);
    const [removed] = state.charges.splice(idx, 1);
    return removed;
  };
  prisma.reservationCharge.deleteMany = async ({ where = {} } = {}) => {
    const before = state.charges.length;
    state.charges = state.charges.filter((c) => {
      if (where.reservationId && c.reservationId !== where.reservationId) return true;
      if (where.chargeType && c.chargeType !== where.chargeType) return true;
      return false;
    });
    return { count: before - state.charges.length };
  };

  // RentalAgreement mock — needed because reservation-extend.service.js
  // now mirrors returnAt onto RentalAgreement (2026-05-27 fix for the
  // late-fee-ignores-extensions bug). Stores a per-agreement row so we
  // can assert returnAt landed correctly in the create/delete tests.
  state.agreements = initial.agreements || [
    { id: 'agree-1', tenantId: 'tenant-1', status: 'FINALIZED',
      returnAt: new Date(state.reservation.returnAt) }
  ];
  prisma.rentalAgreement = prisma.rentalAgreement || {};
  prisma.rentalAgreement.update = async ({ where, data }) => {
    const a = state.agreements.find((x) => x.id === where.id);
    if (!a) throw new Error('mock: agreement not found ' + where.id);
    Object.assign(a, data);
    return { ...a };
  };

  // RentalAgreementCharge + payment mocks (MONEY-FIX, 2026-07-12) — needed
  // because reservation-extend now calls reservationPricingService
  // .syncAgreementCharges after recomputeTaxRow so the extension rate + its
  // tax are mirrored onto the binding agreement's subtotal/taxes/total/balance.
  // The gap that let the bug ship: the old mock had NO agreement-charge table,
  // so nothing exercised the reconciler. These mocks replay the reconciler's
  // real behavior (carve-out preserve on delete, recompute from selected rows)
  // so tests can assert agreement money actually moves.
  state.agreementCharges = initial.agreementCharges || [];
  state.agreementPayments = initial.agreementPayments || [];
  prisma.rentalAgreementCharge = prisma.rentalAgreementCharge || {};
  prisma.rentalAgreementCharge.deleteMany = async ({ where = {} } = {}) => {
    const before = state.agreementCharges.length;
    state.agreementCharges = state.agreementCharges.filter((c) => {
      if (where.rentalAgreementId && c.rentalAgreementId !== where.rentalAgreementId) return true;
      // Mirror the carve-out in syncAgreementCharges: FEE_ENGINE_*,
      // ADMIN_CORRECTION and DAMAGE_CHARGE rows survive the recompute.
      const src = String(c.source || '').toUpperCase();
      if (src.startsWith('FEE_ENGINE_') || src === 'ADMIN_CORRECTION' || src === 'DAMAGE_CHARGE') return true;
      return false;
    });
    return { count: before - state.agreementCharges.length };
  };
  prisma.rentalAgreementCharge.createMany = async ({ data }) => {
    const rows = Array.isArray(data) ? data : [data];
    for (const d of rows) {
      state.agreementCharges.push({ id: `ac-${agreementChargeIdCounter++}`, ...d });
    }
    return { count: rows.length };
  };
  prisma.rentalAgreementCharge.findMany = async ({ where = {} } = {}) => {
    return state.agreementCharges.filter((c) => {
      if (where.rentalAgreementId && c.rentalAgreementId !== where.rentalAgreementId) return false;
      if (where.selected !== undefined && c.selected !== where.selected) return false;
      return true;
    });
  };
  prisma.rentalAgreementPayment = prisma.rentalAgreementPayment || {};
  prisma.rentalAgreementPayment.findMany = async ({ where = {} } = {}) => {
    return state.agreementPayments.filter((p) => {
      if (where.rentalAgreementId && p.rentalAgreementId !== where.rentalAgreementId) return false;
      if (where.status && p.status !== where.status) return false;
      if (where.method?.not && p.method === where.method.not) return false;
      return true;
    });
  };

  // Spy that records every syncAgreementCharges invocation (reservationId,
  // scope, opts) and still delegates to the REAL reconciler above so the
  // agreement money is actually recomputed against the mock tables. Restored
  // in afterEach via originalSyncAgreementCharges.
  state.syncCalls = [];
  reservationPricingService.syncAgreementCharges = async (...args) => {
    state.syncCalls.push(args);
    return originalSyncAgreementCharges.apply(reservationPricingService, args);
  };

  prisma.rentalAgreementAddendum = prisma.rentalAgreementAddendum || {};
  prisma.rentalAgreementAddendum.create = async ({ data }) => {
    const row = { id: `add-${addendumIdCounter++}`, createdAt: new Date(), ...data };
    state.addendums.push(row);
    return row;
  };
  prisma.rentalAgreementAddendum.findFirst = async ({ where = {} } = {}) => {
    return state.addendums.find((a) => {
      if (where.extensionChargeId && a.extensionChargeId !== where.extensionChargeId) return false;
      return true;
    }) || null;
  };
  prisma.rentalAgreementAddendum.update = async ({ where, data }) => {
    const a = state.addendums.find((x) => x.id === where.id);
    if (!a) throw new Error('mock: addendum not found ' + where.id);
    Object.assign(a, data);
    return { ...a };
  };

  prisma.location = prisma.location || {};
  prisma.location.findUnique = async () => ({ taxRate: 11.5 });

  prisma.auditLog = prisma.auditLog || {};
  prisma.auditLog.create = async ({ data }) => {
    const row = { id: `log-${auditIdCounter++}`, createdAt: new Date(), ...data };
    state.auditLogs.push(row);
    return row;
  };

  return state;
}

describe('reservation-extend (unified flow)', () => {
  // Save originals so we can restore between describe blocks.
  let originalPrisma;
  beforeEach(() => {
    originalPrisma = {
      reservation: { ...prisma.reservation },
      reservationCharge: { ...(prisma.reservationCharge || {}) },
      rentalAgreement: { ...(prisma.rentalAgreement || {}) },
      rentalAgreementCharge: { ...(prisma.rentalAgreementCharge || {}) },
      rentalAgreementPayment: { ...(prisma.rentalAgreementPayment || {}) },
      rentalAgreementAddendum: { ...(prisma.rentalAgreementAddendum || {}) },
      location: { ...(prisma.location || {}) },
      auditLog: { ...(prisma.auditLog || {}) }
    };
  });
  afterEach(() => {
    Object.assign(prisma.reservation, originalPrisma.reservation);
    if (prisma.reservationCharge) Object.assign(prisma.reservationCharge, originalPrisma.reservationCharge);
    if (prisma.rentalAgreement) Object.assign(prisma.rentalAgreement, originalPrisma.rentalAgreement);
    if (prisma.rentalAgreementCharge) Object.assign(prisma.rentalAgreementCharge, originalPrisma.rentalAgreementCharge);
    if (prisma.rentalAgreementPayment) Object.assign(prisma.rentalAgreementPayment, originalPrisma.rentalAgreementPayment);
    if (prisma.rentalAgreementAddendum) Object.assign(prisma.rentalAgreementAddendum, originalPrisma.rentalAgreementAddendum);
    if (prisma.location) Object.assign(prisma.location, originalPrisma.location);
    if (prisma.auditLog) Object.assign(prisma.auditLog, originalPrisma.auditLog);
    // Restore the real reconciler after each spy-wrapped test.
    reservationPricingService.syncAgreementCharges = originalSyncAgreementCharges;
  });

  // ===========================================================================
  // Validation
  // ===========================================================================
  describe('validation', () => {
    it('rejects when newReturnAt is missing', async () => {
      makeMockDb();
      await assert.rejects(
        () => reservationExtendService.extendReservation({
          reservationId: 'res-1', newReturnAt: null,
          extensionDailyRate: null, note: '', actorUserId: 'u-1',
          tenantScope: { tenantId: 'tenant-1' }
        }),
        /New return date is required/
      );
    });

    it('rejects when newReturnAt is invalid', async () => {
      makeMockDb();
      await assert.rejects(
        () => reservationExtendService.extendReservation({
          reservationId: 'res-1', newReturnAt: 'not-a-date',
          extensionDailyRate: null, note: '', actorUserId: 'u-1',
          tenantScope: { tenantId: 'tenant-1' }
        }),
        /newReturnAt is invalid/
      );
    });

    it('rejects when newReturnAt is not after current returnAt', async () => {
      makeMockDb();
      await assert.rejects(
        () => reservationExtendService.extendReservation({
          reservationId: 'res-1',
          newReturnAt: new Date('2026-05-14T00:00:00Z'), // before current
          extensionDailyRate: null, note: '', actorUserId: 'u-1',
          tenantScope: { tenantId: 'tenant-1' }
        }),
        /must be after the current return date/
      );
    });

    it('rejects CANCELLED reservations', async () => {
      makeMockDb({ initial: { reservation: { status: 'CANCELLED' } } });
      await assert.rejects(
        () => reservationExtendService.extendReservation({
          reservationId: 'res-1',
          newReturnAt: new Date('2026-05-20T00:00:00Z'),
          extensionDailyRate: null, note: '', actorUserId: 'u-1',
          tenantScope: { tenantId: 'tenant-1' }
        }),
        /Cannot extend a reservation with status CANCELLED/
      );
    });

    it('rejects non-numeric extensionDailyRate (Codex finding from PR #30)', async () => {
      makeMockDb();
      await assert.rejects(
        () => reservationExtendService.extendReservation({
          reservationId: 'res-1',
          newReturnAt: new Date('2026-05-20T00:00:00Z'),
          extensionDailyRate: 'abc', note: '', actorUserId: 'u-1',
          tenantScope: { tenantId: 'tenant-1' }
        }),
        /must be a valid number/
      );
    });

    it('rejects negative extensionDailyRate', async () => {
      makeMockDb();
      await assert.rejects(
        () => reservationExtendService.extendReservation({
          reservationId: 'res-1',
          newReturnAt: new Date('2026-05-20T00:00:00Z'),
          extensionDailyRate: -10, note: '', actorUserId: 'u-1',
          tenantScope: { tenantId: 'tenant-1' }
        }),
        /cannot be negative/
      );
    });
  });

  // ===========================================================================
  // Happy path: per-day rescale + taxable extension + tax recompute
  // ===========================================================================
  describe('happy path', () => {
    it('creates extension charge with taxable=true (Hector 2026-04-30)', async () => {
      makeMockDb();
      const result = await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'), // +2 days
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      assert.equal(result.extensionCharge.code, 'EXTENSION_RATE');
      assert.equal(result.extensionCharge.chargeType, 'DAILY');
      assert.equal(result.extensionCharge.quantity, 2);
      assert.equal(result.extensionCharge.rate, 50);
      assert.equal(result.extensionCharge.total, 100);
      assert.equal(result.extensionCharge.taxable, true, 'extension rate must be taxable');
      assert.equal(result.extensionCharge.source, 'EXTENSION_DEFAULT');
    });

    it('mirrors the extended returnAt onto RentalAgreement (RES-623949, 2026-05-27)', async () => {
      // The late-fee engine in checkin-close.service.js reads dueBackAt
      // from agreement.returnAt. Before this fix only reservation.returnAt
      // was updated on extension, so the late-fee engine measured against
      // the pre-extension date and produced phantom fees (RES-623949 got
      // billed $650 for "26 hours late" on a rental returned ON TIME vs
      // its extended dueBack). Both tables must move together.
      const state = makeMockDb();
      const newReturn = new Date('2026-05-17T00:00:00Z'); // +2 days
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: newReturn,
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const agreement = state.agreements.find((a) => a.id === 'agree-1');
      assert.equal(
        agreement.returnAt.toISOString(),
        newReturn.toISOString(),
        'agreement.returnAt must match the extended reservation.returnAt'
      );
      assert.equal(
        state.reservation.returnAt.toISOString(),
        newReturn.toISOString(),
        'reservation.returnAt sanity check'
      );
    });

    it('does NOT touch the agreement when the reservation has no agreement attached', async () => {
      // Extending a pre-checkout reservation (no signed agreement yet)
      // already skips the addendum auto-create; the agreement mirror
      // must follow the same gate so we don't blow up when there's
      // nothing to update.
      const state = makeMockDb({
        initial: {
          reservation: {
            // Override the default fixture's rentalAgreement to null
            rentalAgreement: null
          }
        }
      });
      // No agreement on the reservation → the only agreement in state
      // is the fixture's default agree-1 row, which should stay put.
      const before = new Date(state.agreements[0].returnAt);
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      assert.equal(
        state.agreements[0].returnAt.toISOString(),
        before.toISOString(),
        'agreement.returnAt untouched when reservation has no agreement'
      );
    });

    it('does NOT rescale BASE_RATE row (Bug 8, 2026-05-12)', async () => {
      // 5-day base rental, extend by 2 days. The BASE_RATE row must
      // stay at 5 days x $50 = $250; the EXTENSION_RATE charge covers
      // the 2 new days (2 x $50 = $100). Rescaling the base on top of
      // creating the extension double-counted before this fix.
      const state = makeMockDb();
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const baseAfter = state.charges.find((c) => c.id === 'c-base');
      assert.equal(baseAfter.quantity, 5, 'BASE_RATE row stays at original day count');
      assert.equal(baseAfter.total, 250, 'BASE_RATE row total unchanged');
      // The EXTENSION_RATE row is the only added base-rate billing line.
      const ext = state.charges.find((c) => c.code === 'EXTENSION_RATE');
      assert.equal(ext.quantity, 2);
      assert.equal(ext.total, 100);
    });

    it('does NOT rescale base row when source is legacy "DAILY" (RES-368604)', async () => {
      // Older booking-engine paths persisted the base rental row with
      // source='DAILY' (not 'BASE_RATE'). RES-368604 surfaced this in
      // prod on 2026-05-12 — the original Bug 8 fix matched only
      // source==='BASE_RATE' and was still rescaling these legacy rows.
      // The whitelist-based predicate must leave any DAILY row whose
      // source is NOT in PER_DAY_LIKE_SOURCES alone.
      const state = makeMockDb({
        initial: {
          charges: [
            { id: 'c-base-legacy', reservationId: 'res-1', name: 'Daily',
              chargeType: 'DAILY', quantity: 5, rate: 50, total: 250,
              taxable: true, selected: true, sortOrder: 0,
              source: 'DAILY', sourceRefId: null,
              createdAt: new Date('2026-05-01T10:00:00Z') }
          ]
        }
      });
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const base = state.charges.find((c) => c.id === 'c-base-legacy');
      assert.equal(base.quantity, 5, 'legacy DAILY base row not rescaled');
      assert.equal(base.total, 250);
    });

    it('does NOT rescale base row when source is null/empty (very legacy)', async () => {
      const state = makeMockDb({
        initial: {
          charges: [
            { id: 'c-base-null', reservationId: 'res-1', name: 'Daily',
              chargeType: 'DAILY', quantity: 5, rate: 50, total: 250,
              taxable: true, selected: true, sortOrder: 0,
              source: null, sourceRefId: null,
              createdAt: new Date('2026-05-01T10:00:00Z') }
          ]
        }
      });
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const base = state.charges.find((c) => c.id === 'c-base-null');
      assert.equal(base.quantity, 5);
      assert.equal(base.total, 250);
    });

    it('does NOT rescale multi-unit FLAT SERVICE when qty != oldTotalDays (Codex P1 on PR #67)', async () => {
      // computeAdditionalServiceLine stores SERVICE quantity as the
      // unit count, not days. A 2-unit FLAT child-seat service has
      // qty=2 totally independent of the rental's day count. If the
      // strict qty === oldTotalDays gate is dropped for SERVICE rows,
      // those FLAT multi-unit rows get rewritten as day-count charges
      // and overbilled on extension. Keep the strict equality check
      // for non-INSURANCE UNIT sources so this row stays put when qty
      // doesn't match oldTotalDays.
      const state = makeMockDb({
        initial: {
          charges: [
            { id: 'c-base', reservationId: 'res-1', name: 'Daily',
              chargeType: 'DAILY', quantity: 3, rate: 50, total: 150,
              taxable: true, selected: true, sortOrder: 0, source: 'BASE_RATE',
              createdAt: new Date('2026-05-01T10:00:00Z') },
            { id: 'c-seats', reservationId: 'res-1', name: 'Child Seats x2',
              chargeType: 'UNIT', quantity: 2, rate: 25, total: 50,
              taxable: true, selected: true, sortOrder: 2,
              source: 'SERVICE', sourceRefId: 'svc-seats',
              createdAt: new Date('2026-05-01T10:00:00Z') }
          ],
          reservation: {
            pickupAt: new Date('2026-05-10T00:00:00Z'),
            returnAt: new Date('2026-05-13T00:00:00Z') // 3 days
          }
        }
      });
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'), // +4 days → 7 total
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const seats = state.charges.find((c) => c.id === 'c-seats');
      assert.equal(seats.quantity, 2, 'FLAT multi-unit SERVICE qty unchanged when != oldTotalDays');
      assert.equal(seats.total, 50, 'FLAT multi-unit SERVICE total unchanged');
    });

    it('DOES rescale a per-day row even when qty != oldTotalDays (RES-368604, 2026-05-12)', async () => {
      // RES-368604 surfaced this: Insurance was provisioned with qty=2
      // for a 2-day rental, but a returnAt time drift (5/7 12:45 →
      // 5/9 16:45 = 52 hours) made rentalDays() return ceil(52/24)=3.
      // The previous strict-equality predicate (qty === oldTotalDays)
      // refused to rescale because 2 !== 3, so Insurance got stuck at
      // qty=2 through an extension. The relaxed predicate (qty > 1)
      // accepts any per-day-source UNIT row with qty>1, and the rescale
      // uses row.rate (the per-day amount) × newTotalDays, so the new
      // total is correct regardless of the prior quantity.
      const state = makeMockDb({
        initial: {
          reservation: {
            pickupAt: new Date('2026-05-07T12:45:00Z'),
            returnAt: new Date('2026-05-09T16:45:00Z') // 52 hours → ceil to 3 days
          },
          charges: [
            { id: 'c-base', reservationId: 'res-1', name: 'Daily',
              chargeType: 'DAILY', quantity: 3, rate: 100, total: 300,
              taxable: true, selected: true, sortOrder: 0, source: 'BASE_RATE',
              createdAt: new Date('2026-05-01T10:00:00Z') },
            { id: 'c-ins', reservationId: 'res-1', name: 'Insurance: Full Super Collision',
              chargeType: 'UNIT', quantity: 2, rate: 32.99, total: 65.98,
              taxable: true, selected: true, sortOrder: 2,
              source: 'INSURANCE', sourceRefId: 'plan-1',
              createdAt: new Date('2026-05-01T10:00:00Z') }
          ]
        }
      });
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-12T20:45:00Z'), // 128 hours from pickup → 6 days
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const ins = state.charges.find((c) => c.id === 'c-ins');
      assert.equal(ins.quantity, 6, 'insurance rescales to newTotalDays even though qty != oldTotalDays');
      assert.equal(ins.total, Number((6 * 32.99).toFixed(2)), 'insurance total = newDays * rate');
      const base = state.charges.find((c) => c.id === 'c-base');
      assert.equal(base.quantity, 3, 'BASE_RATE still untouched');
    });

    it('does NOT rescale FIXED-mode INSURANCE on a 1-day rental (Codex P1 on PR #66)', async () => {
      // FIXED / PERCENTAGE insurance rows are stored as quantity=1
      // regardless of rental length (see computeInsuranceLine in
      // booking-engine.service.js). On a 1-day rental, qty=1 ties with
      // oldTotalDays=1 — without the qty > 1 guard the extension flow
      // would wrongly multiply the one-time amount by the new day
      // count.
      const state = makeMockDb({
        initial: {
          reservation: {
            pickupAt: new Date('2026-05-10T00:00:00Z'),
            returnAt: new Date('2026-05-11T00:00:00Z') // 1 day
          },
          charges: [
            { id: 'c-base', reservationId: 'res-1', name: 'Base rental',
              chargeType: 'DAILY', quantity: 1, rate: 50, total: 50,
              taxable: true, selected: true, sortOrder: 0, source: 'BASE_RATE',
              createdAt: new Date('2026-05-01T10:00:00Z') },
            { id: 'c-ins-fixed', reservationId: 'res-1', name: 'Insurance: Flat $40',
              chargeType: 'UNIT', quantity: 1, rate: 40, total: 40,
              taxable: true, selected: true, sortOrder: 2, source: 'INSURANCE',
              sourceRefId: 'plan-fixed',
              createdAt: new Date('2026-05-01T10:00:00Z') }
          ]
        }
      });
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-14T00:00:00Z'), // +3 days
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const ins = state.charges.find((c) => c.id === 'c-ins-fixed');
      assert.equal(ins.quantity, 1, 'FIXED insurance row stays at qty=1');
      assert.equal(ins.total, 40, 'FIXED insurance total unchanged');
    });

    it('DOES rescale INSURANCE-sourced rows (Hector, 2026-05-12)', async () => {
      // User asked insurance to extend alongside services on
      // 2026-05-12. Insurance lives at chargeType=UNIT, source='INSURANCE',
      // quantity=days. Adding INSURANCE to PER_DAY_LIKE_SOURCES makes
      // the qty==oldTotalDays heuristic pick it up.
      const state = makeMockDb({
        initial: {
          charges: [
            { id: 'c-base', reservationId: 'res-1', name: 'Daily',
              chargeType: 'DAILY', quantity: 5, rate: 50, total: 250,
              taxable: true, selected: true, sortOrder: 0,
              source: 'BASE_RATE', sourceRefId: null,
              createdAt: new Date('2026-05-01T10:00:00Z') },
            { id: 'c-ins', reservationId: 'res-1', name: 'Insurance: Full Super',
              chargeType: 'UNIT', quantity: 5, rate: 32.99, total: 164.95,
              taxable: true, selected: true, sortOrder: 2,
              source: 'INSURANCE', sourceRefId: 'plan-1',
              createdAt: new Date('2026-05-01T10:00:00Z') }
          ]
        }
      });
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const ins = state.charges.find((c) => c.id === 'c-ins');
      assert.equal(ins.quantity, 7, 'insurance rescales to new total days');
      assert.equal(ins.total, Number((7 * 32.99).toFixed(2)));
      const base = state.charges.find((c) => c.id === 'c-base');
      assert.equal(base.quantity, 5, 'BASE_RATE still untouched');
    });

    it('DOES rescale non-BASE_RATE chargeType=DAILY rows (Codex P1 on PR #65)', async () => {
      // AdditionalService configured with chargeType=DAILY flows into
      // ReservationCharge as DAILY+source='SERVICE' (see
      // booking-engine.service.js:1921, service.chargeType is
      // propagated verbatim). Those rows MUST keep rescaling on
      // extension, because EXTENSION_RATE only covers the base rent.
      const state = makeMockDb({
        initial: {
          charges: [
            { id: 'c-base', reservationId: 'res-1', name: 'Base rental',
              chargeType: 'DAILY', quantity: 5, rate: 50, total: 250,
              taxable: true, selected: true, sortOrder: 0, source: 'BASE_RATE',
              createdAt: new Date('2026-05-01T10:00:00Z') },
            { id: 'c-daily-svc', reservationId: 'res-1', name: 'Daily Wash',
              chargeType: 'DAILY', quantity: 5, rate: 7, total: 35,
              taxable: true, selected: true, sortOrder: 1, source: 'SERVICE',
              sourceRefId: 'svc-wash',
              createdAt: new Date('2026-05-01T10:00:00Z') }
          ]
        }
      });
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'), // +2 days, 7 total
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const base = state.charges.find((c) => c.id === 'c-base');
      assert.equal(base.quantity, 5, 'BASE_RATE stays at 5');
      assert.equal(base.total, 250);
      const svc = state.charges.find((c) => c.id === 'c-daily-svc');
      assert.equal(svc.quantity, 7, 'daily AdditionalService rescales to new total days');
      assert.equal(svc.total, Number((7 * 7).toFixed(2)), 'daily service total = newDays x rate');
    });

    it('DOES rescale KIOSK_UPSELL per-day rows exactly like counter-sold SERVICE rows (kiosk B2 QA, 2026-07-05)', async () => {
      // Kiosk upsell accept writes per-day add-ons as chargeType=DAILY,
      // quantity=days, rate=dailyRate, source='KIOSK_UPSELL' (see
      // kiosk-offers.service.js acceptOffers). Without KIOSK_UPSELL in
      // PER_DAY_LIKE_SOURCES the extra days rode uncharged — and a
      // coversTolls package would cover days the customer never paid for.
      // 3-day rental with CDW 12.99×3, extend +2 days → 5 total.
      const state = makeMockDb({
        initial: {
          reservation: {
            pickupAt: new Date('2026-05-10T00:00:00Z'),
            returnAt: new Date('2026-05-13T00:00:00Z'), // 3 days
            estimatedTotal: 188.97
          },
          charges: [
            { id: 'c-base', reservationId: 'res-1', name: 'Base rental',
              chargeType: 'DAILY', quantity: 3, rate: 50, total: 150,
              taxable: true, selected: true, sortOrder: 0, source: 'BASE_RATE',
              createdAt: new Date('2026-05-01T10:00:00Z') },
            { id: 'c-kiosk-cdw', reservationId: 'res-1', name: 'Collision Damage Waiver',
              chargeType: 'DAILY', quantity: 3, rate: 12.99, total: 38.97,
              taxable: true, selected: true, sortOrder: 1000, source: 'KIOSK_UPSELL',
              sourceRefId: 'svc-cdw', notes: 'Kiosk upsell',
              createdAt: new Date('2026-05-01T10:00:00Z') }
          ]
        }
      });
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-15T00:00:00Z'), // +2 days, 5 total
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const cdw = state.charges.find((c) => c.id === 'c-kiosk-cdw');
      assert.equal(cdw.quantity, 5, 'kiosk per-day add-on rescales to new total days');
      assert.equal(cdw.total, Number((5 * 12.99).toFixed(2)), 'kiosk add-on total = newDays × rate (64.95)');
      const base = state.charges.find((c) => c.id === 'c-base');
      assert.equal(base.quantity, 3, 'BASE_RATE still untouched');
      assert.equal(base.total, 150);
    });

    it('does NOT rescale one-time (UNIT, qty=1) KIOSK_UPSELL rows on extension (kiosk B2 QA, 2026-07-05)', async () => {
      // FIXED kiosk add-ons (booster seat: chargeType=UNIT, quantity=1,
      // rate=total) are one-time — the qty<=1 guard in shouldRescaleDailyRow
      // must leave them alone even though KIOSK_UPSELL is whitelisted.
      const state = makeMockDb({
        initial: {
          reservation: {
            pickupAt: new Date('2026-05-10T00:00:00Z'),
            returnAt: new Date('2026-05-13T00:00:00Z'), // 3 days
            estimatedTotal: 175
          },
          charges: [
            { id: 'c-base', reservationId: 'res-1', name: 'Base rental',
              chargeType: 'DAILY', quantity: 3, rate: 50, total: 150,
              taxable: true, selected: true, sortOrder: 0, source: 'BASE_RATE',
              createdAt: new Date('2026-05-01T10:00:00Z') },
            { id: 'c-kiosk-booster', reservationId: 'res-1', name: 'Booster Seat',
              chargeType: 'UNIT', quantity: 1, rate: 25, total: 25,
              taxable: false, selected: true, sortOrder: 1000, source: 'KIOSK_UPSELL',
              sourceRefId: 'svc-booster', notes: 'Kiosk upsell',
              createdAt: new Date('2026-05-01T10:00:00Z') }
          ]
        }
      });
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-15T00:00:00Z'), // +2 days, 5 total
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const booster = state.charges.find((c) => c.id === 'c-kiosk-booster');
      assert.equal(booster.quantity, 1, 'one-time kiosk add-on quantity unchanged');
      assert.equal(booster.total, 25, 'one-time kiosk add-on total unchanged');
    });

    it('rescales per-day SERVICE rows stored as UNIT with quantity=oldDays (Bug 7a)', async () => {
      // Pre-Paid Tolls service provisioned by booking-engine as
      // chargeType=UNIT, quantity=days, rate=dailyRate (booking-engine.service.js:1822).
      // Original 5-day rental → 5 units. Extend +2 days → must rescale to 7.
      const state = makeMockDb({
        initial: {
          charges: [
            { id: 'c-base', reservationId: 'res-1', name: 'Base rental',
              chargeType: 'DAILY', quantity: 5, rate: 50, total: 250,
              taxable: true, selected: true, sortOrder: 0, source: 'BASE_RATE',
              createdAt: new Date('2026-05-01T10:00:00Z') },
            { id: 'c-tolls', reservationId: 'res-1', name: 'Pre-Paid Tolls',
              chargeType: 'UNIT', quantity: 5, rate: 9.99, total: 49.95,
              taxable: true, selected: true, sortOrder: 1, source: 'SERVICE',
              sourceRefId: 'svc-tolls',
              createdAt: new Date('2026-05-01T10:00:00Z') }
          ]
        }
      });
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'), // +2 days → 7 total
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const tolls = state.charges.find((c) => c.id === 'c-tolls');
      assert.equal(tolls.quantity, 7, 'per-day UNIT service rescaled to new total days');
      assert.equal(tolls.total, Number((7 * 9.99).toFixed(2)), 'per-day UNIT total = newDays × rate');
    });

    it('does NOT rescale FIXED chargeType=UNIT addons (qty does not match oldDays)', async () => {
      // FIXED $25 child seat — qty=1 doesn't match the 5-day pre-extension window,
      // so the heuristic correctly leaves it alone.
      const state = makeMockDb({
        initial: {
          charges: [
            { id: 'c-base', reservationId: 'res-1', name: 'Base rental',
              chargeType: 'DAILY', quantity: 5, rate: 50, total: 250,
              taxable: true, selected: true, sortOrder: 0, source: 'BASE_RATE',
              createdAt: new Date('2026-05-01T10:00:00Z') },
            { id: 'c-seat', reservationId: 'res-1', name: 'Child Seat',
              chargeType: 'UNIT', quantity: 1, rate: 25, total: 25,
              taxable: true, selected: true, sortOrder: 1, source: 'ADDON',
              createdAt: new Date('2026-05-01T10:00:00Z') }
          ]
        }
      });
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const seat = state.charges.find((c) => c.id === 'c-seat');
      assert.equal(seat.quantity, 1, 'FIXED UNIT addon untouched');
      assert.equal(seat.total, 25, 'FIXED UNIT total untouched');
    });

    it('does NOT rescale security deposit even if chargeType=DAILY', async () => {
      const state = makeMockDb({
        initial: {
          charges: [
            { id: 'c-base', reservationId: 'res-1', name: 'Base rental',
              chargeType: 'DAILY', quantity: 5, rate: 50, total: 250,
              taxable: true, selected: true, sortOrder: 0, source: 'BASE_RATE',
              createdAt: new Date('2026-05-01T10:00:00Z') },
            { id: 'c-dep', reservationId: 'res-1', name: 'Security Deposit',
              chargeType: 'DAILY', quantity: 1, rate: 200, total: 200,
              taxable: false, selected: true, sortOrder: 50, source: 'SECURITY_DEPOSIT',
              createdAt: new Date('2026-05-01T10:00:00Z') }
          ]
        }
      });
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const dep = state.charges.find((c) => c.id === 'c-dep');
      assert.equal(dep.quantity, 1, 'security deposit untouched');
      assert.equal(dep.total, 200);
    });

    it('recomputes TAX row against new taxable subtotal (includes extension)', async () => {
      // 5d × $50 = $250 base (unchanged after fix), extend +2d at $50
      // adds an EXTENSION_RATE of $100. Total taxable subtotal:
      // $250 base + $100 extension = $350. Tax @ 11.5% = $40.25.
      const state = makeMockDb();
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const taxRows = state.charges.filter((c) => c.chargeType === 'TAX');
      assert.equal(taxRows.length, 1, 'exactly one TAX row after recompute');
      assert.equal(taxRows[0].total, 40.25,
        'tax = ($250 base + $100 ext) × 11.5% = $40.25');
    });

    it('sets originalReturnAt on first extension only', async () => {
      const state = makeMockDb();
      const originalReturn = state.reservation.returnAt.toISOString();

      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      assert.equal(state.reservation.originalReturnAt.toISOString(), originalReturn,
        'originalReturnAt = pre-first-extension returnAt');
    });

    it('does NOT overwrite originalReturnAt on second extension', async () => {
      const state = makeMockDb({
        initial: { reservation: { originalReturnAt: new Date('2026-05-15T00:00:00Z') } }
      });
      // Simulate that first extension already happened: returnAt is now
      // 2026-05-17 (after first ext). Now do a second extension to 05-19.
      state.reservation.returnAt = new Date('2026-05-17T00:00:00Z');
      const preserveOriginal = state.reservation.originalReturnAt.toISOString();

      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-19T00:00:00Z'),
        extensionDailyRate: 60, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      assert.equal(state.reservation.originalReturnAt.toISOString(), preserveOriginal,
        'second extension preserves originalReturnAt');
    });

    it('auto-creates RentalAgreementAddendum tied to extension charge', async () => {
      const state = makeMockDb();
      const result = await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: 'Customer late return', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      assert.ok(result.addendum, 'addendum returned');
      assert.equal(state.addendums.length, 1, 'one addendum created');
      const a = state.addendums[0];
      assert.equal(a.rentalAgreementId, 'agree-1');
      assert.equal(a.reasonCategory, 'EXTENSION');
      assert.equal(a.status, 'PENDING_SIGNATURE');
      assert.equal(a.extensionChargeId, result.extensionCharge.id);
      assert.ok(a.signatureToken, 'signature token issued');
      assert.equal(a.pickupAt.toISOString(), '2026-05-15T00:00:00.000Z',
        'addendum.pickupAt = pre-extension returnAt (start of extension period)');
      assert.equal(a.returnAt.toISOString(), '2026-05-17T00:00:00.000Z',
        'addendum.returnAt = new returnAt');
    });

    it('addendum captures originalCharges + newCharges + chargeDelta', async () => {
      const state = makeMockDb();
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const a = state.addendums[0];
      const orig = JSON.parse(a.originalCharges);
      const next = JSON.parse(a.newCharges);
      const delta = JSON.parse(a.chargeDelta);
      assert.ok(Array.isArray(orig));
      assert.ok(Array.isArray(next));
      assert.equal(delta.extensionDays, 2);
      assert.equal(delta.previousReturnAt, '2026-05-15T00:00:00.000Z');
      assert.equal(delta.newReturnAt, '2026-05-17T00:00:00.000Z');
    });

    it('addendum captures actor role from request (Sentry finding on PR #34)', async () => {
      const state = makeMockDb();
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        actorRole: 'AGENT', // agent did the extension, not an admin
        tenantScope: { tenantId: 'tenant-1' }
      });
      assert.equal(state.addendums[0].initiatedByRole, 'AGENT',
        'addendum.initiatedByRole reflects the actual actor role');
    });

    it('addendum.initiatedByRole defaults to ADMIN when actorRole missing', async () => {
      const state = makeMockDb();
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        // actorRole intentionally omitted
        tenantScope: { tenantId: 'tenant-1' }
      });
      assert.equal(state.addendums[0].initiatedByRole, 'ADMIN');
    });

    it('skips addendum creation when reservation has no agreement', async () => {
      const state = makeMockDb({
        initial: { reservation: { rentalAgreement: null } }
      });
      const result = await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      assert.equal(result.addendum, null);
      assert.equal(state.addendums.length, 0);
    });

    it('writes audit log with full delta', async () => {
      const state = makeMockDb();
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: 75, note: 'Negotiated rate', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      assert.equal(state.auditLogs.length, 1);
      const meta = JSON.parse(state.auditLogs[0].data
        ? state.auditLogs[0].data.metadata
        : state.auditLogs[0].metadata);
      assert.equal(meta.reservationExtended, true);
      assert.equal(meta.extensionDays, 2);
      assert.equal(meta.newTotalDays, 7);
      assert.equal(meta.extensionDailyRate, 75);
      assert.equal(meta.firstExtensionForReservation, true);
      assert.equal(meta.note, 'Negotiated rate');
    });
  });

  // ===========================================================================
  // deleteExtension
  // ===========================================================================
  describe('deleteExtension', () => {
    it('reverts a pending extension cleanly', async () => {
      const state = makeMockDb();
      // First, do an extension
      const ext = await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      // Now delete it
      const result = await reservationExtendService.deleteExtension({
        reservationId: 'res-1',
        extensionChargeId: ext.extensionCharge.id,
        actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      assert.equal(result.revertedReturnAt.toISOString(), '2026-05-15T00:00:00.000Z');
      assert.equal(result.wasLastExtension, true);
      assert.equal(state.reservation.returnAt.toISOString(), '2026-05-15T00:00:00.000Z');
      assert.equal(state.reservation.originalReturnAt, null,
        'last-extension delete clears originalReturnAt');
      // EXTENSION_RATE charge gone
      assert.equal(
        state.charges.filter((c) => c.code === 'EXTENSION_RATE').length, 0
      );
      // base DAILY charge restored to 5 days × $50 = $250
      const base = state.charges.find((c) => c.id === 'c-base');
      assert.equal(base.quantity, 5);
      assert.equal(base.total, 250);
      // Addendum voided
      const addendum = state.addendums[0];
      assert.equal(addendum.status, 'VOID');
    });

    it('refuses to delete a SIGNED extension', async () => {
      const state = makeMockDb();
      const ext = await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      // Customer signs the addendum
      state.addendums[0].status = 'SIGNED';
      await assert.rejects(
        () => reservationExtendService.deleteExtension({
          reservationId: 'res-1',
          extensionChargeId: ext.extensionCharge.id,
          actorUserId: 'u-1',
          tenantScope: { tenantId: 'tenant-1' }
        }),
        /addendum has been signed/
      );
    });

    it('refuses to delete an older extension when newer ones exist (LIFO)', async () => {
      const state = makeMockDb();
      // First extension
      const ext1 = await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      // Second extension (newer)
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-19T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      // Try to delete the OLDER one
      await assert.rejects(
        () => reservationExtendService.deleteExtension({
          reservationId: 'res-1',
          extensionChargeId: ext1.extensionCharge.id,
          actorUserId: 'u-1',
          tenantScope: { tenantId: 'tenant-1' }
        }),
        /Only the most recent extension/
      );
    });

    it('rejects an invalid extensionChargeId', async () => {
      makeMockDb();
      await assert.rejects(
        () => reservationExtendService.deleteExtension({
          reservationId: 'res-1',
          extensionChargeId: 'does-not-exist',
          actorUserId: 'u-1',
          tenantScope: { tenantId: 'tenant-1' }
        }),
        /Extension charge not found/
      );
    });
  });

  // ===========================================================================
  // Agreement reconciliation (MONEY-FIX, 2026-07-12)
  //
  // The bug: extendReservation created the taxable EXTENSION_RATE charge and
  // recomputed the reservation-side TAX row, but NEVER mirrored either onto the
  // binding RentalAgreement — so RentalAgreement.taxes/total/balance (what the
  // customer owes) missed the extension's rate AND its tax. The fix adds the
  // canonical reconciler (reservationPricingService.syncAgreementCharges,
  // { allowClosed: true }) after the tax recompute in BOTH extend and delete.
  // These tests exercise the reconciler against the mock agreement tables so
  // we prove the money actually lands on the agreement (the old mock had no
  // agreement-charge table, which is why the gap shipped).
  // ===========================================================================
  describe('agreement reconciliation (money-fix)', () => {
    it('extension rate + its tax reach the agreement total/balance exactly once', async () => {
      // 5d × $50 = $250 base, extend +2d at $50 → EXTENSION_RATE $100.
      // Taxable subtotal $350; tax @ 11.5% = $40.25. Agreement must show
      // subtotal 350, taxes 40.25, total 390.25, balance 390.25 (paid $0).
      const state = makeMockDb();
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });

      // syncAgreementCharges was invoked for this reservation with allowClosed.
      assert.equal(state.syncCalls.length, 1, 'reconciler called exactly once');
      const [rid, scope, opts] = state.syncCalls[0];
      assert.equal(rid, 'res-1');
      assert.deepEqual(scope, { tenantId: 'tenant-1' });
      assert.equal(opts.allowClosed, true, 'must pass allowClosed:true');

      const agreement = state.agreements.find((a) => a.id === 'agree-1');
      assert.equal(agreement.subtotal, 350, 'agreement subtotal = base 250 + extension 100');
      assert.equal(agreement.taxes, 40.25, 'agreement taxes include the extension tax ($40.25)');
      assert.equal(agreement.total, 390.25, 'agreement total = 350 + 40.25');
      assert.equal(agreement.balance, 390.25, 'agreement balance moved by the extension + its tax');

      // No double-tax: exactly ONE TAX row mirrored onto the agreement.
      const agreementTaxRows = state.agreementCharges.filter((c) => c.chargeType === 'TAX');
      assert.equal(agreementTaxRows.length, 1, 'exactly one TAX row on the agreement');
      assert.equal(agreementTaxRows[0].total, 40.25);
      const agreementExtRows = state.agreementCharges.filter((c) => c.code === 'EXTENSION_RATE');
      assert.equal(agreementExtRows.length, 1, 'extension rate mirrored onto the agreement once');
    });

    it('reconciles a CLOSED agreement via allowClosed (late-return / post-checkout extension)', async () => {
      // A late-return extension can land on a CLOSED agreement. allowClosed:true
      // lets syncAgreementCharges reopen the money math for it (mirrors every
      // other post-checkout money mutation). Without allowClosed the reconciler
      // no-ops on CLOSED and the extension tax would never reach the balance.
      const state = makeMockDb({
        initial: {
          reservation: {
            rentalAgreement: { id: 'agree-1', status: 'CLOSED', tenantId: 'tenant-1' }
          },
          agreements: [
            { id: 'agree-1', tenantId: 'tenant-1', status: 'CLOSED',
              returnAt: new Date('2026-05-15T00:00:00Z') }
          ]
        }
      });
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const agreement = state.agreements.find((a) => a.id === 'agree-1');
      assert.equal(agreement.total, 390.25, 'CLOSED agreement total still reconciled (allowClosed)');
      assert.equal(agreement.taxes, 40.25, 'CLOSED agreement taxes include the extension tax');
      assert.equal(agreement.balance, 390.25, 'CLOSED agreement balance reconciled');
    });

    it('deleteExtension reconciles the agreement back down (removes extension rate + its tax)', async () => {
      const state = makeMockDb();
      const ext = await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      // After extend the agreement carries the extension + $40.25 tax.
      assert.equal(state.agreements[0].total, 390.25);

      await reservationExtendService.deleteExtension({
        reservationId: 'res-1',
        extensionChargeId: ext.extensionCharge.id,
        actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });

      // Reconciler ran on BOTH paths, always with allowClosed:true.
      assert.equal(state.syncCalls.length, 2, 'reconciler called on extend AND delete');
      assert.ok(state.syncCalls.every(([, , o]) => o?.allowClosed === true),
        'both invocations pass allowClosed:true');

      // Agreement back to base-only: 5d × $50 = $250, tax @ 11.5% = $28.75.
      const agreement = state.agreements.find((a) => a.id === 'agree-1');
      assert.equal(agreement.subtotal, 250, 'extension rate removed from agreement subtotal');
      assert.equal(agreement.taxes, 28.75, 'agreement tax recomputed off the base-only subtotal');
      assert.equal(agreement.total, 278.75);
      assert.equal(agreement.balance, 278.75, 'agreement balance reverted');
      const agreementExtRows = state.agreementCharges.filter((c) => c.code === 'EXTENSION_RATE');
      assert.equal(agreementExtRows.length, 0, 'no EXTENSION_RATE row left on the agreement');
    });
  });

  // ===========================================================================
  // Multi-extension stacking
  // ===========================================================================
  describe('multi-extension', () => {
    it('two sequential extensions each create their own addendum', async () => {
      const state = makeMockDb();
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-19T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      assert.equal(state.addendums.length, 2, 'one addendum per extension');
      // Both pending
      assert.ok(state.addendums.every((a) => a.status === 'PENDING_SIGNATURE'));
      // Two EXTENSION_RATE charges
      const exts = state.charges.filter((c) => c.code === 'EXTENSION_RATE');
      assert.equal(exts.length, 2);
      // Base DAILY charge stays at its original 5 days (Bug 8 fix —
      // chargeType=DAILY no longer rescales; the two EXTENSION_RATE
      // lines carry the extra days' base billing).
      const base = state.charges.find((c) => c.id === 'c-base');
      assert.equal(base.quantity, 5);
      assert.equal(base.total, 250);
    });
  });
});
