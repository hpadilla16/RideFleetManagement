/**
 * Report Builder dataset registries (2026-07-26, Hector: "lo mas inclusivo
 * posible" — every business domain in the system is a dataset).
 *
 * SECURITY MODEL — read before adding a field:
 * - Every exposable field is an explicit entry here. The engine refuses any
 *   key not in the registry, so this file IS the leak boundary.
 * - `roles` defaults to MONEY_ROLES for money/PII and STAFF_ROLES otherwise;
 *   AGENT access is explicit opt-in per field. Enforcement happens at RUN
 *   time against the runner's role (a TENANT-shared report built by an admin
 *   runs with money columns stripped for an agent), not only in the builder.
 * - Secrets/tokens/card data NEVER enter the registry (no cardOnFileToken,
 *   no portal tokens, no signature data URLs, no authnet profile ids).
 * - `path` is a dot-path into the Prisma row shape built by the engine's
 *   select tree — never user-supplied.
 * - Location scoping: each dataset declares HOW it scopes to
 *   allowedLocationIds; the engine injects it before user filters. Datasets
 *   with no clean location column scope through their relation and fail
 *   CLOSED for scoped users when marked scopedUsersBlocked.
 */

export const STAFF_ROLES = ['SUPER_ADMIN', 'ADMIN', 'OPS', 'AGENT'];
export const MONEY_ROLES = ['SUPER_ADMIN', 'ADMIN', 'OPS'];

const f = (key, label, group, type, opts = {}) => ({ key, label, group, type, roles: MONEY_ROLES, ...opts });
const fa = (key, label, group, type, opts = {}) => ({ key, label, group, type, roles: STAFF_ROLES, ...opts });

const CUSTOMER_NAME_FIELDS = (prefix = 'customer') => ([
  fa(`${prefix}Name`, 'Customer name', 'Customer', 'string', {
    path: null,
    resolve: (row) => [row?.[prefix]?.firstName, row?.[prefix]?.lastName].filter(Boolean).join(' '),
    select: { [prefix]: { select: { firstName: true, lastName: true } } }
  })
]);

const LOCATION_FIELD = (key, label, relation) =>
  fa(key, label, 'Locations', 'string', {
    path: `${relation}.name`,
    select: { [relation]: { select: { name: true, code: true } } },
    filterPath: `${relation}Id`
  });

