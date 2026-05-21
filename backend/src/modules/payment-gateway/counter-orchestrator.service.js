/**
 * Counter checkin orchestrator — Interactive T&C + Dejavoo P1 unified flow.
 * (2026-05-21)
 *
 * `runCounterCheckinFlow` is the entry point invoked by the route handler
 * `POST /api/payment-gateway/counter/start-checkin`. It walks the customer
 * through the entire signing + pre-auth flow on the Dejavoo terminal:
 *
 *   1. Show full T&C once on the terminal (Disclaimer endpoint).
 *   2. Iterate every required TermsTemplateField in order:
 *        - INITIAL    → disclaimer(section context) + getSignature
 *        - SIGNATURE  → getSignature
 *        - CHECKBOX   → userChoice(prompt, ['Sí','No'])
 *        - TEXT_FIELD → userInput(prompt)
 *        - DATE       → userInput(prompt) + validate ISO date
 *   3. Persist each result to ReservationSigningField + DejavooTransaction.
 *   4. Render the final signed HTML → PDF → upload to Storage.
 *   5. Run autoRentalAuth for the security-deposit pre-auth amount.
 *   6. Return summary to the agent UI.
 *
 * Feature flag gates (read by the route, but the service double-checks
 * defensively): `interactiveTC` AND `dejavooCounter` must both resolve
 * to ON for the user. If only `interactiveTC` is ON, the route should
 * have already routed to the tablet UX (not this orchestrator).
 *
 * Crash-safety: every step writes a DejavooTransaction BEFORE the network
 * call (status pending), then updates with response/error. If the process
 * dies mid-flow, the ReservationSigning row stays in `startedAt != null,
 * completedAt == null` state and a future "Resume signing" button can
 * pick up at the next unfinished field.
 *
 * Design doc: doc/interactive-tc-and-dejavoo-unified-2026-05-21.md §5
 */

