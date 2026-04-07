import { prisma } from './prisma.js';

export const TENANT_PLAN_CATALOG_KEY = 'tenantPlanCatalog';

export const DEFAULT_TENANT_PLAN_CATALOG = [
  {
    code: 'BETA',
    name: 'Beta',
    maxAdmins: 2,
    maxUsers: 10,
    maxVehicles: 25,
    smartPlannerIncluded: true,
    plannerCopilotIncluded: false,
    plannerCopilotMonthlyQueryCap: 50,
    plannerCopilotAllowedModels: ['gpt-4.1-mini'],
    telematicsIncluded: false,
    inspectionIntelligenceIncluded: true,
    isActive: true
  },
  {
    code: 'STARTER',
    name: 'Starter',
    maxAdmins: 2,
    maxUsers: 10,
    maxVehicles: 40,
    smartPlannerIncluded: true,
    plannerCopilotIncluded: true,
    plannerCopilotMonthlyQueryCap: 150,
    plannerCopilotAllowedModels: ['gpt-4.1-mini'],
    telematicsIncluded: false,
    inspectionIntelligenceIncluded: true,
    isActive: true
  },
  {
    code: 'PRO',
    name: 'Pro',
    maxAdmins: 5,
    maxUsers: 50,
    maxVehicles: 250,
    smartPlannerIncluded: true,
    plannerCopilotIncluded: true,
    plannerCopilotMonthlyQueryCap: 1000,
    plannerCopilotAllowedModels: ['gpt-4.1-mini', 'gpt-4.1'],
    telematicsIncluded: true,
    inspectionIntelligenceIncluded: true,
    isActive: true
  },
  {
    code: 'ENTERPRISE',
    name: 'Enterprise',
    maxAdmins: null,
    maxUsers: null,
    maxVehicles: null,
    smartPlannerIncluded: true,
    plannerCopilotIncluded: true,
    plannerCopilotMonthlyQueryCap: null,
    plannerCopilotAllowedModels: ['gpt-4.1-mini', 'gpt-4.1'],
    telematicsIncluded: true,
    inspectionIntelligenceIncluded: true,
    isActive: true
  }
];

function normalizePlanCode(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizePlanName(value, fallbackCode) {
  const name = String(value || '').trim();
  return name || fallbackCode;
}

function normalizeLimit(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new Error('Plan limits must be whole numbers or blank for unlimited');
  }
  return parsed;
}

function normalizeBoolean(value, fallback = false) {
  return value == null ? !!fallback : !!value;
}

function normalizeStringList(value = [], fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  return Array.from(new Set(source.map((item) => String(item || '').trim()).filter(Boolean)));
}

export function normalizeTenantPlanCatalog(plans = []) {
  const source = Array.isArray(plans) && plans.length ? plans : DEFAULT_TENANT_PLAN_CATALOG;
  const seen = new Set();
  return source.map((plan, index) => {
    const code = normalizePlanCode(plan?.code);
    if (!code) throw new Error(`Plan code is required on row ${index + 1}`);
    if (seen.has(code)) throw new Error(`Duplicate plan code ${code}`);
    seen.add(code);
    return {
      code,
      name: normalizePlanName(plan?.name, code),
      maxAdmins: normalizeLimit(plan?.maxAdmins),
      maxUsers: normalizeLimit(plan?.maxUsers),
      maxVehicles: normalizeLimit(plan?.maxVehicles),
      smartPlannerIncluded: normalizeBoolean(plan?.smartPlannerIncluded, true),
      plannerCopilotIncluded: normalizeBoolean(plan?.plannerCopilotIncluded, false),
      plannerCopilotMonthlyQueryCap: normalizeLimit(plan?.plannerCopilotMonthlyQueryCap),
      plannerCopilotAllowedModels: normalizeStringList(plan?.plannerCopilotAllowedModels, ['gpt-4.1-mini']),
      telematicsIncluded: normalizeBoolean(plan?.telematicsIncluded, false),
      inspectionIntelligenceIncluded: normalizeBoolean(plan?.inspectionIntelligenceIncluded, true),
      isActive: plan?.isActive !== false
    };
  });
}

export async function getTenantPlanCatalog(client = prisma) {
  const row = await client.appSetting.findUnique({
    where: { key: TENANT_PLAN_CATALOG_KEY }
  });
  if (!row?.value) return normalizeTenantPlanCatalog(DEFAULT_TENANT_PLAN_CATALOG);
  try {
    return normalizeTenantPlanCatalog(JSON.parse(row.value));
  } catch {
    return normalizeTenantPlanCatalog(DEFAULT_TENANT_PLAN_CATALOG);
  }
}

