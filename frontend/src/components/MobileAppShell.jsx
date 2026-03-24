'use client';

function renderValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  return value;
}

export function MobileAppShell({ eyebrow, title, description, statusLabel, stats = [], tabs = [] }) {
  return (
    <section className="glass card-lg section-card mobile-app-shell">
      <div className="app-banner">
        <div className="row-between" style={{ alignItems: 'start', marginBottom: 0, gap: 12 }}>
          <div className="stack" style={{ gap: 6 }}>
            {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
            <h2 className="page-title" style={{ margin: 0 }}>{title}</h2>
            <p className="ui-muted">{description}</p>
          </div>
          {statusLabel ? <span className="status-chip neutral">{statusLabel}</span> : null}
        </div>

        {stats.length ? (
          <div className="app-card-grid compact">
            {stats.map((stat) => (
              <div key={stat.label} className="doc-card">
                <strong>{stat.label}</strong>
                <div className="doc-meta">{renderValue(stat.value)}</div>
              </div>
            ))}
          </div>
        ) : null}

        {tabs.length ? (
          <div className="mobile-app-shell-nav">
            {tabs.map((tab) => (
              <a
                key={`${tab.href}:${tab.label}`}
                href={tab.href}
                className={`mobile-app-shell-link ${tab.active ? 'active' : ''}`}
              >
                {tab.label}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
