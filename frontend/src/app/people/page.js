'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

const EMPTY_PERSON = {
  personType: 'EMPLOYEE',
  role: 'AGENT',
  fullName: '',
  displayName: '',
  legalName: '',
  email: '',
  phone: '',
  enableLogin: true,
  sendInvite: true,
  password: '',
  payoutProvider: '',
  payoutAccountRef: '',
  payoutEnabled: false,
  notes: ''
};

export default function PeoplePage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const [msg, setMsg] = useState('');
  const [people, setPeople] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [activeTenantId, setActiveTenantId] = useState('');
  const [form, setForm] = useState(EMPTY_PERSON);

  const role = String(me?.role || '').toUpperCase();
  const isSuper = role === 'SUPER_ADMIN';
  const canManagePeople = ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(role);

  const scopedQuery = useMemo(() => {
    const qs = new URLSearchParams();
    if (isSuper && activeTenantId) qs.set('tenantId', activeTenantId);
    const text = qs.toString();
    return text ? `?${text}` : '';
  }, [isSuper, activeTenantId]);

  const load = async () => {
    try {
      const requests = [api(`/api/people${scopedQuery}`, {}, token)];
      if (isSuper) requests.push(api('/api/tenants', {}, token));
      const [peopleOut, tenantsOut] = await Promise.all(requests);
      setPeople(Array.isArray(peopleOut) ? peopleOut : []);
      if (isSuper) {
        const rows = Array.isArray(tenantsOut) ? tenantsOut : [];
        setTenants(rows);
        if (!activeTenantId && rows[0]?.id) setActiveTenantId(rows[0].id);
      }
      setMsg('');
    } catch (e) {
      setMsg(e.message);
    }
  };

  useEffect(() => {
    if (!canManagePeople) return;
    load();
  }, [token, scopedQuery, canManagePeople]);

  const savePerson = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        ...form,
        tenantId: isSuper ? activeTenantId : undefined
      };
      const out = await api('/api/people', { method: 'POST', body: JSON.stringify(payload) }, token);
      setForm(EMPTY_PERSON);
      setMsg(out?.tempPassword
        ? `Person created. Temporary password: ${out.tempPassword}${out.inviteSent ? ' · Invite sent' : ''}`
        : 'Person created');
      await load();
    } catch (e2) {
      setMsg(e2.message);
    }
  };

  const resetPassword = async (person) => {
    try {
      const pwd = window.prompt(`Temporary password for ${person.displayName || person.email}`, '');
      if (pwd === null) return;
      const sendInvite = window.confirm(`Send the temporary password to ${person.email || 'this user'} by email?`);
      const out = await api(`/api/people/${person.userId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({
          password: pwd || undefined,
          sendInvite
        })
      }, token);
      setMsg(`Password reset for ${out.email}. Temp password: ${out.tempPassword}${out.inviteSent ? ' · Invite sent' : ''}`);
    } catch (e) {
      setMsg(e.message);
    }
  };

  const visiblePeople = useMemo(() => {
    if (!isSuper || !activeTenantId) return people;
    return people.filter((row) => String(row.tenantId || '') === String(activeTenantId));
  }, [people, isSuper, activeTenantId]);

  const hostMode = form.personType === 'HOST';
  const loginRequired = form.personType !== 'HOST' || form.enableLogin;

  if (!canManagePeople) {
    return (
      <AppShell me={me} logout={logout}>
        <section className="glass card-lg">
          <h2>People & Access</h2>
          <p className="error">Admin or Ops access required.</p>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="row-between">
          <div>
            <div className="label">People & Access</div>
            <h2 style={{ margin: '8px 0 0' }}>Admins, Employees, and Hosts</h2>
          </div>
        </div>

        {msg ? <div className="label">{msg}</div> : null}

        {isSuper ? (
          <div className="glass card" style={{ padding: 12 }}>
            <div className="stack">
              <label className="label">Tenant Scope</label>
              <select value={activeTenantId} onChange={(e) => setActiveTenantId(e.target.value)}>
                {tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
                ))}
              </select>
            </div>
          </div>
        ) : null}

        <div className="grid2">
          <section className="glass card" style={{ padding: 12 }}>
            <h3 style={{ marginTop: 0 }}>Create Person</h3>
            <form className="stack" onSubmit={savePerson}>
              <div className="grid2">
                <div className="stack">
                  <label className="label">Person Type</label>
                  <select value={form.personType} onChange={(e) => setForm({
                    ...form,
                    personType: e.target.value,
                    role: e.target.value === 'ADMIN' ? 'ADMIN' : 'AGENT',
                    enableLogin: e.target.value === 'HOST' ? false : true
                  })}>
                    <option value="ADMIN">ADMIN</option>
                    <option value="EMPLOYEE">EMPLOYEE</option>
                    <option value="HOST">HOST</option>
                  </select>
                </div>
                <div className="stack">
                  <label className="label">Access Role</label>
                  <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} disabled={form.personType === 'ADMIN'}>
                    <option value="ADMIN">ADMIN</option>
                    <option value="OPS">OPS</option>
                    <option value="AGENT">AGENT</option>
                  </select>
                </div>
                <div className="stack">
                  <label className="label">{hostMode ? 'Display Name' : 'Full Name'}</label>
                  <input value={hostMode ? form.displayName : form.fullName} onChange={(e) => setForm(hostMode ? { ...form, displayName: e.target.value } : { ...form, fullName: e.target.value })} />
                </div>
                <div className="stack">
                  <label className="label">Legal Name</label>
                  <input value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
                </div>
                <div className="stack">
                  <label className="label">Email</label>
                  <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
                <div className="stack">
                  <label className="label">Phone</label>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
              </div>

              {hostMode ? (
                <>
                  <label className="label">
                    <input type="checkbox" checked={form.enableLogin} onChange={(e) => setForm({ ...form, enableLogin: e.target.checked })} /> Enable host login
                  </label>
                  <div className="grid2">
                    <div className="stack">
                      <label className="label">Payout Provider</label>
                      <input value={form.payoutProvider} onChange={(e) => setForm({ ...form, payoutProvider: e.target.value })} placeholder="stripe-connect / manual" />
                    </div>
                    <div className="stack">
                      <label className="label">Payout Account Ref</label>
                      <input value={form.payoutAccountRef} onChange={(e) => setForm({ ...form, payoutAccountRef: e.target.value })} />
                    </div>
                  </div>
                  <label className="label">
                    <input type="checkbox" checked={form.payoutEnabled} onChange={(e) => setForm({ ...form, payoutEnabled: e.target.checked })} /> Payouts enabled
                  </label>
                </>
              ) : null}

              {loginRequired ? (
                <>
                  <div className="grid2">
                    <div className="stack">
                      <label className="label">Temporary Password</label>
                      <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Leave blank to auto-generate" />
                    </div>
                    <div className="stack">
                      <label className="label">Invite</label>
                      <label className="label">
                        <input type="checkbox" checked={form.sendInvite} onChange={(e) => setForm({ ...form, sendInvite: e.target.checked })} /> Send invite email
                      </label>
                    </div>
                  </div>
                </>
              ) : null}

              <div className="stack">
                <label className="label">Notes</label>
                <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>

              {hostMode && form.enableLogin ? (
                <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>
                  Host login uses the current platform auth stack for now. We can tighten host-specific permissions in the next slice when we start the host app.
                </div>
              ) : null}

              <div><button type="submit">Create Person</button></div>
            </form>
          </section>

          <section className="glass card" style={{ padding: 12 }}>
            <h3 style={{ marginTop: 0 }}>Current People</h3>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Role</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Access</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {visiblePeople.map((person) => (
                  <tr key={person.id}>
                    <td>{person.displayName || person.fullName || '-'}</td>
                    <td>{person.personType}</td>
                    <td>{person.accessRole || '-'}</td>
                    <td>{person.email || '-'}</td>
                    <td>{person.phone || '-'}</td>
                    <td>{person.hasLogin ? 'Login Enabled' : 'Profile Only'}</td>
                    <td>{person.status}</td>
                    <td>
                      {person.hasLogin && person.userId ? (
                        <button type="button" onClick={() => resetPassword(person)}>Reset Password</button>
                      ) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visiblePeople.length ? (
              <div className="label" style={{ marginTop: 10 }}>No people yet for this tenant.</div>
            ) : null}
          </section>
        </div>
      </section>
    </AppShell>
  );
}
