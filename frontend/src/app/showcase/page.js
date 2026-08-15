'use client';

/**
 * The public showcase — a guided product tour for the marketing site.
 *
 * PUBLIC AND DISCONNECTED, on purpose. No AuthGate, no AppShell, and not one
 * call to the API. A page without a login must not be a door into the
 * product: anything that reads the database becomes public attack surface,
 * and one scoping mistake puts a real customer's name on a marketing page.
 * Every figure on screen comes from screens.js and is invented.
 *
 * The WORDS come from lib/training/curriculum.js — the same file the tour and
 * the training modules read. So the story the marketing site tells cannot
 * drift from the one the product teaches, which is the whole reason this page
 * lives in the app rather than being copied into the marketing repo.
 *
 * EMBEDDING: the marketing site (Next.js on Vercel) frames this route. It
 * sizes to its container and carries no chrome of its own.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { allModules } from '../../lib/training/curriculum.js';
import { SCREENS } from './screens.js';

const STEP_MS = 7000;

export default function ShowcasePage() {
  const chapters = useMemo(
    () => allModules()
      .filter((m) => Number.isFinite(m.showcase))
      .sort((a, b) => a.showcase - b.showcase),
    []
  );

  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const chapter = chapters[i];

  const go = useCallback((next) => {
    setI(((next % chapters.length) + chapters.length) % chapters.length);
  }, [chapters.length]);

  // Autoplay. Loops rather than ending: on a marketing page this is attract
  // mode, and a demo that stops on a dead final frame is worse than none.
  useEffect(() => {
    if (!playing) return undefined;
    if (typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return undefined;
    const t = setTimeout(() => go(i + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, i, go]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight') { setPlaying(false); go(i + 1); }
      if (e.key === 'ArrowLeft') { setPlaying(false); go(i - 1); }
      if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [i, go]);

  if (!chapter) return null;
  const step = chapter.steps?.[0] || {};

  return (
    <main style={S.page}>
      <div style={S.frame}>
        <section style={S.copy}>
          <p style={S.eyebrow}>Ride Fleet</p>
          <h1 style={S.title}>{chapter.title}</h1>
          <p style={S.body}>{step.body || chapter.summary}</p>

          <div style={S.controls}>
            <button type="button" onClick={() => { setPlaying(false); go(i - 1); }} style={S.btn} aria-label="Anterior">←</button>
            <button type="button" onClick={() => setPlaying((p) => !p)} style={S.btn}>
              {playing ? 'Pausa' : 'Reproducir'}
            </button>
            <button type="button" onClick={() => { setPlaying(false); go(i + 1); }} style={S.btn} aria-label="Siguiente">→</button>
          </div>

          <div style={S.dots} role="tablist" aria-label="Capítulos">
            {chapters.map((c, n) => (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={n === i}
                aria-label={c.title}
                onClick={() => { setPlaying(false); go(n); }}
                style={{ ...S.dot, ...(n === i ? S.dotOn : null) }}
              />
            ))}
          </div>
        </section>

        <section style={S.screenWrap} aria-hidden="true">
          <div style={S.chrome}>
            <span style={S.dotRed} /><span style={S.dotAmber} /><span style={S.dotGreen} />
          </div>
          <div key={chapter.key} style={S.screen}>
            <Screen spec={SCREENS[chapter.key]} />
          </div>
        </section>
      </div>

      <p style={S.disclaimer}>
        Datos de demostración. Ningún cliente, vehículo ni monto en esta página es real.
      </p>
    </main>
  );
}

function Screen({ spec }) {
  if (!spec) return null;

  if (spec.kind === 'dashboard') {
    return (
      <>
        <div style={S.tileRow}>
          {spec.tiles.map((t) => (
            <div key={t.label} style={S.tile}>
              <div style={S.tileLabel}>{t.label}</div>
              <div style={{ ...S.tileValue, color: tone(t.tone) }}>{t.value}</div>
            </div>
          ))}
        </div>
        <table style={S.table}><tbody>
          {spec.rows.map((r) => (
            <tr key={r.join()}>
              {r.map((cell, n) => (
                <td key={n} style={{ ...S.td, fontWeight: n === 2 ? 600 : 400 }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody></table>
      </>
    );
  }

  if (spec.kind === 'feed') {
    return (
      <>
        {spec.sources.map((s) => (
          <div key={s.name} style={S.feedRow}>
            <span style={{ fontWeight: 600 }}>{s.name}</span>
            <span style={S.grow} />
            <span style={S.muted}>{s.count} reservas</span>
            <span style={s.state === 'review' ? S.pillWarn : S.pillGood}>
              {s.state === 'review' ? 'en revisión' : 'emparejadas'}
            </span>
          </div>
        ))}
        <p style={S.caption}>{spec.caption}</p>
      </>
    );
  }

  if (spec.kind === 'wizard') {
    return (
      <>
        <div style={S.chips}>
          {spec.steps.map((label, n) => (
            <span key={label} style={{ ...S.chip, ...(n === spec.active ? S.chipOn : null) }}>{label}</span>
          ))}
        </div>
        <div style={S.quote}>
          {spec.quote.map(([k, v], n) => (
            <div key={k} style={{ ...S.quoteRow, fontWeight: n === spec.quote.length - 1 ? 700 : 400 }}>
              <span>{k}</span><span>{v}</span>
            </div>
          ))}
        </div>
      </>
    );
  }

  if (spec.kind === 'inspection') {
    return (
      <>
        <div style={S.angleGrid}>
          {spec.angles.map((a) => (
            <div key={a} style={S.angle}><span style={S.angleTick}>✓</span><span style={S.angleLabel}>{a}</span></div>
          ))}
        </div>
        <p style={S.caption}>{spec.caption}</p>
      </>
    );
  }

  if (spec.kind === 'fees') {
    return (
      <>
        <div style={S.quote}>
          {spec.lines.map(([k, v], n) => (
            <div key={k} style={{ ...S.quoteRow, fontWeight: n === spec.lines.length - 1 ? 700 : 400 }}>
              <span>{k}</span><span>{v}</span>
            </div>
          ))}
        </div>
        <p style={S.caption}>{spec.caption}</p>
      </>
    );
  }

  if (spec.kind === 'alert') {
    return (
      <div style={S.alertBox}>
        <div style={S.alertTitle}>{spec.title}</div>
        {spec.rows.map((r) => (
          <div key={r[0]} style={S.alertRow}>
            <span style={{ fontWeight: 600 }}>{r[0]}</span>
            <span style={S.muted}>{r[1]}</span>
            <span style={S.grow} />
            <span style={S.pillWarn}>{r[2]}</span>
          </div>
        ))}
      </div>
    );
  }

  if (spec.kind === 'market') {
    return (
      <>
        <div style={{ ...S.marketRow, ...S.marketHead }}>
          <span>Clase</span><span>Tu tarifa</span><span>Mercado</span><span />
        </div>
        {spec.rows.map((r) => (
          <div key={r[0]} style={S.marketRow}>
            <span style={{ fontWeight: 600 }}>{r[0]}</span>
            <span>{r[1]}</span>
            <span style={S.muted}>{r[2]}</span>
            <span style={r[3] === 'below' ? S.pillGood : S.pillWarn}>
              {r[3] === 'below' ? 'bajo mercado' : 'sobre mercado'}
            </span>
          </div>
        ))}
        <p style={S.caption}>{spec.caption}</p>
      </>
    );
  }

  return null;
}

const BRAND = '#8752FE';
const tone = (t) => (t === 'good' ? '#1f8a5f' : t === 'warn' ? '#b4342b' : '#1e1a2b');

const S = {
  page: { minHeight: '100vh', background: '#F5F3F9', color: '#1e1a2b', fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', padding: '3vh 4vw', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14 },
  frame: { display: 'grid', gridTemplateColumns: 'minmax(0, 5fr) minmax(0, 7fr)', gap: 'clamp(20px, 4vw, 48px)', alignItems: 'center', maxWidth: 1180, margin: '0 auto', width: '100%' },
  copy: { minWidth: 0 },
  eyebrow: { fontSize: 12, letterSpacing: '0.16em', textTransform: 'uppercase', color: BRAND, fontWeight: 700, margin: '0 0 10px' },
  title: { fontSize: 'clamp(1.7rem, 3.4vw, 2.6rem)', lineHeight: 1.1, letterSpacing: '-0.02em', margin: '0 0 12px', fontWeight: 700 },
  body: { fontSize: 'clamp(0.95rem, 1.3vw, 1.05rem)', lineHeight: 1.6, color: '#4a4258', margin: 0 },
  controls: { display: 'flex', gap: 8, marginTop: 22 },
  btn: { padding: '7px 14px', borderRadius: 9, border: '1px solid #ddd6ea', background: '#fff', color: '#4a4258', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  dots: { display: 'flex', gap: 6, marginTop: 18 },
  dot: { width: 26, height: 4, borderRadius: 2, border: 'none', background: '#ddd6ea', padding: 0, cursor: 'pointer' },
  dotOn: { background: BRAND },

  screenWrap: { background: '#fff', borderRadius: 14, border: '1px solid #ddd6ea', boxShadow: '0 18px 44px rgba(30,20,60,0.12)', overflow: 'hidden', minWidth: 0 },
  chrome: { display: 'flex', gap: 6, padding: '10px 14px', borderBottom: '1px solid #ede9f5', background: '#faf9fc' },
  dotRed: { width: 9, height: 9, borderRadius: '50%', background: '#e88b84' },
  dotAmber: { width: 9, height: 9, borderRadius: '50%', background: '#e8c98b' },
  dotGreen: { width: 9, height: 9, borderRadius: '50%', background: '#9ed3b4' },
  screen: { padding: 'clamp(14px, 2vw, 22px)', minHeight: 280, display: 'flex', flexDirection: 'column', gap: 12, animation: 'none' },

  tileRow: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 },
  tile: { background: '#f5f3f9', borderRadius: 9, padding: '10px 12px' },
  tileLabel: { fontSize: 11, color: '#7c7391', marginBottom: 3 },
  tileValue: { fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  td: { padding: '8px 6px', borderBottom: '1px solid #ede9f5', color: '#4a4258' },

  feedRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 9, border: '1px solid #ede9f5', fontSize: 13 },
  grow: { flex: 1 },
  muted: { color: '#7c7391', fontSize: 12.5 },
  caption: { fontSize: 12.5, color: '#7c7391', margin: '4px 0 0' },
  pillGood: { background: '#e3f3eb', color: '#1f8a5f', fontSize: 11, padding: '2px 9px', borderRadius: 6, fontWeight: 600 },
  pillWarn: { background: '#f8efe0', color: '#9a5b12', fontSize: 11, padding: '2px 9px', borderRadius: 6, fontWeight: 600 },

  chips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  chip: { fontSize: 12, padding: '5px 11px', borderRadius: 999, background: '#f5f3f9', color: '#7c7391', fontWeight: 600 },
  chipOn: { background: BRAND, color: '#fff' },
  quote: { border: '1px solid #ede9f5', borderRadius: 10, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 },
  quoteRow: { display: 'flex', justifyContent: 'space-between', fontSize: 13.5, fontVariantNumeric: 'tabular-nums' },

  angleGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 },
  angle: { background: '#f5f3f9', borderRadius: 9, padding: '14px 8px', textAlign: 'center' },
  angleTick: { display: 'block', color: '#1f8a5f', fontWeight: 700, fontSize: 15 },
  angleLabel: { fontSize: 11, color: '#7c7391' },

  alertBox: { border: '1px solid #e8b6b0', borderRadius: 10, padding: '12px 14px' },
  alertTitle: { color: '#b4342b', fontWeight: 700, fontSize: 14, marginBottom: 10 },
  alertRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid #f3e4e2', fontSize: 13 },

  marketRow: { display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr 1.2fr', gap: 8, alignItems: 'center', padding: '8px 4px', borderBottom: '1px solid #ede9f5', fontSize: 13, fontVariantNumeric: 'tabular-nums' },
  marketHead: { fontSize: 11, color: '#7c7391', textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid #ddd6ea' },

  disclaimer: { textAlign: 'center', fontSize: 11.5, color: '#7c7391', margin: 0 },
};
