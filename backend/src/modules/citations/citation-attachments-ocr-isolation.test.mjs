/**
 * Citation ATTACHMENTS never reach an AI provider. DATA-PROTECTION PATH.
 *
 * THE RISK THIS PINS. `CitationDocument` is the OCR intake queue: the
 * scheduler claims rows with `where: { status: 'PENDING' }` and ships their
 * bytes to a vision LLM. Supporting documents attached to a citation — a
 * payment receipt, a dispute letter, the renter's signed acknowledgement —
 * carry the renter's name, licence details and address. Filing them as
 * CitationDocument rows would feed all of that to a provider on a timer and
 * try to parse a receipt as a new citation.
 *
 * That is not hypothetical: Corpusa's citation OCR was deliberately disabled
 * on 2026-08-27 for the TL International disclosure, and we have stated in
 * writing that AI-assisted processing is off for that tenant. An attachment
 * feature that quietly re-opened the path would falsify that statement.
 *
 * The isolation is STRUCTURAL — a separate table with no PENDING status, which
 * the scheduler's query cannot reach — and these tests exist so it stays that
 * way. Three independent doors are checked, because any one of them alone
 * could pass for the wrong reason:
 *
 *   1. UPLOAD writes no CitationDocument row (the direct door).
 *   2. A SWEEP with attachments waiting makes no provider call and does not
 *      touch them (the scheduler door).
 *   3. Neither the attachment service nor the export service imports the
 *      extractor or writes to citationDocument (the static door — this is the
 *      one that catches a future refactor "reusing" the OCR pipeline).
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { runOnce } from './citation-ocr.scheduler.js';
import { citationAttachmentsService } from './citation-attachments.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TENANT = 'tenant-corpusa';
const CITATION = 'cit-1';

let fetchCalls = [];
let originals = {};
let attachmentStore = [];
let docStore = [];
let createArgs = [];

beforeEach(() => {
  fetchCalls = [];
  originals = {};
  attachmentStore = [];
  docStore = [];
  createArgs = [];

  process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = 'true'; // scheduler + upload gate
  process.env.ANTHROPIC_API_KEY = 'PLATFORM-HOUSE-CREDENTIAL-0001';

  // Any outbound call at all is a failure — that is the whole assertion.
  originals.fetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    throw new Error(`REFUSED: no external call may be made, but one went to ${url}`);
  };

  originals.warn = logger.warn;
  originals.info = logger.info;
  originals.error = logger.error;
  logger.warn = () => {}; logger.info = () => {}; logger.error = () => {};

  originals.prisma = {
    tenantFindMany: prisma.tenant.findMany,
    tenantFindUnique: prisma.tenant.findUnique,
    appSettingFindUnique: prisma.appSetting.findUnique,
    docFindMany: prisma.citationDocument.findMany,
    docGroupBy: prisma.citationDocument.groupBy,
    docCreate: prisma.citationDocument.create,
    docUpdate: prisma.citationDocument.update,
    docUpdateMany: prisma.citationDocument.updateMany,
    citFindFirst: prisma.citation.findFirst,
    attFindMany: prisma.citationAttachment.findMany,
    attCreate: prisma.citationAttachment.create,
  };

  prisma.tenant.findMany = async () => [{ id: TENANT }];
  prisma.tenant.findUnique = async () => ({ name: 'Corpusa' });
  // Corpusa has NO OCR credential configured — the 2026-08-27 state.
  prisma.appSetting.findUnique = async () => null;

  // The OCR queue is EMPTY. Attachments exist. If the two tables were ever
  // conflated, the sweep would find work here.
  prisma.citationDocument.findMany = async () => docStore.filter((d) => d.status === 'PENDING');
  prisma.citationDocument.groupBy = async () => [];
  prisma.citationDocument.create = async ({ data }) => {
    const row = { id: `doc-${docStore.length + 1}`, ...data };
    docStore.push(row);
    return row;
  };
  prisma.citationDocument.update = async () => ({});
  prisma.citationDocument.updateMany = async () => ({ count: 0 });

  prisma.citation.findFirst = async ({ where }) => (
    where?.id === CITATION && where?.tenantId === TENANT
      ? { id: CITATION, tenantId: TENANT, citationNo: 'A-1' }
      : null
  );
  prisma.citationAttachment.findMany = async () => attachmentStore;
  prisma.citationAttachment.create = async ({ data }) => {
    // Keep the RAW data the service passed, separately from the row the DB
    // would return — the assertion below is about what the service WROTE, and
    // a default applied by the fake would mask it.
    createArgs.push(data);
    const row = {
      id: `att-${attachmentStore.length + 1}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'ACTIVE', // the schema default
      ...data,
    };
    attachmentStore.push(row);
    return row;
  };
});

afterEach(() => {
  globalThis.fetch = originals.fetch;
  logger.warn = originals.warn;
  logger.info = originals.info;
  logger.error = originals.error;
  prisma.tenant.findMany = originals.prisma.tenantFindMany;
  prisma.tenant.findUnique = originals.prisma.tenantFindUnique;
  prisma.appSetting.findUnique = originals.prisma.appSettingFindUnique;
  prisma.citationDocument.findMany = originals.prisma.docFindMany;
  prisma.citationDocument.groupBy = originals.prisma.docGroupBy;
  prisma.citationDocument.create = originals.prisma.docCreate;
  prisma.citationDocument.update = originals.prisma.docUpdate;
  prisma.citationDocument.updateMany = originals.prisma.docUpdateMany;
  prisma.citation.findFirst = originals.prisma.citFindFirst;
  prisma.citationAttachment.findMany = originals.prisma.attFindMany;
  prisma.citationAttachment.create = originals.prisma.attCreate;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;
});

// A 1x1 PNG — real bytes, so the magic-header check passes.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

test('DOOR 1: attaching a document creates NO CitationDocument row — it never enters the OCR queue', async () => {
  const uploaded = [];
  const row = await citationAttachmentsService.upload(
    CITATION,
    {
      label: 'Reply from City of Orlando',
      docType: 'AGENCY_RESPONSE',
      fileName: 'reply.png',
      file: PNG_DATA_URL,
    },
    { tenantId: TENANT, userId: 'user-1' },
    { uploadObject: async (args) => { uploaded.push(args); return { ok: true }; } },
  );

  assert.equal(attachmentStore.length, 1, 'the attachment was stored');
  assert.equal(row.docType, 'AGENCY_RESPONSE');
  // THE ASSERTION: nothing was written to the OCR intake table.
  assert.equal(docStore.length, 0, 'an attachment must never create a CitationDocument');
  // And nothing it wrote carries the status the scheduler claims on.
  assert.equal(createArgs.length, 1);
  assert.equal(createArgs[0].status, undefined,
    'the create must not set a status at all; the column defaults to ACTIVE, never PENDING');
  assert.equal(attachmentStore[0].status, 'ACTIVE',
    'the row lands ACTIVE — a value the OCR scheduler never claims on');
  assert.equal(uploaded.length, 1, 'the bytes went to storage, not to a provider');
  assert.equal(fetchCalls.length, 0, 'no external call was made during upload');
});

test('DOOR 2: an OCR sweep with attachments waiting makes no provider call and does not touch them', async () => {
  attachmentStore = [
    {
      id: 'att-1', tenantId: TENANT, citationId: CITATION, status: 'ACTIVE',
      docType: 'PROOF_OF_PAYMENT', label: 'Receipt',
      storagePath: 'citation-documents:tenants/t/citations/c/attachments/x.png',
      mimeType: 'image/png',
    },
  ];

  // Count every write the OCR pipeline could make. Zero is the answer that
  // discriminates "structurally unreachable" from "happened not to run".
  let docWrites = 0;
  prisma.citationDocument.update = async () => { docWrites += 1; return {}; };
  prisma.citationDocument.updateMany = async () => { docWrites += 1; return { count: 1 }; };
  let attachmentWrites = 0;
  const attUpdate = prisma.citationAttachment.update;
  const attUpdateMany = prisma.citationAttachment.updateMany;
  prisma.citationAttachment.update = async () => { attachmentWrites += 1; return {}; };
  prisma.citationAttachment.updateMany = async () => { attachmentWrites += 1; return { count: 1 }; };

  try {
    await runOnce();
  } finally {
    prisma.citationAttachment.update = attUpdate;
    prisma.citationAttachment.updateMany = attUpdateMany;
  }

  assert.equal(fetchCalls.length, 0, 'the sweep made no external call');
  assert.equal(docWrites, 0, 'no document was claimed — the pipeline never started');
  assert.equal(attachmentWrites, 0, 'the sweep never wrote to CitationAttachment');
  assert.equal(attachmentStore[0].status, 'ACTIVE', 'the attachment is untouched by the sweep');
});

/**
 * Strip comments before a static check. These files DISCUSS the OCR pipeline
 * at length — that is deliberate, it is how the next reader learns why the
 * separation exists — so a naive grep would match the warnings themselves and
 * the guard would be unmaintainable. Only real code is inspected.
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1');   // line comments (not "://" in a URL)
}

test('DOOR 3 (static): the attachment and export services never import the extractor or write to the OCR queue', () => {
  for (const file of ['citation-attachments.service.js', 'citation-export.service.js', 'citation-attachments.js']) {
    const src = codeOnly(readFileSync(join(__dirname, file), 'utf8'));

    assert.ok(!/from\s+'\.\/citation-ocr\.extract\.js'/.test(src),
      `${file} must not import the OCR extractor`);
    assert.ok(!/extractCitationFields/.test(src),
      `${file} must not reference extractCitationFields`);
    assert.ok(!/from\s+'\.\/citation-ocr\.scheduler\.js'/.test(src),
      `${file} must not import the OCR scheduler`);

    assert.ok(!/citationDocument\.(create|update|updateMany|upsert|createMany)\b/.test(src),
      `${file} must not write to the CitationDocument (OCR) table`);

    // The status the scheduler claims on must never be written by this feature.
    assert.ok(!/status:\s*'PENDING'/.test(src),
      `${file} must not set status PENDING — that is the OCR scheduler's claim value`);
  }
});

test('DOOR 3b (static): the scheduler still selects ONLY CitationDocument', () => {
  const src = codeOnly(readFileSync(join(__dirname, 'citation-ocr.scheduler.js'), 'utf8'));
  assert.ok(!/citationAttachment/.test(src),
    'the OCR scheduler must never reference CitationAttachment — if this fails, the queue now reads attachments');
});
