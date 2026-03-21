import { prisma } from '../../lib/prisma.js';
import { reservationsService } from '../reservations/reservations.service.js';

function tenantScope(user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN') return {};
  return user?.tenantId ? { tenantId: user.tenantId } : { id: '__never__' };
}

function includeReservation() {
  return {
    customer: true,
    vehicle: { include: { vehicleType: true } },
    vehicleType: true,
    pickupLocation: true,
    returnLocation: true,
    rentalAgreement: true
  };
}

function matchesQuery(query) {
  if (!query) return undefined;
  return {
    OR: [
      { reservationNumber: { contains: query, mode: 'insensitive' } },
      { repairOrderNumber: { contains: query, mode: 'insensitive' } },
      { claimNumber: { contains: query, mode: 'insensitive' } },
      { serviceAdvisorName: { contains: query, mode: 'insensitive' } },
      { customer: { firstName: { contains: query, mode: 'insensitive' } } },
      { customer: { lastName: { contains: query, mode: 'insensitive' } } },
      { customer: { email: { contains: query, mode: 'insensitive' } } },
      { serviceVehiclePlate: { contains: query, mode: 'insensitive' } },
      { serviceVehicleVin: { contains: query, mode: 'insensitive' } }
    ]
  };
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function buildBillingExportWhere(scope = {}, input = {}) {
  const query = String(input?.query || '').trim();
  const billingStatus = String(input?.billingStatus || '').trim().toUpperCase();
  const billingMode = String(input?.billingMode || '').trim().toUpperCase();
  const startDate = parseDate(input?.startDate);
  const endDate = parseDate(input?.endDate);

  const where = {
    ...scope,
    workflowMode: 'DEALERSHIP_LOANER',
    status: { not: 'CANCELLED' },
    ...(matchesQuery(query) || {})
  };

  if (billingStatus) where.loanerBillingStatus = billingStatus;
  if (billingMode) where.loanerBillingMode = billingMode;
  if (startDate || endDate) {
    where.pickupAt = {
      ...(startDate ? { gte: startDate } : {}),
      ...(endDate ? { lte: endDate } : {})
    };
  }

  return where;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateTime(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function buildBillingCsv(rows = []) {
  const header = [
    'Reservation',
    'Customer',
    'Repair Order',
    'Claim',
    'Billing Mode',
    'Billing Status',
    'Estimate',
    'Payment Status',
    'Agreement Total',
    'Agreement Balance',
    'Billing Contact',
    'Billing Email',
    'Billing Phone',
    'Authorization Ref',
    'Advisor',
    'Pickup',
    'Return',
    'Location',
    'Due Now',
    'Dealer Covered',
    'Alert Reason'
  ];

  const body = rows.map((row) => [
    row.reservationNumber,
    [row.customer?.firstName, row.customer?.lastName].filter(Boolean).join(' '),
    row.repairOrderNumber || '',
    row.claimNumber || '',
    row.loanerBillingMode || '',
    row.loanerBillingStatus || '',
    row.estimatedTotal || 0,
    row.paymentStatus || '',
    row.rentalAgreement?.total || 0,
    row.rentalAgreement?.balance || 0,
    row.loanerBillingContactName || '',
    row.loanerBillingContactEmail || '',
    row.loanerBillingContactPhone || '',
    row.loanerBillingAuthorizationRef || '',
    row.serviceAdvisorName || '',
    formatDateTime(row.pickupAt),
    formatDateTime(row.returnAt),
    row.pickupLocation?.name || '',
    Math.max(0, Number(row.rentalAgreement?.balance || 0)),
    ['COURTESY', 'WARRANTY', 'INTERNAL'].includes(String(row.loanerBillingMode || '').toUpperCase()) ? 'Yes' : 'No',
    row.status === 'CHECKED_OUT' && row.returnAt && new Date(row.returnAt).getTime() < Date.now()
      ? 'Overdue Return'
      : row.loanerBillingStatus === 'DENIED'
        ? 'Billing Denied'
        : row.estimatedServiceCompletionAt && !row.loanerServiceCompletedAt && new Date(row.estimatedServiceCompletionAt).getTime() < Date.now()
          ? 'Service ETA Missed'
          : ''
  ].map(csvCell).join(','));

  return [header.map(csvCell).join(','), ...body].join('\n');
}

function buildLoanerHandoffHtml(row) {
  let packet = {};
  try {
    packet = row.loanerBorrowerPacketJson ? JSON.parse(row.loanerBorrowerPacketJson) : {};
  } catch {}
  const customerName = [row.customer?.firstName, row.customer?.lastName].filter(Boolean).join(' ') || 'Customer';
  const serviceVehicle = [row.serviceVehicleYear, row.serviceVehicleMake, row.serviceVehicleModel, row.serviceVehiclePlate].filter(Boolean).join(' - ') || '-';
  const loanerVehicle = row.vehicle ? [row.vehicle.year, row.vehicle.make, row.vehicle.model, row.vehicle.internalNumber].filter(Boolean).join(' ') : 'Unassigned';
  return buildLoanerPrintShell({
    title: `Loaner Handoff Packet ${row.reservationNumber}`,
    pill: `Handoff ${row.reservationNumber}`,
    subtitle: `RO ${row.repairOrderNumber || '-'} • ${row.loanerBillingMode || '-'} • Claim ${row.claimNumber || '-'}`,
    summaryTiles: [
      { label: 'Customer', value: customerName },
      { label: 'Reservation', value: row.reservationNumber },
      { label: 'Pickup', value: formatDateTime(row.pickupAt) },
      { label: 'Return', value: formatDateTime(row.returnAt) },
      { label: 'Loaner Vehicle', value: loanerVehicle },
      { label: 'Service Vehicle', value: serviceVehicle },
      { label: 'Billing Status', value: row.loanerBillingStatus || 'DRAFT' },
      { label: 'Liability Accepted', value: row.loanerLiabilityAccepted ? 'Yes' : 'No' }
    ],
    sections: [
      {
        title: 'Borrower Packet',
        content: buildLoanerTable([
          ['Driver License Checked', packet.driverLicenseChecked ? 'Yes' : 'No'],
          ['Insurance Card Collected', packet.insuranceCardCollected ? 'Yes' : 'No'],
          ['Registration Confirmed', packet.registrationConfirmed ? 'Yes' : 'No'],
          ['Walkaround Completed', packet.walkaroundCompleted ? 'Yes' : 'No'],
          ['Fuel / Mileage Captured', packet.fuelAndMileageCaptured ? 'Yes' : 'No'],
          ['Notes', packet.notes || row.loanerCloseoutNotes || row.serviceAdvisorNotes || '-']
        ])
      },
      {
        title: 'Service Lane Context',
        content: buildLoanerTable([
          ['Service Advisor', row.serviceAdvisorName || '-'],
          ['Advisor Email', row.serviceAdvisorEmail || '-'],
          ['Advisor Phone', row.serviceAdvisorPhone || '-'],
          ['Billing Contact', row.loanerBillingContactName || '-'],
          ['Authorization Ref', row.loanerBillingAuthorizationRef || '-'],
          ['Pickup Location', row.pickupLocation?.name || '-']
        ])
      }
    ],
    signatureLabels: ['Customer Signature / Initials', 'Staff / Service Advisor']
  });
}

function buildLoanerPrintShell({
  title,
  pill,
  subtitle,
  companyName = 'Ride Fleet',
  companyAddress = '',
  companyPhone = '',
  summaryTiles = [],
  sections = [],
  footer = 'Ride Fleet dealership loaner program',
  signatureLabels = []
}) {
  const tileHtml = summaryTiles.map((tile) => `
    <div class="tile">
      <div class="k">${escapeHtml(tile.label)}</div>
      <div class="v ${tile.tone === 'paid' ? 'paid' : tile.tone === 'due' ? 'due' : ''}">${escapeHtml(tile.value)}</div>
    </div>
  `).join('');
  const sectionHtml = sections.map((section) => `
    <div class="card section">
      <h3>${escapeHtml(section.title)}</h3>
      ${section.content}
    </div>
  `).join('');
  const signatures = signatureLabels.length
    ? `<div class="card section"><div class="sig">${signatureLabels.map((label) => `<div class="sig-main"><div class="sig-meta">${escapeHtml(label)}</div></div>`).join('')}</div></div>`
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#0b0a12;--bg-2:#12101c;--card:#171424;--card-2:#1d1830;--line:#30264a;--ink:#f4f1ff;--muted:#b0a7c7;--brand:#8b5cf6;--brand2:#c084fc;--ok:#22c55e;--warn:#f59e0b;--radius:16px;--shadow:0 12px 36px rgba(0,0,0,.45);}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,ui-sans-serif,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--ink);background:radial-gradient(900px 400px at -10% -10%, #2a1c4d 0%, transparent 60%),radial-gradient(700px 350px at 110% -10%, #2f1a52 0%, transparent 60%),linear-gradient(180deg,var(--bg),var(--bg-2));padding:24px;}
.wrap{max-width:1050px;margin:0 auto}
.card{background:linear-gradient(180deg,var(--card),var(--card-2));border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);}
.hero{padding:18px 20px;display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:12px;}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.logo{width:52px;height:52px;border-radius:12px;border:1px solid #4b3b74;background:#120f1e;display:flex;align-items:center;justify-content:center;overflow:hidden;flex:0 0 auto;}
.logo-fallback{color:#d7c7ff;font-size:18px;font-weight:800;letter-spacing:.03em;}
.title{margin:0;font-size:30px;line-height:1.05;letter-spacing:-.02em;font-weight:850;background:linear-gradient(90deg,var(--brand),var(--brand2));-webkit-background-clip:text;background-clip:text;color:transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sub{margin-top:6px;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill{border:1px solid #5d4691;color:#dccdff;background:#231a39;border-radius:999px;padding:9px 13px;font-size:12px;font-weight:700;white-space:nowrap;}
.section{padding:13px;margin-top:10px}
.section h3{margin:0 0 9px;font-size:17px;color:#efe9ff}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;}
.tile{border:1px solid #3a2d5f;border-radius:11px;padding:9px 10px;background:#1a1530;}
.k{color:#9f93be;font-size:10px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;}
.v{font-size:14px;font-weight:650}
.paid{color:var(--ok)}
.due{color:var(--warn)}
table{width:100%;border-collapse:separate;border-spacing:0;border:1px solid #3a2d5f;border-radius:12px;overflow:hidden;background:#18132b;}
th,td{padding:9px 10px;font-size:12px;border-bottom:1px solid #31264f;vertical-align:top;}
tr:last-child td{border-bottom:none}
th{background:#21193a;color:#ac9ed0;text-transform:uppercase;letter-spacing:.07em;font-size:10px;text-align:left;}
.terms{border:1px solid #3a2d5f;border-radius:12px;background:#17122a;color:#c8bcdf;padding:12px;font-size:12px;line-height:1.55;white-space:pre-wrap;}
.sig{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}
.sig-main{border:1px dashed #5a468d;border-radius:12px;background:#18132b;padding:10px;min-height:92px;}
.sig-meta{font-size:11px;color:#aa9ec8;margin-bottom:8px}
.footer{margin-top:10px;text-align:center;color:#9185af;font-size:10px;letter-spacing:.03em;}
@media (max-width:940px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.sig{grid-template-columns:1fr}}
@media print{body{padding:0;background:#fff;color:#111}.card,.tile,table,.terms,.sig-main{background:#fff !important;color:#111 !important;border-color:#ddd !important;box-shadow:none !important}th{background:#f5f5f5 !important;color:#555 !important}.title{color:#111 !important;-webkit-text-fill-color:#111;background:none}.sub,.k,.sig-meta,.footer{color:#555 !important}.paid{color:#166534 !important}.due{color:#92400e !important}}
</style>
</head>
<body><div class="wrap"><div class="card hero"><div class="brand"><div class="logo"><div class="logo-fallback">RF</div></div><div style="min-width:0"><h1 class="title">${escapeHtml(companyName)}</h1><div class="sub">${escapeHtml(companyAddress)} ${companyPhone ? `• ${escapeHtml(companyPhone)}` : ''}</div><div class="sub">${escapeHtml(subtitle || '')}</div></div></div><div class="pill">${escapeHtml(pill || title)}</div></div><div class="card section"><div class="grid">${tileHtml}</div></div>${sectionHtml}${signatures}<div class="footer">${escapeHtml(footer)}</div></div></body></html>`;
}

function buildLoanerTable(rows = []) {
  return `<table><tbody>${rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</tbody></table>`;
}

function buildLoanerBillingSummaryHtml(row) {
  const customerName = [row.customer?.firstName, row.customer?.lastName].filter(Boolean).join(' ') || 'Customer';
  const agreementTotal = Number(row.rentalAgreement?.total || 0);
  const agreementBalance = Number(row.rentalAgreement?.balance || 0);
  const estimate = Number(row.estimatedTotal || 0);
  const serviceVehicle = [row.serviceVehicleYear, row.serviceVehicleMake, row.serviceVehicleModel, row.serviceVehiclePlate].filter(Boolean).join(' - ') || '-';
  const loanerVehicle = row.vehicle ? [row.vehicle.year, row.vehicle.make, row.vehicle.model, row.vehicle.internalNumber].filter(Boolean).join(' ') : 'Unassigned';
  return buildLoanerPrintShell({
    title: `Dealer Invoice Summary ${row.reservationNumber}`,
    pill: `Invoice ${row.loanerDealerInvoiceNumber || row.reservationNumber}`,
    subtitle: `RO ${row.repairOrderNumber || '-'} • Claim ${row.claimNumber || '-'} • Billing ${row.loanerBillingMode || '-'}`,
    summaryTiles: [
      { label: 'Customer', value: customerName },
      { label: 'Reservation', value: row.reservationNumber },
      { label: 'Estimate', value: `$${estimate.toFixed(2)}` },
      { label: 'Agreement Balance', value: `$${agreementBalance.toFixed(2)}`, tone: agreementBalance > 0 ? 'due' : 'paid' },
      { label: 'Billing Status', value: row.loanerBillingStatus || 'DRAFT' },
      { label: 'Invoice #', value: row.loanerDealerInvoiceNumber || '-' },
      { label: 'PO #', value: row.loanerPurchaseOrderNumber || '-' },
      { label: 'Accounting Closed', value: row.loanerAccountingClosedAt ? formatDateTime(row.loanerAccountingClosedAt) : 'Open' }
    ],
    sections: [
      { title: 'Service And Vehicle Context', content: buildLoanerTable([['Service Advisor', row.serviceAdvisorName || '-'], ['Service Vehicle', serviceVehicle], ['Loaner Vehicle', loanerVehicle], ['Pickup Location', row.pickupLocation?.name || '-'], ['Return Location', row.returnLocation?.name || '-']]) },
      { title: 'Dealer Billing Summary', content: buildLoanerTable([['Billing Mode', row.loanerBillingMode || '-'], ['Billing Status', row.loanerBillingStatus || 'DRAFT'], ['Estimate', `$${estimate.toFixed(2)}`], ['Agreement Total', `$${agreementTotal.toFixed(2)}`], ['Agreement Balance', `$${agreementBalance.toFixed(2)}`], ['Payment Status', row.paymentStatus || 'PENDING'], ['Billing Contact', row.loanerBillingContactName || '-'], ['Billing Email', row.loanerBillingContactEmail || '-'], ['Billing Phone', row.loanerBillingContactPhone || '-'], ['Authorization Ref', row.loanerBillingAuthorizationRef || '-'], ['Accounting Notes', row.loanerAccountingNotes || row.loanerBillingNotes || '-']]) }
    ],
    signatureLabels: ['Service Advisor / Authorization', 'Accounting / Billing Review']
  });
}

function buildLoanerPurchaseOrderHtml(row) {
  const customerName = [row.customer?.firstName, row.customer?.lastName].filter(Boolean).join(' ') || 'Customer';
  const estimate = Number(row.estimatedTotal || 0);
  const serviceVehicle = [row.serviceVehicleYear, row.serviceVehicleMake, row.serviceVehicleModel, row.serviceVehiclePlate].filter(Boolean).join(' - ') || '-';
  const loanerVehicle = row.vehicle ? [row.vehicle.year, row.vehicle.make, row.vehicle.model, row.vehicle.internalNumber].filter(Boolean).join(' ') : 'Unassigned';
  return buildLoanerPrintShell({
    title: `Loaner Purchase Order ${row.reservationNumber}`,
    pill: `PO ${row.loanerPurchaseOrderNumber || row.reservationNumber}`,
    subtitle: 'Dealer authorization to release a loaner during active service',
    summaryTiles: [
      { label: 'PO Number', value: row.loanerPurchaseOrderNumber || '-' },
      { label: 'Reservation', value: row.reservationNumber },
      { label: 'RO Number', value: row.repairOrderNumber || '-' },
      { label: 'Billing Mode', value: row.loanerBillingMode || '-' },
      { label: 'Customer', value: customerName },
      { label: 'Advisor', value: row.serviceAdvisorName || '-' },
      { label: 'Pickup', value: formatDateTime(row.pickupAt) },
      { label: 'Return', value: formatDateTime(row.returnAt) }
    ],
    sections: [
      { title: 'Purchase Order Context', content: buildLoanerTable([['Service Vehicle', serviceVehicle], ['Loaner Vehicle', loanerVehicle], ['Claim Number', row.claimNumber || '-'], ['Estimated Loaner Cost', `$${estimate.toFixed(2)}`], ['Liability Accepted', row.loanerLiabilityAccepted ? 'Yes' : 'No'], ['Billing Contact', row.loanerBillingContactName || '-'], ['Authorization Ref', row.loanerBillingAuthorizationRef || '-']]) },
      { title: 'Program Notes', content: `<div class="terms">${escapeHtml(row.loanerProgramNotes || row.loanerBillingNotes || row.loanerAccountingNotes || 'No additional purchase-order notes recorded.')}</div>` }
    ],
    signatureLabels: ['Service Advisor Approval', 'Accounting / PO Release']
  });
}

function reservationCard(row) {
  let packet = {};
  try {
    packet = row.loanerBorrowerPacketJson ? JSON.parse(row.loanerBorrowerPacketJson) : {};
  } catch {}
  return {
    id: row.id,
    reservationNumber: row.reservationNumber,
    workflowMode: row.workflowMode,
    status: row.status,
    paymentStatus: row.paymentStatus,
    pickupAt: row.pickupAt,
    returnAt: row.returnAt,
    estimatedTotal: row.estimatedTotal,
    readyForPickupAt: row.readyForPickupAt,
    repairOrderNumber: row.repairOrderNumber,
    claimNumber: row.claimNumber,
    loanerBillingMode: row.loanerBillingMode,
    serviceAdvisorName: row.serviceAdvisorName,
    estimatedServiceCompletionAt: row.estimatedServiceCompletionAt,
    loanerBorrowerPacketCompletedAt: row.loanerBorrowerPacketCompletedAt,
    loanerBorrowerPacketCompletedBy: row.loanerBorrowerPacketCompletedBy,
    loanerBorrowerPacket: packet,
    loanerBillingContactName: row.loanerBillingContactName,
    loanerBillingContactEmail: row.loanerBillingContactEmail,
    loanerBillingContactPhone: row.loanerBillingContactPhone,
    loanerBillingAuthorizationRef: row.loanerBillingAuthorizationRef,
    loanerBillingNotes: row.loanerBillingNotes,
    loanerReturnExceptionFlag: !!row.loanerReturnExceptionFlag,
    loanerReturnExceptionNotes: row.loanerReturnExceptionNotes,
    loanerBillingStatus: row.loanerBillingStatus || 'DRAFT',
    loanerBillingSubmittedAt: row.loanerBillingSubmittedAt,
    loanerBillingSettledAt: row.loanerBillingSettledAt,
    serviceAdvisorNotes: row.serviceAdvisorNotes,
    serviceAdvisorUpdatedAt: row.serviceAdvisorUpdatedAt,
    loanerServiceCompletedAt: row.loanerServiceCompletedAt,
    loanerServiceCompletedBy: row.loanerServiceCompletedBy,
    loanerCloseoutNotes: row.loanerCloseoutNotes,
    loanerPurchaseOrderNumber: row.loanerPurchaseOrderNumber,
    loanerDealerInvoiceNumber: row.loanerDealerInvoiceNumber,
    loanerAccountingNotes: row.loanerAccountingNotes,
    loanerAccountingClosedAt: row.loanerAccountingClosedAt,
    loanerAccountingClosedBy: row.loanerAccountingClosedBy,
    loanerLastExtendedAt: row.loanerLastExtendedAt,
    loanerLastVehicleSwapAt: row.loanerLastVehicleSwapAt,
    serviceVehicle: {
      year: row.serviceVehicleYear,
      make: row.serviceVehicleMake,
      model: row.serviceVehicleModel,
      plate: row.serviceVehiclePlate,
      vin: row.serviceVehicleVin
    },
    customer: row.customer
      ? {
          id: row.customer.id,
          firstName: row.customer.firstName,
          lastName: row.customer.lastName,
          email: row.customer.email,
          phone: row.customer.phone
        }
      : null,
    vehicle: row.vehicle
      ? {
          id: row.vehicle.id,
          make: row.vehicle.make,
          model: row.vehicle.model,
          year: row.vehicle.year,
          internalNumber: row.vehicle.internalNumber
        }
      : null,
    vehicleType: row.vehicleType ? { id: row.vehicleType.id, name: row.vehicleType.name } : null,
    pickupLocation: row.pickupLocation ? { id: row.pickupLocation.id, name: row.pickupLocation.name } : null,
    returnLocation: row.returnLocation ? { id: row.returnLocation.id, name: row.returnLocation.name } : null,
    rentalAgreement: row.rentalAgreement
      ? {
          id: row.rentalAgreement.id,
          status: row.rentalAgreement.status,
          balance: row.rentalAgreement.balance,
          total: row.rentalAgreement.total
        }
      : null,
    overdueReturn: row.status === 'CHECKED_OUT' && row.returnAt ? new Date(row.returnAt).getTime() < Date.now() : false,
    serviceEtaAtRisk: row.status !== 'CANCELLED' && !row.loanerServiceCompletedAt && row.estimatedServiceCompletionAt
      ? new Date(row.estimatedServiceCompletionAt).getTime() < Date.now()
      : false
  };
}

async function ensureTenantFeature(scope = {}, tenantId = null) {
  const resolvedTenantId = tenantId || scope?.tenantId || null;
  if (!resolvedTenantId) return true;
  const tenant = await prisma.tenant.findUnique({
    where: { id: resolvedTenantId },
    select: { dealershipLoanerEnabled: true }
  });
  return !!tenant?.dealershipLoanerEnabled;
}

async function resolveCustomer(payload = {}, scope = {}) {
  if (payload.customerId) {
    const existing = await prisma.customer.findFirst({
      where: {
        id: String(payload.customerId),
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      }
    });
    if (!existing) throw new Error('Selected customer not found');
    return existing;
  }

  const firstName = String(payload.firstName || '').trim();
  const lastName = String(payload.lastName || '').trim();
  const phone = String(payload.phone || '').trim();
  const email = String(payload.email || '').trim().toLowerCase() || null;
  if (!firstName || !lastName || !phone) {
    throw new Error('Customer first name, last name, and phone are required');
  }

  if (email) {
    const existingByEmail = await prisma.customer.findFirst({
      where: {
        email,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      }
    });
    if (existingByEmail) return existingByEmail;
  }

  return prisma.customer.create({
    data: {
      tenantId: scope?.tenantId || null,
      firstName,
      lastName,
      phone,
      email
    }
  });
}

function makeReservationNumber() {
  return `DL-${Date.now().toString().slice(-8)}`;
}

async function getLoanerReservationOrThrow(id, scope = {}) {
  const row = await prisma.reservation.findFirst({
    where: {
      id,
      workflowMode: 'DEALERSHIP_LOANER',
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
    },
    include: includeReservation()
  });
  if (!row) throw new Error('Loaner reservation not found');
  return row;
}

export const dealershipLoanerService = {
  async getConfig(user, tenantId = null) {
    const role = String(user?.role || '').toUpperCase();
    if (role === 'SUPER_ADMIN') {
      if (!tenantId) return { enabled: true, tenantId: null, tenantName: null };
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, name: true, dealershipLoanerEnabled: true }
      });
      return {
        enabled: !!tenant?.dealershipLoanerEnabled || true,
        tenantId: tenant?.id || tenantId,
        tenantName: tenant?.name || null
      };
    }

    if (!user?.tenantId) return { enabled: false, tenantId: null, tenantName: null };
    const tenant = await prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { id: true, name: true, dealershipLoanerEnabled: true }
    });
    return {
      enabled: !!tenant?.dealershipLoanerEnabled,
      tenantId: tenant?.id || user.tenantId,
      tenantName: tenant?.name || null
    };
  },

  async getDashboard(user, input = {}) {
    const scope = tenantScope(user);
    const query = String(input?.query || '').trim();
    const now = new Date();
    const next72h = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(startOfToday);
    endOfToday.setDate(endOfToday.getDate() + 1);
    const loanerWhere = { ...scope, workflowMode: 'DEALERSHIP_LOANER' };

    const [intakeRaw, activeRaw, returnsRaw, advisorRaw, billingRaw, overdueRaw, searchRaw, counts] = await Promise.all([
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          status: { in: ['NEW', 'CONFIRMED'] },
          pickupAt: { gte: startOfToday, lte: next72h }
        },
        include: includeReservation(),
        orderBy: [{ pickupAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          status: 'CHECKED_OUT'
        },
        include: includeReservation(),
        orderBy: [{ returnAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          status: { in: ['CONFIRMED', 'CHECKED_OUT'] },
          returnAt: { gte: startOfToday, lte: next72h }
        },
        include: includeReservation(),
        orderBy: [{ returnAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          status: { in: ['NEW', 'CONFIRMED'] }
        },
        include: includeReservation(),
        orderBy: [{ estimatedServiceCompletionAt: 'asc' }, { pickupAt: 'asc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          status: { not: 'CANCELLED' },
          loanerBillingMode: { in: ['CUSTOMER_PAY', 'WARRANTY', 'INSURANCE'] },
          loanerBillingStatus: { not: 'SETTLED' }
        },
        include: includeReservation(),
        orderBy: [{ updatedAt: 'desc' }],
        take: 8
      }),
      prisma.reservation.findMany({
        where: {
          ...loanerWhere,
          status: { in: ['NEW', 'CONFIRMED', 'CHECKED_OUT'] },
          OR: [
            { status: 'CHECKED_OUT', returnAt: { lt: now } },
            { status: { in: ['NEW', 'CONFIRMED'] }, estimatedServiceCompletionAt: { lt: now }, readyForPickupAt: null },
            { loanerBillingStatus: 'DENIED' }
          ]
        },
        include: includeReservation(),
        orderBy: [{ returnAt: 'asc' }, { estimatedServiceCompletionAt: 'asc' }, { updatedAt: 'desc' }],
        take: 12
      }),
      query
        ? prisma.reservation.findMany({
            where: {
              ...loanerWhere,
              ...(matchesQuery(query) || {})
            },
            include: includeReservation(),
            orderBy: [{ pickupAt: 'desc' }],
            take: 12
          })
        : Promise.resolve([]),
      Promise.all([
        prisma.reservation.count({ where: { ...loanerWhere, status: { in: ['NEW', 'CONFIRMED', 'CHECKED_OUT'] } } }),
        prisma.reservation.count({ where: { ...loanerWhere, status: 'CHECKED_OUT' } }),
        prisma.reservation.count({ where: { ...loanerWhere, status: { in: ['NEW', 'CONFIRMED'] }, pickupAt: { gte: startOfToday, lt: endOfToday } } }),
        prisma.reservation.count({ where: { ...loanerWhere, status: { in: ['CONFIRMED', 'CHECKED_OUT'] }, returnAt: { gte: startOfToday, lt: endOfToday } } }),
        prisma.reservation.count({ where: { ...loanerWhere, readyForPickupAt: { not: null }, status: { in: ['NEW', 'CONFIRMED'] } } }),
        prisma.reservation.count({ where: { ...loanerWhere, status: { in: ['NEW', 'CONFIRMED'] }, loanerBorrowerPacketCompletedAt: null } }),
        prisma.reservation.count({ where: { ...loanerWhere, status: { not: 'CANCELLED' }, loanerBillingMode: { in: ['CUSTOMER_PAY', 'WARRANTY', 'INSURANCE'] }, loanerBillingStatus: { not: 'SETTLED' } } }),
        prisma.reservation.count({ where: { ...loanerWhere, loanerReturnExceptionFlag: true, status: { not: 'CANCELLED' } } }),
        prisma.reservation.count({ where: { ...loanerWhere, status: 'CHECKED_OUT', returnAt: { lt: now } } }),
        prisma.reservation.count({ where: { ...loanerWhere, status: { in: ['NEW', 'CONFIRMED'] }, estimatedServiceCompletionAt: { lt: now }, readyForPickupAt: null } })
      ])
    ]);

    return {
      badges: [
        counts[8] > 0 ? { tone: 'warn', label: `${counts[8]} overdue returns`, detail: 'Loaners still out past the promised return time' } : null,
        counts[9] > 0 ? { tone: 'warn', label: `${counts[9]} service delays`, detail: 'Service ETA passed and the customer still is not ready for handoff' } : null,
        counts[7] > 0 ? { tone: 'warn', label: `${counts[7]} return exceptions`, detail: 'Loaners with damage, fuel, odor, or closeout issues' } : null,
        counts[6] > 0 ? { tone: 'neutral', label: `${counts[6]} billing items`, detail: 'Customer-pay, warranty, or insurance loaners still not settled' } : null
      ].filter(Boolean),
      query,
      metrics: {
        openLoaners: counts[0],
        activeLoaners: counts[1],
        pickupsToday: counts[2],
        dueBackToday: counts[3],
        readyForDelivery: counts[4],
        packetPending: counts[5],
        billingAttention: counts[6],
        returnExceptions: counts[7],
        overdueReturns: counts[8],
        serviceDelays: counts[9]
      },
      queues: {
        intake: intakeRaw.map(reservationCard),
        active: activeRaw.map(reservationCard),
        returns: returnsRaw.map(reservationCard),
        advisor: advisorRaw.map(reservationCard),
        billing: billingRaw.map(reservationCard),
        alerts: overdueRaw.map((row) => ({
          ...reservationCard(row),
          alertReason: row.status === 'CHECKED_OUT' && row.returnAt && new Date(row.returnAt).getTime() < now.getTime()
            ? 'Overdue Return'
            : row.loanerBillingStatus === 'DENIED'
              ? 'Billing Denied'
              : 'Service ETA Missed',
          alertSeverity: row.status === 'CHECKED_OUT' && row.returnAt && new Date(row.returnAt).getTime() < now.getTime()
            ? 'warn'
            : row.loanerBillingStatus === 'DENIED'
              ? 'warn'
              : 'neutral'
        }))
      },
      searchResults: searchRaw.map(reservationCard)
    };
  },

  async getIntakeOptions(user) {
    const scope = tenantScope(user);
    const [customers, locations, vehicleTypes, vehicles] = await Promise.all([
      prisma.customer.findMany({
        where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        select: { id: true, firstName: true, lastName: true, email: true, phone: true }
      }),
      prisma.location.findMany({
        where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
        orderBy: { name: 'asc' },
        select: { id: true, name: true }
      }),
      prisma.vehicleType.findMany({
        where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
        orderBy: { name: 'asc' },
        select: { id: true, name: true }
      }),
      prisma.vehicle.findMany({
        where: {
          ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
          status: { notIn: ['IN_MAINTENANCE', 'OUT_OF_SERVICE'] }
        },
        orderBy: [{ make: 'asc' }, { model: 'asc' }, { internalNumber: 'asc' }],
        select: {
          id: true,
          year: true,
          make: true,
          model: true,
          internalNumber: true,
          status: true
        }
      })
    ]);

    return { customers, locations, vehicleTypes, vehicles };
  },

  async intake(user, payload = {}) {
    const scope = tenantScope(user);
    const role = String(user?.role || '').toUpperCase();
    if (role !== 'SUPER_ADMIN') {
      const enabled = await ensureTenantFeature(scope);
      if (!enabled) throw new Error('Dealership loaner is not enabled for this tenant');
    }

    const customer = await resolveCustomer(payload, scope);
    if (!payload.vehicleTypeId) throw new Error('vehicleTypeId is required');
    if (!payload.pickupLocationId || !payload.returnLocationId) throw new Error('pickupLocationId and returnLocationId are required');
    if (!payload.pickupAt || !payload.returnAt) throw new Error('pickupAt and returnAt are required');
    if (!payload.loanerLiabilityAccepted) throw new Error('Customer liability acknowledgement is required');

    const billingMode = String(payload.loanerBillingMode || 'COURTESY').toUpperCase();
    const loanerBillingStatus = ['COURTESY', 'INTERNAL'].includes(billingMode) ? 'APPROVED' : 'PENDING_APPROVAL';
    const reservation = await reservationsService.create({
      reservationNumber: String(payload.reservationNumber || '').trim() || makeReservationNumber(),
      sourceRef: String(payload.sourceRef || '').trim() || `LOANER:${String(payload.repairOrderNumber || 'NA')}:${Date.now()}`,
      customerId: customer.id,
      vehicleId: payload.vehicleId ? String(payload.vehicleId) : null,
      vehicleTypeId: String(payload.vehicleTypeId),
      pickupAt: payload.pickupAt,
      returnAt: payload.returnAt,
      pickupLocationId: String(payload.pickupLocationId),
      returnLocationId: String(payload.returnLocationId),
      dailyRate: billingMode === 'COURTESY' || billingMode === 'WARRANTY' || billingMode === 'INTERNAL' ? 0 : Number(payload.dailyRate || 0),
      estimatedTotal: billingMode === 'COURTESY' || billingMode === 'WARRANTY' || billingMode === 'INTERNAL' ? 0 : Number(payload.estimatedTotal || 0),
      paymentStatus: 'PENDING',
      status: 'CONFIRMED',
      sendConfirmationEmail: false,
      notes: payload.notes || null,
      workflowMode: 'DEALERSHIP_LOANER',
      loanerBillingMode: billingMode,
      repairOrderNumber: payload.repairOrderNumber || null,
      claimNumber: payload.claimNumber || null,
      serviceAdvisorName: payload.serviceAdvisorName || null,
      serviceAdvisorEmail: payload.serviceAdvisorEmail || null,
      serviceAdvisorPhone: payload.serviceAdvisorPhone || null,
      serviceStartAt: payload.serviceStartAt || payload.pickupAt,
      estimatedServiceCompletionAt: payload.estimatedServiceCompletionAt || payload.returnAt,
      serviceVehicleYear: payload.serviceVehicleYear ? Number(payload.serviceVehicleYear) : null,
      serviceVehicleMake: payload.serviceVehicleMake || null,
      serviceVehicleModel: payload.serviceVehicleModel || null,
      serviceVehiclePlate: payload.serviceVehiclePlate || null,
      serviceVehicleVin: payload.serviceVehicleVin || null,
      loanerLiabilityAccepted: true,
      loanerProgramNotes: payload.loanerProgramNotes || null,
      loanerBillingStatus,
      loanerBillingSubmittedAt: ['WARRANTY', 'INSURANCE', 'CUSTOMER_PAY'].includes(billingMode) ? new Date().toISOString() : null,
      serviceAdvisorNotes: String(payload.serviceAdvisorNotes || '').trim() || null,
      serviceAdvisorUpdatedAt: payload.serviceAdvisorNotes ? new Date().toISOString() : null
    }, scope);

    return reservationsService.getById(reservation.id, scope);
  },

  async getReservation(user, reservationId) {
    const scope = tenantScope(user);
    const row = await getLoanerReservationOrThrow(reservationId, scope);
    return reservationCard(row);
  },

  async renderHandoffPrint(user, reservationId) {
    const scope = tenantScope(user);
    const row = await getLoanerReservationOrThrow(reservationId, scope);
    return buildLoanerHandoffHtml(row);
  },

  async renderBillingPrint(user, reservationId) {
    const scope = tenantScope(user);
    const row = await getLoanerReservationOrThrow(reservationId, scope);
    return buildLoanerBillingSummaryHtml(row);
  },

  async renderPurchaseOrderPrint(user, reservationId) {
    const scope = tenantScope(user);
    const row = await getLoanerReservationOrThrow(reservationId, scope);
    return buildLoanerPurchaseOrderHtml(row);
  },

  async exportBillingCsv(user, input = {}) {
    const scope = tenantScope(user);
    const rows = await prisma.reservation.findMany({
      where: buildBillingExportWhere(scope, input),
      include: includeReservation(),
      orderBy: [{ pickupAt: 'desc' }]
    });
    return buildBillingCsv(rows);
  },

  async saveBorrowerPacket(user, reservationId, payload = {}) {
    const scope = tenantScope(user);
    const current = await getLoanerReservationOrThrow(reservationId, scope);
    const packet = {
      driverLicenseChecked: !!payload.driverLicenseChecked,
      insuranceCardCollected: !!payload.insuranceCardCollected,
      registrationConfirmed: !!payload.registrationConfirmed,
      walkaroundCompleted: !!payload.walkaroundCompleted,
      fuelAndMileageCaptured: !!payload.fuelAndMileageCaptured,
      notes: String(payload.notes || '').trim() || null
    };
    const complete = packet.driverLicenseChecked
      && packet.insuranceCardCollected
      && packet.registrationConfirmed
      && packet.walkaroundCompleted
      && packet.fuelAndMileageCaptured;

    const updated = await reservationsService.update(reservationId, {
      loanerBorrowerPacketJson: JSON.stringify(packet),
      loanerBorrowerPacketCompletedAt: complete ? new Date().toISOString() : null,
      loanerBorrowerPacketCompletedBy: complete
        ? (String(user?.fullName || '').trim() || String(user?.email || '').trim() || 'Staff')
        : null
    }, scope);

    await prisma.auditLog.create({
      data: {
        tenantId: current.tenantId || user?.tenantId || null,
        reservationId,
        action: 'UPDATE',
        actorUserId: user?.sub || user?.id || null,
        metadata: JSON.stringify({
          dealershipLoanerBorrowerPacketSaved: true,
          complete,
          packet
        })
      }
    });

    return reservationCard(updated);
  },

  async saveBilling(user, reservationId, payload = {}) {
    const scope = tenantScope(user);
    const current = await getLoanerReservationOrThrow(reservationId, scope);
    const billingMode = payload.loanerBillingMode ? String(payload.loanerBillingMode).toUpperCase() : current.loanerBillingMode;
    const nextBillingStatus = payload.loanerBillingStatus
      ? String(payload.loanerBillingStatus).toUpperCase()
      : current.loanerBillingStatus;
    const submittedAt = payload.loanerBillingSubmittedAt
      ? payload.loanerBillingSubmittedAt
      : (current.loanerBillingSubmittedAt
        ? current.loanerBillingSubmittedAt.toISOString()
        : (['WARRANTY', 'INSURANCE', 'CUSTOMER_PAY'].includes(billingMode) ? new Date().toISOString() : null));

    const updated = await reservationsService.update(reservationId, {
      loanerBillingMode: billingMode,
      loanerBillingContactName: String(payload.loanerBillingContactName || '').trim() || null,
      loanerBillingContactEmail: String(payload.loanerBillingContactEmail || '').trim() || null,
      loanerBillingContactPhone: String(payload.loanerBillingContactPhone || '').trim() || null,
      loanerBillingAuthorizationRef: String(payload.loanerBillingAuthorizationRef || '').trim() || null,
      loanerBillingNotes: String(payload.loanerBillingNotes || '').trim() || null,
      loanerBillingStatus: nextBillingStatus,
      loanerBillingSubmittedAt: submittedAt,
      loanerBillingSettledAt: nextBillingStatus === 'SETTLED' ? new Date().toISOString() : null
    }, scope);

    await prisma.auditLog.create({
      data: {
        tenantId: current.tenantId || user?.tenantId || null,
        reservationId,
        action: 'UPDATE',
        actorUserId: user?.sub || user?.id || null,
        metadata: JSON.stringify({
          dealershipLoanerBillingSaved: true,
          loanerBillingMode: updated.loanerBillingMode,
          loanerBillingStatus: updated.loanerBillingStatus,
          loanerBillingAuthorizationRef: updated.loanerBillingAuthorizationRef || null
        })
      }
    });

    return reservationCard(updated);
  },

  async saveAccountingCloseout(user, reservationId, payload = {}) {
    const scope = tenantScope(user);
    const current = await getLoanerReservationOrThrow(reservationId, scope);
    const closed = !!payload.closeoutComplete;
    const updated = await reservationsService.update(reservationId, {
      loanerPurchaseOrderNumber: String(payload.loanerPurchaseOrderNumber || '').trim() || null,
      loanerDealerInvoiceNumber: String(payload.loanerDealerInvoiceNumber || '').trim() || null,
      loanerAccountingNotes: String(payload.loanerAccountingNotes || '').trim() || null,
      loanerAccountingClosedAt: closed ? new Date().toISOString() : null,
      loanerAccountingClosedBy: closed
        ? (String(user?.fullName || '').trim() || String(user?.email || '').trim() || 'Accounting')
        : null
    }, scope);

    await prisma.auditLog.create({
      data: {
        tenantId: current.tenantId || user?.tenantId || null,
        reservationId,
        action: 'UPDATE',
        actorUserId: user?.sub || user?.id || null,
        metadata: JSON.stringify({
          dealershipLoanerAccountingCloseoutSaved: true,
          closeoutComplete: closed,
          loanerPurchaseOrderNumber: String(payload.loanerPurchaseOrderNumber || '').trim() || null,
          loanerDealerInvoiceNumber: String(payload.loanerDealerInvoiceNumber || '').trim() || null
        })
      }
    });

    return reservationCard(updated);
  },

  async saveAdvisorOps(user, reservationId, payload = {}) {
    const scope = tenantScope(user);
    const current = await getLoanerReservationOrThrow(reservationId, scope);
    const markReady = payload.readyForPickup === true;

    const updated = await reservationsService.update(reservationId, {
      serviceAdvisorName: String(payload.serviceAdvisorName ?? current.serviceAdvisorName ?? '').trim() || null,
      serviceAdvisorEmail: String(payload.serviceAdvisorEmail ?? current.serviceAdvisorEmail ?? '').trim() || null,
      serviceAdvisorPhone: String(payload.serviceAdvisorPhone ?? current.serviceAdvisorPhone ?? '').trim() || null,
      serviceAdvisorNotes: String(payload.serviceAdvisorNotes || '').trim() || null,
      serviceAdvisorUpdatedAt: new Date().toISOString(),
      estimatedServiceCompletionAt: payload.estimatedServiceCompletionAt || null,
      readyForPickupAt: markReady ? new Date().toISOString() : null,
      readyForPickupByUserId: markReady ? (user?.sub || user?.id || null) : null,
      readyForPickupOverrideNote: markReady
        ? (String(payload.readyForPickupNote || '').trim() || 'Service lane marked ready for pickup')
        : null
    }, scope);

    await prisma.auditLog.create({
      data: {
        tenantId: current.tenantId || user?.tenantId || null,
        reservationId,
        action: 'UPDATE',
        actorUserId: user?.sub || user?.id || null,
        metadata: JSON.stringify({
          dealershipLoanerAdvisorOpsSaved: true,
          readyForPickup: markReady,
          estimatedServiceCompletionAt: updated.estimatedServiceCompletionAt,
          serviceAdvisorName: updated.serviceAdvisorName || null
        })
      }
    });

    return reservationCard(updated);
  },

  async saveReturnException(user, reservationId, payload = {}) {
    const scope = tenantScope(user);
    const current = await getLoanerReservationOrThrow(reservationId, scope);
    const flagged = payload.flagged !== false;
    const notes = String(payload.loanerReturnExceptionNotes || '').trim() || null;

    const updated = await reservationsService.update(reservationId, {
      loanerReturnExceptionFlag: flagged,
      loanerReturnExceptionNotes: flagged ? notes : null
    }, scope);

    await prisma.auditLog.create({
      data: {
        tenantId: current.tenantId || user?.tenantId || null,
        reservationId,
        action: 'UPDATE',
        actorUserId: user?.sub || user?.id || null,
        metadata: JSON.stringify({
          dealershipLoanerReturnExceptionSaved: true,
          flagged,
          notes
        })
      }
    });

    return reservationCard(updated);
  },

  async extendLoaner(user, reservationId, payload = {}) {
    const scope = tenantScope(user);
    const current = await getLoanerReservationOrThrow(reservationId, scope);
    if (!payload.returnAt) throw new Error('New return date is required');

    const updated = await reservationsService.update(reservationId, {
      returnAt: payload.returnAt,
      estimatedServiceCompletionAt: payload.estimatedServiceCompletionAt || payload.returnAt,
      loanerLastExtendedAt: new Date().toISOString()
    }, scope);

    await prisma.auditLog.create({
      data: {
        tenantId: current.tenantId || user?.tenantId || null,
        reservationId,
        action: 'UPDATE',
        actorUserId: user?.sub || user?.id || null,
        metadata: JSON.stringify({
          dealershipLoanerExtended: true,
          previousReturnAt: current.returnAt,
          nextReturnAt: updated.returnAt,
          estimatedServiceCompletionAt: updated.estimatedServiceCompletionAt,
          note: String(payload.note || '').trim() || null
        })
      }
    });

    return reservationCard(updated);
  },

  async swapVehicle(user, reservationId, payload = {}) {
    const scope = tenantScope(user);
    const current = await getLoanerReservationOrThrow(reservationId, scope);
    const nextVehicleId = String(payload.vehicleId || '').trim();
    if (!nextVehicleId) throw new Error('vehicleId is required');
    if (nextVehicleId === String(current.vehicleId || '')) {
      throw new Error('Select a different loaner vehicle to swap');
    }

    const updated = await reservationsService.update(reservationId, {
      vehicleId: nextVehicleId,
      loanerLastVehicleSwapAt: new Date().toISOString()
    }, scope);

    await prisma.auditLog.create({
      data: {
        tenantId: current.tenantId || user?.tenantId || null,
        reservationId,
        action: 'UPDATE',
        actorUserId: user?.sub || user?.id || null,
        metadata: JSON.stringify({
          dealershipLoanerVehicleSwapped: true,
          previousVehicleId: current.vehicleId || null,
          nextVehicleId,
          note: String(payload.note || '').trim() || null
        })
      }
    });

    return reservationCard(updated);
  },

  async completeService(user, reservationId, payload = {}) {
    const scope = tenantScope(user);
    const current = await getLoanerReservationOrThrow(reservationId, scope);
    const completedBy = String(user?.fullName || '').trim() || String(user?.email || '').trim() || 'Staff';

    const updated = await reservationsService.update(reservationId, {
      loanerServiceCompletedAt: new Date().toISOString(),
      loanerServiceCompletedBy: completedBy,
      loanerCloseoutNotes: String(payload.loanerCloseoutNotes || '').trim() || null,
      estimatedServiceCompletionAt: payload.estimatedServiceCompletionAt || current.estimatedServiceCompletionAt?.toISOString?.() || null
    }, scope);

    await prisma.auditLog.create({
      data: {
        tenantId: current.tenantId || user?.tenantId || null,
        reservationId,
        action: 'UPDATE',
        actorUserId: user?.sub || user?.id || null,
        metadata: JSON.stringify({
          dealershipLoanerServiceCompleted: true,
          completedBy,
          closeoutNotes: updated.loanerCloseoutNotes || null
        })
      }
    });

    return reservationCard(updated);
  }
};
