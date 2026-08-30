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
import { encrypt, decrypt, isEncryptionConfigured } from '../../lib/integration-crypto.js';
import { encryptSettingSecret, carrySettingSecret, decryptSettingSecret } from '../../lib/setting-secret-crypto.js';
import { invalidateTenantTerminalConfig } from '../payment-gateway/tenant-terminal-config.js';
import { resolveTenantProviderCredential } from '../../lib/tenant-provider-credential.js';
import { normalizePolicy as normalizeTwoFactorPolicy, VALID_TWO_FACTOR_ROLES } from '../../lib/two-factor-policy.js';
import { isCheckoutPaymentRequired, setCheckoutPaymentRequired } from './checkout-payment-policy.js';

const DEFAULTS = {
  companyName: 'Ride Fleet',
  companyAddress: 'San Juan, Puerto Rico',
  companyPhone: '(787) 000-0000',
  companyLogoUrl: '',
  termsText:
    'Renter acknowledges responsibility for the vehicle, traffic violations, tolls, and damages while in possession. Charges shown are estimates and may be adjusted according to final inspection, fuel level, mileage, fees, taxes, and applicable policy terms.',
  returnInstructionsText:
    '1) Return vehicle clean and with agreed fuel level. 2) Report damage before handoff. 3) Return keys/documents to staff. 4) After-hours returns may include additional fees.',
  agreementHtmlTemplate: '',
  // Per-tenant override for the canonical T&C HTML. Empty string means
  // "use the canonical lib/terms/tc-<TC_VERSION>.html"; any non-empty value
  // supersedes it via getEffectiveTermsHtml(), which since 2026-07-24 resolves
  // location → tenant → canonical — so a branch that sets its own
  // Location.termsHtml outranks this tenant-level value.
  termsHtml: '',
  // Per-tenant loaner T&C override (2026-06-26). Used on loaner (DEALERSHIP_LOANER) agreements
  // instead of the rental T&C when set; empty = fall back to the rental T&C.
  loanerTermsHtml: '',
  // Affidavit of Transfer of Liability (citations, Fase D #4) — the registered
  // OWNER / legal entity that submits the affidavit. May differ from the rental
  // brand (companyName). When blank, the affidavit falls back to companyName /
  // companyAddress / companyPhone.
  affidavitOwnerName: '',
  affidavitOwnerAddress: '',
  affidavitOwnerPhone: '',
  // Email branding (2026-06-27): brand color + support link for the unified
  // transactional email template. Empty brand color => RFM default (#8752FE).
  emailBrandColor: '',
  emailSupportUrl: '',
  // Per-tenant FROM address (2026-08-11, Hector: Rent & Go's emails should
  // come from noreply@THEIR domain, not @ridefleetmanager.com). ONLY set
  // after the domain is VERIFIED in MailerSend (SPF + DKIM green): an
  // unverified from domain is a hard reject, not a spam-folder problem. The
  // mailer falls back to the platform default when the tenant-from send
  // fails, so a wrong value degrades the address, never the delivery.
  emailFromAddress: ''
};

const ALLOWED_KEYS = Object.keys(DEFAULTS);

// Pre-check-in auto-email (2026-06-28). Tenants opt in to automatically emailing
// the pre-check-in invite N hours before pickup, plus an optional reminder closer
// to pickup if the customer hasn't completed it. Lead-time presets: 24/48/72h.
const PRECHECKIN_LEAD_PRESETS = [24, 48, 72];
function clampLead(v, fallback) {
  const n = Number(v);
  return PRECHECKIN_LEAD_PRESETS.includes(n) ? n : fallback;
}
function normalizePrecheckinAutoEmail(p = {}) {
  const leadHours = clampLead(p?.leadHours, 48);
  let reminderLeadHours = clampLead(p?.reminderLeadHours, 24);
  // Reminder must fire AFTER the invite (i.e. closer to pickup => fewer hours out).
  if (reminderLeadHours >= leadHours) reminderLeadHours = Math.min(...PRECHECKIN_LEAD_PRESETS.filter((h) => h < leadHours), 24);
  if (!Number.isFinite(reminderLeadHours)) reminderLeadHours = 24;
  return {
    enabled: !!p?.enabled,
    leadHours,
    reminderEnabled: p?.reminderEnabled === undefined ? true : !!p?.reminderEnabled,
    reminderLeadHours
  };
}

// Market Intelligence dashboard SIPP picker (beta.134). A tenant pins up to 6 of
// these to their MI dashboard card. Keep in sync with SIPP_NAMES in the frontend
// MarketIntelligenceCard.jsx. Unknown codes are rejected on save.
const DASHBOARD_SIPP_CODES = [
  'ECAR', 'CCAR', 'ICAR', 'SCAR', 'FCAR', 'PCAR', 'LCAR',
  'CFAR', 'IFAR', 'SFAR', 'FFAR', 'PFAR', 'LFAR', 'RFAR', 'XFAR', 'FJAR', 'FVAR',
  'MVAR', 'SPAR', 'STAR', 'PUAR'
];
const DASHBOARD_SIPP_MAX = 6;

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

const DEFAULT_REVIEW_EMAIL_CONFIG = {
  enabled: false,
  trigger: 'CHECKED_IN', // 'OFF' | 'CHECKED_OUT' | 'CHECKED_IN'
  reviewLinkUrl: ''
};

function normalizeReviewTrigger(raw) {
  const v = String(raw || '').toUpperCase();
  return ['OFF', 'CHECKED_OUT', 'CHECKED_IN'].includes(v) ? v : 'CHECKED_IN';
}


