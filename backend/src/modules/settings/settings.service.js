import { prisma } from '../../lib/prisma.js';

import {
  MODULE_KEYS,
  MODULE_LABELS,
  getTenantModuleConfig,
  updateTenantModuleConfig,
  getEditableModuleAccessForUser,
  updateStoredUserModuleConfig
} from '../../lib/module-access.js';
import { getTenantPlanCatalog, resolveTenantPlanConfig } from '../../lib/tenant-plan-limits.js';

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
  dailyOpsReportSubject: 'Daily Ops Report - {{companyName}} - {{reportStart}} to {{reportEnd}}',
  dailyOpsReportBody: 'Hello team,\n\nHere is the latest daily ops report for {{companyName}}.\nRange: {{reportStart}} to {{reportEnd}} ({{reportDays}} days)\nTenant: {{tenantName}}\nLocation: {{locationName}}\n\nReservations Created: {{reservationsCreated}}\nChecked Out: {{checkedOut}}\nChecked In: {{checkedIn}}\nAvailable Fleet: {{availableFleet}}\nMigration Held: {{migrationHeld}}\nWash Held: {{washHeld}}\nMaintenance Held: {{maintenanceHeld}}\nOut Of Service Held: {{outOfServiceHeld}}\nUtilization: {{utilizationPct}}\nCollected Payments: {{collectedPayments}}\nOpen Balance: {{openBalance}}\n\nFleet Holds:\n{{fleetHoldSummary}}\n\nTop Pickup Locations:\n{{topPickupSummary}}\n\nReservation Status:\n{{statusSummary}}\n\nGenerated by Ride Fleet.',
  dailyOpsReportHtml: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111"><div style="font-size:20px;font-weight:700;margin-bottom:8px">{{companyName}} Daily Ops Report</div><div style="color:#4b5563;margin-bottom:16px">Range: {{reportStart}} to {{reportEnd}} ({{reportDays}} days)<br/>Tenant: {{tenantName}}<br/>Location: {{locationName}}</div><table style="width:100%;border-collapse:collapse;margin-bottom:18px"><tr><td style="padding:8px;border:1px solid #e5e7eb"><b>Reservations</b><br/>{{reservationsCreated}}</td><td style="padding:8px;border:1px solid #e5e7eb"><b>Checked Out</b><br/>{{checkedOut}}</td><td style="padding:8px;border:1px solid #e5e7eb"><b>Checked In</b><br/>{{checkedIn}}</td><td style="padding:8px;border:1px solid #e5e7eb"><b>Available Fleet</b><br/>{{availableFleet}}</td></tr><tr><td style="padding:8px;border:1px solid #e5e7eb"><b>Collected</b><br/>{{collectedPayments}}</td><td style="padding:8px;border:1px solid #e5e7eb"><b>Open Balance</b><br/>{{openBalance}}</td><td style="padding:8px;border:1px solid #e5e7eb"><b>Utilization</b><br/>{{utilizationPct}}</td><td style="padding:8px;border:1px solid #e5e7eb"><b>Wash Held</b><br/>{{washHeld}}</td></tr></table><div style="font-weight:700;margin:18px 0 6px">Fleet Hold Breakdown</div><table style="width:100%;border-collapse:collapse;margin-bottom:18px"><thead><tr><th align="left" style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb">Hold Type</th><th align="left" style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb">Count</th><th align="left" style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb">Note</th></tr></thead><tbody>{{fleetHoldRowsHtml}}</tbody></table><div style="font-weight:700;margin:18px 0 6px">Top Pickup Locations</div><table style="width:100%;border-collapse:collapse;margin-bottom:18px"><thead><tr><th align="left" style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb">Location</th><th align="left" style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb">Reservations</th></tr></thead><tbody>{{topPickupRowsHtml}}</tbody></table><div style="font-weight:700;margin:18px 0 6px">Reservation Status</div><table style="width:100%;border-collapse:collapse"><thead><tr><th align="left" style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb">Status</th><th align="left" style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb">Count</th></tr></thead><tbody>{{statusRowsHtml}}</tbody></table><div style="margin-top:18px;color:#6b7280">Generated by Ride Fleet.</div></div>',
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

const DEFAULT_PLANNER_COPILOT_CONFIG = {
  enabled: false,
  provider: 'openai',
  model: 'gpt-4.1-mini',
  allowGlobalApiKeyFallback: false,
  allowedModels: ['gpt-4.1-mini'],
  monthlyQueryCap: null,
  aiOnlyForPaidPlan: false,
  allowedPlans: ['PRO', 'ENTERPRISE'],
  apiKey: ''
};

const DEFAULT_TELEMATICS_CONFIG = {
  enabled: false,
  provider: 'ZUBIE',
  allowManualEventIngest: true,
  allowZubieConnector: true,
  webhookAuthMode: 'HEADER_SECRET',
  zubieWebhookSecret: ''
};

const DEFAULT_REVENUE_PRICING_CONFIG = {
  enabled: false,
  recommendationMode: 'ADVISORY',
  applyToPublicQuotes: false,
  weekendMarkupPct: 5,
  shortLeadWindowDays: 7,
  shortLeadMarkupPct: 10,
  lastMinuteWindowDays: 2,
  lastMinuteMarkupPct: 18,
  utilizationMediumThresholdPct: 70,
  utilizationMediumMarkupPct: 5,
  utilizationHighThresholdPct: 85,
  utilizationHighMarkupPct: 10,
  utilizationCriticalThresholdPct: 95,
  utilizationCriticalMarkupPct: 18,
  shortageMarkupPct: 12,
  maxAdjustmentPct: 25
};

