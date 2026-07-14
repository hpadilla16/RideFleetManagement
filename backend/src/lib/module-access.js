import { prisma } from './prisma.js';
import { cache } from './cache.js';
import { globalKey } from './cache/tenantKey.js';

export const MODULE_KEYS = [
  'dashboard',
  'reservations',
  'vehicles',
  'maintenance',
  'customers',
  'people',
  'planner',
  'reports',
  'carSharing',
  'hostApp',
  'employeeApp',
  'issueCenter',
  'loaner',
  'tolls',
  'citations',
  'kiosk',
  'marketIntelligence',
  'settings',
  'security',
  'tenants'
];

export const MODULE_LABELS = {
  dashboard: 'Dashboard',
  reservations: 'Reservations',
  vehicles: 'Vehicles',
  maintenance: 'Maintenance',
  customers: 'Customers',
  people: 'People',
  planner: 'Planner',
  reports: 'Reports',
  carSharing: 'Car Sharing',
  hostApp: 'Host App',
  employeeApp: 'Employee App',
  issueCenter: 'Issue Center',
  loaner: 'Loaner Program',
  tolls: 'Tolls',
  citations: 'Citations',
  kiosk: 'Kiosk',
  marketIntelligence: 'Market Intelligence',
  settings: 'Settings',
  security: 'Security',
  tenants: 'Tenants'
};

function hostRoleModuleMap() {
  return {
    dashboard: true,
    reservations: false,
    vehicles: false,
    maintenance: false,
    customers: false,
    people: false,
    planner: false,
    reports: false,
    carSharing: false,
    hostApp: true,
    employeeApp: false,
    issueCenter: false,
    loaner: false,
    tolls: false,
    citations: false,
    kiosk: false,
    marketIntelligence: false,
    settings: false,
    security: false,
    tenants: false
  };
}

export function scopedSettingKey(baseKey, scope = {}) {
  return scope?.tenantId ? `tenant:${scope.tenantId}:${baseKey}` : baseKey;
}

function normalizeBooleanMap(value = {}) {
  const out = {};
  for (const key of MODULE_KEYS) out[key] = value?.[key] !== false;
  return out;
}

export function roleAllowedModuleMap(roleOrUser) {
  const current = String(
    typeof roleOrUser === 'object' && roleOrUser !== null ? roleOrUser.role : roleOrUser
  ).toUpperCase();
  const base = Object.fromEntries(MODULE_KEYS.map((key) => [key, false]));
  const hasHostProfile =
    typeof roleOrUser === 'object' &&
    roleOrUser !== null &&
    !!(roleOrUser.hostProfileId || roleOrUser.hostProfile?.id);

  if (hasHostProfile && current !== 'SUPER_ADMIN') {
    return hostRoleModuleMap();
  }

  if (current === 'SUPER_ADMIN') {
    for (const key of MODULE_KEYS) base[key] = true;
    return base;
  }

  if (current === 'ADMIN') {
    return {
      ...base,
      dashboard: true,
      reservations: true,
      vehicles: true,
      maintenance: true,
      customers: true,
      people: true,
      planner: true,
      reports: true,
      carSharing: true,
      hostApp: true,
      employeeApp: true,
      issueCenter: true,
      loaner: true,
      tolls: true,
      citations: true,
      kiosk: true,
      settings: true,
      security: true,
      marketIntelligence: true,
      tenants: false
    };
  }

  if (current === 'OPS') {
    return {
      ...base,
      dashboard: true,
      reservations: true,
      vehicles: true,
      maintenance: true,
      customers: true,
      people: false,
      planner: true,
      reports: true,
      carSharing: true,
      hostApp: true,
      employeeApp: true,
      issueCenter: true,
      loaner: true,
      tolls: true,
      citations: true,
      kiosk: true,
      settings: false,
      security: false,
      marketIntelligence: true,
      tenants: false
    };
  }

  return {
    ...base,
    dashboard: true,
    reservations: true,
    vehicles: true,
    maintenance: true,
    customers: true,
    people: false,
    planner: true,
    reports: false,
    carSharing: false,
    hostApp: true,
    employeeApp: true,
    issueCenter: true,
    loaner: true,
    tolls: false,
    citations: true,
    kiosk: false,
    settings: false,
    security: false,
    marketIntelligence: true,
    tenants: false
  };
}

export function defaultTenantModuleConfig(tenant = null) {
  return {
    dashboard: true,
    reservations: true,
    vehicles: true,
    maintenance: true,
    customers: true,
    people: true,
    planner: true,
    reports: true,
    carSharing: !!tenant?.carSharingEnabled,
    hostApp: !!tenant?.carSharingEnabled,
    employeeApp: true,
    issueCenter: true,
    loaner: !!tenant?.dealershipLoanerEnabled,
    tolls: !!tenant?.tollsEnabled,
    citations: true,
    // Kiosk is OPT-IN per tenant (Hector, 2026-07-04 — unlike beta.212's
    // default-ON maintenance/citations). Enforced fail-closed in
    // normalizeTenantModuleConfig below.
    kiosk: false,
    marketIntelligence: !!tenant?.marketIntelligenceEnabled,
    settings: true,
    security: true,
    tenants: false
  };
}

