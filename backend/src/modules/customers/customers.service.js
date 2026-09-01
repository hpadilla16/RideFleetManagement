import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { parseLocationConfig } from '../../lib/location-config.js';
import { reservationProgramWhereForScope } from '../../lib/program-category.js';
import { normalizeDob } from '../../lib/dob.js';
import { normalizeDate } from '../../lib/date-utils.js';
import {
  materializeDocumentRef,
  maybeUploadCustomerDocument,
  isStoragePath
} from './customer-documents.js';

function norm(v) {
  return String(v ?? '').trim();
}

function normLower(v) {
  return norm(v).toLowerCase();
}

function parseDateInput(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseNumberInput(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ageOnDate(dob, onDate) {
  if (!dob || !onDate) return null;
  const birth = new Date(dob);
  const ref = new Date(onDate);
  if (Number.isNaN(birth.getTime()) || Number.isNaN(ref.getTime())) return null;
  let age = ref.getFullYear() - birth.getFullYear();
  const m = ref.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < birth.getDate())) age--;
  return age;
}


async function applyCreditToUnpaidAgreements(customerId, scope = {}) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { creditBalance: true, notes: true } });
  let credit = Number(customer?.creditBalance || 0);
  if (credit <= 0) return;

  const agreements = await prisma.rentalAgreement.findMany({
    where: {
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
      reservation: { customerId },
      balance: { gt: 0 }
    },
    orderBy: { createdAt: 'asc' }
  });

  const operations = [];
  for (const a of agreements) {
    if (credit <= 0) break;
    const bal = Number(a.balance || 0);
    if (bal <= 0) continue;
    const used = Math.min(credit, bal);
    const nextBal = Number((bal - used).toFixed(2));

    operations.push(prisma.rentalAgreement.update({ where: { id: a.id }, data: { balance: nextBal } }));
    operations.push(prisma.rentalAgreementPayment.create({
      data: {
        rentalAgreementId: a.id,
        method: 'OTHER',
        amount: used,
        reference: 'CUSTOMER_CREDIT_AUTO_APPLIED',
        status: 'PAID',
        notes: 'Automatically applied from customer credit balance'
      }
    }));

    credit = Number((credit - used).toFixed(2));
  }
  if (operations.length) await prisma.$transaction(operations);

  if (credit !== Number(customer?.creditBalance || 0)) {
    const consumed = Number((Number(customer?.creditBalance || 0) - credit).toFixed(2));
    const note = `[CREDIT AUTO-APPLIED ${new Date().toISOString()}] -${consumed.toFixed(2)} applied to unpaid agreements`;
    await prisma.customer.update({
      where: { id: customerId },
      data: {
        creditBalance: credit,
        notes: customer?.notes ? `${customer.notes}\n${note}` : note
      }
    });
  }
}

async function resolveImportTenant(row, scope = {}, cache) {
  // SECURITY (P0): tenancy comes ONLY from the authenticated scope, never from
  // the uploaded rows. Previously a row could carry tenantId/tenantSlug/
  // tenantName and steer the import into another tenant (or, for a tenant-less
  // request, anywhere). A non-super-admin gets scope.tenantId (or the deny-all
  // sentinel from tenant-scope.js); a super-admin must narrow with ?tenantId so
  // scope.tenantId is set. If there is no scoped tenant we resolve to null and
  // the per-row validator rejects the row ("tenant scope required").
  if (!scope?.tenantId) return null;
  if (!cache.tenantById.has(scope.tenantId)) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: scope.tenantId },
      select: { id: true, slug: true, name: true }
    });
    cache.tenantById.set(scope.tenantId, tenant || null);
  }
  return cache.tenantById.get(scope.tenantId);
}

