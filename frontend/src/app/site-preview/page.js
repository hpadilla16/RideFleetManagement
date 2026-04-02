import Link from 'next/link';

const heroMetrics = [
  { label: 'Launch path', value: 'WordPress to API-first' },
  { label: 'Guest journeys', value: 'Rentals + car sharing' },
  { label: 'Ops source of truth', value: 'Ride Fleet backend' }
];

const lanes = [
  {
    href: '/site-preview/rent',
    title: 'Traditional Rentals',
    summary: 'Airport, neighborhood, and hotel style bookings with clear pricing, extras, payments, and customer portal follow-up.',
    cta: 'Design rental flow'
  },
  {
    href: '/site-preview/car-sharing',
    title: 'Car Sharing',
    summary: 'A separate public entry point for shorter bookings, marketplace-style browsing, and host-friendly vehicle presentation.',
    cta: 'Design car sharing flow'
  }
];

const phases = [
  'Stand up a public-facing shell that can live on a beta subdomain without touching the current WordPress production site.',
  'Connect rental search and checkout to Ride Fleet APIs while reusing the existing public booking and payment machinery.',
  'Build a distinct car sharing UX on top of the same backend so both products live under one branded website.'
];

export default function SitePreviewHomePage() {
  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="glass card-lg" style={{ padding: 32, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gap: 24, gridTemplateColumns: '1.3fr 0.9fr' }}>
          <div className="stack" style={{ gap: 18 }}>
            <span className="eyebrow">Public Website Plan</span>
            <h1 style={{ margin: 0, fontSize: 'clamp(2.2rem, 4vw, 4.25rem)', lineHeight: 1.02 }}>
              Build a guest website that feels premium on the front end and stays operationally grounded in Ride Fleet.
            </h1>
            <p className="ui-muted" style={{ fontSize: '1.05rem', maxWidth: 720 }}>
              This preview route is the staging ground for replacing the current WordPress booking experience at
              {' '}<strong>ride-carsharing.com</strong> with a faster API-connected site for rentals and car sharing.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Link href="/site-preview/rent" className="ios-action-btn" style={{ textDecoration: 'none' }}>
                Start Rental UX
              </Link>
              <Link href="/site-preview/car-sharing" className="ios-btn secondary" style={{ textDecoration: 'none' }}>
                Start Car Sharing UX
              </Link>
            </div>
          </div>

          <div className="glass card" style={{ padding: 22, alignSelf: 'stretch' }}>
            <div className="stack" style={{ gap: 12 }}>
              <div className="label">Why this route</div>
              {heroMetrics.map((metric) => (
                <div key={metric.label} style={{ padding: '12px 14px', borderRadius: 18, background: 'rgba(111, 86, 255, 0.08)' }}>
                  <div className="label">{metric.label}</div>
                  <div style={{ fontWeight: 800, marginTop: 2 }}>{metric.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
        {lanes.map((lane) => (
          <Link
            key={lane.href}
            href={lane.href}
            className="glass card"
            style={{ padding: 24, textDecoration: 'none', color: 'inherit', display: 'grid', gap: 12 }}
          >
            <span className="eyebrow">Guest Lane</span>
            <h2 style={{ margin: 0 }}>{lane.title}</h2>
            <p className="ui-muted" style={{ margin: 0 }}>{lane.summary}</p>
            <strong style={{ color: '#6e49ff' }}>{lane.cta}</strong>
          </Link>
        ))}
      </section>

      <section className="glass card-lg" style={{ padding: 28 }}>
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div className="stack" style={{ gap: 8, maxWidth: 700 }}>
            <span className="eyebrow">Execution Phases</span>
            <h2 style={{ margin: 0 }}>What we build next on this branch</h2>
            <p className="ui-muted" style={{ margin: 0 }}>
              The first goal is to create a polished public shell and then progressively connect real Ride Fleet booking flows.
            </p>
          </div>
        </div>
        <div className="stack" style={{ gap: 12, marginTop: 18 }}>
          {phases.map((phase, index) => (
            <div key={phase} className="glass card" style={{ padding: 18 }}>
              <div className="label">Phase {index + 1}</div>
              <div style={{ fontWeight: 700, marginTop: 4 }}>{phase}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
