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

function metricSummary(people) {
  return [
    { label: 'People', value: people.length },
    { label: 'Admins', value: people.filter((row) => row.personType === 'ADMIN').length },
    { label: 'Employees', value: people.filter((row) => row.personType === 'EMPLOYEE').length },
    { label: 'Hosts', value: people.filter((row) => row.personType === 'HOST').length },
    { label: 'Login Enabled', value: people.filter((row) => row.hasLogin).length },
    { label: 'Profile Only', value: people.filter((row) => !row.hasLogin).length }
  ];
}

function personStatusClass(status) {
  const value = String(status || '').toUpperCase();
  if (value === 'ACTIVE') return 'status-chip good';
  if (value === 'PAUSED') return 'status-chip warn';
  return 'status-chip neutral';
}

function personTypeSummary(personType) {
  if (personType === 'ADMIN') return 'Tenant leaders with access and oversight.';
  if (personType === 'HOST') return 'Supply-side partner with optional login and payouts.';
  return 'Operations and sales teammate inside the tenant.';
}

export default function PeoplePage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const [msg, setMsg] = useState('');
  const [people, setPeople] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [activeTenantId, setActiveTenantId] = useState('');
  const [search, setSearch] = useState('');
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
      setForm({ ...EMPTY_PERSON });
      setMsg(
        out?.tempPassword
          ? `Person created. Temporary password: ${out.tempPassword}${out.inviteSent ? ' · Invite sent' : ''}`
          : 'Person created'
      );
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
    const base = !isSuper || !activeTenantId
      ? people
      : people.filter((row) => String(row.tenantId || '') === String(activeTenantId));
    const term = search.trim().toLowerCase();
    if (!term) return base;
    return base.filter((row) =>
      [
        row.displayName,
        row.fullName,
        row.legalName,
        row.email,
        row.phone,
        row.personType,
        row.accessRole
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term))
    );
  }, [people, isSuper, activeTenantId, search]);

  const metrics = useMemo(() => metricSummary(visiblePeople), [visiblePeople]);
  const hostMode = form.personType === 'HOST';
  const loginRequired = form.personType !== 'HOST' || form.enableLogin;

  if (!canManagePeople) {
    return (
      <AppShell me={me} logout={logout}>
        <section className="glass card-lg stack">
          <div className="eyebrow">People & Access</div>
          <h2>Admins, employees, and hosts</h2>
          <p className="error">Admin or Ops access required.</p>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell me={me} logout={logout}>
      <section className="page-hero">
        <div className="hero-grid">
          <section className="glass card-lg hero-copy">
            <div className="eyebrow">People & Access</div>
            <h2>Bring admins, staff, and hosts into one clean workspace.</h2>
            <p>
              This module is the operational identity layer for the platform. Use it to invite tenant leaders,
              onboard employees, and prepare hosts for the guest and host-facing app experiences that come next.
            </p>
            <div className="hero-meta">
              <span className="hero-pill">{isSuper ? 'Super admin tenant routing' : 'Tenant-scoped access'}</span>
              <span className="hero-pill">{loginRequired ? 'Invite-ready access flow' : 'Profile-only host flow'}</span>
              <span className="hero-pill">{visiblePeople.length} active people in view</span>
            </div>
          </section>

          <section className="glass card-lg stack">
            <div className="eyebrow">Current Scope</div>
            <div className="metric-grid">
              {metrics.map((metric) => (
                <div key={metric.label} className="metric-card">
                  <span className="label">{metric.label}</span>
                  <strong>{metric.value}</strong>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>

      {msg ? <div className="surface-note" style={{ marginBottom: 16 }}>{msg}</div> : null}

      <section className="glass card-lg stack" style={{ marginBottom: 18 }}>
        <div className="row-between" style={{ marginBottom: 0 }}>
          <div>
            <div className="section-title">Directory filters</div>
            <div className="ui-muted">Scope people by tenant and search quickly across names, roles, and contact details.</div>
          </div>
        </div>

        <div className="form-grid-3">
          {isSuper ? (
            <div className="stack">
              <label className="label">Tenant Scope</label>
              <select value={activeTenantId} onChange={(e) => setActiveTenantId(e.target.value)}>
                {tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="stack">
            <label className="label">Search People</label>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, phone, type, or role"
            />
          </div>

          <div className="surface-note">
            <strong style={{ display: 'block', marginBottom: 4 }}>Current flow</strong>
            Admins and employees get platform access immediately. Hosts can stay profile-only or receive login access
            depending on how you want to phase the host app rollout.
          </div>
        </div>
      </section>

      <section className="split-panel" style={{ marginBottom: 18 }}>
        <section className="glass card-lg section-card">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div>
              <div className="section-title">Create Person</div>
              <div className="ui-muted">{personTypeSummary(form.personType)}</div>
            </div>
          </div>

          <form className="stack" onSubmit={savePerson}>
            <div className="form-grid-2">
              <div className="stack">
                <label className="label">Person Type</label>
                <select
                  value={form.personType}
                  onChange={(e) => setForm({
                    ...form,
                    personType: e.target.value,
                    role: e.target.value === 'ADMIN' ? 'ADMIN' : 'AGENT',
                    enableLogin: e.target.value === 'HOST' ? false : true
                  })}
                >
                  <option value="ADMIN">ADMIN</option>
                  <option value="EMPLOYEE">EMPLOYEE</option>
                  <option value="HOST">HOST</option>
                </select>
              </div>

              <div className="stack">
                <label className="label">Access Role</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                  disabled={form.personType === 'ADMIN'}
                >
                  <option value="ADMIN">ADMIN</option>
                  <option value="OPS">OPS</option>
                  <option value="AGENT">AGENT</option>
                </select>
              </div>

              <div className="stack">
                <label className="label">{hostMode ? 'Display Name' : 'Full Name'}</label>
                <input
                  value={hostMode ? form.displayName : form.fullName}
                  onChange={(e) => setForm(
                    hostMode
                      ? { ...form, displayName: e.target.value }
                      : { ...form, fullName: e.target.value }
                  )}
                />
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
                <div className="surface-note">
                  Host profiles can stay operational-only while you prepare the host app, or receive immediate login
                  access if you want them inside the dashboard today.
                </div>

                <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  <input
                    type="checkbox"
                    checked={form.enableLogin}
                    onChange={(e) => setForm({ ...form, enableLogin: e.target.checked })}
                  /> Enable host login
                </label>

                <div className="form-grid-2">
                  <div className="stack">
                    <label className="label">Payout Provider</label>
                    <input
                      value={form.payoutProvider}
                      onChange={(e) => setForm({ ...form, payoutProvider: e.target.value })}
                      placeholder="stripe-connect / manual"
                    />
                  </div>

                  <div className="stack">
                    <label className="label">Payout Account Ref</label>
                    <input
                      value={form.payoutAccountRef}
                      onChange={(e) => setForm({ ...form, payoutAccountRef: e.target.value })}
                    />
                  </div>
                </div>

                <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  <input
                    type="checkbox"
                    checked={form.payoutEnabled}
                    onChange={(e) => setForm({ ...form, payoutEnabled: e.target.checked })}
                  /> Payouts enabled
                </label>
              </>
            ) : null}

            {loginRequired ? (
              <div className="form-grid-2">
                <div className="stack">
                  <label className="label">Temporary Password</label>
                  <input
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder="Leave blank to auto-generate"
                  />
                </div>

                <div className="stack">
                  <label className="label">Invite Delivery</label>
                  <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                    <input
                      type="checkbox"
                      checked={form.sendInvite}
                      onChange={(e) => setForm({ ...form, sendInvite: e.target.checked })}
                    /> Send invite email
                  </label>
                </div>
              </div>
            ) : null}

            <div className="stack">
              <label className="label">Notes</label>
              <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>

            {hostMode && form.enableLogin ? (
              <div className="surface-note">
                Host login uses the current platform auth stack for now. In the next slice we can tighten host-specific
                navigation and permissions when we start shaping the host app.
              </div>
            ) : null}

            <div className="inline-actions">
              <button type="submit">Create Person</button>
              <button type="button" className="button-subtle" onClick={() => setForm({ ...EMPTY_PERSON })}>Reset Form</button>
            </div>
          </form>
        </section>

        <section className="glass card-lg section-card">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div>
              <div className="section-title">People Directory</div>
              <div className="ui-muted">A single view of who can operate, sell, or host on this tenant.</div>
            </div>
            <span className="hero-pill">{visiblePeople.length} in view</span>
          </div>

          <div className="table-shell">
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
                    <td>
                      <div className="stack" style={{ gap: 4 }}>
                        <strong>{person.displayName || person.fullName || '-'}</strong>
                        <span className="ui-muted" style={{ fontSize: 12 }}>{person.legalName || 'No legal name yet'}</span>
                      </div>
                    </td>
                    <td>{person.personType}</td>
                    <td>{person.accessRole || '-'}</td>
                    <td>{person.email || '-'}</td>
                    <td>{person.phone || '-'}</td>
                    <td>
                      <span className={person.hasLogin ? 'status-chip good' : 'status-chip neutral'}>
                        {person.hasLogin ? 'Login Enabled' : 'Profile Only'}
                      </span>
                    </td>
                    <td>
                      <span className={personStatusClass(person.status)}>{person.status}</span>
                    </td>
                    <td>
                      {person.hasLogin && person.userId ? (
                        <div className="inline-actions">
                          <button type="button" onClick={() => resetPassword(person)}>Reset Password</button>
                        </div>
                      ) : (
                        '-'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!visiblePeople.length ? (
            <div className="surface-note">
              No people match the current tenant scope or search. Create an admin, employee, or host to start building
              out access for this workspace.
            </div>
          ) : null}
        </section>
      </section>
    </AppShell>
  );
}
