import { prisma } from '../../lib/prisma.js';

import {
  MODULE_KEYS,
  MODULE_LABELS,
  getTenantModuleConfig,
  updateTenantModuleConfig,
  getEditableModuleAccessForUser,
  updateStoredUserModuleConfig
} from '../../lib/module-access.js';

const DEFAULTS = {
  companyName: 'Ride Fleet',
  companyAddress: 'San Juan, Puerto Rico',
  companyPhone: '(787) 000-0000',
  companyLogoUrl: '',
  termsText:
    'Renter acknowledges responsibility for the vehicle, traffic violations, tolls, and damages while in possession. Charges shown are estimates and may be adjusted according to final inspection, fuel level, mileage, fees, taxes, and applicable policy terms.',
  returnInstructionsText:
    '1) Return vehicle clean and with agreed fuel level. 2) Report damage before handoff. 3) Return keys/documents to staff. 4) After-hours returns may include additional fees.',
  agreementHtmlTemplate: ''
};

const ALLOWED_KEYS = Object.keys(DEFAULTS);

const DEFAULT_EMAIL_TEMPLATES = {
  requestSignatureSubject: 'Signature Request - Reservation {{reservationNumber}}',
  requestSignatureBody: 'Hello {{customerName}},\n\nPlease sign your rental documents using this secure link:\n{{link}}\n\nThank you.',
  requestSignatureHtml: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">Hello {{customerName}},<br/><br/>Please sign your rental documents using this secure link:<br/><a href="{{link}}">{{link}}</a><br/><br/>This link expires at {{expiresAt}}.<br/><br/>Thank you,<br/>{{companyName}}</div>',
  requestCustomerInfoSubject: 'Customer Information Request - Reservation {{reservationNumber}}',
  requestCustomerInfoBody: 'Hello {{customerName}},\n\nPlease complete your pre-check-in information here:\n{{link}}\n\nThank you.',
  requestCustomerInfoHtml: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">Hello {{customerName}},<br/><br/>Please complete your pre-check-in information here:<br/><a href="{{link}}">{{link}}</a><br/><br/>This link expires at {{expiresAt}}.<br/><br/>Thank you,<br/>{{companyName}}</div>',
  requestPaymentSubject: 'Payment Request - Reservation {{reservationNumber}}',
  requestPaymentBody: 'Hello {{customerName}},\n\nPlease complete payment using this secure link:\n{{link}}\n\nThank you.',
  requestPaymentHtml: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">Hello {{customerName}},<br/><br/>Please complete payment using this secure link:<br/><a href="{{link}}">{{link}}</a><br/><br/>This link expires at {{expiresAt}}.<br/><br/>Thank you,<br/>{{companyName}}</div>',
  returnReceiptSubject: 'Return Receipt - Reservation {{reservationNumber}}',
  returnReceiptBody: 'Hello {{customerName}},\n\nYour rental agreement has been closed.\nReservation: {{reservationNumber}}\nTotal Paid: {{paidAmount}}\nBalance: {{balance}}\n\nThank you for choosing us.',
  returnReceiptHtml: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">Hello {{customerName}},<br/><br/>Your rental agreement has been closed.<br/>Reservation: <b>{{reservationNumber}}</b><br/>Total Paid: <b>${{paidAmount}}</b><br/>Balance: <b>${{balance}}</b><br/><br/>Thank you for choosing {{companyName}}.</div>',
  rentalReviewRequestSubject: 'How Was Your Rental Experience? - Reservation {{reservationNumber}}',
  rentalReviewRequestBody: 'Hello {{customerName}},\n\nThank you for renting with {{companyName}}. Your reservation {{reservationNumber}} has been checked in successfully.\n\nWe would love to hear about your experience. Please reply to this email or leave your review using your preferred review channel.\n\nThank you again,\n{{companyName}}',
  rentalReviewRequestHtml: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">Hello {{customerName}},<br/><br/>Thank you for renting with {{companyName}}. Your reservation <b>{{reservationNumber}}</b> has been checked in successfully.<br/><br/>We would love to hear about your experience. Please reply to this email or leave your review using your preferred review channel.<br/><br/>Thank you again,<br/>{{companyName}}</div>',
  reservationDetailSubject: 'Reservation Details - {{reservationNumber}}',
  reservationDetailBody: 'Hello {{customerName}},\n\nHere are your reservation details.\nReservation #: {{reservationNumber}}\nStatus: {{status}}\nPickup: {{pickupAt}}\nReturn: {{returnAt}}\nPickup Location: {{pickupLocation}}\nReturn Location: {{returnLocation}}\nVehicle: {{vehicle}}\nDaily Rate: {{dailyRate}}\nEstimated Total: {{estimatedTotal}}\n\nThank you.',
  reservationDetailHtml: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">Hello {{customerName}},<br/><br/>Here are your reservation details:<br/>Reservation #: <b>{{reservationNumber}}</b><br/>Status: {{status}}<br/>Pickup: {{pickupAt}}<br/>Return: {{returnAt}}<br/>Pickup Location: {{pickupLocation}}<br/>Return Location: {{returnLocation}}<br/>Vehicle: {{vehicle}}<br/>Daily Rate: {{dailyRate}}<br/>Estimated Total: {{estimatedTotal}}<br/><br/>Thank you,<br/>{{companyName}}</div>',
  agreementEmailSubject: 'Your Rental Agreement {{agreementNumber}}',
  agreementEmailHtml: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">Hello {{customerName}},<br/><br/>Attached is your rental agreement <b>{{agreementNumber}}</b> for reservation <b>{{reservationNumber}}</b>.<br/><br/>Total: <b>${{total}}</b><br/>Amount Paid: <b>${{amountPaid}}</b><br/>Amount Due: <b>${{amountDue}}</b><br/><br/><a href="{{portalLink}}">Open Portal</a><br/><br/>Thank you,<br/>{{companyName}}</div>'
};

