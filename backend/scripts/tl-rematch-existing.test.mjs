// scripts/tl-rematch-existing.test.mjs
//
// Drives runRematch() / processOne() against a stubbed Prisma so we
// can verify the decision branches end-to-end without touching the
// database.
//
// Run: `node --test scripts/tl-rematch-existing.test.mjs` from backend/.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runRematch,
  processOne,
  buildCustomerCreateData,
  buildReservationCreateData,
  canAutoCreateCustomer,
} from './tl-rematch-existing.mjs';

const TENANT = 'tenant-1';

function silentLogger() {
  return { log: () => {}, lines: [] };
}

function makeStubPrisma(opts = {}) {
  const {
    externalReservations = [],
    acrissMaps = [],        // [{ tenantId, acrissCode, vehicleCategory }]
    locationCodeMaps = [],  // [{ tenantId, externalCode, location:{id,code,name} }]
    customers = [],         // pre-existing customers for match
    vehicleTypes = [],      // [{ tenantId, id, code }]
  } = opts;

  const calls = {
    customerCreate: [],
    reservationCreate: [],
    externalReservationUpdate: [],
  };

  const tx = {
    externalReservation: {
      findUnique: async ({ where }) =>
        externalReservations.find((r) => r.id === where.id) || null,
      update: async ({ where, data }) => {
        const row = externalReservations.find((r) => r.id === where.id);
        Object.assign(row, data);
        calls.externalReservationUpdate.push({ where, data });
        return row;
      },
    },
    customer: {
      create: async ({ data }) => {
        const created = { id: `cust-new-${calls.customerCreate.length + 1}`, ...data };
        customers.push(created);
        calls.customerCreate.push({ data });
        return created;
      },
    },
    reservation: {
      create: async ({ data }) => {
        const created = { id: `res-new-${calls.reservationCreate.length + 1}`, ...data };
        calls.reservationCreate.push({ data });
        return created;
      },
    },
  };

  return {
    calls,
    externalReservation: {
      findMany: async (args) => {
        let rows = externalReservations.filter(
          (r) => r.sourceSystem === args.where.sourceSystem &&
                 args.where.promotionStatus.in.includes(r.promotionStatus),
        );
        if (args.take) rows = rows.slice(0, args.take);
        return rows;
      },
      findUnique: tx.externalReservation.findUnique,
      update: tx.externalReservation.update,
    },
    customer: {
      findMany: async ({ where }) => {
        const tenantId = where?.tenantId;
        // email path
        if (where.email?.equals !== undefined) {
          return customers.filter(
            (c) => c.tenantId === tenantId &&
                   (c.email || '').toLowerCase() === where.email.equals.toLowerCase(),
          );
        }
        // phone path
        if (where.phone?.contains) {
          return customers.filter(
            (c) => c.tenantId === tenantId &&
                   (c.phone || '').includes(where.phone.contains),
          );
        }
        return [];
      },
      create: tx.customer.create,
    },
    reservation: {
      create: tx.reservation.create,
    },
    acrissCategoryMap: {
      findUnique: async ({ where }) =>
        acrissMaps.find(
          (m) => m.tenantId === where.tenantId_acrissCode.tenantId &&
                 m.acrissCode === where.tenantId_acrissCode.acrissCode,
        ) || null,
      findFirst: async ({ where }) =>
        acrissMaps.find(
          (m) => m.tenantId === where.tenantId && m.acrissCode === where.acrissCode,
        ) || null,
    },
    locationCodeMap: {
      findUnique: async ({ where }) =>
        locationCodeMaps.find(
          (m) => m.tenantId === where.tenantId_externalCode.tenantId &&
                 m.externalCode === where.tenantId_externalCode.externalCode,
        ) || null,
    },
    vehicleType: {
      findFirst: async ({ where }) => {
        const code = where.code?.equals?.toLowerCase();
        return vehicleTypes.find(
          (v) => v.tenantId === where.tenantId && (v.code || '').toLowerCase() === code,
        ) || null;
      },
    },
    $transaction: async (fn) => fn(tx),
  };
}

const ACRISS = { tenantId: TENANT, acrissCode: 'CCAR', vehicleCategory: 'CFAR' };
const LOC = {
  tenantId: TENANT,
  externalCode: 'SJUA01',
  location: { id: 'loc-sju', code: 'SJU', name: 'San Juan' },
};
const VT = { tenantId: TENANT, id: 'vt-cfar', code: 'CFAR' };

