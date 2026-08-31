/**
 * customer-export.test.mjs — GDPR Phase B data-subject EXPORT.
 *
 * DB-FREE: drives exportCustomer() against a small READ-ONLY in-memory Prisma
 * fake (the erasure-suite pattern) so it runs on a laptop in the npm chain.
 *
 * Proves:
 *   - COMPLETENESS vs the map: EVERY entry in customer-pii-map.js (plus the
 *     `message` cascade child) has an export category, and the exporter emits a
 *     key for every one — so export can never silently drop a table erasure
 *     scrubs. FAILS if a new map entry has no export home.
 *   - The fields GET /api/customers/:id omits today (payments, tolls, citations,
 *     messages, photos, signatures, incidents, quotes) are ALL present.
 *   - Storage refs → short-TTL SIGNED URLs; data: blobs stay inline.
 *   - READ-ONLY: the store is byte-for-byte unchanged and no write method runs.
 *   - Cross-tenant → 404.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The service transitively imports lib/prisma.js (constructs a PrismaClient at
// load time from a URL string; it never connects — every query goes through the
// injected fake). Set a dummy DATABASE_URL before the module graph loads.
process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db?schema=public';
process.env.NODE_ENV ||= 'test';

const { exportCustomer, CustomerNotFoundError, EXPORT_MODEL_CATEGORY, exportUrlTtlSeconds, isSecretColumn } =
  await import('./customer-export.service.js');
const { CUSTOMER_PII_MAP } = await import('./customer-pii-map.js');

// ---------------------------------------------------------------------------
// READ-ONLY in-memory Prisma fake. Supports findFirst/findMany with the where
// matchers the reach resolver emits: scalar equals, { in }, { equals, mode },
// null, OR, AND. Every WRITE method THROWS — an export that mutates fails loud.
// ---------------------------------------------------------------------------
const MODELS = [
  'customer', 'reservation', 'rentalAgreement', 'rentalAgreementAddendum',
  'loanerAgreement', 'loanerPhoto', 'loanerDamagePoint', 'loanerRequest',
  'trip', 'tripDocument', 'tripFulfillmentPlan', 'tripTimelineEvent', 'tripPayout',
  'conversation', 'message', 'hostReview', 'quote',
  'agreementDriver', 'reservationAdditionalDriver', 'agreementSectionInitial',
  'rentalAgreementInspection', 'rentalAgreementVehicleSwap', 'rentalAgreementCharge',
  'rentalAgreementPayment', 'agreementCommission', 'reservationCharge', 'reservationPayment',
  'customerInspection', 'reservationIncident', 'vehicleDamageReport', 'reviewProof',
  'tripIncident', 'tripIncidentCommunication', 'shuttleRequest', 'kioskSession',
  'externalReservation', 'citation', 'citationDocument', 'citationAttachment',
  'tollTransaction', 'paymentOpsFlag', 'checkoutSession', 'auditLog', 'overdueVehicleAlert',
  'handoffToken', 'shuttleTrackerLink',
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

function makeReadOnlyFake(seed, writeCalls) {
  const store = {};
  for (const m of MODELS) store[m] = (seed[m] || []).map((r) => ({ ...r }));

  const denyWrite = (name, op) => () => {
    writeCalls.push(`${name}.${op}`);
    throw new Error(`export is read-only: ${name}.${op} must never be called`);
  };

  const delegate = (name) => ({
    async findMany({ where, select } = {}) {
      let rows = store[name].filter((r) => matchWhere(r, where)).map((r) => ({ ...r }));
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
    updateMany: denyWrite(name, 'updateMany'),
    deleteMany: denyWrite(name, 'deleteMany'),
    update: denyWrite(name, 'update'),
    create: denyWrite(name, 'create'),
    delete: denyWrite(name, 'delete'),
  });

  const client = { _store: store };
  for (const m of MODELS) client[m] = delegate(m);
  client.$transaction = () => { throw new Error('export is read-only: $transaction must never be called'); };
  return client;
}

// ---------------------------------------------------------------------------
// Seed: a customer with the categories the DSAR test names + storage/signature
// refs. tenant t1.
// ---------------------------------------------------------------------------
function seedData() {
  return {
    customer: [{
      id: 'c1', tenantId: 't1',
      firstName: 'John', lastName: 'Doe', email: 'john.doe@example.com', phone: '+15551234567',
      licenseNumber: 'D1234567', dateOfBirth: new Date('1990-01-15T00:00:00.000Z'),
      address1: '1 Main St', city: 'Miami', state: 'FL', zip: '33101', country: 'US',
      idPhotoUrl: 'tenants/t1/customers/c1/id-photo.jpg',        // storage path → signed URL
      licenseBackUrl: 'inventory-photos:tenants/t1/customers/c1/lic.jpg', // explicit bucket → signed URL
      insuranceDocumentUrl: 'https://cdn.example.com/ins.pdf',   // external URL → passthrough
      authnetCustomerProfileId: 'cust-prof-1', cardLast4: '4242', cardBrand: 'Visa',
      creditBalance: 25, doNotRent: true, doNotRentReason: 'Erased earlier: gdpr',
      // SECRETS — must be stripped from the export.
      portalResetToken: 'SECRETVAL-portalResetToken', portalResetExpiresAt: new Date('2027-01-01Z'),
      guestAccessToken: 'SECRETVAL-guestAccessToken', guestAccessExpiresAt: new Date('2027-01-01Z'),
      deletionToken: 'SECRETVAL-deletionToken', deletionTokenExpiresAt: new Date('2027-01-01Z'),
    }],
    reservation: [{
      id: 'r1', tenantId: 't1', customerId: 'c1', reservationNumber: 'RES-1',
      signatureDataUrl: 'data:image/png;base64,AAAA',           // inline signature → passthrough
      notes: 'John Doe underage', flightNumber: 'AA123',
      // Capability tokens (values are SECRETS) — but keep their *ExpiresAt.
      customerInfoToken: 'SECRETVAL-customerInfoToken', customerInfoTokenExpiresAt: new Date('2027-01-01Z'),
      signatureToken: 'SECRETVAL-signatureToken', signatureTokenExpiresAt: new Date('2027-01-01Z'),
      paymentRequestToken: 'SECRETVAL-paymentRequestToken', paymentRequestTokenExpiresAt: new Date('2027-01-01Z'),
    }],
    rentalAgreement: [{
      id: 'a1', tenantId: 't1', reservationId: 'r1', agreementNumber: 'RA-1',
      customerFirstName: 'John', customerLastName: 'Doe', customerEmail: 'john.doe@example.com',
      dateOfBirth: new Date('1990-01-15T00:00:00.000Z'), licenseNumber: 'D1234567',
      tcSignatureDataUrl: 'data:image/png;base64,BBBB',         // inline signature
      insuranceDocumentUrl: 'tenants/t1/customers/c1/insurance.pdf', // storage path → signed URL
      total: 100, subtotal: 90, taxes: 10,
    }],
    rentalAgreementPayment: [{
      id: 'rap1', rentalAgreementId: 'a1', amount: 100, method: 'CARD', reference: 'ref-1',
      notes: 'paid by John',
    }],
    reservationPayment: [{
      id: 'rp1', reservationId: 'r1', amount: 100, method: 'CARD', reference: 'ref-2', notes: 'paid',
    }],
    rentalAgreementInspection: [{
      id: 'ins1', rentalAgreementId: 'a1', phase: 'CHECKOUT', actorIp: '203.0.113.7',
      photosJson: '[{"path":"tenants/t1/insp/1.jpg"},{"path":"tenants/t1/insp/2.jpg"}]', // photo-set → signed URLs
      notes: 'returned late', damages: 'dent', exterior: 'ok', interior: 'ok',
    }],
    reservationIncident: [{
      id: 'ri1', tenantId: 't1', reservationId: 'r1', reportNumber: 'INC-1', type: 'INTERIOR',
      title: 'Interior damage', narrative: 'renter John Doe left it filthy',
      certifiedByName: 'Staff Member', signatureDataUrl: 'data:image/png;base64,STAFFSIG',
    }],
    quote: [{
      id: 'q1', tenantId: 't1', quoteNumber: 'Q-1', customerId: 'c1',
      contactName: 'John Doe', contactPhone: '+15551234567', contactEmail: 'john.doe@example.com',
      total: 120, status: 'ACTIVE',
    }],
    conversation: [{
      id: 'conv1', tenantId: 't1', customerId: 'c1', subject: 'Pickup for John',
      pickupPhotoUrl: 'tenants/t1/pickup/p.jpg',                // storage path → signed URL
    }],
    message: [
      { id: 'msg1', conversationId: 'conv1', senderType: 'GUEST', senderName: 'John', body: 'hi' },
      { id: 'msg2', conversationId: 'conv1', senderType: 'HOST', senderName: 'Host', body: 'ok' },
    ],
    tollTransaction: [{
      id: 'tt1', tenantId: 't1', reservationId: 'r1', amount: 5, location: 'Turnpike',
      reviewNotes: 'billed to John', sourcePayloadJson: '{"plate":"ABC"}',
    }],
    citation: [{
      id: 'cit1', tenantId: 't1', reservationId: 'r1', citationNo: 'CIT-1', agency: 'City',
      amount: 50, location: 'Main St', violationType: 'PARKING', reviewNotes: 'driver John disputes',
    }],
    citationDocument: [{
      id: 'cd1', tenantId: 't1', citationId: 'cit1',
      bucketPath: 'inventory-photos:tenants/t1/citations/cd1.pdf', ocrJson: '{"name":"John Doe"}',
    }],
    // ---- Rows carrying SECRET tokens/hashes that must NOT appear in the export ----
    hostReview: [{
      id: 'hr1', tripId: 'tr1', guestCustomerId: 'c1', rating: 5, comments: 'great guest',
      reviewerName: 'John Doe',
      publicToken: 'SECRETVAL-hostReviewPublicToken', publicTokenExpiresAt: new Date('2027-01-01Z'),
    }],
    loanerAgreement: [{
      id: 'la1', tenantId: 't1', reservationId: 'r1', agreementNumber: 'LA-1',
      customerFirstName: 'John', customerLastName: 'Doe',
      signatureToken: 'SECRETVAL-loanerSignatureToken', signatureTokenExpiresAt: new Date('2027-01-01Z'),
      portalToken: 'SECRETVAL-loanerPortalToken', portalTokenExpiresAt: new Date('2027-01-01Z'),
    }],
    kioskSession: [{
      id: 'ks1', tenantId: 't1', deviceId: 'd1', reservationId: 'r1', kind: 'CHECKOUT',
      nameUpdateCodeHash: 'SECRETVAL-nameUpdateCodeHash', outcome: 'IN_PROGRESS',
    }],
    handoffToken: [{
      id: 'ho1', reservationId: 'r1', kind: 'CHECKIN',
      token: 'SECRETVAL-handoffToken', expiresAt: new Date('2027-01-01Z'),
    }],
    shuttleTrackerLink: [{
      id: 'stl1', tenantId: 't1', reservationId: 'r1',
      token: 'SECRETVAL-shuttleTrackerToken', expiresAt: new Date('2027-01-01Z'),
    }],
    // A second tenant's customer — must be unreachable from tenant t1.
  };
}

function silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function makeSigner(signCalls) {
  return async ({ bucket, path, expiresIn }) => {
    signCalls.push({ bucket, path, expiresIn });
    return `https://signed.example/${bucket}/${path}?token=SIG&ttl=${expiresIn}`;
  };
}

async function runExport(seed = seedData(), opts = {}) {
  const writeCalls = [];
  const signCalls = [];
  const fake = makeReadOnlyFake(seed, writeCalls);
  const before = JSON.stringify(fake._store);
  const report = await exportCustomer('c1', { actor: 'admin@x.com', ...opts }, {
    prisma: fake, logger: silentLogger(), getSignedUrl: makeSigner(signCalls),
  });
  const after = JSON.stringify(fake._store);
  return { report, fake, writeCalls, signCalls, before, after };
}

// ---------------------------------------------------------------------------
// (1) COMPLETENESS vs the map — the drift guard.
// ---------------------------------------------------------------------------
describe('customer export — completeness vs the PII map', () => {
  it('every map entry (+ the message cascade child) has an export category', () => {
    const missing = Object.keys(CUSTOMER_PII_MAP).filter((model) => !(model in EXPORT_MODEL_CATEGORY));
    assert.deepEqual(
      missing,
      [],
      `Map entries with NO export category — add them to EXPORT_MODEL_CATEGORY in ` +
      `customer-export.service.js so export cannot drift from the map/erasure:\n  ${missing.join('\n  ')}`,
    );
    assert.ok('message' in EXPORT_MODEL_CATEGORY, 'the Conversation `message` cascade child must have a category');
  });

  it('EXPORT_MODEL_CATEGORY has no phantom entries (no category without a map model)', () => {
    const known = new Set([...Object.keys(CUSTOMER_PII_MAP), 'message']);
    const phantom = Object.keys(EXPORT_MODEL_CATEGORY).filter((m) => !known.has(m));
    assert.deepEqual(phantom, [], `EXPORT_MODEL_CATEGORY names model(s) not in the map: ${phantom.join(', ')}`);
  });

  it('the export output exposes a key for EVERY category (empty categories still appear)', async () => {
    // Run against a bare customer (no child rows) — every category must still be
    // present as an empty array, proving the shape is complete by construction.
    const { report } = await runExport({ customer: [{ id: 'c1', tenantId: 't1', firstName: 'A', lastName: 'B' }] });
    const data = report.data;
    for (const [model, category] of Object.entries(EXPORT_MODEL_CATEGORY)) {
      if (category === 'subject') { assert.ok(data.subject, 'subject present'); continue; }
      assert.ok(category in data, `category "${category}" (model ${model}) missing from export output`);
      assert.ok(Array.isArray(data[category]), `category "${category}" should be an array`);
    }
    assert.ok('suppression' in data, 'suppression summary present');
  });
});

// ---------------------------------------------------------------------------
// (2) SEEDED export — the DSAR content the thin GET omits, signed URLs, read-only.
// ---------------------------------------------------------------------------
describe('customer export — seeded content', () => {
  it('includes the fields GET /api/customers/:id omits today (payments/tolls/citations/messages/incidents/quotes)', async () => {
    const { report } = await runExport();
    const d = report.data;

    // subject master row present + not redacted (subject sees their own data).
    assert.equal(d.subject.firstName, 'John');
    assert.equal(d.subject.email, 'john.doe@example.com');

    // Core categories seeded.
    assert.equal(d.reservations.length, 1);
    assert.equal(d.rentalAgreements.length, 1);
    assert.equal(d.inspections.length, 1);

    // The thin-GET omissions — ALL present.
    assert.ok(d.agreementPayments.length + d.reservationPayments.length >= 2, 'payments present');
    assert.equal(d.tolls.length, 1, 'tolls present');
    assert.equal(d.citations.length, 1, 'citations present');
    assert.equal(d.messages.length, 2, 'messages present');
    assert.equal(d.incidents.length, 1, 'incidents present');
    assert.equal(d.quotes.length, 1, 'quotes present');
  });

  it('signatures stay inline (data: blobs) and are not stripped', async () => {
    const { report } = await runExport();
    const d = report.data;
    assert.deepEqual(d.reservations[0].signatureDataUrl, { kind: 'inline', value: 'data:image/png;base64,AAAA' });
    assert.deepEqual(d.rentalAgreements[0].tcSignatureDataUrl, { kind: 'inline', value: 'data:image/png;base64,BBBB' });
    assert.deepEqual(d.incidents[0].signatureDataUrl, { kind: 'inline', value: 'data:image/png;base64,STAFFSIG' });
  });

  it('storage-backed media → short-TTL SIGNED URLs, external URLs passthrough, raw paths never leak', async () => {
    const { report, signCalls } = await runExport();
    const d = report.data;
    const ttl = exportUrlTtlSeconds();

    // Customer KYC doc (bare path, default bucket) → signed URL.
    assert.equal(d.subject.idPhotoUrl.kind, 'signed-url');
    assert.ok(d.subject.idPhotoUrl.url.startsWith('https://signed.example/'));
    // Explicit "<bucket>:<path>" honoured.
    assert.equal(d.subject.licenseBackUrl.kind, 'signed-url');
    assert.equal(d.subject.licenseBackUrl.bucket, 'inventory-photos');
    // External URL → passthrough (not ours to sign).
    assert.deepEqual(d.subject.insuranceDocumentUrl, { kind: 'url', url: 'https://cdn.example.com/ins.pdf' });

    // Agreement KYC doc (storage path) → signed URL.
    assert.equal(d.rentalAgreements[0].insuranceDocumentUrl.kind, 'signed-url');
    // Conversation pickup photo (top-level storage) → signed URL.
    assert.equal(d.conversations[0].pickupPhotoUrl.kind, 'signed-url');

    // Inspection photo-set JSON → list of signed URLs, no raw path leaked.
    const photos = d.inspections[0].photosJson;
    assert.equal(photos.kind, 'photo-set');
    assert.equal(photos.count, 2);
    assert.ok(photos.refs.every((r) => r.kind === 'signed-url' && r.url.startsWith('https://signed.example/')));
    // The raw seeded storage path must not survive as a bare path in the output.
    assert.ok(!photos.refs.some((r) => r.url.startsWith('tenants/')), 'raw storage path must not leak');

    // Short TTL was requested on every signed URL.
    assert.ok(signCalls.length > 0, 'signer was called');
    assert.ok(signCalls.every((c) => c.expiresIn === ttl), 'all signed URLs use the short TTL');
    assert.ok(ttl <= 3600, 'TTL is short (<= 1h)');

    // Sub-processor disclosure surfaced (without re-fetching card data).
    assert.equal(report.subProcessors.authnet.held, true);
    assert.equal(report.subProcessors.authnet.profileId, 'cust-prof-1');
  });

  it('STRIPS live credentials/tokens/hashes — none appear anywhere in the export', async () => {
    const { report } = await runExport();
    const blob = JSON.stringify(report);

    // (a) No seeded secret VALUE survives anywhere in the output.
    assert.ok(!blob.includes('SECRETVAL-'), 'a secret token/hash value leaked into the export');

    // (b) No secret COLUMN NAME appears anywhere in the output (recursively).
    const SECRET_NAMES = [
      'portalResetToken', 'guestAccessToken', 'deletionToken', 'token',
      'customerInfoToken', 'signatureToken', 'paymentRequestToken', 'portalToken', 'publicToken',
      'nameUpdateCodeHash', 'codeHash', 'lockPinHash',
    ];
    const found = [];
    (function walk(node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (isSecretColumn(k)) found.push(k);
          walk(v);
        }
      }
    })(report);
    assert.deepEqual([...new Set(found)], [], `secret column name(s) present in export: ${[...new Set(found)].join(', ')}`);
    for (const name of SECRET_NAMES) {
      assert.ok(!Object.prototype.hasOwnProperty.call(report.data.subject, name), `subject still carries ${name}`);
    }

    // (c) The NON-secret facts around the tokens are KEPT (a link existed).
    assert.ok('portalResetExpiresAt' in report.data.subject, 'subject *ExpiresAt kept');
    assert.ok('signatureTokenExpiresAt' in report.data.reservations[0], 'reservation token *ExpiresAt kept');
    assert.ok('publicTokenExpiresAt' in report.data.hostReviews[0], 'hostReview token *ExpiresAt kept');
    assert.equal(report.data.handoffTokens.length, 1, 'the handoff link row is still disclosed');
    assert.ok('expiresAt' in report.data.handoffTokens[0], 'handoff link expiresAt kept');
    assert.ok(!('token' in report.data.handoffTokens[0]), 'handoff token value stripped');
    assert.ok('expiresAt' in report.data.shuttleTrackerLinks[0] && !('token' in report.data.shuttleTrackerLinks[0]));
  });

  it('isSecretColumn: token VALUES and credential hashes yes; timestamps/refs no', () => {
    for (const yes of ['token', 'portalResetToken', 'signatureToken', 'publicToken', 'nameUpdateCodeHash', 'codeHash', 'lockPinHash']) {
      assert.equal(isSecretColumn(yes), true, `${yes} should be secret`);
    }
    for (const no of ['signatureTokenExpiresAt', 'portalResetExpiresAt', 'expiresAt', 'authnetCustomerProfileId', 'reference', 'agreementNumber']) {
      assert.equal(isSecretColumn(no), false, `${no} should NOT be secret`);
    }
  });

  it('is strictly READ-ONLY: nothing mutated, no write method called', async () => {
    const { writeCalls, before, after } = await runExport();
    assert.deepEqual(writeCalls, [], `export called write method(s): ${writeCalls.join(', ')}`);
    assert.equal(before, after, 'the store must be byte-for-byte unchanged after an export');
  });

  it('cross-tenant export returns 404 (fail-closed scope)', async () => {
    const writeCalls = [];
    const fake = makeReadOnlyFake(seedData(), writeCalls);
    await assert.rejects(
      () => exportCustomer('c1', { actor: 'admin', scope: { tenantId: 'other-tenant' } }, {
        prisma: fake, logger: silentLogger(), getSignedUrl: makeSigner([]),
      }),
      (err) => err instanceof CustomerNotFoundError && err.statusCode === 404,
    );
  });
});

// ---------------------------------------------------------------------------
// (3) NAMESAKE / shared-phone isolation — the tightened shared resolver.
// Two same-tenant customers share a phone but have different names + emails.
// Subject A's export must NOT fold in subject B's quote or loaner-request via
// the shared phone (or via B's own linked/contact rows).
// ---------------------------------------------------------------------------
const SHARED_PHONE = '+15550009999';

function namesakeSeed() {
  return {
    customer: [
      { id: 'A', tenantId: 't1', firstName: 'John', lastName: 'Doe', email: 'john@x.com', phone: SHARED_PHONE },
      { id: 'B', tenantId: 't1', firstName: 'Jane', lastName: 'Roe', email: 'jane@x.com', phone: SHARED_PHONE },
    ],
    quote: [
      // A's own linked quote — MUST appear.
      { id: 'qA', tenantId: 't1', quoteNumber: 'Q-A', customerId: 'A', contactName: 'John Doe', contactPhone: SHARED_PHONE, contactEmail: 'john@x.com' },
      // B's linked quote — MUST NOT appear (belongs to B, only shares the phone).
      { id: 'qB', tenantId: 't1', quoteNumber: 'Q-B', customerId: 'B', contactName: 'Jane Roe', contactPhone: SHARED_PHONE, contactEmail: 'jane@x.com' },
      // An UNLINKED quote that is really B's (B's name+email) but on the shared
      // phone — MUST NOT appear in A's set (bare shared phone must not pull it).
      { id: 'qU', tenantId: 't1', quoteNumber: 'Q-U', customerId: null, contactName: 'Jane Roe', contactPhone: SHARED_PHONE, contactEmail: 'jane@x.com' },
    ],
    loanerRequest: [
      // B's loaner request on the shared phone — MUST NOT appear in A's set.
      { id: 'lrB', tenantId: 't1', name: 'Jane Roe', phone: SHARED_PHONE, email: 'jane@x.com', status: 'RECEIVED' },
    ],
    externalReservation: [
      // B's import row on the shared phone — MUST NOT appear in A's set.
      { id: 'extB', tenantId: 't1', customerFirstName: 'Jane', customerLastName: 'Roe', customerEmail: 'jane@x.com', customerPhone: SHARED_PHONE },
    ],
  };
}

describe('customer export — namesake / shared-phone isolation (shared resolver)', () => {
  it("subject A's export excludes subject B's quote / loaner-request / import that only share a phone", async () => {
    const writeCalls = [];
    const fake = makeReadOnlyFake(namesakeSeed(), writeCalls);
    const report = await exportCustomer('A', { actor: 'admin', scope: { tenantId: 't1' } }, {
      prisma: fake, logger: silentLogger(), getSignedUrl: makeSigner([]),
    });
    const d = report.data;

    // Only A's own linked quote is present.
    const quoteNumbers = d.quotes.map((q) => q.quoteNumber).sort();
    assert.deepEqual(quoteNumbers, ['Q-A'], `A's export pulled a namesake quote: ${quoteNumbers.join(', ')}`);

    // B's loaner request (shared phone, different name+email) is not pulled in.
    assert.equal(d.loanerRequests.length, 0, "A's export pulled B's loaner request via the shared phone");

    // B's import row (shared phone, different email) is not pulled in.
    assert.equal(d.externalReservations.length, 0, "A's export pulled B's import row via the shared phone");

    // No B PII leaked anywhere in A's export.
    assert.ok(!JSON.stringify(report).includes('Jane'), "subject B's data leaked into A's export");
    assert.ok(!JSON.stringify(report).includes('jane@x.com'), "subject B's email leaked into A's export");
  });
});
