const sampleCategories = [
  { name: 'Compact and economy', use: 'Airport arrivals, budget-sensitive guests, quick city travel.' },
  { name: 'SUV and family', use: 'Longer stays, luggage-heavy trips, Puerto Rico touring, group comfort.' },
  { name: 'Car sharing host vehicles', use: 'Neighborhood pickup, shorter trips, lifestyle-oriented listings.' }
];

export default function FleetPreviewPage() {
  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="glass card-lg" style={{ padding: 28 }}>
        <span className="eyebrow">Fleet Page Preview</span>
        <h1 style={{ marginTop: 8 }}>How the future public inventory should be merchandised</h1>
        <p className="ui-muted" style={{ maxWidth: 760 }}>
          This page will evolve into the public fleet catalog. For now it defines the buckets we want to surface before wiring them to
          live Ride Fleet inventory and pricing data.
        </p>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 18 }}>
        {sampleCategories.map((category) => (
          <article key={category.name} className="glass card" style={{ padding: 22 }}>
            <div className="label">Inventory group</div>
            <h3 style={{ marginTop: 8 }}>{category.name}</h3>
            <p className="ui-muted" style={{ marginBottom: 0 }}>{category.use}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
