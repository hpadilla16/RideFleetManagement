import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePromotion,
  extractLocationCode,
  normalizePhone,
  jaroWinkler,
  REVIEW_REASONS,
} from './promotion-matcher.service.js';

// ----------------------------------------------------------------------------
// Helpers — synthetic Prisma stub
// ----------------------------------------------------------------------------

function makePrismaStub({
  acrissTenant = null,
  acrissGlobal = null,
  location = null,
  customers = [],
} = {}) {
  return {
    acrissCategoryMap: {
      findUnique: async ({ where }) =>
        acrissTenant && where.tenantId_acrissCode.acrissCode === acrissTenant.acrissCode
          ? acrissTenant
          : null,
      findFirst: async ({ where }) =>
        acrissGlobal && where.tenantId === null && where.acrissCode === acrissGlobal.acrissCode
          ? acrissGlobal
          : null,
    },
    locationCodeMap: {
      findUnique: async ({ where }) =>
        location && location.externalCode === where.tenantId_externalCode.externalCode
          ? { ...location, location: location.location }
          : null,
    },
    customer: {
      findMany: async ({ where }) => {
        return customers.filter((c) => {
          if (where.email) {
            if (!c.email) return false;
            return String(c.email).toLowerCase() === String(where.email.equals).toLowerCase();
          }
          if (where.phone) {
            // Mirror Prisma's `contains` semantics liberally — also tolerate
            // stored phones with formatting (dashes, spaces) by comparing
            // their digit-only suffix.
            if (!c.phone) return false;
            const needle = where.phone.contains;
            const haystackDigits = String(c.phone).replace(/\D+/g, '');
            return c.phone.includes(needle) || haystackDigits.endsWith(needle);
          }
          return false;
        });
      },
    },
  };
}

const TENANT_ID = 'tnt_abc';
const baseExt = {
  tenantId: TENANT_ID,
  currency: 'USD',
  vehicleAcriss: 'CCAR',
  pickupLocation: 'San Juan Airport (SJUA01)',
  customerEmail: 'john@example.com',
  customerPhone: '+1 (787) 555-1234',
  customerFirstName: 'John',
  customerLastName: 'Doe',
};

const goodAcriss = { acrissCode: 'CCAR', vehicleCategory: 'COMPACT' };
const goodLoc = {
  externalCode: 'SJUA01',
  location: { id: 'loc_sju', code: 'SJU', name: 'San Juan Airport' },
};

// ----------------------------------------------------------------------------
// 1. currency_non_usd
// ----------------------------------------------------------------------------

test('branch: currency non-USD → MANUAL_REVIEW currency_non_usd', async () => {
  const prisma = makePrismaStub({ acrissTenant: goodAcriss, location: goodLoc });
  const res = await evaluatePromotion({ ...baseExt, currency: 'EUR' }, { prisma });
  assert.equal(res.decision, 'MANUAL_REVIEW');
  assert.equal(res.reason, REVIEW_REASONS.CURRENCY_NON_USD);
});

// ----------------------------------------------------------------------------
// 2. acriss_unmapped
// ----------------------------------------------------------------------------

test('branch: ACRISS unmapped → MANUAL_REVIEW acriss_unmapped', async () => {
  const prisma = makePrismaStub({ /* no acriss */ location: goodLoc });
  const res = await evaluatePromotion(baseExt, { prisma });
  assert.equal(res.decision, 'MANUAL_REVIEW');
  assert.equal(res.reason, REVIEW_REASONS.ACRISS_UNMAPPED);
});

test('branch: ACRISS missing on row → MANUAL_REVIEW acriss_unmapped', async () => {
  const prisma = makePrismaStub({ acrissTenant: goodAcriss, location: goodLoc });
  const res = await evaluatePromotion({ ...baseExt, vehicleAcriss: null }, { prisma });
  assert.equal(res.decision, 'MANUAL_REVIEW');
  assert.equal(res.reason, REVIEW_REASONS.ACRISS_UNMAPPED);
});

test('branch: ACRISS global fallback wins when tenant row absent', async () => {
  const prisma = makePrismaStub({
    acrissGlobal: { acrissCode: 'CCAR', vehicleCategory: 'COMPACT_GLOBAL' },
    location: goodLoc,
    customers: [{ id: 'c1', email: 'john@example.com', firstName: 'John', lastName: 'Doe', phone: '7875551234' }],
  });
  const res = await evaluatePromotion(baseExt, { prisma });
  assert.equal(res.decision, 'AUTO');
  assert.equal(res.mappedVehicleCategory, 'COMPACT_GLOBAL');
});

// ----------------------------------------------------------------------------
// 3. location_unmapped
// ----------------------------------------------------------------------------

