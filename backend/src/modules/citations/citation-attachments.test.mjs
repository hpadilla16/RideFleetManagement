/**
 * Citation attachments — rules, scoping and the export bundle. No DB.
 *
 * The DB-backed location-scope cases live in citations-location-scope.test.mjs
 * alongside the rest of the citations scope suite (that file needs a real
 * Postgres). What is pinned HERE is everything that can be settled without
 * one: the upload rules, the payment-card confirmation, the fail-closed scope
 * lookup, and the export's promise that a bundle it cannot complete says so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// The service modules transitively import lib/prisma.js, which constructs a
// PrismaClient AT IMPORT TIME and throws without DATABASE_URL. Static `import`
// declarations are hoisted above every statement in this file, so setting the
// variable next to them would be too late — it has to be set before a DYNAMIC
// import, which is what makes this suite genuinely runnable with no database.
// (Same pattern as tolls-scope-guard.test.mjs.) Nothing here touches the DB.
process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:1/unused';

const {
  ATTACHMENT_DOC_TYPES, ATTACHMENT_MAX_BYTES,
  normalizeDocType, isAllowedMime, isEmbeddable, mayContainCardData,
  CARD_WARNING_CODE,
} = await import('./citation-attachments.js');
const {
  citationAttachmentsService, decodeAttachment, parseStorageRef,
} = await import('./citation-attachments.service.js');
const { planParts, buildCoverHtml } = await import('./citation-export.service.js');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

// ---------------------------------------------------------------------------
// The controlled list + the allowlist.
// ---------------------------------------------------------------------------
test('the document-type list is exactly the seven agreed types', () => {
  assert.deepEqual([...ATTACHMENT_DOC_TYPES], [
    'AGENCY_NOTICE', 'PROOF_OF_PAYMENT', 'DISPUTE_LETTER', 'AGENCY_RESPONSE',
    'CUSTOMER_CORRESPONDENCE', 'RENTAL_DOCUMENT', 'OTHER',
  ]);
});

test('an unknown docType degrades to OTHER rather than failing the upload', () => {
  assert.equal(normalizeDocType('nonsense'), 'OTHER');
  assert.equal(normalizeDocType(''), 'OTHER');
  assert.equal(normalizeDocType('dispute_letter'), 'DISPUTE_LETTER', 'case-insensitive');
});

test('the MIME allowlist admits documents and refuses executables', () => {
  assert.ok(isAllowedMime('application/pdf'));
  assert.ok(isAllowedMime('image/jpeg'));
  assert.ok(isAllowedMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  assert.equal(isAllowedMime('application/x-msdownload'), false);
  assert.equal(isAllowedMime('text/html'), false, 'HTML in a signed-URL origin is an XSS vector');
  assert.equal(isAllowedMime('image/svg+xml'), false, 'SVG carries script');
});

test('only PDF/JPEG/PNG are embeddable — a .docx is accepted but cannot be appended', () => {
  assert.ok(isEmbeddable('application/pdf'));
  assert.ok(isEmbeddable('image/png'));
  assert.equal(isEmbeddable('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), false);
});

// ---------------------------------------------------------------------------
// Decoding: the allowlist must not be decorative.
// ---------------------------------------------------------------------------
test('decode accepts a real PNG and reports its true type', () => {
  const out = decodeAttachment(PNG_DATA_URL);
  assert.equal(out.contentType, 'image/png');
  assert.equal(out.ext, 'png');
  assert.ok(out.buffer.byteLength > 0);
});

test('the stored type comes from the MAGIC HEADER, not the caller\'s claim', () => {
  // Both directions. A recognised header always wins, so the type we persist —
  // and therefore the way the export tries to embed it — matches the actual
  // bytes. Trusting the declared mime is what would make the allowlist
  // decorative and put a corrupt page in a bundle sent to an agency.
  const pdfClaimedAsImage = decodeAttachment(`data:image/jpeg;base64,${Buffer.from('%PDF-1.7 x').toString('base64')}`);
  assert.equal(pdfClaimedAsImage.contentType, 'application/pdf');
  assert.equal(pdfClaimedAsImage.ext, 'pdf');

  const pngClaimedAsPdf = decodeAttachment(`data:application/pdf;base64,${PNG_B64}`);
  assert.equal(pngClaimedAsPdf.contentType, 'image/png');
  assert.equal(pngClaimedAsPdf.ext, 'png');
});

test('an embeddable type whose bytes are unrecognisable is REFUSED, not stored as junk', () => {
  // Declared PDF, but the bytes are neither PDF nor a known image. We cannot
  // append it and we cannot tell what it is, so it does not get stored.
  const garbage = `data:application/pdf;base64,${Buffer.from('this is not any known format').toString('base64')}`;
  assert.throws(() => decodeAttachment(garbage), /do not match its declared type/i);
});

test('a disallowed type is refused with 415 and an empty file with 400', () => {
  assert.throws(() => decodeAttachment('data:application/x-msdownload;base64,AAAA'), (e) => e.status === 415);
  assert.throws(() => decodeAttachment('not a data url'), (e) => e.status === 400);
});

test('the size cap is 15MB and is enforced', () => {
  assert.equal(ATTACHMENT_MAX_BYTES, 15 * 1024 * 1024);
  const huge = `data:application/pdf;base64,${Buffer.alloc(ATTACHMENT_MAX_BYTES + 1024, 0x41).toString('base64')}`;
  assert.throws(() => decodeAttachment(huge), (e) => e.status === 413);
});

test('parseStorageRef splits the "<bucket>:<path>" convention', () => {
  assert.deepEqual(parseStorageRef('citation-documents:tenants/t1/x.pdf'),
    { bucket: 'citation-documents', path: 'tenants/t1/x.pdf' });
  assert.equal(parseStorageRef('no-colon'), null);
});

// ---------------------------------------------------------------------------
// THE PCI PROMPT. A confirmation, never a block.
// ---------------------------------------------------------------------------
test('a proof-of-payment always triggers the payment-card prompt', () => {
  assert.equal(mayContainCardData({ docType: 'PROOF_OF_PAYMENT', fileName: 'x.pdf', label: 'x' }), true);
});

test('card-ish words in the filename or label trigger the prompt, in English and Spanish', () => {
  assert.equal(mayContainCardData({ docType: 'OTHER', fileName: 'visa-receipt.jpg', label: 'z' }), true);
  assert.equal(mayContainCardData({ docType: 'OTHER', fileName: 'a.pdf', label: 'Recibo de pago' }), true);
  assert.equal(mayContainCardData({ docType: 'OTHER', fileName: 'a.pdf', label: 'Factura' }), true);
});

test('an ordinary dispute letter does NOT trigger the prompt', () => {
  assert.equal(mayContainCardData({ docType: 'DISPUTE_LETTER', fileName: 'letter.pdf', label: 'Our reply to the agency' }), false);
});

function fakeDb({ citation = { id: 'c1', tenantId: 'T1', citationNo: 'A-1' }, attachments = [] } = {}) {
  const created = [];
  return {
    created,
    citation: {
      findFirst: async ({ where }) => (
        where.tenantId === citation.tenantId && where.id === citation.id ? citation : null
      ),
    },
    citationAttachment: {
      findMany: async () => attachments,
      findFirst: async ({ where }) => attachments.find((a) => a.id === where.id && a.tenantId === where.tenantId) || null,
      create: async ({ data }) => { const row = { id: 'att-1', status: 'ACTIVE', ...data }; created.push(row); return row; },
      update: async ({ data }) => ({ id: 'att-1', ...data }),
    },
  };
}

test('upload REFUSES a likely-card document with 409 until the operator confirms', async () => {
  process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = 'true';
  const db = fakeDb();
  await assert.rejects(
    () => citationAttachmentsService.upload(
      'c1',
      { label: 'Receipt', docType: 'PROOF_OF_PAYMENT', file: PNG_DATA_URL },
      { tenantId: 'T1' }, { uploadObject: async () => ({}) }, db,
    ),
    (e) => e.status === 409 && e.code === CARD_WARNING_CODE && e.requiresConfirmation === true,
  );
  assert.equal(db.created.length, 0, 'nothing was stored while the prompt was outstanding');
  delete process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;
});

test('confirming the prompt lets the SAME upload through — it warns, it never blocks', async () => {
  process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = 'true';
  const db = fakeDb();
  const row = await citationAttachmentsService.upload(
    'c1',
    { label: 'Receipt', docType: 'PROOF_OF_PAYMENT', file: PNG_DATA_URL, acknowledgedCardWarning: true },
    { tenantId: 'T1' }, { uploadObject: async () => ({}) }, db,
  );
  assert.equal(row.docType, 'PROOF_OF_PAYMENT');
  assert.equal(db.created.length, 1);
  assert.match(db.created[0].storagePath, /^citation-documents:tenants\/T1\/citations\/c1\/attachments\//,
    'stored as "<bucket>:<path>" under a tenant- and citation-scoped prefix');
  delete process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;
});

// ---------------------------------------------------------------------------
// Scoping — fail-closed, resolved through the citation.
// ---------------------------------------------------------------------------
test('a caller from another tenant gets 404, not another tenant\'s citation', async () => {
  const db = fakeDb();
  await assert.rejects(
    () => citationAttachmentsService.list('c1', { tenantId: 'OTHER-TENANT' }, {}, db),
    (e) => e.status === 404,
  );
});

test('a scope with no tenantId is refused outright (deny-all scope must not read)', async () => {
  const db = fakeDb();
  await assert.rejects(
    () => citationAttachmentsService.list('c1', {}, {}, db),
    (e) => e.status === 400,
  );
});

test('list returns only ACTIVE attachments unless archived are asked for', async () => {
  let seenWhere = null;
  const db = fakeDb();
  db.citationAttachment.findMany = async ({ where }) => { seenWhere = where; return []; };
  await citationAttachmentsService.list('c1', { tenantId: 'T1' }, {}, db);
  assert.equal(seenWhere.status, 'ACTIVE');
  assert.equal(seenWhere.tenantId, 'T1', 'every query is tenant-scoped');
  await citationAttachmentsService.list('c1', { tenantId: 'T1' }, { includeArchived: true }, db);
  assert.equal(seenWhere.status, undefined);
});

test('delete archives rather than hard-deleting — dispute evidence survives a tidy-up', async () => {
  const db = fakeDb({ attachments: [{ id: 'att-1', tenantId: 'T1', citationId: 'c1', status: 'ACTIVE' }] });
  let hardDeleted = false;
  db.citationAttachment.delete = async () => { hardDeleted = true; };
  const out = await citationAttachmentsService.remove('att-1', { tenantId: 'T1' }, db);
  assert.equal(out.status, 'ARCHIVED');
  assert.equal(hardDeleted, false);
});

// ---------------------------------------------------------------------------
// The export bundle.
// ---------------------------------------------------------------------------
function bundleWith(parts) {
  return {
    citation: {
      id: 'c1', citationNo: 'A-1', agency: 'City of Orlando', violationType: 'Parking',
      amount: 50, fee: 10, status: 'MATCHED', billingStatus: 'PENDING',
      issuedAt: new Date('2026-01-05'), dueAt: new Date('2026-02-05'), location: 'Main St',
      vehicle: null, reservation: null,
    },
    attachments: parts,
    sourceDocumentPath: 'citation-documents:tenants/T1/notice.pdf',
  };
}

test('the ORIGINAL notice is part one of the bundle, before any attachment', () => {
  const parts = planParts(bundleWith([
    { id: 'a1', storagePath: 'b:p1', label: 'Receipt', docType: 'PROOF_OF_PAYMENT', mimeType: 'application/pdf' },
  ]));
  assert.equal(parts[0].kind, 'SOURCE', 'without this the bundle is missing the citation itself');
  assert.equal(parts[1].kind, 'ATTACHMENT');
});

test('a non-embeddable attachment is planned as listed-only, not dropped', () => {
  const parts = planParts(bundleWith([
    {
      id: 'a1', storagePath: 'b:p1', label: 'Our letter', docType: 'DISPUTE_LETTER',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'letter.docx',
    },
  ]));
  const att = parts.find((p) => p.kind === 'ATTACHMENT');
  assert.equal(att.embeddable, false);
  assert.equal(att.fileName, 'letter.docx', 'the filename survives so the cover can name it');
});

test('the cover MARKS an incomplete bundle and names what is missing', () => {
  const bundle = bundleWith([]);
  bundle.parts = [
    { kind: 'SOURCE', label: 'Original citation notice', docType: 'AGENCY_NOTICE', included: true, resolvedMime: 'application/pdf' },
    {
      kind: 'ATTACHMENT', label: 'Our letter', fileName: 'letter.docx', docType: 'DISPUTE_LETTER',
      included: false, reason: 'FORMAT', sizeBytes: 2048,
    },
  ];
  const html = buildCoverHtml([bundle], { companyName: 'Ride' });
  assert.match(html, /This file is incomplete/i, 'the recipient must not assume the bundle is whole');
  assert.match(html, /letter\.docx/, 'the missing document is named');
  assert.match(html, /Dispute letter/, 'and typed');
  assert.match(html, /A-1/, 'the citation number is on the cover');
  assert.match(html, /City of Orlando/, 'the agency is on the cover');
});

test('a complete bundle says so instead of warning', () => {
  const bundle = bundleWith([]);
  bundle.parts = [
    { kind: 'SOURCE', label: 'Original citation notice', docType: 'AGENCY_NOTICE', included: true, resolvedMime: 'application/pdf' },
  ];
  const html = buildCoverHtml([bundle], {});
  assert.doesNotMatch(html, /This file is incomplete/i);
  assert.match(html, /appended after this page/i);
});

test('buildCoverHtml takes an ARRAY — the bulk-export seam is real, not aspirational', () => {
  const a = bundleWith([]); a.parts = [];
  const b = bundleWith([]); b.parts = []; b.citation = { ...b.citation, id: 'c2', citationNo: 'B-2' };
  const html = buildCoverHtml([a, b], {});
  assert.match(html, /A-1/);
  assert.match(html, /B-2/);
  assert.match(html, /Citation 1 of 2/, 'multi-citation bundles number their covers');
});

// ---------------------------------------------------------------------------
// fetchParts — what the bundle can and cannot carry, decided BEFORE the cover
// is rendered so the cover never claims something it does not contain.
// ---------------------------------------------------------------------------
async function realPdf(pages = 1) {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

test('a damaged PDF is caught at FETCH time, so the cover marks it not included', async () => {
  const { fetchParts } = await import('./citation-export.service.js');
  const bundle = bundleWith([
    { id: 'a1', storagePath: 'b:broken.pdf', label: 'Agency notice', docType: 'AGENCY_NOTICE', mimeType: 'application/pdf' },
  ]);
  bundle.sourceDocumentPath = null;
  // %PDF header, garbage body — sniffs as PDF, cannot be parsed.
  const broken = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('not really a pdf')]);
  await fetchParts([bundle], { downloadObject: async () => ({ body: broken, contentType: 'application/pdf' }) });

  const part = bundle.parts[0];
  assert.equal(part.included, false);
  assert.equal(part.reason, 'UNREADABLE');
  const html = buildCoverHtml([bundle], {});
  assert.match(html, /damaged and could not be read/i);
  assert.match(html, /This file is incomplete/i);
});

test('an unreachable object is listed as missing, and does not fail the whole export', async () => {
  const { fetchParts } = await import('./citation-export.service.js');
  const bundle = bundleWith([
    { id: 'a1', storagePath: 'b:gone.pdf', label: 'Receipt', docType: 'PROOF_OF_PAYMENT', mimeType: 'application/pdf' },
  ]);
  bundle.sourceDocumentPath = null;
  await fetchParts([bundle], { downloadObject: async () => { throw new Error('404'); } });
  assert.equal(bundle.parts[0].included, false);
  assert.equal(bundle.parts[0].reason, 'MISSING');
});

test('an external http documentPath is listed, never fetched', async () => {
  const { fetchParts } = await import('./citation-export.service.js');
  const bundle = bundleWith([]);
  bundle.sourceDocumentPath = 'https://agency.example.gov/notice/123';
  let fetched = 0;
  await fetchParts([bundle], { downloadObject: async () => { fetched += 1; return { body: Buffer.from('x') }; } });
  assert.equal(fetched, 0, 'the export must not fetch arbitrary external URLs');
  assert.equal(bundle.parts[0].reason, 'EXTERNAL');
});

test('END TO END: a real PDF attachment is APPENDED to the cover, and the page count proves it', async () => {
  const { fetchParts, composeBundlePdf } = await import('./citation-export.service.js');
  const { PDFDocument } = await import('pdf-lib');

  const attachmentPdf = await realPdf(3);
  const bundle = bundleWith([
    { id: 'a1', storagePath: 'b:notice.pdf', label: 'Agency notice', docType: 'AGENCY_NOTICE', mimeType: 'application/pdf' },
  ]);
  bundle.sourceDocumentPath = null;
  await fetchParts([bundle], { downloadObject: async () => ({ body: attachmentPdf, contentType: 'application/pdf' }) });
  assert.equal(bundle.parts[0].included, true);

  const out = await composeBundlePdf([bundle], { companyName: 'Ride' });
  const doc = await PDFDocument.load(out);
  assert.ok(doc.getPageCount() >= 4,
    `the 3 attachment pages were appended to the cover (got ${doc.getPageCount()})`);
  assert.equal(out.subarray(0, 4).toString('latin1'), '%PDF', 'the export is a real PDF');
});

test('END TO END: with no appendable attachment the export is still a valid one-PDF bundle', async () => {
  const { fetchParts, composeBundlePdf } = await import('./citation-export.service.js');
  const { PDFDocument } = await import('pdf-lib');
  const bundle = bundleWith([
    {
      id: 'a1', storagePath: 'b:letter.docx', label: 'Our letter', docType: 'DISPUTE_LETTER',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'letter.docx',
    },
  ]);
  bundle.sourceDocumentPath = null;
  await fetchParts([bundle], { downloadObject: async () => { throw new Error('must not be called'); } });
  const out = await composeBundlePdf([bundle], {});
  const doc = await PDFDocument.load(out);
  assert.ok(doc.getPageCount() >= 1);
  assert.equal(out.subarray(0, 4).toString('latin1'), '%PDF');
});
