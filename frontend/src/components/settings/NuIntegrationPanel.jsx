'use client';

/**
 * NuIntegrationPanel — Settings tab for the NU Car Rentals (affiliates portal)
 * franchise reservation sync (Fase 5). Sibling of EconomyIntegrationPanel; same
 * components, styling, and API-client pattern, matching nu-panel-mockup.html.
 *
 * KEY DIFFERENCE from Economy: NU is location 1:1. One NU affiliate login maps to
 * ONE Ride location, so the "which reservations to watch" card is a SINGLE mapping
 * row (NU account → one Ride location), NOT Economy's multi-area table. NU also
 * has a PREPAID MIX (PP/OP prepaid vs blank pay-at-destination) — an explainer
 * card documents it. Money posture is unchanged: Ride only records estimatedTotal,
 * never charges.
 *
 * English-only UI. SUPER_ADMIN + ADMIN gated by the parent settings page (ADMIN
 * is hard-scoped to their own tenant by the backend's resolveTenantId).
 *
 * Backend contract (mounted at /api/admin/integrations/nu):
 *   GET   /status                         -> { configured, masterEnabled, integrationEnabled,
 *                                              credential, locations[], lastRun, nextRunAt }
 *   PUT   /enabled       { enabled }       -> { ok, masterEnabled }
 *   POST  /credentials   { username, password } -> { ok, credentialId, rotatedAt }  (pw never returned)
 *   POST  /test-auth                       -> { ok, status }
 *   POST  /run-now                         -> { ok, jobId }
 *   GET   /runs?limit=                     -> { runs: [...] }
 *   GET   /locations                       -> { rows: [{ id, externalCenter, locationId, enabled,
 *                                              lookbackDays, lookaheadDays, location }] }
 *   POST  /locations     { locationId, externalCenter?, enabled?, lookbackDays?, lookaheadDays? }
 *   PUT   /locations/:id { locationId?, externalCenter?, enabled?, lookbackDays?, lookaheadDays? }
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

// Green/red pill matching the mockup + Economy StatusBadge inline styles.
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

const NOTE_STYLE = {
  padding: '12px 14px', borderRadius: 14,
  background: 'linear-gradient(180deg, rgba(135,82,254,.08), rgba(31,199,170,.06))',
  border: '1px solid rgba(135,82,254,.12)', color: '#433b63', lineHeight: 1.6, fontSize: 13,
};

export function NuIntegrationPanel({ token, me, isSuper, isAdmin, tenantName, activeSettingsTenantId, scopedSettingsPath, onPageMsg }) {
  const [status, setStatus] = useState(null);
  const [runs, setRuns] = useState([]);
  const [locations, setLocations] = useState([]);   // config rows (0 or 1 for 1:1 NU)
  const [rideLocations, setRideLocations] = useState([]); // tenant Ride locations for dropdown
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [runNowBusy, setRunNowBusy] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toast, setToast] = useState('');

  // Create-mapping form (shown when no NuLocationConfig row exists yet).
  const [newLocationId, setNewLocationId] = useState('');
  const [newCenter, setNewCenter] = useState('');
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
        api(scoped('/api/admin/integrations/nu/status'), { bypassCache: true }, token).catch(() => null),
        api(scoped('/api/admin/integrations/nu/runs?limit=7'), { bypassCache: true }, token).catch(() => ({ runs: [] })),
        api(scoped('/api/admin/integrations/nu/locations'), { bypassCache: true }, token).catch(() => ({ rows: [] })),
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
        scoped('/api/admin/integrations/nu/enabled'),
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
      flashToast('Enter Login ID and password before saving');
      return;
    }
    setSaving(true);
    try {
      const res = await api(
        scoped('/api/admin/integrations/nu/credentials'),
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
        scoped('/api/admin/integrations/nu/test-auth'),
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
        scoped('/api/admin/integrations/nu/run-now'),
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

  // ---- Single mapping CRUD (1:1 NU) ----------------------------------------
  const handleCreateMapping = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    if (!newLocationId) { flashToast('Pick a Ride location'); return; }
    setAddBusy(true);
    try {
      const res = await api(
        scoped('/api/admin/integrations/nu/locations'),
        {
          method: 'POST',
          body: JSON.stringify({
            locationId: newLocationId,
            externalCenter: newCenter.trim() || undefined,
            enabled: true,
          }),
        },
        token
      );
      if (res?.ok) {
        flashToast('Location mapping saved');
        setNewLocationId('');
        setNewCenter('');
        await reload();
      } else {
        flashToast(res?.error || 'Could not save mapping');
      }
    } catch (err) {
      flashToast(err?.message || 'Could not save mapping');
    } finally {
      setAddBusy(false);
    }
  };

  const patchMapping = async (id, body) => {
    try {
      const res = await api(
        scoped(`/api/admin/integrations/nu/locations/${id}`),
        { method: 'PUT', body: JSON.stringify(body) },
        token
      );
      if (res?.ok) { await reload(); }
      else flashToast(res?.error || 'Could not update mapping');
    } catch (err) {
      flashToast(err?.message || 'Could not update mapping');
    }
  };

  const toggleMapping = async (row) => {
    try {
      const res = await api(
        scoped(`/api/admin/integrations/nu/locations/${row.id}/toggle`),
        { method: 'POST', body: JSON.stringify({ enabled: !row.enabled }) },
        token
      );
      if (res?.ok) await reload();
    } catch (err) {
      flashToast(err?.message || 'Could not toggle mapping');
    }
  };

  const configured = !!status?.configured;
  const masterEnabled = !!status?.masterEnabled;
  const lastTestStatus = status?.credential?.lastTestStatus || null;
  const connected = configured && String(lastTestStatus || '').toUpperCase() === 'OK';
  const lastRun = status?.lastRun || null;

  // NU is 1:1 → a single mapping row. Use the first (only) config if present.
  const mapping = locations[0] || null;
  const mappedLocation = mapping
    ? (rideLocations.find((l) => l.id === mapping.locationId) || mapping.location || null)
    : null;
  const mappedLocationLabel = mappedLocation
    ? `${mappedLocation.name || mappedLocation.code}${mappedLocation.code && mappedLocation.name ? ` (${mappedLocation.code})` : ''}`
    : (mapping ? '(unmapped)' : '-');

  // Platform default import window (env-configured on the backend). effectiveWindow
  // already applies the env fallback when a row's own override is null.
  const platformDefault = (() => {
    const w = mapping?.effectiveWindow;
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
              <h2 style={{ margin: 0 }}>NU Car Rentals</h2>
              <Pill tone={connected ? 'green' : 'gray'}>{connected ? 'Connected' : (configured ? 'Untested' : 'Not configured')}</Pill>
              {tenantName ? <Pill tone="gray">{tenantName}</Pill> : null}
            </div>
            <p className="ui-muted">
              Imports reservations from the NU Car Rentals affiliate portal into Ride. Runs autonomously once configured.
              This login covers <strong>{mappedLocation ? mappedLocationLabel : 'one location'}</strong> (1:1 mapping).
            </p>
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
            <span className="label">Location</span>
            <strong>{mappedLocationLabel}</strong>
            <span className="ui-muted" style={{ fontSize: 12 }}>
              {mapping ? `${mapping.externalCenter ? `Center ${mapping.externalCenter} · ` : ''}1:1 mapping` : 'not mapped yet'}
            </span>
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
            The autonomous scheduler is currently <strong>off</strong> platform-wide (NU_INTEGRATION_ENABLED). You can configure everything now; scheduled runs start when it is enabled. Use <strong>Run sync now</strong> to sync on demand.
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
          The NU affiliate portal uses a plain <strong>Login ID + password</strong> (Telerik portal, no proxy or 2FA). Stored <strong>encrypted (AES-256-GCM)</strong> and never shown again after saving.
        </p>

        <form onSubmit={handleSaveCreds} className="stack" style={{ gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 14 }}>
            <label className="stack" style={{ gap: 6 }}>
              <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Login ID</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="corpusa.fll"
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
        <div className="surface-note" style={NOTE_STYLE}>
          🔒 Encrypted at rest with AES-256-GCM. NU authenticates by session (no CloudFlare, no hourly-expiring cookie), so the panel re-logs in on its own — you rarely need to touch this again. Autonomous from Ride's server, no proxy required.
        </div>
      </section>

      {/* ============ 3. WHICH RESERVATIONS TO WATCH (SINGLE 1:1 mapping) ============ */}
      <section className="glass card section-card">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <h3 style={{ margin: 0 }}>Which reservations to watch</h3>
            <p className="ui-muted">
              An NU affiliate login is scoped to <strong>one location</strong>. This account maps 1:1 to a single Ride location —
              there's no per-area filter like a multi-area source (e.g. Economy's MIA / LAX). Set the destination location and its import window below.
            </p>
          </div>
        </div>

        {mapping ? (
          /* SINGLE mapping row (not a table) */
          <div style={{ border: '1px solid #ece5ff', borderRadius: 16, background: 'rgba(255,255,255,.72)', padding: 16 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-end' }}>
              <div style={{ display: 'grid', gap: 6, minWidth: 210 }}>
                <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>NU account</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="ui-muted" style={{ fontSize: 13 }}>
                    {mappedLocation ? <>Covers <strong>{mappedLocationLabel}</strong></> : 'NU affiliate login'}
                  </span>
                  <span className="ui-muted">→</span>
                </div>
                <label className="stack" style={{ gap: 4, marginTop: 4 }}>
                  <span className="ui-muted" style={{ fontSize: 12 }}>External center</span>
                  <input
                    type="text"
                    defaultValue={mapping.externalCenter ?? ''}
                    placeholder="100"
                    title="NU portal center code (e.g. 100 = Ft. Lauderdale)"
                    onBlur={(e) => {
                      const v = e.target.value.trim() === '' ? null : e.target.value.trim();
                      if ((mapping.externalCenter ?? null) !== v) patchMapping(mapping.id, { externalCenter: v });
                    }}
                    style={{ width: 110 }}
                  />
                </label>
              </div>

              <div style={{ display: 'grid', gap: 6, minWidth: 230 }}>
                <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Ride location</span>
                <select
                  value={mapping.locationId}
                  onChange={(e) => patchMapping(mapping.id, { locationId: e.target.value })}
                  style={{ maxWidth: 240 }}
                >
                  {rideLocations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name || l.code} {l.code ? `(${l.code})` : ''}</option>
                  ))}
                  {!rideLocations.some((l) => l.id === mapping.locationId) && mapping.location ? (
                    <option value={mapping.locationId}>{mapping.location.name || mapping.location.code}</option>
                  ) : null}
                </select>
              </div>

              <div style={{ display: 'grid', gap: 6 }}>
                <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Import window (days)</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="number" min={0}
                    defaultValue={mapping.lookbackDays ?? ''}
                    placeholder={mapping.effectiveWindow?.lookbackDays != null ? String(mapping.effectiveWindow.lookbackDays) : 'default'}
                    title="Lookback days (blank = platform default)"
                    onBlur={(e) => {
                      const v = e.target.value === '' ? null : Number(e.target.value);
                      if ((mapping.lookbackDays ?? null) !== v) patchMapping(mapping.id, { lookbackDays: v });
                    }}
                    style={{ width: 78 }}
                  />
                  <span className="ui-muted" style={{ fontSize: 12 }}>back /</span>
                  <input
                    type="number" min={0}
                    defaultValue={mapping.lookaheadDays ?? ''}
                    placeholder={mapping.effectiveWindow?.lookaheadDays != null ? String(mapping.effectiveWindow.lookaheadDays) : 'default'}
                    title="Lookahead days (blank = platform default)"
                    onBlur={(e) => {
                      const v = e.target.value === '' ? null : Number(e.target.value);
                      if ((mapping.lookaheadDays ?? null) !== v) patchMapping(mapping.id, { lookaheadDays: v });
                    }}
                    style={{ width: 78 }}
                  />
                  <span className="ui-muted" style={{ fontSize: 12 }}>ahead</span>
                </div>
              </div>

              <div style={{ display: 'grid', gap: 6, justifyItems: 'center' }}>
                <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Import</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!mapping.enabled}
                  aria-label="Import NU reservations"
                  className="switch"
                  onClick={() => toggleMapping(mapping)}
                  title={mapping.enabled ? 'Importing — click to pause' : 'Paused — click to import'}
                />
              </div>
            </div>
          </div>
        ) : (
          /* No mapping yet — create the single 1:1 mapping. */
          <form onSubmit={handleCreateMapping} style={{ border: '1px solid #ece5ff', borderRadius: 16, background: 'rgba(255,255,255,.72)', padding: 16, display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-end' }}>
            <label className="stack" style={{ gap: 6, minWidth: 230 }}>
              <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Ride location</span>
              <select value={newLocationId} onChange={(e) => setNewLocationId(e.target.value)} style={{ minWidth: 220 }}>
                <option value="">Select…</option>
                {rideLocations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name || l.code} {l.code ? `(${l.code})` : ''}</option>
                ))}
              </select>
            </label>
            <label className="stack" style={{ gap: 6 }}>
              <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>External center</span>
              <input
                type="text" value={newCenter}
                onChange={(e) => setNewCenter(e.target.value)}
                placeholder="100" title="NU portal center code (default 100 = Ft. Lauderdale)"
                style={{ width: 110 }}
              />
            </label>
            <button type="submit" className="subtle" disabled={addBusy}>{addBusy ? 'Saving…' : 'Save mapping'}</button>
          </form>
        )}

        <div className="ui-muted" style={{ fontSize: 12 }}>
          Import window blank = the platform default{platformDefault
            ? ` (${platformDefault.lookbackDays} back / ${platformDefault.lookaheadDays} ahead)`
            : ''}. Only this location is imported while the toggle is on.
        </div>
        <div className="surface-note" style={NOTE_STYLE}>
          🧭 One NU login = one location today. The config keeps an <strong>external center</strong> field
          (e.g. <code>100</code> = Ft. Lauderdale) so multi-center NU accounts can add more rows later without changing this panel.
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

        <div className="surface-note" style={NOTE_STYLE}>
          ⚙️ Runs autonomously (~every 15 minutes) once credentials are saved and the location is enabled. Reservations are pulled from the <strong>NU affiliate grid</strong> for the configured date window. Use <strong>Run sync now</strong> only if you need the latest reservations immediately.
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

      {/* ============ 5. PREPAID vs PAY-AT-DESTINATION (NU-specific) ============ */}
      <section className="glass card section-card" style={{ borderLeft: '4px solid var(--brand-purple, #8752FE)' }}>
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <h3 style={{ margin: 0 }}>Prepaid vs pay-at-destination</h3>
            <p className="ui-muted">
              NU reservations are a <strong>mix</strong> — unlike Economy or TL (all prepaid). The portal's <code>Code</code> column
              tells you which is which, and Ride shows a matching badge on every imported reservation so the counter knows whether to collect payment.
            </p>
          </div>
        </div>

        <div className="app-card-grid">
          <div className="info-tile" style={{ gap: 8 }}>
            <span style={{ background: 'rgba(135,82,254,.15)', color: '#5a2fca', border: '1px solid rgba(135,82,254,.22)', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, display: 'inline-block' }}>
              Franchise import · Prepaid
            </span>
            <span style={{ fontSize: 13 }}>Code <code>PP</code> / <code>OP</code></span>
            <span className="ui-muted" style={{ fontSize: 12 }}>Already paid through NU — <strong>do not charge at the counter</strong>.</span>
          </div>
          <div className="info-tile" style={{ gap: 8 }}>
            <span style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, display: 'inline-block' }}>
              Franchise import · Pay at destination
            </span>
            <span style={{ fontSize: 13 }}>Code <code>(blank)</code></span>
            <span className="ui-muted" style={{ fontSize: 12 }}>The <strong>counter collects</strong> at pickup. Not prepaid.</span>
          </div>
        </div>

        <div className="surface-note" style={NOTE_STYLE}>
          💳 Either way, Ride <strong>never charges the card</strong> on import — it only records the estimated total. Prepaid rentals were paid through NU; pay-at-destination rentals are collected manually by the counter at delivery.
        </div>
      </section>

      {/* ============ 6. PENDING IMPORTS POINTER ============ */}
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
              Reservations that couldn't be auto-matched (unmapped customer, unknown vehicle class) are held in the review tray before they become live Ride reservations.
            </p>
          </div>
          <Link href="/reservations" style={{ whiteSpace: 'nowrap', color: '#6d3df2', fontWeight: 700, fontSize: 13 }}>
            Open review tray →
          </Link>
        </div>
        <div className="surface-note" style={NOTE_STYLE}>
          The review tray also appears at the top of <strong>Reservations</strong> whenever there are imports waiting. Same source-aware tray, labeled <strong>“Pending franchise imports — NU Car Rentals”</strong>.
        </div>
      </section>
    </div>
  );
}

export default NuIntegrationPanel;
