/**
 * L2L3ValidationError / AutoRentalValidationError — decoding the failure that
 * arrives inside a success. PURE — no prisma, no network.
 *
 * Plan §5.4, and this is the part that bites:
 *
 *   > They are objects keyed by field name, not arrays — and, critically,
 *   > THEY ARE RETURNED INSIDE A 200 OK. The transaction can be APPROVED
 *   > while the L3 / AutoRental enrichment silently fails.
 *
 * So the money moves, the customer drives away, `approved === true`, and the
 * interchange qualification we did all this work for quietly did not happen.
 * Nothing in the response's status fields says so. If we do not look inside
 * these two objects and log what we find, the enrichment can be broken for
 * months and every dashboard will say the payments are fine.
 *
 * Hence: log it LOUDLY (WARN, named fields), never silently.
 *
 * ── WHY A MAPPING TABLE, AND NOT JUST `Object.keys()` ───────────────────────
 *
 * The error keys use FLAT LEGACY XML NAMES that do not match the nested REST
 * paths we actually send (plan §5.4):
 *
 *     PickupAddress                 -/->  AutoRental.AutoRentalPickup.Address
 *     PickupDate                    -/->  AutoRental.AutoRentalPickup.DateTime
 *     RentalDistanceUnitofMeasure   -/->  AutoRental.AutoRentalDistance
 *                                           .AutoRentalDistanceUnitofMeasure
 *
 * And two keys — `RentalTime` and `ReturnTime` — have NO corresponding REST
 * request field at all; the REST shape folds time into `DateTime`. An agent
 * handed the raw key "ReturnTime is missing" would go looking for a field that
 * does not exist in anything we sent.
 *
 * The table also names the RFM COLUMN behind each field, because the actionable
 * question is never "which wire field was invalid" — it is "which row in our
 * database do I go fix".
 *
 * Value vocabulary, from the legacy SOAP spec's populated form:
 *   "Is invalid" / "Is missing"
 *
 * The positive signal is `ExtData.ARLFlag === 'Y'` on a valid AutoRental
 * transaction.
 *
 * POLICY (plan §5.4 → H-14): when the sale approved but validation failed, the
 * customer has paid. RECORD THE PAYMENT — the money is real — and raise a flag
 * naming the fields. Do NOT void a good sale over a reporting defect. This
 * module only produces the description; it deliberately makes no decision
 * about the transaction.
 */

/**
 * Flat legacy key -> { path, rfm }.
 *   path — where we actually put the value in the REST request
 *   rfm  — the RFM field / column that produced it
 *
 * Both key sets are reproduced in full from the AutoRental Sale 200 sample
 * quoted verbatim in plan §5.4, so an unexpected key is genuinely unexpected
 * rather than merely unlisted.
 */
export const L2L3_FIELD_MAP = {
  // Header / summary
  Description:          { path: 'L3Data.items[].Description',            rfm: 'RentalAgreementCharge.name' },
  PoNumber:             { path: 'PoNumber',                              rfm: '(not sent — loaner-only Reservation.loanerPurchaseOrderNumber)' },
  PurchaseIdentifier:   { path: 'L3Data.Header.PurchaseIdentifier',      rfm: 'RentalAgreement.agreementNumber' },
  SummaryCommodityCode: { path: 'L3Data.Header.SummaryCommodityCode',    rfm: 'settings spin.autoRental.summaryCommodityCode (per-tenant)' },
  LineItemCount:        { path: 'L3Data.Header.LineItemCount',           rfm: 'count of non-deposit, non-TAX RentalAgreementCharge rows' },
  TaxAmount:            { path: 'L3Data.Header.TaxAmount',               rfm: 'RentalAgreement.taxes' },
  // Line items
  Quantity:             { path: 'L3Data.items[].Quantity',               rfm: 'RentalAgreementCharge.quantity' },
  UnitOfMeasure:        { path: 'L3Data.items[].UnitOfMeasure',          rfm: 'derived from RentalAgreementCharge.chargeType/code' },
  UnitCost:             { path: 'L3Data.items[].UnitCost',               rfm: 'RentalAgreementCharge.rate' },
  TaxRate:              { path: 'L3Data.items[].TaxRate',                rfm: 'Location.taxRate (allocated — no per-line tax exists)' },
  DiscountAmount:       { path: 'L3Data.items[].DiscountAmount',         rfm: 'abs(RentalAgreementCharge.total) on a negative row' },
  DebitCreditIndicator: { path: 'L3Data.items[].DiscountIndicator',      rfm: 'sign of RentalAgreementCharge.total' },
  ExtLineAmount:        { path: 'L3Data.items[].ExtLineAmount',          rfm: 'RentalAgreementCharge.total' },
  QuantityExpIndicator: { path: '(not sent)',                            rfm: '(not sent — implicit 0 decimal exponent)' },
  UnitPriceDecimal:     { path: '(not sent)',                            rfm: '(not sent — UnitCost carries its own decimal point)' },
};

