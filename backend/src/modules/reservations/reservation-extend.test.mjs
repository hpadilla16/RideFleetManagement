import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reservationExtendService } from './reservation-extend.service.js';
import { prisma } from '../../lib/prisma.js';

// Mock prisma operations for testing the extension logic.
// No database needed — we mock the critical paths.

describe('reservation-extend', () => {
  let findFirstCalls;
  let updateCalls;
  let createChargeCalls;
  let createAuditLogCalls;

  let origFindFirst;
  let origUpdate;
  let origCreateCharge;
  let origFindManyCharge;
  let origCreateAuditLog;

  beforeEach(() => {
    findFirstCalls = [];
    updateCalls = [];
    createChargeCalls = [];
    createAuditLogCalls = [];

    origFindFirst = prisma.reservation.findFirst;
    origUpdate = prisma.reservation.update;
    origCreateCharge = prisma.reservationCharge?.create;
    origFindManyCharge = prisma.reservationCharge?.findMany;
    origCreateAuditLog = prisma.auditLog?.create;

    if (!prisma.reservationCharge) {
      prisma.reservationCharge = {};
    }
    if (!prisma.auditLog) {
      prisma.auditLog = {};
    }
  });

  afterEach(() => {
    prisma.reservation.findFirst = origFindFirst;
    prisma.reservation.update = origUpdate;
    if (origCreateCharge) {
      prisma.reservationCharge.create = origCreateCharge;
    } else {
      delete prisma.reservationCharge.create;
    }
    if (origFindManyCharge) {
      prisma.reservationCharge.findMany = origFindManyCharge;
    } else {
      delete prisma.reservationCharge.findMany;
    }
    if (origCreateAuditLog) {
      prisma.auditLog.create = origCreateAuditLog;
    } else {
      delete prisma.auditLog.create;
    }
  });

  describe('extendReservation validation', () => {
    it('rejects when newReturnAt is missing', async () => {
      try {
        await reservationExtendService.extendReservation({
          reservationId: 'res-1',
          newReturnAt: null,
          extensionDailyRate: null,
          note: '',
          actorUserId: 'user-1',
          tenantScope: { tenantId: 'tenant-1' }
        });
        assert.fail('Expected an error');
      } catch (e) {
        assert.match(e.message, /New return date is required/);
      }
    });

    it('rejects when newReturnAt is an invalid date', async () => {
      try {
        await reservationExtendService.extendReservation({
          reservationId: 'res-1',
          newReturnAt: 'not-a-date',
          extensionDailyRate: null,
          note: '',
          actorUserId: 'user-1',
          tenantScope: { tenantId: 'tenant-1' }
        });
        assert.fail('Expected an error');
      } catch (e) {
        assert.match(e.message, /newReturnAt is invalid/);
      }
    });

    it('rejects when newReturnAt <= current returnAt', async () => {
      const currentReturn = new Date('2026-05-15T00:00:00Z');
      const sameReturn = new Date('2026-05-15T00:00:00Z');

      prisma.reservation.findFirst = async () => ({
        id: 'res-1',
        tenantId: 'tenant-1',
        status: 'CONFIRMED',
        returnAt: currentReturn,
        pickupAt: new Date('2026-05-10T00:00:00Z'),
        dailyRate: 50,
        pricingSnapshot: { dailyRate: 50 },
        charges: []
      });

      try {
        await reservationExtendService.extendReservation({
          reservationId: 'res-1',
          newReturnAt: sameReturn,
          extensionDailyRate: null,
          note: '',
          actorUserId: 'user-1',
          tenantScope: { tenantId: 'tenant-1' }
        });
        assert.fail('Expected an error');
      } catch (e) {
        assert.match(e.message, /New return date must be after/);
      }
    });

    it('rejects when reservation status is CANCELLED', async () => {
      const currentReturn = new Date('2026-05-15T00:00:00Z');
      const nextReturn = new Date('2026-05-20T00:00:00Z');

      prisma.reservation.findFirst = async () => ({
        id: 'res-1',
        tenantId: 'tenant-1',
        status: 'CANCELLED',
        returnAt: currentReturn,
        pickupAt: new Date('2026-05-10T00:00:00Z'),
        dailyRate: 50,
        pricingSnapshot: { dailyRate: 50 },
        charges: []
      });

      try {
        await reservationExtendService.extendReservation({
          reservationId: 'res-1',
          newReturnAt: nextReturn,
          extensionDailyRate: null,
          note: '',
          actorUserId: 'user-1',
          tenantScope: { tenantId: 'tenant-1' }
        });
        assert.fail('Expected an error');
      } catch (e) {
        assert.match(e.message, /Cannot extend a reservation with status/);
      }
    });

    it('rejects when reservation status is CHECKED_IN', async () => {
      const currentReturn = new Date('2026-05-15T00:00:00Z');
      const nextReturn = new Date('2026-05-20T00:00:00Z');

      prisma.reservation.findFirst = async () => ({
        id: 'res-1',
        tenantId: 'tenant-1',
        status: 'CHECKED_IN',
        returnAt: currentReturn,
        pickupAt: new Date('2026-05-10T00:00:00Z'),
        dailyRate: 50,
        pricingSnapshot: { dailyRate: 50 },
        charges: []
      });

      try {
        await reservationExtendService.extendReservation({
          reservationId: 'res-1',
          newReturnAt: nextReturn,
          extensionDailyRate: null,
          note: '',
          actorUserId: 'user-1',
          tenantScope: { tenantId: 'tenant-1' }
        });
        assert.fail('Expected an error');
      } catch (e) {
        assert.match(e.message, /Cannot extend a reservation with status/);
      }
    });

    it('rejects when extensionDailyRate is non-numeric (string "abc")', async () => {
      const currentReturn = new Date('2026-05-15T00:00:00Z');
      const nextReturn = new Date('2026-05-20T00:00:00Z');

      prisma.reservation.findFirst = async () => ({
        id: 'res-1',
        tenantId: 'tenant-1',
        status: 'CONFIRMED',
        returnAt: currentReturn,
        pickupAt: new Date('2026-05-10T00:00:00Z'),
        dailyRate: 50,
        pricingSnapshot: { dailyRate: 50 },
        charges: []
      });

      try {
        await reservationExtendService.extendReservation({
          reservationId: 'res-1',
          newReturnAt: nextReturn,
          extensionDailyRate: 'abc',
          note: '',
          actorUserId: 'user-1',
          tenantScope: { tenantId: 'tenant-1' }
        });
        assert.fail('Expected an error');
      } catch (e) {
        assert.match(e.message, /must be a valid number/);
      }
    });

    it('rejects when extensionDailyRate is negative', async () => {
      const currentReturn = new Date('2026-05-15T00:00:00Z');
      const nextReturn = new Date('2026-05-20T00:00:00Z');

      prisma.reservation.findFirst = async () => ({
        id: 'res-1',
        tenantId: 'tenant-1',
        status: 'CONFIRMED',
        returnAt: currentReturn,
        pickupAt: new Date('2026-05-10T00:00:00Z'),
        dailyRate: 50,
        pricingSnapshot: { dailyRate: 50 },
        charges: []
      });

      try {
        await reservationExtendService.extendReservation({
          reservationId: 'res-1',
          newReturnAt: nextReturn,
          extensionDailyRate: -10,
          note: '',
          actorUserId: 'user-1',
          tenantScope: { tenantId: 'tenant-1' }
        });
        assert.fail('Expected an error');
      } catch (e) {
        assert.match(e.message, /cannot be negative/);
      }
    });
  });

  describe('extendReservation happy path', () => {
    beforeEach(() => {
      const currentReturn = new Date('2026-05-15T00:00:00Z');

      prisma.reservation.findFirst = async (args) => {
        findFirstCalls.push(args);
        return {
          id: 'res-1',
          tenantId: 'tenant-1',
          status: 'CONFIRMED',
          returnAt: currentReturn,
          pickupAt: new Date('2026-05-10T00:00:00Z'),
          dailyRate: 50,
          pricingSnapshot: { dailyRate: 50 },
          charges: [
            {
              id: 'charge-1',
              reservationId: 'res-1',
              chargeType: 'DAILY',
              quantity: 5,
              rate: 50,
              total: 250,
              selected: true,
              sortOrder: 0
            }
          ]
        };
      };

      prisma.reservation.update = async (args) => {
        updateCalls.push(args);
        return {
          id: 'res-1',
          returnAt: args.data.returnAt || new Date('2026-05-20T00:00:00Z'),
          estimatedTotal: args.data.estimatedTotal
        };
      };

      prisma.reservationCharge.create = async (args) => {
        createChargeCalls.push(args);
        return {
          id: 'charge-ext-1',
          ...args.data
        };
      };

      // Mock findMany used by the service to recompute estimatedTotal
      // after the extension charge is created. Returns the original
      // base charge + the just-created extension charge.
      prisma.reservationCharge.findMany = async () => {
        const base = {
          id: 'charge-1',
          reservationId: 'res-1',
          chargeType: 'DAILY',
          quantity: 5,
          rate: 50,
          total: 250,
          selected: true,
          sortOrder: 0
        };
        const ext = createChargeCalls.length > 0
          ? { id: 'charge-ext-1', ...createChargeCalls[createChargeCalls.length - 1].data }
          : null;
        return ext ? [base, ext] : [base];
      };

      prisma.auditLog.create = async (args) => {
        createAuditLogCalls.push(args);
        return { id: 'audit-1', ...args.data };
      };
    });

    it('happy path: extends with NO override (uses reservation.dailyRate)', async () => {
      const nextReturn = new Date('2026-05-20T00:00:00Z');

      const result = await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: nextReturn,
        extensionDailyRate: null,
        note: 'Customer requested',
        actorUserId: 'user-1',
        tenantScope: { tenantId: 'tenant-1' }
      });

      assert.ok(result.reservation);
      assert.ok(result.extensionCharge);
      assert.equal(result.extensionDays, 5);

      const charge = result.extensionCharge;
      assert.equal(charge.chargeType, 'DAILY');
      assert.equal(charge.quantity, 5);
      assert.equal(charge.rate, 50);
      assert.equal(charge.total, 250);
      assert.equal(charge.source, 'EXTENSION_DEFAULT');
      assert.equal(charge.code, 'EXTENSION_RATE');
    });

    it('happy path: extends with custom extensionDailyRate override', async () => {
      const nextReturn = new Date('2026-05-20T00:00:00Z');

      const result = await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: nextReturn,
        extensionDailyRate: 75,
        note: 'Special rate applied',
        actorUserId: 'user-1',
        tenantScope: { tenantId: 'tenant-1' }
      });

      assert.ok(result.extensionCharge);
      assert.equal(result.extensionDays, 5);

      const charge = result.extensionCharge;
      assert.equal(charge.chargeType, 'DAILY');
      assert.equal(charge.quantity, 5);
      assert.equal(charge.rate, 75);
      assert.equal(charge.total, 375);
      assert.equal(charge.source, 'EXTENSION_OVERRIDE');
    });

    it('happy path: allows extensionDailyRate = 0 (free extension)', async () => {
      const nextReturn = new Date('2026-05-20T00:00:00Z');

      const result = await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: nextReturn,
        extensionDailyRate: 0,
        note: 'Complimentary extension',
        actorUserId: 'user-1',
        tenantScope: { tenantId: 'tenant-1' }
      });

      assert.ok(result.extensionCharge);
      const charge = result.extensionCharge;
      assert.equal(charge.rate, 0);
      assert.equal(charge.total, 0);
      assert.equal(charge.source, 'EXTENSION_OVERRIDE');
    });

    it('creates correct audit log entry', async () => {
      const nextReturn = new Date('2026-05-20T00:00:00Z');

      await reservationExtendService.extendReservation({
        reservationId: 'res-1',
        newReturnAt: nextReturn,
        extensionDailyRate: 60,
        note: 'Extended by agent',
        actorUserId: 'user-1',
        tenantScope: { tenantId: 'tenant-1' }
      });

      assert.equal(createAuditLogCalls.length, 1);
      const auditCall = createAuditLogCalls[0];
      const metadata = JSON.parse(auditCall.data.metadata);
      assert.equal(metadata.reservationExtended, true);
      assert.equal(metadata.extensionDays, 5);
      assert.equal(metadata.extensionDailyRate, 60);
      assert.equal(metadata.note, 'Extended by agent');
    });
  });
});