const DEFAULT_SELF_SERVICE_CONFIG = {
  enabled: false,
  allowPickup: true,
  allowDropoff: true,
  requirePrecheckinForPickup: true,
  requireSignatureForPickup: true,
  requirePaymentForPickup: true,
  allowAfterHoursPickup: false,
  allowAfterHoursDropoff: true,
  keyExchangeMode: 'DESK',
  pickupInstructions: '',
  dropoffInstructions: '',
  supportPhone: '',
  readinessMode: 'STRICT',
  carSharingAutoRevealEnabled: true,
  carSharingAutoRevealModes: ['LOCKBOX', 'REMOTE_UNLOCK', 'SELF_SERVICE'],
  carSharingDefaultRevealWindowHours: 24,
  carSharingAirportRevealWindowHours: 12,
  carSharingHotelRevealWindowHours: 8,
  carSharingNeighborhoodRevealWindowHours: 24,
  carSharingStationRevealWindowHours: 10,
  carSharingHostPickupRevealWindowHours: 18,
  carSharingBranchRevealWindowHours: 0,
  carSharingDefaultHandoffMode: 'IN_PERSON',
  carSharingAirportHandoffMode: 'LOCKBOX',
  carSharingHotelHandoffMode: 'IN_PERSON',
  carSharingNeighborhoodHandoffMode: 'SELF_SERVICE',
  carSharingStationHandoffMode: 'LOCKBOX',
  carSharingHostPickupHandoffMode: 'LOCKBOX',
  carSharingBranchHandoffMode: 'SELF_SERVICE',
  carSharingAirportInstructionsTemplate: 'Share the terminal, parking garage, level, stall, and timing for access or key retrieval.',
  carSharingHotelInstructionsTemplate: 'Share the hotel entrance, lobby, valet, or curbside meeting instructions and exact timing.',
  carSharingNeighborhoodInstructionsTemplate: 'Share the street, landmark, parking side, and how the guest should access the vehicle.',
  carSharingStationInstructionsTemplate: 'Share the station meeting point, garage/lot, and platform or entrance guidance.',
  carSharingHostPickupInstructionsTemplate: 'Share the driveway, garage, gate, lockbox, or parking notes the guest should follow on arrival.',
  carSharingBranchInstructionsTemplate: 'Share the branch lot, kiosk, desk, or self-service pickup steps the guest should follow.'
};

function buildPlannerCopilotPlanDefaults(planConfig = null) {
  return {
    smartPlannerIncluded: planConfig?.smartPlannerIncluded !== false,
    plannerCopilotIncluded: !!planConfig?.plannerCopilotIncluded,
    telematicsIncluded: !!planConfig?.telematicsIncluded,
    inspectionIntelligenceIncluded: planConfig?.inspectionIntelligenceIncluded !== false,
    monthlyQueryCap: planConfig?.plannerCopilotMonthlyQueryCap == null ? DEFAULT_PLANNER_COPILOT_CONFIG.monthlyQueryCap : planConfig.plannerCopilotMonthlyQueryCap,
    allowedModels: normalizeModelList(planConfig?.plannerCopilotAllowedModels || DEFAULT_PLANNER_COPILOT_CONFIG.allowedModels)
  };
}

function normalizeAllowedPlans(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  return Array.from(new Set(raw.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean)));
}

function normalizeModelList(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  return Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean)));
}

function normalizeMonthlyQueryCap(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function normalizeWebhookAuthMode(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'NONE') return 'NONE';
  return 'HEADER_SECRET';
}

function normalizePercentSetting(value, fallback = 0, max = 500) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Number(fallback || 0);
  return Math.max(0, Math.min(max, Number(parsed.toFixed(2))));
}

function normalizeDayWindow(value, fallback = 0, max = 365) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Number(fallback || 0);
  return Math.max(0, Math.min(max, Math.floor(parsed)));
}

function normalizeHourWindow(value, fallback = 0, max = 168) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Number(fallback || 0);
  return Math.max(0, Math.min(max, Math.floor(parsed)));
}

function normalizeHandoffModeList(value, fallback = []) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  return Array.from(new Set(
    raw
      .map((item) => String(item || '').trim().toUpperCase())
      .filter((item) => ['LOCKBOX', 'REMOTE_UNLOCK', 'SELF_SERVICE', 'IN_PERSON'].includes(item))
  )).length
    ? Array.from(new Set(
        raw
          .map((item) => String(item || '').trim().toUpperCase())
          .filter((item) => ['LOCKBOX', 'REMOTE_UNLOCK', 'SELF_SERVICE', 'IN_PERSON'].includes(item))
      ))
    : fallback;
}

function normalizeSingleHandoffMode(value, fallback = 'IN_PERSON') {
  const normalized = String(value || fallback).trim().toUpperCase();
  return ['LOCKBOX', 'REMOTE_UNLOCK', 'SELF_SERVICE', 'IN_PERSON'].includes(normalized) ? normalized : fallback;
}

