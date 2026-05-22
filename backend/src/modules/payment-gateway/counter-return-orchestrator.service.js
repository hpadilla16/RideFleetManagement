/**
 * Counter RETURN orchestrator — Interactive T&C + Dejavoo P1 (2026-05-21).
 *
 * ROUND 22 — extras-vs-deposit semantics.
 *
 * Background: at pickup we now charge the RENTAL FEE up front via SALE (single
 * swipe → IPosToken saved on Customer), and place a separate AUTH hold for the
 * security deposit using the token (CNP). At return, the agent collects ONLY
 * the EXTRAS owed on top of the original rental fee — late hours, damage,
 * fuel, tolls, etc.
 *
 *   extras = finalCharges - rentalFeeCollectedAtPickup
 *
 * Three branches:
 *
 *   CASE A — extras > 0 AND extras <= depositHold  (the common case)
 *     → autoRentalCapture(extras) against the AUTH
 *     → Dejavoo voids the unused portion of the hold automatically.
 *
 *   CASE B — extras > depositHold  (excess: huge damage bill, etc.)
 *     → autoRentalCapture for the FULL hold
 *     → CNP saleWithToken for (extras - depositHold) using
 *       Customer.dejavooIposToken (no customer presence required).
 *       If we somehow don't have a saved token, fall back to a fresh
 *       card-present sale on the terminal.
 *
 *   CASE C — extras == 0  (nothing extra owed; common when there's no damage
 *                          / late fee / fuel charge)
 *     → void the AUTH — releases the deposit hold. Rental fee was already
 *       collected at pickup, so no further capture is needed.
 *
 * Feature flag gate: `dejavooCounter` must resolve ON for the user.
 * `interactiveTC` is NOT required here — return can happen even if the
 * signing flow was completed on a tablet or via legacy single-sig.
 *
 * Receipt signature: every CAPTURE / SALE call uses CaptureSignature=true,
 * so the customer signs the receipt on the terminal IF they're present.
 * For CNP saleWithToken there's no signature (card-not-present). The PNG,
 * when present, is persisted to Storage as a "receipt" entry.
 *
 * Design doc: doc/interactive-tc-and-dejavoo-unified-2026-05-21.md §5–6
 */

import { isFeatureOnForUser } from '../../lib/feature-flags.js';
import {
  spinClient,
  buildLevel3FromReservation,
} from './spin-client.js';
import { uploadSignatureBlob } from '../terms/signing-storage.js';
import { CounterOrchestratorError } from './counter-orchestrator.service.js';