async function buildCustomerImportRow(row, index, scope = {}, cache = {}) {
  const tenant = await resolveImportTenant(row || {}, scope, cache);
  // tenantId comes ONLY from the authenticated scope (never row-derived).
  const tenantId = tenant?.id || null;

  const firstName = norm(row.firstName);
  const lastName = norm(row.lastName);
  const email = norm(row.email) || null;
  const phone = norm(row.phone);
  const licenseNumber = norm(row.licenseNumber) || null;
  const licenseState = norm(row.licenseState) || null;
  const dateOfBirth = row.dateOfBirth ? normalizeDob(row.dateOfBirth) : null;
  const creditBalance = parseNumberInput(row.creditBalance);

  const errors = [];
  const duplicateReasons = [];

  if (!tenantId) errors.push('tenant scope required');
  if (!firstName) errors.push('firstName required');
  if (!lastName) errors.push('lastName required');
  if (!phone) errors.push('phone required');
  if (row.dateOfBirth && !dateOfBirth) errors.push('dateOfBirth invalid');
  if (row.creditBalance && creditBalance == null) errors.push('creditBalance invalid');

  const existing = tenantId
    ? await prisma.customer.findFirst({
        where: {
          tenantId,
          OR: [
            ...(email ? [{ email }] : []),
            ...(phone ? [{ phone }] : []),
            ...(licenseNumber ? [{ licenseNumber }] : [])
          ]
        },
        select: { id: true, email: true, phone: true, licenseNumber: true }
      })
    : null;

  if (existing?.email && email && normLower(existing.email) === normLower(email)) duplicateReasons.push('email exists');
  if (existing?.phone && phone && normLower(existing.phone) === normLower(phone)) duplicateReasons.push('phone exists');
  if (existing?.licenseNumber && licenseNumber && normLower(existing.licenseNumber) === normLower(licenseNumber)) duplicateReasons.push('licenseNumber exists');

  return {
    row: index + 1,
    valid: errors.length === 0 && duplicateReasons.length === 0,
    errors,
    duplicateReasons,
    tenantId,
    tenantLabel: tenant?.name || tenant?.slug || tenantId || '',
    firstName,
    lastName,
    email,
    phone,
    normalized: {
      tenantId,
      firstName,
      lastName,
      email,
      phone,
      dateOfBirth,
      address1: norm(row.address1) || null,
      address2: norm(row.address2) || null,
      city: norm(row.city) || null,
      state: norm(row.state) || null,
      zip: norm(row.zip) || null,
      country: norm(row.country) || null,
      licenseNumber,
      licenseState,
      insurancePolicyNumber: norm(row.insurancePolicyNumber) || null,
      insuranceDocumentUrl: norm(row.insuranceDocumentUrl) || null,
      idPhotoUrl: norm(row.idPhotoUrl) || null,
      licenseBackUrl: norm(row.licenseBackUrl) || null,
      creditBalance: creditBalance ?? 0,
      doNotRent: ['1', 'true', 'yes', 'y'].includes(normLower(row.doNotRent)),
      doNotRentReason: norm(row.doNotRentReason) || null,
      notes: norm(row.notes) || null
    }
  };
}

/**
 * Build a partial { idPhotoUrl?, licenseBackUrl?, insuranceDocumentUrl? } patch
 * that replaces inline base64 doc values with Storage paths -- but only for
 * fields actually provided AND only when CUSTOMER_DOCS_STORAGE_ENABLED is on.
 * Returns null when there is nothing to rewrite. Upload is fail-safe (the
 * original value is kept on any error), so a Storage hiccup never loses a KYC
 * doc. `undefined` field values are ignored (PATCH semantics).
 */
