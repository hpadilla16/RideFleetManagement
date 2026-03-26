'use client';

import Link from 'next/link';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';

const anchors = [
  { id: 'start-here', label: 'Start Here' },
  { id: 'front-desk', label: 'Front Desk' },
  { id: 'support', label: 'Support & Issues' },
  { id: 'loaner', label: 'Loaner Program' },
  { id: 'car-sharing', label: 'Car Sharing' },
  { id: 'admin', label: 'Admin & Settings' }
];

const dailyWorkflows = [
  {
    title: 'Dashboard to Reservation',
    route: '/dashboard',
    summary: 'Start on the workspace dashboard, check pickups/returns, then jump into Reservations for check-out, check-in, inspections, and payments.',
    bullets: [
      'Use Dashboard to spot today’s pickups, returns, fee advisories, and lane pressure.',
      'Open Reservations to create, edit, or complete rental workflows.',
      'Inside each reservation, move through checkout, inspection, check-in, payments, and tolls.'
    ]
  },
  {
    title: 'Customer Support',
    route: '/issues',
    summary: 'Issue Center is the control room for disputes, support replies, host approvals, and now toll disputes tied to reservations.',
    bullets: [
      'Use Issues to review open incidents, request more info, and resolve customer disputes.',
      'Toll disputes now open or reuse Issue Center cases automatically from the Tolls module.',
      'If a case belongs to a reservation, use Open Workflow to jump into the reservation context.'
    ]
  },
  {
    title: 'Loaner Operations',
    route: '/loaner',
    summary: 'Loaner Program handles service-lane reservations, borrower packet progress, delivery/return flow, billing blockers, and closeout.',
    bullets: [
      'Use Loaner Shift and queue focus filters to work intake, returns, billing, or alerts.',
      'Track borrower packet status, advisor context, and billing readiness in one place.',
      'Use Reservation workflow pages when a loaner needs vehicle, payment, or inspection follow-up.'
    ]
  },
  {
    title: 'Car Sharing & Host',
    route: '/car-sharing',
    summary: 'Car Sharing manages published listings, trips, availability, and attention queues. Host App is the host-facing surface for listings and readiness.',
    bullets: [
      'Use Car Sharing to manage listings, trips, host approvals, and marketplace supply.',
      'Use Host App when working as the host or validating host-side workflows.',
      'Public host profile, host review, and guest trust surfaces all tie back into these modules.'
    ]
  }
];

const roleGuides = [
  {
    title: 'Super Admin',
    bullets: [
      'Create and manage tenants.',
      'Turn modules on or off per tenant.',
      'Control user-level module access.',
      'Configure payment gateways, rates, services, and insurance by tenant.'
    ]
  },
  {
    title: 'Tenant Admin',
    bullets: [
      'Run the tenant day to day.',
      'Create users and narrow their module access.',
      'Maintain settings, locations, rates, fleet, and operations for that tenant.'
    ]
  },
  {
    title: 'Employee / Ops',
    bullets: [
      'Create reservations, work front desk, check vehicles out/in, and keep the day moving.',
      'Use Employee App, Reservations, Planner, and Loaner depending on the workflow.',
      'Escalate unusual cases into Issue Center when customer service or approval work is needed.'
    ]
  },
  {
    title: 'Customer Service',
    bullets: [
      'Use Issue Center for replies, disputes, vehicle approvals, and toll disputes.',
      'Track case history before changing status.',
      'Jump back into reservations or tolls when context is needed.'
    ]
  }
];

const faq = [
  {
    question: 'Where do I start if a customer is standing at the counter?',
    answer: 'Start in Employee App or Reservations. Search the reservation first. If it does not exist, create it there before moving into checkout, documents, or payments.'
  },
  {
    question: 'Where do I go for missing documents or customer follow-up?',
    answer: 'Use Customers for account context and Issue Center if the situation has already become a support case or dispute.'
  },
  {
    question: 'Where do tolls show up now?',
    answer: 'Use Tolls for AutoExpreso sync, review, dispute handling, and posting to reservation billing. Reservation detail pages also show the toll panel once charges are linked.'
  },
  {
    question: 'How do I know if a module is unavailable because of permissions?',
    answer: 'If the route opens but shows an access-controlled message, the tenant or user does not currently have that module enabled. A tenant admin or super admin needs to update module access.'
  }
];

