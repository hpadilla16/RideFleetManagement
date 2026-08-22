'use client';

import { useEffect, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';

export default function SecuritySettingsPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

// Staff 2FA (2026-08-22) — self-service for the CURRENT user: status, enable
// (QR enrollment → one-time backup codes), regenerate codes, disable (requires
// password + a current code).
function TwoFactorSelfService({ token }) {
  const [status, setStatus] = useState(null);
  const [msg, setMsg] = useState('');
  const [enroll, setEnroll] = useState(null); // { qrDataUrl, secret }
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);   // one-time backup codes to show
  const [busy, setBusy] = useState(false);

  const loadStatus = async () => {
    try {
      setStatus(await api('/api/auth/2fa/status', {}, token));
    } catch (e) {
      setMsg(e.message);
    }
  };
  useEffect(() => { loadStatus(); }, [token]);

  const beginEnable = async () => {
    setMsg('');
    try {
      const out = await api('/api/auth/2fa/enroll/start', { method: 'POST' }, token);
      setEnroll({ qrDataUrl: out.qrDataUrl, secret: out.secret });
      setCode('');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const confirmEnable = async (e) => {
    e.preventDefault();
    try {
      setBusy(true);
      const out = await api('/api/auth/2fa/enroll/verify', { method: 'POST', body: JSON.stringify({ code: code.trim() }) }, token);
      setCodes(out.backupCodes || []);
      setEnroll(null);
      setCode('');
      setMsg('Two-factor authentication enabled.');
      await loadStatus();
    } catch (e2) {
      setMsg(e2.message);
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    if (!window.confirm('Generate new backup codes? Your existing codes will stop working.')) return;
    try {
      const out = await api('/api/auth/2fa/backup-codes/regenerate', { method: 'POST' }, token);
      setCodes(out.backupCodes || []);
      setMsg('New backup codes generated.');
      await loadStatus();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const disable = async () => {
    const password = window.prompt('Confirm your password to disable 2FA:');
    if (password === null) return;
    const currentCode = window.prompt('Enter a current authentication code (or a backup code):');
    if (currentCode === null) return;
    try {
      await api('/api/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ password, code: currentCode.trim() }) }, token);
      setMsg('Two-factor authentication disabled.');
      setCodes(null);
      await loadStatus();
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <section className="glass card-lg stack">
      <div className="row-between"><h2>Two-Factor Authentication</h2>
        <span className={`status-chip ${status?.enabled ? 'good' : 'warn'}`}>
          {status?.enabled ? 'Enabled' : 'Not enabled'}
        </span>
      </div>
      <p className="ui-muted">Protect your own account with a time-based one-time code from an authenticator app.</p>
      {msg ? <div className="label">{msg}</div> : null}

      {codes ? (
        <div className="app-banner stack">
          <strong>Save your backup codes</strong>
          <p className="ui-muted">Each works once if you lose your authenticator. They will not be shown again.</p>
          <div style={{ fontFamily: 'monospace', fontSize: 16 }}>
            {codes.map((c) => (<div key={c}>{c}</div>))}
          </div>
          <button type="button" onClick={() => setCodes(null)}>I saved these</button>
        </div>
      ) : null}

      {!status?.enabled && !enroll ? (
        <div className="inline-actions"><button type="button" onClick={beginEnable}>Enable 2FA</button></div>
      ) : null}

      {enroll ? (
        <div className="stack">
          <p className="ui-muted">Scan with your authenticator app, then enter the 6-digit code.</p>
          {enroll.qrDataUrl ? <img src={enroll.qrDataUrl} alt="2FA QR code" style={{ width: 180, height: 180 }} /> : null}
          {enroll.secret ? <p className="label">Manual key: <code>{enroll.secret}</code></p> : null}
          <form className="inline-actions" onSubmit={confirmEnable}>
            <input placeholder="6-digit code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required />
            <button type="submit" disabled={busy}>{busy ? 'Verifying…' : 'Verify and enable'}</button>
          </form>
        </div>
      ) : null}

      {status?.enabled ? (
        <div className="stack">
          <div className="label">Backup codes remaining: {status.backupCodesRemaining ?? '-'}</div>
          <div className="inline-actions">
            <button type="button" onClick={regenerate}>Regenerate backup codes</button>
            <button type="button" className="button-subtle" onClick={disable}>Disable 2FA</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Inner({ token, me, logout }) {
  const [users, setUsers] = useState([]);
  const [msg, setMsg] = useState('');
  const usersWithPin = users.filter((user) => user.hasLockPin).length;
  const usersWithoutPin = users.length - usersWithPin;
  const recentlyUpdatedPins = users.filter((user) => {
    if (!user.lockPinUpdatedAt) return false;
    const updated = new Date(user.lockPinUpdatedAt).getTime();
    return Number.isFinite(updated) && Date.now() - updated <= 1000 * 60 * 60 * 24 * 7;
  }).length;

  const load = async () => {
    try {
      const out = await api('/api/auth/users', {}, token);
      setUsers(out || []);
    } catch (e) {
      setMsg(e.message);
    }
  };

  useEffect(() => { load(); }, [token]);

  const resetPin = async (u) => {
    if (!window.confirm(`Reset screen-lock PIN for ${u.fullName || u.name || u.email}?`)) return;
    try {
      await api(`/api/auth/users/${u.id}/reset-lock-pin`, { method: 'POST' }, token);
      setMsg(`PIN reset for ${u.fullName || u.name || u.email}`);
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  // 2026-06-04 — per-user idle screen-lock exemption (for ops/reporting
  // agent accounts that drive automated read-only sessions).
  const toggleLockExempt = async (u) => {
    const next = !u.screenLockExempt;
    const who = u.fullName || u.name || u.email;
    if (!window.confirm(next
      ? `Exempt ${who} from the idle screen lock? Use only for trusted automation/reporting accounts.`
      : `Re-enable the idle screen lock for ${who}?`)) return;
    try {
      await api(`/api/auth/users/${u.id}/screen-lock-exempt`, {
        method: 'POST',
        body: JSON.stringify({ exempt: next })
      }, token);
      setMsg(`Screen lock ${next ? 'exemption enabled' : 're-enabled'} for ${who}`);
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <AppShell me={me} logout={logout}>
      <TwoFactorSelfService token={token} />
      <section className="glass card-lg stack">
        <div className="row-between"><h2>Security Settings</h2><span className="badge">Admin</span></div>
        <div className="app-banner">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div className="stack" style={{ gap: 6 }}>
              <span className="eyebrow">Security Hub</span>
              <h3 style={{ margin: 0 }}>Screen Lock Coverage</h3>
              <p className="ui-muted">Review who still needs a lock PIN and reset access quickly from one mobile-friendly board.</p>
            </div>
            <span className={`status-chip ${usersWithoutPin === 0 ? 'good' : 'warn'}`}>
              {usersWithoutPin === 0 ? 'All users covered' : `${usersWithoutPin} missing PIN`}
            </span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Users</span>
              <strong>{users.length}</strong>
            </div>
            <div className="info-tile">
              <span className="label">With PIN</span>
              <strong>{usersWithPin}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Missing PIN</span>
              <strong>{usersWithoutPin}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Updated 7 Days</span>
              <strong>{recentlyUpdatedPins}</strong>
            </div>
          </div>
        </div>
        <div className="label" style={{ marginBottom: 10 }}>Reset screen-lock PIN for any user</div>
        {msg ? <div className="label" style={{ marginBottom: 8 }}>{msg}</div> : null}
        <table>
          <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Has PIN</th><th>PIN Updated</th><th>Lock Exempt</th><th>Action</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.fullName || u.name || '-'}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>{u.hasLockPin ? 'Yes' : 'No'}</td>
                <td>{u.lockPinUpdatedAt ? new Date(u.lockPinUpdatedAt).toLocaleString() : '-'}</td>
                <td>{u.screenLockExempt ? 'Yes' : 'No'}</td>
                <td className="row" style={{ gap: 6 }}>
                  <button onClick={() => resetPin(u)}>Reset PIN</button>
                  <button className="button-subtle" onClick={() => toggleLockExempt(u)}>
                    {u.screenLockExempt ? 'Enable Lock' : 'Exempt Lock'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
