'use client';

/**
 * MarketTargetsPanel — where each brand's suggested prices are written
 * (2026-09-09).
 *
 * Hector: "los precios que son de MEX, escriban a MEX directamente y que los de
 * zezgo escriban al de zezgo cuando prendemos el rate writeback".
 *
 * The thing this screen has to make obvious is that ONE SCRAPE FEEDS MANY
 * BRANDS. A profile is a scrape — a real browser, credits, minutes — and the
 * market at an airport is the same for everyone selling there. So the profile
 * is the heading and the targets are rows under it, rather than each brand
 * looking like its own separate job.
 *
 * The second thing is the fallback. A profile with no rows still writes: to its
 * own targetRateId, under its own rule. That is every profile in production
 * today, and a screen showing an empty table would say the opposite. So the
 * backend reports what the engine would ACTUALLY do (`effective`) and this
 * renders that as a real row, marked inherited.
 *
 * Backend contract (mounted at /api/market-scraper):
 *   GET    /profiles                    -> [{ id, name, locationCode, ... }]
 *   GET    /profiles/:id/targets        -> { profile, effective[], targets[],
 *                                            franchises[], rates[], strategies[] }
 *   POST   /profiles/:id/targets        { franchiseId?, rateId, strategy?, ... }
 *   PATCH  /targets/:targetId
 *   DELETE /targets/:targetId
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/client';

const STRATEGY_LABEL = {
  CHEAPEST_MINUS_AMOUNT: 'Cheapest − amount',
  MATCH_CHEAPEST: 'Match cheapest',
  CHEAPEST_PLUS_PCT: 'Cheapest + %',
  STATIC_FLOOR: 'Hard floor',
};

function Pill({ tone = 'gray', children, title }) {
  const map = {
    green: { background: '#dcfce7', color: '#166534' },
    amber: { background: '#fef3c7', color: '#92400e' },
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

const EMPTY_DRAFT = {
  franchiseId: '', rateId: '', strategy: '', strategyAmount: '', strategyPct: '', strategyFloor: '', autoApply: false,
};

export default function MarketTargetsPanel({ token, me, isSuper, isAdmin, onPageMsg }) {
  const canAccess = Boolean(isSuper || isAdmin || me);

  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [error, setError] = useState('');

  const flash = useCallback((m) => { if (onPageMsg) onPageMsg(m); }, [onPageMsg]);

  const loadProfiles = useCallback(async () => {
    try {
      const res = await api('/api/market-scraper/profiles', { bypassCache: true }, token);
      const list = Array.isArray(res) ? res : (res?.profiles || []);
      setProfiles(list);
      if (list.length && !profileId) setProfileId(list[0].id);
    } catch (e) {
      setError(e?.message || 'Could not load profiles');
    }
  }, [token, profileId]);

  const loadTargets = useCallback(async (id) => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      setData(await api(`/api/market-scraper/profiles/${id}/targets`, { bypassCache: true }, token));
    } catch (e) {
      setError(e?.message || 'Could not load targets');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { if (canAccess) loadProfiles(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [canAccess]);
  useEffect(() => { if (profileId) loadTargets(profileId); }, [profileId, loadTargets]);

  const rateLabel = useCallback((rate) => {
    if (!rate) return '—';
    const loc = data?.locations?.find((l) => l.id === rate.locationId);
    return `${rate.rateCode}${rate.name ? ` · ${rate.name}` : ''}${loc ? ` · ${loc.code}` : ''}`;
  }, [data]);

  // A brand needs one row per RATE, not one in total — LAX keeps a separate
  // single-class rate per class, so Economy covering its seven classes has
  // seven rows here. What cannot repeat is the PAIR.
  const usedPairs = useMemo(
    () => new Set((data?.targets || []).map((t) => `${t.franchiseId ?? ''}|${t.rateId}`)),
    [data],
  );
  const takenRatesForDraft = useMemo(() => {
    const f = draft.franchiseId || '';
    return new Set((data?.targets || [])
      .filter((t) => (t.franchiseId ?? '') === f)
      .map((t) => t.rateId));
  }, [data, draft.franchiseId]);

  const mutate = async (fn, msg) => {
    setBusy(msg);
    setError('');
    try {
      await fn();
      await loadTargets(profileId);
      flash(msg);
    } catch (e) {
      setError(e?.message || 'That did not work');
    } finally {
      setBusy(null);
    }
  };

  const addTarget = () => mutate(async () => {
    if (!draft.rateId) throw new Error('Pick the rate this brand writes to');
    await api(`/api/market-scraper/profiles/${profileId}/targets`, {
      method: 'POST',
      body: JSON.stringify({
        franchiseId: draft.franchiseId || null,
        rateId: draft.rateId,
        strategy: draft.strategy || null,
        strategyAmount: draft.strategyAmount,
        strategyPct: draft.strategyPct,
        strategyFloor: draft.strategyFloor,
        autoApply: draft.autoApply,
      }),
    }, token);
    setDraft(EMPTY_DRAFT);
  }, 'Target added');

  const patchTarget = (t, body, msg) => mutate(
    () => api(`/api/market-scraper/targets/${t.id}`, { method: 'PATCH', body: JSON.stringify(body) }, token),
    msg,
  );

  const removeTarget = (t) => mutate(
    () => api(`/api/market-scraper/targets/${t.id}`, { method: 'DELETE' }, token),
    'Target removed',
  );

  if (!canAccess) return null;

  const profile = data?.profile;
  const inherited = (data?.effective || []).filter((e) => e.legacy);

  return (
    <section className="glass card section-card">
      <div className="stack" style={{ gap: 6 }}>
        <h3 style={{ margin: 0 }}>Where each brand&apos;s prices are written</h3>
        <div className="ui-muted">
          One scrape feeds every brand selling at that airport — the market is the same for all of
          them, so a profile is read once and its suggestions are written to each brand&apos;s own
          rate. A brand only needs a row here when it wants a different rate or a different place on
          the ladder. Pairs with <strong>Which price we publish</strong>, which decides what each
          integration reads back out.
        </div>
      </div>

      <div className="inline-actions" style={{ marginTop: 12, gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="stack" style={{ gap: 4 }}>
          <span className="ui-muted">Profile (one scrape)</span>
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)} style={{ minWidth: 260 }}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.locationCode} · {p.name}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => loadTargets(profileId)} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error ? <div style={{ marginTop: 12, color: '#991b1b' }}>{error}</div> : null}

      {profile ? (
        <div className="ui-muted" style={{ marginTop: 12, fontSize: 13 }}>
          Profile rule: <strong>{STRATEGY_LABEL[profile.strategy] || profile.strategy}</strong>
          {profile.strategyAmount != null ? ` ${profile.strategyAmount}` : ''}
          {' · '}
          {profile.targetRateId
            ? 'has its own target rate'
            : 'no target rate of its own — it can only write through the rows below'}
        </div>
      ) : null}

      {inherited.length ? (
        <div style={{
          marginTop: 12, padding: '10px 12px', borderRadius: 10,
          border: '1px solid rgba(0,0,0,0.08)', background: 'rgba(0,0,0,0.02)',
        }}
        >
          <Pill tone="blue">Inherited</Pill>
          <span style={{ marginLeft: 8 }}>
            With no rows configured this profile still writes to its own rate, under its own rule.
            Adding a row below replaces that.
          </span>
        </div>
      ) : null}

      <div style={{ overflowX: 'auto', marginTop: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid rgba(0,0,0,0.1)' }}>
              <th style={{ padding: '6px 8px' }}>Brand</th>
              <th style={{ padding: '6px 8px' }}>Writes to rate</th>
              <th style={{ padding: '6px 8px' }}>Rule</th>
              <th style={{ padding: '6px 8px' }}>Auto-apply</th>
              <th style={{ padding: '6px 8px' }}>Active</th>
              <th style={{ padding: '6px 8px' }} />
            </tr>
          </thead>
          <tbody>
            {(data?.targets || []).map((t) => (
              <tr key={t.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
                <td style={{ padding: '6px 8px' }}>
                  {t.franchise ? <strong>{t.franchise.name}</strong> : <Pill tone="gray" title="Everything not claimed by another brand">House</Pill>}
                </td>
                <td style={{ padding: '6px 8px' }}>
                  {rateLabel(t.rate)}
                  {t.rate?.franchiseId && t.franchiseId && t.rate.franchiseId !== t.franchiseId ? (
                    <div style={{ marginTop: 2 }}>
                      <Pill tone="amber" title="This rate belongs to a different brand, so the writeback for this brand will not read it back">
                        rate belongs to another brand
                      </Pill>
                    </div>
                  ) : null}
                </td>
                <td style={{ padding: '6px 8px' }}>
                  {t.strategy
                    ? `${STRATEGY_LABEL[t.strategy] || t.strategy}${t.strategyAmount != null ? ` ${t.strategyAmount}` : ''}`
                    : <span className="ui-muted">Same as the profile</span>}
                </td>
                <td style={{ padding: '6px 8px' }}>
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={Boolean(t.autoApply)}
                      disabled={Boolean(busy)}
                      onChange={(e) => patchTarget(t, { autoApply: e.target.checked },
                        e.target.checked ? 'Auto-apply on for this brand' : 'Auto-apply off for this brand')}
                    />
                    {t.autoApply ? <Pill tone="amber" title="This brand writes prices automatically">writes</Pill> : <span className="ui-muted">watched</span>}
                  </label>
                </td>
                <td style={{ padding: '6px 8px' }}>
                  <input
                    type="checkbox"
                    checked={Boolean(t.active)}
                    disabled={Boolean(busy)}
                    onChange={(e) => patchTarget(t, { active: e.target.checked }, e.target.checked ? 'Target active' : 'Target paused')}
                  />
                </td>
                <td style={{ padding: '6px 8px' }}>
                  <button type="button" className="button-subtle" disabled={Boolean(busy)} onClick={() => removeTarget(t)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {!(data?.targets || []).length ? (
              <tr>
                <td colSpan={6} className="ui-muted" style={{ padding: '10px 8px' }}>
                  No per-brand rows. This profile writes the inherited way described above.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* ---- add a row ---- */}
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(0,0,0,0.08)' }}>
        <h4 style={{ margin: '0 0 8px' }}>Add a brand</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          <label className="stack" style={{ gap: 4 }}>
            <span className="ui-muted">Brand</span>
            <select value={draft.franchiseId} onChange={(e) => setDraft({ ...draft, franchiseId: e.target.value })}>
              <option value="">House (everything unbranded)</option>
              {(data?.franchises || []).map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </label>
          <label className="stack" style={{ gap: 4 }}>
            <span className="ui-muted">Writes to rate</span>
            <select value={draft.rateId} onChange={(e) => setDraft({ ...draft, rateId: e.target.value })}>
              <option value="">Pick a rate…</option>
              {(data?.rates || []).map((r) => (
                <option key={r.id} value={r.id} disabled={takenRatesForDraft.has(r.id)}>
                  {rateLabel(r)}{takenRatesForDraft.has(r.id) ? ' — this brand already writes it' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="stack" style={{ gap: 4 }}>
            <span className="ui-muted">Rule</span>
            <select value={draft.strategy} onChange={(e) => setDraft({ ...draft, strategy: e.target.value })}>
              <option value="">Same as the profile</option>
              {(data?.strategies || []).map((s) => (
                <option key={s} value={s}>{STRATEGY_LABEL[s] || s}</option>
              ))}
            </select>
          </label>
          <label className="stack" style={{ gap: 4 }}>
            <span className="ui-muted">Amount</span>
            <input
              type="number" step="0.01" min="0" placeholder="blank = profile's"
              value={draft.strategyAmount}
              onChange={(e) => setDraft({ ...draft, strategyAmount: e.target.value })}
            />
          </label>
          <label className="stack" style={{ gap: 4 }}>
            <span className="ui-muted">Percent</span>
            <input
              type="number" step="0.01" min="0" placeholder="blank = profile's"
              value={draft.strategyPct}
              onChange={(e) => setDraft({ ...draft, strategyPct: e.target.value })}
            />
          </label>
          <label className="stack" style={{ gap: 4 }}>
            <span className="ui-muted">Floor</span>
            <input
              type="number" step="0.01" min="0" placeholder="blank = profile's"
              value={draft.strategyFloor}
              onChange={(e) => setDraft({ ...draft, strategyFloor: e.target.value })}
            />
          </label>
        </div>
        <div className="ui-muted" style={{ fontSize: 12, marginTop: 6 }}>
          Leave a number blank to inherit the profile&apos;s. Blank is not zero — an amount of 0 would
          turn &ldquo;cheapest minus a dollar&rdquo; into &ldquo;match the cheapest&rdquo;.
          {' '}A brand needs one row per rate: these sedes keep a separate rate per vehicle class, so a
          brand covering seven classes has seven rows.
        </div>
        <div className="inline-actions" style={{ marginTop: 10, gap: 10, alignItems: 'center' }}>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={draft.autoApply}
              onChange={(e) => setDraft({ ...draft, autoApply: e.target.checked })}
            />
            <span>Let this brand write prices automatically</span>
          </label>
          <button type="button" onClick={addTarget} disabled={Boolean(busy) || !draft.rateId}>
            {busy === 'Target added' ? 'Adding…' : 'Add brand'}
          </button>
        </div>
        <div className="ui-muted" style={{ fontSize: 12, marginTop: 8 }}>
          Nothing here writes on its own until the Market Intelligence master switch is on as well.
        </div>
      </div>
    </section>
  );
}
