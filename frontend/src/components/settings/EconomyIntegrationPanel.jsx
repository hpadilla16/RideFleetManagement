'use client';

/**
 * EconomyIntegrationPanel — Settings tab for the Economy (RezLight) franchise
 * reservation sync (Fase 5). Sibling of TLIntegrationPanel; same components,
 * styling, and API-client pattern, matching economy-panel-mockup.html.
 *
 * English-only UI. SUPER_ADMIN + ADMIN gated by the parent settings page (ADMIN
 * is hard-scoped to their own tenant by the backend's resolveTenantId).
 *
 * Backend contract (mounted at /api/admin/integrations/economy):
 *   GET   /status                         -> { configured, masterEnabled, integrationEnabled,
 *                                              credential, locations[], lastRun, nextRunAt }
 *   PUT   /enabled       { enabled }       -> { ok, masterEnabled }
 *   POST  /credentials   { username, password } -> { ok, credentialId, rotatedAt }  (pw never returned)
 *   POST  /test-auth                       -> { ok, status }
 *   POST  /run-now                         -> { ok, jobId }
 *   GET   /runs?limit=                     -> { runs: [...] }
 *   GET   /locations                       -> { rows: [{ id, externalArea, locationId, enabled,
 *                                              lookbackDays, lookaheadDays, location }] }
 *   POST  /locations     { externalArea, locationId, enabled?, lookbackDays?, lookaheadDays? }
 *   PUT   /locations/:id { locationId?, enabled?, lookbackDays?, lookaheadDays? }
 *   POST  /locations/:id/toggle { enabled }
 *   DELETE /locations/:id
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/client';

function relativeTime(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return new Date(iso).toLocaleString();
  const abs = Math.abs(ms);
  const sec = Math.floor(abs / 1000);
  const suffix = ms < 0 ? 'from now' : 'ago';
  if (sec < 60) return `${sec}s ${suffix}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${suffix}`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${suffix}`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ${suffix}`;
  return new Date(iso).toLocaleDateString();
}

function fmtTimestamp(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function fmtMoney(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '-';
  return `$${num.toFixed(2)}`;
}

// Green/red pill matching the mockup + TL StatusBadge inline styles.
function Pill({ tone = 'gray', children }) {
  const map = {
    green: { background: '#dcfce7', color: '#166534' },
    red: { background: '#fee2e2', color: '#991b1b' },
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

function statusTone(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'OK' || s === 'SUCCESS' || s === 'CONNECTED') return 'green';
  if (s === 'ERROR' || s === 'EXPIRED' || s === 'FAILED') return 'red';
  if (s === 'PARTIAL') return 'amber';
  return 'gray';
}

export function EconomyIntegrationPanel({ token, me, isSuper, isAdmin, activeSettingsTenantId, scopedSettingsPath, onPageMsg }) {
  const [status, setStatus] = useState(null);
  const [runs, setRuns] = useState([]);
  const [locations, setLocations] = useState([]);   // config rows
  const [rideLocations, setRideLocations] = useState([]); // tenant Ride locations for dropdowns
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [runNowBusy, setRunNowBusy] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toast, setToast] = useState('');

  // New-area form.
  const [newArea, setNewArea] = useState('');
  const [newLocationId, setNewLocationId] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  const canAccess = isAdmin ?? (isSuper || String(me?.role || '').toUpperCase() === 'ADMIN');

  const scoped = useMemo(
    () => scopedSettingsPath || ((p) => p),
    [scopedSettingsPath]
  );

  if (!canAccess) {
    return (
      <div style={{ padding: 16, background: '#fef3c7', borderRadius: 8 }}>
        <strong>Admin access required.</strong> This panel is restricted to ADMIN and SUPER_ADMIN users.
      </div>
    );
  }

  const reload = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [s, r, l, rl] = await Promise.all([
        api(scoped('/api/admin/integrations/economy/status'), { bypassCache: true }, token).catch(() => null),
        api(scoped('/api/admin/integrations/economy/runs?limit=7'), { bypassCache: true }, token).catch(() => ({ runs: [] })),
        api(scoped('/api/admin/integrations/economy/locations'), { bypassCache: true }, token).catch(() => ({ rows: [] })),
        api(scoped('/api/locations'), {}, token).catch(() => []),
      ]);
      setStatus(s || null);
      setRuns(Array.isArray(r?.runs) ? r.runs : []);
      setLocations(Array.isArray(l?.rows) ? l.rows : []);
      setRideLocations(Array.isArray(rl) ? rl : (rl?.rows || []));
    } catch (e) {
      setLoadError(e?.message || 'Could not load status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, activeSettingsTenantId]);

  const flashToast = (text) => {
    setToast(text);
    if (onPageMsg) onPageMsg(text);
    setTimeout(() => setToast(''), 4000);
  };

  // ---- Master enable -------------------------------------------------------
  const handleToggleMaster = async () => {
    const next = !status?.masterEnabled;
    setToggleBusy(true);
    try {
      const res = await api(
        scoped('/api/admin/integrations/economy/enabled'),
        { method: 'PUT', body: JSON.stringify({ enabled: next }) },
        token
      );
      if (res?.ok) {
        flashToast(next ? 'Integration enabled' : 'Integration disabled');
        setStatus((s) => ({ ...(s || {}), masterEnabled: res.masterEnabled }));
      }
    } catch (err) {
      flashToast(err?.message || 'Could not update');
    } finally {
      setToggleBusy(false);
    }
  };

  // ---- Credentials ---------------------------------------------------------
  const handleSaveCreds = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    if (!username.trim() || !password) {
      flashToast('Enter username and password before saving');
      return;
    }
    setSaving(true);
    try {
      const res = await api(
        scoped('/api/admin/integrations/economy/credentials'),
        { method: 'POST', body: JSON.stringify({ username: username.trim(), password }) },
        token
      );
      if (res?.ok) {
        flashToast('Credentials saved (encrypted)');
        setPassword('');
        await reload();
      } else {
        flashToast('Could not save credentials');
      }
    } catch (err) {
      flashToast(err?.message || 'Could not save credentials');
    } finally {
      setSaving(false);
    }
  };

  const handleTestAuth = async () => {
    setTesting(true);
    try {
      const res = await api(
        scoped('/api/admin/integrations/economy/test-auth'),
        { method: 'POST' },
        token
      );
      flashToast(res?.ok ? 'Connection OK' : `Connection failed (${res?.status || 'ERROR'})`);
      await reload();
    } catch (err) {
      flashToast(err?.message || 'Could not test connection');
    } finally {
      setTesting(false);
    }
  };

  const handleRunNow = async () => {
    setRunNowBusy(true);
    try {
      const res = await api(
        scoped('/api/admin/integrations/economy/run-now'),
        { method: 'POST' },
        token
      );
      flashToast(res?.ok ? `Sync queued (job ${res.jobId})` : 'Could not queue');
      await reload();
    } catch (err) {
      flashToast(err?.message || 'Could not queue sync');
    } finally {
      setRunNowBusy(false);
    }
  };

  // ---- Area config CRUD ----------------------------------------------------
  const handleAddArea = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    const area = String(newArea || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(area)) { flashToast('Area must be a 3-letter code (e.g. MIA)'); return; }
    if (!newLocationId) { flashToast('Pick a Ride location'); return; }
    setAddBusy(true);
    try {
      const res = await api(
        scoped('/api/admin/integrations/economy/locations'),
        { method: 'POST', body: JSON.stringify({ externalArea: area, locationId: newLocationId, enabled: true }) },
        token
      );
      if (res?.ok) {
        flashToast(`Area ${area} added`);
        setNewArea('');
        setNewLocationId('');
        await reload();
      } else {
        flashToast(res?.error || 'Could not add area');
      }
    } catch (err) {
      flashToast(err?.message || 'Could not add area');
    } finally {
      setAddBusy(false);
    }
  };

  const patchArea = async (id, body) => {
    try {
      const res = await api(
        scoped(`/api/admin/integrations/economy/locations/${id}`),
        { method: 'PUT', body: JSON.stringify(body) },
        token
      );
      if (res?.ok) { await reload(); }
      else flashToast(res?.error || 'Could not update area');
    } catch (err) {
      flashToast(err?.message || 'Could not update area');
    }
  };

  const toggleArea = async (row) => {
    try {
      const res = await api(
        scoped(`/api/admin/integrations/economy/locations/${row.id}/toggle`),
        { method: 'POST', body: JSON.stringify({ enabled: !row.enabled }) },
        token
      );
      if (res?.ok) await reload();
    } catch (err) {
      flashToast(err?.message || 'Could not toggle area');
    }
  };

  const removeArea = async (row) => {
    if (typeof window !== 'undefined' && !window.confirm(`Remove area ${row.externalArea}?`)) return;
    try {
      const res = await api(
        scoped(`/api/admin/integrations/economy/locations/${row.id}`),
        { method: 'DELETE' },
        token
      );
      if (res?.ok) await reload();
    } catch (err) {
      flashToast(err?.message || 'Could not remove area');
    }
  };

  const configured = !!status?.configured;
  const masterEnabled = !!status?.masterEnabled;
  const lastTestStatus = status?.credential?.lastTestStatus || null;
  const connected = configured && String(lastTestStatus || '').toUpperCase() === 'OK';
  const activeAreas = locations.filter((l) => l.enabled);
  const lastRun = status?.lastRun || null;

  // Platform default import window (env-configured on the backend). Each location
  // row's effectiveWindow already applies the env fallback when its own override
  // is null, so a row whose override IS null reflects the true platform default.
  // Prefer such a row; otherwise fall back to any row's effectiveWindow.
  const platformDefault = (() => {
    const nullRow = locations.find(
      (l) => l.effectiveWindow && l.lookbackDays == null && l.lookaheadDays == null
    );
    const anyRow = locations.find((l) => l.effectiveWindow);
    const w = (nullRow || anyRow)?.effectiveWindow;
    return w && Number.isFinite(w.lookbackDays) && Number.isFinite(w.lookaheadDays)
      ? { lookbackDays: w.lookbackDays, lookaheadDays: w.lookaheadDays }
      : null;
  })();

  return (
    <div className="stack" style={{ gap: 20 }}>
      {toast ? (
        <div style={{ padding: 10, background: '#ecfdf5', border: '1px solid #10b981', borderRadius: 6, color: '#065f46' }}>{toast}</div>
      ) : null}
      {loadError ? (
        <div style={{ padding: 10, background: '#fee2e2', border: '1px solid #ef4444', borderRadius: 6, color: '#991b1b' }}>{loadError}</div>
      ) : null}

      {/* ============ 1. HEADER ============ */}
      <section className="glass card section-card">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <div className="eyebrow" style={{ color: '#6d3df2', fontWeight: 800, fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' }}>
              Booking source integration
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0 }}>Economy (RezLight)</h2>
              <Pill tone={connected ? 'green' : 'gray'}>{connected ? 'Connected' : (configured ? 'Untested' : 'Not configured')}</Pill>
            </div>
            <p className="ui-muted">Imports reservations from Economy Rent A Car (RezLight portal) into Ride. Runs autonomously once configured.</p>
          </div>
          <div style={{ display: 'grid', gap: 8, justifyItems: 'end' }}>
            <span className="label">Integration enabled</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                role="switch"
                aria-checked={masterEnabled}
                aria-label="Integration enabled (master switch for this tenant)"
                className="switch"
                disabled={toggleBusy || loading}
                onClick={handleToggleMaster}
                title="Master switch for this tenant"
              />
              <span className="ui-muted" style={{ fontSize: 13, minWidth: 58 }}>
                {toggleBusy ? '…' : (masterEnabled ? 'Enabled' : 'Disabled')}
              </span>
            </div>
            <span className="ui-muted" style={{ fontSize: 12 }}>Master switch for this tenant</span>
          </div>
        </div>

        <div className="app-card-grid" style={{ marginTop: 8 }}>
          <div className="info-tile">
            <span className="label">Connection</span>
            <strong><Pill tone={connected ? 'green' : 'gray'}>{connected ? 'Connected' : 'Untested'}</Pill></strong>
          </div>
          <div className="info-tile">
            <span className="label">Areas active</span>
            <strong>{activeAreas.length} of {locations.length}</strong>
            <span className="ui-muted" style={{ fontSize: 12 }}>{activeAreas.map((a) => a.externalArea).join(', ') || '-'}</span>
          </div>
          <div className="info-tile">
            <span className="label">Last sync</span>
            <strong>{relativeTime(lastRun?.finishedAt || lastRun?.startedAt)}</strong>
            <span className="ui-muted" style={{ fontSize: 12 }}>{fmtTimestamp(lastRun?.finishedAt || lastRun?.startedAt)}</span>
          </div>
          <div className="info-tile">
            <span className="label">Pending review</span>
            <strong>{lastRun?.needsReview ?? 0}</strong>
            <span className="ui-muted" style={{ fontSize: 12 }}>awaiting promotion</span>
          </div>
        </div>
        {!status?.integrationEnabled ? (
          <div className="ui-muted" style={{ fontSize: 12 }}>
            The autonomous scheduler is currently <strong>off</strong> platform-wide (ECONOMY_INTEGRATION_ENABLED). You can configure everything now; scheduled runs start when it is enabled. Use <strong>Run sync now</strong> to sync on demand.
          </div>
        ) : null}
      </section>

      {/* ============ 2. CREDENTIALS ============ */}
      <section className="glass card section-card">
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Credentials</h3>
          <Pill tone={statusTone(lastTestStatus)}>{lastTestStatus ? (connected ? 'Verified' : lastTestStatus) : 'Untested'}</Pill>
        </div>
        <p className="ui-muted">
          One Economy account covers every area you enable below (MIA, LAX…). Credentials are stored <strong>encrypted (AES-256-GCM)</strong> and never shown again after saving.
        </p>

        <form onSubmit={handleSaveCreds} className="stack" style={{ gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 14 }}>
            <label className="stack" style={{ gap: 6 }}>
              <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Username</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="economy.miami@corpusa.example"
                autoComplete="off"
              />
            </label>
            <label className="stack" style={{ gap: 6 }}>
              <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={configured ? '•••••••••••• (unchanged)' : 'Enter password'}
                autoComplete="new-password"
              />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" disabled={testing || loading || !configured} onClick={handleTestAuth}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button type="submit" className="subtle" disabled={saving}>
              {saving ? 'Saving…' : 'Save credentials'}
            </button>
            <span className="ui-muted" style={{ fontSize: 13 }}>
              {status?.credential?.lastTestedAt
                ? <>Last tested <strong>{relativeTime(status.credential.lastTestedAt)}</strong> · <Pill tone={statusTone(lastTestStatus)}>{lastTestStatus || 'Untested'}</Pill></>
                : 'Not tested yet'}
            </span>
          </div>
        </form>
        <div className="surface-note" style={{ padding: '12px 14px', borderRadius: 14, background: 'linear-gradient(180deg, rgba(135,82,254,.08), rgba(31,199,170,.06))', border: '1px solid rgba(135,82,254,.12)', color: '#433b63', lineHeight: 1.6, fontSize: 13 }}>
          🔒 Encrypted at rest with AES-256-GCM. Because Economy has no CloudFlare and no hourly-expiring cookie, the panel re-logs in on its own — you rarely need to touch this again.
        </div>
      </section>

      {/* ============ 3. WHICH RESERVATIONS TO WATCH ============ */}
      <section className="glass card section-card">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <h3 style={{ margin: 0 }}>Which reservations to watch</h3>
            <p className="ui-muted">
              Map each external <strong>area</strong> (first 3 letters of the pickup code, e.g. <code>MIAO01 → MIA</code>) to a Ride location. Only enabled areas are imported.
            </p>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #f0eaff' }}>
                <th style={{ padding: '8px 10px' }}>External area</th>
                <th></th>
                <th style={{ padding: '8px 10px' }}>Ride location</th>
                <th style={{ padding: '8px 10px' }}>Import window (days)</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Import</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {locations.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 12, color: '#6b7280' }}>No areas configured yet. Add one below.</td></tr>
              ) : locations.map((row) => (
                <tr key={row.id} style={{ borderBottom: '1px solid #f0eaff', opacity: row.enabled ? 1 : 0.6 }}>
                  <td style={{ padding: '8px 10px' }}><code>{row.externalArea}</code></td>
                  <td className="ui-muted">→</td>
                  <td style={{ padding: '8px 10px' }}>
                    <select
                      value={row.locationId}
                      onChange={(e) => patchArea(row.id, { locationId: e.target.value })}
                      style={{ maxWidth: 220 }}
                    >
                      {rideLocations.map((l) => (
                        <option key={l.id} value={l.id}>{l.name || l.code} {l.code ? `(${l.code})` : ''}</option>
                      ))}
                      {/* Preserve the current value if it's not in the loaded list. */}
                      {!rideLocations.some((l) => l.id === row.locationId) && row.location ? (
                        <option value={row.locationId}>{row.location.name || row.location.code}</option>
                      ) : null}
                    </select>
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="number" min={0}
                        defaultValue={row.lookbackDays ?? ''}
                        placeholder={row.effectiveWindow?.lookbackDays != null ? String(row.effectiveWindow.lookbackDays) : 'default'}
                        title="Lookback days (blank = platform default)"
                        onBlur={(e) => {
                          const v = e.target.value === '' ? null : Number(e.target.value);
                          if ((row.lookbackDays ?? null) !== v) patchArea(row.id, { lookbackDays: v });
                        }}
                        style={{ width: 74 }}
                      />
                      <span className="ui-muted" style={{ fontSize: 12 }}>back /</span>
                      <input
                        type="number" min={0}
                        defaultValue={row.lookaheadDays ?? ''}
                        placeholder={row.effectiveWindow?.lookaheadDays != null ? String(row.effectiveWindow.lookaheadDays) : 'default'}
                        title="Lookahead days (blank = platform default)"
                        onBlur={(e) => {
                          const v = e.target.value === '' ? null : Number(e.target.value);
                          if ((row.lookaheadDays ?? null) !== v) patchArea(row.id, { lookaheadDays: v });
                        }}
                        style={{ width: 74 }}
                      />
                      <span className="ui-muted" style={{ fontSize: 12 }}>ahead</span>
                    </div>
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      {row.enabled && !row.locationId ? (
                        <Pill tone="amber">No location</Pill>
                      ) : null}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={!!row.enabled}
                        aria-label={`Import ${row.externalArea} reservations`}
                        className="switch"
                        onClick={() => toggleArea(row)}
                        title={row.enabled ? 'Importing — click to pause' : 'Paused — click to import'}
                      />
                    </div>
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    <button type="button" className="ghost" style={{ color: '#991b1b' }} onClick={() => removeArea(row)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Add area */}
        <form onSubmit={handleAddArea} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label className="stack" style={{ gap: 6 }}>
            <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Area (3 letters)</span>
            <input
              type="text" maxLength={3} value={newArea}
              onChange={(e) => setNewArea(e.target.value.toUpperCase())}
              placeholder="MIA" style={{ width: 100, textTransform: 'uppercase' }}
            />
          </label>
          <label className="stack" style={{ gap: 6 }}>
            <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Ride location</span>
            <select value={newLocationId} onChange={(e) => setNewLocationId(e.target.value)} style={{ minWidth: 200 }}>
              <option value="">Select…</option>
              {rideLocations.map((l) => (
                <option key={l.id} value={l.id}>{l.name || l.code} {l.code ? `(${l.code})` : ''}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="subtle" disabled={addBusy}>{addBusy ? 'Adding…' : '+ Add area'}</button>
        </form>
        <div className="ui-muted" style={{ fontSize: 12 }}>
          Import window blank = the platform default{platformDefault
            ? ` (${platformDefault.lookbackDays} back / ${platformDefault.lookaheadDays} ahead)`
            : ''}. Disabled areas are ignored even if Economy returns them.
        </div>
      </section>

      {/* ============ 4. SYNC STATUS ============ */}
      <section className="glass card section-card">
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Sync status</h3>
          <button type="button" disabled={runNowBusy || loading} onClick={handleRunNow}>
            {runNowBusy ? 'Queuing…' : 'Run sync now'}
          </button>
        </div>

        <div className="app-card-grid">
          <div className="info-tile">
            <span className="label">Last run</span>
            <strong>{relativeTime(lastRun?.finishedAt || lastRun?.startedAt)}</strong>
            <span className="ui-muted" style={{ fontSize: 12 }}>{fmtTimestamp(lastRun?.finishedAt || lastRun?.startedAt)}</span>
          </div>
          <div className="info-tile">
            <span className="label">Imported</span>
            <strong>{lastRun?.autoPromoted ?? 0}</strong>
            <span className="ui-muted" style={{ fontSize: 12 }}>auto-promoted</span>
          </div>
          <div className="info-tile">
            <span className="label">Needs manual review</span>
            <strong>{lastRun?.needsReview ?? 0}</strong>
            <span className="ui-muted" style={{ fontSize: 12 }}>held for an agent</span>
          </div>
          <div className="info-tile">
            <span className="label">Next scheduled run</span>
            <strong>{status?.nextRunAt ? relativeTime(status.nextRunAt) : (status?.integrationEnabled ? '-' : 'paused')}</strong>
            <span className="ui-muted" style={{ fontSize: 12 }}>{status?.nextRunAt ? fmtTimestamp(status.nextRunAt) : 'scheduler off'}</span>
          </div>
        </div>

        <div className="surface-note" style={{ padding: '12px 14px', borderRadius: 14, background: 'linear-gradient(180deg, rgba(135,82,254,.08), rgba(31,199,170,.06))', border: '1px solid rgba(135,82,254,.12)', color: '#433b63', lineHeight: 1.6, fontSize: 13 }}>
          ⚙️ Runs autonomously (~every 15 minutes) once credentials and at least one area are enabled. Use <strong>Run sync now</strong> only if you need the latest reservations immediately.
        </div>

        <div className="row-between">
          <h4 className="ui-muted" style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}>Recent runs</h4>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #f0eaff' }}>
                <th style={{ padding: '8px 10px' }}>When</th>
                <th style={{ padding: '8px 10px' }}>Status</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Found</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Imported</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Review</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} style={{ padding: 12, color: '#6b7280' }}>Loading…</td></tr>
              ) : runs.length === 0 ? (
                <tr><td colSpan={5} style={{ padding: 12, color: '#6b7280' }}>No runs yet</td></tr>
              ) : runs.slice(0, 7).map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid #f0eaff' }}>
                  <td style={{ padding: '8px 10px' }}>{fmtTimestamp(r.startedAt)}</td>
                  <td style={{ padding: '8px 10px' }}><Pill tone={statusTone(r.status)}>{r.status || '-'}</Pill></td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.pickupsFound ?? '-'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.autoPromoted ?? '-'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.needsReview ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ============ 5. PENDING IMPORTS POINTER ============ */}
      <section className="glass card section-card" style={{ borderLeft: '4px solid #f59e0b' }}>
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h3 style={{ margin: 0 }}>Pending imports</h3>
              {(lastRun?.needsReview ?? 0) > 0 ? (
                <Pill tone="amber">{lastRun.needsReview} awaiting review</Pill>
              ) : null}
            </div>
            <p className="ui-muted">
              Reservations that couldn't be auto-matched (unmapped customer, unknown vehicle class, or location mismatch) are held in the review tray before they become live Ride reservations.
            </p>
          </div>
          <Link href="/reservations" style={{ whiteSpace: 'nowrap', color: '#6d3df2', fontWeight: 700, fontSize: 13 }}>
            Open review tray →
          </Link>
        </div>
        <div className="surface-note" style={{ padding: '12px 14px', borderRadius: 14, background: 'linear-gradient(180deg, rgba(135,82,254,.08), rgba(31,199,170,.06))', border: '1px solid rgba(135,82,254,.12)', color: '#433b63', lineHeight: 1.6, fontSize: 13 }}>
          The review tray also appears at the top of <strong>Reservations</strong> whenever there are Economy or TL imports waiting. Same tray, source-aware.
        </div>
      </section>
    </div>
  );
}

export default EconomyIntegrationPanel;