async function _buildDocStoragePatch(fields, ctx) {
  const patch = {};
  const map = [
    ['idPhotoUrl', 'id-photo'],
    ['licenseBackUrl', 'license-back'],
    ['insuranceDocumentUrl', 'insurance']
  ];
  for (const [field, kind] of map) {
    const value = fields?.[field];
    if (value === undefined) continue;
    const next = await maybeUploadCustomerDocument(value, { ...ctx, kind });
    if (next !== value) patch[field] = next;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * Materialize the three Customer KYC doc fields (idPhotoUrl, licenseBackUrl,
 * insuranceDocumentUrl) on a customer record: Storage paths -> short-lived
 * signed URLs; legacy inline base64 and external http(s) URLs pass through;
 * signing errors collapse to ''. Returns a NEW object. Best-effort -- never
 * throws. Shared by getById and update.
 */
/**
 * Best-effort contentType for a stored document reference, derived WITHOUT
 * fetching the bytes:
 *   - data: URL   -> parse the declared mime (e.g. data:application/pdf;base64,)
 *   - http/storage path -> infer from the file extension
 *   - unknown     -> undefined (caller omits contentType)
 * Used by the on-demand doc endpoints so the client can decide image vs PDF.
 */
function _deriveDocContentType(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  const dataMatch = s.match(/^data:([^;,]+)[;,]/i);
  if (dataMatch) return String(dataMatch[1] || '').toLowerCase() || undefined;
  // Strip any query string (signed URLs carry ?token=...) before reading ext.
  const noQuery = s.split('?')[0];
  const m = noQuery.match(/\.([a-z0-9]{2,5})$/i);
  const ext = m ? m[1].toLowerCase() : '';
  const BY_EXT = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heif', gif: 'image/gif', pdf: 'application/pdf'
  };
  return BY_EXT[ext];
}

async function _materializeCustomerDocs(customer) {
  if (!customer) return customer;
  const [idPhotoUrl, licenseBackUrl, insuranceDocumentUrl] = await Promise.all([
    materializeDocumentRef(customer.idPhotoUrl),
    materializeDocumentRef(customer.licenseBackUrl),
    materializeDocumentRef(customer.insuranceDocumentUrl)
  ]);
  return { ...customer, idPhotoUrl, licenseBackUrl, insuranceDocumentUrl };
}

export const customersService = {
  // Returns a slim shape via raw SQL so the heavy idPhotoUrl/insuranceDocumentUrl fields
  // (which can each hold ~1-3 MB of base64 image data) never leave Postgres. The list endpoint
  // was previously returning the full payload (~48 MB for 300 customers, ~10s to transfer)
  // just so the table could render "Yes/No" indicators. We expose hasIdPhoto /
  // hasInsuranceDocument booleans computed in SQL instead. Full record still available via
  // getById(:id) when the user opens a specific customer.
  async list(scope = {}, options = {}) {
    const query = norm(options.query);
    const limitRaw = options.limit;
    // 2026-05-27: default raised from 200 → 2000. The frontend does its
    // search client-side via rows.filter(), so customers beyond the limit
    // were invisible to the search box — newer customers added past the
    // 200th row literally couldn't be found in the UI. The slim shape (no
    // base64 images) keeps the payload under ~600KB for 2k rows. Hard cap
    // at 5000 to guard against runaway queries.
    const limit = limitRaw == null || limitRaw === ''
      ? 2000
      : Math.min(5000, Math.max(1, Number.parseInt(String(limitRaw), 10) || 2000));

    const tenantId = scope?.tenantId || null;
    const searchPattern = query ? `%${query.toLowerCase()}%` : null;
    // VozIA gap #4 (2026-07-15): match the digits-only form of the query against the
    // derived phoneNormalized column, so a spoken "7875551234" finds a stored
    // "(787) 555-1234". Only set when the query actually carries digits.
    const searchDigits = query ? query.replace(/\D/g, '') : '';
    // Only engage the phone arm for phone-shaped queries (>= 7 digits). Shorter
    // numeric fragments in name/address searches — and the "0000000000" auto-create
    // placeholder — would otherwise flood results with unrelated customers. 7 also
    // matches the smallest variant VozIA sends (raw / last-10 / last-7).
    const phonePattern = searchDigits.length >= 7 ? `%${searchDigits}%` : null;

    // Tagged-template parameterization keeps this safe from SQL injection.
    return prisma.$queryRaw`
      SELECT
        id, "tenantId", "firstName", "lastName", email, phone,
        -- dateOfBirthEnc: field-crypto (2026-08-23) — post-backfill the plain
        -- DateTime is null; the prisma extension decrypts Enc back onto
        -- dateOfBirth and strips the Enc key from the row.
        "dateOfBirth", "dateOfBirthEnc", "licenseNumber", "licenseState",
        city, state,
        "creditBalance", "doNotRent", "doNotRentReason",
        "createdAt", "updatedAt",
        ("idPhotoUrl" IS NOT NULL AND "idPhotoUrl" <> '') AS "hasIdPhoto",
        ("insuranceDocumentUrl" IS NOT NULL AND "insuranceDocumentUrl" <> '') AS "hasInsuranceDocument"
      FROM "Customer"
      WHERE
        (${tenantId}::text IS NULL OR "tenantId" = ${tenantId})
        AND (
          ${searchPattern}::text IS NULL
          -- Phase 0 (2026-06-09): rewritten from LOWER(col) LIKE → col ILIKE
          -- and CONCAT() → || so the pg_trgm GIN indexes (migration
          -- 20260610_pg_trgm_search) can serve every arm of this OR. ILIKE is
          -- semantically identical to LOWER LIKE; CONCAT() is only STABLE so
          -- Postgres can't index it, while || is IMMUTABLE and matches the
          -- expression indexes exactly.
          OR "firstName" ILIKE ${searchPattern}
          OR "lastName" ILIKE ${searchPattern}
          -- 2026-06-06 (Ola 2.7): match the full "First Last" (and "Last First")
          -- so "Hector Padilla" finds the customer, not just "Padilla".
          OR (COALESCE("firstName", '') || ' ' || COALESCE("lastName", '')) ILIKE ${searchPattern}
          OR (COALESCE("lastName", '') || ' ' || COALESCE("firstName", '')) ILIKE ${searchPattern}
          OR email ILIKE ${searchPattern}
          OR phone ILIKE ${searchPattern}
          -- VozIA gap #4: digits-only phone match (served by the phoneNormalized trgm index)
          OR (${phonePattern}::text IS NOT NULL AND "phoneNormalized" ILIKE ${phonePattern})
        )
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `;
  },

  async getById(id, scope = {}) {
    // Program scoping (2026-07-02): a program-restricted employee must not see
    // this customer's other-program history. Reservations filter directly on
    // workflowMode; agreements partition through their (required) reservation —
    // same relation pattern as agreementProgramWhere() in
    // rental-agreements.service.js. Admin/BOTH scopes → {} (no-op).
    const progRes = reservationProgramWhereForScope(scope);
    const customer = await prisma.customer.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      include: {
        reservations: {
          where: progRes,
          orderBy: { createdAt: 'desc' },
          include: { vehicle: true, pickupLocation: true, returnLocation: true }
        }
      }
    });
    if (!customer) return null;

    const agreements = await prisma.rentalAgreement.findMany({
      where: { ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}), reservation: { customerId: id, ...progRes } },
      orderBy: { createdAt: 'desc' },
      include: { reservation: true }
    });

    const reservations = (customer.reservations || []).map((r) => {
      const cfg = parseLocationConfig(r?.pickupLocation?.locationConfig);
      const enabled = !!cfg?.underageAlertEnabled;
      const threshold = Number(cfg?.underageAlertAge ?? cfg?.chargeAgeMin ?? 21);
      const age = ageOnDate(customer.dateOfBirth, r.pickupAt);
      const underageAlert = !!enabled && Number.isFinite(threshold) && threshold >= 16 && age != null && age < threshold;
      return { ...r, underageAlert, underageAlertAge: age, underageAlertThreshold: threshold };
    });

    const unpaidBalance = agreements.reduce((s, a) => s + Number(a.balance || 0), 0);

    // Blob -> Storage migration (Phase 1): sign Storage-path doc refs for the
    // client. Legacy inline base64 / external http URLs pass through; signing
    // errors collapse to '' (best-effort). Covers the three Customer KYC docs
    // and the nested agreement.insuranceDocumentUrl.
    const { idPhotoUrl, licenseBackUrl, insuranceDocumentUrl } =
      await _materializeCustomerDocs(customer);
    const signedAgreements = await Promise.all(
      agreements.map(async (a) => ({
        ...a,
        insuranceDocumentUrl: await materializeDocumentRef(a.insuranceDocumentUrl)
      }))
    );

    return {
      ...customer,
      idPhotoUrl,
      licenseBackUrl,
      insuranceDocumentUrl,
      reservations,
      agreements: signedAgreements,
      unpaidBalance
    };
  },


  // ------------------------------------------------------------------
  // On-demand KYC document fetch (perf-safe blob delivery).
  //
  // The reservation detail page and other admin surfaces deliberately do NOT
  // ship the (potentially multi-MB) base64 doc columns in their list/detail
  // payloads. Instead they render presence booleans and call these endpoints
  // on click to materialize ONE document at a time.
  //
  // Loads ONLY the requested column (never the sibling blobs), runs it through
  // materializeDocumentRef so Storage paths become short-lived signed URLs,
  // http(s) URLs pass through, and legacy inline base64/data: URLs are returned
  // as-is. Returns { url, contentType } or null when the field is empty.
  // Tenant-scoped via the same fail-closed scope the routes pass in — a raw
  // Storage path is NEVER returned to the client.
  //
  // kind: 'id-photo' | 'insurance' | 'license-back'
  async getDocument(id, kind, scope = {}, opts = {}) {
    const FIELD_BY_KIND = {
      'id-photo': 'idPhotoUrl',
      'insurance': 'insuranceDocumentUrl',
      'license-back': 'licenseBackUrl'
    };
    const field = FIELD_BY_KIND[kind];
    if (!field) return null;

    const customer = await prisma.customer.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { [field]: true }
    });
    // Not found OR cross-tenant (fail-closed): treat identically as "no doc".
    if (!customer) return null;

    const raw = customer[field];
    if (raw == null || String(raw).trim() === '') return null;

    // Derive contentType BEFORE materializing (materialize replaces a storage
    // path with an opaque signed URL from which we can't infer the extension).
    const contentType = _deriveDocContentType(raw);

    // Storage path -> signed URL; http passthrough; inline base64 unchanged.
    // Never leak the raw storage path: if signing fails materializeDocumentRef
    // returns '' for a storage path, which we surface as "no doc" (null).
    const url = await materializeDocumentRef(raw, opts?.signer ? { signer: opts.signer } : {});
    if (isStoragePath(String(raw)) && (!url || url === '')) return null;
    if (url == null || url === '') return null;

    return contentType ? { url, contentType } : { url };
  },

  async create(data, scope = {}) {
    // Create first so we have a stable customerId for the Storage key, then --
    // when CUSTOMER_DOCS_STORAGE_ENABLED is on -- upload inline doc blobs and
    // rewrite them to Storage paths. Flag OFF: the second step is a no-op, so
    // behavior is byte-identical to before.
    const created = await prisma.customer.create({
      data: {
        // SECURITY (P0): tenant comes ONLY from the authenticated scope, never
        // from the request body. Dropped the `|| data.tenantId` fallback.
        tenantId: scope?.tenantId || null,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email ?? null,
        phone: data.phone,
        licenseNumber: data.licenseNumber ?? null,
        licenseState: data.licenseState ?? null,
        dateOfBirth: data.dateOfBirth ? normalizeDob(data.dateOfBirth) : null,
        insurancePolicyNumber: data.insurancePolicyNumber ?? null,
        insuranceExpiry: data.insuranceExpiry ? normalizeDate(data.insuranceExpiry) : null,
        insuranceDocumentUrl: data.insuranceDocumentUrl ?? null,
        address1: data.address1 ?? null,
        address2: data.address2 ?? null,
        city: data.city ?? null,
        state: data.state ?? null,
        zip: data.zip ?? null,
        country: data.country ?? null,
        idPhotoUrl: data.idPhotoUrl ?? null,
        licenseBackUrl: data.licenseBackUrl ?? null,
        creditBalance: data.creditBalance ?? 0,
        doNotRent: !!data.doNotRent,
        doNotRentReason: data.doNotRentReason ?? null,
        notes: data.notes ?? null
      }
    });
    const storagePatch = await _buildDocStoragePatch(
      { idPhotoUrl: created.idPhotoUrl, licenseBackUrl: created.licenseBackUrl, insuranceDocumentUrl: created.insuranceDocumentUrl },
      { tenantId: created.tenantId, customerId: created.id }
    );
    const stored = storagePatch
      ? await prisma.customer.update({ where: { id: created.id }, data: storagePatch })
      : created;
    return _materializeCustomerDocs(stored);
  },

  async validateBulk(rows = [], scope = {}) {
    const cache = {
      tenantById: new Map(),
      tenantBySlug: new Map(),
      tenantByName: new Map()
    };

    let validCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;
    const report = [];

    for (let idx = 0; idx < rows.length; idx += 1) {
      const built = await buildCustomerImportRow(rows[idx], idx, scope, cache);
      if (built.errors.length) invalidCount += 1;
      else if (built.duplicateReasons.length) duplicateCount += 1;
      else validCount += 1;
      report.push(built);
    }

    return {
      found: rows.length,
      valid: validCount,
      duplicates: duplicateCount,
      invalid: invalidCount,
      rows: report
    };
  },

  async importBulk(rows = [], scope = {}) {
    const validation = await this.validateBulk(rows, scope);
    const validRows = validation.rows.filter((row) => row.valid);

    if (!validRows.length) {
      return { created: 0, skipped: validation.found, validation };
    }

    await prisma.customer.createMany({
      data: validRows.map((row) => ({
        tenantId: row.normalized.tenantId,
        firstName: row.normalized.firstName,
        lastName: row.normalized.lastName,
        email: row.normalized.email,
        phone: row.normalized.phone,
        dateOfBirth: row.normalized.dateOfBirth,
        address1: row.normalized.address1,
        address2: row.normalized.address2,
        city: row.normalized.city,
        state: row.normalized.state,
        zip: row.normalized.zip,
        country: row.normalized.country,
        licenseNumber: row.normalized.licenseNumber,
        licenseState: row.normalized.licenseState,
        insurancePolicyNumber: row.normalized.insurancePolicyNumber,
        insuranceDocumentUrl: row.normalized.insuranceDocumentUrl,
        idPhotoUrl: row.normalized.idPhotoUrl,
        creditBalance: row.normalized.creditBalance,
        doNotRent: row.normalized.doNotRent,
        doNotRentReason: row.normalized.doNotRentReason,
        notes: row.normalized.notes
      }))
    });

    return {
      created: validRows.length,
      skipped: validation.found - validRows.length,
      validation
    };
  },

  async update(id, patch, scope = {}) {
    const current = await prisma.customer.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) } });
    if (!current) throw new Error('Customer not found');
    const data = { ...(patch || {}) };
    delete data.tenantId;
    if (Object.prototype.hasOwnProperty.call(data, 'dateOfBirth')) {
      data.dateOfBirth = data.dateOfBirth ? normalizeDob(data.dateOfBirth) : null;
    }
    if (Object.prototype.hasOwnProperty.call(data, 'creditBalance')) {
      data.creditBalance = Number(data.creditBalance || 0);
    }
    // Blob -> Storage (Phase 1): when the flag is ON and an incoming doc field
    // holds inline base64/data-url, upload it and persist the Storage path
    // instead. Flag OFF (or non-inline value) -> the field is written unchanged.
    const docStoragePatch = await _buildDocStoragePatch(
      {
        idPhotoUrl: Object.prototype.hasOwnProperty.call(data, 'idPhotoUrl') ? data.idPhotoUrl : undefined,
        licenseBackUrl: Object.prototype.hasOwnProperty.call(data, 'licenseBackUrl') ? data.licenseBackUrl : undefined,
        insuranceDocumentUrl: Object.prototype.hasOwnProperty.call(data, 'insuranceDocumentUrl') ? data.insuranceDocumentUrl : undefined
      },
      { tenantId: current.tenantId, customerId: id }
    );
    if (docStoragePatch) Object.assign(data, docStoragePatch);

    const row = await prisma.customer.update({ where: { id }, data });
    await applyCreditToUnpaidAgreements(id, scope);
    const fresh = await prisma.customer.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) } });
    // The returned record is sent straight to the client; after a backfill (or
    // with the flag on) the doc columns hold bare Storage paths -- sign them
    // here, exactly like getById, via the shared helper.
    return _materializeCustomerDocs(fresh);
  },

  async issuePasswordReset(id, baseUrl = 'http://localhost:3000', scope = {}) {
    const current = await prisma.customer.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Customer not found');
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1h

    const row = await prisma.customer.update({
      where: { id },
      data: { portalResetToken: token, portalResetExpiresAt: expiresAt },
      select: { id: true, email: true, firstName: true, lastName: true }
    });

    const resetLink = `${baseUrl.replace(/\/$/, '')}/customer/reset-password?token=${token}`;
    return { ...row, resetLink, expiresAt };
  },

  async remove(id, scope = {}) {
    const current = await prisma.customer.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Customer not found');
    return prisma.customer.delete({ where: { id } });
  }
};