function normalizeSelfServiceConfig(raw = {}, options = {}) {
  const tenantPlan = String(options.tenantPlan || 'BETA').trim().toUpperCase() || 'BETA';
  const keyExchangeMode = ['DESK', 'LOCKBOX', 'SMART_LOCK', 'KEY_CABINET'].includes(String(raw?.keyExchangeMode || '').trim().toUpperCase())
    ? String(raw?.keyExchangeMode || '').trim().toUpperCase()
    : DEFAULT_SELF_SERVICE_CONFIG.keyExchangeMode;
  const readinessMode = String(raw?.readinessMode || DEFAULT_SELF_SERVICE_CONFIG.readinessMode).trim().toUpperCase() === 'ADVISORY'
    ? 'ADVISORY'
    : 'STRICT';
  return {
    enabled: raw?.enabled == null ? !!DEFAULT_SELF_SERVICE_CONFIG.enabled : !!raw?.enabled,
    allowPickup: raw?.allowPickup == null ? !!DEFAULT_SELF_SERVICE_CONFIG.allowPickup : !!raw?.allowPickup,
    allowDropoff: raw?.allowDropoff == null ? !!DEFAULT_SELF_SERVICE_CONFIG.allowDropoff : !!raw?.allowDropoff,
    requirePrecheckinForPickup: raw?.requirePrecheckinForPickup == null ? !!DEFAULT_SELF_SERVICE_CONFIG.requirePrecheckinForPickup : !!raw?.requirePrecheckinForPickup,
    requireSignatureForPickup: raw?.requireSignatureForPickup == null ? !!DEFAULT_SELF_SERVICE_CONFIG.requireSignatureForPickup : !!raw?.requireSignatureForPickup,
    requirePaymentForPickup: raw?.requirePaymentForPickup == null ? !!DEFAULT_SELF_SERVICE_CONFIG.requirePaymentForPickup : !!raw?.requirePaymentForPickup,
    allowAfterHoursPickup: raw?.allowAfterHoursPickup == null ? !!DEFAULT_SELF_SERVICE_CONFIG.allowAfterHoursPickup : !!raw?.allowAfterHoursPickup,
    allowAfterHoursDropoff: raw?.allowAfterHoursDropoff == null ? !!DEFAULT_SELF_SERVICE_CONFIG.allowAfterHoursDropoff : !!raw?.allowAfterHoursDropoff,
    keyExchangeMode,
    pickupInstructions: String(raw?.pickupInstructions || '').trim(),
    dropoffInstructions: String(raw?.dropoffInstructions || '').trim(),
    supportPhone: String(raw?.supportPhone || '').trim(),
    readinessMode,
    carSharingAutoRevealEnabled: raw?.carSharingAutoRevealEnabled == null ? !!DEFAULT_SELF_SERVICE_CONFIG.carSharingAutoRevealEnabled : !!raw?.carSharingAutoRevealEnabled,
    carSharingAutoRevealModes: normalizeHandoffModeList(raw?.carSharingAutoRevealModes, DEFAULT_SELF_SERVICE_CONFIG.carSharingAutoRevealModes),
    carSharingDefaultRevealWindowHours: normalizeHourWindow(raw?.carSharingDefaultRevealWindowHours, DEFAULT_SELF_SERVICE_CONFIG.carSharingDefaultRevealWindowHours),
    carSharingAirportRevealWindowHours: normalizeHourWindow(raw?.carSharingAirportRevealWindowHours, DEFAULT_SELF_SERVICE_CONFIG.carSharingAirportRevealWindowHours),
    carSharingHotelRevealWindowHours: normalizeHourWindow(raw?.carSharingHotelRevealWindowHours, DEFAULT_SELF_SERVICE_CONFIG.carSharingHotelRevealWindowHours),
    carSharingNeighborhoodRevealWindowHours: normalizeHourWindow(raw?.carSharingNeighborhoodRevealWindowHours, DEFAULT_SELF_SERVICE_CONFIG.carSharingNeighborhoodRevealWindowHours),
    carSharingStationRevealWindowHours: normalizeHourWindow(raw?.carSharingStationRevealWindowHours, DEFAULT_SELF_SERVICE_CONFIG.carSharingStationRevealWindowHours),
    carSharingHostPickupRevealWindowHours: normalizeHourWindow(raw?.carSharingHostPickupRevealWindowHours, DEFAULT_SELF_SERVICE_CONFIG.carSharingHostPickupRevealWindowHours),
    carSharingBranchRevealWindowHours: normalizeHourWindow(raw?.carSharingBranchRevealWindowHours, DEFAULT_SELF_SERVICE_CONFIG.carSharingBranchRevealWindowHours),
    carSharingDefaultHandoffMode: normalizeSingleHandoffMode(raw?.carSharingDefaultHandoffMode, DEFAULT_SELF_SERVICE_CONFIG.carSharingDefaultHandoffMode),
    carSharingAirportHandoffMode: normalizeSingleHandoffMode(raw?.carSharingAirportHandoffMode, DEFAULT_SELF_SERVICE_CONFIG.carSharingAirportHandoffMode),
    carSharingHotelHandoffMode: normalizeSingleHandoffMode(raw?.carSharingHotelHandoffMode, DEFAULT_SELF_SERVICE_CONFIG.carSharingHotelHandoffMode),
    carSharingNeighborhoodHandoffMode: normalizeSingleHandoffMode(raw?.carSharingNeighborhoodHandoffMode, DEFAULT_SELF_SERVICE_CONFIG.carSharingNeighborhoodHandoffMode),
    carSharingStationHandoffMode: normalizeSingleHandoffMode(raw?.carSharingStationHandoffMode, DEFAULT_SELF_SERVICE_CONFIG.carSharingStationHandoffMode),
    carSharingHostPickupHandoffMode: normalizeSingleHandoffMode(raw?.carSharingHostPickupHandoffMode, DEFAULT_SELF_SERVICE_CONFIG.carSharingHostPickupHandoffMode),
    carSharingBranchHandoffMode: normalizeSingleHandoffMode(raw?.carSharingBranchHandoffMode, DEFAULT_SELF_SERVICE_CONFIG.carSharingBranchHandoffMode),
    carSharingAirportInstructionsTemplate: String(raw?.carSharingAirportInstructionsTemplate ?? DEFAULT_SELF_SERVICE_CONFIG.carSharingAirportInstructionsTemplate).trim(),
    carSharingHotelInstructionsTemplate: String(raw?.carSharingHotelInstructionsTemplate ?? DEFAULT_SELF_SERVICE_CONFIG.carSharingHotelInstructionsTemplate).trim(),
    carSharingNeighborhoodInstructionsTemplate: String(raw?.carSharingNeighborhoodInstructionsTemplate ?? DEFAULT_SELF_SERVICE_CONFIG.carSharingNeighborhoodInstructionsTemplate).trim(),
    carSharingStationInstructionsTemplate: String(raw?.carSharingStationInstructionsTemplate ?? DEFAULT_SELF_SERVICE_CONFIG.carSharingStationInstructionsTemplate).trim(),
    carSharingHostPickupInstructionsTemplate: String(raw?.carSharingHostPickupInstructionsTemplate ?? DEFAULT_SELF_SERVICE_CONFIG.carSharingHostPickupInstructionsTemplate).trim(),
    carSharingBranchInstructionsTemplate: String(raw?.carSharingBranchInstructionsTemplate ?? DEFAULT_SELF_SERVICE_CONFIG.carSharingBranchInstructionsTemplate).trim(),
    tenantPlan
  };
}

