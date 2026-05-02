'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from '../../lib/client';

/**
 * Action Board — public kiosk display.
 *
 * Mounted at /store-board?token=<kiosk-token>. Token is the auth (no JWT,
 * no AuthGate). Designed for a TV in the store: 1080p, sober dark theme,
 * legible from ~3m, polls every 30s, live clock, no chrome from the rest
 * of the app.
 *
 * The frontend sends its browser timezone + today's local date to the
 * backend so cross-timezone tenants render correctly without server-side
 * timezone guessing.
 */

const POLL_INTERVAL_MS = 30 * 1000;

const styles = {
  // Sober palette — no gradients, accents only on alertable states.
  bg: '#0a0a0d',
  bg2: '#101015',
  card: '#13131a',
  line: '#1f1f29',
  lineSoft: '#14141c',
  text: '#e8e8ee',
  text2: '#b0b0bc',
  text3: '#6a6a7a',
  text4: '#41414d',
  ok: '#2bcf7d',
  ready: '#1fc7aa',
  due: '#f5b833',
  late: '#ff5560',
  noShow: '#c4445a',
  info: '#6092ff',
  font: "Inter, -apple-system, 'Segoe UI', system-ui, Roboto, sans-serif",
  mono: "'JetBrains Mono', 'SF Mono', Menlo, monospace"
};

function getKioskTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Puerto_Rico';
  } catch {
    return 'America/Puerto_Rico';
  }
}

function localDateString(date, tz) {
  // Returns YYYY-MM-DD as the TV would see it.
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    return `${y}-${m}-${d}`;
  } catch {
    return new Date(date).toISOString().slice(0, 10);
  }
}

function fmtTimeOnly(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return '-';
  }
}

/**
 * Returns a human-readable relative-time string for a target ISO timestamp,
 * given a `now` Date. Examples:
 *   "in 18m"        — 18 minutes from now
 *   "in 3h 18m"     — 3h 18m from now
 *   "42m ago"       — 42 minutes ago
 *   "1h 42m ago"    — 1h 42m ago (used for done items + late "X ago" copy)
 */
function relTime(iso, now, lateLabel = false) {
  if (!iso) return '';
  const target = new Date(iso).getTime();
  const diffMin = Math.round((target - now.getTime()) / 60000);
  if (diffMin === 0) return 'now';
  const abs = Math.abs(diffMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const block = h > 0 ? `${h}h ${m}m` : `${m}m`;
  if (diffMin > 0) return `in ${block}`;
  return lateLabel ? `${block} late` : `${block} ago`;
}

export default function StoreBoardPage() {
  const [token, setToken] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => new Date());
  const fetchRef = useRef(null);

  // Read ?token=... from URL on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const t = (sp.get('token') || '').trim();
    setToken(t);
  }, []);

  // Live clock
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Polling
  useEffect(() => {
    if (!token) return undefined;

    const tz = getKioskTimezone();

    const fetchOnce = async () => {
      try {
        const date = localDateString(new Date(), tz);
        const url = `${API_BASE}/api/public/store-board/${encodeURIComponent(token)}?date=${encodeURIComponent(date)}&tz=${encodeURIComponent(tz)}`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) {
          let msg = `Board fetch failed (${res.status})`;
          try {
            const j = await res.json();
            if (j?.error) msg = j.error;
          } catch {}
          setError(msg);
          setLoading(false);
          return;
        }
        const j = await res.json();
        setData(j);
        setError('');
        setLoading(false);
      } catch (e) {
        setError(String(e?.message || e));
        setLoading(false);
      }
    };

    fetchOnce();
    fetchRef.current = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      if (fetchRef.current) clearInterval(fetchRef.current);
      fetchRef.current = null;
    };
  }, [token]);

  if (!token) {
    return (
      <CenterMessage
        title="No kiosk token"
        body="Open this page with a ?token=... URL provided by your admin."
      />
    );
  }

  if (loading && !data) {
    return <CenterMessage title="Loading board…" body="One moment." />;
  }

  if (error && !data) {
    return <CenterMessage title="Board unavailable" body={error} tone="alert" />;
  }

  return <BoardView data={data} now={now} error={error} />;
}

function CenterMessage({ title, body, tone }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: styles.bg,
        color: styles.text,
        fontFamily: styles.font,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        padding: 24,
        textAlign: 'center'
      }}
    >
      <div
        style={{
          fontSize: 36,
          fontWeight: 700,
          letterSpacing: '-0.01em',
          color: tone === 'alert' ? styles.late : styles.text,
          marginBottom: 12
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 18, color: styles.text2 }}>{body}</div>
    </div>
  );
}

