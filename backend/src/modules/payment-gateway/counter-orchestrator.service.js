/**
 * Counter checkin orchestrator — Sale-driven Dejavoo P1 flow.
 * (2026-05-21 original; 2026-05-22 round 25 Sale-driven refactor)
 *
 * `runCounterCheckinFlow` is the entry point invoked by the route handler
 * `POST /api/payment-gateway/counter/start-checkin`. It runs the customer
 * through the signing + payment flow in TWO terminal interactions:
 *
 *   1. SALE for the rental fee (autoRentalSale) — this single call:
 *        - Auto-displays the disclaimer page (configured on the terminal
 *          profile via the iPOSpays merchant portal, not pushed per-call)
 *        - Prompts the customer to insert / tap / swipe
 *        - Captures the signature on screen (CaptureSignature: true)
 *        - Returns IPosToken (saved card-on-file) + SignatureData (base64 PNG)
 *      The signature PNG counts as acceptance of the entire T&C. We persist
 *      one ReservationSigningField row per required TermsTemplateField, all
 *      pointing to the same signature blob (the customer accepted them all
 *      by signing once).
 *
 *   2. AUTH hold for the security deposit (authWithToken using the saved
 *      IPosToken — no second swipe required).
 *
 * Round 25 (2026-05-22) refactor notes:
 *   - The 5 standalone interactive endpoints (Disclaimer, GetSignature,
 *     UserChoice, UserInput, Cart) all returned 404 against api.spinpos.net.
 *   - SPIn handles the interactive flow INSIDE the Sale request itself, not
 *     as separate `v2/Payment/<Method>` calls.
 *   - The per-field iteration loop (INITIAL / SIGNATURE / CHECKBOX /
 *     TEXT_FIELD / DATE) was removed. The TermsTemplate schema stays for the
 *     future tablet-based signing surface that DOES walk field-by-field.
 *
 * Feature flag gates: `interactiveTC` AND `dejavooCounter` must both be ON.
 *
 * Crash-safety: each network call writes a DejavooTransaction BEFORE the
 * request (status PENDING) and updates with response/error. If the process
 * dies mid-flow, ReservationSigning stays in started-but-not-completed
 * state; the next call to `runCounterCheckinFlow` resumes from the SALE.
 *
 * Design doc: doc/round-25-plan-2026-05-22.md
 * Predecessor: doc/interactive-tc-and-dejavoo-unified-2026-05-21.md §5
 */

import { isFeatureOnForUser } from '../../lib/feature-flags.js';
import { getActiveTemplateForTenant } from '../terms/terms-templates.service.js';
import {
  spinClient,
  buildLevel3FromReservation,
} from './spin-client.js';
import { uploadSignatureBlob } from '../terms/signing-storage.js';

// Lazy prisma + lazy logger — same pattern as the rest of the codebase.
let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

let _logger = null;
async function getLogger() {
  if (_logger) return _logger;
  try {
    const mod = await import('../../lib/logger.js');
    _logger = mod.default || mod;
  } catch {
    _logger = { info: () => {}, warn: () => {}, error: () => {} };
  }
  return _logger;
}

export class CounterOrchestratorError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = 'CounterOrchestratorError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Security-deposit charge detection (Round 26 followup #10, 2026-05-24)
//
// The booking-engine writes a Security Deposit row into ReservationCharge so
// it appears as a line item in the wizard UI. That row should NEVER be
// included in the rental-fee SALE — the deposit is handled by a separate AUTH
// hold via `tenant.settings.dejavoo.preAuthAmountCents`. Including it in the
// SALE would CAPTURE the deposit (i.e. charge it for real) on top of the AUTH
// hold = customer pays the deposit twice.
//
// We check three signals because legacy reservations have `code = null` and
// `source = null` — they were created before those columns started being
// populated by the booking engine. Newer reservations have `code` +/- `source`
// set. Name match is the final fallback for fully-manual rows.
// ---------------------------------------------------------------------------
const DEPOSIT_CODES = new Set(['SECURITY_DEPOSIT', 'DEPOSIT', 'DEPOSIT_DUE']);
const DEPOSIT_SOURCES = new Set(['SECURITY_DEPOSIT', 'DEPOSIT']);

