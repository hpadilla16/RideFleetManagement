import Link from 'next/link';

const pillars = [
  'Separate discovery and storytelling from the internal ops dashboard so the guest experience feels marketplace-ready.',
  'Support shorter trips, different merchandising, and stronger emphasis on hosts, neighborhood pickup, and flexibility.',
  'Still use Ride Fleet APIs and reservation infrastructure so operations stay in one system of record.'
];

export default function CarSharingPreviewPage() {
  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="glass card-lg" style={{ padding: 28 }}>
        <span className="eyebrow">Car Sharing Lane</span>
        <h1 style={{ marginTop: 8, marginBottom: 8 }}>Dedicated entry point for car sharing guests</h1>
        <p className="ui-muted" style={{ maxWidth: 760 }}>
          The new public site should make car sharing feel like its own product, even though Ride Fleet keeps the operations, vehicle,
          pricing, payment, and customer records centralized behind the scenes.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 18 }}>
          <Link href="/car-sharing" className="ios-action-btn" style={{ textDecoration: 'none' }}>
            Open current car sharing flow
          </Link>
          <Link href="/site-preview" className="ios-btn secondary" style={{ textDecoration: 'none' }}>
            Back to preview home
          </Link>
        </div>
      </section>

      <section className="glass card-lg" style={{ padding: 24 }}>
        <div className="stack" style={{ gap: 14 }}>
          {pillars.map((pillar, index) => (
            <div key={pillar} className="glass card" style={{ padding: 18 }}>
              <div className="label">Pillar {index + 1}</div>
              <div style={{ fontWeight: 700, marginTop: 4 }}>{pillar}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