const DEFAULT_RESERVATION_OPTIONS = {
  autoAssignVehicleFromType: false,
  tenantTimeZone: 'America/Puerto_Rico'
};

function defaultPaymentGatewayConfig() {
  return {
    gateway: String(process.env.PAYMENT_GATEWAY || 'authorizenet').toLowerCase(),
    label: 'Default Payment Gateway',
    authorizenet: {
      enabled: !!(process.env.AUTHNET_API_LOGIN_ID && process.env.AUTHNET_TRANSACTION_KEY),
      environment: String(process.env.AUTHNET_ENV || 'sandbox').toLowerCase(),
      loginId: String(process.env.AUTHNET_API_LOGIN_ID || ''),
      transactionKey: String(process.env.AUTHNET_TRANSACTION_KEY || ''),
      clientKey: String(process.env.AUTHNET_CLIENT_KEY || ''),
      signatureKey: String(process.env.AUTHNET_SIGNATURE_KEY || '')
    },
    stripe: {
      enabled: !!process.env.STRIPE_SECRET_KEY,
      secretKey: String(process.env.STRIPE_SECRET_KEY || ''),
      publishableKey: String(process.env.STRIPE_PUBLISHABLE_KEY || ''),
      webhookSecret: String(process.env.STRIPE_WEBHOOK_SECRET || '')
    },
    square: {
      enabled: !!(process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_LOCATION_ID),
      environment: String(process.env.SQUARE_ENV || 'production').toLowerCase(),
      accessToken: String(process.env.SQUARE_ACCESS_TOKEN || ''),
      applicationId: String(process.env.SQUARE_APPLICATION_ID || ''),
      locationId: String(process.env.SQUARE_LOCATION_ID || '')
    }
  };
}

function scopedKey(baseKey, scope = {}) {
  return scope?.tenantId ? `tenant:${scope.tenantId}:${baseKey}` : baseKey;
}

