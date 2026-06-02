import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { uploadObject, safePath, getSignedUrl } from '../../lib/storage/supabase-storage.js';
import { decodePhotoValue, getPhotosBucket } from '../rental-agreements/inspection-photos.js';
import { buildIncidentReportHtml } from './incident-report-pdf.js';

// =====================================================================
// Damage / Incident Report service. Builds a reservation-anchored,
// dispute-ready incident report; immutable once ISSUED (revise = clone).
// Plan: doc/damage-incident-report-plan-2026-06-01.md
// =====================================================================

const DEFAULT_WINDOW_HOURS = 24;

const TYPE_META = {
  DAMAGE: { title: 'VEHICLE DAMAGE INCIDENT REPORT', banner: 'VEHICLE DAMAGE DOCUMENTED AT RETURN — DAMAGE CHARGE ASSESSED' },
  SMOKING: { title: 'VEHICLE POLICY VIOLATION & SMOKING FEE INCIDENT REPORT — PROHIBITED SUBSTANCE USE', banner: 'SMOKING FEE VIOLATION — EVIDENCE OF PROHIBITED SUBSTANCE USE DOCUMENTED INSIDE VEHICLE' },
  CLEANING: { title: 'VEHICLE CLEANING FEE INCIDENT REPORT', banner: 'EXCESSIVE SOILING DOCUMENTED — CLEANING FEE ASSESSED' },
  POLICY_VIOLATION: { title: 'RENTAL AGREEMENT POLICY VIOLATION REPORT', banner: 'POLICY VIOLATION DOCUMENTED — FEES ASSESSED PER AGREEMENT' },
  TOLL: { title: 'UNPAID TOLL INCIDENT REPORT', banner: 'UNPAID TOLL ACTIVITY DOCUMENTED — TOLL + ADMIN FEE ASSESSED' },
  LATE_RETURN: { title: 'LATE RETURN INCIDENT REPORT', banner: 'VEHICLE RETURNED PAST CONTRACTED TIME — LATE FEE ASSESSED' },
  OTHER: { title: 'VEHICLE INCIDENT REPORT', banner: '' }
};

// Seed clause library (mirrors the sample's §5). Seeded per-tenant; editable.
const DEFAULT_CLAUSES = [
  { section: '6', label: 'Smoking Prohibition', amountRange: null, category: 'SMOKING', text: 'Smoking or use of any tobacco, cannabis, or other substance inside the rental vehicle is strictly prohibited and triggers the applicable smoking fee.' },
  { section: '6', label: 'Smoking Fee', amountRange: '$500 + tax', category: 'SMOKING', text: 'A smoking fee of $500 + tax applies for any evidence of smoking inside the vehicle.' },
  { section: '6', label: 'Cleaning Fee', amountRange: '$150–$750 + tax', category: 'CLEANING', text: 'Cleaning fees of $150–$750 + tax apply to vehicles returned in unsanitary or excessively soiled condition.' },
  { section: '6', label: 'Vehicle Condition at Return', amountRange: null, category: 'DAMAGE', text: 'The vehicle must be returned in identical condition (normal wear permitted). Contamination or damage exceeding normal wear is chargeable.' },
  { section: '1', label: 'Illegal Activity / Authorized Use', amountRange: null, category: 'POLICY_VIOLATION', text: 'Use of the rental vehicle for illegal activities, including consumption of controlled substances, constitutes unauthorized use and breach of contract.' },
  { section: '15', label: 'Breach of Contract', amountRange: 'up to $2,500', category: 'POLICY_VIOLATION', text: 'Any violation of the agreement may result in a breach-of-contract penalty of up to $2,500, plus all actual damages, cleaning costs, and administrative fees.' }
];

function tenantScope(user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN') return {};
  return user?.tenantId ? { tenantId: user.tenantId } : { id: '__never__' };
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); } catch { return ''; }
}
function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.max(0, Math.round((new Date(b) - new Date(a)) / (24 * 3600e3)));
}

function makeReportNumber(vehicle, date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const plate = String(vehicle?.licensePlate || vehicle?.plate || 'NA').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'NA';
  return `INC-${y}${m}${d}-${plate}`;
}