function currentUsagePeriodKey(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function maskSecret(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length <= 8) return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

function normalizePlannerCopilotConfig(raw = {}, options = {}) {
  const includeSecret = !!options.includeSecret;
  const tenantPlan = String(options.tenantPlan || 'BETA').trim().toUpperCase() || 'BETA';
  const planDefaults = buildPlannerCopilotPlanDefaults(options.planConfig || null);
  const envApiKey = String(process.env.OPENAI_API_KEY || '').trim();
  const tenantApiKey = String(raw?.apiKey || '').trim();
  const allowGlobalApiKeyFallback = !!raw?.allowGlobalApiKeyFallback;
  const allowedPlans = normalizeAllowedPlans(raw?.allowedPlans || DEFAULT_PLANNER_COPILOT_CONFIG.allowedPlans);
  const allowedModels = normalizeModelList(raw?.allowedModels || planDefaults.allowedModels || DEFAULT_PLANNER_COPILOT_CONFIG.allowedModels);
  const aiOnlyForPaidPlan = !!raw?.aiOnlyForPaidPlan;
  const planEligible = !aiOnlyForPaidPlan || allowedPlans.includes(tenantPlan);
  const selectedModel = String(raw?.model || planDefaults.allowedModels?.[0] || DEFAULT_PLANNER_COPILOT_CONFIG.model).trim() || DEFAULT_PLANNER_COPILOT_CONFIG.model;
  const modelAllowed = !allowedModels.length || allowedModels.includes(selectedModel);
  const credentialSource = tenantApiKey
    ? 'TENANT'
    : allowGlobalApiKeyFallback && envApiKey
      ? 'GLOBAL'
      : 'NONE';

  return {
    enabled: raw?.enabled == null ? !!planDefaults.plannerCopilotIncluded : !!raw?.enabled,
    provider: 'openai',
    model: selectedModel,
    allowGlobalApiKeyFallback,
    allowedModels,
    monthlyQueryCap: normalizeMonthlyQueryCap(raw?.monthlyQueryCap ?? planDefaults.monthlyQueryCap),
    aiOnlyForPaidPlan,
    allowedPlans,
    tenantPlan,
    planEligible,
    modelAllowed,
    apiKey: includeSecret ? tenantApiKey : '',
    apiKeyMasked: tenantApiKey ? maskSecret(tenantApiKey) : '',
    hasTenantApiKey: !!tenantApiKey,
    credentialSource,
    planDefaults,
    ready: (raw?.enabled == null ? !!planDefaults.plannerCopilotIncluded : !!raw?.enabled) && !!planDefaults.plannerCopilotIncluded && credentialSource !== 'NONE' && planEligible && modelAllowed
  };
}

function normalizeTelematicsConfig(raw = {}, options = {}) {
  const includeSecret = !!options.includeSecret;
  const tenantPlan = String(options.tenantPlan || 'BETA').trim().toUpperCase() || 'BETA';
  const planDefaults = buildPlannerCopilotPlanDefaults(options.planConfig || null);
  const enabled = raw?.enabled == null ? !!planDefaults.telematicsIncluded : !!raw?.enabled;
  const provider = ['ZUBIE', 'GENERIC', 'SAMSARA', 'GEOTAB', 'AZUGA'].includes(String(raw?.provider || DEFAULT_TELEMATICS_CONFIG.provider).trim().toUpperCase())
    ? String(raw?.provider || DEFAULT_TELEMATICS_CONFIG.provider).trim().toUpperCase()
    : DEFAULT_TELEMATICS_CONFIG.provider;
  const allowManualEventIngest = raw?.allowManualEventIngest == null ? !!DEFAULT_TELEMATICS_CONFIG.allowManualEventIngest : !!raw?.allowManualEventIngest;
  const allowZubieConnector = raw?.allowZubieConnector == null ? !!DEFAULT_TELEMATICS_CONFIG.allowZubieConnector : !!raw?.allowZubieConnector;
  const zubieWebhookSecret = String(raw?.zubieWebhookSecret || '').trim();
  const webhookAuthMode = normalizeWebhookAuthMode(raw?.webhookAuthMode);
  const connectorEnabled = provider === 'ZUBIE' && allowZubieConnector;
  return {
    enabled,
    provider,
    allowManualEventIngest,
    allowZubieConnector,
    webhookAuthMode,
    zubieWebhookSecret: includeSecret ? zubieWebhookSecret : '',
    zubieWebhookSecretMasked: zubieWebhookSecret ? maskSecret(zubieWebhookSecret) : '',
    hasZubieWebhookSecret: !!zubieWebhookSecret,
    tenantPlan,
    planDefaults: {
      telematicsIncluded: !!planDefaults.telematicsIncluded,
      inspectionIntelligenceIncluded: planDefaults.inspectionIntelligenceIncluded !== false
    },
    ready: enabled && !!planDefaults.telematicsIncluded,
    publicWebhookReady: enabled
      && !!planDefaults.telematicsIncluded
      && connectorEnabled
      && (webhookAuthMode === 'NONE' || !!zubieWebhookSecret)
  };
}

function normalizeRevenuePricingConfig(raw = {}, options = {}) {
  const tenantPlan = String(options.tenantPlan || 'BETA').trim().toUpperCase() || 'BETA';
  return {
    enabled: raw?.enabled == null ? !!DEFAULT_REVENUE_PRICING_CONFIG.enabled : !!raw?.enabled,
    recommendationMode: String(raw?.recommendationMode || DEFAULT_REVENUE_PRICING_CONFIG.recommendationMode).trim().toUpperCase() === 'AUTOPILOT' ? 'AUTOPILOT' : 'ADVISORY',
    applyToPublicQuotes: !!raw?.applyToPublicQuotes,
    weekendMarkupPct: normalizePercentSetting(raw?.weekendMarkupPct, DEFAULT_REVENUE_PRICING_CONFIG.weekendMarkupPct),
    shortLeadWindowDays: normalizeDayWindow(raw?.shortLeadWindowDays, DEFAULT_REVENUE_PRICING_CONFIG.shortLeadWindowDays),
    shortLeadMarkupPct: normalizePercentSetting(raw?.shortLeadMarkupPct, DEFAULT_REVENUE_PRICING_CONFIG.shortLeadMarkupPct),
    lastMinuteWindowDays: normalizeDayWindow(raw?.lastMinuteWindowDays, DEFAULT_REVENUE_PRICING_CONFIG.lastMinuteWindowDays),
    lastMinuteMarkupPct: normalizePercentSetting(raw?.lastMinuteMarkupPct, DEFAULT_REVENUE_PRICING_CONFIG.lastMinuteMarkupPct),
    utilizationMediumThresholdPct: normalizePercentSetting(raw?.utilizationMediumThresholdPct, DEFAULT_REVENUE_PRICING_CONFIG.utilizationMediumThresholdPct, 100),
    utilizationMediumMarkupPct: normalizePercentSetting(raw?.utilizationMediumMarkupPct, DEFAULT_REVENUE_PRICING_CONFIG.utilizationMediumMarkupPct),
    utilizationHighThresholdPct: normalizePercentSetting(raw?.utilizationHighThresholdPct, DEFAULT_REVENUE_PRICING_CONFIG.utilizationHighThresholdPct, 100),
    utilizationHighMarkupPct: normalizePercentSetting(raw?.utilizationHighMarkupPct, DEFAULT_REVENUE_PRICING_CONFIG.utilizationHighMarkupPct),
    utilizationCriticalThresholdPct: normalizePercentSetting(raw?.utilizationCriticalThresholdPct, DEFAULT_REVENUE_PRICING_CONFIG.utilizationCriticalThresholdPct, 100),
    utilizationCriticalMarkupPct: normalizePercentSetting(raw?.utilizationCriticalMarkupPct, DEFAULT_REVENUE_PRICING_CONFIG.utilizationCriticalMarkupPct),
    shortageMarkupPct: normalizePercentSetting(raw?.shortageMarkupPct, DEFAULT_REVENUE_PRICING_CONFIG.shortageMarkupPct),
    maxAdjustmentPct: normalizePercentSetting(raw?.maxAdjustmentPct, DEFAULT_REVENUE_PRICING_CONFIG.maxAdjustmentPct),
    tenantPlan
  };
}

const CAR_SHARING_PRESET_TYPES = ['AIRPORT', 'HOTEL', 'NEIGHBORHOOD', 'STATION', 'TENANT_BRANCH'];
const CAR_SHARING_PRESET_VISIBILITY = ['PUBLIC_EXACT', 'APPROXIMATE_ONLY', 'REVEAL_AFTER_BOOKING'];

function normalizeCarSharingPresetType(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!CAR_SHARING_PRESET_TYPES.includes(normalized)) throw new Error('Invalid car sharing preset type');
  return normalized;
}

