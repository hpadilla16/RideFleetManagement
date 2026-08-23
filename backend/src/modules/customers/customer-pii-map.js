/**
 * customer-pii-map.js — THE SINGLE SOURCE OF TRUTH for where customer PII lives
 * in the RideFleet data model, and what the GDPR erasure primitive is allowed
 * to do to each place.
 *
 * WHY THIS FILE EXISTS
 *   Customer PII is reachable FOUR ways — the master row, direct FK holders,
 *   denormalised snapshot columns on contracts/trips, and the Authorize.Net
 *   sub-processor. Every table that got a denormalised copy but was never added
 *   to the anonymiser is a silent gap. QA's finding: the worst gaps are
 *   cascade-CHILDREN of a RETAINED parent — the parent row is kept, so the DB
 *   cascade never fires, so the child's PII survives. This map enumerates them.
 *   Imported by Phase A (erase), Phase B (export), Phase C (sweep) so all three
 *   read ONE list and cannot drift apart.
 *
 * ====================================================================
 * RETENTION MODE (config, NOT hard-coded — legal set is being researched)
 * ====================================================================
 *   GDPR_RETENTION_MODE selects how much survives on the statutory records we
 *   cannot hard-delete (Reservation/RentalAgreement — FK RESTRICT):
 *
 *   - CONSERVATIVE (default): retain the non-identifying accounting/contract
 *       facts (amounts, agreementNumber, dates, vehicle/location IDs) PLUS the
 *       customer LAST name on agreements; erase every other PII column.
 *   - FULL_DELETE: the retention set is EMPTY — erase EVERY PII column,
 *       INCLUDING customerLastName, keeping only truly non-PII structural
 *       columns (amounts, IDs, timestamps). We still cannot DELETE the
 *       Reservation/RentalAgreement rows, so FULL_DELETE == anonymise every PII
 *       column on them.
 *
 *   Switching modes is a CONFIG change (env var), never a code change. Columns
 *   are classified below as:
 *     - ALWAYS ERASED : listed in a spec's columns.redact / columns.null /
 *                       columns.jsonEmpty / columns.storage — erased in BOTH modes.
 *     - CONSERVATIVE-RETAINED : listed in a spec's columns.conservativeRetain —
 *                       retained in CONSERVATIVE, erased (redacted) in FULL_DELETE.
 *                       Today that is ONLY customerLastName on the two agreement
 *                       models.
 *     - ALWAYS RETAINED : any column NOT in any list — amounts, IDs, timestamps,
 *                       agreementNumber, vehicle-condition photos. Never touched.
 *
 * RETENTION-EXCEPTION FIELD MAP (the CONSERVATIVE default, encoded once):
 *   - Agreements: RETAIN agreementNumber + all money columns + timestamps +
 *       vehicle/location IDs + customerLastName. ERASE dateOfBirth, licence
 *       number/state/expiry, insurance/licence image refs (+ delete the bytes),
 *       email, phone, address*, IPs, cardOnFileToken/Last4, first name,
 *       signature images, live capability tokens.
 *   - Payments/accounting: retain amounts + reference + timestamps; erase the
 *       free-text notes columns (they can carry PII).
 *   - Damage/incident: retain damage facts + amounts + VEHICLE photos; erase
 *       customerAck signature/name/IP, person photos, free-text notes.
 *   - Signatures: retain signedAt + termsVersion; erase the signature IMAGE.
 *
 * VEHICLE PHOTOS ARE RETAINED. Inspection walkarounds, LoanerPhoto sets,
 *   VehicleDamageReport / IncidentEvidence photos and the swap inspection JSON
 *   are vehicle-CONDITION evidence on a retained contract; only the
 *   person-identifying columns beside them are erased. Each such decision is
 *   documented in a `retainedPhotoNote` so QA + counsel can see it.
 *
 * LIVE CAPABILITY TOKENS. Any unexpired token that resolves to a (now
 *   anonymised) reservation is revoked: per-reservation token columns are
 *   nulled, and the ephemeral token tables (HandoffToken, ShuttleTrackerLink)
 *   are hard-deleted.
 *
 * doNotRent SUPPRESSION: erasure SETS Customer.doNotRent = true + reason — a
 *   minimised suppression record retained ON PURPOSE. The erasure report
 *   discloses it; we do NOT claim total erasure.
 *
 * ESM. No new npm deps. Pure data + tiny classifiers; no DB/network here.
 */

