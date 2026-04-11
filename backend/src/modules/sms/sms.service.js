import { ValidationError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { sendSms } from './sms-providers.js';
import { getTemplates, getTemplate, renderTemplate, renderCustom } from './sms-templates.js';
import logger from '../../lib/logger.js';
import { cache } from '../../lib/cache.js';

/**
 * Resolve SMS config for a tenant.
 */
async function getTenantSmsConfig(tenantId) {
  if (!tenantId) return null;
  return cache.getOrSet(`sms:config:${tenantId}`, async () => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, settingsJson: true }
  });
  if (!tenant) return null;
  let settings = {};
  try { settings = typeof tenant.settingsJson === 'string' ? JSON.parse(tenant.settingsJson) : (tenant.settingsJson || {}); } catch {}

  const provider = settings.smsProvider || process.env.SMS_PROVIDER || 'telnyx';
  const fromNumber = settings.smsFromNumber || process.env.SMS_FROM_NUMBER || '';
  const companyName = tenant.name || 'Ride Fleet';

  const credentials = {};
  if (provider === 'telnyx') {
    credentials.apiKey = settings.smsApiKey || process.env.TELNYX_API_KEY || '';
  } else if (provider === 'twilio') {
    credentials.accountSid = settings.smsAccountSid || process.env.TWILIO_ACCOUNT_SID || '';
    credentials.authToken = settings.smsAuthToken || process.env.TWILIO_AUTH_TOKEN || '';
  } else if (provider === 'plivo') {
    credentials.authId = settings.smsAuthId || process.env.PLIVO_AUTH_ID || '';
    credentials.authToken = settings.smsAuthToken || process.env.PLIVO_AUTH_TOKEN || '';
  }

  return { provider, fromNumber, companyName, credentials, enabled: !!fromNumber && Object.values(credentials).some(Boolean) };
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
