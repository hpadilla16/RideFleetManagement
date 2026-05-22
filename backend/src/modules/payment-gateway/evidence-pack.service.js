/**
 * Evidence pack builder — chargeback dispute bundle (2026-05-21).
 *
 * Given a Reservation OR a single DejavooTransaction, return a structured
 * JSON payload that contains EVERYTHING a merchant would hand to their
 * acquiring bank when fighting a chargeback:
 *
 *   - Reservation (driver name, dates, amount)
 *   - RentalAgreement (agreement number, terms version)
 *   - Signed agreement PDF (signed URL)
 *   - Per-field initials + signatures (signed URLs)
 *   - Inspection PRE+POST media (signed URLs from Pillar 2)
 *   - Inspection findings (damage assessments)
 *   - Level 3 RentalData that was sent at AUTH/SALE time
 *   - Card data (last4, brand, entry type, auth codes)
 *   - All related DejavooTransaction rows (AUTH/CAPTURE/SALE/VOID with timestamps)
 *   - Merchant + terminal identification
 *
 * The result is a single JSON document the agent (or counsel) downloads
 * via the route handler. Stored URLs are signed with a 24h TTL so they
 * can be shared via email without exposing the Storage bucket directly.
 *
 * Design doc: doc/interactive-tc-and-dejavoo-unified-2026-05-21.md §9
 */

import { signSignatureUrl, signSignatureUrls } from '../terms/signing-storage.js';
// Lazy load — inspections module ships in Pillar 2 (rounds 12-12c).
// Until those land, evidence-pack falls back to returning an empty array
// for inspection media (route still works, just no inspection photos in
// the chargeback bundle).
let _signInspectionMediaRows = null;
async function signInspectionMediaRows(...args) {
  if (!_signInspectionMediaRows) {
    try {
      const m = await import('../inspections/inspection-media-storage.js');
      _signInspectionMediaRows = m.signInspectionMediaRows;
    } catch {
      _signInspectionMediaRows = () => [];
    }
  }
  return _signInspectionMediaRows(...args);
}

// Lazy prisma
let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

const EVIDENCE_URL_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export class EvidencePackError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'EvidencePackError';
    this.status = status;
  }
}

/**
 * Build an evidence pack for a single reservation.
 *
 * @param {object} args
 * @param {string} args.reservationId
 * @param {object} args.tenantScope    — { tenantId } or { allowCrossTenant: true }
 * @param {object} [args.prisma]
 * @param {object} [args.signers]      — DI seam for storage signing
 * @returns {Promise<object>}
 */
