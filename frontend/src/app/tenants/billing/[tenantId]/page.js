'use client';

/**
 * `/tenants/billing/[tenantId]` — the SUPER_ADMIN billing detail (design §7.2
 * screen 2): subscription, payment method, charge history, event log, and the
 * Phase 4 write actions.
 *
 * Thin wrapper, same reason as the overview: the screen lives in the sibling
 * `.jsx` so vitest can import and exercise it directly.
 */

import { useParams } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { TenantBillingDetailClient } from './TenantBillingDetailClient';

export default function TenantBillingDetailPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const { tenantId } = useParams();
  const isSuper = String(me?.role || '').toUpperCase().trim() === 'SUPER_ADMIN';
  return (
    <AppShell me={me} logout={logout}>
      {isSuper
        ? <TenantBillingDetailClient token={token} tenantId={tenantId} />
        : (
          <section className="glass card-lg">
            <h2>Tenant Billing</h2>
            <p className="error">Super admin only.</p>
          </section>
        )}
    </AppShell>
  );
}
