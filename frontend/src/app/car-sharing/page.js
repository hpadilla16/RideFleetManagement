'use client';

import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';

const launchTracks = [
  {
    title: 'Host Supply',
    points: [
      'Owner onboarding and payout setup',
      'Vehicle listing readiness and compliance',
      'Availability windows, blackout dates, and handoff rules'
    ]
  },
  {
    title: 'Guest Booking',
    points: [
      'Marketplace search with daily pricing and trip rules',
      'Driver verification, pre-check-in, and insurance selection',
      'Trip timeline with signature, payment, and receipts'
    ]
  },
  {
    title: 'Trip Ops',
    points: [
      'Pickup and return workflow with inspection evidence',
      'Damage, tolls, reimbursements, and post-trip charges',
      'Support timeline for disputes and claims'
    ]
  }
];

const reuseAreas = [
  'Reservations, pricing snapshots, charges, and payments',
  'Rental agreement signing and document delivery',
  'Inspection reports, images, and damage tracking',
  'Commission/earnings ledger pattern for host payouts and platform fees',
  'Customer portal patterns for self-service guest workflows'
];

const mvpPhases = [
  {
    phase: 'Phase 1',
    name: 'Discovery + Model',
    outcome: 'Define host, listing, trip, payout, and verification models that can coexist with Fleet Manager tenants.'
  },
  {
    phase: 'Phase 2',
    name: 'Supply + Listing',
    outcome: 'Allow hosts or internal ops to onboard vehicles, set pricing, and publish a listing.'
  },
  {
    phase: 'Phase 3',
    name: 'Guest Booking Flow',
    outcome: 'Search, reserve, pay, pre-check-in, sign, and receive trip documents through a customer-facing flow.'
  },
  {
    phase: 'Phase 4',
    name: 'Trip Ops + Earnings',
    outcome: 'Handle pickup/return, incident tracking, host earnings, and platform payouts.'
  }
];

const actorModel = [
  {
    title: 'Tenant',
    detail: 'Remains the operational container. Fleet Manager teams can manage listings, support trips, and control marketplace policy.'
  },
  {
    title: 'HostProfile',
    detail: 'Becomes the business identity for supply, payouts, and listing ownership, with optional future login access.'
  },
  {
    title: 'User',
    detail: 'Stays as the application login actor for internal staff and eventually for host portal access when linked to a HostProfile.'
  },
  {
    title: 'Customer',
    detail: 'Continues as the guest/renter identity for booking, pre-check-in, signature, payment, and trip documents.'
  }
];

function DiscoveryCard({ title, children }) {
  return (
    <section className="glass card-lg stack" style={{ gap: 12 }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {children}
    </section>
  );
}

export default function CarSharingPage() {
  return (
    <AuthGate>
      {({ me, logout }) => (
        <AppShell me={me} logout={logout}>
          <section className="glass card-lg" style={{ marginBottom: 18 }}>
            <div className="label">Sprint 5 Discovery</div>
            <h2 style={{ marginTop: 8, marginBottom: 10 }}>Car Sharing Track</h2>
            <p style={{ margin: 0, maxWidth: 900, lineHeight: 1.7 }}>
              This module is the bridge from traditional fleet rental operations into a Turo-style experience.
              The goal is not to replace Fleet Manager, but to reuse its strongest operational pieces while adding
              listing, guest booking, host earnings, and trip-specific workflows.
            </p>
          </section>

          <section className="grid2">
            <DiscoveryCard title="Product Shape">
              <div className="stack">
                {launchTracks.map((track) => (
                  <div key={track.title} className="glass" style={{ padding: 14, borderRadius: 18 }}>
                    <div style={{ fontWeight: 700, marginBottom: 8 }}>{track.title}</div>
                    <div className="stack">
                      {track.points.map((point) => (
                        <div key={point} className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
                          {point}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </DiscoveryCard>

            <DiscoveryCard title="What We Can Reuse">
              <div className="stack">
                {reuseAreas.map((area) => (
                  <div key={area} className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
                    <strong>•</strong>
                    <span>{area}</span>
                  </div>
                ))}
              </div>
            </DiscoveryCard>
          </section>

          <section className="glass card-lg" style={{ marginTop: 18 }}>
            <h3 style={{ marginTop: 0 }}>MVP Phases</h3>
            <div className="stack">
              {mvpPhases.map((phase) => (
                <div key={phase.phase} className="row-between" style={{ alignItems: 'flex-start', gap: 16, padding: '14px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  <div style={{ minWidth: 120 }}>
                    <div className="label">{phase.phase}</div>
                    <div style={{ fontWeight: 700 }}>{phase.name}</div>
                  </div>
                  <div style={{ maxWidth: 760, lineHeight: 1.7 }}>{phase.outcome}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="grid2" style={{ marginTop: 18 }}>
            <DiscoveryCard title="Recommended Actor Model">
              <div className="stack">
                {actorModel.map((item) => (
                  <div key={item.title} className="glass" style={{ padding: 14, borderRadius: 18 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>{item.title}</div>
                    <div style={{ lineHeight: 1.7 }}>{item.detail}</div>
                  </div>
                ))}
              </div>
            </DiscoveryCard>

            <DiscoveryCard title="Key Business Decisions">
              <div className="stack">
                <div><strong>Inventory source:</strong> internal fleet only, host-owned vehicles, or both.</div>
                <div><strong>Payout timing:</strong> after trip completion, after damage hold release, or on a schedule.</div>
                <div><strong>Verification gate:</strong> driver approval before booking, before pickup, or both.</div>
                <div><strong>Trip responsibility:</strong> host handoff, station handoff, or blended handoff model.</div>
              </div>
            </DiscoveryCard>

            <DiscoveryCard title="Recommended Next Build Slice">
              <div className="stack">
                <div>1. Define data model for `Host`, `Listing`, `Trip`, `TripPayout`, and `TripIncident`.</div>
                <div>2. Build internal listing management inside Fleet Manager.</div>
                <div>3. Add a simple guest-facing search and listing detail experience.</div>
                <div>4. Reuse pre-check-in, signature, and payment steps from the customer portal.</div>
              </div>
            </DiscoveryCard>
          </section>
        </AppShell>
      )}
    </AuthGate>
  );
}
