'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, TOKEN_KEY, USER_KEY, readStoredToken, api, readViewLocation, writeViewLocation } from '../lib/client';
import { isModuleEnabled, pathnameToModule } from '../lib/moduleAccess';
import { useTranslation } from 'react-i18next';
import { setLanguage } from '../lib/i18n';
import { CommandPalette } from './CommandPalette';
import { ShuttleBanner } from './ShuttleBanner';

/**
 * Sidebar redesign (2026-08-24, approved mockup): the flat NAV_ITEMS list is
 * regrouped into collapsible sections. PRESENTATION ONLY — every item keeps the
 * exact same href, labelKey, module/feature/admin gate and tour anchor it had in
 * the flat list. Gated-away items stay HIDDEN (same filters as before); a
 * section whose items are all gated away renders nothing.
 */
export const NAV_SECTIONS = [
  { key: 'dailyOps', labelKey: 'nav.sectionDailyOps', items: [
    { href: '/dashboard', labelKey: 'nav.dashboard', moduleKey: 'dashboard', tour: 'nav-dashboard', icon: 'gauge' },
    { href: '/reservations', labelKey: 'nav.reservations', moduleKey: 'reservations', tour: 'nav-reservations', icon: 'calcheck' },
    { href: '/quotes', labelKey: 'nav.quotes', moduleKey: 'quotes', icon: 'quote' },
    { href: '/planner', labelKey: 'nav.planner', moduleKey: 'planner', icon: 'planner' },
    { href: '/customers', labelKey: 'nav.customers', moduleKey: 'customers', icon: 'users' },
    // Incidents hub (2026-07-28): reservation-bound documents — gated with reservations.
    { href: '/incidents', labelKey: 'nav.incidents', moduleKey: 'reservations', icon: 'alert' },
    // Self service (kiosk B3b): ops surface with live devices/sessions —
    // counter surface, gated by the opt-in 'kiosk' module.
    { href: '/kiosks', labelKey: 'nav.kiosks', moduleKey: 'kiosk', icon: 'kiosk' }
  ] },
  { key: 'fleet', labelKey: 'nav.sectionFleet', items: [
    { href: '/vehicles', labelKey: 'nav.vehicles', moduleKey: 'vehicles', icon: 'car' },
    { href: '/vehicles/inventory-helper', labelKey: 'nav.inventoryHelper', moduleKey: 'vehicles', icon: 'clipboard' },
    { href: '/maintenance', labelKey: 'nav.maintenance', moduleKey: 'maintenance', icon: 'wrench' },
    // Staff Shuttle Monitor (2026-08-24, approved): its own nav item, shown
    // only when the tenant has at least one location with the tracker ≠ OFF
    // (feature check below, /api/shuttle-monitor/enabled). Rides on the
    // reservations module like the queue and tracker settings it summarizes.
    { href: '/shuttles', labelKey: 'nav.shuttles', feature: 'shuttleMonitor', moduleKey: 'reservations', icon: 'bus' },
    { href: '/loaner', labelKey: 'nav.loaner', feature: 'dealershipLoaner', moduleKey: 'loaner', icon: 'key' },
    { href: '/car-sharing', labelKey: 'nav.carSharing', feature: 'carSharing', moduleKey: 'carSharing', icon: 'share' },
    { href: '/host', labelKey: 'nav.hostApp', feature: 'carSharing', moduleKey: 'hostApp', icon: 'phone' }
    // Employee App hidden 2026-06-16 — not in use right now (route still works at /employee).
    // { href: '/employee', labelKey: 'nav.employeeApp', moduleKey: 'employeeApp' },
  ] },
  { key: 'money', labelKey: 'nav.sectionMoney', items: [
    { href: '/tolls', labelKey: 'nav.tolls', moduleKey: 'tolls', icon: 'road' },
    { href: '/citations', labelKey: 'nav.citations', moduleKey: 'citations', icon: 'ticket' },
    // Inventory Reports now lives INSIDE Reports (tile on the /reports-v2 landing).
    { href: '/reports-v2', labelKey: 'nav.reports', moduleKey: 'reports', tour: 'nav-reports', icon: 'chart' }
  ] },
  { key: 'growth', labelKey: 'nav.sectionGrowth', items: [
    { href: '/market', labelKey: 'nav.marketIntelligence', adminOnly: true, moduleKey: 'marketIntelligence', tour: 'nav-market', icon: 'trend' },
    { href: '/suggestions', labelKey: 'nav.pricingSuggestions', adminOnly: true, moduleKey: 'marketIntelligence', icon: 'percent' }
  ] },
  { key: 'admin', labelKey: 'nav.sectionAdmin', items: [
    { href: '/people', labelKey: 'nav.people', adminOnly: true, moduleKey: 'people', tour: 'nav-people', icon: 'idcard' },
    { href: '/issues', labelKey: 'nav.issueCenter', moduleKey: 'issueCenter', icon: 'lifebuoy' },
    { href: '/knowledge-base', labelKey: 'nav.knowledgeBase', tour: 'nav-university', icon: 'grad' },
    { href: '/settings', labelKey: 'nav.settings', moduleKey: 'settings', tour: 'nav-settings', icon: 'gear' },
    { href: '/settings/security', labelKey: 'nav.security', adminOnly: true, moduleKey: 'security', icon: 'shield' },
    { href: '/settings/store-boards', labelKey: 'nav.actionBoards', adminOnly: true, moduleKey: 'settings', icon: 'kanban' },
    { href: '/tenants', labelKey: 'nav.tenants', superOnly: true, moduleKey: 'tenants', icon: 'building', chip: 'SA' },
    // Ride's own subscription revenue from its tenants. A sibling of /tenants
    // rather than a tab inside it: "who is past due today?" is a daily,
    // cross-tenant question and should not require picking a tenant first.
    // Reuses moduleKey 'tenants' deliberately — a new module key would ripple
    // through lib/module-access.js and trip test:module-defaults-drift for no
    // gain, since anyone who can see Tenants should see Tenant Billing.
    { href: '/tenants/billing', labelKey: 'nav.tenantBilling', superOnly: true, moduleKey: 'tenants', icon: 'card', chip: 'SA' }
    // Agreement clauses removed from the sidebar — it already lives inside Settings.
  ] }
];

