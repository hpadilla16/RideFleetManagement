/**
 * customer-erasure.test.mjs — GDPR erasure primitive.
 *
 * DB-FREE: drives eraseCustomer() against a small in-memory Prisma fake (the
 * account-deletion.test.mjs pattern) so it runs on a laptop in the npm chain.
 *
 * Proves the TWO SACRED INVARIANTS and full reconciliation:
 *   - flag OFF refuses to mutate (503) — nothing changes
 *   - dry-run (the default) mutates NOTHING and returns a plan
 *   - a real erase scrubs EVERY touched table (name/email/phone/DOB/licence gone)
 *   - retained agreement keeps agreementNumber + money + LAST name, loses
 *     DOB/licence/signature image
 *   - doNotRent suppression is set
 *   - re-running is a no-op (idempotent)
 *   - KYC/document Storage bytes + the AuthNet profile are reaped
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The service transitively imports lib/prisma.js, which constructs a
// PrismaClient at load time (it only needs a URL STRING — it never connects
// because every query in this suite goes through the injected in-memory fake).
// Set a dummy DATABASE_URL BEFORE the module graph loads, then dynamic-import.
process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db?schema=public';
process.env.NODE_ENV ||= 'test';

const { eraseCustomer, ErasureNotEnabledError } = await import('./customer-erasure.service.js');
const { REDACTION } = await import('./customer-pii-map.js');

// ---------------------------------------------------------------------------
// Tiny in-memory Prisma fake. Supports the query surface eraseCustomer uses:
// findFirst / findMany / count / updateMany / deleteMany / update + $transaction,
// with where matchers: scalar equals, { in }, { equals, mode:'insensitive' },
// null, OR, AND.
// ---------------------------------------------------------------------------
const MODELS = [
  'customer', 'reservation', 'rentalAgreement', 'loanerAgreement', 'loanerPhoto',
  'loanerRequest', 'trip', 'tripDocument', 'conversation', 'message', 'hostReview',
  'quote', 'agreementDriver', 'reservationAdditionalDriver', 'agreementSectionInitial',
  'rentalAgreementInspection', 'reservationIncident', 'vehicleDamageReport',
  'tripIncident', 'tripIncidentCommunication', 'shuttleRequest', 'kioskSession',
  'externalReservation', 'citation', 'citationDocument',
];

function matchCond(value, cond) {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    if ('in' in cond) return Array.isArray(cond.in) && cond.in.includes(value);
    if ('equals' in cond) {
      if (cond.mode === 'insensitive') {
        return String(value ?? '').toLowerCase() === String(cond.equals ?? '').toLowerCase();
      }
      return value === cond.equals;
    }
    return false;
  }
  // scalar (incl. null)
  return value === cond;
}

function matchWhere(row, where) {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!Array.isArray(cond) || !cond.some((w) => matchWhere(row, w))) return false;
    } else if (key === 'AND') {
      if (!Array.isArray(cond) || !cond.every((w) => matchWhere(row, w))) return false;
    } else if (!matchCond(row[key], cond)) {
      return false;
    }
  }
  return true;
}

function makeFake(seed) {
  const store = {};
  for (const m of MODELS) store[m] = (seed[m] || []).map((r) => ({ ...r }));

  const delegate = (name) => ({
    async findMany({ where, select } = {}) {
      let rows = store[name].filter((r) => matchWhere(r, where));
      rows = rows.map((r) => ({ ...r }));
      if (select) {
        rows = rows.map((r) => {
          const o = {};
          for (const k of Object.keys(select)) if (select[k]) o[k] = r[k];
          return o;
        });
      }
      return rows;
    },
    async findFirst({ where } = {}) {
      const r = store[name].find((row) => matchWhere(row, where));
      return r ? { ...r } : null;
    },
    async count({ where } = {}) {
      return store[name].filter((r) => matchWhere(r, where)).length;
    },
    async updateMany({ where, data } = {}) {
      let count = 0;
      for (const r of store[name]) {
        if (matchWhere(r, where)) { Object.assign(r, data); count += 1; }
      }
      return { count };
    },
    async deleteMany({ where } = {}) {
      const before = store[name].length;
      store[name] = store[name].filter((r) => !matchWhere(r, where));
      return { count: before - store[name].length };
    },
    async update({ where, data } = {}) {
      const r = store[name].find((row) => matchWhere(row, where));
      if (!r) throw new Error(`update: no ${name} row for ${JSON.stringify(where)}`);
      Object.assign(r, data);
      return { ...r };
    },
  });

  const client = { _store: store };
  for (const m of MODELS) client[m] = delegate(m);
  client.$transaction = async (fn) => fn(client);
  return client;
}

// ---------------------------------------------------------------------------
// Seed: a customer with the full spread of PII-bearing rows.
// ---------------------------------------------------------------------------
const PII = {
  email: 'john.doe@example.com',
  phone: '+15551234567',
  license: 'D1234567',
  dob: new Date('1990-01-15T00:00:00.000Z'),
  first: 'John',
  last: 'Doe',
  driverFirst: 'Jane',
};

function seedData() {
  return {
    customer: [{
      id: 'c1', tenantId: 't1',
      firstName: PII.first, lastName: PII.last, email: PII.email, phone: PII.phone,
      phoneNormalized: '15551234567', licenseNumber: PII.license, licenseState: 'FL',
      dateOfBirth: PII.dob, insurancePolicyNumber: 'POL-9', insuranceExpiry: PII.dob,
      insuranceDocumentUrl: 'https://cdn.example.com/ins.pdf', // external URL — nulled, not reaped
      address1: '1 Main St', address2: 'Apt 2', city: 'Miami', state: 'FL', zip: '33101',
      country: 'US', idPhotoUrl: 'tenants/t1/customers/c1/id-photo_abc.jpg',
      licenseBackUrl: 'inventory-photos:tenants/t1/customers/c1/license-back_x.jpg',
      locale: 'en', authnetCustomerProfileId: 'cust-prof-1', authnetPaymentProfileId: 'pay-prof-1',
      cardLast4: '4242', cardBrand: 'Visa', cardExpiresMonth: 12, cardExpiresYear: 2030,
      cardUpdatedAt: PII.dob, creditBalance: 25,
      portalResetToken: 'prt', guestAccessToken: 'gat', deletionToken: 'del-tok',
      notes: 'called about John Doe', doNotRent: false, doNotRentReason: null,
    }],
    reservation: [{
      id: 'r1', tenantId: 't1', customerId: 'c1', reservationNumber: 'RES-1',
      pickupAt: new Date('2026-01-01T10:00:00Z'), returnAt: new Date('2026-01-03T10:00:00Z'),
      signatureDataUrl: 'data:image/png;base64,AAAA', signatureSignedBy: PII.first,
      notes: `${PII.first} ${PII.last} underage`, flightNumber: 'AA123',
      pickupInstructions: 'call ' + PII.phone, customerInfoReviewNote: null,
      loanerBillingContactName: null, loanerBillingContactEmail: null,
      loanerBillingContactPhone: null, loanerBorrowerPacketJson: null,
    }],
    rentalAgreement: [{
      id: 'a1', tenantId: 't1', reservationId: 'r1', agreementNumber: 'RA-1',
      customerFirstName: PII.first, customerLastName: PII.last, customerEmail: PII.email,
      customerPhone: PII.phone, customerAddress1: '1 Main St', customerAddress2: 'Apt 2',
      customerCity: 'Miami', customerState: 'FL', customerZip: '33101', customerCountry: 'US',
      dateOfBirth: PII.dob, licenseNumber: PII.license, licenseState: 'FL', licenseExpiry: PII.dob,
      insurancePolicyNumber: 'POL-9', insuranceDocumentUrl: 'tenants/t1/customers/c1/insurance_y.pdf',
      tcSignatureDataUrl: 'data:image/png;base64,BBBB', tcSignerName: PII.first + ' ' + PII.last,
      tcCustomerIp: '203.0.113.7', tcSignedAt: new Date('2026-01-01T10:05:00Z'),
      declinedInsuranceSignatureDataUrl: 'data:image/png;base64,CCCC',
      cardOnFileToken: 'tok-xyz', cardOnFileLast4: '4242', cardOnFileBrand: 'Visa',
      cardOnFileType: 'CREDIT', notes: 'note about ' + PII.first,
      total: 100, subtotal: 90, taxes: 10, closedAt: new Date('2026-01-03T12:00:00Z'),
      returnedAt: new Date('2026-01-03T11:00:00Z'),
    }],
    agreementDriver: [{
      id: 'ad1', rentalAgreementId: 'a1', firstName: PII.driverFirst, lastName: 'Smith',
      email: 'jane@example.com', phone: '+15550000000', licenseNumber: 'S9999999',
      licenseState: 'FL', licenseExpiry: PII.dob, dateOfBirth: PII.dob, isPrimary: false,
    }],
    reservationAdditionalDriver: [{
      id: 'rad1', reservationId: 'r1', firstName: PII.driverFirst, lastName: 'Smith',
      address: '5 Oak Ave', dateOfBirth: PII.dob, licenseNumber: 'S9999999', notes: 'friend',
    }],
    agreementSectionInitial: [{
      id: 'asi1', agreementId: 'a1', sectionKey: 'insurance', sectionLabel: 'Insurance',
      initialDataUrl: 'data:image/png;base64,DDDD', signedAt: new Date('2026-01-01T10:04:00Z'),
      customerIp: '203.0.113.7',
    }],
    rentalAgreementInspection: [{
      id: 'ins1', rentalAgreementId: 'a1', phase: 'CHECKOUT', actorIp: '203.0.113.7',
      photosJson: '[{"path":"tenants/t1/insp/1.jpg"}]', photoStorageRefs: null, notes: 'clean',
    }],
    quote: [{
      id: 'q1', tenantId: 't1', quoteNumber: 'Q-1', customerId: 'c1',
      contactName: PII.first + ' ' + PII.last, contactPhone: PII.phone, contactEmail: PII.email,
      total: 120, status: 'ACTIVE',
    }],
    conversation: [{
      id: 'conv1', tenantId: 't1', customerId: 'c1', subject: 'Pickup for ' + PII.first,
      lastMessageText: 'see you at ' + PII.phone, pickupAddress: '1 Main St',
      pickupPhotoUrl: 'tenants/t1/pickup/p.jpg',
    }],
    message: [
      { id: 'msg1', conversationId: 'conv1', senderType: 'GUEST', senderName: PII.first, body: 'hi ' + PII.phone },
      { id: 'msg2', conversationId: 'conv1', senderType: 'HOST', senderName: 'Host', body: 'ok' },
    ],
    hostReview: [{
      id: 'hr1', tripId: 'tr1', hostProfileId: 'hp1', guestCustomerId: 'c1',
      rating: 5, comments: 'great guest ' + PII.first, reviewerName: PII.first + ' ' + PII.last,
    }],
    trip: [{
      id: 'tr1', tenantId: 't1', guestCustomerId: 'c1', tripCode: 'TRIP-1',
      notes: 'guest ' + PII.first + ' ' + PII.phone, quotedTotal: 200,
    }],
    tripDocument: [{
      id: 'td1', tripId: 'tr1', documentType: 'LICENSE', dataUrl: 'data:image/jpeg;base64,EEEE',
    }],
    shuttleRequest: [{
      id: 'sr1', tenantId: 't1', locationId: 'l1', reservationId: 'r1',
      customerName: PII.first + ' ' + PII.last, customerPhone: PII.phone,
      pickupNote: 'terminal 2', delayNoticesJson: '[{"to":"' + PII.phone + '"}]', closeReason: null,
    }],
    kioskSession: [{
      id: 'ks1', tenantId: 't1', deviceId: 'd1', reservationId: 'r1', kind: 'CHECKOUT',
      eventsJson: [{ step: 'ID', data: { name: PII.first } }], nameUpdateCodeHash: 'hash-abc',
      paymentIntentRef: 'intent-1', outcome: 'IN_PROGRESS',
    }],
    externalReservation: [{
      id: 'ext1', tenantId: 't1', sourceSystem: 'TL_INTERNATIONAL', externalRef: 'ZE1',
      customerFirstName: PII.first, customerLastName: PII.last, customerEmail: PII.email,
      customerPhone: PII.phone, customerCountry: 'US', flightNumber: 'AA123',
      rawJson: { name: PII.first + ' ' + PII.last, email: PII.email }, promotedToReservationId: 'r1',
    }],
    vehicleDamageReport: [{
      id: 'vdr1', tenantId: 't1', vehicleId: 'v1', reservationId: 'r1', phase: 'CHECKIN',
      view: 'FRONT', xPct: 10, yPct: 20, description: 'scratch',
      customerAckSignatureDataUrl: 'data:image/png;base64,FFFF',
      customerAckSignerName: PII.first + ' ' + PII.last, customerAckIp: '203.0.113.7',
      customerAckStatementText: 'I accept responsibility',
      customerAckSignedAt: new Date('2026-01-03T12:00:00Z'), // retained timestamp (distinct from DOB)
      photoJson: { storage: true, bucket: 'inspection-photos', refs: [{ path: 'tenants/t1/dmg/1.jpg' }] },
    }],
    citation: [{
      id: 'cit1', tenantId: 't1', reservationId: 'r1', citationNo: 'CIT-1', agency: 'City',
      amount: 50,
    }],
    citationDocument: [{
      id: 'cd1', tenantId: 't1', citationId: 'cit1',
      bucketPath: 'inventory-photos:tenants/t1/citations/cd1.pdf', ocrJson: '{"name":"John Doe"}',
    }],
    loanerAgreement: [{
      id: 'la1', tenantId: 't1', reservationId: 'r1', agreementNumber: 'LA-1',
      customerFirstName: PII.first, customerLastName: PII.last, customerEmail: PII.email,
      customerPhone: PII.phone, dateOfBirth: PII.dob, licenseNumber: PII.license, licenseState: 'FL',
      licenseImagePath: 'tenants/t1/loaner-agreements/la1/license.jpg',
      insurancePolicyNumber: 'POL-9', insuranceImagePath: 'tenants/t1/loaner-agreements/la1/ins.jpg',
      signatureDataUrl: 'data:image/png;base64,GGGG', signerName: PII.first, signerIp: '203.0.113.7',
      notes: null, closedAt: new Date('2026-01-03T12:00:00Z'),
    }],
    loanerPhoto: [{
      id: 'lp1', loanerAgreementId: 'la1', tenantId: 't1', kind: 'WALKAROUND',
      storagePath: 'tenants/t1/loaner-agreements/la1/WALK.jpg',
    }],
  };
}

function silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function makeDeps(fake, deleteCalls, authnetCalls) {
  return {
    prisma: fake,
    logger: silentLogger(),
    deleteObject: async ({ bucket, path }) => { deleteCalls.push({ bucket, path }); return { deleted: true }; },
    authnetDelete: async (profileId) => { authnetCalls.push(profileId); return { ok: true, code: 'DELETED' }; },
  };
}

// Erasable PII literals that must NOT survive anywhere after a live erase.
const FORBIDDEN = [PII.email, PII.phone, PII.license, '1990-01-15', 'John', 'Jane', 'jane@example.com'];

function assertNoForbiddenPII(fake) {
  for (const m of MODELS) {
    for (const row of fake._store[m]) {
      const blob = JSON.stringify(row);
      for (const needle of FORBIDDEN) {
        assert.ok(
          !blob.includes(needle),
          `PII "${needle}" survived in ${m}: ${blob}`,
        );
      }
    }
  }
}

describe('customer erasure — sacred invariants', () => {
  beforeEach(() => { delete process.env.GDPR_ERASURE_ENABLED; });

  it('INVARIANT #1: flag OFF refuses to mutate (dryRun:false throws 503, nothing changes)', async () => {
    delete process.env.GDPR_ERASURE_ENABLED; // OFF
    const fake = makeFake(seedData());
    const deleteCalls = []; const authnetCalls = [];
    await assert.rejects(
      () => eraseCustomer('c1', { actor: 'admin', reason: 'gdpr', dryRun: false }, makeDeps(fake, deleteCalls, authnetCalls)),
      (err) => err instanceof ErasureNotEnabledError && err.statusCode === 503,
    );
    // Nothing mutated, nothing reaped.
    assert.equal(fake._store.customer[0].email, PII.email);
    assert.equal(fake._store.customer[0].doNotRent, false);
    assert.equal(deleteCalls.length, 0);
    assert.equal(authnetCalls.length, 0);
  });

  it('INVARIANT #2: dry-run is the DEFAULT and mutates nothing, but returns a plan', async () => {
    process.env.GDPR_ERASURE_ENABLED = 'true'; // even with flag ON, default dryRun wins
    const fake = makeFake(seedData());
    const deleteCalls = []; const authnetCalls = [];
    const report = await eraseCustomer('c1', { actor: 'admin', reason: 'gdpr' }, makeDeps(fake, deleteCalls, authnetCalls));

    assert.equal(report.dryRun, true);
    assert.ok(report.tables.customer === 1);
    assert.ok(report.tables.rentalAgreement >= 1);
    assert.ok(Array.isArray(report.storageToDelete) && report.storageToDelete.length > 0);
    assert.equal(report.authnetProfile.action, 'WOULD_DELETE');
    assert.ok(report.retainedDisclosure.some((s) => /suppression record/i.test(s)));

    // Absolutely no mutation / no side effects.
    assert.equal(fake._store.customer[0].email, PII.email);
    assert.equal(fake._store.customer[0].doNotRent, false);
    assert.equal(fake._store.conversation.length, 1);
    assert.equal(deleteCalls.length, 0);
    assert.equal(authnetCalls.length, 0);
  });
});

describe('customer erasure — live reconciliation', () => {
  let fake; let deleteCalls; let authnetCalls; let report;

  beforeEach(async () => {
    process.env.GDPR_ERASURE_ENABLED = 'true';
    fake = makeFake(seedData());
    deleteCalls = []; authnetCalls = [];
    report = await eraseCustomer('c1', { actor: 'admin@x.com', reason: 'gdpr-request', dryRun: false }, makeDeps(fake, deleteCalls, authnetCalls));
  });

  it('scrubs the master Customer row completely + sets doNotRent', () => {
    const c = fake._store.customer[0];
    assert.equal(c.firstName, REDACTION);
    assert.equal(c.lastName, REDACTION);
    assert.equal(c.phone, REDACTION);
    assert.equal(c.email, null);
    assert.equal(c.phoneNormalized, null);
    assert.equal(c.licenseNumber, null);
    assert.equal(c.dateOfBirth, null);
    assert.equal(c.idPhotoUrl, null);
    assert.equal(c.licenseBackUrl, null);
    assert.equal(c.cardLast4, null);
    assert.equal(c.authnetCustomerProfileId, null);
    assert.equal(c.authnetPaymentProfileId, null);
    assert.equal(c.creditBalance, 0);
    assert.equal(c.doNotRent, true);
    assert.ok(String(c.doNotRentReason).includes('gdpr-request'));
  });

  it('RETAINS the closed agreement facts but erases its PII (statutory retention)', () => {
    const a = fake._store.rentalAgreement[0];
    // retained
    assert.equal(a.agreementNumber, 'RA-1');
    assert.equal(a.total, 100);
    assert.equal(a.customerLastName, PII.last); // LAST name kept
    assert.ok(a.closedAt); assert.ok(a.tcSignedAt); // timestamps kept
    // erased
    assert.equal(a.customerFirstName, REDACTION);
    assert.equal(a.customerEmail, null);
    assert.equal(a.customerPhone, null);
    assert.equal(a.dateOfBirth, null);
    assert.equal(a.licenseNumber, null);
    assert.equal(a.tcSignatureDataUrl, null); // signature IMAGE gone
    assert.equal(a.declinedInsuranceSignatureDataUrl, null);
    assert.equal(a.cardOnFileToken, null);
    assert.equal(a.insuranceDocumentUrl, null);
  });

  it('scrubs every direct-FK + denormalised table', () => {
    assert.equal(fake._store.agreementDriver[0].firstName, REDACTION);
    assert.equal(fake._store.agreementDriver[0].licenseNumber, null);
    assert.equal(fake._store.reservationAdditionalDriver[0].firstName, REDACTION);
    assert.equal(fake._store.reservationAdditionalDriver[0].licenseNumber, null);
    assert.equal(fake._store.agreementSectionInitial[0].initialDataUrl, REDACTION);
    assert.equal(fake._store.agreementSectionInitial[0].customerIp, null);
    assert.ok(fake._store.agreementSectionInitial[0].signedAt); // retained
    assert.equal(fake._store.rentalAgreementInspection[0].actorIp, null);
    assert.ok(fake._store.rentalAgreementInspection[0].photosJson); // vehicle photos retained
    assert.equal(fake._store.reservation[0].signatureDataUrl, null);
    assert.equal(fake._store.reservation[0].notes, null);
    assert.equal(fake._store.reservation[0].flightNumber, null);
    assert.equal(fake._store.reservation[0].reservationNumber, 'RES-1'); // retained
    assert.equal(fake._store.quote[0].contactEmail, null);
    assert.equal(fake._store.quote[0].contactName, null);
    assert.equal(fake._store.quote[0].quoteNumber, 'Q-1'); // retained
    assert.equal(fake._store.hostReview[0].reviewerName, null);
    assert.equal(fake._store.hostReview[0].comments, null);
    assert.equal(fake._store.hostReview[0].rating, 5); // aggregate stat retained
    assert.equal(fake._store.trip[0].notes, null);
    assert.equal(fake._store.trip[0].tripCode, 'TRIP-1'); // retained
    assert.equal(fake._store.shuttleRequest[0].customerName, REDACTION);
    assert.equal(fake._store.shuttleRequest[0].customerPhone, null);
    assert.deepEqual(fake._store.kioskSession[0].eventsJson, []); // telemetry reset
    assert.equal(fake._store.kioskSession[0].nameUpdateCodeHash, null);
    assert.equal(fake._store.kioskSession[0].paymentIntentRef, 'intent-1'); // money ref retained
    assert.equal(fake._store.externalReservation[0].customerEmail, null);
    assert.deepEqual(fake._store.externalReservation[0].rawJson, {});
    assert.equal(fake._store.externalReservation[0].externalRef, 'ZE1'); // retained
    assert.equal(fake._store.vehicleDamageReport[0].customerAckSignerName, null);
    assert.equal(fake._store.vehicleDamageReport[0].customerAckIp, null);
    assert.equal(fake._store.vehicleDamageReport[0].description, 'scratch'); // damage fact retained
    assert.ok(fake._store.vehicleDamageReport[0].photoJson); // vehicle photos retained
    assert.equal(fake._store.citationDocument[0].ocrJson, null);
    assert.equal(fake._store.citationDocument[0].bucketPath, REDACTION);
    // loaner statutory record
    assert.equal(fake._store.loanerAgreement[0].agreementNumber, 'LA-1');
    assert.equal(fake._store.loanerAgreement[0].customerLastName, PII.last);
    assert.equal(fake._store.loanerAgreement[0].customerEmail, null);
    assert.equal(fake._store.loanerAgreement[0].licenseImagePath, null);
    assert.equal(fake._store.loanerAgreement[0].signatureDataUrl, null);
    assert.ok(fake._store.loanerPhoto[0].storagePath); // vehicle walkaround retained
  });

  it('HARD-DELETES chat threads + personal trip documents', () => {
    assert.equal(fake._store.conversation.length, 0);
    assert.equal(fake._store.message.length, 0);
    assert.equal(fake._store.tripDocument.length, 0);
  });

  it('leaves NO erasable PII anywhere (whole-store reconciliation scan)', () => {
    assertNoForbiddenPII(fake);
  });

  it('reaps KYC/document Storage bytes + the AuthNet profile', () => {
    const paths = deleteCalls.map((d) => `${d.bucket}:${d.path}`);
    // customer id photo (default customer-documents bucket)
    assert.ok(paths.includes('customer-documents:tenants/t1/customers/c1/id-photo_abc.jpg'));
    // customer license back — explicit bucket:path form
    assert.ok(paths.includes('inventory-photos:tenants/t1/customers/c1/license-back_x.jpg'));
    // agreement insurance doc
    assert.ok(paths.includes('customer-documents:tenants/t1/customers/c1/insurance_y.pdf'));
    // conversation pickup photo (reaped before the row was deleted)
    assert.ok(paths.includes('customer-documents:tenants/t1/pickup/p.jpg'));
    // citation document (explicit bucket:path)
    assert.ok(paths.includes('inventory-photos:tenants/t1/citations/cd1.pdf'));
    // loaner license + insurance images
    assert.ok(paths.some((p) => p.endsWith('la1/license.jpg')));
    // the external http(s) insurance URL was NULLED, never reaped
    assert.ok(!paths.some((p) => p.includes('cdn.example.com')));
    // AuthNet profile deleted
    assert.deepEqual(authnetCalls, ['cust-prof-1']);
    assert.equal(report.authnetProfile.action, 'DELETED');
  });

  it('is idempotent — re-running mutates nothing new and does not throw', async () => {
    const deleteCalls2 = []; const authnetCalls2 = [];
    const report2 = await eraseCustomer('c1', { actor: 'admin@x.com', reason: 'gdpr-request', dryRun: false }, makeDeps(fake, deleteCalls2, authnetCalls2));
    assert.equal(report2.ok, true);
    assert.equal(report2.dryRun, false);
    // Still scrubbed, still no PII.
    assertNoForbiddenPII(fake);
    assert.equal(fake._store.customer[0].doNotRent, true);
    // Nothing left to hard-delete.
    assert.equal(fake._store.conversation.length, 0);
    // AuthNet profile id is already gone, so no second upstream delete.
    assert.equal(authnetCalls2.length, 0);
  });
});