// Lazy prisma + logger
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRefId(prefix, reservationId) {
  const tail = String(reservationId || '').slice(-8) || 'noresv';
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${tail}-${ts}${rnd}`.slice(0, 50);
}

const ENCRYPTED_KEY_PREFIX = 'enc:v1:';

async function resolveTenantConfigForTerminal(terminal, tenant, deps = {}) {
  let authKey = terminal.authKeyEnc || '';
  if (authKey.startsWith(ENCRYPTED_KEY_PREFIX)) {
    const decryptFn = deps.decrypt || (await import('../../lib/integration-crypto.js')).decrypt;
    authKey = decryptFn(authKey.slice(ENCRYPTED_KEY_PREFIX.length));
  }
  if (!authKey) {
    try {
      const settings = typeof tenant?.settingsJson === 'string'
        ? JSON.parse(tenant.settingsJson)
        : (tenant?.settingsJson || {});
      authKey = settings?.spinAuthKey || '';
    } catch { authKey = ''; }
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

async function recordTxError(prisma, txId, err) {
  return prisma.dejavooTransaction.update({
    where: { id: txId },
    data: {
      statusCode: err?.spinStatusCode || 'ERROR',
      errorMessage: err?.message || 'unknown error',
      completedAt: new Date(),
    },
  });
}

/**
 * Sum up the final amount in cents for a reservation. Defaults to summing
 * the selected ReservationCharge rows. Caller can override with explicit
 * `finalAmountCents`.
 */
function computeFinalAmountCents(reservation) {
  const charges = (reservation?.charges || []).filter((c) => c.selected !== false);
  let total = 0;
  for (const c of charges) {
    const n = Number(c.total);
    if (Number.isFinite(n)) total += n;
  }
  // Convert dollars to cents, rounded
  return Math.round(total * 100);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the counter return flow.
 *
 * @param {object} args
 * @param {string} args.reservationId
 * @param {string} args.terminalId
 * @param {object} args.user
 * @param {number} [args.finalAmountCents]  — override TOTAL owed (rental + extras);
 *                                            else computed from selected charges.
 * @param {number} [args.extrasAmountCents] — override EXTRAS directly (rare; used
 *                                            mostly by tests / portals where the
 *                                            UI already knows the delta). When
 *                                            provided this wins over finalAmountCents.
 * @param {object} [args.deps]
 * @returns {Promise<object>} {
 *   case: 'CAPTURE' | 'CAPTURE_PLUS_SALE' | 'VOID',
 *   rentalFeeCollectedCents, extrasCents,
 *   capturedAmountCents, additionalSaleCents,
 *   additionalSaleMode?: 'CARD_ON_FILE' | 'CARD_PRESENT',
 *   captureReferenceId, saleReferenceId?, voidReferenceId?,
 *   receiptSignaturePath?,
 *   completed: true
 * }
 */
export async function runCounterReturnFlow({
  reservationId,
  terminalId,
  user,
  finalAmountCents: explicitFinal,
  extrasAmountCents: explicitExtras,
  deps = {},
} = {}) {
  if (!reservationId) {
    throw new CounterOrchestratorError('reservationId required', 400, 'MISSING_RESERVATION_ID');
  }
  if (!terminalId) {
    throw new CounterOrchestratorError('terminalId required', 400, 'MISSING_TERMINAL_ID');
  }
  if (!user?.tenantId) {
    throw new CounterOrchestratorError('user.tenantId required', 403, 'MISSING_TENANT_SCOPE');
  }

  const prisma = deps.prisma || (await resolveDefaultPrisma());
  const spin = deps.spin || spinClient;
  const storage = deps.storage || { uploadSignatureBlob };
  const flagOn = deps.getFlagOn || isFeatureOnForUser;
  const logger = await getLogger();

  // ---- 1. Feature flag gate (dejavooCounter only — TC may be off here) -
  const djOn = await flagOn(user.tenantId, 'dejavooCounter', user, { prisma });
  if (!djOn) {
    throw new CounterOrchestratorError(
      'Dejavoo counter flow is not enabled for this tenant',
      403,
      'FLAG_OFF'
    );
  }

  // ---- 2. Load context --------------------------------------------------
  const [tenant, reservation, terminal] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { id: true, settingsJson: true },
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
        signing: true,
      },
    }),
    prisma.dejavooTerminal.findFirst({
      where: { id: terminalId, tenantId: user.tenantId },
    }),
  ]);

  if (!tenant) {
    throw new CounterOrchestratorError('Tenant not found', 404, 'TENANT_NOT_FOUND');
  }
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
      `Terminal status is ${terminal.status}`,
      409,
      'TERMINAL_INACTIVE'
    );
  }

  // ---- 3. Find the prior AUTH transaction --------------------------------
  const priorAuth = await prisma.dejavooTransaction.findFirst({
    where: {
      reservationId: reservation.id,
      type: 'AUTH',
      approved: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!priorAuth) {
    throw new CounterOrchestratorError(
      'No prior approved AUTH found for this reservation — cannot capture or void',
      422,
      'NO_PRIOR_AUTH'
    );
  }
  const authAmountCents = priorAuth.amountCents || 0;

  // ---- 4. Resolve final amount + EXTRAS (round 22) ----------------------
  // The amount we owe-or-refund AT RETURN is `extras` = final - alreadyPaid.
  // The base rental fee was charged at pickup (`rentalFeeCollectedCents`),
  // so extras represents add-ons accumulated during the rental: damage,
  // late hours, fuel, tolls, cleaning, etc.
  const finalCents = typeof explicitFinal === 'number'
    ? Math.max(0, Math.round(explicitFinal))
    : computeFinalAmountCents(reservation);
  const rentalFeeCollectedCents = Math.max(
    0,
    Number(reservation.rentalFeeCollectedCents) || 0
  );
  const extrasCents = typeof explicitExtras === 'number'
    ? Math.max(0, Math.round(explicitExtras))
    : Math.max(0, finalCents - rentalFeeCollectedCents);

  logger.info?.('[counter-return] resolved amounts', {
    reservationId,
    authAmountCents,
    finalCents,
    rentalFeeCollectedCents,
    extrasCents,
  });

  // ---- 5. Resolve tenantConfig (decrypted authKey) -----------------------
  const tenantConfig = await resolveTenantConfigForTerminal(terminal, tenant, deps);

  // ---- 6. (Optional) display cart on terminal screen before charging -----
  const { Cart, Level3 } = buildLevel3FromReservation(
    reservation, reservation.rentalAgreement || {}, reservation.charges || []
  );
  if (Cart.Items.length > 0 && extrasCents > 0) {
    const cartRef = makeRefId('CART', reservation.id);
    const cartTx = await recordPendingTx(prisma, {
      tenantId: tenant.id,
      terminalId: terminal.id,
      reservationId: reservation.id,
      signingId: reservation.signing?.id || null,
      type: 'CART',
      referenceId: cartRef,
      amountCents: extrasCents,
      customLabel: 'Return summary (extras)',
      requestJson: {
        items: Cart.Items.length,
        total: Cart.Total,
        rentalFeePaidAtPickup: rentalFeeCollectedCents,
        extrasCents,
      },
    });
    try {
      const raw = await spin.cart(
        { items: Cart.Items, total: Cart.Total, referenceId: cartRef },
        tenantConfig
      );
      const normalized = spin.normalizeResponse(raw);
      await recordTxResult(prisma, cartTx.id, normalized, raw);
    } catch (err) {
      // Cart display is best-effort — don't block the actual settlement.
      await recordTxError(prisma, cartTx.id, err);
    }
  }

  // ---- 7. Branch on the 3 cases — driven by EXTRAS, not finalCents ------
  if (extrasCents === 0) {
    return _caseVoid({
      prisma, spin, tenantConfig, tenant, terminal, reservation, priorAuth, logger,
      rentalFeeCollectedCents, extrasCents, finalCents,
    });
  }
  if (extrasCents <= authAmountCents) {
    return _caseCapture({
      prisma, spin, storage, tenantConfig, tenant, terminal, reservation,
      priorAuth, extrasCents, Level3, logger,
      rentalFeeCollectedCents, finalCents,
    });
  }
  return _caseCaptureAndSale({
    prisma, spin, storage, tenantConfig, tenant, terminal, reservation,
    priorAuth, authAmountCents, extrasCents, Level3, logger,
    rentalFeeCollectedCents, finalCents,
  });
}

// ---------------------------------------------------------------------------
// CASE A — extras > 0 AND extras <= depositHold
// Capture the `extras` from the deposit hold; Dejavoo voids the remainder.
// ---------------------------------------------------------------------------

async function _caseCapture({
  prisma, spin, storage, tenantConfig, tenant, terminal, reservation,
  priorAuth, extrasCents, Level3, logger,
  rentalFeeCollectedCents, finalCents,
}) {
  const ref = makeRefId('CAP', reservation.id);
  const tx = await recordPendingTx(prisma, {
    tenantId: tenant.id,
    terminalId: terminal.id,
    reservationId: reservation.id,
    signingId: reservation.signing?.id || null,
    type: 'CAPTURE',
    referenceId: ref,
    amountCents: extrasCents,
    invoiceNumber: reservation.id,
    customLabel: 'Capture extras at return',
    parentTransactionId: priorAuth.id,
    requestJson: {
      authReferenceId: priorAuth.referenceId,
      extrasCents,
      rentalFeeCollectedCents,
      finalCents,
    },
  });
  let normalized;
  let raw;
  try {
    raw = await spin.autoRentalCapture(
      {
        referenceId: priorAuth.referenceId,
        amount: extrasCents / 100,
        rentalData: Level3.RentalData,
      },
      tenantConfig
    );
    normalized = spin.normalizeResponse(raw);
  } catch (err) {
    await recordTxError(prisma, tx.id, err);
    throw err;
  }
  if (!normalized.approved) {
    await recordTxResult(prisma, tx.id, normalized, raw);
    throw new CounterOrchestratorError(
      `Capture failed: ${normalized.message || normalized.detailedMessage}`,
      402,
      'CAPTURE_FAILED'
    );
  }
  const sigPath = await _persistReceiptSig({ raw, prisma, storage, tenant, reservation, txId: tx.id });
  await recordTxResult(prisma, tx.id, normalized, raw);
  if (sigPath) {
    await prisma.dejavooTransaction.update({
      where: { id: tx.id },
      data: { signatureStoragePath: sigPath },
    });
  }
  // Promote token to Customer card-on-file (round 20)
  await _promoteCardOnFile({ prisma, normalized, reservation, logger });
  // Touch terminal lastSeenAt
  await prisma.dejavooTerminal.update({
    where: { id: terminal.id },
    data: { lastSeenAt: new Date() },
  });
  logger.info?.('[counter-return] CAPTURE done', {
    reservationId: reservation.id,
    capturedCents: extrasCents,
    rentalFeeCollectedCents,
  });
  return {
    case: 'CAPTURE',
    rentalFeeCollectedCents,
    extrasCents,
    capturedAmountCents: extrasCents,
    additionalSaleCents: 0,
    captureReferenceId: ref,
    receiptSignaturePath: sigPath || null,
    completed: true,
  };
}

// ---------------------------------------------------------------------------
// CASE B — extras > depositHold
// Capture the FULL hold, then charge the overage. Prefer CNP saleWithToken
// using Customer.dejavooIposToken; fall back to card-present sale if we
// don't have a saved token.
// ---------------------------------------------------------------------------

async function _caseCaptureAndSale({
  prisma, spin, storage, tenantConfig, tenant, terminal, reservation,
  priorAuth, authAmountCents, extrasCents, Level3, logger,
  rentalFeeCollectedCents, finalCents,
}) {
  // Step 1: capture full pre-auth (Dejavoo collects this from the hold)
  const capRef = makeRefId('CAP', reservation.id);
  const capTx = await recordPendingTx(prisma, {
    tenantId: tenant.id,
    terminalId: terminal.id,
    reservationId: reservation.id,
    signingId: reservation.signing?.id || null,
    type: 'CAPTURE',
    referenceId: capRef,
    amountCents: authAmountCents,
    invoiceNumber: reservation.id,
    customLabel: 'Capture pre-auth (full) — extras exceed hold',
    parentTransactionId: priorAuth.id,
    requestJson: {
      authReferenceId: priorAuth.referenceId,
      capturedCents: authAmountCents,
      extrasCents,
      rentalFeeCollectedCents,
      finalCents,
    },
  });
  let capNorm;
  let capRaw;
  try {
    capRaw = await spin.autoRentalCapture(
      {
        referenceId: priorAuth.referenceId,
        amount: authAmountCents / 100,
        rentalData: Level3.RentalData,
      },
      tenantConfig
    );
    capNorm = spin.normalizeResponse(capRaw);
  } catch (err) {
    await recordTxError(prisma, capTx.id, err);
    throw err;
  }
  if (!capNorm.approved) {
    await recordTxResult(prisma, capTx.id, capNorm, capRaw);
    throw new CounterOrchestratorError(
      `Capture failed: ${capNorm.message || capNorm.detailedMessage}`,
      402,
      'CAPTURE_FAILED'
    );
  }
  await recordTxResult(prisma, capTx.id, capNorm, capRaw);

  // Step 2: charge the overage. Prefer CNP via saved token; fall back to
  // card-present sale on the terminal if the customer has no saved token.
  const diffCents = extrasCents - authAmountCents;
  const cardOnFileToken = reservation.customer?.dejavooIposToken || null;
  const saleMode = cardOnFileToken ? 'CARD_ON_FILE' : 'CARD_PRESENT';
  const saleRef = makeRefId(saleMode === 'CARD_ON_FILE' ? 'CNPS' : 'SALE', reservation.id);
  const saleTx = await recordPendingTx(prisma, {
    tenantId: tenant.id,
    terminalId: terminal.id,
    reservationId: reservation.id,
    signingId: reservation.signing?.id || null,
    type: 'SALE',
    referenceId: saleRef,
    amountCents: diffCents,
    invoiceNumber: reservation.id,
    customLabel:
      saleMode === 'CARD_ON_FILE'
        ? 'Sale for overage (card-on-file CNP)'
        : 'Sale for overage (card-present, no token on file)',
    parentTransactionId: capTx.id,
    requestJson: {
      diffCents,
      saleMode,
      cardOnFileLast4: reservation.customer?.dejavooCardLast4 || null,
    },
  });
  let saleNorm;
  let saleRaw;
  try {
    if (saleMode === 'CARD_ON_FILE') {
      saleRaw = await spin.saleWithToken(
        {
          amount: diffCents / 100,
          referenceId: saleRef,
          iposToken: cardOnFileToken,
          invoiceNumber: reservation.id,
          rentalData: Level3.RentalData,
        },
        tenantConfig
      );
    } else {
      saleRaw = await spin.autoRentalSale(
        {
          amount: diffCents / 100,
          referenceId: saleRef,
          invoiceNumber: reservation.id,
          rentalData: Level3.RentalData,
          level3: { RentalData: Level3.RentalData },
        },
        tenantConfig
      );
    }
    saleNorm = spin.normalizeResponse(saleRaw);
  } catch (err) {
    await recordTxError(prisma, saleTx.id, err);
    throw err;
  }
  if (!saleNorm.approved) {
    await recordTxResult(prisma, saleTx.id, saleNorm, saleRaw);
    throw new CounterOrchestratorError(
      `Overage sale failed (${saleMode}): ${saleNorm.message || saleNorm.detailedMessage}. ` +
      `Pre-auth capture of $${(authAmountCents / 100).toFixed(2)} already settled; ` +
      `agent must collect the $${(diffCents / 100).toFixed(2)} overage by another means ` +
      `or issue a manual refund.`,
      402,
      'SALE_FAILED'
    );
  }
  // CNP token sales don't capture a signature on the terminal; card-present do.
  const sigPath = saleMode === 'CARD_PRESENT'
    ? await _persistReceiptSig({ raw: saleRaw, prisma, storage, tenant, reservation, txId: saleTx.id })
    : null;
  await recordTxResult(prisma, saleTx.id, saleNorm, saleRaw);
  if (sigPath) {
    await prisma.dejavooTransaction.update({
      where: { id: saleTx.id },
      data: { signatureStoragePath: sigPath },
    });
  }
  // If we just did a CARD_PRESENT sale, the customer's physical card was
  // dipped — promote that token (it may be a different card than the one
  // used at pickup). For CARD_ON_FILE we already have the token, no need
  // to re-save.
  if (saleMode === 'CARD_PRESENT') {
    await _promoteCardOnFile({ prisma, normalized: saleNorm, reservation, logger });
  }
  await prisma.dejavooTerminal.update({
    where: { id: terminal.id },
    data: { lastSeenAt: new Date() },
  });
  logger.info?.('[counter-return] CAPTURE+SALE done', {
    reservationId: reservation.id,
    capturedCents: authAmountCents,
    additionalCents: diffCents,
    saleMode,
    rentalFeeCollectedCents,
  });
  return {
    case: 'CAPTURE_PLUS_SALE',
    rentalFeeCollectedCents,
    extrasCents,
    capturedAmountCents: authAmountCents,
    additionalSaleCents: diffCents,
    additionalSaleMode: saleMode,
    captureReferenceId: capRef,
    saleReferenceId: saleRef,
    receiptSignaturePath: sigPath || null,
    completed: true,
  };
}

// ---------------------------------------------------------------------------
// CASE C — extras == 0  (nothing extra owed — void the deposit hold)
// ---------------------------------------------------------------------------

async function _caseVoid({
  prisma, spin, tenantConfig, tenant, terminal, reservation, priorAuth, logger,
  rentalFeeCollectedCents, extrasCents, finalCents,
}) {
  const ref = makeRefId('VOID', reservation.id);
  const tx = await recordPendingTx(prisma, {
    tenantId: tenant.id,
    terminalId: terminal.id,
    reservationId: reservation.id,
    signingId: reservation.signing?.id || null,
    type: 'VOID',
    referenceId: ref,
    amountCents: 0,
    invoiceNumber: reservation.id,
    customLabel: 'Void pre-auth (nothing owed at return)',
    parentTransactionId: priorAuth.id,
    requestJson: { authReferenceId: priorAuth.referenceId },
  });
  let normalized;
  let raw;
  try {
    raw = await spin.void({ referenceId: priorAuth.referenceId }, tenantConfig);
    normalized = spin.normalizeResponse(raw);
  } catch (err) {
    await recordTxError(prisma, tx.id, err);
    throw err;
  }
  if (!normalized.approved) {
    await recordTxResult(prisma, tx.id, normalized, raw);
    throw new CounterOrchestratorError(
      `Void failed: ${normalized.message}`,
      402,
      'VOID_FAILED'
    );
  }
  await recordTxResult(prisma, tx.id, normalized, raw);
  await prisma.dejavooTerminal.update({
    where: { id: terminal.id },
    data: { lastSeenAt: new Date() },
  });
  logger.info?.('[counter-return] VOID done', {
    reservationId: reservation.id,
    authReferenceId: priorAuth.referenceId,
    rentalFeeCollectedCents,
  });
  return {
    case: 'VOID',
    rentalFeeCollectedCents,
    extrasCents: extrasCents ?? 0,
    capturedAmountCents: 0,
    additionalSaleCents: 0,
    voidReferenceId: ref,
    receiptSignaturePath: null,
    completed: true,
  };
}

// ---------------------------------------------------------------------------
// Receipt signature persistence
// ---------------------------------------------------------------------------

/**
 * Promote the IPosToken returned from CAPTURE/SALE up to Customer for
 * future card-not-present charges (round 20). Non-fatal on error.
 */
async function _promoteCardOnFile({ prisma, normalized, reservation, logger }) {
  if (!normalized?.iposToken || !reservation?.customer?.id) return;
  try {
    await prisma.customer.update({
      where: { id: reservation.customer.id },
      data: {
        dejavooIposToken: normalized.iposToken,
        dejavooCardLast4: normalized.cardData?.last4 || null,
        dejavooCardBrand: normalized.cardData?.cardType || null,
        dejavooCardEntryType: normalized.cardData?.entryType || null,
        dejavooCardCapturedAt: new Date(),
      },
    });
    if (logger?.info) {
      logger.info('[counter-return] saved card-on-file token', {
        customerId: reservation.customer.id,
        last4: normalized.cardData?.last4,
      });
    }
  } catch (err) {
    if (logger?.warn) {
      logger.warn('[counter-return] failed to save card-on-file token', {
        customerId: reservation.customer.id,
        msg: err.message,
      });
    }
  }
}

async function _persistReceiptSig({ raw, prisma, storage, tenant, reservation, txId }) {
  // Dejavoo Sale/Capture responses with CaptureSignature=true include
  // SignatureData (base64 PNG). Save to Storage as a "receipt-<ts>.png".
  const base64 = raw?.SignatureData || raw?.Signature || null;
  if (!base64) return null;
  try {
    const uploaded = await storage.uploadSignatureBlob({
      tenantId: tenant.id,
      reservationId: reservation.id,
      fieldKey: `RECEIPT-${txId.slice(-8)}`,
      body: base64,
      contentType: 'image/png',
      kind: 'receipt',
    });
    return uploaded.storagePath;
  } catch (err) {
    // Signature save failures are non-fatal — log + continue
    const logger = await getLogger();
    logger.warn?.('[counter-return] receipt sig save failed', { reservationId: reservation.id, msg: err.message });
    return null;
  }
}

// Exported for tests
export const _internal = {
  computeFinalAmountCents,
  resolveTenantConfigForTerminal,
  makeRefId,
};
