import { prisma } from './prisma.js';
import { cache } from './cache.js';

export const MODULE_KEYS = [
  'dashboard',
  'reservations',
  'vehicles',
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
  'settings',
  'security',
  'tenants'
];

export const MODULE_LABELS = {
  dashboard: 'Dashboard',
  reservations: 'Reservations',
  vehicles: 'Vehicles',
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
  settings: 'Settings',
  security: 'Security',
  tenants: 'Tenants'
};

function hostRoleModuleMap() {
  return {
    dashboard: true,
    reservations: false,
    vehicles: false,
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
      settings: true,
      security: true,
      tenants: false
    };
  }

  if (current === 'OPS') {
    return {
      ...base,
      dashboard: true,
      reservations: true,
      vehicles: true,
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
      settings: false,
      security: false,
      tenants: false
    };
  }

  return {
    ...base,
    dashboard: true,
    reservations: true,
    vehicles: true,
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
    settings: false,
    security: false,
    tenants: false
  };
}

export function defaultTenantModuleConfig(tenant = null) {
  return {
    dashboard: true,
    reservations: true,
    vehicles: true,
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
    return normalizeTenantModuleConfig(normalizeBooleanMap(), { carSharingEnabled: true, dealershipLoanerEnabled: true, tollsEnabled: true });
  }
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, carSharingEnabled: true, dealershipLoanerEnabled: true, tollsEnabled: true }
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
    select: { id: true, carSharingEnabled: true, dealershipLoanerEnabled: true, tollsEnabled: true }
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
  cache.del(`session:${userId}`);
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
  return {
    tenantConfig,
    userConfig: storedConfig,
    effective: config
  };
}
