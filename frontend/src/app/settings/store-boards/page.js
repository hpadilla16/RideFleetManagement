'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';

/**
 * Admin page to mint and manage Action Board kiosk tokens.
 *
 * Each row is one TV display in a store. The admin picks a Location and
 * gives it a label, mints, copies the URL, and sets the TV's home page to
 * that URL. Revoke when a TV is decommissioned or replaced.
 *
 * `lastSeenAt` lets the admin spot a TV that's offline (kiosk hasn't
 * polled in a while). Useful when employees say "the board isn't
 * updating" — admin can see at a glance whether the kiosk lost its
 * connection.
 *
 * Multi-tenant handling:
 *   - Tenant-scoped admins (ADMIN/OPS) see their own tenant only — no
 *     picker; the JWT scopes everything.
 *   - SUPER_ADMIN gets a tenant picker because the backend refuses to
 *     mint kiosk tokens "in the void". Picking a tenant rebuilds the page
 *     and re-fetches that tenant's locations + tokens.
 */
export default function StoreBoardsAdminPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const isSuperAdmin = String(me?.role || '').toUpperCase() === 'SUPER_ADMIN';

  const [tenants, setTenants] = useState([]);
  // Tenant context. Non-super-admins are pinned to their own tenant; the
  // backend reads it from the JWT, so we don't actually need to send it
  // back, but tracking it here keeps the codepath uniform.
  const [activeTenantId, setActiveTenantId] = useState(() => (isSuperAdmin ? '' : (me?.tenantId || '')));

  const [tokens, setTokens] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [includeRevoked, setIncludeRevoked] = useState(false);

  // Mint form state
  const [formLocationId, setFormLocationId] = useState('');
  const [formLabel, setFormLabel] = useState('');
  const [formBusy, setFormBusy] = useState(false);

  // Last-minted token banner (shown once so admin can copy the URL)
  const [justMinted, setJustMinted] = useState(null);

  // Load tenants if SUPER_ADMIN — needed to populate the picker.
  useEffect(() => {
    if (!isSuperAdmin) return;
    (async () => {
      try {
        const rows = await api('/api/tenants');
        const list = Array.isArray(rows) ? rows : (rows?.items || []);
        setTenants(list);
      } catch (e) {
        setMsg(`Could not load tenants: ${e?.message || e}`);
      }
    })();
  }, [isSuperAdmin]);

  // Build the `?tenantId=...` query string suffix to pass on every API
  // call. SUPER_ADMIN has to send it explicitly; tenant-scoped admins can
  // omit it since the backend reads it from their JWT.
  const tenantQuery = useMemo(() => {
    if (isSuperAdmin && activeTenantId) return `?tenantId=${encodeURIComponent(activeTenantId)}`;
    return '';
  }, [isSuperAdmin, activeTenantId]);

  // Append tenantId onto an arbitrary URL while preserving any existing
  // query string. Centralized so we don't sprinkle ad-hoc joiners around.
  const withTenant = (url, extra = '') => {
    const sep = url.includes('?') ? '&' : '?';
    const tParam = isSuperAdmin && activeTenantId ? `${sep}tenantId=${encodeURIComponent(activeTenantId)}` : '';
    return `${url}${tParam}${extra ? `${tParam ? '&' : sep}${extra}` : ''}`;
  };

  const refresh = async () => {
    // SUPER_ADMIN must pick a tenant first; without it the backend refuses
    // and we'd just spam errors.
    if (isSuperAdmin && !activeTenantId) {
      setTokens([]);
      setLocations([]);
      return;
    }
    setLoading(true);
    setMsg('');
    try {
      const tokRows = await api(withTenant('/api/store-board/tokens', includeRevoked ? 'includeRevoked=true' : ''));
      const locRows = await api(withTenant('/api/locations'));
      setTokens(Array.isArray(tokRows) ? tokRows : []);
      setLocations(Array.isArray(locRows) ? locRows : []);
    } catch (e) {
      setMsg(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, includeRevoked, activeTenantId]);

  // Sentry HIGH on PR #45: when SUPER_ADMIN switches tenants, the old
  // formLocationId stays selected. Submitting then would mint against
  // tenant B with a location ID that belongs to tenant A — backend would
  // 404 (defense in depth check) but only after the user clicked. Clearing
  // it on tenant change keeps the picker honest. Form label is also
  // cleared since labels are typically tenant-specific ("Carolina Front
  // Counter" doesn't belong on a different tenant).
  useEffect(() => {
    setFormLocationId('');
    setFormLabel('');
    setJustMinted(null);
  }, [activeTenantId]);

  const submitMint = async (e) => {
    e?.preventDefault?.();
    if (isSuperAdmin && !activeTenantId) { setMsg('Pick a tenant first'); return; }
    if (!formLocationId) { setMsg('Pick a location'); return; }
    if (!formLabel.trim()) { setMsg('Add a label'); return; }
    setFormBusy(true);
    setMsg('');
    try {
      const row = await api(withTenant('/api/store-board/tokens'), {
        method: 'POST',
        body: JSON.stringify({ locationId: formLocationId, label: formLabel.trim() })
      });
      setJustMinted(row);
      setFormLabel('');
      // Don't reset locationId — admin probably mints multiple tokens for
      // the same store (one per TV).
      await refresh();
    } catch (e) {
      setMsg(e?.message || String(e));
    } finally {
      setFormBusy(false);
    }
  };

  const handleRevoke = async (row) => {
    if (!window.confirm(`Revoke "${row.label}"? The TV using this token will stop receiving updates immediately.`)) return;
    try {
      await api(withTenant(`/api/store-board/tokens/${row.id}/revoke`), { method: 'POST', body: JSON.stringify({}) });
      setMsg(`Revoked "${row.label}"`);
      await refresh();
    } catch (e) {
      setMsg(e?.message || String(e));
    }
  };

  const buildKioskUrl = (token) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/store-board?token=${encodeURIComponent(token)}`;
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setMsg('URL copied to clipboard');
    } catch {
      setMsg('Copy failed — select the URL manually and copy');
    }
  };

  const locationLookup = useMemo(() => {
    const m = new Map();
    for (const l of locations) m.set(l.id, l);
    return m;
  }, [locations]);

  const needsTenantPick = isSuperAdmin && !activeTenantId;

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="row-between"><h2>Store Action Boards</h2><span className="badge">Admin</span></div>

        <div className="app-banner">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div className="stack" style={{ gap: 6 }}>
              <span className="eyebrow">Action Board Hub</span>
              <h3 style={{ margin: 0 }}>Kiosk Displays</h3>
              <p className="ui-muted">
                Mint a URL for each TV in your stores. The TV opens that URL once and stays on it —
                pickups and returns refresh automatically every 30 seconds.
              </p>
            </div>
            <span className={`status-chip ${tokens.filter((t) => !t.revokedAt).length > 0 ? 'good' : 'warn'}`}>
              {tokens.filter((t) => !t.revokedAt).length} active
            </span>
          </div>
        </div>

        {/* SUPER_ADMIN tenant picker — only shown when needed */}
        {isSuperAdmin ? (
          <div className="stack" style={{ gap: 8, marginBottom: 12 }}>
            <label className="label">Operating in tenant</label>
            <select
              value={activeTenantId}
              onChange={(e) => setActiveTenantId(e.target.value)}
              style={{ maxWidth: 420 }}
            >
              <option value="">— Pick a tenant —</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.slug ? ` · ${t.slug}` : ''}</option>
              ))}
            </select>
            {needsTenantPick ? (
              <div className="ui-muted" style={{ fontSize: 13 }}>
                Pick a tenant above to mint kiosk URLs for that tenant&apos;s locations.
              </div>
            ) : null}
          </div>
        ) : null}

        {msg ? <div className="label" style={{ marginBottom: 8 }}>{msg}</div> : null}

        {justMinted ? (
          <div
            style={{
              border: '1px solid #2bcf7d',
              background: 'rgba(43, 207, 125, 0.06)',
              borderRadius: 12,
              padding: 16,
              marginBottom: 14
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6, color: '#1f8b56' }}>
              ✓ Kiosk minted: {justMinted.label}
            </div>
            <div className="ui-muted" style={{ marginBottom: 8 }}>
              Open this URL on the in-store TV. Bookmark it as the home page.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                readOnly
                value={buildKioskUrl(justMinted.token)}
                onFocus={(e) => e.target.select()}
                style={{
                  flex: 1,
                  fontFamily: 'monospace',
                  fontSize: 13,
                  padding: '8px 10px',
                  background: 'rgba(0,0,0,0.04)',
                  border: '1px solid rgba(0,0,0,0.12)',
                  borderRadius: 6
                }}
              />
              <button type="button" onClick={() => copyToClipboard(buildKioskUrl(justMinted.token))}>
                Copy URL
              </button>
              <button type="button" className="button-subtle" onClick={() => setJustMinted(null)}>
                Done
              </button>
            </div>
          </div>
        ) : null}

        {needsTenantPick ? null : (
          <>
            <form onSubmit={submitMint} className="stack" style={{ gap: 12, marginBottom: 16 }}>
              <div className="label">Mint a new kiosk URL</div>
              <div className="grid2" style={{ gap: 12 }}>
                <div className="stack">
                  <label className="label">Location</label>
                  <select
                    value={formLocationId}
                    onChange={(e) => setFormLocationId(e.target.value)}
                    disabled={formBusy}
                  >
                    <option value="">Pick a location…</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>{l.name} {l.code ? `· ${l.code}` : ''}</option>
                    ))}
                  </select>
                </div>
                <div className="stack">
                  <label className="label">Display label</label>
                  <input
                    type="text"
                    value={formLabel}
                    onChange={(e) => setFormLabel(e.target.value)}
                    placeholder="e.g. Front Counter Display"
                    disabled={formBusy}
                  />
                </div>
              </div>
              <div>
                <button type="submit" disabled={formBusy || !formLocationId || !formLabel.trim()}>
                  {formBusy ? 'Minting…' : 'Mint kiosk URL'}
                </button>
              </div>
            </form>

            <div className="row-between" style={{ marginBottom: 10 }}>
              <div className="label" style={{ marginBottom: 0 }}>Existing kiosks</div>
              <label style={{ fontSize: 12, color: '#666', display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={includeRevoked}
                  onChange={(e) => setIncludeRevoked(e.target.checked)}
                />
                Show revoked
              </label>
            </div>

            {loading ? (
              <div className="label">Loading…</div>
            ) : tokens.length === 0 ? (
              <div className="label">No kiosks yet. Mint one above.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Location</th>
                    <th>Status</th>
                    <th>Last seen</th>
                    <th>Created</th>
                    <th>URL</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((row) => {
                    const loc = locationLookup.get(row.locationId);
                    const isRevoked = !!row.revokedAt;
                    const lastSeen = row.lastSeenAt ? new Date(row.lastSeenAt) : null;
                    const lastSeenAgoMs = lastSeen ? Date.now() - lastSeen.getTime() : null;
                    const offline = !isRevoked && (!lastSeen || lastSeenAgoMs > 5 * 60 * 1000);
                    return (
                      <tr key={row.id} style={isRevoked ? { opacity: 0.5 } : undefined}>
                        <td>{row.label}</td>
                        <td>{loc ? `${loc.name}${loc.code ? ` · ${loc.code}` : ''}` : row.locationId}</td>
                        <td>
                          {isRevoked ? (
                            <span className="status-chip warn">Revoked</span>
                          ) : offline ? (
                            <span className="status-chip warn">Offline</span>
                          ) : (
                            <span className="status-chip good">Active</span>
                          )}
                        </td>
                        <td>{lastSeen ? lastSeen.toLocaleString() : '—'}</td>
                        <td>{new Date(row.createdAt).toLocaleString()}</td>
                        <td>
                          {isRevoked ? '—' : (
                            <button
                              type="button"
                              className="button-subtle"
                              onClick={() => copyToClipboard(buildKioskUrl(row.token))}
                              title="Copy kiosk URL to clipboard"
                            >
                              Copy URL
                            </button>
                          )}
                        </td>
                        <td>
                          {isRevoked ? '—' : (
                            <button
                              type="button"
                              className="button-subtle"
                              onClick={() => handleRevoke(row)}
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
    </AppShell>
  );
}