export const AUTORENTAL_FIELD_MAP = {
  AdjustmentAmount:            { path: 'AutoRental.AutoRentalAdjustment.AdjustmentAmount',            rfm: "(not sent at checkout — nothing to adjust yet)" },
  AdjustmentAuditIndicatorCode:{ path: 'AutoRental.AutoRentalAdjustment.AdjustmentAuditIndicatorCode',rfm: '(not sent — indicator semantics undocumented, plan D-4)' },
  AgreementReferenceNumber:    { path: 'AutoRental.AutoRentalAgreement.AgreementReferenceNumber',     rfm: 'RentalAgreement.agreementNumber' },
  RentalPeriod:                { path: 'AutoRental.AutoRentalAgreement.RentalPeriod',                 rfm: 'derived from Reservation.pickupAt/returnAt' },
  RentalDuration:              { path: 'AutoRental.AutoRentalAgreement.RentalDuration',               rfm: 'derived from Reservation.pickupAt/returnAt (no stored column)' },
  RenterName:                  { path: 'AutoRental.AutoRentalRenter.RenterName',                      rfm: 'RentalAgreement.customerFirstName + customerLastName' },
  ServiceMobile:               { path: 'AutoRental.AutoRentalRenter.ServiceMobile',                   rfm: 'Customer.phoneNormalized' },
  VehicleMake:                 { path: 'AutoRental.AutoRentalVehicle.VehicleMake',                    rfm: 'Vehicle.make (nullable)' },
  VehicleModel:                { path: 'AutoRental.AutoRentalVehicle.VehicleModel',                   rfm: 'Vehicle.model (nullable)' },
  RentalRate:                  { path: 'AutoRental.AutoRentalPricing.RentalRate',                     rfm: 'rate on the chargeType DAILY row' },
  // ⚠️ the 2201. See normalizeRentalClassId() in autorental-l3.builder.js.
  RentalClassId:               { path: 'AutoRental.AutoRentalVehicle.RentalClassId',                  rfm: 'VehicleType.code via normalizeRentalClassId() — 0001-0032 or 9999' },
  RentalDistance:              { path: 'AutoRental.AutoRentalDistance.RentalDistance',                rfm: 'freeMilesPerDay x days (odometerOut is not written until AFTER payment)' },
  RentalDistanceUnitofMeasure: { path: 'AutoRental.AutoRentalDistance.AutoRentalDistanceUnitofMeasure',rfm: '(constant "Miles" — no distance-unit column exists in RFM)' },
  // Pickup
  PickupAddress:     { path: 'AutoRental.AutoRentalPickup.Address',      rfm: 'Location.address (pickupLocationId)' },
  PickupCity:        { path: 'AutoRental.AutoRentalPickup.City',         rfm: 'Location.city (pickupLocationId)' },
  PickupState:       { path: 'AutoRental.AutoRentalPickup.State',        rfm: 'Location.state (pickupLocationId) — free text, not a code' },
  PickupCountry:     { path: 'AutoRental.AutoRentalPickup.Country',      rfm: 'Location.country (pickupLocationId) — free text' },
  PickupCountryCode: { path: 'AutoRental.AutoRentalPickup.CountryCode',  rfm: 'DOES NOT EXIST — no countryCode column (plan §4.5)' },
  PickupRegionCode:  { path: 'AutoRental.AutoRentalPickup.RegionCode',   rfm: 'DOES NOT EXIST — omitted until plan D-5 is answered' },
  PickupLocation:    { path: 'AutoRental.AutoRentalPickup.LocationId',   rfm: 'Location.code (pickupLocationId)' },
  PickupDate:        { path: 'AutoRental.AutoRentalPickup.DateTime',     rfm: 'Reservation.pickupAt — TIMEZONE-NAIVE (plan §4.2, H-10)' },
  // ⚠️ no separate time field exists in the REST request; time is folded into DateTime.
  RentalTime:        { path: '(no REST field — folded into AutoRentalPickup.DateTime)', rfm: 'Reservation.pickupAt' },
  // Return
  ReturnAddress:      { path: 'AutoRental.AutoRentalReturn.Address',     rfm: 'Location.address (returnLocationId)' },
  ReturnStateCountry: { path: 'AutoRental.AutoRentalReturn.State/Country',rfm: 'Location.state / Location.country (returnLocationId)' },
  ReturnRegionCode:   { path: 'AutoRental.AutoRentalReturn.RegionCode',  rfm: 'DOES NOT EXIST — omitted until plan D-5 is answered' },
  ReturnLocationId:   { path: 'AutoRental.AutoRentalReturn.LocationId',  rfm: 'Location.code (returnLocationId)' },
  ReturnDate:         { path: 'AutoRental.AutoRentalReturn.DateTime',    rfm: 'Reservation.returnAt — TIMEZONE-NAIVE (plan §4.2, H-10)' },
  ReturnTime:         { path: '(no REST field — folded into AutoRentalReturn.DateTime)', rfm: 'Reservation.returnAt' },
};

