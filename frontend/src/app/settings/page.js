/**
 * Settings Page — Multi-tab tenant configuration panel.
 *
 * Section Index (search for these markers):
 *   SECTION:agreement    — Line ~1693  Company, branding, agreement templates
 *   SECTION:payments     — Line ~1753  Payment gateway config
 *   SECTION:ai           — Line ~1888  Planner copilot / AI config
 *   SECTION:access       — Line ~2218  Module access controls
 *   SECTION:locations    — Line ~2253  Location management
 *   SECTION:fees         — Line ~2293  Fee configuration
 *   SECTION:rates        — Line ~2340  Rate plans and pricing
 *   SECTION:vehicleTypes — Line ~2554  Vehicle type management
 *   SECTION:insurance    — Line ~2608  Insurance plan management
 *   SECTION:selfService  — Line ~2752  Self-service / car sharing handoff config
 *   SECTION:revenue      — Line ~3066  Revenue pricing engine
 *   SECTION:carSharing   — Line ~3358  Car sharing search places
 *   SECTION:telematics   — Line ~3526  Telematics / Zubie config
 *   SECTION:emails       — Line ~3719  Email template management
 *   SECTION:services     — Line ~3789  Additional services
 *   SECTION:commissions  — Line ~3951  Commission plans and rules
 *
 * Constants: imported from ./settings-constants.js (~390 lines)
 */
'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { TLIntegrationPanel } from '../../components/settings/TLIntegrationPanel';
import { EconomyIntegrationPanel } from '../../components/settings/EconomyIntegrationPanel';
import { LocationDocumentsPanel } from '../../components/settings/LocationDocumentsPanel';
import { NuIntegrationPanel } from '../../components/settings/NuIntegrationPanel';
import { FlexwaysIntegrationPanel } from '../../components/settings/FlexwaysIntegrationPanel';
import { AdvantageIntegrationPanel } from '../../components/settings/AdvantageIntegrationPanel';
import { MexIntegrationPanel } from '../../components/settings/MexIntegrationPanel';
import { KioskUpsellSettings } from '../../components/settings/KioskUpsellSettings';
import { ShuttleTrackerSettings } from '../../components/settings/ShuttleTrackerSettings';
import { TwoFactorPolicySettings } from '../../components/settings/TwoFactorPolicySettings';
import { LoanerRatesTab } from './LoanerRatesTab';
import { OneStepGpsConnectorTab } from './OneStepGpsConnectorTab';
import { API_BASE, api } from '../../lib/client';
import { MODULE_DEFINITIONS } from '../../lib/moduleAccess';


import {
  DEFAULTS, DEFAULT_EMAIL_TEMPLATES, DEFAULT_PAYMENT_GATEWAY_CONFIG,
  DEFAULT_PLANNER_COPILOT_CONFIG, DEFAULT_PLANNER_COPILOT_USAGE,
  DEFAULT_TELEMATICS_CONFIG, DEFAULT_REVENUE_PRICING_CONFIG,
  DEFAULT_REVENUE_PRICING_PREVIEW, DEFAULT_PRECHECKIN_DISCOUNT, DEFAULT_PRECHECKIN_AUTO_EMAIL,
  DEFAULT_SELF_SERVICE_CONFIG, DEFAULT_CAR_SHARING_PRESET,
  EMPTY_LOCATION, LOCATION_CONFIG_DEFAULT, EMPTY_FEE, EMPTY_STOP_SALE, DEFAULT_REVIEW_EMAIL_CONFIG,
  EMPTY_VEHICLE_TYPE, EMPTY_RATE, EMPTY_SERVICE,
  EMPTY_COMMISSION_PLAN, EMPTY_COMMISSION_RULE, DEFAULT_REVIEW_TIERS_UI,
  TENANT_TIMEZONE_OPTIONS, normalizeInsurancePlan, parseDelimitedRows
} from './settings-constants';


const SETTINGS_CORE_SECTIONS = ['agreement', 'locations', 'vehicleTypes', 'reservationOptions', 'paymentGateway', 'tenantModules'];
const SETTINGS_TAB_SECTIONS = {
  agreement: [],
  locations: ['fees'],
  fees: ['fees'],
  feeRates: [],
  loanerRates: [],
  rates: ['rates'],
  revenue: ['revenuePricing'],
  carSharing: ['carSharingSearchPlaces'],
  selfService: ['selfService', 'precheckinDiscount', 'precheckinAutoEmail'],
  vehicleTypes: [],
  insurance: ['insurancePlans'],
  payments: [],
  ai: ['plannerCopilot', 'plannerCopilotUsage'],
  telematics: ['telematics'],
  marketIntel: ['dashboardSipps', 'marketExcludedVendors', 'marketPricingConfig'],
  access: [],
  emails: ['emailTemplates', 'reviewEmail'],
  services: ['services', 'fees'],
  stopSales: ['stopSales', 'vehicleTypes'],
  commissions: [],
  franchises: [],
  integrations: []
};

// Market Intelligence dashboard SIPP picker (beta.134). Friendly labels for the
// SIPP codes the backend returns in `options`. Keep in sync with SIPP_NAMES in
// components/MarketIntelligenceCard.jsx + DASHBOARD_SIPP_CODES in settings.service.js.
const SIPP_LABELS = {
  ECAR: 'Economy', CCAR: 'Compact', ICAR: 'Mid-size', SCAR: 'Standard',
  FCAR: 'Fullsize', PCAR: 'Premium', LCAR: 'Luxury',
  CFAR: 'Compact SUV', IFAR: 'Mid-size SUV', SFAR: 'Standard SUV',
  FFAR: 'Fullsize SUV', PFAR: 'Premium SUV', LFAR: 'Luxury SUV',
  RFAR: 'Recreational', XFAR: 'Open-Air All-Terrain', FJAR: 'SUV (FJAR)',
  FVAR: 'Passenger Van', MVAR: 'Minivan', SPAR: 'Special',
  STAR: 'Sports/Convertible', PUAR: 'Pickup'
};

/**
 * Every value `tab` may hold. Deep links (`/settings?tab=telematics`) are
 * validated against this set — an unknown or hand-typed tab silently keeps the
 * default rather than rendering a blank page.
 *
 * Added 2026-08-26: the shuttle Monitor's empty-state buttons and the GPS
 * connector empty state pushed to a bare `/settings`, so an operator told to
 * "turn the tracker on" landed on Agreement and had to hunt for the tab.
 * Keep in sync with the `tab === '…'` render guards below.
 */
const SETTINGS_TABS = new Set([
  'access', 'agreement', 'ai', 'carSharing', 'commissions', 'emails', 'feeRates',
  'fees', 'franchises', 'insurance', 'integrations', 'kioskUpsell', 'loanerRates',
  'locations', 'marketIntel', 'payments', 'rates', 'revenue', 'selfService',
  'services', 'stopSales', 'telematics', 'vehicleTypes',
]);

export default function SettingsPage() {
  return <AuthGate>{({ token, me, logout }) => <SettingsInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function SettingsInner({ token, me, logout }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState('agreement');
  const [msg, setMsg] = useState('');

  // Deep link support: `/settings?tab=telematics` opens that tab on mount.
  // Read from window.location rather than useSearchParams so this page needs no
  // Suspense boundary (same idiom as customer/pay, customer/precheckin, …).
  // Mount-only on purpose — after the first render the tab buttons own `tab`,
  // and re-applying the query string would fight the operator's clicks.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const wanted = new URLSearchParams(window.location.search).get('tab');
      if (wanted && SETTINGS_TABS.has(wanted)) setTab(wanted);
    } catch { /* malformed query string — keep the default tab */ }
  }, []);

  const [cfg, setCfg] = useState(DEFAULTS);
  const [locations, setLocations] = useState([]);
  const [services, setServices] = useState([]);
  const [fees, setFees] = useState([]);
  const [rates, setRates] = useState([]);
  const [rateQuery, setRateQuery] = useState('');
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [vehicleTypeForm, setVehicleTypeForm] = useState(EMPTY_VEHICLE_TYPE);
  const [vehicleTypeEditId, setVehicleTypeEditId] = useState(null);
  const [insurancePlans, setInsurancePlans] = useState([]);
  const [insuranceEditIdx, setInsuranceEditIdx] = useState(-1);
  const [insuranceForm, setInsuranceForm] = useState({
    code: '',
    name: '',
    label: '',
    description: '',
    chargeBy: 'FIXED',
    amount: '',
    commissionValueType: '',
    commissionPercentValue: '',
    commissionFixedAmount: '',
    taxable: false,
    isActive: true,
    locationIds: [],
    vehicleTypeIds: []
  });
  const [emailTemplates, setEmailTemplates] = useState(DEFAULT_EMAIL_TEMPLATES);
  const [reviewEmailConfig, setReviewEmailConfig] = useState(DEFAULT_REVIEW_EMAIL_CONFIG);
  const [reservationOptions, setReservationOptions] = useState({ autoAssignVehicleFromType: false, requireFranchiseSelection: false, tenantTimeZone: 'America/Puerto_Rico' });
  // Vehicle Profile pack (2026-06-10): tenant rule for "ready to rotate".
  const [fleetRotationRule, setFleetRotationRule] = useState('TIME');
  // Idle-vehicle notification (2026-09-01, backlog #5): OFF by default; the
  // daily sweep only emits for tenants that flip this on.
  const [idleVehicleCfg, setIdleVehicleCfg] = useState({ enabled: false, thresholdDays: 7 });
  const [idleVehicleSaving, setIdleVehicleSaving] = useState(false);
  // Customer-led inspection (2026-06-11).
  const [customerInspectionEnabled, setCustomerInspectionEnabled] = useState(false);
  // Check-in inspection model (Fase D, 2026-06-18): 'AGENT' (current) vs 'CUSTOMER' (agent-less).
  const [customerInspectionCheckinModel, setCustomerInspectionCheckinModel] = useState('AGENT');
  // Checkout payment policy (2026-08-26). Seeded TRUE so a failed/slow load
  // never renders the switch as "payment off" for a tenant that requires it.
  const [checkoutPaymentRequired, setCheckoutPaymentRequired] = useState(true);
  const [checkoutPaymentSaving, setCheckoutPaymentSaving] = useState(false);
  // Citations OCR (2026-06-15): per-tenant vision-LLM credentials for mail intake.
  const [ocrCfg, setOcrCfg] = useState({ provider: 'anthropic', model: '', hasKey: false });
  const [ocrKeyInput, setOcrKeyInput] = useState('');
  const [ocrSaving, setOcrSaving] = useState(false);
  const saveOcrConfig = async (patch) => {
    setOcrSaving(true);
    try {
      const out = await api(scopedSettingsPath('/api/settings/citation-ocr'), {
        method: 'PUT',
        body: JSON.stringify(patch)
      }, token);
      if (out) setOcrCfg(out);
      setOcrKeyInput('');
      setMsg('Citations OCR settings saved');
    } catch (err) {
      setMsg(err?.message || 'Failed to save OCR settings');
    } finally {
      setOcrSaving(false);
    }
  };
  // Agent Copilot AI fallback (2026-09-02, copilot Phase 2): OFF by default —
  // the copilot's miss path stays exactly Phase 1 until an admin flips this
  // on AND a key resolves. Same encrypted-key contract as Citations OCR.
  const [copilotAiCfg, setCopilotAiCfg] = useState({ enabled: false, provider: 'anthropic', model: '', dailyCallCap: 200, hasKey: false });
  const [copilotAiKeyInput, setCopilotAiKeyInput] = useState('');
  const [copilotAiSaving, setCopilotAiSaving] = useState(false);
  const saveCopilotAiConfig = async (patch) => {
    setCopilotAiSaving(true);
    try {
      const out = await api(scopedSettingsPath('/api/settings/copilot-ai'), {
        method: 'PUT',
        body: JSON.stringify(patch)
      }, token);
      if (out) setCopilotAiCfg(out);
      setCopilotAiKeyInput('');
      setMsg('Copilot AI settings saved');
    } catch (err) {
      setMsg(err?.message || 'Failed to save Copilot AI settings');
    } finally {
      setCopilotAiSaving(false);
    }
  };
  const [paymentGatewayConfig, setPaymentGatewayConfig] = useState(DEFAULT_PAYMENT_GATEWAY_CONFIG);
  const [paymentGatewayHealth, setPaymentGatewayHealth] = useState(null);
  const [plannerCopilotConfig, setPlannerCopilotConfig] = useState(DEFAULT_PLANNER_COPILOT_CONFIG);
  const [plannerCopilotUsage, setPlannerCopilotUsage] = useState(DEFAULT_PLANNER_COPILOT_USAGE);
  const [telematicsConfig, setTelematicsConfig] = useState(DEFAULT_TELEMATICS_CONFIG);
  // Market Intelligence dashboard SIPP picker (beta.134)
  const [dashboardSipps, setDashboardSipps] = useState({ sipps: [], options: [], max: 6 });
  // Market Intelligence excluded competitors (per-tenant; one vendor per line in the textarea)
  const [excludedVendorsText, setExcludedVendorsText] = useState('');
  // Tax-aware pricing config per location (Amadeus/Titanium, taxes, brokerage, floor)
  const [pricingConfigs, setPricingConfigs] = useState({ configs: [], connectionTypes: ['TITANIUM', 'AMADEUS'] });
  const [pcDraft, setPcDraft] = useState({ locationCode: '', connectionType: 'TITANIUM', taxesText: '', brokeragePct: '', floorBase: '', ceilingBase: '', maxDeltaPct: '', utilTiersText: '' });
  const [pcError, setPcError] = useState('');
  const [revenuePricingConfig, setRevenuePricingConfig] = useState(DEFAULT_REVENUE_PRICING_CONFIG);
  const [revenuePricingPreview, setRevenuePricingPreview] = useState(DEFAULT_REVENUE_PRICING_PREVIEW);
  const [revenuePricingPreviewResult, setRevenuePricingPreviewResult] = useState(null);
  const [selfServiceConfig, setSelfServiceConfig] = useState(DEFAULT_SELF_SERVICE_CONFIG);
  const [precheckinDiscount, setPrecheckinDiscount] = useState(DEFAULT_PRECHECKIN_DISCOUNT);
  const [precheckinAutoEmail, setPrecheckinAutoEmail] = useState(DEFAULT_PRECHECKIN_AUTO_EMAIL);
  const [carSharingSearchPlaces, setCarSharingSearchPlaces] = useState([]);
  const [tenantModuleAccess, setTenantModuleAccess] = useState({});
  const [loadedSettingsSections, setLoadedSettingsSections] = useState({});

  const [locationForm, setLocationForm] = useState(EMPTY_LOCATION);
  const [feeForm, setFeeForm] = useState(EMPTY_FEE);
  const [rateForm, setRateForm] = useState(EMPTY_RATE);
  const [rateDailyUploadRows, setRateDailyUploadRows] = useState([]);
  const [rateDailyUploadName, setRateDailyUploadName] = useState('');
  const [rateDailyUploadReport, setRateDailyUploadReport] = useState(null);
  // Excel import flow — separate from the legacy CSV flow above so the diff
  // preview state doesn't collide while a user is mid-upload.
  const [rateExcelImport, setRateExcelImport] = useState(null);
  const [rateLocationPicker, setRateLocationPicker] = useState(null);
  // Calendar grid filters for the daily-overrides view (replaces the old slice(0,24)).
  const [rateGridFilters, setRateGridFilters] = useState({
    vehicleTypeIds: [],
    dateFrom: '',
    dateTo: '',
    actionFilter: 'all'
  });
  const [serviceForm, setServiceForm] = useState(EMPTY_SERVICE);
  const [carSharingPresetForm, setCarSharingPresetForm] = useState(DEFAULT_CAR_SHARING_PRESET);
  const [serviceEditId, setServiceEditId] = useState(null);
  const [locationEditor, setLocationEditor] = useState(null);
  const [locationEditorTab, setLocationEditorTab] = useState('main');
  const [copyLocationModal, setCopyLocationModal] = useState(null);
  const [tenantRows, setTenantRows] = useState([]);
  const [activeSettingsTenantId, setActiveSettingsTenantId] = useState('');
  const [commissionPlans, setCommissionPlans] = useState([]);
  const [commissionEmployees, setCommissionEmployees] = useState([]);
  const [activeCommissionTenantId, setActiveCommissionTenantId] = useState('');
  const [activeCommissionPlanId, setActiveCommissionPlanId] = useState('');
  const [commissionPlanForm, setCommissionPlanForm] = useState(EMPTY_COMMISSION_PLAN);
  const [commissionRuleForm, setCommissionRuleForm] = useState(EMPTY_COMMISSION_RULE);
  const [franchises, setFranchises] = useState([]);
  const [franchiseForm, setFranchiseForm] = useState({ name: '', code: '', logoUrl: '', address: '', phone: '', email: '', termsText: '', returnInstructionsText: '', agreementHtmlTemplate: '', isDefault: false, isActive: true });
  const [franchiseEditId, setFranchiseEditId] = useState(null);
  const [stopSales, setStopSales] = useState([]);
  const [stopSaleForm, setStopSaleForm] = useState(EMPTY_STOP_SALE);
  const [stopSaleEditId, setStopSaleEditId] = useState(null);
  // Integrations tab: which booking-source panel is active (TL / Economy / NU).
  const [activeIntegration, setActiveIntegration] = useState('tl');

  const role = String(me?.role || '').toUpperCase().trim();
  const isAdmin = role === 'ADMIN' || role === 'SUPER_ADMIN';
  const isSuper = role === 'SUPER_ADMIN';

  const scopedSettingsPath = (path, tenantId = activeSettingsTenantId) => {
    if (!isSuper || !tenantId) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}tenantId=${encodeURIComponent(tenantId)}`;
  };

  useEffect(() => {
    api(scopedSettingsPath('/api/settings/fleet-rotation'), {}, token)
      .then((out) => setFleetRotationRule(out?.rule === 'MILEAGE' ? 'MILEAGE' : 'TIME'))
      .catch(() => {});
    api(scopedSettingsPath('/api/settings/idle-vehicles'), {}, token)
      .then((out) => out && setIdleVehicleCfg({ enabled: out.enabled === true, thresholdDays: Number(out.thresholdDays) >= 1 ? Number(out.thresholdDays) : 7 }))
      .catch(() => {});
    api(scopedSettingsPath('/api/settings/customer-inspection'), {}, token)
      .then((out) => {
        setCustomerInspectionEnabled(!!out?.enabled);
        setCustomerInspectionCheckinModel(String(out?.checkinModel || 'AGENT').toUpperCase() === 'CUSTOMER' ? 'CUSTOMER' : 'AGENT');
      })
      .catch(() => {});
    api(scopedSettingsPath('/api/settings/citation-ocr'), {}, token)
      .then((out) => out && setOcrCfg(out))
      .catch(() => {});
    api(scopedSettingsPath('/api/settings/copilot-ai'), {}, token)
      .then((out) => out && setCopilotAiCfg(out))
      .catch(() => {});
    // Checkout payment policy. `!== false` (not `!!`) so anything the API does
    // not return as an explicit false leaves the switch ON — same fail-safe
    // direction the backend resolver uses.
    api(scopedSettingsPath('/api/settings/checkout-payment'), {}, token)
      .then((out) => setCheckoutPaymentRequired(out?.checkoutPaymentRequired !== false))
      .catch(() => {});
    // activeSettingsTenantId in deps (2026-07-26 fix): for a SUPER_ADMIN these
    // three loads are tenant-scoped via scopedSettingsPath, but the effect only
    // ran once on mount — BEFORE a tenant was picked — so the toggles showed
    // the unscoped/stale value forever. Hector flipped customer-led inspection
    // ON for a tenant, the PUT landed in the right key, and the UI kept
    // showing OFF ("no me deja prenderlo").
    // HOTFIX 2026-07-26: this effect must live BELOW the activeSettingsTenantId
    // declaration — referencing the useState const in the deps array from above
    // its declaration is a TDZ ReferenceError that crashed the whole Settings
    // page ("something went wrong") in beta.363.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, activeSettingsTenantId]);


  const applySettingsSection = (key, value) => {
    if (key === 'agreement') setCfg(value || DEFAULTS);
    if (key === 'locations') setLocations(Array.isArray(value) ? value : []);
    if (key === 'services') setServices(Array.isArray(value) ? value : []);
    if (key === 'fees') setFees(Array.isArray(value) ? value : []);
    if (key === 'stopSales') setStopSales(Array.isArray(value) ? value : []);
    if (key === 'rates') setRates(Array.isArray(value) ? value : []);
    if (key === 'vehicleTypes') setVehicleTypes(Array.isArray(value) ? value : []);
    if (key === 'insurancePlans') setInsurancePlans((value || []).map(normalizeInsurancePlan));
    if (key === 'emailTemplates') setEmailTemplates({ ...DEFAULT_EMAIL_TEMPLATES, ...(value || {}) });
    if (key === 'reviewEmail') setReviewEmailConfig({
      ...DEFAULT_REVIEW_EMAIL_CONFIG,
      ...(value || {}),
      enabled: !!(value?.enabled),
      trigger: ['OFF', 'CHECKED_OUT', 'CHECKED_IN'].includes(String(value?.trigger || '').toUpperCase())
        ? String(value.trigger).toUpperCase() : 'CHECKED_IN',
      reviewLinkUrl: String(value?.reviewLinkUrl || '')
    });
    if (key === 'reservationOptions') setReservationOptions({
      autoAssignVehicleFromType: !!value?.autoAssignVehicleFromType,
      requireFranchiseSelection: !!value?.requireFranchiseSelection,
      tenantTimeZone: String(value?.tenantTimeZone || 'America/Puerto_Rico')
    });
    if (key === 'paymentGateway') {
      setPaymentGatewayConfig({
        ...DEFAULT_PAYMENT_GATEWAY_CONFIG,
        ...(value || {}),
        authorizenet: {
          ...DEFAULT_PAYMENT_GATEWAY_CONFIG.authorizenet,
          ...(value?.authorizenet || {})
        },
        stripe: {
          ...DEFAULT_PAYMENT_GATEWAY_CONFIG.stripe,
          ...(value?.stripe || {})
        },
        square: {
          ...DEFAULT_PAYMENT_GATEWAY_CONFIG.square,
          ...(value?.square || {})
        },
        spin: {
          ...DEFAULT_PAYMENT_GATEWAY_CONFIG.spin,
          ...(value?.spin || {})
        },
        ipos: {
          ...DEFAULT_PAYMENT_GATEWAY_CONFIG.ipos,
          ...(value?.ipos || {})
        },
        autocharge: {
          ...DEFAULT_PAYMENT_GATEWAY_CONFIG.autocharge,
          ...(value?.autocharge || {})
        }
      });
    }
    if (key === 'plannerCopilot') {
      setPlannerCopilotConfig({
        ...DEFAULT_PLANNER_COPILOT_CONFIG,
        ...(value || {}),
        allowedModels: Array.isArray(value?.allowedModels) ? value.allowedModels : DEFAULT_PLANNER_COPILOT_CONFIG.allowedModels,
        monthlyQueryCap: value?.monthlyQueryCap == null ? '' : String(value.monthlyQueryCap),
        allowedPlans: Array.isArray(value?.allowedPlans) ? value.allowedPlans : DEFAULT_PLANNER_COPILOT_CONFIG.allowedPlans,
        planDefaults: {
          ...DEFAULT_PLANNER_COPILOT_CONFIG.planDefaults,
          ...(value?.planDefaults || {}),
          allowedModels: Array.isArray(value?.planDefaults?.allowedModels) ? value.planDefaults.allowedModels : DEFAULT_PLANNER_COPILOT_CONFIG.planDefaults.allowedModels
        },
        apiKey: '',
        clearTenantApiKey: false
      });
    }
    if (key === 'plannerCopilotUsage') {
      setPlannerCopilotUsage({
        ...DEFAULT_PLANNER_COPILOT_USAGE,
        ...(value || {}),
        summary: {
          ...DEFAULT_PLANNER_COPILOT_USAGE.summary,
          ...(value?.summary || {})
        },
        currentPeriod: {
          ...DEFAULT_PLANNER_COPILOT_USAGE.currentPeriod,
          ...(value?.currentPeriod || {})
        },
        periods: Array.isArray(value?.periods) ? value.periods : [],
        recent: Array.isArray(value?.recent) ? value.recent : []
      });
    }
    if (key === 'telematics') {
      setTelematicsConfig({
        ...DEFAULT_TELEMATICS_CONFIG,
        ...(value || {}),
        planDefaults: {
          ...DEFAULT_TELEMATICS_CONFIG.planDefaults,
          ...(value?.planDefaults || {})
        }
      });
    }
    if (key === 'dashboardSipps') {
      setDashboardSipps({
        sipps: Array.isArray(value?.sipps) ? value.sipps : [],
        options: Array.isArray(value?.options) ? value.options : [],
        max: Number(value?.max) || 6
      });
    }
    if (key === 'marketExcludedVendors') {
      setExcludedVendorsText((Array.isArray(value?.vendors) ? value.vendors : []).join('\n'));
    }
    if (key === 'marketPricingConfig') {
      setPricingConfigs({
        configs: Array.isArray(value?.configs) ? value.configs : [],
        connectionTypes: Array.isArray(value?.connectionTypes) ? value.connectionTypes : ['TITANIUM', 'AMADEUS'],
      });
    }
    if (key === 'revenuePricing') {
      setRevenuePricingConfig({
        ...DEFAULT_REVENUE_PRICING_CONFIG,
        ...(value || {})
      });
    }
    if (key === 'carSharingSearchPlaces') {
      setCarSharingSearchPlaces(Array.isArray(value) ? value : []);
    }
    if (key === 'precheckinDiscount') {
      setPrecheckinDiscount({ ...DEFAULT_PRECHECKIN_DISCOUNT, ...(value || {}) });
    }
    if (key === 'precheckinAutoEmail') {
      setPrecheckinAutoEmail({ ...DEFAULT_PRECHECKIN_AUTO_EMAIL, ...(value || {}) });
    }
    if (key === 'selfService') {
      setSelfServiceConfig({
        ...DEFAULT_SELF_SERVICE_CONFIG,
        ...(value || {})
      });
    }
    if (key === 'tenantModules') setTenantModuleAccess(value?.config || {});
  };

  const sectionLoaders = {
    agreement: (forceLoad = false) => api(scopedSettingsPath('/api/settings/rental-agreement'), forceLoad ? { bypassCache: true } : {}, token),
    locations: (forceLoad = false) => api(scopedSettingsPath('/api/locations'), forceLoad ? { bypassCache: true } : {}, token),
    services: (forceLoad = false) => api(scopedSettingsPath('/api/additional-services'), forceLoad ? { bypassCache: true } : {}, token),
    fees: (forceLoad = false) => api(scopedSettingsPath('/api/fees'), forceLoad ? { bypassCache: true } : {}, token),
    stopSales: (forceLoad = false) => api(scopedSettingsPath('/api/stop-sales'), forceLoad ? { bypassCache: true } : {}, token),
    rates: (forceLoad = false) => api(scopedSettingsPath('/api/rates'), forceLoad ? { bypassCache: true } : {}, token),
    vehicleTypes: (forceLoad = false) => api(scopedSettingsPath('/api/vehicle-types'), forceLoad ? { bypassCache: true } : {}, token),
    insurancePlans: (forceLoad = false) => api(scopedSettingsPath('/api/settings/insurance-plans'), forceLoad ? { bypassCache: true } : {}, token),
    emailTemplates: (forceLoad = false) => api(scopedSettingsPath('/api/settings/email-templates'), forceLoad ? { bypassCache: true } : {}, token),
    reviewEmail: (forceLoad = false) => api(scopedSettingsPath('/api/settings/review-email'), forceLoad ? { bypassCache: true } : {}, token),
    reservationOptions: (forceLoad = false) => api(scopedSettingsPath('/api/settings/reservation-options'), forceLoad ? { bypassCache: true } : {}, token),
    paymentGateway: (forceLoad = false) => api(scopedSettingsPath('/api/settings/payment-gateway'), forceLoad ? { bypassCache: true } : {}, token),
    plannerCopilot: (forceLoad = false) => api(scopedSettingsPath('/api/settings/planner-copilot'), forceLoad ? { bypassCache: true } : {}, token),
    plannerCopilotUsage: (forceLoad = false) => api(scopedSettingsPath('/api/settings/planner-copilot/usage'), forceLoad ? { bypassCache: true } : {}, token),
    telematics: (forceLoad = false) => api(scopedSettingsPath('/api/settings/telematics'), forceLoad ? { bypassCache: true } : {}, token),
    dashboardSipps: (forceLoad = false) => api(scopedSettingsPath('/api/settings/dashboard-sipps'), forceLoad ? { bypassCache: true } : {}, token),
    marketExcludedVendors: (forceLoad = false) => api(scopedSettingsPath('/api/settings/market-excluded-vendors'), forceLoad ? { bypassCache: true } : {}, token),
    marketPricingConfig: (forceLoad = false) => api(scopedSettingsPath('/api/settings/market-pricing-config'), forceLoad ? { bypassCache: true } : {}, token),
    revenuePricing: (forceLoad = false) => api(scopedSettingsPath('/api/settings/revenue-pricing'), forceLoad ? { bypassCache: true } : {}, token),
    carSharingSearchPlaces: (forceLoad = false) => api(scopedSettingsPath('/api/settings/car-sharing-search-places'), forceLoad ? { bypassCache: true } : {}, token),
    precheckinDiscount: (forceLoad = false) => api(scopedSettingsPath('/api/settings/precheckin-discount'), forceLoad ? { bypassCache: true } : {}, token),
    precheckinAutoEmail: (forceLoad = false) => api(scopedSettingsPath('/api/settings/precheckin-auto-email'), forceLoad ? { bypassCache: true } : {}, token),
    selfService: (forceLoad = false) => api(scopedSettingsPath('/api/settings/self-service'), forceLoad ? { bypassCache: true } : {}, token),
    tenantModules: (forceLoad = false) => api(scopedSettingsPath('/api/settings/tenant-modules'), forceLoad ? { bypassCache: true } : {}, token)
  };

  const load = async (force = false) => {
    if (isSuper && !activeSettingsTenantId) return;
    const requestedSections = Array.from(new Set([
      ...SETTINGS_CORE_SECTIONS,
      ...(SETTINGS_TAB_SECTIONS[tab] || [])
    ]));
    const sectionsToLoad = force
      ? requestedSections
      : requestedSections.filter((key) => !loadedSettingsSections[key]);
    if (!sectionsToLoad.length) return;

    const requests = sectionsToLoad.map((key) => [key, sectionLoaders[key]?.(force)]).filter(([, request]) => request);
    const results = await Promise.allSettled(requests.map(([, request]) => request));
    const succeeded = [];
    const failedKeys = [];

    results.forEach((result, index) => {
      const key = requests[index][0];
      if (result.status === 'fulfilled') {
        applySettingsSection(key, result.value);
        succeeded.push(key);
      } else {
        failedKeys.push(key);
      }
    });

    if (succeeded.length) {
      setLoadedSettingsSections((prev) => ({
        ...prev,
        ...Object.fromEntries(succeeded.map((key) => [key, true]))
      }));
    }

    if (failedKeys.length) setMsg(`Some settings data could not be loaded: ${failedKeys.join(', ')}`);
    else setMsg('');
  };

  const editStopSale = (s) => {
    setStopSaleEditId(s.id);
    const toLocal = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      // datetime-local wants "YYYY-MM-DDTHH:MM" in LOCAL time, not UTC
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    setStopSaleForm({
      vehicleTypeId: s.vehicleTypeId || s.vehicleType?.id || '',
      startDate: toLocal(s.startDate),
      endDate: toLocal(s.endDate),
      reason: s.reason || '',
      notes: s.notes || '',
      isActive: !!s.isActive
    });
  };

  const cancelEditStopSale = () => {
    setStopSaleEditId(null);
    setStopSaleForm(EMPTY_STOP_SALE);
  };

  const saveStopSale = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    try {
      if (!stopSaleForm.vehicleTypeId || !stopSaleForm.startDate || !stopSaleForm.endDate) {
        setMsg('Vehicle class, start date, and end date are required');
        return;
      }
      const payload = {
        vehicleTypeId: stopSaleForm.vehicleTypeId,
        startDate: new Date(stopSaleForm.startDate).toISOString(),
        endDate: new Date(stopSaleForm.endDate).toISOString(),
        reason: stopSaleForm.reason || null,
        notes: stopSaleForm.notes || null,
        isActive: !!stopSaleForm.isActive
      };
      if (stopSaleEditId) {
        await api(scopedSettingsPath(`/api/stop-sales/${stopSaleEditId}`), { method: 'PATCH', body: JSON.stringify(payload) }, token);
        setMsg('Stop sale updated');
      } else {
        await api(scopedSettingsPath('/api/stop-sales'), { method: 'POST', body: JSON.stringify(payload) }, token);
        setMsg('Stop sale added');
      }
      cancelEditStopSale();
      await load(true);
    } catch (err) { setMsg(err.message || 'Could not save stop sale'); }
  };

  const toggleStopSale = async (s) => {
    try {
      await api(scopedSettingsPath(`/api/stop-sales/${s.id}`), { method: 'PATCH', body: JSON.stringify({ isActive: !s.isActive }) }, token);
      setMsg('Stop sale updated');
      await load(true);
    } catch (err) { setMsg(err.message || 'Could not update stop sale'); }
  };

  const removeStopSale = async (id) => {
    try {
      await api(scopedSettingsPath(`/api/stop-sales/${id}`), { method: 'DELETE' }, token);
      setMsg('Stop sale removed');
      await load(true);
    } catch (err) { setMsg(err.message || 'Could not remove stop sale'); }
  };

  const loadFranchises = async () => {
    try {
      const rows = await api(scopedSettingsPath('/api/settings/franchises'), {}, token);
      setFranchises(Array.isArray(rows) ? rows : []);
    } catch (e) { setMsg(e.message); }
  };

  const saveFranchise = async () => {
    try {
      if (!franchiseForm.name) { setMsg('Franchise name is required'); return; }
      if (franchiseEditId) {
        await api(scopedSettingsPath(`/api/settings/franchises/${franchiseEditId}`), { method: 'PATCH', body: JSON.stringify(franchiseForm) }, token);
        setMsg('Franchise updated');
      } else {
        await api(scopedSettingsPath('/api/settings/franchises'), { method: 'POST', body: JSON.stringify(franchiseForm) }, token);
        setMsg('Franchise created');
      }
      setFranchiseEditId(null);
      setFranchiseForm({ name: '', code: '', logoUrl: '', address: '', phone: '', email: '', termsText: '', returnInstructionsText: '', agreementHtmlTemplate: '', isDefault: false, isActive: true });
      await loadFranchises();
    } catch (e) { setMsg(e.message); }
  };

  const deleteFranchise = async (id) => {
    if (!confirm('Delete this franchise? If reservations exist it will be deactivated instead.')) return;
    try {
      await api(scopedSettingsPath(`/api/settings/franchises/${id}`), { method: 'DELETE' }, token);
      setMsg('Franchise removed');
      await loadFranchises();
    } catch (e) { setMsg(e.message); }
  };

  const loadCommissionConfig = async (tenantId = activeCommissionTenantId) => {
    try {
      const qs = new URLSearchParams();
      if (isSuper && tenantId) qs.set('tenantId', tenantId);
      const list = await api(`/api/commissions/plans${qs.toString() ? `?${qs.toString()}` : ''}`, {}, token);
      const rows = Array.isArray(list) ? list : [];
      setCommissionPlans(rows);
      setActiveCommissionPlanId((current) => {
        if (current && rows.some((row) => row.id === current)) return current;
        return rows[0]?.id || '';
      });
    } catch (e) {
      setMsg(e.message);
    }
  };

  const loadCommissionEmployees = async (tenantId = activeCommissionTenantId) => {
    try {
      const qs = new URLSearchParams();
      if (isSuper && tenantId) qs.set('tenantId', tenantId);
      const rows = await api(`/api/commissions/employees${qs.toString() ? `?${qs.toString()}` : ''}`, {}, token);
      setCommissionEmployees(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setMsg(e.message);
    }
  };

  const loadTenants = async () => {
    if (!isSuper) return;
    try {
      const list = await api('/api/tenants', {}, token);
      const rows = Array.isArray(list) ? list : [];
      setTenantRows(rows);
      if (!activeSettingsTenantId && rows[0]?.id) setActiveSettingsTenantId(rows[0].id);
      if (!activeCommissionTenantId && rows[0]?.id) setActiveCommissionTenantId(rows[0].id);
    } catch (e) {
      setMsg(e.message);
    }
  };

  useEffect(() => {
    setLoadedSettingsSections({});
    setCfg(DEFAULTS);
    setLocations([]);
    setServices([]);
    setFees([]);
    setRates([]);
    setVehicleTypes([]);
    setInsurancePlans([]);
    setEmailTemplates(DEFAULT_EMAIL_TEMPLATES);
    setReservationOptions({ autoAssignVehicleFromType: false, requireFranchiseSelection: false, tenantTimeZone: 'America/Puerto_Rico' });
    setPaymentGatewayConfig(DEFAULT_PAYMENT_GATEWAY_CONFIG);
    setPlannerCopilotConfig(DEFAULT_PLANNER_COPILOT_CONFIG);
    setPlannerCopilotUsage(DEFAULT_PLANNER_COPILOT_USAGE);
    setTelematicsConfig(DEFAULT_TELEMATICS_CONFIG);
    setTenantModuleAccess({});
  }, [isSuper, activeSettingsTenantId, me?.tenant?.id]);

  useEffect(() => { load(true); }, [token, isSuper, activeSettingsTenantId]);
  useEffect(() => { load(); }, [token, tab]);
  useEffect(() => {
    if (tab !== 'commissions') return;
    loadCommissionConfig(activeCommissionTenantId);
  }, [token, activeCommissionTenantId, tab]);
  useEffect(() => {
    if (tab !== 'commissions') return;
    loadCommissionEmployees(activeCommissionTenantId);
  }, [token, activeCommissionTenantId, tab]);
  useEffect(() => {
    if (tab !== 'franchises') return;
    loadFranchises();
  }, [token, tab, activeSettingsTenantId]);
  useEffect(() => { loadTenants(); }, [token, isSuper]);

  const saveAgreement = async () => {
    setCfg(await api(scopedSettingsPath('/api/settings/rental-agreement'), { method: 'PUT', body: JSON.stringify(cfg) }, token));
    setMsg('Rental agreement settings saved');
  };

  const previewAgreementTemplate = () => {
    const raw = String(cfg?.agreementHtmlTemplate || '').trim();
    if (!raw) {
      setMsg('Add Agreement HTML Template first');
      return;
    }
    const vars = {
      companyName: cfg.companyName || 'Ride Fleet',
      companyAddress: cfg.companyAddress || 'San Juan, Puerto Rico',
      companyPhone: cfg.companyPhone || '(787) 000-0000',
      agreementNumber: 'RA-PREVIEW-0001',
      reservationNumber: 'RES-PREVIEW',
      customerName: 'John Doe',
      pickupAt: new Date().toLocaleString(),
      returnAt: new Date(Date.now() + 2 * 86400000).toLocaleString(),
      taxConfig: 'Tax (11.50%)',
      total: '123.45',
      amountPaid: '50.00',
      amountDue: '73.45',
      chargesRows: '<tr><td>Daily</td><td>3.00</td><td>$10.00</td><td>$30.00</td></tr><tr><td>Underage FEE</td><td>1.00</td><td>$24.99/day</td><td>$74.97</td></tr><tr><td>Tax (11.50%)</td><td>1.00</td><td>$12.77</td><td>$12.77</td></tr>',
      paymentsRows: '<tr><td>' + new Date().toLocaleString() + '</td><td>OTC</td><td>PREVIEW-1</td><td>SETTLED</td><td>$50.00</td></tr>',
      termsText: cfg.termsText || '',
      signatureSignedBy: 'John Doe',
      signatureDateTime: new Date().toLocaleString(),
      signatureIp: '127.0.0.1',
      signatureDataUrl: ''
    };
    let html = raw;
    Object.entries(vars).forEach(([k, v]) => { html = html.replaceAll(`{{${k}}}`, String(v ?? '')); });
    const w = window.open('', '_blank');
    if (!w) return setMsg('Popup blocked. Allow popups for preview.');
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  const saveReviewEmailConfig = async () => {
    try {
      const payload = {
        enabled: !!reviewEmailConfig.enabled,
        trigger: String(reviewEmailConfig.trigger || 'CHECKED_IN').toUpperCase(),
        reviewLinkUrl: String(reviewEmailConfig.reviewLinkUrl || '')
      };
      const out = await api(scopedSettingsPath('/api/settings/review-email'), { method: 'PUT', body: JSON.stringify(payload) }, token);
      setReviewEmailConfig({ ...DEFAULT_REVIEW_EMAIL_CONFIG, ...(out || {}) });
      setMsg('Review email automation saved');
    } catch (err) { setMsg(err.message || 'Could not save review email settings'); }
  };

  const saveEmailTemplates = async () => {
    const out = await api(scopedSettingsPath('/api/settings/email-templates'), { method: 'PUT', body: JSON.stringify(emailTemplates) }, token);
    setEmailTemplates({ ...DEFAULT_EMAIL_TEMPLATES, ...(out || {}) });
    setMsg('Email templates saved');
  };

  const saveReservationOptions = async () => {
    const out = await api(scopedSettingsPath('/api/settings/reservation-options'), { method: 'PUT', body: JSON.stringify(reservationOptions) }, token);
    setReservationOptions({
      autoAssignVehicleFromType: !!out?.autoAssignVehicleFromType,
      requireFranchiseSelection: !!out?.requireFranchiseSelection,
      tenantTimeZone: String(out?.tenantTimeZone || 'America/Puerto_Rico')
    });
    setMsg('Reservation options saved');
  };

  const savePaymentGatewayConfig = async () => {
    const out = await api(scopedSettingsPath('/api/settings/payment-gateway'), {
      method: 'PUT',
      body: JSON.stringify(paymentGatewayConfig)
    }, token);
    setPaymentGatewayConfig({
      ...DEFAULT_PAYMENT_GATEWAY_CONFIG,
      ...(out || {}),
      authorizenet: {
        ...DEFAULT_PAYMENT_GATEWAY_CONFIG.authorizenet,
        ...(out?.authorizenet || {})
      },
      stripe: {
        ...DEFAULT_PAYMENT_GATEWAY_CONFIG.stripe,
        ...(out?.stripe || {})
      },
      square: {
        ...DEFAULT_PAYMENT_GATEWAY_CONFIG.square,
        ...(out?.square || {})
      },
      spin: {
        ...DEFAULT_PAYMENT_GATEWAY_CONFIG.spin,
        ...(out?.spin || {})
      },
      ipos: {
        ...DEFAULT_PAYMENT_GATEWAY_CONFIG.ipos,
        ...(out?.ipos || {})
      }
    });
    setMsg('Payment gateway settings saved');
  };

  const runPaymentGatewayHealthCheck = async () => {
    const out = await api(scopedSettingsPath('/api/settings/payment-gateway/health-check'), { method: 'POST' }, token);
    setPaymentGatewayHealth(out);
    setMsg(out?.summary || 'Payment gateway check complete');
  };

  const savePlannerCopilotConfig = async () => {
    const out = await api(scopedSettingsPath('/api/settings/planner-copilot'), {
      method: 'PUT',
      body: JSON.stringify({
        enabled: !!plannerCopilotConfig.enabled,
        model: String(plannerCopilotConfig.model || 'gpt-4.1-mini'),
        allowGlobalApiKeyFallback: !!plannerCopilotConfig.allowGlobalApiKeyFallback,
        allowedModels: Array.isArray(plannerCopilotConfig.allowedModels) ? plannerCopilotConfig.allowedModels : [],
        monthlyQueryCap: plannerCopilotConfig.monthlyQueryCap === '' ? null : Number(plannerCopilotConfig.monthlyQueryCap),
        aiOnlyForPaidPlan: !!plannerCopilotConfig.aiOnlyForPaidPlan,
        allowedPlans: Array.isArray(plannerCopilotConfig.allowedPlans) ? plannerCopilotConfig.allowedPlans : [],
        apiKey: String(plannerCopilotConfig.apiKey || ''),
        clearTenantApiKey: !!plannerCopilotConfig.clearTenantApiKey
      })
    }, token);
    setPlannerCopilotConfig({
      ...DEFAULT_PLANNER_COPILOT_CONFIG,
      ...(out || {}),
      allowedModels: Array.isArray(out?.allowedModels) ? out.allowedModels : DEFAULT_PLANNER_COPILOT_CONFIG.allowedModels,
      monthlyQueryCap: out?.monthlyQueryCap == null ? '' : String(out.monthlyQueryCap),
      allowedPlans: Array.isArray(out?.allowedPlans) ? out.allowedPlans : DEFAULT_PLANNER_COPILOT_CONFIG.allowedPlans,
      planDefaults: {
        ...DEFAULT_PLANNER_COPILOT_CONFIG.planDefaults,
        ...(out?.planDefaults || {}),
        allowedModels: Array.isArray(out?.planDefaults?.allowedModels) ? out.planDefaults.allowedModels : DEFAULT_PLANNER_COPILOT_CONFIG.planDefaults.allowedModels
      },
      apiKey: '',
      clearTenantApiKey: false
    });
    const usage = await api(scopedSettingsPath('/api/settings/planner-copilot/usage'), { bypassCache: true }, token);
    setPlannerCopilotUsage({
      ...DEFAULT_PLANNER_COPILOT_USAGE,
      ...(usage || {}),
      summary: {
        ...DEFAULT_PLANNER_COPILOT_USAGE.summary,
        ...(usage?.summary || {})
      },
      currentPeriod: {
        ...DEFAULT_PLANNER_COPILOT_USAGE.currentPeriod,
        ...(usage?.currentPeriod || {})
      },
      periods: Array.isArray(usage?.periods) ? usage.periods : [],
      recent: Array.isArray(usage?.recent) ? usage.recent : []
    });
    setMsg('Planner Copilot settings saved');
  };

  const saveTelematicsConfig = async () => {
    const out = await api(scopedSettingsPath('/api/settings/telematics'), {
      method: 'PUT',
      body: JSON.stringify({
        enabled: !!telematicsConfig.enabled,
        provider: String(telematicsConfig.provider || 'ZUBIE').toUpperCase(),
        allowManualEventIngest: !!telematicsConfig.allowManualEventIngest,
        allowZubieConnector: !!telematicsConfig.allowZubieConnector,
        webhookAuthMode: String(telematicsConfig.webhookAuthMode || 'HEADER_SECRET').toUpperCase(),
        zubieWebhookSecret: String(telematicsConfig.zubieWebhookSecret || ''),
        clearZubieWebhookSecret: !!telematicsConfig.clearZubieWebhookSecret,
        allowVoltswitchConnector: !!telematicsConfig.allowVoltswitchConnector,
        voltswitchApiEmail: String(telematicsConfig.voltswitchApiEmail || ''),
        voltswitchApiPassword: String(telematicsConfig.voltswitchApiPassword || ''),
        voltswitchSyncIntervalMinutes: Number(telematicsConfig.voltswitchSyncIntervalMinutes) || 5,
        clearVoltswitchCredentials: !!telematicsConfig.clearVoltswitchCredentials
      })
    }, token);
    setTelematicsConfig({
      ...DEFAULT_TELEMATICS_CONFIG,
      ...(out || {}),
      planDefaults: {
        ...DEFAULT_TELEMATICS_CONFIG.planDefaults,
        ...(out?.planDefaults || {})
      },
      zubieWebhookSecret: '',
      clearZubieWebhookSecret: false,
      voltswitchApiPassword: '',
      clearVoltswitchCredentials: false
    });
    setMsg('Telematics settings saved');
  };

  const [voltswitchSyncBusy, setVoltswitchSyncBusy] = useState(false);
  const [voltswitchSyncResult, setVoltswitchSyncResult] = useState(null);
  const runVoltswitchSyncNow = async () => {
    setVoltswitchSyncBusy(true);
    setVoltswitchSyncResult(null);
    try {
      const out = await api(scopedSettingsPath('/api/vehicles/telematics/voltswitch/sync'), { method: 'POST' }, token);
      setVoltswitchSyncResult(out || {});
      setMsg(`Voltswitch sync: ${out?.synced ?? 0} devices synced, ${(out?.devices || []).filter((d) => d.matched).length} matched to fleet vehicles`);
    } catch (err) {
      setVoltswitchSyncResult({ error: err?.message || 'Sync failed' });
      setMsg(`Voltswitch sync failed: ${err?.message || 'unknown error'}`);
    } finally {
      setVoltswitchSyncBusy(false);
    }
  };

  // Market Intelligence dashboard SIPP picker (beta.134)
  const toggleDashboardSipp = (code) => {
    setDashboardSipps((current) => {
      const has = current.sipps.includes(code);
      if (has) return { ...current, sipps: current.sipps.filter((c) => c !== code) };
      if (current.sipps.length >= (current.max || 6)) return current; // cap reached
      return { ...current, sipps: [...current.sipps, code] };
    });
  };

  const saveDashboardSipps = async () => {
    const out = await api(scopedSettingsPath('/api/settings/dashboard-sipps'), {
      method: 'PUT',
      body: JSON.stringify({ sipps: dashboardSipps.sipps })
    }, token);
    setDashboardSipps({
      sipps: Array.isArray(out?.sipps) ? out.sipps : [],
      options: Array.isArray(out?.options) ? out.options : dashboardSipps.options,
      max: Number(out?.max) || dashboardSipps.max || 6
    });
    setMsg('Dashboard SIPPs saved');
  };

  // Market Intelligence excluded competitors (per-tenant pool hygiene)
  const saveMarketExcludedVendors = async () => {
    const vendors = excludedVendorsText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const out = await api(scopedSettingsPath('/api/settings/market-excluded-vendors'), {
      method: 'PUT',
      body: JSON.stringify({ vendors })
    }, token);
    setExcludedVendorsText((Array.isArray(out?.vendors) ? out.vendors : []).join('\n'));
    setMsg('Excluded competitors saved');
  };

  // Tax-aware pricing config per location ------------------------------------
  // taxes round-trip as "name:pct, name:pct" text (e.g. "PR tax:11.5, Airport fee:10.5").
  const taxesToText = (taxes) => (Array.isArray(taxes) ? taxes : [])
    .map((t) => `${t.name || 'Tax'}:${t.pct}`).join(', ');
  const parseTaxesText = (text) => String(text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.lastIndexOf(':');
      const name = (i >= 0 ? s.slice(0, i) : s).trim() || 'Tax';
      const pct = Number((i >= 0 ? s.slice(i + 1) : '').trim()) || 0;
      return { name, pct };
    });

  // Positional utilization tiers round-trip as "fromPct => target" per line, e.g.
  //   50 => 3 cheapest · 70 => 5 cheapest · 85 => market · 90 => market +15%
  const tierTargetToText = (t) => {
    switch (t.type) {
      case 'NTH_CHEAPEST': return (t.n || 1) === 1 ? 'cheapest' : `${t.n} cheapest`;
      case 'NTH_EXPENSIVE': return `${t.n} expensive`;
      case 'MARKET': return 'market';
      case 'MARKET_PCT': return `market ${(t.pct ?? 0) >= 0 ? '+' : ''}${t.pct ?? 0}%`;
      case 'CHEAPEST_MINUS': return `cheapest -${t.amount ?? 0}`;
      default: return '';
    }
  };
  const tiersToText = (rules) => (Array.isArray(rules) ? rules : [])
    .map((t) => `${t.fromPct} => ${tierTargetToText(t)}`).join('\n');
  const parseTierTarget = (raw, fromPct) => {
    const r = String(raw || '').trim().toLowerCase();
    if (r.includes('market')) {
      const m = r.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
      return m ? { fromPct, type: 'MARKET_PCT', pct: Number(m[1]) } : { fromPct, type: 'MARKET' };
    }
    let m = r.match(/(\d+)\s*(?:st|nd|rd|th)?\s*(?:cheap|barat)/);
    if (m) return { fromPct, type: 'NTH_CHEAPEST', n: Number(m[1]) };
    m = r.match(/(\d+)\s*(?:st|nd|rd|th)?\s*(?:expens|caro)/);
    if (m) return { fromPct, type: 'NTH_EXPENSIVE', n: Number(m[1]) };
    m = r.match(/cheapest\s*-\s*\$?(\d+(?:\.\d+)?)/);
    if (m) return { fromPct, type: 'CHEAPEST_MINUS', amount: Number(m[1]) };
    if (/cheap|barat/.test(r)) return { fromPct, type: 'NTH_CHEAPEST', n: 1 };
    return null;
  };
  const parseTiersText = (text) => String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const sep = s.includes('=>') ? '=>' : ':';
      const i = s.indexOf(sep);
      const fromPct = Number((i >= 0 ? s.slice(0, i) : s).trim()) || 0;
      return parseTierTarget(i >= 0 ? s.slice(i + sep.length) : '', fromPct);
    })
    .filter(Boolean);

  const savePricingConfig = async () => {
    if (!pcDraft.locationCode.trim()) { setPcError('Location code is required'); return; }
    const floorBase = pcDraft.floorBase === '' ? null : Number(pcDraft.floorBase);
    const ceilingBase = pcDraft.ceilingBase === '' ? null : Number(pcDraft.ceilingBase);
    const maxDeltaPct = pcDraft.maxDeltaPct === '' ? null : Number(pcDraft.maxDeltaPct);
    // Money-safety validation (mirrors the backend guardrail checks).
    if (ceilingBase != null && (!Number.isFinite(ceilingBase) || ceilingBase < 0)) {
      setPcError('Ceiling (base $) must be a positive number'); return;
    }
    if (floorBase != null && ceilingBase != null && ceilingBase < floorBase) {
      setPcError('Ceiling (base $) must be greater than or equal to Floor (base $)'); return;
    }
    if (maxDeltaPct != null && (!Number.isFinite(maxDeltaPct) || maxDeltaPct <= 0 || maxDeltaPct > 100)) {
      setPcError('Max move per run must be a percent greater than 0, up to 100'); return;
    }
    setPcError('');
    const body = {
      locationCode: pcDraft.locationCode.trim().toUpperCase(),
      connectionType: pcDraft.connectionType,
      taxes: parseTaxesText(pcDraft.taxesText),
      brokeragePct: Number(pcDraft.brokeragePct) || 0,
      floorBase,
      ceilingBase,
      maxDeltaPct,
      utilizationRules: parseTiersText(pcDraft.utilTiersText),
    };
    await api(scopedSettingsPath('/api/settings/market-pricing-config'), { method: 'PUT', body: JSON.stringify(body) }, token);
    const out = await api(scopedSettingsPath('/api/settings/market-pricing-config'), { bypassCache: true }, token);
    setPricingConfigs({ configs: out?.configs || [], connectionTypes: out?.connectionTypes || ['TITANIUM', 'AMADEUS'] });
    setPcDraft({ locationCode: '', connectionType: 'TITANIUM', taxesText: '', brokeragePct: '', floorBase: '', ceilingBase: '', maxDeltaPct: '', utilTiersText: '' });
    setMsg('Pricing config saved');
  };

  const editPricingConfig = (c) => setPcDraft({
    locationCode: c.locationCode,
    connectionType: c.connectionType,
    taxesText: taxesToText(c.taxes),
    brokeragePct: String(c.brokeragePct ?? ''),
    floorBase: c.floorBase == null ? '' : String(c.floorBase),
    ceilingBase: c.ceilingBase == null ? '' : String(c.ceilingBase),
    maxDeltaPct: c.maxDeltaPct == null ? '' : String(c.maxDeltaPct),
    utilTiersText: tiersToText(c.utilizationRules),
  });

  const deletePricingConfig = async (code) => {
    await api(scopedSettingsPath(`/api/settings/market-pricing-config/${encodeURIComponent(code)}`), { method: 'DELETE' }, token);
    const out = await api(scopedSettingsPath('/api/settings/market-pricing-config'), { bypassCache: true }, token);
    setPricingConfigs({ configs: out?.configs || [], connectionTypes: out?.connectionTypes || ['TITANIUM', 'AMADEUS'] });
    setMsg('Pricing config removed');
  };

  const saveRevenuePricingConfig = async () => {
    const out = await api(scopedSettingsPath('/api/settings/revenue-pricing'), {
      method: 'PUT',
      body: JSON.stringify({
        enabled: !!revenuePricingConfig.enabled,
        recommendationMode: String(revenuePricingConfig.recommendationMode || 'ADVISORY').toUpperCase(),
        applyToPublicQuotes: !!revenuePricingConfig.applyToPublicQuotes,
        weekendMarkupPct: Number(revenuePricingConfig.weekendMarkupPct || 0),
        shortLeadWindowDays: Number(revenuePricingConfig.shortLeadWindowDays || 0),
        shortLeadMarkupPct: Number(revenuePricingConfig.shortLeadMarkupPct || 0),
        lastMinuteWindowDays: Number(revenuePricingConfig.lastMinuteWindowDays || 0),
        lastMinuteMarkupPct: Number(revenuePricingConfig.lastMinuteMarkupPct || 0),
        utilizationMediumThresholdPct: Number(revenuePricingConfig.utilizationMediumThresholdPct || 0),
        utilizationMediumMarkupPct: Number(revenuePricingConfig.utilizationMediumMarkupPct || 0),
        utilizationHighThresholdPct: Number(revenuePricingConfig.utilizationHighThresholdPct || 0),
        utilizationHighMarkupPct: Number(revenuePricingConfig.utilizationHighMarkupPct || 0),
        utilizationCriticalThresholdPct: Number(revenuePricingConfig.utilizationCriticalThresholdPct || 0),
        utilizationCriticalMarkupPct: Number(revenuePricingConfig.utilizationCriticalMarkupPct || 0),
        shortageMarkupPct: Number(revenuePricingConfig.shortageMarkupPct || 0),
        maxAdjustmentPct: Number(revenuePricingConfig.maxAdjustmentPct || 0)
      })
    }, token);
    setRevenuePricingConfig({
      ...DEFAULT_REVENUE_PRICING_CONFIG,
      ...(out || {})
    });
    setMsg('Revenue pricing settings saved');
  };

  const savePrecheckinDiscount = async () => {
    const out = await api(scopedSettingsPath('/api/settings/precheckin-discount'), {
      method: 'PUT',
      body: JSON.stringify({
        enabled: !!precheckinDiscount.enabled,
        type: String(precheckinDiscount.type || 'PERCENTAGE').toUpperCase(),
        value: Math.max(0, Number(precheckinDiscount.value || 0))
      })
    }, token);
    setPrecheckinDiscount({ ...DEFAULT_PRECHECKIN_DISCOUNT, ...(out || {}) });
    setMsg('Pre-check-in discount settings saved');
  };

  const savePrecheckinAutoEmail = async () => {
    const out = await api(scopedSettingsPath('/api/settings/precheckin-auto-email'), {
      method: 'PUT',
      body: JSON.stringify({
        enabled: !!precheckinAutoEmail.enabled,
        leadHours: Number(precheckinAutoEmail.leadHours) || 48,
        reminderEnabled: !!precheckinAutoEmail.reminderEnabled,
        reminderLeadHours: Number(precheckinAutoEmail.reminderLeadHours) || 24
      })
    }, token);
    setPrecheckinAutoEmail({ ...DEFAULT_PRECHECKIN_AUTO_EMAIL, ...(out || {}) });
    setMsg('Pre-check-in auto-email settings saved');
  };

  const saveSelfServiceConfig = async () => {
    const out = await api(scopedSettingsPath('/api/settings/self-service'), {
      method: 'PUT',
      body: JSON.stringify({
        enabled: !!selfServiceConfig.enabled,
        allowPickup: !!selfServiceConfig.allowPickup,
        allowDropoff: !!selfServiceConfig.allowDropoff,
        requirePrecheckinForPickup: !!selfServiceConfig.requirePrecheckinForPickup,
        requireSignatureForPickup: !!selfServiceConfig.requireSignatureForPickup,
        requirePaymentForPickup: !!selfServiceConfig.requirePaymentForPickup,
        allowAfterHoursPickup: !!selfServiceConfig.allowAfterHoursPickup,
        allowAfterHoursDropoff: !!selfServiceConfig.allowAfterHoursDropoff,
        keyExchangeMode: String(selfServiceConfig.keyExchangeMode || 'DESK').toUpperCase(),
        pickupInstructions: String(selfServiceConfig.pickupInstructions || ''),
        dropoffInstructions: String(selfServiceConfig.dropoffInstructions || ''),
        supportPhone: String(selfServiceConfig.supportPhone || ''),
        readinessMode: String(selfServiceConfig.readinessMode || 'STRICT').toUpperCase(),
        carSharingAutoRevealEnabled: !!selfServiceConfig.carSharingAutoRevealEnabled,
        carSharingAutoRevealModes: Array.isArray(selfServiceConfig.carSharingAutoRevealModes) ? selfServiceConfig.carSharingAutoRevealModes : [],
        carSharingDefaultRevealWindowHours: Number(selfServiceConfig.carSharingDefaultRevealWindowHours || 0),
        carSharingAirportRevealWindowHours: Number(selfServiceConfig.carSharingAirportRevealWindowHours || 0),
        carSharingHotelRevealWindowHours: Number(selfServiceConfig.carSharingHotelRevealWindowHours || 0),
        carSharingNeighborhoodRevealWindowHours: Number(selfServiceConfig.carSharingNeighborhoodRevealWindowHours || 0),
        carSharingStationRevealWindowHours: Number(selfServiceConfig.carSharingStationRevealWindowHours || 0),
        carSharingHostPickupRevealWindowHours: Number(selfServiceConfig.carSharingHostPickupRevealWindowHours || 0),
        carSharingBranchRevealWindowHours: Number(selfServiceConfig.carSharingBranchRevealWindowHours || 0),
        carSharingDefaultHandoffMode: String(selfServiceConfig.carSharingDefaultHandoffMode || 'IN_PERSON').toUpperCase(),
        carSharingAirportHandoffMode: String(selfServiceConfig.carSharingAirportHandoffMode || 'LOCKBOX').toUpperCase(),
        carSharingHotelHandoffMode: String(selfServiceConfig.carSharingHotelHandoffMode || 'IN_PERSON').toUpperCase(),
        carSharingNeighborhoodHandoffMode: String(selfServiceConfig.carSharingNeighborhoodHandoffMode || 'SELF_SERVICE').toUpperCase(),
        carSharingStationHandoffMode: String(selfServiceConfig.carSharingStationHandoffMode || 'LOCKBOX').toUpperCase(),
        carSharingHostPickupHandoffMode: String(selfServiceConfig.carSharingHostPickupHandoffMode || 'LOCKBOX').toUpperCase(),
        carSharingBranchHandoffMode: String(selfServiceConfig.carSharingBranchHandoffMode || 'SELF_SERVICE').toUpperCase(),
        carSharingAirportInstructionsTemplate: String(selfServiceConfig.carSharingAirportInstructionsTemplate || ''),
        carSharingHotelInstructionsTemplate: String(selfServiceConfig.carSharingHotelInstructionsTemplate || ''),
        carSharingNeighborhoodInstructionsTemplate: String(selfServiceConfig.carSharingNeighborhoodInstructionsTemplate || ''),
        carSharingStationInstructionsTemplate: String(selfServiceConfig.carSharingStationInstructionsTemplate || ''),
        carSharingHostPickupInstructionsTemplate: String(selfServiceConfig.carSharingHostPickupInstructionsTemplate || ''),
        carSharingBranchInstructionsTemplate: String(selfServiceConfig.carSharingBranchInstructionsTemplate || '')
      })
    }, token);
    setSelfServiceConfig({
      ...DEFAULT_SELF_SERVICE_CONFIG,
      ...(out || {})
    });
    setMsg('Self-service settings saved');
  };

  const saveCarSharingPreset = async () => {
    const payload = {
      placeType: carSharingPresetForm.placeType,
      label: String(carSharingPresetForm.label || ''),
      publicLabel: String(carSharingPresetForm.publicLabel || ''),
      anchorLocationId: carSharingPresetForm.anchorLocationId || null,
      city: String(carSharingPresetForm.city || ''),
      state: String(carSharingPresetForm.state || ''),
      postalCode: String(carSharingPresetForm.postalCode || ''),
      country: String(carSharingPresetForm.country || ''),
      radiusMiles: carSharingPresetForm.radiusMiles === '' ? null : Number(carSharingPresetForm.radiusMiles),
      visibilityMode: carSharingPresetForm.visibilityMode,
      searchable: !!carSharingPresetForm.searchable,
      isActive: !!carSharingPresetForm.isActive,
      pickupEligible: !!carSharingPresetForm.pickupEligible,
      deliveryEligible: !!carSharingPresetForm.deliveryEligible
    };
    if (carSharingPresetForm.id) {
      await api(scopedSettingsPath(`/api/settings/car-sharing-search-places/${carSharingPresetForm.id}`), {
        method: 'PATCH',
        body: JSON.stringify(payload)
      }, token);
      setMsg('Car sharing preset updated');
    } else {
      await api(scopedSettingsPath('/api/settings/car-sharing-search-places'), {
        method: 'POST',
        body: JSON.stringify(payload)
      }, token);
      setMsg('Car sharing preset created');
    }
    setCarSharingPresetForm(DEFAULT_CAR_SHARING_PRESET);
    await load(true);
  };

  const removeCarSharingPreset = async (id) => {
    if (!window.confirm('Remove this car sharing preset?')) return;
    await api(scopedSettingsPath(`/api/settings/car-sharing-search-places/${id}`), {
      method: 'DELETE'
    }, token);
    setMsg('Car sharing preset removed');
    if (carSharingPresetForm.id === id) setCarSharingPresetForm(DEFAULT_CAR_SHARING_PRESET);
    await load(true);
  };

  const runRevenuePricingPreview = async () => {
    if (!revenuePricingPreview.vehicleTypeId || !revenuePricingPreview.pickupAt || !revenuePricingPreview.returnAt) {
      setMsg('Select vehicle type, pickup, and return to preview revenue pricing.');
      return;
    }
    const qs = new URLSearchParams({
      vehicleTypeId: String(revenuePricingPreview.vehicleTypeId),
      pickupAt: new Date(revenuePricingPreview.pickupAt).toISOString(),
      returnAt: new Date(revenuePricingPreview.returnAt).toISOString(),
      ...(revenuePricingPreview.pickupLocationId ? { pickupLocationId: String(revenuePricingPreview.pickupLocationId) } : {}),
      displayOnline: revenuePricingPreview.displayOnline ? 'true' : 'false'
    });
    const out = await api(scopedSettingsPath(`/api/rates/revenue-recommendation?${qs.toString()}`), { bypassCache: true }, token);
    setRevenuePricingPreviewResult(out || null);
    setMsg(out?.summary || 'Revenue pricing preview loaded');
  };

  const uploadLogo = (file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => setCfg((x) => ({ ...x, companyLogoUrl: String(r.result || '') }));
    r.readAsDataURL(file);
  };

  const addLocation = async (e) => {
    e.preventDefault();
    await api(scopedSettingsPath('/api/locations'), { method: 'POST', body: JSON.stringify(locationForm) }, token);
    setLocationForm(EMPTY_LOCATION);
    setMsg('Location added');
    await load(true);
  };

  const patchLocation = async (id, patch) => {
    await api(scopedSettingsPath(`/api/locations/${id}`), { method: 'PATCH', body: JSON.stringify(patch) }, token);
    setMsg('Location updated');
    await load(true);
  };

  const removeLocation = async (id) => {
    if (!window.confirm('Remove this location?')) return;
    await api(scopedSettingsPath(`/api/locations/${id}`), { method: 'DELETE' }, token);
    setMsg('Location removed');
    await load(true);
  };

  const copyLocationSettings = (source) => {
    setCopyLocationModal({ sourceId: source.id, targetId: '' });
  };

  const executeCopyLocationSettings = async () => {
    try {
      if (!copyLocationModal?.sourceId || !copyLocationModal?.targetId) {
        setMsg('Select a target location');
        window.alert('Please select a target location first.');
        return;
      }

      const source = locations.find((l) => l.id === copyLocationModal.sourceId);
      const target = locations.find((l) => l.id === copyLocationModal.targetId);
      if (!source || !target) {
        setMsg('Invalid source/target location');
        window.alert('Copy failed: invalid source or target location.');
        return;
      }

      const sourceConfig = (() => {
        try {
          if (!source.locationConfig) return LOCATION_CONFIG_DEFAULT;
          if (typeof source.locationConfig === 'string') return JSON.parse(source.locationConfig);
          return source.locationConfig;
        } catch {
          return LOCATION_CONFIG_DEFAULT;
        }
      })();

      await patchLocation(target.id, {
        taxRate: Number(source.taxRate || 0),
        feeIds: (source.locationFees || []).map((lf) => lf.feeId),
        locationConfig: { ...LOCATION_CONFIG_DEFAULT, ...(sourceConfig || {}) }
      });

      setCopyLocationModal(null);
      setMsg(`Copied settings from ${source.code} to ${target.code}`);
      window.alert(`Settings copied successfully from ${source.code} to ${target.code}.`);
    } catch (e) {
      const text = String(e?.message || 'Unknown error');
      setMsg(`Copy failed: ${text}`);
      window.alert(`Copy failed: ${text}`);
    }
  };

  const resetVehicleTypeForm = () => {
    setVehicleTypeForm(EMPTY_VEHICLE_TYPE);
    setVehicleTypeEditId(null);
  };

  const uploadVehicleTypeImage = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setVehicleTypeForm((current) => ({ ...current, imageUrl: String(reader.result || '') }));
    reader.readAsDataURL(file);
  };

  const saveVehicleType = async (e) => {
    e.preventDefault();
    const code = String(vehicleTypeForm.code || '').trim().toUpperCase();
    const name = String(vehicleTypeForm.name || '').trim();
    const description = String(vehicleTypeForm.description || '').trim();
    if (!code || !name) {
      setMsg('Vehicle type code and name are required');
      return;
    }
    const duplicate = vehicleTypes.some((vt) => vt.code?.toUpperCase() === code && vt.id !== vehicleTypeEditId);
    if (duplicate) {
      setMsg('Vehicle type code already exists. Use a unique code.');
      return;
    }
    const payload = { code, name, description: description || null, imageUrl: vehicleTypeForm.imageUrl || null };
    try {
      if (vehicleTypeEditId) {
        await api(scopedSettingsPath(`/api/vehicle-types/${vehicleTypeEditId}`), { method: 'PATCH', body: JSON.stringify(payload) }, token);
        setMsg('Vehicle type updated');
      } else {
        await api(scopedSettingsPath('/api/vehicle-types'), { method: 'POST', body: JSON.stringify(payload) }, token);
        setMsg('Vehicle type added');
      }
      resetVehicleTypeForm();
      await load(true);
    } catch (err) {
      setMsg(err?.message || 'Failed to save vehicle type');
    }
  };

  const editVehicleType = (vt) => {
    setVehicleTypeEditId(vt.id);
    setVehicleTypeForm({
      code: vt.code || '',
      name: vt.name || '',
      description: vt.description || '',
      imageUrl: vt.imageUrl || ''
    });
  };

  const removeVehicleType = async (vt) => {
    if (!window.confirm(`Delete vehicle type ${vt.code || vt.name}?`)) return;
    try {
      await api(scopedSettingsPath(`/api/vehicle-types/${vt.id}`), { method: 'DELETE' }, token);
      setMsg('Vehicle type removed');
      if (vehicleTypeEditId === vt.id) resetVehicleTypeForm();
      await load(true);
    } catch (err) {
      setMsg(err?.message || 'Failed to remove vehicle type');
    }
  };

  const editLocation = (loc) => {
    let parsedConfig = { ...LOCATION_CONFIG_DEFAULT };
    try {
      if (loc.locationConfig) {
        const raw = typeof loc.locationConfig === 'string' ? JSON.parse(loc.locationConfig) : loc.locationConfig;
        if (raw && typeof raw === 'object') parsedConfig = { ...LOCATION_CONFIG_DEFAULT, ...raw };
      }
    } catch {}

    setLocationEditor({
      id: loc.id,
      code: loc.code || '',
      name: loc.name || '',
      address: loc.address || '',
      city: loc.city || '',
      state: loc.state || '',
      country: loc.country || '',
      isActive: !!loc.isActive,
      taxRate: String(loc.taxRate ?? '0'),
      latitude: loc.latitude == null ? '' : String(loc.latitude),
      longitude: loc.longitude == null ? '' : String(loc.longitude),
      geofenceRadiusKm: loc.geofenceRadiusKm == null ? '' : String(loc.geofenceRadiusKm),
      feeIds: (loc.locationFees || []).map((lf) => lf.feeId),
      config: parsedConfig
    });
    setLocationEditorTab('main');
  };
  const toggleLocationFee = (feeId) => {
    setLocationEditor((prev) => {
      if (!prev) return prev;
      const set = new Set(prev.feeIds || []);
      if (set.has(feeId)) set.delete(feeId); else set.add(feeId);
      return { ...prev, feeIds: Array.from(set) };
    });
  };

  const saveLocationEditor = async () => {
    if (!locationEditor) return;
    if (!locationEditor.code || !locationEditor.name) {
      setMsg('Location code and name are required');
      return;
    }

    const tax = Number(locationEditor.taxRate || 0);
    const grace = Number(locationEditor.config?.gracePeriodMin || 0);
    const minAge = Number(locationEditor.config?.chargeAgeMin || 0);
    const maxAge = Number(locationEditor.config?.chargeAgeMax || 0);
    const underageAlertAge = Number(locationEditor.config?.underageAlertAge || 0);

    if (Number.isNaN(tax) || tax < 0 || tax > 100) { setMsg('Tax rate must be between 0 and 100'); return; }
    if (Number.isNaN(grace) || grace < 0) { setMsg('Grace period must be 0 or more'); return; }
    if (Number.isNaN(minAge) || minAge < 16) { setMsg('Minimum age must be at least 16'); return; }
    if (Number.isNaN(maxAge) || maxAge < minAge) { setMsg('Maximum age must be greater than or equal to minimum age'); return; }
    if (locationEditor.config?.underageAlertEnabled && (Number.isNaN(underageAlertAge) || underageAlertAge < 16)) { setMsg('Underage alert age must be at least 16'); return; }
    const underageFeeMaxAge = Number(locationEditor.config?.underageFeeMaxAge || 0);
    if (locationEditor.config?.ageRulesEnforced && (Number.isNaN(underageFeeMaxAge) || underageFeeMaxAge < minAge)) { setMsg('Underage fee max age must be greater than or equal to minimum age'); return; }

    const geoLat = String(locationEditor.latitude ?? '').trim();
    const geoLng = String(locationEditor.longitude ?? '').trim();
    const geoRadius = String(locationEditor.geofenceRadiusKm ?? '').trim();
    if ((geoLat === '') !== (geoLng === '')) { setMsg('Geofence needs BOTH latitude and longitude (or leave both empty)'); return; }
    if (geoLat !== '' && (Number.isNaN(Number(geoLat)) || Math.abs(Number(geoLat)) > 90)) { setMsg('Latitude must be a number between -90 and 90'); return; }
    if (geoLng !== '' && (Number.isNaN(Number(geoLng)) || Math.abs(Number(geoLng)) > 180)) { setMsg('Longitude must be a number between -180 and 180'); return; }
    if (geoRadius !== '' && (Number.isNaN(Number(geoRadius)) || Number(geoRadius) <= 0)) { setMsg('Geofence radius must be a positive number of km'); return; }

    await patchLocation(locationEditor.id, {
      code: locationEditor.code,
      name: locationEditor.name,
      address: locationEditor.address,
      city: locationEditor.city,
      state: locationEditor.state,
      country: locationEditor.country,
      isActive: !!locationEditor.isActive,
      taxRate: tax,
      latitude: geoLat === '' ? null : Number(geoLat),
      longitude: geoLng === '' ? null : Number(geoLng),
      geofenceRadiusKm: geoRadius === '' ? null : Number(geoRadius),
      feeIds: locationEditor.feeIds || [],
      locationConfig: locationEditor.config || LOCATION_CONFIG_DEFAULT
    });
    setLocationEditor(null);
  };
  const toggleServiceVehicleType = (id) => {
    setServiceForm((prev) => {
      const set = new Set(prev.vehicleTypeIds || []);
      if (set.has(id)) set.delete(id); else set.add(id);
      return { ...prev, vehicleTypeIds: Array.from(set) };
    });
  };

  const resetServiceForm = () => {
    setServiceForm(EMPTY_SERVICE);
    setServiceEditId(null);
  };

  const addService = async (e) => {
    e.preventDefault();
    const payload = {
      ...serviceForm,
      rate: Number(serviceForm.rate || 0),
      dailyRate: serviceForm.dailyRate === '' ? null : Number(serviceForm.dailyRate),
      weeklyRate: serviceForm.weeklyRate === '' ? null : Number(serviceForm.weeklyRate),
      monthlyRate: serviceForm.monthlyRate === '' ? null : Number(serviceForm.monthlyRate),
      commissionValueType: serviceForm.commissionValueType || null,
      commissionPercentValue: serviceForm.commissionPercentValue === '' ? null : Number(serviceForm.commissionPercentValue),
      commissionFixedAmount: serviceForm.commissionFixedAmount === '' ? null : Number(serviceForm.commissionFixedAmount),
      defaultQty: Number(serviceForm.defaultQty || 1),
      sortOrder: Number(serviceForm.sortOrder || 0),
      displayDescription: serviceForm.displayDescription || null,
      displayPriority: Number(serviceForm.displayPriority || 0),
      vehicleTypeIds: JSON.stringify(serviceForm.vehicleTypeIds || []),
      locationId: serviceForm.locationId || null,
      linkedFeeId: serviceForm.linkedFeeId || null
    };
    await api(scopedSettingsPath(serviceEditId ? `/api/additional-services/${serviceEditId}` : '/api/additional-services'), {
      method: serviceEditId ? 'PATCH' : 'POST',
      body: JSON.stringify(payload)
    }, token);
    resetServiceForm();
    setMsg(serviceEditId ? 'Additional service updated' : 'Additional service added');
    await load(true);
  };

  const patchService = async (id, patch) => {
    await api(scopedSettingsPath(`/api/additional-services/${id}`), { method: 'PATCH', body: JSON.stringify(patch) }, token);
    setMsg('Additional service updated');
    await load(true);
  };

  const removeService = async (id) => {
    if (!window.confirm('Remove this service?')) return;
    await api(scopedSettingsPath(`/api/additional-services/${id}`), { method: 'DELETE' }, token);
    setMsg('Service removed');
    await load(true);
  };

  const addFee = async (e) => {
    e.preventDefault();
    await api(scopedSettingsPath('/api/fees'), { method: 'POST', body: JSON.stringify({ ...feeForm, amount: Number(feeForm.amount || 0) }) }, token);
    setFeeForm(EMPTY_FEE);
    setMsg('Fee added');
    await load(true);
  };

  const editFee = async (fee) => {
    const name = window.prompt('Fee name', fee.name || '');
    if (name === null) return;
    const amount = window.prompt('Amount', String(fee.amount ?? '0'));
    if (amount === null) return;
    await api(scopedSettingsPath(`/api/fees/${fee.id}`), {
      method: 'PATCH',
      body: JSON.stringify({
        name,
        amount: Number(amount || 0),
        mandatory: !!fee.mandatory
      })
    }, token);
    setMsg('Fee updated');
    await load(true);
  };

  const toggleFee = async (fee) => {
    await api(scopedSettingsPath(`/api/fees/${fee.id}`), { method: 'PATCH', body: JSON.stringify({ isActive: !fee.isActive }) }, token);
    await load(true);
  };

  const removeFee = async (id) => {
    if (!window.confirm('Remove this fee?')) return;
    await api(scopedSettingsPath(`/api/fees/${id}`), { method: 'DELETE' }, token);
    setMsg('Fee removed');
    await load(true);
  };

  const saveInsurancePlans = async (nextPlans) => {
    const payload = (nextPlans || []).map((p) => ({
      code: p.code || '',
      name: p.name || '',
      label: p.label || p.name || '',
      description: p.description || '',
      chargeBy: p.chargeBy || 'FIXED',
      mode: p.chargeBy || 'FIXED',
      amount: Number(p.amount || 0),
      commissionValueType: p.commissionValueType || null,
      commissionPercentValue: p.commissionValueType === 'PERCENT' ? Number(p.commissionPercentValue || 0) : null,
      commissionFixedAmount: p.commissionValueType && p.commissionValueType !== 'PERCENT' ? Number(p.commissionFixedAmount || 0) : null,
      taxable: !!p.taxable,
      isActive: p.isActive !== false,
      locationIds: Array.isArray(p.locationIds) ? p.locationIds : [],
      vehicleTypeIds: Array.isArray(p.vehicleTypeIds) ? p.vehicleTypeIds : []
    }));
    await api(scopedSettingsPath('/api/settings/insurance-plans'), { method: 'PUT', body: JSON.stringify({ plans: payload }) }, token);
    setInsurancePlans(payload);
  };

  const resetInsuranceForm = () => {
    setInsuranceForm({
      code: '', name: '', label: '', description: '', chargeBy: 'FIXED', amount: '', commissionValueType: '', commissionPercentValue: '', commissionFixedAmount: '', taxable: false, isActive: true, locationIds: [], vehicleTypeIds: []
    });
    setInsuranceEditIdx(-1);
  };

  const addInsurancePlan = async (e) => {
    e.preventDefault();
    const row = {
      code: insuranceForm.code,
      name: insuranceForm.name,
      label: insuranceForm.label || insuranceForm.name,
      description: insuranceForm.description || '',
      displayDescription: insuranceForm.displayDescription || '',
      displayPriority: Number(insuranceForm.displayPriority || 0),
      chargeBy: insuranceForm.chargeBy,
      amount: Number(insuranceForm.amount || 0),
      commissionValueType: insuranceForm.commissionValueType || '',
      commissionPercentValue: insuranceForm.commissionValueType === 'PERCENT' ? Number(insuranceForm.commissionPercentValue || 0) : '',
      commissionFixedAmount: insuranceForm.commissionValueType && insuranceForm.commissionValueType !== 'PERCENT' ? Number(insuranceForm.commissionFixedAmount || 0) : '',
      taxable: !!insuranceForm.taxable,
      isActive: !!insuranceForm.isActive,
      locationIds: insuranceForm.locationIds || [],
      vehicleTypeIds: insuranceForm.vehicleTypeIds || []
    };
    const next = insuranceEditIdx >= 0
      ? insurancePlans.map((p, i) => (i === insuranceEditIdx ? row : p))
      : [...insurancePlans, row];
    await saveInsurancePlans(next);
    resetInsuranceForm();
    setMsg(insuranceEditIdx >= 0 ? 'Insurance plan updated' : 'Insurance plan saved');
  };

  const editInsurancePlan = (idx) => {
    const p = insurancePlans[idx];
    if (!p) return;
    setInsuranceEditIdx(idx);
    setInsuranceForm({
      code: p.code || '',
      name: p.name || '',
      label: p.label || p.name || '',
      description: p.description || '',
      chargeBy: p.chargeBy || p.mode || 'FIXED',
      amount: String(p.amount ?? ''),
      commissionValueType: p.commissionValueType || '',
      commissionPercentValue: p.commissionPercentValue ?? '',
      commissionFixedAmount: p.commissionFixedAmount ?? '',
      taxable: !!p.taxable,
      isActive: p.isActive !== false,
      locationIds: Array.isArray(p.locationIds) ? p.locationIds : [],
      vehicleTypeIds: Array.isArray(p.vehicleTypeIds) ? p.vehicleTypeIds : []
    });
  };

  const toggleInsurancePlan = async (idx) => {
    const next = insurancePlans.map((p, i) => i === idx ? { ...p, isActive: !p.isActive } : p);
    await saveInsurancePlans(next);
    setMsg('Insurance plan updated');
  };

  const removeInsurancePlan = async (idx) => {
    const next = insurancePlans.filter((_, i) => i !== idx);
    await saveInsurancePlans(next);
    if (insuranceEditIdx === idx) resetInsuranceForm();
    setMsg('Insurance plan removed');
  };

  const resetRateDailyUpload = () => {
    setRateDailyUploadRows([]);
    setRateDailyUploadName('');
    setRateDailyUploadReport(null);
    setRateExcelImport(null);
    setRateLocationPicker(null);
  };

  const buildRateEditorState = (rate) => ({
    id: rate.id,
    rateCode: rate.rateCode || '',
    name: rate.name || '',
    locationId: rate.locationId || '',
    locationIds: (() => {
      try {
        if (Array.isArray(rate.locationIds)) return rate.locationIds;
        if (typeof rate.locationIds === 'string' && rate.locationIds.trim()) {
          const parsed = JSON.parse(rate.locationIds);
          return Array.isArray(parsed) ? parsed : [];
        }
      } catch {}
      return [];
    })(),
    rateType: rate.rateType || 'MULTIPLE_CLASSES',
    calculationBy: rate.calculationBy || '24_HOUR_TIME',
    averageBy: rate.averageBy || 'DATE_RANGE',
    daily: String(rate.daily ?? ''),
    fuelChargePerGallon: rate.fuelChargePerGallon ?? '',
    minChargeDays: rate.minChargeDays ?? '',
    extraMileCharge: rate.extraMileCharge ?? '',
    graceMinutes: rate.graceMinutes ?? '',
    useHourlyRates: !!rate.useHourlyRates,
    active: !!rate.active,
    displayOnline: !!rate.displayOnline,
    sameSpecialRates: !!rate.sameSpecialRates,
    monday: rate.monday ?? true,
    tuesday: rate.tuesday ?? true,
    wednesday: rate.wednesday ?? true,
    thursday: rate.thursday ?? true,
    friday: rate.friday ?? true,
    saturday: rate.saturday ?? true,
    sunday: rate.sunday ?? true,
    effectiveDate: rate.effectiveDate ? new Date(rate.effectiveDate).toISOString().slice(0, 10) : '',
    endDate: rate.endDate ? new Date(rate.endDate).toISOString().slice(0, 10) : '',
    isActive: rate.isActive ?? true,
    dailyPrices: Array.isArray(rate.dailyPrices) ? rate.dailyPrices.map((row) => ({
      id: row.id,
      date: row.date ? new Date(row.date).toISOString().slice(0, 10) : '',
      daily: String(row.daily ?? ''),
      vehicleTypeId: row.vehicleTypeId || '',
      vehicleTypeCode: row.vehicleType?.code || '',
      vehicleTypeName: row.vehicleType?.name || ''
    })) : [],
    rateItems: vehicleTypes.map((vt, idx) => {
      const found = (rate.rateItems || []).find((x) => x.vehicleTypeId === vt.id);
      return {
        vehicleTypeId: vt.id,
        sortOrder: idx,
        hourly: String(found?.hourly ?? ''),
        daily: String(found?.daily ?? ''),
        extraDaily: String(found?.extraDaily ?? ''),
        weekly: String(found?.weekly ?? ''),
        monthly: String(found?.monthly ?? ''),
        minHourly: String(found?.minHourly ?? 0),
        minDaily: String(found?.minDaily ?? 0),
        minWeekly: String(found?.minWeekly ?? 0),
        minMonthly: String(found?.minMonthly ?? 0),
        extraMileCharge: String(found?.extraMileCharge ?? '')
      };
    })
  });

  const applyRateToEditor = (rate) => {
    setRateForm(buildRateEditorState(rate));
    resetRateDailyUpload();
  };

  const addRate = async (e) => {
    e.preventDefault();
    const payload = {
      ...rateForm,
      daily: Number(rateForm.daily || 0),
      fuelChargePerGallon: rateForm.fuelChargePerGallon === '' ? null : Number(rateForm.fuelChargePerGallon),
      minChargeDays: rateForm.minChargeDays === '' ? null : Number(rateForm.minChargeDays),
      extraMileCharge: rateForm.extraMileCharge === '' ? null : Number(rateForm.extraMileCharge),
      graceMinutes: rateForm.graceMinutes === '' ? null : Number(rateForm.graceMinutes),
      locationId: rateForm.locationId || null,
      locationIds: Array.isArray(rateForm.locationIds) ? rateForm.locationIds : [],
      effectiveDate: rateForm.effectiveDate || null,
      endDate: rateForm.endDate || null,
      rateItems: (rateForm.rateItems || []).map((it, idx) => ({
        vehicleTypeId: it.vehicleTypeId,
        sortOrder: idx,
        hourly: Number(it.hourly || 0),
        daily: Number(it.daily || 0),
        extraDaily: Number(it.extraDaily || 0),
        weekly: Number(it.weekly || 0),
        monthly: Number(it.monthly || 0),
        minHourly: Number(it.minHourly || 0),
        minDaily: Number(it.minDaily || 0),
        minWeekly: Number(it.minWeekly || 0),
        minMonthly: Number(it.minMonthly || 0),
        extraMileCharge: Number(it.extraMileCharge || 0)
      }))
    };

    try {
      if (rateForm.id) {
        await api(scopedSettingsPath(`/api/rates/${rateForm.id}`), { method: 'PATCH', body: JSON.stringify(payload) }, token);
        setMsg('Rate updated');
      } else {
        await api(scopedSettingsPath('/api/rates'), { method: 'POST', body: JSON.stringify(payload) }, token);
        setMsg('Rate added');
      }
    } catch (err) {
      const text = String(err?.message || '');
      if (rateForm.id && /\/api\/rates\/.+ failed \(404\)|Rate not found/i.test(text)) {
        setMsg('That rate no longer exists. Please select it again from the list, then save.');
        await load(true);
        return;
      }
      setMsg(text || 'Unable to save rate');
      return;
    }

    setRateForm(EMPTY_RATE);
    resetRateDailyUpload();
    await load(true);
  };

  const editRate = async (rate) => {
    applyRateToEditor(rate);
  };

  const toggleRate = async (rate) => {
    try {
      await api(scopedSettingsPath(`/api/rates/${rate.id}`), { method: 'PATCH', body: JSON.stringify({ isActive: !rate.isActive }) }, token);
      await load(true);
    } catch (err) {
      const text = String(err?.message || '');
      if (/failed \(404\)|Rate not found/i.test(text)) {
        setMsg('That rate no longer exists. The list was refreshed.');
        if (rateForm?.id === rate.id) setRateForm(EMPTY_RATE);
        await load(true);
        return;
      }
      setMsg(text || 'Unable to update rate status');
    }
  };

  const removeRate = async (id) => {
    if (!window.confirm('Delete this rate?')) return;
    try {
      await api(scopedSettingsPath(`/api/rates/${id}`), { method: 'DELETE' }, token);
      setMsg('Rate deleted');
      if (rateForm?.id === id) setRateForm(EMPTY_RATE);
      await load(true);
    } catch (err) {
      const text = String(err?.message || '');
      if (/failed \(404\)|Rate not found/i.test(text)) {
        setMsg('That rate was already removed. The list was refreshed.');
        if (rateForm?.id === id) setRateForm(EMPTY_RATE);
        await load(true);
        return;
      }
      setMsg(text || 'Unable to delete rate');
    }
  };

  const downloadRateDailyPricingTemplate = () => {
    const sampleTypes = vehicleTypes.slice(0, Math.max(1, Math.min(vehicleTypes.length, 3)));
    const sampleRows = sampleTypes.length
      ? sampleTypes.map((vt, idx) => `2026-03-0${idx + 1},${vt.code},${(idx + 5).toFixed(2)}`).join('\n')
      : '2026-03-01,ECON,49.99';
    const csv = `date,vehicleTypeCode,dailyRate\n${sampleRows}\n`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeCode = String(rateForm?.rateCode || 'rate').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
    link.href = url;
    link.download = `${safeCode || 'rate'}-daily-pricing-template.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  // Excel template — mirrors the suggestion-report column layout (Sipp /
  // PickUpDate / SuggestedAmount + Location) so a tenant who doesn't have a
  // CarTrawler export can still build an import file in Excel/Numbers and
  // upload it through the Excel path. Generated as a real .xlsx via a tiny
  // hand-crafted ZIP so we don't have to bundle SheetJS just for this.
  const downloadRateDailyPricingExcelTemplate = async () => {
    const sampleTypes = vehicleTypes.slice(0, Math.max(1, Math.min(vehicleTypes.length, 3)));
    // Resolve the location code from `rateForm.locationId` (rateForm doesn't
    // store locationCode directly — Codex P2 review on PR #49). Fall back
    // through: primary location → first additional locationIds → tenant's
    // first active location → 'SJU' placeholder.
    const findLocCode = (id) => {
      if (!id) return null;
      const match = locations.find((l) => l.id === id);
      return match?.code || null;
    };
    const additionalIds = Array.isArray(rateForm?.locationIds) ? rateForm.locationIds : [];
    const templateLocationCode =
      findLocCode(rateForm?.locationId)
      || (additionalIds.map(findLocCode).find(Boolean))
      || locations.find((l) => l.isActive !== false)?.code
      || 'SJU';

    const sampleData = sampleTypes.length
      ? sampleTypes.map((vt, idx) => ({
          sipp: vt.code,
          location: templateLocationCode,
          date: `2026-03-0${idx + 1}`,
          suggestedAmount: (idx + 5).toFixed(2)
        }))
      : [{ sipp: 'ECON', location: templateLocationCode, date: '2026-03-01', suggestedAmount: '49.99' }];

    // Minimal SheetJS-free .xlsx writer: build the sharedStrings + sheet1 XML
    // manually then zip them together. xlsx is just a ZIP with a few XML
    // files — we only need the headers parseDailyPriceExcel recognizes
    // (Sipp / Location / PickUpDate / SuggestedAmount).
    const sheetRows = [
      ['Sipp', 'Location', 'PickUpDate', 'SuggestedAmount'],
      ...sampleData.map((r) => [r.sipp, r.location, r.date, Number(r.suggestedAmount)])
    ];
    const cellRef = (col, row) => `${String.fromCharCode(65 + col)}${row + 1}`;
    const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // Collect strings for sharedStrings.xml (keeps file smaller than inline strings).
    const stringIndex = new Map();
    const stringList = [];
    const internString = (s) => {
      const key = String(s);
      if (stringIndex.has(key)) return stringIndex.get(key);
      const i = stringList.length;
      stringIndex.set(key, i);
      stringList.push(key);
      return i;
    };

    const sheetData = sheetRows.map((row, rIdx) => {
      const cells = row.map((value, cIdx) => {
        const ref = cellRef(cIdx, rIdx);
        if (typeof value === 'number') {
          return `<c r="${ref}"><v>${value}</v></c>`;
        }
        const idx = internString(value);
        return `<c r="${ref}" t="s"><v>${idx}</v></c>`;
      }).join('');
      return `<row r="${rIdx + 1}">${cells}</row>`;
    }).join('');

    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`;
    const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${stringList.length}" uniqueCount="${stringList.length}">${stringList.map((s) => `<si><t>${xmlEscape(s)}</t></si>`).join('')}</sst>`;
    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Suggestion Report" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;

    // Build the ZIP. Each entry uses store (no compression) — the file is
    // tiny so the size hit is irrelevant and we avoid a zlib dep.
    const encoder = new TextEncoder();
    const files = [
      { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
      { name: '_rels/.rels', data: encoder.encode(rootRels) },
      { name: 'xl/workbook.xml', data: encoder.encode(workbookXml) },
      { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRels) },
      { name: 'xl/sharedStrings.xml', data: encoder.encode(sharedStringsXml) },
      { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(sheetXml) }
    ];

    // CRC32 for ZIP entries (pure JS, table-based).
    let crcTable = downloadRateDailyPricingExcelTemplate._crcTable;
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let j = 0; j < 8; j += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[i] = c >>> 0;
      }
      downloadRateDailyPricingExcelTemplate._crcTable = crcTable;
    }
    const crc32 = (buf) => {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    };

    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const crc = crc32(file.data);
      const size = file.data.length;
      const local = new Uint8Array(30 + nameBytes.length + size);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true); // local file header signature
      dv.setUint16(4, 20, true); // version
      dv.setUint16(6, 0, true); // flags
      dv.setUint16(8, 0, true); // method (0 = store)
      dv.setUint16(10, 0, true); // mod time
      dv.setUint16(12, 0, true); // mod date
      dv.setUint32(14, crc, true);
      dv.setUint32(18, size, true);
      dv.setUint32(22, size, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      local.set(file.data, 30 + nameBytes.length);
      localParts.push(local);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true); // central directory signature
      cv.setUint16(4, 20, true); // version made by
      cv.setUint16(6, 20, true); // version needed
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);
      offset += local.length;
    }
    const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);
    const centralOffset = offset;

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralOffset, true);

    const totalSize = localParts.reduce((sum, p) => sum + p.length, 0) + centralSize + eocd.length;
    const out = new Uint8Array(totalSize);
    let pos = 0;
    for (const p of localParts) { out.set(p, pos); pos += p.length; }
    for (const p of centralParts) { out.set(p, pos); pos += p.length; }
    out.set(eocd, pos);

    const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeCode = String(rateForm?.rateCode || 'rate').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
    link.href = url;
    link.download = `${safeCode || 'rate'}-suggestion-report-template.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  const loadRateDailyPricingFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseDelimitedRows(text);
      setRateDailyUploadRows(rows);
      setRateDailyUploadName(file.name || 'pricing-upload.csv');
      setRateDailyUploadReport(null);
      setMsg(rows.length ? `Loaded ${rows.length} dynamic pricing row(s) from ${file.name}` : 'No pricing rows found in that file');
    } catch (err) {
      setMsg(`Failed to read file: ${err.message}`);
    }
  };

  const validateRateDailyPricing = async () => {
    if (!rateForm?.id) {
      setMsg('Save the rate first, then upload dynamic daily prices.');
      return;
    }
    if (!rateDailyUploadRows.length) {
      setMsg('Upload the pricing template first.');
      return;
    }
    try {
      const out = await api(scopedSettingsPath(`/api/rates/${rateForm.id}/daily-prices/validate`), {
        method: 'POST',
        body: JSON.stringify({ rows: rateDailyUploadRows })
      }, token);
      setRateDailyUploadReport(out);
      setMsg(`Validated ${out.validCount || 0} dynamic daily pricing row(s)`);
    } catch (err) {
      setMsg(String(err?.message || 'Unable to validate dynamic pricing file'));
    }
  };

  const importRateDailyPricing = async () => {
    if (!rateForm?.id) {
      setMsg('Save the rate first, then upload dynamic daily prices.');
      return;
    }
    if (!rateDailyUploadRows.length) {
      setMsg('Upload the pricing template first.');
      return;
    }
    try {
      const out = await api(scopedSettingsPath(`/api/rates/${rateForm.id}/daily-prices/import`), {
        method: 'POST',
        body: JSON.stringify({ rows: rateDailyUploadRows })
      }, token);
      if (out?.rate) applyRateToEditor(out.rate);
      await load(true);
      setRateDailyUploadReport(out ? {
        validCount: out.imported || 0,
        errorCount: Array.isArray(out.errors) ? out.errors.length : 0,
        rows: out.rate?.dailyPrices || [],
        errors: out.errors || []
      } : null);
      setMsg(`Imported ${out?.imported || 0} dynamic daily pricing row(s)`);
    } catch (err) {
      setMsg(String(err?.message || 'Unable to import dynamic daily pricing'));
    }
  };

  // ----- Excel import flow (suggestion-report-style spreadsheets) -----
  // Upload a competitor's daily-rate suggestion .xlsx → backend parses it →
  // we auto-detect the target Rate by Location code → user reviews diff
  // (added/updated/skipped/errors) → Apply commits.
  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => {
      const result = String(reader.result || '');
      // Strip the data-URL prefix; the backend strips it too but we may as well be tidy.
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.readAsDataURL(file);
  });

  const beginRateExcelImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setMsg(`Parsing ${file.name}…`);
      const excelBase64 = await fileToBase64(file);
      const parsed = await api(scopedSettingsPath('/api/rates/parse-excel'), {
        method: 'POST',
        body: JSON.stringify({ excelBase64, filename: file.name })
      }, token);
      const detectedCodes = Array.isArray(parsed?.detectedLocationCodes) ? parsed.detectedLocationCodes : [];
      const primaryLocation = detectedCodes[0] || '';

      let candidateRates = [];
      let lookupResult = null;
      if (primaryLocation) {
        lookupResult = await api(
          scopedSettingsPath(`/api/rates/lookup-by-location/${encodeURIComponent(primaryLocation)}`),
          { method: 'GET' },
          token
        );
        candidateRates = Array.isArray(lookupResult?.rates) ? lookupResult.rates : [];
      }

      // Stash the parsed rows + filename for the next step. The picker / preview
      // pulls from this object; once user picks a Rate we run validate against it.
      const importState = {
        filename: file.name,
        parsedRows: parsed.rows || [],
        rowCount: parsed.rowCount || 0,
        detectedLocationCodes: detectedCodes,
        location: lookupResult?.location || null,
        candidateRates,
        selectedRateId: candidateRates.length === 1 ? candidateRates[0].id : '',
        // Suggestion-report-specific zero-amount filtering happens at parse time
        // (see rates.service.js parseDailyPriceExcel). Carry the counts forward
        // so the diff preview can show the user what was filtered.
        zeroSkipped: Array.isArray(parsed.zeroSkipped) ? parsed.zeroSkipped : [],
        zeroSkippedCount: parsed.zeroSkippedCount || 0,
        report: null,
        applying: false
      };
      setRateExcelImport(importState);

      if (candidateRates.length === 0) {
        setMsg(
          primaryLocation
            ? `No active rates found at location "${primaryLocation}" for this tenant — create one first or pick a different location.`
            : 'Could not detect a location from the Excel; pick a rate manually.'
        );
        // Even without a candidate, show the picker so the user can manually pick from any rate
        setRateLocationPicker({ source: 'excel-import', forceManual: true });
        return;
      }
      if (candidateRates.length > 1) {
        setRateLocationPicker({ source: 'excel-import', forceManual: false });
        setMsg(`Found ${candidateRates.length} rates at ${primaryLocation} — pick one.`);
        return;
      }

      // Exactly one match — auto-validate.
      await runExcelValidate({ ...importState });
    } catch (err) {
      setMsg(String(err?.message || 'Could not parse Excel file'));
      setRateExcelImport(null);
    }
  };

  const runExcelValidate = async (state) => {
    try {
      const rateId = state?.selectedRateId;
      if (!rateId) {
        setMsg('Pick a rate first');
        return;
      }
      const out = await api(scopedSettingsPath(`/api/rates/${rateId}/daily-prices/validate`), {
        method: 'POST',
        body: JSON.stringify({ rows: state.parsedRows, silentSkipUnknownTypes: true })
      }, token);
      const next = { ...state, selectedRateId: rateId, report: out, applying: false };
      setRateExcelImport(next);
      setRateLocationPicker(null);
      setMsg(
        `Preview ready — ${out.addedCount || 0} new, ${out.updatedCount || 0} updates, ` +
        `${out.unchangedCount || 0} unchanged, ${out.skippedCount || 0} skipped, ` +
        `${out.errorCount || 0} errors.`
      );
    } catch (err) {
      setMsg(String(err?.message || 'Could not validate the Excel rows'));
    }
  };

  const applyRateExcelImport = async () => {
    if (!rateExcelImport?.selectedRateId || !rateExcelImport?.parsedRows?.length) return;
    try {
      setRateExcelImport((s) => (s ? { ...s, applying: true } : s));
      const rateId = rateExcelImport.selectedRateId;
      const out = await api(scopedSettingsPath(`/api/rates/${rateId}/daily-prices/import`), {
        method: 'POST',
        body: JSON.stringify({ rows: rateExcelImport.parsedRows, silentSkipUnknownTypes: true })
      }, token);
      if (out?.rate) applyRateToEditor(out.rate);
      await load(true);
      setMsg(
        `Applied — ${out.addedCount || 0} added, ${out.updatedCount || 0} updated, ` +
        `${out.skippedCount || 0} skipped, ${out.errorCount || 0} errors.`
      );
      setRateExcelImport(null);
    } catch (err) {
      setMsg(String(err?.message || 'Could not apply the import'));
      setRateExcelImport((s) => (s ? { ...s, applying: false } : s));
    }
  };

  const cancelRateExcelImport = () => {
    setRateExcelImport(null);
    setRateLocationPicker(null);
  };

  const removeRateDailyPrice = async (dailyPriceId) => {
    if (!rateForm?.id || !dailyPriceId) return;
    try {
      const out = await api(scopedSettingsPath(`/api/rates/${rateForm.id}/daily-prices/${dailyPriceId}`), {
        method: 'DELETE'
      }, token);
      if (out) applyRateToEditor(out);
      await load(true);
      setMsg('Dynamic daily price removed');
    } catch (err) {
      setMsg(String(err?.message || 'Unable to remove dynamic daily price'));
    }
  };

  const editService = async (svc) => {
    setServiceEditId(svc.id);
    setServiceForm({
      code: svc.code || '',
      name: svc.name || '',
      description: svc.description || '',
      chargeType: svc.chargeType || 'UNIT',
      unitLabel: svc.unitLabel || 'Unit',
      calculationBy: svc.calculationBy || '24_HOUR_TIME',
      rate: String(svc.rate ?? ''),
      dailyRate: String(svc.dailyRate ?? ''),
      weeklyRate: String(svc.weeklyRate ?? ''),
      monthlyRate: String(svc.monthlyRate ?? ''),
      commissionValueType: svc.commissionValueType || '',
      commissionPercentValue: String(svc.commissionPercentValue ?? ''),
      commissionFixedAmount: String(svc.commissionFixedAmount ?? ''),
      taxable: !!svc.taxable,
      defaultQty: String(svc.defaultQty ?? 1),
      sortOrder: String(svc.sortOrder ?? 0),
      allVehicleTypes: svc.allVehicleTypes !== false,
      vehicleTypeIds: (() => {
        try {
          if (Array.isArray(svc.vehicleTypeIds)) return svc.vehicleTypeIds;
          if (typeof svc.vehicleTypeIds === 'string' && svc.vehicleTypeIds.trim()) {
            const parsed = JSON.parse(svc.vehicleTypeIds);
            return Array.isArray(parsed) ? parsed : [];
          }
        } catch {}
        return [];
      })(),
      displayOnline: !!svc.displayOnline,
      defaultRencars: !!svc.defaultRencars,
      mandatory: !!svc.mandatory,
      coversTolls: !!svc.coversTolls,
      tollPassthrough: !!svc.tollPassthrough,
      isActive: svc.isActive !== false,
      locationId: svc.locationId || '',
      linkedFeeId: svc.linkedFeeId || ''
    });
  };

  const resetCommissionPlanForm = () => {
    setCommissionPlanForm({
      ...EMPTY_COMMISSION_PLAN,
      tenantId: isSuper ? (activeCommissionTenantId || '') : (me?.tenantId || '')
    });
  };

  const resetCommissionRuleForm = () => {
    setCommissionRuleForm(EMPTY_COMMISSION_RULE);
  };

  const editCommissionPlan = (plan) => {
    setActiveCommissionPlanId(plan.id);
    setCommissionPlanForm({
      id: plan.id,
      tenantId: plan.tenantId || '',
      name: plan.name || '',
      isActive: plan.isActive !== false,
      personKind: plan.personKind || '',
      reviewTiers: Array.isArray(plan.reviewTiersJson) ? plan.reviewTiersJson : [],
      reviewTierSources: Array.isArray(plan.reviewTierSourcesJson) ? plan.reviewTierSourcesJson : [],
      defaultValueType: plan.defaultValueType || '',
      defaultPercentValue: plan.defaultPercentValue ?? '',
      defaultFixedAmount: plan.defaultFixedAmount ?? ''
    });
    resetCommissionRuleForm();
  };

  const saveCommissionPlan = async (e) => {
    e.preventDefault();
    const tenantId = isSuper ? (commissionPlanForm.tenantId || activeCommissionTenantId || '') : (me?.tenantId || '');
    const scopeTenantId = commissionPlanForm.id ? (activeCommissionPlan?.tenantId || tenantId) : tenantId;
    if (!commissionPlanForm.name.trim()) {
      setMsg('Commission plan name is required');
      return;
    }
    if (isSuper && !tenantId) {
      setMsg('Select a tenant before saving a commission plan');
      return;
    }
    const payload = {
      tenantId: tenantId || null,
      name: commissionPlanForm.name.trim(),
      isActive: !!commissionPlanForm.isActive,
      personKind: commissionPlanForm.personKind || null,
      reviewTiers: (commissionPlanForm.reviewTiers || [])
        // An untouched "+ Add tier" row is blank strings — drop it, don't
        // let Number('') turn it into a phantom 0-reviews/0% tier.
        .filter((t) => String(t.minReviews).trim() !== '' && String(t.pct).trim() !== '')
        .map((t) => ({ minReviews: Number(t.minReviews), pct: Number(t.pct) }))
        .filter((t) => Number.isFinite(t.minReviews) && Number.isFinite(t.pct)),
      reviewTierSources: commissionPlanForm.reviewTierSources || [],
      defaultValueType: commissionPlanForm.defaultValueType || null,
      defaultPercentValue: commissionPlanForm.defaultPercentValue,
      defaultFixedAmount: commissionPlanForm.defaultFixedAmount
    };
    try {
      const method = commissionPlanForm.id ? 'PATCH' : 'POST';
      const path = commissionPlanForm.id ? `/api/commissions/plans/${commissionPlanForm.id}` : '/api/commissions/plans';
      const qs = new URLSearchParams();
      if (isSuper && scopeTenantId) qs.set('tenantId', scopeTenantId);
      const saved = await api(`${path}${qs.toString() ? `?${qs.toString()}` : ''}`, { method, body: JSON.stringify(payload) }, token);
      setMsg(commissionPlanForm.id ? 'Commission plan updated' : 'Commission plan created');
      await loadCommissionConfig(activeCommissionTenantId);
      setActiveCommissionPlanId(saved?.id || '');
      resetCommissionPlanForm();
    } catch (e2) {
      setMsg(e2.message);
    }
  };

  const removeCommissionPlan = async (plan) => {
    if (!window.confirm(`Delete commission plan "${plan.name}"?`)) return;
    try {
      const qs = new URLSearchParams();
      if (isSuper && plan?.tenantId) qs.set('tenantId', plan.tenantId);
      await api(`/api/commissions/plans/${plan.id}${qs.toString() ? `?${qs.toString()}` : ''}`, { method: 'DELETE' }, token);
      setMsg('Commission plan removed');
      if (activeCommissionPlanId === plan.id) setActiveCommissionPlanId('');
      resetCommissionPlanForm();
      resetCommissionRuleForm();
      await loadCommissionConfig(activeCommissionTenantId);
    } catch (e) {
      setMsg(e.message);
    }
  };

  const editCommissionRule = (rule) => {
    setCommissionRuleForm({
      id: rule.id,
      name: rule.name || '',
      serviceId: rule.serviceId || '',
      chargeCode: rule.chargeCode || '',
      chargeType: rule.chargeType || '',
      valueType: rule.valueType || 'PERCENT',
      percentValue: rule.percentValue ?? '',
      fixedAmount: rule.fixedAmount ?? '',
      priority: String(rule.priority ?? 0),
      isActive: rule.isActive !== false
    });
  };

  const saveCommissionRule = async (e) => {
    e.preventDefault();
    const activePlan = commissionPlans.find((plan) => plan.id === activeCommissionPlanId);
    const tenantId = activePlan?.tenantId || activeCommissionTenantId || '';
    if (!activePlan) {
      setMsg('Select a commission plan first');
      return;
    }
    if (!commissionRuleForm.name.trim()) {
      setMsg('Commission rule name is required');
      return;
    }
    if (!commissionRuleForm.serviceId && !commissionRuleForm.chargeCode.trim() && !commissionRuleForm.chargeType) {
      setMsg('Choose a service, charge code, or charge type for the rule');
      return;
    }
    if (commissionRuleForm.valueType === 'PERCENT' && commissionRuleForm.percentValue === '') {
      setMsg('Percent value is required for percentage rules');
      return;
    }
    if (commissionRuleForm.valueType !== 'PERCENT' && commissionRuleForm.fixedAmount === '') {
      setMsg('Fixed amount is required for fixed commission rules');
      return;
    }

    const payload = {
      name: commissionRuleForm.name.trim(),
      serviceId: commissionRuleForm.serviceId || null,
      chargeCode: commissionRuleForm.chargeCode.trim() || null,
      chargeType: commissionRuleForm.chargeType || null,
      valueType: commissionRuleForm.valueType,
      percentValue: commissionRuleForm.percentValue,
      fixedAmount: commissionRuleForm.fixedAmount,
      priority: Number(commissionRuleForm.priority || 0),
      isActive: !!commissionRuleForm.isActive
    };

    try {
      const qs = new URLSearchParams();
      if (isSuper && tenantId) qs.set('tenantId', tenantId);
      if (commissionRuleForm.id) {
        await api(`/api/commissions/rules/${commissionRuleForm.id}${qs.toString() ? `?${qs.toString()}` : ''}`, { method: 'PATCH', body: JSON.stringify(payload) }, token);
      } else {
        await api(`/api/commissions/plans/${activePlan.id}/rules${qs.toString() ? `?${qs.toString()}` : ''}`, { method: 'POST', body: JSON.stringify(payload) }, token);
      }
      setMsg(commissionRuleForm.id ? 'Commission rule updated' : 'Commission rule created');
      resetCommissionRuleForm();
      await loadCommissionConfig(activeCommissionTenantId);
    } catch (e2) {
      setMsg(e2.message);
    }
  };

  const removeCommissionRule = async (rule) => {
    if (!window.confirm(`Delete commission rule "${rule.name}"?`)) return;
    const activePlan = commissionPlans.find((plan) => plan.id === activeCommissionPlanId);
    const tenantId = activePlan?.tenantId || activeCommissionTenantId || '';
    try {
      const qs = new URLSearchParams();
      if (isSuper && tenantId) qs.set('tenantId', tenantId);
      await api(`/api/commissions/rules/${rule.id}${qs.toString() ? `?${qs.toString()}` : ''}`, { method: 'DELETE' }, token);
      setMsg('Commission rule removed');
      if (commissionRuleForm.id === rule.id) resetCommissionRuleForm();
      await loadCommissionConfig(activeCommissionTenantId);
    } catch (e) {
      setMsg(e.message);
    }
  };

  const assignCommissionPlanToEmployee = async (employeeId, commissionPlanId) => {
    try {
      const qs = new URLSearchParams();
      if (isSuper && activeCommissionTenantId) qs.set('tenantId', activeCommissionTenantId);
      await api(`/api/commissions/employees/${employeeId}/plan${qs.toString() ? `?${qs.toString()}` : ''}`, {
        method: 'PATCH',
        body: JSON.stringify({ commissionPlanId: commissionPlanId || null })
      }, token);
      setMsg('Employee commission assignment saved');
      await loadCommissionEmployees(activeCommissionTenantId);
    } catch (e) {
      setMsg(e.message);
    }
  };

  const activeCommissionPlan = commissionPlans.find((plan) => plan.id === activeCommissionPlanId) || null;
  const commissionServiceTenantId = activeCommissionPlan?.tenantId || activeCommissionTenantId;
  const commissionServices = services.filter((service) => {
    if (!isSuper || !commissionServiceTenantId) return true;
    return !service?.tenantId || service.tenantId === commissionServiceTenantId;
  });

  const rateScopeLabel = (rate) => {
    if (rate?.location?.name) return rate.location.name;
    try {
      const ids = Array.isArray(rate?.locationIds)
        ? rate.locationIds
        : (typeof rate?.locationIds === 'string' && rate.locationIds.trim() ? JSON.parse(rate.locationIds) : []);
      if (Array.isArray(ids) && ids.length) {
        const names = ids
          .map((id) => locations.find((l) => l.id === id)?.name)
          .filter(Boolean);
        if (names.length) return names.join(', ');
        return `${ids.length} location(s)`;
      }
    } catch {}
    return 'All locations';
  };

  const rateFormMode = rateForm?.id ? 'Editing rate' : 'New rate';
  const rateDateInvalid = !!(rateForm?.effectiveDate && rateForm?.endDate && new Date(rateForm.endDate) < new Date(rateForm.effectiveDate));
  const rateFormValid = !!rateForm?.rateCode && !rateDateInvalid;
  const rateDailyPrices = Array.isArray(rateForm?.dailyPrices) ? rateForm.dailyPrices : [];

  // Build the calendar grid (rows = vehicleTypes that have at least one override
  // in the active filter; cols = dates in range; cells = price + edit/remove).
  // This replaces the old `slice(0, 24)` that was hiding most overrides.
  const rateGrid = (() => {
    if (!rateDailyPrices.length) {
      return { vehicleTypes: [], dates: [], cells: new Map(), totals: { added: 0, updated: 0, unchanged: 0 } };
    }

    const fromTs = rateGridFilters.dateFrom ? new Date(`${rateGridFilters.dateFrom}T00:00:00Z`).getTime() : null;
    const toTs = rateGridFilters.dateTo ? new Date(`${rateGridFilters.dateTo}T00:00:00Z`).getTime() : null;
    const allowedTypeIds = rateGridFilters.vehicleTypeIds.length
      ? new Set(rateGridFilters.vehicleTypeIds)
      : null;

    const filtered = rateDailyPrices.filter((row) => {
      const ts = row.date ? new Date(`${row.date}T00:00:00Z`).getTime() : null;
      if (ts == null || Number.isNaN(ts)) return false;
      if (fromTs != null && ts < fromTs) return false;
      if (toTs != null && ts > toTs) return false;
      if (allowedTypeIds && !allowedTypeIds.has(row.vehicleTypeId)) return false;
      return true;
    });

    // Group by vehicleType and date
    const typeMap = new Map();
    const dateSet = new Set();
    filtered.forEach((row) => {
      if (!typeMap.has(row.vehicleTypeId)) {
        typeMap.set(row.vehicleTypeId, {
          id: row.vehicleTypeId,
          code: row.vehicleTypeCode || '',
          name: row.vehicleTypeName || row.vehicleTypeId
        });
      }
      if (row.date) dateSet.add(row.date);
    });

    const dates = Array.from(dateSet).sort();
    const vehicleTypes = Array.from(typeMap.values()).sort((a, b) =>
      String(a.code).localeCompare(String(b.code))
    );
    const cells = new Map(); // key = `${typeId}|${date}` → row
    filtered.forEach((row) => {
      cells.set(`${row.vehicleTypeId}|${row.date}`, row);
    });

    return { vehicleTypes, dates, cells, totalCount: filtered.length };
  })();
  const activeSettingsTenant = tenantRows.find((tenant) => tenant.id === activeSettingsTenantId) || null;
  const activeLocationCount = loadedSettingsSections.locations
    ? locations.filter((location) => location.isActive !== false).length
    : null;
  const activeVehicleTypeCount = loadedSettingsSections.vehicleTypes ? vehicleTypes.length : null;
  const onlineRateCount = loadedSettingsSections.rates
    ? rates.filter((rate) => rate.isActive !== false && rate.displayOnline).length
    : null;
  const onlineServiceCount = loadedSettingsSections.services
    ? services.filter((service) => service.isActive !== false && service.displayOnline).length
    : null;
  const activeInsuranceCount = loadedSettingsSections.insurancePlans
    ? insurancePlans.filter((plan) => plan.isActive !== false).length
    : null;
  const paymentGatewayLabel = loadedSettingsSections.paymentGateway
    ? ({
        authorizenet: 'Authorize.Net',
        stripe: 'Stripe',
        square: 'Square',
        spin: 'SPIn',
        ipos: 'iPOS Payment Links'
      }[String(paymentGatewayConfig?.gateway || '').toLowerCase()] || 'Not set')
    : '—';
  const settingsReadyCount = [
    loadedSettingsSections.locations && activeLocationCount > 0,
    loadedSettingsSections.vehicleTypes && activeVehicleTypeCount > 0,
    loadedSettingsSections.rates && onlineRateCount > 0,
    loadedSettingsSections.insurancePlans && activeInsuranceCount > 0
  ].filter(Boolean).length;
  const activeTabLabel = {
    agreement: 'Agreement',
    locations: 'Locations',
    fees: 'Fees',
    rates: 'Rates',
    revenue: 'Revenue',
    carSharing: 'Car Sharing',
    selfService: 'Self-Service',
    vehicleTypes: 'Vehicle Types',
    insurance: 'Insurance',
    payments: 'Payments',
    ai: 'AI Copilot',
    telematics: 'Telematics',
    marketIntel: 'Market Intelligence',
    kioskUpsell: 'Kiosk Upsell',
    emails: 'Emails',
    services: 'Additional Services',
    commissions: 'Commissions',
    access: 'Access Control'
  }[tab] || 'Settings';

  if (!isAdmin) {
    return <AppShell me={me} logout={logout}><section className="glass card-lg"><h2>Settings</h2><p className="error">Admin only.</p></section></AppShell>;
  }

  return (
    <AppShell me={me} logout={logout}>
      {msg ? <p className="label">{msg}</p> : null}

      <section className="glass card-lg stack">
        {isSuper ? (
          <div className="form-grid-2" style={{ marginBottom: 8 }}>
            <div className="stack">
              <label className="label">Settings Tenant Scope</label>
              <select value={activeSettingsTenantId} onChange={(e) => setActiveSettingsTenantId(e.target.value)}>
                {tenantRows.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>{tenant.name} ({tenant.slug})</option>
                ))}
              </select>
            </div>
            <div className="surface-note">
              Vehicle types, locations, rates, services, fees, insurance, and agreement settings now follow this tenant
              scope so you can configure exactly what applies to each host and booking flow.
            </div>
          </div>
        ) : null}

        <div className="app-banner">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div className="stack" style={{ gap: 6 }}>
              <span className="eyebrow">Settings Hub</span>
              <h2 style={{ margin: 0 }}>Configuration Snapshot</h2>
              <p className="ui-muted">
                {isSuper
                  ? `Managing ${activeSettingsTenant?.name || 'tenant settings'} with current focus on ${activeTabLabel}.`
                  : `Manage agreement, pricing, supply, and online booking settings with current focus on ${activeTabLabel}.`}
              </p>
            </div>
            <span className={`status-chip ${settingsReadyCount >= 4 ? 'good' : settingsReadyCount >= 2 ? 'warn' : 'neutral'}`}>
              {settingsReadyCount}/4 booking basics ready
            </span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Tenant Scope</span>
              <strong>{isSuper ? (activeSettingsTenant?.name || 'Select tenant') : (me?.tenant?.name || 'Current tenant')}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Active Locations</span>
              <strong>{activeLocationCount ?? '—'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Vehicle Types</span>
              <strong>{activeVehicleTypeCount ?? '—'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Online Rates</span>
              <strong>{onlineRateCount ?? '—'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Online Services</span>
              <strong>{onlineServiceCount ?? '—'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Insurance Plans</span>
              <strong>{activeInsuranceCount ?? '—'}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Payment Gateway</span>
              <strong>{paymentGatewayLabel}</strong>
            </div>
          </div>
          <div className="inline-actions">
            <button type="button" onClick={() => setTab('vehicleTypes')}>Vehicle Types</button>
            <button type="button" onClick={() => setTab('locations')}>Locations</button>
            <button type="button" onClick={() => setTab('rates')}>Rates</button>
            <button type="button" onClick={() => setTab('revenue')}>Revenue</button>
            <button type="button" onClick={() => setTab('carSharing')}>Car Sharing</button>
            <button type="button" onClick={() => setTab('selfService')}>Self-Service</button>
            <button type="button" onClick={() => setTab('services')}>Online Services</button>
            <button type="button" onClick={() => setTab('insurance')}>Insurance</button>
            <button type="button" onClick={() => setTab('payments')}>Payments</button>
            <button type="button" onClick={() => setTab('ai')}>AI Copilot</button>
            <button type="button" onClick={() => setTab('telematics')}>Telematics</button>
            <button type="button" onClick={() => setTab('access')}>Access Control</button>
            <button type="button" onClick={() => setTab('agreement')}>Agreement</button>
            <button type="button" onClick={() => setTab('franchises')}>Franchises</button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setTab('agreement')}>Agreement</button>
          <button onClick={() => { window.location.href = '/settings/agreement-clauses'; }}>Agreement Clauses</button>
          <button onClick={() => setTab('locations')}>Locations</button>
          <button onClick={() => setTab('fees')}>Fees</button>
          <button onClick={() => setTab('feeRates')}>Inspection Fees</button>
          <button onClick={() => setTab('loanerRates')}>Loaner Rates</button>
          <button onClick={() => setTab('stopSales')}>Stop Sales</button>
          <button onClick={() => setTab('rates')}>Rates</button>
          <button onClick={() => setTab('revenue')}>Revenue</button>
          <button onClick={() => setTab('carSharing')}>Car Sharing</button>
          <button onClick={() => setTab('selfService')}>Self-Service</button>
          <button onClick={() => setTab('vehicleTypes')}>Vehicle Types</button>
          <button onClick={() => setTab('insurance')}>Insurance</button>
          <button onClick={() => setTab('payments')}>Payments</button>
          <button onClick={() => setTab('ai')}>AI Copilot</button>
          <button onClick={() => setTab('telematics')}>Telematics</button>
          <button onClick={() => setTab('marketIntel')}>Market Intelligence</button>
          <button onClick={() => setTab('kioskUpsell')}>Kiosk Upsell</button>
          <button onClick={() => setTab('access')}>Access Control</button>
          <button onClick={() => setTab('emails')}>Emails</button>
          <button onClick={() => setTab('services')}>Additional Services</button>
          <button onClick={() => setTab('commissions')}>Commissions</button>
          <button onClick={() => setTab('franchises')}>Franchises</button>
          {isAdmin && <button onClick={() => setTab('integrations')}>Integraciones / Integrations</button>}
        </div>

        {tab === 'agreement' && (
          <div className="stack">
            <h2>Rental Agreement Settings</h2>
            <div className="grid2">
              <input placeholder="Company Name" value={cfg.companyName || ''} onChange={(e) => setCfg({ ...cfg, companyName: e.target.value })} />
              <input placeholder="Company Phone" value={cfg.companyPhone || ''} onChange={(e) => setCfg({ ...cfg, companyPhone: e.target.value })} />
            </div>
            <input placeholder="Company Address" value={cfg.companyAddress || ''} onChange={(e) => setCfg({ ...cfg, companyAddress: e.target.value })} />
            <input placeholder="Logo URL" value={cfg.companyLogoUrl || ''} onChange={(e) => setCfg({ ...cfg, companyLogoUrl: e.target.value })} />
            <input type="file" accept="image/*" onChange={(e) => uploadLogo(e.target.files?.[0])} />
            <div className="stack" style={{ marginTop: 6 }}>
              <label className="label">Email branding</label>
              <div className="hint" style={{ fontSize: 12, color: '#6b7a9a' }}>
                Accent color and support link used in customer emails. Leave the color blank to use the Ride default (#8752FE).
              </div>
              <div className="grid2">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="color" aria-label="Email brand color" value={cfg.emailBrandColor || '#8752FE'} onChange={(e) => setCfg({ ...cfg, emailBrandColor: e.target.value })} style={{ width: 48, height: 36, padding: 0 }} />
                  <input placeholder="#8752FE" value={cfg.emailBrandColor || ''} onChange={(e) => setCfg({ ...cfg, emailBrandColor: e.target.value })} />
                </div>
                <input placeholder="Support URL (https://...)" value={cfg.emailSupportUrl || ''} onChange={(e) => setCfg({ ...cfg, emailSupportUrl: e.target.value })} />
              </div>
            </div>
            <div className="stack" style={{ marginTop: 6 }}>
              <label className="label">Send customer email from your own domain</label>
              <div className="hint" style={{ fontSize: 12, color: '#6b7a9a' }}>
                Every email to your customers goes out from this address instead of @ridefleetmanager.com. <strong>Set this only after we verify your domain</strong> (SPF + DKIM) — ask us first. Leave blank to send from the platform address.
              </div>
              <input
                placeholder="reservas@tudominio.com"
                value={cfg.emailFromAddress || ''}
                onChange={(e) => setCfg({ ...cfg, emailFromAddress: e.target.value.trim() })}
              />
            </div>
            <div className="stack" style={{ marginTop: 6 }}>
              <label className="label">Affidavit owner (transfer-of-liability)</label>
              <div className="hint" style={{ fontSize: 12, color: '#6b7a9a' }}>
                The registered legal entity that submits citation affidavits — may differ from the rental brand above. Leave blank to use the company name / address / phone above.
              </div>
              <input placeholder="Affidavit owner legal name (e.g., ZEZGO ORLANDO LLC)" value={cfg.affidavitOwnerName || ''} onChange={(e) => setCfg({ ...cfg, affidavitOwnerName: e.target.value })} />
              <input placeholder="Affidavit owner address" value={cfg.affidavitOwnerAddress || ''} onChange={(e) => setCfg({ ...cfg, affidavitOwnerAddress: e.target.value })} />
              <input placeholder="Affidavit owner phone" value={cfg.affidavitOwnerPhone || ''} onChange={(e) => setCfg({ ...cfg, affidavitOwnerPhone: e.target.value })} />
            </div>
            <textarea rows={6} placeholder="Terms and Conditions" value={cfg.termsText || ''} onChange={(e) => setCfg({ ...cfg, termsText: e.target.value })} />
            <div className="stack">
              <label className="label">Terms &amp; Conditions HTML</label>
              <textarea
                rows={20}
                style={{ width: '100%' }}
                placeholder={'<!-- Your custom T&C HTML here. Leave empty to use the canonical RideFleet T&C. -->'}
                value={cfg.termsHtml || ''}
                onChange={(e) => setCfg({ ...cfg, termsHtml: e.target.value })}
              />
              <div className="hint" style={{ fontSize: 12, color: '#6b7a9a' }}>
                Custom T&amp;C text for this tenant. If left empty, the system uses the canonical RideFleet T&amp;C. Plain HTML or text. Use {'{{INITIALS_S4_DECLINE}}'}, {'{{INITIALS_S11_CARD_ON_FILE}}'}, {'{{INITIALS_S11_CNP}}'}, {'{{INITIALS_S11_NO_CHARGEBACK}}'}, {'{{INITIALS_S13_POST_RENTAL}}'} as initial-line placeholders.
              </div>
            </div>
            <textarea rows={4} placeholder="Return Instructions" value={cfg.returnInstructionsText || ''} onChange={(e) => setCfg({ ...cfg, returnInstructionsText: e.target.value })} />
            <div className="stack">
              <label className="label">Agreement HTML Template (Global)</label>
              <textarea
                rows={14}
                placeholder={`Use placeholders like: {{companyName}}, {{agreementNumber}}, {{reservationNumber}}, {{customerName}}, {{pickupAt}}, {{returnAt}}, {{taxConfig}}, {{total}}, {{amountPaid}}, {{amountDue}}, {{chargesRows}}, {{paymentsRows}}, {{termsText}}, {{signatureSignedBy}}, {{signatureDateTime}}, {{signatureIp}}, {{signatureDataUrl}}`}
                value={cfg.agreementHtmlTemplate || ''}
                onChange={(e) => setCfg({ ...cfg, agreementHtmlTemplate: e.target.value })}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={saveAgreement}>Save Settings</button>
              <button onClick={previewAgreementTemplate}>Preview Template</button>
              <button onClick={() => setCfg(DEFAULTS)}>Reset Form</button>
            </div>

            <div className="glass card" style={{ padding: 12 }}>
              <h3 style={{ marginBottom: 8 }}>Reservation Options</h3>
              <div className="form-grid-2" style={{ marginBottom: 12 }}>
                <div className="stack">
                  <label className="label">Tenant Time Zone</label>
                  <select
                    value={reservationOptions.tenantTimeZone || 'America/Puerto_Rico'}
                    onChange={(e) => setReservationOptions({ ...reservationOptions, tenantTimeZone: e.target.value })}
                  >
                    {TENANT_TIMEZONE_OPTIONS.map((zone) => (
                      <option key={zone} value={zone}>{zone}</option>
                    ))}
                  </select>
                </div>
                <div className="surface-note">
                  This tenant-wide time zone applies across the reservation dashboard and all locations under this tenant so pickup and return times display consistently for staff.
                </div>
              </div>
              <label className="label" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={!!reservationOptions.autoAssignVehicleFromType}
                  onChange={(e) => setReservationOptions({ ...reservationOptions, autoAssignVehicleFromType: e.target.checked })}
                />
                Auto-assign vehicle on reservation create (from available vehicles in selected vehicle type)
              </label>
              <label className="label" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13, marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={!!reservationOptions.requireFranchiseSelection}
                  onChange={(e) => setReservationOptions({ ...reservationOptions, requireFranchiseSelection: e.target.checked })}
                />
                Require franchise selection before check-out (agent must assign a franchise to complete checkout)
              </label>
              <div style={{ marginTop: 10 }}>
                <button onClick={saveReservationOptions}>Save Reservation Options</button>
              </div>
            </div>

            <div className="glass card" style={{ padding: 12 }}>
              <h3 style={{ marginBottom: 8 }}>Customer-led Inspection</h3>
              <div className="form-grid-2">
                <label className="label" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={customerInspectionEnabled}
                    onChange={async (e) => {
                      const enabled = e.target.checked;
                      setCustomerInspectionEnabled(enabled);
                      try {
                        await api(scopedSettingsPath('/api/settings/customer-inspection'), { method: 'PUT', body: JSON.stringify({ enabled, checkinModel: customerInspectionCheckinModel }) }, token);
                        setMsg(`Customer-led inspection ${enabled ? 'enabled' : 'disabled'}`);
                      } catch (err) {
                        setMsg(err?.message || 'Failed to save customer inspection setting');
                      }
                    }}
                  />
                  Let customers do the checkout inspection from their phone
                </label>
                <div className="surface-note">
                  Checkout step 4 gains a &quot;Send inspection link to customer&quot; option (24h link,
                  disclosures included; the QR agent flow stays as fail-safe). Customer damage
                  reports land in the review queue for soft/hard approval.
                </div>
              </div>
              {customerInspectionEnabled ? (
                <div className="form-grid-2" style={{ marginTop: 10 }}>
                  <div className="stack">
                    <label className="label">Check-in (return) inspection model</label>
                    <select
                      value={customerInspectionCheckinModel}
                      onChange={async (e) => {
                        const checkinModel = e.target.value === 'CUSTOMER' ? 'CUSTOMER' : 'AGENT';
                        setCustomerInspectionCheckinModel(checkinModel);
                        try {
                          await api(scopedSettingsPath('/api/settings/customer-inspection'), { method: 'PUT', body: JSON.stringify({ enabled: customerInspectionEnabled, checkinModel }) }, token);
                          setMsg(`Check-in model: ${checkinModel === 'CUSTOMER' ? 'customer self-inspection' : 'agent inspection'}`);
                        } catch (err) {
                          setMsg(err?.message || 'Failed to save check-in model');
                        }
                      }}
                    >
                      <option value="AGENT">Agent inspection (agent inspects at return)</option>
                      <option value="CUSTOMER">Customer inspection (customer self-inspects; agent can skip)</option>
                    </select>
                  </div>
                  <div className="surface-note">
                    With <strong>Customer inspection</strong>, the customer gets a D-1 email and a printed
                    in-car QR to self-inspect at return; the agent&apos;s check-in can skip the inspection
                    step (agent can still view/add damage before closing). <strong>Agent inspection</strong>
                    keeps today&apos;s flow where the agent always inspects.
                  </div>
                </div>
              ) : null}
            </div>

            {/*
              Checkout payment policy (2026-08-26). Per-TENANT only — no
              per-location, no per-reservation override. Turning it OFF makes the
              wizard skip step 3 for this tenant; it does NOT remove any other
              way to take money (View Payments, manual sale/deposit, post-rental
              charges all stay exactly as they are).
            */}
            <div className="glass card" style={{ padding: 12 }}>
              <h3 style={{ marginBottom: 8 }}>Check-out Payment · Pago en el check-out</h3>
              <div className="form-grid-2">
                <label className="label" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={checkoutPaymentRequired}
                    disabled={checkoutPaymentSaving}
                    onChange={async (e) => {
                      const required = e.target.checked;
                      const previous = checkoutPaymentRequired;
                      setCheckoutPaymentRequired(required);
                      setCheckoutPaymentSaving(true);
                      try {
                        const out = await api(
                          scopedSettingsPath('/api/settings/checkout-payment'),
                          { method: 'PUT', body: JSON.stringify({ checkoutPaymentRequired: required }) },
                          token,
                        );
                        // Trust the server's answer, not the optimistic flip.
                        setCheckoutPaymentRequired(out?.checkoutPaymentRequired !== false);
                        setMsg(required
                          ? 'Payment is required during check-out · Se exige pago durante el check-out'
                          : 'Check-out will skip the payment step · El check-out omitirá el paso de pago');
                      } catch (err) {
                        // Roll back — leaving the switch showing a state the
                        // server rejected is how a tenant thinks payment is off
                        // when it is not.
                        setCheckoutPaymentRequired(previous);
                        setMsg(err?.message || 'Failed to save checkout payment setting');
                      } finally {
                        setCheckoutPaymentSaving(false);
                      }
                    }}
                  />
                  Require payment during check-out · Exigir pago durante el check-out
                </label>
                <div className="surface-note">
                  ON (default) keeps today&apos;s flow: the wizard stops at step 3 until the sale and
                  the deposit hold are taken. When OFF, the wizard skips the payment step for this
                  tenant — agents can still take payments afterwards from <strong>View Payments</strong>
                  {' '}(manual sale, deposit, refunds are all unchanged).
                  <br />
                  ON (por defecto) mantiene el flujo actual: el wizard se detiene en el paso 3 hasta
                  cobrar la venta y el depósito. Cuando está OFF, el wizard omite el paso de pago para
                  este tenant — los agentes pueden cobrar después desde <strong>View Payments</strong>.
                </div>
              </div>
              {!checkoutPaymentRequired ? (
                <div className="surface-note" style={{ marginTop: 8 }}>
                  Applies to check-out sessions started from now on. Sessions already in progress keep
                  the payment step. · Aplica a los check-outs que empiecen desde ahora; los que ya
                  están en progreso conservan el paso de pago.
                </div>
              ) : null}
            </div>

            <div className="glass card" style={{ padding: 12 }}>
              <h3 style={{ marginBottom: 8 }}>Fleet Rotation Rule</h3>
              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">When is a vehicle "ready to rotate"?</label>
                  <select
                    value={fleetRotationRule}
                    onChange={async (e) => {
                      const rule = e.target.value;
                      setFleetRotationRule(rule);
                      try {
                        await api(scopedSettingsPath('/api/settings/fleet-rotation'), { method: 'PUT', body: JSON.stringify({ rule }) }, token);
                        setMsg('Fleet rotation rule saved');
                      } catch (err) {
                        setMsg(err?.message || 'Failed to save rotation rule');
                      }
                    }}
                  >
                    <option value="TIME">Time in fleet (vs target months per vehicle)</option>
                    <option value="MILEAGE">Mileage (vs target miles per vehicle)</option>
                  </select>
                </div>
                <div className="surface-note">
                  Drives the "Ready to Rotate" dashboard tile and the /vehicles?rotation=ready batch. Per-vehicle targets (months / miles) are set in each vehicle's Edit form.
                </div>
              </div>
            </div>

            {/*
              Idle-vehicle notification (2026-09-01, backlog #5). Per-tenant,
              OFF by default (ship inert, tenant opts in — shuttle-tracker
              precedent). The daily 09:20 UTC sweep emits one Notification
              Center envelope per vehicle per idle episode; new activity
              self-resolves it on the next sweep.
            */}
            <div className="glass card" style={{ padding: 12 }}>
              <h3 style={{ marginBottom: 8 }}>Idle Vehicle Alerts · Alertas de vehículo ocioso</h3>
              <div className="form-grid-2">
                <label className="label" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!idleVehicleCfg.enabled}
                    disabled={idleVehicleSaving}
                    onChange={async (e) => {
                      const enabled = e.target.checked;
                      const previous = idleVehicleCfg;
                      setIdleVehicleCfg({ ...idleVehicleCfg, enabled });
                      setIdleVehicleSaving(true);
                      try {
                        const out = await api(scopedSettingsPath('/api/settings/idle-vehicles'), { method: 'PUT', body: JSON.stringify({ enabled }) }, token);
                        if (out) setIdleVehicleCfg({ enabled: out.enabled === true, thresholdDays: Number(out.thresholdDays) >= 1 ? Number(out.thresholdDays) : 7 });
                        setMsg(enabled
                          ? 'Idle vehicle alerts enabled · Alertas de vehículo ocioso activadas'
                          : 'Idle vehicle alerts disabled · Alertas de vehículo ocioso desactivadas');
                      } catch (err) {
                        setIdleVehicleCfg(previous);
                        setMsg(err?.message || 'Failed to save idle vehicle setting');
                      } finally {
                        setIdleVehicleSaving(false);
                      }
                    }}
                  />
                  Notify when a vehicle sits without a rental · Avisar cuando un vehículo pasa días sin renta
                </label>
                <div className="surface-note">
                  Once a day, every <strong>available</strong> vehicle with no reservation activity for the
                  threshold below raises one notification (per idle stretch, not per day) in the Notification
                  Center. It self-resolves when the vehicle is rented or assigned again.
                  <br />
                  Una vez al día, cada vehículo <strong>disponible</strong> sin actividad de reservas por los
                  días del umbral genera una notificación (por episodio, no por día) en el centro de
                  notificaciones. Se resuelve sola cuando el vehículo vuelve a rentarse o asignarse.
                </div>
              </div>
              {idleVehicleCfg.enabled ? (
                <div className="form-grid-2" style={{ marginTop: 10 }}>
                  <div className="stack">
                    <label className="label">Days without activity · Días sin actividad</label>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={idleVehicleCfg.thresholdDays}
                      disabled={idleVehicleSaving}
                      onChange={(e) => setIdleVehicleCfg({ ...idleVehicleCfg, thresholdDays: e.target.value })}
                      onBlur={async () => {
                        const n = Math.floor(Number(idleVehicleCfg.thresholdDays));
                        if (!Number.isFinite(n) || n < 1) {
                          setIdleVehicleCfg({ ...idleVehicleCfg, thresholdDays: 7 });
                          return;
                        }
                        setIdleVehicleSaving(true);
                        try {
                          const out = await api(scopedSettingsPath('/api/settings/idle-vehicles'), { method: 'PUT', body: JSON.stringify({ thresholdDays: n }) }, token);
                          if (out) setIdleVehicleCfg({ enabled: out.enabled === true, thresholdDays: Number(out.thresholdDays) >= 1 ? Number(out.thresholdDays) : 7 });
                          setMsg('Idle threshold saved · Umbral guardado');
                        } catch (err) {
                          setMsg(err?.message || 'Failed to save idle threshold');
                        } finally {
                          setIdleVehicleSaving(false);
                        }
                      }}
                    />
                  </div>
                  <div className="surface-note">
                    Default 7 days. Vehicles in maintenance, on rent, booked ahead, shuttles and
                    car-sharing units are never counted as idle.
                    <br />
                    Por defecto 7 días. Vehículos en mantenimiento, rentados, con reserva próxima,
                    shuttles y unidades de car sharing nunca cuentan como ociosos.
                  </div>
                </div>
              ) : null}
            </div>

            <div className="glass card" style={{ padding: 12 }}>
              <h3 style={{ marginBottom: 8 }}>Citations OCR (AI)</h3>
              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">AI provider</label>
                  <select value={ocrCfg.provider} onChange={(e) => setOcrCfg((p) => ({ ...p, provider: e.target.value }))}>
                    <option value="anthropic">Anthropic (Claude)</option>
                  </select>
                  <label className="label">Model (optional)</label>
                  <input
                    placeholder="claude-haiku-4-5-20251001"
                    value={ocrCfg.model || ''}
                    onChange={(e) => setOcrCfg((p) => ({ ...p, model: e.target.value }))}
                  />
                  <label className="label">Min OCR confidence ({ocrCfg.confidenceMin ?? 70})</label>
                  <input
                    type="number" min="0" max="100"
                    placeholder="70"
                    value={ocrCfg.confidenceMin ?? 70}
                    onChange={(e) => setOcrCfg((p) => ({ ...p, confidenceMin: e.target.value }))}
                  />
                  <label className="label">API key {ocrCfg.hasKey ? '(saved — leave blank to keep)' : '(not set)'}</label>
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={ocrCfg.hasKey ? '•••••••••• (key on file)' : 'sk-ant-...'}
                    value={ocrKeyInput}
                    onChange={(e) => setOcrKeyInput(e.target.value)}
                  />
                  <div className="inline-actions" style={{ gap: 6 }}>
                    <button
                      type="button"
                      disabled={ocrSaving}
                      onClick={() => saveOcrConfig({
                        provider: ocrCfg.provider,
                        model: ocrCfg.model,
                        confidenceMin: ocrCfg.confidenceMin,
                        ...(ocrKeyInput.trim() ? { apiKey: ocrKeyInput.trim() } : {})
                      })}
                    >
                      {ocrSaving ? 'Saving...' : 'Save'}
                    </button>
                    {ocrCfg.hasKey ? (
                      <button type="button" className="button-subtle" disabled={ocrSaving} onClick={() => saveOcrConfig({ clearKey: true })}>Remove key</button>
                    ) : null}
                  </div>
                </div>
                <div className="surface-note">
                  Your AI key powers the OCR that reads mailed citation notices uploaded in Citations. Stored encrypted; used only to extract fields from your own notices. Leave the key field blank to keep the existing one.
                </div>
              </div>
            </div>

            {/* Agent Copilot AI fallback (2026-09-02, copilot Phase 2). OFF by
                default for every tenant: with the switch off (or no key) the
                copilot answers only from the curated intent map, exactly as
                Phase 1 shipped. */}
            <div className="glass card" style={{ padding: 12 }}>
              <h3 style={{ marginBottom: 8 }}>Agent Copilot AI fallback</h3>
              <div className="form-grid-2">
                <div className="stack">
                  <label className="switch-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={copilotAiCfg.enabled === true}
                      onChange={(e) => saveCopilotAiConfig({ enabled: e.target.checked })}
                      disabled={copilotAiSaving}
                    />
                    <span>Answer unmatched copilot questions with AI (from Ride University articles only)</span>
                  </label>
                  <label className="label">Model (optional)</label>
                  <input
                    placeholder="claude-haiku-4-5-20251001"
                    value={copilotAiCfg.model || ''}
                    onChange={(e) => setCopilotAiCfg((p) => ({ ...p, model: e.target.value }))}
                  />
                  <label className="label">Daily call cap (per tenant)</label>
                  <input
                    type="number" min="1"
                    placeholder="200"
                    value={copilotAiCfg.dailyCallCap ?? 200}
                    onChange={(e) => setCopilotAiCfg((p) => ({ ...p, dailyCallCap: e.target.value }))}
                  />
                  <label className="label">API key {copilotAiCfg.hasKey ? '(saved — leave blank to keep)' : '(not set)'}</label>
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={copilotAiCfg.hasKey ? '•••••••••• (key on file)' : 'sk-ant-...'}
                    value={copilotAiKeyInput}
                    onChange={(e) => setCopilotAiKeyInput(e.target.value)}
                  />
                  <div className="inline-actions" style={{ gap: 6 }}>
                    <button
                      type="button"
                      disabled={copilotAiSaving}
                      onClick={() => saveCopilotAiConfig({
                        model: copilotAiCfg.model,
                        dailyCallCap: copilotAiCfg.dailyCallCap,
                        ...(copilotAiKeyInput.trim() ? { apiKey: copilotAiKeyInput.trim() } : {})
                      })}
                    >
                      {copilotAiSaving ? 'Saving...' : 'Save'}
                    </button>
                    {copilotAiCfg.hasKey ? (
                      <button type="button" className="button-subtle" disabled={copilotAiSaving} onClick={() => saveCopilotAiConfig({ clearKey: true })}>Remove key</button>
                    ) : null}
                  </div>
                </div>
                <div className="surface-note">
                  When the copilot cannot answer from its curated map, it can ask AI — restricted to what the Ride University articles actually say, always cited, marked with an AI chip in the panel. Off by default; needs this switch AND a key. The daily cap bounds spend per tenant. The key is stored encrypted and never leaves the server.
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'payments' && (
          <div className="stack">
            <h2>Tenant Payment Gateway</h2>
            <div className="surface-note">
              Configure the online payment gateway for this tenant. Super admins can switch tenant scope above and keep separate merchant credentials for each tenant.
            </div>
            <div className="form-grid-2">
              <div className="stack">
                <label className="label">Primary Gateway</label>
                <select value={paymentGatewayConfig.gateway} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, gateway: e.target.value })}>
                  <option value="authorizenet">Authorize.Net</option>
                  <option value="stripe">Stripe</option>
                  <option value="square">Square</option>
                  <option value="spin">SPIn</option>
                  <option value="ipos">{t('settingsPayments.ipos.gatewayOption')}</option>
                </select>
              </div>
              <div className="stack">
                <label className="label">Gateway Label</label>
                <input value={paymentGatewayConfig.label || ''} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, label: e.target.value })} placeholder="Primary payment gateway" />
              </div>
            </div>

            <section className="glass card section-card">
              <h3 style={{ margin: '0 0 4px' }}>Post-check-in autocharge</h3>
              <div className="surface-note">
                When a vehicle is returned with an unpaid balance (gas, cleaning, late, etc.), choose whether the
                balance is charged automatically in the background or left for staff to collect in the reservation’s
                View Payments tab. Use Automatic for drop-and-go returns.
              </div>
              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Autocharge mode</label>
                  <select
                    value={paymentGatewayConfig.autocharge?.mode || 'AUTO'}
                    onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, autocharge: { ...(paymentGatewayConfig.autocharge || {}), mode: e.target.value } })}
                  >
                    <option value="AUTO">Automatic — charge in the background</option>
                    <option value="MANUAL">Manual — collect in View Payments</option>
                  </select>
                </div>
                {String(paymentGatewayConfig.autocharge?.mode || 'AUTO').toUpperCase() !== 'MANUAL' && (
                  <div className="stack">
                    <label className="label">Charge how long after check-in?</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="number" min="0" max="720" step="1" style={{ maxWidth: 120 }}
                        value={paymentGatewayConfig.autocharge?.delayHours ?? 24}
                        onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, autocharge: { ...(paymentGatewayConfig.autocharge || {}), delayHours: e.target.value === '' ? '' : Number(e.target.value) } })}
                      />
                      <span className="label" style={{ margin: 0 }}>hours after check-in</span>
                    </div>
                  </div>
                )}
              </div>
            </section>

            <section className="glass card section-card">
              <div className="row-between">
                <h3 style={{ margin: 0 }}>Authorize.Net</h3>
                <label className="label"><input type="checkbox" checked={!!paymentGatewayConfig.authorizenet?.enabled} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, authorizenet: { ...paymentGatewayConfig.authorizenet, enabled: e.target.checked } })} /> Enabled</label>
              </div>
              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Environment</label>
                  <select value={paymentGatewayConfig.authorizenet?.environment || 'sandbox'} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, authorizenet: { ...paymentGatewayConfig.authorizenet, environment: e.target.value } })}>
                    <option value="sandbox">Sandbox</option>
                    <option value="production">Production</option>
                  </select>
                </div>
                <div className="stack">
                  <label className="label">API Login ID</label>
                  <input value={paymentGatewayConfig.authorizenet?.loginId || ''} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, authorizenet: { ...paymentGatewayConfig.authorizenet, loginId: e.target.value } })} />
                </div>
              </div>
              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Transaction Key</label>
                  <input value={paymentGatewayConfig.authorizenet?.transactionKey || ''} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, authorizenet: { ...paymentGatewayConfig.authorizenet, transactionKey: e.target.value } })} />
                </div>
                  <div className="stack">
                    <label className="label">Client Key (Optional)</label>
                    <input value={paymentGatewayConfig.authorizenet?.clientKey || ''} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, authorizenet: { ...paymentGatewayConfig.authorizenet, clientKey: e.target.value } })} />
                  </div>
                </div>
                <div className="form-grid-2">
                  <div className="stack">
                    <label className="label">Signature Key</label>
                    <input value={paymentGatewayConfig.authorizenet?.signatureKey || ''} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, authorizenet: { ...paymentGatewayConfig.authorizenet, signatureKey: e.target.value } })} />
                  </div>
                  <div className="stack">
                    <label className="label">Webhook URL</label>
                    <input value={`${API_BASE}/api/public/payment-gateway/authorizenet/webhook`} readOnly />
                  </div>
                </div>
                <div className="surface-note">
                  Use the hosted Authorize.Net checkout for PCI scope reduction. To auto-confirm portal payments in Ride Fleet, add the webhook URL above in Authorize.Net and paste the webhook Signature Key here.
                </div>
              </section>

            <section className="glass card section-card">
              <div className="row-between">
                <h3 style={{ margin: 0 }}>Stripe</h3>
                <label className="label"><input type="checkbox" checked={!!paymentGatewayConfig.stripe?.enabled} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, stripe: { ...paymentGatewayConfig.stripe, enabled: e.target.checked } })} /> Enabled</label>
              </div>
              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Secret Key</label>
                  <input value={paymentGatewayConfig.stripe?.secretKey || ''} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, stripe: { ...paymentGatewayConfig.stripe, secretKey: e.target.value } })} />
                </div>
                <div className="stack">
                  <label className="label">Publishable Key</label>
                  <input value={paymentGatewayConfig.stripe?.publishableKey || ''} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, stripe: { ...paymentGatewayConfig.stripe, publishableKey: e.target.value } })} />
                </div>
              </div>
              <div className="stack">
                <label className="label">Webhook Secret</label>
                <input value={paymentGatewayConfig.stripe?.webhookSecret || ''} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, stripe: { ...paymentGatewayConfig.stripe, webhookSecret: e.target.value } })} />
              </div>
            </section>

            <section className="glass card section-card">
              <div className="row-between">
                <h3 style={{ margin: 0 }}>Square</h3>
                <label className="label"><input type="checkbox" checked={!!paymentGatewayConfig.square?.enabled} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, square: { ...paymentGatewayConfig.square, enabled: e.target.checked } })} /> Enabled</label>
              </div>
              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Environment</label>
                  <select value={paymentGatewayConfig.square?.environment || 'production'} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, square: { ...paymentGatewayConfig.square, environment: e.target.value } })}>
                    <option value="production">Production</option>
                    <option value="sandbox">Sandbox</option>
                  </select>
                </div>
                <div className="stack">
                  <label className="label">Application ID</label>
                  <input value={paymentGatewayConfig.square?.applicationId || ''} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, square: { ...paymentGatewayConfig.square, applicationId: e.target.value } })} />
                </div>
              </div>
              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Access Token</label>
                  <input value={paymentGatewayConfig.square?.accessToken || ''} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, square: { ...paymentGatewayConfig.square, accessToken: e.target.value } })} />
                </div>
                <div className="stack">
                  <label className="label">Location ID</label>
                  <input value={paymentGatewayConfig.square?.locationId || ''} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, square: { ...paymentGatewayConfig.square, locationId: e.target.value } })} />
                </div>
              </div>
            </section>

            <section className="glass card section-card">
              <div className="row-between">
                <h3 style={{ margin: 0 }}>SPIn Terminal</h3>
                <label className="label"><input type="checkbox" checked={!!paymentGatewayConfig.spin?.enabled} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, spin: { ...paymentGatewayConfig.spin, enabled: e.target.checked } })} /> Enabled</label>
              </div>
              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Environment</label>
                  <select value={paymentGatewayConfig.spin?.environment || 'sandbox'} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, spin: { ...paymentGatewayConfig.spin, environment: e.target.value } })}>
                    <option value="sandbox">Sandbox</option>
                    <option value="production">Production</option>
                  </select>
                </div>
                <div className="stack">
                  <label className="label">Auth Key</label>
                  <input
                    type="password"
                    autoComplete="off"
                    value={paymentGatewayConfig.spin?.authKey || ''}
                    onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, spin: { ...paymentGatewayConfig.spin, authKey: e.target.value } })}
                    placeholder={paymentGatewayConfig.spin?.hasAuthKey ? 'Saved — leave blank to keep' : 'Paste the Auth Key from your iPOS merchant portal'}
                  />
                </div>
              </div>
              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">TPN (Terminal Profile Number)</label>
                  <input value={paymentGatewayConfig.spin?.tpn || ''} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, spin: { ...paymentGatewayConfig.spin, tpn: e.target.value } })} />
                </div>
                <div className="stack">
                  <label className="label">Merchant Number</label>
                  <input value={paymentGatewayConfig.spin?.merchantNumber || '1'} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, spin: { ...paymentGatewayConfig.spin, merchantNumber: e.target.value } })} />
                </div>
              </div>
              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Callback URL</label>
                  <input value={paymentGatewayConfig.spin?.callbackUrl || ''} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, spin: { ...paymentGatewayConfig.spin, callbackUrl: e.target.value } })} placeholder="https://yoursite.com/api/public/payment-gateway/spin/callback" />
                </div>
                <div className="stack">
                  <label className="label">Proxy Timeout (seconds)</label>
                  <input type="number" value={paymentGatewayConfig.spin?.proxyTimeout || '120'} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, spin: { ...paymentGatewayConfig.spin, proxyTimeout: e.target.value } })} />
                </div>
              </div>
              <div className="surface-note">
                SPIn is a card-present terminal gateway for in-person payments. Configure the Auth Key and TPN from your SPIn merchant portal.
                These credentials are <strong>per tenant</strong>: checkout charges settle into the merchant account behind the TPN saved here.
                The Auth Key is encrypted at rest and never shown again — leave it blank to keep the saved one.
                Auth Key <strong>and</strong> TPN must BOTH be set; a half-filled pair is refused at the counter rather than paired with another terminal.
              </div>
            </section>

            <section className="glass card section-card">
              <div className="row-between">
                <h3 style={{ margin: 0 }}>{t('settingsPayments.ipos.title')}</h3>
                <label className="label"><input type="checkbox" checked={!!paymentGatewayConfig.ipos?.enabled} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, ipos: { ...paymentGatewayConfig.ipos, enabled: e.target.checked } })} /> {t('settingsPayments.ipos.enabled')}</label>
              </div>
              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">{t('settingsPayments.ipos.environment')}</label>
                  <select value={paymentGatewayConfig.ipos?.environment || 'production'} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, ipos: { ...paymentGatewayConfig.ipos, environment: e.target.value } })}>
                    <option value="sandbox">{t('settingsPayments.ipos.envSandbox')}</option>
                    <option value="production">{t('settingsPayments.ipos.envProduction')}</option>
                  </select>
                </div>
                <div className="stack">
                  <label className="label">{t('settingsPayments.ipos.hppToken')}</label>
                  <input
                    type="password"
                    autoComplete="off"
                    value={paymentGatewayConfig.ipos?.hppToken || ''}
                    onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, ipos: { ...paymentGatewayConfig.ipos, hppToken: e.target.value } })}
                    placeholder={paymentGatewayConfig.ipos?.hasHppToken ? t('settingsPayments.ipos.tokenSavedPlaceholder') : t('settingsPayments.ipos.tokenEmptyPlaceholder')}
                  />
                </div>
                <div className="stack">
                  <label className="label">{t('settingsPayments.ipos.apiKey')}</label>
                  <input
                    type="password"
                    autoComplete="off"
                    value={paymentGatewayConfig.ipos?.apiKey || ''}
                    onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, ipos: { ...paymentGatewayConfig.ipos, apiKey: e.target.value } })}
                    placeholder={paymentGatewayConfig.ipos?.hasApiKey ? t('settingsPayments.ipos.tokenSavedPlaceholder') : t('settingsPayments.ipos.apiKeyEmptyPlaceholder')}
                  />
                  <span className="hint">{t('settingsPayments.ipos.apiKeyHint')}</span>
                </div>
                <div className="stack">
                  <label className="label">{t('settingsPayments.ipos.secretKey')}</label>
                  <input
                    type="password"
                    autoComplete="off"
                    value={paymentGatewayConfig.ipos?.secretKey || ''}
                    onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, ipos: { ...paymentGatewayConfig.ipos, secretKey: e.target.value } })}
                    placeholder={paymentGatewayConfig.ipos?.hasSecretKey ? t('settingsPayments.ipos.tokenSavedPlaceholder') : t('settingsPayments.ipos.secretKeyEmptyPlaceholder')}
                  />
                  <span className="hint">{t('settingsPayments.ipos.secretKeyHint')}</span>
                </div>
              </div>
              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">{t('settingsPayments.ipos.tpn')}</label>
                  <input
                    value={paymentGatewayConfig.ipos?.tpn || ''}
                    onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, ipos: { ...paymentGatewayConfig.ipos, tpn: e.target.value } })}
                    placeholder={paymentGatewayConfig.spin?.tpn ? t('settingsPayments.ipos.tpnFallbackPlaceholder', { tpn: paymentGatewayConfig.spin.tpn }) : t('settingsPayments.ipos.tpnEmptyPlaceholder')}
                  />
                </div>
                <div className="stack">
                  <label className="label">{t('settingsPayments.ipos.expiryDays')}</label>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={paymentGatewayConfig.ipos?.expiryDays ?? 3}
                    onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, ipos: { ...paymentGatewayConfig.ipos, expiryDays: e.target.value } })}
                  />
                </div>
              </div>
              <div className="surface-note">
                {t('settingsPayments.ipos.note1')}{' '}
                <strong>{t('settingsPayments.ipos.note2')}</strong>{' '}
                {t('settingsPayments.ipos.note3')}
              </div>
            </section>

            <div className="inline-actions">
              <button type="button" onClick={savePaymentGatewayConfig}>Save Payment Gateway</button>
              <button type="button" className="button-subtle" onClick={runPaymentGatewayHealthCheck}>Run Health Check</button>
            </div>
            {paymentGatewayHealth ? (
              <div className="surface-note">
                <strong>{paymentGatewayHealth.summary}</strong>
                <div style={{ marginTop: 8 }}>
                  Active gateway: <strong>{String(paymentGatewayHealth.gateway || '-').toUpperCase()}</strong>
                </div>
                {paymentGatewayHealth.checks?.[paymentGatewayHealth.gateway]?.missing?.length ? (
                  <div style={{ marginTop: 8 }}>
                    Missing: {paymentGatewayHealth.checks[paymentGatewayHealth.gateway].missing.join(', ')}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {tab === 'ai' && (
          <div className="stack">
            <h2>Planner Copilot</h2>
            <div className="surface-note">
              Turn Planner Copilot on per tenant, choose the model, and decide whether this tenant should use its own OpenAI key or fall back to the platform key when available.
            </div>
            <section className="glass card section-card">
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="stack" style={{ gap: 6 }}>
                  <h3 style={{ margin: 0 }}>Tenant AI Access</h3>
                  <div className="ui-muted">
                    When enabled, agents using the Planner can ask for AI dispatch guidance on the visible range.
                  </div>
                </div>
                <span className={`status-chip ${plannerCopilotConfig.ready ? 'good' : plannerCopilotConfig.enabled ? 'warn' : 'neutral'}`}>
                  {plannerCopilotConfig.ready ? 'Ready' : plannerCopilotConfig.enabled ? 'Needs Credential' : 'Disabled'}
                </span>
              </div>

              <div className="form-grid-2">
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!plannerCopilotConfig.enabled}
                    onChange={(e) => setPlannerCopilotConfig((current) => ({ ...current, enabled: e.target.checked }))}
                  /> Enable Planner Copilot for this tenant
                </label>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!plannerCopilotConfig.allowGlobalApiKeyFallback}
                    onChange={(e) => setPlannerCopilotConfig((current) => ({ ...current, allowGlobalApiKeyFallback: e.target.checked }))}
                  /> Allow platform fallback key when tenant key is blank
                </label>
              </div>

              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Provider</label>
                  <input value="OpenAI" readOnly />
                </div>
                <div className="stack">
                  <label className="label">Model</label>
                  <input
                    value={plannerCopilotConfig.model || ''}
                    onChange={(e) => setPlannerCopilotConfig((current) => ({ ...current, model: e.target.value }))}
                    placeholder="gpt-4.1-mini"
                  />
                </div>
              </div>

              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Monthly Query Cap</label>
                  <input
                    type="number"
                    min="1"
                    value={plannerCopilotConfig.monthlyQueryCap}
                    onChange={(e) => setPlannerCopilotConfig((current) => ({ ...current, monthlyQueryCap: e.target.value }))}
                    placeholder="Leave blank for no cap"
                  />
                </div>
                <div className="stack">
                  <label className="label">Allowed Models</label>
                  <input
                    value={Array.isArray(plannerCopilotConfig.allowedModels) ? plannerCopilotConfig.allowedModels.join(', ') : ''}
                    onChange={(e) => setPlannerCopilotConfig((current) => ({
                      ...current,
                      allowedModels: e.target.value.split(',').map((item) => item.trim()).filter(Boolean)
                    }))}
                    placeholder="gpt-4.1-mini, gpt-4.1"
                  />
                </div>
              </div>

              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Allowed Paid Plans</label>
                  <input
                    value={Array.isArray(plannerCopilotConfig.allowedPlans) ? plannerCopilotConfig.allowedPlans.join(', ') : ''}
                    onChange={(e) => setPlannerCopilotConfig((current) => ({
                      ...current,
                      allowedPlans: e.target.value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean)
                    }))}
                    placeholder="PRO, ENTERPRISE"
                  />
                </div>
              </div>

              <div className="form-grid-2">
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!plannerCopilotConfig.aiOnlyForPaidPlan}
                    onChange={(e) => setPlannerCopilotConfig((current) => ({ ...current, aiOnlyForPaidPlan: e.target.checked }))}
                  /> Restrict AI responses to paid plans only
                </label>
                <div className="surface-note">
                  Tenant plan: <strong>{plannerCopilotConfig.tenantPlan || 'BETA'}</strong>
                  <div style={{ marginTop: 8 }}>
                    Plan eligibility: <strong>{plannerCopilotConfig.planEligible ? 'Eligible for AI' : 'Not eligible for AI under current policy'}</strong>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    Model eligibility: <strong>{plannerCopilotConfig.modelAllowed ? 'Configured model allowed' : 'Configured model blocked by package policy'}</strong>
                  </div>
                </div>
              </div>

              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Tenant OpenAI API Key</label>
                  <input
                    type="password"
                    value={plannerCopilotConfig.apiKey || ''}
                    onChange={(e) => setPlannerCopilotConfig((current) => ({ ...current, apiKey: e.target.value, clearTenantApiKey: false }))}
                    placeholder={plannerCopilotConfig.hasTenantApiKey ? 'Leave blank to keep existing key' : 'sk-...'}
                  />
                </div>
                <div className="surface-note">
                  Credential source: <strong>{plannerCopilotConfig.credentialSource}</strong>
                  <div style={{ marginTop: 8 }}>
                    Stored tenant key: <strong>{plannerCopilotConfig.hasTenantApiKey ? (plannerCopilotConfig.apiKeyMasked || 'Configured') : 'Not set'}</strong>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    Runtime status: <strong>{plannerCopilotConfig.ready ? 'AI ready for this tenant' : plannerCopilotConfig.enabled ? 'Enabled but not ready yet' : 'Feature disabled'}</strong>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    Current month usage: <strong>{Number(plannerCopilotUsage?.currentPeriod?.totalQueries || 0)}</strong>
                    {plannerCopilotConfig.monthlyQueryCap ? ` / ${plannerCopilotConfig.monthlyQueryCap}` : ' / uncapped'}
                  </div>
                </div>
              </div>

              <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={!!plannerCopilotConfig.clearTenantApiKey}
                  onChange={(e) => setPlannerCopilotConfig((current) => ({
                    ...current,
                    clearTenantApiKey: e.target.checked,
                    apiKey: e.target.checked ? '' : current.apiKey
                  }))}
                /> Clear stored tenant API key on save
              </label>

              <div className="inline-actions">
                <button type="button" onClick={savePlannerCopilotConfig}>Save Planner Copilot</button>
                <button
                  type="button"
                  className="button-subtle"
                  onClick={() => setPlannerCopilotConfig((current) => ({
                    ...current,
                    enabled: !!current?.planDefaults?.plannerCopilotIncluded,
                    model: current?.planDefaults?.allowedModels?.[0] || current.model,
                    allowedModels: Array.isArray(current?.planDefaults?.allowedModels) ? current.planDefaults.allowedModels : current.allowedModels,
                    monthlyQueryCap: current?.planDefaults?.monthlyQueryCap == null ? '' : String(current.planDefaults.monthlyQueryCap)
                  }))}
                >
                  Apply Plan Defaults
                </button>
              </div>
            </section>

            <section className="glass card section-card">
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="stack" style={{ gap: 6 }}>
                  <h3 style={{ margin: 0 }}>Commercial Package Snapshot</h3>
                  <div className="ui-muted">
                    This shows what the current tenant plan includes by default for Smart Planner intelligence.
                  </div>
                </div>
                <span className="status-chip neutral">{plannerCopilotConfig.tenantPlan || 'BETA'}</span>
              </div>
              <div className="app-card-grid compact">
                <div className="info-tile">
                  <span className="label">Smart Planner</span>
                  <strong>{plannerCopilotConfig.planDefaults?.smartPlannerIncluded ? 'Included' : 'Not included'}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">Planner Copilot</span>
                  <strong>{plannerCopilotConfig.planDefaults?.plannerCopilotIncluded ? 'Included' : 'Not included'}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">Telematics</span>
                  <strong>{plannerCopilotConfig.planDefaults?.telematicsIncluded ? 'Included' : 'Not included'}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">Inspection Intelligence</span>
                  <strong>{plannerCopilotConfig.planDefaults?.inspectionIntelligenceIncluded ? 'Included' : 'Not included'}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">Default Monthly Cap</span>
                  <strong>{plannerCopilotConfig.planDefaults?.monthlyQueryCap == null ? 'Unlimited' : plannerCopilotConfig.planDefaults.monthlyQueryCap}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">Default Models</span>
                  <strong>{Array.isArray(plannerCopilotConfig.planDefaults?.allowedModels) && plannerCopilotConfig.planDefaults.allowedModels.length ? plannerCopilotConfig.planDefaults.allowedModels.join(', ') : '—'}</strong>
                </div>
              </div>
            </section>

            <section className="glass card section-card">
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="stack" style={{ gap: 6 }}>
                  <h3 style={{ margin: 0 }}>Usage Audit</h3>
                  <div className="ui-muted">
                    Track tenant adoption, model usage, and whether responses came back in AI or heuristic mode.
                  </div>
                </div>
                <span className="status-chip neutral">{Number(plannerCopilotUsage?.summary?.totalQueries || 0)} total queries</span>
              </div>

              <div className="app-card-grid compact">
                <div className="info-tile">
                  <span className="label">Current Period</span>
                  <strong>{plannerCopilotUsage?.currentPeriod?.period || '—'}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">Current Month Queries</span>
                  <strong>{Number(plannerCopilotUsage?.currentPeriod?.totalQueries || 0)}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">AI Responses</span>
                  <strong>{Number(plannerCopilotUsage?.summary?.aiResponses || 0)}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">Heuristic Responses</span>
                  <strong>{Number(plannerCopilotUsage?.summary?.heuristicResponses || 0)}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">Last Used</span>
                  <strong>{plannerCopilotUsage?.summary?.lastUsedAt ? new Date(plannerCopilotUsage.summary.lastUsedAt).toLocaleString() : '—'}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">Last Mode</span>
                  <strong>{plannerCopilotUsage?.summary?.lastMode || '—'}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">Last Model</span>
                  <strong>{plannerCopilotUsage?.summary?.lastModel || '—'}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">Last User</span>
                  <strong>{plannerCopilotUsage?.summary?.lastActorName || plannerCopilotUsage?.summary?.lastActorEmail || '—'}</strong>
                </div>
              </div>

              <div className="surface-note">
                Models used:
                {' '}
                {Object.keys(plannerCopilotUsage?.summary?.modelCounts || {}).length
                  ? Object.entries(plannerCopilotUsage.summary.modelCounts).map(([model, count]) => `${model} (${count})`).join(', ')
                  : 'No model usage recorded yet.'}
              </div>

              <div className="surface-note">
                Current period model usage:
                {' '}
                {Object.keys(plannerCopilotUsage?.currentPeriod?.modelCounts || {}).length
                  ? Object.entries(plannerCopilotUsage.currentPeriod.modelCounts).map(([model, count]) => `${model} (${count})`).join(', ')
                  : 'No current-period model usage yet.'}
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Total</th>
                      <th>AI</th>
                      <th>Heuristic</th>
                      <th>Models</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(plannerCopilotUsage?.periods || []).length ? plannerCopilotUsage.periods.map((row) => (
                      <tr key={row.period}>
                        <td>{row.period}</td>
                        <td>{Number(row.totalQueries || 0)}</td>
                        <td>{Number(row.aiResponses || 0)}</td>
                        <td>{Number(row.heuristicResponses || 0)}</td>
                        <td>
                          {Object.keys(row?.modelCounts || {}).length
                            ? Object.entries(row.modelCounts).map(([model, count]) => `${model} (${count})`).join(', ')
                            : '—'}
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={5} className="ui-muted">No period metrics recorded yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>User</th>
                      <th>Mode</th>
                      <th>Model</th>
                      <th>Risk</th>
                      <th>Question</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(plannerCopilotUsage?.recent || []).length ? plannerCopilotUsage.recent.map((row, index) => (
                      <tr key={`${row.createdAt || 'row'}-${index}`}>
                        <td>{row?.createdAt ? new Date(row.createdAt).toLocaleString() : '—'}</td>
                        <td>{row?.actorName || row?.actorEmail || 'Unknown'}</td>
                        <td>{row?.mode || '—'}</td>
                        <td>{row?.model || '—'}</td>
                        <td>{row?.riskLevel || '—'}</td>
                        <td>{row?.questionPreview || '—'}</td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={6} className="ui-muted">No Planner Copilot usage recorded yet for this tenant.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {tab === 'access' && (
          <div className="stack">
            <h2>Tenant Module Access</h2>
            <div className="surface-note">
              Control which workspace modules are enabled for this tenant. User-level permissions can only narrow access further. Car Sharing and Loaner still depend on their tenant feature flags too.
            </div>
            {MODULE_DEFINITIONS.filter((item) => item.description && item.key !== 'tenants').map((item) => (
              <div className="surface-note" key={`${item.key}-desc`}>
                <strong>{item.label}</strong> — {item.description}
                {item.keepsNote ? <> {item.keepsNote}</> : null}
                {item.tenantNote ? <> {item.tenantNote}</> : null}
              </div>
            ))}
            <div className="service-checks-grid">
              {MODULE_DEFINITIONS.filter((item) => item.key !== 'tenants').map((item) => (
                <label key={item.key} className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  <input
                    type="checkbox"
                    checked={tenantModuleAccess[item.key] !== false}
                    onChange={(e) => setTenantModuleAccess((current) => ({ ...current, [item.key]: e.target.checked }))}
                  /> {item.label}
                </label>
              ))}
            </div>
            <div className="inline-actions">
              <button
                type="button"
                onClick={async () => {
                  const out = await api(scopedSettingsPath('/api/settings/tenant-modules'), {
                    method: 'PUT',
                    body: JSON.stringify(tenantModuleAccess)
                  }, token);
                  setTenantModuleAccess(out?.config || {});
                  setMsg('Tenant module access saved');
                }}
              >
                Save Tenant Module Access
              </button>
            </div>
            <hr style={{ opacity: 0.15, width: '100%' }} />
            <TwoFactorPolicySettings token={token} scopedPath={scopedSettingsPath} />
          </div>
        )}

        {tab === 'locations' && (
          <div className="stack">
            <h2>Locations</h2>
            <form className="stack" onSubmit={addLocation}>
              <div className="grid2">
                <input required placeholder="Code" value={locationForm.code} onChange={(e) => setLocationForm({ ...locationForm, code: e.target.value })} />
                <input required placeholder="Name" value={locationForm.name} onChange={(e) => setLocationForm({ ...locationForm, name: e.target.value })} />
              </div>
              <input placeholder="Address" value={locationForm.address} onChange={(e) => setLocationForm({ ...locationForm, address: e.target.value })} />
              <div className="grid2">
                <input placeholder="City" value={locationForm.city} onChange={(e) => setLocationForm({ ...locationForm, city: e.target.value })} />
                <input placeholder="State" value={locationForm.state} onChange={(e) => setLocationForm({ ...locationForm, state: e.target.value })} />
              </div>
              <button type="submit">Add Location</button>
            </form>

            <table>
              <thead><tr><th>Code</th><th>Name</th><th>City</th><th>Tax %</th><th>Fees</th><th>Active</th><th>Actions</th></tr></thead>
              <tbody>
                {locations.map((l) => (
                  <tr key={l.id}>
                    <td>{l.code}</td>
                    <td>{l.name}</td>
                    <td>{l.city || '-'}</td>
                    <td>{Number(l.taxRate || 0).toFixed(2)}%</td>
                    <td>{(l.locationFees || []).map((lf) => lf.fee?.name).filter(Boolean).join(', ') || '-'}</td>
                    <td>{l.isActive ? 'Yes' : 'No'}</td>
                    <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button onClick={() => editLocation(l)}>Location Settings</button>
                      <button onClick={() => copyLocationSettings(l)}>Copy Settings</button>
                      <button onClick={() => patchLocation(l.id, { isActive: !l.isActive })}>{l.isActive ? 'Disable' : 'Enable'}</button>
                      <button onClick={() => removeLocation(l.id)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Business documents (2026-07-28): the paperwork a branch needs to
                trade — permits, registrations, insurance. Filed per location
                with a validity date; the dashboard warns 30 days out. */}
            <LocationDocumentsPanel token={token} locations={locations} />
          </div>
        )}

        {tab === 'fees' && (
          <div className="stack">
            <h2>Fees</h2>
            <form className="stack" onSubmit={addFee}>
              <div className="grid2">
                <input placeholder="Code" value={feeForm.code} onChange={(e) => setFeeForm({ ...feeForm, code: e.target.value })} />
                <input required placeholder="Fee Name" value={feeForm.name} onChange={(e) => setFeeForm({ ...feeForm, name: e.target.value })} />
              </div>
              <textarea rows={2} placeholder="Description" value={feeForm.description} onChange={(e) => setFeeForm({ ...feeForm, description: e.target.value })} />
              <div className="grid2">
                <select value={feeForm.mode} onChange={(e) => setFeeForm({ ...feeForm, mode: e.target.value })}>
                  <option value="FIXED">Fixed Charge</option>
                  <option value="PER_DAY">Per Day</option>
                  <option value="PERCENTAGE">Percentage</option>
                </select>
                <input placeholder="Amount" value={feeForm.amount} onChange={(e) => setFeeForm({ ...feeForm, amount: e.target.value })} />
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <label className="label"><input type="checkbox" checked={feeForm.taxable} onChange={(e) => setFeeForm({ ...feeForm, taxable: e.target.checked })} /> Taxable</label>
                <label className="label"><input type="checkbox" checked={feeForm.isActive} onChange={(e) => setFeeForm({ ...feeForm, isActive: e.target.checked })} /> Active</label>
                <label className="label"><input type="checkbox" checked={!!feeForm.mandatory} onChange={(e) => setFeeForm({ ...feeForm, mandatory: e.target.checked })} /> Mandatory</label>
                <label className="label"><input type="checkbox" checked={!!feeForm.isUnderageFee} onChange={(e) => setFeeForm({ ...feeForm, isUnderageFee: e.target.checked })} /> Underage Fee</label>
                <label className="label"><input type="checkbox" checked={!!feeForm.isAdditionalDriverFee} onChange={(e) => setFeeForm({ ...feeForm, isAdditionalDriverFee: e.target.checked })} /> Additional Driver Fee</label>
                <label className="label"><input type="checkbox" checked={!!feeForm.displayOnline} onChange={(e) => setFeeForm({ ...feeForm, displayOnline: e.target.checked })} /> Display Online</label>
              </div>
              <button type="submit">Add Fee</button>
            </form>

            <table>
              <thead><tr><th>Name</th><th>Mode</th><th>Amount</th><th>Mandatory</th><th>Underage Fee</th><th>Addl Driver Fee</th><th>Active</th><th>Display Online</th><th>Actions</th></tr></thead>
              <tbody>
                {fees.map((f) => (
                  <tr key={f.id}>
                    <td>{f.name}</td><td>{f.mode}</td><td>{Number(f.amount || 0).toFixed(2)}</td><td>{f.mandatory ? 'Yes' : 'No'}</td><td>{f.isUnderageFee ? 'Yes' : 'No'}</td><td>{f.isAdditionalDriverFee ? 'Yes' : 'No'}</td><td>{f.isActive ? 'Yes' : 'No'}</td><td>{f.displayOnline ? 'Yes' : 'No'}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => editFee(f)}>Edit</button>
                      <button onClick={async () => { await api(scopedSettingsPath(`/api/fees/${f.id}`), { method: 'PATCH', body: JSON.stringify({ mandatory: !f.mandatory }) }, token); setMsg('Mandatory fee flag updated'); await load(true); }}>{f.mandatory ? 'Unset Mandatory' : 'Set Mandatory'}</button>
                      <button onClick={async () => { await api(scopedSettingsPath(`/api/fees/${f.id}`), { method: 'PATCH', body: JSON.stringify({ isUnderageFee: !f.isUnderageFee }) }, token); setMsg('Underage fee flag updated'); await load(true); }}>{f.isUnderageFee ? 'Unset Underage' : 'Set Underage'}</button>
                      <button onClick={async () => { await api(scopedSettingsPath(`/api/fees/${f.id}`), { method: 'PATCH', body: JSON.stringify({ displayOnline: !f.displayOnline }) }, token); setMsg('Website display updated'); await load(true); }}>{f.displayOnline ? 'Hide from Website' : 'Show on Website'}</button>
                      <button onClick={() => toggleFee(f)}>{f.isActive ? 'Disable' : 'Enable'}</button>
                      <button onClick={() => removeFee(f.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'feeRates' && (
          <FeeRatesTab
            token={token}
            me={me}
            isSuper={isSuper}
            tenantName={isSuper ? (activeSettingsTenant?.name || 'Tenant') : (me?.tenant?.name || 'Current tenant')}
            scopedSettingsPath={scopedSettingsPath}
            activeSettingsTenantId={activeSettingsTenantId}
            locations={locations}
            onPageMsg={setMsg}
          />
        )}

        {tab === 'loanerRates' && (
          <LoanerRatesTab
            token={token}
            tenantName={isSuper ? (activeSettingsTenant?.name || 'Tenant') : (me?.tenant?.name || 'Current tenant')}
            scopedSettingsPath={scopedSettingsPath}
            onPageMsg={setMsg}
          />
        )}

        {tab === 'integrations' && (
          <div className="stack" style={{ gap: 20 }}>
            {/* Booking-source switcher (TL / Economy / NU) — mirrors the mockup */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className={activeIntegration === 'tl' ? '' : 'subtle'}
                onClick={() => setActiveIntegration('tl')}
              >
                TL International
              </button>
              <button
                type="button"
                className={activeIntegration === 'economy' ? '' : 'subtle'}
                onClick={() => setActiveIntegration('economy')}
              >
                Economy (RezLight)
              </button>
              <button
                type="button"
                className={activeIntegration === 'nu' ? '' : 'subtle'}
                onClick={() => setActiveIntegration('nu')}
              >
                NU Car Rentals
              </button>
              <button
                type="button"
                className={activeIntegration === 'flexways' ? '' : 'subtle'}
                onClick={() => setActiveIntegration('flexways')}
              >
                Flexways
              </button>
              <button
                type="button"
                className={activeIntegration === 'advantage' ? '' : 'subtle'}
                onClick={() => setActiveIntegration('advantage')}
              >
                Advantage (TSD)
              </button>
              <button
                type="button"
                className={activeIntegration === 'mex' ? '' : 'subtle'}
                onClick={() => setActiveIntegration('mex')}
              >
                MEX (TSD)
              </button>
            </div>

            {activeIntegration === 'tl' ? (
              <TLIntegrationPanel
                token={token}
                me={me}
                isSuper={isSuper}
                isAdmin={isAdmin}
                activeSettingsTenantId={activeSettingsTenantId}
                scopedSettingsPath={scopedSettingsPath}
                onPageMsg={setMsg}
              />
            ) : activeIntegration === 'economy' ? (
              <EconomyIntegrationPanel
                token={token}
                me={me}
                isSuper={isSuper}
                isAdmin={isAdmin}
                activeSettingsTenantId={activeSettingsTenantId}
                scopedSettingsPath={scopedSettingsPath}
                onPageMsg={setMsg}
              />
            ) : activeIntegration === 'nu' ? (
              <NuIntegrationPanel
                token={token}
                me={me}
                isSuper={isSuper}
                isAdmin={isAdmin}
                tenantName={isSuper ? (activeSettingsTenant?.name || 'Tenant') : (me?.tenant?.name || 'Current tenant')}
                activeSettingsTenantId={activeSettingsTenantId}
                scopedSettingsPath={scopedSettingsPath}
                onPageMsg={setMsg}
              />
            ) : activeIntegration === 'mex' ? (
              <MexIntegrationPanel
                token={token}
                me={me}
                isSuper={isSuper}
                isAdmin={isAdmin}
                tenantName={isSuper ? (activeSettingsTenant?.name || 'Tenant') : (me?.tenant?.name || 'Current tenant')}
                activeSettingsTenantId={activeSettingsTenantId}
                scopedSettingsPath={scopedSettingsPath}
                onPageMsg={setMsg}
              />
            ) : activeIntegration === 'advantage' ? (
              <AdvantageIntegrationPanel
                token={token}
                me={me}
                isSuper={isSuper}
                isAdmin={isAdmin}
                tenantName={isSuper ? (activeSettingsTenant?.name || 'Tenant') : (me?.tenant?.name || 'Current tenant')}
                activeSettingsTenantId={activeSettingsTenantId}
                scopedSettingsPath={scopedSettingsPath}
                onPageMsg={setMsg}
              />
            ) : (
              <FlexwaysIntegrationPanel
                token={token}
                me={me}
                isSuper={isSuper}
                isAdmin={isAdmin}
                tenantName={isSuper ? (activeSettingsTenant?.name || 'Tenant') : (me?.tenant?.name || 'Current tenant')}
                activeSettingsTenantId={activeSettingsTenantId}
                scopedSettingsPath={scopedSettingsPath}
                onPageMsg={setMsg}
              />
            )}
          </div>
        )}

        {tab === 'stopSales' && (
          <div className="stack">
            <h2>Stop Sales (Website)</h2>
            <p className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
              Block a vehicle class from appearing on the public booking website for a date range.
              Backoffice and manual reservations are not affected - staff can still book these vehicles.
            </p>
            <form className="stack" onSubmit={saveStopSale}>
              <div className="grid2">
                <select required value={stopSaleForm.vehicleTypeId} onChange={(e) => setStopSaleForm({ ...stopSaleForm, vehicleTypeId: e.target.value })}>
                  <option value="">Select a vehicle class...</option>
                  {vehicleTypes.map((vt) => (
                    <option key={vt.id} value={vt.id}>{vt.name} ({vt.code})</option>
                  ))}
                </select>
                <input placeholder="Reason (e.g. Maintenance, Internal Use, Event)" value={stopSaleForm.reason} onChange={(e) => setStopSaleForm({ ...stopSaleForm, reason: e.target.value })} />
              </div>
              <div className="grid2">
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  Start Date &amp; Time
                  <input required type="datetime-local" value={stopSaleForm.startDate} onChange={(e) => setStopSaleForm({ ...stopSaleForm, startDate: e.target.value })} />
                </label>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  End Date &amp; Time
                  <input required type="datetime-local" value={stopSaleForm.endDate} onChange={(e) => setStopSaleForm({ ...stopSaleForm, endDate: e.target.value })} />
                </label>
              </div>
              <textarea rows={2} placeholder="Notes (optional)" value={stopSaleForm.notes} onChange={(e) => setStopSaleForm({ ...stopSaleForm, notes: e.target.value })} />
              <label className="label"><input type="checkbox" checked={!!stopSaleForm.isActive} onChange={(e) => setStopSaleForm({ ...stopSaleForm, isActive: e.target.checked })} /> Active</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit">{stopSaleEditId ? 'Update Stop Sale' : 'Add Stop Sale'}</button>
                {stopSaleEditId && <button type="button" onClick={cancelEditStopSale}>Cancel</button>}
              </div>
            </form>

            <table>
              <thead>
                <tr><th>Vehicle Class</th><th>Start</th><th>End</th><th>Reason</th><th>Active</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {stopSales.length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted, #888)', padding: 14 }}>No stop sales configured. Add one above to hide a class from the public website.</td></tr>
                )}
                {stopSales.map((s) => (
                  <tr key={s.id}>
                    <td>{s.vehicleType?.name || '-'}{s.vehicleType?.code ? ` (${s.vehicleType.code})` : ''}</td>
                    <td>{s.startDate ? new Date(s.startDate).toLocaleString() : '-'}</td>
                    <td>{s.endDate ? new Date(s.endDate).toLocaleString() : '-'}</td>
                    <td>{s.reason || '-'}</td>
                    <td><span className="badge">{s.isActive ? 'Active' : 'Inactive'}</span></td>
                    <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button onClick={() => editStopSale(s)}>Edit</button>
                      <button onClick={() => toggleStopSale(s)}>{s.isActive ? 'Disable' : 'Enable'}</button>
                      <button onClick={() => removeStopSale(s.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'rates' && (
          <div className="stack">
            <div className="row-between"><h2>Master Rates</h2><button onClick={() => { setRateForm({ ...EMPTY_RATE, rateItems: vehicleTypes.map((vt, idx) => ({ vehicleTypeId: vt.id, sortOrder: idx, hourly: '', daily: '', extraDaily: '', weekly: '', monthly: '', minHourly: '0', minDaily: '0', minWeekly: '0', minMonthly: '0', extraMileCharge: '' })) }); resetRateDailyUpload(); }}>New Rate</button></div>
            <div className="label" style={{ marginTop: -4 }}>{rateFormMode}</div>
            <div className="grid2">
              <input placeholder="Rate code" value={rateQuery} onChange={(e) => setRateQuery(e.target.value)} />
              <button onClick={load}>Search</button>
            </div>

            <form className="stack glass card rate-editor" onSubmit={addRate}>
              <div className="grid2">
                <div className="stack"><label className="label">Rate Code*</label><input required value={rateForm.rateCode || ''} onChange={(e) => setRateForm({ ...rateForm, rateCode: e.target.value })} /></div>
                <div className="stack"><label className="label">Calculation By</label><select value={rateForm.calculationBy || '24_HOUR_TIME'} onChange={(e) => setRateForm({ ...rateForm, calculationBy: e.target.value })}><option value="24_HOUR_TIME">24 Hour Time</option><option value="CALENDAR_DAY">Calendar Day</option></select></div>
              </div>

              <div className="grid2">
                <div className="stack"><label className="label">Rate Type</label><select value={rateForm.rateType || 'MULTIPLE_CLASSES'} onChange={(e) => setRateForm({ ...rateForm, rateType: e.target.value })}><option value="MULTIPLE_CLASSES">Standard</option><option value="SINGLE_CLASS">Single Class</option></select></div>
                <div className="stack"><label className="label">Available By</label><select value={rateForm.averageBy || 'DATE_RANGE'} onChange={(e) => setRateForm({ ...rateForm, averageBy: e.target.value })}><option value="DATE_RANGE">Date Range</option><option value="CALENDAR">Calendar</option></select></div>
              </div>

              <div className="stack">
                <label className="label">Default Location Scope</label>
                <select value={rateForm.locationId || ''} onChange={(e) => setRateForm({ ...rateForm, locationId: e.target.value })}>
                  <option value="">All locations (global default)</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>

                <label className="label" style={{ marginTop: 8 }}>Also Apply To Multiple Locations (optional)</label>
                <select
                  multiple
                  size={Math.min(6, Math.max(3, locations.length || 3))}
                  value={rateForm.locationIds || []}
                  onChange={(e) => {
                    const ids = Array.from(e.target.selectedOptions).map((o) => o.value);
                    setRateForm({ ...rateForm, locationIds: ids });
                  }}
                >
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <span className="label">Tip: leave this empty to use only the default scope above.</span>
              </div>

              <div className="grid2">
                <div className="stack"><label className="label">Effective Date*</label><input type="date" value={rateForm.effectiveDate || ''} onChange={(e) => setRateForm({ ...rateForm, effectiveDate: e.target.value })} /></div>
                <div className="stack"><label className="label">End Date*</label><input type="date" value={rateForm.endDate || ''} onChange={(e) => setRateForm({ ...rateForm, endDate: e.target.value })} /></div>
              </div>
              {rateDateInvalid ? <div className="error">End Date must be the same or after Effective Date.</div> : null}

              <div className="grid2">
                <div className="stack"><label className="label">Fuel Charge Per Gallon/Liter*</label><input value={rateForm.fuelChargePerGallon || ''} onChange={(e) => setRateForm({ ...rateForm, fuelChargePerGallon: e.target.value })} /></div>
                <div className="stack"><label className="label">Minimum Charge Days*</label><input value={rateForm.minChargeDays || ''} onChange={(e) => setRateForm({ ...rateForm, minChargeDays: e.target.value })} /></div>
              </div>

              <div className="grid2">
                <div className="stack"><label className="label">Extra Mile Charge*</label><input value={rateForm.extraMileCharge || ''} onChange={(e) => setRateForm({ ...rateForm, extraMileCharge: e.target.value })} /></div>
                <div className="stack"><label className="label">Grace Minutes*</label><input value={rateForm.graceMinutes || ''} onChange={(e) => setRateForm({ ...rateForm, graceMinutes: e.target.value })} /></div>
              </div>

              <div className="grid2 rate-flags">
                <label className="label"><input type="checkbox" checked={!rateForm.useHourlyRates} onChange={(e) => setRateForm({ ...rateForm, useHourlyRates: !e.target.checked })} /> Skip Hourly Rate</label>
                <label className="label"><input type="checkbox" checked={!!rateForm.active} onChange={(e) => setRateForm({ ...rateForm, active: e.target.checked })} /> Active</label>
                <label className="label"><input type="checkbox" checked={!!rateForm.displayOnline} onChange={(e) => setRateForm({ ...rateForm, displayOnline: e.target.checked })} /> Display Online</label>
                <label className="label"><input type="checkbox" checked={!!rateForm.sameSpecialRates} onChange={(e) => setRateForm({ ...rateForm, sameSpecialRates: e.target.checked })} /> Date Specific Rate</label>
              </div>

              <div className="glass card" style={{ padding: 10 }}>
                <div className="label" style={{ marginBottom: 6 }}>Available on</div>
                <div className="grid2">
                  {['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map((d) => (
                    <label key={d} className="label" style={{ textTransform: 'capitalize' }}>
                      <input type="checkbox" checked={!!rateForm[d]} onChange={(e) => setRateForm({ ...rateForm, [d]: e.target.checked })} /> {d}
                    </label>
                  ))}
                </div>
              </div>



              <div className="stack">
                <label className="label">Rental Rates</label>
                <table>
                  <thead><tr><th>Vehicle Type</th><th>Hourly</th><th>Daily</th><th>Extra Daily</th><th>Weekly</th><th>Monthly</th><th>Min Hourly</th><th>Min Daily</th><th>Min Weekly</th><th>Min Monthly</th><th>Extra Mile Charge</th></tr></thead>
                  <tbody>
                    {(rateForm.rateItems || vehicleTypes.map((vt, idx) => ({ vehicleTypeId: vt.id, sortOrder: idx }))).map((ri, idx) => {
                      const vt = vehicleTypes.find((x) => x.id === ri.vehicleTypeId);
                      const updateItem = (k, v) => setRateForm((prev) => ({ ...prev, rateItems: (prev.rateItems || []).map((it, i) => i === idx ? { ...it, [k]: v } : it) }));
                      return (
                        <tr key={`${ri.vehicleTypeId}-${idx}`}>
                          <td>{vt?.name || ri.vehicleTypeId}</td>
                          <td><input value={ri.hourly || ''} onChange={(e) => updateItem('hourly', e.target.value)} /></td>
                          <td><input value={ri.daily || ''} onChange={(e) => updateItem('daily', e.target.value)} /></td>
                          <td><input value={ri.extraDaily || ''} onChange={(e) => updateItem('extraDaily', e.target.value)} /></td>
                          <td><input value={ri.weekly || ''} onChange={(e) => updateItem('weekly', e.target.value)} /></td>
                          <td><input value={ri.monthly || ''} onChange={(e) => updateItem('monthly', e.target.value)} /></td>
                          <td><input value={ri.minHourly || '0'} onChange={(e) => updateItem('minHourly', e.target.value)} /></td>
                          <td><input value={ri.minDaily || '0'} onChange={(e) => updateItem('minDaily', e.target.value)} /></td>
                          <td><input value={ri.minWeekly || '0'} onChange={(e) => updateItem('minWeekly', e.target.value)} /></td>
                          <td><input value={ri.minMonthly || '0'} onChange={(e) => updateItem('minMonthly', e.target.value)} /></td>
                          <td><input value={ri.extraMileCharge || ''} onChange={(e) => updateItem('extraMileCharge', e.target.value)} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="glass card" style={{ padding: 14 }}>
                <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                  <div className="stack" style={{ gap: 4 }}>
                    <label className="label">Dynamic Daily Pricing</label>
                    <div className="surface-note" style={{ margin: 0 }}>
                      Override the base daily rate by date and vehicle class. Two import paths:{' '}
                      <strong>CSV template</strong> (manually-built rates) and{' '}
                      <strong>Suggestion Report Excel</strong> (CarTrawler / competitor exports — uses the SuggestedAmount column, ignores SIPP codes you don&apos;t have).
                    </div>
                  </div>
                  <div className="stack" style={{ gap: 4, alignItems: 'flex-end' }}>
                    <span className="badge">{rateDailyPrices.length} total overrides</span>
                  </div>
                </div>

                {!rateForm.id ? (
                  <div className="surface-note" style={{ marginTop: 12 }}>
                    Save the rate first, then upload your date-based daily prices.
                  </div>
                ) : (
                  <div className="stack" style={{ marginTop: 12, gap: 10 }}>
                    {/* Two import paths shown as parallel groups so the buttons
                        in each group line up visually instead of mixing solid
                        + subtle styles in one row. */}
                    <div className="grid2" style={{ gap: 12 }}>
                      <div className="glass card" style={{ padding: 10 }}>
                        <div className="stack" style={{ gap: 8 }}>
                          <span className="label" style={{ fontSize: 11, opacity: 0.75 }}>CSV Template</span>
                          <div className="inline-actions" style={{ gap: 6, flexWrap: 'wrap' }}>
                            <button type="button" className="button-subtle" onClick={downloadRateDailyPricingTemplate}>
                              Download CSV
                            </button>
                            <label className="button-subtle" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                              Upload CSV
                              <input
                                type="file"
                                accept=".csv,.txt,text/csv"
                                style={{ display: 'none' }}
                                onChange={loadRateDailyPricingFile}
                              />
                            </label>
                            <button type="button" className="button-subtle" onClick={validateRateDailyPricing} disabled={!rateDailyUploadRows.length}>Validate</button>
                            <button type="button" className="button-subtle" onClick={importRateDailyPricing} disabled={!rateDailyUploadRows.length}>Import</button>
                          </div>
                        </div>
                      </div>

                      <div className="glass card" style={{ padding: 10 }}>
                        <div className="stack" style={{ gap: 8 }}>
                          <span className="label" style={{ fontSize: 11, opacity: 0.75 }}>Excel — Suggestion Report</span>
                          <div className="inline-actions" style={{ gap: 6, flexWrap: 'wrap' }}>
                            <button type="button" className="button-subtle" onClick={downloadRateDailyPricingExcelTemplate}>
                              Download Excel
                            </button>
                            <label className="button-subtle" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                              Upload Excel
                              <input
                                type="file"
                                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                                style={{ display: 'none' }}
                                onChange={beginRateExcelImport}
                              />
                            </label>
                          </div>
                        </div>
                      </div>
                    </div>

                    {rateDailyUploadName ? (
                      <div className="surface-note">
                        Loaded CSV: <strong>{rateDailyUploadName}</strong> with <strong>{rateDailyUploadRows.length}</strong> row(s).
                      </div>
                    ) : null}

                    {rateDailyUploadReport ? (
                      <div className="surface-note">
                        <strong>CSV summary:</strong> {rateDailyUploadReport.validCount || 0} valid row(s), {rateDailyUploadReport.errorCount || 0} issue(s).
                        {Array.isArray(rateDailyUploadReport.errors) && rateDailyUploadReport.errors.length ? (
                          <div style={{ marginTop: 8 }}>
                            {rateDailyUploadReport.errors.slice(0, 8).map((error, idx) => (
                              <div key={`${error.line || idx}-${error.field || idx}`}>
                                Line {error.line || '-'} | {error.field || 'row'} | {error.message}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {/* ----- Excel import: rate picker ----- */}
                    {rateExcelImport && rateLocationPicker ? (
                      <div className="glass card" style={{ padding: 12, borderColor: '#5b8cff' }}>
                        <div className="stack" style={{ gap: 6 }}>
                          <strong>Pick the rate to update</strong>
                          <div className="surface-note" style={{ margin: 0 }}>
                            Detected location <strong>{(rateExcelImport.detectedLocationCodes || []).join(', ') || '—'}</strong>
                            {rateExcelImport.candidateRates?.length
                              ? ` — ${rateExcelImport.candidateRates.length} active rate(s) match. Pick one below.`
                              : ' — no rates match this location for this tenant. Pick any rate manually.'}
                          </div>
                          <div className="stack" style={{ gap: 4 }}>
                            <select
                              value={rateExcelImport.selectedRateId || ''}
                              onChange={(e) => setRateExcelImport((s) => (s ? { ...s, selectedRateId: e.target.value } : s))}
                            >
                              <option value="">— pick a rate —</option>
                              {(rateExcelImport.candidateRates?.length
                                ? rateExcelImport.candidateRates
                                : rates
                              ).map((r) => (
                                <option key={r.id} value={r.id}>
                                  {r.rateCode}{r.name ? ` · ${r.name}` : ''} {r.location?.code ? `· ${r.location.code}` : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="inline-actions">
                            <button
                              type="button"
                              disabled={!rateExcelImport.selectedRateId}
                              onClick={() => runExcelValidate(rateExcelImport)}
                            >
                              Continue → Preview Diff
                            </button>
                            <button type="button" className="button-subtle" onClick={cancelRateExcelImport}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {/* ----- Excel import: diff preview ----- */}
                    {rateExcelImport && rateExcelImport.report && !rateLocationPicker ? (() => {
                      const r = rateExcelImport.report;
                      const targetRate = (rateExcelImport.candidateRates || []).find(x => x.id === rateExcelImport.selectedRateId)
                        || rates.find(x => x.id === rateExcelImport.selectedRateId);
                      const diffSamples = [...(r.added || []).slice(0, 5).map(x => ({...x, _kind: 'add'})),
                                          ...(r.updated || []).slice(0, 5).map(x => ({...x, _kind: 'update'}))];
                      return (
                        <div className="glass card" style={{ padding: 12, borderColor: '#5b8cff' }}>
                          <div className="stack" style={{ gap: 8 }}>
                            <div className="row-between" style={{ alignItems: 'baseline' }}>
                              <strong>Preview: {rateExcelImport.filename}</strong>
                              <span className="label">
                                Target: <strong>{targetRate?.rateCode || rateExcelImport.selectedRateId}</strong>
                                {targetRate?.location?.code ? ` · ${targetRate.location.code}` : ''}
                              </span>
                            </div>
                            <div className="inline-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
                              <span className="badge" style={{ background: 'rgba(34,197,94,0.18)' }}>{r.addedCount || 0} new</span>
                              <span className="badge" style={{ background: 'rgba(59,130,246,0.18)' }}>{r.updatedCount || 0} updates</span>
                              <span className="badge">{r.unchangedCount || 0} unchanged</span>
                              <span className="badge" style={{ background: 'rgba(251,191,36,0.18)' }}>
                                {(r.skippedCount || 0) + (rateExcelImport.zeroSkippedCount || 0)} skipped
                              </span>
                              <span className="badge" style={{ background: r.errorCount ? 'rgba(239,68,68,0.18)' : undefined }}>{r.errorCount || 0} errors</span>
                              <span className="label">Total parsed: {rateExcelImport.rowCount + (rateExcelImport.zeroSkippedCount || 0)}</span>
                            </div>

                            {(Array.isArray(r.skipped) && r.skipped.length) || rateExcelImport.zeroSkipped?.length ? (
                              <div className="surface-note" style={{ margin: 0 }}>
                                <strong>Skipped:</strong>
                                <ul style={{ margin: '4px 0 0 18px' }}>
                                  {(rateExcelImport.zeroSkipped || []).map((s, i) => (<li key={`z${i}`}>{s.message}</li>))}
                                  {(r.skipped || []).map((s, i) => (<li key={i}>{s.message}</li>))}
                                </ul>
                              </div>
                            ) : null}

                            {Array.isArray(r.errors) && r.errors.length ? (
                              <div className="surface-note" style={{ margin: 0, color: '#fca5a5' }}>
                                <strong>Errors ({r.errors.length}):</strong>
                                <ul style={{ margin: '4px 0 0 18px' }}>
                                  {r.errors.slice(0, 6).map((e, i) => (
                                    <li key={i}>Line {e.line} · {e.field} · {e.message}</li>
                                  ))}
                                  {r.errors.length > 6 ? <li>… and {r.errors.length - 6} more</li> : null}
                                </ul>
                              </div>
                            ) : null}

                            {diffSamples.length ? (
                              <div className="stack" style={{ gap: 4 }}>
                                <span className="label">Sample changes:</span>
                                <table>
                                  <thead>
                                    <tr><th>Action</th><th>Date</th><th>Vehicle Type</th><th>Before</th><th>After</th></tr>
                                  </thead>
                                  <tbody>
                                    {diffSamples.map((row, i) => (
                                      <tr key={i}>
                                        <td>
                                          <span className="badge" style={{
                                            background: row._kind === 'add' ? 'rgba(34,197,94,0.18)' : 'rgba(59,130,246,0.18)'
                                          }}>{row._kind === 'add' ? 'NEW' : 'UPDATE'}</span>
                                        </td>
                                        <td>{row.dateKey || row.date}</td>
                                        <td>{row.vehicleTypeCode}</td>
                                        <td>{row.previousDaily != null ? `$${Number(row.previousDaily).toFixed(2)}` : '—'}</td>
                                        <td><strong>${Number(row.daily).toFixed(2)}</strong></td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                                {(r.addedCount + r.updatedCount) > diffSamples.length ? (
                                  <span className="label">… and {(r.addedCount + r.updatedCount) - diffSamples.length} more change(s) on Apply.</span>
                                ) : null}
                              </div>
                            ) : null}

                            <div className="inline-actions">
                              <button
                                type="button"
                                onClick={applyRateExcelImport}
                                disabled={rateExcelImport.applying || (r.addedCount + r.updatedCount === 0)}
                              >
                                {rateExcelImport.applying
                                  ? 'Applying…'
                                  : `Apply ${(r.addedCount || 0) + (r.updatedCount || 0)} change(s)`}
                              </button>
                              <button type="button" className="button-subtle" onClick={cancelRateExcelImport}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })() : null}

                    {/* ----- Calendar grid view (replaces the buggy slice(0,24)) ----- */}
                    {rateDailyPrices.length ? (
                      <div className="stack" style={{ gap: 8 }}>
                        <div className="row-between" style={{ alignItems: 'baseline' }}>
                          <label className="label">Current Daily Overrides — Calendar View</label>
                          <span className="label">
                            Showing {rateGrid.totalCount} of {rateDailyPrices.length} overrides
                          </span>
                        </div>

                        <div className="inline-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
                          <div className="stack" style={{ gap: 2 }}>
                            <span className="label" style={{ fontSize: 11 }}>From</span>
                            <input
                              type="date"
                              value={rateGridFilters.dateFrom}
                              onChange={(e) => setRateGridFilters(f => ({ ...f, dateFrom: e.target.value }))}
                            />
                          </div>
                          <div className="stack" style={{ gap: 2 }}>
                            <span className="label" style={{ fontSize: 11 }}>To</span>
                            <input
                              type="date"
                              value={rateGridFilters.dateTo}
                              onChange={(e) => setRateGridFilters(f => ({ ...f, dateTo: e.target.value }))}
                            />
                          </div>
                          <div className="stack" style={{ gap: 2 }}>
                            <span className="label" style={{ fontSize: 11 }}>Vehicle Type</span>
                            <select
                              value={rateGridFilters.vehicleTypeIds[0] || ''}
                              onChange={(e) => setRateGridFilters(f => ({
                                ...f,
                                vehicleTypeIds: e.target.value ? [e.target.value] : []
                              }))}
                            >
                              <option value="">All types</option>
                              {Array.from(new Map(rateDailyPrices.map(p => [p.vehicleTypeId, p])).values())
                                .sort((a, b) => String(a.vehicleTypeCode || '').localeCompare(String(b.vehicleTypeCode || '')))
                                .map(p => (
                                  <option key={p.vehicleTypeId} value={p.vehicleTypeId}>
                                    {p.vehicleTypeCode}{p.vehicleTypeName ? ` · ${p.vehicleTypeName}` : ''}
                                  </option>
                                ))}
                            </select>
                          </div>
                          {(rateGridFilters.dateFrom || rateGridFilters.dateTo || rateGridFilters.vehicleTypeIds.length) ? (
                            <button
                              type="button"
                              className="button-subtle"
                              style={{ alignSelf: 'flex-end' }}
                              onClick={() => setRateGridFilters({ vehicleTypeIds: [], dateFrom: '', dateTo: '', actionFilter: 'all' })}
                            >
                              Clear filters
                            </button>
                          ) : null}
                        </div>

                        {rateGrid.dates.length === 0 ? (
                          <div className="surface-note">No overrides match the current filters.</div>
                        ) : (
                          <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                            <table style={{ minWidth: 'max-content' }}>
                              <thead>
                                <tr>
                                  <th style={{ position: 'sticky', left: 0, background: 'inherit', zIndex: 1, minWidth: 140 }}>Vehicle Type</th>
                                  {rateGrid.dates.map((d) => {
                                    const dt = new Date(`${d}T00:00:00Z`);
                                    const dow = dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
                                    const md = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
                                    return (
                                      <th key={d} style={{ minWidth: 78, textAlign: 'center', whiteSpace: 'nowrap', fontSize: 11 }}>
                                        <div style={{ opacity: 0.6 }}>{dow}</div>
                                        <div>{md}</div>
                                      </th>
                                    );
                                  })}
                                </tr>
                              </thead>
                              <tbody>
                                {rateGrid.vehicleTypes.map((vt) => (
                                  <tr key={vt.id}>
                                    <td style={{ position: 'sticky', left: 0, background: 'inherit', zIndex: 1, fontWeight: 600 }}>
                                      {vt.code}
                                      {vt.name ? <div style={{ fontSize: 11, opacity: 0.7, fontWeight: 400 }}>{vt.name}</div> : null}
                                    </td>
                                    {rateGrid.dates.map((d) => {
                                      const cell = rateGrid.cells.get(`${vt.id}|${d}`);
                                      if (!cell) return <td key={d} style={{ textAlign: 'center', opacity: 0.3 }}>—</td>;
                                      return (
                                        <td key={d} style={{ textAlign: 'center', padding: 4 }}>
                                          <div
                                            title={`${vt.code} on ${d}\nClick × to remove`}
                                            style={{
                                              display: 'inline-flex',
                                              alignItems: 'center',
                                              gap: 4,
                                              padding: '2px 6px',
                                              borderRadius: 4,
                                              background: 'rgba(59,130,246,0.12)',
                                              fontSize: 12,
                                              fontVariantNumeric: 'tabular-nums'
                                            }}
                                          >
                                            <span>${Number(cell.daily || 0).toFixed(2)}</span>
                                            {cell.id ? (
                                              <button
                                                type="button"
                                                className="button-subtle"
                                                style={{ padding: '0 4px', fontSize: 10, lineHeight: 1.2 }}
                                                onClick={() => removeRateDailyPrice(cell.id)}
                                                title="Remove this override"
                                              >×</button>
                                            ) : null}
                                          </div>
                                        </td>
                                      );
                                    })}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="surface-note">No daily overrides yet. Base daily rates above will still apply.</div>
                    )}
                  </div>
                )}
              </div>

              <button type="submit" disabled={!rateFormValid}>{rateForm.id ? 'Update Rate' : 'Save Rate'}</button>
            </form>

            <table>
              <thead><tr><th>Rate Code</th><th>Location</th><th>Type</th><th>Calculation By</th><th>Effective Date</th><th>End Date</th><th>Display Online</th><th>Active</th><th>Actions</th></tr></thead>
              <tbody>
                {rates.filter((r) => !rateQuery || (r.rateCode || '').toLowerCase().includes(rateQuery.toLowerCase())).map((r) => (
                  <tr key={r.id}>
                    <td>{r.rateCode}</td>
                    <td>{rateScopeLabel(r)}</td>
                    <td>{r.rateType}</td>
                    <td>{r.calculationBy}</td>
                    <td>{r.effectiveDate ? new Date(r.effectiveDate).toLocaleDateString() : '-'}</td>
                    <td>{r.endDate ? new Date(r.endDate).toLocaleDateString() : '-'}</td>
                    <td><span className="badge">{r.displayOnline ? 'Online' : 'Hidden'}</span></td>
                    <td><span className="badge">{r.isActive ? 'Active' : 'Inactive'}</span></td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => editRate(r)}>Edit</button>
                      <button onClick={() => toggleRate(r)}>{r.isActive ? 'Disable' : 'Enable'}</button>
                      <button onClick={() => removeRate(r.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'vehicleTypes' && (
          <div className="stack">
            <div className="row-between"><h2>Vehicle Classes</h2><button onClick={resetVehicleTypeForm}>New Class</button></div>
            <form className="stack" onSubmit={saveVehicleType}>
              <div className="grid3">
                <input placeholder="Code" value={vehicleTypeForm.code} onChange={(e) => setVehicleTypeForm({ ...vehicleTypeForm, code: e.target.value.toUpperCase() })} />
                <input placeholder="Name" value={vehicleTypeForm.name} onChange={(e) => setVehicleTypeForm({ ...vehicleTypeForm, name: e.target.value })} />
                <input placeholder="Description" value={vehicleTypeForm.description} onChange={(e) => setVehicleTypeForm({ ...vehicleTypeForm, description: e.target.value })} />
              </div>
              <div className="grid2">
                <div className="stack">
                  <label className="label">Default Booking Image</label>
                  <input type="file" accept="image/*" onChange={(e) => uploadVehicleTypeImage(e.target.files?.[0])} />
                  <span className="label">This image will show in booking when a host listing has no custom vehicle photos.</span>
                </div>
                <div className="stack">
                  <label className="label">Preview</label>
                  {vehicleTypeForm.imageUrl ? (
                    <img src={vehicleTypeForm.imageUrl} alt="Vehicle type preview" style={{ width: '100%', maxWidth: 220, aspectRatio: '16 / 10', objectFit: 'cover', borderRadius: 16, border: '1px solid rgba(110,73,255,.15)' }} />
                  ) : (
                    <div className="surface-note">No image uploaded yet.</div>
                  )}
                  {vehicleTypeForm.imageUrl ? <button type="button" className="button-subtle" onClick={() => setVehicleTypeForm({ ...vehicleTypeForm, imageUrl: '' })}>Remove Image</button> : null}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit">{vehicleTypeEditId ? 'Update Class' : 'Add Class'}</button>
                {vehicleTypeEditId ? <button type="button" onClick={resetVehicleTypeForm}>Cancel</button> : null}
              </div>
            </form>
            <table>
              <thead><tr><th>Image</th><th>Code</th><th>Name</th><th>Description</th><th>Actions</th></tr></thead>
              <tbody>
                {vehicleTypes.length ? vehicleTypes.map((vt) => (
                  <tr key={vt.id}>
                    <td>{vt.imageUrl ? <img src={vt.imageUrl} alt={vt.name} style={{ width: 84, height: 54, objectFit: 'cover', borderRadius: 12, border: '1px solid rgba(110,73,255,.15)' }} /> : <span className="label">No image</span>}</td>
                    <td>{vt.code}</td>
                    <td>{vt.name}</td>
                    <td>{vt.description || '-'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" onClick={() => editVehicleType(vt)}>Edit</button>
                        <button type="button" onClick={() => removeVehicleType(vt)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                )) : (
                  <tr><td colSpan="5">No vehicle classes configured yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'insurance' && (
          <div className="stack">
            <h2>Insurance Plans</h2>
            <form className="stack service-form" onSubmit={addInsurancePlan}>
              <div className="grid2">
                <div className="stack"><label className="label">Code*</label><input required value={insuranceForm.code} onChange={(e) => setInsuranceForm({ ...insuranceForm, code: e.target.value })} /></div>
                <div className="stack"><label className="label">Name*</label><input required value={insuranceForm.name} onChange={(e) => setInsuranceForm({ ...insuranceForm, name: e.target.value })} /></div>
                <div className="stack"><label className="label">Label</label><input value={insuranceForm.label} onChange={(e) => setInsuranceForm({ ...insuranceForm, label: e.target.value })} /></div>
                <div className="stack"><label className="label">Description</label><input value={insuranceForm.description} onChange={(e) => setInsuranceForm({ ...insuranceForm, description: e.target.value })} /></div>
              </div>

              <div className="grid2">
                <div className="stack">
                  <label className="label">Charge Type</label>
                  <select value={insuranceForm.chargeBy} onChange={(e) => setInsuranceForm({ ...insuranceForm, chargeBy: e.target.value })}>
                    <option value="PER_DAY">Per Day</option>
                    <option value="FIXED">Fixed</option>
                    <option value="PERCENTAGE">Percentage</option>
                  </select>
                </div>
                <div className="stack"><label className="label">Charge Amount</label><input value={insuranceForm.amount} onChange={(e) => setInsuranceForm({ ...insuranceForm, amount: e.target.value })} /></div>
              </div>

              <label className="label">
                <input type="checkbox" checked={!!insuranceForm.taxable} onChange={(e) => setInsuranceForm({ ...insuranceForm, taxable: e.target.checked })} /> Taxable
              </label>

              <div className="stack">
                <label className="label">Applies to Locations</label>
                <div className="service-checks-grid">
                  {locations.map((l) => (
                    <label key={l.id} className="label">
                      <input
                        type="checkbox"
                        checked={(insuranceForm.locationIds || []).includes(l.id)}
                        onChange={(e) => setInsuranceForm((prev) => ({
                          ...prev,
                          locationIds: e.target.checked ? [...(prev.locationIds || []), l.id] : (prev.locationIds || []).filter((x) => x !== l.id)
                        }))}
                      /> {l.code} - {l.name}
                    </label>
                  ))}
                </div>
              </div>

              <div className="stack">
                <label className="label">Applies to Vehicle Classes</label>
                <div className="service-checks-grid">
                  {vehicleTypes.map((vt) => (
                    <label key={vt.id} className="label">
                      <input
                        type="checkbox"
                        checked={(insuranceForm.vehicleTypeIds || []).includes(vt.id)}
                        onChange={(e) => setInsuranceForm((prev) => ({
                          ...prev,
                          vehicleTypeIds: e.target.checked ? [...(prev.vehicleTypeIds || []), vt.id] : (prev.vehicleTypeIds || []).filter((x) => x !== vt.id)
                        }))}
                      /> {vt.code} - {vt.name}
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid2">
                <div className="stack">
                  <label className="label">Insurance Commission</label>
                  <select value={insuranceForm.commissionValueType || ''} onChange={(e) => setInsuranceForm({ ...insuranceForm, commissionValueType: e.target.value })}>
                    <option value="">No direct commission</option>
                    <option value="PERCENT">Percent of insurance premium</option>
                    <option value="FIXED_PER_UNIT">Fixed per policy sold</option>
                    <option value="FIXED_PER_AGREEMENT">Fixed per agreement</option>
                  </select>
                </div>
                {insuranceForm.commissionValueType === 'PERCENT' ? (
                  <div className="stack">
                    <label className="label">Commission Percent</label>
                    <input type="number" min="0" step="0.01" value={insuranceForm.commissionPercentValue} onChange={(e) => setInsuranceForm({ ...insuranceForm, commissionPercentValue: e.target.value })} placeholder="5" />
                  </div>
                ) : insuranceForm.commissionValueType ? (
                  <div className="stack">
                    <label className="label">Commission Fixed Amount</label>
                    <input type="number" min="0" step="0.01" value={insuranceForm.commissionFixedAmount} onChange={(e) => setInsuranceForm({ ...insuranceForm, commissionFixedAmount: e.target.value })} placeholder="3.00" />
                  </div>
                ) : <div />}
              </div>

              <div>
                <label className="label">Customer Display Description</label>
                <textarea
                  placeholder="Description shown to customers on the display screen (leave blank to use internal description)"
                  value={insuranceForm.displayDescription}
                  onChange={(e) => setInsuranceForm({ ...insuranceForm, displayDescription: e.target.value })}
                  rows={2}
                  style={{ width: '100%', resize: 'vertical' }}
                />
              </div>
              <div className="grid2">
                <div>
                  <label className="label">Display Priority</label>
                  <input type="number" min="0" max="100" placeholder="0 = auto" value={insuranceForm.displayPriority} onChange={(e) => setInsuranceForm({ ...insuranceForm, displayPriority: e.target.value })} />
                  <div className="ui-muted" style={{ fontSize: '0.78rem', marginTop: 2 }}>Higher priority plans appear first on the customer display. 0 = automatic.</div>
                </div>
              </div>
              <label className="label"><input type="checkbox" checked={!!insuranceForm.isActive} onChange={(e) => setInsuranceForm({ ...insuranceForm, isActive: e.target.checked })} /> Active</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit">{insuranceEditIdx >= 0 ? 'Update Insurance Plan' : 'Add Insurance Plan'}</button>
                {insuranceEditIdx >= 0 ? <button type="button" onClick={resetInsuranceForm}>Cancel Edit</button> : null}
              </div>
            </form>

            <table>
              <thead><tr><th>Code</th><th>Name/Label</th><th>Charge</th><th>Commission</th><th>Taxable</th><th>Locations</th><th>Vehicle Classes</th><th>Active</th><th>Actions</th></tr></thead>
              <tbody>
                {insurancePlans.map((p, idx) => (
                  <tr key={`${p.code}-${idx}`}>
                    <td>{p.code}</td>
                    <td>
                      <div>{p.name}</div>
                      <div className="label">{p.label || '-'}</div>
                      <div className="label">{p.description || '-'}</div>
                    </td>
                    <td>{p.chargeBy || p.mode} / {Number(p.amount || 0).toFixed(2)}</td>
                    <td>
                      {p.commissionValueType === 'PERCENT' ? `${Number(p.commissionPercentValue || 0).toFixed(2)}%` :
                        p.commissionValueType ? `$${Number(p.commissionFixedAmount || 0).toFixed(2)}` :
                        '-'}
                      <div className="label">{p.commissionValueType || '-'}</div>
                    </td>
                    <td>{p.taxable ? 'Yes' : 'No'}</td>
                    <td className="label">{(p.locationIds || []).length ? (p.locationIds || []).map((id) => locations.find((l) => l.id === id)?.code || id).join(', ') : 'All'}</td>
                    <td className="label">{(p.vehicleTypeIds || []).length ? (p.vehicleTypeIds || []).map((id) => vehicleTypes.find((v) => v.id === id)?.code || id).join(', ') : 'All'}</td>
                    <td>{p.isActive ? 'Yes' : 'No'}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => editInsurancePlan(idx)}>Edit</button>
                      <button onClick={() => toggleInsurancePlan(idx)}>{p.isActive ? 'Disable' : 'Enable'}</button>
                      <button onClick={() => removeInsurancePlan(idx)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'selfService' && (
          <div className="stack">
            <h2>Self-Service Pickup / Drop-Off</h2>
            <div className="surface-note">
              Configure tenant-level readiness rules for self-service handoff, plus the default key exchange mode and instructions that show up in the customer portal.
            </div>

            <section className="glass card section-card">
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="stack" style={{ gap: 6 }}>
                  <h3 style={{ margin: 0 }}>Tenant Handoff Rules</h3>
                  <div className="ui-muted">
                    This controls whether a customer can be considered ready for self-service pickup/drop-off after pre-check-in, signature, and payment are done.
                  </div>
                </div>
                <span className={`status-chip ${selfServiceConfig.enabled ? 'good' : 'neutral'}`}>
                  {selfServiceConfig.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>

              <div className="form-grid-2">
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!selfServiceConfig.enabled}
                    onChange={(e) => setSelfServiceConfig((current) => ({ ...current, enabled: e.target.checked }))}
                  /> Enable self-service handoff for this tenant
                </label>
                <div className="surface-note">
                  Tenant plan: <strong>{selfServiceConfig.tenantPlan || 'BETA'}</strong>
                  <div style={{ marginTop: 8 }}>
                    Readiness mode: <strong>{String(selfServiceConfig.readinessMode || 'STRICT').toUpperCase()}</strong>
                  </div>
                </div>
              </div>

              <div className="form-grid-2">
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!selfServiceConfig.allowPickup}
                    onChange={(e) => setSelfServiceConfig((current) => ({ ...current, allowPickup: e.target.checked }))}
                  /> Allow self-service pickup
                </label>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!selfServiceConfig.allowDropoff}
                    onChange={(e) => setSelfServiceConfig((current) => ({ ...current, allowDropoff: e.target.checked }))}
                  /> Allow self-service drop-off
                </label>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!selfServiceConfig.requirePrecheckinForPickup}
                    onChange={(e) => setSelfServiceConfig((current) => ({ ...current, requirePrecheckinForPickup: e.target.checked }))}
                  /> Require pre-check-in before pickup
                </label>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!selfServiceConfig.requireSignatureForPickup}
                    onChange={(e) => setSelfServiceConfig((current) => ({ ...current, requireSignatureForPickup: e.target.checked }))}
                  /> Require signed agreement before pickup
                </label>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!selfServiceConfig.requirePaymentForPickup}
                    onChange={(e) => setSelfServiceConfig((current) => ({ ...current, requirePaymentForPickup: e.target.checked }))}
                  /> Require payment before pickup
                </label>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!selfServiceConfig.allowAfterHoursPickup}
                    onChange={(e) => setSelfServiceConfig((current) => ({ ...current, allowAfterHoursPickup: e.target.checked }))}
                  /> Allow after-hours pickup
                </label>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!selfServiceConfig.allowAfterHoursDropoff}
                    onChange={(e) => setSelfServiceConfig((current) => ({ ...current, allowAfterHoursDropoff: e.target.checked }))}
                  /> Allow after-hours drop-off
                </label>
              </div>

              <div className="form-grid-3">
                <div className="stack">
                  <label className="label">Key Exchange Mode</label>
                  <select value={selfServiceConfig.keyExchangeMode || 'DESK'} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, keyExchangeMode: e.target.value }))}>
                    <option value="DESK">Front Desk</option>
                    <option value="LOCKBOX">Lockbox</option>
                    <option value="SMART_LOCK">Smart Lock</option>
                    <option value="KEY_CABINET">Key Cabinet</option>
                  </select>
                </div>
                <div className="stack">
                  <label className="label">Readiness Mode</label>
                  <select value={selfServiceConfig.readinessMode || 'STRICT'} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, readinessMode: e.target.value }))}>
                    <option value="STRICT">Strict</option>
                    <option value="ADVISORY">Advisory</option>
                  </select>
                </div>
                <div className="stack">
                  <label className="label">Support Phone</label>
                  <input value={selfServiceConfig.supportPhone || ''} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, supportPhone: e.target.value }))} placeholder="(787) 555-0101" />
                </div>
              </div>

              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Pickup Instructions</label>
                  <textarea rows={4} value={selfServiceConfig.pickupInstructions || ''} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, pickupInstructions: e.target.value }))} placeholder="Where to go, how to retrieve keys, what to verify before leaving." />
                </div>
                <div className="stack">
                  <label className="label">Drop-Off Instructions</label>
                  <textarea rows={4} value={selfServiceConfig.dropoffInstructions || ''} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, dropoffInstructions: e.target.value }))} placeholder="Where to return keys, after-hours steps, photo expectations, or lockbox instructions." />
                </div>
              </div>

              <div className="surface-note" style={{ display: 'grid', gap: 12 }}>
                <div>
                  <strong>Car Sharing Handoff Intelligence</strong>
                  <div className="ui-muted" style={{ marginTop: 6 }}>
                    Automatically reveal exact handoff details close to pickup for lockbox, remote unlock, and self-service trips, with different windows by place type.
                  </div>
                </div>

                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!selfServiceConfig.carSharingAutoRevealEnabled}
                    onChange={(e) => setSelfServiceConfig((current) => ({ ...current, carSharingAutoRevealEnabled: e.target.checked }))}
                  /> Enable automatic exact-handoff reveal for car sharing
                </label>

                <div className="form-grid-2">
                  {['LOCKBOX', 'REMOTE_UNLOCK', 'SELF_SERVICE', 'IN_PERSON'].map((mode) => (
                    <label key={mode} className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={Array.isArray(selfServiceConfig.carSharingAutoRevealModes) && selfServiceConfig.carSharingAutoRevealModes.includes(mode)}
                        onChange={(e) => {
                          const current = Array.isArray(selfServiceConfig.carSharingAutoRevealModes) ? selfServiceConfig.carSharingAutoRevealModes : [];
                          const next = e.target.checked
                            ? Array.from(new Set([...current, mode]))
                            : current.filter((item) => item !== mode);
                          setSelfServiceConfig((config) => ({ ...config, carSharingAutoRevealModes: next }));
                        }}
                      /> Auto reveal for {mode.replaceAll('_', ' ').toLowerCase()}
                    </label>
                  ))}
                </div>

                <div className="form-grid-3">
                  <div className="stack">
                    <label className="label">Default Reveal Window (Hours)</label>
                    <input type="number" min="0" max="168" value={selfServiceConfig.carSharingDefaultRevealWindowHours ?? 24} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, carSharingDefaultRevealWindowHours: e.target.value }))} />
                  </div>
                  <div className="stack">
                    <label className="label">Airport Reveal Window</label>
                    <input type="number" min="0" max="168" value={selfServiceConfig.carSharingAirportRevealWindowHours ?? 12} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, carSharingAirportRevealWindowHours: e.target.value }))} />
                  </div>
                  <div className="stack">
                    <label className="label">Hotel Reveal Window</label>
                    <input type="number" min="0" max="168" value={selfServiceConfig.carSharingHotelRevealWindowHours ?? 8} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, carSharingHotelRevealWindowHours: e.target.value }))} />
                  </div>
                  <div className="stack">
                    <label className="label">Neighborhood Reveal Window</label>
                    <input type="number" min="0" max="168" value={selfServiceConfig.carSharingNeighborhoodRevealWindowHours ?? 24} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, carSharingNeighborhoodRevealWindowHours: e.target.value }))} />
                  </div>
                  <div className="stack">
                    <label className="label">Station Reveal Window</label>
                    <input type="number" min="0" max="168" value={selfServiceConfig.carSharingStationRevealWindowHours ?? 10} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, carSharingStationRevealWindowHours: e.target.value }))} />
                  </div>
                  <div className="stack">
                    <label className="label">Host Pickup Reveal Window</label>
                    <input type="number" min="0" max="168" value={selfServiceConfig.carSharingHostPickupRevealWindowHours ?? 18} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, carSharingHostPickupRevealWindowHours: e.target.value }))} />
                  </div>
                  <div className="stack">
                    <label className="label">Branch Area Reveal Window</label>
                    <input type="number" min="0" max="168" value={selfServiceConfig.carSharingBranchRevealWindowHours ?? 0} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, carSharingBranchRevealWindowHours: e.target.value }))} />
                  </div>
                </div>

                <div className="stack" style={{ gap: 12 }}>
                  <strong>Car Sharing Handoff Presets</strong>
                  <div className="ui-muted">
                    Suggest the best handoff mode and starter instructions by search place type so hosts can release airport, hotel, and neighborhood trips faster.
                  </div>

                  <div className="form-grid-2">
                    <div className="stack">
                      <label className="label">Default Handoff Mode</label>
                      <select value={selfServiceConfig.carSharingDefaultHandoffMode || 'IN_PERSON'} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, carSharingDefaultHandoffMode: e.target.value }))}>
                        <option value="IN_PERSON">In-person</option>
                        <option value="LOCKBOX">Lockbox</option>
                        <option value="REMOTE_UNLOCK">Remote unlock</option>
                        <option value="SELF_SERVICE">Self-service</option>
                      </select>
                    </div>
                  </div>

                  {[
                    ['Airport', 'Airport', 'carSharingAirportHandoffMode', 'carSharingAirportInstructionsTemplate'],
                    ['Hotel', 'Hotel', 'carSharingHotelHandoffMode', 'carSharingHotelInstructionsTemplate'],
                    ['Neighborhood', 'Neighborhood', 'carSharingNeighborhoodHandoffMode', 'carSharingNeighborhoodInstructionsTemplate'],
                    ['Station', 'Station', 'carSharingStationHandoffMode', 'carSharingStationInstructionsTemplate'],
                    ['Host Pickup', 'Host Pickup Spot', 'carSharingHostPickupHandoffMode', 'carSharingHostPickupInstructionsTemplate'],
                    ['Branch', 'Branch Area', 'carSharingBranchHandoffMode', 'carSharingBranchInstructionsTemplate']
                  ].map(([key, label, modeKey, instructionsKey]) => (
                    <div key={key} className="surface-note" style={{ display: 'grid', gap: 12 }}>
                      <div className="row-between" style={{ alignItems: 'center', gap: 12 }}>
                        <strong>{label}</strong>
                        <span className="status-chip neutral">Preset</span>
                      </div>
                      <div className="form-grid-2">
                        <div className="stack">
                          <label className="label">Suggested Handoff Mode</label>
                          <select value={selfServiceConfig[modeKey] || selfServiceConfig.carSharingDefaultHandoffMode || 'IN_PERSON'} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, [modeKey]: e.target.value }))}>
                            <option value="IN_PERSON">In-person</option>
                            <option value="LOCKBOX">Lockbox</option>
                            <option value="REMOTE_UNLOCK">Remote unlock</option>
                            <option value="SELF_SERVICE">Self-service</option>
                          </select>
                        </div>
                        <div className="stack">
                          <label className="label">Instruction Template</label>
                          <textarea rows={3} value={selfServiceConfig[instructionsKey] || ''} onChange={(e) => setSelfServiceConfig((current) => ({ ...current, [instructionsKey]: e.target.value }))} placeholder="Starter instructions for hosts using this type of place." />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="inline-actions">
                <button type="button" onClick={saveSelfServiceConfig}>Save Self-Service</button>
                <button type="button" className="button-subtle" onClick={() => setSelfServiceConfig(DEFAULT_SELF_SERVICE_CONFIG)}>Reset to Defaults</button>
              </div>
            </section>

            <section className="glass card section-card">
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="stack" style={{ gap: 6 }}>
                  <h3 style={{ margin: 0 }}>Pre-Check-in Discount</h3>
                  <div className="ui-muted">
                    Offer a discount on insurance plans and add-on services when customers select them during pre-check-in instead of at the counter.
                    The customer sees the counter price crossed out with the discounted pre-check-in price.
                  </div>
                </div>
                <span className={`status-chip ${precheckinDiscount.enabled ? 'good' : 'neutral'}`}>
                  {precheckinDiscount.enabled ? 'Active' : 'Off'}
                </span>
              </div>

              <div className="form-grid-2" style={{ marginTop: 14 }}>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!precheckinDiscount.enabled}
                    onChange={(e) => setPrecheckinDiscount((c) => ({ ...c, enabled: e.target.checked }))}
                  /> Enable pre-check-in discount
                </label>
                <div className="surface-note">
                  When enabled, insurance and services selected during the self-service pre-check-in flow will be charged at the discounted rate instead of the counter rate.
                </div>
              </div>

              {precheckinDiscount.enabled && (
                <div className="form-grid-2" style={{ marginTop: 12 }}>
                  <div>
                    <label className="label">Discount Type</label>
                    <select
                      value={precheckinDiscount.type || 'PERCENTAGE'}
                      onChange={(e) => setPrecheckinDiscount((c) => ({ ...c, type: e.target.value }))}
                    >
                      <option value="PERCENTAGE">Percentage (%)</option>
                      <option value="FIXED">Fixed Amount ($)</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">
                      {precheckinDiscount.type === 'FIXED' ? 'Discount Amount ($)' : 'Discount Percentage (%)'}
                    </label>
                    <input
                      type="number"
                      step={precheckinDiscount.type === 'FIXED' ? '0.01' : '1'}
                      min="0"
                      max={precheckinDiscount.type === 'PERCENTAGE' ? '100' : undefined}
                      value={precheckinDiscount.value || ''}
                      onChange={(e) => setPrecheckinDiscount((c) => ({ ...c, value: e.target.value }))}
                      placeholder={precheckinDiscount.type === 'FIXED' ? '5.00' : '10'}
                    />
                  </div>
                  <div className="surface-note" style={{ gridColumn: '1 / -1' }}>
                    {precheckinDiscount.type === 'PERCENTAGE'
                      ? `Example: a $50 insurance plan would be charged at $${(50 * (1 - (Number(precheckinDiscount.value) || 0) / 100)).toFixed(2)} (${Number(precheckinDiscount.value) || 0}% off).`
                      : `Example: a $50 insurance plan would be charged at $${Math.max(0, 50 - (Number(precheckinDiscount.value) || 0)).toFixed(2)} ($${Number(precheckinDiscount.value || 0).toFixed(2)} off).`
                    }
                  </div>
                </div>
              )}

              <div className="inline-actions" style={{ marginTop: 12 }}>
                <button type="button" onClick={savePrecheckinDiscount}>Save Discount Settings</button>
                <button type="button" className="button-subtle" onClick={() => setPrecheckinDiscount(DEFAULT_PRECHECKIN_DISCOUNT)}>Reset</button>
              </div>
            </section>

            <section className="glass card section-card">
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="stack" style={{ gap: 6 }}>
                  <h3 style={{ margin: 0 }}>Auto-Send Pre-Check-in Invite</h3>
                  <div className="ui-muted">
                    Email the customer their pre-check-in link automatically before pickup, so more guests arrive checked in.
                    Manual sends are respected (no duplicates), and emails go out branded in the customer&apos;s language.
                  </div>
                </div>
                <span className={`status-chip ${precheckinAutoEmail.enabled ? 'good' : 'neutral'}`}>
                  {precheckinAutoEmail.enabled ? 'On' : 'Off'}
                </span>
              </div>

              <div className="form-grid-2" style={{ marginTop: 14 }}>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!precheckinAutoEmail.enabled}
                    onChange={(e) => setPrecheckinAutoEmail((c) => ({ ...c, enabled: e.target.checked }))}
                  /> Enable automatic pre-check-in invite
                </label>
                <div className="surface-note">
                  Off by default. When enabled, a sweep runs hourly and sends the invite to reservations whose pickup is within the window below.
                </div>
              </div>

              {precheckinAutoEmail.enabled && (
                <>
                  <div className="form-grid-2" style={{ marginTop: 12 }}>
                    <div>
                      <label className="label">Send how early</label>
                      <select
                        value={Number(precheckinAutoEmail.leadHours) || 48}
                        onChange={(e) => {
                          const leadHours = Number(e.target.value);
                          setPrecheckinAutoEmail((c) => {
                            const opts = [24, 48].filter((h) => h < leadHours);
                            const reminderLeadHours = opts.includes(Number(c.reminderLeadHours)) ? Number(c.reminderLeadHours) : (opts.length ? opts[opts.length - 1] : 24);
                            return { ...c, leadHours, reminderLeadHours };
                          });
                        }}
                      >
                        <option value={24}>24 hours before pickup</option>
                        <option value={48}>48 hours before pickup</option>
                        <option value={72}>72 hours before pickup</option>
                      </select>
                    </div>
                    <div className="surface-note">
                      The invite goes out once, this many hours before the pickup time.
                    </div>
                  </div>

                  <div className="form-grid-2" style={{ marginTop: 12 }}>
                    <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={!!precheckinAutoEmail.reminderEnabled}
                        onChange={(e) => setPrecheckinAutoEmail((c) => ({ ...c, reminderEnabled: e.target.checked }))}
                      /> Send a reminder if not completed
                    </label>
                    <div className="surface-note">
                      A single nudge closer to pickup if the customer hasn&apos;t finished their pre-check-in.
                    </div>
                  </div>

                  {precheckinAutoEmail.reminderEnabled && (
                    <div className="form-grid-2" style={{ marginTop: 12 }}>
                      <div>
                        <label className="label">Reminder timing</label>
                        {[24, 48].filter((h) => h < (Number(precheckinAutoEmail.leadHours) || 48)).length ? (
                          <select
                            value={Number(precheckinAutoEmail.reminderLeadHours) || 24}
                            onChange={(e) => setPrecheckinAutoEmail((c) => ({ ...c, reminderLeadHours: Number(e.target.value) }))}
                          >
                            {[24, 48].filter((h) => h < (Number(precheckinAutoEmail.leadHours) || 48)).map((h) => (
                              <option key={h} value={h}>{h} hours before pickup</option>
                            ))}
                          </select>
                        ) : (
                          <div className="surface-note">Set &quot;Send how early&quot; to 48 or 72 hours to enable a separate reminder.</div>
                        )}
                      </div>
                      <div className="surface-note">
                        Must be closer to pickup than the invite. Reminders only go to customers who still haven&apos;t completed pre-check-in.
                      </div>
                    </div>
                  )}

                  <div className="surface-note" style={{ marginTop: 12 }}>
                    Summary: invite sent {Number(precheckinAutoEmail.leadHours) || 48}h before pickup{precheckinAutoEmail.reminderEnabled && [24, 48].filter((h) => h < (Number(precheckinAutoEmail.leadHours) || 48)).length ? `, reminder ${Number(precheckinAutoEmail.reminderLeadHours) || 24}h before` : ''}.
                  </div>
                </>
              )}

              <div className="inline-actions" style={{ marginTop: 12 }}>
                <button type="button" onClick={savePrecheckinAutoEmail}>Save Auto-Email Settings</button>
                <button type="button" className="button-subtle" onClick={() => setPrecheckinAutoEmail(DEFAULT_PRECHECKIN_AUTO_EMAIL)}>Reset</button>
              </div>
            </section>
          </div>
        )}

        {tab === 'revenue' && (
          <div className="stack">
            <h2>Revenue / Dynamic Pricing</h2>
            <div className="surface-note">
              Configure tenant-level pricing uplift rules based on weekend demand, lead time, utilization, and shortage pressure.
            </div>

            <section className="glass card section-card">
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="stack" style={{ gap: 6 }}>
                  <h3 style={{ margin: 0 }}>Revenue Rules</h3>
                  <div className="ui-muted">
                    This foundation stays explainable: it starts from the standard rate table, then layers capped demand-based uplifts.
                  </div>
                </div>
                <span className={`status-chip ${revenuePricingConfig.enabled ? 'good' : 'neutral'}`}>
                  {revenuePricingConfig.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>

              <div className="form-grid-2">
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!revenuePricingConfig.enabled}
                    onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, enabled: e.target.checked }))}
                  /> Enable revenue recommendations for this tenant
                </label>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!revenuePricingConfig.applyToPublicQuotes}
                    onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, applyToPublicQuotes: e.target.checked }))}
                  /> Apply recommended uplift to public booking quotes
                </label>
              </div>

              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Recommendation Mode</label>
                  <select
                    value={revenuePricingConfig.recommendationMode || 'ADVISORY'}
                    onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, recommendationMode: e.target.value }))}
                  >
                    <option value="ADVISORY">Advisory</option>
                    <option value="AUTOPILOT">Autopilot Ready</option>
                  </select>
                  <div className="ui-muted">
                    `Advisory` explains the uplift. `Autopilot Ready` prepares us for automatic execution in future slices.
                  </div>
                </div>
                <div className="surface-note">
                  Tenant plan: <strong>{revenuePricingConfig.tenantPlan || 'BETA'}</strong>
                  <div style={{ marginTop: 8 }}>
                    Public quote behavior: <strong>{revenuePricingConfig.applyToPublicQuotes ? 'Lifted quotes enabled' : 'Preview only'}</strong>
                  </div>
                </div>
              </div>

              <div className="form-grid-3">
                <div className="stack">
                  <label className="label">Weekend Markup %</label>
                  <input type="number" min="0" step="0.01" value={revenuePricingConfig.weekendMarkupPct} onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, weekendMarkupPct: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Short Lead Window (days)</label>
                  <input type="number" min="0" step="1" value={revenuePricingConfig.shortLeadWindowDays} onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, shortLeadWindowDays: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Short Lead Markup %</label>
                  <input type="number" min="0" step="0.01" value={revenuePricingConfig.shortLeadMarkupPct} onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, shortLeadMarkupPct: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Last Minute Window (days)</label>
                  <input type="number" min="0" step="1" value={revenuePricingConfig.lastMinuteWindowDays} onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, lastMinuteWindowDays: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Last Minute Markup %</label>
                  <input type="number" min="0" step="0.01" value={revenuePricingConfig.lastMinuteMarkupPct} onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, lastMinuteMarkupPct: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Shortage Markup %</label>
                  <input type="number" min="0" step="0.01" value={revenuePricingConfig.shortageMarkupPct} onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, shortageMarkupPct: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Utilization Medium Threshold %</label>
                  <input type="number" min="0" max="100" step="0.01" value={revenuePricingConfig.utilizationMediumThresholdPct} onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, utilizationMediumThresholdPct: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Utilization Medium Markup %</label>
                  <input type="number" min="0" step="0.01" value={revenuePricingConfig.utilizationMediumMarkupPct} onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, utilizationMediumMarkupPct: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Utilization High Threshold %</label>
                  <input type="number" min="0" max="100" step="0.01" value={revenuePricingConfig.utilizationHighThresholdPct} onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, utilizationHighThresholdPct: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Utilization High Markup %</label>
                  <input type="number" min="0" step="0.01" value={revenuePricingConfig.utilizationHighMarkupPct} onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, utilizationHighMarkupPct: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Utilization Critical Threshold %</label>
                  <input type="number" min="0" max="100" step="0.01" value={revenuePricingConfig.utilizationCriticalThresholdPct} onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, utilizationCriticalThresholdPct: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Utilization Critical Markup %</label>
                  <input type="number" min="0" step="0.01" value={revenuePricingConfig.utilizationCriticalMarkupPct} onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, utilizationCriticalMarkupPct: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Max Total Adjustment %</label>
                  <input type="number" min="0" step="0.01" value={revenuePricingConfig.maxAdjustmentPct} onChange={(e) => setRevenuePricingConfig((current) => ({ ...current, maxAdjustmentPct: e.target.value }))} />
                </div>
              </div>

              <div className="inline-actions">
                <button type="button" onClick={saveRevenuePricingConfig}>Save Revenue Rules</button>
                <button
                  type="button"
                  className="button-subtle"
                  onClick={() => setRevenuePricingConfig(DEFAULT_REVENUE_PRICING_CONFIG)}
                >
                  Reset to Defaults
                </button>
              </div>
            </section>

            <section className="glass card section-card">
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="stack" style={{ gap: 6 }}>
                  <h3 style={{ margin: 0 }}>Recommendation Preview</h3>
                  <div className="ui-muted">
                    Run a sample quote against the current tenant rules before deciding whether to apply these adjustments publicly.
                  </div>
                </div>
                <span className={`status-chip ${revenuePricingPreviewResult?.enabled ? 'good' : 'neutral'}`}>
                  {revenuePricingPreviewResult?.enabled ? 'Live Preview' : 'Preview'}
                </span>
              </div>

              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Vehicle Type</label>
                  <select value={revenuePricingPreview.vehicleTypeId} onChange={(e) => setRevenuePricingPreview((current) => ({ ...current, vehicleTypeId: e.target.value }))}>
                    <option value="">Select vehicle type</option>
                    {vehicleTypes.map((vehicleType) => (
                      <option key={vehicleType.id} value={vehicleType.id}>
                        {vehicleType.code} - {vehicleType.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="stack">
                  <label className="label">Pickup Location</label>
                  <select value={revenuePricingPreview.pickupLocationId} onChange={(e) => setRevenuePricingPreview((current) => ({ ...current, pickupLocationId: e.target.value }))}>
                    <option value="">Any matching rate scope</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.code} - {location.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="stack">
                  <label className="label">Pickup</label>
                  <input type="datetime-local" value={revenuePricingPreview.pickupAt} onChange={(e) => setRevenuePricingPreview((current) => ({ ...current, pickupAt: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Return</label>
                  <input type="datetime-local" value={revenuePricingPreview.returnAt} onChange={(e) => setRevenuePricingPreview((current) => ({ ...current, returnAt: e.target.value }))} />
                </div>
              </div>

              <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={!!revenuePricingPreview.displayOnline}
                  onChange={(e) => setRevenuePricingPreview((current) => ({ ...current, displayOnline: e.target.checked }))}
                /> Use online-display rates only
              </label>

              <div className="inline-actions">
                <button type="button" onClick={runRevenuePricingPreview}>Run Preview</button>
              </div>

              {revenuePricingPreviewResult ? (
                <div className="stack" style={{ gap: 12 }}>
                  <div className="app-card-grid compact">
                    <div className="info-tile">
                      <span className="label">Base Daily</span>
                      <strong>${Number(revenuePricingPreviewResult.baseQuote?.dailyRate || 0).toFixed(2)}</strong>
                    </div>
                    <div className="info-tile">
                      <span className="label">Recommended Daily</span>
                      <strong>${Number(revenuePricingPreviewResult.recommendedDailyRate || 0).toFixed(2)}</strong>
                    </div>
                    <div className="info-tile">
                      <span className="label">Base Total</span>
                      <strong>${Number(revenuePricingPreviewResult.baseQuote?.baseTotal || 0).toFixed(2)}</strong>
                    </div>
                    <div className="info-tile">
                      <span className="label">Recommended Total</span>
                      <strong>${Number(revenuePricingPreviewResult.recommendedBaseTotal || 0).toFixed(2)}</strong>
                    </div>
                    <div className="info-tile">
                      <span className="label">Adjustment</span>
                      <strong>{Number(revenuePricingPreviewResult.adjustmentPct || 0).toFixed(2)}%</strong>
                    </div>
                    <div className="info-tile">
                      <span className="label">Peak Utilization</span>
                      <strong>{Number((revenuePricingPreviewResult.metrics?.peakUtilizationPct ?? revenuePricingPreviewResult.metrics?.utilizationPct) || 0).toFixed(2)}%</strong>
                    </div>
                    <div className="info-tile">
                      <span className="label">Average Utilization</span>
                      <strong>{Number(revenuePricingPreviewResult.metrics?.averageUtilizationPct || 0).toFixed(2)}%</strong>
                    </div>
                    <div className="info-tile">
                      <span className="label">Pressure Days</span>
                      <strong>{Number(revenuePricingPreviewResult.metrics?.pressureDaysCount || 0)}</strong>
                    </div>
                  </div>

                  <div className="surface-note">
                    {revenuePricingPreviewResult.summary || 'No summary available.'}
                    <div style={{ marginTop: 8 }}>
                      Lead time: <strong>{Number(revenuePricingPreviewResult.metrics?.leadTimeDays || 0).toFixed(2)} days</strong>
                      {' · '}
                      Peak date: <strong>{revenuePricingPreviewResult.metrics?.peakPressureDate || '—'}</strong>
                      {' · '}
                      Peak band: <strong>{revenuePricingPreviewResult.metrics?.peakPressureBand || 'NORMAL'}</strong>
                      {' · '}
                      Peak shortage: <strong>{Number((revenuePricingPreviewResult.metrics?.peakShortageUnits ?? revenuePricingPreviewResult.metrics?.shortageUnits) || 0)}</strong>
                    </div>
                  </div>

                  <div className="glass card" style={{ padding: 12 }}>
                    <h4 style={{ marginTop: 0 }}>Active Factors</h4>
                    {(revenuePricingPreviewResult.factors || []).length ? (
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {(revenuePricingPreviewResult.factors || []).map((factor) => (
                          <li key={`${factor.code}-${factor.adjustmentPct}`}>
                            <strong>{factor.label}</strong>
                            {' '}
                            (+{Number(factor.adjustmentPct || 0).toFixed(2)}%) — {factor.reason}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="ui-muted">No uplift factors triggered for this request.</div>
                    )}
                  </div>

                  {(revenuePricingPreviewResult.recommendedDailyBreakdown || []).length ? (
                    <div className="glass card" style={{ padding: 12 }}>
                      <h4 style={{ marginTop: 0 }}>Date-Level Demand Curve</h4>
                      <div style={{ overflowX: 'auto' }}>
                        <table className="table">
                          <thead>
                            <tr>
                              <th>Date</th>
                              <th>Demand</th>
                              <th>Available</th>
                              <th>Utilization</th>
                              <th>Band</th>
                              <th>Base Daily</th>
                              <th>Recommended</th>
                              <th>Adj %</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(revenuePricingPreviewResult.recommendedDailyBreakdown || []).map((row) => (
                              <tr key={row.date}>
                                <td>{row.date}</td>
                                <td>{Number(row.demandCount || 0)}</td>
                                <td>{Number(row.availableUnits || 0)}</td>
                                <td>{Number(row.utilizationPct || 0).toFixed(2)}%</td>
                                <td>{row.pressureBand || 'NORMAL'}</td>
                                <td>${Number(row.baseDailyRate || 0).toFixed(2)}</td>
                                <td>${Number(row.recommendedDailyRate || 0).toFixed(2)}</td>
                                <td>{Number(row.adjustmentPct || 0).toFixed(2)}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          </div>
        )}

        {tab === 'carSharing' && (
          <div className="stack">
            <h2>Car Sharing Search Place Presets</h2>
            <div className="surface-note">
              Create tenant-approved airports, hotels, neighborhoods, and stations so guests can search meaningful places without depending only on host pickup spots. This is the layer that should feel closer to a marketplace like Turo, while still staying tenant-governed.
            </div>

            <section className="glass card section-card">
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="stack" style={{ gap: 6 }}>
                  <h3 style={{ margin: 0 }}>{carSharingPresetForm.id ? 'Edit Search Place Preset' : 'Create Search Place Preset'}</h3>
                  <div className="ui-muted">
                    Use these presets for airports, hotels, neighborhoods, and other canonical guest search places.
                  </div>
                </div>
                {carSharingPresetForm.id ? (
                  <button type="button" className="button-subtle" onClick={() => setCarSharingPresetForm(DEFAULT_CAR_SHARING_PRESET)}>Clear</button>
                ) : null}
              </div>

              <div className="form-grid-3">
                <div className="stack">
                  <label className="label">Place Type</label>
                  <select value={carSharingPresetForm.placeType} onChange={(e) => setCarSharingPresetForm((current) => ({ ...current, placeType: e.target.value }))}>
                    <option value="AIRPORT">Airport</option>
                    <option value="HOTEL">Hotel</option>
                    <option value="NEIGHBORHOOD">Neighborhood</option>
                    <option value="STATION">Station</option>
                    <option value="TENANT_BRANCH">Tenant Branch Search Place</option>
                  </select>
                </div>
                <div className="stack">
                  <label className="label">Internal Label</label>
                  <input value={carSharingPresetForm.label} onChange={(e) => setCarSharingPresetForm((current) => ({ ...current, label: e.target.value }))} placeholder="SJU Airport" />
                </div>
                <div className="stack">
                  <label className="label">Public Label</label>
                  <input value={carSharingPresetForm.publicLabel} onChange={(e) => setCarSharingPresetForm((current) => ({ ...current, publicLabel: e.target.value }))} placeholder="San Juan Airport" />
                </div>
                <div className="stack">
                  <label className="label">Anchor Location</label>
                  <select value={carSharingPresetForm.anchorLocationId} onChange={(e) => setCarSharingPresetForm((current) => ({ ...current, anchorLocationId: e.target.value }))}>
                    <option value="">No anchor location</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>{location.name}</option>
                    ))}
                  </select>
                </div>
                <div className="stack">
                  <label className="label">Visibility Mode</label>
                  <select value={carSharingPresetForm.visibilityMode} onChange={(e) => setCarSharingPresetForm((current) => ({ ...current, visibilityMode: e.target.value }))}>
                    <option value="APPROXIMATE_ONLY">Approximate only</option>
                    <option value="REVEAL_AFTER_BOOKING">Reveal after booking</option>
                    <option value="PUBLIC_EXACT">Public exact</option>
                  </select>
                </div>
                <div className="stack">
                  <label className="label">Radius Miles</label>
                  <input type="number" min="0" value={carSharingPresetForm.radiusMiles} onChange={(e) => setCarSharingPresetForm((current) => ({ ...current, radiusMiles: e.target.value }))} placeholder="Optional" />
                </div>
                <div className="stack">
                  <label className="label">City</label>
                  <input value={carSharingPresetForm.city} onChange={(e) => setCarSharingPresetForm((current) => ({ ...current, city: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">State</label>
                  <input value={carSharingPresetForm.state} onChange={(e) => setCarSharingPresetForm((current) => ({ ...current, state: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Postal Code</label>
                  <input value={carSharingPresetForm.postalCode} onChange={(e) => setCarSharingPresetForm((current) => ({ ...current, postalCode: e.target.value }))} />
                </div>
                <div className="stack">
                  <label className="label">Country</label>
                  <input value={carSharingPresetForm.country} onChange={(e) => setCarSharingPresetForm((current) => ({ ...current, country: e.target.value }))} />
                </div>
              </div>

              <div className="form-grid-2">
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input type="checkbox" checked={!!carSharingPresetForm.searchable} onChange={(e) => setCarSharingPresetForm((current) => ({ ...current, searchable: e.target.checked }))} /> Searchable in marketplace
                </label>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input type="checkbox" checked={!!carSharingPresetForm.isActive} onChange={(e) => setCarSharingPresetForm((current) => ({ ...current, isActive: e.target.checked }))} /> Active
                </label>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input type="checkbox" checked={!!carSharingPresetForm.pickupEligible} onChange={(e) => setCarSharingPresetForm((current) => ({ ...current, pickupEligible: e.target.checked }))} /> Pickup eligible
                </label>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input type="checkbox" checked={!!carSharingPresetForm.deliveryEligible} onChange={(e) => setCarSharingPresetForm((current) => ({ ...current, deliveryEligible: e.target.checked }))} /> Delivery eligible
                </label>
              </div>

              <div className="inline-actions">
                <button type="button" onClick={saveCarSharingPreset}>{carSharingPresetForm.id ? 'Save Preset' : 'Create Preset'}</button>
              </div>
            </section>

            <section className="glass card section-card">
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="stack" style={{ gap: 6 }}>
                  <h3 style={{ margin: 0 }}>Preset Library</h3>
                  <div className="ui-muted">
                    These search places appear as tenant-curated destinations for car sharing search.
                  </div>
                </div>
                <span className="status-chip neutral">{carSharingSearchPlaces.length} presets</span>
              </div>

              {carSharingSearchPlaces.length ? (
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Public Label</th>
                        <th>City</th>
                        <th>Anchor</th>
                        <th>Visibility</th>
                        <th>Search</th>
                        <th>Eligibility</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {carSharingSearchPlaces.map((place) => (
                        <tr key={place.id}>
                          <td>{String(place.placeType || '').replace(/_/g, ' ')}</td>
                          <td>{place.publicLabel || place.label}</td>
                          <td>{[place.city, place.state].filter(Boolean).join(', ') || '—'}</td>
                          <td>{place.anchorLocation?.name || '—'}</td>
                          <td>{String(place.visibilityMode || '').replace(/_/g, ' ')}</td>
                          <td>{place.searchable ? 'Yes' : 'No'}</td>
                          <td>{[place.pickupEligible ? 'Pickup' : '', place.deliveryEligible ? 'Delivery' : ''].filter(Boolean).join(' / ') || '—'}</td>
                          <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button type="button" onClick={() => setCarSharingPresetForm({
                              id: place.id,
                              placeType: place.placeType || 'AIRPORT',
                              label: place.label || '',
                              publicLabel: place.publicLabel || '',
                              anchorLocationId: place.anchorLocationId || '',
                              city: place.city || '',
                              state: place.state || '',
                              postalCode: place.postalCode || '',
                              country: place.country || 'Puerto Rico',
                              radiusMiles: place.radiusMiles == null ? '' : String(place.radiusMiles),
                              visibilityMode: place.visibilityMode || 'APPROXIMATE_ONLY',
                              searchable: !!place.searchable,
                              isActive: !!place.isActive,
                              pickupEligible: !!place.pickupEligible,
                              deliveryEligible: !!place.deliveryEligible
                            })}>Edit</button>
                            <button type="button" className="button-subtle" onClick={() => removeCarSharingPreset(place.id)}>Remove</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="surface-note">
                  No search place presets yet. Start with airports, top hotels, and neighborhoods so the marketplace search feels more natural for guests.
                </div>
              )}
            </section>
          </div>
        )}

        {tab === 'telematics' && (
          <div className="stack">
            <h2>Telematics</h2>
            <div className="surface-note">
              Turn telematics on per tenant, choose the target provider, and control whether manual ingest or the Zubie connector placeholder can be used for this customer.
            </div>

            <section className="glass card section-card">
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="stack" style={{ gap: 6 }}>
                  <h3 style={{ margin: 0 }}>Tenant Telematics Access</h3>
                  <div className="ui-muted">
                    This controls telematics device linking, manual ping ingest, and the Zubie connector stub for the current tenant.
                  </div>
                </div>
                <span className={`status-chip ${telematicsConfig.ready ? 'good' : telematicsConfig.enabled ? 'warn' : 'neutral'}`}>
                  {telematicsConfig.ready ? 'Ready' : telematicsConfig.enabled ? 'Plan Blocked' : 'Disabled'}
                </span>
              </div>

              <div className="form-grid-2">
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!telematicsConfig.enabled}
                    onChange={(e) => setTelematicsConfig((current) => ({ ...current, enabled: e.target.checked }))}
                  /> Enable telematics for this tenant
                </label>
                <div className="surface-note">
                  Tenant plan: <strong>{telematicsConfig.tenantPlan || 'BETA'}</strong>
                  <div style={{ marginTop: 8 }}>
                    Plan inclusion: <strong>{telematicsConfig.planDefaults?.telematicsIncluded ? 'Included in package' : 'Not included in package'}</strong>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    Runtime status: <strong>{telematicsConfig.ready ? 'Feature can be used now' : telematicsConfig.enabled ? 'Enabled here but blocked by package policy' : 'Feature disabled for this tenant'}</strong>
                  </div>
                </div>
              </div>

              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Provider</label>
                  <select value={telematicsConfig.provider || 'ZUBIE'} onChange={(e) => setTelematicsConfig((current) => ({ ...current, provider: e.target.value }))}>
                    <option value="ZUBIE">Zubie</option>
                    <option value="VOLTSWITCH">Voltswitch GPS</option>
                    <option value="GENERIC">Generic</option>
                    <option value="SAMSARA">Samsara</option>
                    <option value="GEOTAB">Geotab</option>
                    <option value="AZUGA">Azuga</option>
                  </select>
                </div>
                <div className="surface-note">
                  Current target provider: <strong>{telematicsConfig.provider === 'ZUBIE' ? 'Zubie' : (telematicsConfig.provider || 'ZUBIE')}</strong>
                  <div style={{ marginTop: 8 }}>
                    {String(telematicsConfig.provider || '').toUpperCase() === 'ZUBIE'
                      ? 'Zubie is the preferred rental-fleet placeholder and the first connector target for this tenant.'
                      : 'This provider is being held as a future connector target or generic fallback.'}
                  </div>
                </div>
              </div>

              <div className="form-grid-2">
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!telematicsConfig.allowManualEventIngest}
                    onChange={(e) => setTelematicsConfig((current) => ({ ...current, allowManualEventIngest: e.target.checked }))}
                  /> Allow manual telematics event ingest from the vehicle profile
                </label>
                <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!telematicsConfig.allowZubieConnector}
                    onChange={(e) => setTelematicsConfig((current) => ({ ...current, allowZubieConnector: e.target.checked }))}
                  /> Allow Zubie connector placeholder endpoint for this tenant
                </label>
              </div>

              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Zubie Webhook Auth</label>
                  <select
                    value={telematicsConfig.webhookAuthMode || 'HEADER_SECRET'}
                    onChange={(e) => setTelematicsConfig((current) => ({ ...current, webhookAuthMode: e.target.value }))}
                    disabled={String(telematicsConfig.provider || '').toUpperCase() !== 'ZUBIE'}
                  >
                    <option value="HEADER_SECRET">Header Secret</option>
                    <option value="NONE">No Verification</option>
                  </select>
                  <div className="ui-muted">
                    Use Header Secret for the public Zubie webhook. `No Verification` is only for controlled testing.
                  </div>
                </div>
                <div className="stack">
                  <label className="label">Zubie Webhook Secret</label>
                  <input
                    type="password"
                    placeholder={telematicsConfig.hasZubieWebhookSecret ? 'Secret already saved' : 'Paste shared secret'}
                    value={telematicsConfig.zubieWebhookSecret || ''}
                    onChange={(e) => setTelematicsConfig((current) => ({ ...current, zubieWebhookSecret: e.target.value, clearZubieWebhookSecret: false }))}
                    disabled={String(telematicsConfig.provider || '').toUpperCase() !== 'ZUBIE'}
                  />
                  <div className="ui-muted">
                    {telematicsConfig.hasZubieWebhookSecret
                      ? `Current secret: ${telematicsConfig.zubieWebhookSecretMasked || 'Saved'}`
                      : 'No tenant webhook secret saved yet.'}
                  </div>
                  <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={!!telematicsConfig.clearZubieWebhookSecret}
                      onChange={(e) => setTelematicsConfig((current) => ({
                        ...current,
                        clearZubieWebhookSecret: e.target.checked,
                        zubieWebhookSecret: e.target.checked ? '' : current.zubieWebhookSecret
                      }))}
                      disabled={String(telematicsConfig.provider || '').toUpperCase() !== 'ZUBIE' || !telematicsConfig.hasZubieWebhookSecret}
                    /> Clear saved webhook secret on next save
                  </label>
                </div>
              </div>

              {String(telematicsConfig.provider || '').toUpperCase() === 'VOLTSWITCH' && (
                <>
                  <div className="form-grid-2">
                    <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={!!telematicsConfig.allowVoltswitchConnector}
                        onChange={(e) => setTelematicsConfig((current) => ({ ...current, allowVoltswitchConnector: e.target.checked }))}
                      /> Enable the Voltswitch pull connector for this tenant
                    </label>
                    <div className="surface-note">
                      Connector status: <strong>{telematicsConfig.voltswitchConnectorReady ? 'Ready — syncing on schedule' : 'Not ready'}</strong>
                      <div style={{ marginTop: 8 }}>
                        Needs provider Voltswitch, the connector enabled, and API credentials saved. The worker then pulls device positions automatically.
                      </div>
                    </div>
                  </div>

                  <div className="form-grid-2">
                    <div className="stack">
                      <label className="label">Voltswitch API Email</label>
                      <input
                        type="text"
                        placeholder="account email for app.voltswitchgps.com"
                        value={telematicsConfig.voltswitchApiEmail || ''}
                        onChange={(e) => setTelematicsConfig((current) => ({ ...current, voltswitchApiEmail: e.target.value, clearVoltswitchCredentials: false }))}
                      />
                    </div>
                    <div className="stack">
                      <label className="label">Voltswitch API Password</label>
                      <input
                        type="password"
                        placeholder={telematicsConfig.hasVoltswitchCredentials ? 'Password already saved' : 'Account password'}
                        value={telematicsConfig.voltswitchApiPassword || ''}
                        onChange={(e) => setTelematicsConfig((current) => ({ ...current, voltswitchApiPassword: e.target.value, clearVoltswitchCredentials: false }))}
                      />
                      <div className="ui-muted">
                        {telematicsConfig.hasVoltswitchCredentials
                          ? `Saved: ${telematicsConfig.voltswitchApiPasswordMasked || 'yes'} — leave blank to keep it`
                          : 'No credentials saved yet.'}
                      </div>
                    </div>
                  </div>

                  <div className="form-grid-2">
                    <div className="stack">
                      <label className="label">Sync interval (minutes)</label>
                      <input
                        type="number"
                        min={1}
                        max={60}
                        value={telematicsConfig.voltswitchSyncIntervalMinutes ?? 5}
                        onChange={(e) => setTelematicsConfig((current) => ({ ...current, voltswitchSyncIntervalMinutes: e.target.value }))}
                      />
                      <div className="ui-muted">How often the worker pulls device locations (1–60 min).</div>
                    </div>
                    <div className="stack">
                      <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                        <input
                          type="checkbox"
                          checked={!!telematicsConfig.clearVoltswitchCredentials}
                          onChange={(e) => setTelematicsConfig((current) => ({
                            ...current,
                            clearVoltswitchCredentials: e.target.checked,
                            ...(e.target.checked ? { voltswitchApiEmail: '', voltswitchApiPassword: '' } : {})
                          }))}
                          disabled={!telematicsConfig.hasVoltswitchCredentials}
                        /> Clear saved credentials on next save
                      </label>
                      <div className="inline-actions" style={{ marginTop: 8 }}>
                        <button
                          type="button"
                          className="button-subtle"
                          onClick={runVoltswitchSyncNow}
                          disabled={voltswitchSyncBusy || !telematicsConfig.voltswitchConnectorReady}
                        >
                          {voltswitchSyncBusy ? 'Syncing…' : 'Sync devices now'}
                        </button>
                      </div>
                      {voltswitchSyncResult && !voltswitchSyncResult.error && (
                        <div className="ui-muted">
                          Synced {voltswitchSyncResult.synced ?? 0} devices ({(voltswitchSyncResult.devices || []).filter((d) => d.matched).length} matched to fleet vehicles by VIN/plate{voltswitchSyncResult.errors?.length ? `, ${voltswitchSyncResult.errors.length} errors` : ''}).
                        </div>
                      )}
                      {voltswitchSyncResult?.error && (
                        <div className="ui-muted">Sync failed: {voltswitchSyncResult.error}</div>
                      )}
                    </div>
                  </div>
                </>
              )}

              <div className="inline-actions">
                <button type="button" onClick={saveTelematicsConfig}>Save Telematics</button>
                <button
                  type="button"
                  className="button-subtle"
                  onClick={() => setTelematicsConfig((current) => ({
                    ...current,
                    enabled: !!current?.planDefaults?.telematicsIncluded,
                    provider: 'ZUBIE',
                    allowManualEventIngest: true,
                    allowZubieConnector: true,
                    webhookAuthMode: 'HEADER_SECRET',
                    zubieWebhookSecret: '',
                    clearZubieWebhookSecret: false
                  }))}
                >
                  Apply Plan Defaults
                </button>
              </div>
            </section>

            {/* OneStepGPS connector (2026-08-24): API key + device↔vehicle mapping,
                per the approved mockups. Factored into its own component so this
                page does not grow — it talks only to
                /api/admin/integrations/onestepgps. Rendered unconditionally in
                this tab: the key lives in IntegrationCredential, independent of
                the telematicsConfig provider dropdown above (which the settings
                blob save can therefore never erase). */}
            <OneStepGpsConnectorTab
              token={token}
              scopedSettingsPath={scopedSettingsPath}
              onPageMsg={setMsg}
            />

            <section className="glass card section-card">
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="stack" style={{ gap: 6 }}>
                  <h3 style={{ margin: 0 }}>Commercial Package Snapshot</h3>
                  <div className="ui-muted">
                    This shows what the current tenant plan includes by default for telematics and inspection-linked intelligence.
                  </div>
                </div>
                <span className="status-chip neutral">{telematicsConfig.tenantPlan || 'BETA'}</span>
              </div>
              <div className="app-card-grid compact">
                <div className="info-tile">
                  <span className="label">Telematics</span>
                  <strong>{telematicsConfig.planDefaults?.telematicsIncluded ? 'Included' : 'Not included'}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">Inspection Intelligence</span>
                  <strong>{telematicsConfig.planDefaults?.inspectionIntelligenceIncluded ? 'Included' : 'Not included'}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">Tenant Toggle</span>
                  <strong>{telematicsConfig.enabled ? 'On' : 'Off'}</strong>
                </div>
                <div className="info-tile">
                  <span className="label">Provider Target</span>
                  <strong>{telematicsConfig.provider || 'ZUBIE'}</strong>
                </div>
              </div>
              <div className="surface-note">
                Public webhook path:
                {' '}
                <strong>{API_BASE}/api/public/telematics/zubie/{activeSettingsTenantId || me?.tenantId || 'tenantId'}/webhook</strong>
                <div style={{ marginTop: 8 }}>
                  Public webhook status:
                  {' '}
                  <strong>{telematicsConfig.publicWebhookReady ? 'Ready' : 'Needs config'}</strong>
                </div>
                <div style={{ marginTop: 8 }}>
                  Expected header:
                  {' '}
                  <strong>
                    {String(telematicsConfig.webhookAuthMode || 'HEADER_SECRET').toUpperCase() === 'HEADER_SECRET'
                      ? 'x-zubie-webhook-secret'
                      : 'No secret header required'}
                  </strong>
                </div>
              </div>
            </section>
          </div>
        )}

        {tab === 'marketIntel' && (
          <div className="stack">
            <h2>Market Intelligence</h2>
            <section className="glass card section-card">
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="stack" style={{ gap: 6 }}>
                  <h3 style={{ margin: 0 }}>Onboarding wizard</h3>
                  <div className="ui-muted">Stand up market-based pricing in 4 steps (airports → discovery → SIPP mapping → guardrails). Creates rules in SUGGEST mode — nothing auto-applies.</div>
                </div>
                <button type="button" onClick={() => { window.location.href = '/market/onboarding'; }}>Open wizard</button>
              </div>
            </section>
            <section className="glass card section-card">
              <div className="stack" style={{ gap: 6 }}>
                <h3 style={{ margin: 0 }}>Dashboard SIPP picker</h3>
                <div className="ui-muted">
                  Pick up to {dashboardSipps.max || 6} vehicle classes (SIPP codes) to pin to the
                  Market Intelligence dashboard card, in the order you tap them. Leave empty to show
                  the top {dashboardSipps.max || 6} by market volume.
                </div>
              </div>
              <div className="ui-muted" style={{ marginTop: 8 }}>
                Selected: {dashboardSipps.sipps.length}/{dashboardSipps.max || 6}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {(dashboardSipps.options || []).map((code) => {
                  const selected = dashboardSipps.sipps.includes(code);
                  const atCap = !selected && dashboardSipps.sipps.length >= (dashboardSipps.max || 6);
                  return (
                    <button
                      key={code}
                      type="button"
                      onClick={() => toggleDashboardSipp(code)}
                      disabled={atCap}
                      className={selected ? '' : 'button-subtle'}
                      title={atCap ? `Limit of ${dashboardSipps.max || 6} reached` : ''}
                      style={{ opacity: atCap ? 0.5 : 1 }}
                    >
                      {selected ? '✓ ' : ''}{code} · {SIPP_LABELS[code] || code}
                    </button>
                  );
                })}
              </div>
              <div className="inline-actions" style={{ marginTop: 14 }}>
                <button type="button" onClick={saveDashboardSipps}>Save Dashboard SIPPs</button>
                <button
                  type="button"
                  className="button-subtle"
                  onClick={() => setDashboardSipps((current) => ({ ...current, sipps: [] }))}
                >
                  Clear (use top 6)
                </button>
              </div>
            </section>
            <section className="glass card section-card">
              <div className="stack" style={{ gap: 6 }}>
                <h3 style={{ margin: 0 }}>Excluded competitors</h3>
                <div className="ui-muted">
                  Vendors to drop from the competitor pool for this tenant — list your own
                  brand(s) here so the pricing engine never compares against yourself, plus any
                  brokers/vendors you don&apos;t want counted. One per line. Spelling variants are
                  matched automatically (e.g. &quot;U-Save Car Rental&quot; = &quot;U-Save&quot;).
                </div>
              </div>
              <textarea
                value={excludedVendorsText}
                onChange={(e) => setExcludedVendorsText(e.target.value)}
                rows={5}
                placeholder={'ZezGo\nRoutes\nCarwiz'}
                style={{ width: '100%', marginTop: 10, fontFamily: 'inherit' }}
              />
              <div className="inline-actions" style={{ marginTop: 12 }}>
                <button type="button" onClick={saveMarketExcludedVendors}>Save excluded competitors</button>
                <button
                  type="button"
                  className="button-subtle"
                  onClick={() => setExcludedVendorsText('')}
                >
                  Clear
                </button>
              </div>
            </section>
            <section className="glass card section-card">
              <div className="stack" style={{ gap: 6 }}>
                <h3 style={{ margin: 0 }}>Tax-aware pricing config (per location)</h3>
                <div className="ui-muted">
                  Lets the engine back-solve the BASE rate to upload from a target all-in price,
                  undoing Expedia&apos;s taxes + fees + brokerage. A location WITHOUT a config keeps the
                  old behavior (no gross-up). <strong>Titanium:</strong> all-in = base × (1 + taxes) ×
                  (1 + brokerage). <strong>Amadeus:</strong> all-in = base × (1 + brokerage) + base ×
                  taxes.
                </div>
              </div>
              {(pricingConfigs.configs || []).length > 0 && (
                <div className="stack" style={{ gap: 6, marginTop: 10 }}>
                  {pricingConfigs.configs.map((c) => (
                    <div key={c.locationCode} className="row-between" style={{ alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                      <div className="ui-muted" style={{ fontSize: 13 }}>
                        <strong>{c.locationCode}</strong> · {c.connectionType} · taxes {taxesToText(c.taxes) || '—'} · brokerage {c.brokeragePct}% · floor {c.floorBase == null ? '—' : `$${c.floorBase}`} · ceiling {c.ceilingBase == null ? '—' : `$${c.ceilingBase}`} · max move {c.maxDeltaPct == null ? '—' : `${c.maxDeltaPct}%`} · tiers {Array.isArray(c.utilizationRules) && c.utilizationRules.length ? c.utilizationRules.length : '—'}
                      </div>
                      <div className="inline-actions">
                        <button type="button" className="button-subtle" onClick={() => editPricingConfig(c)}>Edit</button>
                        <button type="button" className="button-subtle" onClick={() => deletePricingConfig(c.locationCode)}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginTop: 12 }}>
                <label className="stack" style={{ gap: 4 }}>
                  <span className="ui-muted">Location code</span>
                  <input value={pcDraft.locationCode} onChange={(e) => setPcDraft({ ...pcDraft, locationCode: e.target.value })} placeholder="SJU" />
                </label>
                <label className="stack" style={{ gap: 4 }}>
                  <span className="ui-muted">Connection</span>
                  <select value={pcDraft.connectionType} onChange={(e) => setPcDraft({ ...pcDraft, connectionType: e.target.value })}>
                    {(pricingConfigs.connectionTypes || ['TITANIUM', 'AMADEUS']).map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label className="stack" style={{ gap: 4 }}>
                  <span className="ui-muted">Taxes (name:pct, …)</span>
                  <input value={pcDraft.taxesText} onChange={(e) => setPcDraft({ ...pcDraft, taxesText: e.target.value })} placeholder="PR tax:11.5, Airport fee:10.5" />
                </label>
                <label className="stack" style={{ gap: 4 }}>
                  <span className="ui-muted">Brokerage %</span>
                  <input type="number" step="0.001" value={pcDraft.brokeragePct} onChange={(e) => setPcDraft({ ...pcDraft, brokeragePct: e.target.value })} placeholder="20.1" />
                </label>
                <label className="stack" style={{ gap: 4 }}>
                  <span className="ui-muted">Floor (base $)</span>
                  <input type="number" step="0.01" value={pcDraft.floorBase} onChange={(e) => setPcDraft({ ...pcDraft, floorBase: e.target.value })} placeholder="required for auto-apply" />
                </label>
                <label className="stack" style={{ gap: 4 }}>
                  <span className="ui-muted">Ceiling (base $)</span>
                  <input type="number" step="0.01" value={pcDraft.ceilingBase} onChange={(e) => setPcDraft({ ...pcDraft, ceilingBase: e.target.value })} placeholder="max auto-apply write" />
                </label>
                <label className="stack" style={{ gap: 4 }}>
                  <span className="ui-muted">Max move per run (%)</span>
                  <input type="number" step="0.001" min="0" max="100" value={pcDraft.maxDeltaPct} onChange={(e) => setPcDraft({ ...pcDraft, maxDeltaPct: e.target.value })} placeholder="e.g. 15" />
                </label>
              </div>
              <div className="ui-muted" style={{ fontSize: 12, marginTop: 8 }}>
                <strong>Auto-apply guardrails.</strong> Auto-apply stays <strong>on HOLD</strong> for a
                location — it reads and suggests but <strong>will not write a live price</strong> — until
                <strong> Floor</strong>, <strong>Ceiling</strong> and <strong>Max move per run</strong> are all
                set. Floor/Ceiling clamp the base rate auto-apply may upload; a single run that would move a
                live price by more than Max move per run is <strong>held for review</strong> instead of written.
              </div>
              <label className="stack" style={{ gap: 4, marginTop: 10 }}>
                <span className="ui-muted">Utilization tiers (one per line, &quot;fromPct =&gt; target&quot;) — when projected utilization at pickup reaches fromPct, target this position on the competitive ladder</span>
                <textarea
                  value={pcDraft.utilTiersText}
                  onChange={(e) => setPcDraft({ ...pcDraft, utilTiersText: e.target.value })}
                  rows={5}
                  placeholder={'50 => 3 cheapest\n70 => 5 cheapest\n85 => market\n90 => market +15%'}
                  style={{ width: '100%', fontFamily: 'inherit' }}
                />
                <span className="ui-muted" style={{ fontSize: 11 }}>
                  Targets: &quot;N cheapest&quot;, &quot;N expensive&quot;, &quot;market&quot; (median of competitors), &quot;market +15%&quot; / &quot;-10%&quot;, or &quot;cheapest -2&quot;. Below the lowest fromPct the base margin applies. Empty = no utilization tiers.
                </span>
              </label>
              {pcError && (
                <div role="alert" className="error" style={{ marginTop: 10, fontWeight: 600, fontSize: 13 }}>{pcError}</div>
              )}
              <div className="inline-actions" style={{ marginTop: 12 }}>
                <button type="button" onClick={savePricingConfig}>Save location config</button>
              </div>
            </section>
          </div>
        )}

        {tab === 'kioskUpsell' && (
          <KioskUpsellSettings token={token} scopedPath={scopedSettingsPath} />
        )}

        {tab === 'emails' && (
          <div className="stack">
            <h2>Email Templates</h2>
            <div className="label">Available placeholders: {'{{customerName}}'}, {'{{reservationNumber}}'}, {'{{link}}'}, {'{{expiresAt}}'}, {'{{agreementNumber}}'}, {'{{pickupAt}}'}, {'{{returnAt}}'}, {'{{total}}'}, {'{{amountPaid}}'}, {'{{amountDue}}'}, {'{{portalLink}}'}, {'{{companyName}}'}, {'{{companyAddress}}'}, {'{{companyPhone}}'}, {'{{pickupLocation}}'}, {'{{returnLocation}}'}, {'{{workflowMode}}'}, {'{{reportStart}}'}, {'{{reportEnd}}'}, {'{{reportDays}}'}, {'{{tenantName}}'}, {'{{locationName}}'}, {'{{reservationsCreated}}'}, {'{{checkedOut}}'}, {'{{checkedIn}}'}, {'{{availableFleet}}'}, {'{{migrationHeld}}'}, {'{{washHeld}}'}, {'{{maintenanceHeld}}'}, {'{{outOfServiceHeld}}'}, {'{{utilizationPct}}'}, {'{{collectedPayments}}'}, {'{{openBalance}}'}, {'{{fleetHoldSummary}}'}, {'{{topPickupSummary}}'}, {'{{statusSummary}}'}</div>

            <div className="glass card stack" style={{ padding: 12 }}>
              <h3>Request Signature</h3>
              <input placeholder="Subject" value={emailTemplates.requestSignatureSubject || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, requestSignatureSubject: e.target.value })} />
              <textarea rows={5} placeholder="Body (text)" value={emailTemplates.requestSignatureBody || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, requestSignatureBody: e.target.value })} />
              <textarea rows={6} placeholder="Body (HTML)" value={emailTemplates.requestSignatureHtml || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, requestSignatureHtml: e.target.value })} />
            </div>

            <div className="glass card stack" style={{ padding: 12 }}>
              <h3>Request Customer Information</h3>
              <input placeholder="Subject" value={emailTemplates.requestCustomerInfoSubject || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, requestCustomerInfoSubject: e.target.value })} />
              <textarea rows={5} placeholder="Body (text)" value={emailTemplates.requestCustomerInfoBody || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, requestCustomerInfoBody: e.target.value })} />
              <textarea rows={6} placeholder="Body (HTML)" value={emailTemplates.requestCustomerInfoHtml || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, requestCustomerInfoHtml: e.target.value })} />
            </div>

            <div className="glass card stack" style={{ padding: 12 }}>
              <h3>Request Payment</h3>
              <input placeholder="Subject" value={emailTemplates.requestPaymentSubject || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, requestPaymentSubject: e.target.value })} />
              <textarea rows={5} placeholder="Body (text)" value={emailTemplates.requestPaymentBody || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, requestPaymentBody: e.target.value })} />
              <textarea rows={6} placeholder="Body (HTML)" value={emailTemplates.requestPaymentHtml || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, requestPaymentHtml: e.target.value })} />
            </div>

            <div className="glass card stack" style={{ padding: 12 }}>
              <h3>Daily Ops Report</h3>
              <div className="surface-note">
                Used by Reports Workspace when the team sends a daily ops email. If the recipient field is left blank in Reports, the system falls back to the selected location email configuration when available.
              </div>
              <input placeholder="Subject" value={emailTemplates.dailyOpsReportSubject || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, dailyOpsReportSubject: e.target.value })} />
              <textarea rows={8} placeholder="Body (text)" value={emailTemplates.dailyOpsReportBody || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, dailyOpsReportBody: e.target.value })} />
              <textarea rows={10} placeholder="Body (HTML)" value={emailTemplates.dailyOpsReportHtml || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, dailyOpsReportHtml: e.target.value })} />
            </div>

            <div className="glass card stack" style={{ padding: 12 }}>
              <h3>Reservation Detail Email</h3>
              <input placeholder="Subject" value={emailTemplates.reservationDetailSubject || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, reservationDetailSubject: e.target.value })} />
              <textarea rows={5} placeholder="Body (text)" value={emailTemplates.reservationDetailBody || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, reservationDetailBody: e.target.value })} />
              <textarea rows={6} placeholder="Body (HTML)" value={emailTemplates.reservationDetailHtml || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, reservationDetailHtml: e.target.value })} />
            </div>

            <div className="glass card stack" style={{ padding: 12 }}>
              <h3>Return Receipt</h3>
              <input placeholder="Subject" value={emailTemplates.returnReceiptSubject || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, returnReceiptSubject: e.target.value })} />
              <textarea rows={5} placeholder="Body (text)" value={emailTemplates.returnReceiptBody || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, returnReceiptBody: e.target.value })} />
              <textarea rows={6} placeholder="Body (HTML)" value={emailTemplates.returnReceiptHtml || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, returnReceiptHtml: e.target.value })} />
            </div>

            <div className="glass card stack" style={{ padding: 12 }}>
              <h3>Rental / Loaner Review Request</h3>
              <div className="surface-note">
                This message goes out after a normal rental or dealership loaner reservation is checked in. It does not affect car sharing host reviews.
              </div>
              <input placeholder="Subject" value={emailTemplates.rentalReviewRequestSubject || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, rentalReviewRequestSubject: e.target.value })} />
              <textarea rows={5} placeholder="Body (text)" value={emailTemplates.rentalReviewRequestBody || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, rentalReviewRequestBody: e.target.value })} />
              <textarea rows={6} placeholder="Body (HTML)" value={emailTemplates.rentalReviewRequestHtml || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, rentalReviewRequestHtml: e.target.value })} />
            </div>

            <div className="glass card stack" style={{ padding: 12 }}>
              <h3>Review Email Automation</h3>
              <div className="surface-note">
                Automatically send the Rental / Loaner Review Request email when a reservation reaches the selected status. The email uses the template above. Leave the review link blank if you do not want to embed a review URL.
              </div>
              <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={!!reviewEmailConfig.enabled}
                  onChange={(e) => setReviewEmailConfig((current) => ({ ...current, enabled: e.target.checked }))}
                /> Enable automatic review email
              </label>
              <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                Send when reservation is:
                <select
                  value={reviewEmailConfig.trigger || 'CHECKED_IN'}
                  onChange={(e) => setReviewEmailConfig((current) => ({ ...current, trigger: e.target.value }))}
                  style={{ marginLeft: 8 }}
                >
                  <option value="OFF">Off (never send)</option>
                  <option value="CHECKED_OUT">Checked Out (pickup)</option>
                  <option value="CHECKED_IN">Checked In (return)</option>
                </select>
              </label>
              <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                Review link URL (optional - exposed as {'{{reviewLink}}'} in the template)
                <input
                  placeholder="https://g.page/r/your-business/review"
                  value={reviewEmailConfig.reviewLinkUrl || ''}
                  onChange={(e) => setReviewEmailConfig((current) => ({ ...current, reviewLinkUrl: e.target.value }))}
                />
              </label>
              <div>
                <button onClick={saveReviewEmailConfig}>Save Review Email Automation</button>
              </div>
            </div>

            <div className="glass card stack" style={{ padding: 12 }}>
              <h3>Agreement Email (HTML)</h3>
              <input placeholder="Subject" value={emailTemplates.agreementEmailSubject || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, agreementEmailSubject: e.target.value })} />
              <textarea rows={10} placeholder="HTML body" value={emailTemplates.agreementEmailHtml || ''} onChange={(e) => setEmailTemplates({ ...emailTemplates, agreementEmailHtml: e.target.value })} />
            </div>

            <button onClick={saveEmailTemplates}>Save Email Templates</button>
          </div>
        )}

        {tab === 'services' && (
          <div className="stack service-settings">
            <h2>Additional Services</h2>
            <form className="stack service-form" onSubmit={addService}>
              <div className="grid2">
                <div className="stack">
                  <label className="label">Name*</label>
                  <input required value={serviceForm.name} onChange={(e) => setServiceForm({ ...serviceForm, name: e.target.value })} />
                </div>
                <div className="stack">
                  <label className="label">Code*</label>
                  <input required value={serviceForm.code} onChange={(e) => setServiceForm({ ...serviceForm, code: e.target.value })} />
                </div>
              </div>

              <div className="grid2">
                <div className="stack">
                  <label className="label">Calculation By</label>
                  <select value={serviceForm.calculationBy} onChange={(e) => setServiceForm({ ...serviceForm, calculationBy: e.target.value })}>
                    <option value="24_HOUR_TIME">24 Hour Time</option>
                    <option value="CALENDAR_DAY">Calendar Day</option>
                  </select>
                </div>
                <div className="stack">
                  <label className="label">One-Time / Flat Rate</label>
                  <input type="number" min="0" step="0.01" value={serviceForm.rate} onChange={(e) => setServiceForm({ ...serviceForm, rate: e.target.value })} />
                </div>
              </div>

              <div className="grid3">
                <div className="stack"><label className="label">Daily</label><input type="number" min="0" step="0.01" value={serviceForm.dailyRate} onChange={(e) => setServiceForm({ ...serviceForm, dailyRate: e.target.value })} /></div>
                <div className="stack"><label className="label">Weekly</label><input type="number" min="0" step="0.01" value={serviceForm.weeklyRate} onChange={(e) => setServiceForm({ ...serviceForm, weeklyRate: e.target.value })} /></div>
                <div className="stack"><label className="label">Monthly</label><input type="number" min="0" step="0.01" value={serviceForm.monthlyRate} onChange={(e) => setServiceForm({ ...serviceForm, monthlyRate: e.target.value })} /></div>
              </div>

              <div className="grid2">
                <div className="stack">
                  <label className="label">Linked Fee (optional)</label>
                  <select value={serviceForm.linkedFeeId} onChange={(e) => setServiceForm({ ...serviceForm, linkedFeeId: e.target.value })}>
                    <option value="">No linked fee</option>
                    {fees.map((fee) => <option key={fee.id} value={fee.id}>{fee.name} {fee.code ? `(${fee.code})` : ''}</option>)}
                  </select>
                  <div className="label">If selected, this fee is automatically added when the service is chosen.</div>
                </div>
                <div className="stack">
                  <label className="label">Default Qty</label>
                  <input type="number" min="1" step="1" value={serviceForm.defaultQty} onChange={(e) => setServiceForm({ ...serviceForm, defaultQty: e.target.value })} />
                </div>
              </div>

              <div className="glass card stack" style={{ padding: 12 }}>
                <h3>Service-Specific Commission</h3>
                <div className="label">If you set this here, it overrides the employee's plan for this service only.</div>
                <div className="grid2">
                  <div className="stack">
                    <label className="label">Commission Type</label>
                    <select value={serviceForm.commissionValueType || ''} onChange={(e) => setServiceForm({ ...serviceForm, commissionValueType: e.target.value })}>
                      <option value="">Use employee/tenant plan</option>
                      <option value="PERCENT">Percent of service revenue</option>
                      <option value="FIXED_PER_UNIT">Fixed per unit sold</option>
                      <option value="FIXED_PER_AGREEMENT">Fixed per agreement</option>
                    </select>
                  </div>
                  <div className="stack">
                    <label className="label">Percent Value</label>
                    <input type="number" min="0" step="0.01" value={serviceForm.commissionPercentValue} onChange={(e) => setServiceForm({ ...serviceForm, commissionPercentValue: e.target.value })} placeholder="5" />
                  </div>
                </div>
                <div className="stack">
                  <label className="label">Fixed Amount</label>
                  <input type="number" min="0" step="0.01" value={serviceForm.commissionFixedAmount} onChange={(e) => setServiceForm({ ...serviceForm, commissionFixedAmount: e.target.value })} placeholder="3.00" />
                </div>
              </div>

              <label className="label"><input type="checkbox" checked={serviceForm.allVehicleTypes} onChange={(e) => setServiceForm({ ...serviceForm, allVehicleTypes: e.target.checked, vehicleTypeIds: e.target.checked ? [] : serviceForm.vehicleTypeIds })} /> All Vehicle Types</label>

              <div className="glass card vehicle-types-box" style={{ opacity: serviceForm.allVehicleTypes ? 0.6 : 1 }}>
                {vehicleTypes.map((vt) => (
                  <label key={vt.id} className="label" style={{ display: 'block', marginBottom: 6 }}>
                    <input type="checkbox" disabled={serviceForm.allVehicleTypes} checked={serviceForm.allVehicleTypes || (serviceForm.vehicleTypeIds || []).includes(vt.id)} onChange={() => toggleServiceVehicleType(vt.id)} /> {vt.name}
                  </label>
                ))}
              </div>

              <div className="service-checks-grid">
                <label className="label"><input type="checkbox" checked={serviceForm.mandatory} onChange={(e) => setServiceForm({ ...serviceForm, mandatory: e.target.checked })} /> Mandatory</label>
                <label className="label"><input type="checkbox" checked={serviceForm.displayOnline} onChange={(e) => setServiceForm({ ...serviceForm, displayOnline: e.target.checked })} /> Display Online</label>
                <label className="label"><input type="checkbox" checked={serviceForm.taxable} onChange={(e) => setServiceForm({ ...serviceForm, taxable: e.target.checked })} /> Taxable</label>
                <label className="label"><input type="checkbox" checked={serviceForm.coversTolls} onChange={(e) => setServiceForm({ ...serviceForm, coversTolls: e.target.checked, ...(e.target.checked ? { tollPassthrough: false } : {}) })} /> Toll Package / Prepaid Tolls</label>
                <label className="label" title="Bill the actual tolls used at cost — the location's toll policy/admin fee is NOT applied. If Toll Package is also checked, the package wins."><input type="checkbox" checked={serviceForm.tollPassthrough} onChange={(e) => setServiceForm({ ...serviceForm, tollPassthrough: e.target.checked, ...(e.target.checked ? { coversTolls: false } : {}) })} /> Toll Activation (bill tolls at cost, no admin fee)</label>
                <label className="label"><input type="checkbox" checked={serviceForm.isActive} onChange={(e) => setServiceForm({ ...serviceForm, isActive: e.target.checked })} /> Active</label>
              </div>

              <div>
                <label className="label">Customer Display Description</label>
                <textarea
                  placeholder="Description shown to customers on the display screen (leave blank to use internal description)"
                  value={serviceForm.displayDescription}
                  onChange={(e) => setServiceForm({ ...serviceForm, displayDescription: e.target.value })}
                  rows={2}
                  style={{ width: '100%', resize: 'vertical' }}
                />
              </div>
              <div className="grid2">
                <select value={serviceForm.locationId} onChange={(e) => setServiceForm({ ...serviceForm, locationId: e.target.value })}>
                  <option value="">All locations (global)</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <input placeholder="Sort Order" value={serviceForm.sortOrder} onChange={(e) => setServiceForm({ ...serviceForm, sortOrder: e.target.value })} />
              </div>
              <div className="grid2">
                <div>
                  <label className="label">Display Priority</label>
                  <input type="number" min="0" max="100" placeholder="0 = auto, higher = shown first" value={serviceForm.displayPriority} onChange={(e) => setServiceForm({ ...serviceForm, displayPriority: e.target.value })} />
                  <div className="ui-muted" style={{ fontSize: '0.78rem', marginTop: 2 }}>Higher priority services appear first on the customer display. 0 = automatic (context-based).</div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit">{serviceEditId ? 'Save Service' : 'Add Service'}</button>
                {serviceEditId ? <button type="button" onClick={resetServiceForm}>Cancel</button> : null}
              </div>
            </form>

            <table>
              <thead><tr><th>Name</th><th>Type</th><th>Pricing</th><th>Linked Fee</th><th>Commission</th><th>Qty</th><th>Location</th><th>Toll Package</th><th>Online</th><th>Active</th><th>Actions</th></tr></thead>
              <tbody>
                {services.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td>{s.chargeType}</td>
                    <td>
                      {[
                        Number(s.rate || 0) > 0 ? `Flat $${Number(s.rate || 0).toFixed(2)}` : null,
                        Number(s.dailyRate || 0) > 0 ? `Daily $${Number(s.dailyRate || 0).toFixed(2)}` : null,
                        Number(s.weeklyRate || 0) > 0 ? `Weekly $${Number(s.weeklyRate || 0).toFixed(2)}` : null,
                        Number(s.monthlyRate || 0) > 0 ? `Monthly $${Number(s.monthlyRate || 0).toFixed(2)}` : null
                      ].filter(Boolean).join(' | ') || '$0.00'}
                    </td>
                    <td>{s.linkedFee?.name || 'None'}</td>
                    <td>
                      {s.commissionValueType === 'PERCENT' ? `${Number(s.commissionPercentValue || 0).toFixed(2)}%` :
                        s.commissionValueType ? `$${Number(s.commissionFixedAmount || 0).toFixed(2)}` :
                        'Plan Default'}
                      <div className="label">{s.commissionValueType || '-'}</div>
                    </td>
                    <td>{Number(s.defaultQty || 1).toFixed(2)}</td>
                    <td>{s.location?.name || 'All'}</td>
                    <td>{s.coversTolls ? 'Prepaid' : (s.tollPassthrough ? 'At cost' : 'No')}</td>
                    <td>{s.displayOnline ? 'Yes' : 'No'}</td>
                    <td>{s.isActive ? 'Yes' : 'No'}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => editService(s)}>Edit</button>
                      <button onClick={() => patchService(s.id, { isActive: !s.isActive })}>{s.isActive ? 'Disable' : 'Enable'}</button>
                      <button onClick={() => removeService(s.id)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'commissions' && (
          <div className="stack">
            <div className="row-between">
              <div>
                <h2>Commission Plans</h2>
                <p className="label">Configure how service sales pay out when an agreement closes.</p>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => { resetCommissionPlanForm(); resetCommissionRuleForm(); }}>New Plan</button>
                <button type="button" onClick={() => loadCommissionConfig(activeCommissionTenantId)}>Refresh</button>
              </div>
            </div>

            {isSuper ? (
              <div className="stack">
                <label className="label">Tenant Scope</label>
                <select value={activeCommissionTenantId} onChange={(e) => {
                  setActiveCommissionTenantId(e.target.value);
                  setActiveCommissionPlanId('');
                  resetCommissionPlanForm();
                  resetCommissionRuleForm();
                }}>
                  <option value="">All tenants</option>
                  {tenantRows.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name} ({tenant.slug})</option>)}
                </select>
              </div>
            ) : null}

            <div className="grid2">
              <form className="glass card stack" style={{ padding: 12 }} onSubmit={saveCommissionPlan}>
                <div className="row-between">
                  <h3>{commissionPlanForm.id ? 'Edit Plan' : 'New Plan'}</h3>
                  {commissionPlanForm.id ? <button type="button" onClick={resetCommissionPlanForm}>Cancel</button> : null}
                </div>

                {isSuper ? (
                  <div className="stack">
                    <label className="label">Tenant</label>
                    <select
                      value={commissionPlanForm.tenantId || activeCommissionTenantId || ''}
                      disabled={!!commissionPlanForm.id}
                      onChange={(e) => setCommissionPlanForm((prev) => ({ ...prev, tenantId: e.target.value }))}
                    >
                      <option value="">Select tenant</option>
                      {tenantRows.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name} ({tenant.slug})</option>)}
                    </select>
                    {commissionPlanForm.id ? <span className="label">Tenant scope is fixed after plan creation.</span> : null}
                  </div>
                ) : null}

                <div className="stack">
                  <label className="label">Plan Name</label>
                  <input value={commissionPlanForm.name} onChange={(e) => setCommissionPlanForm((prev) => ({ ...prev, name: e.target.value }))} placeholder="Sales Team Standard" />
                </div>

                <div className="grid2">
                  <div className="stack">
                    <label className="label">Default Rule Type</label>
                    <select value={commissionPlanForm.defaultValueType || ''} onChange={(e) => setCommissionPlanForm((prev) => ({ ...prev, defaultValueType: e.target.value }))}>
                      <option value="">No default fallback</option>
                      <option value="PERCENT">Percent of line revenue</option>
                      <option value="FIXED_PER_UNIT">Fixed per unit sold</option>
                      <option value="FIXED_PER_AGREEMENT">Fixed per agreement</option>
                    </select>
                  </div>
                  <div className="stack">
                    <label className="label">Status</label>
                    <label className="label"><input type="checkbox" checked={!!commissionPlanForm.isActive} onChange={(e) => setCommissionPlanForm((prev) => ({ ...prev, isActive: e.target.checked }))} /> Active plan</label>
                  </div>
                </div>

                <div className="stack">
                  <label className="label">Applies To</label>
                  <select value={commissionPlanForm.personKind || ''} onChange={(e) => setCommissionPlanForm((prev) => ({ ...prev, personKind: e.target.value }))}>
                    <option value="">Standard employees (catalog + rules)</option>
                    <option value="VIRTUAL_AGENT">Virtual agents — % of sold items (services + insurance)</option>
                  </select>
                  {commissionPlanForm.personKind === 'VIRTUAL_AGENT' ? (
                    <span className="label">Uses Default Percent on every service and insurance line the agent sells. Taxes, fees and deposits are always excluded. Set Default Rule Type to Percent.</span>
                  ) : null}
                </div>

                {commissionPlanForm.personKind !== 'VIRTUAL_AGENT' ? (
                  <div className="stack">
                    <label className="label">
                      <input
                        type="checkbox"
                        checked={(commissionPlanForm.reviewTiers || []).length > 0}
                        onChange={(e) => setCommissionPlanForm((prev) => ({
                          ...prev,
                          reviewTiers: e.target.checked ? DEFAULT_REVIEW_TIERS_UI.map((t) => ({ ...t })) : [],
                          reviewTierSources: e.target.checked ? ['EXPEDIA', 'PRICELINE'] : []
                        }))}
                      /> Review-tier commissions (replaces the flat-rate catalog for this plan)
                    </label>
                    {(commissionPlanForm.reviewTiers || []).length ? (
                      <div className="stack" style={{ gap: 6 }}>
                        <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                          Percent of sold items (services + insurance) by validated reviews this month. Below the first row = no commission. Applies only to the sources checked below.
                        </span>
                        {(commissionPlanForm.reviewTiers || []).map((tier, idx) => (
                          <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input type="number" min="0" step="1" value={tier.minReviews}
                              style={{ width: 110 }}
                              onChange={(e) => setCommissionPlanForm((prev) => {
                                const tiers = [...prev.reviewTiers];
                                tiers[idx] = { ...tiers[idx], minReviews: e.target.value };
                                return { ...prev, reviewTiers: tiers };
                              })} />
                            <span className="label">reviews →</span>
                            <input type="number" min="0" max="100" step="0.5" value={tier.pct}
                              style={{ width: 90 }}
                              onChange={(e) => setCommissionPlanForm((prev) => {
                                const tiers = [...prev.reviewTiers];
                                tiers[idx] = { ...tiers[idx], pct: e.target.value };
                                return { ...prev, reviewTiers: tiers };
                              })} />
                            <span className="label">%</span>
                            <button type="button" className="button-subtle" onClick={() => setCommissionPlanForm((prev) => ({
                              ...prev, reviewTiers: prev.reviewTiers.filter((_, j) => j !== idx)
                            }))}>✕</button>
                          </div>
                        ))}
                        <div>
                          <button type="button" className="button-subtle" onClick={() => setCommissionPlanForm((prev) => ({
                            ...prev, reviewTiers: [...prev.reviewTiers, { minReviews: '', pct: '' }]
                          }))}>＋ Add tier</button>
                        </div>
                        <div style={{ display: 'flex', gap: 14 }}>
                          {['EXPEDIA', 'PRICELINE'].map((src) => (
                            <label key={src} className="label">
                              <input type="checkbox"
                                checked={(commissionPlanForm.reviewTierSources || []).includes(src)}
                                onChange={(e) => setCommissionPlanForm((prev) => ({
                                  ...prev,
                                  reviewTierSources: e.target.checked
                                    ? [...(prev.reviewTierSources || []), src]
                                    : (prev.reviewTierSources || []).filter((s) => s !== src)
                                }))} /> {src}
                            </label>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="grid2">
                  <div className="stack">
                    <label className="label">Default Percent</label>
                    <input type="number" min="0" step="0.01" value={commissionPlanForm.defaultPercentValue} onChange={(e) => setCommissionPlanForm((prev) => ({ ...prev, defaultPercentValue: e.target.value }))} placeholder="5" />
                  </div>
                  <div className="stack">
                    <label className="label">Default Fixed Amount</label>
                    <input type="number" min="0" step="0.01" value={commissionPlanForm.defaultFixedAmount} onChange={(e) => setCommissionPlanForm((prev) => ({ ...prev, defaultFixedAmount: e.target.value }))} placeholder="3.00" />
                  </div>
                </div>

                <button type="submit">{commissionPlanForm.id ? 'Save Plan' : 'Create Plan'}</button>
              </form>

              <div className="glass card stack" style={{ padding: 12 }}>
                <div className="row-between">
                  <h3>Existing Plans</h3>
                  <span className="label">{commissionPlans.length} total</span>
                </div>
                <table>
                  <thead><tr><th>Name</th><th>Tenant</th><th>Defaults</th><th>Rules</th><th>Active</th><th>Actions</th></tr></thead>
                  <tbody>
                    {commissionPlans.length ? commissionPlans.map((plan) => (
                      <tr key={plan.id}>
                        <td>
                          <div>{plan.name}</div>
                          <div className="label">{plan.personKind === 'VIRTUAL_AGENT' ? 'Virtual agents' : ''}{plan.personKind === 'VIRTUAL_AGENT' && plan.id === activeCommissionPlanId ? ' · ' : ''}{plan.id === activeCommissionPlanId ? 'Selected plan' : ''}</div>
                        </td>
                        <td>{tenantRows.find((tenant) => tenant.id === plan.tenantId)?.name || (plan.tenantId ? plan.tenantId : 'Current tenant')}</td>
                        <td>{plan.defaultValueType || '-'}{plan.defaultValueType === 'PERCENT' && plan.defaultPercentValue != null ? ` / ${Number(plan.defaultPercentValue).toFixed(2)}%` : ''}{plan.defaultValueType && plan.defaultValueType !== 'PERCENT' && plan.defaultFixedAmount != null ? ` / $${Number(plan.defaultFixedAmount).toFixed(2)}` : ''}</td>
                        <td>{Array.isArray(plan.rules) ? plan.rules.length : 0}</td>
                        <td>{plan.isActive ? 'Yes' : 'No'}</td>
                        <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button type="button" onClick={() => editCommissionPlan(plan)}>Edit</button>
                          <button type="button" onClick={() => setActiveCommissionPlanId(plan.id)}>Rules</button>
                          <button type="button" onClick={() => removeCommissionPlan(plan)}>Delete</button>
                        </td>
                      </tr>
                    )) : (
                      <tr><td colSpan="6">No commission plans configured yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="glass card stack" style={{ padding: 12 }}>
              <div className="row-between">
                <div>
                  <h3>{activeCommissionPlan ? `Rules for ${activeCommissionPlan.name}` : 'Commission Rules'}</h3>
                  <p className="label">Use service-specific rules first, then charge code/type, then the plan fallback.</p>
                </div>
                {commissionRuleForm.id ? <button type="button" onClick={resetCommissionRuleForm}>Cancel Rule Edit</button> : null}
              </div>

              {!activeCommissionPlan ? <p className="label">Select a plan to configure its rules.</p> : (
                <>
                  <form className="stack" onSubmit={saveCommissionRule}>
                    <div className="grid2">
                      <div className="stack">
                        <label className="label">Rule Name</label>
                        <input value={commissionRuleForm.name} onChange={(e) => setCommissionRuleForm((prev) => ({ ...prev, name: e.target.value }))} placeholder="Insurance policy sold" />
                      </div>
                      <div className="stack">
                        <label className="label">Priority</label>
                        <input type="number" value={commissionRuleForm.priority} onChange={(e) => setCommissionRuleForm((prev) => ({ ...prev, priority: e.target.value }))} />
                      </div>
                    </div>

                    <div className="grid3">
                      <div className="stack">
                        <label className="label">Service Match</label>
                        <select value={commissionRuleForm.serviceId} onChange={(e) => setCommissionRuleForm((prev) => ({ ...prev, serviceId: e.target.value }))}>
                          <option value="">No service match</option>
                          {commissionServices.map((service) => <option key={service.id} value={service.id}>{service.code} - {service.name}</option>)}
                        </select>
                      </div>
                      <div className="stack">
                        <label className="label">Charge Code Match</label>
                        <input value={commissionRuleForm.chargeCode} onChange={(e) => setCommissionRuleForm((prev) => ({ ...prev, chargeCode: e.target.value.toUpperCase() }))} placeholder="LDW" />
                      </div>
                      <div className="stack">
                        <label className="label">Charge Type Match</label>
                        <select value={commissionRuleForm.chargeType} onChange={(e) => setCommissionRuleForm((prev) => ({ ...prev, chargeType: e.target.value }))}>
                          <option value="">No charge type match</option>
                          <option value="UNIT">UNIT</option>
                          <option value="DAILY">DAILY</option>
                          <option value="PERCENT">PERCENT</option>
                          <option value="DEPOSIT">DEPOSIT</option>
                          <option value="TAX">TAX</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid2">
                      <div className="stack">
                        <label className="label">Commission Type</label>
                        <select value={commissionRuleForm.valueType} onChange={(e) => setCommissionRuleForm((prev) => ({ ...prev, valueType: e.target.value }))}>
                          <option value="PERCENT">Percent of sale</option>
                          <option value="FIXED_PER_UNIT">Fixed per unit</option>
                          <option value="FIXED_PER_AGREEMENT">Fixed per agreement</option>
                        </select>
                      </div>
                      <div className="stack">
                        <label className="label">Status</label>
                        <label className="label"><input type="checkbox" checked={!!commissionRuleForm.isActive} onChange={(e) => setCommissionRuleForm((prev) => ({ ...prev, isActive: e.target.checked }))} /> Active rule</label>
                      </div>
                    </div>

                    <div className="grid2">
                      <div className="stack">
                        <label className="label">Percent Value</label>
                        <input type="number" min="0" step="0.01" value={commissionRuleForm.percentValue} onChange={(e) => setCommissionRuleForm((prev) => ({ ...prev, percentValue: e.target.value }))} placeholder="5" />
                      </div>
                      <div className="stack">
                        <label className="label">Fixed Amount</label>
                        <input type="number" min="0" step="0.01" value={commissionRuleForm.fixedAmount} onChange={(e) => setCommissionRuleForm((prev) => ({ ...prev, fixedAmount: e.target.value }))} placeholder="3.00" />
                      </div>
                    </div>

                    <button type="submit">{commissionRuleForm.id ? 'Save Rule' : 'Add Rule'}</button>
                  </form>

                  <table>
                    <thead><tr><th>Name</th><th>Match</th><th>Type</th><th>Value</th><th>Priority</th><th>Active</th><th>Actions</th></tr></thead>
                    <tbody>
                      {(activeCommissionPlan.rules || []).length ? (activeCommissionPlan.rules || []).map((rule) => (
                        <tr key={rule.id}>
                          <td>{rule.name}</td>
                          <td>
                            {rule.service?.name || rule.chargeCode || rule.chargeType || '-'}
                            <div className="label">{rule.service?.code ? `${rule.service.code} service` : rule.chargeCode ? 'Charge code' : rule.chargeType ? 'Charge type' : 'Fallback'}</div>
                          </td>
                          <td>{rule.valueType}</td>
                          <td>{rule.valueType === 'PERCENT' ? `${Number(rule.percentValue || 0).toFixed(2)}%` : `$${Number(rule.fixedAmount || 0).toFixed(2)}`}</td>
                          <td>{rule.priority}</td>
                          <td>{rule.isActive ? 'Yes' : 'No'}</td>
                          <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button type="button" onClick={() => editCommissionRule(rule)}>Edit</button>
                            <button type="button" onClick={() => removeCommissionRule(rule)}>Delete</button>
                          </td>
                        </tr>
                      )) : (
                        <tr><td colSpan="7">No rules configured for this plan yet.</td></tr>
                      )}
                    </tbody>
                  </table>
                </>
              )}
            </div>

            <div className="glass card stack" style={{ padding: 12 }}>
              <div className="row-between">
                <div>
                  <h3>Employee Plan Assignments</h3>
                  <p className="label">Each employee can inherit the tenant default or use a specific commission plan override.</p>
                </div>
                <button type="button" onClick={() => loadCommissionEmployees(activeCommissionTenantId)}>Refresh Employees</button>
              </div>

              <table>
                <thead><tr><th>Employee</th><th>Role</th><th>Email</th><th>Assigned Plan</th><th>Action</th></tr></thead>
                <tbody>
                  {commissionEmployees.length ? commissionEmployees.map((employee) => (
                    <tr key={employee.id}>
                      <td>{employee.fullName}</td>
                      <td>{employee.role}</td>
                      <td>{employee.email}</td>
                      <td>
                        <select
                          value={employee.commissionPlanId || ''}
                          onChange={(e) => {
                            const nextPlanId = e.target.value;
                            setCommissionEmployees((prev) => prev.map((row) => row.id === employee.id ? {
                              ...row,
                              commissionPlanId: nextPlanId || null,
                              commissionPlan: commissionPlans.find((plan) => plan.id === nextPlanId) || null
                            } : row));
                          }}
                        >
                          <option value="">Tenant default plan</option>
                          {commissionPlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
                        </select>
                        <div className="label">
                          {employee.commissionPlan?.name || 'Uses tenant default'}
                        </div>
                      </td>
                      <td>
                        <button type="button" onClick={() => assignCommissionPlanToEmployee(employee.id, employee.commissionPlanId || '')}>
                          Save Assignment
                        </button>
                      </td>
                    </tr>
                  )) : (
                    <tr><td colSpan="5">No active admins or employees found for this tenant.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'franchises' && (
          <div className="stack">
            <h2>Franchise Management</h2>
            <p className="label">Manage franchises for this tenant. Each franchise can have its own logo, terms, and agreement template used when generating rental agreements.</p>

            <div className="glass card" style={{ padding: 16 }}>
              <h3>{franchiseEditId ? 'Edit Franchise' : 'New Franchise'}</h3>
              <div className="grid2">
                <div className="stack"><label className="label">Name*</label><input value={franchiseForm.name} onChange={(e) => setFranchiseForm({ ...franchiseForm, name: e.target.value })} placeholder="Franchise name" /></div>
                <div className="stack"><label className="label">Code</label><input value={franchiseForm.code} onChange={(e) => setFranchiseForm({ ...franchiseForm, code: e.target.value })} placeholder="Auto-generated if blank" /></div>
              </div>
              <div className="grid2">
                <div className="stack"><label className="label">Address</label><input value={franchiseForm.address} onChange={(e) => setFranchiseForm({ ...franchiseForm, address: e.target.value })} /></div>
                <div className="stack"><label className="label">Phone</label><input value={franchiseForm.phone} onChange={(e) => setFranchiseForm({ ...franchiseForm, phone: e.target.value })} /></div>
              </div>
              <div className="grid2">
                <div className="stack"><label className="label">Email</label><input value={franchiseForm.email} onChange={(e) => setFranchiseForm({ ...franchiseForm, email: e.target.value })} /></div>
                <div className="stack"><label className="label">Logo URL</label><input value={franchiseForm.logoUrl} onChange={(e) => setFranchiseForm({ ...franchiseForm, logoUrl: e.target.value })} placeholder="https://..." /></div>
              </div>
              <div className="stack"><label className="label">Terms &amp; Policies</label><textarea rows={4} value={franchiseForm.termsText} onChange={(e) => setFranchiseForm({ ...franchiseForm, termsText: e.target.value })} placeholder="Franchise-specific terms shown on rental agreements" /></div>
              <div className="stack"><label className="label">Return Instructions</label><textarea rows={3} value={franchiseForm.returnInstructionsText} onChange={(e) => setFranchiseForm({ ...franchiseForm, returnInstructionsText: e.target.value })} placeholder="Return instructions for this franchise" /></div>
              <div className="stack"><label className="label">Agreement HTML Template</label><textarea rows={6} value={franchiseForm.agreementHtmlTemplate} onChange={(e) => setFranchiseForm({ ...franchiseForm, agreementHtmlTemplate: e.target.value })} placeholder="Custom HTML template (uses {{companyName}}, {{termsText}}, etc.)" /></div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <label className="label"><input type="checkbox" checked={franchiseForm.isDefault} onChange={(e) => setFranchiseForm({ ...franchiseForm, isDefault: e.target.checked })} /> Default franchise</label>
                <label className="label"><input type="checkbox" checked={franchiseForm.isActive} onChange={(e) => setFranchiseForm({ ...franchiseForm, isActive: e.target.checked })} /> Active</label>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={saveFranchise}>{franchiseEditId ? 'Update' : 'Create'} Franchise</button>
                {franchiseEditId && <button type="button" onClick={() => { setFranchiseEditId(null); setFranchiseForm({ name: '', code: '', logoUrl: '', address: '', phone: '', email: '', termsText: '', returnInstructionsText: '', agreementHtmlTemplate: '', isDefault: false, isActive: true }); }}>Cancel</button>}
              </div>
            </div>

            {franchises.length > 0 && (
              <table>
                <thead><tr><th>Name</th><th>Code</th><th>Default</th><th>Active</th><th>Actions</th></tr></thead>
                <tbody>
                  {franchises.map((f) => (
                    <tr key={f.id}>
                      <td>{f.name}</td>
                      <td>{f.code}</td>
                      <td>{f.isDefault ? 'Yes' : ''}</td>
                      <td>{f.isActive ? 'Yes' : 'No'}</td>
                      <td style={{ display: 'flex', gap: 4 }}>
                        <button type="button" onClick={() => { setFranchiseEditId(f.id); setFranchiseForm({ name: f.name || '', code: f.code || '', logoUrl: f.logoUrl || '', address: f.address || '', phone: f.phone || '', email: f.email || '', termsText: f.termsText || '', returnInstructionsText: f.returnInstructionsText || '', agreementHtmlTemplate: f.agreementHtmlTemplate || '', isDefault: !!f.isDefault, isActive: f.isActive !== false }); }}>Edit</button>
                        <button type="button" onClick={() => deleteFranchise(f.id)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!franchises.length && <div className="label">No franchises configured yet.</div>}
          </div>
        )}
      </section>

      {copyLocationModal && (
        <div className="modal-backdrop" onClick={() => setCopyLocationModal(null)}>
          <div className="rent-modal glass" style={{ width: 'min(520px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
            <h3>Copy Location Settings</h3>
            <div className="stack">
              <div className="stack">
                <label className="label">From</label>
                <input disabled value={(locations.find((l) => l.id === copyLocationModal.sourceId)?.code || '') + ' - ' + (locations.find((l) => l.id === copyLocationModal.sourceId)?.name || '')} />
              </div>
              <div className="stack">
                <label className="label">To</label>
                <select value={copyLocationModal.targetId} onChange={(e) => setCopyLocationModal({ ...copyLocationModal, targetId: e.target.value })}>
                  <option value="">Select target location</option>
                  {locations.filter((l) => l.id !== copyLocationModal.sourceId).map((l) => <option key={l.id} value={l.id}>{l.code} - {l.name}</option>)}
                </select>
              </div>
              <div className="row-between">
                <button type="button" onClick={() => setCopyLocationModal(null)}>Cancel</button>
                <button type="button" onClick={executeCopyLocationSettings}>Copy Settings</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {locationEditor && (
        <div className="modal-backdrop" onClick={() => setLocationEditor(null)}>
          <div
            className="rent-modal glass"
            style={{
              width: 'min(1100px, 96vw)',
              minWidth: '320px',
              maxWidth: '96vw',
              maxHeight: '90vh',
              overflowY: 'auto',
              overflowX: 'hidden',
              WebkitOverflowScrolling: 'touch',
              touchAction: 'pan-y'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Location Settings</h3>
            <div className="stack">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[
                  ['main', 'Main'],
                  ['rental', 'Rental Rules'],
                  ['payments', 'Payments'],
                  ['operations', 'Hours of Operations'],
                  ['closed', 'Closed Days'],
                  ['fees', 'Fees & Taxes'],
                  ['agreementTemplate', 'Agreement Template (Global)']
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setLocationEditorTab(key)}
                    style={{ opacity: locationEditorTab === key ? 1 : 0.65, border: locationEditorTab === key ? '2px solid #6d28d9' : undefined }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {locationEditorTab === 'main' && (
                <>
                  <div className="label">Identity</div>
                  <div className="grid2">
                    <div className="stack"><label className="label">Location Code</label><input placeholder="Location Code" value={locationEditor.code} onChange={(e) => setLocationEditor({ ...locationEditor, code: e.target.value })} /></div>
                    <div className="stack"><label className="label">Location Name</label><input placeholder="Location Name" value={locationEditor.name} onChange={(e) => setLocationEditor({ ...locationEditor, name: e.target.value })} /></div>
                  </div>

                  <div className="label">Address</div>
                  <div className="stack"><label className="label">Street Address</label><input placeholder="Address" value={locationEditor.address} onChange={(e) => setLocationEditor({ ...locationEditor, address: e.target.value })} /></div>
                  <div className="grid2">
                    <div className="stack"><label className="label">City</label><input placeholder="City" value={locationEditor.city} onChange={(e) => setLocationEditor({ ...locationEditor, city: e.target.value })} /></div>
                    <div className="stack"><label className="label">State</label><input placeholder="State" value={locationEditor.state} onChange={(e) => setLocationEditor({ ...locationEditor, state: e.target.value })} /></div>
                  </div>

                  <div className="label">Defaults</div>
                  <div className="grid2">
                    <div className="stack"><label className="label">Country</label><input placeholder="Country" value={locationEditor.country} onChange={(e) => setLocationEditor({ ...locationEditor, country: e.target.value })} /></div>
                    <div className="stack"><label className="label">Tax Rate %</label><input placeholder="Tax Rate %" value={locationEditor.taxRate} onChange={(e) => setLocationEditor({ ...locationEditor, taxRate: e.target.value })} /></div>
                  </div>
                  <div className="grid2">
                    <div className="stack"><label className="label">Default Rate Plan</label><input placeholder="Default Rate Plan" value={locationEditor.config?.defaultRatePlan || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), defaultRatePlan: e.target.value } })} /></div>
                    <label className="label"><input type="checkbox" checked={!!locationEditor.isActive} onChange={(e) => setLocationEditor({ ...locationEditor, isActive: e.target.checked })} /> Active Location</label>
                  </div>

                  <div className="label">Geofence (overdue alerts)</div>
                  <div className="grid2">
                    <div className="stack"><label className="label">Latitude</label><input placeholder="18.439400" value={locationEditor.latitude ?? ''} onChange={(e) => setLocationEditor({ ...locationEditor, latitude: e.target.value })} /></div>
                    <div className="stack"><label className="label">Longitude</label><input placeholder="-66.001800" value={locationEditor.longitude ?? ''} onChange={(e) => setLocationEditor({ ...locationEditor, longitude: e.target.value })} /></div>
                  </div>
                  <div className="grid2">
                    <div className="stack"><label className="label">Geofence Radius (km)</label><input placeholder="0.5" value={locationEditor.geofenceRadiusKm ?? ''} onChange={(e) => setLocationEditor({ ...locationEditor, geofenceRadiusKm: e.target.value })} /></div>
                    <div className="ui-muted" style={{ alignSelf: 'end', fontSize: 12 }}>
                      Right-click the lot in Google Maps → copy coordinates. Overdue rentals with GPS inside this circle are treated as returned-not-checked-in; outside every geofenced branch raises a dashboard alert. Leave empty to skip this location.
                    </div>
                  </div>

                  <div className="label">Location Contact & Instructions</div>
                  <div className="grid2">
                    <div className="stack"><label className="label">Location Email (confirmation copy)</label><input placeholder="location@email.com" value={locationEditor.config?.locationEmail || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), locationEmail: e.target.value } })} /></div>
                    <div className="stack"><label className="label">Location Phone</label><input placeholder="(000) 000-0000" value={locationEditor.config?.locationPhone || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), locationPhone: e.target.value } })} /></div>
                  </div>
                  <div className="stack"><label className="label">Pickup Instructions</label><textarea rows={3} value={locationEditor.config?.pickupInstructions || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), pickupInstructions: e.target.value } })} /></div>
                  <div className="stack"><label className="label">Shuttle Pickup Spot (what the voice agent tells a caller who is already waiting — just WHERE to stand; leave empty to reuse Pickup Instructions)</label><textarea rows={2} value={locationEditor.config?.shuttlePickupInstructions || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), shuttlePickupInstructions: e.target.value } })} placeholder="e.g. Wait between columns 4 and 5, outside of baggage claim." /></div>
                  {/* Shuttle tracker polish NEW #4 (2026-08-24): static walking directions shown on the customer tracker page under "How to get there". Plain sede-written text, no routing engine. */}
                  <div className="stack"><label className="label">Shuttle Walking Directions (customer tracker page — HOW to get to the pickup spot, step by step)</label><textarea rows={3} value={locationEditor.config?.shuttleWalkingDirections || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), shuttleWalkingDirections: e.target.value } })} placeholder="e.g. 1. Take the elevator to Level 1 (Arrivals). 2. Cross both crosswalks to the outer island. 3. Wait under sign B-4 — about a 3 minute walk." /></div>
                  {/* Per-language directions (2026-08-25): Spanish variant of the same text — the tracker page shows it when the customer's ES/EN toggle is on ES, falling back to the English one when empty. */}
                  <div className="stack"><label className="label">Shuttle Walking Directions (Español) — shown when the customer picks ES on the tracker page</label><textarea rows={3} value={locationEditor.config?.shuttleWalkingDirectionsEs || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), shuttleWalkingDirectionsEs: e.target.value } })} placeholder="ej. 1. Toma el ascensor al Nivel 1 (Llegadas). 2. Cruza ambos cruces peatonales hasta la isleta exterior. 3. Espera bajo el letrero B-4 — unos 3 minutos a pie." /></div>
                  {locationEditor.id && <ShuttleTrackerSettings locationId={locationEditor.id} scopedSettingsPath={scopedSettingsPath} />}
                  <div className="stack"><label className="label">Drop-off Instructions</label><textarea rows={3} value={locationEditor.config?.dropoffInstructions || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), dropoffInstructions: e.target.value } })} /></div>

                  <div className="label">Self-Service Handoff Overrides</div>
                  <div className="grid2">
                    <div className="stack">
                      <label className="label">Key Exchange Mode Override</label>
                      <select
                        value={locationEditor.config?.selfServiceKeyExchangeMode || ''}
                        onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), selfServiceKeyExchangeMode: e.target.value } })}
                      >
                        <option value="">Use tenant default</option>
                        <option value="DESK">Front Desk</option>
                        <option value="LOCKBOX">Lockbox</option>
                        <option value="SMART_LOCK">Smart Lock</option>
                        <option value="KEY_CABINET">Key Cabinet</option>
                      </select>
                    </div>
                    <div className="stack"><label className="label">Pickup Point Label</label><input placeholder="Example: Lockbox A near entrance" value={locationEditor.config?.selfServicePickupPointLabel || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), selfServicePickupPointLabel: e.target.value } })} /></div>
                    <div className="stack"><label className="label">Drop-off Point Label</label><input placeholder="Example: Return key slot by gate" value={locationEditor.config?.selfServiceDropoffPointLabel || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), selfServiceDropoffPointLabel: e.target.value } })} /></div>
                  </div>
                  <div className="stack"><label className="label">Self-Service Pickup Instructions</label><textarea rows={3} value={locationEditor.config?.selfServicePickupInstructions || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), selfServicePickupInstructions: e.target.value } })} /></div>
                  <div className="stack"><label className="label">Self-Service Drop-off Instructions</label><textarea rows={3} value={locationEditor.config?.selfServiceDropoffInstructions || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), selfServiceDropoffInstructions: e.target.value } })} /></div>
                </>
              )}

              {locationEditorTab === 'rental' && (
                <>
                  <div className="label">Validation rules</div>
                  <div className="grid2">
                    <div className="stack"><label className="label">Grace Period (min)</label><input type="number" min="0" placeholder="Grace Period (min)" value={locationEditor.config?.gracePeriodMin ?? ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), gracePeriodMin: Number(e.target.value || 0) } })} /></div>
                    <div className="stack"><label className="label">Minimum Age</label><input type="number" min="16" placeholder="Minimum Age" value={locationEditor.config?.chargeAgeMin ?? ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), chargeAgeMin: Number(e.target.value || 0) } })} /></div>
                    <div className="stack"><label className="label">Maximum Age</label><input type="number" min="16" placeholder="Maximum Age" value={locationEditor.config?.chargeAgeMax ?? ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), chargeAgeMax: Number(e.target.value || 0) } })} /></div>
                    <div className="stack"><label className="label">Maintenance Hold (miles)</label><input type="number" min="0" placeholder="Maintenance Hold (miles)" value={locationEditor.config?.maintenanceHoldMiles ?? ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), maintenanceHoldMiles: Number(e.target.value || 0) } })} /></div>
                    <label className="label"><input type="checkbox" checked={!!locationEditor.config?.underageAlertEnabled} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), underageAlertEnabled: e.target.checked } })} /> Underage Alert Enabled</label>
                    <div className="stack"><label className="label">Underage Alert Age</label><input type="number" min="16" placeholder="Underage Alert Age" value={locationEditor.config?.underageAlertAge ?? ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), underageAlertAge: Number(e.target.value || 0) } })} /></div>
                    <label className="label"><input type="checkbox" checked={!!locationEditor.config?.ageRulesEnforced} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), ageRulesEnforced: e.target.checked } })} /> Enforce Age Rules at Check-Out</label>
                    <div className="stack"><label className="label">Underage Fee Max Age</label><input type="number" min="16" placeholder="Underage Fee Max Age" value={locationEditor.config?.underageFeeMaxAge ?? ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), underageFeeMaxAge: Number(e.target.value || 0) } })} /></div>
                    <label className="label"><input type="checkbox" checked={!!locationEditor.config?.requirePrecheckinBeforeCheckout} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), requirePrecheckinBeforeCheckout: e.target.checked } })} /> Require Pre-Check-In before Check-Out</label>
                  </div>
                  <span className="label">Tip: Min age must be at least 16 and max age must be ≥ min age. Underage alert adds a reservation warning note when customer age is below alert age. Enforce Age Rules blocks check-out under Minimum Age (and requires a date of birth on file); drivers between Minimum Age and Underage Fee Max Age get the mandatory underage fee (Fees flagged "Underage Fee" assigned to this location). Require Pre-Check-In blocks the check-out wizard until the customer (or staff, on their behalf) completes the pre-check-in form.</span>
                  <div className="label" style={{ marginTop: 12 }}>Automatic emails</div>
                  <div className="grid2">
                    <label className="label"><input type="checkbox" checked={locationEditor.config?.precheckinAutoEmailEnabled !== false} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), precheckinAutoEmailEnabled: e.target.checked } })} /> Pre-Check-In Auto Email</label>
                    <div className="stack"><label className="label">Check-In Email Delay (hours)</label><input type="number" min="0" placeholder="0 = immediately" value={locationEditor.config?.checkinEmailDelayHours ?? ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), checkinEmailDelayHours: Number(e.target.value || 0) } })} /></div>
                  </div>
                  <span className="label">Pre-Check-In Auto Email: unchecking stops the tenant-wide automatic pre-check-in invite/reminder for THIS location only. Check-In Email Delay: hours to wait after a completed check-in before emailing the receipt/invoice (0 = send immediately); the email sent reflects the balance at send time.</span>
                </>
              )}

              {locationEditorTab === 'payments' && (
                <>
                <div className="grid2">
                  <div className="stack"><label className="label">Currency</label><select value={locationEditor.config?.currency || 'USD'} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), currency: e.target.value } })}>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select></div>
                  <label className="label"><input type="checkbox" checked={!!locationEditor.config?.requirePaymentOnDebit} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), requirePaymentOnDebit: e.target.checked } })} /> Require Payment if Debit</label>
                  <label className="label"><input type="checkbox" checked={!!locationEditor.config?.requireRefundIfDue} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), requireRefundIfDue: e.target.checked } })} /> Require Refund if Due</label>

                  <label className="label"><input type="checkbox" checked={!!locationEditor.config?.requireDeposit} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), requireDeposit: e.target.checked } })} /> Require Deposit</label>
                  <div className="stack"><label className="label">Deposit Mode</label><select value={locationEditor.config?.depositMode || 'FIXED'} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), depositMode: e.target.value } })}><option value="FIXED">Fixed</option><option value="PERCENTAGE">Percentage</option></select></div>
                  <div className="stack"><label className="label">Deposit Amount</label><input type="number" min="0" value={Number(locationEditor.config?.depositAmount || 0)} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), depositAmount: Number(e.target.value || 0) } })} /></div>

                  {(locationEditor.config?.depositMode || 'FIXED') === 'PERCENTAGE' ? (
                    <div className="stack">
                      <label className="label">Deposit % Basis (select one or more)</label>
                      <div className="service-checks-grid">
                        {['rate', 'services', 'fees'].map((k) => (
                          <label key={k} className="label">
                            <input
                              type="checkbox"
                              checked={Array.isArray(locationEditor.config?.depositPercentBasis) ? locationEditor.config.depositPercentBasis.includes(k) : k === 'rate'}
                              onChange={(e) => {
                                const prev = Array.isArray(locationEditor.config?.depositPercentBasis) ? locationEditor.config.depositPercentBasis : ['rate'];
                                const next = e.target.checked ? [...new Set([...prev, k])] : prev.filter((x) => x !== k);
                                setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), depositPercentBasis: next.length ? next : ['rate'] } });
                              }}
                            /> {k.toUpperCase()}
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <label className="label"><input type="checkbox" checked={!!locationEditor.config?.requireSecurityDeposit} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), requireSecurityDeposit: e.target.checked } })} /> Require Security Deposit</label>
                  <div className="stack"><label className="label">Security Deposit Mode</label><select value={locationEditor.config?.securityDepositMode || 'FIXED'} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), securityDepositMode: e.target.value } })}><option value="FIXED">Fixed</option><option value="PERCENTAGE">Percentage</option></select></div>
                  <div className="stack"><label className="label">Security Deposit Amount</label><input type="number" min="0" value={Number(locationEditor.config?.securityDepositAmount || 0)} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), securityDepositAmount: Number(e.target.value || 0) } })} /></div>
                  <div className="stack"><label className="label">Security Deposit (Debit cards)</label><input type="number" min="0" value={Number(locationEditor.config?.securityDepositAmountDebit || 0)} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), securityDepositAmountDebit: Number(e.target.value || 0) } })} /><span className="label">Applied automatically when the customer pays with a debit card. Leave 0 to use the standard amount.</span></div>
                </div>

                <div className="glass card" style={{ padding: 10, marginTop: 10 }}>
                  <div className="label" style={{ marginBottom: 8 }}>Toll Policy (this location)</div>
                  <div className="grid2">
                    <label className="label"><input type="checkbox" checked={!!locationEditor.config?.tollPolicyEnabled} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), tollPolicyEnabled: e.target.checked } })} /> Enable Toll Policy</label>
                    <label className="label"><input type="checkbox" checked={!!locationEditor.config?.tollTaxable} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), tollTaxable: e.target.checked } })} /> Toll Charges Taxable</label>
                  </div>
                  {locationEditor.config?.tollPolicyEnabled ? (
                    <>
                      <label className="label"><input type="checkbox" checked={!!locationEditor.config?.tollAdditionalFeeEnabled} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), tollAdditionalFeeEnabled: e.target.checked } })} /> Add Additional Toll Fee</label>
                      {locationEditor.config?.tollAdditionalFeeEnabled ? (
                        <div className="grid2">
                          <div className="stack"><label className="label">Additional Fee Mode</label><select value={locationEditor.config?.tollAdditionalFeeMode || 'FIXED'} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), tollAdditionalFeeMode: e.target.value } })}><option value="FIXED">Fixed Charge</option><option value="PERCENTAGE">% of Toll Amount</option><option value="PER_TOLL">Per Toll Transaction</option></select></div>
                          <div className="stack"><label className="label">Additional Fee Amount</label><input type="number" min="0" value={Number(locationEditor.config?.tollAdditionalFeeAmount || 0)} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), tollAdditionalFeeAmount: Number(e.target.value || 0) } })} /></div>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
                </>
              )}

              {locationEditorTab === 'operations' && (
                <div className="stack">
                  <div className="label">Hours by day</div>
                  <div className="stack">
                    {['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].map((day) => {
                      const row = locationEditor.config?.weeklyHours?.[day] || { enabled: true, open: '08:00', close: '18:00' };
                      const setRow = (patch) => {
                        const next = { ...(locationEditor.config?.weeklyHours || {}), [day]: { ...row, ...patch } };
                        setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), weeklyHours: next } });
                      };
                      return (
                        <div key={day} className="glass card" style={{ padding: 10 }}>
                          <div className="label" style={{ textTransform: 'capitalize', marginBottom: 8 }}>{day}</div>
                          <div className="grid2">
                            <div className="stack"><label className="label">Open</label><input type="time" value={row.open || '08:00'} onChange={(e) => setRow({ open: e.target.value })} /></div>
                            <div className="stack"><label className="label">Close</label><input type="time" value={row.close || '18:00'} onChange={(e) => setRow({ close: e.target.value })} /></div>
                          </div>
                          <label className="label"><input type="checkbox" checked={row.enabled !== false} onChange={(e) => setRow({ enabled: e.target.checked })} /> Open for reservations</label>
                        </div>
                      );
                    })}
                  </div>

                  <label className="label"><input type="checkbox" checked={!!locationEditor.config?.allowOutsideHours} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), allowOutsideHours: e.target.checked } })} /> Allow reservations outside office hours</label>

                  {locationEditor.config?.allowOutsideHours ? (
                    <>
                      <label className="label"><input type="checkbox" checked={!!locationEditor.config?.outsideHoursFeeEnabled} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), outsideHoursFeeEnabled: e.target.checked } })} /> Charge outside-hours fee</label>
                      {locationEditor.config?.outsideHoursFeeEnabled ? (
                        <div className="grid2">
                          <div className="stack"><label className="label">Outside-hours Fee Mode</label><select value={locationEditor.config?.outsideHoursFeeMode || 'FIXED'} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), outsideHoursFeeMode: e.target.value } })}><option value="FIXED">Fixed</option><option value="PERCENTAGE">Percentage</option></select></div>
                          <div className="stack"><label className="label">Outside-hours Fee Amount</label><input type="number" min="0" value={locationEditor.config?.outsideHoursFeeAmount ?? 0} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), outsideHoursFeeAmount: Number(e.target.value || 0) } })} /></div>
                        </div>
                      ) : null}
                      <div className="stack"><label className="label">Outside-hours Pickup Instructions</label><textarea rows={3} value={locationEditor.config?.outsideHoursPickupInstructions || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), outsideHoursPickupInstructions: e.target.value } })} /></div>
                      <div className="stack"><label className="label">Outside-hours Drop-off Instructions</label><textarea rows={3} value={locationEditor.config?.outsideHoursDropoffInstructions || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), outsideHoursDropoffInstructions: e.target.value } })} /></div>
                    </>
                  ) : null}
                </div>
              )}

              {locationEditorTab === 'closed' && (
                <div className="stack">
                  <div className="label">Closed weekdays</div>
                  <div className="grid2">
                    {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d, idx) => {
                      const selected = (locationEditor.config?.closedWeekdays || []).includes(idx);
                      return (
                        <label key={d} className="label">
                          <input type="checkbox" checked={selected} onChange={(e) => {
                            const set = new Set(locationEditor.config?.closedWeekdays || []);
                            if (e.target.checked) set.add(idx); else set.delete(idx);
                            setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), closedWeekdays: Array.from(set).sort((a, b) => a - b) } });
                          }} /> {d}
                        </label>
                      );
                    })}
                  </div>
                  <div className="stack"><label className="label">Closed specific dates (comma separated, YYYY-MM-DD)</label><input value={(locationEditor.config?.closedDates || []).join(', ')} onChange={(e) => {
                    const dates = String(e.target.value || '').split(',').map((x) => x.trim()).filter(Boolean);
                    setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), closedDates: dates } });
                  }} /></div>
                </div>
              )}

              {locationEditorTab === 'fees' && (
                <>
                  <div className="label">Fees that apply to this location</div>
                  <div className="glass card" style={{ maxHeight: 220, overflow: 'auto' }}>
                    {fees.map((f) => (
                      <label key={f.id} className="label" style={{ display: 'block', marginBottom: 6 }}>
                        <input type="checkbox" checked={(locationEditor.feeIds || []).includes(f.id)} onChange={() => toggleLocationFee(f.id)} /> {f.name} ({f.mode} · {Number(f.amount || 0).toFixed(2)})
                      </label>
                    ))}
                  </div>
                </>
              )}

              {locationEditorTab === 'agreementTemplate' && (
                <div className="stack">
                  <div className="label">Global Agreement HTML Template (applies to all agreements)</div>
                  <textarea
                    rows={14}
                    value={cfg.agreementHtmlTemplate || ''}
                    onChange={(e) => setCfg({ ...cfg, agreementHtmlTemplate: e.target.value })}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" onClick={previewAgreementTemplate}>Preview Template</button>
                    <button type="button" onClick={saveAgreement}>Save Global Template</button>
                  </div>
                </div>
              )}

              <div className="row-between">
                <button type="button" onClick={() => setLocationEditor(null)}>Cancel</button>
                <button type="button" onClick={saveLocationEditor}>Save Location Settings</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

/**
 * FeeRatesTab — Inspection Fees configuration (Pillar 2, 16q frontend).
 *
 * Lets a tenant Admin override platform-default inspection fee amounts
 * (fuel refill, cleaning, smoking, excess mileage, late return). Non-Admin
 * users see a read-only view. Super-admins inherit the page-level
 * `activeSettingsTenantId` scope so writes are routed correctly.
 *
 * API:
 *   GET  /api/settings/fee-rates  ->  { rates: [...] }
 *   PUT  /api/settings/fee-rates  ->  body { rates: [{ feeType, amount, notes? }] }
 */
const FEE_ICONS = {
  FUEL_REFILL: 'fuel pump',
  CLEANING_LIGHT: 'sparkle',
  CLEANING_MEDIUM: 'sponge',
  CLEANING_HEAVY: 'soap',
  SMOKING: 'no smoking',
  EXCESS_MILEAGE: 'road',
  LATE_RETURN: 'clock'
};
// Emoji map (rendered as text, no JSX-special chars in the source):
const FEE_EMOJI = {
  FUEL_REFILL: '⛽',          // fuel pump
  CLEANING_LIGHT: '✨',       // sparkles
  CLEANING_MEDIUM: '🧽',// sponge
  CLEANING_HEAVY: '🧼', // soap
  SMOKING: '🚬',        // smoking sign (no-smoking ban is more complex)
  EXCESS_MILEAGE: '🛣️', // motorway
  LATE_RETURN: '⏰'           // alarm clock
};

const UNIT_LABEL = {
  PER_GALLON: 'per gallon',
  FLAT: 'flat',
  PER_MILE: 'per mile',
  PER_HOUR: 'per hour'
};

function formatMoney(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  return `$${num.toFixed(2)}`;
}

function effectiveAmount(rate) {
  if (rate?.currentAmount !== null && rate?.currentAmount !== undefined) return Number(rate.currentAmount);
  return Number(rate?.defaultAmount ?? 0);
}

// V2 (pillar2 followup): audit-history helpers — relative time + compact diff.

function relativeTime(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleString();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function diffSummary(before, after) {
  const b = before || {};
  const a = after || {};
  const out = [];
  const fmtMoney = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : String(n));
  if (!before && after) {
    if (typeof a.amount === 'number') out.push(`rate set to ${fmtMoney(a.amount)}`);
    if (a.isActive === false) out.push('isActive: false');
    return out.length ? out.join(', ') : 'created';
  }
  if (before && !after) return 'deleted';
  if (Number(b.amount) !== Number(a.amount)) out.push(`rate: ${fmtMoney(Number(b.amount))} → ${fmtMoney(Number(a.amount))}`);
  if (!!b.isActive !== !!a.isActive) out.push(`isActive: ${!!b.isActive} → ${!!a.isActive}`);
  if ((b.notes || '') !== (a.notes || '')) out.push('notes changed');
  if ((b.unit || '') !== (a.unit || '')) out.push(`unit: ${b.unit} → ${a.unit}`);
  return out.length ? out.join(', ') : 'no field-level diff';
}

function FeeRatesTab({ token, me, isSuper, tenantName, scopedSettingsPath, activeSettingsTenantId, locations = [], onPageMsg }) {
  // Selected scope: '' (or null) = tenant default. Non-empty = location id.
  // Persisted in the URL query (?location=X) so refresh keeps the view.
  const initialLocationId = (() => {
    if (typeof window === 'undefined') return '';
    try {
      const u = new URL(window.location.href);
      return u.searchParams.get('location') || '';
    } catch { return ''; }
  })();
  const [selectedLocationId, setSelectedLocationId] = useState(initialLocationId);
  const [locationsWithOverrides, setLocationsWithOverrides] = useState([]); // [{ locationId, overrideCount }]
  const [rates, setRates] = useState([]);
  const [draft, setDraft] = useState({});       // { feeType: { amount, notes } }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});     // { feeType: 'message' }
  const [savedToast, setSavedToast] = useState('');
  const [loadError, setLoadError] = useState('');
  // V2 (pillar2 followup): audit history panel.
  const [auditEntries, setAuditEntries] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState('');
  const [auditOpen, setAuditOpen] = useState(false);

  const isLocationScope = !!selectedLocationId;
  const selectedLocation = isLocationScope
    ? (locations || []).find((l) => l.id === selectedLocationId) || null
    : null;
  const selectedLocationName = selectedLocation
    ? (selectedLocation.name || selectedLocation.code || selectedLocationId)
    : 'Default (Tenant-wide)';
  const overrideLocationIds = new Set(locationsWithOverrides.map((l) => l.locationId));

  // Build a draft snapshot from the API rows (current amount, falling back to default).
  const draftFromRates = (rows) => {
    const next = {};
    for (const r of rows || []) {
      next[r.feeType] = {
        amount: String(effectiveAmount(r)),
        notes: r.notes || '',
        isActive: r.isActive !== false  // default true; explicit false = disabled
      };
    }
    return next;
  };

  // For the per-location editor, the draft starts empty (placeholder = "no
  // override"). When listing tenant defaults we still pre-populate from the
  // current value as before.
  const draftFromRatesForLocation = (rows) => {
    const next = {};
    for (const r of rows || []) {
      const hasOverride = r.currentAmount !== null && r.currentAmount !== undefined;
      next[r.feeType] = {
        amount: hasOverride ? String(Number(r.currentAmount)) : '',
        notes: r.notes || '',
        isActive: r.isActive !== false
      };
    }
    return next;
  };

  const loadRates = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const qs = selectedLocationId ? `?locationId=${encodeURIComponent(selectedLocationId)}` : '';
      const res = await api(scopedSettingsPath(`/api/settings/fee-rates${qs}`), { bypassCache: true }, token);
      const rows = Array.isArray(res?.rates) ? res.rates : [];
      setRates(rows);
      setDraft(selectedLocationId ? draftFromRatesForLocation(rows) : draftFromRates(rows));
      setErrors({});
    } catch (e) {
      setLoadError(e?.message || 'Could not load inspection fee rates');
    } finally {
      setLoading(false);
    }
  };

  const loadLocationsWithOverrides = async () => {
    try {
      const res = await api(scopedSettingsPath('/api/settings/fee-rates/locations-with-overrides'), { bypassCache: true }, token);
      const rows = Array.isArray(res?.locations) ? res.locations : [];
      setLocationsWithOverrides(rows);
    } catch {
      // Non-fatal — UI just won't show "has overrides" badges.
      setLocationsWithOverrides([]);
    }
  };

  useEffect(() => { loadRates(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, activeSettingsTenantId, selectedLocationId]);
  useEffect(() => { loadLocationsWithOverrides(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, activeSettingsTenantId]);

  // Sync URL (?location=) when the selector changes.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const u = new URL(window.location.href);
      if (selectedLocationId) u.searchParams.set('location', selectedLocationId);
      else u.searchParams.delete('location');
      window.history.replaceState(null, '', u.toString());
    } catch { /* no-op */ }
  }, [selectedLocationId]);

  // V2: fetch the audit log for the current tenant scope. Best-effort; an
  // error here surfaces as inline text in the History panel but never blocks
  // the main rates UI.
  const loadAuditEntries = async () => {
    setAuditLoading(true);
    setAuditError('');
    try {
      const res = await api(scopedSettingsPath('/api/settings/fee-rates/audit?limit=20'), { bypassCache: true }, token);
      const entries = Array.isArray(res?.entries) ? res.entries : [];
      setAuditEntries(entries);
    } catch (e) {
      setAuditError(e?.message || 'Could not load fee rate history');
      setAuditEntries([]);
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => { loadAuditEntries(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, activeSettingsTenantId]);

  const ratesByType = rates.reduce((acc, r) => { acc[r.feeType] = r; return acc; }, {});

  // Anyone editable? Backend returns per-row `editable`; in V1 the value is the same across rows.
  const editable = rates.length === 0 ? true : rates.every((r) => r.editable);

  // ───── Validation + dirty tracking ─────
  const validateAmount = (rate, amountStr) => {
    const n = Number(amountStr);
    if (!Number.isFinite(n)) return 'Enter a valid number';
    const { min, max } = rate?.validRange || {};
    if (typeof min === 'number' && n < min) return `Min ${formatMoney(min)}`;
    if (typeof max === 'number' && n > max) return `Max ${formatMoney(max)}`;
    return '';
  };

  const isRowDirty = (feeType) => {
    const rate = ratesByType[feeType];
    if (!rate) return false;
    const d = draft[feeType];
    if (!d) return false;
    const draftActive = d.isActive !== false;
    const rateActive = rate.isActive !== false;
    if (isLocationScope) {
      // For location scope, dirty = (override changed) or (toggled active).
      // Empty string draft = "no override". rate.currentAmount === null also = "no override".
      const trimmed = (d.amount ?? '').toString().trim();
      const draftHasOverride = trimmed !== '';
      const rateHasOverride = rate.currentAmount !== null && rate.currentAmount !== undefined;
      if (draftHasOverride !== rateHasOverride) return true;
      if (draftHasOverride && Number(d.amount) !== Number(rate.currentAmount)) return true;
      if ((d.notes || '') !== (rate.notes || '')) return true;
      if (draftActive !== rateActive) return true;
      return false;
    }
    return (
      Number(d.amount) !== effectiveAmount(rate) ||
      (d.notes || '') !== (rate.notes || '') ||
      draftActive !== rateActive
    );
  };

  const dirtyFeeTypes = Object.keys(draft).filter(isRowDirty);
  const hasErrors = Object.values(errors).some((m) => !!m);

  const updateDraft = (feeType, patch) => {
    const rate = ratesByType[feeType];
    setDraft((prev) => {
      const next = { ...prev, [feeType]: { ...(prev[feeType] || {}), ...patch } };
      return next;
    });
    if (patch.amount !== undefined && rate) {
      const raw = (patch.amount ?? '').toString().trim();
      // Empty in location scope means "no override" — not an error.
      if (isLocationScope && raw === '') {
        setErrors((prev) => ({ ...prev, [feeType]: '' }));
      } else {
        const msg = validateAmount(rate, patch.amount);
        setErrors((prev) => ({ ...prev, [feeType]: msg }));
      }
    }
  };

  const resetRow = (feeType) => {
    const rate = ratesByType[feeType];
    if (!rate) return;
    if (isLocationScope) {
      // For location scope, "reset" means clear the override (revert to tenant
      // default). The actual DB delete only happens on save (we mark the row
      // empty so isRowDirty triggers + save sends a DELETE for it).
      setDraft((prev) => ({
        ...prev,
        [feeType]: { amount: '', notes: '', isActive: true }
      }));
    } else {
      setDraft((prev) => ({
        ...prev,
        [feeType]: { amount: String(Number(rate.defaultAmount ?? 0)), notes: '', isActive: true }
      }));
    }
    setErrors((prev) => ({ ...prev, [feeType]: '' }));
  };

  // For per-location: explicitly delete a single override row (DELETE call)
  // and refresh the table. This is the "Reset to tenant default" affordance.
  const deleteOverrideRow = async (feeType) => {
    if (!isLocationScope || !editable || saving) return;
    setSaving(true);
    try {
      await api(
        scopedSettingsPath(`/api/settings/fee-rates/${encodeURIComponent(feeType)}?locationId=${encodeURIComponent(selectedLocationId)}`),
        { method: 'DELETE' },
        token
      );
      await loadRates();
      await loadLocationsWithOverrides();
      setSavedToast(`${feeType} override removed`);
      setTimeout(() => setSavedToast(''), 2500);
    } catch (e) {
      const msg = e?.message || `Could not delete ${feeType} override`;
      if (typeof onPageMsg === 'function') onPageMsg(msg);
    } finally {
      setSaving(false);
    }
  };

  const discardAll = () => {
    setDraft(isLocationScope ? draftFromRatesForLocation(rates) : draftFromRates(rates));
    setErrors({});
  };

  const save = async () => {
    if (!editable || saving || hasErrors || dirtyFeeTypes.length === 0) return;
    setSaving(true);
    try {
      if (isLocationScope) {
        // Bucket dirty rows: cleared (delete) vs filled (upsert).
        const toDelete = [];
        const toUpsert = [];
        for (const feeType of dirtyFeeTypes) {
          const d = draft[feeType] || {};
          const trimmed = (d.amount ?? '').toString().trim();
          if (trimmed === '') {
            toDelete.push(feeType);
          } else {
            const out = { feeType, amount: Number(d.amount), isActive: d.isActive !== false };
            if (d.notes && d.notes.trim()) out.notes = d.notes.trim();
            toUpsert.push(out);
          }
        }
        if (toUpsert.length > 0) {
          await api(
            scopedSettingsPath(`/api/settings/fee-rates?locationId=${encodeURIComponent(selectedLocationId)}`),
            { method: 'PUT', body: JSON.stringify({ rates: toUpsert }) },
            token
          );
        }
        for (const feeType of toDelete) {
          await api(
            scopedSettingsPath(`/api/settings/fee-rates/${encodeURIComponent(feeType)}?locationId=${encodeURIComponent(selectedLocationId)}`),
            { method: 'DELETE' },
            token
          );
        }
        await loadRates();
        await loadLocationsWithOverrides();
        const overrideCount = (rates || []).filter((r) => r.currentAmount !== null && r.currentAmount !== undefined).length;
        setSavedToast(`Location overrides saved · ${overrideCount} active for ${selectedLocationName}`);
        if (typeof onPageMsg === 'function') onPageMsg('');
        setTimeout(() => setSavedToast(''), 3500);
        return;
      }
      const payload = {
        rates: dirtyFeeTypes.map((feeType) => {
          const d = draft[feeType] || {};
          const out = { feeType, amount: Number(d.amount), isActive: d.isActive !== false };
          if (d.notes && d.notes.trim()) out.notes = d.notes.trim();
          return out;
        })
      };
      const res = await api(
        scopedSettingsPath('/api/settings/fee-rates'),
        { method: 'PUT', body: JSON.stringify(payload) },
        token
      );
      const nextRows = Array.isArray(res?.rates) ? res.rates : [];
      setRates(nextRows);
      setDraft(draftFromRates(nextRows));
      setErrors({});
      const customCount = nextRows.filter((r) => r.currentSource === 'tenant_default' && r.currentAmount !== null).length;
      const toastMsg = `Fee rates updated · ${customCount} custom rate${customCount === 1 ? '' : 's'} active`;
      setSavedToast(toastMsg);
      if (typeof onPageMsg === 'function') onPageMsg('');
      setTimeout(() => setSavedToast(''), 3500);
      // V2: refresh the audit list so the just-saved change appears at the top.
      loadAuditEntries();
    } catch (e) {
      const msg = e?.message || 'Could not save fee rates';
      if (typeof onPageMsg === 'function') onPageMsg(msg);
      setSavedToast('');
      // If server returned per-row errors, surface them.
      const perRow = e?.body?.errors || e?.data?.errors;
      if (Array.isArray(perRow)) {
        const map = {};
        for (const item of perRow) {
          if (item?.feeType && item?.message) map[item.feeType] = String(item.message);
        }
        if (Object.keys(map).length) setErrors((prev) => ({ ...prev, ...map }));
      }
    } finally {
      setSaving(false);
    }
  };

  // ───── Styling tokens (inline, matching mockup) ─────
  const VIOLET = '#6d3df2';
  const VIOLET_SOFT = 'rgba(109,61,242,.10)';
  const VIOLET_STRONG = 'rgba(109,61,242,.22)';
  const INK = '#1d1d1f';
  const MUTED = '#6e6e73';
  const DIVIDER = '#e5e5ea';
  const DANGER = '#ff3b30';
  const SURFACE = '#ffffff';

  const cardStyle = (dirty, error) => ({
    background: SURFACE,
    border: `1px solid ${error ? DANGER : (dirty ? VIOLET_STRONG : DIVIDER)}`,
    borderRadius: 16,
    padding: '14px 16px',
    marginBottom: 10,
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    boxShadow: dirty ? '0 0 0 2px rgba(109,61,242,.08), 0 1px 2px rgba(0,0,0,.02)' : '0 1px 2px rgba(0,0,0,.02)',
    flexWrap: 'wrap'
  });

  if (loading) {
    return (
      <div className="stack">
        <h2>Inspection Fees</h2>
        <p className="label">Loading fee rates…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="stack">
        <h2>Inspection Fees</h2>
        <p className="error">{loadError}</p>
        <div><button onClick={loadRates}>Retry</button></div>
      </div>
    );
  }

  const dirtyCount = dirtyFeeTypes.length;
  const adminEmail = me?.tenant?.adminEmail || `admin@${me?.tenant?.slug || 'your-tenant'}`;

  return (
    <div className="stack" style={{ position: 'relative' }}>
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="stack" style={{ gap: 4 }}>
          <h2 style={{ margin: 0 }}>
            {isLocationScope ? `Overrides for ${selectedLocationName}` : 'Inspection Fees'}
          </h2>
          <p style={{ color: MUTED, fontSize: 13, lineHeight: 1.5, maxWidth: 740, margin: 0 }}>
            {isLocationScope
              ? 'Tenant default shown in gray; the override editor is normal weight. Leave an amount blank to keep the tenant default for that fee.'
              : 'Charged on check-in when the vehicle returns dirty, low on fuel, smoked-in, or over its mileage allowance.'}
          </p>
        </div>
        <span
          style={{
            padding: '6px 12px',
            borderRadius: 999,
            background: VIOLET_SOFT,
            color: VIOLET,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            whiteSpace: 'nowrap'
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: VIOLET }} />
          {tenantName}
        </span>
      </div>

      {/* Location selector — Pillar 2 follow-up. Default = tenant-wide. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px',
          background: VIOLET_SOFT,
          border: `1px solid ${VIOLET_STRONG}`,
          borderRadius: 12,
          flexWrap: 'wrap'
        }}
      >
        <label style={{ fontSize: 12, fontWeight: 700, color: VIOLET, textTransform: 'uppercase', letterSpacing: '.04em' }}>
          Editing
        </label>
        <select
          value={selectedLocationId}
          onChange={(e) => setSelectedLocationId(e.target.value || '')}
          style={{
            padding: '8px 12px',
            borderRadius: 10,
            border: `1px solid ${DIVIDER}`,
            background: '#fff',
            fontSize: 13,
            fontWeight: 600,
            color: INK,
            minWidth: 240
          }}
        >
          <option value="">Default (Tenant-wide)</option>
          {(locations || []).map((l) => (
            <option key={l.id} value={l.id}>
              {(l.name || l.code || l.id)}{overrideLocationIds.has(l.id) ? ' • has overrides' : ''}
            </option>
          ))}
        </select>
        {isLocationScope ? (
          <span style={{ fontSize: 12, color: MUTED }}>
            Tenant default values are shown faded. Empty input = no override (tenant default applies).
          </span>
        ) : (
          <span style={{ fontSize: 12, color: MUTED }}>
            These are the tenant-wide defaults. Select a location to edit per-location overrides.
          </span>
        )}
      </div>

            {isSuper && activeSettingsTenantId ? (
        <div
          style={{
            background: 'linear-gradient(135deg, #ffd60a 0%, #ff9f0a 100%)',
            color: '#5d3a00',
            padding: '10px 14px',
            borderRadius: 12,
            fontSize: 13,
            fontWeight: 600
          }}
        >
          Viewing as: <strong>{tenantName}</strong> (super-admin override)
        </div>
      ) : null}

      {!editable ? (
        <div
          style={{
            background: '#fff4e0',
            border: '1px solid #ffe0b3',
            color: '#7a4a00',
            padding: '12px 14px',
            borderRadius: 12,
            fontSize: 13
          }}
        >
          Only Admin can edit fee rates. Ask <strong>{adminEmail}</strong> for changes.
        </div>
      ) : null}

      <div className="stack" style={{ gap: 0 }}>
        {rates.map((rate) => {
          const d = draft[rate.feeType] || { amount: '', notes: '', isActive: true };
          const dirty = isRowDirty(rate.feeType);
          const err = errors[rate.feeType] || '';
          const overrideActive = rate.currentAmount !== null && rate.currentAmount !== undefined;
          const range = rate.validRange || { min: 0, max: 9999, step: 0.01 };
          const unitLabel = UNIT_LABEL[rate.unit] || rate.unit || '';
          const isOn = d.isActive !== false;
          const cardOpacity = isOn ? 1 : 0.55;
          return (
            <div key={rate.feeType} style={{ ...cardStyle(dirty, !!err), opacity: cardOpacity }}>
              <div
                style={{
                  width: 40, height: 40, borderRadius: 12,
                  background: 'linear-gradient(135deg, rgba(109,61,242,.10), rgba(135,82,254,.04))',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 22, flexShrink: 0
                }}
                aria-hidden="true"
              >
                {FEE_EMOJI[rate.feeType] || '•'}
              </div>

              <div style={{ flex: '1 1 220px', minWidth: 200 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong style={{ color: INK, fontSize: 15 }}>{rate.label || rate.feeType}</strong>
                  {dirty ? <span title="Modified" style={{ width: 8, height: 8, borderRadius: '50%', background: VIOLET, display: 'inline-block' }} /> : null}
                </div>
                <div style={{ color: MUTED, fontSize: 12, lineHeight: 1.45, marginTop: 3 }}>
                  {rate.description}
                </div>
                <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {!isOn ? (
                    <span style={{ padding: '3px 9px', borderRadius: 999, background: '#ffe6e6', color: DANGER, fontSize: 11, fontWeight: 700 }}>
                      Disabled
                    </span>
                  ) : overrideActive ? (
                    <span style={{ padding: '3px 9px', borderRadius: 999, background: VIOLET_SOFT, color: VIOLET, fontSize: 11, fontWeight: 700 }}>
                      {isLocationScope ? 'Location override' : 'Custom rate'}
                    </span>
                  ) : (
                    <span style={{ padding: '3px 9px', borderRadius: 999, background: '#f0f0f3', color: MUTED, fontSize: 11, fontWeight: 600 }}>
                      {isLocationScope ? 'Using tenant default' : 'Using platform default'}
                    </span>
                  )}
                </div>
              </div>

              <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: MUTED, fontWeight: 600 }}>$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step={range.step || 0.01}
                    min={range.min}
                    max={range.max}
                    disabled={!editable || !isOn}
                    value={d.amount}
                    placeholder={isLocationScope ? (rate.tenantDefaultAmount != null ? String(Number(rate.tenantDefaultAmount)) : '') : ''}
                    onChange={(e) => updateDraft(rate.feeType, { amount: e.target.value })}
                    style={{
                      width: 110,
                      padding: '8px 10px',
                      borderRadius: 10,
                      border: `1px solid ${err ? DANGER : DIVIDER}`,
                      fontSize: 14,
                      fontWeight: 600,
                      color: INK,
                      outline: 'none',
                      background: editable && isOn ? '#fff' : '#f5f5f7'
                    }}
                  />
                  <span style={{ color: MUTED, fontSize: 12 }}>/ {unitLabel}</span>
                </div>
                {err ? (
                  <div style={{ color: DANGER, fontSize: 11, fontWeight: 600 }}>{err}</div>
                ) : null}
              </div>

              {/* On/Off toggle — tenant can disable a fee entirely (engine skips it) */}
              <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  disabled={!editable}
                  onClick={() => updateDraft(rate.feeType, { isActive: !isOn })}
                  title={isOn ? 'Disable this fee' : 'Enable this fee'}
                  aria-pressed={isOn}
                  style={{
                    position: 'relative',
                    width: 44,
                    height: 26,
                    borderRadius: 999,
                    border: 'none',
                    background: isOn ? VIOLET : '#d2d2d7',
                    cursor: editable ? 'pointer' : 'not-allowed',
                    padding: 0,
                    transition: 'background 160ms ease'
                  }}
                >
                  <span style={{
                    position: 'absolute',
                    top: 3,
                    left: isOn ? 21 : 3,
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    background: '#fff',
                    boxShadow: '0 1px 3px rgba(0,0,0,.18)',
                    transition: 'left 160ms ease'
                  }} />
                </button>
              </div>

              <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, minWidth: 130 }}>
                {isLocationScope ? (
                  <span style={{ color: MUTED, fontSize: 11 }}>
                    Tenant default {formatMoney(rate.tenantDefaultAmount ?? rate.defaultAmount)}
                  </span>
                ) : (
                  <span style={{ color: MUTED, fontSize: 11 }}>
                    Default {formatMoney(rate.defaultAmount)}
                  </span>
                )}
                {editable && (dirty || overrideActive) ? (
                  isLocationScope ? (
                    <button
                      type="button"
                      onClick={() => (overrideActive ? deleteOverrideRow(rate.feeType) : resetRow(rate.feeType))}
                      title={overrideActive ? 'Delete this per-location override and revert to tenant default' : 'Clear edits to this row'}
                      style={{
                        padding: '4px 10px',
                        borderRadius: 8,
                        border: `1px solid ${DIVIDER}`,
                        background: '#fff',
                        color: VIOLET,
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer'
                      }}
                    >
                      {overrideActive ? 'Reset to tenant default' : 'Clear'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => resetRow(rate.feeType)}
                      title="Reset to platform default value"
                      style={{
                        padding: '4px 10px',
                        borderRadius: 8,
                        border: `1px solid ${DIVIDER}`,
                        background: '#fff',
                        color: VIOLET,
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer'
                      }}
                    >
                      &#x21BB; Reset
                    </button>
                  )
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {editable ? (
        <div
          style={{
            position: 'sticky',
            bottom: 0,
            background: 'rgba(255,255,255,.92)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            borderTop: `1px solid ${DIVIDER}`,
            padding: '12px 0',
            marginTop: 12,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10
          }}
        >
          <button
            type="button"
            onClick={discardAll}
            disabled={dirtyCount === 0 || saving}
            style={{
              padding: '9px 16px',
              borderRadius: 10,
              border: `1px solid ${DIVIDER}`,
              background: '#fff',
              color: INK,
              fontSize: 13,
              fontWeight: 600,
              cursor: dirtyCount === 0 || saving ? 'not-allowed' : 'pointer',
              opacity: dirtyCount === 0 || saving ? 0.55 : 1
            }}
          >
            Discard changes
          </button>
          <button
            type="button"
            onClick={save}
            disabled={dirtyCount === 0 || hasErrors || saving}
            style={{
              padding: '9px 18px',
              borderRadius: 10,
              border: 'none',
              background: VIOLET,
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              cursor: dirtyCount === 0 || hasErrors || saving ? 'not-allowed' : 'pointer',
              opacity: dirtyCount === 0 || hasErrors || saving ? 0.55 : 1,
              boxShadow: '0 4px 12px rgba(109,61,242,.32)'
            }}
          >
            {saving ? 'Saving…' : `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}`}
          </button>
        </div>
      ) : null}

      {/* V2 (pillar2 followup): Recent changes — audit history */}
      <div
        style={{
          marginTop: 18,
          border: `1px solid ${DIVIDER}`,
          borderRadius: 12,
          background: SURFACE,
          overflow: 'hidden'
        }}
      >
        <button
          type="button"
          onClick={() => setAuditOpen((v) => !v)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: INK,
            fontSize: 13,
            fontWeight: 600
          }}
          aria-expanded={auditOpen}
        >
          <span>Recent changes {auditEntries.length ? `(${auditEntries.length})` : ''}</span>
          <span style={{ color: MUTED, fontSize: 18, lineHeight: 1 }}>{auditOpen ? '\u2212' : '+'}</span>
        </button>
        {auditOpen ? (
          <div style={{ borderTop: `1px solid ${DIVIDER}`, padding: '8px 0' }}>
            {auditLoading ? (
              <p className="label" style={{ padding: '8px 16px', margin: 0, color: MUTED }}>
                Loading history…
              </p>
            ) : auditError ? (
              <div style={{ padding: '8px 16px' }}>
                <p className="error" style={{ margin: 0 }}>{auditError}</p>
                <button
                  type="button"
                  onClick={loadAuditEntries}
                  style={{ marginTop: 6, padding: '4px 10px', borderRadius: 8, border: `1px solid ${DIVIDER}`, background: '#fff', cursor: 'pointer', fontSize: 12 }}
                >
                  Retry
                </button>
              </div>
            ) : auditEntries.length === 0 ? (
              <p className="label" style={{ padding: '8px 16px', margin: 0, color: MUTED }}>
                No changes recorded yet.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {auditEntries.map((e) => (
                  <li
                    key={e.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '110px 1fr',
                      gap: 10,
                      padding: '8px 16px',
                      borderTop: `1px solid ${DIVIDER}`,
                      fontSize: 12
                    }}
                  >
                    <span style={{ color: MUTED, whiteSpace: 'nowrap' }} title={e.changedAt || ''}>
                      {relativeTime(e.changedAt)}
                    </span>
                    <span style={{ color: INK }}>
                      <strong style={{ fontWeight: 600 }}>{e.feeType}</strong>
                      <span style={{ color: MUTED }}> · {e.changeType.toLowerCase()}</span>
                      <span style={{ marginLeft: 8 }}>{diffSummary(e.before, e.after)}</span>
                      <span style={{ display: 'block', color: MUTED, marginTop: 2 }}>
                        by {e.actorEmail || e.actorUserId || 'unknown'}{e.actorRole ? ` (${e.actorRole})` : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      {savedToast ? (
        <div
          role="status"
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 32,
            transform: 'translateX(-50%)',
            background: INK,
            color: '#fff',
            padding: '12px 18px',
            borderRadius: 12,
            fontSize: 13,
            fontWeight: 600,
            boxShadow: '0 12px 30px rgba(0,0,0,.25)',
            zIndex: 50
          }}
        >
          {savedToast}
        </div>
      ) : null}
    </div>
  );
}
