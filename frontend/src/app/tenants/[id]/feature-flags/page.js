'use client';

/**
 * Per-tenant feature-flag admin UI (2026-05-21).
 *
 * Lists every flag known for a tenant + 3 radio buttons per flag
 * (OFF / TEST / LIVE). PATCH persists. Audit history table below.
 *
 * SUPER_ADMIN only — non-super-admins shouldn't see this in the nav, and
 * the backend rejects PATCH/GET attempts from anyone else.
 *
 * Backend: see `doc/feature-flag-convention.md`.
 */

import { useEffect, useState, useMemo } from 'react';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';
import { invalidateFeatureFlags } from '../../../../hooks/useFeatureFlags';

// Flags we know about. The backend stores anything in tenant.settingsJson.featureFlags
// but the UI surfaces these explicitly so admins see a stable, documented list.
const KNOWN_FLAGS = [
  {
    name: 'interactiveTC',
    label: 'Interactive T&C signing',
    description:
      'Structured per-field T&C signing flow (initials + signature + checkbox + date + text). Required by Dejavoo terminal flow.',
  },
  {
    name: 'dejavooCounter',
    label: 'Dejavoo P1 counter terminal',
    description:
      'In-person counter checkin + return on the Dejavoo P1 hardware terminal. Requires Interactive T&C to be ON for the full flow.',
  },
];

const STATES = ['OFF', 'TEST', 'LIVE'];

const STATE_BADGE_CLASS = {
  OFF: 'status-chip',
  TEST: 'status-chip warn',
  LIVE: 'status-chip good',
};

const STATE_DESCRIPTION = {
  OFF: 'Legacy flow for everyone at this tenant (default).',
  TEST: 'New flow visible only to SUPER_ADMIN users — agents still see legacy.',
  LIVE: 'New flow active for ALL agents at this tenant.',
};

export default function TenantFeatureFlagsPage({ params }) {
  return (
    <AuthGate>
      {({ token, me, logout }) => (
        <Inner tenantId={params?.id} token={token} me={me} logout={logout} />
      )}
    </AuthGate>
  );
}

