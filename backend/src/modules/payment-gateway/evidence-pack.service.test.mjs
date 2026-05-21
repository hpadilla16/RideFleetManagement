/**
 * Tests for evidence-pack.service.js (2026-05-21).
 * Run: node --test backend/src/modules/payment-gateway/evidence-pack.service.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEvidencePackForReservation,
  EvidencePackError,
} from './evidence-pack.service.js';

function makeFakePrisma({ reservation } = {}) {
  return {
    reservation: {
      async findFirst({ where }) {
        if (!reservation) return null;
        if (where.id !== reservation.id) return null;
        if (where.tenantId && reservation.tenantId !== where.tenantId) return null;
        return reservation;
      },
    },
  };
}

const SAMPLE = {
  id: 'r1',
  tenantId: 't1',
  status: 'COMPLETED',
  pickupAt: new Date('2026-05-21T14:00:00Z'),
  returnAt: new Date('2026-05-24T14:00:00Z'),
  signingCompletedAt: new Date('2026-05-21T15:00:00Z'),
  estimatedTotal: 300,
  tenant: { id: 't1', name: 'Pilot' },
  pickupLocation: { id: 'l_sju', code: 'SJU', name: 'San Juan Airport' },
  returnLocation: { id: 'l_sju', code: 'SJU', name: 'San Juan Airport' },
  vehicle: {
    id: 'v1', plate: 'ABC123', year: 2024, make: 'Toyota', model: 'RAV4',
    vehicleType: { code: 'SFAR', name: 'Standard SUV' },
  },
  customer: {
    id: 'c1', firstName: 'M', lastName: 'Rivera', email: 'm@example.com',
    phone: '+1-787-555-0100', licenseNumber: 'PR-12345',
  },
  charges: [
    { id: 'ch1', code: 'BASE', name: 'Base rate', chargeType: 'UNIT',
      quantity: 3, rate: 75, total: 225, taxable: true, source: null, sourceRefId: null },
  ],
  rentalAgreement: {
    id: 'ag1', agreementNumber: 'AG-001', dailyRate: 75, totalDays: 3,
    status: 'CLOSED', signedAt: new Date(), closedAt: new Date(),
  },
  signing: {
    id: 'sgn1',
    surfaceUsed: 'DEJAVOO_TERMINAL',
    startedAt: new Date(),
    completedAt: new Date(),
    customerName: 'M Rivera',
    customerLicense: 'PR-12345',
    ipAddress: '10.0.0.1',
    userAgent: 'Counter Tablet',
    signedPdfStoragePath: 'tenants/t1/reservations/r1/signing/agreement-1.pdf',
    template: { id: 'tpl1', name: 'Pilot', version: '1.0', contentLanguage: 'en' },
    fields: [
      {
        id: 'sf1',
        templateField: { kind: 'INITIAL', label: 'S4', markerKey: 'INIT_S4', order: 0 },
        value: null,
        signedAt: new Date(),
        signatureSvgOrPath: 'tenants/t1/reservations/r1/signing/initial-INIT_S4-x.png',
      },
      {
        id: 'sf2',
        templateField: { kind: 'SIGNATURE', label: 'Sign', markerKey: 'SIG_RENTER', order: 1 },
        value: null,
        signedAt: new Date(),
        signatureSvgOrPath: 'tenants/t1/reservations/r1/signing/agreement-SIG_RENTER-x.png',
      },
    ],
  },
  dejavooTransactions: [
    {
      id: 'tx_auth',
      type: 'AUTH',
      referenceId: 'AUTH-r1-1',
      amountCents: 25000,
      invoiceNumber: 'r1',
      customLabel: 'Pre-auth at pickup',
      approved: true,
      statusCode: '0000',
      authCode: 'AUTH123',
      cardLast4: '4242',
      cardBrand: 'VISA',
      cardEntryType: 'CHIP',
      iposToken: 'tok_xyz',
      errorMessage: null,
      signatureStoragePath: null,
      parentTransactionId: null,
      startedAt: new Date(),
      completedAt: new Date(),
      callbackReceivedAt: new Date(),
      terminal: { id: 'term1', name: 'Counter SJU', tpn: '12345', merchantNumber: 1 },
    },
    {
      id: 'tx_cap',
      type: 'CAPTURE',
      referenceId: 'CAP-r1-1',
      amountCents: 22500,
      invoiceNumber: 'r1',
      customLabel: 'Capture at return',
      approved: true,
      statusCode: '0000',
      authCode: 'CAP456',
      cardLast4: '4242',
      cardBrand: 'VISA',
      cardEntryType: 'CHIP',
      iposToken: null,
      errorMessage: null,
      signatureStoragePath: 'tenants/t1/reservations/r1/signing/receipt-x.png',
      parentTransactionId: 'tx_auth',
      startedAt: new Date(),
      completedAt: new Date(),
      callbackReceivedAt: new Date(),
      terminal: { id: 'term1', name: 'Counter SJU', tpn: '12345', merchantNumber: 1 },
    },
  ],
  inspections: [
    {
      id: 'i_pre', stage: 'PRE', capturedAt: new Date(), capturedByType: 'CUSTOMER',
      signedByName: 'M Rivera', signedAt: new Date(),
      media: [
        { id: 'm1', kind: 'PHOTO', position: 'FRONT', storagePath: 'tenants/t1/inspections/i_pre/FRONT_m1.jpg',
          contentType: 'image/jpeg', sizeBytes: 1024, capturedAt: new Date() },
      ],
      findings: [],
    },
  ],
};

const SIGNERS = {
  async signSignatureUrl(path) {
    return `https://signed/${path}`;
  },
  async signSignatureUrls(rows) {
    return rows.map((r) => ({
      ...r,
      signedUrl: r.signatureSvgOrPath ? `https://signed/${r.signatureSvgOrPath}` : null,
    }));
  },
  async signInspectionMediaRows(rows) {
    return rows.map((r) => ({ ...r, signedUrl: `https://signed/${r.storagePath}` }));
  },
};

test('buildEvidencePackForReservation rejects missing args', async () => {
  await assert.rejects(
    () => buildEvidencePackForReservation({ tenantScope: { tenantId: 't1' } }),
    /reservationId required/
  );
  await assert.rejects(
    () => buildEvidencePackForReservation({ reservationId: 'r1' }),
    /tenantScope required/
  );
});

test('buildEvidencePackForReservation 404 when reservation missing', async () => {
  const prisma = makeFakePrisma({ reservation: null });
  await assert.rejects(
    () =>
      buildEvidencePackForReservation({
        reservationId: 'r_nope',
        tenantScope: { tenantId: 't1' },
        prisma,
        signers: SIGNERS,
      }),
    (err) => err instanceof EvidencePackError && err.status === 404
  );
});

test('buildEvidencePackForReservation returns full bundle', async () => {
  const prisma = makeFakePrisma({ reservation: SAMPLE });
  const pack = await buildEvidencePackForReservation({
    reservationId: 'r1',
    tenantScope: { tenantId: 't1' },
    prisma,
    signers: SIGNERS,
  });
  // Top-level keys
  assert.ok(pack.generatedAt);
  assert.equal(typeof pack.evidenceUrlTtlSeconds, 'number');
  assert.equal(pack.reservation.id, 'r1');
  assert.equal(pack.customer.email, 'm@example.com');
  assert.equal(pack.tenant.id, 't1');
  assert.equal(pack.agreement.agreementNumber, 'AG-001');
  // Card data lifted from the AUTH transaction
  assert.equal(pack.cardData.last4, '4242');
  assert.equal(pack.cardData.brand, 'VISA');
  // Auth codes list
  assert.equal(pack.authCodes.length, 2, 'AUTH + CAPTURE both have authCode');
  // Signing
  assert.equal(pack.signing.surfaceUsed, 'DEJAVOO_TERMINAL');
  assert.equal(pack.signing.signedPdfUrl, 'https://signed/tenants/t1/reservations/r1/signing/agreement-1.pdf');
  assert.equal(pack.signing.fields.length, 2);
  assert.match(pack.signing.fields[0].signedUrl, /^https:\/\/signed\//);
  // Transactions enriched with signatureUrl when present
  const capTx = pack.transactions.find((t) => t.id === 'tx_cap');
  assert.match(capTx.signatureUrl, /^https:\/\/signed\//);
  // Inspections enriched with media signed URLs
  assert.equal(pack.inspections.length, 1);
  assert.match(pack.inspections[0].media[0].signedUrl, /^https:\/\/signed\//);
  // Merchant card lifted from terminal
  assert.equal(pack.merchant.terminalName, 'Counter SJU');
  assert.equal(pack.merchant.tpn, '12345');
});

test('buildEvidencePackForReservation tolerates missing signing/inspections', async () => {
  const minimal = { ...SAMPLE, signing: null, inspections: [], dejavooTransactions: [] };
  const prisma = makeFakePrisma({ reservation: minimal });
  const pack = await buildEvidencePackForReservation({
    reservationId: 'r1',
    tenantScope: { tenantId: 't1' },
    prisma,
    signers: SIGNERS,
  });
  assert.equal(pack.signing, null);
  assert.deepEqual(pack.inspections, []);
  assert.deepEqual(pack.transactions, []);
  assert.equal(pack.cardData, null, 'no AUTH → no cardData');
  assert.equal(pack.merchant, null);
  assert.deepEqual(pack.authCodes, []);
});

test('buildEvidencePackForReservation degrades when signer throws', async () => {
  const prisma = makeFakePrisma({ reservation: SAMPLE });
  const badSigners = {
    async signSignatureUrl() { throw new Error('signer down'); },
    async signSignatureUrls(rows) {
      return rows.map((r) => ({ ...r, signedUrl: null }));
    },
    async signInspectionMediaRows(rows) {
      return rows.map((r) => ({ ...r, signedUrl: null }));
    },
  };
  const pack = await buildEvidencePackForReservation({
    reservationId: 'r1',
    tenantScope: { tenantId: 't1' },
    prisma,
    signers: badSigners,
  });
  assert.equal(pack.signing.signedPdfUrl, null);
  for (const tx of pack.transactions) {
    if (tx.signatureStoragePath) {
      assert.equal(tx.signatureUrl, null, 'signer error degrades cleanly');
    }
  }
});
