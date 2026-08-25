import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppShell, NAV_SECTIONS } from '../src/components/AppShell';

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => {
      const map = {
        'nav.dashboard': 'Dashboard',
        'nav.reservations': 'Reservations',
        'nav.vehicles': 'Vehicles',
        'nav.customers': 'Customers',
        'nav.settings': 'Settings',
        'topbar.dark': 'Dark',
        'topbar.light': 'Light',
        'topbar.lock': 'Lock',
        'topbar.logout': 'Logout',
        'lockScreen.screenLocked': 'Screen Locked',
        'lockScreen.unlock': 'Unlock',
      };
      return map[key] || key;
    },
    i18n: { language: 'en' },
  }),
}));

// Mock setLanguage
vi.mock('../src/lib/i18n', () => ({
  default: {},
  setLanguage: vi.fn(),
}));

// Mock client
vi.mock('../src/lib/client', () => ({
  API_BASE: 'http://localhost:4000',
  TOKEN_KEY: 'fleet_jwt',
  USER_KEY: 'fleet_user',
  readStoredToken: () => 'mock-token',
  api: vi.fn().mockResolvedValue({}),
  // The location switcher (2026-08-11) made AppShell call these on mount.
  // This mock did not export them, so every render threw and all nine tests
  // in this file went red — a mock gap, not a component bug.
  readViewLocation: () => '',
  writeViewLocation: vi.fn(),
}));

// Mock moduleAccess — controllable per test so the gating tests can turn
// individual modules off (the default keeps everything enabled).
const moduleAccessMocks = vi.hoisted(() => ({
  isModuleEnabled: vi.fn(() => true),
}));
vi.mock('../src/lib/moduleAccess', () => ({
  isModuleEnabled: moduleAccessMocks.isModuleEnabled,
  pathnameToModule: () => 'dashboard',
  MODULE_DEFINITIONS: [],
}));

const mockMe = {
  id: 'user-1',
  name: 'Test User',
  email: 'test@test.com',
  role: 'ADMIN',
  tenantId: 'tenant-1',
};

// The flat NAV_ITEMS list as it existed before the sectioned sidebar
// (2026-08-24). The redesign is presentation-only: every one of these must
// survive, with the exact same href and gates, in exactly one section.
const OLD_FLAT_NAV = [
  { href: '/dashboard', moduleKey: 'dashboard' },
  { href: '/reservations', moduleKey: 'reservations' },
  { href: '/quotes', moduleKey: 'quotes' },
  { href: '/vehicles', moduleKey: 'vehicles' },
  { href: '/vehicles/inventory-helper', moduleKey: 'vehicles' },
  { href: '/customers', moduleKey: 'customers' },
  { href: '/people', adminOnly: true, moduleKey: 'people' },
  { href: '/planner', moduleKey: 'planner' },
  { href: '/reports-v2', moduleKey: 'reports' },
  { href: '/car-sharing', feature: 'carSharing', moduleKey: 'carSharing' },
  { href: '/host', feature: 'carSharing', moduleKey: 'hostApp' },
  { href: '/issues', moduleKey: 'issueCenter' },
  { href: '/incidents', moduleKey: 'reservations' },
  { href: '/shuttles', feature: 'shuttleMonitor', moduleKey: 'reservations' },
  { href: '/loaner', feature: 'dealershipLoaner', moduleKey: 'loaner' },
  { href: '/tolls', moduleKey: 'tolls' },
  { href: '/maintenance', moduleKey: 'maintenance' },
  { href: '/citations', moduleKey: 'citations' },
  { href: '/kiosks', moduleKey: 'kiosk' },
  { href: '/market', adminOnly: true, moduleKey: 'marketIntelligence' },
  { href: '/suggestions', adminOnly: true, moduleKey: 'marketIntelligence' },
  { href: '/knowledge-base' },
  { href: '/settings', moduleKey: 'settings' },
  { href: '/tenants', superOnly: true, moduleKey: 'tenants' },
  { href: '/settings/security', adminOnly: true, moduleKey: 'security' },
  { href: '/settings/store-boards', adminOnly: true, moduleKey: 'settings' },
];

