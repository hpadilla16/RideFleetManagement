import { ValidationError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { sendSms } from './sms-providers.js';
import { getTemplates, getTemplate, renderTemplate, renderCustom } from './sms-templates.js';
import logger from '../../lib/logger.js';
import { cache } from '../../lib/cache.js';
import { tenantKey } from '../../lib/cache/tenantKey.js';
import { resolveTenantProviderCredential } from '../../lib/tenant-provider-credential.js';

/**
 * The tenant's own SMS credentials for a provider, and the platform's, as two
 * whole sets. `secret` is the one field that gets masked into the WARN.
 *
 * Kept as SETS, not per-field, because that is where the SPIn wrong-merchant
 * bug lived: mixing a tenant's accountSid with the platform's authToken is not
 * a partially-working config, it is a request signed by the wrong account.
 */
function smsCredentialSets(provider, settings = {}) {
  if (provider === 'twilio') {
    return {
      tenant: { accountSid: settings.smsAccountSid || '', authToken: settings.smsAuthToken || '' },
      platform: {
        accountSid: process.env.TWILIO_ACCOUNT_SID || '',
        authToken: process.env.TWILIO_AUTH_TOKEN || '',
      },
      secretField: 'authToken',
    };
  }
  if (provider === 'plivo') {
    return {
      tenant: { authId: settings.smsAuthId || '', authToken: settings.smsAuthToken || '' },
      platform: {
        authId: process.env.PLIVO_AUTH_ID || '',
        authToken: process.env.PLIVO_AUTH_TOKEN || '',
      },
      secretField: 'authToken',
    };
  }
  // telnyx (the default) — single-field credential.
  return {
    tenant: { apiKey: settings.smsApiKey || '' },
    platform: { apiKey: process.env.TELNYX_API_KEY || '' },
    secretField: 'apiKey',
  };
}

const isComplete = (set) => Object.values(set).every((v) => !!String(v || '').trim());
const isPartial = (set) => !isComplete(set) && Object.values(set).some((v) => !!String(v || '').trim());

/**
 * Resolve SMS config for a tenant.
 *
 * 2026-08-27: this used to be six `settings.x || process.env.Y || ''` lines, so
 * a tenant that had configured no SMS at all sent its guests' messages through
 * the PLATFORM's Telnyx/Twilio/Plivo account — the platform's number on the
 * recipient's phone, the platform's bill, and the guest's phone number handed
 * to a carrier account that tenant never agreed to. Same defect shape as the
 * SPIn terminal and the Anthropic OCR key; resolution now goes through
 * lib/tenant-provider-credential.js, which fails closed by default and WARNs
 * by name when a tenant is deliberately opted in.
 */
async function getTenantSmsConfig(tenantId) {
  if (!tenantId) return null;
  return cache.getOrSet(tenantKey(tenantId, 'sms', 'config'), async () => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, settingsJson: true }
  });
  if (!tenant) return null;
  let settings = {};
  try { settings = typeof tenant.settingsJson === 'string' ? JSON.parse(tenant.settingsJson) : (tenant.settingsJson || {}); } catch {}

  const provider = settings.smsProvider || process.env.SMS_PROVIDER || 'telnyx';
  const companyName = tenant.name || 'Ride Fleet';

  const sets = smsCredentialSets(provider, settings);
  const decision = resolveTenantProviderCredential({
    tenantId,
    feature: 'sms',
    tenantName: companyName,
    // The masked value in the WARN is the real secret of whichever set wins,
    // so the log line identifies the account without ever printing it.
    tenantCredential: isComplete(sets.tenant) ? sets.tenant[sets.secretField] : '',
    platformCredential: isComplete(sets.platform) ? sets.platform[sets.secretField] : '',
    tenantConfigPartial: isPartial(sets.tenant),
    tenantOptIn: !!settings.smsAllowPlatformKeyFallback,
  });

  const credentials = decision.source === 'TENANT' ? sets.tenant
    : decision.source === 'PLATFORM' ? sets.platform
      : {};

  // The FROM number follows the credentials it was issued against. A tenant's
  // own Telnyx key paired with the platform's number was never a working
  // config — the carrier rejects a number that is not on the account — it just
  // failed at the provider instead of here.
  const fromNumber = decision.source === 'PLATFORM'
    ? (settings.smsFromNumber || process.env.SMS_FROM_NUMBER || '')
    : (settings.smsFromNumber || '');

  return {
    provider,
    fromNumber,
    companyName,
    credentials,
    credentialSource: decision.source,
    enabled: !!fromNumber && isComplete(credentials) && Object.keys(credentials).length > 0,
  };
  }, 3 * 60 * 1000); // cache 3 min
}

