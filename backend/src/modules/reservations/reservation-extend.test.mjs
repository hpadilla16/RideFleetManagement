import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reservationExtendService } from './reservation-extend.service.js';
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
      rentalAgreementAddendum: { ...(prisma.rentalAgreementAddendum || {}) },
      location: { ...(prisma.location || {}) },
      auditLog: { ...(prisma.auditLog || {}) }
    };
  });
  afterEach(() => {
    Object.assign(prisma.reservation, originalPrisma.reservation);
    if (prisma.reservationCharge) Object.assign(prisma.reservationCharge, originalPrisma.reservationCharge);
    if (prisma.rentalAgreementAddendum) Object.assign(prisma.rentalAgreementAddendum, originalPrisma.rentalAgreementAddendum);
    if (prisma.location) Object.assign(prisma.location, originalPrisma.location);
    if (prisma.auditLog) Object.assign(prisma.auditLog, originalPrisma.auditLog);
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

    it('rescales chargeType=DAILY rows to new total days', async () => {
      // 5-day base rental → extend by 2 days → base should rescale to 7 days × $50 = $350
      const state = makeMockDb();
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const baseAfter = state.charges.find((c) => c.id === 'c-base');
      assert.equal(baseAfter.quantity, 7, 'base DAILY rescaled to new total days');
      assert.equal(baseAfter.total, 350, 'base DAILY total = quantity × rate');
    });

    it('does NOT rescale FIXED chargeType=UNIT addons', async () => {
      // Add a FIXED $25 child seat fee (one-time)
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
      // 5d × $50 = $250 base, extend +2d at $50 = +$100. Total taxable
      // subtotal: $350 base (rescaled) + $100 extension = $450.
      // Tax @ 11.5% = $51.75
      const state = makeMockDb();
      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: new Date('2026-05-17T00:00:00Z'),
        extensionDailyRate: null, note: '', actorUserId: 'u-1',
        tenantScope: { tenantId: 'tenant-1' }
      });
      const taxRows = state.charges.filter((c) => c.chargeType === 'TAX');
      assert.equal(taxRows.length, 1, 'exactly one TAX row after recompute');
      assert.equal(taxRows[0].total, 51.75,
        'tax = ($350 base + $100 ext) × 11.5% = $51.75');
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
      // Base DAILY charge rescaled to 9 days (5 → 7 → 9)
      const base = state.charges.find((c) => c.id === 'c-base');
      assert.equal(base.quantity, 9);
      assert.equal(base.total, 450);
    });
  });
});