import { CUSTOMER_DOCS_BUCKET } from './customer-documents.js';

// ---------------------------------------------------------------------------
// Buckets (kept in sync with the upload sites). deleteObject swallows 404, so a
// mis-guessed default bucket on a bare path is a harmless no-op; the DB column
// is nulled regardless. The explicit "<bucket>:<path>" form carries its own
// bucket.
// ---------------------------------------------------------------------------
export { CUSTOMER_DOCS_BUCKET };
export const PHOTOS_BUCKET =
  process.env.SUPABASE_STORAGE_PHOTOS_BUCKET || 'inspection-photos';
export const INVENTORY_PHOTOS_BUCKET =
  process.env.SUPABASE_STORAGE_INVENTORY_BUCKET || 'inventory-photos';

// Sentinel written into required, non-null identity columns we cannot null.
export const REDACTION = '[erased]';

// ---------------------------------------------------------------------------
// Retention mode config.
// ---------------------------------------------------------------------------
export const RETENTION_MODES = Object.freeze({ CONSERVATIVE: 'CONSERVATIVE', FULL_DELETE: 'FULL_DELETE' });

/**
 * The active retention mode, read fresh from env so an operator toggle needs no
 * restart. Anything other than the exact string 'FULL_DELETE' (case-insensitive)
 * is CONSERVATIVE — the safe default while the legal set is researched.
 */
export function getRetentionMode() {
  return String(process.env.GDPR_RETENTION_MODE || '').toUpperCase() === RETENTION_MODES.FULL_DELETE
    ? RETENTION_MODES.FULL_DELETE
    : RETENTION_MODES.CONSERVATIVE;
}

/**
 * STATUTORY_RETENTION_FIELDS — for a given mode, the columns retained on the
 * statutory records. CONSERVATIVE keeps customerLastName on the agreement
 * models; FULL_DELETE keeps nothing (the set is empty → those columns are
 * erased too). This is the ONE switch legal research will flip.
 */
export function statutoryRetentionFields(mode = getRetentionMode()) {
  if (mode === RETENTION_MODES.FULL_DELETE) return Object.freeze({});
  return Object.freeze({
    rentalAgreement: ['customerLastName'],
    loanerAgreement: ['customerLastName'],
  });
}

