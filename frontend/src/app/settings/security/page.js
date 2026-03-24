'use client';

import { useEffect, useState } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';

export default function SecuritySettingsPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
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

  return (
    <AppShell me={me} logout={logout}>
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
          <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Has PIN</th><th>PIN Updated</th><th>Action</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.fullName || u.name || '-'}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>{u.hasLockPin ? 'Yes' : 'No'}</td>
                <td>{u.lockPinUpdatedAt ? new Date(u.lockPinUpdatedAt).toLocaleString() : '-'}</td>
                <td><button onClick={() => resetPin(u)}>Reset PIN</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