/* 18px inline stroke icon set (approved mockup, consistent 1.8 weight). Inline
   on purpose — no icon library. */
const NAV_ICON_PATHS = {
  gauge: '<path d="M12 15l3.5-3.5"/><path d="M3.5 18.5a10 10 0 1 1 17 0"/>',
  calcheck: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 9.5h18"/><path d="m9 15.5 2 2 4-4"/>',
  quote: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/>',
  planner: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8.5h6M9 12h8M7 15.5h4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  kiosk: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M12 18h.01"/><path d="M8 6h8"/>',
  car: '<path d="M19 17h2v-4.5L18.5 8h-13L3 12.5V17h2"/><circle cx="7.5" cy="17" r="1.8"/><circle cx="16.5" cy="17" r="1.8"/><path d="M9.3 17h5.4"/><path d="M3 12.5h18"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h6"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  bus: '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 11h16"/><path d="M8 18v2M16 18v2"/><path d="M8 15h.01M16 15h.01"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 9.5-9.5"/><path d="M15.5 7.5l3 3"/><path d="M18 5l2 2"/>',
  share: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M12 18h.01"/>',
  road: '<path d="M4 20 8 4M20 20 16 4"/><path d="M12 6v2M12 11v2.5M12 16.5v2.5"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M13 5.5v2M13 11v2M13 16.5v2"/>',
  chart: '<path d="M3 3v18h18"/><path d="M8 17v-5M13 17V8M18 17v-3"/>',
  trend: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  percent: '<circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/><path d="M19 5 5 19"/>',
  idcard: '<rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="9" r="2.5"/><path d="M8 16.5a4 4 0 0 1 8 0"/>',
  lifebuoy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m5.7 5.7 3.4 3.4M18.3 5.7l-3.4 3.4M18.3 18.3l-3.4-3.4M5.7 18.3l3.4-3.4"/>',
  grad: '<path d="M22 9 12 4 2 9l10 5z"/><path d="M6 11.5V16c0 1.4 2.7 2.8 6 2.8s6-1.4 6-2.8v-4.5"/><path d="M22 9v5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  kanban: '<path d="M6 5v14M12 5v8M18 5v11"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  /* Topbar redesign (2026-08-25, approved mockup) */
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  display: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  lock: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'
};