function BoardView({ data, now, error }) {
  const tenantName = data?.tenant?.name || data?.tenant?.id || 'Ride Fleet';
  const locationName = data?.location?.name || 'Store';
  const locationCode = data?.location?.code ? `· ${data.location.code}` : '';
  const tomorrowAm = data?.tomorrowAmPickups || [];
  const todayPickups = data?.pickups || [];
  const returns = data?.returns || [];
  const summary = data?.summary || { pickups: {}, returns: {} };

  const clockTime = useMemo(
    () => now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
    [now]
  );
  const clockDate = useMemo(
    () => now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    [now]
  );

  return (
    <>
      <style>{boardCss}</style>
      <div className="frame">

        <header className="header">
          <div className="brand-block">
            <div className="logo">{initials(tenantName)}</div>
            <div>
              <div className="brand-name">{tenantName}</div>
              <div className="brand-sub">Action Board</div>
            </div>
          </div>
          <div></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <div className="location-tag">{locationName} {locationCode}</div>
            <div className="clock-block">
              <div className="clock-time mono">{clockTime}</div>
              <div className="clock-date">{clockDate}</div>
            </div>
          </div>
        </header>

        <div className="body">

          {/* PICKUPS column */}
          <div className="column">
            <div className="col-header">
              <div className="col-title">
                <div className="col-title-text">Pickups</div>
                <div className="col-count">
                  {todayPickups.length} hoy{tomorrowAm.length > 0 ? ` · ${tomorrowAm.length} mañana AM` : ''}
                </div>
              </div>
              <div className="col-summary">
                {summary.pickups?.confirmed > 0 && <SumChip n={summary.pickups.confirmed} label="Confirmed" />}
                {summary.pickups?.checkedOut > 0 && <SumChip n={summary.pickups.checkedOut} label="Out" />}
                {summary.pickups?.noShow > 0 && <SumChip n={summary.pickups.noShow} label="No-Show" alert />}
              </div>
            </div>
            <div className="col-body">
              {todayPickups.length === 0 && tomorrowAm.length === 0 ? (
                <EmptySection text="No pickups scheduled." />
              ) : null}

              {todayPickups.length > 0 && (
                <>
                  <div className="section-label">Hoy</div>
                  {todayPickups.map((it) => (
                    <BoardCard key={it.id} item={it} side="pickup" now={now} />
                  ))}
                </>
              )}

              {tomorrowAm.length > 0 && (
                <>
                  <div className="section-label">Mañana AM</div>
                  {tomorrowAm.map((it) => (
                    <BoardCard key={it.id} item={it} side="pickup" now={now} tomorrow />
                  ))}
                </>
              )}
            </div>
          </div>

          {/* RETURNS column */}
          <div className="column">
            <div className="col-header">
              <div className="col-title">
                <div className="col-title-text">Returns</div>
                <div className="col-count">{returns.length} hoy</div>
              </div>
              <div className="col-summary">
                {summary.returns?.returned > 0 && <SumChip n={summary.returns.returned} label="Returned" />}
                {summary.returns?.dueNow > 0 && <SumChip n={summary.returns.dueNow} label="Due Now" />}
                {summary.returns?.late > 0 && <SumChip n={summary.returns.late} label="Late" alert />}
              </div>
            </div>
            <div className="col-body">
              {returns.length === 0 ? <EmptySection text="No returns scheduled." /> : null}
              {returns.map((it) => (
                <BoardCard key={it.id} item={it} side="return" now={now} />
              ))}
            </div>
          </div>

        </div>

        <footer className="footer">
          <div className="footer-block">
            <div className="refresh-dot" />
            <span>Live · auto-refresh 30s · {error ? <span style={{ color: styles.late }}>{error}</span> : <>updated {fmtTimeOnly(data?.generatedAt)}</>}</span>
          </div>
          <div className="footer-block">
            <span>{tenantName} · Action Board</span>
          </div>
        </footer>
      </div>
    </>
  );
}

