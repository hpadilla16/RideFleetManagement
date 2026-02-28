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
    if (!window.confirm(`Reset screen-lock PIN for ${u.name || u.email}?`)) return;
    try {
      await api(`/api/auth/users/${u.id}/reset-lock-pin`, { method: 'POST' }, token);
      setMsg(`PIN reset for ${u.name || u.email}`);
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg">
        <div className="row-between"><h2>Security Settings</h2><span className="badge">Admin</span></div>
        <div className="label" style={{ marginBottom: 10 }}>Reset screen-lock PIN for any user</div>
        {msg ? <div className="label" style={{ marginBottom: 8 }}>{msg}</div> : null}
        <table>
          <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Has PIN</th><th>PIN Updated</th><th>Action</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name || '-'}</td>
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
