'use client';

/**
 * Kiosks admin (Fase B3b, 2026-07-05) — mockup A1/A3 in
 * doc/kiosk-mockups-2026-07-04.html. Module-gated 'kiosk' (pathnameToModule
 * maps /kiosks → kiosk; AppShell renders the blocked-module card otherwise).
 *
 * Devices: pair (one-time 6-digit code), fresh pairing code, rotate token
 * (shown ONCE), revoke, connectivity from lastSeenAt. Sessions: list + outcome
 * filter (deep-link /kiosks?outcome=ESCALATED from the dashboard banner).
 * KPI cards only show what the API can actually feed — extras attach/revenue
 * land with the Fase B6 telemetry work, so those cards are intentionally
 * absent rather than faked.
 *
 * Key handoff: edits GET/PUT /api/kiosk/key-handoff when the backend exposes
 * it; degrades to a read-only note when it doesn't (defaults to STAFF).
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

export default function KiosksPage() {
  return <AuthGate>{({ token, me, logout }) => <KiosksInner token={token} me={me} logout={logout} />}</AuthGate>;
}

const OUTCOMES = ['COMPLETED', 'ESCALATED', 'ABANDONED', 'IN_PROGRESS'];
const OUTCOME_TONE = { COMPLETED: 'good', ESCALATED: 'warn', ABANDONED: 'bad', IN_PROGRESS: 'neutral' };
const ESCALATE_LABEL = {
  ID_SCAN_FAILED: 'ID scan',
  ID_MISMATCH: 'ID mismatch',
  PAYMENT_TROUBLE: 'Payment',
  CUSTOMER_REQUEST: 'Asked for help',
  LOOKUP_FAILED: 'Lookup',
  OTHER: 'Other',
};

const timeAgo = (value) => {
  if (!value) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
};

const duration = (start, end) => {
  if (!start) return '—';
  const stop = end ? new Date(end).getTime() : Date.now();
  const secs = Math.max(0, Math.round((stop - new Date(start).getTime()) / 1000));
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
};

function KiosksInner({ token, me, logout }) {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState(searchParams?.get('outcome') ? 'sessions' : 'devices');
  const [outcome, setOutcome] = useState(String(searchParams?.get('outcome') || '').toUpperCase() || '');
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [devices, setDevices] = useState([]);
  const [sessions, setSessions] = useState([]); // TABLE rows (outcome-filtered)
  const [kpiSessions, setKpiSessions] = useState([]); // KPI source (never outcome-filtered)
  const [counts, setCounts] = useState({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // One-time secrets modal (pairing code / rotated token — never shown again).
  const [secret, setSecret] = useState(null); // { kind: 'pairing'|'token', deviceName, value, expiresAt }
  const [pairModal, setPairModal] = useState(null); // { name, locationId, walkupEnabled }

  // Key-handoff config (GET/PUT /api/kiosk/key-handoff). 404 = endpoint not on
  // this backend build → read-only note; any OTHER failure = visible error +
  // retry (never an eternal "Loading…").
  const [keyHandoff, setKeyHandoff] = useState(null);
  const [keyHandoffUnavailable, setKeyHandoffUnavailable] = useState(false);
  const [keyHandoffError, setKeyHandoffError] = useState('');

  const locName = (id) => locations.find((l) => l.id === id)?.name || id || '—';
  const deviceName = (id) => devices.find((d) => d.id === id)?.name || null;

  async function reload() {
    try {
      const locQS = locationId ? `&locationId=${encodeURIComponent(locationId)}` : '';
      // KPIs ALWAYS come from the unfiltered fetch — otherwise the
      // /kiosks?outcome=ESCALATED deep-link would make "Sessions today" count
      // only escalations and "Solved without staff" read 0%. The outcome
      // filter scopes the TABLE fetch only.
      const [devicesOut, allSessionsOut, filteredOut] = await Promise.all([
        api(`/api/kiosk/devices?_=1${locQS}`, { bypassCache: true }, token),
        api(`/api/kiosk/sessions?take=500${locQS}`, { bypassCache: true }, token),
        outcome
          ? api(`/api/kiosk/sessions?take=500${locQS}&outcome=${outcome}`, { bypassCache: true }, token)
          : Promise.resolve(null),
      ]);
      setDevices(Array.isArray(devicesOut) ? devicesOut : []);
      const allRows = Array.isArray(allSessionsOut?.sessions) ? allSessionsOut.sessions : [];
      setKpiSessions(allRows);
      setCounts(allSessionsOut?.counts || {});
      setSessions(outcome ? (Array.isArray(filteredOut?.sessions) ? filteredOut.sessions : []) : allRows);
    } catch (e) { setMsg(String(e?.message || e)); }
  }

  async function loadKeyHandoff() {
    setKeyHandoffError('');
    try {
      const out = await api('/api/kiosk/key-handoff', { bypassCache: true }, token);
      setKeyHandoff(out?.config || out || {});
      setKeyHandoffUnavailable(false);
    } catch (e) {
      if (e?.status === 404) setKeyHandoffUnavailable(true);
      else setKeyHandoffError(String(e?.message || e));
    }
  }

  useEffect(() => {
    api('/api/locations', {}, token).then((d) => {
      const list = Array.isArray(d) ? d : (d?.locations || []);
      setLocations(list.map((l) => ({ id: l.id, code: l.code, name: l.name })));
    }).catch(() => {});
    loadKeyHandoff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [token, locationId, outcome]);

  // KPI cards — only what the API can feed today (extras attach/revenue = B6).
  const kpi = useMemo(() => {
    const active = devices.filter((d) => d.status === 'ACTIVE');
    const online = active.filter((d) => d.connectivity === 'ONLINE');
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const today = kpiSessions.filter((s) => s.startedAt && new Date(s.startedAt) >= midnight);
    const byOutcome = (o) => today.filter((s) => s.outcome === o).length;
    const ended = byOutcome('COMPLETED') + byOutcome('ESCALATED') + byOutcome('ABANDONED');
    return {
      online: online.length,
      activeDevices: active.length,
      offline: active.length - online.length,
      today: today.length,
      completed: byOutcome('COMPLETED'),
      escalated: byOutcome('ESCALATED'),
      abandoned: byOutcome('ABANDONED'),
      solvedPct: ended > 0 ? Math.round((byOutcome('COMPLETED') / ended) * 100) : null,
    };
  }, [devices, kpiSessions]);

  async function createDevice() {
    if (!pairModal?.name?.trim()) { setMsg('Kiosk name is required'); return; }
    if (!pairModal?.locationId) { setMsg('Pick a location'); return; }
    setBusy(true); setMsg('');
    try {
      const out = await api('/api/kiosk/devices', {
        method: 'POST',
        body: JSON.stringify({
          name: pairModal.name.trim(),
          locationId: pairModal.locationId,
          walkupEnabled: pairModal.walkupEnabled !== false,
        }),
      }, token);
      setPairModal(null);
      setSecret({ kind: 'pairing', deviceName: out?.device?.name, value: out?.pairingCode, expiresAt: out?.pairingCodeExpiresAt });
      await reload();
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  }

  async function issueCode(device) {
    setBusy(true); setMsg('');
    try {
      const out = await api(`/api/kiosk/devices/${device.id}/pairing-code`, { method: 'POST' }, token);
      setSecret({ kind: 'pairing', deviceName: device.name, value: out?.pairingCode, expiresAt: out?.pairingCodeExpiresAt });
      await reload();
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  }

  async function rotate(device) {
    if (!window.confirm(`Rotate the token for "${device.name}"? The tablet stops working until it is re-paired or given the new token.`)) return;
    setBusy(true); setMsg('');
    try {
      const out = await api(`/api/kiosk/devices/${device.id}/rotate`, { method: 'POST' }, token);
      setSecret({ kind: 'token', deviceName: device.name, value: out?.deviceToken });
      await reload();
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  }

  async function revoke(device) {
    if (!window.confirm(`Revoke "${device.name}"? Its token stops authenticating immediately and the kiosk shows out-of-service. This cannot be undone.`)) return;
    setBusy(true); setMsg('');
    try {
      await api(`/api/kiosk/devices/${device.id}/revoke`, { method: 'POST' }, token);
      await reload();
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  }

  // PATCH /api/kiosk/devices/:id {walkupEnabled?, name?} → full updated device
  // view. 404 DEVICE_NOT_FOUND / 422 INVALID_DEVICE_PATCH surface in msg.
  async function patchDevice(device, patch) {
    setBusy(true); setMsg('');
    try {
      const updated = await api(`/api/kiosk/devices/${device.id}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      }, token);
      setDevices((cur) => cur.map((d) => (d.id === device.id ? { ...d, ...updated } : d)));
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  }

  async function renameDevice(device) {
    const name = window.prompt('New kiosk name (1–80 characters):', device.name);
    if (name === null) return;
    if (!name.trim() || name.trim().length > 80) { setMsg('Kiosk name must be 1–80 characters'); return; }
    await patchDevice(device, { name: name.trim() });
  }

  async function saveKeyHandoff() {
    setBusy(true); setMsg('');
    try {
      await api('/api/kiosk/key-handoff', { method: 'PUT', body: JSON.stringify({ config: keyHandoff }) }, token);
      setMsg('Key handoff saved');
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  }

  const setHandoffEntry = (key, patch) => {
    setKeyHandoff((cur) => ({ ...(cur || {}), [key]: { mode: 'STAFF', ...(cur?.[key] || {}), ...patch } }));
  };

  const chipFor = (device) => {
    if (device.status !== 'ACTIVE') return <span className="status-chip bad">Revoked</span>;
    if (device.connectivity === 'ONLINE') return <span className="status-chip good">● Online</span>;
    return <span className="status-chip warn">● Offline</span>;
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="row-between" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <span className="eyebrow">Self service</span>
            <h2 style={{ margin: '6px 0 2px' }}>Kiosks</h2>
            <p className="ui-muted" style={{ margin: 0 }}>Self-service devices at your locations</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">All locations</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <button type="button" onClick={() => setPairModal({ name: '', locationId: locations[0]?.id || '', walkupEnabled: true })}>
              + Pair new kiosk
            </button>
          </div>
        </div>

        {msg ? <p className="label">{msg}</p> : null}

        <div className="app-card-grid compact">
          <div className="info-tile">
            <span className="label">Devices online</span>
            <strong>{kpi.online}<span style={{ fontSize: 14, color: 'var(--ui-muted, #6f668f)' }}>/{kpi.activeDevices}</span></strong>
            <span className="ui-muted">{kpi.offline > 0 ? `${kpi.offline} offline > 15 min` : 'all healthy'}</span>
          </div>
          <div className="info-tile">
            <span className="label">Sessions today</span>
            <strong>{kpi.today}</strong>
            <span className="ui-muted">{kpi.completed} completed · {kpi.escalated} escalated · {kpi.abandoned} abandoned</span>
          </div>
          {kpi.solvedPct !== null ? (
            <div className="info-tile">
              <span className="label">Solved without staff</span>
              <strong style={{ color: kpi.solvedPct >= 70 ? '#047857' : '#b45309' }}>{kpi.solvedPct}%</strong>
              <span className="ui-muted">target ≥ 70%</span>
            </div>
          ) : null}
          {/* Extras attach rate + extras revenue cards land with the Fase B6
              telemetry endpoints — omitted (not faked) until the API feeds them. */}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className={tab === 'devices' ? '' : 'button-subtle'} onClick={() => setTab('devices')}>Devices</button>
          <button type="button" className={tab === 'sessions' ? '' : 'button-subtle'} onClick={() => setTab('sessions')}>Sessions</button>
        </div>

        {tab === 'devices' ? (
          <>
            <div className="table-scroll" style={{ overflowX: 'auto' }}>
              <table className="table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Kiosk</th>
                    <th style={{ textAlign: 'left' }}>Location</th>
                    <th style={{ textAlign: 'left' }}>Status</th>
                    <th style={{ textAlign: 'left' }}>Last heartbeat</th>
                    <th style={{ textAlign: 'left' }}>Walk-up</th>
                    <th style={{ textAlign: 'left' }}>App</th>
                    <th style={{ textAlign: 'left' }}>Manage</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((device) => (
                    <tr key={device.id}>
                      <td><strong>{device.name}</strong>{device.pairingPending ? <span className="ui-muted"> · pairing pending</span> : null}</td>
                      <td>{locName(device.locationId)}</td>
                      <td>{chipFor(device)}</td>
                      <td className="ui-muted">{timeAgo(device.lastSeenAt)}</td>
                      <td>
                        {device.status === 'ACTIVE' ? (
                          <label
                            title='Turn the "Rent a car now" walk-up card on/off for this kiosk (applies on the tablet without re-pairing)'
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: busy ? 'default' : 'pointer' }}
                          >
                            <input
                              type="checkbox"
                              checked={device.walkupEnabled !== false}
                              disabled={busy}
                              onChange={(e) => patchDevice(device, { walkupEnabled: e.target.checked })}
                            />
                            {device.walkupEnabled !== false ? 'On' : 'Off'}
                          </label>
                        ) : (device.walkupEnabled ? 'On' : 'Off')}
                      </td>
                      <td className="ui-muted">{device.appVersion || '—'}</td>
                      <td>
                        {device.status === 'ACTIVE' ? (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button type="button" className="button-subtle" disabled={busy} onClick={() => renameDevice(device)}>Rename</button>
                            <button type="button" className="button-subtle" disabled={busy} onClick={() => issueCode(device)}>Pairing code</button>
                            <button type="button" className="button-subtle" disabled={busy} onClick={() => rotate(device)}>Rotate</button>
                            <button type="button" className="button-subtle" disabled={busy} style={{ color: '#be123c' }} onClick={() => revoke(device)}>Revoke</button>
                          </div>
                        ) : <span className="ui-muted">revoked {timeAgo(device.revokedAt)}</span>}
                      </td>
                    </tr>
                  ))}
                  {!devices.length ? (
                    <tr><td colSpan={7} className="ui-muted">No kiosks yet — pair your first tablet with “+ Pair new kiosk”.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <p className="ui-muted" style={{ fontSize: 12.5 }}>
              Pairing generates a one-time 6-digit code (10-min TTL) you type once on the tablet; the tablet then holds a
              rotable device token. Revoke kills the token instantly. A device with no request for 15+ minutes shows Offline.
            </p>

            <section className="glass card section-card">
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="stack" style={{ gap: 4 }}>
                  <h3 style={{ margin: 0 }}>Key handoff after checkout</h3>
                  <div className="ui-muted">
                    What the DONE screen tells the guest per location: see a staff member (default) or a lockbox note.
                    The lockbox note is only revealed after the contract is signed and the checkout is closed.
                  </div>
                </div>
                {!keyHandoffUnavailable && keyHandoff ? (
                  <button type="button" disabled={busy} onClick={saveKeyHandoff}>Save key handoff</button>
                ) : null}
              </div>
              {keyHandoffUnavailable ? (
                <p className="ui-muted" style={{ marginTop: 10 }}>
                  The key-handoff admin endpoint (<code>/api/kiosk/key-handoff</code>) is not available on this backend
                  build yet — every location currently defaults to <strong>staff handoff</strong>. Once the backend ships
                  it, this panel becomes editable.
                </p>
              ) : keyHandoffError ? (
                <div style={{ marginTop: 10 }}>
                  <p className="label" style={{ color: '#be123c' }}>Couldn&apos;t load the key-handoff config: {keyHandoffError}</p>
                  <button type="button" className="button-subtle" onClick={loadKeyHandoff}>Retry</button>
                </div>
              ) : keyHandoff ? (
                <div className="stack" style={{ marginTop: 10, gap: 10 }}>
                  {[{ id: 'default', name: 'Default (all locations)' }, ...locations].map((loc) => {
                    const entry = keyHandoff?.[loc.id] || {};
                    const mode = String(entry.mode || (loc.id === 'default' ? 'STAFF' : '')).toUpperCase();
                    return (
                      <div key={loc.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ minWidth: 200, fontWeight: 600 }}>{loc.name}</span>
                        <select
                          value={mode || 'INHERIT'}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === 'INHERIT') {
                              setKeyHandoff((cur) => {
                                const next = { ...(cur || {}) };
                                delete next[loc.id];
                                return next;
                              });
                            } else setHandoffEntry(loc.id, { mode: v });
                          }}
                        >
                          {loc.id !== 'default' ? <option value="INHERIT">Use default</option> : null}
                          <option value="STAFF">Staff handoff</option>
                          <option value="LOCKBOX">Lockbox</option>
                        </select>
                        {mode === 'LOCKBOX' ? (
                          <input
                            style={{ flex: 1, minWidth: 240 }}
                            placeholder="Lockbox note shown to the guest (e.g. Lockbox A-07 by the exit · code 4821)"
                            value={entry.lockboxNote || ''}
                            onChange={(e) => setHandoffEntry(loc.id, { lockboxNote: e.target.value })}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : <p className="ui-muted" style={{ marginTop: 10 }}>Loading…</p>}
            </section>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                <option value="">All outcomes</option>
                {OUTCOMES.map((o) => <option key={o} value={o}>{o.charAt(0) + o.slice(1).toLowerCase().replace('_', ' ')}</option>)}
              </select>
              <span className="ui-muted" style={{ fontSize: 12.5 }}>
                All time: {OUTCOMES.map((o) => `${counts[o] || 0} ${o.toLowerCase().replace('_', ' ')}`).join(' · ')}
              </span>
            </div>
            <div className="table-scroll" style={{ overflowX: 'auto' }}>
              <table className="table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Started</th>
                    <th style={{ textAlign: 'left' }}>Kiosk</th>
                    <th style={{ textAlign: 'left' }}>Type</th>
                    <th style={{ textAlign: 'left' }}>Reservation</th>
                    <th style={{ textAlign: 'left' }}>Last step</th>
                    <th style={{ textAlign: 'left' }}>Duration</th>
                    <th style={{ textAlign: 'left' }}>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td className="ui-muted">{s.startedAt ? new Date(s.startedAt).toLocaleString() : '—'}</td>
                      <td>{s.device?.name || deviceName(s.deviceId) || '—'}</td>
                      <td>{s.kind === 'WALKUP' ? <span className="status-chip neutral">Walk-up</span> : 'Pickup'}</td>
                      <td>
                        {s.reservationId
                          ? <a href={`/reservations/${s.reservationId}`} style={{ fontWeight: 600 }}>Open ›</a>
                          : <span className="ui-muted">—</span>}
                      </td>
                      <td className="ui-muted">{s.step || '—'}</td>
                      <td>{duration(s.startedAt, s.endedAt)}</td>
                      <td>
                        <span className={`status-chip ${OUTCOME_TONE[s.outcome] || 'neutral'}`}>
                          {s.outcome === 'ESCALATED' && s.escalatedReason
                            ? `Escalated · ${ESCALATE_LABEL[s.escalatedReason] || s.escalatedReason}`
                            : s.outcome.charAt(0) + s.outcome.slice(1).toLowerCase().replace('_', ' ')}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {!sessions.length ? (
                    <tr><td colSpan={7} className="ui-muted">No sessions {outcome ? `with outcome ${outcome}` : 'yet'}.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <p className="ui-muted" style={{ fontSize: 12.5 }}>
              Each session stores the full funnel (steps, offers shown/accepted/declined, scan attempts, outcome) — the
              per-step funnel and attach-rate breakdowns ship with Fase B6.
            </p>
          </>
        )}
      </section>

      {pairModal ? (
        <div className="modal-backdrop" style={backdropStyle}>
          <div className="glass card-lg" style={modalStyle}>
            <h3 style={{ marginTop: 0 }}>Pair a new kiosk</h3>
            <div className="stack" style={{ gap: 10 }}>
              <input
                placeholder="Kiosk name (e.g. Kiosk 1 — Counter left)"
                value={pairModal.name}
                onChange={(e) => setPairModal({ ...pairModal, name: e.target.value })}
              />
              <select
                value={pairModal.locationId}
                onChange={(e) => setPairModal({ ...pairModal, locationId: e.target.value })}
              >
                <option value="">Pick a location…</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={pairModal.walkupEnabled !== false}
                  onChange={(e) => setPairModal({ ...pairModal, walkupEnabled: e.target.checked })}
                />
                Allow walk-up “Rent a car now” on this kiosk
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button type="button" disabled={busy} onClick={createDevice}>Create & get pairing code</button>
              <button type="button" className="button-subtle" onClick={() => setPairModal(null)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}

      {secret ? (
        <div className="modal-backdrop" style={backdropStyle}>
          <div className="glass card-lg" style={{ ...modalStyle, textAlign: 'center' }}>
            {secret.kind === 'pairing' ? (
              <>
                <h3 style={{ marginTop: 0 }}>Pairing code for {secret.deviceName}</h3>
                <div style={{ fontSize: 44, fontWeight: 800, letterSpacing: '.25em', margin: '10px 0' }}>{secret.value}</div>
                <p className="ui-muted">
                  Type this code once on the tablet at <code>/kiosk</code>. Single-use,
                  expires {secret.expiresAt ? new Date(secret.expiresAt).toLocaleTimeString() : 'in 10 minutes'} — it will
                  not be shown again.
                </p>
              </>
            ) : (
              <>
                <h3 style={{ marginTop: 0 }}>New device token for {secret.deviceName}</h3>
                <div style={{ fontSize: 14, fontWeight: 700, wordBreak: 'break-all', margin: '10px 0', padding: 10, background: 'rgba(135,82,254,.06)', borderRadius: 10 }}>
                  {secret.value}
                </div>
                <p className="ui-muted">
                  The old token is dead. Shown ONCE — easiest recovery is issuing a fresh pairing code and re-pairing the tablet.
                </p>
              </>
            )}
            <button type="button" onClick={() => setSecret(null)}>Done</button>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

const backdropStyle = {
  position: 'fixed', inset: 0, background: 'rgba(33,26,56,.45)', zIndex: 80,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
};
const modalStyle = { maxWidth: 480, width: '100%', background: '#fff' };
