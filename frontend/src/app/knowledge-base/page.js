'use client';

import Link from 'next/link';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';

const anchors = [
  { id: 'start-here', label: 'Start Here' },
  { id: 'front-desk', label: 'Front Desk' },
  { id: 'reservations', label: 'Reservations SOP' },
  { id: 'support', label: 'Support & Issues' },
  { id: 'loaner', label: 'Loaner Program' },
  { id: 'car-sharing', label: 'Car Sharing' },
  { id: 'tolls', label: 'Tolls' },
  { id: 'website', label: 'Website & WordPress' },
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

const reservationPlaybooks = [
  {
    title: 'Create or Find a Reservation',
    route: '/reservations',
    whenToUse: 'Use this when a customer is calling, standing at the counter, or when staff needs to verify an existing booking before any checkout work starts.',
    steps: [
      'Search by reservation number, customer name, phone, or email first.',
      'If the reservation does not exist, create it from Reservations or Employee App.',
      'Confirm pickup date, return date, vehicle type, pickup location, and customer information before moving forward.',
      'If the customer belongs to a dealership loaner flow, verify repair-order and advisor context too.'
    ],
    commonMistakes: [
      'Starting checkout before confirming customer identity and reservation details.',
      'Editing operational details without checking if there is already an Issue Center case tied to the reservation.',
      'Skipping location and vehicle assignment verification before handing off the vehicle.'
    ]
  },
  {
    title: 'Checkout, Inspection, and Payment',
    route: '/reservations',
    whenToUse: 'Use this once the customer is confirmed and the team is ready to release the vehicle.',
    steps: [
      'Open the reservation workflow and review the Reservation Ops Snapshot.',
      'Go through checkout, inspection, and payment in sequence.',
      'Confirm additional drivers, documents, and agreement status before vehicle release.',
      'If charges are still pending, keep the reservation in the workflow until the financial side is clean.'
    ],
    commonMistakes: [
      'Skipping the inspection photo flow.',
      'Collecting payment without reviewing due now versus estimated total.',
      'Leaving additional drivers or tolls unresolved before closeout.'
    ]
  },
  {
    title: 'Check-In and Closeout',
    route: '/reservations',
    whenToUse: 'Use this when the vehicle is returning and the team needs to capture condition, fees, and final charges.',
    steps: [
      'Open the reservation and use Check-In Snapshot to confirm the right unit and customer.',
      'Complete inspection compare and review any damage or fee advisories.',
      'Review tolls, balances, and open issues before final closeout.',
      'If something is disputed, escalate it into Issue Center instead of forcing closeout blindly.'
    ],
    commonMistakes: [
      'Closing the reservation before posted tolls or fees are reviewed.',
      'Ignoring check-in inspection compare when damage is being discussed.',
      'Failing to open an issue when the customer disputes a charge.'
    ]
  }
];

const issuePlaybooks = [
  {
    title: 'When to Use Issue Center',
    bullets: [
      'Use Issue Center when the case is no longer a normal reservation step and needs structured review.',
      'Examples: customer disputes, host vehicle approval replies, toll disputes, document follow-up, unresolved payment disagreements.',
      'The goal is to move communication out of random text/email and into a traceable workflow.'
    ]
  },
  {
    title: 'How to Work a Case',
    bullets: [
      'Open the case and review title, type, reservation or trip context, amount claimed, and history first.',
      'If more evidence is needed, request more information instead of changing status too early.',
      'If the case belongs to a reservation or toll, jump back into that workflow for context, then return to the case.',
      'Close or resolve only after the financial and operational impact is understood.'
    ]
  },
  {
    title: 'Toll Disputes',
    bullets: [
      'A disputed toll can now create or reuse an Issue Center case automatically.',
      'Use Open Issue Case from Tolls when staff needs support workflow around a specific toll transaction.',
      'As the issue changes status, the toll row now reflects that status back in the Tolls module.'
    ]
  }
];

const tollPlaybooks = [
  {
    title: 'What Tolls Does',
    bullets: [
      'Syncs AutoExpreso activity for Puerto Rico accounts.',
      'Matches transactions against the tenant fleet using plate, toll tag, toll sticker, and assigned reservation time window.',
      'Keeps a review queue for anything that still needs manual confirmation.'
    ]
  },
  {
    title: 'Daily Toll Workflow',
    bullets: [
      'Make sure the tenant has Tolls enabled and the AutoExpreso provider account is configured.',
      'Review Automatic AutoExpreso Sync status, last run, next run, and sweep stats.',
      'Confirm or reset suggested matches in the review queue.',
      'Post valid tolls to the reservation once the match is correct.',
      'If the toll is disputed, mark it disputed and move it into Issue Center.'
    ]
  },
  {
    title: 'Common Toll Troubleshooting',
    bullets: [
      'If a toll does not match, verify the vehicle plate, toll tag number, and toll sticker on the vehicle record first.',
      'If a tenant shows no tolls, verify that the tenant has Tolls enabled and the provider account is active.',
      'If sync fails, check health check and last sync status before assuming the data is missing.'
    ]
  }
];

const adminPlaybooks = [
  {
    title: 'Settings',
    route: '/settings',
    bullets: [
      'Use Settings to manage agreement text, locations, rates, fees, additional services, insurance plans, email templates, payment gateways, and tenant modules.',
      'Super admins should verify Settings Tenant Scope before making changes.',
      'If the website booking or shortcode pricing looks wrong, Rates, Vehicle Types, and Additional Services are the first places to review.'
    ]
  },
  {
    title: 'Tenants',
    route: '/tenants',
    bullets: [
      'Use Tenants to create tenants, manage slug, status, plan, and tenant-level module flags.',
      'Modules like Car Sharing, Loaner, and Tolls should be confirmed here before troubleshooting deeper.',
      'The tenant slug used for website shortcodes should come from this screen.'
    ]
  },
  {
    title: 'People & Access',
    route: '/people',
    bullets: [
      'Use People to manage logins, profile-only users, and module access at the user level.',
      'Tenant admins should only control the users they created.',
      'If a user says a module is missing, verify user-level module access here after checking tenant-level access.'
    ]
  }
];

const quickTroubleshooting = [
  {
    title: 'Pricing or availability looks wrong on website',
    answer: 'Check Settings > Rates, Vehicle Types, Additional Services, online display flags, and tenant slug used in the shortcode before touching WordPress content.'
  },
  {
    title: 'User cannot see a module',
    answer: 'Check tenant module enablement first, then user-level module access in People. If both are on, verify the user is logged into the correct tenant context.'
  },
  {
    title: 'A toll is not matching automatically',
    answer: 'Verify the assigned vehicle on the reservation, then check the vehicle plate, toll tag number, toll sticker number, and the reservation time window.'
  },
  {
    title: 'A customer is disputing charges at return',
    answer: 'Do not force closeout blindly. Review check-in inspection, payments, tolls, and if needed open or continue the case in Issue Center.'
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
    question: 'How do we place booking on the existing WordPress website?',
    answer: 'Use the Ride Fleet WordPress shortcodes. The booking shortcode embeds the public booking flow. The vehicle classes shortcode shows class cards with daily pricing and a Rent Now CTA.'
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

            <section id="reservations" className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Reservations SOP</div>
                  <p className="ui-muted">This is the core operating manual for front desk, counter, and closeout work.</p>
                </div>
                <Link href="/reservations"><button type="button">Open Reservations</button></Link>
              </div>
              <div className="knowledge-grid">
                {reservationPlaybooks.map((item) => (
                  <article key={item.title} className="surface-note stack">
                    <div className="row-between">
                      <strong>{item.title}</strong>
                      <Link href={item.route}><button type="button" className="button-subtle">Open</button></Link>
                    </div>
                    <p className="ui-muted">{item.whenToUse}</p>
                    <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>Recommended steps</div>
                    <ul className="knowledge-list">
                      {item.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ul>
                    <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>Common mistakes</div>
                    <ul className="knowledge-list">
                      {item.commonMistakes.map((mistake) => (
                        <li key={mistake}>{mistake}</li>
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
              <div className="knowledge-grid">
                {issuePlaybooks.map((item) => (
                  <article key={item.title} className="surface-note stack">
                    <strong>{item.title}</strong>
                    <ul className="knowledge-list">
                      {item.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
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
              <div className="surface-note" style={{ display: 'grid', gap: 10 }}>
                <strong>Best practice order for loaner teams</strong>
                <ul className="knowledge-list">
                  <li>Start with queue focus for the lane you are actively handling.</li>
                  <li>Review borrower packet progress before handoff.</li>
                  <li>Track advisor and billing context before closing anything out.</li>
                  <li>Use Reservation workflow if the loaner needs inspection, payment, or toll context.</li>
                </ul>
              </div>
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

            <section id="tolls" className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Tolls</div>
                  <p className="ui-muted">Puerto Rico AutoExpreso sync, reconciliation, and dispute handling now live in one workflow.</p>
                </div>
                <Link href="/tolls"><button type="button">Open Tolls</button></Link>
              </div>
              <div className="knowledge-grid">
                {tollPlaybooks.map((item) => (
                  <article key={item.title} className="surface-note stack">
                    <strong>{item.title}</strong>
                    <ul className="knowledge-list">
                      {item.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            </section>

            <section id="website" className="glass card-lg section-card">
              <div className="row-between">
                <div>
                  <div className="section-title">Website & WordPress Shortcodes</div>
                  <p className="ui-muted">
                    These are meant for the existing WordPress website. They do not replace the website. They let the team embed Ride Fleet booking and pricing surfaces inside pages that already exist.
                  </p>
                </div>
                <span className="status-chip neutral">Website Ops</span>
              </div>

              <div className="knowledge-grid">
                <article className="surface-note stack">
                  <strong>Booking Embed Shortcode</strong>
                  <p className="ui-muted">
                    Use this when the page should show the full public booking module inside WordPress so the customer can search availability and complete the reservation flow.
                  </p>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}><code>[ridefleet_booking tenant_slug="gokarrental" search_mode="RENTAL" height="1900"]</code></pre>
                  <ul className="knowledge-list">
                    <li>Use this on an existing Reserve page.</li>
                    <li>`tenant_slug` is optional if the site represents the whole marketplace.</li>
                    <li>`search_mode` can be `RENTAL` or `CAR_SHARING`.</li>
                  </ul>
                </article>

                <article className="surface-note stack">
                  <strong>Vehicle Classes Shortcode</strong>
                  <p className="ui-muted">
                    Use this when the page should show available vehicle classes, daily starting price, and a `Rent Now` call to action that opens the booking flow prefilled.
                  </p>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}><code>[ridefleet_vehicle_classes tenant_slug="gokarrental" limit="6" cta_label="Rent Now"]</code></pre>
                  <ul className="knowledge-list">
                    <li>Good for homepage sections, inventory teasers, or category landing pages.</li>
                    <li>It reads pricing from Ride Fleet, not from WordPress.</li>
                    <li>The button sends the customer into the booking process with the class already selected.</li>
                  </ul>
                </article>
              </div>

              <div className="surface-note" style={{ display: 'grid', gap: 10 }}>
                <strong>How the team should use this</strong>
                <ul className="knowledge-list">
                  <li>Do not rebuild booking logic in WordPress. WordPress should only host the content and the shortcode placement.</li>
                  <li>Use the tenant slug from <Link href="/tenants">Tenants</Link> when the website belongs to one specific operation.</li>
                  <li>If the page is for the broader marketplace, the shortcode can be used without `tenant_slug`.</li>
                  <li>If pricing or availability looks off, verify Rates, Vehicle Types, Locations, and online display settings inside Ride Fleet instead of editing WordPress.</li>
                </ul>
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
              <div className="knowledge-grid">
                {adminPlaybooks.map((item) => (
                  <article key={item.title} className="surface-note stack">
                    <div className="row-between">
                      <strong>{item.title}</strong>
                      <Link href={item.route}><button type="button" className="button-subtle">Open</button></Link>
                    </div>
                    <ul className="knowledge-list">
                      {item.bullets.map((bullet) => (
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

            <section className="glass card-lg section-card">
              <div className="section-title">Quick Troubleshooting</div>
              <div className="knowledge-grid">
                {quickTroubleshooting.map((item) => (
                  <article key={item.title} className="surface-note stack">
                    <strong>{item.title}</strong>
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
