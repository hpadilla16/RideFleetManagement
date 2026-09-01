/**
 * The module registry, plus the per-role starting defaults used to pre-fill the
 * People create form.
 *
 * KEEP THIS FILE DEPENDENCY-FREE. It is imported by React components, by vitest,
 * and — deliberately — by a plain Node test under backend/ that asserts the role
 * defaults below have not drifted from backend/src/lib/module-access.js. Adding
 * a `next/*` or React import here would break that guard.
 */
export const MODULE_DEFINITIONS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'reservations', label: 'Reservations' },
  // Capability module, not a nav page (2026-07-25). Gates only the routes that
  // make the SYSTEM move money at the gateway, destroy a payment record, or
  // store a reusable card. Recording a payment taken on the external POS is
  // NOT gated — that stays open so the counter never jams.
  // Deliberately absent from pathnameToModule and preferredAppRoute: there is
  // no /payment-actions page to land on.
  {
    key: 'paymentActions',
    label: 'Payment Actions',
    // description = what the switch controls.
    // keepsNote    = what stays available regardless (shown in Settings + People).
    // tenantNote   = tenant-switch-only nuance (shown in Settings only).
    // NO "void" here. The live void route is
    // reservations.routes.js POST /:id/payments/:paymentId/void-no-refund,
    // gated by canDoAdminCorrections (ADMIN-only) and NOT by this setting.
    // Listing it would mislead in both directions: an agent WITH this
    // permission would read that they can void and cannot, and an admin
    // WITHOUT it would read that they lost void when they keep it. The
    // agreements-router void that suggested otherwise is now a 410 stub.
    description:
      'Charge a card the customer already has on file, capture or release a ' +
      'security deposit, refund a payment, remove a payment from the record, ' +
      "and save a customer's card for future charges.",
    keepsNote:
      'Recording a payment you already took on the card terminal always stays ' +
      'available — this switch never blocks that. Voiding a payment for ' +
      'bookkeeping is admin-only and is not controlled by this setting.',
    tenantNote:
      'Admins keep these actions even when this is off, so turning it off can ' +
      "never leave the company unable to release a customer's deposit. Off means " +
      'it can no longer be given to ops staff or agents.'
  },
  { key: 'quotes', label: 'Quotes' },
  { key: 'vehicles', label: 'Vehicles' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'customers', label: 'Customers' },
  { key: 'people', label: 'People' },
  { key: 'planner', label: 'Planner' },
  { key: 'reports', label: 'Reports' },
  { key: 'carSharing', label: 'Car Sharing' },
  { key: 'hostApp', label: 'Host App' },
  { key: 'employeeApp', label: 'Employee App' },
  { key: 'issueCenter', label: 'Issue Center' },
  { key: 'loaner', label: 'Loaner Program' },
  { key: 'tolls', label: 'Tolls' },
  { key: 'citations', label: 'Citations' },
  { key: 'kiosk', label: 'Kiosk' },
  { key: 'marketIntelligence', label: 'Market Intelligence' },
  { key: 'settings', label: 'Settings' },
  { key: 'security', label: 'Security' },
  { key: 'tenants', label: 'Tenants' }
];

export const MODULE_LABELS = Object.fromEntries(MODULE_DEFINITIONS.map((item) => [item.key, item.label]));

/**
 * Modules each role starts with. MIRRORS roleAllowedModuleMap in
 * backend/src/lib/module-access.js — that file is the authority; this exists
 * only to pre-fill the People create form. The mirror is pinned by
 * backend/src/lib/module-access-frontend-defaults.test.mjs, which imports BOTH
 * and fails if they disagree on any key.
 *
 * STRUCTURE MATTERS HERE. This used to be four hand-written object literals
 * inside people/page.js, and every module added since they were written
 * (quotes, maintenance, tolls, citations, kiosk, marketIntelligence) was simply
 * MISSING from all four. A missing key rendered as CHECKED — the checkbox read
 * `!== false` — and savePerson PUTs the whole map back, so creating a person
 * persisted an explicit `true` override for modules they were never meant to
 * have (a HOST got quotes/maintenance/citations; an agent got tolls and kiosk).
 * That explicit override then beat the role default in
 * getEditableModuleAccessForUser, so the grant stuck.
 *
 * The default is now built by iterating the registry with everything FALSE and
 * turning on only what is listed below. A module added tomorrow is off for
 * every role until someone opts it in — the safe direction.
 */
