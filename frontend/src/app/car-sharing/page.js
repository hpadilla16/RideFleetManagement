'use client';

import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';

export default function CarSharingPlaceholderPage() {
  return <AuthGate>{({ me, logout }) => (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <h2>Car Sharing Module</h2>
        <p className="label">Placeholder</p>
        <p>This module is intentionally scaffolded as a placeholder for future car sharing flows (fleet sharing rules, availability windows, station logic, and customer self-serve handoff).</p>
      </section>
    </AppShell>
  )}</AuthGate>;
}
