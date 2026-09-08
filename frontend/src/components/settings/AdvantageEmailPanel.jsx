'use client';

/**
 * AdvantageEmailPanel — the Settings screen for Advantage's email-delivered
 * reservations (2026-09-08).
 *
 * Advantage has no TSD portal for this account, so bookings arrive as email and
 * RFM polls a mailbox. The pipeline shipped without a screen, which meant the
 * first real message could only be handled by pasting fetch() into a browser
 * console — including the mailbox password. This is that screen.
 *
 * Sibling of MexIntegrationPanel: same api client, same `scoped()` path helper,
 * same card/table styling, English-only (these panels are not wired to the
 * locale files).
 *
 * WHAT THIS SCREEN IS FOR, IN ORDER OF HOW OFTEN IT MATTERS:
 *   1. The QUARANTINE TRAY. The parser works from a closed vocabulary and holds
 *      anything it does not recognise instead of guessing. That is the right
 *      behaviour and it means quarantined messages are normal, especially early.
 *      Someone has to be able to see them and retry them, which is most of the
 *      value here.
 *   2. The mailbox connection, with a real IMAP probe that reads no message —
 *      so a bad password is told apart from a bad parse before either matters.
 *   3. The routes: (TSD account, branch) → Ride location. An email for an
 *      unmapped pair is quarantined, and this is where you see that it was.
 *
 * The password is write-only. It is sent once and never returned; the status
 * endpoint reports host, folder and username only.
 *
 * Backend contract (mounted at /api/admin/integrations/advantage-email):
 *   GET   /status                      -> { configured, masterEnabled, integrationEnabled,
 *                                           credential, mailbox, senderAllowlist, routes,
 *                                           quarantinedOpen, health, lastRun, nextRunAt }
 *   PUT   /enabled     { enabled }
 *   POST  /credentials { host, port, secure, username, password, mailbox, processedMailbox }
 *   POST  /test-connection             -> live IMAP probe, reads nothing
 *   POST  /run-now                     -> one-off poll
 *   GET   /runs?limit=
 *   GET   /messages?limit=&status=     -> the inbound ledger
 *   POST  /messages/:id/retry
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/client';

function relativeTime(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return new Date(iso).toLocaleString();
  const abs = Math.abs(ms);
  const suffix = ms < 0 ? 'from now' : 'ago';
  const sec = Math.floor(abs / 1000);
  if (sec < 60) return `${sec}s ${suffix}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${suffix}`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${suffix}`;
  return `${Math.floor(hr / 24)}d ${suffix}`;
}

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
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

const TH = { padding: '8px 10px', textAlign: 'left' };
const TD = { padding: '8px 10px', verticalAlign: 'top' };
const ROW = { borderBottom: '1px solid #f0eaff' };

export function AdvantageEmailPanel({
  token, me, isSuper, isAdmin, tenantName, scopedSettingsPath, onPageMsg,
}) {
  const [status, setStatus] = useState(null);
  const [runs, setRuns] = useState([]);
  const [messages, setMessages] = useState([]);
  const [rideLocations, setRideLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState('');

  // Connection form. `password` is never populated from the server — it is
  // write-only, and a blank field on an already-configured mailbox means
  // "leave the stored password alone".
  const [host, setHost] = useState('imap.titan.email');
  const [port, setPort] = useState('993');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mailbox, setMailbox] = useState('INBOX');
  const [processedMailbox, setProcessedMailbox] = useState('');

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(null);
  const [msgFilter, setMsgFilter] = useState('');

  const canAccess = isAdmin ?? (isSuper || String(me?.role || '').toUpperCase() === 'ADMIN');
  const scoped = useMemo(() => scopedSettingsPath || ((p) => p), [scopedSettingsPath]);

  const flash = useCallback((m) => {
    setToast(m);
    if (onPageMsg) onPageMsg(m);
    setTimeout(() => setToast(''), 5000);
  }, [onPageMsg]);

  const base = '/api/admin/integrations/advantage-email';

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [st, rn, ms, locs] = await Promise.all([
        api(scoped(`${base}/status`), { bypassCache: true }, token).catch((e) => ({ __error: e?.message })),
        api(scoped(`${base}/runs?limit=8`), { bypassCache: true }, token).catch(() => ({ runs: [] })),
        api(scoped(`${base}/messages?limit=25`), { bypassCache: true }, token).catch(() => ({ messages: [] })),
        api(scoped('/api/locations'), {}, token).catch(() => []),
      ]);
      if (st?.__error) setLoadError(st.__error);
      else setStatus(st || null);
      setRuns(Array.isArray(rn?.runs) ? rn.runs : []);
      setMessages(Array.isArray(ms?.messages) ? ms.messages : (Array.isArray(ms) ? ms : []));
      setRideLocations(Array.isArray(locs) ? locs : (locs?.locations || []));
      // Prefill the form from what is stored, password excepted.
      const mb = st?.mailbox;
      if (mb && mb.configured !== false) {
        if (mb.host) setHost(mb.host);
        if (mb.port) setPort(String(mb.port));
        if (mb.username) setUsername(mb.username);
        if (mb.mailbox) setMailbox(mb.mailbox);
        setProcessedMailbox(mb.processedMailbox || '');
      }
    } finally {
      setLoading(false);
    }
  }, [scoped, token]);

  useEffect(() => { if (canAccess) reload(); }, [canAccess, reload]);

  const post = async (path, body, label) => {
    const res = await api(scoped(`${base}${path}`), {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }, token);
    if (label) flash(label);
    return res;
  };

  const saveCredentials = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    if (!username.trim()) { flash('Enter the mailbox address'); return; }
    if (!status?.configured && !password) { flash('Enter the mailbox password'); return; }
    setSaving(true);
    try {
      await post('/credentials', {
        host: host.trim(),
        port: Number(port) || 993,
        secure: true,
        username: username.trim(),
        password,
        mailbox: mailbox.trim() || 'INBOX',
        processedMailbox: processedMailbox.trim(),
      }, 'Mailbox connection saved (encrypted)');
      setPassword('');
      await reload();
    } catch (err) {
      flash(err?.message || 'Could not save the connection');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const res = await post('/test-connection', {});
      flash(res?.ok
        ? `Connected. ${res.messageCount != null ? `${res.messageCount} message(s) in the folder.` : 'No message was read.'}`
        : `Could not connect: ${res?.error || 'unknown error'}`);
      await reload();
    } catch (err) {
      flash(err?.message || 'Could not connect');
    } finally {
      setTesting(false);
    }
  };

  const runNow = async () => {
    setRunBusy(true);
    try {
      await post('/run-now', {}, 'Poll queued — refresh in a moment');
      setTimeout(reload, 4000);
    } catch (err) {
      flash(err?.message || 'Could not queue the poll');
    } finally {
      setRunBusy(false);
    }
  };

  const toggleEnabled = async (next) => {
    setToggleBusy(true);
    try {
      const res = await api(scoped(`${base}/enabled`), {
        method: 'PUT', body: JSON.stringify({ enabled: next }),
      }, token);
      if (res?.ok !== false) {
        flash(next ? 'Email ingestion enabled for this tenant' : 'Email ingestion disabled');
        await reload();
      }
    } catch (err) {
      flash(err?.message || 'Could not update');
    } finally {
      setToggleBusy(false);
    }
  };

  const retryMessage = async (id) => {
    setRetryBusy(id);
    try {
      await post(`/messages/${id}/retry`, {}, 'Cleared — the next poll will re-import it');
      await reload();
    } catch (err) {
      flash(err?.message || 'Could not clear the quarantine');
    } finally {
      setRetryBusy(null);
    }
  };

  if (!canAccess) return null;

  const health = status?.health || {};
  const mb = status?.mailbox || {};
  const allowlist = status?.senderAllowlist;
  const unrestricted = allowlist === 'unrestricted' || (Array.isArray(allowlist) && !allowlist.length);
  const shown = msgFilter ? messages.filter((m) => m.status === msgFilter) : messages;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* ============ 1. HEADER + MASTER SWITCHES ============ */}
      <section className="glass card section-card">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <h3 style={{ margin: 0 }}>
              Advantage — email delivery{' '}
              <Pill tone={health.pillTone || (status?.configured ? 'gray' : 'amber')}>
                {health.pillLabel || (status?.configured ? 'Configured' : 'Needs setup')}
              </Pill>
            </h3>
            <p className="ui-muted">
              Advantage has no portal for this account, so reservations arrive as email and
              RFM polls a mailbox. {tenantName ? <>Tenant: <strong>{tenantName}</strong>.</> : null}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" onClick={reload} disabled={loading}>Refresh</button>
            <button type="button" onClick={runNow} disabled={runBusy || !status?.configured}>
              {runBusy ? 'Queuing…' : 'Run now'}
            </button>
          </div>
        </div>

        {loadError ? <p style={{ color: '#991b1b' }}>{loadError}</p> : null}
        {toast ? <p className="ui-muted" style={{ marginTop: 4 }}>{toast}</p> : null}

        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <label className="label" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={!!status?.masterEnabled}
              disabled={toggleBusy}
              onChange={(e) => toggleEnabled(e.target.checked)}
            />
            Enabled for this tenant
          </label>
          <span className="ui-muted" style={{ fontSize: 12 }}>
            Platform poll: {status?.integrationEnabled
              ? <Pill tone="green">on</Pill>
              : <Pill tone="gray">off</Pill>}
            {' '}— both must be on before anything is polled automatically.
            &nbsp;Last run {relativeTime(status?.lastRun?.startedAt)}.
          </span>
        </div>

        {/* An unrestricted allowlist is a real exposure, not a nag: anyone who
            learns the address could post reservations into the tenant. */}
        {unrestricted ? (
          <p style={{ marginTop: 10, color: '#92400e', fontSize: 13 }}>
            <strong>Sender allowlist is empty — any sender is accepted.</strong> Set
            <code> ADVANTAGE_EMAIL_ALLOWED_SENDERS</code> to Advantage&apos;s sending domain
            before turning the poll on, or anyone who learns this address can create
            reservations in this tenant.
          </p>
        ) : (
          <p className="ui-muted" style={{ marginTop: 10, fontSize: 12 }}>
            Accepted senders: <code>{Array.isArray(allowlist) ? allowlist.join(', ') : String(allowlist)}</code>
          </p>
        )}
      </section>

      {/* ============ 2. MAILBOX CONNECTION ============ */}
      <section className="glass card section-card">
        <div style={{ display: 'grid', gap: 4 }}>
          <h3 style={{ margin: 0 }}>Mailbox connection</h3>
          <p className="ui-muted">
            IMAP over TLS. The password is stored encrypted and never shown again — leave it
            blank to keep the one already saved.
          </p>
        </div>

        <form onSubmit={saveCredentials} style={{ display: 'grid', gap: 10, marginTop: 10 }}>
          <div className="grid2">
            <div className="stack">
              <label className="label">IMAP host</label>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="imap.titan.email" />
            </div>
            <div className="stack">
              <label className="label">Port</label>
              <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="993" />
            </div>
          </div>
          <div className="grid2">
            <div className="stack">
              <label className="label">Mailbox address (IMAP username)</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="advantagerez@ridefleetmanager.com"
                autoComplete="off"
              />
            </div>
            <div className="stack">
              <label className="label">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={status?.configured ? 'leave blank to keep the stored one' : ''}
                autoComplete="new-password"
              />
            </div>
          </div>
          <div className="grid2">
            <div className="stack">
              <label className="label">Folder</label>
              <input value={mailbox} onChange={(e) => setMailbox(e.target.value)} placeholder="INBOX" />
            </div>
            <div className="stack">
              <label className="label">Move processed to (optional)</label>
              <input
                value={processedMailbox}
                onChange={(e) => setProcessedMailbox(e.target.value)}
                placeholder="leave blank while you are still learning the format"
              />
              <span className="ui-muted" style={{ fontSize: 12 }}>
                Blank marks messages read without moving them, so a badly parsed email stays
                where you can look at it.
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save connection'}</button>
            <button type="button" onClick={testConnection} disabled={testing || !status?.configured}>
              {testing ? 'Connecting…' : 'Test connection'}
            </button>
            {status?.credential ? (
              <span className="ui-muted" style={{ fontSize: 12 }}>
                Saved {relativeTime(status.credential.rotatedAt)} · last test{' '}
                {status.credential.lastTestStatus || 'never'}{' '}
                {status.credential.lastTestedAt ? `(${relativeTime(status.credential.lastTestedAt)})` : ''}
              </span>
            ) : null}
          </div>
          <span className="ui-muted" style={{ fontSize: 12 }}>
            The test opens a real IMAP session and reads no message, so a wrong password is
            told apart from a bad parse before either one matters.
          </span>
        </form>
      </section>

      {/* ============ 3. ROUTES ============ */}
      <section className="glass card section-card">
        <div style={{ display: 'grid', gap: 4 }}>
          <h3 style={{ margin: 0 }}>Branch routing</h3>
          <p className="ui-muted">
            Each email names a TSD account and a branch; that pair decides which sede the
            reservation lands in. An email for an unmapped pair is quarantined, never guessed.
            These rows are shared with the Advantage portal integration.
          </p>
        </div>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ ...ROW, textAlign: 'left' }}>
                <th style={TH}>TSD #</th>
                <th style={TH}>Branch</th>
                <th style={TH}>Ride location</th>
                <th style={TH}>Active</th>
              </tr>
            </thead>
            <tbody>
              {!status?.routes?.length ? (
                <tr><td colSpan={4} style={{ ...TD, color: '#92400e' }}>
                  No branch is mapped. Every incoming email will be quarantined until one is —
                  add it in the Advantage (TSD) tab.
                </td></tr>
              ) : status.routes.map((r) => {
                const loc = rideLocations.find((l) => l.id === r.locationId);
                return (
                  <tr key={r.id} style={ROW}>
                    <td style={TD}><code>{r.tsdNumber}</code></td>
                    <td style={TD}><code>{r.branch}</code></td>
                    <td style={TD}>{loc ? `${loc.name || ''} (${loc.code || ''})` : <span className="ui-muted">unknown</span>}</td>
                    <td style={TD}>{r.enabled ? <Pill tone="green">yes</Pill> : <Pill tone="gray">no</Pill>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ============ 4. THE INBOUND LEDGER — the reason this screen exists ============ */}
      <section className="glass card section-card" style={{ borderLeft: '4px solid #f59e0b' }}>
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <h3 style={{ margin: 0 }}>
              Received messages{' '}
              {status?.quarantinedOpen ? <Pill tone="amber">{status.quarantinedOpen} held</Pill> : null}
            </h3>
            <p className="ui-muted">
              The parser recognises a closed set of message types and HOLDS anything else rather
              than guessing what it means. Held messages are normal early on — each one names
              what it could not read. Fix the cause, then retry.
            </p>
          </div>
          <select value={msgFilter} onChange={(e) => setMsgFilter(e.target.value)}>
            <option value="">All</option>
            <option value="IMPORTED">Imported</option>
            <option value="QUARANTINED">Held</option>
            <option value="FAILED">Failed</option>
          </select>
        </div>

        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ ...ROW, textAlign: 'left' }}>
                <th style={TH}>Received</th>
                <th style={TH}>From</th>
                <th style={TH}>Subject</th>
                <th style={TH}>Status</th>
                <th style={TH}>Booking</th>
                <th style={TH}></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} style={TD}>Loading…</td></tr>
              ) : !shown.length ? (
                <tr><td colSpan={6} style={{ ...TD, color: '#6b7280' }}>
                  No messages yet. Once the mailbox is connected, use <strong>Run now</strong> to
                  poll it once without turning the automatic poll on.
                </td></tr>
              ) : shown.map((m) => (
                <tr key={m.id} style={ROW}>
                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>{fmt(m.receivedAt || m.createdAt)}</td>
                  <td style={TD}><code style={{ fontSize: 12 }}>{m.fromAddress || '—'}</code></td>
                  <td style={{ ...TD, maxWidth: 260 }}>{m.subject || <span className="ui-muted">(none)</span>}</td>
                  <td style={TD}>
                    {m.status === 'IMPORTED' ? <Pill tone="green">imported</Pill>
                      : m.status === 'QUARANTINED' ? <Pill tone="amber">held</Pill>
                        : <Pill tone="red">failed</Pill>}
                    {m.reason || m.error ? (
                      <div className="ui-muted" style={{ fontSize: 12, marginTop: 4 }}>{m.reason || m.error}</div>
                    ) : null}
                  </td>
                  <td style={TD}>{m.externalRef ? <code>{m.externalRef}</code> : '—'}</td>
                  <td style={TD}>
                    {m.status !== 'IMPORTED' ? (
                      <button type="button" onClick={() => retryMessage(m.id)} disabled={retryBusy === m.id}>
                        {retryBusy === m.id ? 'Clearing…' : 'Retry'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ============ 5. RUNS ============ */}
      <section className="glass card section-card">
        <h3 style={{ margin: 0 }}>Recent polls</h3>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ ...ROW, textAlign: 'left' }}>
                <th style={TH}>Started</th>
                <th style={TH}>Status</th>
                <th style={TH}>Found</th>
                <th style={TH}>New</th>
                <th style={TH}>Promoted</th>
                <th style={TH}>Review</th>
                <th style={TH}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {!runs.length ? (
                <tr><td colSpan={7} style={{ ...TD, color: '#6b7280' }}>No poll has run yet.</td></tr>
              ) : runs.map((r) => (
                <tr key={r.id} style={ROW}>
                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>{fmt(r.startedAt)}</td>
                  <td style={TD}>
                    {r.status === 'OK' ? <Pill tone="green">OK</Pill>
                      : r.status === 'PARTIAL' ? <Pill tone="amber">partial</Pill>
                        : <Pill tone="red">{String(r.status || '').toLowerCase()}</Pill>}
                  </td>
                  <td style={TD}>{r.pickupsFound ?? 0}</td>
                  <td style={TD}>{r.newlyInserted ?? 0}</td>
                  <td style={TD}>{r.autoPromoted ?? 0}</td>
                  <td style={TD}>{r.needsReview ?? 0}</td>
                  <td style={{ ...TD, maxWidth: 320 }} className="ui-muted">{r.notes || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default AdvantageEmailPanel;
