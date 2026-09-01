'use client';

/**
 * `/tenants/billing` — the SUPER_ADMIN billing overview (design §7.2 screen 1).
 *
 * Thin wrapper on purpose: the vitest `.js` loader does not parse JSX in a
 * `page.js`, so the screen itself lives in the sibling `.jsx` where it can be
 * imported and tested directly — the same split as `(public)/autopay/[token]`.
 */

import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { BillingOverviewClient } from './BillingOverviewClient';

export default function TenantBillingPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const isSuper = String(me?.role || '').toUpperCase().trim() === 'SUPER_ADMIN';
  return (
    <AppShell me={me} logout={logout}>
      {isSuper
        ? <BillingOverviewClient token={token} />
        : (
          <section className="glass card-lg">
            <h2>Tenant Billing</h2>
            <p className="error">Super admin only.</p>
          </section>
        )}
    </AppShell>
  );
}
