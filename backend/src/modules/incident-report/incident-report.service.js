import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { uploadObject, safePath, getSignedUrl } from '../../lib/storage/supabase-storage.js';
import { userAllowedLocationIds } from '../../lib/tenant-scope.js';
import { sendEmail } from '../../lib/mailer.js';
import { decodePhotoValue, getPhotosBucket } from '../rental-agreements/inspection-photos.js';
import { buildIncidentReportHtml } from './incident-report-pdf.js';
import { computeChargeSection } from './incident-report-charges.js';

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

const VALID_TYPES = Object.keys(TYPE_META);
const VALID_SEVERITIES = ['MINOR', 'MODERATE', 'SEVERE'];
// Post-issuance lifecycle. DRAFT only moves to ISSUED via certify; VOID/CLOSED are terminal.
const STATUS_FLOW = {
  DRAFT: [],
  ISSUED: ['DISPUTED', 'RESOLVED', 'CLOSED', 'VOID'],
  DISPUTED: ['RESOLVED', 'CLOSED', 'VOID'],
  RESOLVED: ['CLOSED', 'VOID'],
  CLOSED: [],
  VOID: []
};

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

/**
 * Collision-aware report number. 2026-06-03 — reportNumber is @unique but the
 * base format is INC-YYYYMMDD-PLATE, so a SECOND incident for the same vehicle
 * on the same day always threw P2002 (Sentry: "Unique constraint failed on
 * reportNumber", 500 to the agent). Second-and-later reports get a sequence
 * suffix: INC-20260603-KST788, INC-20260603-KST788-2, -3, …
 */
async function nextReportNumber(vehicle, date = new Date()) {
  const base = makeReportNumber(vehicle, date);
  // Exact base OR a `base-N` suffix only — NOT a greedy startsWith (which would let
  // INC-…-KST78 match INC-…-KST788 and inflate the count for similar plates).
  const clashes = await prisma.reservationIncident.count({
    where: { OR: [{ reportNumber: base }, { reportNumber: { startsWith: `${base}-` } }] },
  });
  return clashes === 0 ? base : `${base}-${clashes + 1}`;
}

function reportingWindowHours(tenant) {
  try {
    const s = typeof tenant?.settingsJson === 'string' ? JSON.parse(tenant.settingsJson) : (tenant?.settingsJson || {});
    const n = Number(s.incidentReportingWindowHours);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_HOURS;
  } catch { return DEFAULT_WINDOW_HOURS; }
}

function err(message, statusCode) { const e = new Error(message); e.statusCode = statusCode; return e; }

