import { prisma } from './prisma.js';
import { cache } from './cache.js';
import { globalKey } from './cache/tenantKey.js';
import logger from './logger.js';

export const MODULE_KEYS = [
  'dashboard',
  'reservations',
  // Payment Actions (2026-07-25) — a CAPABILITY module, not a nav page.
  //
  // The rule (Hector): an AGENT may RECORD what already happened outside the
  // system; only ADMIN/OPS may make the system MOVE money at the gateway,
  // DESTROY a payment record, or STORE a reusable card. Counter staff collect
  // on an external POS terminal and key the result in afterwards, so the
  // record-only routes (postPayment, addManualPayment, request-payment) are
  // deliberately NOT gated — gating them would jam the counter.
  //
  // Gated: charge-card-on-file (AuthNet + Spin), security-deposit
  // capture/release, spin release/reauth, refund, payment delete/void, and
  // save-card-on-file. Those shipped behind requireModuleAccess('reservations')
  // only, so any employee with the Reservations module could charge a saved
  // card, refund, or delete a payment record.
  //
  // Default ON for ADMIN/OPS, OFF for AGENT/staff and hosts — Hector opens it
  // per person in People. Because it has no page of its own it is deliberately
  // absent from pathnameToModule/preferredAppRoute.
  'paymentActions',
  'vehicles',
  'maintenance',
  'customers',
  'people',
  'planner',
  'quotes',
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
  // Partnerships (2026-09-05): commercial alliances with their own terms, price
  // book and hosted page. Tenant opt-in (Tenant.partnershipsEnabled, like
  // marketIntelligence); default ON for ADMIN/OPS, OFF for agents and hosts.
  'partnerships',
  'settings',
  'security',
  'tenants'
];

/**
 * Optional second sentence shown when a module gate denies a request. The first
 * sentence is always "<Label> is turned off for your account." — this adds the
 * next step so the user is not left guessing. Keep them short and actionable.
 */
export const MODULE_DENIED_HINTS = {
  paymentActions:
    'You can still record a payment taken on the card terminal — ask an admin if ' +
    'you need to charge or refund a card.',
  partnerships: 'Ask an admin to open Partnerships for you, or to turn the module on for the company.'
};

export const MODULE_LABELS = {
  dashboard: 'Dashboard',
  reservations: 'Reservations',
  paymentActions: 'Payment Actions',
  vehicles: 'Vehicles',
  maintenance: 'Maintenance',
  customers: 'Customers',
  people: 'People',
  planner: 'Planner',
  quotes: 'Quotes',
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
  partnerships: 'Partnerships',
  settings: 'Settings',
  security: 'Security',
  tenants: 'Tenants'
};

function hostRoleModuleMap() {
  return {
    // Spread every MODULE_KEY as false FIRST. getEditableModuleAccessForUser
    // reads this map as `roleAllowed[key] !== false`, so a key missing from a
    // literal resolves to TRUE — a host would silently inherit any module added
    // after this map was written. The other role maps already spread `base`;
    // this one did not, which is why paymentActions had to be listed by hand.
    // With the spread, a new module is OFF for hosts by default.
    ...Object.fromEntries(MODULE_KEYS.map((key) => [key, false])),
    dashboard: true,
    reservations: false,
    paymentActions: false,
    vehicles: false,
    maintenance: false,
    customers: false,
    people: false,
    planner: false,
    quotes: false,
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
    partnerships: false,
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
      paymentActions: true,
      vehicles: true,
      maintenance: true,
      customers: true,
      people: true,
      planner: true,
      quotes: true,
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
      partnerships: true,
      tenants: false
    };
  }

  if (current === 'OPS') {
    return {
      ...base,
      dashboard: true,
      reservations: true,
      paymentActions: true,
      vehicles: true,
      maintenance: true,
      customers: true,
      people: false,
      planner: true,
      quotes: true,
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
      partnerships: true,
      tenants: false
    };
  }

  return {
    ...base,
    dashboard: true,
    reservations: true,
    // AGENT / staff default: OFF. Explicit rather than relying on `base`,
    // so the intent survives anyone reordering this map. Hector opens it
    // per person in People when a counter agent genuinely needs it.
    paymentActions: false,
    vehicles: true,
    maintenance: true,
    customers: true,
    people: false,
    planner: true,
    quotes: true,
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
    // Partnerships is an ADMIN/OPS configuration surface (prices, terms, QR).
    partnerships: false,
    tenants: false
  };
}

