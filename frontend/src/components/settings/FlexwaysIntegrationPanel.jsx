'use client';

/**
 * FlexwaysIntegrationPanel — Settings tab for the Flexways (MobilityPS) franchise
 * reservation sync (Fase 5). Sibling of EconomyIntegrationPanel / NuIntegrationPanel;
 * same components, styling, and API-client pattern, matching
 * doc/flexways-panel-mockup-2026-07-13.html (the approved "autonomous" v2 mockup).
 *
 * KEY DIFFERENCES from NU/Economy:
 *   - MULTI-SEDE grid (like Economy's areas), keyed by the portal's `idSede`
 *     (e.g. 383). Each sede maps to one Ride location + import window + toggle.
 *   - AUTONOMOUS auth: Ride signs in on its own with a real headless login (the
 *     same engine the worker uses). Test connection performs a real login, NOT a
 *     stored-password check. The portal's reCAPTCHA v3 is a passive behavior score
 *     — the headless browser loads the real page and grecaptcha emits its token;
 *     Ride NEVER solves or bypasses a captcha.
 *   - CONNECTION HEALTH card: live status of the autonomous login
 *     ("Connected · auto-login healthy" / "Login failing · <reason> · retrying
 *     automatically" / "Not configured"). "Force re-login" is an emergency-only
 *     button — the worker re-authenticates on its own, so manual re-login is never
 *     the normal mode of operation.
 *   - Optional residential EGRESS PROXY (FLEXWAYS_PROXY_URL) surfaced as a
 *     collapsed advanced/ops setting, mirroring TL International's proxy mitigation.
 *   - ACRISS category-map callout with a mapped/total counter + deep-link.
 *   - Recent runs table adds a Duration column and an inline failure reason
 *     (amber SESSION_EXPIRED — auto-retrying vs red LOGIN_FAILED).
 *
 * Money posture is unchanged: Ride only records estimatedTotal, never charges.
 *
 * English-only UI (matches NU/Economy). SUPER_ADMIN + ADMIN gated by the parent
 * settings page (ADMIN is hard-scoped to its own tenant by the backend's
 * resolveTenantId).
 *
 * Backend contract (mounted at /api/admin/integrations/flexways — same shapes as
 * /api/admin/integrations/nu, clone of nu.routes):
 *   GET   /status                         -> { configured, masterEnabled, integrationEnabled,
 *                                              credential, locations[], lastRun, nextRunAt,
 *                                              health?, acrissMap?, proxyConfigured? }
 *   PUT   /enabled       { enabled }       -> { ok, masterEnabled }
 *   POST  /credentials   { username, password } -> { ok, credentialId, rotatedAt }  (pw never returned)
 *   POST  /test-auth                       -> { ok, status }   (real headless login)
 *   POST  /run-now                         -> { ok, jobId }
 *   GET   /runs?limit=                     -> { runs: [...] }   (each: { status, startedAt,
 *                                              finishedAt|durationMs, pickupsFound, autoPromoted,
 *                                              needsReview, failureReason? }
 *   GET   /locations                       -> { rows: [{ id, externalSede, locationId, enabled,
 *                                              lookbackDays, lookaheadDays, effectiveWindow, location }] }
 *   POST  /locations     { externalSede, locationId, enabled?, lookbackDays?, lookaheadDays? }
 *   PUT   /locations/:id { locationId?, externalSede?, enabled?, lookbackDays?, lookaheadDays? }
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

// Green/red pill matching the mockup + NU/Economy StatusBadge inline styles.
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

// Renders the Recent-runs status cell: SUCCESS (green, optional "(re-login)"),
// SESSION_EXPIRED-class failures amber ("auto-retrying"), other failures red with
// the concrete reason inline.
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
  if (s === 'FAILED' || s === 'ERROR' || s === 'EXPIRED') {
    const sessionExpired = reasonUp.includes('SESSION_EXPIRED') || reasonUp.includes('EXPIRED') || s === 'EXPIRED';
    // Session-expired is non-blocking — the worker re-logs in on its own. Always
    // carry "— auto-retrying" for that case (even when the backend also sent a
    // reason string) so a non-technical admin never reads it as a hard failure.
    return (
      <Pill tone={sessionExpired ? 'amber' : 'red'}>
        FAILED{reason ? ` · ${reason}` : (sessionExpired ? ' · SESSION_EXPIRED' : '')}{sessionExpired ? ' — auto-retrying' : ''}
      </Pill>
    );
  }
  return <Pill tone={statusTone(s)}>{run?.status || '-'}</Pill>;
}

export function FlexwaysIntegrationPanel({ token, me, isSuper, isAdmin, tenantName, activeSettingsTenantId, scopedSettingsPath, onPageMsg }) {
  const [status, setStatus] = useState(null);
  const [runs, setRuns] = useState([]);
  const [locations, setLocations] = useState([]);   // sede config rows
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

  // New-sede form.
  const [newSede, setNewSede] = useState('');
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
        api(scoped('/api/admin/integrations/flexways/status'), { bypassCache: true }, token).catch(() => null),
        api(scoped('/api/admin/integrations/flexways/runs?limit=7'), { bypassCache: true }, token).catch(() => ({ runs: [] })),
        api(scoped('/api/admin/integrations/flexways/locations'), { bypassCache: true }, token).catch(() => ({ rows: [] })),
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
        scoped('/api/admin/integrations/flexways/enabled'),
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
        scoped('/api/admin/integrations/flexways/credentials'),
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
        scoped('/api/admin/integrations/flexways/test-auth'),
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

  // Force re-login = emergency re-authentication. The autonomous worker normally
  // re-authenticates on its own; this discards the stored session and signs in
  // fresh right now via the same real headless login as Test connection.
  const handleForceRelogin = async () => {
    setRelogging(true);
    try {
      const res = await api(
        scoped('/api/admin/integrations/flexways/test-auth'),
        { method: 'POST', body: JSON.stringify({ force: true }) },
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
        scoped('/api/admin/integrations/flexways/run-now'),
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

  // ---- Sede config CRUD ----------------------------------------------------
  const sedeOf = (row) => (row?.externalSede ?? row?.idSede ?? '');

  const handleAddSede = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    const sede = String(newSede || '').trim();
    if (!sede) { flashToast('Enter a sede id (idSede), e.g. 383'); return; }
    if (!newLocationId) { flashToast('Pick a Ride location'); return; }
    setAddBusy(true);
    try {
      const res = await api(
        scoped('/api/admin/integrations/flexways/locations'),
        { method: 'POST', body: JSON.stringify({ externalSede: sede, locationId: newLocationId, enabled: true }) },
        token
      );
      if (res?.ok) {
        flashToast(`Sede ${sede} added`);
        setNewSede('');
        setNewLocationId('');
        await reload();
      } else {
        flashToast(res?.error || 'Could not add sede');
      }
    } catch (err) {
      flashToast(err?.message || 'Could not add sede');
    } finally {
      setAddBusy(false);
    }
  };

  const patchSede = async (id, body) => {
    try {
      const res = await api(
        scoped(`/api/admin/integrations/flexways/locations/${id}`),
        { method: 'PUT', body: JSON.stringify(body) },
        token
      );
      if (res?.ok) { await reload(); }
      else flashToast(res?.error || 'Could not update sede');
    } catch (err) {
      flashToast(err?.message || 'Could not update sede');
    }
  };

  const toggleSede = async (row) => {
    try {
      const res = await api(
        scoped(`/api/admin/integrations/flexways/locations/${row.id}/toggle`),
        { method: 'POST', body: JSON.stringify({ enabled: !row.enabled }) },
        token
      );
      if (res?.ok) await reload();
    } catch (err) {
      flashToast(err?.message || 'Could not toggle sede');
    }
  };

  const removeSede = async (row) => {
    if (typeof window !== 'undefined' && !window.confirm(`Remove sede ${sedeOf(row)}?`)) return;
    try {
      const res = await api(
        scoped(`/api/admin/integrations/flexways/locations/${row.id}`),
        { method: 'DELETE' },
        token
      );
      if (res?.ok) await reload();
    } catch (err) {
      flashToast(err?.message || 'Could not remove sede');
    }
  };

  const configured = !!status?.configured;
  const masterEnabled = !!status?.masterEnabled;
  const lastTestStatus = status?.credential?.lastTestStatus || null;
  const connected = configured && String(lastTestStatus || '').toUpperCase() === 'OK';
  const activeSedes = locations.filter((l) => l.enabled);
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
  // Prefer an explicit health object from the backend; otherwise derive from the
  // credential + last run. The system always retries on its own — copy never says
  // "reconnect manually".
  const health = (() => {
    const h = status?.health || null;
    const lastSuccessAt = h?.lastSuccessAt
      || status?.credential?.lastSuccessAt
      || (String(lastRun?.status || '').toUpperCase() === 'SUCCESS' ? (lastRun?.finishedAt || lastRun?.startedAt) : null)
      || (connected ? status?.credential?.lastTestedAt : null);

    // Explicit state wins.
    const explicit = String(h?.state || '').toLowerCase();
    if (!configured || explicit === 'unconfigured' || explicit === 'not_configured') {
      return {
        kind: 'unconfigured',
        title: 'Not configured',
        meta: 'Add the portal username and password above, then Test connection. Once saved, Ride logs in and syncs on its own.',
        pillTone: 'gray', pillLabel: 'No credentials',
      };
    }

    const lastTestUp = String(lastTestStatus || '').toUpperCase();
    const lastRunUp = String(lastRun?.status || '').toUpperCase();
    const failing = explicit === 'failing'
      || (lastTestUp && lastTestUp !== 'OK')
      || lastRunUp === 'FAILED' || lastRunUp === 'ERROR';

    if (failing) {
      const reason = h?.reason
        || status?.credential?.lastError
        || lastRun?.failureReason
        || 'the automated login was scored too low from the datacenter IP';
      return {
        kind: 'failing',
        title: h?.reasonKind ? `Login failing · ${h.reasonKind}` : 'Login failing · retrying automatically',
        meta: (
          <>
            {lastSuccessAt ? <>Last success <strong>{relativeTime(lastSuccessAt)}</strong> · </> : null}
            {reason} · <strong>retrying automatically</strong> · consider enabling the residential proxy (Advanced → connection routing)
          </>
        ),
        pillTone: 'red', pillLabel: 'Login failing',
      };
    }

    return {
      kind: 'healthy',
      title: 'Connected · auto-login healthy',
      meta: (
        <>
          {lastSuccessAt ? <>Last successful login <strong>{relativeTime(lastSuccessAt)}</strong> · </> : null}
          session valid · worker re-authenticates automatically when it expires
        </>
      ),
      pillTone: 'green', pillLabel: 'Healthy',
    };
  })();

  const healthStrip = (() => {
    if (health.kind === 'healthy') {
      return { border: '1.5px solid #bbf1d2', background: 'linear-gradient(180deg,#f2fdf6,#e9fbf1)', dot: '#22c55e', dotGlow: 'rgba(34,197,94,.16)', title: '#14532d', meta: '#4d6b57' };
    }
    if (health.kind === 'failing') {
      return { border: '1.5px solid #f7c6c6', background: 'linear-gradient(180deg,#fef4f4,#fdeaea)', dot: '#ef4444', dotGlow: 'rgba(239,68,68,.14)', title: '#7f1d1d', meta: '#8d5050' };
    }
    return { border: '1.5px solid #d7cbff', background: 'linear-gradient(180deg,#faf8ff,#f4f0ff)', dot: '#a99bd6', dotGlow: 'rgba(135,82,254,.12)', title: '#3b2e63', meta: '#7c6bb0' };
  })();

  // ---- ACRISS category map (defensive: backend may not send it yet) --------
  const acriss = status?.acrissMap || status?.categoryMap || null;
  const acrissMapped = Number.isFinite(Number(acriss?.mapped)) ? Number(acriss.mapped) : null;
  const acrissTotal = Number.isFinite(Number(acriss?.total)) ? Number(acriss.total) : null;
  // Only surface the deep-link when the backend gives a REAL category-map
  // destination — there's no ACRISS map UI yet, so the old self-referential
  // fallback to this same page was a dead-end. Hide the link until href exists.
  const acrissHref = acriss?.href || null;
  const acrissZero = acrissMapped === 0 && (acrissTotal == null || acrissTotal > 0) && activeSedes.length > 0;

  const proxyConfigured = !!status?.proxyConfigured;

  return (
    <div className="stack" style={{ gap: 20 }}>
      {toast ? (
        <div style={{ padding: 10, background: '#ecfdf5', border: '1px solid #10b981', borderRadius: 6, color: '#065f46' }}>{toast}</div>
      ) : null}
      {loadError ? (
        <div style={{ padding: 10, background: '#fee2e2', border: '1px solid #ef4444', borderRadius: 6, color: '#991b1b' }}>{loadError}</div>
      ) : null}

      {/* ============ 1. HEADER + MASTER TOGGLE ============ */}
      <section className="glass card section-card">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <div className="eyebrow" style={{ color: '#6d3df2', fontWeight: 800, fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' }}>
              Booking source integration
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0 }}>
                Flexways <span style={{ fontWeight: 600, color: '#6f668f', fontSize: 15 }}>(MobilityPS)</span>
              </h2>
              {/* Derive the header pill from the SAME live `health` object as the
                  Connection health card — not the stale manual-test status — so a
                  failed scheduled run can never show green "Connected" up here
                  while the card below shows red "Login failing". (GD 2026-07-13) */}
              <Pill tone={health.pillTone}>{health.kind === 'healthy' ? 'Connected' : (health.kind === 'failing' ? 'Login failing' : (configured ? 'Untested' : 'Not configured'))}</Pill>
              {tenantName ? <Pill tone="gray">{tenantName}</Pill> : null}
            </div>
            <p className="ui-muted">
              Imports reservations from the Flexways / MobilityPS portal into Ride. <strong>Runs autonomously once configured</strong> —
              the sync worker signs in on its own and re-logs in when the session expires. Reservations arrive as{' '}
              <span style={{ background: 'rgba(135,82,254,.15)', color: '#5a2fca', border: '1px solid rgba(135,82,254,.22)', padding: '1px 7px', borderRadius: 999, fontSize: 11, fontWeight: 600, display: 'inline-block' }}>
                Franchise import · FW-
              </span>{' '}
              and go through the same review tray as Economy and NU.
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
            <strong><Pill tone={health.pillTone}>{health.kind === 'healthy' ? 'Connected' : (health.kind === 'failing' ? 'Login failing' : 'Not configured')}</Pill></strong>
            <span className="ui-muted" style={{ fontSize: 12 }}>{health.kind === 'healthy' ? 'auto-login healthy' : (health.kind === 'failing' ? 'retrying automatically' : 'add credentials')}</span>
          </div>
          <div className="info-tile">
            <span className="label">Sedes active</span>
            <strong>{activeSedes.length} of {locations.length}</strong>
            <span className="ui-muted" style={{ fontSize: 12 }}>
              {activeSedes.map((a) => (a.location?.name || a.location?.code || sedeOf(a))).join(', ') || '-'}
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
            The autonomous scheduler is currently <strong>off</strong> platform-wide (FLEXWAYS_INTEGRATION_ENABLED). You can configure everything now; scheduled runs start when it is enabled. Use <strong>Run sync now</strong> to sync on demand.
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
          The Flexways portal (<code>system.mobilityps.com</code>) uses a <strong>username + password</strong> login. Ride signs in on its own with these; stored <strong>encrypted (AES-256-GCM)</strong> and never shown again after saving.
        </p>

        <form onSubmit={handleSaveCreds} className="stack" style={{ gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 14 }}>
            <label className="stack" style={{ gap: 6 }}>
              <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Username</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="corpusa.orl"
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
          🔐 Encrypted at rest with AES-256-GCM. <strong>Test connection runs a real headless login</strong> against the portal (the same engine the worker uses) and reports the actual result — it does not just check that a password is stored. The portal's reCAPTCHA v3 is a passive, behavior-based score: the headless browser loads the real login page and the page's own <code>grecaptcha</code> emits its token; Ride <strong>never solves or bypasses a captcha</strong>.
        </div>

        <details style={{ border: '1px solid #e6dfff', borderRadius: 12, background: 'rgba(255,255,255,.6)', marginTop: 4, padding: '10px 14px' }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#56526b' }}>
            Advanced · connection routing (rarely needed)
          </summary>
          <div style={{ padding: '12px 2px 4px', color: '#6f668f', fontSize: 13, lineHeight: 1.6 }}>
            <strong>Egress proxy</strong> — if the automated login is scored low from the datacenter IP (bot-score), route Flexways
            traffic through a residential proxy, the same mitigation TL International uses (<code>TL_INTERNATIONAL_PROXY_URL</code>).
            This is a platform/ops setting (<code>FLEXWAYS_PROXY_URL</code>), <strong>not a day-to-day action</strong> — left unset,
            Ride egresses from the droplet. {' '}
            <Pill tone={proxyConfigured ? 'green' : 'gray'}>{proxyConfigured ? 'Proxy: configured' : 'Proxy: not set'}</Pill>
          </div>
        </details>
      </section>

      {/* ============ 3. CONNECTION HEALTH ============ */}
      <section className="glass card section-card" style={{ borderLeft: '4px solid var(--brand-purple, #8752FE)' }}>
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Connection health</h3>
          <button type="button" className="subtle" disabled={relogging || !configured} onClick={handleForceRelogin} title="Emergency only — the worker re-authenticates on its own">
            {relogging ? 'Re-logging in…' : 'Force re-login'}
          </button>
        </div>
        <p className="ui-muted">Live status of the autonomous login. Ride re-logs in on its own — you don't manage the session.</p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, border: healthStrip.border, background: healthStrip.background, borderRadius: 16, padding: '14px 18px', flexWrap: 'wrap', marginTop: 4 }}>
          <span style={{ width: 12, height: 12, borderRadius: 999, background: healthStrip.dot, boxShadow: `0 0 0 5px ${healthStrip.dotGlow}`, flex: 'none' }} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 850, color: healthStrip.title, fontSize: 14.5 }}>{health.title}</div>
            <div style={{ fontSize: 12.5, color: healthStrip.meta }}>{health.meta}</div>
          </div>
          <Pill tone={health.pillTone}>{health.pillLabel}</Pill>
        </div>

        <div className="surface-note" style={NOTE_STYLE}>
          🔁 If a login fails (low bot-score, portal down, expired session), the worker <strong>retries on its own</strong> with backoff and re-authenticates on the next run — no manual step. <strong>Force re-login</strong> is an emergency button that discards the stored session and signs in fresh right now; you should rarely need it.
        </div>
      </section>

      {/* ============ 4. WHICH RESERVATIONS TO WATCH (SEDES GRID) ============ */}
      <section className="glass card section-card">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <h3 style={{ margin: 0 }}>Which reservations to watch</h3>
            <p className="ui-muted">
              Flexways organizes inventory by <strong>sede</strong> (branch). Map each portal sede (<code>idSede</code>) to a Ride location and set its import window. Only enabled sedes are imported.
            </p>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #f0eaff' }}>
                <th style={{ padding: '8px 10px' }}>Sede (portal)</th>
                <th></th>
                <th style={{ padding: '8px 10px' }}>Ride location</th>
                <th style={{ padding: '8px 10px' }}>Import window (days)</th>
                <th style={{ padding: '8px 10px', textAlign: 'center' }}>Import</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {locations.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 12, color: '#6b7280' }}>No sedes configured yet. Add one below.</td></tr>
              ) : locations.map((row) => (
                <tr key={row.id} style={{ borderBottom: '1px solid #f0eaff', opacity: row.enabled ? 1 : 0.6 }}>
                  <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                    <code>{sedeOf(row)}</code>
                    {row.location?.name ? <span className="ui-muted" style={{ fontSize: 12, marginLeft: 6 }}>{row.location.name}</span> : null}
                  </td>
                  <td className="ui-muted">→</td>
                  <td style={{ padding: '8px 10px' }}>
                    <select
                      value={row.locationId || ''}
                      onChange={(e) => patchSede(row.id, { locationId: e.target.value })}
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
                          if ((row.lookbackDays ?? null) !== v) patchSede(row.id, { lookbackDays: v });
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
                          if ((row.lookaheadDays ?? null) !== v) patchSede(row.id, { lookaheadDays: v });
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
                        aria-label={`Import sede ${sedeOf(row)} reservations`}
                        className="switch"
                        onClick={() => toggleSede(row)}
                        title={row.enabled ? 'Importing — click to pause' : 'Paused — click to import'}
                      />
                    </div>
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    <button type="button" className="ghost" style={{ color: '#991b1b' }} onClick={() => removeSede(row)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Add sede */}
        <form onSubmit={handleAddSede} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', borderTop: '1px solid #f0eaff', paddingTop: 14, marginTop: 4 }}>
          <label className="stack" style={{ gap: 6 }}>
            <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>Sede id (idSede)</span>
            <input
              type="text" value={newSede}
              onChange={(e) => setNewSede(e.target.value)}
              placeholder="383" style={{ width: 110 }}
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
          <button type="submit" className="subtle" disabled={addBusy}>{addBusy ? 'Adding…' : '+ Add sede'}</button>
        </form>
        <div className="ui-muted" style={{ fontSize: 12 }}>
          Import window blank = the platform default{platformDefault
            ? ` (${platformDefault.lookbackDays} back / ${platformDefault.lookaheadDays} ahead)`
            : ''}. Dates in the portal are DD/MM/YYYY (LATAM) — Ride converts on import.
        </div>
        <div className="surface-note" style={NOTE_STYLE}>
          🧭 The <strong>idSede</strong> comes from the portal URL (e.g. <code>idSede=383</code>). New sedes added on the Flexways side just need a new row here — no code changes.
        </div>
      </section>

      {/* ============ 5. SYNC STATUS + RECENT RUNS ============ */}
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
          ⚙️ Runs autonomously (~every 15 minutes) once credentials are saved and at least one sede is enabled. The worker signs in headlessly, pulls the Flexways reservations grid for each sede's date window, and re-authenticates by itself when the session lapses. Use <strong>Run sync now</strong> only if you need the latest reservations immediately.
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
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Duration</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Found</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Imported</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Review</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} style={{ padding: 12, color: '#6b7280' }}>Loading…</td></tr>
              ) : runs.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 12, color: '#6b7280' }}>No runs yet</td></tr>
              ) : runs.slice(0, 7).map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid #f0eaff' }}>
                  <td style={{ padding: '8px 10px' }}>{fmtTimestamp(r.startedAt)}</td>
                  <td style={{ padding: '8px 10px' }}><RunStatusCell run={r} /></td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtDuration(r)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.pickupsFound ?? '-'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.autoPromoted ?? '-'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.needsReview ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ============ 6. SEED ACRISS MAP CALLOUT ============ */}
      <section className="glass card section-card" style={{ borderLeft: `4px solid ${acrissZero ? '#f59e0b' : 'var(--brand-purple, #8752FE)'}` }}>
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <h3 style={{ margin: 0 }}>Before the first sync: seed the class map</h3>
            <p className="ui-muted">
              Imported reservations are matched to Ride vehicle classes through the <strong>ACRISS category map</strong>. If the map is empty, every reservation lands in manual review. Seed it once per tenant before enabling sedes.
            </p>
          </div>
          {/* Only render the Link when we have a REAL destination. next/link's
              formatUrl destructures the href — <Link href={null}> throws
              "Cannot destructure property 'auth' from null" and crashes the
              whole /settings page (there's no ACRISS-map route yet). */}
          {acrissHref ? (
            <Link href={acrissHref} style={{ whiteSpace: 'nowrap', color: '#6d3df2', fontWeight: 700, fontSize: 13 }}>
              Open category map →
            </Link>
          ) : null}
        </div>
        <div className="surface-note" style={NOTE_STYLE}>
          🗺️ <strong>{acrissMapped == null ? '—' : acrissMapped} of {acrissTotal == null ? '—' : acrissTotal}</strong> Flexways class codes mapped for this tenant. The panel shows mapped / total so you can see coverage at a glance{acrissZero ? ' — seed the map before the first run to avoid a review backlog.' : '.'}
        </div>
      </section>

      {/* ============ 7. PENDING IMPORTS POINTER ============ */}
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
              Reservations that couldn't be auto-matched (unmapped class, unknown customer) are held in the review tray before they become live Ride reservations.
            </p>
          </div>
          <Link href="/reservations" style={{ whiteSpace: 'nowrap', color: '#6d3df2', fontWeight: 700, fontSize: 13 }}>
            Open review tray →
          </Link>
        </div>
        <div className="surface-note" style={NOTE_STYLE}>
          The review tray lives at the top of <strong>Reservations</strong> — same source-aware tray as Economy and NU, labeled <strong>“Pending franchise imports — Flexways”</strong>. It is not duplicated here.
        </div>
      </section>
    </div>
  );
}

export default FlexwaysIntegrationPanel;