function normalizeCarSharingPresetVisibility(value) {
  const normalized = String(value || 'APPROXIMATE_ONLY').trim().toUpperCase();
  if (!CAR_SHARING_PRESET_VISIBILITY.includes(normalized)) throw new Error('Invalid car sharing preset visibility');
  return normalized;
}

async function ensureScopedLocation(locationId, tenantId) {
  if (!locationId) return null;
  const location = await prisma.location.findFirst({
    where: { id: locationId, tenantId, isActive: true },
    select: { id: true }
  });
  if (!location) throw new Error('Anchor location not found');
  return location.id;
}

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
    },
    spin: {
      enabled: !!process.env.SPIN_AUTH_KEY,
      environment: String(process.env.SPIN_ENV || 'sandbox').toLowerCase(),
      authKey: String(process.env.SPIN_AUTH_KEY || ''),
      tpn: String(process.env.SPIN_TPN || ''),
      merchantNumber: String(process.env.SPIN_MERCHANT_NUMBER || '1'),
      callbackUrl: String(process.env.SPIN_CALLBACK_URL || ''),
      proxyTimeout: String(process.env.SPIN_PROXY_TIMEOUT || '120')
    }
  };
}

function scopedKey(baseKey, scope = {}) {
  return scope?.tenantId ? `tenant:${scope.tenantId}:${baseKey}` : baseKey;
}