export const ROLE_DEFAULT_MODULES = {
  HOST: ['dashboard', 'hostApp'],
  ADMIN: [
    'dashboard', 'reservations', 'paymentActions', 'vehicles', 'maintenance', 'customers',
    'people', 'planner', 'quotes', 'reports', 'carSharing', 'hostApp', 'employeeApp',
    'issueCenter', 'loaner', 'tolls', 'citations', 'kiosk', 'marketIntelligence',
    'settings', 'security'
  ],
  OPS: [
    'dashboard', 'reservations', 'paymentActions', 'vehicles', 'maintenance', 'customers',
    'planner', 'quotes', 'reports', 'carSharing', 'hostApp', 'employeeApp', 'issueCenter',
    'loaner', 'tolls', 'citations', 'kiosk', 'marketIntelligence'
  ],
  // AGENT / counter staff. paymentActions is deliberately absent — Hector opens
  // it per person from the People screen when an agent genuinely needs it.
  AGENT: [
    'dashboard', 'reservations', 'vehicles', 'maintenance', 'customers', 'planner',
    'quotes', 'hostApp', 'employeeApp', 'issueCenter', 'loaner', 'citations',
    'marketIntelligence'
  ]
};

/**
 * Pre-fill map for the People create form. Returns EVERY registry key as an
 * explicit boolean — never a partial map, because the caller PUTs the result
 * straight to /api/settings/users/:id/module-access as the user's overrides.
 */
export function buildDefaultUserModuleAccess(personType = 'EMPLOYEE', role = 'AGENT') {
  const type = String(personType || 'EMPLOYEE').toUpperCase();
  const currentRole = String(role || 'AGENT').toUpperCase();
  const allowed =
    type === 'HOST'
      ? ROLE_DEFAULT_MODULES.HOST
      : ROLE_DEFAULT_MODULES[currentRole] || ROLE_DEFAULT_MODULES.AGENT;

  const out = {};
  for (const item of MODULE_DEFINITIONS) out[item.key] = allowed.includes(item.key);
  out.tenants = false; // never granted from this screen
  return out;
}

export function isModuleEnabled(me, moduleKey) {
  if (!moduleKey) return true;
  if (String(me?.role || '').toUpperCase() === 'SUPER_ADMIN') return true;
  return me?.moduleAccess?.[moduleKey] !== false;
}

export function pathnameToModule(pathname = '') {
  const path = String(pathname || '').toLowerCase();
  if (path.startsWith('/dashboard') || path === '/') return 'dashboard';
  if (path.startsWith('/reservations')) return 'reservations';
  if (path.startsWith('/quotes')) return 'quotes';
  if (path.startsWith('/maintenance')) return 'maintenance';
  if (path.startsWith('/vehicles')) return 'vehicles';
  if (path.startsWith('/customers')) return 'customers';
  if (path.startsWith('/people')) return 'people';
  if (path.startsWith('/planner')) return 'planner';
  if (path.startsWith('/reports')) return 'reports';
  if (path.startsWith('/car-sharing')) return 'carSharing';
  if (path.startsWith('/host') || path.startsWith('/host-profile') || path.startsWith('/host-review')) return 'hostApp';
  if (path.startsWith('/employee')) return 'employeeApp';
  if (path.startsWith('/issues') || path.startsWith('/issue-response')) return 'issueCenter';
  // Staff Shuttle Monitor (2026-08-24) — same module as the shuttle queue and
  // tracker settings it summarizes. NOTE: '/shuttles' only; the public
  // tracker at /shuttle/<token> renders outside AppShell and is token-authed.
  if (path.startsWith('/shuttles')) return 'reservations';
  if (path.startsWith('/loaner')) return 'loaner';
  if (path.startsWith('/tolls')) return 'tolls';
  if (path.startsWith('/citations')) return 'citations';
  // Admin pages only (/kiosks) — the public kiosk app (/kiosk) is device-token
  // authed and is NOT gated by user module access.
  if (path.startsWith('/kiosks')) return 'kiosk';
  if (path.startsWith('/settings/security')) return 'security';
  if (path.startsWith('/settings')) return 'settings';
  if (path.startsWith('/tenants')) return 'tenants';
  return null;
}

export function preferredAppRoute(me) {
  const role = String(me?.role || '').toUpperCase();
  const moduleAccess = me?.moduleAccess || {};
  const enabled = (key) => role === 'SUPER_ADMIN' || moduleAccess?.[key] !== false;

  if (role === 'SUPER_ADMIN') return '/dashboard';
  if (me?.hostProfileId && enabled('hostApp')) return '/host';
  if (enabled('employeeApp')) return '/employee';
  if (enabled('dashboard')) return '/dashboard';

  const orderedRoutes = [
    ['reservations', '/reservations'],
    ['customers', '/customers'],
    ['vehicles', '/vehicles'],
    ['planner', '/planner'],
    ['reports', '/reports'],
    ['carSharing', '/car-sharing'],
    ['hostApp', '/host'],
    ['issueCenter', '/issues'],
    ['loaner', '/loaner'],
    ['tolls', '/tolls'],
    ['people', '/people'],
    ['settings', '/settings'],
    ['security', '/settings/security'],
    ['tenants', '/tenants']
  ];

  const fallback = orderedRoutes.find(([key]) => enabled(key));
  return fallback?.[1] || '/dashboard';
}