// Minimal HTML-escape for the optional email note (the report HTML itself is
// already escaped by buildIncidentReportHtml).
function escapeHtmlForEmail(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function serialize(row) {
  if (!row) return null;
  let citedClauses = [];
  try { citedClauses = row.citedClausesJson ? JSON.parse(row.citedClausesJson) : []; } catch {}
  let chargeIds = [];
  try { chargeIds = row.chargeIdsJson ? JSON.parse(row.chargeIdsJson) : []; } catch {}
  return {
    id: row.id, tenantId: row.tenantId, reservationId: row.reservationId,
    reportNumber: row.reportNumber, type: row.type, status: row.status, severity: row.severity,
    title: row.title, discoveryAt: row.discoveryAt, narrative: row.narrative,
    preRentalCondition: row.preRentalCondition, odorNoted: row.odorNoted, conditionAtReturn: row.conditionAtReturn,
    citedClauses, chargeIds, rebuttalText: row.rebuttalText,
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
        // Perf (2026-06-05): only checkoutInsp.notes is read from inspections
        // here — never pull photosJson base64 blobs into a create flow.
        rentalAgreement: {
          include: {
            charges: true,
            inspections: { select: { id: true, phase: true, capturedAt: true, notes: true } }
          }
        }
      }
    });
    if (!reservation) throw err('Reservation not found', 404);

    const type = String(payload.type || 'DAMAGE').toUpperCase();
    const meta = TYPE_META[type] || TYPE_META.OTHER;
    const ag = reservation.rentalAgreement;
    const checkoutInsp = (ag?.inspections || []).find((i) => i.phase === 'CHECKOUT');

    const baseData = {
      tenantId: reservation.tenantId ?? user?.tenantId ?? null,
      reservationId: reservation.id,
      rentalAgreementId: ag?.id ?? null,
      type, status: 'DRAFT',
      title: payload.title || meta.title,
      discoveryAt: parseDate(payload.discoveryAt) ?? reservation.returnAt ?? new Date(),
      narrative: payload.narrative || null,
      // Don't auto-assert a clean pre-rental condition on a dispute document. Use the
      // real check-out inspection notes if any; otherwise leave blank for staff to fill.
      preRentalCondition: payload.preRentalCondition || checkoutInsp?.notes || null,
      odorNoted: payload.odorNoted || null,
      conditionAtReturn: payload.conditionAtReturn || null,
      depositApplied: ag?.securityDepositAmount ?? null,
      createdByUserId: user?.id || null
    };
    // Retry on the @unique reportNumber collision — concurrent creates for the same
    // vehicle/day both compute the same suffix and one throws P2002.
    let created = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        created = await prisma.reservationIncident.create({
          data: { ...baseData, reportNumber: await nextReportNumber(reservation.vehicle, new Date()) },
          include: includeEvidence
        });
        break;
      } catch (e) {
        if (e?.code === 'P2002' && attempt < 4) continue;
        throw e;
      }
    }
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

  /**
   * Tenant-wide incidents HUB (2026-07-28): every report in one place, joined
   * with its reservation + customer + vehicle + pickup sede. Filters:
   * status/type/severity + free-text q (report #, reservation #, customer
   * name/email, plate). Location-scoped users only see incidents whose
   * reservation picked up at one of their sedes (fail-closed: a null
   * pickupLocationId row is hidden from scoped users, same convention as
   * tolls/citations lists).
   */
  async listForTenant(user, { status, type, severity, q, page = 1, pageSize = 50 } = {}) {
    const where = { ...tenantScope(user) };

    const st = String(status || '').toUpperCase();
    if (st && Object.prototype.hasOwnProperty.call(STATUS_FLOW, st)) where.status = st;
    const ty = String(type || '').toUpperCase();
    if (ty && VALID_TYPES.includes(ty)) where.type = ty;
    const sev = String(severity || '').toUpperCase();
    if (sev && VALID_SEVERITIES.includes(sev)) where.severity = sev;

    const allowedIds = userAllowedLocationIds(user);
    if (allowedIds) {
      where.reservation = { pickupLocationId: { in: allowedIds } };
    }

    const text = String(q || '').trim();
    if (text) {
      const contains = { contains: text, mode: 'insensitive' };
      where.OR = [
        { reportNumber: contains },
        { title: contains },
        { reservation: { reservationNumber: contains } },
        { reservation: { customer: { firstName: contains } } },
        { reservation: { customer: { lastName: contains } } },
        { reservation: { customer: { email: contains } } },
        { reservation: { vehicle: { plate: contains } } },
      ];
    }

    const take = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

    const [total, rows] = await Promise.all([
      prisma.reservationIncident.count({ where }),
      prisma.reservationIncident.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip, take,
        // Hub payload stays light: NO evidence blobs, just the row + the joins
        // the table shows. Detail/print still go through get()/renderHtml.
        select: {
          id: true, reportNumber: true, type: true, status: true, severity: true,
          title: true, discoveryAt: true, issuedAt: true, createdAt: true,
          depositApplied: true,
          reservation: {
            select: {
              id: true, reservationNumber: true,
              pickupLocation: { select: { id: true, name: true, code: true } },
              customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
              vehicle: { select: { id: true, plate: true, internalNumber: true, make: true, model: true } },
            }
          }
        }
      })
    ]);

    return {
      total,
      page: Math.max(Number(page) || 1, 1),
      pageSize: take,
      items: rows.map((r) => ({
        id: r.id, reportNumber: r.reportNumber, type: r.type, status: r.status,
        severity: r.severity, title: r.title, discoveryAt: r.discoveryAt,
        issuedAt: r.issuedAt, createdAt: r.createdAt,
        depositApplied: r.depositApplied == null ? null : Number(r.depositApplied),
        reservation: r.reservation ? {
          id: r.reservation.id,
          reservationNumber: r.reservation.reservationNumber,
          location: r.reservation.pickupLocation || null,
          customer: r.reservation.customer || null,
          vehicle: r.reservation.vehicle || null,
        } : null,
      })),
    };
  },

  /**
   * Email a report to a recipient (2026-07-28 hub ask): renders the SAME
   * print HTML and sends it inline + as an .html attachment. The report
   * content is never logged. Any non-DRAFT report can be emailed; a DRAFT
   * is blocked (it is not a final document yet).
   */
  async emailReport(user, id, { to, note } = {}) {
    const recipient = String(to || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw err('A valid recipient email is required', 400);
    const row = await findScoped(user, id);
    if (row.status === 'DRAFT') throw err('Draft reports cannot be emailed — certify & issue first', 409);

    const html = await this.renderHtml(user, id);
    const noteText = String(note || '').trim();
    const subject = `Incident Report ${row.reportNumber}`;
    const bodyHtml = [
      noteText ? `<p style="font-family:Arial,sans-serif">${escapeHtmlForEmail(noteText)}</p><hr/>` : '',
      html,
    ].join('\n');

    // The attachment is a REAL PDF (2026-08-07, Sentry f36960357ba5):
    // MailerSend content-sniffs every attachment against its filename and
    // rejected the .html one with MS42202 ("Filename and attached file does
    // not match"), 422-ing the whole send. A PDF's magic bytes always agree
    // with .pdf — and a PDF is the better deliverable for the insurance and
    // third parties these reports go to. The filename is sanitized because
    // the sniff-vs-name check is also known to trip on odd characters.
    // Fallback: if the PDF render fails, attach the HTML as before — a
    // maybe-rejected attachment beats losing the send entirely.
    const safeName = String(row.reportNumber).replace(/[^A-Za-z0-9._-]+/g, '-');
    let attachments;
    try {
      const { renderReportPdf } = await import('../reports/reports-export.js');
      const pdf = await renderReportPdf(html);
      attachments = [{ filename: `${safeName}.pdf`, content: pdf, contentType: 'application/pdf' }];
    } catch (pdfErr) {
      console.warn('[incident-report] PDF render failed — attaching HTML fallback', row.reportNumber, pdfErr?.message);
      attachments = [{
        filename: `${safeName}.html`,
        // Raw Buffer — the mailer's toBase64() encodes exactly once.
        content: Buffer.from(html, 'utf8'),
        contentType: 'text/html',
      }];
    }

    await sendEmail({ tenantId: user?.tenantId,
      to: recipient,
      subject,
      html: bodyHtml,
      text: `${noteText ? `${noteText}\n\n` : ''}Incident report ${row.reportNumber} is attached.`,
      attachments,
    });

    return { ok: true, reportNumber: row.reportNumber, to: recipient };
  },

  async update(user, id, payload = {}) {
    const row = await findScoped(user, id);
    assertDraft(row);
    const data = {};
    for (const k of ['title', 'narrative', 'preRentalCondition', 'odorNoted', 'conditionAtReturn', 'rebuttalText']) {
      if (k in payload) data[k] = payload[k] || null;
    }
    if ('type' in payload) {
      const t = String(payload.type).toUpperCase();
      if (!VALID_TYPES.includes(t)) throw err(`Invalid incident type: ${t}`, 400);
      data.type = t;
    }
    if ('severity' in payload) {
      if (!payload.severity) data.severity = null;
      else {
        const s = String(payload.severity).toUpperCase();
        if (!VALID_SEVERITIES.includes(s)) throw err(`Invalid severity: ${s}`, 400);
        data.severity = s;
      }
    }
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
      where: {
        rentalAgreementId: row.rentalAgreementId, phase: String(phase).toUpperCase(),
        // Defense-in-depth: the row is already tenant-scoped, but also constrain the
        // inspection's agreement to the same tenant when we have one.
        ...(row.tenantId ? { rentalAgreement: { tenantId: row.tenantId } } : {})
      }
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
      // Accept storage-path refs AND externally-hosted URL refs — don't silently drop
      // hosted inspection photos (signedUrlSafe passes full URLs through unchanged).
      const stored = ref?.path || ref?.url || null;
      if (!stored) continue;
      ordinal += 1; added += 1;
      await prisma.incidentEvidence.create({
        data: {
          incidentId: row.id, tenantId: row.tenantId, ordinal,
          location: ref.key || `${PH} photo`,
          description: `Imported from ${PH} inspection.`,
          evidenceStatus: status,
          storagePath: stored, contentType: ref.contentType || null,
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

  async updateEvidence(user, id, evidenceId, payload = {}) {
    const row = await findScoped(user, id);
    assertDraft(row);
    const data = {};
    if ('location' in payload) data.location = String(payload.location || '');
    if ('description' in payload) data.description = String(payload.description || '');
    if ('evidenceStatus' in payload) {
      data.evidenceStatus = String(payload.evidenceStatus || '').toUpperCase() === 'CONFIRMED' ? 'CONFIRMED' : 'VIOLATION';
    }
    const res = await prisma.incidentEvidence.updateMany({ where: { id: String(evidenceId), incidentId: row.id }, data });
    if (!res.count) throw err('Evidence not found', 404);
    return { ok: true };
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
            // Preserve the original capture time — chain of custody must not reset to now().
            sourcePhase: e.sourcePhase, takenAt: e.takenAt, takenByUserId: e.takenByUserId
          }))
        }
      },
      include: includeEvidence
    });
    return serialize(clone);
  },

  /** Post-issuance lifecycle transition: ISSUED → DISPUTED/RESOLVED/CLOSED/VOID (and onward). */
  async setStatus(user, id, status) {
    const row = await findScoped(user, id);
    const to = String(status || '').toUpperCase();
    const allowed = STATUS_FLOW[row.status] || [];
    if (!allowed.includes(to)) throw err(`Cannot move report from ${row.status} to ${to || '(none)'}`, 409);
    const updated = await prisma.reservationIncident.update({
      where: { id: row.id }, data: { status: to }, include: includeEvidence
    });
    return serialize(updated);
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
  // Evidence pulled from an externally-hosted inspection photo stores a full URL — pass through.
  if (/^https?:\/\//i.test(path)) return path;
  try { return await getSignedUrl({ bucket: getPhotosBucket(), path, expiresIn: 3600 }); } catch { return ''; }
}

async function assembleReport(row, reservation) {
  const ag = reservation?.rentalAgreement;
  const v = reservation?.vehicle;
  const cust = reservation?.customer;
  const renterName = ag?.customerFirstName
    ? [ag.customerFirstName, ag.customerLastName].filter(Boolean).join(' ')
    : [cust?.firstName, cust?.lastName].filter(Boolean).join(' ');

  // §6 charges: the per-report selection (chargeIdsJson) if set, else all
  // selected charges. Tax is recomputed per the picked lines — see
  // incident-report-charges.js (TL-ZE40809640BA fix, 2026-07-02).
  let pickedIds = null;
  try {
    const ids = row.chargeIdsJson ? JSON.parse(row.chargeIdsJson) : null;
    if (Array.isArray(ids) && ids.length) pickedIds = new Set(ids.map(String));
  } catch {}
  const chargeSection = computeChargeSection({
    rows: ag?.charges || [],
    pickedIds,
    depositApplied: row.depositApplied
  });

  // §8 photos: signed URLs for evidence with a photo
  const photos = [];
  for (const e of (row.evidence || [])) {
    if (e.storagePath) photos.push({ caption: `Fig. ${e.ordinal} — ${e.location}`, url: await signedUrlSafe(e.storagePath) });
  }

  let citedClauses = [];
  try { citedClauses = row.citedClausesJson ? JSON.parse(row.citedClausesJson) : []; } catch {}

  // Author-provided rebuttal wins (one point per line). Otherwise build neutral,
  // evidence-backed points — never auto-assert "delivered clean / no pre-existing damage"
  // on a dispute document regardless of the actual facts (legal accuracy).
  const photoCount = (row.evidence || []).filter((e) => e.storagePath).length;
  let rebuttalPoints;
  if (row.rebuttalText && String(row.rebuttalText).trim()) {
    rebuttalPoints = String(row.rebuttalText).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } else {
    rebuttalPoints = [
      'The signed rental agreement expressly authorizes the assessed fee upon documented evidence of the violation.',
      row.preRentalCondition
        ? `Pre-rental condition on record: ${row.preRentalCondition}`
        : `The pre-rental condition is documented in the check-out inspection on file${reservation?.pickupAt ? ` (${fmtDate(reservation.pickupAt)})` : ''}.`,
      `${photoCount} timestamped photograph${photoCount === 1 ? '' : 's'} document the evidence supporting this report.`,
      'The deposit was collected and applied per the signed agreement, which authorizes post-rental charges.'
    ];
  }

  // Renter damage acknowledgement (2026-07-25): read from the DAMAGE REPORT
  // at assemble time. The damage record is the durable anchor — the incident
  // link-back is best-effort — so the PDF finds the signature even when the
  // link landed after a partial failure. Lookup failure renders no block
  // (never blocks the print).
  const ackReport = await prisma.vehicleDamageReport.findFirst({
    where: { incidentId: row.id, customerAckSignatureDataUrl: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: {
      customerAckSignatureDataUrl: true,
      customerAckSignerName: true,
      customerAckSignedAt: true,
      customerAckStatementText: true
    }
  }).catch(() => null);

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
      chargeApplied: chargeSection.feeNames.length ? `${chargeSection.feeNames.join(', ')} — deposit applied toward total` : null
    },
    evidence: (row.evidence || []).map((e) => ({ ordinal: e.ordinal, location: e.location, description: e.description, status: e.evidenceStatus })),
    clauses: citedClauses,
    charges: chargeSection.lines.length
      ? { lines: chargeSection.lines, total: chargeSection.total, depositApplied: chargeSection.depositApplied, balanceDue: chargeSection.balanceDue }
      : { lines: [] },
    rebuttalPoints,
    photos,
    certification: { name: row.certifiedByName, title: row.certifiedByTitle, signatureDataUrl: row.signatureDataUrl, date: fmtDate(row.certifiedAt) },
    renterAcknowledgement: ackReport
      ? {
          name: ackReport.customerAckSignerName || renterName,
          signatureDataUrl: ackReport.customerAckSignatureDataUrl,
          statementText: ackReport.customerAckStatementText || '',
          date: fmtDate(ackReport.customerAckSignedAt)
        }
      : null
  };
}

export const __test = { makeReportNumber, reportingWindowHours, serialize, daysBetween, DEFAULT_CLAUSES, TYPE_META, computeChargeSection };