function Inner({ tenantId, token, me, logout }) {
  const [flags, setFlags] = useState({});
  const [audit, setAudit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState('');
  const [confirmFlag, setConfirmFlag] = useState(null); // { name, from, to }

  const isSuperAdmin = useMemo(() => {
    const role = String(me?.role || '').toUpperCase();
    return role === 'SUPER_ADMIN';
  }, [me]);

  const load = async () => {
    setError('');
    setLoading(true);
    try {
      const out = await api(`/api/admin/tenants/${tenantId}/feature-flags`, {}, token);
      setFlags(out?.flags || {});
      setAudit(out?.audit || []);
    } catch (e) {
      setError(e.message || 'Failed to load feature flags');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tenantId && token) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, token]);

  const requestChange = (name, to) => {
    const from = flags[name] || 'OFF';
    if (from === to) return;
    // LIVE always confirms; OFF/TEST can apply directly (still logged)
    if (to === 'LIVE') {
      setConfirmFlag({ name, from, to });
    } else {
      applyChange(name, to);
    }
  };

  const applyChange = async (name, to) => {
    setSaving(name);
    setError('');
    try {
      await api(
        `/api/admin/tenants/${tenantId}/feature-flags`,
        { method: 'PATCH', body: JSON.stringify({ [name]: to }) },
        token
      );
      invalidateFeatureFlags(); // so the rest of the app picks up the new state
      await load();
    } catch (e) {
      setError(e.message || 'Failed to update flag');
    } finally {
      setSaving(null);
      setConfirmFlag(null);
    }
  };

  if (!isSuperAdmin) {
    return (
      <AppShell me={me} logout={logout}>
        <section className="glass card-lg stack">
          <h2>Forbidden</h2>
          <p className="ui-muted">
            Only SUPER_ADMIN users can manage tenant feature flags.
          </p>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="row-between">
          <div className="stack" style={{ gap: 4 }}>
            <span className="eyebrow">Admin · Feature Flags</span>
            <h2 style={{ margin: 0 }}>Tenant feature flags</h2>
            <p className="ui-muted" style={{ marginTop: 4, marginBottom: 0 }}>
              Tenant: <code>{tenantId}</code>
            </p>
          </div>
          <button className="btn" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {error && <div className="app-banner danger">{error}</div>}

        <div className="stack" style={{ gap: 16 }}>
          {KNOWN_FLAGS.map((f) => {
            const current = flags[f.name] || 'OFF';
            return (
              <div key={f.name} className="card stack" style={{ gap: 12, padding: 16 }}>
                <div className="row-between">
                  <div className="stack" style={{ gap: 4 }}>
                    <h3 style={{ margin: 0 }}>
                      {f.label}{' '}
                      <code style={{ fontSize: '0.8em', opacity: 0.6 }}>{f.name}</code>
                    </h3>
                    <p className="ui-muted" style={{ margin: 0 }}>
                      {f.description}
                    </p>
                  </div>
                  <span className={STATE_BADGE_CLASS[current]}>{current}</span>
                </div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {STATES.map((s) => {
                    const active = current === s;
                    return (
                      <label
                        key={s}
                        className={`pill ${active ? 'pill-active' : ''}`}
                        style={{
                          cursor: saving === f.name ? 'not-allowed' : 'pointer',
                          opacity: saving === f.name ? 0.5 : 1,
                          padding: '8px 14px',
                          borderRadius: 999,
                          border: '1px solid var(--color-border, #ccc)',
                          background: active ? 'var(--color-accent, #2563eb)' : 'transparent',
                          color: active ? 'white' : 'inherit',
                          display: 'inline-flex',
                          gap: 6,
                          alignItems: 'center',
                        }}
                      >
                        <input
                          type="radio"
                          name={`flag-${f.name}`}
                          value={s}
                          checked={active}
                          disabled={saving === f.name}
                          onChange={() => requestChange(f.name, s)}
                          style={{ display: 'none' }}
                        />
                        {s}
                      </label>
                    );
                  })}
                </div>
                <p className="ui-muted" style={{ margin: 0, fontSize: '0.9em' }}>
                  {STATE_DESCRIPTION[current]}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Audit history */}
      <section className="glass card-lg stack" style={{ marginTop: 24 }}>
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Audit history</h3>
          <span className="ui-muted" style={{ fontSize: '0.9em' }}>
            Last {audit.length} change{audit.length === 1 ? '' : 's'}
          </span>
        </div>
        {audit.length === 0 ? (
          <p className="ui-muted">No changes recorded yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 8 }}>When</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Actor</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Flag</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>From → To</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((row) => {
                  const payload = row.payload || {};
                  return (
                    <tr key={row.id} style={{ borderTop: '1px solid var(--color-border, #eee)' }}>
                      <td style={{ padding: 8, fontSize: '0.9em' }}>
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td style={{ padding: 8 }}>
                        {row.actorUser?.fullName || row.actorUser?.email || row.actorUserId || '—'}
                      </td>
                      <td style={{ padding: 8 }}>
                        <code>{payload.flag || row.resource}</code>
                      </td>
                      <td style={{ padding: 8 }}>
                        <span className={STATE_BADGE_CLASS[payload.from] || 'status-chip'}>
                          {payload.from || '—'}
                        </span>
                        {' → '}
                        <span className={STATE_BADGE_CLASS[payload.to] || 'status-chip'}>
                          {payload.to || '—'}
                        </span>
                        {payload.noop && (
                          <span
                            className="ui-muted"
                            style={{ marginLeft: 8, fontSize: '0.85em' }}
                          >
                            (no-op — same state)
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* LIVE confirmation dialog */}
      {confirmFlag && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div className="card-lg" style={{ maxWidth: 480, padding: 24, background: 'white' }}>
            <h3 style={{ marginTop: 0 }}>Activate for ALL agents?</h3>
            <p>
              You&apos;re about to flip <code>{confirmFlag.name}</code> from{' '}
              <strong>{confirmFlag.from}</strong> to <strong>LIVE</strong>. All agents
              at this tenant will start seeing the new flow on their next checkout.
            </p>
            <p className="ui-muted">
              You can flip it back to <strong>OFF</strong> at any time and every
              subsequent checkin returns to the legacy flow within seconds.
            </p>
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn ghost" onClick={() => setConfirmFlag(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => applyChange(confirmFlag.name, confirmFlag.to)}
                disabled={saving === confirmFlag.name}
              >
                {saving === confirmFlag.name ? 'Activating…' : 'Activate LIVE'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
