'use client';

/**
 * TLIntegrationPanel - Settings tab for the TL International franchise
 * reservation sync (round 5 - task 24 phase 1, frontend Surface 1).
 *
 * English-only UI. SUPER_ADMIN + ADMIN gated by the parent settings page;
 * this component renders a friendly notice if a lower role slips through.
 * (Opened to ADMIN on 2026-05-26 — ADMIN is hard-scoped to their own tenant
 * by the backend's resolveTenantId.)
 *
 * Backend contract (mounted at /api/admin/integrations/tl-international):
 *   POST /cookie            { cookie } -> { ok, lastTestedAt, lastTestStatus }
 *   POST /test-auth         (no body)  -> { ok, lastTestedAt, lastTestStatus }
 *   POST /run-now                       -> { ok, jobId }
 *   GET  /runs?limit=7                  -> { runs: [...] }
 *   GET  /status                        -> { enabled, cookie, nextRunAt, lastRun }
 *
 * Super-admins editing another tenant's config get `?tenantId=` appended
 * via the parent's `scopedSettingsPath` helper.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '../../lib/client';

function relativeTime(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleString();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function fmtTimestamp(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function StatusBadge({ status }) {
  const s = String(status || '').toUpperCase();
  if (s === 'SUCCESS' || s === 'OK' || s === 'CONNECTED') {
    return <span style={{ background: '#dcfce7', color: '#166534', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>Connected</span>;
  }
  if (s === 'FAILED' || s === 'ERROR' || s === 'EXPIRED') {
    return <span style={{ background: '#fee2e2', color: '#991b1b', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>Cookie expired</span>;
  }
  if (s === 'PARTIAL') {
    return <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>Partial</span>;
  }
  return <span style={{ background: '#e5e7eb', color: '#374151', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{status || 'Untested'}</span>;
}

export function TLIntegrationPanel({ token, me, isSuper, isAdmin, activeSettingsTenantId, scopedSettingsPath, onPageMsg }) {
  const [status, setStatus] = useState(null);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [cookie, setCookie] = useState('');
  const [showCookie, setShowCookie] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [runNowBusy, setRunNowBusy] = useState(false);
  const [toast, setToast] = useState('');

  // Fallback for callers that haven't been updated to pass `isAdmin` yet.
  const canAccess = isAdmin ?? (isSuper || String(me?.role || '').toUpperCase() === 'ADMIN');

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
      const [s, r] = await Promise.all([
        api(scopedSettingsPath('/api/admin/integrations/tl-international/status'), { bypassCache: true }, token).catch(() => null),
        api(scopedSettingsPath('/api/admin/integrations/tl-international/runs?limit=7'), { bypassCache: true }, token).catch(() => ({ runs: [] }))
      ]);
      setStatus(s || null);
      setRuns(Array.isArray(r?.runs) ? r.runs : []);
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

  const handleSaveCookie = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    const trimmed = String(cookie || '').trim();
    if (!trimmed) {
      flashToast('Paste the cookie before saving');
      return;
    }
    setSaving(true);
    try {
      const res = await api(
        scopedSettingsPath('/api/admin/integrations/tl-international/cookie'),
        { method: 'POST', body: JSON.stringify({ cookie: trimmed }) },
        token
      );
      if (res?.ok) {
        flashToast('Cookie saved and tested');
        setCookie('');
        await reload();
      } else {
        flashToast('Cookie saved but test failed');
        await reload();
      }
    } catch (err) {
      flashToast(err?.message || 'Could not save cookie');
    } finally {
      setSaving(false);
    }
  };

  const handleTestAuth = async () => {
    setTesting(true);
    try {
      const res = await api(
        scopedSettingsPath('/api/admin/integrations/tl-international/test-auth'),
        { method: 'POST' },
        token
      );
      flashToast(res?.ok ? 'Connection OK' : 'Connection failed');
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
        scopedSettingsPath('/api/admin/integrations/tl-international/run-now'),
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

  const lastTestStatus = status?.cookie?.lastTestStatus || (runs[0]?.status === 'SUCCESS' ? 'CONNECTED' : 'UNKNOWN');
  const cookieExpired = String(lastTestStatus).toUpperCase() === 'FAILED' || String(lastTestStatus).toUpperCase() === 'EXPIRED';

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row-between" style={{ alignItems: 'start' }}>
        <div>
          <h2 style={{ marginBottom: 4 }}>TL International - Reservation sync</h2>
          <p className="ui-muted">Imports franchise reservations from TL into RideFleet.</p>
        </div>
        <span className="status-chip neutral">Integration</span>
      </div>

      {toast ? (
        <div style={{ padding: 10, background: '#ecfdf5', border: '1px solid #10b981', borderRadius: 6, color: '#065f46' }}>{toast}</div>
      ) : null}

      {loadError ? (
        <div style={{ padding: 10, background: '#fee2e2', border: '1px solid #ef4444', borderRadius: 6, color: '#991b1b' }}>{loadError}</div>
      ) : null}

      {cookieExpired ? (
        <div style={{ padding: 12, background: '#fee2e2', border: '1px solid #ef4444', borderRadius: 6 }}>
          <strong style={{ color: '#991b1b' }}>Cookie expired.</strong>
          <div style={{ color: '#7f1d1d', marginTop: 4 }}>Sync is paused until you rotate a fresh cookie.</div>
        </div>
      ) : null}

      <section className="glass card section-card" style={{ padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>Connection health</h3>
        <div className="app-card-grid compact" style={{ marginTop: 8 }}>
          <div className="info-tile">
            <span className="label">Status</span>
            <strong><StatusBadge status={cookieExpired ? 'EXPIRED' : (status?.enabled ? lastTestStatus : 'PAUSED')} /></strong>
          </div>
          <div className="info-tile">
            <span className="label">Last tested</span>
            <strong>{relativeTime(status?.cookie?.lastTestedAt)}</strong>
            <span className="ui-muted">{fmtTimestamp(status?.cookie?.lastTestedAt)}</span>
          </div>
          <div className="info-tile">
            <span className="label">Next run</span>
            <strong>{status?.nextRunAt ? fmtTimestamp(status.nextRunAt) : '-'}</strong>
          </div>
          <div className="info-tile">
            <span className="label">Enabled</span>
            <strong>{status?.enabled ? 'Yes' : 'No'}</strong>
            <span className="ui-muted">Change in Tenant.integrationConfig (TODO)</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="button" disabled={testing || loading} onClick={handleTestAuth}>
            {testing ? 'Testing...' : 'Test connection'}
          </button>
          <button type="button" disabled={runNowBusy || loading} onClick={handleRunNow}>
            {runNowBusy ? 'Queuing...' : 'Run now'}
          </button>
        </div>
      </section>

      <section className="glass card section-card" style={{ padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>Rotate cookie</h3>
        <p className="ui-muted">
          Paste the full Cookie header from an active TL International browser session. Encrypted before storage and tested immediately.
        </p>
        <form onSubmit={handleSaveCookie} className="stack" style={{ gap: 10 }}>
          <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            Cookie header
            <textarea
              rows={4}
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              placeholder="ASP.NET_SessionId=abc123; .ASPXAUTH=..."
              style={{
                width: '100%',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 12,
                WebkitTextSecurity: showCookie ? 'none' : 'disc',
                color: showCookie ? 'inherit' : 'transparent',
                textShadow: showCookie ? 'none' : '0 0 6px rgba(0,0,0,0.5)'
              }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
              <input type="checkbox" checked={showCookie} onChange={(e) => setShowCookie(e.target.checked)} />
              {' '}Show
            </label>
            <button type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save & test'}
            </button>
            <a
              href="https://intranet.tlinternational.com/help/cookies"
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 13, color: '#2563eb' }}
            >
              How to get it?
            </a>
          </div>
        </form>
        <div className="ui-muted" style={{ marginTop: 8, fontSize: 13 }}>
          Last rotated: <strong>{relativeTime(status?.cookie?.rotatedAt)}</strong>
        </div>
      </section>

      <section className="glass card section-card" style={{ padding: 16 }}>
        <div className="row-between" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Recent runs</h3>
          <Link
            href="/settings/integrations/tl-international/runs"
            style={{ fontSize: 13, color: '#2563eb' }}
          >
            View full history -&gt;
          </Link>
        </div>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>When</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Found</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>New</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Errors</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} style={{ padding: 8, color: '#6b7280' }}>Loading...</td></tr>
              ) : runs.length === 0 ? (
                <tr><td colSpan={5} style={{ padding: 8, color: '#6b7280' }}>No runs yet</td></tr>
              ) : (
                runs.slice(0, 7).map((r) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '6px 8px' }}>{fmtTimestamp(r.startedAt || r.createdAt)}</td>
                    <td style={{ padding: '6px 8px' }}><StatusBadge status={r.status} /></td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.pickupsFound ?? '-'}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.newlyInserted ?? r.inserted ?? '-'}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.errors ?? r.errorCount ?? 0}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default TLIntegrationPanel;