import { isFeatureOnForUser } from '../../lib/feature-flags.js';
import { getActiveTemplateForTenant } from '../terms/terms-templates.service.js';
import {
  spinClient,
  buildLevel3FromReservation,
  htmlToTerminalText,
  extractContextAroundMarker,
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
// Helpers
// ---------------------------------------------------------------------------

function makeRefId(prefix, reservationId) {
  const tail = String(reservationId || '').slice(-8) || 'noresv';
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${tail}-${ts}${rnd}`.slice(0, 50);
}

function isValidIsoDate(s) {
  if (!s || typeof s !== 'string') return false;
  // Accept full ISO or YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return !Number.isNaN(Date.parse(s));
  return !Number.isNaN(Date.parse(s));
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
      statusCode: err?.spinStatusCode || 'ERROR',
      errorMessage: err?.message || 'unknown error',
      completedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Per-field handlers
// ---------------------------------------------------------------------------

async function captureInitialOrSignature({
  prisma, field, signing, terminal, reservation, tenantConfig, spin, storage, contentHtml,
}) {
  // Optional Disclaimer first to show the section text
  if (field.kind === 'INITIAL') {
    const contextText =
      field.terminalContextText ||
      extractContextAroundMarker(contentHtml, field.markerKey);
    if (contextText) {
      const dRef = makeRefId('DISC', reservation.id);
      const dTx = await recordPendingTx(prisma, {
        tenantId: signing.tenantIdSnapshot,
        terminalId: terminal.id,
        reservationId: reservation.id,
        signingId: signing.id,
        type: 'DISCLAIMER',
        referenceId: dRef,
        customLabel: `Disclaimer for ${field.markerKey}`,
        requestJson: { text: contextText, markerKey: field.markerKey },
      });
      try {
        const resp = await spin.disclaimer(
          { text: contextText, title: field.label, referenceId: dRef },
          tenantConfig
        );
        const normalized = spin.normalizeResponse(resp);
        await recordTxResult(prisma, dTx.id, normalized, resp);
      } catch (err) {
        await recordTxError(prisma, dTx.id, err);
        throw err;
      }
    }
  }

  // GetSignature
  const sRef = makeRefId(field.kind === 'INITIAL' ? 'INIT' : 'SIG', reservation.id);
  const tx = await recordPendingTx(prisma, {
    tenantId: signing.tenantIdSnapshot,
    terminalId: terminal.id,
    reservationId: reservation.id,
    signingId: signing.id,
    type: 'GET_SIGNATURE',
    referenceId: sRef,
    customLabel: field.label,
    requestJson: { prompt: field.terminalPromptText || field.label, markerKey: field.markerKey },
  });
  let normalized;
  let raw;
  try {
    raw = await spin.getSignature(
      { promptText: field.terminalPromptText || field.label, referenceId: sRef },
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
      `Signature capture failed for ${field.markerKey}: ${normalized.message || normalized.detailedMessage}`,
      409,
      'SIGNATURE_FAILED'
    );
  }

  // Persist signature PNG to Storage
  const base64 = raw?.SignatureData || raw?.Signature || null;
  let storagePath = null;
  if (base64) {
    const uploaded = await storage.uploadSignatureBlob({
      tenantId: signing.tenantIdSnapshot,
      reservationId: reservation.id,
      fieldKey: field.markerKey,
      body: base64,
      contentType: 'image/png',
      kind: field.kind === 'INITIAL' ? 'initial' : 'agreement',
    });
    storagePath = uploaded.storagePath;
  }

  // Update tx with the signature path
  await prisma.dejavooTransaction.update({
    where: { id: tx.id },
    data: {
      signatureStoragePath: storagePath,
      responseJson: normalized,
      rawResponse: raw,
      statusCode: normalized.statusCode,
      approved: true,
      completedAt: new Date(),
    },
  });

  return { signatureStoragePath: storagePath, dejavooTransactionId: tx.id };
}

async function captureChoice({
  prisma, field, signing, terminal, reservation, tenantConfig, spin,
}) {
  const ref = makeRefId('UC', reservation.id);
  const choices = ['Sí', 'No'];
  const tx = await recordPendingTx(prisma, {
    tenantId: signing.tenantIdSnapshot,
    terminalId: terminal.id,
    reservationId: reservation.id,
    signingId: signing.id,
    type: 'USER_CHOICE',
    referenceId: ref,
    customLabel: field.label,
    requestJson: { prompt: field.terminalPromptText || field.label, choices, markerKey: field.markerKey },
  });
  let raw;
  let normalized;
  try {
    raw = await spin.userChoice(
      { prompt: field.terminalPromptText || field.label, choices, referenceId: ref },
      tenantConfig
    );
    normalized = spin.normalizeResponse(raw);
  } catch (err) {
    await recordTxError(prisma, tx.id, err);
    throw err;
  }
  await recordTxResult(prisma, tx.id, normalized, raw);
  if (!normalized.approved) {
    throw new CounterOrchestratorError(
      `UserChoice failed for ${field.markerKey}: ${normalized.message}`,
      409,
      'CHOICE_FAILED'
    );
  }
  const selected = raw?.SelectedChoice || raw?.Selected || raw?.UserChoice;
  const value = selected === choices[0] ? 'true' : 'false';
  return { value, dejavooTransactionId: tx.id };
}

async function captureText({
  prisma, field, signing, terminal, reservation, tenantConfig, spin, validateDate,
}) {
  const ref = makeRefId('UI', reservation.id);
  const tx = await recordPendingTx(prisma, {
    tenantId: signing.tenantIdSnapshot,
    terminalId: terminal.id,
    reservationId: reservation.id,
    signingId: signing.id,
    type: 'USER_INPUT',
    referenceId: ref,
    customLabel: field.label,
    requestJson: { prompt: field.terminalPromptText || field.label, markerKey: field.markerKey, isDate: !!validateDate },
  });
  let raw;
  let normalized;
  try {
    raw = await spin.userInput(
      { prompt: field.terminalPromptText || field.label, referenceId: ref },
      tenantConfig
    );
    normalized = spin.normalizeResponse(raw);
  } catch (err) {
    await recordTxError(prisma, tx.id, err);
    throw err;
  }
  await recordTxResult(prisma, tx.id, normalized, raw);
  if (!normalized.approved) {
    throw new CounterOrchestratorError(
      `UserInput failed for ${field.markerKey}: ${normalized.message}`,
      409,
      'INPUT_FAILED'
    );
  }
  const value = String(raw?.UserInput || raw?.InputText || '').trim();
  if (!value) {
    throw new CounterOrchestratorError(
      `Empty input for required field ${field.markerKey}`,
      422,
      'EMPTY_INPUT'
    );
  }
  if (validateDate && !isValidIsoDate(value)) {
    throw new CounterOrchestratorError(
      `Invalid date format for ${field.markerKey}: '${value}' (expected YYYY-MM-DD or ISO)`,
      422,
      'INVALID_DATE'
    );
  }
  return { value, dejavooTransactionId: tx.id };
}

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
export async function runCounterCheckinFlow({ reservationId, terminalId, user, deps = {} } = {}) {
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

  // ---- 5. Show the full T&C once on the terminal -------------------------
  if (pendingFields.length === requiredFields.length) {
    // First run only — skip the intro Disclaimer on resume so we don't
    // make the customer re-read.
    const introRef = makeRefId('TC', reservation.id);
    const introTx = await recordPendingTx(prisma, {
      tenantId: tenant.id,
      terminalId: terminal.id,
      reservationId: reservation.id,
      signingId: signing.id,
      type: 'DISCLAIMER',
      referenceId: introRef,
      customLabel: 'Full T&C',
      requestJson: { kind: 'intro', length: template.contentHtml.length },
    });
    try {
      const text = htmlToTerminalText(template.contentHtml);
      const raw = await spin.disclaimer(
        { text, title: template.name || 'Acuerdo de Renta', referenceId: introRef },
        tenantConfig
      );
      const normalized = spin.normalizeResponse(raw);
      await recordTxResult(prisma, introTx.id, normalized, raw);
    } catch (err) {
      await recordTxError(prisma, introTx.id, err);
      throw err;
    }
  }

  // ---- 6. Iterate fields --------------------------------------------------
  for (const field of pendingFields) {
    let result;
    if (field.kind === 'INITIAL' || field.kind === 'SIGNATURE') {
      result = await captureInitialOrSignature({
        prisma, field, signing, terminal, reservation, tenantConfig, spin, storage,
        contentHtml: template.contentHtml,
      });
      await prisma.reservationSigningField.create({
        data: {
          signingId: signing.id,
          templateFieldId: field.id,
          signatureSvgOrPath: result.signatureStoragePath,
          signedAt: new Date(),
          dejavooTransactionId: result.dejavooTransactionId,
        },
      });
    } else if (field.kind === 'CHECKBOX') {
      result = await captureChoice({
        prisma, field, signing, terminal, reservation, tenantConfig, spin,
      });
      await prisma.reservationSigningField.create({
        data: {
          signingId: signing.id,
          templateFieldId: field.id,
          value: result.value,
          signedAt: new Date(),
          dejavooTransactionId: result.dejavooTransactionId,
        },
      });
    } else if (field.kind === 'TEXT_FIELD' || field.kind === 'DATE') {
      result = await captureText({
        prisma, field, signing, terminal, reservation, tenantConfig, spin,
        validateDate: field.kind === 'DATE',
      });
      await prisma.reservationSigningField.create({
        data: {
          signingId: signing.id,
          templateFieldId: field.id,
          value: result.value,
          signedAt: new Date(),
          dejavooTransactionId: result.dejavooTransactionId,
        },
      });
    } else {
      throw new CounterOrchestratorError(
        `Unknown field kind '${field.kind}' for ${field.markerKey}`,
        400,
        'UNKNOWN_KIND'
      );
    }
  }

  // ---- 7. AUTH for pre-auth security deposit -----------------------------
  const preAuthCents = resolvePreAuthAmountCents(tenant, reservation);
  const preAuthAmount = preAuthCents / 100;
  const { Cart, Level3 } = buildLevel3FromReservation(
    reservation, reservation.rentalAgreement || {}, reservation.charges || []
  );
  const authRef = makeRefId('AUTH', reservation.id);
  const authTx = await recordPendingTx(prisma, {
    tenantId: tenant.id,
    terminalId: terminal.id,
    reservationId: reservation.id,
    signingId: signing.id,
    type: 'AUTH',
    referenceId: authRef,
    amountCents: preAuthCents,
    invoiceNumber: reservation.id,
    customLabel: 'Pre-auth at pickup',
    requestJson: { amount: preAuthAmount, rentalData: Level3.RentalData, cartItems: Cart.Items.length },
  });
  let authNorm = null;
  try {
    const raw = await spin.autoRentalAuth(
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
  } catch (err) {
    await recordTxError(prisma, authTx.id, err);
    throw err;
  }
  if (!authNorm.approved) {
    throw new CounterOrchestratorError(
      `Pre-auth failed: ${authNorm.message || authNorm.detailedMessage}`,
      402,
      'AUTH_DECLINED'
    );
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
  isValidIsoDate,
};