function NavIcon({ name, className }) {
  const markup = NAV_ICON_PATHS[name];
  if (!markup) return null;
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

/* Section open/closed + rail collapse persistence (per approved mockup). */
const NAV_SECTION_STATE_PREFIX = 'ui.nav.section.';
const NAV_RAIL_KEY = 'ui.nav.rail';
/* Auto-collapse to the icon rail on narrow laptops. NOTE: the existing mobile
   drawer takes over below 981px (globals.css @media 980px) and is untouched —
   rail styles are scoped to min-width 981px, so within 768–980px the drawer
   still wins exactly as before. */
const NAV_RAIL_AUTO_QUERY = '(min-width: 768px) and (max-width: 1280px)';

const IDLE_LOCK_MS = 2 * 60 * 1000;

/* Theme persistence (topbar redesign 2026-08-25, approved decision (a)):
   3 states — 'light' | 'dark' | null (= follow the OS via
   prefers-color-scheme). Stored under 'ui.theme'; the legacy 2-state
   'ui.darkMode' key is still read as a fallback (a user's explicit old
   choice survives) and mirrored with the RESOLVED value so nothing that
   consumed it (layout.js boot script on stale builds) breaks. data-theme
   on <html> stays the single consumption point — unchanged. */
const THEME_KEY = 'ui.theme';
function readThemePref() {
  if (typeof window === 'undefined') return null;
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') return v;
    if (v === 'system') return null;
    const legacy = localStorage.getItem('ui.darkMode');
    if (legacy === '1') return 'dark';
    if (legacy === '0') return 'light';
    return null;
  } catch { return null; }
}

/* Avatar initials from the user's name (brand-tinted background in CSS). */
function userInitials(me) {
  const src = String(me?.fullName || me?.name || '').trim();
  if (src) {
    const parts = src.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] || '';
    const second = parts.length > 1 ? (parts[parts.length - 1][0] || '') : (parts[0]?.[1] || '');
    return (first + second).toUpperCase();
  }
  const mail = String(me?.email || '').trim();
  return mail ? mail.slice(0, 2).toUpperCase() : 'U';
}