/**
 * A key with a non-empty value is a failure. Empty string / null / undefined
 * mean "this field was fine" — the gateway returns the WHOLE key set on every
 * response, populated or not, so presence proves nothing and only the value
 * counts.
 */
function nonEmptyEntries(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj)
    .filter(([, v]) => String(v == null ? '' : v).trim() !== '')
    .map(([key, value]) => [key, String(value).trim()]);
}

function describeOne(key, value, map, kind) {
  const known = map[key];
  return {
    kind,
    key,
    value,
    // An unmapped key is not an error on the gateway's part — it means their
    // vocabulary grew and ours did not. Say so instead of dropping it.
    known: !!known,
    path: known ? known.path : '(UNMAPPED — add to autorental-validation.js)',
    rfmField: known ? known.rfm : '(unknown)',
  };
}

/**
 * Extract every populated validation error from a gateway response.
 *
 * @param {object} response — the raw 200 OK body
 * @returns {{ok:boolean, arlFlag:string|null, errors:Array, unmapped:Array}}
 *          `ok` is false when ANY field failed. It says nothing about whether
 *          the money moved — check `approved` for that.
 */
export function extractValidationErrors(response = {}) {
  const l2l3 = response?.L2L3ValidationError ?? response?.l2l3ValidationError;
  const auto = response?.AutoRentalValidationError ?? response?.autoRentalValidationError;

  const errors = [
    ...nonEmptyEntries(l2l3).map(([k, v]) => describeOne(k, v, L2L3_FIELD_MAP, 'L2L3')),
    ...nonEmptyEntries(auto).map(([k, v]) => describeOne(k, v, AUTORENTAL_FIELD_MAP, 'AUTORENTAL')),
  ];

  const arlFlag = response?.ExtData?.ARLFlag ?? response?.extData?.ARLFlag ?? null;

  return {
    ok: errors.length === 0,
    arlFlag: arlFlag == null ? null : String(arlFlag),
    errors,
    unmapped: errors.filter((e) => !e.known).map((e) => e.key),
  };
}

/**
 * One readable line, naming the RFM field that produced each failure.
 *
 * ⚠️ NEVER include the payload. It carries renter PII (name, mobile, email,
 * pickup address) and plan §5.4 is explicit: log normalized FIELD NAMES at
 * WARN, never the payload.
 *
 * @returns {string} '' when nothing failed, so the caller can `if (line)`.
 */
export function describeValidationErrors(response = {}) {
  const { errors, arlFlag } = extractValidationErrors(response);
  if (errors.length === 0) return '';

  const parts = errors.map((e) => `${e.key} (${e.rfmField}) ${e.value}`);
  const flag = arlFlag === null ? 'absent' : arlFlag;
  return `L3/AutoRental enrichment FAILED on ${errors.length} field(s) `
    + `[ARLFlag=${flag}]: ${parts.join('; ')}`;
}

/**
 * The positive signal. A valid AutoRental transaction returns
 * ExtData.ARLFlag === 'Y' (plan §5.4). Absence is NOT success — it is the
 * absence of evidence, which on this rail has historically meant failure.
 */
export function isAutoRentalAccepted(response = {}) {
  const flag = response?.ExtData?.ARLFlag ?? response?.extData?.ARLFlag ?? null;
  return String(flag || '').toUpperCase() === 'Y';
}

export const autoRentalValidation = {
  L2L3_FIELD_MAP,
  AUTORENTAL_FIELD_MAP,
  extractValidationErrors,
  describeValidationErrors,
  isAutoRentalAccepted,
};
