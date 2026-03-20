'use client';

import { useEffect, useState } from 'react';

export const portalStyles = {
  page: {
    minHeight: '100vh',
    padding: '32px 18px 56px',
    background: 'radial-gradient(circle at top left, rgba(125,92,255,0.18), transparent 28%), radial-gradient(circle at top right, rgba(0,194,168,0.16), transparent 22%), linear-gradient(180deg, #f7f4ff 0%, #f2f7fb 100%)',
    color: '#201536'
  },
  shell: {
    maxWidth: 1120,
    margin: '0 auto',
    display: 'grid',
    gap: 18
  },
  hero: {
    background: 'linear-gradient(135deg, #22153f 0%, #5f38d8 58%, #38b7c6 100%)',
    color: '#fff',
    borderRadius: 28,
    padding: '26px 28px',
    boxShadow: '0 20px 60px rgba(66, 41, 150, 0.22)'
  },
  eyebrow: {
    fontSize: 12,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    opacity: 0.72,
    marginBottom: 8
  },
  heroTitle: {
    margin: 0,
    fontSize: 34,
    lineHeight: 1.05
  },
  heroSubtitle: {
    marginTop: 10,
    maxWidth: 760,
    fontSize: 15,
    lineHeight: 1.6,
    opacity: 0.92
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.25fr) minmax(320px, 0.75fr)',
    gap: 18,
    alignItems: 'start'
  },
  stack: {
    display: 'grid',
    gap: 16
  },
  card: {
    background: 'rgba(255,255,255,0.86)',
    border: '1px solid rgba(106, 76, 189, 0.14)',
    borderRadius: 24,
    padding: 18,
    boxShadow: '0 10px 34px rgba(65, 45, 133, 0.08)',
    backdropFilter: 'blur(14px)'
  },
  cardTitle: {
    margin: '0 0 12px',
    fontSize: 20
  },
  sectionTitle: {
    margin: '4px 0 8px',
    fontSize: 16
  },
  statGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: 12
  },
  statTile: {
    borderRadius: 18,
    padding: '14px 16px',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.82), rgba(245,239,255,0.78))',
    border: '1px solid rgba(112, 87, 189, 0.12)'
  },
  statLabel: {
    fontSize: 11,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: '#746294',
    marginBottom: 6
  },
  statValue: {
    fontSize: 18,
    fontWeight: 700
  },
  notice: {
    borderRadius: 16,
    padding: '12px 14px',
    fontSize: 14,
    lineHeight: 1.5
  },
  input: {
    width: '100%',
    borderRadius: 14,
    border: '1px solid rgba(102, 79, 177, 0.18)',
    padding: '12px 14px',
    background: 'rgba(255,255,255,0.92)',
    color: '#201536',
    outline: 'none'
  },
  textarea: {
    width: '100%',
    borderRadius: 16,
    border: '1px solid rgba(102, 79, 177, 0.18)',
    padding: '12px 14px',
    background: 'rgba(255,255,255,0.92)',
    color: '#201536',
    outline: 'none',
    minHeight: 120
  },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 46,
    padding: '0 18px',
    borderRadius: 14,
    border: 'none',
    background: 'linear-gradient(135deg, #6e49ff 0%, #8b63ff 100%)',
    color: '#fff',
    fontWeight: 700,
    cursor: 'pointer',
    boxShadow: '0 12px 24px rgba(110, 73, 255, 0.22)'
  },
  secondaryButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 42,
    padding: '0 14px',
    borderRadius: 12,
    border: '1px solid rgba(102, 79, 177, 0.16)',
    background: '#fff',
    color: '#372259',
    fontWeight: 600,
    textDecoration: 'none',
    cursor: 'pointer'
  },
  table: {
    width: '100%',
    minWidth: 0,
    borderCollapse: 'collapse'
  },
  tableCell: {
    padding: '10px 0',
    borderBottom: '1px solid rgba(105, 85, 171, 0.12)'
  }
};

export function PortalFrame({ eyebrow = 'Ride Fleet Portal', title, subtitle, aside, children }) {
  const [isCompact, setIsCompact] = useState(false);

  useEffect(() => {
    const update = () => setIsCompact(window.innerWidth < 980);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return (
    <main style={{
      ...portalStyles.page,
      padding: isCompact ? '18px 12px 40px' : portalStyles.page.padding
    }}>
      <div style={{ ...portalStyles.shell, gap: isCompact ? 14 : portalStyles.shell.gap }}>
        <section style={{
          ...portalStyles.hero,
          borderRadius: isCompact ? 22 : portalStyles.hero.borderRadius,
          padding: isCompact ? '22px 18px' : portalStyles.hero.padding
        }}>
          <div style={portalStyles.eyebrow}>{eyebrow}</div>
          <h1 style={{
            ...portalStyles.heroTitle,
            fontSize: isCompact ? 28 : portalStyles.heroTitle.fontSize,
            lineHeight: isCompact ? 1.04 : portalStyles.heroTitle.lineHeight
          }}>{title}</h1>
          {subtitle ? <div style={{ ...portalStyles.heroSubtitle, fontSize: isCompact ? 14 : portalStyles.heroSubtitle.fontSize }}>{subtitle}</div> : null}
        </section>

        <section style={{
          ...portalStyles.grid,
          gridTemplateColumns: isCompact ? 'minmax(0, 1fr)' : portalStyles.grid.gridTemplateColumns,
          gap: isCompact ? 14 : portalStyles.grid.gap
        }}>
          <div style={{ ...portalStyles.stack, order: 1 }}>{children}</div>
          <aside style={{ ...portalStyles.stack, order: isCompact ? 2 : 1 }}>{aside}</aside>
        </section>
      </div>
    </main>
  );
}