function normalizeTenantModuleConfig(raw = {}, tenant = null) {
  const defaults = defaultTenantModuleConfig(tenant);
  const parsed = normalizeBooleanMap(raw || {});
  const next = {
    ...defaults,
    ...parsed,
    carSharing: !!parsed.carSharing && !!tenant?.carSharingEnabled,
    hostApp: !!parsed.hostApp && !!parsed.carSharing && !!tenant?.carSharingEnabled,
    loaner: !!parsed.loaner && !!tenant?.dealershipLoanerEnabled,
    tolls: !!parsed.tolls && !!tenant?.tollsEnabled,
    // normalizeBooleanMap treats MISSING keys as true, which would silently
    // flip kiosk ON for every tenant whose stored config predates the module.
    // Kiosk is default-OFF: only an EXPLICIT true in the stored config enables it.
    kiosk: (raw || {})?.kiosk === true,
    marketIntelligence: !!parsed.marketIntelligence && !!tenant?.marketIntelligenceEnabled,
    tenants: false
  };
  return next;
}

function normalizeUserModuleConfig(raw = {}) {
  const out = {};
  for (const key of MODULE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw || {}, key)) out[key] = !!raw[key];
  }
  return out;
}

export async function getTenantModuleConfig(tenantId) {
  if (!tenantId) {
    // Kiosk stays default-OFF even in this tenantless fallback —
    // normalizeBooleanMap() alone would report it as true.
    return normalizeTenantModuleConfig({ ...normalizeBooleanMap(), kiosk: false }, {
      carSharingEnabled: true,
      dealershipLoanerEnabled: true,
      tollsEnabled: true,
      marketIntelligenceEnabled: true
    });
  }
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      carSharingEnabled: true,
      dealershipLoanerEnabled: true,
      tollsEnabled: true,
      marketIntelligenceEnabled: true
    }
  });
  if (!tenant) return defaultTenantModuleConfig(null);
  const row = await prisma.appSetting.findUnique({ where: { key: scopedSettingKey('moduleAccess', { tenantId }) } });
  let parsed = {};
  try {
    parsed = row?.value ? JSON.parse(row.value) : {};
  } catch {
    parsed = {};
  }
  return normalizeTenantModuleConfig(parsed, tenant);
}

export async function updateTenantModuleConfig(tenantId, payload = {}) {
  if (!tenantId) throw new Error('tenantId is required');
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    // marketIntelligenceEnabled MUST be selected: normalizeTenantModuleConfig
    // gates marketIntelligence on it, so omitting it forced the module OFF on
    // every save (the tenant-modules toggle would never stick). 2026-07-14.
    select: {
      id: true,
      carSharingEnabled: true,
      dealershipLoanerEnabled: true,
      tollsEnabled: true,
      marketIntelligenceEnabled: true
    }
  });
  if (!tenant) throw new Error('Tenant not found');
  const next = normalizeTenantModuleConfig(payload, tenant);
  const key = scopedSettingKey('moduleAccess', { tenantId });
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) }
  });
  // Invalidate all cached sessions since tenant config affects all users in this tenant
  cache.invalidate('session:');
  return next;
}

export async function getStoredUserModuleConfig(userId) {
  const row = await prisma.appSetting.findUnique({ where: { key: `user:${userId}:moduleAccess` } });
  if (!row?.value) return {};
  try {
    return normalizeUserModuleConfig(JSON.parse(row.value) || {});
  } catch {
    return {};
  }
}

export async function updateStoredUserModuleConfig(userId, payload = {}) {
  const next = normalizeUserModuleConfig(payload);
  const key = `user:${userId}:moduleAccess`;
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) }
  });
  // Invalidate cached session for this user
  // session:<userId> is intentionally GLOBAL — user sessions span tenants
  // (a SUPER_ADMIN's session is not bound to one tenant). See PR-3b.
  cache.del(globalKey('session', userId));
  return next;
}

export async function getEditableModuleAccessForUser(user) {
  const roleAllowed = roleAllowedModuleMap(user);
  const tenantConfig = await getTenantModuleConfig(user?.tenantId || null);
  const storedConfig = await getStoredUserModuleConfig(user?.id);
  const config = {};

  for (const key of MODULE_KEYS) {
    const tenantEnabled = tenantConfig[key] !== false;
    const hasUserOverride = Object.prototype.hasOwnProperty.call(storedConfig, key);
    const roleEnabled = roleAllowed[key] !== false;
    // User-level override takes priority over role default, but tenant config is always enforced
    const moduleEnabled = hasUserOverride ? !!storedConfig[key] : roleEnabled;
    config[key] = !!tenantEnabled && !!moduleEnabled;
  }

  return { tenantConfig, storedConfig, config };
}

export async function getEffectiveModuleAccessForUser(user) {
  if (String(user?.role || '').toUpperCase() === 'SUPER_ADMIN') {
    const allEnabled = Object.fromEntries(MODULE_KEYS.map((key) => [key, true]));
    return {
      tenantConfig: allEnabled,
      userConfig: allEnabled,
      effective: allEnabled
    };
  }

  const { tenantConfig, storedConfig, config } = await getEditableModuleAccessForUser(user);

  // Program scoping (2026-07-02): a RENTAL_ONLY employee loses the loaner
  // module entirely (nav + requireModuleAccess('loaner') routes → 403).
  // LOANER_ONLY is intentionally NOT clamped — Hector's decision: those
  // employees keep all their modules, data-filtered to loaner rows instead.
  // ADMIN is never program-scoped (mirrors the location-scoping bypass in
  // lib/tenant-scope.js userProgramScope — inlined here rather than imported
  // to keep module-access free of the auth-middleware import cycle).
  // SUPER_ADMIN already returned all-enabled above.
  const role = String(user?.role || '').toUpperCase();
  if (role !== 'ADMIN' && String(user?.programScope || '').toUpperCase() === 'RENTAL_ONLY') {
    config.loaner = false;
  }

  return {
    tenantConfig,
    userConfig: storedConfig,
    effective: config
  };
}