function reportingWindowHours(tenant) {
  try {
    const s = typeof tenant?.settingsJson === 'string' ? JSON.parse(tenant.settingsJson) : (tenant?.settingsJson || {});
    const n = Number(s.incidentReportingWindowHours);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_HOURS;
  } catch { return DEFAULT_WINDOW_HOURS; }
}

function err(message, statusCode) { const e = new Error(message); e.statusCode = statusCode; return e; }

function serialize(row) {
  if (!row) return null;
  let citedClauses = [];
  try { citedClauses = row.citedClausesJson ? JSON.parse(row.citedClausesJson) : []; } catch {}
  return {
    id: row.id, tenantId: row.tenantId, reservationId: row.reservationId,
    reportNumber: row.reportNumber, type: row.type, status: row.status, severity: row.severity,
    title: row.title, discoveryAt: row.discoveryAt, narrative: row.narrative,
    preRentalCondition: row.preRentalCondition, odorNoted: row.odorNoted, conditionAtReturn: row.conditionAtReturn,
    citedClauses, rebuttalText: row.rebuttalText,
    depositApplied: row.depositApplied == null ? null : Number(row.depositApplied),
    certifiedByName: row.certifiedByName, certifiedByTitle: row.certifiedByTitle,
    certifiedAt: row.certifiedAt, issuedAt: row.issuedAt, revisionOfId: row.revisionOfId,
    locked: row.status !== 'DRAFT',
    evidence: (row.evidence || []).map((e) => ({
      id: e.id, ordinal: e.ordinal, location: e.location, description: e.description,
      evidenceStatus: e.evidenceStatus, storagePath: e.storagePath, sourcePhase: e.sourcePhase, takenAt: e.takenAt
    })),
    createdAt: row.createdAt, updatedAt: row.updatedAt
  };
}

const includeEvidence = { evidence: { orderBy: { ordinal: 'asc' } } };

async function findScoped(user, id) {
  const row = await prisma.reservationIncident.findFirst({ where: { id: String(id), ...tenantScope(user) }, include: includeEvidence });
  if (!row) throw err('Incident report not found', 404);
  return row;
}
function assertDraft(row) {
  if (row.status !== 'DRAFT') throw err(`Incident report is ${row.status.toLowerCase()} and cannot be edited`, 409);
}