export function isDepositCharge(c) {
  if (!c) return false;
  const code = typeof c.code === 'string' ? c.code.trim().toUpperCase() : '';
  if (code && DEPOSIT_CODES.has(code)) return true;
  const source = typeof c.source === 'string' ? c.source.trim().toUpperCase() : '';
  if (source && DEPOSIT_SOURCES.has(source)) return true;
  const name = typeof c.name === 'string' ? c.name.trim().toLowerCase() : '';
  if (name && (name === 'security deposit' || name === 'deposit' || name.startsWith('security deposit'))) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRefId(prefix, reservationId) {
  const tail = String(reservationId || '').slice(-8) || 'noresv';
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${tail}-${ts}${rnd}`.slice(0, 50);
}

/**
 * Persist a DejavooTransaction row BEFORE making the network call. We
 * write it as `approved=false, statusCode=PENDING` and update once we
 * get the response. Crash mid-call leaves an audit trail.
 */
async function recordPendingTx(prisma, base) {
  return prisma.dejavooTransaction.create({
    data: {
      ...base,
      approved: false,
      requestJson: base.requestJson || {},
      statusCode: 'PENDING',
      startedAt: new Date(),
    },
  });
}

/**
 * Update a DejavooTransaction with a real spinClient response.
 */
async function recordTxResult(prisma, txId, normalized, rawResponse) {
  return prisma.dejavooTransaction.update({
    where: { id: txId },
    data: {
      responseJson: normalized,
      rawResponse: rawResponse || null,
      statusCode: normalized?.statusCode || null,
      approved: !!normalized?.approved,
      authCode: normalized?.authCode || null,
      iposToken: normalized?.iposToken || null,
      cardLast4: normalized?.cardData?.last4 || null,
      cardBrand: normalized?.cardData?.cardType || null,
      cardEntryType: normalized?.cardData?.entryType || null,
      errorMessage: normalized?.approved ? null : (normalized?.detailedMessage || normalized?.message || null),
      completedAt: new Date(),
    },
  });
}

/**
 * Mark a DejavooTransaction failed (orchestrator caught an exception).
 */
async function recordTxError(prisma, txId, err) {
  return prisma.dejavooTransaction.update({
    where: { id: txId },
    data: {
      // Round 25 fix (2026-05-22): DejavooTransaction.statusCode is String?
      // but spinStatusCode comes back as Int from SPIn. Wrap so Prisma doesn't
      // reject the write. Without this, when the SPIn flow fails the audit row
      // never gets persisted → we lose the trail of WHY it failed.
      statusCode: String(err?.spinStatusCode || 'ERROR'),
      errorMessage: err?.message || 'unknown error',
      // Round 25 hotfix (2026-05-22): also persist the raw SPIn response when
      // available. Without this, when SPIn returned StatusCode 2201 we had no
      // way to see the AutoRentalValidationError fields that pinpoint the
      // mismatch. spin-client throws err with err.spinResponse = data.
      rawResponse: err?.spinResponse || null,
      completedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Removed in round 25 (2026-05-22): per-field interactive handlers.
//
//   - captureInitialOrSignature() — invoked spin.disclaimer() + spin.getSignature()
//   - captureChoice()             — invoked spin.userChoice()
//   - captureText()               — invoked spin.userInput() (+ ISO date validation)
//
// All five SPIn endpoints (Disclaimer / GetSignature / UserChoice / UserInput
// / Cart) returned 404 against api.spinpos.net — they aren't exposed as
// standalone `v2/Payment/*` endpoints. The Sale-driven flow now captures the
// customer's signature once via `autoRentalSale({ CaptureSignature: true })`
// and treats that signature as acceptance of the entire T&C. The TermsTemplate
// + ReservationSigningField schema stays for the future tablet-based signing
// surface that does walk field-by-field.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pre-auth resolver
// ---------------------------------------------------------------------------

function resolvePreAuthAmountCents(tenant, reservation) {
  // Tenant settings: { dejavoo: { preAuthAmountCents: 25000 } }
  let settings = {};
  try {
    settings = typeof tenant.settingsJson === 'string'
      ? JSON.parse(tenant.settingsJson)
      : (tenant.settingsJson || {});
  } catch {
    settings = {};
  }
  const direct = settings?.dejavoo?.preAuthAmountCents;
  if (typeof direct === 'number' && direct > 0) return direct;
  // Fallback: 25% of reservation estimated total
  const est = Number(reservation?.estimatedTotal) || 0;
  if (est > 0) return Math.round(est * 0.25 * 100);
  // Last-resort fallback (USD $250)
  return 25000;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the full counter checkin flow.
 *
 * @param {object} args
 * @param {string} args.reservationId
 * @param {string} args.terminalId
 * @param {object} args.user             — req.user (for audit + flag resolution)
 * @param {object} [args.deps]           — DI seam for tests
 *   { prisma, spin, storage, getTenantConfig, getFlagOn, getActiveTemplate, getReservation, getTenant }
 *
 * @returns {Promise<object>} {
 *   signingId, authReferenceId, authAmountCents, signedFields: number,
 *   pendingFields: number, // 0 if complete
 *   completed: boolean
 * }
 */
export async function runCounterCheckinFlow({
  reservationId,
  terminalId,
  user,
  preAuthOverrideCents,
  preAuthOverrideReason,
  deps = {},
} = {}) {
  if (!reservationId) {
    throw new CounterOrchestratorError('reservationId required', 400, 'MISSING_RESERVATION_ID');
  }
  if (!terminalId) {
    throw new CounterOrchestratorError('terminalId required', 400, 'MISSING_TERMINAL_ID');
  }
  if (!user || !user.tenantId) {
    throw new CounterOrchestratorError('user.tenantId required', 403, 'MISSING_TENANT_SCOPE');
  }

  const prisma = deps.prisma || (await resolveDefaultPrisma());
  const spin = deps.spin || spinClient;
  const storage = deps.storage || { uploadSignatureBlob };
  const flagOn = deps.getFlagOn || isFeatureOnForUser;
  const fetchActiveTpl = deps.getActiveTemplate || getActiveTemplateForTenant;
  const logger = await getLogger();

  // ---- 1. Feature flag gate -----------------------------------------------
  const [tcOn, djOn] = await Promise.all([
    flagOn(user.tenantId, 'interactiveTC', user, { prisma }),
    flagOn(user.tenantId, 'dejavooCounter', user, { prisma }),
  ]);
  if (!tcOn || !djOn) {
    throw new CounterOrchestratorError(
      `Counter Dejavoo flow not enabled (interactiveTC=${tcOn}, dejavooCounter=${djOn})`,
      403,
      'FLAG_OFF'
    );
  }

  // ---- 2. Load context ----------------------------------------------------
  const [tenant, reservation, terminal, template] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { id: true, name: true, settingsJson: true, termsHtml: true },
    }),
    prisma.reservation.findFirst({
      where: { id: reservationId, tenantId: user.tenantId },
      include: {
        pickupLocation: true,
        returnLocation: true,
        vehicle: { include: { vehicleType: true } },
        customer: true,
        charges: { where: { selected: true } },
        rentalAgreement: true,
      },
    }),
    prisma.dejavooTerminal.findFirst({
      where: { id: terminalId, tenantId: user.tenantId },
    }),
    fetchActiveTpl({ tenantId: user.tenantId, prisma }),
  ]);

  if (!tenant) throw new CounterOrchestratorError('Tenant not found', 404, 'TENANT_NOT_FOUND');
  if (!reservation) {
    throw new CounterOrchestratorError(
      `Reservation ${reservationId} not found in tenant scope`,
      404,
      'RESERVATION_NOT_FOUND'
    );
  }
  if (!terminal) {
    throw new CounterOrchestratorError(
      `Terminal ${terminalId} not found in tenant scope`,
      404,
      'TERMINAL_NOT_FOUND'
    );
  }
  if (terminal.status !== 'ACTIVE') {
    throw new CounterOrchestratorError(
      `Terminal status is ${terminal.status}, expected ACTIVE`,
      409,
      'TERMINAL_INACTIVE'
    );
  }
  if (!template) {
    throw new CounterOrchestratorError(
      'No active TermsTemplate for this tenant — activate one before running checkin',
      422,
      'NO_ACTIVE_TEMPLATE'
    );
  }

  // ---- 3. Resolve tenantConfig from terminal (decrypted authKey) ---------
  const tenantConfig = await resolveTenantConfigForTerminal(terminal, tenant, deps);

  // ---- 4. Create-or-resume ReservationSigning row ------------------------
  let signing = await prisma.reservationSigning.findUnique({
    where: { reservationId: reservation.id },
  });
  if (signing && signing.completedAt) {
    throw new CounterOrchestratorError(
      'Reservation is already signed — cannot start a new signing flow',
      409,
      'ALREADY_SIGNED'
    );
  }
  if (!signing) {
    signing = await prisma.reservationSigning.create({
      data: {
        reservationId: reservation.id,
        templateId: template.id,
        templateVersionSnapshot: template.contentHtml,
        surfaceUsed: 'DEJAVOO_TERMINAL',
        dejavooTerminalId: terminal.id,
        agentUserId: user.sub || user.id,
        customerName:
          [reservation.customer?.firstName, reservation.customer?.lastName]
            .filter(Boolean)
            .join(' ') || 'Customer',
        customerLicense: reservation.customer?.licenseNumber || null,
        customerCardLast4: null, // populated after AUTH
        ipAddress: deps.ipAddress || null,
        userAgent: deps.userAgent || null,
      },
    });
  }
  // Snapshot tenantId for the per-step recordPendingTx helper (we don't
  // want to plumb tenantId into every call site).
  signing.tenantIdSnapshot = tenant.id;

  const requiredFields = (template.fields || []).filter((f) => f.required !== false);
  const existingFieldRows = await prisma.reservationSigningField.findMany({
    where: { signingId: signing.id },
    select: { templateFieldId: true },
  });
  const alreadySigned = new Set(existingFieldRows.map((r) => r.templateFieldId));
  const pendingFields = requiredFields.filter((f) => !alreadySigned.has(f.id));

  logger.info?.('[counter-orchestrator] starting', {
    reservationId,
    terminalId,
    templateId: template.id,
    pendingFields: pendingFields.length,
    requiredFields: requiredFields.length,
  });

  // ---- 5. (Removed in round 25) ------------------------------------------
  //
  // The previous flow showed the full T&C on the terminal via spin.disclaimer
  // (step 5) and then iterated TermsTemplateField records calling
  // spin.getSignature / spin.userChoice / spin.userInput per field (step 6).
  // All 5 endpoints returned 404 against api.spinpos.net — they aren't
  // exposed as standalone v2/Payment/* methods.
  //
  // New flow: the terminal profile is configured (via iPOSpays merchant
  // portal) to auto-display the disclaimer page before every Sale. The
  // customer's acceptance is captured by the Sale request itself via
  // CaptureSignature: true (see step 7b below). That single signature
  // counts as acceptance of every required field — we persist one row per
  // TermsTemplateField pointing to the same signature blob after the Sale
  // returns successfully.
  //
  // See: doc/round-25-plan-2026-05-22.md
  // ------------------------------------------------------------------------

  // ---- 6. (Removed — see step 5 note above) ------------------------------

  // ---- 7a. Compute the rental fee amount + the security deposit amount ---
  // Round 22 — IRC flow: at pickup we charge the RENTAL FEE first (single
  // swipe), then place an AUTH hold for the security deposit using the
  // saved IPosToken (no second swipe).
  //
  // Rental fee = sum of selected ReservationCharge.total for the reservation,
  // EXCLUDING deposit-coded rows. The deposit appears as a charge line in the
  // wizard UI for visibility, but it is handled by the separate AUTH hold
  // below (preAuthAmountCents) — including it in the SALE would double-charge
  // the customer (Round 26 followup #10, 2026-05-24).
  //
  // Security deposit = tenant.settings.dejavoo.preAuthAmountCents (override
  // allowed via preAuthOverrideCents).
  const rentalFeeDollars = (reservation.charges || [])
    .filter((c) => c.selected !== false)
    .filter((c) => !isDepositCharge(c))
    .reduce((acc, c) => {
      const n = Number(c.total);
      return acc + (Number.isFinite(n) ? n : 0);
    }, 0);
  const rentalFeeCents = Math.round(rentalFeeDollars * 100);

  const defaultCents = resolvePreAuthAmountCents(tenant, reservation);
  const overrideRequested =
    typeof preAuthOverrideCents === 'number' &&
    preAuthOverrideCents >= 0 &&
    preAuthOverrideCents !== defaultCents;
  const preAuthCents = overrideRequested ? preAuthOverrideCents : defaultCents;
  const preAuthAmount = preAuthCents / 100;

  if (overrideRequested) {
    try {
      await prisma.tenantAuditLog.create({
        data: {
          tenantId: tenant.id,
          actorUserId: user.sub || user.id || null,
          action: 'PREAUTH_OVERRIDE',
          resource: reservation.id,
          payload: {
            reservationId: reservation.id,
            defaultCents,
            overrideCents: preAuthCents,
            reason: preAuthOverrideReason || null,
            at: new Date().toISOString(),
          },
        },
      });
      logger.info?.('[counter-orchestrator] pre-auth override applied', {
        reservationId, defaultCents, overrideCents: preAuthCents, reason: preAuthOverrideReason,
      });
    } catch (err) {
      // Non-fatal — log + continue
      logger.warn?.('[counter-orchestrator] failed to audit pre-auth override', {
        msg: err.message,
      });
    }
  }

  const { Cart, Level3 } = buildLevel3FromReservation(
    reservation, reservation.rentalAgreement || {}, reservation.charges || []
  );

  // ---- 7b. SALE for the rental fee (single swipe — token saved) ----------
  // Skip the SALE step entirely if rentalFee is 0 (e.g. prepaid online,
  // complimentary rental). In that case we go directly to the AUTH with
  // a card-present prompt (no token yet, so we can't do CNP).
  //
  // Round 25 (2026-05-22): autoRentalSale has CaptureSignature: true set,
  // so the response carries the customer's T&C signature as SignatureData
  // (base64 PNG). We extract + upload to Storage immediately so subsequent
  // ReservationSigningField rows (one per required template field) can
  // point at the same blob.
  let saleNorm = null;
  let saleTx = null;
  let cardOnFileToken = null;
  let signatureStoragePath = null;
  let signatureSourceTxId = null;

  if (rentalFeeCents > 0) {
    const saleRef = makeRefId('SALE', reservation.id);
    saleTx = await recordPendingTx(prisma, {
      tenantId: tenant.id,
      terminalId: terminal.id,
      reservationId: reservation.id,
      signingId: signing.id,
      type: 'SALE',
      referenceId: saleRef,
      amountCents: rentalFeeCents,
      invoiceNumber: reservation.id,
      customLabel: 'Rental fee at pickup',
      requestJson: {
        amount: rentalFeeDollars,
        rentalData: Level3.RentalData,
        cartItems: Cart.Items.length,
        kind: 'pickup_rental_fee',
      },
    });
    try {
      const raw = await spin.autoRentalSale(
        {
          amount: rentalFeeDollars,
          referenceId: saleRef,
          invoiceNumber: reservation.id,
          rentalData: Level3.RentalData,
          cart: Cart,
          level3: { RentalData: Level3.RentalData },
        },
        tenantConfig
      );
      saleNorm = spin.normalizeResponse(raw);
      await recordTxResult(prisma, saleTx.id, saleNorm, raw);

      // Extract T&C signature from the Sale response (CaptureSignature: true)
      const saleSig = raw?.SignatureData || raw?.Signature || null;
      if (saleSig) {
        const uploaded = await storage.uploadSignatureBlob({
          tenantId: tenant.id,
          reservationId: reservation.id,
          fieldKey: 'tc_acceptance',
          body: saleSig,
          contentType: 'image/png',
          kind: 'agreement',
        });
        signatureStoragePath = uploaded.storagePath;
        signatureSourceTxId = saleTx.id;
        await prisma.dejavooTransaction.update({
          where: { id: saleTx.id },
          data: { signatureStoragePath },
        });
        // Round 26 (2026-05-23): also persist the signature as a data URL on
        // the Reservation so the rental-agreement PDF + email renderer can
        // inline it without a Storage round-trip. This is what populates
        // the four {{INITIALS_*}} markers covered by the terminal disclaimer
        // (Sections 11 + 13). The customer-portal sign flow already sets
        // this same field; we mirror its shape here.
        await prisma.reservation.update({
          where: { id: reservation.id },
          data: {
            signatureDataUrl: `data:image/png;base64,${String(saleSig).replace(/^data:image\/[a-z]+;base64,/, '')}`,
            signatureSignedAt: new Date(),
            signatureSignedBy: `${reservation.customer?.firstName || ''} ${reservation.customer?.lastName || ''}`.trim() || null,
          },
        });
      }
    } catch (err) {
      await recordTxError(prisma, saleTx.id, err);
      throw err;
    }
    if (!saleNorm.approved) {
      throw new CounterOrchestratorError(
        `Rental fee charge failed: ${saleNorm.message || saleNorm.detailedMessage}. ` +
        `Customer's card was declined — no security deposit hold attempted.`,
        402,
        'SALE_DECLINED'
      );
    }
    cardOnFileToken = saleNorm.iposToken || null;

    // Stamp the reservation that we collected the rental fee
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        rentalFeeCollectedAt: new Date(),
        rentalFeeCollectedCents: rentalFeeCents,
      },
    });
    logger.info?.('[counter-orchestrator] rental fee charged at pickup', {
      reservationId, rentalFeeCents, last4: saleNorm.cardData?.last4, hasSignature: !!signatureStoragePath,
    });
  } else {
    logger.info?.('[counter-orchestrator] skipping SALE — rentalFee == 0; signature captured by AUTH below', { reservationId });
  }

  // ---- 7c. AUTH for security deposit (CNP if we have a token from SALE) --
  const authRef = makeRefId('AUTH', reservation.id);
  const useCardOnFileForAuth = !!cardOnFileToken;
  const authTx = await recordPendingTx(prisma, {
    tenantId: tenant.id,
    terminalId: terminal.id,
    reservationId: reservation.id,
    signingId: signing.id,
    type: 'AUTH',
    referenceId: authRef,
    amountCents: preAuthCents,
    invoiceNumber: reservation.id,
    customLabel: overrideRequested
      ? `Security deposit (override: \$${(preAuthCents / 100).toFixed(2)}, default was \$${(defaultCents / 100).toFixed(2)})`
      : 'Security deposit hold',
    parentTransactionId: saleTx?.id || null,
    requestJson: {
      amount: preAuthAmount,
      defaultCents,
      overrideCents: overrideRequested ? preAuthCents : null,
      overrideReason: overrideRequested ? (preAuthOverrideReason || null) : null,
      rentalData: Level3.RentalData,
      cardNotPresent: useCardOnFileForAuth,
      saleReferenceId: saleTx?.referenceId || null,
    },
  });
  let authNorm = null;
  try {
    const raw = useCardOnFileForAuth
      ? await spin.authWithToken(
          {
            amount: preAuthAmount,
            referenceId: authRef,
            iposToken: cardOnFileToken,
            invoiceNumber: reservation.id,
            rentalData: Level3.RentalData,
          },
          tenantConfig
        )
      : await spin.autoRentalAuth(
          {
            amount: preAuthAmount,
            referenceId: authRef,
            invoiceNumber: reservation.id,
            rentalData: Level3.RentalData,
          },
          tenantConfig
        );
    authNorm = spin.normalizeResponse(raw);
    await recordTxResult(prisma, authTx.id, authNorm, raw);

    // Round 25 fallback: if no SALE ran (rentalFee == 0), autoRentalAuth
    // captures the signature instead (CaptureSignature: true on the
    // autoRentalAuth body; authWithToken is CNP so no sig). Extract here.
    if (!signatureStoragePath && !useCardOnFileForAuth) {
      const authSig = raw?.SignatureData || raw?.Signature || null;
      if (authSig) {
        const uploaded = await storage.uploadSignatureBlob({
          tenantId: tenant.id,
          reservationId: reservation.id,
          fieldKey: 'tc_acceptance',
          body: authSig,
          contentType: 'image/png',
          kind: 'agreement',
        });
        signatureStoragePath = uploaded.storagePath;
        signatureSourceTxId = authTx.id;
        await prisma.dejavooTransaction.update({
          where: { id: authTx.id },
          data: { signatureStoragePath },
        });
        // Round 26 (2026-05-23): mirror to Reservation.signatureDataUrl so
        // the PDF renderer can inline the signature in the four INITIALS_*
        // slots covered by the terminal disclaimer. See companion code in
        // the SALE branch above for full reasoning.
        await prisma.reservation.update({
          where: { id: reservation.id },
          data: {
            signatureDataUrl: `data:image/png;base64,${String(authSig).replace(/^data:image\/[a-z]+;base64,/, '')}`,
            signatureSignedAt: new Date(),
            signatureSignedBy: `${reservation.customer?.firstName || ''} ${reservation.customer?.lastName || ''}`.trim() || null,
          },
        });
      }
    }
  } catch (err) {
    await recordTxError(prisma, authTx.id, err);
    throw err;
  }
  if (!authNorm.approved) {
    throw new CounterOrchestratorError(
      `Security deposit hold failed: ${authNorm.message || authNorm.detailedMessage}. ` +
      (useCardOnFileForAuth
        ? 'Rental fee was already charged; manual intervention may be needed to issue a refund or retry the hold.'
        : 'No charges placed.'),
      402,
      'AUTH_DECLINED'
    );
  }

  // ---- 7d. Persist ReservationSigningField rows --------------------------
  //
  // Round 25 (2026-05-22): we no longer walk fields one by one — the
  // customer's single signature on the Sale/Auth screen counts as
  // acceptance of every required field. We persist one row per
  // TermsTemplateField pointing to the SAME signature blob. For non-
  // signature kinds (CHECKBOX / TEXT_FIELD / DATE) we mark them accepted
  // (value='true') via the bundled signing.
  const fieldsToPersist = requiredFields.filter((f) => !alreadySigned.has(f.id));
  if (fieldsToPersist.length > 0) {
    const signedAt = new Date();
    const sourceTxId = signatureSourceTxId || saleTx?.id || authTx.id;
    for (const field of fieldsToPersist) {
      const isSignatureKind = field.kind === 'INITIAL' || field.kind === 'SIGNATURE';
      await prisma.reservationSigningField.create({
        data: {
          signingId: signing.id,
          templateFieldId: field.id,
          signatureSvgOrPath: isSignatureKind ? (signatureStoragePath || null) : null,
          value: isSignatureKind ? null : 'true',
          signedAt,
          dejavooTransactionId: sourceTxId,
        },
      });
    }
    logger.info?.('[counter-orchestrator] persisted signing fields', {
      reservationId, count: fieldsToPersist.length, signatureCaptured: !!signatureStoragePath,
    });
  }

  // ---- 8. Finalize ReservationSigning ------------------------------------
  await prisma.reservationSigning.update({
    where: { id: signing.id },
    data: {
      completedAt: new Date(),
      customerCardLast4: authNorm.cardData?.last4 || null,
    },
  });
  await prisma.reservation.update({
    where: { id: reservation.id },
    data: { signingCompletedAt: new Date() },
  });
  // Touch terminal lastSeenAt
  await prisma.dejavooTerminal.update({
    where: { id: terminal.id },
    data: { lastSeenAt: new Date() },
  });

  // ---- 9. Promote IPosToken to Customer card-on-file (round 20) ----------
  // The AUTH response includes an IPosToken that represents the card in
  // Dejavoo's token vault. Saving it on the Customer record lets us run
  // card-not-present charges later (tolls, late fees, damage assessments)
  // without the customer being physically present.
  if (authNorm?.iposToken && reservation.customer?.id) {
    try {
      await prisma.customer.update({
        where: { id: reservation.customer.id },
        data: {
          dejavooIposToken: authNorm.iposToken,
          dejavooCardLast4: authNorm.cardData?.last4 || null,
          dejavooCardBrand: authNorm.cardData?.cardType || null,
          dejavooCardEntryType: authNorm.cardData?.entryType || null,
          dejavooCardCapturedAt: new Date(),
        },
      });
      logger.info?.('[counter-orchestrator] saved card-on-file token', {
        customerId: reservation.customer.id,
        last4: authNorm.cardData?.last4,
      });
    } catch (err) {
      // Non-fatal — log + continue. The transaction is already approved;
      // we just lose the future card-on-file benefit.
      logger.warn?.('[counter-orchestrator] failed to save card-on-file token', {
        customerId: reservation.customer.id,
        msg: err.message,
      });
    }
  }

  logger.info?.('[counter-orchestrator] completed', {
    reservationId,
    signingId: signing.id,
    authReferenceId: authRef,
    authAmount: preAuthAmount,
  });

  return {
    signingId: signing.id,
    authReferenceId: authRef,
    authAmountCents: preAuthCents,
    signedFields: requiredFields.length,
    pendingFields: 0,
    completed: true,
    cardLast4: authNorm.cardData?.last4 || null,
  };
}