const baseExt = (overrides = {}) => ({
  id: 'ext-1',
  tenantId: TENANT,
  sourceSystem: 'TL_INTERNATIONAL',
  externalRef: 'ZE40781622BA',
  promotionStatus: 'MANUAL_REVIEW',
  needsReviewReason: 'acriss_unmapped',
  currency: 'USD',
  vehicleAcriss: 'CCAR',
  pickupLocation: 'San Juan Airport (SJUA01)',
  dropoffLocation: 'San Juan Airport (SJUA01)',
  pickupAt: new Date('2026-05-21T15:00:00Z'),
  dropoffAt: new Date('2026-05-25T15:00:00Z'),
  customerFirstName: 'Jahleya',
  customerLastName: 'Smith',
  customerEmail: 'JAHLEYASMITH@GMAIL.COM',
  customerPhone: '+1 787 555 1234',
  customerCountry: 'US',
  totalAmount: '450.00',
  ...overrides,
});

describe('canAutoCreateCustomer', () => {
  it('returns true when email present', () => {
    assert.equal(canAutoCreateCustomer({ customerEmail: 'a@b.c' }), true);
  });
  it('returns true when both first + last present', () => {
    assert.equal(
      canAutoCreateCustomer({ customerFirstName: 'A', customerLastName: 'B' }),
      true,
    );
  });
  it('returns false when neither email nor full name', () => {
    assert.equal(canAutoCreateCustomer({}), false);
  });
});

describe('buildCustomerCreateData', () => {
  it('fills required fields and falls back phone to email when missing', () => {
    const data = buildCustomerCreateData({
      tenantId: TENANT,
      externalRef: 'ZE40781622BA',
      customerEmail: 'a@b.c',
      customerFirstName: 'A',
      customerLastName: 'B',
      customerPhone: '',
    });
    assert.equal(data.tenantId, TENANT);
    assert.equal(data.firstName, 'A');
    assert.equal(data.email, 'a@b.c');
    assert.equal(data.phone, 'a@b.c'); // fell back to email
  });
  it('falls back phone to tl:ref when no email nor phone', () => {
    const data = buildCustomerCreateData({
      tenantId: TENANT,
      externalRef: 'ZE40781622BA',
      customerFirstName: 'A',
      customerLastName: 'B',
    });
    assert.equal(data.phone, 'tl:ZE40781622BA');
  });
});

describe('buildReservationCreateData', () => {
  it('produces a PENDING_FRANCHISE_IMPORT row with TL- prefix', () => {
    const data = buildReservationCreateData(baseExt(), 'cust-1', 'loc-sju', 'vt-cfar');
    assert.equal(data.reservationNumber, 'TL-ZE40781622BA');
    assert.equal(data.status, 'PENDING_FRANCHISE_IMPORT');
    assert.equal(data.customerId, 'cust-1');
    assert.equal(data.pickupLocationId, 'loc-sju');
    assert.equal(data.returnLocationId, 'loc-sju');
    assert.equal(data.vehicleTypeId, 'vt-cfar');
    assert.equal(data.estimatedTotal, 450);
    assert.equal(data.sendConfirmationEmail, false);
  });
  it('returns null estimatedTotal for malformed totalAmount', () => {
    const data = buildReservationCreateData(
      baseExt({ totalAmount: 'not-a-number' }),
      'cust-1', 'loc-sju', null,
    );
    assert.equal(data.estimatedTotal, null);
  });
});

describe('processOne — AUTO path', () => {
  it('promotes when all 5 checks pass and a customer matches', async () => {
    const existingCustomer = {
      id: 'cust-existing', tenantId: TENANT, firstName: 'Jahleya', lastName: 'Smith',
      email: 'jahleyasmith@gmail.com', phone: '+1 787 555 1234',
    };
    const ext = baseExt();
    const stub = makeStubPrisma({
      externalReservations: [ext],
      acrissMaps: [ACRISS],
      locationCodeMaps: [LOC],
      customers: [existingCustomer],
      vehicleTypes: [VT],
    });
    const res = await processOne(stub, ext, { commit: true, logger: silentLogger() });
    assert.equal(res.outcome, 'promoted');
    assert.equal(stub.calls.reservationCreate.length, 1);
    assert.equal(stub.calls.reservationCreate[0].data.reservationNumber, 'TL-ZE40781622BA');
    assert.equal(ext.promotionStatus, 'PROMOTED');
    assert.equal(ext.promotedByUserId, 'system');
  });
});

