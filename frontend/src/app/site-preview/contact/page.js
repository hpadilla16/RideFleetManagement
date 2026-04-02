const contactCards = [
  { label: 'Reservations', value: 'Use this lane for quote, booking, and trip support flows.' },
  { label: 'Car sharing guests', value: 'Dedicated support copy and policy links should live here.' },
  { label: 'Hosts and partners', value: 'This route should connect to the existing host onboarding path and CRM follow-up.' }
];

export default function ContactPreviewPage() {
  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="glass card-lg" style={{ padding: 28 }}>
        <span className="eyebrow">Contact and Support</span>
        <h1 style={{ marginTop: 8 }}>Support routing for the new public website</h1>
        <p className="ui-muted" style={{ maxWidth: 760 }}>
          The production site should separate guest support, host inquiries, and operational escalations without dumping everyone into
          the internal Ride Fleet UI.
        </p>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 18 }}>
        {contactCards.map((card) => (
          <article key={card.label} className="glass card" style={{ padding: 22 }}>
            <div className="label">{card.label}</div>
            <p style={{ marginTop: 10, marginBottom: 0, fontWeight: 700 }}>{card.value}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