function BoardCard({ item, side, now, tomorrow }) {
  const isLate = item.boardStatus === 'Late' || item.boardStatus === 'No-Show';
  const isDone = item.boardStatus === 'Checked Out' || item.boardStatus === 'Returned';
  const time = side === 'pickup' ? item.pickupAt : item.returnAt;
  const className = `card${isLate ? ' alert' : ''}${isDone ? ' done' : ''}`;

  const relLabel = tomorrow
    ? 'tomorrow'
    : isLate && side === 'return'
      ? relTime(time, now, true)
      : isLate && side === 'pickup'
        ? `${relTime(time, now).replace('in ', '').replace(' ago', '')} late · no contact`
        : relTime(time, now);

  return (
    <div className={className}>
      <div>
        <div className="time mono">{fmtTimeOnly(time)}</div>
        <div className="time-rel" style={isLate ? { color: styles.late } : undefined}>{relLabel}</div>
      </div>
      <div className="who">
        <div className="customer-name">{item.customerName}</div>
        <div className="vehicle-line">
          {item.vehicle || '—'}
          {item.plate ? <span className="vehicle-plate">{item.plate}</span> : null}
        </div>
        <div className="meta-line">{item.reservationNumber}</div>
      </div>
      <div className="status-stack">
        <span className={`pill ${pillClass(item.boardStatus)}`}>{item.boardStatus}</span>
      </div>
    </div>
  );
}

function pillClass(s) {
  switch (s) {
    case 'Confirmed':   return 'confirmed';
    case 'Ready':       return 'ready';
    case 'In Progress': return 'in-progress';
    case 'Checked Out': return 'checked-out';
    case 'No-Show':     return 'no-show';
    case 'Cancelled':   return 'cancelled';
    case 'Scheduled':   return 'scheduled';
    case 'Due Now':     return 'due-now';
    case 'Late':        return 'late';
    case 'Returned':    return 'returned';
    default:            return 'confirmed';
  }
}

function SumChip({ n, label, alert }) {
  return (
    <span className={`summary-chip${alert ? ' alert' : ''}`}>
      <strong>{n}</strong>{label}
    </span>
  );
}

function EmptySection({ text }) {
  return (
    <div
      style={{
        padding: '40px 0',
        textAlign: 'center',
        color: styles.text3,
        fontSize: 14,
        textTransform: 'uppercase',
        letterSpacing: '0.1em'
      }}
    >
      {text}
    </div>
  );
}

function initials(s) {
  if (!s) return 'RF';
  const words = String(s).trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || 'RF';
}