export async function buildEvidencePackForReservation({
  reservationId, tenantScope, prisma, signers,
} = {}) {
  if (!reservationId) throw new EvidencePackError('reservationId required', 400);
  if (!tenantScope) throw new EvidencePackError('tenantScope required', 403);

  prisma = prisma || (await resolveDefaultPrisma());
  const tenantWhere =
    tenantScope.allowCrossTenant && !tenantScope.tenantId
      ? {}
      : tenantScope.tenantId
        ? { tenantId: tenantScope.tenantId }
        : null;
  if (!tenantWhere) throw new EvidencePackError('tenantId required in scope', 403);

  // Single mega-query loading everything we'll need
  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, ...tenantWhere },
    include: {
      tenant: { select: { id: true, name: true } },
      pickupLocation: { select: { id: true, code: true, name: true } },
      returnLocation: { select: { id: true, code: true, name: true } },
      vehicle: {
        select: {
          id: true, plate: true, year: true, make: true, model: true,
          vehicleType: { select: { code: true, name: true } },
        },
      },
      customer: {
        select: {
          id: true, firstName: true, lastName: true, email: true, phone: true,
          licenseNumber: true,
        },
      },
      charges: {
        where: { selected: true },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true, code: true, name: true, chargeType: true,
          quantity: true, rate: true, total: true, taxable: true,
          source: true, sourceRefId: true,
        },
      },
      rentalAgreement: {
        select: {
          id: true, agreementNumber: true, dailyRate: true, totalDays: true,
          status: true, signedAt: true, closedAt: true,
        },
      },
      signing: {
        include: {
          template: {
            select: { id: true, name: true, version: true, contentLanguage: true },
          },
          fields: {
            include: {
              templateField: {
                select: { kind: true, label: true, markerKey: true, order: true },
              },
            },
            orderBy: { signedAt: 'asc' },
          },
        },
      },
      dejavooTransactions: {
        orderBy: { startedAt: 'asc' },
        select: {
          id: true, type: true, referenceId: true, amountCents: true,
          invoiceNumber: true, customLabel: true,
          approved: true, statusCode: true, authCode: true,
          cardLast4: true, cardBrand: true, cardEntryType: true,
          iposToken: true, errorMessage: true,
          signatureStoragePath: true, parentTransactionId: true,
          startedAt: true, completedAt: true, callbackReceivedAt: true,
          terminal: { select: { id: true, name: true, tpn: true, merchantNumber: true } },
        },
      },
      inspections: {
        orderBy: { stage: 'asc' },
        include: {
          media: {
            select: {
              id: true, kind: true, position: true,
              storagePath: true, contentType: true, sizeBytes: true,
              capturedAt: true,
            },
          },
          findings: {
            where: { status: { in: ['ACCEPTED', 'DISPUTED'] } },
            select: {
              id: true, position: true, severity: true, description: true,
              suggestedChargeCents: true, status: true, aiConfidence: true,
              addendumChargeId: true, customerDisputedAt: true, customerComment: true,
              acceptedAt: true, rejectedAt: true,
            },
          },
        },
      },
    },
  });

  if (!reservation) {
    throw new EvidencePackError(`Reservation ${reservationId} not found`, 404);
  }

  // Sign all the URLs in parallel
  const sigSign = signers?.signSignatureUrl || signSignatureUrl;
  const sigSignRows = signers?.signSignatureUrls || signSignatureUrls;
  const inspectionSignRows = signers?.signInspectionMediaRows || signInspectionMediaRows;

  // Signed agreement PDF
  let signedPdfUrl = null;
  if (reservation.signing?.signedPdfStoragePath) {
    try {
      signedPdfUrl = await sigSign(reservation.signing.signedPdfStoragePath, {
        expiresIn: EVIDENCE_URL_TTL_SECONDS,
      });
    } catch { signedPdfUrl = null; }
  }

  // Per-field signatures (sign in parallel)
  const signedFieldRows = await sigSignRows(
    reservation.signing?.fields || [],
    { expiresIn: EVIDENCE_URL_TTL_SECONDS }
  );

  // Receipt/transaction signatures (each DejavooTransaction may have one)
  const txWithSigUrls = [];
  for (const tx of reservation.dejavooTransactions || []) {
    let receiptUrl = null;
    if (tx.signatureStoragePath) {
      try {
        receiptUrl = await sigSign(tx.signatureStoragePath, {
          expiresIn: EVIDENCE_URL_TTL_SECONDS,
        });
      } catch { receiptUrl = null; }
    }
    txWithSigUrls.push({ ...tx, signatureUrl: receiptUrl });
  }

  // Inspection media (each stage with signed URLs)
  const inspectionsWithUrls = [];
  for (const insp of reservation.inspections || []) {
    const mediaSigned = await inspectionSignRows(insp.media || [], {
      expiresIn: EVIDENCE_URL_TTL_SECONDS,
    });
    inspectionsWithUrls.push({
      id: insp.id,
      stage: insp.stage,
      capturedAt: insp.capturedAt,
      capturedByType: insp.capturedByType,
      signedByName: insp.signedByName,
      signedAt: insp.signedAt,
      media: mediaSigned,
      findings: insp.findings || [],
    });
  }

  // The pre-AUTH transaction = the original card auth
  const authTx = (reservation.dejavooTransactions || []).find((t) => t.type === 'AUTH' && t.approved);

  return {
    generatedAt: new Date().toISOString(),
    evidenceUrlTtlSeconds: EVIDENCE_URL_TTL_SECONDS,
    reservation: {
      id: reservation.id,
      status: reservation.status,
      pickupAt: reservation.pickupAt,
      returnAt: reservation.returnAt,
      signingCompletedAt: reservation.signingCompletedAt,
      estimatedTotal: reservation.estimatedTotal,
      pickupLocation: reservation.pickupLocation,
      returnLocation: reservation.returnLocation,
      vehicle: reservation.vehicle,
    },
    customer: reservation.customer,
    tenant: reservation.tenant,
    agreement: reservation.rentalAgreement,
    cardData: authTx
      ? {
          last4: authTx.cardLast4,
          brand: authTx.cardBrand,
          entryType: authTx.cardEntryType,
          token: authTx.iposToken,
        }
      : null,
    authCodes: (reservation.dejavooTransactions || [])
      .filter((t) => t.approved && t.authCode)
      .map((t) => ({ type: t.type, authCode: t.authCode, referenceId: t.referenceId, at: t.completedAt })),
    charges: (reservation.charges || []).map((c) => ({
      ...c,
      // Decimal-as-string passthrough for the wire
    })),
    signing: reservation.signing
      ? {
          id: reservation.signing.id,
          surfaceUsed: reservation.signing.surfaceUsed,
          startedAt: reservation.signing.startedAt,
          completedAt: reservation.signing.completedAt,
          customerName: reservation.signing.customerName,
          customerLicense: reservation.signing.customerLicense,
          ipAddress: reservation.signing.ipAddress,
          userAgent: reservation.signing.userAgent,
          template: reservation.signing.template,
          signedPdfUrl,
          fields: signedFieldRows.map((f) => ({
            id: f.id,
            kind: f.templateField?.kind,
            label: f.templateField?.label,
            markerKey: f.templateField?.markerKey,
            order: f.templateField?.order,
            value: f.value,
            signedAt: f.signedAt,
            signedUrl: f.signedUrl, // null if not a signature kind
          })),
        }
      : null,
    transactions: txWithSigUrls,
    inspections: inspectionsWithUrls,
    merchant: authTx?.terminal
      ? {
          terminalName: authTx.terminal.name,
          tpn: authTx.terminal.tpn,
          merchantNumber: authTx.terminal.merchantNumber,
        }
      : null,
  };
}
