/**
 * customer-pii-map.js — THE SINGLE SOURCE OF TRUTH for where customer PII lives
 * in the RideFleet data model, and what the GDPR erasure primitive is allowed
 * to do to each place.
 *
 * WHY THIS FILE EXISTS
 *   The original self-service anonymiser (account-deletion.service.js) only
 *   scrubbed the master `Customer` row. Customer PII is actually reachable FOUR
 *   ways — the master row, direct FK holders, denormalised snapshot columns on
 *   contracts/trips, and the Authorize.Net sub-processor. Every table that got
 *   a denormalised copy but was never added to the anonymiser is a silent gap.
 *   This map is imported by:
 *     - Phase A: customer-erasure.service.js  (erase)
 *     - Phase B: the export primitive          (subject access / portability)
 *     - Phase C: the retention sweep           (window-expiry erasure)
 *   so all three read ONE list and cannot drift out of sync.
 *
 * RETENTION CLASSIFICATION (per-table `retention`):
 *   - RETAIN_STATUTORY : NEVER hard-delete. FK RESTRICT + statutory retention
 *       (Reservation, RentalAgreement, LoanerAgreement, every payment model,
 *       every damage/incident model). We anonymise-in-place: null the erasable
 *       PII columns, redact required-non-null identity columns to a sentinel,
 *       reap the person-document storage bytes — but KEEP the row, its money
 *       columns, its timestamps, its vehicle/location IDs, and (per the
 *       retention field map) the customer's LAST name + vehicle-condition
 *       photos.
 *   - ANONYMISE : not statutorily retained, but referenced by a retained row or
 *       carrying operational history worth keeping as a shell. Null/redact the
 *       PII columns in place; keep the row.
 *   - HARD_DELETE : Cascade-safe, non-retained child rows that are pure PII with
 *       no downstream money/audit dependency (chat threads, uploaded personal
 *       documents). Delete the rows outright. Idempotent: re-run finds none.
 *
 * RETENTION-EXCEPTION FIELD MAP (the default an operator/counsel can later
 * adjust — encoded here in ONE place so it never drifts):
 *   - Agreements: RETAIN agreementNumber + all money columns + timestamps +
 *       vehicle/location IDs + customerLastName. ERASE dateOfBirth, licence
 *       number/state/expiry, insurance/licence image refs (+ delete the bytes),
 *       email, phone, address*, IPs, cardOnFileToken/Last4, first name,
 *       signature images.
 *   - Payments/accounting: retain amounts + reference + timestamps (they carry
 *       no other PII, so they are not enumerated here — nothing to erase).
 *   - Damage/incident: retain damage facts + amounts + VEHICLE photos; erase
 *       customerAck signature/name/IP and person photos.
 *   - Signatures: retain signedAt + termsVersion; erase the signature IMAGE.
 *
 * VEHICLE PHOTOS ARE RETAINED. RentalAgreementInspection photos, LoanerPhoto
 *   walkarounds, VehicleDamageReport / IncidentEvidence photos are
 *   vehicle-CONDITION evidence on a retained contract. The retention field map
 *   is explicit ("retain ... vehicle photos"), so by DEFAULT this map retains
 *   those object collections and only erases the PERSON-identifying columns that
 *   sit next to them (actorIp, customerAck*, etc.). The `retainedPhotoNote`
 *   entries document each such decision so QA and counsel can see it.
 *
 * doNotRent SUPPRESSION: erasure SETS Customer.doNotRent = true + reason. That
 *   is a minimised suppression record that is retained ON PURPOSE (so a fresh
 *   sign-up with the same email cannot silently re-onboard a barred renter).
 *   The erasure report discloses it — we do NOT claim total erasure.
 *
 * ESM. No new npm deps. Pure data + tiny classifiers; no DB/network here.
 */

import { CUSTOMER_DOCS_BUCKET } from './customer-documents.js';

// ---------------------------------------------------------------------------
// Buckets. Kept in sync with the upload sites:
//   - customer/agreement/loaner KYC docs → customer-documents.js
//   - inspection / loaner / kiosk / damage vehicle photos → inspection-photos
//   - inventory + citation documents → inventory-photos
// deleteObject swallows 404, so a mis-guessed default bucket on a bare path is a
// harmless no-op; the DB column is nulled regardless. Refs written in the
// explicit "<bucket>:<path>" form carry their own bucket and never rely on the
// default.
// ---------------------------------------------------------------------------
export { CUSTOMER_DOCS_BUCKET };
export const PHOTOS_BUCKET =
  process.env.SUPABASE_STORAGE_PHOTOS_BUCKET || 'inspection-photos';