function formatDate(d) {
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatTime(d) {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function AppShell({ me, logout, children }) {
  // Location switcher (2026-08-11, Hector): a user with several locations
  // picks which one they are VIEWING, the way a super admin picks a tenant.
  // The pick travels as a header on every request (see lib/client.js) and
  // requireAuth narrows their scope server-side. This list is fetched with
  // skipViewLocation — otherwise, once narrowed, the dropdown would show only
  // the selected location and you could never switch back.
  const [viewLocations, setViewLocations] = useState([]);
  const [viewLocationId, setViewLocationId] = useState('');
  useEffect(() => {
    setViewLocationId(readViewLocation());
    const token = readStoredToken();
    if (!token) return;
    if (String(me?.role || '').toUpperCase() === 'SUPER_ADMIN') return; // supers drive by tenant
    api('/api/locations/selectable', { skipViewLocation: true }, token)
      .then((rows) => setViewLocations(Array.isArray(rows) ? rows : []))
      .catch(() => setViewLocations([]));
  }, [me?.role]);
  const switchViewLocation = (id) => {
    writeViewLocation(id);
    // Full reload: every page refetches under the new scope. Cheaper and more
    // correct than teaching each page to react to a scope event.
    window.location.reload();
  };

  const { t, i18n } = useTranslation();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  // 3-state theme (approved decision (a)): 'light' | 'dark' | null = system.
  const [themePref, setThemePref] = useState(() => readThemePref());
  const [systemDark, setSystemDark] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => setSystemDark(!!mq.matches);
    apply();
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', apply);
      else if (mq.removeListener) mq.removeListener(apply);
    };
  }, []);
  const darkMode = themePref === 'dark' || (themePref === null && systemDark);
  const pickTheme = (pref) => {
    setThemePref(pref);
    try { localStorage.setItem(THEME_KEY, pref === null ? 'system' : pref); } catch {}
  };

  const [locked, setLocked] = useState(false);
  const [hasPin, setHasPin] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newPin2, setNewPin2] = useState('');
  const [lockMsg, setLockMsg] = useState('');
  const [failedUnlockAttempts, setFailedUnlockAttempts] = useState(0);
  const [now, setNow] = useState(new Date());
  const [canReturnSuper, setCanReturnSuper] = useState(false);
  const [carSharingVisible, setCarSharingVisible] = useState(() => isModuleEnabled(me, 'carSharing'));
  const [dealershipLoanerVisible, setDealershipLoanerVisible] = useState(() => isModuleEnabled(me, 'loaner'));
  // Shuttle Monitor visibility (2026-08-24): ONE fetch at mount, no polling —
  // the nav shows only for tenants with a tracker turned on somewhere in the
  // caller's scope. Soft-fail hidden: a backend mid-deploy hides a nav item,
  // it never breaks the shell.
  const [shuttleMonitorVisible, setShuttleMonitorVisible] = useState(false);
  // Open-request badge on the Shuttles item — fed by the ShuttleBanner's
  // existing 20s poll via a window event, so the shell adds ZERO requests.
  const [shuttleOpenCount, setShuttleOpenCount] = useState(0);
  useEffect(() => {
    const token = readStoredToken();
    if (!token || !isModuleEnabled(me, 'reservations')) return;
    api('/api/shuttle-monitor/enabled', {}, token)
      .then((out) => setShuttleMonitorVisible(!!out?.enabled))
      .catch(() => setShuttleMonitorVisible(false));
  }, [me]);
  useEffect(() => {
    const onCount = (e) => setShuttleOpenCount(Number(e?.detail) || 0);
    window.addEventListener('shuttle:openCount', onCount);
    return () => window.removeEventListener('shuttle:openCount', onCount);
  }, []);

  // Collapsible sections — open by default, closed state remembered per
  // section (one localStorage key each, so future sections default open).
  const [closedSections, setClosedSections] = useState(() => {
    const out = {};
    if (typeof window === 'undefined') return out;
    for (const sec of NAV_SECTIONS) {
      try { out[sec.key] = localStorage.getItem(NAV_SECTION_STATE_PREFIX + sec.key) === '1'; } catch { out[sec.key] = false; }
    }
    return out;
  });
  const toggleSection = (key) => {
    setClosedSections((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem(NAV_SECTION_STATE_PREFIX + key, next[key] ? '1' : '0'); } catch {}
      return next;
    });
  };

  // Icon-rail collapse — manual choice (persisted) wins; otherwise the
  // 768–1280px auto-collapse decides. Mobile drawer (<981px CSS) unaffected.
  const [railPref, setRailPref] = useState(() => {
    if (typeof window === 'undefined') return null;
    try {
      const v = localStorage.getItem(NAV_RAIL_KEY);
      return v === '1' ? true : v === '0' ? false : null;
    } catch { return null; }
  });
  const [autoRail, setAutoRail] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(NAV_RAIL_AUTO_QUERY);
    const apply = () => setAutoRail(!!mq.matches);
    apply();
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', apply);
      else if (mq.removeListener) mq.removeListener(apply);
    };
  }, []);
  const railCollapsed = railPref === null ? autoRail : railPref;
  const toggleRail = () => {
    const next = !railCollapsed;
    setRailPref(next);
    try { localStorage.setItem(NAV_RAIL_KEY, next ? '1' : '0'); } catch {}
  };

  // Same trigger the topbar search button uses — opens the EXISTING
  // CommandPalette (it listens for Ctrl/Cmd+K on window).
  const openCommandPalette = () => {
    try { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })); } catch { /* no-op */ }
  };

  // Profile dropdown (topbar redesign 2026-08-25): open/close + click-outside
  // + Esc (returns focus to the avatar button) + ArrowUp/ArrowDown between
  // the menu's controls. Pure presentation — the actions inside reuse the
  // exact same handlers the old flat topbar buttons had.
  const [profileOpen, setProfileOpen] = useState(false);
  const profileBtnRef = useRef(null);
  const profileMenuRef = useRef(null);
  const closeProfileMenu = (refocus) => {
    setProfileOpen(false);
    if (refocus && profileBtnRef.current) profileBtnRef.current.focus();
  };
  useEffect(() => {
    if (!profileOpen) return;
    const onDown = (e) => {
      if (profileMenuRef.current && profileMenuRef.current.contains(e.target)) return;
      if (profileBtnRef.current && profileBtnRef.current.contains(e.target)) return;
      setProfileOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeProfileMenu(true);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const root = profileMenuRef.current;
        if (!root) return;
        const items = Array.from(root.querySelectorAll('button:not(:disabled)'));
        if (!items.length) return;
        e.preventDefault();
        const idx = items.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown'
          ? items[(idx + 1) % items.length]
          : items[(idx - 1 + items.length) % items.length];
        next.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileOpen]);

  const idleTimerRef = useRef(null);
  const role = String(me?.role || '').toUpperCase();
  // Identity bits for the avatar button + dropdown header. Same sources the
  // old identity block used, plus whatever tenant name the shell already has.
  const displayName = me?.fullName || me?.name || me?.email || t('appShell.userFallback');
  const initials = useMemo(() => userInitials(me), [me]);
  const tenantName = me?.tenantName || me?.tenant?.name || me?.tenantSlug || '';
  // 2026-06-04 — per-user exemption (ops/reporting agent accounts): never
  // arm the idle lock and ignore any persisted locked flag for these users.
  const screenLockExempt = !!me?.screenLockExempt;
  const isAdminNavRole = ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(role);
  const activeModule = pathnameToModule(pathname);
  const blockedModule = activeModule && !isModuleEnabled(me, activeModule) ? activeModule : null;

  const authApi = async (path, init = {}) => {
    const token = readStoredToken();
    if (!token) throw new Error('Missing auth token');
    const res = await fetch(`${API_BASE}/api/auth${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers || {})
      }
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
    return j;
  };

  useEffect(() => {
    try {
      setThemePref(readThemePref());
      const persistedLocked = localStorage.getItem('ui.screenLocked') === '1';
      if (persistedLocked && !me?.screenLockExempt) {
        setLocked(true);
        setNow(new Date());
      }
      if (me?.screenLockExempt) {
        try { localStorage.removeItem('ui.screenLocked'); } catch {}
      }
      const hasPinHint = localStorage.getItem('ui.hasPin') === '1';
      setHasPin(hasPinHint);
      const hasBackup = !!localStorage.getItem('superadmin_backup_token');
      const currentRole = String(me?.role || '').toUpperCase();
      setCanReturnSuper(hasBackup && currentRole !== 'SUPER_ADMIN');
    } catch {}

    (async () => {
      try {
        const token = readStoredToken();
        if (!token) return;
        const st = await authApi('/lock-pin/status');
        const has = !!st?.hasPin;
        setHasPin(has);
        try { localStorage.setItem('ui.hasPin', has ? '1' : '0'); } catch {}
      } catch {
        setHasPin(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Legacy mirror: resolved 2-state value, so old consumers keep working.
    try { localStorage.setItem('ui.darkMode', darkMode ? '1' : '0'); } catch {}
    // data-theme on <html> stays the single consumption point — unchanged.
    if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  useEffect(() => {
    setCarSharingVisible(isModuleEnabled(me, 'carSharing'));
    setDealershipLoanerVisible(isModuleEnabled(me, 'loaner'));
  }, [me]);

  useEffect(() => {
    if (!locked) return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [locked]);

  const armIdleLock = useMemo(() => () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      setLocked(true);
      try { localStorage.setItem('ui.screenLocked', '1'); } catch {}
      setPinInput('');
      setLockMsg('');
      setNow(new Date());
    }, IDLE_LOCK_MS);
  }, []);

  useEffect(() => {
    if (screenLockExempt) {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (locked) setLocked(false);
      return;
    }
    if (locked) {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      return;
    }
    const onActivity = () => armIdleLock();
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach((eventName) => window.addEventListener(eventName, onActivity, { passive: true }));
    armIdleLock();
    return () => {
      events.forEach((eventName) => window.removeEventListener(eventName, onActivity));
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [locked, armIdleLock, screenLockExempt]);

  const lockNow = () => {
    setLocked(true);
    try { localStorage.setItem('ui.screenLocked', '1'); } catch {}
    setPinInput('');
    setLockMsg('');
    setFailedUnlockAttempts(0);
    setNow(new Date());
  };

  const returnToSuperAdmin = () => {
    try {
      const t = localStorage.getItem('superadmin_backup_token');
      const u = localStorage.getItem('superadmin_backup_user');
      if (!t || !u) return;
      const v = localStorage.getItem('superadmin_backup_viewlocation');
      localStorage.setItem(TOKEN_KEY, t);
      localStorage.setItem(USER_KEY, u);
      if (v) localStorage.setItem('ui.viewLocationId', v);
      else localStorage.removeItem('ui.viewLocationId');
      localStorage.removeItem('superadmin_backup_token');
      localStorage.removeItem('superadmin_backup_user');
      localStorage.removeItem('superadmin_backup_viewlocation');
      window.location.href = '/tenants';
    } catch {}
  };

  const unlock = async () => {
    try {
      if (!hasPin) {
        if (!newPin || newPin.length < 4) return setLockMsg(t('lockScreen.pinTooShort'));
        if (newPin !== newPin2) return setLockMsg(t('lockScreen.pinMismatch'));
        await authApi('/lock-pin/set', { method: 'POST', body: JSON.stringify({ pin: newPin }) });
        try { localStorage.setItem('ui.hasPin', '1'); } catch {}
        setHasPin(true);
        setNewPin('');
        setNewPin2('');
        setLockMsg('');
        setFailedUnlockAttempts(0);
        setLocked(false);
        try { localStorage.setItem('ui.screenLocked', '0'); } catch {}
        return;
      }

      await authApi('/lock-pin/verify', { method: 'POST', body: JSON.stringify({ pin: pinInput }) });
      setPinInput('');
      setLockMsg('');
      setFailedUnlockAttempts(0);
      setLocked(false);
      try { localStorage.setItem('ui.screenLocked', '0'); } catch {}
    } catch (e) {
      const nextFails = failedUnlockAttempts + 1;
      setFailedUnlockAttempts(nextFails);
      if (nextFails >= 3) {
        setLockMsg(t('lockScreen.tooManyAttempts'));
        setTimeout(() => logout(), 500);
        return;
      }
      setLockMsg(`${e.message || t('lockScreen.invalidPin')} ${t('lockScreen.attemptsSuffix', { count: nextFails })}`);
    }
  };

  const resetMyPin = async () => {
    try {
      await authApi('/lock-pin/reset', { method: 'POST' });
      try { localStorage.setItem('ui.hasPin', '0'); } catch {}
      setHasPin(false);
      setPinInput('');
      setNewPin('');
      setNewPin2('');
      setLockMsg(t('lockScreen.pinReset'));
    } catch (e) {
      setLockMsg(e.message || t('lockScreen.unableToReset'));
    }
  };

  // The SAME visibility filters the old flat list applied — gate logic is
  // untouched, only the grouping around it changed.
  const isNavItemVisible = (item) =>
    (!item.superOnly || role === 'SUPER_ADMIN') &&
    (!item.adminOnly || isAdminNavRole) &&
    (item.feature !== 'carSharing' || carSharingVisible) &&
    (item.feature !== 'dealershipLoaner' || dealershipLoanerVisible) &&
    (item.feature !== 'shuttleMonitor' || shuttleMonitorVisible) &&
    isModuleEnabled(me, item.moduleKey);

  const renderNavItem = (item) => {
    const label = t(item.labelKey);
    const showBadge = item.href === '/shuttles' && shuttleOpenCount > 0;
    if (item.disabled) {
      return (
        <span key={item.href} className="nav-link nav-link-disabled">
          <NavIcon name={item.icon} className="nav-icon" />
          <span className="nav-label">{label}</span>
        </span>
      );
    }
    return (
      <Link
        key={item.href}
        href={item.href}
        className={`nav-link ${pathname?.startsWith(item.href) ? 'active' : ''}`}
        data-tour={item.tour}
        data-tip={showBadge ? `${label} (${shuttleOpenCount})` : label}
        onClick={() => setMobileOpen(false)}
      >
        <NavIcon name={item.icon} className="nav-icon" />
        <span className="nav-label">{label}</span>
        {item.chip ? <span className="nav-chip">{item.chip}</span> : null}
        {showBadge ? <span className="nav-badge">{shuttleOpenCount}</span> : null}
      </Link>
    );
  };

  return (
    <div className={`app-shell ${railCollapsed ? 'nav-rail' : ''}`}>
      <aside className={`sidebar glass ${mobileOpen ? 'open' : ''} ${railCollapsed ? 'rail' : ''}`}>
        <div className="brand-block">
          <div className="brand">Ride Fleet</div>
          <div className="brand-subtitle">{t('appShell.brandSubtitle')}</div>
        </div>

        {/* The `global-search` tour anchor lives HERE, not on the topbar's
            mobile search button (2026-08-26). The 2026-08-25 topbar redesign
            removed the duplicate desktop search field, leaving the anchor on
            `.tb-search-mobile`, which is `display: none` above 980px — so the
            onboarding tour's "Find anything from here" step waited forever on
            an element no desktop user could see. This sidebar control is the
            only always-present desktop entry to the command palette, which is
            exactly what the step describes. */}
        <button
          type="button"
          className="sb-search"
          data-tour="global-search"
          title={t('search.open', 'Search (Ctrl+K)')}
          onClick={openCommandPalette}
        >
          <NavIcon name="search" className="sb-search-icon" />
          <span className="sb-search-label">{t('appShell.goTo', 'Go to…')}</span>
          <kbd className="sb-search-kbd">Ctrl K</kbd>
        </button>

        <div className="nav-scroll">
          {NAV_SECTIONS.map((sec) => {
            const visibleItems = sec.items.filter(isNavItemVisible);
            if (!visibleItems.length) return null; // fully gated section: no empty header
            const closed = !!closedSections[sec.key];
            return (
              <div key={sec.key} className={`nav-sec ${closed ? 'closed' : ''}`}>
                <button
                  type="button"
                  className="nav-sec-head"
                  aria-expanded={!closed}
                  onClick={() => toggleSection(sec.key)}
                >
                  <span className="nav-sec-title">{t(sec.labelKey)}</span>
                  <NavIcon name="chev" className="nav-sec-chev" />
                </button>
                <div className="nav-sec-items">
                  {visibleItems.map(renderNavItem)}
                </div>
              </div>
            );
          })}
        </div>

        <div className="sb-foot">
          <button
            type="button"
            className="sb-collapse"
            aria-pressed={railCollapsed}
            title={railCollapsed ? t('appShell.expandNav', 'Expand') : t('appShell.collapseNav', 'Collapse')}
            onClick={toggleRail}
          >
            <NavIcon name="panel" className="sb-collapse-icon" />
            <span className="sb-collapse-label">{railCollapsed ? t('appShell.expandNav', 'Expand') : t('appShell.collapseNav', 'Collapse')}</span>
          </button>
        </div>
      </aside>

      {mobileOpen ? <div className="drawer-backdrop" onClick={() => setMobileOpen(false)} /> : null}

      <main className="content">
        {/* Shuttle arc (2026-08-05): a customer at the curb outranks whatever
            screen the agent is on — banner lives in the shell, not a page. */}
        <ShuttleBanner />
        {/* Topbar redesign (2026-08-25, approved mockup): left = hamburger
            (mobile) + mobile-only search icon + location chip-select; right =
            impersonation pill + Display + avatar/profile dropdown. ZERO logic
            changes — every control keeps its old handler and visibility
            condition; identity/language/theme/lock/logout consolidated into
            the profile menu. Desktop search left the topbar on purpose (the
            sidebar "Go to… Ctrl+K" is the only desktop entry). */}
        <div className="topbar glass">
          <div className="topbar-primary">
            <button
              className="mobile-menu-btn topbar-action-btn"
              aria-label={t('appShell.openNavMenu')}
              title={t('appShell.openMenu')}
              onClick={() => setMobileOpen((v) => !v)}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" style={{ display: 'block', margin: '0 auto' }}>
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <button
              type="button"
              className="tb-search-mobile"
              title={t('search.open', 'Search (Ctrl+K)')}
              aria-label={t('search.open', 'Search (Ctrl+K)')}
              onClick={openCommandPalette}
            >
              <NavIcon name="search" className="tb-search-mobile-icon" />
            </button>
            {viewLocations.length > 1 ? (
              <span className="tb-loc" title={t('appShell.viewLocation', 'Which location you are viewing')}>
                <NavIcon name="pin" className="tb-loc-icon" />
                <select
                  data-tour="view-location-switcher"
                  className="tb-loc-select"
                  value={viewLocationId}
                  onChange={(e) => switchViewLocation(e.target.value)}
                  title={t('appShell.viewLocation', 'Which location you are viewing')}
                >
                  <option value="">{t('appShell.allLocations', 'All my locations')}</option>
                  {viewLocations.map((l) => (
                    <option key={l.id} value={l.id}>{l.code ? `${l.code} · ${l.name}` : l.name}</option>
                  ))}
                </select>
                <NavIcon name="chev" className="tb-loc-chev" />
              </span>
            ) : null}
          </div>

          <div className="tb-right">
            {canReturnSuper ? (
              <span className="tb-impersonation">
                <NavIcon name="eye" className="tb-imp-icon" />
                <span className="tb-imp-label">
                  {tenantName ? t('topbar.viewingTenant', { tenant: tenantName }) : t('topbar.viewingTenantUnknown')}
                </span>
                <button
                  type="button"
                  className="tb-imp-return"
                  title={t('topbar.returnToSuperAdmin')}
                  onClick={returnToSuperAdmin}
                >
                  {t('appShell.return')}
                </button>
              </span>
            ) : null}
            <button
              type="button"
              className="tb-display"
              title={t('appShell.openCustomerDisplay')}
              onClick={() => window.open('/customer-display', 'customer-display', 'width=600,height=900,scrollbars=yes,resizable=yes')}
            >
              <NavIcon name="display" className="tb-display-icon" />
              <span className="tb-display-label">{t('appShell.display')}</span>
            </button>
            <span className="tb-sep" aria-hidden="true" />
            <span className="tb-profile-anchor">
              <button
                type="button"
                ref={profileBtnRef}
                className="tb-profile"
                aria-haspopup="menu"
                aria-expanded={profileOpen}
                onClick={() => setProfileOpen((v) => !v)}
              >
                <span className="tb-avatar" aria-hidden="true">{initials}</span>
                <span className="tb-id">
                  <span className="tb-id-name">{displayName}</span>
                  <span className="tb-id-role">{me?.role || 'ADMIN'}</span>
                </span>
                <NavIcon name="chev" className="tb-profile-chev" />
              </button>
              {profileOpen ? (
                <div className="profile-dd" role="menu" aria-label={t('topbar.profileMenu', 'Profile')} ref={profileMenuRef}>
                  <div className="profile-dd-head">
                    <span className="tb-avatar tb-avatar-lg" aria-hidden="true">{initials}</span>
                    <div className="profile-dd-who">
                      <div className="profile-dd-name">{displayName}</div>
                      {me?.email ? <div className="profile-dd-mail">{me.email}</div> : null}
                      <div className="profile-dd-meta">
                        <span className="profile-chip">{me?.role || 'ADMIN'}</span>
                        {tenantName ? <span className="profile-chip neutral">{tenantName}</span> : null}
                      </div>
                    </div>
                  </div>
                  <div className="profile-dd-sep" />
                  <div className="profile-dd-group">
                    <div className="profile-dd-glabel">{t('topbar.languageLabel')}</div>
                    <div className="profile-seg" role="radiogroup" aria-label={t('topbar.languageLabel')}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={i18n.language === 'es'}
                        className={i18n.language === 'es' ? 'on' : ''}
                        onClick={() => setLanguage('es')}
                      >
                        ES
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={i18n.language !== 'es'}
                        className={i18n.language !== 'es' ? 'on' : ''}
                        onClick={() => setLanguage('en')}
                      >
                        EN
                      </button>
                    </div>
                  </div>
                  <div className="profile-dd-group">
                    <div className="profile-dd-glabel">{t('topbar.themeLabel')}</div>
                    <div className="profile-seg" role="radiogroup" aria-label={t('topbar.themeLabel')}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={themePref === 'light'}
                        className={themePref === 'light' ? 'on' : ''}
                        onClick={() => pickTheme('light')}
                      >
                        <NavIcon name="sun" className="profile-seg-icon" />
                        {t('topbar.light')}
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={themePref === 'dark'}
                        className={themePref === 'dark' ? 'on' : ''}
                        onClick={() => pickTheme('dark')}
                      >
                        <NavIcon name="moon" className="profile-seg-icon" />
                        {t('topbar.dark')}
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={themePref === null}
                        className={themePref === null ? 'on' : ''}
                        onClick={() => pickTheme(null)}
                      >
                        <NavIcon name="display" className="profile-seg-icon" />
                        {t('topbar.themeSystem')}
                      </button>
                    </div>
                  </div>
                  <div className="profile-dd-sep" />
                  {!screenLockExempt ? (
                    <>
                      <button
                        type="button"
                        className="profile-dd-item"
                        role="menuitem"
                        onClick={() => { closeProfileMenu(false); lockNow(); }}
                      >
                        <NavIcon name="lock" className="profile-dd-item-icon" />
                        {t('topbar.lockScreen')}
                        <span className="profile-dd-hint">{t('topbar.lockHint')}</span>
                      </button>
                      <div className="profile-dd-sep" />
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="profile-dd-item danger"
                    role="menuitem"
                    onClick={logout}
                  >
                    <NavIcon name="logout" className="profile-dd-item-icon" />
                    {t('topbar.logout')}
                  </button>
                </div>
              ) : null}
            </span>
          </div>
        </div>

        <CommandPalette />

        {blockedModule ? (
          <section className="glass card-lg stack">
            <div className="eyebrow">{t('blockedModule.eyebrow')}</div>
            <h2>{t('blockedModule.title')}</h2>
            <p className="ui-muted">
              {t('blockedModule.body')}
            </p>
          </section>
        ) : children}
      </main>

      {locked ? (
        <div className="screenlock-overlay">
          <div className="screenlock-bg-orb orb-a" />
          <div className="screenlock-bg-orb orb-b" />
          <div className="screenlock-bg-orb orb-c" />

          <div className="screenlock-center">
            <div className="screenlock-logo-wrap">
              <img
                src="/logo.jpg"
                alt="Ride Fleet"
                className="screenlock-logo-img"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
              <div className="screenlock-logo">Ride Fleet</div>
            </div>
            <div className="screenlock-time">{formatTime(now)}</div>
            <div className="screenlock-date">{formatDate(now)}</div>
            <div className="screenlock-user">{me?.fullName || me?.name || me?.email || t('appShell.userFallback')}</div>

            <div className="screenlock-card glass card">
              <h3 style={{ marginBottom: 8 }}>{t('lockScreen.screenLocked')}</h3>
              {hasPin ? (
                <input
                  type="password"
                  placeholder={t('lockScreen.enterPin')}
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') unlock(); }}
                />
              ) : (
                <div className="stack">
                  <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>{t('lockScreen.setPin')}</div>
                  <input type="password" placeholder={t('lockScreen.newPin')} value={newPin} onChange={(e) => setNewPin(e.target.value)} />
                  <input type="password" placeholder={t('lockScreen.confirmPin')} value={newPin2} onChange={(e) => setNewPin2(e.target.value)} />
                </div>
              )}

              {lockMsg ? <div className="label" style={{ marginTop: 8, color: '#fca5a5' }}>{lockMsg}</div> : null}

              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button onClick={unlock}>{t('lockScreen.unlock')}</button>
                <button className="button-subtle" onClick={resetMyPin}>{t('appShell.resetPin')}</button>
                <button className="button-subtle" onClick={logout}>{t('topbar.logout')}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