async function readJsonSetting(key, fallback) {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

async function writeJsonSetting(key, value) {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) }
  });
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

  async getPrecheckinDiscount(scope = {}) {
    const row = await prisma.appSetting.findUnique({ where: { key: scopedKey('precheckinDiscount', scope) } });
    if (!row?.value) return { enabled: false, type: 'PERCENTAGE', value: 0 };
    try {
      const parsed = JSON.parse(row.value);
      return {
        enabled: !!parsed?.enabled,
        type: String(parsed?.type || 'PERCENTAGE').toUpperCase() === 'FIXED' ? 'FIXED' : 'PERCENTAGE',
        value: Number(parsed?.value || 0)
      };
    } catch {
      return { enabled: false, type: 'PERCENTAGE', value: 0 };
    }
  },

  async updatePrecheckinDiscount(payload = {}, scope = {}) {
    const next = {
      enabled: !!payload?.enabled,
      type: String(payload?.type || 'PERCENTAGE').toUpperCase() === 'FIXED' ? 'FIXED' : 'PERCENTAGE',
      value: Math.max(0, Number(payload?.value || 0))
    };
    const key = scopedKey('precheckinDiscount', scope);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) }
    });
    return next;
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
        },
        spin: {
          ...defaults.spin,
          ...(parsed?.spin || {})
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
      },
      spin: {
        ...defaults.spin,
        ...(payload?.spin || {}),
        enabled: !!payload?.spin?.enabled,
        environment: String(payload?.spin?.environment || defaults.spin.environment).trim().toLowerCase(),
        authKey: String(payload?.spin?.authKey || '').trim(),
        tpn: String(payload?.spin?.tpn || '').trim(),
        merchantNumber: String(payload?.spin?.merchantNumber || '1').trim(),
        callbackUrl: String(payload?.spin?.callbackUrl || '').trim(),
        proxyTimeout: String(payload?.spin?.proxyTimeout || '120').trim()
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

  async getPlannerCopilotConfig(scope = {}, options = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const [tenant, planCatalog] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: scope.tenantId },
        select: { id: true, plan: true }
      }),
      getTenantPlanCatalog()
    ]);
    const planConfig = resolveTenantPlanConfig(tenant?.plan || 'BETA', planCatalog);
    const row = await prisma.appSetting.findUnique({ where: { key: scopedKey('plannerCopilotConfig', scope) } });
    if (!row?.value) return normalizePlannerCopilotConfig(DEFAULT_PLANNER_COPILOT_CONFIG, { ...options, tenantPlan: tenant?.plan || 'BETA', planConfig });
    try {
      const parsed = JSON.parse(row.value);
      return normalizePlannerCopilotConfig({
        ...DEFAULT_PLANNER_COPILOT_CONFIG,
        ...(parsed || {})
      }, { ...options, tenantPlan: tenant?.plan || 'BETA', planConfig });
    } catch {
      return normalizePlannerCopilotConfig(DEFAULT_PLANNER_COPILOT_CONFIG, { ...options, tenantPlan: tenant?.plan || 'BETA', planConfig });
    }
  },

  async getTelematicsConfig(scope = {}, options = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const [tenant, planCatalog] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: scope.tenantId },
        select: { id: true, plan: true }
      }),
      getTenantPlanCatalog()
    ]);
    const planConfig = resolveTenantPlanConfig(tenant?.plan || 'BETA', planCatalog);
    const row = await prisma.appSetting.findUnique({ where: { key: scopedKey('telematicsConfig', scope) } });
    if (!row?.value) return normalizeTelematicsConfig(DEFAULT_TELEMATICS_CONFIG, { ...options, tenantPlan: tenant?.plan || 'BETA', planConfig });
    try {
      const parsed = JSON.parse(row.value);
      return normalizeTelematicsConfig({
        ...DEFAULT_TELEMATICS_CONFIG,
        ...(parsed || {})
      }, { ...options, tenantPlan: tenant?.plan || 'BETA', planConfig });
    } catch {
      return normalizeTelematicsConfig(DEFAULT_TELEMATICS_CONFIG, { ...options, tenantPlan: tenant?.plan || 'BETA', planConfig });
    }
  },

  async getRevenuePricingConfig(scope = {}, options = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const tenant = await prisma.tenant.findUnique({
      where: { id: scope.tenantId },
      select: { id: true, plan: true }
    });
    const row = await prisma.appSetting.findUnique({ where: { key: scopedKey('revenuePricingConfig', scope) } });
    if (!row?.value) return normalizeRevenuePricingConfig(DEFAULT_REVENUE_PRICING_CONFIG, { ...options, tenantPlan: tenant?.plan || 'BETA' });
    try {
      const parsed = JSON.parse(row.value);
      return normalizeRevenuePricingConfig({
        ...DEFAULT_REVENUE_PRICING_CONFIG,
        ...(parsed || {})
      }, { ...options, tenantPlan: tenant?.plan || 'BETA' });
    } catch {
      return normalizeRevenuePricingConfig(DEFAULT_REVENUE_PRICING_CONFIG, { ...options, tenantPlan: tenant?.plan || 'BETA' });
    }
  },

  async getSelfServiceConfig(scope = {}, options = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const tenant = await prisma.tenant.findUnique({
      where: { id: scope.tenantId },
      select: { id: true, plan: true }
    });
    const row = await prisma.appSetting.findUnique({ where: { key: scopedKey('selfServiceConfig', scope) } });
    if (!row?.value) return normalizeSelfServiceConfig(DEFAULT_SELF_SERVICE_CONFIG, { ...options, tenantPlan: tenant?.plan || 'BETA' });
    try {
      const parsed = JSON.parse(row.value);
      return normalizeSelfServiceConfig({
        ...DEFAULT_SELF_SERVICE_CONFIG,
        ...(parsed || {})
      }, { ...options, tenantPlan: tenant?.plan || 'BETA' });
    } catch {
      return normalizeSelfServiceConfig(DEFAULT_SELF_SERVICE_CONFIG, { ...options, tenantPlan: tenant?.plan || 'BETA' });
    }
  },

  async updateTelematicsConfig(payload = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const existing = await this.getTelematicsConfig(scope, { includeSecret: true });
    const next = {
      enabled: !!payload?.enabled,
      provider: String(payload?.provider || DEFAULT_TELEMATICS_CONFIG.provider).trim().toUpperCase() || DEFAULT_TELEMATICS_CONFIG.provider,
      allowManualEventIngest: !!payload?.allowManualEventIngest,
      allowZubieConnector: !!payload?.allowZubieConnector,
      webhookAuthMode: normalizeWebhookAuthMode(payload?.webhookAuthMode),
      zubieWebhookSecret: payload?.clearZubieWebhookSecret
        ? ''
        : String(payload?.zubieWebhookSecret || '').trim() || String(existing?.zubieWebhookSecret || '').trim()
    };
    const key = scopedKey('telematicsConfig', scope);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) }
    });
    return this.getTelematicsConfig(scope);
  },

  async updateRevenuePricingConfig(payload = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const next = normalizeRevenuePricingConfig({
      ...DEFAULT_REVENUE_PRICING_CONFIG,
      ...(payload || {})
    }, {
      tenantPlan: (
        await prisma.tenant.findUnique({
          where: { id: scope.tenantId },
          select: { plan: true }
        })
      )?.plan || 'BETA'
    });
    const key = scopedKey('revenuePricingConfig', scope);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) }
    });
    return this.getRevenuePricingConfig(scope);
  },

  async updateSelfServiceConfig(payload = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const next = normalizeSelfServiceConfig({
      ...DEFAULT_SELF_SERVICE_CONFIG,
      ...(payload || {})
    }, {
      tenantPlan: (
        await prisma.tenant.findUnique({
          where: { id: scope.tenantId },
          select: { plan: true }
        })
      )?.plan || 'BETA'
    });
    const key = scopedKey('selfServiceConfig', scope);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) }
    });
    return this.getSelfServiceConfig(scope);
  },

  async listCarSharingSearchPlacePresets(scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    return prisma.carSharingSearchPlace.findMany({
      where: {
        tenantId: scope.tenantId,
        hostProfileId: null,
        placeType: { in: CAR_SHARING_PRESET_TYPES }
      },
      include: {
        anchorLocation: {
          select: { id: true, name: true, city: true, state: true }
        }
      },
      orderBy: [{ placeType: 'asc' }, { label: 'asc' }]
    });
  },

  async createCarSharingSearchPlacePreset(payload = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const placeType = normalizeCarSharingPresetType(payload?.placeType);
    const anchorLocationId = await ensureScopedLocation(payload?.anchorLocationId ? String(payload.anchorLocationId).trim() : null, scope.tenantId);
    const label = String(payload?.label || '').trim();
    if (!label) throw new Error('label is required');
    const row = await prisma.carSharingSearchPlace.create({
      data: {
        tenantId: scope.tenantId,
        hostProfileId: null,
        anchorLocationId,
        placeType,
        label,
        publicLabel: String(payload?.publicLabel || label).trim() || label,
        city: payload?.city ? String(payload.city).trim() : null,
        state: payload?.state ? String(payload.state).trim() : null,
        postalCode: payload?.postalCode ? String(payload.postalCode).trim() : null,
        country: payload?.country ? String(payload.country).trim() : null,
        radiusMiles: payload?.radiusMiles === '' || payload?.radiusMiles == null ? null : Math.max(0, Math.floor(Number(payload.radiusMiles))),
        searchable: payload?.searchable !== false,
        isActive: payload?.isActive !== false,
        approvalStatus: 'APPROVED',
        visibilityMode: normalizeCarSharingPresetVisibility(payload?.visibilityMode),
        deliveryEligible: !!payload?.deliveryEligible,
        pickupEligible: payload?.pickupEligible !== false
      },
      include: {
        anchorLocation: {
          select: { id: true, name: true, city: true, state: true }
        }
      }
    });
    return row;
  },

  async updateCarSharingSearchPlacePreset(id, payload = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const current = await prisma.carSharingSearchPlace.findFirst({
      where: {
        id,
        tenantId: scope.tenantId,
        hostProfileId: null,
        placeType: { in: CAR_SHARING_PRESET_TYPES }
      }
    });
    if (!current) throw new Error('Car sharing preset not found');
    const anchorLocationId = Object.prototype.hasOwnProperty.call(payload || {}, 'anchorLocationId')
      ? await ensureScopedLocation(payload?.anchorLocationId ? String(payload.anchorLocationId).trim() : null, scope.tenantId)
      : undefined;
    return prisma.carSharingSearchPlace.update({
      where: { id: current.id },
      data: {
        placeType: Object.prototype.hasOwnProperty.call(payload || {}, 'placeType') ? normalizeCarSharingPresetType(payload?.placeType) : undefined,
        anchorLocationId,
        label: Object.prototype.hasOwnProperty.call(payload || {}, 'label') ? String(payload?.label || '').trim() : undefined,
        publicLabel: Object.prototype.hasOwnProperty.call(payload || {}, 'publicLabel') ? (payload?.publicLabel ? String(payload.publicLabel).trim() : null) : undefined,
        city: Object.prototype.hasOwnProperty.call(payload || {}, 'city') ? (payload?.city ? String(payload.city).trim() : null) : undefined,
        state: Object.prototype.hasOwnProperty.call(payload || {}, 'state') ? (payload?.state ? String(payload.state).trim() : null) : undefined,
        postalCode: Object.prototype.hasOwnProperty.call(payload || {}, 'postalCode') ? (payload?.postalCode ? String(payload.postalCode).trim() : null) : undefined,
        country: Object.prototype.hasOwnProperty.call(payload || {}, 'country') ? (payload?.country ? String(payload.country).trim() : null) : undefined,
        radiusMiles: Object.prototype.hasOwnProperty.call(payload || {}, 'radiusMiles')
          ? (payload?.radiusMiles === '' || payload?.radiusMiles == null ? null : Math.max(0, Math.floor(Number(payload.radiusMiles))))
          : undefined,
        searchable: Object.prototype.hasOwnProperty.call(payload || {}, 'searchable') ? !!payload?.searchable : undefined,
        isActive: Object.prototype.hasOwnProperty.call(payload || {}, 'isActive') ? !!payload?.isActive : undefined,
        visibilityMode: Object.prototype.hasOwnProperty.call(payload || {}, 'visibilityMode') ? normalizeCarSharingPresetVisibility(payload?.visibilityMode) : undefined,
        deliveryEligible: Object.prototype.hasOwnProperty.call(payload || {}, 'deliveryEligible') ? !!payload?.deliveryEligible : undefined,
        pickupEligible: Object.prototype.hasOwnProperty.call(payload || {}, 'pickupEligible') ? !!payload?.pickupEligible : undefined
      },
      include: {
        anchorLocation: {
          select: { id: true, name: true, city: true, state: true }
        }
      }
    });
  },

  async deleteCarSharingSearchPlacePreset(id, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const current = await prisma.carSharingSearchPlace.findFirst({
      where: {
        id,
        tenantId: scope.tenantId,
        hostProfileId: null,
        placeType: { in: CAR_SHARING_PRESET_TYPES }
      },
      select: { id: true }
    });
    if (!current) throw new Error('Car sharing preset not found');
    await prisma.carSharingSearchPlace.delete({
      where: { id: current.id }
    });
    return { ok: true };
  },

  async updatePlannerCopilotConfig(payload = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const existing = await this.getPlannerCopilotConfig(scope, { includeSecret: true });
    const next = {
      enabled: !!payload?.enabled,
      provider: 'openai',
      model: String(payload?.model || existing?.model || DEFAULT_PLANNER_COPILOT_CONFIG.model).trim() || DEFAULT_PLANNER_COPILOT_CONFIG.model,
      allowGlobalApiKeyFallback: !!payload?.allowGlobalApiKeyFallback,
      allowedModels: normalizeModelList(payload?.allowedModels || existing?.allowedModels || DEFAULT_PLANNER_COPILOT_CONFIG.allowedModels),
      monthlyQueryCap: normalizeMonthlyQueryCap(payload?.monthlyQueryCap),
      aiOnlyForPaidPlan: !!payload?.aiOnlyForPaidPlan,
      allowedPlans: normalizeAllowedPlans(payload?.allowedPlans || existing?.allowedPlans || DEFAULT_PLANNER_COPILOT_CONFIG.allowedPlans),
      apiKey: payload?.clearTenantApiKey
        ? ''
        : String(payload?.apiKey || '').trim() || String(existing?.apiKey || '').trim()
    };
    const key = scopedKey('plannerCopilotConfig', scope);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) }
    });
    return this.getPlannerCopilotConfig(scope);
  },

  async getPlannerCopilotUsage(scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const summaryKey = scopedKey('plannerCopilotUsageSummary', scope);
    const recentKey = scopedKey('plannerCopilotUsageRecent', scope);
    const periodsKey = scopedKey('plannerCopilotUsagePeriods', scope);
    const [summary, recent, periods] = await Promise.all([
      readJsonSetting(summaryKey, {
        totalQueries: 0,
        aiResponses: 0,
        heuristicResponses: 0,
        modelCounts: {},
        lastUsedAt: null,
        lastMode: null,
        lastModel: null,
        lastActorName: '',
        lastActorEmail: ''
      }),
      readJsonSetting(recentKey, []),
      readJsonSetting(periodsKey, {})
    ]);
    const currentPeriod = currentUsagePeriodKey();
    const currentPeriodMetrics = periods?.[currentPeriod] && typeof periods[currentPeriod] === 'object'
      ? periods[currentPeriod]
      : { totalQueries: 0, aiResponses: 0, heuristicResponses: 0, modelCounts: {} };
    const periodHistory = Object.entries(periods && typeof periods === 'object' ? periods : {})
      .sort((left, right) => String(right[0]).localeCompare(String(left[0])))
      .slice(0, 6)
      .map(([period, value]) => ({
        period,
        totalQueries: Number(value?.totalQueries || 0),
        aiResponses: Number(value?.aiResponses || 0),
        heuristicResponses: Number(value?.heuristicResponses || 0),
        modelCounts: value?.modelCounts && typeof value.modelCounts === 'object' ? value.modelCounts : {}
      }));
    return {
      summary: {
        totalQueries: Number(summary?.totalQueries || 0),
        aiResponses: Number(summary?.aiResponses || 0),
        heuristicResponses: Number(summary?.heuristicResponses || 0),
        modelCounts: summary?.modelCounts && typeof summary.modelCounts === 'object' ? summary.modelCounts : {},
        lastUsedAt: summary?.lastUsedAt || null,
        lastMode: summary?.lastMode || null,
        lastModel: summary?.lastModel || null,
        lastActorName: String(summary?.lastActorName || ''),
        lastActorEmail: String(summary?.lastActorEmail || '')
      },
      currentPeriod: {
        period: currentPeriod,
        totalQueries: Number(currentPeriodMetrics?.totalQueries || 0),
        aiResponses: Number(currentPeriodMetrics?.aiResponses || 0),
        heuristicResponses: Number(currentPeriodMetrics?.heuristicResponses || 0),
        modelCounts: currentPeriodMetrics?.modelCounts && typeof currentPeriodMetrics.modelCounts === 'object' ? currentPeriodMetrics.modelCounts : {}
      },
      periods: periodHistory,
      recent: Array.isArray(recent) ? recent : []
    };
  },

  async recordPlannerCopilotUsage(event = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const summaryKey = scopedKey('plannerCopilotUsageSummary', scope);
    const recentKey = scopedKey('plannerCopilotUsageRecent', scope);
    const periodsKey = scopedKey('plannerCopilotUsagePeriods', scope);
    const nowIso = new Date().toISOString();
    const periodKey = currentUsagePeriodKey(new Date(nowIso));
    const mode = String(event?.mode || 'HEURISTIC').toUpperCase() === 'AI' ? 'AI' : 'HEURISTIC';
    const model = String(event?.model || '').trim() || null;
    const actorName = String(event?.actorName || '').trim();
    const actorEmail = String(event?.actorEmail || '').trim();
    const questionPreview = String(event?.question || '').trim().slice(0, 180);

    const [summary, recent, periods] = await Promise.all([
      readJsonSetting(summaryKey, {
        totalQueries: 0,
        aiResponses: 0,
        heuristicResponses: 0,
        modelCounts: {},
        lastUsedAt: null,
        lastMode: null,
        lastModel: null,
        lastActorName: '',
        lastActorEmail: ''
      }),
      readJsonSetting(recentKey, []),
      readJsonSetting(periodsKey, {})
    ]);

    const nextSummary = {
      totalQueries: Number(summary?.totalQueries || 0) + 1,
      aiResponses: Number(summary?.aiResponses || 0) + (mode === 'AI' ? 1 : 0),
      heuristicResponses: Number(summary?.heuristicResponses || 0) + (mode === 'HEURISTIC' ? 1 : 0),
      modelCounts: {
        ...(summary?.modelCounts && typeof summary.modelCounts === 'object' ? summary.modelCounts : {}),
        ...(model ? {
          [model]: Number(summary?.modelCounts?.[model] || 0) + 1
        } : {})
      },
      lastUsedAt: nowIso,
      lastMode: mode,
      lastModel: model,
      lastActorName: actorName,
      lastActorEmail: actorEmail
    };

    const nextRecent = [
      {
        createdAt: nowIso,
        actorUserId: event?.actorUserId || null,
        actorName,
        actorEmail,
        mode,
        model,
        riskLevel: String(event?.riskLevel || '').trim() || null,
        questionPreview,
        aiError: String(event?.aiError || '').trim() || null
      },
      ...(Array.isArray(recent) ? recent : [])
    ].slice(0, 25);

    const periodMap = periods && typeof periods === 'object' ? periods : {};
    const currentPeriodRow = periodMap?.[periodKey] && typeof periodMap[periodKey] === 'object'
      ? periodMap[periodKey]
      : { totalQueries: 0, aiResponses: 0, heuristicResponses: 0, modelCounts: {} };
    const nextPeriods = {
      ...periodMap,
      [periodKey]: {
        totalQueries: Number(currentPeriodRow?.totalQueries || 0) + 1,
        aiResponses: Number(currentPeriodRow?.aiResponses || 0) + (mode === 'AI' ? 1 : 0),
        heuristicResponses: Number(currentPeriodRow?.heuristicResponses || 0) + (mode === 'HEURISTIC' ? 1 : 0),
        modelCounts: {
          ...(currentPeriodRow?.modelCounts && typeof currentPeriodRow.modelCounts === 'object' ? currentPeriodRow.modelCounts : {}),
          ...(model ? {
            [model]: Number(currentPeriodRow?.modelCounts?.[model] || 0) + 1
          } : {})
        }
      }
    };
    const trimmedPeriods = Object.fromEntries(
      Object.entries(nextPeriods)
        .sort((left, right) => String(right[0]).localeCompare(String(left[0])))
        .slice(0, 12)
    );

    await Promise.all([
      writeJsonSetting(summaryKey, nextSummary),
      writeJsonSetting(recentKey, nextRecent),
      writeJsonSetting(periodsKey, trimmedPeriods)
    ]);

    return {
      summary: nextSummary,
      currentPeriod: {
        period: periodKey,
        ...(trimmedPeriods[periodKey] || { totalQueries: 0, aiResponses: 0, heuristicResponses: 0, modelCounts: {} })
      },
      periods: Object.entries(trimmedPeriods)
        .sort((left, right) => String(right[0]).localeCompare(String(left[0])))
        .map(([period, value]) => ({ period, ...(value || {}) })),
      recent: nextRecent
    };
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