const DEFAULT_RESERVATION_OPTIONS = {
  autoAssignVehicleFromType: false,
  requireFranchiseSelection: false,
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
  zubieWebhookSecret: '',
  // Voltswitch GPS pull-based integration
  allowVoltswitchConnector: false,
  voltswitchApiEmail: '',
  voltswitchApiPassword: '',
  voltswitchSyncIntervalMinutes: 5
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
  const validProviders = ['ZUBIE', 'GENERIC', 'SAMSARA', 'GEOTAB', 'AZUGA', 'VOLTSWITCH'];
  const provider = validProviders.includes(String(raw?.provider || DEFAULT_TELEMATICS_CONFIG.provider).trim().toUpperCase())
    ? String(raw?.provider || DEFAULT_TELEMATICS_CONFIG.provider).trim().toUpperCase()
    : DEFAULT_TELEMATICS_CONFIG.provider;
  const allowManualEventIngest = raw?.allowManualEventIngest == null ? !!DEFAULT_TELEMATICS_CONFIG.allowManualEventIngest : !!raw?.allowManualEventIngest;
  const allowZubieConnector = raw?.allowZubieConnector == null ? !!DEFAULT_TELEMATICS_CONFIG.allowZubieConnector : !!raw?.allowZubieConnector;
  const zubieWebhookSecret = String(raw?.zubieWebhookSecret || '').trim();
  const webhookAuthMode = normalizeWebhookAuthMode(raw?.webhookAuthMode);
  const connectorEnabled = provider === 'ZUBIE' && allowZubieConnector;

  // Voltswitch GPS
  const allowVoltswitchConnector = raw?.allowVoltswitchConnector == null ? !!DEFAULT_TELEMATICS_CONFIG.allowVoltswitchConnector : !!raw?.allowVoltswitchConnector;
  // Dual-read: stored values may be `enci:` ciphertext (2026-08-24) or legacy
  // plaintext; decryptSettingSecret passes plaintext through and yields '' on
  // a failed decrypt, so a missing key reads as "no credentials", never as
  // ciphertext leaking into the UI or a Voltswitch login attempt.
  const voltswitchApiEmail = String(decryptSettingSecret(raw?.voltswitchApiEmail) || '').trim();
  const voltswitchApiPassword = String(decryptSettingSecret(raw?.voltswitchApiPassword) || '').trim();
  const voltswitchSyncIntervalMinutes = Math.max(1, Math.min(60, Number(raw?.voltswitchSyncIntervalMinutes) || DEFAULT_TELEMATICS_CONFIG.voltswitchSyncIntervalMinutes));
  const voltswitchConnectorReady = provider === 'VOLTSWITCH' && allowVoltswitchConnector && !!voltswitchApiEmail && !!voltswitchApiPassword;

  return {
    enabled,
    provider,
    allowManualEventIngest,
    allowZubieConnector,
    webhookAuthMode,
    zubieWebhookSecret: includeSecret ? zubieWebhookSecret : '',
    zubieWebhookSecretMasked: zubieWebhookSecret ? maskSecret(zubieWebhookSecret) : '',
    hasZubieWebhookSecret: !!zubieWebhookSecret,
    // Voltswitch
    allowVoltswitchConnector,
    voltswitchApiEmail,
    voltswitchApiPassword: includeSecret ? voltswitchApiPassword : '',
    voltswitchApiPasswordMasked: voltswitchApiPassword ? maskSecret(voltswitchApiPassword) : '',
    hasVoltswitchCredentials: !!voltswitchApiEmail && !!voltswitchApiPassword,
    voltswitchSyncIntervalMinutes,
    voltswitchConnectorReady,
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
    // Post-check-in autocharge of any unpaid balance (gas/cleaning/late fees).
    // mode AUTO → charge automatically `delayHours` after check-in (drop-and-go).
    // mode MANUAL → never auto-charge; balance is collected by staff in the
    // reservation's View Payments tab.
    autocharge: {
      mode: 'AUTO',        // 'AUTO' | 'MANUAL'
      delayHours: 24       // hours after check-in to charge (AUTO only)
    },
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
      // 2026-05-29 — Production-only deployment. The Spin client no
      // longer has a sandbox code path (SPIN_ENV / SPIN_SANDBOX removed);
      // exposing those fields here would be misleading. environment is
      // pinned to 'production' for the admin panel display.
      //
      // 2026-08-26 — the PLATFORM env terminal is no longer used as this
      // tenant's default. Two reasons, both money-safety:
      //   1. SPIN_AUTH_KEY is a live payment credential; pre-filling it into
      //      every tenant admin's Settings form handed the platform merchant's
      //      key to anyone with tenant ADMIN.
      //   2. Worse, the form round-trips: a tenant admin who opened the page
      //      and pressed Save would have COPIED the platform TPN into their own
      //      config, permanently pinning their charges to somebody else's
      //      merchant account. That is the wrong-merchant bug, self-inflicted
      //      through the UI.
      // An unconfigured tenant now reads as empty here, and the charge path
      // decides what to do about it (modules/payment-gateway/tenant-terminal-config).
      enabled: false,
      environment: 'production',
      // NEVER populated on read — see getPaymentGatewayConfig. `hasAuthKey`
      // is what tells the UI a key is on file.
      authKey: '',
      hasAuthKey: false,
      tpn: '',
      merchantNumber: '1',
      callbackUrl: '',
      proxyTimeout: '120'
    },
    // iPOSpays Hosted Payment Page — customer PAYMENT LINKS for tenants who
    // transact through iPOS/Dejavoo (gateway: 'ipos'). Distinct from the
    // `spin` block above (card-present terminal) although the two share a
    // merchant: the HPP is tied to a CloudPOS TPN and authenticates with an
    // ecom token generated in the iPOSpays portal.
    //
    // DELIBERATELY NO env defaults. Platform env credentials belong to Ride's
    // merchant accounts; pre-filling them here is how a tenant's payment link
    // settles into the wrong merchant (see the spin block's 2026-08-26 note).
    // An unconfigured tenant reads as empty and the link-minting path fails
    // closed with an operator-facing message.
    ipos: {
      enabled: false,
      environment: 'production',
      // CloudPOS TPN. Blank falls back to spin.tpn at resolve time (same
      // tenant, same merchant) — see payment-gateway/ipos-hpp-client.js.
      tpn: '',
      // NEVER populated on read — `hasHppToken` tells the UI one is on file.
      // Stored as `enci:` ciphertext like spin.authKey.
      hppToken: '',
      hasHppToken: false,
      // The Merchant API Key from the portal's Generate Keys section. A
      // SECOND credential, not the token: the mint authenticates with the
      // ecom token in a `token` header, but queryPaymentStatus authenticates
      // with THIS key in the Authorization header — learned live 2026-08-29
      // when the status check 401'd the token on the owner's first real
      // payment. Same never-on-read / ciphertext contract as hppToken.
      apiKey: '',
      hasApiKey: false,
      // Hosted-link expiry in days (iPOSpays accepts 1–31).
      expiryDays: 3
    },
    // PayArc — used for US-mainland car-sharing pickups. Puerto Rico
    // pickups stay on Authorize.Net regardless. Selector lives in
    // public-booking/payarc-hosted-fields.js → selectPaymentGateway().
    //
    // `bearerToken`  — server-only API key (Authorization: Bearer <key>)
    // `publicKey`    — safe to embed in the mobile WebView bridge page
    // `webhookSecret`— HMAC secret for incoming webhook validation
    //                  (TODO: confirm header name + algorithm against
    //                  docs.payarc.net/reference/add-webhooks once
    //                  dashboard access is available)
    payarc: {
      enabled: !!process.env.PAYARC_BEARER_TOKEN,
      environment: String(process.env.PAYARC_ENV || 'sandbox').toLowerCase(),
      bearerToken: String(process.env.PAYARC_BEARER_TOKEN || ''),
      publicKey: String(process.env.PAYARC_PUBLIC_KEY || ''),
      webhookSecret: String(process.env.PAYARC_WEBHOOK_SECRET || ''),
      merchantId: String(process.env.PAYARC_MERCHANT_ID || ''),
      merchantEmail: String(process.env.PAYARC_MERCHANT_EMAIL || '')
    }
  };
}