// ---------------------------------------------------------------------------
// Storage-ref classification. A stored reference is one of:
//   - 'object'  a real Storage object we can delete (bare path w/ default
//               bucket, or the explicit "<bucket>:<path>" form).
//   - 'url'     external http(s) URL — not ours to delete; just null the col.
//   - 'inline'  data: URL or raw base64 blob — no object; just null it.
//   - 'empty'   null/blank.
// ORDER MATTERS: http and data: contain ':' and must be tested before the
// "<bucket>:<path>" split; a raw base64 blob can contain '/' and must be tested
// before the bare-path branch.
// ---------------------------------------------------------------------------
export function classifyStorageRef(value, { defaultBucket } = {}) {
  if (value == null) return { kind: 'empty' };
  const s = String(value).trim();
  if (!s) return { kind: 'empty' };

  if (/^https?:\/\//i.test(s)) return { kind: 'url', value: s };
  if (/^data:/i.test(s)) return { kind: 'inline', value: s };

  const m = s.match(/^([a-z0-9][a-z0-9._-]*):(.+)$/i);
  if (m && !m[1].includes('/') && !m[2].startsWith('//')) {
    return { kind: 'object', bucket: m[1], path: m[2] };
  }

  if (s.length > 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    return { kind: 'inline', value: s };
  }

  if (s.includes('/')) return { kind: 'object', bucket: defaultBucket, path: s };

  return { kind: 'inline', value: s };
}

/**
 * Collect deletable Storage objects out of JSON photo-ref shapes:
 *   - { storage: true, bucket, refs: [{ path }, ...] }
 *   - [{ path }, ...] | [{ storagePath }, ...]
 * Returns [{ bucket, path }]. Defensive; never throws. Provided for Phase C
 * reuse; Phase A retains vehicle photos and does not call this on them.
 */
export function collectRefsFromJson(json, { defaultBucket } = {}) {
  const out = [];
  if (json == null) return out;
  let parsed = json;
  if (typeof json === 'string') {
    try { parsed = JSON.parse(json); } catch { return out; }
  }
  const push = (bucket, path) => {
    if (path && typeof path === 'string') out.push({ bucket: bucket || defaultBucket, path });
  };
  if (Array.isArray(parsed)) {
    for (const r of parsed) if (r && typeof r === 'object') push(r.bucket || defaultBucket, r.path || r.storagePath);
    return out;
  }
  if (parsed && typeof parsed === 'object') {
    const bucket = parsed.bucket || defaultBucket;
    const refs = Array.isArray(parsed.refs) ? parsed.refs : [];
    for (const r of refs) if (r && typeof r === 'object') push(r.bucket || bucket, r.path || r.storagePath);
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE MAP. One entry per model that holds customer PII. `columns` names the
// exact Prisma scalar fields (verified against schema.prisma 2026-08-22):
//   redact             → REDACTION sentinel (required, non-null identity columns)
//   null               → null (nullable columns)
//   zero               → 0
//   jsonEmpty          → [{ column, value }] required Json set to an empty value
//   conservativeRetain → retained in CONSERVATIVE, redacted in FULL_DELETE
//   storage            → [{ column, defaultBucket, requiredRedact? }] refs whose
//                        bytes we reap; non-required storage cols are also in null
// `match` documents HOW rows are found (the service implements each kind).
// `retention`: RETAIN_STATUTORY | ANONYMISE | HARD_DELETE | RETAIN_PHOTOS
// ---------------------------------------------------------------------------
export const CUSTOMER_PII_MAP = Object.freeze({
  // (1) MASTER ROW ---------------------------------------------------------
  customer: {
    model: 'customer',
    label: 'Customer',
    retention: 'ANONYMISE',
    match: { kind: 'self' },
    columns: {
      redact: ['firstName', 'lastName', 'phone'],
      null: [
        'email', 'phoneNormalized', 'licenseNumber', 'licenseState', 'dateOfBirth',
        'insurancePolicyNumber', 'insuranceExpiry', 'insuranceDocumentUrl',
        'address1', 'address2', 'city', 'state', 'zip', 'country',
        'idPhotoUrl', 'licenseBackUrl', 'locale',
        'authnetCustomerProfileId', 'authnetPaymentProfileId',
        'cardLast4', 'cardBrand', 'cardExpiresMonth', 'cardExpiresYear', 'cardUpdatedAt',
        'portalResetToken', 'portalResetExpiresAt',
        'guestAccessToken', 'guestAccessExpiresAt',
        'deletionToken', 'deletionTokenExpiresAt',
        'notes',
      ],
      zero: ['creditBalance'],
      storage: [
        { column: 'idPhotoUrl', defaultBucket: CUSTOMER_DOCS_BUCKET },
        { column: 'licenseBackUrl', defaultBucket: CUSTOMER_DOCS_BUCKET },
        { column: 'insuranceDocumentUrl', defaultBucket: CUSTOMER_DOCS_BUCKET },
      ],
    },
    suppression: true,
  },

  // (2) DIRECT FK HOLDERS --------------------------------------------------
  reservation: {
    model: 'reservation',
    label: 'Reservation',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'customerFk', field: 'customerId' },
    columns: {
      null: [
        'signatureDataUrl', 'signatureSignedBy', 'notes', 'flightNumber',
        'pickupInstructions', 'customerInfoReviewNote',
        'loanerBillingContactName', 'loanerBillingContactEmail', 'loanerBillingContactPhone',
        'loanerBorrowerPacketJson',
        // Live capability tokens that resolve to this reservation — revoked.
        'customerInfoToken', 'customerInfoTokenExpiresAt',
        'signatureToken', 'signatureTokenExpiresAt',
        'paymentRequestToken', 'paymentRequestTokenExpiresAt',
      ],
    },
    retainNote:
      'Retain the whole rental record (money, status, vehicle/location, timestamps). ' +
      'Erase the pre-check-in signature image, free-text notes, and live tokens.',
  },
  conversation: {
    model: 'conversation',
    label: 'Conversation (+ Message children)',
    retention: 'HARD_DELETE',
    match: { kind: 'customerFk', field: 'customerId' },
    storage: [{ column: 'pickupPhotoUrl', defaultBucket: CUSTOMER_DOCS_BUCKET }],
    cascades: ['message'],
  },
  trip: {
    model: 'trip',
    label: 'Trip',
    retention: 'ANONYMISE',
    match: { kind: 'customerFk', field: 'guestCustomerId' },
    columns: { null: ['notes'] },
  },
  hostReview: {
    model: 'hostReview',
    label: 'HostReview',
    retention: 'ANONYMISE',
    match: { kind: 'customerFk', field: 'guestCustomerId' },
    columns: { null: ['reviewerName', 'comments', 'publicToken', 'publicTokenExpiresAt'] },
  },
  quote: {
    model: 'quote',
    label: 'Quote',
    retention: 'ANONYMISE',
    match: { kind: 'quote', fields: ['customerId', 'contactEmail', 'contactPhone'] },
    columns: { null: ['contactName', 'contactPhone', 'contactEmail'] },
  },

  // (3) DENORMALISED PII SNAPSHOT COLUMNS ---------------------------------
  rentalAgreement: {
    model: 'rentalAgreement',
    label: 'RentalAgreement',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'reservationRelation', field: 'reservationId' },
    columns: {
      redact: ['customerFirstName'],
      conservativeRetain: ['customerLastName'], // retained CONSERVATIVE, redacted FULL_DELETE
      null: [
        'customerEmail', 'customerPhone',
        'customerAddress1', 'customerAddress2', 'customerCity', 'customerState',
        'customerZip', 'customerCountry',
        'dateOfBirth', 'licenseNumber', 'licenseState', 'licenseExpiry',
        'insurancePolicyNumber', 'insuranceDocumentUrl',
        'tcSignatureDataUrl', 'tcSignerName', 'tcCustomerIp',
        'declinedInsuranceSignatureDataUrl',
        'cardOnFileToken', 'cardOnFileLast4', 'cardOnFileBrand', 'cardOnFileType',
        'notes',
      ],
      storage: [{ column: 'insuranceDocumentUrl', defaultBucket: CUSTOMER_DOCS_BUCKET }],
    },
    retainNote:
      'agreementNumber, money columns, deposits, timestamps and vehicle/location ' +
      'IDs always retained. customerLastName retained in CONSERVATIVE only. ' +
      'Signature IMAGES erased; their signedAt timestamps stay.',
  },
  rentalAgreementAddendum: {
    model: 'rentalAgreementAddendum',
    label: 'RentalAgreementAddendum',
    retention: 'ANONYMISE', // Cascade child of a RETAINED agreement
    match: { kind: 'agreementRelation', field: 'rentalAgreementId' },
    columns: {
      null: [
        'signatureSignedBy', 'signatureDataUrl', 'signatureIp',
        'signatureToken', 'signatureTokenExpiresAt', // live signing token — revoked
      ],
    },
    retainNote: 'Retain the addendum reason + charge deltas; erase the signature image, IP + token.',
  },
  agreementDriver: {
    model: 'agreementDriver',
    label: 'AgreementDriver',
    retention: 'ANONYMISE',
    match: { kind: 'agreementRelation', field: 'rentalAgreementId' },
    columns: {
      redact: ['firstName', 'lastName'],
      null: ['email', 'phone', 'licenseNumber', 'licenseState', 'licenseExpiry', 'dateOfBirth'],
    },
  },
  reservationAdditionalDriver: {
    model: 'reservationAdditionalDriver',
    label: 'ReservationAdditionalDriver',
    retention: 'ANONYMISE',
    match: { kind: 'reservationRelation', field: 'reservationId' },
    columns: {
      redact: ['firstName', 'lastName'],
      null: ['address', 'dateOfBirth', 'licenseNumber', 'notes'],
    },
  },
  agreementSectionInitial: {
    model: 'agreementSectionInitial',
    label: 'AgreementSectionInitial',
    retention: 'ANONYMISE',
    match: { kind: 'agreementRelation', field: 'agreementId' },
    columns: { redact: ['initialDataUrl'], null: ['customerIp'] },
    retainNote: 'Keep sectionKey + signedAt; erase the initials image + customer IP.',
  },
  rentalAgreementInspection: {
    model: 'rentalAgreementInspection',
    label: 'RentalAgreementInspection',
    retention: 'ANONYMISE',
    match: { kind: 'agreementRelation', field: 'rentalAgreementId' },
    columns: { null: ['actorIp'] },
    retainedPhotoNote: 'photosJson + photoStorageRefs are vehicle-condition evidence — retained.',
  },
  rentalAgreementVehicleSwap: {
    model: 'rentalAgreementVehicleSwap',
    label: 'RentalAgreementVehicleSwap',
    retention: 'ANONYMISE',
    match: { kind: 'agreementRelation', field: 'rentalAgreementId' },
    columns: { null: ['note'] },
    retainedPhotoNote: 'previousInspectionJson / nextInspectionJson are vehicle-condition photos — retained.',
  },
  rentalAgreementCharge: {
    model: 'rentalAgreementCharge',
    label: 'RentalAgreementCharge',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'agreementRelation', field: 'rentalAgreementId' },
    // No PII columns to erase: `name` is a required accounting line label (fee /
    // product name), retained as an accounting fact. Documented per the sweep.
    columns: {},
    retainNote: 'Accounting line items — `name` is a fee/product label, retained.',
  },
  rentalAgreementPayment: {
    model: 'rentalAgreementPayment',
    label: 'RentalAgreementPayment',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'agreementRelation', field: 'rentalAgreementId' },
    columns: { null: ['notes'] },
    retainNote: 'Payment facts (amount, method, reference, timestamps) retained; free-text notes erased.',
  },
  agreementCommission: {
    model: 'agreementCommission',
    label: 'AgreementCommission',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'agreementRelation', field: 'rentalAgreementId' },
    columns: { null: ['notes'] },
    retainNote: 'Commission accounting retained; free-text notes erased.',
  },
  loanerAgreement: {
    model: 'loanerAgreement',
    label: 'LoanerAgreement',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'reservationRelation', field: 'reservationId' },
    columns: {
      redact: ['customerFirstName'],
      conservativeRetain: ['customerLastName'],
      null: [
        'customerEmail', 'customerPhone', 'dateOfBirth',
        'licenseNumber', 'licenseState', 'licenseExpiry', 'licenseImagePath',
        'insurancePolicyNumber', 'insuranceImagePath',
        'signatureDataUrl', 'signerName', 'signerIp',
        'portalRequestNote', 'notes',
        // Live capability tokens — revoked.
        'signatureToken', 'signatureTokenExpiresAt', 'portalToken', 'portalTokenExpiresAt',
      ],
      storage: [
        { column: 'licenseImagePath', defaultBucket: PHOTOS_BUCKET },
        { column: 'insuranceImagePath', defaultBucket: PHOTOS_BUCKET },
      ],
    },
    retainNote: 'Retain agreementNumber + money + timestamps + vehicle; customerLastName retained CONSERVATIVE only.',
  },
  loanerPhoto: {
    model: 'loanerPhoto',
    label: 'LoanerPhoto',
    retention: 'RETAIN_PHOTOS',
    match: { kind: 'loanerRelation', field: 'loanerAgreementId' },
    retainedPhotoNote: 'Walkaround / damage VEHICLE photos on a retained loaner agreement — retained.',
  },
  loanerDamagePoint: {
    model: 'loanerDamagePoint',
    label: 'LoanerDamagePoint',
    retention: 'ANONYMISE',
    match: { kind: 'loanerRelation', field: 'loanerAgreementId' },
    columns: { null: ['note'] },
    retainNote: 'Retain the damage coordinate + severity + photo link; erase the free-text note.',
  },
  loanerRequest: {
    model: 'loanerRequest',
    label: 'LoanerRequest',
    retention: 'ANONYMISE',
    match: { kind: 'loanerRequest', fields: ['name', 'phone', 'email'] },
    columns: { redact: ['name', 'phone'], null: ['email', 'notes'] },
  },
  tripDocument: {
    model: 'tripDocument',
    label: 'TripDocument',
    retention: 'HARD_DELETE',
    match: { kind: 'tripRelation', field: 'tripId' },
  },
  tripFulfillmentPlan: {
    model: 'tripFulfillmentPlan',
    label: 'TripFulfillmentPlan',
    retention: 'ANONYMISE',
    match: { kind: 'tripRelation', field: 'tripId' },
    columns: {
      null: [
        'exactAddress1', 'exactAddress2', 'city', 'state', 'postalCode', 'country',
        'latitude', 'longitude', 'instructions',
      ],
    },
    retainNote: 'Erase the exact delivery address, coordinates + instructions (the guest home).',
  },
  tripTimelineEvent: {
    model: 'tripTimelineEvent',
    label: 'TripTimelineEvent',
    retention: 'ANONYMISE',
    match: { kind: 'tripRelation', field: 'tripId' },
    columns: { null: ['notes', 'metadata'] },
  },
  tripPayout: {
    model: 'tripPayout',
    label: 'TripPayout',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'tripRelation', field: 'tripId' },
    columns: { null: ['notes'] },
    retainNote: 'Payout accounting retained; free-text notes erased.',
  },
  reservationCharge: {
    model: 'reservationCharge',
    label: 'ReservationCharge',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'reservationRelation', field: 'reservationId' },
    columns: { null: ['notes'] },
    retainNote: '`name` is an accounting line label (retained); free-text notes erased.',
  },
  reservationPayment: {
    model: 'reservationPayment',
    label: 'ReservationPayment',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'reservationRelation', field: 'reservationId' },
    columns: { null: ['notes'] },
    retainNote: 'Payment facts retained; free-text notes erased.',
  },
  customerInspection: {
    model: 'customerInspection',
    label: 'CustomerInspection',
    retention: 'ANONYMISE',
    match: { kind: 'reservationOrAgreement', fields: ['reservationId', 'rentalAgreementId'] },
    columns: { null: ['emailTo'] },
    retainNote: 'Denormalised inspection-invite queue row; erase the recipient email.',
  },
  reservationIncident: {
    model: 'reservationIncident',
    label: 'ReservationIncident (+ IncidentEvidence)',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'reservationRelation', field: 'reservationId' },
    columns: {},
    retainedPhotoNote:
      'IncidentEvidence photos are vehicle damage evidence — retained. Certifier ' +
      'signature/name are staff, not the erasure subject — retained.',
  },
  vehicleDamageReport: {
    model: 'vehicleDamageReport',
    label: 'VehicleDamageReport',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'reservationScalar', field: 'reservationId' },
    columns: { null: ['customerAckSignatureDataUrl', 'customerAckSignerName', 'customerAckIp'] },
    retainedPhotoNote: 'photoJson / estimatePhotoJson / fixedPhotoJson are vehicle photos — retained.',
  },
  reviewProof: {
    model: 'reviewProof',
    label: 'ReviewProof',
    retention: 'ANONYMISE',
    match: { kind: 'reservationOrAgreement', fields: ['reservationId', 'rentalAgreementId'] },
    columns: {
      null: ['aiReviewerName', 'aiNotes'],
      jsonEmpty: [{ column: 'photoJson', value: {} }], // screenshot of the public review — carries the reviewer's name/text
    },
    retainNote: 'Retain the commission money/status; erase the reviewer name, AI notes + the review screenshot.',
  },
  tripIncident: {
    model: 'tripIncident',
    label: 'TripIncident (+ TripIncidentCommunication)',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'reservationRelation', field: 'reservationId' },
    columns: {},
    retainNote: 'Retain incident facts + amounts; scrub the communication child.',
  },
  tripIncidentCommunication: {
    model: 'tripIncidentCommunication',
    label: 'TripIncidentCommunication',
    retention: 'ANONYMISE',
    match: { kind: 'tripIncidentRelation', field: 'incidentId' },
    columns: { null: ['subject', 'message', 'attachmentsJson', 'senderRefId', 'publicToken', 'publicTokenExpiresAt'] },
  },
  shuttleRequest: {
    model: 'shuttleRequest',
    label: 'ShuttleRequest',
    retention: 'ANONYMISE',
    match: { kind: 'reservationRelation', field: 'reservationId' },
    columns: {
      redact: ['customerName'],
      null: ['customerPhone', 'pickupNote', 'delayNoticesJson', 'closeReason'],
    },
  },
  kioskSession: {
    model: 'kioskSession',
    label: 'KioskSession',
    retention: 'ANONYMISE',
    match: { kind: 'reservationScalar', field: 'reservationId' },
    columns: { null: ['nameUpdateCodeHash'], jsonEmpty: [{ column: 'eventsJson', value: [] }] },
    retainNote: 'Keep the payment-intent refs (late-payment resolution) + outcome + timestamps.',
  },
  externalReservation: {
    model: 'externalReservation',
    label: 'ExternalReservation',
    retention: 'ANONYMISE',
    match: { kind: 'externalReservation', fields: ['promotedToReservationId', 'customerEmail'] },
    columns: {
      null: [
        'customerFirstName', 'customerLastName', 'customerEmail', 'customerPhone',
        'customerCountry', 'flightNumber',
      ],
      jsonEmpty: [{ column: 'rawJson', value: {} }],
    },
  },
  citationDocument: {
    model: 'citationDocument',
    label: 'CitationDocument',
    retention: 'ANONYMISE',
    match: { kind: 'citationDocument', field: 'citationId' },
    columns: {
      null: ['ocrJson'],
      storage: [{ column: 'bucketPath', defaultBucket: INVENTORY_PHOTOS_BUCKET, requiredRedact: true }],
    },
  },

  // (2b) LIVE CAPABILITY TOKEN TABLES — hard-deleted so no unexpired token can
  // resolve to the anonymised reservation. Ephemeral, no money/audit value.
  handoffToken: {
    model: 'handoffToken',
    label: 'HandoffToken',
    retention: 'HARD_DELETE',
    match: { kind: 'reservationRelation', field: 'reservationId' },
  },
  shuttleTrackerLink: {
    model: 'shuttleTrackerLink',
    label: 'ShuttleTrackerLink',
    retention: 'HARD_DELETE',
    // token is a required @unique column, so we cannot null it (collisions);
    // the link is ephemeral, so delete it outright to revoke access.
    match: { kind: 'reservationRelation', field: 'reservationId' },
  },
});

// (4) SUB-PROCESSOR — Authorize.Net CIM. Handled by the service after commit:
// delete the customer profile upstream (best-effort) and null the local
// authnet* IDs + card* metadata (already listed under `customer`).
export const SUBPROCESSOR = Object.freeze({
  authnet: {
    profileIdColumn: 'authnetCustomerProfileId',
    paymentProfileIdColumn: 'authnetPaymentProfileId',
  },
});

export default {
  CUSTOMER_PII_MAP,
  SUBPROCESSOR,
  CUSTOMER_DOCS_BUCKET,
  PHOTOS_BUCKET,
  INVENTORY_PHOTOS_BUCKET,
  REDACTION,
  RETENTION_MODES,
  getRetentionMode,
  statutoryRetentionFields,
  classifyStorageRef,
  collectRefsFromJson,
};