export function defaultTenantModuleConfig(tenant = null) {
  return {
    dashboard: true,
    reservations: true,
    // Tenant-level default ON (Hector, 2026-07-25): the tenant owns the
    // capability, the per-user/role layer decides who actually gets it.
    paymentActions: true,
    vehicles: true,
    maintenance: true,
    customers: true,
    people: true,
    planner: true,
    quotes: true,
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
    partnerships: !!tenant?.partnershipsEnabled,
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
    // Same beta.307 shape as marketIntelligence: the tenant entitlement is the
    // ceiling; the stored switch can only turn it OFF below that ceiling.
    partnerships: !!parsed.partnerships && !!tenant?.partnershipsEnabled,
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
      marketIntelligenceEnabled: true,
      partnershipsEnabled: true
    });
  }
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      carSharingEnabled: true,
      dealershipLoanerEnabled: true,
      tollsEnabled: true,
      marketIntelligenceEnabled: true,
      partnershipsEnabled: true
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
    // partnershipsEnabled likewise (2026-09-05) — same trap, same fix.
    select: {
      id: true,
      carSharingEnabled: true,
      dealershipLoanerEnabled: true,
      tollsEnabled: true,
      marketIntelligenceEnabled: true,
      partnershipsEnabled: true
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

/**
 * ANTI-SELF-LOCKOUT (2026-07-25) — paymentActions only.
 *
 * Every other module is a FEATURE a tenant either has or does not (Tolls, Car
 * Sharing, Kiosk), so it is correct that the tenant switch turns it off for
 * everyone. paymentActions is not a feature — it is a PERMISSION LEVEL inside
 * Reservations, which the tenant already has. If the tenant switch could strip
 * ADMIN too, turning it off would leave the whole company unable to charge a
 * saved card or RELEASE A CUSTOMER'S DEPOSIT HOLD. So for this key the tenant
 * switch governs everyone BELOW admin: it decides whether the capability can be
 * handed to OPS/agents at all. Admins keep it unconditionally.
 *
 * This MUST live in getEditableModuleAccessForUser, not only in the effective
 * path. settings.service.js returns `config` from HERE to the People screen. If
 * the two disagreed, People would render an admin's checkbox UNCHECKED while
 * the admin actually had access — and because savePerson PUTs the whole map
 * back, any routine edit (a phone number) would persist `paymentActions:false`
 * as an EXPLICIT override. That override sets hasUserOverride, the carve-out
 * stops applying, and the admin is locked out for real, recoverable only by a
 * SUPER_ADMIN. The security property is only real if both paths agree.
 *
 * An explicit per-user override still wins, which is the intended way to remove
 * the capability from one specific admin.
 */
function applyPaymentActionsLockoutCarveOut(user, tenantConfig, storedConfig, config) {
  if (tenantConfig?.paymentActions !== false) return;
  const role = String(user?.role || '').toUpperCase();
  if (role !== 'ADMIN' && role !== 'SUPER_ADMIN') return;
  const hasUserOverride = Object.prototype.hasOwnProperty.call(storedConfig || {}, 'paymentActions');
  config.paymentActions = hasUserOverride ? !!storedConfig.paymentActions : true;
}

/**
 * Diff two module maps and record what actually changed.
 *
 * BOTH maps must come from the SAME layer. Comparing an EFFECTIVE map
 * (role ∧ tenant ∧ stored) against a STORED map invents phantom changes
 * wherever role or tenant denies a module the stored blob says true, and
 * misses real ones — so callers pass stored-before vs stored-after for the
 * per-user scope, and tenant-before vs tenant-after for the tenant scope.
 *
 * TRI-STATE, not boolean. A stored map has three states per key: explicit true,
 * explicit false, and ABSENT (no override — follow the role/tenant default).
 * A value-only diff (`!!before[k] !== !!after[k]`) collapses absent into false,
 * so REMOVING an explicit `{paymentActions:false}` reads as false -> false and
 * writes NO ROW — even though the effective access jumps to the role default,
 * which is `true` for ADMIN/OPS. That is a real grant of the capability to
 * charge and refund cards, recorded nowhere. It is also the same "a missing key
 * is not the same as false" assumption that produced the fail-open role maps
 * this whole change exists to fix, so it is closed here rather than left as a
 * latent twin.
 *
 * `from`/`to` are therefore `true | false | null`, where NULL means "no
 * explicit override". Keys absent on BOTH sides are still not a change.
 *
 * IDs only, never emails or names: actor and target are resolvable by join, so
 * there is no reason to copy PII into an audit row.
 *
 * Best-effort by design — an audit failure must never block the permission
 * change — but it is now capable of succeeding, which the AuditLog version was
 * not (that table's reservationId is required, so every insert threw into the
 * catch and wrote nothing).
 *
 * Returns the changed list so callers/tests can assert on it.
 */
export async function recordModuleAccessAudit({
  scope,
  tenantId = null,
  targetUserId = null,
  actor = null,
  before = {},
  after = {}
}) {
  const has = (map, key) => Object.prototype.hasOwnProperty.call(map || {}, key);
  const state = (map, key) => (has(map, key) ? !!map[key] : null);

  const changed = MODULE_KEYS.filter((key) => {
    if (!has(before, key) && !has(after, key)) return false; // absent both sides
    return has(before, key) !== has(after, key) || !!before?.[key] !== !!after?.[key];
  }).map((key) => ({
    module: key,
    from: state(before, key),
    to: state(after, key)
  }));
  if (!changed.length) return [];

  try {
    await prisma.moduleAccessAuditLog.create({
      data: {
        tenantId: tenantId || null,
        scope,
        targetUserId: targetUserId || null,
        actorUserId: actor?.sub || actor?.id || null,
        actorRole: actor?.role ? String(actor.role).toUpperCase() : null,
        changed
      }
    });
  } catch (err) {
    logger.warn('module-access: audit write failed', {
      scope,
      targetUserId,
      error: String(err?.message || err)
    });
  }
  return changed;
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

  applyPaymentActionsLockoutCarveOut(user, tenantConfig, storedConfig, config);

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

  // The paymentActions anti-self-lockout carve-out is applied inside
  // getEditableModuleAccessForUser (above), so this path and the People screen
  // can never disagree. See applyPaymentActionsLockoutCarveOut.

  return {
    tenantConfig,
    userConfig: storedConfig,
    effective: config
  };
}