// Inline CSS — kept here so the kiosk page renders identically to the
// design/mockups/action-board/store-board.html mockup. No global classes
// leaking out (we only render this page when on /store-board).
const boardCss = `
.frame { width: 100vw; height: 100vh; display: grid; grid-template-rows: 88px 1fr 36px; background: ${styles.bg}; color: ${styles.text}; font-family: ${styles.font}; overflow: hidden; }
.mono { font-family: ${styles.mono}; font-variant-numeric: tabular-nums; }

.header { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 24px; padding: 0 32px; background: ${styles.bg2}; border-bottom: 1px solid ${styles.line}; }
.brand-block { display: flex; align-items: center; gap: 18px; }
.logo { width: 52px; height: 52px; border: 1px solid ${styles.line}; border-radius: 10px; background: ${styles.card}; display: flex; align-items: center; justify-content: center; color: ${styles.text}; font-size: 18px; font-weight: 800; letter-spacing: -0.02em; }
.brand-name { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; color: ${styles.text}; }
.brand-sub { font-size: 13px; color: ${styles.text3}; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 2px; }
.location-tag { font-size: 14px; color: ${styles.text2}; background: ${styles.card}; border: 1px solid ${styles.line}; padding: 6px 14px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; white-space: nowrap; }
.clock-block { text-align: right; }
.clock-time { font-size: 36px; font-weight: 700; letter-spacing: -0.01em; color: ${styles.text}; }
.clock-date { font-size: 13px; color: ${styles.text3}; text-transform: uppercase; letter-spacing: 0.1em; margin-top: 2px; }

.body { display: grid; grid-template-columns: 60fr 40fr; gap: 0; overflow: hidden; }
.column { display: grid; grid-template-rows: auto 1fr; border-right: 1px solid ${styles.line}; overflow: hidden; }
.column:last-child { border-right: none; }
.col-header { display: flex; align-items: center; justify-content: space-between; padding: 18px 28px 16px; border-bottom: 1px solid ${styles.line}; background: ${styles.bg2}; }
.col-title { display: flex; align-items: baseline; gap: 14px; }
.col-title-text { font-size: 22px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; color: ${styles.text}; }
.col-count { font-size: 14px; color: ${styles.text3}; font-weight: 600; }
.col-summary { display: flex; gap: 10px; }
.summary-chip { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 5px 10px; border-radius: 6px; border: 1px solid ${styles.line}; color: ${styles.text2}; background: ${styles.card}; }
.summary-chip strong { color: ${styles.text}; font-weight: 700; margin-right: 4px; }
.summary-chip.alert { border-color: rgba(255, 85, 96, 0.5); color: ${styles.late}; background: rgba(255, 85, 96, 0.08); }

.col-body { overflow-y: auto; padding: 16px 24px 24px; }
.col-body::-webkit-scrollbar { width: 8px; }
.col-body::-webkit-scrollbar-thumb { background: ${styles.line}; border-radius: 4px; }

.section-label { font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: ${styles.text3}; padding: 14px 0 10px; border-top: 1px dashed ${styles.line}; margin-top: 14px; }
.section-label:first-child { border-top: none; padding-top: 4px; margin-top: 0; }

.card { display: grid; grid-template-columns: 110px 1fr auto; align-items: center; gap: 18px; padding: 14px 18px; margin-bottom: 8px; border-radius: 8px; background: ${styles.card}; border: 1px solid ${styles.line}; transition: background 200ms ease; }
.card.done { background: ${styles.lineSoft}; opacity: 0.55; }
.card.alert { border-color: ${styles.late}; background: rgba(255, 85, 96, 0.06); animation: pulse-border 1.6s ease-in-out infinite; }
@keyframes pulse-border {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 85, 96, 0); }
  50%      { box-shadow: 0 0 0 4px rgba(255, 85, 96, 0.18); }
}

.time { font-size: 30px; font-weight: 700; letter-spacing: 0.01em; color: ${styles.text}; }
.time-rel { font-size: 11px; color: ${styles.text3}; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.06em; }
.card.done .time { color: ${styles.text3}; text-decoration: line-through; }
.card.alert .time { color: ${styles.late}; }

.who { min-width: 0; }
.customer-name { font-size: 19px; font-weight: 700; color: ${styles.text}; letter-spacing: -0.005em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vehicle-line { font-size: 14px; color: ${styles.text2}; margin-top: 3px; font-weight: 500; }
.vehicle-plate { display: inline-block; font-family: ${styles.mono}; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; background: rgba(255, 255, 255, 0.04); border: 1px solid ${styles.line}; padding: 2px 6px; border-radius: 4px; margin-left: 6px; color: ${styles.text2}; }
.meta-line { font-size: 12px; color: ${styles.text3}; margin-top: 4px; letter-spacing: 0.02em; }

.status-stack { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.pill { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 5px 10px; border-radius: 999px; border: 1px solid; white-space: nowrap; }
.pill.confirmed   { color: ${styles.text2}; border-color: ${styles.line}; background: rgba(255,255,255,0.02); }
.pill.ready       { color: ${styles.ready};  border-color: rgba(31,199,170,.45);  background: rgba(31,199,170,.08); }
.pill.in-progress { color: ${styles.info};   border-color: rgba(96,146,255,.45);  background: rgba(96,146,255,.08); }
.pill.checked-out { color: ${styles.ok};     border-color: rgba(43,207,125,.45);  background: rgba(43,207,125,.08); }
.pill.no-show     { color: ${styles.noShow}; border-color: rgba(196,68,90,.5);    background: rgba(196,68,90,.10); }
.pill.cancelled   { color: ${styles.text4};  border-color: ${styles.line}; }
.pill.scheduled   { color: ${styles.text2};  border-color: ${styles.line}; background: rgba(255,255,255,0.02); }
.pill.due-now     { color: ${styles.due};    border-color: rgba(245,184,51,.5);   background: rgba(245,184,51,.10); }
.pill.late        { color: ${styles.late};   border-color: rgba(255,85,96,.6);    background: rgba(255,85,96,.12); }
.pill.returned    { color: ${styles.ok};     border-color: rgba(43,207,125,.45);  background: rgba(43,207,125,.08); }

.footer { display: flex; align-items: center; justify-content: space-between; padding: 0 32px; background: ${styles.bg2}; border-top: 1px solid ${styles.line}; font-size: 11px; color: ${styles.text3}; text-transform: uppercase; letter-spacing: 0.1em; }
.footer-block { display: flex; align-items: center; gap: 14px; }
.refresh-dot { width: 8px; height: 8px; border-radius: 50%; background: ${styles.ok}; box-shadow: 0 0 8px rgba(43, 207, 125, 0.6); animation: refresh-pulse 2s ease-in-out infinite; }
@keyframes refresh-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}
`;
