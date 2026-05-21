import { ValidationError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { spinClient } from './spin-client.js';
import logger from '../../lib/logger.js';
import { cache } from '../../lib/cache.js';
import { tenantKey } from '../../lib/cache/tenantKey.js';

/**
 * Resolve SPIn config for a tenant (cached 3 min).
 */
async function getTenantSpinConfig(tenantId) {
  if (!tenantId) return {};
  return cache.getOrSet(tenantKey(tenantId, 'spin', 'config'), async () => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, settingsJson: true }
  });
  if (!tenant) return {};
  let settings = {};
  try { settings = typeof tenant.settingsJson === 'string' ? JSON.parse(tenant.settingsJson) : (tenant.settingsJson || {}); } catch {}
  return {
    spinAuthKey: settings?.spinAuthKey || '',
    spinTpn: settings?.spinTpn || '',
    spinMerchantNumber: settings?.spinMerchantNumber || 1,
    spinCallbackUrl: settings?.spinCallbackUrl || '',
    spinProxyTimeout: settings?.spinProxyTimeout || 120,
    spinSandbox: settings?.spinSandbox !== false,
  };
  }, 3 * 60 * 1000); // cache 3 min
}

export const paymentGatewayService = {
  /**
   * Charge a reservation/trip via SPIn terminal.
   */
  async chargeReservation({ reservationId, amount, tenantId, actorUserId }) {
    const config = await getTenantSpinConfig(tenantId);
    const referenceId = `RES-${reservationId?.slice(-8)}-${Date.now().toString(36)}`;

    logger.info('SPIn charge initiated', { reservationId, amount, referenceId });

    const result = await spinClient.sale({
      amount,
      referenceId,
      paymentType: 'Credit',
      invoiceNumber: reservationId,
      customFields: { reservationId, actorUserId: actorUserId || '' },
    }, config);

    const normalized = spinClient.normalizeResponse(result);

    // Log payment attempt
    logger.info('SPIn charge result', {
      reservationId, referenceId,
      approved: normalized.approved,
      statusCode: normalized.statusCode,
      authCode: normalized.authCode,
      last4: normalized.cardData?.last4 || '',
    });

    return {
      ...normalized,
      reservationId,
      referenceId,
      amount,
      gateway: 'SPIN',
    };
  },

  /**
   * Place an auth hold (security deposit).
   */
  async authHold({ reservationId, amount, tenantId }) {
    const config = await getTenantSpinConfig(tenantId);
    const referenceId = `AUTH-${reservationId?.slice(-8)}-${Date.now().toString(36)}`;

    const result = await spinClient.auth({
      amount,
      referenceId,
      paymentType: 'Credit',
      invoiceNumber: reservationId,
    }, config);

    return {
      ...spinClient.normalizeResponse(result),
      reservationId,
      referenceId,
      amount,
      gateway: 'SPIN',
      holdType: 'AUTH',
    };
  },

  /**
   * Capture a previously authorized hold.
   */
  async captureHold({ referenceId, amount, tenantId }) {
    const config = await getTenantSpinConfig(tenantId);
    const result = await spinClient.capture({ referenceId, amount }, config);
    return { ...spinClient.normalizeResponse(result), referenceId, gateway: 'SPIN' };
  },

  /**
   * Void a transaction.
   */
  async voidTransaction({ referenceId, tenantId }) {
    const config = await getTenantSpinConfig(tenantId);
    const result = await spinClient.void({ referenceId }, config);
    return { ...spinClient.normalizeResponse(result), referenceId, gateway: 'SPIN' };
  },

  /**
   * Refund to card.
   */
  async refund({ amount, referenceId, tenantId }) {
    const config = await getTenantSpinConfig(tenantId);
    const ref = referenceId || `REF-${Date.now().toString(36)}`;
    const result = await spinClient.refund({ amount, referenceId: ref, paymentType: 'Credit' }, config);
    return { ...spinClient.normalizeResponse(result), referenceId: ref, amount, gateway: 'SPIN' };
  },

  /**
   * Tokenize a card for future use (card-on-file).
   */
  async tokenizeCard({ tenantId }) {
    const config = await getTenantSpinConfig(tenantId);
    const referenceId = `TOK-${Date.now().toString(36)}`;
    const result = await spinClient.getCard({ referenceId }, config);
    const normalized = spinClient.normalizeResponse(result);
    return {
      ...normalized,
      referenceId,
      gateway: 'SPIN',
      tokenSaved: !!normalized.token,
    };
  },

  /**
   * Check terminal connection.
   */
  async checkTerminal({ tenantId }) {
    const config = await getTenantSpinConfig(tenantId);
    try {
      const result = await spinClient.terminalStatus(config);
      return { connected: true, result, gateway: 'SPIN' };
    } catch (err) {
      return { connected: false, error: err.message, gateway: 'SPIN' };
    }
  },

  /**
   * Settle/batch close.
   */
  async settleBatch({ tenantId }) {
    const config = await getTenantSpinConfig(tenantId);
    const result = await spinClient.settle(config);
    return { ...spinClient.normalizeResponse(result), gateway: 'SPIN' };
  },

  /**
   * Get summary report.
   */
  async getSummaryReport({ tenantId }) {
    const config = await getTenantSpinConfig(tenantId);
    return spinClient.summaryReport(config);
  },

  /**
   * Charge a customer's saved Dejavoo card-on-file (card-not-present).
   * Round 20 — for post-rental charges (tolls, late fees, damage).
   *
   * Looks up the customer's dejavooIposToken, resolves an active terminal
   * for the tenant, calls saleWithToken (no terminal interaction needed),
   * and persists a DejavooTransaction row of type=SALE with
   * `cardNotPresent: true` (encoded in customLabel + requestJson).
   *
   * @param {object} args
   * @param {string} args.customerId
   * @param {number} args.amount         — in DOLLARS (we convert to cents for the row)
   * @param {string} [args.reservationId] — links the tx to a reservation
   * @param {string} [args.label]        — human-readable description
   * @param {string} [args.tenantId]     — derived from customer if absent
   * @param {string} [args.actorUserId]
   * @returns {Promise<object>}
   */
  async chargeCardOnFileViaDejavoo({
    customerId, amount, reservationId, label, tenantId, actorUserId,
  } = {}) {
    if (!customerId) throw new ValidationError('customerId is required');
    if (!amount || Number(amount) <= 0) {
      throw new ValidationError('amount must be > 0');
    }
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true, tenantId: true, firstName: true, lastName: true,
        dejavooIposToken: true, dejavooCardLast4: true, dejavooCardBrand: true,
      },
    });
    if (!customer) {
      throw new ValidationError(`Customer ${customerId} not found`);
    }
    if (!customer.dejavooIposToken) {
      throw new ValidationError(
        `Customer ${customerId} has no Dejavoo card-on-file. ` +
        `They must complete an in-person checkout via the P1 terminal first.`
      );
    }
    const effectiveTenantId = tenantId || customer.tenantId;
    if (!effectiveTenantId) {
      throw new ValidationError('tenantId required (customer has no tenantId)');
    }

    // Resolve an active terminal for the tenant + decrypt authKey
    const terminal = await prisma.dejavooTerminal.findFirst({
      where: { tenantId: effectiveTenantId, status: 'ACTIVE' },
      orderBy: { lastSeenAt: 'desc' },
    });
    if (!terminal) {
      throw new ValidationError(
        `No active Dejavoo terminal for tenant ${effectiveTenantId}`
      );
    }
    let authKey = terminal.authKeyEnc || '';
    if (authKey.startsWith('enc:v1:')) {
      const { decrypt } = await import('../../lib/integration-crypto.js');
      authKey = decrypt(authKey.slice('enc:v1:'.length));
    }
    const tenantConfig = {
      spinAuthKey: authKey,
      spinTpn: terminal.tpn,
      spinMerchantNumber: terminal.merchantNumber || 1,
      spinSandbox: terminal.sandbox !== false,
      spinCallbackUrl: terminal.callbackUrl || process.env.SPIN_CALLBACK_URL || '',
    };

    const amountCents = Math.round(Number(amount) * 100);
    const refId = `CNP-${customer.id.slice(-8)}-${Date.now().toString(36)}`.slice(0, 50);
    const txLabel = label || `Card-not-present charge for ${customer.firstName || ''} ${customer.lastName || ''}`.trim();

    // Pre-write the DejavooTransaction row so a crash mid-call leaves audit
    const tx = await prisma.dejavooTransaction.create({
      data: {
        tenantId: effectiveTenantId,
        terminalId: terminal.id,
        reservationId: reservationId || null,
        type: 'SALE',
        referenceId: refId,
        amountCents,
        invoiceNumber: reservationId || null,
        customLabel: `${txLabel} [CNP]`,
        approved: false,
        requestJson: {
          cardNotPresent: true,
          customerId: customer.id,
          last4: customer.dejavooCardLast4,
          brand: customer.dejavooCardBrand,
          actorUserId: actorUserId || null,
        },
        statusCode: 'PENDING',
      },
    });

    let normalized = null;
    let raw = null;
    try {
      raw = await spinClient.saleWithToken({
        amount: Number(amount),
        referenceId: refId,
        iposToken: customer.dejavooIposToken,
        invoiceNumber: reservationId,
        customFields: { customerId: customer.id, label: txLabel },
      }, tenantConfig);
      normalized = spinClient.normalizeResponse(raw);
      await prisma.dejavooTransaction.update({
        where: { id: tx.id },
        data: {
          responseJson: normalized,
          rawResponse: raw,
          statusCode: normalized.statusCode,
          approved: !!normalized.approved,
          authCode: normalized.authCode || null,
          iposToken: normalized.iposToken || null,
          cardLast4: normalized.cardData?.last4 || customer.dejavooCardLast4,
          cardBrand: normalized.cardData?.cardType || customer.dejavooCardBrand,
          errorMessage: normalized.approved ? null : (normalized.message || normalized.detailedMessage || null),
          completedAt: new Date(),
        },
      });
    } catch (err) {
      await prisma.dejavooTransaction.update({
        where: { id: tx.id },
        data: {
          statusCode: err?.spinStatusCode || 'ERROR',
          errorMessage: err?.message || 'unknown error',
          completedAt: new Date(),
        },
      });
      throw err;
    }

    // If the response includes a refreshed token (token rotation), update Customer
    if (normalized.iposToken && normalized.iposToken !== customer.dejavooIposToken) {
      await prisma.customer.update({
        where: { id: customer.id },
        data: {
          dejavooIposToken: normalized.iposToken,
          dejavooCardCapturedAt: new Date(),
        },
      });
    }

    return {
      approved: !!normalized.approved,
      statusCode: normalized.statusCode,
      message: normalized.message,
      authCode: normalized.authCode,
      cardLast4: normalized.cardData?.last4 || customer.dejavooCardLast4,
      cardBrand: normalized.cardData?.cardType || customer.dejavooCardBrand,
      referenceId: refId,
      amountCents,
      transactionId: tx.id,
      gateway: 'DEJAVOO',
      cardNotPresent: true,
    };
  },
};