describe('processOne — customer_not_found auto-create path', () => {
  it('creates a customer + promotes when email present', async () => {
    const ext = baseExt();
    const stub = makeStubPrisma({
      externalReservations: [ext],
      acrissMaps: [ACRISS],
      locationCodeMaps: [LOC],
      customers: [], // none — forces customer_not_found
      vehicleTypes: [VT],
    });
    const res = await processOne(stub, ext, { commit: true, logger: silentLogger() });
    assert.equal(res.outcome, 'promoted');
    assert.equal(res.customerCreated, true);
    assert.equal(stub.calls.customerCreate.length, 1);
    assert.equal(stub.calls.customerCreate[0].data.firstName, 'Jahleya');
    assert.equal(stub.calls.reservationCreate.length, 1);
    assert.equal(ext.promotionStatus, 'PROMOTED');
  });
});

describe('processOne — left in review', () => {
  it('leaves currency_non_usd in review', async () => {
    const ext = baseExt({ currency: 'EUR' });
    const stub = makeStubPrisma({
      externalReservations: [ext],
      acrissMaps: [ACRISS],
      locationCodeMaps: [LOC],
    });
    const res = await processOne(stub, ext, { commit: true, logger: silentLogger() });
    assert.equal(res.outcome, 'left_in_review');
    assert.equal(res.reason, 'currency_non_usd');
    assert.equal(stub.calls.reservationCreate.length, 0);
    assert.equal(ext.needsReviewReason, 'currency_non_usd');
    assert.equal(ext.promotionStatus, 'MANUAL_REVIEW');
  });
});

describe('processOne — already promoted', () => {
  it('skips PROMOTED rows', async () => {
    const ext = baseExt({ promotionStatus: 'PROMOTED' });
    const stub = makeStubPrisma({ externalReservations: [ext] });
    const res = await processOne(stub, ext, { commit: true, logger: silentLogger() });
    assert.equal(res.outcome, 'skipped_promoted');
    assert.equal(stub.calls.reservationCreate.length, 0);
  });
  it('skips AUTO_PROMOTED rows', async () => {
    const ext = baseExt({ promotionStatus: 'AUTO_PROMOTED' });
    const stub = makeStubPrisma({ externalReservations: [ext] });
    const res = await processOne(stub, ext, { commit: true, logger: silentLogger() });
    assert.equal(res.outcome, 'skipped_promoted');
  });
});

describe('runRematch — idempotency', () => {
  it('running twice produces no further writes after commit', async () => {
    const ext = baseExt();
    const stub = makeStubPrisma({
      externalReservations: [ext],
      acrissMaps: [ACRISS],
      locationCodeMaps: [LOC],
      vehicleTypes: [VT],
    });

    const first = await runRematch(stub, { commit: true, logger: silentLogger() });
    assert.equal(first.promoted, 1);
    assert.equal(first.customersCreated, 1);
    const writesAfterFirst = stub.calls.reservationCreate.length;

    const second = await runRematch(stub, { commit: true, logger: silentLogger() });
    assert.equal(second.scanned, 0); // filter excludes PROMOTED
    assert.equal(stub.calls.reservationCreate.length, writesAfterFirst);
  });
});

describe('runRematch — dry run is read-only', () => {
  it('does not write in dry-run mode', async () => {
    const ext = baseExt();
    const stub = makeStubPrisma({
      externalReservations: [ext],
      acrissMaps: [ACRISS],
      locationCodeMaps: [LOC],
      vehicleTypes: [VT],
    });
    const summary = await runRematch(stub, { commit: false, logger: silentLogger() });
    assert.equal(summary.promoted, 1);
    assert.equal(summary.customersCreated, 1);
    assert.equal(stub.calls.reservationCreate.length, 0);
    assert.equal(stub.calls.customerCreate.length, 0);
    assert.equal(ext.promotionStatus, 'MANUAL_REVIEW'); // unchanged
  });
});
