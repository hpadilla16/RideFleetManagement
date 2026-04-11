import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppShell } from '../src/components/AppShell';

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
}));

// Mock moduleAccess
vi.mock('../src/lib/moduleAccess', () => ({
  isModuleEnabled: () => true,
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

describe('AppShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