// ---------------------------------------------------------------------------
// Tenant config resolution (decrypts authKey when stored encrypted)
// ---------------------------------------------------------------------------

const ENCRYPTED_KEY_PREFIX = 'enc:v1:';

/**
 * Resolve the SPIn HTTP config for a terminal. Decrypts authKey if stored
 * with the `enc:v1:` prefix; falls back to plaintext for backcompat.
 */
async function resolveTenantConfigForTerminal(terminal, tenant, deps = {}) {
  let authKey = terminal.authKeyEnc || '';
  if (authKey && authKey.startsWith(ENCRYPTED_KEY_PREFIX)) {
    const decryptFn = deps.decrypt || (await import('../../lib/integration-crypto.js')).decrypt;
    try {
      authKey = decryptFn(authKey.slice(ENCRYPTED_KEY_PREFIX.length));
    } catch (err) {
      throw new CounterOrchestratorError(
        `Failed to decrypt terminal authKey: ${err.message}`,
        500,
        'AUTHKEY_DECRYPT_FAILED'
      );
    }
  }
  if (!authKey) {
    // Last-resort fallback: read legacy tenant.settingsJson.spinAuthKey
    try {
      const settings = typeof tenant.settingsJson === 'string'
        ? JSON.parse(tenant.settingsJson)
        : (tenant.settingsJson || {});
      authKey = settings?.spinAuthKey || '';
    } catch {
      authKey = '';
    }
  }
  if (!authKey) {
    throw new CounterOrchestratorError(
      `Terminal ${terminal.id} has no auth key configured`,
      500,
      'AUTHKEY_MISSING'
    );
  }
  return {
    spinAuthKey: authKey,
    spinTpn: terminal.tpn,
    spinMerchantNumber: terminal.merchantNumber || 1,
    spinSandbox: terminal.sandbox !== false,
    spinCallbackUrl: terminal.callbackUrl || process.env.SPIN_CALLBACK_URL || '',
  };
}

// Exported for tests
export const _internal = {
  resolveTenantConfigForTerminal,
  resolvePreAuthAmountCents,
  makeRefId,
};