export const settingsService = {
  async getTenantModuleAccess(scope = {}) {
    return {
      modules: MODULE_KEYS.map((key) => ({ key, label: MODULE_LABELS[key] || key })),
      config: await getTenantModuleConfig(scope?.tenantId || null)
    };
  },

  async updateTenantModuleAccess(payload = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    return {
      modules: MODULE_KEYS.map((key) => ({ key, label: MODULE_LABELS[key] || key })),
      config: await updateTenantModuleConfig(scope.tenantId, payload || {})
    };
  },

  async getUserModuleAccess(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        tenantId: true,
        hostProfile: { select: { id: true } }
      }
    });
    if (!user) throw new Error('User not found');
    const access = await getEditableModuleAccessForUser({
      id: user.id,
      role: user.role,
      tenantId: user.tenantId || null,
      hostProfileId: user.hostProfile?.id || null
    });
    return {
      modules: MODULE_KEYS.map((key) => ({ key, label: MODULE_LABELS[key] || key })),
      config: access.config,
      tenantConfig: access.tenantConfig,
      storedConfig: access.storedConfig
    };
  },

  async updateUserModuleAccess(userId, payload = {}) {
    return {
      modules: MODULE_KEYS.map((key) => ({ key, label: MODULE_LABELS[key] || key })),
      config: await updateStoredUserModuleConfig(userId, payload || {})
    };
  },

  async getEmailTemplates(scope = {}) {
    const row = await prisma.appSetting.findUnique({ where: { key: scopedKey('emailTemplates', scope) } });
    if (!row?.value) return { ...DEFAULT_EMAIL_TEMPLATES };
    try {
      const parsed = JSON.parse(row.value);
      return { ...DEFAULT_EMAIL_TEMPLATES, ...(parsed || {}) };
    } catch {
      return { ...DEFAULT_EMAIL_TEMPLATES };
    }
  },

  async updateEmailTemplates(payload = {}, scope = {}) {
    const next = { ...DEFAULT_EMAIL_TEMPLATES, ...(payload || {}) };
    const key = scopedKey('emailTemplates', scope);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) }
    });
    return next;
  },

  async getInsurancePlans(scope = {}) {
    const row = await prisma.appSetting.findUnique({ where: { key: scopedKey('insurancePlans', scope) } });
    if (!row?.value) return [];
    try {
      const parsed = JSON.parse(row.value);
      return Array.isArray(parsed)
        ? parsed.map((plan) => ({
            ...plan,
            taxable: !!plan?.taxable,
            commissionValueType: plan?.commissionValueType || null,
            commissionPercentValue: plan?.commissionPercentValue ?? null,
            commissionFixedAmount: plan?.commissionFixedAmount ?? null
          }))
        : [];
    } catch {
      return [];
    }
  },

  async updateInsurancePlans(plans = [], scope = {}) {
    const payload = (Array.isArray(plans) ? plans : []).map((plan) => ({
      ...plan,
      taxable: !!plan?.taxable,
      commissionValueType: plan?.commissionValueType || null,
      commissionPercentValue: plan?.commissionPercentValue === '' || plan?.commissionPercentValue == null ? null : Number(plan.commissionPercentValue),
      commissionFixedAmount: plan?.commissionFixedAmount === '' || plan?.commissionFixedAmount == null ? null : Number(plan.commissionFixedAmount)
    }));
    const key = scopedKey('insurancePlans', scope);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(payload) },
      update: { value: JSON.stringify(payload) }
    });
    return payload;
  },

  async getReservationOptions(scope = {}) {
    const row = await prisma.appSetting.findUnique({ where: { key: scopedKey('reservationOptions', scope) } });
    if (!row?.value) return { ...DEFAULT_RESERVATION_OPTIONS };
    try {
      const parsed = JSON.parse(row.value);
      return { ...DEFAULT_RESERVATION_OPTIONS, ...(parsed || {}) };
    } catch {
      return { ...DEFAULT_RESERVATION_OPTIONS };
    }
  },

  async updateReservationOptions(payload = {}, scope = {}) {
    const next = {
      ...DEFAULT_RESERVATION_OPTIONS,
      ...(payload || {}),
      autoAssignVehicleFromType: !!payload?.autoAssignVehicleFromType,
      tenantTimeZone: String(payload?.tenantTimeZone || DEFAULT_RESERVATION_OPTIONS.tenantTimeZone).trim() || DEFAULT_RESERVATION_OPTIONS.tenantTimeZone
    };
    const key = scopedKey('reservationOptions', scope);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) }
    });
    return next;
  },

  async getPaymentGatewayConfig(scope = {}) {
    const defaults = defaultPaymentGatewayConfig();
    const row = await prisma.appSetting.findUnique({ where: { key: scopedKey('paymentGatewayConfig', scope) } });
    if (!row?.value) return defaults;
    try {
      const parsed = JSON.parse(row.value);
      return {
        ...defaults,
        ...(parsed || {}),
        authorizenet: {
          ...defaults.authorizenet,
          ...(parsed?.authorizenet || {})
        },
        stripe: {
          ...defaults.stripe,
          ...(parsed?.stripe || {})
        },
        square: {
          ...defaults.square,
          ...(parsed?.square || {})
        }
      };
    } catch {
      return defaults;
    }
  },

  async updatePaymentGatewayConfig(payload = {}, scope = {}) {
    const defaults = defaultPaymentGatewayConfig();
    const next = {
      ...defaults,
      ...(payload || {}),
      gateway: String(payload?.gateway || defaults.gateway).trim().toLowerCase(),
      label: String(payload?.label || defaults.label).trim(),
      authorizenet: {
        ...defaults.authorizenet,
        ...(payload?.authorizenet || {}),
        enabled: payload?.authorizenet?.enabled !== false,
        environment: String(payload?.authorizenet?.environment || defaults.authorizenet.environment).trim().toLowerCase(),
        loginId: String(payload?.authorizenet?.loginId || '').trim(),
        transactionKey: String(payload?.authorizenet?.transactionKey || '').trim(),
        clientKey: String(payload?.authorizenet?.clientKey || '').trim(),
        signatureKey: String(payload?.authorizenet?.signatureKey || '').trim()
      },
      stripe: {
        ...defaults.stripe,
        ...(payload?.stripe || {}),
        enabled: !!payload?.stripe?.enabled,
        secretKey: String(payload?.stripe?.secretKey || '').trim(),
        publishableKey: String(payload?.stripe?.publishableKey || '').trim(),
        webhookSecret: String(payload?.stripe?.webhookSecret || '').trim()
      },
      square: {
        ...defaults.square,
        ...(payload?.square || {}),
        enabled: !!payload?.square?.enabled,
        environment: String(payload?.square?.environment || defaults.square.environment).trim().toLowerCase(),
        accessToken: String(payload?.square?.accessToken || '').trim(),
        applicationId: String(payload?.square?.applicationId || '').trim(),
        locationId: String(payload?.square?.locationId || '').trim()
      }
    };
    const key = scopedKey('paymentGatewayConfig', scope);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) }
    });
    return next;
  },

  async getRentalAgreementConfig(scope = {}) {
    const rows = await prisma.appSetting.findMany({ where: { key: { in: ALLOWED_KEYS.map((k) => scopedKey(k, scope)) } } });
    const map = Object.fromEntries(
      rows.map((r) => [String(r.key || '').replace(/^tenant:[^:]+:/, ''), r.value])
    );
    return { ...DEFAULTS, ...map };
  },

  async updateRentalAgreementConfig(payload = {}, scope = {}) {
    const updates = Object.entries(payload).filter(([k]) => ALLOWED_KEYS.includes(k));
    if (!updates.length) return this.getRentalAgreementConfig(scope);

    for (const [baseKey, value] of updates) {
      const key = scopedKey(baseKey, scope);
      await prisma.appSetting.upsert({
        where: { key },
        create: { key, value: String(value ?? '') },
        update: { value: String(value ?? '') }
      });
    }

    return this.getRentalAgreementConfig(scope);
  }
};
