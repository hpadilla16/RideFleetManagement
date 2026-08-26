import { ValidationError } from '../../lib/errors.js';
import { spinClient } from './spin-client.js';
import logger from '../../lib/logger.js';
import { resolveTenantTerminalConfig, toSpinClientConfig } from './tenant-terminal-config.js';

/**
 * Resolve SPIn config for a tenant.
 *
 * 2026-08-26 — this used to read `spinAuthKey` / `spinTpn` off
 * Tenant.settingsJson, a home NOTHING has ever written to. It was a second,
 * divergent answer to "which terminal does this tenant charge through", which
 * is precisely how the wrong-merchant bug comes back. It now delegates to the
 * shared resolver (AppSetting `tenant:<id>:paymentGatewayConfig`, the one the
 * Settings page actually writes), so this module and the checkout wizard can
 * never disagree about whose merchant account gets the money.
 *
 * These routes have no frontend caller today, so no fail-closed gate is added
 * here — that belongs to the live charge path (spin-charge.service). The
 * resolver's own precedence and its loud env-fallback warning still apply.
 */
async function getTenantSpinConfig(tenantId) {
  if (!tenantId) return {};
  return toSpinClientConfig(await resolveTenantTerminalConfig(tenantId));
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
};

// Test-only surface (same convention as incident-report.service.js). Exposed so
// the Tenant.settingsJson drift guard can call the resolver directly instead of
// reaching it through a charge path that needs a terminal.
export const __test = { getTenantSpinConfig };
