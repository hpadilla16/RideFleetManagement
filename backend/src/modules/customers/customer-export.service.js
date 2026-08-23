/**
 * customer-export.service.js — GDPR Article 15 / 20 data-subject EXPORT for a
 * single customer. The exact INVERSE of the Phase A erasure primitive over the
 * SAME surface: whatever erasure would scrub, export discloses.
 *
 * COMPLETE BY CONSTRUCTION
 *   Export walks the SAME customer-pii-map.js and the SAME reach resolver
 *   (customer-pii-reach.js) as erasure, so the two cannot diverge. An export that
 *   forgot a table would be a DSAR gap — but the map already enumerates every
 *   customer-reachable table, and this service reads EVERY entry in it. The
 *   schema-driven completeness test fails if a map entry has no export category.
 *
 * READ-ONLY
 *   Mutates NOTHING. Only findFirst/findMany run. There is no $transaction, no
 *   updateMany/deleteMany/update, and no storage delete. The suite asserts the
 *   store is byte-for-byte unchanged after an export.
 *
 * DISCLOSURE, NOT REDACTION
 *   This is the subject's OWN data going to the subject, so nothing is redacted —
 *   including the retained/suppression facts (they have a right to see what we
 *   keep). The ONE transform is on storage-backed media: raw storage paths and
 *   base64 blobs are never dumped. Each ref is classified the SAME three ways the
 *   map classifies them:
 *     - object path  → short-TTL SIGNED URL (best-effort; '' on signing error)
 *     - http(s) URL  → passthrough (not ours to sign)
 *     - data:/base64 → inline passthrough (it IS the person's data)
 *
 * PRIVACY
 *   No PII is ever placed in a URL/query string (the caller passes only the
 *   customer id in the path), and only { customerId, actor } is logged.
 *
 * ESM. No new npm deps (JSON output; a zip archive can come later).
 * `prisma`, `logger`, and the URL signer are injectable so the suite runs
 * DB-free and offline.
 */

import { prisma as defaultPrisma } from '../../lib/prisma.js';
import defaultLogger from '../../lib/logger.js';
import { getSignedUrl as defaultGetSignedUrl } from '../../lib/storage/index.js';
import {
  CUSTOMER_PII_MAP,
  SUBPROCESSOR,
  CUSTOMER_DOCS_BUCKET,
  PHOTOS_BUCKET,
  INVENTORY_PHOTOS_BUCKET,
  classifyStorageRef,
  collectRefsFromJson,
} from './customer-pii-map.js';
import { chunk, buildWheres, resolveTargets } from './customer-pii-reach.js';

export class CustomerNotFoundError extends Error {
  constructor(message = 'Customer not found.') {
    super(message);
    this.name = 'CustomerNotFoundError';
    this.statusCode = 404;
    this.code = 'CUSTOMER_NOT_FOUND';
  }
}

