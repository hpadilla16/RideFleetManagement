import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { uploadObject, safePath } from '../../lib/storage/supabase-storage.js';
import { decodePhotoValue, getPhotosBucket } from '../rental-agreements/inspection-photos.js';
// 2026-06-03 port retrofits: DOB sanitizer (TL 'age 1076' class) + the shared
// vehicle-status sync so loaner handoff/return can't drift Vehicle.status (bug #44 class).
import logger from '../../lib/logger.js';
import { normalizeDob } from '../../lib/dob.js';
import { syncVehicleStatusForReservation } from '../vehicles/vehicle-status-sync.js';

// =====================================================================
// Loaner Agreement service — the in-bay check-out / check-in wizard.
//
// Produces a signed, photo-backed loaner agreement against a
// DEALERSHIP_LOANER reservation (which stays the lifecycle anchor).
// Mirrors the RentalAgreement family: signature pattern, Supabase
// Storage photo refs, public-token remote signing.
//
// Plan: doc/loaner-reimagining-plan-2026-05-31.md
// =====================================================================

const SIGNATURE_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days (matches addendum flow)

// Public base URL for customer-facing links (same fallback chain as the
// customer-portal + addendum notification services).
function loanerPortalBaseUrl() {
  return (process.env.CUSTOMER_PORTAL_BASE_URL || process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

const PHOTO_KINDS = new Set([
  'WALKAROUND_OUT', 'WALKAROUND_IN', 'DAMAGE', 'FUEL_OUT', 'FUEL_IN',
  'ODOMETER_OUT', 'ODOMETER_IN', 'LICENSE', 'INSURANCE'
]);
const DAMAGE_SEVERITIES = new Set(['MINOR', 'MODERATE', 'SEVERE']);

function tenantScope(user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN') return {};
  return user?.tenantId ? { tenantId: user.tenantId } : { id: '__never__' };
}

function makeAgreementNumber() {
  return `LA-${Date.now().toString().slice(-8)}`;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Fuel stored as a 0.00-1.00 fraction (matches RentalAgreement.fuelOut/In).
function clampFuel(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function agreementInclude() {
  return {
    photos: { orderBy: { takenAt: 'asc' } },
    damagePoints: true,
    reservation: { select: { id: true, reservationNumber: true, workflowMode: true, repairOrderNumber: true } }
  };
}

function serialize(row) {
  if (!row) return null;
  const fuelOut = row.fuelOut == null ? null : Number(row.fuelOut);
  const fuelIn = row.fuelIn == null ? null : Number(row.fuelIn);
  const milesDriven = row.odometerOut != null && row.odometerIn != null ? row.odometerIn - row.odometerOut : null;
  const fuelDelta = fuelOut != null && fuelIn != null ? Number((fuelOut - fuelIn).toFixed(2)) : null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    agreementNumber: row.agreementNumber,
    status: row.status,
    reservationId: row.reservationId,
    reservation: row.reservation || null,
    vehicleId: row.vehicleId,
    pickupAt: row.pickupAt,
    returnAt: row.returnAt,
    customer: {
      firstName: row.customerFirstName,
      lastName: row.customerLastName,
      email: row.customerEmail,
      phone: row.customerPhone,
      dateOfBirth: row.dateOfBirth
    },
    license: {
      number: row.licenseNumber,
      state: row.licenseState,
      expiry: row.licenseExpiry,
      imagePath: row.licenseImagePath
    },
    insurance: {
      carrier: row.insuranceCarrier,
      policyNumber: row.insurancePolicyNumber,
      effective: row.insuranceEffective,
      expiry: row.insuranceExpiry,
      imagePath: row.insuranceImagePath
    },
    fuelOut, fuelIn,
    odometerOut: row.odometerOut,
    odometerIn: row.odometerIn,
    diff: { milesDriven, fuelDelta },
    signature: {
      signed: !!row.signedAt,
      signerName: row.signerName,
      signedAt: row.signedAt,
      termsVersion: row.termsVersion
    },
    remoteSigning: {
      pending: !!row.signatureToken,
      expiresAt: row.signatureTokenExpiresAt
    },
    portalToken: row.portalToken,
    requestedReturnAt: row.requestedReturnAt,
    returnScheduledAt: row.returnScheduledAt,
    portalRequestNote: row.portalRequestNote,
    notes: row.notes,
    finalizedAt: row.finalizedAt,
    closedAt: row.closedAt,
    locked: row.locked,
    photos: (row.photos || []).map((p) => ({
      id: p.id, kind: p.kind, angleLabel: p.angleLabel, storagePath: p.storagePath,
      contentType: p.contentType, sizeBytes: p.sizeBytes, annotation: p.annotation, takenAt: p.takenAt
    })),
    damagePoints: (row.damagePoints || []).map((d) => ({
      id: d.id, x: d.x, y: d.y, side: d.side, severity: d.severity,
      note: d.note, preExisting: d.preExisting, photoId: d.photoId
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function findScoped(user, id) {
  const row = await prisma.loanerAgreement.findFirst({
    where: { id: String(id), ...tenantScope(user) },
    include: agreementInclude()
  });
  if (!row) {
    const err = new Error('Loaner agreement not found');
    err.statusCode = 404;
    throw err;
  }
  return row;
}

function assertEditable(row) {
  if (row.locked || row.status === 'CLOSED' || row.status === 'VOID') {
    const err = new Error(`Loaner agreement is ${row.locked ? 'locked' : row.status.toLowerCase()} and cannot be edited`);
    err.statusCode = 409;
    throw err;
  }
}

export const loanerAgreementService = {
  /**
   * Create a loaner agreement against an existing DEALERSHIP_LOANER reservation.
   * Pulls pickup/return/vehicle from the reservation; the wizard supplies the
   * customer + license fields (typically from a DL PDF417 barcode decode).
   */
  async createForReservation(user, reservationId, payload = {}) {
    const reservation = await prisma.reservation.findFirst({
      where: { id: String(reservationId), ...tenantScope(user) },
      include: { customer: true, loanerAgreement: true }
    });
    if (!reservation) {
      const err = new Error('Reservation not found');
      err.statusCode = 404;
      throw err;
    }
    if (reservation.workflowMode !== 'DEALERSHIP_LOANER') {
      const err = new Error('Reservation is not a dealership loaner');
      err.statusCode = 400;
      throw err;
    }
    if (reservation.loanerAgreement) {
      const err = new Error('A loaner agreement already exists for this reservation');
      err.statusCode = 409;
      throw err;
    }

    const firstName = String(payload.customerFirstName || reservation.customer?.firstName || '').trim();
    const lastName = String(payload.customerLastName || reservation.customer?.lastName || '').trim();
    if (!firstName || !lastName) {
      const err = new Error('customerFirstName and customerLastName are required');
      err.statusCode = 400;
      throw err;
    }

    const created = await prisma.loanerAgreement.create({
      data: {
        tenantId: reservation.tenantId ?? user?.tenantId ?? null,
        agreementNumber: makeAgreementNumber(),
        status: 'DRAFT',
        portalToken: crypto.randomBytes(24).toString('base64url'),
        reservationId: reservation.id,
        vehicleId: payload.vehicleId ? String(payload.vehicleId) : reservation.vehicleId ?? null,
        pickupAt: parseDate(payload.pickupAt) ?? reservation.pickupAt,
        returnAt: parseDate(payload.returnAt) ?? reservation.returnAt,
        customerFirstName: firstName,
        customerLastName: lastName,
        customerEmail: payload.customerEmail ?? reservation.customer?.email ?? null,
        customerPhone: payload.customerPhone ?? reservation.customer?.phone ?? null,
        dateOfBirth: normalizeDob(payload.dateOfBirth),
        licenseNumber: payload.licenseNumber || null,
        licenseState: payload.licenseState || null,
        licenseExpiry: parseDate(payload.licenseExpiry),
        insuranceCarrier: payload.insuranceCarrier || null,
        insurancePolicyNumber: payload.insurancePolicyNumber || null,
        insuranceEffective: parseDate(payload.insuranceEffective),
        insuranceExpiry: parseDate(payload.insuranceExpiry),
        notes: payload.notes || null
      },
      include: agreementInclude()
    });
    return serialize(created);
  },

  async get(user, id) {
    return serialize(await findScoped(user, id));
  },

  async getByReservation(user, reservationId) {
    const row = await prisma.loanerAgreement.findFirst({
      where: { reservationId: String(reservationId), ...tenantScope(user) },
      include: agreementInclude()
    });
    return serialize(row);
  },

  /** Patch customer/license/insurance/fuel-out/odometer-out/notes (pre-signature). */
  async update(user, id, payload = {}) {
    const row = await findScoped(user, id);
    assertEditable(row);
    const data = {};
    const passStr = [
      'customerEmail', 'customerPhone', 'licenseNumber', 'licenseState', 'licenseImagePath',
      'insuranceCarrier', 'insurancePolicyNumber', 'insuranceImagePath', 'notes'
    ];
    for (const k of passStr) if (k in payload) data[k] = payload[k] || null;
    if ('customerFirstName' in payload) data.customerFirstName = String(payload.customerFirstName || '').trim() || row.customerFirstName;
    if ('customerLastName' in payload) data.customerLastName = String(payload.customerLastName || '').trim() || row.customerLastName;
    for (const k of ['dateOfBirth', 'licenseExpiry', 'insuranceEffective', 'insuranceExpiry']) {
      if (k in payload) data[k] = k === 'dateOfBirth' ? normalizeDob(payload[k]) : parseDate(payload[k]);
    }
    if ('fuelOut' in payload) data.fuelOut = clampFuel(payload.fuelOut);
    if ('odometerOut' in payload) data.odometerOut = toInt(payload.odometerOut);
    if ('vehicleId' in payload) data.vehicleId = payload.vehicleId ? String(payload.vehicleId) : null;
    if ('pickupAt' in payload) data.pickupAt = parseDate(payload.pickupAt) ?? row.pickupAt;
    if ('returnAt' in payload) data.returnAt = parseDate(payload.returnAt) ?? row.returnAt;

    const updated = await prisma.loanerAgreement.update({
      where: { id: row.id }, data, include: agreementInclude()
    });
    return serialize(updated);
  },

  /**
   * Upload one or more photos for a given kind to Supabase Storage and persist
   * LoanerPhoto rows. `photos` is an array of { dataUrl, angleLabel, annotation }.
   */
  async uploadPhotos(user, id, { kind, photos } = {}) {
    const row = await findScoped(user, id);
    assertEditable(row);
    const photoKind = String(kind || '').toUpperCase();
    if (!PHOTO_KINDS.has(photoKind)) {
      const err = new Error(`Invalid photo kind: ${kind}`);
      err.statusCode = 400;
      throw err;
    }
    const list = Array.isArray(photos) ? photos : [photos];
    const tenantId = row.tenantId || user?.tenantId || 'no-tenant';
    const bucket = getPhotosBucket();
    const created = [];
    for (const item of list) {
      const dataUrl = typeof item === 'string' ? item : item?.dataUrl;
      const decoded = decodePhotoValue(dataUrl); // throws StorageError(413) if oversize
      if (!decoded) continue;
      const objectId = `${photoKind}_${crypto.randomUUID()}`;
      const path = safePath('tenants', tenantId, 'loaner-agreements', row.id, `${objectId}.${decoded.ext}`);
      await uploadObject({ bucket, path, body: decoded.buffer, contentType: decoded.contentType, upsert: false });
      const rec = await prisma.loanerPhoto.create({
        data: {
          loanerAgreementId: row.id,
          tenantId: row.tenantId,
          kind: photoKind,
          angleLabel: (typeof item === 'object' && item?.angleLabel) || null,
          storagePath: path,
          contentType: decoded.contentType,
          sizeBytes: decoded.buffer.byteLength,
          annotation: (typeof item === 'object' && item?.annotation) || null,
          takenByUserId: user?.id || null
        }
      });
      created.push(rec);
    }
    return { uploaded: created.length, photos: created.map((p) => ({ id: p.id, kind: p.kind, angleLabel: p.angleLabel, storagePath: p.storagePath })) };
  },

  /** Add a damage pin on the car-diagram (normalized x/y in 0.0-1.0). */
  async addDamagePoint(user, id, payload = {}) {
    const row = await findScoped(user, id);
    assertEditable(row);
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const err = new Error('x and y are required (0.0-1.0)');
      err.statusCode = 400;
      throw err;
    }
    const severity = String(payload.severity || 'MINOR').toUpperCase();
    const created = await prisma.loanerDamagePoint.create({
      data: {
        loanerAgreementId: row.id,
        tenantId: row.tenantId,
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
        side: payload.side ? String(payload.side).toUpperCase() : null,
        severity: DAMAGE_SEVERITIES.has(severity) ? severity : 'MINOR',
        note: payload.note || null,
        preExisting: payload.preExisting === undefined ? true : !!payload.preExisting,
        photoId: payload.photoId ? String(payload.photoId) : null,
        createdByUserId: user?.id || null
      }
    });
    return { id: created.id };
  },

  /**
   * Capture the customer signature in-person and activate the agreement
   * (keys out). Requires the fuel + odometer baseline to be recorded first.
   */
  async sign(user, id, payload = {}) {
    const row = await findScoped(user, id);
    assertEditable(row);
    const signatureDataUrl = String(payload.signatureDataUrl || '');
    const signerName = String(payload.signerName || '').trim();
    if (!signatureDataUrl.startsWith('data:image')) {
      const err = new Error('signatureDataUrl (data:image/...) is required');
      err.statusCode = 400;
      throw err;
    }
    if (!signerName) {
      const err = new Error('signerName is required');
      err.statusCode = 400;
      throw err;
    }
    if (row.fuelOut == null || row.odometerOut == null) {
      const err = new Error('Record fuel and odometer out before signing');
      err.statusCode = 400;
      throw err;
    }
    const now = new Date();
    const updated = await prisma.loanerAgreement.update({
      where: { id: row.id },
      data: {
        status: 'ACTIVE',
        signatureDataUrl,
        signerName,
        signedAt: now,
        signerIp: String(payload.ip || '-').trim(),
        termsVersion: payload.termsVersion || row.termsVersion || null,
        finalizedAt: now,
        signatureToken: null,
        signatureTokenExpiresAt: null
      },
      include: agreementInclude()
    });
    // 2026-06-03 port retrofit — signing IS the handoff: the borrower drives
    // off. Advance the reservation to CHECKED_OUT and sync Vehicle.status so
    // availability/forecast/dashboards see the loaner as out (bug #44 class).
    try {
      const resv = await prisma.reservation.findUnique({
        where: { id: row.reservationId },
        select: { id: true, status: true, vehicleId: true },
      });
      if (resv && !['CHECKED_OUT', 'CHECKED_IN', 'CHECKED_IN_UNPAID'].includes(String(resv.status))) {
        await prisma.reservation.update({ where: { id: resv.id }, data: { status: 'CHECKED_OUT' } });
        await syncVehicleStatusForReservation(prisma, {
          reservationId: resv.id,
          vehicleId: updated.vehicleId || resv.vehicleId,
          toStatus: 'CHECKED_OUT',
        });
      }
    } catch (err) {
      logger.warn('[loaner-agreement] reservation/vehicle sync after sign failed', {
        loanerAgreementId: row.id, err: String(err?.message || err),
      });
    }
    return serialize(updated);
  },

  /**
   * Issue a remote-signing token and best-effort text the signing link to the
   * borrower. Returns the token + link; SMS failures never block issuance
   * (the link is still returned for manual share).
   */
  async issueSignatureToken(user, id) {
    const row = await findScoped(user, id);
    assertEditable(row);
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + SIGNATURE_TOKEN_TTL_MS);
    await prisma.loanerAgreement.update({
      where: { id: row.id },
      data: { signatureToken: token, signatureTokenExpiresAt: expiresAt }
    });
    const link = `${loanerPortalBaseUrl()}/customer/sign-loaner?token=${encodeURIComponent(token)}`;

    let smsSent = false;
    let smsTo = null;
    const phone = row.customerPhone;
    if (phone && row.tenantId) {
      try {
        const { smsService } = await import('../sms/sms.service.js');
        await smsService.sendCustom({
          to: phone,
          body: `Please review and sign your loaner agreement: ${link}`,
          tenantId: row.tenantId
        });
        smsSent = true;
        smsTo = `***${String(phone).slice(-4)}`;
      } catch {
        // SMS off / no credentials / bad number — fall back to manual share.
      }
    }
    return { token, expiresAt, link, smsSent, smsTo };
  },

  /** Public (no-auth) read for the remote signing page. Token IS the auth. */
  async getByToken(token) {
    const clean = String(token || '').trim();
    if (!clean) {
      const err = new Error('Signing token is required');
      err.statusCode = 404;
      throw err;
    }
    const row = await prisma.loanerAgreement.findFirst({
      where: { signatureToken: clean },
      include: agreementInclude()
    });
    if (!row || (row.signatureTokenExpiresAt && row.signatureTokenExpiresAt < new Date())) {
      const err = new Error('Signing link is invalid or expired');
      err.statusCode = 404;
      throw err;
    }
    const dto = serialize(row);
    // Public view: omit internal notes.
    delete dto.notes;
    return dto;
  },

  /** Public (no-auth) signature submission. Atomic compare-and-set on the token. */
  async submitSignatureByToken(token, payload = {}, { ip } = {}) {
    const clean = String(token || '').trim();
    const signatureDataUrl = String(payload.signatureDataUrl || '');
    const signerName = String(payload.signerName || '').trim();
    if (!signatureDataUrl.startsWith('data:image')) {
      const err = new Error('signatureDataUrl (data:image/...) is required');
      err.statusCode = 400;
      throw err;
    }
    if (!signerName) {
      const err = new Error('signerName is required');
      err.statusCode = 400;
      throw err;
    }
    const now = new Date();
    const result = await prisma.loanerAgreement.updateMany({
      where: {
        signatureToken: clean,
        status: 'DRAFT',
        OR: [{ signatureTokenExpiresAt: null }, { signatureTokenExpiresAt: { gt: now } }]
      },
      data: {
        status: 'ACTIVE',
        signatureDataUrl,
        signerName,
        signedAt: now,
        signerIp: String(ip || '-').trim(),
        finalizedAt: now,
        signatureToken: null,
        signatureTokenExpiresAt: null
      }
    });
    if (result.count === 0) {
      const err = new Error('Signing link is invalid, expired, or already signed');
      err.statusCode = 409;
      throw err;
    }
    return { ok: true, message: 'Signature captured. Thank you.' };
  },

  /**
   * Check the loaner back in: record fuel/odometer in, upload return photos,
   * flag exceptions, compute the out/in diff, set status RETURNED.
   */
  async checkIn(user, id, payload = {}) {
    const row = await findScoped(user, id);
    if (row.status === 'CLOSED' || row.status === 'VOID') {
      const err = new Error(`Loaner agreement is ${row.status.toLowerCase()}`);
      err.statusCode = 409;
      throw err;
    }
    const data = {
      status: 'RETURNED',
      fuelIn: 'fuelIn' in payload ? clampFuel(payload.fuelIn) : row.fuelIn,
      odometerIn: 'odometerIn' in payload ? toInt(payload.odometerIn) : row.odometerIn
    };
    if (payload.notes) data.notes = [row.notes, `[check-in] ${payload.notes}`].filter(Boolean).join('\n');
    const updated = await prisma.loanerAgreement.update({
      where: { id: row.id }, data, include: agreementInclude()
    });
    // 2026-06-03 port retrofit — vehicle is physically back: advance the
    // reservation to CHECKED_IN and sync Vehicle.status (frees availability).
    try {
      const resv = await prisma.reservation.findUnique({
        where: { id: row.reservationId },
        select: { id: true, status: true, vehicleId: true },
      });
      if (resv && !['CHECKED_IN', 'CHECKED_IN_UNPAID'].includes(String(resv.status))) {
        await prisma.reservation.update({ where: { id: resv.id }, data: { status: 'CHECKED_IN' } });
        await syncVehicleStatusForReservation(prisma, {
          reservationId: resv.id,
          vehicleId: updated.vehicleId || resv.vehicleId,
          toStatus: 'CHECKED_IN',
        });
      }
    } catch (err) {
      logger.warn('[loaner-agreement] reservation/vehicle sync after check-in failed', {
        loanerAgreementId: row.id, err: String(err?.message || err),
      });
    }
    return serialize(updated);
  },

  /** Close out the agreement (billing settled). Locks it. */
  async close(user, id, payload = {}) {
    const row = await findScoped(user, id);
    if (row.status === 'VOID') {
      const err = new Error('Loaner agreement is void');
      err.statusCode = 409;
      throw err;
    }
    const updated = await prisma.loanerAgreement.update({
      where: { id: row.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedByUserId: user?.id || null,
        locked: true,
        notes: payload.notes ? [row.notes, `[closeout] ${payload.notes}`].filter(Boolean).join('\n') : row.notes
      },
      include: agreementInclude()
    });
    return serialize(updated);
  },

  // ------------------- Customer self-service portal -------------------

  /** Public (no-auth) status read by the long-lived portal token. */
  async getByPortalToken(token) {
    const clean = String(token || '').trim();
    if (!clean) {
      const err = new Error('Portal link is required');
      err.statusCode = 404;
      throw err;
    }
    const row = await prisma.loanerAgreement.findFirst({
      where: { portalToken: clean },
      include: {
        vehicle: { select: { year: true, make: true, model: true, plate: true } },
        reservation: {
          select: {
            reservationNumber: true, status: true, repairOrderNumber: true,
            serviceAdvisorName: true, estimatedServiceCompletionAt: true, loanerServiceCompletedAt: true
          }
        }
      }
    });
    if (!row || row.status === 'VOID') {
      const err = new Error('Portal link is invalid or no longer active');
      err.statusCode = 404;
      throw err;
    }
    if (row.portalTokenExpiresAt && row.portalTokenExpiresAt < new Date()) {
      const err = new Error('Portal link has expired');
      err.statusCode = 404;
      throw err;
    }
    const v = row.vehicle;
    return {
      agreementNumber: row.agreementNumber,
      status: row.status,
      pickupAt: row.pickupAt,
      returnAt: row.returnAt,
      customer: { firstName: row.customerFirstName, lastName: row.customerLastName },
      vehicle: v ? { label: [v.year, v.make, v.model].filter(Boolean).join(' '), plate: v.plate } : null,
      service: {
        repairOrderNumber: row.reservation?.repairOrderNumber || null,
        advisorName: row.reservation?.serviceAdvisorName || null,
        estimatedCompletionAt: row.reservation?.estimatedServiceCompletionAt || null,
        completedAt: row.reservation?.loanerServiceCompletedAt || null,
        reservationStatus: row.reservation?.status || null
      },
      requestedReturnAt: row.requestedReturnAt,
      returnScheduledAt: row.returnScheduledAt
    };
  },

  async _findPortalRowOrThrow(clean) {
    const row = await prisma.loanerAgreement.findFirst({ where: { portalToken: clean }, include: { reservation: { select: { status: true } } } });
    if (!row || row.status === 'VOID' || row.status === 'CLOSED') {
      const err = new Error('Portal link is invalid or no longer active');
      err.statusCode = 404;
      throw err;
    }
    // Reject portal actions once the loaner reservation is terminal (returned/cancelled) so a stale
    // tab can't submit an extension/return after the fact.
    if (['CHECKED_IN', 'CHECKED_IN_UNPAID', 'CANCELLED', 'NO_SHOW'].includes(String(row.reservation?.status || '').toUpperCase())) {
      const err = new Error('This loaner is no longer active');
      err.statusCode = 404;
      throw err;
    }
    if (row.portalTokenExpiresAt && row.portalTokenExpiresAt < new Date()) {
      const err = new Error('Portal link has expired');
      err.statusCode = 404;
      throw err;
    }
    return row;
  },

  /** Best-effort fan-out when a borrower submits a portal request (no throw). */
  async _notifyPortalRequest(row, kind, whenISO, note) {
    try {
      const { parseLocationConfig } = await import('../../lib/location-config.js');
      const { sendEmail } = await import('../../lib/mailer.js');
      const resv = await prisma.reservation.findUnique({
        where: { id: row.reservationId },
        select: {
          reservationNumber: true, repairOrderNumber: true, serviceAdvisorName: true, serviceAdvisorEmail: true,
          pickupLocation: { select: { name: true, locationConfig: true } }
        }
      });
      const label = kind === 'EXTENSION' ? 'extension' : 'return';
      const who = [row.customerFirstName, row.customerLastName].filter(Boolean).join(' ') || 'A loaner customer';
      const when = whenISO ? new Date(whenISO).toLocaleString('en-US', { timeZone: 'America/Puerto_Rico' }) : '';
      const ro = resv?.repairOrderNumber ? ` (RO ${resv.repairOrderNumber})` : '';
      const locEmail = parseLocationConfig(resv?.pickupLocation?.locationConfig)?.locationEmail || '';
      const body = `Loaner ${label} request${ro}: ${who} requested ${when || '(no date provided)'}.`
        + (note ? ` Note: ${note}` : '') + (resv?.reservationNumber ? ` [${resv.reservationNumber}]` : '');
      // Tenant notification -> the LOCATION email (primary); advisor email as an additional recipient. Email only (no SMS).
      const recipients = [...new Set([locEmail, resv?.serviceAdvisorEmail].filter(Boolean))];
      for (const to of recipients) {
        try { await sendEmail({ to, subject: `Loaner ${label} request${ro}`, text: body }); } catch {}
      }
      // Customer confirmation by email (texting not enabled yet).
      if (row.customerEmail) {
        try { await sendEmail({ to: row.customerEmail, subject: `Your loaner ${label} request`, text: `We received your loaner ${label} request${when ? ' for ' + when : ''}. Our team will confirm shortly.` }); } catch {}
      }
    } catch (e) {
      try { logger.warn('[loaner] portal request notify failed: ' + (e?.message || e)); } catch {}
    }
  },

  /** Public: borrower requests an extension (staff approves later). */
  async requestExtensionByToken(token, payload = {}) {
    const row = await this._findPortalRowOrThrow(String(token || '').trim());
    const requested = parseDate(payload.requestedReturnAt);
    if (!requested) {
      const err = new Error('A valid requested return date is required');
      err.statusCode = 400;
      throw err;
    }
    const note = payload.note ? String(payload.note).slice(0, 500) : row.portalRequestNote;
    await prisma.loanerAgreement.update({
      where: { id: row.id },
      data: { requestedReturnAt: requested, portalRequestNote: note,
        portalRequestAt: new Date(), portalRequestKind: 'EXTENSION', portalRequestHandledAt: null }
    });
    this._notifyPortalRequest(row, 'EXTENSION', requested, note).catch(() => {}); // fire-and-forget
    return { ok: true, message: 'Extension requested. The service team will confirm by email.' };
  },

  /** Public: borrower schedules a return time. */
  async scheduleReturnByToken(token, payload = {}) {
    const row = await this._findPortalRowOrThrow(String(token || '').trim());
    const scheduled = parseDate(payload.returnScheduledAt);
    if (!scheduled) {
      const err = new Error('A valid return time is required');
      err.statusCode = 400;
      throw err;
    }
    const note2 = payload.note ? String(payload.note).slice(0, 500) : row.portalRequestNote;
    await prisma.loanerAgreement.update({
      where: { id: row.id },
      data: { returnScheduledAt: scheduled, portalRequestNote: note2,
        portalRequestAt: new Date(), portalRequestKind: 'RETURN', portalRequestHandledAt: null }
    });
    this._notifyPortalRequest(row, 'RETURN', scheduled, note2).catch(() => {}); // fire-and-forget
    return { ok: true, message: 'Return scheduled. See you then!' };
  }
};

// Pure helpers exposed for unit tests (no Prisma / DB dependency).
export const __test = { serialize, parseDate, clampFuel, toInt, makeAgreementNumber };
