'use client';

import { useEffect, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';
import { MODULE_DEFINITIONS } from '../../lib/moduleAccess';

const DEFAULTS = {
  companyName: 'Ride Fleet',
  companyAddress: 'San Juan, Puerto Rico',
  companyPhone: '(787) 000-0000',
  companyLogoUrl: '',
  termsText: '',
  returnInstructionsText: '',
  agreementHtmlTemplate: ''
};

const DEFAULT_EMAIL_TEMPLATES = {
  requestSignatureSubject: 'Signature Request - Reservation {{reservationNumber}}',
  requestSignatureBody: 'Hello {{customerName}},\n\nPlease sign your rental documents using this secure link:\n{{link}}\n\nThank you.',
  requestSignatureHtml: '<div>Hello {{customerName}},<br/><br/>Please sign your rental documents: <a href="{{link}}">{{link}}</a><br/><br/>Thanks,<br/>{{companyName}}</div>',
  requestCustomerInfoSubject: 'Customer Information Request - Reservation {{reservationNumber}}',
  requestCustomerInfoBody: 'Hello {{customerName}},\n\nPlease complete your pre-check-in information here:\n{{link}}\n\nThank you.',
  requestCustomerInfoHtml: '<div>Hello {{customerName}},<br/><br/>Please complete pre-check-in info: <a href="{{link}}">{{link}}</a><br/><br/>Thanks,<br/>{{companyName}}</div>',
  requestPaymentSubject: 'Payment Request - Reservation {{reservationNumber}}',
  requestPaymentBody: 'Hello {{customerName}},\n\nPlease complete payment using this secure link:\n{{link}}\n\nThank you.',
  requestPaymentHtml: '<div>Hello {{customerName}},<br/><br/>Please complete payment: <a href="{{link}}">{{link}}</a><br/><br/>Thanks,<br/>{{companyName}}</div>',
  reservationDetailSubject: 'Reservation Details - {{reservationNumber}}',
  reservationDetailBody: 'Hello {{customerName}},\n\nReservation #: {{reservationNumber}}\nStatus: {{status}}\nPickup: {{pickupAt}}\nReturn: {{returnAt}}\nPickup Location: {{pickupLocation}}\nReturn Location: {{returnLocation}}\nVehicle: {{vehicle}}\nDaily Rate: {{dailyRate}}\nEstimated Total: {{estimatedTotal}}\n\nThank you.',
  reservationDetailHtml: '<div>Hello {{customerName}},<br/><br/>Reservation #: <b>{{reservationNumber}}</b><br/>Status: {{status}}<br/>Pickup: {{pickupAt}}<br/>Return: {{returnAt}}<br/>Pickup Location: {{pickupLocation}}<br/>Return Location: {{returnLocation}}<br/>Vehicle: {{vehicle}}<br/>Daily Rate: {{dailyRate}}<br/>Estimated Total: {{estimatedTotal}}<br/><br/>Thank you,<br/>{{companyName}}</div>',
  returnReceiptSubject: 'Return Receipt - Reservation {{reservationNumber}}',
  returnReceiptBody: 'Hello {{customerName}},\n\nYour rental agreement has been closed.\nReservation: {{reservationNumber}}\nTotal Paid: {{paidAmount}}\nBalance: {{balance}}\n\nThank you for choosing us.',
  returnReceiptHtml: '<div>Hello {{customerName}},<br/><br/>Your rental agreement has been closed.<br/>Reservation: <b>{{reservationNumber}}</b><br/>Total Paid: <b>${{paidAmount}}</b><br/>Balance: <b>${{balance}}</b><br/><br/>Thank you for choosing {{companyName}}.</div>',
  rentalReviewRequestSubject: 'How Was Your Rental Experience? - Reservation {{reservationNumber}}',
  rentalReviewRequestBody: 'Hello {{customerName}},\n\nThank you for renting with {{companyName}}. Your reservation {{reservationNumber}} has been checked in successfully.\n\nWe would love to hear about your experience. Please reply to this email or leave your review using your preferred review channel.\n\nThank you again,\n{{companyName}}',
  rentalReviewRequestHtml: '<div>Hello {{customerName}},<br/><br/>Thank you for renting with {{companyName}}. Your reservation <b>{{reservationNumber}}</b> has been checked in successfully.<br/><br/>We would love to hear about your experience. Please reply to this email or leave your review using your preferred review channel.<br/><br/>Thank you again,<br/>{{companyName}}</div>',
  agreementEmailSubject: 'Your Rental Agreement {{agreementNumber}}',
  agreementEmailHtml: '<div>Hello {{customerName}},<br/><br/>Attached is your rental agreement <b>{{agreementNumber}}</b>.<br/><br/>Thanks,<br/>{{companyName}}</div>'
};

const DEFAULT_PAYMENT_GATEWAY_CONFIG = {
  gateway: 'authorizenet',
  label: 'Primary payment gateway',
  authorizenet: {
    enabled: true,
    environment: 'sandbox',
    loginId: '',
    transactionKey: '',
    clientKey: ''
  },
  stripe: {
    enabled: false,
    secretKey: '',
    publishableKey: '',
    webhookSecret: ''
  },
  square: {
    enabled: false,
    environment: 'production',
    accessToken: '',
    applicationId: '',
    locationId: ''
  }
};

const EMPTY_LOCATION = { code: '', name: '', address: '', city: '', state: '', country: 'Puerto Rico', taxRate: '11.5', isActive: true };
const LOCATION_CONFIG_DEFAULT = {
  gracePeriodMin: 60,
  chargeAgeMin: 21,
  chargeAgeMax: 75,
  underageAlertEnabled: false,
  underageAlertAge: 25,
  defaultRatePlan: 'RETAIL_RATE',
  currency: 'USD',
  paymentDueAction: 'AT_BOOKING',
  paymentWarning: 'DISPLAY_WARNING',
  requirePaymentOnDebit: false,
  requireRefundIfDue: false,
  allowOptionalServices: true,
  maintenanceHoldMiles: 500,
  maxMilesBlockedReturn: 365,
  requireDeposit: false,
  depositMode: 'FIXED',
  depositAmount: 0,
  depositPercentBasis: ['rate'],
  requireSecurityDeposit: false,
  securityDepositMode: 'FIXED',
  securityDepositAmount: 0,
  tollPolicyEnabled: false,
  tollTaxable: false,
  tollAdditionalFeeEnabled: false,
  tollAdditionalFeeMode: 'FIXED',
  tollAdditionalFeeAmount: 0,
  locationEmail: '',
  locationPhone: '',
  pickupInstructions: '',
  dropoffInstructions: '',
  operationsOpenTime: '08:00',
  operationsCloseTime: '18:00',
  weeklyHours: {
    sunday: { enabled: false, open: '08:00', close: '18:00' },
    monday: { enabled: true, open: '08:00', close: '18:00' },
    tuesday: { enabled: true, open: '08:00', close: '18:00' },
    wednesday: { enabled: true, open: '08:00', close: '18:00' },
    thursday: { enabled: true, open: '08:00', close: '18:00' },
    friday: { enabled: true, open: '08:00', close: '18:00' },
    saturday: { enabled: true, open: '08:00', close: '18:00' }
  },
  allowOutsideHours: false,
  outsideHoursFeeEnabled: false,
  outsideHoursFeeMode: 'FIXED',
  outsideHoursFeeAmount: 0,
  outsideHoursPickupInstructions: '',
  outsideHoursDropoffInstructions: '',
  closedWeekdays: [],
  closedDates: []
};
const EMPTY_FEE = { code: '', name: '', description: '', mode: 'FIXED', amount: '', taxable: false, isActive: true, mandatory: false, isUnderageFee: false, isAdditionalDriverFee: false };
const EMPTY_RATE = {
  id: '',
  rateCode: '',
  name: '',
  locationId: '',
  locationIds: [],
  rateType: 'MULTIPLE_CLASSES',
  calculationBy: '24_HOUR_TIME',
  averageBy: 'DATE_RANGE',
  daily: '',
  fuelChargePerGallon: '',
  minChargeDays: '',
  extraMileCharge: '',
  graceMinutes: '',
  useHourlyRates: false,
  active: true,
  displayOnline: false,
  sameSpecialRates: false,
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: true,
  sunday: true,
  effectiveDate: '',
  endDate: '',
  isActive: true,
  rateItems: [],
  dailyPrices: []
};
const EMPTY_SERVICE = {
  code: '', name: '', description: '', chargeType: 'UNIT', unitLabel: 'Unit', calculationBy: '24_HOUR_TIME',
  rate: '', dailyRate: '', weeklyRate: '', monthlyRate: '', commissionValueType: '', commissionPercentValue: '', commissionFixedAmount: '', taxable: false, defaultQty: '1', sortOrder: '0',
  allVehicleTypes: true, vehicleTypeIds: [], displayOnline: false, defaultRencars: false, mandatory: false, coversTolls: false,
  isActive: true, locationId: '', linkedFeeId: ''
};
const EMPTY_VEHICLE_TYPE = { code: '', name: '', description: '', imageUrl: '' };
const EMPTY_COMMISSION_PLAN = {
  id: '',
  tenantId: '',
  name: '',
  isActive: true,
  defaultValueType: '',
  defaultPercentValue: '',
  defaultFixedAmount: ''
};
const EMPTY_COMMISSION_RULE = {
  id: '',
  name: '',
  serviceId: '',
  chargeCode: '',
  chargeType: '',
  valueType: 'PERCENT',
  percentValue: '',
  fixedAmount: '',
  priority: '0',
  isActive: true
};

function parseDelimitedRows(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(delimiter).map((item) => item.trim());

  return lines.slice(1).map((line) => {
    const values = line.split(delimiter).map((item) => item.trim());
    return headers.reduce((acc, header, idx) => {
      acc[header] = values[idx] ?? '';
      return acc;
    }, {});
  });
}

function normalizeInsurancePlan(p = {}) {
  return {
    code: p.code || '',
    name: p.name || '',
    label: p.label || p.name || '',
    description: p.description || '',
    chargeBy: p.chargeBy || p.mode || 'FIXED',
    amount: Number(p.amount || 0),
    commissionValueType: p.commissionValueType || '',
    commissionPercentValue: p.commissionPercentValue ?? '',
    commissionFixedAmount: p.commissionFixedAmount ?? '',
    taxable: !!p.taxable,
    isActive: p.isActive !== false,
    locationIds: Array.isArray(p.locationIds) ? p.locationIds : [],
    vehicleTypeIds: Array.isArray(p.vehicleTypeIds) ? p.vehicleTypeIds : []
  };
}

const SETTINGS_CORE_SECTIONS = ['agreement', 'locations', 'vehicleTypes', 'reservationOptions', 'paymentGateway', 'tenantModules'];
const SETTINGS_TAB_SECTIONS = {
  agreement: [],
  locations: ['fees'],
  fees: ['fees'],
  rates: ['rates'],
  vehicleTypes: [],
  insurance: ['insurancePlans'],
  payments: [],
  access: [],
  emails: ['emailTemplates'],
  services: ['services', 'fees'],
  commissions: []
};

export default function SettingsPage() {
  return <AuthGate>{({ token, me, logout }) => <SettingsInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function SettingsInner({ token, me, logout }) {
  const [tab, setTab] = useState('agreement');
  const [msg, setMsg] = useState('');

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
  const [reservationOptions, setReservationOptions] = useState({ autoAssignVehicleFromType: false });
  const [paymentGatewayConfig, setPaymentGatewayConfig] = useState(DEFAULT_PAYMENT_GATEWAY_CONFIG);
  const [paymentGatewayHealth, setPaymentGatewayHealth] = useState(null);
  const [tenantModuleAccess, setTenantModuleAccess] = useState({});
  const [loadedSettingsSections, setLoadedSettingsSections] = useState({});

  const [locationForm, setLocationForm] = useState(EMPTY_LOCATION);
  const [feeForm, setFeeForm] = useState(EMPTY_FEE);
  const [rateForm, setRateForm] = useState(EMPTY_RATE);
  const [rateDailyUploadRows, setRateDailyUploadRows] = useState([]);
  const [rateDailyUploadName, setRateDailyUploadName] = useState('');
  const [rateDailyUploadReport, setRateDailyUploadReport] = useState(null);
  const [serviceForm, setServiceForm] = useState(EMPTY_SERVICE);
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

  const role = String(me?.role || '').toUpperCase().trim();
  const isAdmin = role === 'ADMIN' || role === 'SUPER_ADMIN';
  const isSuper = role === 'SUPER_ADMIN';

  const scopedSettingsPath = (path, tenantId = activeSettingsTenantId) => {
    if (!isSuper || !tenantId) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}tenantId=${encodeURIComponent(tenantId)}`;
  };

  const applySettingsSection = (key, value) => {
    if (key === 'agreement') setCfg(value || DEFAULTS);
    if (key === 'locations') setLocations(Array.isArray(value) ? value : []);
    if (key === 'services') setServices(Array.isArray(value) ? value : []);
    if (key === 'fees') setFees(Array.isArray(value) ? value : []);
    if (key === 'rates') setRates(Array.isArray(value) ? value : []);
    if (key === 'vehicleTypes') setVehicleTypes(Array.isArray(value) ? value : []);
    if (key === 'insurancePlans') setInsurancePlans((value || []).map(normalizeInsurancePlan));
    if (key === 'emailTemplates') setEmailTemplates({ ...DEFAULT_EMAIL_TEMPLATES, ...(value || {}) });
    if (key === 'reservationOptions') setReservationOptions({ autoAssignVehicleFromType: !!value?.autoAssignVehicleFromType });
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
        }
      });
    }
    if (key === 'tenantModules') setTenantModuleAccess(value?.config || {});
  };

  const sectionLoaders = {
    agreement: (forceLoad = false) => api(scopedSettingsPath('/api/settings/rental-agreement'), forceLoad ? { bypassCache: true } : {}, token),
    locations: (forceLoad = false) => api(scopedSettingsPath('/api/locations'), forceLoad ? { bypassCache: true } : {}, token),
    services: (forceLoad = false) => api(scopedSettingsPath('/api/additional-services'), forceLoad ? { bypassCache: true } : {}, token),
    fees: (forceLoad = false) => api(scopedSettingsPath('/api/fees'), forceLoad ? { bypassCache: true } : {}, token),
    rates: (forceLoad = false) => api(scopedSettingsPath('/api/rates'), forceLoad ? { bypassCache: true } : {}, token),
    vehicleTypes: (forceLoad = false) => api(scopedSettingsPath('/api/vehicle-types'), forceLoad ? { bypassCache: true } : {}, token),
    insurancePlans: (forceLoad = false) => api(scopedSettingsPath('/api/settings/insurance-plans'), forceLoad ? { bypassCache: true } : {}, token),
    emailTemplates: (forceLoad = false) => api(scopedSettingsPath('/api/settings/email-templates'), forceLoad ? { bypassCache: true } : {}, token),
    reservationOptions: (forceLoad = false) => api(scopedSettingsPath('/api/settings/reservation-options'), forceLoad ? { bypassCache: true } : {}, token),
    paymentGateway: (forceLoad = false) => api(scopedSettingsPath('/api/settings/payment-gateway'), forceLoad ? { bypassCache: true } : {}, token),
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
    setReservationOptions({ autoAssignVehicleFromType: false });
    setPaymentGatewayConfig(DEFAULT_PAYMENT_GATEWAY_CONFIG);
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

  const saveEmailTemplates = async () => {
    const out = await api(scopedSettingsPath('/api/settings/email-templates'), { method: 'PUT', body: JSON.stringify(emailTemplates) }, token);
    setEmailTemplates({ ...DEFAULT_EMAIL_TEMPLATES, ...(out || {}) });
    setMsg('Email templates saved');
  };

  const saveReservationOptions = async () => {
    const out = await api(scopedSettingsPath('/api/settings/reservation-options'), { method: 'PUT', body: JSON.stringify(reservationOptions) }, token);
    setReservationOptions({ autoAssignVehicleFromType: !!out?.autoAssignVehicleFromType });
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
      }
    });
    setMsg('Payment gateway settings saved');
  };

  const runPaymentGatewayHealthCheck = async () => {
    const out = await api(scopedSettingsPath('/api/settings/payment-gateway/health-check'), { method: 'POST' }, token);
    setPaymentGatewayHealth(out);
    setMsg(out?.summary || 'Payment gateway check complete');
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

    await patchLocation(locationEditor.id, {
      code: locationEditor.code,
      name: locationEditor.name,
      address: locationEditor.address,
      city: locationEditor.city,
      state: locationEditor.state,
      country: locationEditor.country,
      isActive: !!locationEditor.isActive,
      taxRate: tax,
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

  const loadRateDailyPricingFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    const rows = parseDelimitedRows(text);
    setRateDailyUploadRows(rows);
    setRateDailyUploadName(file.name || 'pricing-upload.csv');
    setRateDailyUploadReport(null);
    setMsg(rows.length ? `Loaded ${rows.length} dynamic pricing row(s) from ${file.name}` : 'No pricing rows found in that file');
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
  const rateDailyPricePreview = rateDailyPrices.slice(0, 24);
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
        square: 'Square'
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
    vehicleTypes: 'Vehicle Types',
    insurance: 'Insurance',
    payments: 'Payments',
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
            <button type="button" onClick={() => setTab('services')}>Online Services</button>
            <button type="button" onClick={() => setTab('insurance')}>Insurance</button>
            <button type="button" onClick={() => setTab('payments')}>Payments</button>
            <button type="button" onClick={() => setTab('access')}>Access Control</button>
            <button type="button" onClick={() => setTab('agreement')}>Agreement</button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setTab('agreement')}>Agreement</button>
          <button onClick={() => setTab('locations')}>Locations</button>
          <button onClick={() => setTab('fees')}>Fees</button>
          <button onClick={() => setTab('rates')}>Rates</button>
          <button onClick={() => setTab('vehicleTypes')}>Vehicle Types</button>
          <button onClick={() => setTab('insurance')}>Insurance</button>
          <button onClick={() => setTab('payments')}>Payments</button>
          <button onClick={() => setTab('access')}>Access Control</button>
          <button onClick={() => setTab('emails')}>Emails</button>
          <button onClick={() => setTab('services')}>Additional Services</button>
          <button onClick={() => setTab('commissions')}>Commissions</button>
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
            <textarea rows={6} placeholder="Terms and Conditions" value={cfg.termsText || ''} onChange={(e) => setCfg({ ...cfg, termsText: e.target.value })} />
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
              <label className="label" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={!!reservationOptions.autoAssignVehicleFromType}
                  onChange={(e) => setReservationOptions({ ...reservationOptions, autoAssignVehicleFromType: e.target.checked })}
                />
                Auto-assign vehicle on reservation create (from available vehicles in selected vehicle type)
              </label>
              <div style={{ marginTop: 10 }}>
                <button onClick={saveReservationOptions}>Save Reservation Options</button>
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
                </select>
              </div>
              <div className="stack">
                <label className="label">Gateway Label</label>
                <input value={paymentGatewayConfig.label || ''} onChange={(e) => setPaymentGatewayConfig({ ...paymentGatewayConfig, label: e.target.value })} placeholder="Primary payment gateway" />
              </div>
            </div>

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

        {tab === 'access' && (
          <div className="stack">
            <h2>Tenant Module Access</h2>
            <div className="surface-note">
              Control which workspace modules are enabled for this tenant. User-level permissions can only narrow access further. Car Sharing and Loaner still depend on their tenant feature flags too.
            </div>
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
              </div>
              <button type="submit">Add Fee</button>
            </form>

            <table>
              <thead><tr><th>Name</th><th>Mode</th><th>Amount</th><th>Mandatory</th><th>Underage Fee</th><th>Addl Driver Fee</th><th>Active</th><th>Actions</th></tr></thead>
              <tbody>
                {fees.map((f) => (
                  <tr key={f.id}>
                    <td>{f.name}</td><td>{f.mode}</td><td>{Number(f.amount || 0).toFixed(2)}</td><td>{f.mandatory ? 'Yes' : 'No'}</td><td>{f.isUnderageFee ? 'Yes' : 'No'}</td><td>{f.isAdditionalDriverFee ? 'Yes' : 'No'}</td><td>{f.isActive ? 'Yes' : 'No'}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => editFee(f)}>Edit</button>
                      <button onClick={async () => { await api(scopedSettingsPath(`/api/fees/${f.id}`), { method: 'PATCH', body: JSON.stringify({ mandatory: !f.mandatory }) }, token); setMsg('Mandatory fee flag updated'); await load(true); }}>{f.mandatory ? 'Unset Mandatory' : 'Set Mandatory'}</button>
                      <button onClick={async () => { await api(scopedSettingsPath(`/api/fees/${f.id}`), { method: 'PATCH', body: JSON.stringify({ isUnderageFee: !f.isUnderageFee }) }, token); setMsg('Underage fee flag updated'); await load(true); }}>{f.isUnderageFee ? 'Unset Underage' : 'Set Underage'}</button>
                      <button onClick={() => toggleFee(f)}>{f.isActive ? 'Disable' : 'Enable'}</button>
                      <button onClick={() => removeFee(f.id)}>Delete</button>
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
                      Upload an Excel-friendly CSV template to set a different daily rate by date for each vehicle class, like March 1 = $5 and March 2 = $6. Dates can be YYYY-MM-DD or MM/DD/YYYY.
                    </div>
                  </div>
                  <span className="badge">{rateDailyPrices.length} daily overrides</span>
                </div>

                {!rateForm.id ? (
                  <div className="surface-note" style={{ marginTop: 12 }}>
                    Save the rate first, then upload your date-based daily prices.
                  </div>
                ) : (
                  <div className="stack" style={{ marginTop: 12 }}>
                    <div className="inline-actions">
                      <button type="button" onClick={downloadRateDailyPricingTemplate}>Download Template</button>
                      <label className="button-subtle" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                        Upload CSV
                        <input
                          type="file"
                          accept=".csv,.txt,text/csv"
                          style={{ display: 'none' }}
                          onChange={(e) => loadRateDailyPricingFile(e.target.files?.[0])}
                        />
                      </label>
                      <button type="button" className="button-subtle" onClick={validateRateDailyPricing} disabled={!rateDailyUploadRows.length}>Validate Upload</button>
                      <button type="button" onClick={importRateDailyPricing} disabled={!rateDailyUploadRows.length}>Import Daily Pricing</button>
                    </div>

                    {rateDailyUploadName ? (
                      <div className="surface-note">
                        Loaded file: <strong>{rateDailyUploadName}</strong> with <strong>{rateDailyUploadRows.length}</strong> row(s).
                      </div>
                    ) : null}

                    {rateDailyUploadReport ? (
                      <div className="surface-note">
                        <strong>Validation summary:</strong> {rateDailyUploadReport.validCount || 0} valid row(s), {rateDailyUploadReport.errorCount || 0} issue(s).
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

                    {rateDailyPrices.length ? (
                      <div className="stack">
                        <label className="label">Current Daily Overrides</label>
                        <table>
                          <thead><tr><th>Date</th><th>Vehicle Type</th><th>Daily Rate</th><th>Actions</th></tr></thead>
                          <tbody>
                            {rateDailyPricePreview.map((row) => (
                              <tr key={row.id || `${row.date}-${row.vehicleTypeId}`}>
                                <td>{row.date || '-'}</td>
                                <td>{row.vehicleTypeCode ? `${row.vehicleTypeCode} - ${row.vehicleTypeName || ''}` : row.vehicleTypeName || row.vehicleTypeId}</td>
                                <td>${Number(row.daily || 0).toFixed(2)}</td>
                                <td>{row.id ? <button type="button" className="button-subtle" onClick={() => removeRateDailyPrice(row.id)}>Remove</button> : '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {rateDailyPrices.length > rateDailyPricePreview.length ? (
                          <span className="label">Showing first {rateDailyPricePreview.length} of {rateDailyPrices.length} daily overrides.</span>
                        ) : null}
                      </div>
                    ) : (
                      <div className="surface-note">No daily overrides uploaded yet. Base daily rates above will still apply.</div>
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

        {tab === 'emails' && (
          <div className="stack">
            <h2>Email Templates</h2>
            <div className="label">Available placeholders: {'{{customerName}}'}, {'{{reservationNumber}}'}, {'{{link}}'}, {'{{expiresAt}}'}, {'{{agreementNumber}}'}, {'{{pickupAt}}'}, {'{{returnAt}}'}, {'{{total}}'}, {'{{amountPaid}}'}, {'{{amountDue}}'}, {'{{portalLink}}'}, {'{{companyName}}'}, {'{{companyAddress}}'}, {'{{companyPhone}}'}, {'{{pickupLocation}}'}, {'{{returnLocation}}'}, {'{{workflowMode}}'}</div>

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
                <label className="label"><input type="checkbox" checked={serviceForm.coversTolls} onChange={(e) => setServiceForm({ ...serviceForm, coversTolls: e.target.checked })} /> Toll Package / Prepaid Tolls</label>
                <label className="label"><input type="checkbox" checked={serviceForm.isActive} onChange={(e) => setServiceForm({ ...serviceForm, isActive: e.target.checked })} /> Active</label>
              </div>

              <div className="grid2">
                <select value={serviceForm.locationId} onChange={(e) => setServiceForm({ ...serviceForm, locationId: e.target.value })}>
                  <option value="">All locations (global)</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <input placeholder="Sort Order" value={serviceForm.sortOrder} onChange={(e) => setServiceForm({ ...serviceForm, sortOrder: e.target.value })} />
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
                    <td>{s.coversTolls ? 'Yes' : 'No'}</td>
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
                          <div className="label">{plan.id === activeCommissionPlanId ? 'Selected plan' : ''}</div>
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

                  <div className="label">Location Contact & Instructions</div>
                  <div className="grid2">
                    <div className="stack"><label className="label">Location Email (confirmation copy)</label><input placeholder="location@email.com" value={locationEditor.config?.locationEmail || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), locationEmail: e.target.value } })} /></div>
                    <div className="stack"><label className="label">Location Phone</label><input placeholder="(000) 000-0000" value={locationEditor.config?.locationPhone || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), locationPhone: e.target.value } })} /></div>
                  </div>
                  <div className="stack"><label className="label">Pickup Instructions</label><textarea rows={3} value={locationEditor.config?.pickupInstructions || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), pickupInstructions: e.target.value } })} /></div>
                  <div className="stack"><label className="label">Drop-off Instructions</label><textarea rows={3} value={locationEditor.config?.dropoffInstructions || ''} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), dropoffInstructions: e.target.value } })} /></div>
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
                  </div>
                  <span className="label">Tip: Min age must be at least 16 and max age must be ≥ min age. Underage alert adds a reservation warning note when customer age is below alert age.</span>
                </>
              )}

              {locationEditorTab === 'payments' && (
                <>
                <div className="grid2">
                  <div className="stack"><label className="label">Currency</label><select value={locationEditor.config?.currency || 'USD'} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), currency: e.target.value } })}>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select></div>
                  <div className="stack"><label className="label">Payment Due Action</label><select value={locationEditor.config?.paymentDueAction || 'AT_BOOKING'} onChange={(e) => setLocationEditor({ ...locationEditor, config: { ...(locationEditor.config || {}), paymentDueAction: e.target.value } })}>
                    <option value="AT_BOOKING">At Booking</option>
                    <option value="AT_PICKUP">At Pickup</option>
                    <option value="AT_RETURN">At Return</option>
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