export const INVENTORY_PHOTOS_BUCKET =
  process.env.SUPABASE_STORAGE_INVENTORY_BUCKET || 'inventory-photos';

// Sentinel written into required, non-null identity columns we cannot null.
export const REDACTION = '[erased]';

// ---------------------------------------------------------------------------
// Storage-ref classification. A stored reference is one of:
//   - 'object'  a real Storage object we can delete. Either a bare path (uses a
//               default bucket) or the explicit "<bucket>:<path>" form.
//   - 'url'     an external http(s) URL — not ours to delete; just null the col.
//   - 'inline'  a data: URL or raw base64 blob — no object exists; just null it.
//   - 'empty'   null/blank.
// ORDER MATTERS: http and data: both contain ':' and must be tested before the
// "<bucket>:<path>" split; a raw base64 blob may contain '/' and must be tested
// before the bare-path branch.
// ---------------------------------------------------------------------------
export function classifyStorageRef(value, { defaultBucket } = {}) {
  if (value == null) return { kind: 'empty' };
  const s = String(value).trim();
  if (!s) return { kind: 'empty' };

  if (/^https?:\/\//i.test(s)) return { kind: 'url', value: s };
  if (/^data:/i.test(s)) return { kind: 'inline', value: s };

  // Explicit "<bucket>:<path>" — bucket is a slug with no slash, path is the
  // rest and never begins with "//" (which would be a protocol-relative URL).
  const m = s.match(/^([a-z0-9][a-z0-9._-]*):(.+)$/i);
  if (m && !m[1].includes('/') && !m[2].startsWith('//')) {
    return { kind: 'object', bucket: m[1], path: m[2] };
  }

  // Raw base64 blob (long, drawn from the base64 alphabet, optional padding).
  // Real paths carry '.', '_' or '-' and fail this test.
  if (s.length > 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    return { kind: 'inline', value: s };
  }

  // Bare Storage path.
  if (s.includes('/')) return { kind: 'object', bucket: defaultBucket, path: s };

  // Unrecognised short token — treat as inline (no object to delete).
  return { kind: 'inline', value: s };
}

/**
 * Collect deletable Storage objects out of the JSON photo-ref shapes:
 *   - { storage: true, bucket, refs: [{ path }, ...] }   (photoJson / customer-inspection)
 *   - [{ path }, ...] | [{ storagePath }, ...]           (photoStorageRefs)
 * Returns [{ bucket, path }]. Best-effort + defensive: never throws on a shape
 * it does not recognise. Provided for Phase C reuse; Phase A retains vehicle
 * photos and does not call this on retained collections.
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
    for (const r of parsed) {
      if (r && typeof r === 'object') push(r.bucket || defaultBucket, r.path || r.storagePath);
    }
    return out;
  }
  if (parsed && typeof parsed === 'object') {
    const bucket = parsed.bucket || defaultBucket;
    const refs = Array.isArray(parsed.refs) ? parsed.refs : [];
    for (const r of refs) {
      if (r && typeof r === 'object') push(r.bucket || bucket, r.path || r.storagePath);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE MAP. One entry per model that holds customer PII. `columns` names the
// exact Prisma scalar fields (verified against schema.prisma 2026-08-22):
//   null     → set to null (nullable columns)
//   redact   → set to REDACTION sentinel (required, non-null identity columns)
//   jsonEmpty→ set to an empty JSON value (required, non-null Json columns)
//   storage  → [{ column, defaultBucket }] refs whose bytes we reap, then null
//              the column (unless the column is itself required — see notes)
// `match` documents HOW rows are found for a given customer (the service
// implements each kind explicitly — this file stays pure data).
// ---------------------------------------------------------------------------
export const CUSTOMER_PII_MAP = Object.freeze({
  // (1) MASTER ROW ---------------------------------------------------------
  customer: {
    model: 'customer',
    label: 'Customer',
    retention: 'ANONYMISE', // the master row is kept (FK targets), fully scrubbed
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
    suppression: true, // sets doNotRent = true + reason
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
      ],
    },
    retainNote:
      'Retain the whole rental record (money, status, vehicle/location, timestamps). ' +
      'Erase the pre-check-in signature image + free-text notes that can carry PII.',
  },
  conversation: {
    model: 'conversation',
    label: 'Conversation (+ Message children)',
    retention: 'HARD_DELETE',
    match: { kind: 'customerFk', field: 'customerId' },
    // customerId is a required FK with no cascade from Customer, so the row
    // cannot be left pointing nowhere; the whole thread is pure customer PII
    // with no money/audit dependency, so we delete it (Message cascades).
    storage: [{ column: 'pickupPhotoUrl', defaultBucket: CUSTOMER_DOCS_BUCKET }],
    cascades: ['message'],
  },
  trip: {
    model: 'trip',
    label: 'Trip',
    retention: 'ANONYMISE',
    match: { kind: 'customerFk', field: 'guestCustomerId' },
    // Trip carries money (payouts/accounting) so we keep the row and its
    // guestCustomerId (it now points at the anonymised Customer). Only the
    // free-text notes can hold PII.
    columns: { null: ['notes'] },
  },
  hostReview: {
    model: 'hostReview',
    label: 'HostReview',
    retention: 'ANONYMISE',
    match: { kind: 'customerFk', field: 'guestCustomerId' },
    columns: { null: ['reviewerName', 'comments'] }, // keep the numeric rating (aggregate stat)
  },
  quote: {
    model: 'quote',
    label: 'Quote',
    retention: 'ANONYMISE',
    // scalar customerId (NO relation) — also match on the snapshotted contact.
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
      // Retain agreementNumber, money, timestamps, vehicle/location IDs, and
      // customerLastName. Erase everything else that identifies the person.
      redact: ['customerFirstName'],
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
      'customerLastName, agreementNumber, all Decimal money columns, deposits, ' +
      'timestamps (incl. tcSignedAt / returnedAt / closedAt) and vehicle/location ' +
      'IDs are retained. Signature IMAGES are erased; their signedAt timestamps stay.',
  },
  agreementDriver: {
    model: 'agreementDriver',
    label: 'AgreementDriver',
    retention: 'ANONYMISE',
    // Cascade child of a RETAINED agreement — anonymise in place rather than
    // delete, so the retained contract's driver roster stays structurally intact.
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
    // initialDataUrl is a REQUIRED @db.Text signature image — cannot null; redact.
    columns: { redact: ['initialDataUrl'], null: ['customerIp'] },
    retainNote: 'Keep sectionKey + signedAt; erase the initials image + customer IP.',
  },
  rentalAgreementInspection: {
    model: 'rentalAgreementInspection',
    label: 'RentalAgreementInspection',
    retention: 'ANONYMISE',
    match: { kind: 'agreementRelation', field: 'rentalAgreementId' },
    // Erase the person IP. RETAIN the vehicle-condition photos (photosJson /
    // photoStorageRefs) per the retention field map.
    columns: { null: ['actorIp'] },
    retainedPhotoNote: 'photosJson + photoStorageRefs are vehicle-condition evidence — retained.',
  },
  loanerAgreement: {
    model: 'loanerAgreement',
    label: 'LoanerAgreement',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'reservationRelation', field: 'reservationId' },
    columns: {
      redact: ['customerFirstName'],
      null: [
        'customerEmail', 'customerPhone', 'dateOfBirth',
        'licenseNumber', 'licenseState', 'licenseExpiry', 'licenseImagePath',
        'insurancePolicyNumber', 'insuranceImagePath',
        'signatureDataUrl', 'signerName', 'signerIp',
        'portalRequestNote', 'notes',
      ],
      storage: [
        { column: 'licenseImagePath', defaultBucket: PHOTOS_BUCKET },
        { column: 'insuranceImagePath', defaultBucket: PHOTOS_BUCKET },
      ],
    },
    retainNote: 'Retain agreementNumber + money + timestamps + vehicle; keep customerLastName.',
  },
  loanerPhoto: {
    model: 'loanerPhoto',
    label: 'LoanerPhoto',
    retention: 'RETAIN_PHOTOS',
    match: { kind: 'loanerRelation', field: 'loanerAgreementId' },
    retainedPhotoNote: 'Walkaround / damage VEHICLE photos on a retained loaner agreement — retained.',
  },
  loanerRequest: {
    model: 'loanerRequest',
    label: 'LoanerRequest',
    retention: 'ANONYMISE',
    // Self-contained intake, no customer FK — match on name + phone/email.
    match: { kind: 'loanerRequest', fields: ['name', 'phone', 'email'] },
    columns: { redact: ['name', 'phone'], null: ['email', 'notes'] },
  },
  tripDocument: {
    model: 'tripDocument',
    label: 'TripDocument',
    retention: 'HARD_DELETE',
    // dataUrl is a personal LICENSE/INSURANCE/ADDRESS_PROOF image (data URL,
    // no Storage object). Cascade-safe child of Trip, no money — delete.
    match: { kind: 'tripRelation', field: 'tripId' },
  },
  reservationIncident: {
    model: 'reservationIncident',
    label: 'ReservationIncident (+ IncidentEvidence)',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'reservationRelation', field: 'reservationId' },
    // Damage/incident record: retain the facts + amounts + vehicle photos
    // (IncidentEvidence.storagePath). certifiedByName/Title + signatureDataUrl
    // are the STAFF certifier's, not the customer's — retained. Nothing here is
    // customer PII to erase beyond what the linked agreement already holds.
    retainedPhotoNote:
      'IncidentEvidence photos are vehicle damage evidence — retained. Certifier ' +
      'signature/name are staff, not the erasure subject — retained.',
  },
  vehicleDamageReport: {
    model: 'vehicleDamageReport',
    label: 'VehicleDamageReport',
    retention: 'RETAIN_STATUTORY',
    // scalar reservationId (no relation).
    match: { kind: 'reservationScalar', field: 'reservationId' },
    columns: {
      // Erase the customer acknowledgement signature/name/IP. Keep signedAt +
      // the statement wording (a terms snapshot) + the vehicle photos.
      null: ['customerAckSignatureDataUrl', 'customerAckSignerName', 'customerAckIp'],
    },
    retainedPhotoNote: 'photoJson / estimatePhotoJson / fixedPhotoJson are vehicle photos — retained.',
  },
  tripIncident: {
    model: 'tripIncident',
    label: 'TripIncident (+ TripIncidentCommunication)',
    retention: 'RETAIN_STATUTORY',
    match: { kind: 'reservationRelation', field: 'reservationId' },
    // Incident facts + amounts are retained. The customer-facing PII lives in
    // the communications child (see tripIncidentCommunication).
    retainNote: 'Retain incident facts + amounts; scrub the communication child.',
  },
  tripIncidentCommunication: {
    model: 'tripIncidentCommunication',
    label: 'TripIncidentCommunication',
    retention: 'ANONYMISE',
    match: { kind: 'tripIncidentRelation', field: 'incidentId' },
    columns: { null: ['subject', 'message', 'attachmentsJson', 'senderRefId'] },
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
    // Keep the payment-intent refs (late-payment resolution) + outcome +
    // timestamps. eventsJson is a required Json telemetry blob (may hold ID
    // scan data) — reset to an empty array. nameUpdateCodeHash is a hashed
    // possession code — null it.
    columns: { null: ['nameUpdateCodeHash'], jsonEmpty: [{ column: 'eventsJson', value: [] }] },
  },
  externalReservation: {
    model: 'externalReservation',
    label: 'ExternalReservation',
    retention: 'ANONYMISE',
    // Match on the promoted reservation OR the snapshotted customer email.
    match: { kind: 'externalReservation', fields: ['promotedToReservationId', 'customerEmail'] },
    columns: {
      null: [
        'customerFirstName', 'customerLastName', 'customerEmail', 'customerPhone',
        'customerCountry', 'flightNumber',
      ],
      jsonEmpty: [{ column: 'rawJson', value: {} }], // required Json — full inbound PII payload
    },
  },
  citationDocument: {
    model: 'citationDocument',
    label: 'CitationDocument',
    retention: 'ANONYMISE',
    // Reached via Citation.reservationId ∈ the customer's reservations.
    match: { kind: 'citationDocument', field: 'citationId' },
    columns: {
      null: ['ocrJson'],
      // bucketPath is a REQUIRED "<bucket>:<path>" string — reap the object,
      // then redact the pointer (cannot null a required column).
      storage: [{ column: 'bucketPath', defaultBucket: INVENTORY_PHOTOS_BUCKET, requiredRedact: true }],
    },
  },
});

// (4) SUB-PROCESSOR — Authorize.Net CIM. Handled by the service after the DB
// commit: delete the customer profile upstream (best-effort) and null the local
// authnet* IDs + card* metadata columns (already listed under `customer`).
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
  classifyStorageRef,
  collectRefsFromJson,
};
