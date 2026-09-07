'use client';

/**
 * PriceSourcePanel — which price each writeback publishes, per sede (2026-09-07).
 *
 * Hector: "para cada integracion que nosotros apuntamos que precio queremos
 * empujar, para que la sede tenga control si quieren poner precios manual en el
 * sistema de Ride y empujarlos lo pueden hacer, o si quieren que market
 * intelligence lo haga de igual manera".
 *
 * ONE tab for every integration instead of the same control cloned into each
 * provider's panel: a sede's answer for Economy and for MEX is the same kind of
 * decision, and seeing them side by side is the point — that is where you
 * notice that LAX publishes its own numbers to one partner and MI's to another.
 *
 * Sibling of MexIntegrationPanel: same api client, same `scoped()` path helper,
 * same card/table styling, English-only (these panels are not wired to the
 * locale files).
 *
 * Backend contract (mounted at /api/admin/integrations/price-policy):
 *   GET  /   -> { providers[], sources[], rows: [{ locationId, locationName,
 *                 locationCode, provider, externalCode, integrationEnabled,
 *                 ratePushEnabled, priceSource, explicit, updatedAt,
 *                 marketIntelligenceAutoApplies }] }
 *   PUT  /   { locationId, provider, priceSource?, ratePushEnabled? }
 *            -> { ok, priceSource, ratePushEnabled, previous }
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/client';

const SOURCE_LABEL = {
  MANUAL: 'Manual (Ride)',
  MARKET: 'Market Intelligence',
};

const SOURCE_HELP = {
  MANUAL: 'The base rate plus only the per-date prices a person set in Rates. MI never reaches this portal.',
  MARKET: 'The base rate plus every per-date price, including the ones Market Intelligence applies automatically.',
};

function Pill({ tone = 'gray', children }) {
  const map = {
    green: { background: '#dcfce7', color: '#166534' },
    amber: { background: '#fef3c7', color: '#92400e' },
    gray: { background: '#e5e7eb', color: '#374151' },
  };
  const s = map[tone] || map.gray;
  return (
    <span style={{ ...s, padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
      {children}
    </span>
  );
}

export default function PriceSourcePanel({
  token,
  me,
  isSuper,
  isAdmin,
  scopedSettingsPath,
  onPageMsg,
}) {
  const canAccess = Boolean(isSuper || isAdmin || me);
  const scoped = useMemo(() => scopedSettingsPath || ((p) => p), [scopedSettingsPath]);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null);
  const [toast, setToast] = useState('');

  const flash = useCallback((m) => {
    setToast(m);
    if (onPageMsg) onPageMsg(m);
    setTimeout(() => setToast(''), 4000);
  }, [onPageMsg]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api(
        scoped('/api/admin/integrations/price-policy'),
        { bypassCache: true },
        token,
      ).catch(() => ({ rows: [] }));
      setRows(Array.isArray(res?.rows) ? res.rows : []);
    } finally {
      setLoading(false);
    }
  }, [scoped, token]);

  useEffect(() => { if (canAccess) reload(); }, [canAccess, reload]);

  const patch = async (row, body, describe) => {
    const key = `${row.locationId}:${row.provider}`;
    setSavingKey(key);
    try {
      const res = await api(
        scoped('/api/admin/integrations/price-policy'),
        {
          method: 'PUT',
          body: JSON.stringify({ locationId: row.locationId, provider: row.provider, ...body }),
        },
        token,
      );
      if (res?.ok) {
        setRows((all) => all.map((r) => (
          r.locationId === row.locationId && r.provider === row.provider
            ? { ...r, ...body, explicit: true, updatedAt: res.updatedAt || new Date().toISOString() }
            : r
        )));
        flash(`${row.provider} · ${row.locationName || row.locationCode}: ${describe}`);
      } else {
        flash('Could not save');
      }
    } catch (err) {
      flash(err?.message || 'Could not save');
    } finally {
      setSavingKey(null);
    }
  };

  const setSource = (row, priceSource) => patch(
    row, { priceSource }, `now publishing ${SOURCE_LABEL[priceSource]}`,
  );

  const setPush = (row, ratePushEnabled) => patch(
    row,
    { ratePushEnabled },
    ratePushEnabled ? 'rate push ON' : 'rate push OFF — reservations keep importing',
  );

  if (!canAccess) return null;

  // Grouped by sede rather than by provider: the question a person actually
  // asks is "what does LAX publish, and to whom".
  const bySede = new Map();
  for (const r of rows) {
    const key = r.locationId;
    if (!bySede.has(key)) bySede.set(key, { location: r, entries: [] });
    bySede.get(key).entries.push(r);
  }

  return (
    <section className="glass card section-card">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <h3 style={{ margin: 0 }}>Which price we publish</h3>
          <p className="ui-muted">
            Two decisions per sede, per integration: whether we push rates there at all, and whose
            numbers go out — the ones your team sets in Ride, or the ones Market Intelligence applies
            automatically. Turning the push off <strong>does not</strong> stop the integration:
            reservations keep importing exactly as before.
            A <strong>stop sale</strong> always wins over both sources — a class closed in Ride is
            closed on the portal whatever the price came from.
          </p>
        </div>
      </div>

      {toast ? <p className="ui-muted" style={{ marginTop: 4 }}>{toast}</p> : null}

      {loading ? (
        <p className="ui-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="ui-muted" style={{ padding: '8px 0' }}>
          No sede has a rate writeback configured yet. Set one up in the Economy or MEX tab and it will
          appear here.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #f0eaff' }}>
                <th style={{ padding: '8px 10px' }}>Sede</th>
                <th style={{ padding: '8px 10px' }}>Integration</th>
                <th style={{ padding: '8px 10px' }}>Portal code</th>
                <th style={{ padding: '8px 10px' }}>Push rates</th>
                <th style={{ padding: '8px 10px' }}>Publishes</th>
              </tr>
            </thead>
            <tbody>
              {[...bySede.values()].flatMap(({ location, entries }) => entries.map((row, i) => {
                const key = `${row.locationId}:${row.provider}`;
                const busy = savingKey === key;
                // MARKET where no profile auto-applies resolves to the base rate
                // anyway. Say so instead of letting somebody think they turned
                // something on.
                const marketIsInert = row.priceSource === 'MARKET' && !row.marketIntelligenceAutoApplies;
                return (
                  <tr key={key} style={{ borderBottom: '1px solid #f0eaff' }}>
                    <td style={{ padding: '8px 10px' }}>
                      {i === 0 ? (
                        <>
                          <strong>{location.locationName || location.locationCode}</strong>
                          {location.locationCode ? <> <code>{location.locationCode}</code></> : null}
                        </>
                      ) : null}
                    </td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{row.provider}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      <code>{row.externalCode || '—'}</code>
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <div style={{ display: 'grid', gap: 4 }}>
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: busy ? 'wait' : 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={row.ratePushEnabled}
                            disabled={busy}
                            onChange={(e) => setPush(row, e.target.checked)}
                          />
                          {row.ratePushEnabled
                            ? <Pill tone="green">Pushing</Pill>
                            : <Pill tone="gray">Paused</Pill>}
                        </label>
                        {!row.integrationEnabled ? (
                          <span className="ui-muted" style={{ fontSize: 12 }}>
                            This sede is not mapped for {row.provider} imports right now.
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <div style={{ display: 'grid', gap: 4, opacity: row.ratePushEnabled ? 1 : 0.55 }}>
                        <select
                          value={row.priceSource}
                          disabled={busy}
                          onChange={(e) => setSource(row, e.target.value)}
                          style={{ maxWidth: 220 }}
                        >
                          {Object.keys(SOURCE_LABEL).map((s) => (
                            <option key={s} value={s}>{SOURCE_LABEL[s]}</option>
                          ))}
                        </select>
                        <span className="ui-muted" style={{ fontSize: 12 }}>
                          {SOURCE_HELP[row.priceSource]}
                        </span>
                        {row.ratePushEnabled && marketIsInert ? (
                          <span style={{ fontSize: 12, color: '#92400e' }}>
                            No Market Intelligence profile auto-applies to this sede, so today this
                            publishes the same numbers as Manual.
                          </span>
                        ) : null}
                        {!row.ratePushEnabled ? (
                          <span className="ui-muted" style={{ fontSize: 12 }}>
                            Nothing is published while the push is paused — this is what it will send
                            when you switch it on.
                          </span>
                        ) : null}
                        {!row.explicit ? (
                          <span className="ui-muted" style={{ fontSize: 12 }}>Default — nobody has chosen yet.</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </div>
      )}

      <p className="ui-muted" style={{ marginTop: 12, fontSize: 12 }}>
        Changes take effect on the next rate push. Every change is recorded in the audit log with the old
        and the new value. A global transport setting can still hold everything back: if rate pushing is
        switched off for the whole platform, a sede set to Pushing here still writes nothing.
      </p>
    </section>
  );
}