describe('AppShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    moduleAccessMocks.isModuleEnabled.mockImplementation(() => true);
    localStorage.clear();
  });

  it('renders the brand name', () => {
    render(<AppShell me={mockMe} logout={vi.fn()}>Content</AppShell>);
    expect(screen.getByText('Ride Fleet')).toBeInTheDocument();
  });

  it('renders navigation items', () => {
    render(<AppShell me={mockMe} logout={vi.fn()}>Content</AppShell>);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Reservations')).toBeInTheDocument();
    expect(screen.getByText('Vehicles')).toBeInTheDocument();
  });

  it('renders user name in topbar', () => {
    render(<AppShell me={mockMe} logout={vi.fn()}>Content</AppShell>);
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('renders language toggle button (ES)', () => {
    render(<AppShell me={mockMe} logout={vi.fn()}>Content</AppShell>);
    expect(screen.getByText('ES')).toBeInTheDocument();
  });

  it('renders dark mode toggle', () => {
    render(<AppShell me={mockMe} logout={vi.fn()}>Content</AppShell>);
    expect(screen.getByText('Dark')).toBeInTheDocument();
  });

  it('renders lock button', () => {
    render(<AppShell me={mockMe} logout={vi.fn()}>Content</AppShell>);
    expect(screen.getByText('Lock')).toBeInTheDocument();
  });

  it('renders logout button', () => {
    render(<AppShell me={mockMe} logout={vi.fn()}>Content</AppShell>);
    expect(screen.getByText('Logout')).toBeInTheDocument();
  });

  it('renders children content', () => {
    render(<AppShell me={mockMe} logout={vi.fn()}><div>My Page Content</div></AppShell>);
    expect(screen.getByText('My Page Content')).toBeInTheDocument();
  });

  it('shows user role', () => {
    render(<AppShell me={mockMe} logout={vi.fn()}>Content</AppShell>);
    expect(screen.getByText('ADMIN')).toBeInTheDocument();
  });
});

