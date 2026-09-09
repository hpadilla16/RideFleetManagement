'use client';

/**
 * PriceSelfCheckPanel — are we publishing what the strategy said? (2026-09-09)
 *
 * Hector: "quiero un mostrador que ensena estos correciones cuando sucedan".
 *
 * TWO AXES, NOT ONE. He asked for the case where somebody slips under us. The
 * LAX data says the live problem is the opposite: we sit far BELOW our own
 * target and give margin away. A panel that only showed "who beat us" would
 * have shown LAX as healthy every day, so both are first-class here and a cell
 * can fail both at once.
 *
 * THIN LADDERS ARE LABELLED, NEVER HIDDEN. A $77 gap measured against a single
 * premium listing is arithmetically right and operationally nonsense — LAX is
 * bimodal and we compete in the independent tier. Those cells are shown, and
 * kept out of the headline money, so nobody reads "raise this to $92" off a
 * sample of one.
 *
 * READ-ONLY. This reports; it never writes a price. Correcting from a snapshot
 * of a moving market is a separate, gated decision.
 *
 * Backend contract:
 *   GET /api/market-scraper/self-check?locationCode=&days=
 *     -> { locationCode, days, profile, mixedStrategy, ourBrands, summary,
 *          cells[], brands{} }
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/client';

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const signed = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${Number(n).toFixed(2)}`);

function Pill({ tone = 'gray', children, title }) {
  const map = {
    green: { background: '#dcfce7', color: '#166534' },
    amber: { background: '#fef3c7', color: '#92400e' },
    red: { background: '#fee2e2', color: '#991b1b' },
    blue: { background: '#dbeafe', color: '#1e40af' },
    gray: { background: '#e5e7eb', color: '#374151' },
  };
  const s = map[tone] || map.gray;
  return (
    <span title={title} style={{ ...s, padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

function Stat({ label, value, tone = 'gray', hint }) {
  const color = { red: '#991b1b', amber: '#92400e', green: '#166534', gray: '#111827' }[tone] || '#111827';
  return (
    <div style={{ padding: '10px 14px', border: '1px solid rgba(0,0,0,0.08)', borderRadius: 10, minWidth: 150 }}>
      <div className="ui-muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {hint ? <div className="ui-muted" style={{ fontSize: 11, marginTop: 2 }}>{hint}</div> : null}
    </div>
  );
}

const FILTERS = [
  { key: 'ACTION', label: 'Needs attention' },
  { key: 'BELOW', label: 'Leaving money' },
  { key: 'ABOVE', label: 'Priced over' },
  { key: 'UNDERCUT', label: 'Undercut' },
  { key: 'UNSEEN', label: 'Not listed' },
  { key: 'ALL', label: 'Everything' },
];

export default function PriceSelfCheckPanel({ token, me, isSuper, isAdmin, onPageMsg }) {
  const canAccess = Boolean(isSuper || isAdmin || me);

  const [locationCode, setLocationCode] = useState('LAX');
  const [days, setDays] = useState(3);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('ACTION');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!locationCode.trim()) return;
    setLoading(true);
    setError('');
    try {
      const qs = `locationCode=${encodeURIComponent(locationCode.trim())}&days=${Number(days) || 3}`;
      const res = await api(`/api/market-scraper/self-check?${qs}`, { bypassCache: true }, token);
      setData(res);
      if (res?.note && onPageMsg) onPageMsg(res.note);
    } catch (e) {
      setError(e?.message || 'Could not run the check');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [locationCode, days, token, onPageMsg]);

  useEffect(() => { if (canAccess) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [canAccess]);

  const s = data?.summary;

  const shown = useMemo(() => {
    const cells = Array.isArray(data?.cells) ? data.cells : [];
    const pick = {
      BELOW: (c) => c.targetAxis === 'BELOW_TARGET',
      ABOVE: (c) => c.targetAxis === 'ABOVE_TARGET',
      UNDERCUT: (c) => c.ladderAxis === 'UNDERCUT',
      UNSEEN: (c) => !c.ourPriceSeen,
      ACTION: (c) => (c.ourPriceSeen && !c.thinLadder
        && (c.targetAxis === 'BELOW_TARGET' || c.targetAxis === 'ABOVE_TARGET' || c.ladderAxis === 'UNDERCUT')),
      ALL: () => true,
    }[filter] || (() => true);
    // Costliest first — twelve cells a nickel off matter less than one class
    // twenty dollars under across a fortnight.
    return cells.filter(pick).sort((a, b) => {
      const am = Math.abs(Number(a.deltaVsTarget) || 0);
      const bm = Math.abs(Number(b.deltaVsTarget) || 0);
      return bm - am;
    });
  }, [data, filter]);

  if (!canAccess) return null;

  return (
    <section className="glass card section-card">
      <div className="stack" style={{ gap: 6 }}>
        <h3 style={{ margin: 0 }}>Are we publishing what the strategy said?</h3>
        <div className="ui-muted">
          Compares our OWN listings in the last scrapes against the target the profile&apos;s rule
          produces, on two axes: are we <strong>off our target</strong> (leaving money, or priced out
          of the sale), and is <strong>somebody under us</strong>. Read-only — it reports, it never
          writes a price.
        </div>
      </div>

      <div className="inline-actions" style={{ marginTop: 12, gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="stack" style={{ gap: 4 }}>
          <span className="ui-muted">Location code</span>
          <input
            value={locationCode}
            onChange={(e) => setLocationCode(e.target.value.toUpperCase())}
            placeholder="LAX"
            style={{ width: 120 }}
          />
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="ui-muted">Days of scrapes</span>
          <input type="number" min="1" max="30" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 90 }} />
        </label>
        <button type="button" onClick={load} disabled={loading}>
          {loading ? 'Checking…' : 'Run check'}
        </button>
      </div>

      {error ? <div style={{ marginTop: 12, color: '#991b1b' }}>{error}</div> : null}

      {data?.note ? (
        <div className="ui-muted" style={{ marginTop: 12 }}>{data.note}</div>
      ) : null}

      {s && data?.cells?.length ? (
        <>
          <div className="ui-muted" style={{ marginTop: 14, fontSize: 13 }}>
            Rule: <strong>{data.profile?.strategy}</strong>
            {data.profile?.amount != null ? ` ${data.profile.amount}` : ''} · profile “{data.profile?.name}”
            {data.mixedStrategy ? ' · ⚠ this sede has profiles with different rules' : ''}
            {data.ourBrands?.length ? ` · our brands: ${data.ourBrands.join(', ')}` : ''}
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <Stat
              label="Left on the table"
              value={money(s.dollarsLeftPerDay)}
              tone={s.dollarsLeftPerDay > 0 ? 'red' : 'green'}
              hint="per day, ladders deep enough to trust"
            />
            <Stat
              label="Priced over"
              value={money(s.dollarsOverPerDay)}
              tone={s.dollarsOverPerDay > 0 ? 'amber' : 'green'}
              hint="per day, losing the sale"
            />
            <Stat label="Undercut" value={s.undercut} tone={s.undercut ? 'amber' : 'green'} hint="a rival is below us" />
            <Stat label="Not listed" value={s.unseen} tone={s.unseen ? 'amber' : 'green'} hint={`of ${s.cells} cells`} />
            <Stat label="On target" value={s.onTarget} tone="green" hint={`${s.seen} listed`} />
            <Stat
              label="Thin ladders"
              value={s.thin}
              tone="gray"
              hint={`${money(s.dollarsLeftPerDayThin)} not counted above`}
            />
          </div>

          {s.thin > 0 ? (
            <div className="ui-muted" style={{ marginTop: 10, fontSize: 12 }}>
              A “thin ladder” is a cell where fewer than 3 competitors listed that class. The rule still
              computes a target there, but against too few suppliers to act on — at LAX those are mostly
              classes where only a premium brand listed, and matching them would move us out of the
              independent tier we actually compete in.
            </div>
          ) : null}

          <div className="inline-actions" style={{ marginTop: 14, gap: 6, flexWrap: 'wrap' }}>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={filter === f.key ? '' : 'button-subtle'}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div style={{ overflowX: 'auto', marginTop: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid rgba(0,0,0,0.1)' }}>
                  <th style={{ padding: '6px 8px' }}>Pickup</th>
                  <th style={{ padding: '6px 8px' }}>Class</th>
                  <th style={{ padding: '6px 8px' }}>Ours</th>
                  <th style={{ padding: '6px 8px' }}>Target</th>
                  <th style={{ padding: '6px 8px' }}>Gap</th>
                  <th style={{ padding: '6px 8px' }}>Cheapest rival</th>
                  <th style={{ padding: '6px 8px' }}>Ladder</th>
                  <th style={{ padding: '6px 8px' }}>What</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 200).map((c) => {
                  const flags = [];
                  if (!c.ourPriceSeen) flags.push(<Pill key="u" tone="amber" title="Our brands did not appear for this class and date">Not listed</Pill>);
                  if (c.targetAxis === 'BELOW_TARGET') flags.push(<Pill key="b" tone="red" title="We are cheaper than our own rule intended">Leaving money</Pill>);
                  if (c.targetAxis === 'ABOVE_TARGET') flags.push(<Pill key="a" tone="amber" title="We are dearer than our own rule intended">Priced over</Pill>);
                  if (c.ladderAxis === 'UNDERCUT') flags.push(<Pill key="c" tone="amber" title="A competitor is below us">Undercut</Pill>);
                  if (c.targetAxis === 'ON_TARGET' && c.ladderAxis === 'CHEAPEST') flags.push(<Pill key="o" tone="green">On target</Pill>);
                  if (c.thinLadder) flags.push(<Pill key="t" tone="gray" title="Fewer than 3 competitors listed this class — too few to act on">Thin</Pill>);
                  const brands = Object.entries(c.byBrand || {});
                  return (
                    <tr key={`${c.date}|${c.sipp}`} style={{ borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
                      <td style={{ padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}>{c.date}</td>
                      <td style={{ padding: '6px 8px', fontWeight: 600 }}>{c.sipp}</td>
                      <td style={{ padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}>
                        {money(c.ours)}
                        {brands.length > 1 ? (
                          <div className="ui-muted" style={{ fontSize: 11 }}>
                            {brands.map(([n, p]) => `${n} ${money(p)}`).join(' · ')}
                          </div>
                        ) : null}
                      </td>
                      <td style={{ padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}>{money(c.target)}</td>
                      <td style={{
                        padding: '6px 8px',
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: 600,
                        color: c.deltaVsTarget == null ? '#6b7280' : (c.deltaVsTarget < 0 ? '#991b1b' : '#92400e'),
                      }}
                      >
                        {signed(c.deltaVsTarget)}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        {c.rivalName ? `${c.rivalName} ${money(c.rival)}` : '—'}
                      </td>
                      <td style={{ padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}>
                        {c.rivalCount == null ? '—' : `${c.rivalCount} supplier${c.rivalCount === 1 ? '' : 's'}`}
                      </td>
                      <td style={{ padding: '6px 8px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>{flags}</td>
                    </tr>
                  );
                })}
                {!shown.length ? (
                  <tr><td colSpan={8} className="ui-muted" style={{ padding: '10px 8px' }}>Nothing in this view.</td></tr>
                ) : null}
              </tbody>
            </table>
            {shown.length > 200 ? (
              <div className="ui-muted" style={{ fontSize: 12, marginTop: 6 }}>
                Showing the 200 costliest of {shown.length}.
              </div>
            ) : null}
          </div>

          {Object.keys(data.brands || {}).length ? (
            <div style={{ marginTop: 16 }}>
              <h4 style={{ margin: '0 0 6px' }}>By brand</h4>
              <div className="ui-muted" style={{ fontSize: 12, marginBottom: 6 }}>
                Average gap against the target. Negative means that brand is priced under the rule.
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {Object.entries(data.brands).map(([name, b]) => (
                  <Stat
                    key={name}
                    label={name}
                    value={`${signed(b.avgGap)}`}
                    tone={b.avgGap < -1 ? 'red' : (b.avgGap > 1 ? 'amber' : 'green')}
                    hint={`${b.cells} cells, per day`}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {!loading && data && !data.cells?.length && !data.note ? (
        <div className="ui-muted" style={{ marginTop: 12 }}>
          No scrape data in this window for {data.locationCode}.
        </div>
      ) : null}
    </section>
  );
}
