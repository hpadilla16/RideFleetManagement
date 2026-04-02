import Link from 'next/link';

const blocks = [
  {
    title: 'Search and date selection',
    detail: 'Pickup and return locations, travel dates, promo code, and renter intent need to feel fast and trustworthy.'
  },
  {
    title: 'Inventory and pricing results',
    detail: 'Show vehicle types, real pricing, fees, insurance choices, and friction-free next steps into checkout.'
  },
  {
    title: 'Checkout handoff',
    detail: 'Use Ride Fleet APIs to create the reservation and hand the guest into the already-working payment and portal flows.'
  }
];

export default function RentPreviewPage() {
  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="glass card-lg" style={{ padding: 28 }}>
        <span className="eyebrow">Rental MVP</span>
        <h1 style={{ marginTop: 8, marginBottom: 8 }}>Traditional rental booking lane</h1>
        <p className="ui-muted" style={{ maxWidth: 760 }}>
          This lane will become the public experience for guests who want a normal reservation. The near-term goal is a stronger
          front-end shell that can route into the existing Ride Fleet booking flow while we replace the older WordPress UX.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 18 }}>
          <Link href="/book" className="ios-action-btn" style={{ textDecoration: 'none' }}>
            Open current booking flow
          </Link>
          <Link href="/site-preview" className="ios-btn secondary" style={{ textDecoration: 'none' }}>
            Back to preview home
          </Link>
        </div>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 18 }}>
        {blocks.map((block) => (
          <article key={block.title} className="glass card" style={{ padding: 22 }}>
            <div className="label">Build focus</div>
            <h3 style={{ marginTop: 8 }}>{block.title}</h3>
            <p className="ui-muted" style={{ marginBottom: 0 }}>{block.detail}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