/**
 * Shape the stored `spin` block for a READ.
 *
 * The Dejavoo/SPIn authKey is a live payment credential. Since 2026-08-26 it is
 * stored as `enci:` ciphertext (lib/setting-secret-crypto) and is NEVER handed
 * back to the client — not the ciphertext (useless and leaky) and not the
 * plaintext (the settings page is not a credential vault). The UI gets a
 * boolean instead and follows blank-means-keep on save, exactly like the
 * VoltSwitch credentials do.
 *
 * `clearAuthKey` is a write-only command flag; it must never echo back.
 */
function spinBlockForRead(spin = {}) {
  const stored = typeof spin?.authKey === 'string' ? spin.authKey.trim() : '';
  const out = { ...spin, authKey: '', hasAuthKey: !!stored };
  delete out.clearAuthKey;
  return out;
}

/**
 * Shape the stored `ipos` block for a READ. Same rule as spinBlockForRead:
 * the HPP auth token is a live payment credential — the UI gets a boolean and
 * blank-means-keep on save, never the ciphertext and never the plaintext.
 */
function iposBlockForRead(ipos = {}) {
  const stored = typeof ipos?.hppToken === 'string' ? ipos.hppToken.trim() : '';
  const storedKey = typeof ipos?.apiKey === 'string' ? ipos.apiKey.trim() : '';
  const out = {
    ...ipos,
    hppToken: '', hasHppToken: !!stored,
    apiKey: '', hasApiKey: !!storedKey,
  };
  delete out.clearHppToken;
  delete out.clearApiKey;
  return out;
}

