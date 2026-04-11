/**
 * SMS message templates with variable interpolation.
 * Variables: {{guestName}}, {{reservationNumber}}, {{tripCode}}, {{pickupAt}},
 *            {{returnAt}}, {{pickupLocation}}, {{vehicleLabel}}, {{total}},
 *            {{hostName}}, {{companyName}}
 */

const TEMPLATES = {
  BOOKING_CONFIRMATION: {
    id: 'BOOKING_CONFIRMATION',
    label: 'Booking Confirmation',
    body: 'Hi {{guestName}}! Your reservation {{reservationNumber}} is confirmed. Pickup: {{pickupAt}} at {{pickupLocation}}. Vehicle: {{vehicleLabel}}. Total: {{total}}. — {{companyName}}',
  },
  PICKUP_REMINDER: {
    id: 'PICKUP_REMINDER',
    label: 'Pickup Reminder (24h)',
    body: 'Reminder: Your pickup for reservation {{reservationNumber}} is tomorrow at {{pickupAt}}. Location: {{pickupLocation}}. Please have your ID and payment ready. — {{companyName}}',
  },
  PICKUP_DAY: {
    id: 'PICKUP_DAY',
    label: 'Pickup Day',
    body: 'Today is your pickup day! Reservation {{reservationNumber}} — {{pickupLocation}} at {{pickupAt}}. See you soon! — {{companyName}}',
  },
  RETURN_REMINDER: {
    id: 'RETURN_REMINDER',
    label: 'Return Reminder (24h)',
    body: 'Reminder: Your vehicle for reservation {{reservationNumber}} is due back tomorrow at {{returnAt}}. Please return with the same fuel level. — {{companyName}}',
  },
  CHECKOUT_COMPLETE: {
    id: 'CHECKOUT_COMPLETE',
    label: 'Checkout Complete',
    body: 'Your vehicle has been checked out! Reservation {{reservationNumber}}. Drive safe and enjoy your trip. Return by {{returnAt}}. — {{companyName}}',
  },
  CHECKIN_COMPLETE: {
    id: 'CHECKIN_COMPLETE',
    label: 'Check-in Complete',
    body: 'Your vehicle has been returned. Thank you for choosing {{companyName}}! Reservation {{reservationNumber}}. Receipt will be emailed shortly.',
  },
  PAYMENT_REQUEST: {
    id: 'PAYMENT_REQUEST',
    label: 'Payment Request',
    body: 'Hi {{guestName}}, please complete your payment of {{total}} for reservation {{reservationNumber}}. Check your email for the payment link. — {{companyName}}',
  },
  TRIP_CHAT_INVITE: {
    id: 'TRIP_CHAT_INVITE',
    label: 'Trip Chat Invite',
    body: 'Hi {{guestName}}! Your trip chat with {{hostName}} is ready. Coordinate pickup details here: {{chatLink}} — {{companyName}}',
  },
  CUSTOM: {
    id: 'CUSTOM',
    label: 'Custom Message',
    body: '',
  },
};

/**
 * Interpolate template variables.
 */
function interpolate(template, variables = {}) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] !== undefined && variables[key] !== null ? String(variables[key]) : match;
  });
}

export function getTemplates() {
  return Object.values(TEMPLATES);
}

export function getTemplate(id) {
  return TEMPLATES[String(id || '').toUpperCase()] || null;
}

export function renderTemplate(templateId, variables = {}) {
  const template = getTemplate(templateId);
  if (!template) throw new Error(`SMS template not found: ${templateId}`);
  return interpolate(template.body, variables);
}

export function renderCustom(body, variables = {}) {
  return interpolate(body, variables);
}