export const incidentReportService = {
  async create(user, reservationId, payload = {}) {
    const reservation = await prisma.reservation.findFirst({
      where: { id: String(reservationId), ...tenantScope(user) },
      include: {
        customer: true,
        vehicle: true,
        rentalAgreement: { include: { charges: true, inspections: true } }
      }
    });
    if (!reservation) throw err('Reservation not found', 404);

    const type = String(payload.type || 'DAMAGE').toUpperCase();
    const meta = TYPE_META[type] || TYPE_META.OTHER;
    const ag = reservation.rentalAgreement;
    const checkoutInsp = (ag?.inspections || []).find((i) => i.phase === 'CHECKOUT');

    const created = await prisma.reservationIncident.create({
      data: {
        tenantId: reservation.tenantId ?? user?.tenantId ?? null,
        reservationId: reservation.id,
        rentalAgreementId: ag?.id ?? null,
        reportNumber: makeReportNumber(reservation.vehicle, new Date()),
        type, status: 'DRAFT',
        title: payload.title || meta.title,
        discoveryAt: parseDate(payload.discoveryAt) ?? reservation.returnAt ?? new Date(),
        narrative: payload.narrative || null,
        preRentalCondition: payload.preRentalCondition || checkoutInsp?.notes || 'Vehicle delivered clean — no pre-existing damage, smoke, or residue recorded at check-out.',
        odorNoted: payload.odorNoted || null,
        conditionAtReturn: payload.conditionAtReturn || null,
        depositApplied: ag?.securityDepositAmount ?? null,
        createdByUserId: user?.id || null
      },
      include: includeEvidence
    });
    return serialize(created);
  },

  async get(user, id) { return serialize(await findScoped(user, id)); },

  async listForReservation(user, reservationId) {
    const rows = await prisma.reservationIncident.findMany({
      where: { reservationId: String(reservationId), ...tenantScope(user) },
      include: includeEvidence, orderBy: { createdAt: 'desc' }
    });
    return rows.map(serialize);
  },

  async update(user, id, payload = {}) {
    const row = await findScoped(user, id);
    assertDraft(row);
    const data = {};
    for (const k of ['title', 'narrative', 'preRentalCondition', 'odorNoted', 'conditionAtReturn', 'rebuttalText']) {
      if (k in payload) data[k] = payload[k] || null;
    }
    if ('type' in payload) data.type = String(payload.type).toUpperCase();
    if ('severity' in payload) data.severity = payload.severity ? String(payload.severity).toUpperCase() : null;
    if ('discoveryAt' in payload) data.discoveryAt = parseDate(payload.discoveryAt) ?? row.discoveryAt;
    if ('depositApplied' in payload) data.depositApplied = payload.depositApplied == null ? null : Number(payload.depositApplied);
    if ('chargeIds' in payload) data.chargeIdsJson = JSON.stringify(payload.chargeIds || []);
    const updated = await prisma.reservationIncident.update({ where: { id: row.id }, data, include: includeEvidence });
    return serialize(updated);
  },

  /** Snapshot selected clauses from the tenant library into the report. */
  async setClauses(user, id, clauseIds = []) {
    const row = await findScoped(user, id);
    assertDraft(row);
    const clauses = await prisma.agreementClause.findMany({ where: { id: { in: clauseIds.map(String) }, ...tenantScope(user) } });
    const snapshot = clauses.map((c) => ({ section: c.section, label: c.label, text: c.text, amountRange: c.amountRange }));
    const updated = await prisma.reservationIncident.update({
      where: { id: row.id }, data: { citedClausesJson: JSON.stringify(snapshot) }, include: includeEvidence
    });
    return serialize(updated);
  },

  async addEvidence(user, id, payload = {}) {
    const row = await findScoped(user, id);
    assertDraft(row);
    const nextOrdinal = (row.evidence?.reduce((m, e) => Math.max(m, e.ordinal), 0) || 0) + 1;
    let storagePath = payload.storagePath || null;
    let contentType = null;
    if (payload.photoDataUrl) {
      const decoded = decodePhotoValue(payload.photoDataUrl);
      if (decoded) {
        const tenantId = row.tenantId || user?.tenantId || 'no-tenant';
        const path = safePath('tenants', tenantId, 'incidents', row.id, `ev_${crypto.randomUUID()}.${decoded.ext}`);
        await uploadObject({ bucket: getPhotosBucket(), path, body: decoded.buffer, contentType: decoded.contentType, upsert: false });
        storagePath = path; contentType = decoded.contentType;
      }
    }
    const ev = await prisma.incidentEvidence.create({
      data: {
        incidentId: row.id, tenantId: row.tenantId,
        ordinal: nextOrdinal,
        location: String(payload.location || `Item ${nextOrdinal}`),
        description: String(payload.description || ''),
        evidenceStatus: String(payload.evidenceStatus || 'VIOLATION').toUpperCase() === 'CONFIRMED' ? 'CONFIRMED' : 'VIOLATION',
        storagePath, contentType,
        sourcePhase: payload.sourcePhase || 'NEW',
        takenByUserId: user?.id || null
      }
    });
    return { id: ev.id, ordinal: ev.ordinal };
  },

  /** One-tap pull of CHECKOUT/CHECKIN inspection photos as evidence rows. */
  async pullInspectionEvidence(user, id, phase = 'CHECKIN') {
    const row = await findScoped(user, id);
    assertDraft(row);
    if (!row.rentalAgreementId) throw err('No rental agreement on this reservation to pull inspections from', 400);
    const insp = await prisma.rentalAgreementInspection.findFirst({
      where: { rentalAgreementId: row.rentalAgreementId, phase: String(phase).toUpperCase() }
    });
    if (!insp) return { added: 0 };

    const PH = String(phase).toUpperCase();
    const status = PH === 'CHECKOUT' ? 'CONFIRMED' : 'VIOLATION';
    let ordinal = (row.evidence?.reduce((m, e) => Math.max(m, e.ordinal), 0) || 0);
    let added = 0;

    // 1) Modern path — photos already uploaded to Supabase Storage
    //    (INSPECTION_PHOTOS_STORAGE_ENABLED=true). Reference them directly.
    let refs = [];
    try { refs = Array.isArray(insp.photoStorageRefs) ? insp.photoStorageRefs : []; } catch {}
    for (const ref of refs) {
      if (!ref?.path) continue;
      ordinal += 1; added += 1;
      await prisma.incidentEvidence.create({
        data: {
          incidentId: row.id, tenantId: row.tenantId, ordinal,
          location: ref.key || `${PH} photo`,
          description: `Imported from ${PH} inspection.`,
          evidenceStatus: status,
          storagePath: ref.path, contentType: ref.contentType || null,
          sourcePhase: PH, takenByUserId: user?.id || null
        }
      });
    }

    // 2) Legacy path — when storage is off (default), inspection photos are
    //    base64-inlined in photosJson. Decode each and upload it into the
    //    incident bucket so it becomes a first-class evidence photo. Only used
    //    when the modern path produced nothing, to avoid duplicates during the
    //    storage-migration overlap window.
    if (added === 0 && insp.photosJson) {
      let parsed = {};
      try { parsed = JSON.parse(insp.photosJson) || {}; } catch { parsed = {}; }
      const items = [];
      const walk = (val, label) => {
        if (val == null) return;
        if (typeof val === 'string') { items.push({ value: val, label }); return; }
        if (Array.isArray(val)) { val.forEach((v, i) => walk(v, `${label} ${i + 1}`.trim())); return; }
        if (typeof val === 'object') { for (const [k, v] of Object.entries(val)) walk(v, label ? `${label} · ${k}` : k); }
      };
      walk(parsed, '');
      const tenantId = row.tenantId || user?.tenantId || 'no-tenant';
      for (const it of items) {
        const decoded = decodePhotoValue(it.value); // null for non-photo strings / already-hosted URLs
        if (!decoded) continue;
        const path = safePath('tenants', tenantId, 'incidents', row.id, `ev_${crypto.randomUUID()}.${decoded.ext}`);
        try {
          await uploadObject({ bucket: getPhotosBucket(), path, body: decoded.buffer, contentType: decoded.contentType, upsert: false });
        } catch { continue; }
        ordinal += 1; added += 1;
        await prisma.incidentEvidence.create({
          data: {
            incidentId: row.id, tenantId: row.tenantId, ordinal,
            location: it.label ? `${PH} · ${it.label}` : `${PH} photo`,
            description: `Imported from ${PH} inspection.`,
            evidenceStatus: status,
            storagePath: path, contentType: decoded.contentType,
            sourcePhase: PH, takenByUserId: user?.id || null
          }
        });
      }
    }

    return { added };
  },

  async removeEvidence(user, id, evidenceId) {
    const row = await findScoped(user, id);
    assertDraft(row);
    await prisma.incidentEvidence.deleteMany({ where: { id: String(evidenceId), incidentId: row.id } });
    return { ok: true };
  },

  /** Certify + issue. Locks the report (immutable; revise = clone). */
  async certifyAndIssue(user, id, payload = {}) {
    const row = await findScoped(user, id);
    assertDraft(row);
    const name = String(payload.certifiedByName || '').trim();
    const sig = String(payload.signatureDataUrl || '');
    if (!name) throw err('certifiedByName is required', 400);
    if (!sig.startsWith('data:image')) throw err('signatureDataUrl (data:image/...) is required', 400);
    const now = new Date();
    const updated = await prisma.reservationIncident.update({
      where: { id: row.id },
      data: {
        status: 'ISSUED', certifiedByName: name, certifiedByTitle: payload.certifiedByTitle || null,
        signatureDataUrl: sig, certifiedAt: now, issuedAt: now
      },
      include: includeEvidence
    });
    return serialize(updated);
  },

  /** Revise an issued report: clone into a new DRAFT linked by revisionOfId. */
  async revise(user, id) {
    const row = await findScoped(user, id);
    if (row.status === 'DRAFT') throw err('Report is still a draft — edit it directly', 400);
    const clone = await prisma.reservationIncident.create({
      data: {
        tenantId: row.tenantId, reservationId: row.reservationId, rentalAgreementId: row.rentalAgreementId,
        reportNumber: `${row.reportNumber}-R${Date.now().toString().slice(-4)}`,
        type: row.type, status: 'DRAFT', severity: row.severity, title: row.title,
        discoveryAt: row.discoveryAt, narrative: row.narrative, preRentalCondition: row.preRentalCondition,
        odorNoted: row.odorNoted, conditionAtReturn: row.conditionAtReturn,
        citedClausesJson: row.citedClausesJson, rebuttalText: row.rebuttalText,
        chargeIdsJson: row.chargeIdsJson, depositApplied: row.depositApplied,
        revisionOfId: row.id, createdByUserId: user?.id || null,
        evidence: {
          create: (row.evidence || []).map((e) => ({
            tenantId: e.tenantId, ordinal: e.ordinal, location: e.location, description: e.description,
            evidenceStatus: e.evidenceStatus, storagePath: e.storagePath, contentType: e.contentType,
            sourcePhase: e.sourcePhase, takenByUserId: e.takenByUserId
          }))
        }
      },
      include: includeEvidence
    });
    return serialize(clone);
  },

  /** Assemble the report object + render the print HTML. */
  async renderHtml(user, id) {
    const row = await findScoped(user, id);
    const reservation = await prisma.reservation.findFirst({
      where: { id: row.reservationId },
      include: { customer: true, vehicle: true, rentalAgreement: { include: { charges: true } }, tenant: true }
    });
    const report = await assembleReport(row, reservation);
    return buildIncidentReportHtml(report);
  },

  // ---- clause library ----
  clause: {
    async list(user) {
      return prisma.agreementClause.findMany({ where: { ...tenantScope(user) }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    },
    async create(user, payload = {}) {
      return prisma.agreementClause.create({
        data: {
          tenantId: user?.tenantId ?? null, section: String(payload.section || ''), label: String(payload.label || ''),
          text: String(payload.text || ''), amountRange: payload.amountRange || null,
          category: payload.category ? String(payload.category).toUpperCase() : null,
          active: payload.active !== false, sortOrder: Number(payload.sortOrder) || 0
        }
      });
    },
    async update(user, id, payload = {}) {
      const existing = await prisma.agreementClause.findFirst({ where: { id: String(id), ...tenantScope(user) } });
      if (!existing) throw err('Clause not found', 404);
      const data = {};
      for (const k of ['section', 'label', 'text', 'amountRange']) if (k in payload) data[k] = payload[k] || null;
      if ('category' in payload) data.category = payload.category ? String(payload.category).toUpperCase() : null;
      if ('active' in payload) data.active = !!payload.active;
      if ('sortOrder' in payload) data.sortOrder = Number(payload.sortOrder) || 0;
      return prisma.agreementClause.update({ where: { id: existing.id }, data });
    },
    async remove(user, id) {
      const existing = await prisma.agreementClause.findFirst({ where: { id: String(id), ...tenantScope(user) } });
      if (!existing) throw err('Clause not found', 404);
      await prisma.agreementClause.delete({ where: { id: existing.id } });
      return { ok: true };
    },
    /** Seed the default clause set for a tenant (idempotent-ish: skips if any exist). */
    async seed(user) {
      const tenantId = user?.tenantId ?? null;
      const count = await prisma.agreementClause.count({ where: { ...tenantScope(user) } });
      if (count > 0) return { seeded: 0, skipped: true };
      let n = 0;
      for (const c of DEFAULT_CLAUSES) {
        await prisma.agreementClause.create({ data: { tenantId, ...c, sortOrder: n } });
        n += 1;
      }
      return { seeded: n };
    }
  }
};

async function signedUrlSafe(path) {
  if (!path) return '';
  try { return await getSignedUrl({ bucket: getPhotosBucket(), path, expiresIn: 3600 }); } catch { return ''; }
}

async function assembleReport(row, reservation) {
  const ag = reservation?.rentalAgreement;
  const v = reservation?.vehicle;
  const cust = reservation?.customer;
  const renterName = ag?.customerFirstName
    ? [ag.customerFirstName, ag.customerLastName].filter(Boolean).join(' ')
    : [cust?.firstName, cust?.lastName].filter(Boolean).join(' ');

  // §6 charges: selected agreement charges
  const charges = (ag?.charges || []).filter((c) => c.selected !== false).map((c) => ({ name: c.name, total: Number(c.total) }));
  const chargeTotal = charges.reduce((s, c) => s + (Number.isFinite(c.total) ? c.total : 0), 0);
  const depositApplied = row.depositApplied == null ? null : Number(row.depositApplied);
  const balanceDue = charges.length ? Math.max(0, chargeTotal - (depositApplied || 0)) : null;

  // §8 photos: signed URLs for evidence with a photo
  const photos = [];
  for (const e of (row.evidence || [])) {
    if (e.storagePath) photos.push({ caption: `Fig. ${e.ordinal} — ${e.location}`, url: await signedUrlSafe(e.storagePath) });
  }

  let citedClauses = [];
  try { citedClauses = row.citedClausesJson ? JSON.parse(row.citedClausesJson) : []; } catch {}

  const rebuttalPoints = [
    'The signed rental agreement expressly authorizes the assessed fee upon evidence of the violation.',
    `The vehicle was delivered in clean, documented condition at check-out${reservation?.pickupAt ? ` on ${fmtDate(reservation.pickupAt)}` : ''} — no pre-existing issue recorded.`,
    `${(row.evidence || []).filter((e) => e.storagePath).length} timestamped photographs document the evidence across multiple locations.`,
    'The deposit was lawfully collected and applied per the signed agreement; the renter authorized post-rental charges.'
  ];

  const meta = TYPE_META[row.type] || TYPE_META.OTHER;
  return {
    company: { name: reservation?.tenant?.name || 'Ride Fleet' },
    reportNumber: row.reportNumber,
    dateIssued: fmtDate(row.issuedAt || new Date()),
    title: row.title || meta.title,
    bannerText: meta.banner,
    renter: { name: renterName },
    checkIn: fmtDate(reservation?.pickupAt),
    checkOut: fmtDate(reservation?.returnAt),
    periodDays: daysBetween(reservation?.pickupAt, reservation?.returnAt),
    depositCollected: ag?.securityDepositAmount != null ? Number(ag.securityDepositAmount) : null,
    smokingFeeAssessed: row.type === 'SMOKING' ? 'YES — per Rental Agreement' : null,
    vehicle: {
      makeModel: [v?.year, v?.make, v?.model].filter(Boolean).join(' '),
      color: v?.color || '',
      plate: v?.licensePlate || '',
      company: reservation?.tenant?.name || ''
    },
    preRentalCondition: row.preRentalCondition,
    incident: {
      discoveryAt: fmtDate(row.discoveryAt),
      violationType: row.narrative || row.title,
      odorNoted: row.odorNoted,
      conditionAtReturn: row.conditionAtReturn,
      chargeApplied: charges.length ? `${charges.map((c) => c.name).join(', ')} — deposit applied toward total` : null
    },
    evidence: (row.evidence || []).map((e) => ({ ordinal: e.ordinal, location: e.location, description: e.description, status: e.evidenceStatus })),
    clauses: citedClauses,
    charges: charges.length ? { lines: charges, total: chargeTotal, depositApplied, balanceDue } : { lines: [] },
    rebuttalPoints,
    photos,
    certification: { name: row.certifiedByName, title: row.certifiedByTitle, signatureDataUrl: row.signatureDataUrl, date: fmtDate(row.certifiedAt) }
  };
}

export const __test = { makeReportNumber, reportingWindowHours, serialize, daysBetween, DEFAULT_CLAUSES, TYPE_META };