/**
 * Build variables from a reservation for template interpolation.
 */
function buildReservationVariables(reservation, config) {
  return {
    guestName: [reservation.customer?.firstName, reservation.customer?.lastName].filter(Boolean).join(' ') || 'Guest',
    reservationNumber: reservation.reservationNumber || '',
    tripCode: reservation.carSharingTrip?.tripCode || '',
    pickupAt: reservation.pickupAt ? new Date(reservation.pickupAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '',
    returnAt: reservation.returnAt ? new Date(reservation.returnAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '',
    pickupLocation: reservation.pickupLocation?.name || '',
    vehicleLabel: reservation.vehicle ? `${reservation.vehicle.year || ''} ${reservation.vehicle.make || ''} ${reservation.vehicle.model || ''}`.trim() : (reservation.vehicleType?.name || 'Vehicle'),
    total: reservation.estimatedTotal ? `$${Number(reservation.estimatedTotal).toFixed(2)}` : '',
    hostName: reservation.carSharingTrip?.hostProfile?.displayName || '',
    companyName: config?.companyName || 'Ride Fleet',
  };
}

export const smsService = {
  /**
   * List available templates.
   */
  getTemplates() {
    return getTemplates();
  },

  /**
   * Send an SMS for a reservation using a template.
   */
  async sendForReservation({ reservationId, templateId, customBody, tenantId }) {
    const config = await getTenantSmsConfig(tenantId);
    if (!config?.enabled) throw new ValidationError('SMS is not configured for this tenant. Set smsProvider, smsFromNumber, and API credentials in tenant settings.');

    const reservation = await prisma.reservation.findFirst({
      where: { id: reservationId, ...(tenantId ? { tenantId } : {}) },
      include: {
        customer: { select: { firstName: true, lastName: true, phone: true } },
        pickupLocation: { select: { name: true } },
        vehicle: { select: { year: true, make: true, model: true } },
        vehicleType: { select: { name: true } },
        carSharingTrip: { select: { tripCode: true, hostProfile: { select: { displayName: true } } } }
      }
    });
    if (!reservation) throw new ValidationError('Reservation not found');

    const phone = reservation.customer?.phone;
    if (!phone) throw new ValidationError('Customer has no phone number on file');

    const variables = buildReservationVariables(reservation, config);
    const body = customBody
      ? renderCustom(customBody, variables)
      : renderTemplate(templateId || 'BOOKING_CONFIRMATION', variables);

    const result = await sendSms({
      to: phone,
      from: config.fromNumber,
      body,
      provider: config.provider,
      credentials: config.credentials,
    });

    logger.info('SMS sent for reservation', {
      reservationId,
      templateId: templateId || 'CUSTOM',
      provider: config.provider,
      messageId: result.messageId,
      to: phone.slice(-4),
    });

    return {
      ...result,
      reservationId,
      templateId: templateId || 'CUSTOM',
      bodyPreview: body.slice(0, 100),
    };
  },

  /**
   * Send a custom SMS to any number.
   */
  async sendCustom({ to, body, tenantId }) {
    const config = await getTenantSmsConfig(tenantId);
    if (!config?.enabled) throw new ValidationError('SMS is not configured for this tenant');
    if (!to) throw new ValidationError('Phone number is required');
    if (!body) throw new ValidationError('Message body is required');

    return sendSms({
      to,
      from: config.fromNumber,
      body: String(body).trim().slice(0, 1600),
      provider: config.provider,
      credentials: config.credentials,
    });
  },

  /**
   * Check SMS configuration status for a tenant.
   */
  async getConfig({ tenantId }) {
    const config = await getTenantSmsConfig(tenantId);
    return {
      enabled: !!config?.enabled,
      provider: config?.provider || 'none',
      fromNumber: config?.fromNumber ? `***${config.fromNumber.slice(-4)}` : '',
      companyName: config?.companyName || '',
    };
  },
};

// Test-only surface (same convention as incident-report.service.js). Exposed so
// the Tenant.settingsJson drift guard can call the resolver directly instead of
// reaching it through a send path that needs a provider.
export const __test = { getTenantSmsConfig };