export async function saveTenantPlanCatalog(plans = [], client = prisma) {
  const payload = normalizeTenantPlanCatalog(plans);
  await client.appSetting.upsert({
    where: { key: TENANT_PLAN_CATALOG_KEY },
    create: { key: TENANT_PLAN_CATALOG_KEY, value: JSON.stringify(payload) },
    update: { value: JSON.stringify(payload) }
  });
  return payload;
}

export function resolveTenantPlanConfig(planCode, catalog = DEFAULT_TENANT_PLAN_CATALOG) {
  const normalizedCode = normalizePlanCode(planCode || 'BETA');
  const normalizedCatalog = normalizeTenantPlanCatalog(catalog);
  const matched = normalizedCatalog.find((plan) => plan.code === normalizedCode);
  if (matched) return matched;
  return {
    code: normalizedCode,
    name: normalizedCode,
    maxAdmins: null,
    maxUsers: null,
    maxVehicles: null,
    smartPlannerIncluded: true,
    plannerCopilotIncluded: false,
    plannerCopilotMonthlyQueryCap: null,
    plannerCopilotAllowedModels: ['gpt-4.1-mini'],
    telematicsIncluded: false,
    inspectionIntelligenceIncluded: true,
    isActive: false
  };
}

export async function getTenantPlanUsage(tenantId, client = prisma) {
  if (!tenantId) {
    return {
      admins: 0,
      users: 0,
      vehicles: 0
    };
  }

  const internalUserWhere = {
    tenantId,
    isActive: true,
    role: { in: ['ADMIN', 'OPS', 'AGENT'] },
    hostProfile: { is: null }
  };

  const [admins, users, vehicles] = await Promise.all([
    client.user.count({
      where: {
        ...internalUserWhere,
        role: 'ADMIN'
      }
    }),
    client.user.count({ where: internalUserWhere }),
    client.vehicle.count({ where: { tenantId } })
  ]);

  return {
    admins,
    users,
    vehicles
  };
}

function formatLimit(limit) {
  return limit == null ? 'unlimited' : String(limit);
}

export async function assertTenantUserCapacity(tenantId, input = {}, client = prisma) {
  if (!tenantId) return null;
  const userDelta = Number(input?.userDelta || 0);
  const adminDelta = Number(input?.adminDelta || 0);
  if (userDelta <= 0 && adminDelta <= 0) return null;

  const tenant = await client.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, plan: true }
  });
  if (!tenant) throw new Error('Tenant not found');

  const [catalog, usage] = await Promise.all([
    getTenantPlanCatalog(client),
    getTenantPlanUsage(tenant.id, client)
  ]);
  const plan = resolveTenantPlanConfig(tenant.plan, catalog);

  if (plan.maxUsers != null && usage.users + userDelta > plan.maxUsers) {
    throw new Error(`${tenant.name} is on the ${plan.code} plan and allows up to ${formatLimit(plan.maxUsers)} active users. Upgrade the plan or increase the limit before adding another user.`);
  }

  if (plan.maxAdmins != null && usage.admins + adminDelta > plan.maxAdmins) {
    throw new Error(`${tenant.name} is on the ${plan.code} plan and allows up to ${formatLimit(plan.maxAdmins)} active admins. Upgrade the plan or increase the limit before adding another admin.`);
  }

  return { tenant, plan, usage };
}

export async function assertTenantVehicleCapacity(tenantId, input = {}, client = prisma) {
  if (!tenantId) return null;
  const vehicleDelta = Number(input?.vehicleDelta || 0);
  if (vehicleDelta <= 0) return null;

  const tenant = await client.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, plan: true }
  });
  if (!tenant) throw new Error('Tenant not found');

  const [catalog, usage] = await Promise.all([
    getTenantPlanCatalog(client),
    getTenantPlanUsage(tenant.id, client)
  ]);
  const plan = resolveTenantPlanConfig(tenant.plan, catalog);

  if (plan.maxVehicles != null && usage.vehicles + vehicleDelta > plan.maxVehicles) {
    throw new Error(`${tenant.name} is on the ${plan.code} plan and allows up to ${formatLimit(plan.maxVehicles)} vehicles. Upgrade the plan or increase the limit before adding more cars.`);
  }

  return { tenant, plan, usage };
}
