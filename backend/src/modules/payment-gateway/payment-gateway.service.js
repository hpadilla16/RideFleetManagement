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
 *
 * 2026-09-04 — `locationId` / `registerId` are PASSED THROUGH from the caller,
 * never derived. Deliberately: these routes still have no frontend caller, and
 * adding a reservation→location DB lookup to a dead path would be inventing a
 * money-path read nobody exercises. A tenant on per-location registers calling
 * one of these WITHOUT a location gets the resolver's fail-closed
 * AMBIGUOUS_REGISTER_NO_LOCATION — an empty config, so the operation refuses —
 * rather than a guessed counter. That is the right answer to "charge this, I
 * won't say where".
 */
async function getTenantSpinConfig(tenantId, { locationId = null, registerId = null } = {}) {
  if (!tenantId) return {};
  return toSpinClientConfig(await resolveTenantTerminalConfig(tenantId, { locationId, registerId }));
}

export const paymentGatewayService = {
  /**
   * Charge a reservation/trip via SPIn terminal.
   */
  async chargeReservation({ reservationId, amount, tenantId, actorUserId, locationId = null, registerId = null }) {
    const config = await getTenantSpinConfig(tenantId, { locationId, registerId });
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
  async authHold({ reservationId, amount, tenantId, locationId = null, registerId = null }) {
    const config = await getTenantSpinConfig(tenantId, { locationId, registerId });
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
  async captureHold({ referenceId, amount, tenantId, locationId = null, registerId = null }) {
    const config = await getTenantSpinConfig(tenantId, { locationId, registerId });
    const result = await spinClient.capture({ referenceId, amount }, config);
    return { ...spinClient.normalizeResponse(result), referenceId, gateway: 'SPIN' };
  },

  /**
   * Void a transaction.
   */
  async voidTransaction({ referenceId, amount, paymentType, tenantId, locationId = null, registerId = null }) {
    const config = await getTenantSpinConfig(tenantId, { locationId, registerId });
    // amount is required by the gateway — spinClient.void throws without it
    // rather than sending a call we know is refused (2201, proven live).
    const result = await spinClient.void({ referenceId, amount, paymentType }, config);
    return { ...spinClient.normalizeResponse(result), referenceId, gateway: 'SPIN' };
  },

  /**
   * Refund to card.
   */
  async refund({ amount, referenceId, tenantId, locationId = null, registerId = null }) {
    const config = await getTenantSpinConfig(tenantId, { locationId, registerId });
    const ref = referenceId || `REF-${Date.now().toString(36)}`;
    const result = await spinClient.refund({ amount, referenceId: ref, paymentType: 'Credit' }, config);
    return { ...spinClient.normalizeResponse(result), referenceId: ref, amount, gateway: 'SPIN' };
  },

  /**
   * Tokenize a card for future use (card-on-file).
   */
  async tokenizeCard({ tenantId, locationId = null, registerId = null }) {
    const config = await getTenantSpinConfig(tenantId, { locationId, registerId });
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
  async checkTerminal({ tenantId, locationId = null, registerId = null }) {
    const config = await getTenantSpinConfig(tenantId, { locationId, registerId });
    // No credentials resolved = no device to reach. Say so plainly instead of
    // letting spin-client fall through to whatever the env holds — a health
    // check that quietly probes the PLATFORM terminal and reports "connected"
    // is worse than one that fails.
    if (!config?.spinTpn || !config?.spinAuthKey) {
      return { connected: false, error: 'No terminal resolved for this tenant/location — check Settings → Payment Gateway.', gateway: 'SPIN' };
    }
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
  async settleBatch({ tenantId, locationId = null, registerId = null }) {
    const config = await getTenantSpinConfig(tenantId, { locationId, registerId });
    const result = await spinClient.settle(config);
    return { ...spinClient.normalizeResponse(result), gateway: 'SPIN' };
  },

  /**
   * Get summary report.
   */
  async getSummaryReport({ tenantId, locationId = null, registerId = null }) {
    const config = await getTenantSpinConfig(tenantId, { locationId, registerId });
    return spinClient.summaryReport(config);
  },
};

// Test-only surface (same convention as incident-report.service.js). Exposed so
// the Tenant.settingsJson drift guard can call the resolver directly instead of
// reaching it through a charge path that needs a terminal.
export const __test = { getTenantSpinConfig };
