'use client';

/**
 * MexIntegrationPanel — Settings tab for the Mex (TSD RezCentral)
 * franchise reservation sync (Fase 5). Sibling of FlexwaysIntegrationPanel; same
 * components, styling and API-client pattern, matching the approved mockup
 * doc/mex-panel-mockup-2026-07-14.html (screens AD-1 / AD-2 / AD-3).
 *
 * KEY DIFFERENCES from Flexways:
 *   - IDENTITY IS A PAIR. A config row is keyed by TSD # + Branch (the portal's
 *     `Loc` column, "61302.MCO"), not by a single idSede. The grid and the add
 *     form carry BOTH fields.
 *   - NO PREPAID SURFACE. Mex is 100% Pay on Arrival (confirmed with
 *     Mex 2026-07-14) — there is nothing to show, so nothing is shown.
 *   - DEDICATED CONNECTION USER. TSD is single-window strict (one live session per
 *     user), so the credentials note tells the admin never to use their personal
 *     login (mockup AD-2).
 *   - EMAIL COVERAGE ~50% BY DESIGN. The sync joins a second report (Email Address
 *     Report) onto the main feed and only ~half the bookings carry an address —
 *     that is the source data, not a fault. The copy sets that expectation so
 *     "auto-promoted" short of 100% doesn't read as broken (mockup design-note 3).
 *   - NO PROXY / NO CAPTCHA. TSD is a plain ASP.NET back-office (recon Fase 0), so
 *     there's no headless browser, no reCAPTCHA and no residential-proxy escape
 *     hatch to surface.
 *
 * Health: the header pill derives from the backend's LIVE `health` object (a
 * failed scheduled run must never show green up here while the card below is red)
 * — the Graphic Design must-change from the Flexways panel, kept.
 *
 * Money posture: none. Ride only records estimatedTotal; it never charges.
 *
 * English-only UI (matches TL/Economy/NU/Flexways — these panels are not wired to
 * the locale files).
 *
 * Backend contract (mounted at /api/admin/integrations/mex):
 *   GET   /status                          -> { configured, masterEnabled, integrationEnabled,
 *                                               credential, health, locations[], lastRun, nextRunAt }
 *   PUT   /enabled       { enabled }       -> { ok, masterEnabled }
 *   POST  /credentials   { username, password } -> { ok, credentialId, rotatedAt } (pw never returned)
 *   POST  /test-auth                       -> { ok, status }   (real portal login)
 *   POST  /force-relogin                   -> { ok }
 *   POST  /run-now                         -> { ok, jobId }    (409 disabled / 503 no queue)
 *   GET   /runs?limit=                     -> { runs: [...] }
 *   GET   /locations                       -> { rows: [{ id, tsdNumber, branch, loc, locationId,
 *                                               enabled, lookbackDays, lookaheadDays,
 *                                               effectiveWindow, location }] }
 *   POST  /locations     { tsdNumber, branch, locationId, enabled?, lookbackDays?, lookaheadDays? }
 *   PUT   /locations/:id { tsdNumber?, branch?, locationId?, enabled?, lookbackDays?, lookaheadDays? }
 *   POST  /locations/:id/toggle { enabled }
 *   DELETE /locations/:id
 *
 * The location bodies above are built ONLY through buildMexLocationBody()
 * so the panel and mex.routes.js cannot drift on field names — see
 * lib/mex-location-contract.js (the beta.301 regression).
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/client';
import { buildMexLocationBody, mexLocLabel } from '../../lib/mex-location-contract';

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

// Duration of a run, from an explicit durationMs or finished-started delta.
function fmtDuration(r) {
  let ms = Number(r?.durationMs);
  if (!Number.isFinite(ms)) {
    if (r?.finishedAt && r?.startedAt) {
      ms = new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime();
    } else {
      ms = NaN;
    }
  }
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

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
  if (s === 'PARTIAL' || s === 'ATTENTION') return 'amber';
  return 'gray';
}

const NOTE_STYLE = {
  // No hardcoded color: .surface-note already sets #433b63 in light mode, and the
  // inline value was overriding the dark-theme .surface-note override (unreadable).
  padding: '12px 14px', borderRadius: 14,
  background: 'linear-gradient(180deg, rgba(135,82,254,.08), rgba(31,199,170,.06))',
  border: '1px solid rgba(135,82,254,.12)', lineHeight: 1.6, fontSize: 13,
};

// Warn variant of the run strip (mockup .strip.warn). Used when the last run did
// NOT end healthy — a "✓ syncs by itself" claim must never sit on top of a failed
// run.
const NOTE_STYLE_WARN = {
  ...NOTE_STYLE,
  background: '#fdf7ec',
  border: '1px solid #f3ddb5',
  color: '#8a5a0f',
};

// Danger treatment for the emergency-only destructive actions now lives in
// globals.css as `.button-danger` (promoted from this panel's inline
// DANGER_BUTTON_STYLE — it was the third panel-local reinvention). White fill,
// red hairline border, #991b1b text (8.31:1 on #fff), theme-aware in dark.

/**
 * Recent-runs status cell (mockup AD-2). SUCCESS is green; a session expiry is
 * AMBER with "— auto-retrying" because the worker logs back in by itself on the
 * next sweep — a non-technical admin must not read it as a hard failure. A layout
 * drift (ATTENTION) is amber too but DOES want a human. Everything else is red.
 */