test('branch: location code missing in pickupLocation → MANUAL_REVIEW location_unmapped', async () => {
  const prisma = makePrismaStub({ acrissTenant: goodAcriss });
  const res = await evaluatePromotion(
    { ...baseExt, pickupLocation: 'somewhere with no code', dropoffLocation: null },
    { prisma }
  );
  assert.equal(res.decision, 'MANUAL_REVIEW');
  assert.equal(res.reason, REVIEW_REASONS.LOCATION_UNMAPPED);
});

test('branch: location code present but no LocationCodeMap row → location_unmapped', async () => {
  const prisma = makePrismaStub({ acrissTenant: goodAcriss /* no location */ });
  const res = await evaluatePromotion(baseExt, { prisma });
  assert.equal(res.decision, 'MANUAL_REVIEW');
  assert.equal(res.reason, REVIEW_REASONS.LOCATION_UNMAPPED);
});

// ----------------------------------------------------------------------------
// 4. customer_not_found / multiple_matches
// ----------------------------------------------------------------------------

test('branch: zero customer matches → customer_not_found', async () => {
  const prisma = makePrismaStub({
    acrissTenant: goodAcriss,
    location: goodLoc,
    customers: [],
  });
  const res = await evaluatePromotion(baseExt, { prisma });
  assert.equal(res.decision, 'MANUAL_REVIEW');
  assert.equal(res.reason, REVIEW_REASONS.CUSTOMER_NOT_FOUND);
});

test('branch: two email matches → multiple_matches', async () => {
  const prisma = makePrismaStub({
    acrissTenant: goodAcriss,
    location: goodLoc,
    customers: [
      { id: 'c1', email: 'john@example.com', firstName: 'John', lastName: 'Doe', phone: '7875551234' },
      { id: 'c2', email: 'john@example.com', firstName: 'Johnny', lastName: 'Doe', phone: '7875550000' },
    ],
  });
  const res = await evaluatePromotion(baseExt, { prisma });
  assert.equal(res.decision, 'MANUAL_REVIEW');
  assert.equal(res.reason, REVIEW_REASONS.MULTIPLE_MATCHES);
});

test('branch: phone + fuzzy name match wins when email missing', async () => {
  const prisma = makePrismaStub({
    acrissTenant: goodAcriss,
    location: goodLoc,
    customers: [
      { id: 'c1', email: null, firstName: 'Jon', lastName: 'Doe', phone: '+1-787-555-1234' },
    ],
  });
  const res = await evaluatePromotion({ ...baseExt, customerEmail: null }, { prisma });
  assert.equal(res.decision, 'AUTO');
  assert.equal(res.mappedCustomer.id, 'c1');
});

// ----------------------------------------------------------------------------
// 5. happy path
// ----------------------------------------------------------------------------

test('branch: all gates pass → AUTO with mapped customer/category/location', async () => {
  const prisma = makePrismaStub({
    acrissTenant: goodAcriss,
    location: goodLoc,
    customers: [{ id: 'c1', email: 'john@example.com', firstName: 'John', lastName: 'Doe', phone: '7875551234' }],
  });
  const res = await evaluatePromotion(baseExt, { prisma });
  assert.equal(res.decision, 'AUTO');
  assert.equal(res.mappedCustomer.id, 'c1');
  assert.equal(res.mappedVehicleCategory, 'COMPACT');
  assert.equal(res.mappedLocation.id, 'loc_sju');
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

test('extractLocationCode parses trailing parenthesized codes', () => {
  assert.equal(extractLocationCode('San Juan Airport (SJUA01)'), 'SJUA01');
  assert.equal(extractLocationCode('Aguadilla (BQN02)'), 'BQN02');
  assert.equal(extractLocationCode('no code here'), null);
  assert.equal(extractLocationCode(null), null);
  assert.equal(extractLocationCode(''), null);
});

test('normalizePhone strips non-digits and keeps last 10', () => {
  assert.equal(normalizePhone('+1 (787) 555-1234'), '7875551234');
  assert.equal(normalizePhone('787.555.1234'), '7875551234');
  assert.equal(normalizePhone('555-1234'), '5551234');
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
});

test('jaroWinkler is 1 for identical, 0 for empty, monotonic in similarity', () => {
  assert.equal(jaroWinkler('John Doe', 'John Doe'), 1);
  assert.equal(jaroWinkler('', ''), 1);
  assert.equal(jaroWinkler('John', ''), 0);
  assert.ok(jaroWinkler('John Doe', 'Jon Doe') > 0.85);
  assert.ok(jaroWinkler('Carlos Vega', 'Robert Smith') < 0.7);
});
