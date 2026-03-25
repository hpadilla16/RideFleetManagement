'use client';

import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';

export default function TollsPage() {
  return <AuthGate>{({ me, logout }) => <TollsInner me={me} logout={logout} />}</AuthGate>;
}

function TollsInner({ me, logout }) {
  const pillars = [
    {
      title: 'Tenant Fleet Matching',
      detail: 'Use only this tenant\'s vehicles, including plate, toll tag number, and toll sticker number.'
    },
    {
      title: 'Reservation Time Window',
      detail: 'Match toll transactions against pickup and return timestamps with configurable grace windows.'
    },
    {
      title: 'Review Queue',
      detail: 'Send ambiguous tolls to ops for manual confirmation before posting anything to billing.'
    },
    {
      title: 'Provider Connection',
      detail: 'Connect AutoExpreso per tenant later without making the desktop app the source of truth.'
    }
  ];

  const nextSteps = [
    'Add provider credentials and import runs per tenant.',
    'Normalize plate, tag, and sello values before scoring matches.',
    'Create a toll review queue and reservation toll panel.',
    'Post confirmed tolls into reservation charges only after review.'
  ];

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="app-banner">
          <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
            <div>
              <span className="eyebrow">Toll Operations</span>
              <h2 className="page-title" style={{ marginTop: 6 }}>Puerto Rico toll reconciliation for tenant fleet and reservations.</h2>
              <p className="ui-muted">
                This workspace is the foundation for AutoExpreso integration inside Ride Fleet. The matching model is centered on tenant fleet supply,
                reservation pickup and return timestamps, and a human review queue before billing.
              </p>
            </div>
            <span className="status-chip neutral">Module Foundation</span>
          </div>

          <div className="app-card-grid compact">
            {pillars.map((pillar) => (
              <section key={pillar.title} className="glass card section-card">
                <div className="section-title" style={{ fontSize: 15 }}>{pillar.title}</div>
                <div className="ui-muted">{pillar.detail}</div>
              </section>
            ))}
          </div>

          <div className="glass card section-card" style={{ marginTop: 12 }}>
            <div className="section-title">What this module will rely on</div>
            <div className="stack" style={{ gap: 6 }}>
              <div className="surface-note">Vehicles must carry plate, toll tag number, and toll sticker number when available.</div>
              <div className="surface-note">Reservations stay as the canonical trip window for matching and future toll billing.</div>
              <div className="surface-note">Tenant feature flags and user module access controls still decide who can see this area.</div>
            </div>
          </div>

          <div className="glass card section-card" style={{ marginTop: 12 }}>
            <div className="section-title">Next implementation steps</div>
            <div className="stack" style={{ gap: 6 }}>
              {nextSteps.map((step) => (
                <div key={step} className="surface-note">{step}</div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