function RunStatusCell({ run }) {
  const s = String(run?.status || '').toUpperCase();
  const reason = run?.failureReason || run?.reason || run?.error || '';
  const reasonUp = String(reason).toUpperCase();

  if (s === 'SUCCESS' || s === 'OK') {
    const reLogin = run?.reLogin === true || reasonUp.includes('RE-LOGIN') || reasonUp.includes('RELOGIN');
    return (
      <Pill tone="green">
        SUCCESS{reLogin ? <span style={{ fontWeight: 600 }}> (re-login)</span> : null}
      </Pill>
    );
  }
  if (s === 'AUTH_EXPIRED') {
    return <Pill tone="amber">SESSION_EXPIRED — auto-retrying</Pill>;
  }
  if (s === 'ATTENTION') {
    return <Pill tone="amber">ATTENTION · report layout changed</Pill>;
  }
  if (s === 'FAILED' || s === 'ERROR' || s === 'EXPIRED') {
    const sessionExpired = reasonUp.includes('SESSION_EXPIRED') || reasonUp.includes('EXPIRED') || s === 'EXPIRED';
    return (
      <Pill tone={sessionExpired ? 'amber' : 'red'}>
        FAILED{reason ? ` · ${reason}` : (sessionExpired ? ' · SESSION_EXPIRED' : '')}{sessionExpired ? ' — auto-retrying' : ''}
      </Pill>
    );
  }
  return <Pill tone={statusTone(s)}>{run?.status || '-'}</Pill>;
}