export const CUSTOM_REPORT_DATASETS = {
  reservations: {
    key: 'reservations',
    label: 'Reservations',
    description: 'Bookings and rentals',
    model: 'reservation',
    dateFields: { pickupAt: 'Pickup date', returnAt: 'Return date', createdAt: 'Created date' },
    requiredDateFilter: true,
    baseWhere: {},
    // Both endpoints, matching reservationLocationFilter's posture app-wide:
    // a one-way rental is visible from EITHER branch (QA 2026-07-26).
    locationPaths: ['pickupLocationId', 'returnLocationId'],
    fields: [
      fa('reservationNumber', 'Reservation #', 'Identity', 'string'),
      fa('status', 'Status', 'Status & Channel', 'enum'),
      fa('bookingChannel', 'Booking channel', 'Status & Channel', 'enum'),
      fa('workflowMode', 'Workflow', 'Status & Channel', 'enum'),
      f('isPrepaid', 'Prepaid', 'Status & Channel', 'boolean'),
      fa('pickupAt', 'Pickup date', 'Dates', 'date'),
      fa('returnAt', 'Return date', 'Dates', 'date'),
      fa('createdAt', 'Created date', 'Dates', 'date'),
      ...CUSTOMER_NAME_FIELDS(),
      f('customerEmail', 'Customer email', 'Customer', 'string', { path: 'customer.email', select: { customer: { select: { email: true } } } }),
      f('customerPhone', 'Customer phone', 'Customer', 'string', { path: 'customer.phone', select: { customer: { select: { phone: true } } } }),
      fa('vehiclePlate', 'Vehicle plate', 'Vehicle', 'string', { path: 'vehicle.plate', select: { vehicle: { select: { plate: true, internalNumber: true, make: true, model: true } } } }),
      fa('vehicleUnit', 'Vehicle unit #', 'Vehicle', 'string', { path: 'vehicle.internalNumber' }),
      fa('vehicleMakeModel', 'Vehicle make/model', 'Vehicle', 'string', { resolve: (r) => [r?.vehicle?.make, r?.vehicle?.model].filter(Boolean).join(' '), select: { vehicle: { select: { make: true, model: true } } } }),
      LOCATION_FIELD('pickupLocation', 'Pickup location', 'pickupLocation'),
      LOCATION_FIELD('returnLocation', 'Return location', 'returnLocation'),
      f('dailyRate', 'Daily rate', 'Money', 'money'),
      f('estimatedTotal', 'Estimated total', 'Money', 'money'),
      f('paymentStatus', 'Payment status', 'Money', 'enum'),
      f('agreementNumber', 'Agreement #', 'Agreement', 'string', { path: 'rentalAgreement.agreementNumber', select: { rentalAgreement: { select: { agreementNumber: true, status: true, total: true, balance: true } } } }),
      f('agreementStatus', 'Agreement status', 'Agreement', 'enum', { path: 'rentalAgreement.status' }),
      f('agreementTotal', 'Agreement total', 'Agreement', 'money', { path: 'rentalAgreement.total' }),
      f('agreementBalance', 'Agreement balance', 'Agreement', 'money', { path: 'rentalAgreement.balance' }),
      fa('flightNumber', 'Flight #', 'Extras', 'string'),
      fa('notes', 'Notes', 'Extras', 'string')
    ],
    filterableKeys: ['status', 'bookingChannel', 'workflowMode', 'paymentStatus', 'pickupLocation', 'returnLocation'],
    groupByKeys: ['status', 'bookingChannel', 'pickupLocation', 'paymentStatus']
  },

  payments: {
    key: 'payments',
    label: 'Payments',
    description: 'Money collected on agreements',
    model: 'rentalAgreementPayment',
    tenantPath: 'rentalAgreement.tenantId',
    dateFields: { paidAt: 'Paid date', createdAt: 'Created date' },
    requiredDateFilter: true,
    baseWhere: {},
    locationPaths: ['rentalAgreement.pickupLocationId'],
    rolesDataset: MONEY_ROLES,
    fields: [
      f('paidAt', 'Paid date', 'Payment', 'date'),
      f('amount', 'Amount', 'Payment', 'money'),
      f('method', 'Method', 'Payment', 'enum'),
      f('status', 'Status', 'Payment', 'enum'),
      f('reference', 'Reference #', 'Payment', 'string'),
      f('notes', 'Notes', 'Payment', 'string'),
      f('agreementNumber', 'Agreement #', 'Agreement', 'string', { path: 'rentalAgreement.agreementNumber', select: { rentalAgreement: { select: { agreementNumber: true, status: true, customerFirstName: true, customerLastName: true, pickupLocation: { select: { name: true, code: true } } } } } }),
      f('agreementStatus', 'Agreement status', 'Agreement', 'enum', { path: 'rentalAgreement.status' }),
      f('customerName', 'Customer name', 'Customer', 'string', { resolve: (r) => [r?.rentalAgreement?.customerFirstName, r?.rentalAgreement?.customerLastName].filter(Boolean).join(' '), select: { rentalAgreement: { select: { customerFirstName: true, customerLastName: true } } } }),
      f('location', 'Location', 'Locations', 'string', { path: 'rentalAgreement.pickupLocation.name', filterPath: 'rentalAgreement.pickupLocationId' })
    ],
    filterableKeys: ['method', 'status', 'location'],
    groupByKeys: ['method', 'status', 'location']
  },

  charges: {
    key: 'charges',
    label: 'Charges',
    description: 'Billed line items on agreements',
    model: 'rentalAgreementCharge',
    tenantPath: 'rentalAgreement.tenantId',
    dateFields: { createdAt: 'Charged date' },
    requiredDateFilter: true,
    baseWhere: { selected: true },
    locationPaths: ['rentalAgreement.pickupLocationId'],
    rolesDataset: MONEY_ROLES,
    fields: [
      f('createdAt', 'Charged date', 'Charge', 'date'),
      f('name', 'Charge name', 'Charge', 'string'),
      f('code', 'Code', 'Charge', 'string'),
      f('source', 'Source', 'Charge', 'enum'),
      f('quantity', 'Quantity', 'Charge', 'number'),
      f('rate', 'Rate', 'Charge', 'money'),
      f('total', 'Total', 'Charge', 'money'),
      f('taxable', 'Taxable', 'Charge', 'boolean'),
      f('agreementNumber', 'Agreement #', 'Agreement', 'string', { path: 'rentalAgreement.agreementNumber', select: { rentalAgreement: { select: { agreementNumber: true, status: true, pickupLocation: { select: { name: true } } } } } }),
      f('agreementStatus', 'Agreement status', 'Agreement', 'enum', { path: 'rentalAgreement.status' }),
      f('location', 'Location', 'Locations', 'string', { path: 'rentalAgreement.pickupLocation.name', filterPath: 'rentalAgreement.pickupLocationId' })
    ],
    filterableKeys: ['source', 'location'],
    groupByKeys: ['name', 'code', 'source', 'location']
  },

  fleet: {
    key: 'fleet',
    label: 'Fleet',
    description: 'Your vehicles today (snapshot, no date range)',
    model: 'vehicle',
    dateFields: {},
    requiredDateFilter: false,
    baseWhere: {},
    locationPaths: ['homeLocationId'],
    fields: [
      fa('internalNumber', 'Unit #', 'Identity', 'string'),
      fa('plate', 'Plate', 'Identity', 'string'),
      fa('vin', 'VIN', 'Identity', 'string'),
      fa('make', 'Make', 'Identity', 'string'),
      fa('model', 'Model', 'Identity', 'string'),
      fa('year', 'Year', 'Identity', 'number'),
      fa('color', 'Color', 'Identity', 'string'),
      fa('vehicleClass', 'Class', 'Identity', 'string', { path: 'vehicleType.name', select: { vehicleType: { select: { name: true, code: true } } }, filterPath: 'vehicleTypeId' }),
      fa('status', 'Status', 'Status & Location', 'enum'),
      fa('fleetMode', 'Fleet mode', 'Status & Location', 'enum'),
      LOCATION_FIELD('homeLocation', 'Home location', 'homeLocation'),
      fa('mileage', 'Mileage', 'Mileage', 'number'),
      fa('registrationExpiresAt', 'Registration expires', 'Compliance', 'date'),
      f('acquisitionCost', 'Acquisition cost', 'Value & Ownership', 'money', { roles: ['SUPER_ADMIN', 'ADMIN'] }),
      f('acquisitionDate', 'Acquired on', 'Value & Ownership', 'date', { roles: ['SUPER_ADMIN', 'ADMIN'] }),
      fa('createdAt', 'Added to fleet', 'Value & Ownership', 'date')
    ],
    filterableKeys: ['status', 'fleetMode', 'homeLocation', 'vehicleClass'],
    groupByKeys: ['status', 'make', 'homeLocation', 'vehicleClass', 'year']
  },

  customers: {
    key: 'customers',
    label: 'Customers',
    description: 'Who rents from you',
    model: 'customer',
    dateFields: { createdAt: 'Created date' },
    requiredDateFilter: false,
    baseWhere: {},
    locationPaths: [],
    scopedUsersBlocked: true,
    rolesDataset: MONEY_ROLES,
    fields: [
      f('firstName', 'First name', 'Identity', 'string'),
      f('lastName', 'Last name', 'Identity', 'string'),
      f('email', 'Email', 'Contact', 'string'),
      f('phone', 'Phone', 'Contact', 'string'),
      f('city', 'City', 'Address', 'string'),
      f('state', 'State', 'Address', 'string'),
      f('country', 'Country', 'Address', 'string'),
      f('licenseState', 'License state', 'License', 'string'),
      f('doNotRent', 'Do not rent', 'Flags', 'boolean'),
      f('creditBalance', 'Credit balance', 'Money', 'money'),
      f('createdAt', 'Created date', 'Dates', 'date')
    ],
    filterableKeys: ['state', 'country', 'licenseState', 'doNotRent'],
    groupByKeys: ['state', 'country', 'licenseState', 'doNotRent']
  },

  tolls: {
    key: 'tolls',
    label: 'Tolls',
    description: 'Toll crossings and their billing',
    model: 'tollTransaction',
    dateFields: { transactionAt: 'Toll date', createdAt: 'Imported date' },
    requiredDateFilter: true,
    baseWhere: {},
    locationPaths: ['locationId'],
    fields: [
      fa('transactionAt', 'Toll date', 'Toll', 'date'),
      f('amount', 'Amount', 'Toll', 'money'),
      fa('location', 'Plaza', 'Toll', 'string'),
      fa('plateRaw', 'Plate', 'Toll', 'string'),
      fa('status', 'Match status', 'Billing', 'enum'),
      f('billingStatus', 'Billing status', 'Billing', 'enum'),
      fa('needsReview', 'Needs review', 'Billing', 'boolean'),
      fa('reservationNumber', 'Reservation #', 'Rental', 'string', { path: 'reservation.reservationNumber', select: { reservation: { select: { reservationNumber: true } } } }),
      fa('vehicleUnit', 'Vehicle unit #', 'Rental', 'string', { path: 'vehicle.internalNumber', select: { vehicle: { select: { internalNumber: true } } } }),
      fa('createdAt', 'Imported date', 'Dates', 'date')
    ],
    filterableKeys: ['status', 'billingStatus', 'needsReview'],
    groupByKeys: ['status', 'billingStatus', 'location']
  },

  citations: {
    key: 'citations',
    label: 'Citations',
    description: 'Tickets and fines',
    model: 'citation',
    dateFields: { issuedAt: 'Issued date', createdAt: 'Imported date' },
    requiredDateFilter: true,
    baseWhere: {},
    locationPaths: [],
    scopedUsersBlocked: true,
    fields: [
      fa('citationNo', 'Citation #', 'Citation', 'string'),
      fa('agency', 'Agency', 'Citation', 'string'),
      fa('violationType', 'Violation', 'Citation', 'string'),
      fa('issuedAt', 'Issued date', 'Citation', 'date'),
      f('amount', 'Amount', 'Money', 'money'),
      f('fee', 'Fee', 'Money', 'money'),
      fa('dueAt', 'Due date', 'Citation', 'date'),
      fa('plateRaw', 'Plate', 'Citation', 'string'),
      fa('status', 'Match status', 'Billing', 'enum'),
      f('billingStatus', 'Billing status', 'Billing', 'enum'),
      fa('holdReason', 'Hold reason', 'Billing', 'string'),
      fa('reservationNumber', 'Reservation #', 'Rental', 'string', { path: 'reservation.reservationNumber', select: { reservation: { select: { reservationNumber: true } } } })
    ],
    filterableKeys: ['status', 'billingStatus', 'agency'],
    groupByKeys: ['agency', 'status', 'billingStatus', 'violationType']
  },

  commissions: {
    key: 'commissions',
    label: 'Commissions',
    description: 'Staff commission ledger',
    model: 'agreementCommission',
    dateFields: { calculatedAt: 'Calculated date', paidAt: 'Paid date' },
    requiredDateFilter: true,
    baseWhere: {},
    locationPaths: [],
    scopedUsersBlocked: true,
    rolesDataset: MONEY_ROLES,
    fields: [
      f('monthKey', 'Month', 'Commission', 'string'),
      f('status', 'Status', 'Commission', 'enum'),
      f('employeeName', 'Employee', 'Commission', 'string', { path: 'employeeUser.fullName', select: { employeeUser: { select: { fullName: true, email: true } } } }),
      f('grossRevenue', 'Gross revenue', 'Money', 'money'),
      f('eligibleRevenue', 'Eligible revenue', 'Money', 'money'),
      f('commissionAmount', 'Commission', 'Money', 'money'),
      f('calculatedAt', 'Calculated date', 'Dates', 'date'),
      f('paidAt', 'Paid date', 'Dates', 'date'),
      f('agreementNumber', 'Agreement #', 'Agreement', 'string', { path: 'rentalAgreement.agreementNumber', select: { rentalAgreement: { select: { agreementNumber: true } } } })
    ],
    filterableKeys: ['status', 'monthKey'],
    groupByKeys: ['status', 'monthKey', 'employeeName']
  },

  maintenance: {
    key: 'maintenance',
    label: 'Maintenance',
    description: 'Repair orders and service',
    model: 'repairOrder',
    dateFields: { openedAt: 'Opened date', completedAt: 'Completed date' },
    requiredDateFilter: true,
    baseWhere: {},
    locationPaths: ['locationId'],
    fields: [
      fa('roNumber', 'RO #', 'Repair order', 'number'),
      fa('status', 'Status', 'Repair order', 'enum'),
      fa('source', 'Source', 'Repair order', 'enum'),
      fa('vendor', 'Vendor', 'Repair order', 'string'),
      fa('poNumber', 'PO #', 'Repair order', 'string'),
      fa('openedAt', 'Opened date', 'Dates', 'date'),
      fa('completedAt', 'Completed date', 'Dates', 'date'),
      fa('odometerAtOpen', 'Odometer at open', 'Vehicle', 'number'),
      fa('vehicleUnit', 'Vehicle unit #', 'Vehicle', 'string', { path: 'vehicle.internalNumber', select: { vehicle: { select: { internalNumber: true, plate: true } } } }),
      fa('vehiclePlate', 'Vehicle plate', 'Vehicle', 'string', { path: 'vehicle.plate' })
    ],
    filterableKeys: ['status', 'source', 'vendor'],
    groupByKeys: ['status', 'source', 'vendor']
  },

  incidents: {
    key: 'incidents',
    label: 'Incidents',
    description: 'Damage and trip incidents',
    model: 'tripIncident',
    tenantPath: 'reservation.tenantId',
    dateFields: { createdAt: 'Reported date', resolvedAt: 'Resolved date' },
    requiredDateFilter: true,
    baseWhere: {},
    locationPaths: [],
    scopedUsersBlocked: true,
    fields: [
      fa('title', 'Title', 'Incident', 'string'),
      fa('type', 'Type', 'Incident', 'enum'),
      fa('status', 'Status', 'Incident', 'enum'),
      fa('severity', 'Severity', 'Incident', 'enum'),
      fa('priority', 'Priority', 'Incident', 'enum'),
      f('amountClaimed', 'Amount claimed', 'Money', 'money'),
      f('amountResolved', 'Amount resolved', 'Money', 'money'),
      f('liabilityDecision', 'Liability', 'Resolution', 'enum'),
      f('chargeDecision', 'Charge decision', 'Resolution', 'enum'),
      fa('createdAt', 'Reported date', 'Dates', 'date'),
      fa('resolvedAt', 'Resolved date', 'Dates', 'date'),
      fa('reservationNumber', 'Reservation #', 'Rental', 'string', { path: 'reservation.reservationNumber', select: { reservation: { select: { reservationNumber: true } } } })
    ],
    filterableKeys: ['type', 'status', 'severity'],
    groupByKeys: ['type', 'status', 'severity']
  }
};

/** Registry views filtered to a role — single source of truth for UI + engine. */
export function datasetsForRole(role) {
  const out = [];
  for (const ds of Object.values(CUSTOM_REPORT_DATASETS)) {
    const dsRoles = ds.rolesDataset || STAFF_ROLES;
    if (!dsRoles.includes(role)) continue;
    const fields = ds.fields.filter((field) => (field.roles || MONEY_ROLES).includes(role));
    if (!fields.length) continue;
    out.push({
      key: ds.key,
      label: ds.label,
      description: ds.description,
      dateFields: ds.dateFields,
      requiredDateFilter: ds.requiredDateFilter,
      fields: fields.map(({ key, label, group, type }) => ({ key, label, group, type })),
      filterableKeys: ds.filterableKeys.filter((k) => fields.some((fl) => fl.key === k)),
      groupByKeys: ds.groupByKeys.filter((k) => fields.some((fl) => fl.key === k))
    });
  }
  return out;
}