// Signed URLs minted for an export are short-lived on purpose — the export is a
// point-in-time snapshot, not a durable share. Configurable, default 5 minutes.
export function exportUrlTtlSeconds() {
  const n = Number(process.env.GDPR_EXPORT_URL_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 300;
}

// ---------------------------------------------------------------------------
// EXPORT CATEGORY REGISTRY — one output category per map model (+ the `message`
// cascade child, which has no map entry of its own but is erased via the
// Conversation cascade). This registry is the drift guard's target: the
// completeness test asserts EVERY key of CUSTOMER_PII_MAP (plus `message`) has a
// category here, so a new map entry cannot ship without an export home.
// ---------------------------------------------------------------------------
export const EXPORT_MODEL_CATEGORY = Object.freeze({
  // master row is emitted as `subject` (+ a `suppression` summary), not an array
  customer: 'subject',

  reservation: 'reservations',
  conversation: 'conversations',
  message: 'messages', // Conversation cascade child — no own map entry
  trip: 'trips',
  hostReview: 'hostReviews',
  quote: 'quotes',
  rentalAgreement: 'rentalAgreements',
  rentalAgreementAddendum: 'addenda',
  agreementDriver: 'agreementDrivers',
  reservationAdditionalDriver: 'additionalDrivers',
  agreementSectionInitial: 'agreementSectionInitials',
  rentalAgreementInspection: 'inspections',
  rentalAgreementVehicleSwap: 'vehicleSwaps',
  rentalAgreementCharge: 'agreementCharges',
  rentalAgreementPayment: 'agreementPayments',
  agreementCommission: 'agreementCommissions',
  loanerAgreement: 'loanerAgreements',
  loanerPhoto: 'loanerPhotos',
  loanerDamagePoint: 'loanerDamagePoints',
  loanerRequest: 'loanerRequests',
  tripDocument: 'tripDocuments',
  tripFulfillmentPlan: 'fulfillmentPlans',
  tripTimelineEvent: 'tripTimelineEvents',
  tripPayout: 'tripPayouts',
  reservationCharge: 'reservationCharges',
  reservationPayment: 'reservationPayments',
  customerInspection: 'customerInspections',
  reservationIncident: 'incidents',
  vehicleDamageReport: 'damageReports',
  reviewProof: 'reviewProofs',
  tripIncident: 'tripIncidents',
  tripIncidentCommunication: 'tripIncidentCommunications',
  shuttleRequest: 'shuttleRequests',
  kioskSession: 'kioskSessions',
  externalReservation: 'externalReservations',
  citationDocument: 'citationDocuments',
  citation: 'citations',
  tollTransaction: 'tolls',
  paymentOpsFlag: 'paymentOpsFlags',
  checkoutSession: 'checkoutSessions',
  auditLog: 'auditLogs',
  overdueVehicleAlert: 'overdueAlerts',
  handoffToken: 'handoffTokens',
  shuttleTrackerLink: 'shuttleTrackerLinks',
});

// The array categories (everything except the master `subject`), in the order
// they appear above — used to pre-seed an empty, complete output shape.
const ARRAY_CATEGORIES = Object.entries(EXPORT_MODEL_CATEGORY)
  .filter(([model]) => model !== 'customer')
  .map(([, category]) => category);

// ---------------------------------------------------------------------------
// Storage-ref column detection. A single-ref STRING column (a signature image, a
// KYC document, a walkaround photo) is transformed to a signed URL / inline blob
// so a raw path or base64 never lands in the export. A JSON photo-set column is
// expanded to a list of signed URLs.
//
// Object-bucket columns come first from the MAP itself (columns.storage /
// top-level storage carry the authoritative defaultBucket). Any remaining
// media-shaped column is matched by name and given a sensible default bucket;
// classifyStorageRef still honours an explicit "<bucket>:<path>" prefix, so the
// default only matters for a bare path.
// ---------------------------------------------------------------------------
const SCALAR_REF_NAME_RE =
  /(signaturedataurl|initialdataurl|declinedinsurancesignaturedataurl|dataurl|imagepath|photourl|bucketpath|storagepath|idphotourl|licensebackurl|insurancedocumenturl)$/i;
const JSON_PHOTO_NAME_RE =
  /(photojson|photostoragerefs|photosjson|estimatephotojson|fixedphotojson|previousinspectionjson|nextinspectionjson)$/i;

// ---------------------------------------------------------------------------
// SECRET-COLUMN DENY-LIST — applied CENTRALLY to every serialised row (the
// subject, every category, and the message cascade) so it can never be
// forgotten per-model. These are usable CREDENTIALS, not DSAR-relevant personal
// data: a live reset/access/capability TOKEN or a credential HASH dumped into
// JSON that could be stored or forwarded would hand someone account access.
// They are OMITTED from the output entirely.
//
// We KEEP the non-secret facts around them: a token's `*ExpiresAt` /
// `*CreatedAt` timestamp stays (it discloses "a link existed" without the value
// — and does not end in "token", so the pattern below leaves it alone), and the
// Authorize.Net profile-id REFERENCES stay as a sub-processor disclosure (a
// reference, not a usable secret).
//
//   - exact names: portalResetToken, guestAccessToken, deletionToken, token
//                  (HandoffToken.token / ShuttleTrackerLink.token) + the
//                  credential hashes nameUpdateCodeHash / codeHash / lockPinHash.
//   - by pattern:  any `*Token` VALUE column (customerInfoToken,
//                  paymentRequestToken, signatureToken, portalToken,
//                  publicToken, …); any credential `*Hash`
//                  (code/pin/token/secret/password/otp/backup).
// ---------------------------------------------------------------------------
const SECRET_COLUMN_NAMES = new Set([
  'portalResetToken', 'guestAccessToken', 'deletionToken', 'token',
  'nameUpdateCodeHash', 'codeHash', 'lockPinHash',
]);
const SECRET_TOKEN_RE = /token$/i; // a token VALUE (…Token / token) — NOT …TokenExpiresAt
const SECRET_HASH_RE = /(code|pin|token|secret|password|otp|backup)hash$/i;

export function isSecretColumn(name) {
  if (SECRET_COLUMN_NAMES.has(name)) return true;
  if (SECRET_TOKEN_RE.test(name)) return true;
  if (SECRET_HASH_RE.test(name)) return true;
  return false;
}

function heuristicBucket(column) {
  const c = String(column).toLowerCase();
  if (c.includes('bucketpath')) return INVENTORY_PHOTOS_BUCKET;
  if (c.includes('imagepath') || c.includes('storagepath') || JSON_PHOTO_NAME_RE.test(c)) return PHOTOS_BUCKET;
  return CUSTOMER_DOCS_BUCKET;
}

// Map-declared object columns for a spec → { column: defaultBucket }.
function mapDeclaredBuckets(spec) {
  const out = {};
  for (const s of spec?.columns?.storage || []) out[s.column] = s.defaultBucket;
  for (const s of spec?.storage || []) out[s.column] = s.defaultBucket;
  return out;
}

async function signSafe(signer, bucket, path, expiresIn) {
  try {
    const url = await signer({ bucket, path, expiresIn });
    return typeof url === 'string' ? url : '';
  } catch {
    return ''; // best-effort: one bad ref never breaks the whole export
  }
}

// Transform ONE scalar ref value, classified the 3 ways the map classifies refs.
async function materializeScalarRef(value, defaultBucket, signer, expiresIn) {
  const cls = classifyStorageRef(value, { defaultBucket });
  if (cls.kind === 'object') {
    return { kind: 'signed-url', bucket: cls.bucket, url: await signSafe(signer, cls.bucket, cls.path, expiresIn) };
  }
  if (cls.kind === 'url') return { kind: 'url', url: cls.value };
  if (cls.kind === 'inline') return { kind: 'inline', value: cls.value };
  return null; // empty
}

// Transform a JSON photo-set column to a list of signed URLs (paths never leak).
async function materializeJsonRefs(value, defaultBucket, signer, expiresIn) {
  const refs = collectRefsFromJson(value, { defaultBucket });
  const signed = [];
  for (const r of refs) {
    signed.push({ kind: 'signed-url', bucket: r.bucket, url: await signSafe(signer, r.bucket, r.path, expiresIn) });
  }
  return { kind: 'photo-set', count: signed.length, refs: signed };
}

/**
 * Serialise one row: copy every scalar column verbatim (the subject's own data —
 * nothing redacted) EXCEPT storage-backed media columns, which are converted to
 * signed URLs / inline blobs so no raw path or base64 is dumped.
 */
async function serializeRow(spec, row, signer, expiresIn) {
  const declared = mapDeclaredBuckets(spec);
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    // Central deny-list: usable credentials are OMITTED from every row, always.
    if (isSecretColumn(k)) continue;
    if (v == null) { out[k] = v; continue; }
    if (JSON_PHOTO_NAME_RE.test(k)) {
      out[k] = await materializeJsonRefs(v, declared[k] || heuristicBucket(k), signer, expiresIn);
      continue;
    }
    if (typeof v === 'string' && (declared[k] || SCALAR_REF_NAME_RE.test(k))) {
      out[k] = await materializeScalarRef(v, declared[k] || heuristicBucket(k), signer, expiresIn);
      continue;
    }
    out[k] = v;
  }
  return out;
}