export function MexIntegrationPanel({ token, me, isSuper, isAdmin, tenantName, activeSettingsTenantId, scopedSettingsPath, onPageMsg }) {
  const [status, setStatus] = useState(null);
  const [runs, setRuns] = useState([]);
  const [locations, setLocations] = useState([]);        // (tsdNumber, branch) config rows
  const [rideLocations, setRideLocations] = useState([]); // tenant Ride locations for dropdowns
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [relogging, setRelogging] = useState(false);
  const [runNowBusy, setRunNowBusy] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toast, setToast] = useState('');

  // New-config form (AD-1's "Agregar sede" row) — TSD # + Branch + Ride location.
  const [newTsdNumber, setNewTsdNumber] = useState('');
  const [newBranch, setNewBranch] = useState('');
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
        api(scoped('/api/admin/integrations/mex/status'), { bypassCache: true }, token).catch(() => null),
        api(scoped('/api/admin/integrations/mex/runs?limit=7'), { bypassCache: true }, token).catch(() => ({ runs: [] })),
        api(scoped('/api/admin/integrations/mex/locations'), { bypassCache: true }, token).catch(() => ({ rows: [] })),
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
        scoped('/api/admin/integrations/mex/enabled'),
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
        scoped('/api/admin/integrations/mex/credentials'),
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
        scoped('/api/admin/integrations/mex/test-auth'),
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

  // Emergency only — the worker re-authenticates on its own. Discards the stored
  // session and signs in fresh right now.
  const handleForceRelogin = async () => {
    setRelogging(true);
    try {
      const res = await api(
        scoped('/api/admin/integrations/mex/force-relogin'),
        { method: 'POST' },
        token
      );
      flashToast(res?.ok ? 'Re-login OK' : `Re-login failed (${res?.status || 'ERROR'})`);
      await reload();
    } catch (err) {
      flashToast(err?.message || 'Could not re-login');
    } finally {
      setRelogging(false);
    }
  };

  const handleRunNow = async () => {
    setRunNowBusy(true);
    try {
      const res = await api(
        scoped('/api/admin/integrations/mex/run-now'),
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

  // ---- Location config CRUD ------------------------------------------------
  // Every body below goes through buildMexLocationBody — the panel never
  // hand-writes a field name (beta.301).
  const locLabel = (row) => row?.loc || mexLocLabel(row) || '';

  const handleAddConfig = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    const tsdNumber = String(newTsdNumber || '').trim();
    const branch = String(newBranch || '').trim();
    if (!tsdNumber) { flashToast('Enter the TSD # (e.g. 61302)'); return; }
    if (!branch) { flashToast('Enter the branch (e.g. MCO)'); return; }
    if (!newLocationId) { flashToast('Pick a Ride location'); return; }
    setAddBusy(true);
    try {
      const res = await api(
        scoped('/api/admin/integrations/mex/locations'),
        {
          method: 'POST',
          body: JSON.stringify(buildMexLocationBody({
            tsdNumber, branch, locationId: newLocationId, enabled: true,
          })),
        },
        token
      );
      if (res?.ok) {
        flashToast(`${tsdNumber}.${branch.toUpperCase()} added`);
        setNewTsdNumber('');
        setNewBranch('');
        setNewLocationId('');
        await reload();
      } else {
        flashToast(res?.error || 'Could not add location');
      }
    } catch (err) {
      flashToast(err?.message || 'Could not add location');
    } finally {
      setAddBusy(false);
    }
  };

  const patchConfig = async (id, input) => {
    try {
      const res = await api(
        scoped(`/api/admin/integrations/mex/locations/${id}`),
        { method: 'PUT', body: JSON.stringify(buildMexLocationBody(input)) },
        token
      );
      if (res?.ok) { await reload(); }
      else flashToast(res?.error || 'Could not update location');
    } catch (err) {
      flashToast(err?.message || 'Could not update location');
    }
  };

  const toggleConfig = async (row) => {
    try {
      const res = await api(
        scoped(`/api/admin/integrations/mex/locations/${row.id}/toggle`),
        { method: 'POST', body: JSON.stringify({ enabled: !row.enabled }) },
        token
      );
      if (res?.ok) await reload();
    } catch (err) {
      flashToast(err?.message || 'Could not toggle location');
    }
  };

  const removeConfig = async (row) => {
    if (typeof window !== 'undefined' && !window.confirm(`Remove ${locLabel(row)}?`)) return;
    try {
      const res = await api(
        scoped(`/api/admin/integrations/mex/locations/${row.id}`),
        { method: 'DELETE' },
        token
      );
      if (res?.ok) await reload();
    } catch (err) {
      flashToast(err?.message || 'Could not remove location');
    }
  };

  const configured = !!status?.configured;
  const masterEnabled = !!status?.masterEnabled;
  const lastTestStatus = status?.credential?.lastTestStatus || null;
  const connected = configured && String(lastTestStatus || '').toUpperCase() === 'OK';
  const activeConfigs = locations.filter((l) => l.enabled);
  const lastRun = status?.lastRun || null;

  // Platform default import window (env-configured on the backend). A row whose
  // own override is null reflects the true platform default via effectiveWindow.
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

  // ---- Connection health ---------------------------------------------------
  // The backend computes this LIVE from the credential probe AND the last run, so
  // a failing 15-minute cron can never sit behind a green pill left over from an
  // old manual test. We only fall back to deriving it if an older backend didn't
  // send `health` at all.
  const health = (() => {
    const h = status?.health || null;
    const lastTestUp = String(lastTestStatus || '').toUpperCase();
    const lastRunUp = String(lastRun?.status || '').toUpperCase();
    const lastSuccessAt = h?.lastSuccessAt
      || (lastRunUp === 'OK' || lastRunUp === 'SUCCESS' ? (lastRun?.finishedAt || lastRun?.startedAt) : null)
      || (connected ? status?.credential?.lastTestedAt : null);

    const state = String(h?.state || '').toLowerCase()
      || (!configured
        ? 'unconfigured'
        : ((lastTestUp && lastTestUp !== 'OK') || lastRunUp === 'FAILED' || lastRunUp === 'ERROR'
          ? 'failing'
          : (lastTestUp ? 'healthy' : 'untested')));

    if (!configured || state === 'unconfigured') {
      return {
        kind: 'unconfigured',
        title: 'Not configured',
        // AD-3, first card.
        meta: 'Add the portal username and password above, then Test connection. Once saved, Ride logs in and syncs on its own — there is no reconnecting by hand.',
        pillTone: 'gray', pillLabel: 'Not configured',
        headerLabel: 'Not configured',
        tileSubtitle: 'add credentials',
      };
    }

    if (state === 'failing') {
      const reasonKind = h?.reasonKind || null;
      const reason = h?.reason
        || 'the portal rejected the last login — check the connection user and password above';

      // The one place the failing headline is built. The header pill and this
      // card both read it, so they cannot drift apart on a session expiry the
      // way they did when the header hardcoded "credentials rejected".
      // Absent reasonKind (older backend) falls back to Flexways' wording.
      const title = reasonKind
        ? `Login failing · ${reasonKind}`
        : 'Login failing · retrying automatically';

      // A layout drift is NOT a credential problem and is NOT retrying: the
      // backend pauses the import on purpose until the column map is fixed.
      // Telling the admin to check the password there sends them at the wrong
      // fix and contradicts the reason in the same sentence.
      const isDrift = reasonKind === 'report layout drift';
      const isRejected = reasonKind === 'credentials rejected';

      return {
        kind: 'failing',
        title,
        // AD-3, second card.
        meta: (
          <>
            {lastSuccessAt ? <>Last success <strong>{relativeTime(lastSuccessAt)}</strong> · </> : null}
            {reason}
            {isDrift
              ? <> · The import is <strong>paused on purpose</strong> until the column map is fixed — this is not a credential problem, so re-saving the password will not clear it.</>
              : (
                <>
                  {' '}· Ride keeps <strong>retrying every 15 minutes</strong>.
                  {isRejected ? <> If the connection user&apos;s password changed, update it here.</> : null}
                </>
              )}
          </>
        ),
        pillTone: 'red', pillLabel: 'Login failing',
        headerLabel: title,
        tileSubtitle: isDrift
          ? 'paused · needs a column-map fix'
          : (isRejected ? 'retrying · check credentials' : 'retrying automatically'),
      };
    }

    if (state === 'untested') {
      return {
        kind: 'untested',
        title: 'Credentials saved · not tested yet',
        meta: 'Run Test connection to confirm the portal accepts this user before enabling the sync.',
        pillTone: 'gray', pillLabel: 'Untested',
        headerLabel: 'Untested',
        tileSubtitle: 'not tested yet',
      };
    }

    return {
      kind: 'healthy',
      title: 'Connected · auto-login healthy',
      meta: (
        <>
          {lastSuccessAt ? <>Last successful login <strong>{relativeTime(lastSuccessAt)}</strong> · </> : null}
          session valid · the worker re-authenticates automatically when it expires
        </>
      ),
      pillTone: 'green', pillLabel: 'Healthy',
      headerLabel: 'Connected · auto-login healthy',
      tileSubtitle: 'auto-login healthy',
    };
  })();

  // Derived, never re-stated: the header pill is the same string the health card
  // renders as its title (GD must-change, carried over from Flexways beta.298).
  const headerPillLabel = health.headerLabel;

  const healthStrip = (() => {
    if (health.kind === 'healthy') {
      return { border: '1.5px solid #bbf1d2', background: 'linear-gradient(180deg,#f2fdf6,#e9fbf1)', dot: '#22c55e', dotGlow: 'rgba(34,197,94,.16)', title: '#14532d', meta: '#4d6b57' };
    }
    if (health.kind === 'failing') {
      return { border: '1.5px solid #f7c6c6', background: 'linear-gradient(180deg,#fef4f4,#fdeaea)', dot: '#ef4444', dotGlow: 'rgba(239,68,68,.14)', title: '#7f1d1d', meta: '#8d5050' };
    }
    return { border: '1.5px solid #d7cbff', background: 'linear-gradient(180deg,#faf8ff,#f4f0ff)', dot: '#a99bd6', dotGlow: 'rgba(135,82,254,.12)', title: '#3b2e63', meta: '#7c6bb0' };
  })();

  return (
    <div className="stack" style={{ gap: 20 }}>
      {toast ? (
        <div style={{ padding: 10, background: '#ecfdf5', border: '1px solid #10b981', borderRadius: 6, color: '#065f46' }}>{toast}</div>
      ) : null}
      {loadError ? (
        <div style={{ padding: 10, background: '#fee2e2', border: '1px solid #ef4444', borderRadius: 6, color: '#991b1b' }}>{loadError}</div>
      ) : null}

      {/* ============ 1. HEADER + MASTER TOGGLE (AD-1) ============ */}
      <section className="glass card section-card">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <div className="eyebrow" style={{ color: '#6d3df2', fontWeight: 800, fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' }}>
              Booking source integration
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0 }}>
                Mex <span style={{ fontWeight: 600, color: '#6f668f', fontSize: 15 }}>(TSD RezCentral)</span>
              </h2>
              {/* Header pill comes from the SAME live `health` object as the
                  Connection health card — never the stale manual-test status.
                  (GD lesson carried over from Flexways, 2026-07-13.) */}
              <Pill tone={health.pillTone}>{headerPillLabel}</Pill>
              {tenantName ? <Pill tone="gray">{tenantName}</Pill> : null}
            </div>
            <p className="ui-muted">
              Imports reservations from the Mex back-office (<code>rezcentral.tsdasp.net</code>) into Ride.{' '}
              <strong>Runs autonomously once configured</strong> — the sync worker signs in on its own and re-logs in when the
              session expires. Reservations arrive as{' '}
              <span style={{ background: 'rgba(135,82,254,.15)', color: '#5a2fca', border: '1px solid rgba(135,82,254,.22)', padding: '1px 7px', borderRadius: 999, fontSize: 11, fontWeight: 600, display: 'inline-block' }}>
                Franchise import · MEX-
              </span>{' '}
              and go through the same review tray as Economy, NU and Flexways. Every Mex booking is{' '}
              <strong>Pay on Arrival</strong> — the counter collects at pickup, Ride never charges.
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
                title="Turn off to pause the sync without deleting the configuration"
              />
              <span className="ui-muted" style={{ fontSize: 13, minWidth: 58 }}>
                {toggleBusy ? '…' : (masterEnabled ? 'Enabled' : 'Disabled')}
              </span>
            </div>
            <span className="ui-muted" style={{ fontSize: 12 }}>Turn off to pause the sync without deleting the configuration</span>
          </div>
        </div>

        <div className="app-card-grid" style={{ marginTop: 8 }}>
          <div className="info-tile">
            <span className="label">Connection</span>
            <strong><Pill tone={health.pillTone}>{health.pillLabel}</Pill></strong>
            {/* Same derived source as the health card — a drift is paused, not retrying. */}
            <span className="ui-muted" style={{ fontSize: 12 }}>{health.tileSubtitle}</span>
          </div>
          <div className="info-tile">
            <span className="label">Locations active</span>
            <strong>{activeConfigs.length} of {locations.length}</strong>
            <span className="ui-muted" style={{ fontSize: 12 }}>
              {activeConfigs.map((a) => (a.location?.name || a.location?.code || locLabel(a))).join(', ') || '-'}
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

        {/* AD-1's strip: what the last run actually did. State-dependent per the
            mockup (.strip.ok in AD-1 vs .strip.warn in AD-3) — the "✓ syncs by
            itself" claim is only true while health is green, and must never sit
            directly above a failed run. */}
        {lastRun ? (
          health.kind === 'healthy' ? (
            <div className="surface-note" style={NOTE_STYLE}>
              ✓ Ride signs into the portal by itself and syncs every ~15 minutes. Last run{' '}
              <strong>{relativeTime(lastRun.finishedAt || lastRun.startedAt)}</strong> ·{' '}
              <strong>{lastRun.pickupsFound ?? 0}</strong> reservations ·{' '}
              <strong>{lastRun.autoPromoted ?? 0} auto-promoted</strong> ·{' '}
              <strong>{lastRun.needsReview ?? 0}</strong> to manual review.
            </div>
          ) : (
            <div className="surface-note" style={NOTE_STYLE_WARN}>
              ⚠️ Last run <strong>{relativeTime(lastRun.finishedAt || lastRun.startedAt)}</strong> ·{' '}
              <strong>{lastRun.pickupsFound ?? 0}</strong> reservations ·{' '}
              <strong>{lastRun.autoPromoted ?? 0} auto-promoted</strong> ·{' '}
              <strong>{lastRun.needsReview ?? 0}</strong> to manual review. See{' '}
              <strong>Connection health</strong> below — the sync is not running clean right now.
            </div>
          )
        ) : null}

        {!status?.integrationEnabled ? (
          <div className="ui-muted" style={{ fontSize: 12 }}>
            The autonomous scheduler is currently <strong>off</strong> platform-wide (MEX_INTEGRATION_ENABLED). You can configure
            everything now; scheduled runs start when it is enabled. Use <strong>Run sync now</strong> to sync on demand.
          </div>
        ) : null}
      </section>

      {/* ============ 2. CREDENTIALS (AD-2) ============ */}
      <section className="glass card section-card">
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Portal credentials</h3>
          <Pill tone={statusTone(lastTestStatus)}>{lastTestStatus ? (connected ? 'Verified' : lastTestStatus) : 'Untested'}</Pill>
        </div>
        <p className="ui-muted">
          The Mex back-office (<code>rezcentral.tsdasp.net/WebRezClient</code>) uses a <strong>username + password</strong> login.
          Ride signs in on its own with these; stored <strong>encrypted (AES-256-GCM)</strong> and never shown again after saving.
        </p>

        <form onSubmit={handleSaveCreds} className="stack" style={{ gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 14 }}>
            <label className="stack" style={{ gap: 6 }}>
              <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Username</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="AD_CONEXION"
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
            <button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save credentials'}
            </button>
            <button type="button" className="button-subtle" disabled={testing || loading || !configured} onClick={handleTestAuth}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" className="button-danger" disabled={relogging || !configured} onClick={handleForceRelogin} title="Emergency only — the worker re-authenticates on its own">
              {relogging ? 'Re-logging in…' : 'Force re-login'}
            </button>
            <span className="ui-muted" style={{ fontSize: 13 }}>
              {status?.credential?.lastTestedAt
                ? <>Last tested <strong>{relativeTime(status.credential.lastTestedAt)}</strong> · <Pill tone={statusTone(lastTestStatus)}>{lastTestStatus || 'Untested'}</Pill></>
                : 'Not tested yet'}
            </span>
          </div>
        </form>

        {/* AD-2's lock note — the dedicated connection user is the load-bearing
            part: TSD allows ONE live session per user, so a personal login here
            means the worker and the human evict each other all day. */}
        <div className="surface-note" style={NOTE_STYLE}>
          🔒 Stored <strong>encrypted (AES-256)</strong> and never returned to the browser. <strong>Test connection performs a real
          login</strong> against the portal — the same one the worker uses — so it reports the actual result, not just that a password
          is saved.
          <br />
          ⚠️ Use the <strong>dedicated connection user</strong> — never your personal TSD login. TSD RezCentral is{' '}
          <strong>single-window strict</strong> (one live session per user): if Ride and a person share a login, each new sign-in
          knocks the other out and the sync will fail on and off all day.
        </div>
      </section>

      {/* ============ 3. CONNECTION HEALTH (AD-1 / AD-3) ============ */}
      <section className="glass card section-card" style={{ borderLeft: '4px solid var(--brand-purple, #8752FE)' }}>
        <h3 style={{ margin: 0 }}>Connection health</h3>
        <p className="ui-muted">Live status of the autonomous login. Ride re-logs in on its own — you don&apos;t manage the session.</p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, border: healthStrip.border, background: healthStrip.background, borderRadius: 16, padding: '14px 18px', flexWrap: 'wrap', marginTop: 4 }}>
          <span style={{ width: 12, height: 12, borderRadius: 999, background: healthStrip.dot, boxShadow: `0 0 0 5px ${healthStrip.dotGlow}`, flex: 'none' }} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 850, color: healthStrip.title, fontSize: 14.5 }}>{health.title}</div>
            <div style={{ fontSize: 12.5, color: healthStrip.meta }}>{health.meta}</div>
          </div>
          <Pill tone={health.pillTone}>{health.pillLabel}</Pill>
        </div>

        <div className="surface-note" style={NOTE_STYLE}>
          🔁 If a login fails (expired session, portal down), the worker <strong>retries on its own</strong> and re-authenticates on the
          next run — no manual step. <strong>Force re-login</strong> (next to the credentials above) is an emergency button that
          discards the stored session and signs in fresh right now; you should rarely need it.
        </div>
      </section>

      {/* ============ 4. LOCATIONS GRID (AD-1) ============ */}
      <section className="glass card section-card">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <h3 style={{ margin: 0 }}>Mex locations</h3>
            <p className="ui-muted">
              Mex keys its reports by <strong>TSD account number</strong> + <strong>branch</strong>. Map each pair to a Ride
              location and set its import window. Only enabled rows are imported.
            </p>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #f0eaff' }}>
                <th style={{ padding: '8px 10px' }}>TSD #</th>
                <th style={{ padding: '8px 10px' }}>Branch</th>
                <th style={{ padding: '8px 10px' }}>Ride location</th>
                <th style={{ padding: '8px 10px' }}>Import window (days)</th>
                <th style={{ padding: '8px 10px', textAlign: 'center' }}>Active</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {locations.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 12, color: '#6b7280' }}>No Mex locations configured yet. Add one below.</td></tr>
              ) : locations.map((row) => (
                <tr key={row.id} style={{ borderBottom: '1px solid #f0eaff', opacity: row.enabled ? 1 : 0.6 }}>
                  <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}><code>{row.tsdNumber}</code></td>
                  <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}><code>{row.branch}</code></td>
                  <td style={{ padding: '8px 10px' }}>
                    <select
                      value={row.locationId || ''}
                      onChange={(e) => patchConfig(row.id, { locationId: e.target.value })}
                      style={{ maxWidth: 240 }}
                    >
                      <option value="">— not mapped —</option>
                      {rideLocations.map((l) => (
                        <option key={l.id} value={l.id}>{l.name || l.code} {l.code ? `(${l.code})` : ''}</option>
                      ))}
                      {/* Preserve the current value if it's not in the loaded list. */}
                      {row.locationId && !rideLocations.some((l) => l.id === row.locationId) && row.location ? (
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
                          if ((row.lookbackDays ?? null) !== v) patchConfig(row.id, { lookbackDays: v });
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
                          if ((row.lookaheadDays ?? null) !== v) patchConfig(row.id, { lookaheadDays: v });
                        }}
                        style={{ width: 74 }}
                      />
                      <span className="ui-muted" style={{ fontSize: 12 }}>ahead</span>
                    </div>
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      {row.enabled && !row.locationId ? (
                        <Pill tone="amber">No location</Pill>
                      ) : null}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={!!row.enabled}
                        aria-label={`Import ${locLabel(row)} reservations`}
                        className="switch"
                        onClick={() => toggleConfig(row)}
                        title={row.enabled ? 'Importing — click to pause' : 'Paused — click to import'}
                      />
                    </div>
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    <button type="button" className="button-danger" onClick={() => removeConfig(row)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Add row (AD-1's dashed "Agregar sede" strip) */}
        <form onSubmit={handleAddConfig} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', borderTop: '1px solid #f0eaff', paddingTop: 14, marginTop: 4 }}>
          <label className="stack" style={{ gap: 6 }}>
            <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>TSD #</span>
            <input
              type="text" value={newTsdNumber}
              onChange={(e) => setNewTsdNumber(e.target.value)}
              placeholder="61302" style={{ width: 110 }}
            />
          </label>
          <label className="stack" style={{ gap: 6 }}>
            <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Branch</span>
            <input
              type="text" value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              placeholder="MCO" style={{ width: 90, textTransform: 'uppercase' }}
            />
          </label>
          <label className="stack" style={{ gap: 6 }}>
            <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Ride location</span>
            <select value={newLocationId} onChange={(e) => setNewLocationId(e.target.value)} style={{ minWidth: 220 }}>
              <option value="">Select…</option>
              {rideLocations.map((l) => (
                <option key={l.id} value={l.id}>{l.name || l.code} {l.code ? `(${l.code})` : ''}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="button-subtle" disabled={addBusy}>{addBusy ? 'Adding…' : '+ Add location'}</button>
        </form>
        <div className="ui-muted" style={{ fontSize: 12 }}>
          Import window blank = the platform default{platformDefault
            ? ` (${platformDefault.lookbackDays} back / ${platformDefault.lookaheadDays} ahead)`
            : ''}.
        </div>
        <div className="surface-note" style={NOTE_STYLE}>
          🧭 The <strong>TSD #</strong> and the <strong>Branch</strong> come from the portal&apos;s <code>Loc</code> column, which shows
          them joined as <code>61302.MCO</code> — the part before the dot is the TSD #, the part after is the branch. New locations on
          the Mex side only need a row here — no code changes.
        </div>
      </section>

      {/* ============ 5. SYNC STATUS + RECENT RUNS (AD-2) ============ */}
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
          ⚙️ Runs autonomously (~every 15 minutes) once credentials are saved and at least one location is enabled. Each run makes{' '}
          <strong>two passes</strong> over the portal: the <em>Estimated T&amp;M Summary</em> (every booking, with its class and total —
          the “Found” number below) and the <em>Email Address Report</em>, which is matched onto it by confirmation number.
        </div>

        {/* Mockup design-note 3: set the expectation BEFORE the admin reads the
            numbers, so a sub-100% auto-promoted rate doesn't look like a bug. */}
        <div className="surface-note" style={{ ...NOTE_STYLE, background: 'linear-gradient(180deg, rgba(245,158,11,.10), rgba(245,158,11,.04))', border: '1px solid rgba(245,158,11,.22)' }}>
          📭 <strong>About half of Mex bookings arrive with no customer email</strong> — that is how the source data comes, not a
          fault in the sync. Those still import: Ride creates the customer with a placeholder phone (<code>0000000000</code>) for the
          counter to complete at pickup. This is why <strong>auto-promoted never reaches 100%</strong> of what was found.
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
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>New</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Auto-promoted</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Review</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Duration</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} style={{ padding: 12, color: '#6b7280' }}>Loading…</td></tr>
              ) : runs.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 12, color: '#6b7280' }}>No runs yet</td></tr>
              ) : runs.slice(0, 7).map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid #f0eaff' }}>
                  <td style={{ padding: '8px 10px' }}>{fmtTimestamp(r.startedAt)}</td>
                  <td style={{ padding: '8px 10px' }}><RunStatusCell run={r} /></td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.pickupsFound ?? '-'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.newlyInserted ?? '-'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.autoPromoted ?? '-'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.needsReview ?? '-'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtDuration(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ui-muted" style={{ fontSize: 12 }}>
          A <strong>SESSION_EXPIRED</strong> run is not a failure that needs you: the worker signs back in by itself on the next run
          (that is what “auto-retrying” means).
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
              Reservations that couldn&apos;t be auto-matched (unmapped class, unknown customer) are held in the review tray before they
              become live Ride reservations. Cancelled and no-show bookings never reach it — the sync files them away automatically.
            </p>
          </div>
          <Link href="/reservations" style={{ whiteSpace: 'nowrap', color: '#6d3df2', fontWeight: 700, fontSize: 13 }}>
            Open review tray →
          </Link>
        </div>
        <div className="surface-note" style={NOTE_STYLE}>
          The review tray lives at the top of <strong>Reservations</strong> — the same source-aware tray as Economy, NU and Flexways,
          labeled <strong>“Pending franchise imports — Mex”</strong>. It is not duplicated here.
        </div>
      </section>
    </div>
  );
}

export default MexIntegrationPanel;