export default function KnowledgeBasePage() {
  return (
    <AuthGate>
      {({ me, logout }) => (
        <AppShell me={me} logout={logout}>
          <div className="stack" style={{ gap: 18 }}>
            <section className="glass card-lg knowledge-hero">
              <div className="eyebrow">Employee Knowledge Base</div>
              <h1 className="page-title" style={{ margin: 0 }}>Ride Fleet help center for day-to-day operations.</h1>
              <p className="ui-muted" style={{ maxWidth: 860 }}>
                Use this page as the in-product reference for daily workflows, support questions, and where each team should work inside the platform.
              </p>
              <div className="knowledge-anchor-grid">
                {anchors.map((anchor) => (
                  <a key={anchor.id} className="knowledge-anchor" href={`#${anchor.id}`}>
                    <strong>{anchor.label}</strong>
                  </a>
                ))}
              </div>
            </section>

            <section id="start-here" className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Start Here</div>
                  <p className="ui-muted">If you are not sure where to work, follow this order first.</p>
                </div>
                <span className="status-chip neutral">Core Flow</span>
              </div>
              <ol className="knowledge-list">
                <li>Check <Link href="/dashboard">Dashboard</Link> for today’s operational pressure: pickups, returns, loaner blockers, fee advisories, and issue escalations.</li>
                <li>Move into <Link href="/reservations">Reservations</Link> for the actual customer workflow: booking, checkout, inspection, payment, and return.</li>
                <li>Use <Link href="/customers">Customers</Link>, <Link href="/vehicles">Vehicles</Link>, or <Link href="/planner">Planner</Link> when you need supporting context.</li>
                <li>Escalate support, disputes, host approvals, or toll disputes inside <Link href="/issues">Issue Center</Link>.</li>
              </ol>
            </section>

            <section id="front-desk" className="glass card-lg section-card">
              <div className="section-title">Front Desk & Operations</div>
              <div className="knowledge-grid">
                {dailyWorkflows.map((item) => (
                  <article key={item.title} className="surface-note stack">
                    <div className="row-between">
                      <strong>{item.title}</strong>
                      <Link href={item.route}><button type="button" className="button-subtle">Open</button></Link>
                    </div>
                    <p className="ui-muted">{item.summary}</p>
                    <ul className="knowledge-list">
                      {item.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            </section>

            <section id="support" className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Support & Issues</div>
                  <p className="ui-muted">Use this whenever the case is no longer a simple operational step.</p>
                </div>
                <Link href="/issues"><button type="button">Open Issue Center</button></Link>
              </div>
              <ul className="knowledge-list">
                <li>Open Issue Center for customer disputes, host approval replies, reservation follow-up, and toll disputes.</li>
                <li>If the issue belongs to a reservation, open the reservation workflow from the case so you can see payments, inspections, and notes in context.</li>
                <li>If a toll is disputed in <Link href="/tolls">Tolls</Link>, the system can now open or reuse the related Issue Center case automatically.</li>
              </ul>
            </section>

            <section id="loaner" className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Loaner Program</div>
                  <p className="ui-muted">This is the service-lane workflow for dealership tenants.</p>
                </div>
                <Link href="/loaner"><button type="button">Open Loaner Program</button></Link>
              </div>
              <ul className="knowledge-list">
                <li>Use queue focus filters to work Intake, Returns, Advisor, Billing, or Alerts.</li>
                <li>Use Loaner Shift and Service Lane boards to identify the next work to handle on mobile.</li>
                <li>If a loaner reservation needs a regular reservation workflow step, open the linked reservation and continue from there.</li>
              </ul>
            </section>

            <section id="car-sharing" className="glass card-lg section-card">
              <div className="section-title">Car Sharing & Host</div>
              <div className="knowledge-grid">
                <article className="surface-note stack">
                  <strong>Car Sharing Workspace</strong>
                  <p className="ui-muted">Use this for listings, instant book supply, trips, and host approval operations.</p>
                  <div className="inline-actions">
                    <Link href="/car-sharing"><button type="button">Open Car Sharing</button></Link>
                  </div>
                </article>
                <article className="surface-note stack">
                  <strong>Host App</strong>
                  <p className="ui-muted">Use this for listing edits, availability windows, host account context, handoff readiness, and fleet details.</p>
                  <div className="inline-actions">
                    <Link href="/host"><button type="button">Open Host App</button></Link>
                  </div>
                </article>
                <article className="surface-note stack">
                  <strong>Tolls</strong>
                  <p className="ui-muted">Puerto Rico toll sync, review queue, posting to reservations, and toll disputes now live here.</p>
                  <div className="inline-actions">
                    <Link href="/tolls"><button type="button">Open Tolls</button></Link>
                  </div>
                </article>
              </div>
            </section>

            <section id="admin" className="glass card-lg section-card">
              <div className="section-title">Admin & Settings</div>
              <div className="knowledge-grid">
                {roleGuides.map((role) => (
                  <article key={role.title} className="surface-note stack">
                    <strong>{role.title}</strong>
                    <ul className="knowledge-list">
                      {role.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
              <div className="inline-actions">
                <Link href="/settings"><button type="button">Open Settings</button></Link>
                <Link href="/tenants"><button type="button" className="button-subtle">Open Tenants</button></Link>
                <Link href="/people"><button type="button" className="button-subtle">Open People</button></Link>
              </div>
            </section>

            <section className="glass card-lg section-card">
              <div className="section-title">Common Questions</div>
              <div className="stack">
                {faq.map((item) => (
                  <article key={item.question} className="surface-note stack">
                    <strong>{item.question}</strong>
                    <div className="ui-muted">{item.answer}</div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </AppShell>
      )}
    </AuthGate>
  );
}
