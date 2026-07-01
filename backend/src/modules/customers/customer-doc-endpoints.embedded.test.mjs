/**
 * On-demand customer KYC document endpoints — embedded-postgres integration test.
 *
 * Covers customersService.getDocument (the service behind
 *   GET /api/customers/:id/id-photo
 *   GET /api/customers/:id/insurance-doc
 *   GET /api/customers/:id/license-back
 * ) which powers the reservation detail "Customer Documents" panel.
 *
 * Asserts:
 *   - a Storage path ('tenants/...') is signed via an INJECTED signer and the
 *     returned url is the signed URL (raw path is NEVER returned);
 *   - contentType is derived from the extension (image/pdf) and the data: mime;
 *   - an empty field returns null (route → 404);
 *   - a legacy inline data: URL passes through unchanged;
 *   - an http(s) URL passes through;
 *   - cross-tenant access is denied (scope.tenantId of A cannot read B's doc).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootEmbeddedPg } from '../../../scripts/embedded-pg-boot.mjs';
// customersService + scopeFor are imported DYNAMICALLY inside before(), AFTER
// bootEmbeddedPg sets DATABASE_URL. The shared prisma singleton binds its URL at
// import time, so importing the service earlier would give it an undefined URL.
let customersService;
let scopeFor;

let pgHandle;
let prisma;

const TAG = `DOCEP-${Date.now()}`;
const ids = { tenantA: null, tenantB: null, custA: null, custB: null };

const B64_PNG = Buffer.alloc(64, 7).toString('base64');
const INLINE_PNG = `data:image/png;base64,${B64_PNG}`;
const STORAGE_PDF = `tenants/${'A'}/customers/${'C'}/insurance_abc.pdf`;
const HTTP_URL = 'https://cdn.example.com/kyc/license-back.jpg';

// Injected signer: proves signing is invoked for storage paths and lets us
// assert the returned url is the signed URL, never the raw path.
function makeSigner() {
  const calls = [];
  const signer = async ({ bucket, path, expiresIn }) => {
    calls.push({ bucket, path, expiresIn });
    return `https://signed.example.com/${bucket}/${encodeURIComponent(path)}?token=SIGNED`;
  };
  return { signer, calls };
}

function scopeForUser(user) {
  return scopeFor({ user, query: {} });
}

before(async () => {
  pgHandle = await bootEmbeddedPg();
  prisma = pgHandle.prisma;
  ({ customersService } = await import('./customers.service.js'));
  ({ scopeFor } = await import('../../lib/tenant-scope.js'));

  const a = await prisma.tenant.create({ data: { name: `TA ${TAG}`, slug: `ta-${TAG}`.toLowerCase() } });
  const b = await prisma.tenant.create({ data: { name: `TB ${TAG}`, slug: `tb-${TAG}`.toLowerCase() } });
  ids.tenantA = a.id; ids.tenantB = b.id;

  const ca = await prisma.customer.create({
    data: {
      firstName: 'Alice', lastName: `A-${TAG}`, phone: `7870${String(Date.now()).slice(-5)}`,
      tenantId: a.id,
      idPhotoUrl: INLINE_PNG,
      insuranceDocumentUrl: `tenants/${a.id}/customers/CA/insurance_abc.pdf`,
      licenseBackUrl: HTTP_URL
    }
  });
  const cb = await prisma.customer.create({
    data: {
      firstName: 'Bob', lastName: `B-${TAG}`, phone: `9390${String(Date.now()).slice(-5)}`,
      tenantId: b.id,
      idPhotoUrl: `tenants/${b.id}/customers/CB/id_xyz.jpg`
      // insuranceDocumentUrl + licenseBackUrl intentionally left null
    }
  });
  ids.custA = ca.id; ids.custB = cb.id;
});

after(async () => {
  try {
    if (ids.custA) await prisma.customer.delete({ where: { id: ids.custA } }).catch(() => {});
    if (ids.custB) await prisma.customer.delete({ where: { id: ids.custB } }).catch(() => {});
    if (ids.tenantA) await prisma.tenant.delete({ where: { id: ids.tenantA } }).catch(() => {});
    if (ids.tenantB) await prisma.tenant.delete({ where: { id: ids.tenantB } }).catch(() => {});
  } finally {
    if (pgHandle?.stop) await pgHandle.stop();
  }
});

describe('customersService.getDocument (on-demand KYC docs)', () => {
  it('signs a Storage-path insurance doc via the injected signer and never returns the raw path', async () => {
    const scopeA = scopeForUser({ role: 'ADMIN', tenantId: ids.tenantA });
    const { signer, calls } = makeSigner();
    const doc = await customersService.getDocument(ids.custA, 'insurance', scopeA, { signer });
    assert.ok(doc, 'doc returned');
    assert.equal(calls.length, 1, 'signer invoked exactly once');
    assert.equal(calls[0].bucket, 'customer-documents', 'signs in the customer-docs bucket');
    assert.match(doc.url, /^https:\/\/signed\.example\.com\//, 'returns the signed URL');
    assert.ok(!doc.url.startsWith('tenants/'), 'raw storage path is never leaked');
    assert.equal(doc.contentType, 'application/pdf', 'contentType inferred from .pdf extension');
  });

  it('passes through a legacy inline data: URL and derives its mime', async () => {
    const scopeA = scopeForUser({ role: 'ADMIN', tenantId: ids.tenantA });
    const doc = await customersService.getDocument(ids.custA, 'id-photo', scopeA, {});
    assert.ok(doc);
    assert.equal(doc.url, INLINE_PNG, 'inline data url passes through unchanged');
    assert.equal(doc.contentType, 'image/png', 'contentType parsed from the data: mime');
  });

  it('passes through an http(s) URL (license back)', async () => {
    const scopeA = scopeForUser({ role: 'ADMIN', tenantId: ids.tenantA });
    const doc = await customersService.getDocument(ids.custA, 'license-back', scopeA, {});
    assert.ok(doc);
    assert.equal(doc.url, HTTP_URL, 'http url passes through');
    assert.equal(doc.contentType, 'image/jpeg', 'contentType inferred from .jpg extension');
  });

  it('returns null (→ 404) when the requested field is empty', async () => {
    const scopeB = scopeForUser({ role: 'ADMIN', tenantId: ids.tenantB });
    const doc = await customersService.getDocument(ids.custB, 'insurance', scopeB, {});
    assert.equal(doc, null, 'empty insurance field → null');
  });

  it('denies cross-tenant access (tenant A cannot read tenant B doc)', async () => {
    const scopeA = scopeForUser({ role: 'ADMIN', tenantId: ids.tenantA });
    const { signer, calls } = makeSigner();
    const doc = await customersService.getDocument(ids.custB, 'id-photo', scopeA, { signer });
    assert.equal(doc, null, 'cross-tenant read is denied → null');
    assert.equal(calls.length, 0, 'signer never invoked for a denied cross-tenant read');
  });

  it('returns null for an unknown kind', async () => {
    const scopeA = scopeForUser({ role: 'ADMIN', tenantId: ids.tenantA });
    const doc = await customersService.getDocument(ids.custA, 'passport', scopeA, {});
    assert.equal(doc, null);
  });
});