// Read every row a spec matches across its (chunked / OR) wheres, de-duped by id.
async function readRows(prisma, spec, wheres) {
  const seen = new Set();
  const rows = [];
  for (const where of wheres) {
    const found = await prisma[spec.model].findMany({ where });
    for (const r of found) {
      if (r && r.id != null) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
      }
      rows.push(r);
    }
  }
  return rows;
}

/**
 * exportCustomer — assemble the full data-subject export for one customer.
 *
 * @param {string} customerId
 * @param {object} opts
 * @param {string} [opts.actor]  - who requested (audit string, logged)
 * @param {object} [opts.scope]  - tenant scope { tenantId? } (fail-closed lookup)
 * @param {object} [deps] - { prisma, logger, getSignedUrl }
 * @returns {Promise<object>} the structured export
 */
export async function exportCustomer(customerId, opts = {}, deps = {}) {
  const { actor = 'unknown', scope = {} } = opts;
  const {
    prisma = defaultPrisma,
    logger = defaultLogger,
    getSignedUrl = defaultGetSignedUrl,
  } = deps;

  if (!customerId || typeof customerId !== 'string') {
    const err = new Error('customerId is required');
    err.statusCode = 400;
    throw err;
  }

  const expiresIn = exportUrlTtlSeconds();

  // Fail-closed tenant lookup — a tenant-A admin cannot reach a tenant-B customer.
  const tenantWhere = scope?.tenantId ? { tenantId: String(scope.tenantId) } : {};
  const customer = await prisma.customer.findFirst({ where: { id: customerId, ...tenantWhere } });
  if (!customer) throw new CustomerNotFoundError();

  const ctx = await resolveTargets(prisma, customer);

  // Pre-seed a COMPLETE, empty shape so the export always exposes every category
  // (a category with no rows is proof we looked, not proof we forgot).
  const data = {};
  for (const category of ARRAY_CATEGORIES) data[category] = [];

  // (1) MASTER ROW → `subject` (+ suppression summary). Nothing redacted.
  const customerSpec = CUSTOMER_PII_MAP.customer;
  data.subject = await serializeRow(customerSpec, customer, getSignedUrl, expiresIn);
  data.suppression = {
    doNotRent: customer.doNotRent ?? null,
    doNotRentReason: customer.doNotRentReason ?? null,
  };

  // (2) EVERY OTHER MAP ENTRY → its category array. Same map, same reach.
  for (const spec of Object.values(CUSTOMER_PII_MAP)) {
    if (spec.match.kind === 'self') continue; // master handled above
    const category = EXPORT_MODEL_CATEGORY[spec.model];
    if (!category) continue; // guarded by the completeness test
    const wheres = buildWheres(spec, ctx);
    if (!wheres.length) continue;
    const rows = await readRows(prisma, spec, wheres);
    data[category] = [];
    for (const row of rows) data[category].push(await serializeRow(spec, row, getSignedUrl, expiresIn));
  }

  // (3) Message cascade child of Conversation — no map entry, but the subject's
  // own chat content, so it is exported (and would be erased with the parent).
  data.messages = [];
  for (const c of chunk(ctx.conversationIds)) {
    const msgs = await prisma.message.findMany({ where: { conversationId: { in: c } } });
    for (const m of msgs) data.messages.push(await serializeRow({}, m, getSignedUrl, expiresIn));
  }

  // Sub-processor disclosure: we tell the subject a card profile is/was held
  // upstream at Authorize.Net, WITHOUT re-fetching card data from the processor.
  const authnetProfileId = customer[SUBPROCESSOR.authnet.profileIdColumn]
    ? String(customer[SUBPROCESSOR.authnet.profileIdColumn]).trim()
    : null;

  const output = {
    ok: true,
    kind: 'gdpr-customer-export',
    generatedAt: new Date().toISOString(),
    customerId,
    actor,
    urlTtlSeconds: expiresIn,
    subProcessors: {
      authnet: authnetProfileId
        ? { held: true, profileId: authnetProfileId, note: 'Card data is held by Authorize.Net (sub-processor); request it from them directly.' }
        : { held: false },
    },
    data,
  };

  try {
    logger.info('customer-export-generated', { customerId, actor });
  } catch { /* logging must never throw */ }

  return output;
}

export default { exportCustomer, CustomerNotFoundError, EXPORT_MODEL_CATEGORY, exportUrlTtlSeconds };
