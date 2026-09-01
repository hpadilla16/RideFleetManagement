/**
 * customer-pii-completeness.test.mjs — the STRUCTURAL guard.
 *
 * Instead of finding missed customer-PII columns by hand (three QA rounds and
 * counting), this test derives the obligation from the schema itself:
 *
 *   1. Parse backend/prisma/schema.prisma into models + fields.
 *   2. Compute the set of models REACHABLE from a Customer: the roots
 *      (Customer + Reservation/RentalAgreement/Trip/LoanerAgreement/
 *      Conversation/ReservationIncident/Citation), any model with a
 *      customerId/guestCustomerId column, and — transitively — any model that
 *      holds a relation or scalar FK to a reachable model.
 *   3. On each reachable model, flag every column whose NAME matches a
 *      PII/free-text pattern.
 *   4. FAIL if any flagged (model, column) is not EXPLICITLY classified in
 *      customer-pii-map.js as erased/redacted/conservative-retained or
 *      documented-retained — or, for a genuine false positive, named in the
 *      EXCLUSIONS list below with a reason.
 *
 * After this, a NEW PII column added to the schema fails the test until someone
 * classifies it. That is the point.
 *
 * DB-free: pure text parsing + the map. No Prisma client, no DB.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CUSTOMER_PII_MAP } from './customer-pii-map.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma');

// ---------------------------------------------------------------------------
// Schema parsing.
// ---------------------------------------------------------------------------
function parseSchema(text) {
  const models = {}; // name -> { fields: [{ name, type, optional, isList, hasRelationFields }] }
  const re = /model\s+(\w+)\s+\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    const body = m[2];
    const fields = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
      const fm = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?/);
      if (!fm) continue;
      fields.push({
        name: fm[1],
        type: fm[2],
        isList: !!fm[3],
        optional: !!fm[4],
        hasRelationFields: /@relation\([^)]*fields:/.test(line),
      });
    }
    models[name] = { fields };
  }
  return models;
}

// ---------------------------------------------------------------------------
// Reachability from Customer.
// ---------------------------------------------------------------------------
const ROOTS = [
  'Customer', 'Reservation', 'RentalAgreement', 'Trip', 'LoanerAgreement',
  'Conversation', 'ReservationIncident', 'Citation',
];
// Lowercased parent names that a scalar `<prefix>Id` column may reference.
const SCALAR_FK_PARENTS = ROOTS.map((r) => r.toLowerCase());

function computeReachable(models) {
  const modelNames = new Set(Object.keys(models));
  const reachable = new Set(ROOTS.filter((r) => modelNames.has(r)));

  // Seed: any model carrying a direct customer key.
  for (const [name, def] of Object.entries(models)) {
    if (def.fields.some((f) => f.name === 'customerId' || f.name === 'guestCustomerId')) {
      reachable.add(name);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, def] of Object.entries(models)) {
      if (reachable.has(name)) continue;
      for (const f of def.fields) {
        // (a) owning-side relation FK whose target model is reachable.
        if (f.hasRelationFields && modelNames.has(f.type) && reachable.has(f.type)) {
          reachable.add(name); changed = true; break;
        }
        // (b) scalar `<prefix>Id` soft-FK whose prefix ends in a reachable root.
        if (!f.isList && (f.type === 'String') && /Id$/.test(f.name) && f.name !== 'id') {
          const prefix = f.name.slice(0, -2).toLowerCase();
          const parent = SCALAR_FK_PARENTS.find((p) => prefix.endsWith(p));
          if (parent) {
            const parentModel = ROOTS.find((r) => r.toLowerCase() === parent);
            if (parentModel && reachable.has(parentModel)) { reachable.add(name); changed = true; break; }
          }
        }
      }
    }
  }
  return reachable;
}

// ---------------------------------------------------------------------------
// PII / free-text column-name pattern (from the QA spec).
// ---------------------------------------------------------------------------
const PII_PATTERN = new RegExp(
  [
    'firstName', 'lastName', 'customerName', 'email', 'phone', 'dateOfBirth', 'license',
    'address', 'city', 'state', 'zip', 'postalCode', 'latitude', 'longitude',
    'signatureDataUrl', 'initialDataUrl', 'dataUrl', 'photoJson', 'storagePath', 'bucketPath',
    'reviewerName', 'senderName', 'aiReviewerName', 'notes?', 'message', 'instructions',
    'narrative', 'comments', 'rawJson', 'metadata', 'description', 'reason', 'events', 'token',
  ].join('|'),
  'i',
);

// Types that cannot hold free-text/blob PII. DateTime/Boolean/Int flags trip
// the name pattern (checkinEmailSentAt, sendConfirmationEmail, stateVersion)
// but carry no PII. We keep String/Json (free text + blobs) and Decimal (GPS
// latitude/longitude ARE location PII). dateOfBirth is a DateTime but genuine
// PII, so it is never skipped by type.
const SKIP_TYPES = new Set(['Int', 'Boolean', 'DateTime', 'BigInt', 'Float']);

// Relation OBJECT fields are never PII themselves — skip them so a `reservation`
// object field doesn't trip the pattern.
function isStructuralField(field, modelNames) {
  return modelNames.has(field.type); // relation object field
}

// ---------------------------------------------------------------------------
// Classification from the map.
// ---------------------------------------------------------------------------
function camel(model) {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

// For a map entry, the set of columns it explicitly classifies.
function classifiedColumns(entry) {
  const s = new Set();
  const c = entry.columns || {};
  for (const k of ['redact', 'null', 'zero', 'conservativeRetain']) {
    for (const col of c[k] || []) s.add(col);
  }
  for (const j of c.jsonEmpty || []) s.add(j.column);
  for (const st of c.storage || []) s.add(st.column);
  for (const st of entry.storage || []) s.add(st.column); // top-level (conversation)
  for (const col of entry.documentedRetain || []) s.add(col);
  return s;
}

// Models whose EVERY column is erased because the row is deleted outright.
const HARD_DELETED = new Set(
  Object.values(CUSTOMER_PII_MAP).filter((e) => e.retention === 'HARD_DELETE').map((e) => e.model),
);
// Message has no map entry of its own — it is deleted via the Conversation
// cascade (HARD_DELETE). Documented here so the guard treats it as fully erased.
HARD_DELETED.add('message');

// Map: prisma-delegate name -> classified column set.
const MAP_BY_MODEL = {};
for (const entry of Object.values(CUSTOMER_PII_MAP)) {
  MAP_BY_MODEL[entry.model] = classifiedColumns(entry);
}

// ---------------------------------------------------------------------------
// NAMED false-positive exclusions — genuine non-customer-PII columns that the
// pattern flags on reachable models. Each MUST carry a one-line reason.
// Keyed "ModelName.columnName".
// ---------------------------------------------------------------------------
const EXCLUSIONS = {
  // --- Reservation: loaner/service context that is NOT the renter's identity.
  'Reservation.claimNumber': 'insurance claim number — a claim ref, not renter PII',
  'Reservation.repairOrderNumber': 'dealership RO number — not renter PII',
  'Reservation.serviceVehicleVin': 'the customer\'s car in for service — third-party asset, retained',
  'Reservation.serviceVehiclePlate': 'service vehicle plate — third-party asset, retained',
  'Reservation.serviceVehicleMake': 'service vehicle make — third-party asset, retained',
  'Reservation.serviceVehicleModel': 'service vehicle model — third-party asset, retained',
  'Reservation.loanerBillingAuthorizationRef': 'billing authorization ref — accounting, not PII',
  'Reservation.loanerBillingStatus': 'enum status — not PII',
  'Reservation.loanerPurchaseOrderNumber': 'dealership PO number — accounting, not PII',
  'Reservation.loanerDealerInvoiceNumber': 'dealer invoice number — accounting, not PII',
  'Reservation.bookingChannel': 'channel enum (STAFF/…) — not PII',
  'Reservation.workflowMode': 'enum — not PII',
  'Reservation.loanerBillingMode': 'enum — not PII',
  'Reservation.serviceAdvisorName': 'dealership STAFF advisor, not the erasure subject — retained',
  'Reservation.serviceAdvisorEmail': 'dealership STAFF advisor, not the erasure subject — retained',
  'Reservation.serviceAdvisorPhone': 'dealership STAFF advisor, not the erasure subject — retained',
  // --- Money/state enums & references on retained accounting rows.
  'RentalAgreement.paymentReference': 'gateway payment reference — accounting fact, retained',
  'RentalAgreement.securityDepositReference': 'deposit reference — accounting fact, retained',
  'RentalAgreement.paymentMethod': 'enum — not PII',
  'RentalAgreement.status': 'enum — not PII (contains no "state" PII)',
  'RentalAgreement.insurancePlanCode': 'insurance PLAN code (product), not the customer policy',
  'RentalAgreement.insurancePlanName': 'insurance PLAN name (product), not PII',
  'RentalAgreement.insuranceSource': 'enum-ish source, not PII',
  'RentalAgreementCharge.name': 'accounting line label (fee/product name), retained',
  'RentalAgreementCharge.source': 'source tag, not PII',
  'ReservationCharge.name': 'accounting line label, retained',
  'ReservationCharge.source': 'source tag, not PII',
  'RentalAgreementPayment.reference': 'payment reference — accounting fact, retained',
  'RentalAgreementPayment.method': 'enum method — not PII',
  'ReservationPayment.method': 'enum method — not PII',
  'ReservationPayment.reference': 'payment reference — accounting fact, retained',
  'PaymentOpsFlag.reference': 'payment reference — accounting fact, retained',
  'PaymentOpsFlag.gatewayRef': 'gateway handle — accounting fact, retained',
  // --- Citation / Toll: regulatory + vehicle facts, not renter identity.
  'Citation.violationType': 'violation type — regulatory fact, retained',
  'Citation.location': 'citation location — regulatory fact, retained',
  'Citation.externalUrl': 'agency URL — regulatory fact, retained',
  'Citation.documentPath': 'agency document pointer — regulatory fact, retained',
  'Citation.status': 'enum — not PII',
  'Citation.billingStatus': 'enum — not PII',
  'TollTransaction.location': 'toll plaza — vehicle/regulatory fact, retained',
  'TollTransaction.lane': 'toll lane — vehicle fact, retained',
  'TollTransaction.direction': 'toll direction — vehicle fact, retained',
  // --- Incident facts + STAFF certifier.
  'ReservationIncident.title': 'incident banner headline — fact, retained',
  'ReservationIncident.certifiedByName': 'STAFF certifier, not the erasure subject — retained',
  'ReservationIncident.certifiedByTitle': 'STAFF certifier title — retained',
  'ReservationIncident.signatureDataUrl': 'STAFF certifier signature — retained',
  'ReservationIncident.status': 'enum — not PII',
  'ReservationIncident.citedClausesJson': 'snapshot of tenant clause library (product text), not PII',
  'ReservationIncident.chargeIdsJson': 'list of charge ids — accounting, not PII',
  'TripIncident.title': 'incident headline — fact, retained',
  'TripIncident.status': 'enum — not PII',
  'TripIncident.resolutionCode': 'enum — not PII',
  // --- Inspection condition facts (vehicle, not person).
  'RentalAgreementInspection.exterior': 'vehicle-condition fact, retained',
  'RentalAgreementInspection.interior': 'vehicle-condition fact, retained',
  'RentalAgreementInspection.tires': 'vehicle-condition fact, retained',
  'RentalAgreementInspection.lights': 'vehicle-condition fact, retained',
  'RentalAgreementInspection.windshield': 'vehicle-condition fact, retained',
  'RentalAgreementInspection.fuelLevel': 'vehicle-condition fact, retained',
  'VehicleDamageReport.customerAckStatementText': 'terms snapshot the customer signed (product text) — retained',
  'VehicleDamageReport.responsibleParty': 'enum — not PII',
  'VehicleDamageReport.source': 'enum source — not PII',
  'VehicleDamageReport.status': 'enum — not PII',
  // --- Audit trail (retained by design).
  'AuditLog.reason': 'audit trail content — retained by design',
  'AuditLog.metadata': 'audit trail content — retained by design',
  'AuditLog.action': 'enum — not PII',
  // --- Customer suppression record written BY erasure.
  'Customer.doNotRentReason': 'the minimised suppression reason written by erasure — retained',
  // --- External import row.
  'ExternalReservation.needsReviewReason': 'import triage enum (customer_not_found/…), not PII',
  'ExternalReservation.rejectedReason': 'staff rejection reason — not renter PII',
  'ExternalReservation.status': 'raw upstream status string — not PII',
  'ExternalReservation.subBrand': 'brand tag — not PII',
  // --- Kiosk telemetry that stays for money resolution (already scrubbed of PII).
  'KioskSession.paymentIntentState': 'enum — not PII',
  'KioskSession.idVerifyMethod': 'enum (SCAN/STAFF_OVERRIDE) — not PII',
  'KioskSession.escalatedReason': 'enum-ish escalation reason — not PII',
  'KioskSession.step': 'funnel step enum — not PII',
  // --- Loaner portal/enum bits.
  'LoanerAgreement.portalRequestKind': 'enum — not PII',
  'LoanerAgreement.insuranceCarrier': 'insurance carrier (company), not the customer',
  'LoanerDamagePoint.side': 'diagram side enum (FRONT/REAR) — not PII',
  // --- Shuttle enum/source.
  'ShuttleRequest.status': 'enum — not PII',
  'ShuttleRequest.source': 'enum (VOICE/VALET/PUBLIC_LINK) — not PII',
  // --- Checkout session non-PII.
  'CheckoutSession.stateVersion': 'optimistic-concurrency version — not PII',
  // --- Accounting/commission line labels.
  'AgreementCommissionLine.description': 'commission line label (accounting), not PII',
  // --- Citation / assignment vehicle+algorithm facts.
  'Citation.plateState': 'vehicle plate STATE (registration), not renter identity',
  'CitationAssignment.matchReason': 'match-algorithm reason (plate/date), not PII',
  'TollAssignment.matchReason': 'match-algorithm reason, not PII',
  // --- External import: vehicle description.
  'ExternalReservation.vehicleDescription': 'ACRISS/vehicle description, not renter PII',
  // --- Fleet / inventory / maintenance ops (VEHICLE records that cross-ref a
  //     reservation; their free-text is about the vehicle/asset, not the renter).
  'FleetReconciliationFlag.note': 'fleet vehicle-discrepancy note (asset ops), not renter identity',
  'FleetReconciliationFlag.resolvedReason': 'fleet resolution reason (asset ops), not PII',
  'InventoryItem.note': 'inventory count note (asset ops), not renter identity',
  'InventoryItem.maintenanceNote': 'inventory maintenance note (asset ops), not PII',
  'InventoryItem.mismatchResolutionNote': 'inventory mismatch note (asset ops), not PII',
  'InventoryItem.confirmReason': 'inventory confirm reason (asset ops), not PII',
  'InventoryItem.state': 'inventory item state string (OPEN/OUT/…), not PII',
  'RepairOrder.notes': 'maintenance repair-order note (asset ops), not renter identity',
  'RepairOrderLine.description': 'maintenance line description (asset ops), not PII',
  'VehicleMileageEntry.note': 'odometer-entry note (vehicle fact), not renter identity',
  'VehicleFuelReading.note': 'fuel-reading note (vehicle fact), not renter identity',
  'VehicleInspectionAnnotation.note': 'photo-pin damage callout (vehicle-condition), not renter identity',
  // --- Damage evidence (vehicle photos + evidence description, retained).
  'IncidentEvidence.description': 'damage evidence location/description (vehicle), retained',
  'IncidentEvidence.storagePath': 'damage evidence PHOTO (vehicle), retained',
  // --- Planner algorithm.
  'PlannerScenarioAction.reasonSummary': 'planner recommendation rationale (algorithm), not PII',
  // --- Payout hold reason (accounting).
  'TripPayout.holdReason': 'payout-hold reason (accounting), not renter identity',
};

// ---------------------------------------------------------------------------
// The guard.
// ---------------------------------------------------------------------------
describe('customer-pii-map completeness (schema-driven)', () => {
  const schemaText = readFileSync(SCHEMA_PATH, 'utf8');
  const models = parseSchema(schemaText);
  const modelNames = new Set(Object.keys(models));
  const reachable = computeReachable(models);

  it('parses the schema and reaches the known customer-PII models', () => {
    assert.ok(Object.keys(models).length > 50, 'should parse many models');
    for (const must of ['Reservation', 'RentalAgreement', 'Trip', 'Citation', 'ReservationIncident', 'Quote', 'ShuttleRequest']) {
      assert.ok(reachable.has(must), `${must} should be reachable from Customer`);
    }
  });

  it('every PII/free-text column on a reachable model is classified (erase or documented-retain)', () => {
    const unclassified = [];
    for (const model of reachable) {
      const def = models[model];
      const classified = MAP_BY_MODEL[camel(model)] || null;
      const hardDeleted = HARD_DELETED.has(camel(model));
      for (const f of def.fields) {
        if (isStructuralField(f, modelNames)) continue;
        if (SKIP_TYPES.has(f.type) && f.name !== 'dateOfBirth') continue; // non-text scalars
        if (f.name === 'id' || /Id$/.test(f.name)) continue; // ids are not PII themselves
        if (!PII_PATTERN.test(f.name)) continue;
        const key = `${model}.${f.name}`;
        if (EXCLUSIONS[key]) continue;
        if (hardDeleted) continue;
        if (classified && classified.has(f.name)) continue;
        unclassified.push(key);
      }
    }
    unclassified.sort();
    assert.deepEqual(
      unclassified,
      [],
      `Unclassified customer-reachable PII columns — classify each in customer-pii-map.js ` +
      `(erase/redact/documentedRetain) or add to EXCLUSIONS with a reason:\n  ` +
      unclassified.join('\n  '),
    );
  });

  it('every EXCLUSION names a real column on a reachable model (no rot)', () => {
    const stale = [];
    for (const key of Object.keys(EXCLUSIONS)) {
      const [model, col] = key.split('.');
      if (!reachable.has(model) || !models[model] || !models[model].fields.some((f) => f.name === col)) {
        stale.push(key);
      }
    }
    assert.deepEqual(stale, [], `Stale EXCLUSIONS (model/column no longer exists or unreachable): ${stale.join(', ')}`);
  });
});
