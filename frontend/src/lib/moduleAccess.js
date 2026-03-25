export const MODULE_DEFINITIONS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'reservations', label: 'Reservations' },
  { key: 'vehicles', label: 'Vehicles' },
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
  { key: 'settings', label: 'Settings' },
  { key: 'security', label: 'Security' },
  { key: 'tenants', label: 'Tenants' }
];

export const MODULE_LABELS = Object.fromEntries(MODULE_DEFINITIONS.map((item) => [item.key, item.label]));

export function isModuleEnabled(me, moduleKey) {
  if (!moduleKey) return true;
  if (String(me?.role || '').toUpperCase() === 'SUPER_ADMIN') return true;
  return me?.moduleAccess?.[moduleKey] !== false;
}

export function pathnameToModule(pathname = '') {
  const path = String(pathname || '').toLowerCase();
  if (path.startsWith('/dashboard') || path === '/') return 'dashboard';
  if (path.startsWith('/reservations')) return 'reservations';
  if (path.startsWith('/vehicles')) return 'vehicles';
  if (path.startsWith('/customers')) return 'customers';
  if (path.startsWith('/people')) return 'people';
  if (path.startsWith('/planner')) return 'planner';
  if (path.startsWith('/reports')) return 'reports';
  if (path.startsWith('/car-sharing')) return 'carSharing';
  if (path.startsWith('/host') || path.startsWith('/host-profile') || path.startsWith('/host-review')) return 'hostApp';
  if (path.startsWith('/employee')) return 'employeeApp';
  if (path.startsWith('/issues') || path.startsWith('/issue-response')) return 'issueCenter';
  if (path.startsWith('/loaner')) return 'loaner';
  if (path.startsWith('/tolls')) return 'tolls';
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
