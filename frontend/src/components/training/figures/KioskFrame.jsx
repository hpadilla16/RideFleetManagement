'use client';

/**
 * Ride University — the drawn kiosk.
 *
 * WHY DRAWINGS AND NOT SCREENSHOTS (Hector, 2026-09-04): the kiosk runs on a
 * paired iPad and the help console runs in Valet. Neither is a page the tour
 * can navigate to and spotlight, so what happens there has to be SHOWN inside
 * the tour card. A screenshot rots the first time the layout moves and weighs
 * hundreds of KB; a drawing built from the kiosk's own tokens and its own
 * translated strings (`t('kiosk.*')`) is a few hundred bytes and says exactly
 * what the real screen says, in the viewer's language.
 *
 * Every figure is a function of `t` only. No fetches, no state.
 */

import { useTranslation } from 'react-i18next';

// Kiosk tokens, copied from kiosk.css so a drawing looks like the real thing.
export const K = Object.freeze({
  purple: '#8752FE', violet: '#6d3df2', deep: '#4c1d95', ink: '#211a38', title: '#29223f',
  muted: '#6f668f', border: '#e6dfff', borderStrong: '#d7cbff', ground: '#fbfaff', surface: '#ffffff',
  soft: '#efe9fe', softLine: 'rgba(135,82,254,.28)', mint: '#e6f5ec', mintInk: '#065f46',
  warn: '#fff4e0', warnInk: '#9a5b12', bad: '#fdecea', badInk: '#b3261e', chip: '#f1eefa',
});

export const W = 640;
export const H = 320;

/** Clip a string so it never overruns the frame; SVG text does not wrap. */
export function clip(s, max) {
  const str = String(s || '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

/**
 * The tablet: a top step bar (Reservation · ID · Extras · Payment · Sign) with
 * the active step lit, and the corner Help button the guest always has.
 * Children draw the screen's content in the 640×320 space.
 */
export function KioskFrame({ step = 1, help = true, children, label }) {
  const { t } = useTranslation();
  const steps = [
    t('kiosk.stepReservation', 'Reservation'),
    t('kiosk.stepId', 'ID'),
    t('kiosk.stepExtras', 'Protection & extras'),
    t('kiosk.stepPayment', 'Payment'),
    t('kiosk.stepSign', 'Sign & keys'),
  ];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label || ''} data-testid="kiosk-figure" style={{ display: 'block', width: '100%', height: 'auto' }}>
      <rect width={W} height={H} rx="14" fill={K.ground} />
      <rect x="0" y="0" width={W} height="42" fill={K.surface} />
      {steps.map((name, i) => {
        const x = 20 + i * 122;
        const on = i + 1 <= step;
        return (
          <g key={name}>
            <rect x={x} y="15" width="100" height="10" rx="5" fill={on ? K.purple : K.borderStrong} />
            <text x={x} y="36" fontFamily="system-ui, sans-serif" fontSize="9" fill={on ? K.deep : K.muted}>{clip(name, 22)}</text>
          </g>
        );
      })}
      {help && (
        <g>
          <rect x={W - 92} y={H - 40} width="76" height="26" rx="13" fill={K.surface} stroke={K.purple} />
          <text x={W - 54} y={H - 23} textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="11" fontWeight="600" fill={K.deep}>🎧 {clip(t('kiosk.help', 'Help'), 8)}</text>
        </g>
      )}
      {children}
    </svg>
  );
}

/** A screen title + subtitle, the way every kiosk screen opens. */
export function Heading({ title, sub, y = 78 }) {
  return (
    <g>
      <text x="32" y={y} fontFamily="system-ui, sans-serif" fontSize="17" fontWeight="700" fill={K.title}>{clip(title, 52)}</text>
      {sub && <text x="32" y={y + 20} fontFamily="system-ui, sans-serif" fontSize="11.5" fill={K.muted}>{clip(sub, 92)}</text>}
    </g>
  );
}

/** A kiosk button. tone: 'primary' | 'secondary' | 'staff' | 'danger'. */
export function Btn({ x, y, w = 160, label, tone = 'primary', callout }) {
  const fill = tone === 'primary' ? K.purple : tone === 'staff' ? K.deep : tone === 'danger' ? K.bad : K.surface;
  const ink = tone === 'secondary' ? K.ink : tone === 'danger' ? K.badInk : '#fff';
  return (
    <g>
      <rect x={x} y={y} width={w} height="34" rx="9" fill={fill} stroke={tone === 'secondary' ? K.border : 'none'} />
      <text x={x + w / 2} y={y + 22} textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="12" fontWeight="600" fill={ink}>{clip(label, Math.floor(w / 6.4))}</text>
      {callout && <Callout n={callout} x={x + w + 4} y={y + 17} />}
    </g>
  );
}

/** Numbered marker matching the callouts listed under the figure. */
export function Callout({ n, x, y }) {
  return (
    <g>
      <circle cx={x} cy={y} r="11" fill={K.purple} />
      <text x={x} y={y + 4} textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="12" fontWeight="700" fill="#fff">{n}</text>
    </g>
  );
}

/** The guest-facing assist notice pill, violet (now) or green (done). */
export function NoticePill({ y = 58, text, tone = 'now', callout }) {
  const now = tone === 'now';
  return (
    <g>
      <rect x="120" y={y} width="400" height="34" rx="17" fill={now ? K.soft : K.mint} stroke={now ? K.softLine : 'rgba(16,185,129,.3)'} />
      <text x="320" y={y + 22} textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="12" fontWeight="600" fill={now ? K.deep : K.mintInk}>{clip(text, 64)}</text>
      {callout && <Callout n={callout} x={104} y={y + 17} />}
    </g>
  );
}

/** A soft card region. */
export function Card({ x = 32, y, w = W - 64, h, children }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="12" fill={K.surface} stroke={K.border} />
      {children}
    </g>
  );
}

/** Plain text line inside a figure. */
export function Line({ x, y, text, size = 12, color = K.ink, weight = 400, max = 80, anchor = 'start' }) {
  return <text x={x} y={y} textAnchor={anchor} fontFamily="system-ui, sans-serif" fontSize={size} fontWeight={weight} fill={color}>{clip(text, max)}</text>;
}
