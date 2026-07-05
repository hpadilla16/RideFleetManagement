'use client';

/**
 * Bottom tab bar for the employee app shell (Capacitor wrapper, 2026-07-05).
 *
 * Renders ONLY inside the employee shell: the native app, or a browser with
 * the ?shell=employee override (see lib/nativeShell.js) so the shell is
 * testable without a device build. Approved mockups:
 * doc/employee-mobile-app-mockups-2026-07-04.html (v2, GD sign-off).
 *
 * 5 slots: Today / Rentals / Scan (center) / Maintenance / More. Tabs gated by
 * module access disappear and the bar reflows (never leaves a hole). "More"
 * opens the existing AppShell drawer — full nav, already module-gated.
 * Icons are inline SVG (stroke: currentColor) per the design spec: emoji
 * render inconsistently across platforms and can't take the brand purple.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { applyShellQueryOverride, isEmployeeShell } from '../lib/nativeShell';
import { isModuleEnabled } from '../lib/moduleAccess';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };

const ICONS = {
  today: (
    <svg width="22" height="22" viewBox="0 0 24 24" {...stroke}>
      <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9.5 21v-6h5v6" />
    </svg>
  ),
  rentals: (
    <svg width="22" height="22" viewBox="0 0 24 24" {...stroke}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M8 3v4M16 3v4M3 10.5h18" />
    </svg>
  ),
  scan: (
    <svg width="24" height="24" viewBox="0 0 24 24" {...stroke}>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M4 12h16" />
    </svg>
  ),
  maintenance: (
    <svg width="22" height="22" viewBox="0 0 24 24" {...stroke}>
      <path d="M14.7 6.3a4.5 4.5 0 0 0-6 5.6L3 17.6V21h3.4l5.7-5.7a4.5 4.5 0 0 0 5.6-6l-3 3-2.8-.7-.7-2.8 3-3z" />
    </svg>
  ),
  more: (
    <svg width="22" height="22" viewBox="0 0 24 24" {...stroke}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  ),
};

const TABS = [
  { href: '/employee', label: 'Today', icon: 'today' },
  { href: '/reservations', label: 'Rentals', icon: 'rentals', moduleKey: 'reservations' },
  { href: '/scan', label: 'Scan', icon: 'scan', moduleKey: 'vehicles', center: true },
  { href: '/maintenance', label: 'Maint.', icon: 'maintenance', moduleKey: 'maintenance' },
  { href: null, label: 'More', icon: 'more' },
];

export function EmployeeMobileNav({ me, onMore }) {
  const pathname = usePathname();
  // Decided in an effect (not at render) so SSR and the first client render
  // agree — the shell flag lives in localStorage/window.Capacitor.
  const [active, setActive] = useState(false);

  useEffect(() => {
    applyShellQueryOverride();
    setActive(isEmployeeShell());
  }, []);

  useEffect(() => {
    if (!active) return;
    document.body.classList.add('employee-shell');
    return () => document.body.classList.remove('employee-shell');
  }, [active]);

  if (!active) return null;

  const tabs = TABS.filter((t) => !t.moduleKey || isModuleEnabled(me, t.moduleKey));

  return (
    <nav className="emp-nav" aria-label="Employee app navigation">
      {tabs.map((tab) => {
        const isActive = tab.href && (pathname === tab.href || pathname?.startsWith(`${tab.href}/`));
        if (tab.center) {
          return (
            <Link key={tab.label} href={tab.href} className="emp-nav-scan" aria-label={tab.label}>
              {ICONS[tab.icon]}
            </Link>
          );
        }
        if (!tab.href) {
          return (
            <button key={tab.label} type="button" className="emp-nav-tab" onClick={onMore}>
              {ICONS[tab.icon]}
              <span>{tab.label}</span>
            </button>
          );
        }
        return (
          <Link key={tab.label} href={tab.href} className={`emp-nav-tab ${isActive ? 'active' : ''}`}>
            {ICONS[tab.icon]}
            <span>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
