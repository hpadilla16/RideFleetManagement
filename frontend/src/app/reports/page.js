'use client';

import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';

export default function ReportsPlaceholderPage() {
  return <AuthGate>{({ me, logout }) => (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <h2>Reports Module</h2>
        <p className="label">Placeholder</p>
        <p>This module is intentionally scaffolded as a placeholder so we can implement reporting workflows later (financials, utilization, reservations, agreements, no-shows, exports).</p>
      </section>
    </AppShell>
  )}</AuthGate>;
}