/** Clamp the HPP link expiry to iPOSpays' documented 1–31 day window. */
function iposExpiryDaysValue(raw, fallback = 3) {
  if (raw === '' || raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(31, Math.max(1, Math.round(n)));
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

  async getReviewEmailConfig(scope = {}) {
    const row = await prisma.appSetting.findUnique({ where: { key: scopedKey('reviewEmail', scope) } });
    if (!row?.value) return { ...DEFAULT_REVIEW_EMAIL_CONFIG };
    try {
      const parsed = JSON.parse(row.value);
      return {
        ...DEFAULT_REVIEW_EMAIL_CONFIG,
        enabled: !!parsed?.enabled,
        trigger: normalizeReviewTrigger(parsed?.trigger),
        reviewLinkUrl: String(parsed?.reviewLinkUrl || '')
      };
    } catch {
      return { ...DEFAULT_REVIEW_EMAIL_CONFIG };
    }
  },

  async updateReviewEmailConfig(payload = {}, scope = {}) {
    const next = {
      enabled: !!payload?.enabled,
      trigger: normalizeReviewTrigger(payload?.trigger),
      reviewLinkUrl: String(payload?.reviewLinkUrl || '')
    };
    const key = scopedKey('reviewEmail', scope);
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

  async getPrecheckinAutoEmail(scope = {}) {
    const row = await prisma.appSetting.findUnique({ where: { key: scopedKey('precheckinAutoEmail', scope) } });
    const DEF = { enabled: false, leadHours: 48, reminderEnabled: true, reminderLeadHours: 24 };
    if (!row?.value) return { ...DEF };
    try {
      const p = JSON.parse(row.value);
      return normalizePrecheckinAutoEmail(p);
    } catch {
      return { ...DEF };
    }
  },

  async updatePrecheckinAutoEmail(payload = {}, scope = {}) {
    const next = normalizePrecheckinAutoEmail(payload);
    const key = scopedKey('precheckinAutoEmail', scope);
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
      requireFranchiseSelection: !!payload?.requireFranchiseSelection,
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

  // Customer-led inspection (2026-06-11): when enabled, checkout step 4 can
  // delegate the walkthrough to the customer (email link + damage dots).
  // checkinModel (Fase D, 2026-06-18): 'AGENT' = the agent does the return inspection (today's
  // behavior) · 'CUSTOMER' = the customer self-inspects at return, so the agent can skip the
  // inspection step and close (agent can still view/add). Only takes effect when enabled=true.
  /**
   * Per-tenant "is the wizard's payment step mandatory?" switch (2026-08-26).
   *
   * Storage / fail-safe rules live in checkout-payment-policy.js — this is the
   * API-shaped wrapper. FAIL-CLOSED ON TENANT: without a tenantId we throw
   * rather than read or write the unscoped key, because the unscoped key would
   * be a GLOBAL default that could turn payment off for every tenant at once.
   * (A SUPER_ADMIN who has not picked a tenant hits this and gets a 400.)
   */
  async getCheckoutPaymentPolicy(scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    return { checkoutPaymentRequired: await isCheckoutPaymentRequired(scope.tenantId) };
  },

  async updateCheckoutPaymentPolicy(payload = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const raw = payload?.checkoutPaymentRequired;
    // Strict boolean on the WRITE path so a client that sends "false"/0/null
    // gets a clear 400 instead of silently landing on the safe default and
    // leaving the admin staring at a switch that snapped back. The storage
    // layer normalizes again anyway (defense in depth).
    if (typeof raw !== 'boolean') {
      throw new Error('checkoutPaymentRequired must be a boolean');
    }
    const value = await setCheckoutPaymentRequired(scope.tenantId, raw);
    return { checkoutPaymentRequired: value };
  },

  async getCustomerInspectionConfig(scope = {}) {
    const row = await prisma.appSetting.findUnique({ where: { key: scopedKey('customerInspectionConfig', scope) } });
    const fallback = { enabled: false, checkinModel: 'AGENT' };
    if (!row?.value) return fallback;
    try {
      const parsed = JSON.parse(row.value);
      const checkinModel = String(parsed?.checkinModel || 'AGENT').toUpperCase() === 'CUSTOMER' ? 'CUSTOMER' : 'AGENT';
      return { enabled: !!parsed?.enabled, checkinModel };
    } catch {
      return fallback;
    }
  },

  async updateCustomerInspectionConfig(payload = {}, scope = {}) {
    const checkinModel = String(payload?.checkinModel || 'AGENT').toUpperCase() === 'CUSTOMER' ? 'CUSTOMER' : 'AGENT';
    const next = { enabled: !!payload?.enabled, checkinModel };
    const key = scopedKey('customerInspectionConfig', scope);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) }
    });
    return next;
  },

  // Vehicle Profile pack (2026-06-10): per-tenant fleet-rotation rule.
  // rule = 'TIME' (months in fleet vs Vehicle.targetFleetMonths) or
  //        'MILEAGE' (Vehicle.mileage vs Vehicle.targetFleetMiles).
  async getFleetRotationConfig(scope = {}) {
    const row = await prisma.appSetting.findUnique({ where: { key: scopedKey('fleetRotationConfig', scope) } });
    const fallback = { rule: 'TIME' };
    if (!row?.value) return fallback;
    try {
      const parsed = JSON.parse(row.value);
      const rule = String(parsed?.rule || 'TIME').toUpperCase();
      return { rule: rule === 'MILEAGE' ? 'MILEAGE' : 'TIME' };
    } catch {
      return fallback;
    }
  },

  async updateFleetRotationConfig(payload = {}, scope = {}) {
    const rule = String(payload?.rule || 'TIME').toUpperCase();
    const next = { rule: rule === 'MILEAGE' ? 'MILEAGE' : 'TIME' };
    const key = scopedKey('fleetRotationConfig', scope);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) }
    });
    return next;
  },

  // Citations OCR (2026-06-15): per-tenant vision-LLM credentials for the mail
  // intake. The API key is stored ENCRYPTED (integration-crypto, same as TL).
  // getCitationOcrConfig is the safe/masked read for the UI (NEVER returns the
  // key); getCitationOcrResolved is the internal read the worker uses (decrypts).
  async getCitationOcrConfig(scope = {}) {
    const cfg = await readJsonSetting(scopedKey('citationOcrConfig', scope), null);
    return {
      provider: String(cfg?.provider || 'anthropic').toLowerCase(),
      model: cfg?.model || '',
      confidenceMin: Number.isFinite(Number(cfg?.confidenceMin)) ? Number(cfg.confidenceMin) : 70,
      hasKey: !!cfg?.apiKeyEncrypted,
      // 2026-08-27. The opt-in that has to be TRUE before this tenant's
      // documents may be sent to the provider under the PLATFORM account.
      // Defaults false for every tenant, including ones that pre-date this
      // field — an absent key in an old AppSetting row reads as "no", which is
      // exactly the posture the Corpusa incident should have had.
      allowPlatformKeyFallback: !!cfg?.allowPlatformKeyFallback,
    };
  },

  async updateCitationOcrConfig(payload = {}, scope = {}) {
    const key = scopedKey('citationOcrConfig', scope);
    const current = await readJsonSetting(key, {});
    const provider = String(payload?.provider || current.provider || 'anthropic').toLowerCase();
    const model = payload?.model !== undefined ? String(payload.model || '') : (current.model || '');
    let confidenceMin = Number.isFinite(Number(current?.confidenceMin)) ? Number(current.confidenceMin) : 70;
    if (payload?.confidenceMin !== undefined && payload.confidenceMin !== null && `${payload.confidenceMin}`.trim() !== '') {
      const n = Number(payload.confidenceMin);
      if (Number.isFinite(n)) confidenceMin = Math.max(0, Math.min(100, n));
    }
    let apiKeyEncrypted = current.apiKeyEncrypted || null;
    if (payload?.clearKey === true) {
      apiKeyEncrypted = null;
    } else if (typeof payload?.apiKey === 'string' && payload.apiKey.trim()) {
      if (!isEncryptionConfigured()) throw new Error('Encryption key (INTEGRATION_ENC_KEY) is not configured');
      apiKeyEncrypted = encrypt(payload.apiKey.trim());
    }
    // Opt-in to the PLATFORM key. Only an explicit boolean in the payload
    // moves it; anything else preserves what is on file, so a partial PUT from
    // the Settings page (provider/model only) can never silently turn it on.
    let allowPlatformKeyFallback = !!current.allowPlatformKeyFallback;
    if (typeof payload?.allowPlatformKeyFallback === 'boolean') {
      allowPlatformKeyFallback = payload.allowPlatformKeyFallback;
    }
    await writeJsonSetting(key, { provider, model, confidenceMin, apiKeyEncrypted, allowPlatformKeyFallback });
    return { provider, model, confidenceMin, hasKey: !!apiKeyEncrypted, allowPlatformKeyFallback };
  },

  // Internal — decrypts the key for the OCR worker. Returns
  // { provider, model, confidenceMin, apiKey|null, allowPlatformKeyFallback }.
  //
  // NOTE: `apiKey` here is the TENANT'S OWN key and nothing else. It has never
  // meant "the key to call with" — every caller used to finish the job with
  // `cfg.apiKey || process.env.ANTHROPIC_API_KEY`, which is the bug. Callers
  // must now go through resolveCitationOcrCredential() below.
  async getCitationOcrResolved(scope = {}) {
    const cfg = await readJsonSetting(scopedKey('citationOcrConfig', scope), null);
    let apiKey = null;
    if (cfg?.apiKeyEncrypted) {
      try { apiKey = decrypt(cfg.apiKeyEncrypted); } catch { apiKey = null; }
    }
    return {
      provider: String(cfg?.provider || 'anthropic').toLowerCase(),
      model: cfg?.model || '',
      confidenceMin: Number.isFinite(Number(cfg?.confidenceMin)) ? Number(cfg.confidenceMin) : null,
      apiKey,
      allowPlatformKeyFallback: !!cfg?.allowPlatformKeyFallback,
    };
  },

  /**
   * The ONE credential read for every Anthropic-backed, tenant-scoped feature
   * that shares the citationOcrConfig block: citation mail OCR, kiosk ID photo
   * reading and commission review-proof validation.
   *
   * Returns the tenant's provider/model/threshold PLUS a `credential` decision
   * from lib/tenant-provider-credential.js — `{ credential, source, reason }`,
   * where source is TENANT / PLATFORM / NONE and a PLATFORM resolution has
   * already WARNed by tenant and feature. A NONE result carries an empty
   * credential; callers must fail closed on it rather than reaching for env.
   *
   * `feature` distinguishes the three consumers so the opt-in allowlist and the
   * log line name which one is calling out — the citation scheduler and the
   * kiosk are very different data-protection stories even though they read the
   * same key.
   */
  async resolveCitationOcrCredential(scope = {}, { feature = 'citation-ocr' } = {}) {
    const cfg = await this.getCitationOcrResolved(scope);
    const tenantId = scope?.tenantId || null;
    let tenantName = '';
    if (tenantId) {
      // Cosmetic — only used to make the WARN readable. A failed lookup must
      // never change the decision, so it degrades to ''.
      try {
        const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
        tenantName = String(t?.name || '');
      } catch { tenantName = ''; }
    }
    const credential = resolveTenantProviderCredential({
      tenantId,
      feature,
      tenantCredential: cfg.apiKey || '',
      platformCredential: process.env.ANTHROPIC_API_KEY || '',
      tenantOptIn: cfg.allowPlatformKeyFallback,
      tenantName,
    });
    return { ...cfg, credential };
  },

  // Staff 2FA policy (2026-08-22). Stored as AppSetting JSON under
  // scopedKey('twoFactorPolicy', scope): unscoped = the global default a
  // SUPER_ADMIN sets, `tenant:<id>:twoFactorPolicy` = a tenant override. There
  // is NO secret here, so read is unmasked. resolveTwoFactorPolicy (in
  // lib/two-factor-policy) merges global+tenant at login time.
  async getTwoFactorPolicy(scope = {}) {
    const cfg = await readJsonSetting(scopedKey('twoFactorPolicy', scope), null);
    return {
      ...normalizeTwoFactorPolicy(cfg),
      isSet: cfg !== null,
      availableRoles: VALID_TWO_FACTOR_ROLES
    };
  },

  async updateTwoFactorPolicy(payload = {}, scope = {}) {
    const enabled = !!payload?.enabled;
    // Guard against an un-enrollable state (QA, 2026-08-22): 2FA secrets are
    // AES-256-GCM encrypted, so enrollment 503s when INTEGRATION_ENC_KEY is
    // unset. Enabling a policy in that state would compel required users to
    // enroll while enrollment is impossible — nobody can get in. Refuse the
    // flip instead of bricking the tenant. Disabling is always allowed.
    if (enabled && !isEncryptionConfigured()) {
      const err = new Error('Cannot enable two-factor authentication: encryption key (INTEGRATION_ENC_KEY) is not configured');
      err.code = 'ENCRYPTION_NOT_CONFIGURED';
      throw err;
    }
    const requiredRoles = Array.isArray(payload?.requiredRoles)
      ? Array.from(new Set(payload.requiredRoles.map((r) => String(r || '').toUpperCase())))
      : [];
    for (const role of requiredRoles) {
      if (!VALID_TWO_FACTOR_ROLES.includes(role)) {
        throw new Error(`Invalid role in requiredRoles: ${role}`);
      }
    }
    let graceUntil = null;
    if (payload?.graceUntil) {
      const d = new Date(payload.graceUntil);
      if (Number.isNaN(d.getTime())) throw new Error('graceUntil must be a valid date');
      graceUntil = d.toISOString();
    }
    if (enabled && !requiredRoles.length) {
      throw new Error('Enable at least one required role, or leave the policy disabled');
    }
    const value = { enabled, requiredRoles, graceUntil };
    await writeJsonSetting(scopedKey('twoFactorPolicy', scope), value);
    return { ...value, isSet: true, availableRoles: VALID_TWO_FACTOR_ROLES };
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
        spin: spinBlockForRead({
          ...defaults.spin,
          ...(parsed?.spin || {})
        }),
        ipos: iposBlockForRead({
          ...defaults.ipos,
          ...(parsed?.ipos || {})
        }),
        payarc: {
          ...defaults.payarc,
          ...(parsed?.payarc || {})
        },
        autocharge: {
          ...defaults.autocharge,
          ...(parsed?.autocharge || {})
        }
      };
    } catch {
      return defaults;
    }
  },

  async updatePaymentGatewayConfig(payload = {}, scope = {}) {
    const defaults = defaultPaymentGatewayConfig();
    const key = scopedKey('paymentGatewayConfig', scope);

    // Blank-means-keep for the SPIn authKey must carry the STORED BYTES, never
    // a decrypt→re-encrypt round trip: if INTEGRATION_ENC_KEY were missing or
    // wrong for one request, the decrypted value would read '' and the save
    // would silently ERASE a live terminal credential — the 2026-08-13
    // VoltSwitch bug, on the money path this time. So read the raw row.
    let storedRaw = {};
    try {
      const rawRow = await prisma.appSetting.findUnique({ where: { key } });
      storedRaw = rawRow?.value ? (JSON.parse(rawRow.value) || {}) : {};
    } catch {
      storedRaw = {};
    }
    const newSpinAuthKey = String(payload?.spin?.authKey || '').trim();
    const newIposHppToken = String(payload?.ipos?.hppToken || '').trim();
    const newIposApiKey = String(payload?.ipos?.apiKey || '').trim();

    const next = {
      ...defaults,
      ...(payload || {}),
      gateway: String(payload?.gateway || defaults.gateway).trim().toLowerCase(),
      label: String(payload?.label || defaults.label).trim(),
      autocharge: {
        mode: String(payload?.autocharge?.mode || defaults.autocharge.mode).trim().toUpperCase() === 'MANUAL' ? 'MANUAL' : 'AUTO',
        delayHours: (() => {
          const raw = payload?.autocharge?.delayHours;
          if (raw === '' || raw == null) return defaults.autocharge.delayHours; // cleared → default, not 0
          const h = Number(raw);
          if (!Number.isFinite(h) || h < 0) return defaults.autocharge.delayHours;
          return Math.min(Math.round(h), 720); // clamp 0–720h (30 days)
        })()
      },
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
        // ENCRYPTED AT REST (2026-08-26). Blank in the payload means KEEP —
        // the read path never gives the UI the key back, so a plain form
        // round-trip must not wipe it. Only `clearAuthKey: true` erases.
        // encryptSettingSecret THROWS (code ENCRYPTION_NOT_CONFIGURED) rather
        // than storing a new live credential in plaintext.
        authKey: payload?.spin?.clearAuthKey
          ? ''
          : (newSpinAuthKey
            ? encryptSettingSecret(newSpinAuthKey)
            : carrySettingSecret(storedRaw?.spin?.authKey)),
        tpn: String(payload?.spin?.tpn || '').trim(),
        merchantNumber: String(payload?.spin?.merchantNumber || '1').trim(),
        callbackUrl: String(payload?.spin?.callbackUrl || '').trim(),
        proxyTimeout: String(payload?.spin?.proxyTimeout || '120').trim(),
        // Read-shape / command-only fields never belong in the stored blob.
        hasAuthKey: undefined,
        clearAuthKey: undefined
      },
      ipos: {
        ...defaults.ipos,
        ...(payload?.ipos || {}),
        enabled: !!payload?.ipos?.enabled,
        environment: String(payload?.ipos?.environment || defaults.ipos.environment).trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production',
        tpn: String(payload?.ipos?.tpn || '').trim(),
        // Same encrypted-at-rest, blank-means-keep contract as spin.authKey:
        // the read path never returns the token, so a plain form round-trip
        // must not wipe it. Only `clearHppToken: true` erases.
        hppToken: payload?.ipos?.clearHppToken
          ? ''
          : (newIposHppToken
            ? encryptSettingSecret(newIposHppToken)
            : carrySettingSecret(storedRaw?.ipos?.hppToken)),
        // Same contract for the API Key (the status-check credential).
        apiKey: payload?.ipos?.clearApiKey
          ? ''
          : (newIposApiKey
            ? encryptSettingSecret(newIposApiKey)
            : carrySettingSecret(storedRaw?.ipos?.apiKey)),
        expiryDays: iposExpiryDaysValue(payload?.ipos?.expiryDays, defaults.ipos.expiryDays),
        // Read-shape / command-only fields never belong in the stored blob.
        hasHppToken: undefined,
        clearHppToken: undefined,
        hasApiKey: undefined,
        clearApiKey: undefined
      },
      payarc: {
        ...defaults.payarc,
        ...(payload?.payarc || {}),
        enabled: !!payload?.payarc?.enabled,
        environment: String(payload?.payarc?.environment || defaults.payarc.environment).trim().toLowerCase(),
        bearerToken: String(payload?.payarc?.bearerToken || '').trim(),
        publicKey: String(payload?.payarc?.publicKey || '').trim(),
        webhookSecret: String(payload?.payarc?.webhookSecret || '').trim(),
        merchantId: String(payload?.payarc?.merchantId || '').trim(),
        merchantEmail: String(payload?.payarc?.merchantEmail || '').trim()
      }
    };
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) }
    });
    // The live charge path caches this row (60s TTL). Invalidate HERE, in the
    // service, so every writer of this key invalidates — not just the one route
    // we happen to know about today. Cross-worker fan-out rides the cache's
    // Redis pub/sub.
    invalidateTenantTerminalConfig(scope?.tenantId);
    // Re-read rather than returning `next`: `next.spin.authKey` is CIPHERTEXT
    // at this point and must not go back over the wire.
    return this.getPaymentGatewayConfig(scope);
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

  // --- Market Intelligence dashboard SIPP picker (beta.134) -----------------
  // Up to 6 SIPP codes the tenant pins to the MI dashboard card, stored on
  // Tenant.dashboardSipps (JSON array). Empty → card falls back to the top 6 by
  // market volume. getDashboardSipps also returns the valid option list + max so
  // the Settings UI can render the picker without hardcoding the SIPP catalog.
  async getDashboardSipps(scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const tenant = await prisma.tenant.findUnique({
      where: { id: scope.tenantId },
      select: { dashboardSipps: true }
    });
    const raw = Array.isArray(tenant?.dashboardSipps) ? tenant.dashboardSipps : [];
    const sipps = Array.from(new Set(
      raw
        .map((s) => String(s || '').trim().toUpperCase())
        .filter((s) => DASHBOARD_SIPP_CODES.includes(s))
    )).slice(0, DASHBOARD_SIPP_MAX);
    return { sipps, options: DASHBOARD_SIPP_CODES, max: DASHBOARD_SIPP_MAX };
  },

  async updateDashboardSipps(payload = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const input = Array.isArray(payload?.sipps) ? payload.sipps : [];
    const cleaned = Array.from(new Set(
      input
        .map((s) => String(s || '').trim().toUpperCase())
        .filter((s) => DASHBOARD_SIPP_CODES.includes(s))
    )).slice(0, DASHBOARD_SIPP_MAX);
    await prisma.tenant.update({
      where: { id: scope.tenantId },
      // null (not []) when empty so the card cleanly falls back to top-6-by-volume.
      data: { dashboardSipps: cleaned.length ? cleaned : null }
    });
    return { sipps: cleaned, options: DASHBOARD_SIPP_CODES, max: DASHBOARD_SIPP_MAX };
  },

  // --- Market Intelligence excluded competitors (per-tenant pool hygiene) ----
  // Tenant.marketExcludedVendors (JSON array of vendor names). The tenant lists
  // their own brand(s) + any vendors to drop from the competitor pool so the
  // pricing engine never compares against itself. Empty → no filtering.
  async getMarketExcludedVendors(scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const tenant = await prisma.tenant.findUnique({
      where: { id: scope.tenantId },
      select: { marketExcludedVendors: true }
    });
    const vendors = Array.isArray(tenant?.marketExcludedVendors)
      ? tenant.marketExcludedVendors.map((v) => String(v || '').trim()).filter(Boolean)
      : [];
    return { vendors };
  },

  async updateMarketExcludedVendors(payload = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const input = Array.isArray(payload?.vendors) ? payload.vendors : [];
    // Trim, drop blanks, de-dupe case-insensitively, cap at 50.
    const seen = new Set();
    const cleaned = [];
    for (const raw of input) {
      const name = String(raw || '').trim();
      if (!name) continue;
      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      cleaned.push(name);
      if (cleaned.length >= 50) break;
    }
    await prisma.tenant.update({
      where: { id: scope.tenantId },
      data: { marketExcludedVendors: cleaned.length ? cleaned : null }
    });
    return { vendors: cleaned };
  },

  // --- Tax-aware Market pricing config per location -------------------------
  // MarketPricingConfig rows let the engine back-solve the BASE rate from a target
  // ALL-IN price (undoing taxes + fees + brokerage). Per (tenant, location).
  async listMarketPricingConfigs(scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const rows = await prisma.marketPricingConfig.findMany({
      where: { tenantId: scope.tenantId },
      orderBy: { locationCode: 'asc' },
    });
    return {
      configs: rows.map((r) => ({
        id: r.id,
        locationCode: r.locationCode,
        connectionType: r.connectionType,
        taxes: Array.isArray(r.taxes) ? r.taxes : [],
        brokeragePct: Number(r.brokeragePct),
        floorBase: r.floorBase != null ? Number(r.floorBase) : null,
        ceilingBase: r.ceilingBase != null ? Number(r.ceilingBase) : null,
        maxDeltaPct: r.maxDeltaPct != null ? Number(r.maxDeltaPct) : null,
        utilizationRules: Array.isArray(r.utilizationRules) ? r.utilizationRules : [],
        currency: r.currency,
      })),
      connectionTypes: ['TITANIUM', 'AMADEUS'],
    };
  },

  async upsertMarketPricingConfig(payload = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const locationCode = String(payload?.locationCode || '').trim().toUpperCase();
    if (!locationCode) { const e = new Error('locationCode is required'); e.httpStatus = 400; throw e; }
    const connectionType = String(payload?.connectionType || 'TITANIUM').trim().toUpperCase();
    if (!['TITANIUM', 'AMADEUS'].includes(connectionType)) {
      const e = new Error('connectionType must be TITANIUM or AMADEUS'); e.httpStatus = 400; throw e;
    }
    // 2026-07-25 — a tax component may be a FLAT per-day fee (LAX Vehicle
    // License Fee $2/day) via `amountPerDay`, alongside or instead of `pct`.
    // This map used to whitelist {name, pct} only, which silently turned a
    // hand-seeded flat fee into a 0% no-op on the next Settings save — every
    // LAX suggestion would then land $2/day ABOVE the intended undercut (QA
    // BLOCKER B-1). Validation is loud: negatives and per-RENTAL flat fees
    // (an `amount` key — unsupported by per-day math) are rejected, never
    // guessed.
    const taxes = (Array.isArray(payload?.taxes) ? payload.taxes : [])
      .map((t) => {
        if (t?.amount !== undefined) {
          const e = new Error('Per-rental flat fees are not supported — use amountPerDay (USD per day)'); e.httpStatus = 400; throw e;
        }
        const pct = Number(t?.pct) || 0;
        const amountPerDay = (t?.amountPerDay === '' || t?.amountPerDay == null) ? 0 : Number(t.amountPerDay);
        if (!Number.isFinite(amountPerDay) || amountPerDay < 0) {
          const e = new Error('amountPerDay must be a number >= 0'); e.httpStatus = 400; throw e;
        }
        return {
          name: String(t?.name || '').trim() || 'Tax',
          pct,
          ...(amountPerDay > 0 ? { amountPerDay } : {})
        };
      })
      .filter((t) => t.pct !== 0 || (t.amountPerDay || 0) > 0 || t.name !== 'Tax');
    const brokeragePct = Number(payload?.brokeragePct) || 0;
    const floorBase = (payload?.floorBase === '' || payload?.floorBase == null) ? null : Number(payload.floorBase);
    // Auto-apply guardrails (nullable). ceilingBase = max BASE auto-apply may write;
    // maxDeltaPct = max % a single run may move a live price (beyond it → HELD).
    const ceilingBase = (payload?.ceilingBase === '' || payload?.ceilingBase == null) ? null : Number(payload.ceilingBase);
    const maxDeltaPct = (payload?.maxDeltaPct === '' || payload?.maxDeltaPct == null) ? null : Number(payload.maxDeltaPct);
    if (ceilingBase != null && (!Number.isFinite(ceilingBase) || ceilingBase < 0)) {
      const e = new Error('ceilingBase must be a positive number'); e.httpStatus = 400; throw e;
    }
    if (floorBase != null && ceilingBase != null && ceilingBase < floorBase) {
      const e = new Error('ceilingBase must be greater than or equal to floorBase'); e.httpStatus = 400; throw e;
    }
    if (maxDeltaPct != null && (!Number.isFinite(maxDeltaPct) || maxDeltaPct <= 0 || maxDeltaPct > 100)) {
      const e = new Error('maxDeltaPct must be a percent between 0 and 100'); e.httpStatus = 400; throw e;
    }
    const currency = String(payload?.currency || 'USD').trim().toUpperCase() || 'USD';
    // Utilization tiers (positional): { fromPct, type, n?|pct?|amount? }, sorted by fromPct.
    // type ∈ NTH_CHEAPEST | NTH_EXPENSIVE | MARKET | MARKET_PCT | CHEAPEST_MINUS.
    const TIER_TYPES = ['NTH_CHEAPEST', 'NTH_EXPENSIVE', 'MARKET', 'MARKET_PCT', 'CHEAPEST_MINUS'];
    const utilizationRules = (Array.isArray(payload?.utilizationRules) ? payload.utilizationRules : [])
      .map((t) => {
        const fromPct = Math.max(0, Math.min(100, Number(t?.fromPct) || 0));
        const type = String(t?.type || '').toUpperCase();
        const out = { fromPct, type };
        if (type === 'NTH_CHEAPEST' || type === 'NTH_EXPENSIVE') out.n = Math.max(1, Math.round(Number(t?.n) || 1));
        if (type === 'MARKET_PCT') out.pct = Number(t?.pct) || 0;
        if (type === 'CHEAPEST_MINUS') out.amount = Number(t?.amount) || 0;
        return out;
      })
      .filter((t) => TIER_TYPES.includes(t.type))
      .sort((a, b) => a.fromPct - b.fromPct);
    const data = { connectionType, taxes, brokeragePct, floorBase, ceilingBase, maxDeltaPct, utilizationRules, currency };
    const row = await prisma.marketPricingConfig.upsert({
      where: { tenantId_locationCode: { tenantId: scope.tenantId, locationCode } },
      create: { tenantId: scope.tenantId, locationCode, ...data },
      update: data,
    });
    return {
      id: row.id, locationCode: row.locationCode, connectionType: row.connectionType,
      taxes: Array.isArray(row.taxes) ? row.taxes : [], brokeragePct: Number(row.brokeragePct),
      floorBase: row.floorBase != null ? Number(row.floorBase) : null,
      ceilingBase: row.ceilingBase != null ? Number(row.ceilingBase) : null,
      maxDeltaPct: row.maxDeltaPct != null ? Number(row.maxDeltaPct) : null,
      utilizationRules: Array.isArray(row.utilizationRules) ? row.utilizationRules : [],
      currency: row.currency,
    };
  },

  async deleteMarketPricingConfig(locationCode, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const code = String(locationCode || '').trim().toUpperCase();
    await prisma.marketPricingConfig.deleteMany({ where: { tenantId: scope.tenantId, locationCode: code } });
    return { ok: true };
  },

  async updateTelematicsConfig(payload = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required');
    const existing = await this.getTelematicsConfig(scope, { includeSecret: true });
    // Blank-means-keep must carry the STORED credential bytes verbatim, never
    // a decrypt→re-encrypt round trip through `existing`: if the encryption
    // key were missing/wrong for one request, the decrypted value would read
    // '' and the save would silently erase the creds — the pre-2026-08-13 bug
    // in a new costume. So the carry reads the raw row. carrySettingSecret
    // keeps ciphertext as-is and lazily encrypts legacy plaintext (that IS the
    // migration: any save upgrades the blob).
    const key = scopedKey('telematicsConfig', scope);
    let stored = {};
    try {
      const rawRow = await prisma.appSetting.findUnique({ where: { key } });
      stored = rawRow?.value ? (JSON.parse(rawRow.value) || {}) : {};
    } catch {
      stored = {};
    }
    const newVoltswitchEmail = payload?.voltswitchApiEmail == null ? null : String(payload.voltswitchApiEmail).trim();
    const newVoltswitchPassword = String(payload?.voltswitchApiPassword || '').trim();
    const next = {
      enabled: !!payload?.enabled,
      provider: String(payload?.provider || DEFAULT_TELEMATICS_CONFIG.provider).trim().toUpperCase() || DEFAULT_TELEMATICS_CONFIG.provider,
      allowManualEventIngest: !!payload?.allowManualEventIngest,
      allowZubieConnector: !!payload?.allowZubieConnector,
      webhookAuthMode: normalizeWebhookAuthMode(payload?.webhookAuthMode),
      zubieWebhookSecret: payload?.clearZubieWebhookSecret
        ? ''
        : String(payload?.zubieWebhookSecret || '').trim() || String(existing?.zubieWebhookSecret || '').trim(),
      // Voltswitch GPS. Before 2026-08-13 these keys were silently DROPPED
      // here, so any save from the UI erased the connector's config — that is
      // why the connector never went live. The password follows the
      // zubieWebhookSecret rule: blank in the payload means "keep what is
      // saved"; only the explicit clear flag erases. Since 2026-08-24 both
      // credential fields are stored as `enci:` ciphertext (setting-secret-
      // crypto); a kept value carries the stored bytes verbatim.
      allowVoltswitchConnector: !!payload?.allowVoltswitchConnector,
      voltswitchApiEmail: payload?.clearVoltswitchCredentials
        ? ''
        : (newVoltswitchEmail == null
          ? carrySettingSecret(stored?.voltswitchApiEmail)
          : encryptSettingSecret(newVoltswitchEmail)),
      voltswitchApiPassword: payload?.clearVoltswitchCredentials
        ? ''
        : (newVoltswitchPassword
          ? encryptSettingSecret(newVoltswitchPassword)
          : carrySettingSecret(stored?.voltswitchApiPassword)),
      voltswitchSyncIntervalMinutes: Math.max(1, Math.min(60,
        Number(payload?.voltswitchSyncIntervalMinutes) || Number(existing?.voltswitchSyncIntervalMinutes) || DEFAULT_TELEMATICS_CONFIG.voltswitchSyncIntervalMinutes))
    };
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
    // Prefer the Tenant.termsHtml column over any stale AppSetting row.
    if (scope?.tenantId) {
      try {
        const t = await prisma.tenant.findUnique({
          where: { id: scope.tenantId },
          select: { termsHtml: true }
        });
        if (t && typeof t.termsHtml === 'string' && t.termsHtml.length) {
          map.termsHtml = t.termsHtml;
        }
      } catch {
        // ignore — return AppSetting/defaults below
      }
    }
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

    // termsHtml is also mirrored onto the Tenant row so the rental-
    // agreement renderer can resolve the override via prisma.tenant
    // without a settings round-trip. Best-effort: if the mirror write
    // fails we still keep the AppSetting copy (single source of truth
    // is the Tenant column going forward).
    if (scope?.tenantId && Object.prototype.hasOwnProperty.call(payload, 'termsHtml')) {
      const raw = payload.termsHtml;
      const value = typeof raw === 'string' && raw.trim() ? raw : null;
      try {
        await prisma.tenant.update({
          where: { id: scope.tenantId },
          data: { termsHtml: value }
        });
      } catch {
        // ignore — AppSetting fallback already persisted above
      }
    }

    return this.getRentalAgreementConfig(scope);
  }
};