describe('AppShell sectioned sidebar (2026-08-24 redesign)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    moduleAccessMocks.isModuleEnabled.mockImplementation(() => true);
    localStorage.clear();
  });

  it('keeps every item from the old flat NAV list, in exactly one section', () => {
    const flattened = NAV_SECTIONS.flatMap((sec) => sec.items);
    const hrefCounts = {};
    for (const item of flattened) hrefCounts[item.href] = (hrefCounts[item.href] || 0) + 1;

    for (const oldItem of OLD_FLAT_NAV) {
      expect(hrefCounts[oldItem.href], `${oldItem.href} missing or duplicated`).toBe(1);
    }
    // …and no invented pages: sections contain exactly the old inventory.
    expect(flattened.length).toBe(OLD_FLAT_NAV.length);
  });

  it('preserves every gate exactly (module/feature/admin/super)', () => {
    const byHref = Object.fromEntries(
      NAV_SECTIONS.flatMap((sec) => sec.items).map((item) => [item.href, item])
    );
    for (const oldItem of OLD_FLAT_NAV) {
      const now = byHref[oldItem.href];
      expect(now, `${oldItem.href} missing`).toBeTruthy();
      expect(now.moduleKey).toBe(oldItem.moduleKey);
      expect(now.feature).toBe(oldItem.feature);
      expect(!!now.adminOnly).toBe(!!oldItem.adminOnly);
      expect(!!now.superOnly).toBe(!!oldItem.superOnly);
    }
  });

  it('renders section headers for an unrestricted admin', () => {
    render(<AppShell me={mockMe} logout={vi.fn()}>Content</AppShell>);
    expect(screen.getByText('nav.sectionDailyOps')).toBeInTheDocument();
    expect(screen.getByText('nav.sectionFleet')).toBeInTheDocument();
    expect(screen.getByText('nav.sectionMoney')).toBeInTheDocument();
    expect(screen.getByText('nav.sectionGrowth')).toBeInTheDocument();
    expect(screen.getByText('nav.sectionAdmin')).toBeInTheDocument();
  });

  it('hides gated-away items entirely (no greyed rows)', () => {
    // Same behavior as the old flat filters: module off → item gone.
    moduleAccessMocks.isModuleEnabled.mockImplementation((me, key) => key !== 'tolls');
    render(<AppShell me={mockMe} logout={vi.fn()}>Content</AppShell>);
    expect(screen.queryByText('nav.tolls')).not.toBeInTheDocument();
    // Feature-gated Shuttles is hidden until /api/shuttle-monitor/enabled says so.
    expect(screen.queryByText('nav.shuttles')).not.toBeInTheDocument();
    // superOnly Tenants is hidden for a plain ADMIN.
    expect(screen.queryByText('nav.tenants')).not.toBeInTheDocument();
  });

  it('renders no header for a section whose items are all gated away', () => {
    // Growth = Market Intelligence + Pricing Suggestions, both adminOnly on the
    // marketIntelligence module. Turn the module off: the whole section vanishes.
    moduleAccessMocks.isModuleEnabled.mockImplementation((me, key) => key !== 'marketIntelligence');
    render(<AppShell me={mockMe} logout={vi.fn()}>Content</AppShell>);
    expect(screen.queryByText('nav.marketIntelligence')).not.toBeInTheDocument();
    expect(screen.queryByText('nav.pricingSuggestions')).not.toBeInTheDocument();
    expect(screen.queryByText('nav.sectionGrowth')).not.toBeInTheDocument();
  });

  it('hides admin-only items (and Growth) for an AGENT role', () => {
    render(<AppShell me={{ ...mockMe, role: 'AGENT' }} logout={vi.fn()}>Content</AppShell>);
    expect(screen.queryByText('nav.people')).not.toBeInTheDocument();
    expect(screen.queryByText('nav.security')).not.toBeInTheDocument();
    expect(screen.queryByText('nav.actionBoards')).not.toBeInTheDocument();
    expect(screen.queryByText('nav.sectionGrowth')).not.toBeInTheDocument();
    // Non-admin items still there.
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('collapses a section on header click and remembers it in localStorage', () => {
    render(<AppShell me={mockMe} logout={vi.fn()}>Content</AppShell>);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    fireEvent.click(screen.getByText('nav.sectionDailyOps'));
    expect(localStorage.getItem('ui.nav.section.dailyOps')).toBe('1');
    // Collapsed via CSS (display:none on .nav-sec-items) — assert the state class.
    const section = screen.getByText('nav.sectionDailyOps').closest('.nav-sec');
    expect(section.className).toContain('closed');
    fireEvent.click(screen.getByText('nav.sectionDailyOps'));
    expect(localStorage.getItem('ui.nav.section.dailyOps')).toBe('0');
  });

  it('persists the manual rail collapse choice', () => {
    render(<AppShell me={mockMe} logout={vi.fn()}>Content</AppShell>);
    const collapseBtn = document.querySelector('.sb-collapse');
    expect(collapseBtn).toBeTruthy();
    fireEvent.click(collapseBtn);
    expect(localStorage.getItem('ui.nav.rail')).toBe('1');
    expect(document.querySelector('.sidebar').className).toContain('rail');
    fireEvent.click(collapseBtn);
    expect(localStorage.getItem('ui.nav.rail')).toBe('0');
    expect(document.querySelector('.sidebar').className).not.toContain('rail');
  });

  it('sidebar search button dispatches the CommandPalette Ctrl+K trigger', () => {
    render(<AppShell me={mockMe} logout={vi.fn()}>Content</AppShell>);
    const listener = vi.fn();
    window.addEventListener('keydown', listener);
    fireEvent.click(document.querySelector('.sb-search'));
    window.removeEventListener('keydown', listener);
    expect(listener).toHaveBeenCalled();
    const evt = listener.mock.calls[0][0];
    expect(evt.key).toBe('k');
    expect(evt.ctrlKey).toBe(true);
  });
});
