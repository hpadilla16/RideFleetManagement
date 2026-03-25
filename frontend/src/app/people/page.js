'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';
import { MODULE_DEFINITIONS } from '../../lib/moduleAccess';

const EMPTY_PERSON = {
  personType: 'EMPLOYEE',
  role: 'AGENT',
  tenantId: '',
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
  notes: '',
  status: 'ACTIVE'
};

function buildDefaultUserModuleAccess(personType = 'EMPLOYEE', role = 'AGENT') {
  const type = String(personType || 'EMPLOYEE').toUpperCase();
  const currentRole = String(role || 'AGENT').toUpperCase();

  if (type === 'HOST') {
    return {
      dashboard: true,
      reservations: false,
      vehicles: false,
      customers: false,
      people: false,
      planner: false,
      reports: false,
      carSharing: false,
      hostApp: true,
      employeeApp: false,
      issueCenter: false,
      loaner: false,
      settings: false,
      security: false,
      tenants: false
    };
  }

  if (currentRole === 'ADMIN') {
    return {
      dashboard: true,
      reservations: true,
      vehicles: true,
      customers: true,
      people: true,
      planner: true,
      reports: true,
      carSharing: true,
      hostApp: true,
      employeeApp: true,
      issueCenter: true,
      loaner: true,
      settings: true,
      security: true,
      tenants: false
    };
  }

  if (currentRole === 'OPS') {
    return {
      dashboard: true,
      reservations: true,
      vehicles: true,
      customers: true,
      people: false,
      planner: true,
      reports: true,
      carSharing: true,
      hostApp: true,
      employeeApp: true,
      issueCenter: true,
      loaner: true,
      settings: false,
      security: false,
      tenants: false
    };
  }

  return {
    dashboard: true,
    reservations: true,
    vehicles: true,
    customers: true,
    people: false,
    planner: true,
    reports: false,
    carSharing: false,
    hostApp: false,
    employeeApp: true,
    issueCenter: true,
    loaner: true,
    settings: false,
    security: false,
    tenants: false
  };
}

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
  const [editingPersonId, setEditingPersonId] = useState('');
  const [userModuleAccess, setUserModuleAccess] = useState(() =>
    buildDefaultUserModuleAccess(EMPTY_PERSON.personType, EMPTY_PERSON.role)
  );

  const role = String(me?.role || '').toUpperCase();
  const isSuper = role === 'SUPER_ADMIN';
  const canManagePeople = ['SUPER_ADMIN', 'ADMIN'].includes(role);
  const canManageModuleAccess = ['SUPER_ADMIN', 'ADMIN'].includes(role);

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

  useEffect(() => {
    if (isSuper && activeTenantId && !editingPersonId) {
      setForm((current) => ({ ...current, tenantId: activeTenantId }));
    }
  }, [isSuper, activeTenantId, editingPersonId]);

  const savePerson = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        ...form,
        tenantId: isSuper ? (form.tenantId || activeTenantId) : undefined
      };
      const out = editingPersonId
        ? await api(`/api/people/${editingPersonId}`, { method: 'PATCH', body: JSON.stringify(payload) }, token)
        : await api('/api/people', { method: 'POST', body: JSON.stringify(payload) }, token);
      if (canManageModuleAccess && out?.person?.userId && (payload.enableLogin !== false || out?.person?.hasLogin)) {
        await api(`/api/settings/users/${out.person.userId}/module-access`, {
          method: 'PUT',
          body: JSON.stringify(userModuleAccess)
        }, token);
      }
      setForm({ ...EMPTY_PERSON, tenantId: isSuper ? activeTenantId : '' });
      setEditingPersonId('');
      setUserModuleAccess(buildDefaultUserModuleAccess(EMPTY_PERSON.personType, EMPTY_PERSON.role));
      setMsg(
        editingPersonId ? 'Person updated' : out?.tempPassword
          ? `Person created. Temporary password: ${out.tempPassword}${out.inviteSent ? ' · Invite sent' : ''}`
          : 'Person created'
      );
      await load();
    } catch (e2) {
      setMsg(e2.message);
    }
  };

  const startEditPerson = (person) => {
    setEditingPersonId(person.id);
    setForm({
      personType: person.personType || 'EMPLOYEE',
      role: person.accessRole || (person.personType === 'ADMIN' ? 'ADMIN' : 'AGENT'),
      tenantId: person.tenantId || activeTenantId || '',
      fullName: person.personType === 'HOST' ? '' : (person.fullName || person.displayName || ''),
      displayName: person.personType === 'HOST' ? (person.displayName || '') : '',
      legalName: person.legalName || '',
      email: person.email || '',
      phone: person.phone || '',
      enableLogin: !!person.hasLogin,
      sendInvite: false,
      password: '',
      payoutProvider: person.payoutProvider || '',
      payoutAccountRef: person.payoutAccountRef || '',
      payoutEnabled: !!person.payoutEnabled,
      notes: person.notes || '',
      status: person.status || 'ACTIVE'
    });
    if (canManageModuleAccess && person.userId && person.hasLogin) {
      api(`/api/settings/users/${person.userId}/module-access`, {}, token)
        .then((out) => setUserModuleAccess(out?.config || {}))
        .catch(() => setUserModuleAccess(buildDefaultUserModuleAccess(person.personType, person.accessRole)));
    } else {
      setUserModuleAccess(buildDefaultUserModuleAccess(person.personType, person.accessRole));
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const resetForm = () => {
    setEditingPersonId('');
    setForm({ ...EMPTY_PERSON, tenantId: isSuper ? activeTenantId : '' });
    setUserModuleAccess(buildDefaultUserModuleAccess(EMPTY_PERSON.personType, EMPTY_PERSON.role));
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

  const canEditPersonRecord = (person) => {
    if (isSuper) return true;
    if (role !== 'ADMIN') return true;
    return person.userId === me?.id || person.createdByUserId === me?.id;
  };

  const metrics = useMemo(() => metricSummary(visiblePeople), [visiblePeople]);
  const hostMode = form.personType === 'HOST';
  const loginRequired = !editingPersonId && (form.personType !== 'HOST' || form.enableLogin);
  const editingPerson = useMemo(() => visiblePeople.find((row) => row.id === editingPersonId) || null, [visiblePeople, editingPersonId]);
  const peopleOpsHub = useMemo(() => {
    const admins = visiblePeople.filter((row) => row.personType === 'ADMIN');
    const hosts = visiblePeople.filter((row) => row.personType === 'HOST');
    const profileOnly = visiblePeople.filter((row) => !row.hasLogin);
    const paused = visiblePeople.filter((row) => String(row.status || '').toUpperCase() === 'PAUSED');

    const nextItems = [
      hosts[0]
        ? {
            id: `host-${hosts[0].id}`,
            title: 'Host Setup Review',
            detail: hosts[0].displayName || hosts[0].legalName || hosts[0].email || 'Host profile',
            note: hosts[0].hasLogin ? 'Host login is enabled and ready for host app access.' : 'Profile-only host. Review if login should be enabled next.',
            action: () => startEditPerson(hosts[0]),
            actionLabel: 'Edit Host'
          }
        : null,
      profileOnly[0]
        ? {
            id: `profile-${profileOnly[0].id}`,
            title: 'Profile-Only User',
            detail: profileOnly[0].displayName || profileOnly[0].fullName || profileOnly[0].email || 'Profile',
            note: 'This person does not have login access yet.',
            action: () => startEditPerson(profileOnly[0]),
            actionLabel: 'Review Access'
          }
        : null,
      paused[0]
        ? {
            id: `paused-${paused[0].id}`,
            title: 'Paused Person',
            detail: paused[0].displayName || paused[0].fullName || paused[0].email || 'Paused profile',
            note: 'Profile is paused and may need reactivation or tenant review.',
            action: () => startEditPerson(paused[0]),
            actionLabel: 'Open Profile'
          }
        : null,
      admins[0]
        ? {
            id: `admin-${admins[0].id}`,
            title: 'Admin Coverage',
            detail: admins[0].displayName || admins[0].fullName || admins[0].email || 'Admin profile',
            note: 'Use this to verify tenant leadership and access routing.',
            action: () => startEditPerson(admins[0]),
            actionLabel: 'Review Admin'
          }
        : null
    ].filter(Boolean);

    return {
      admins: admins.length,
      hosts: hosts.length,
      profileOnly: profileOnly.length,
      paused: paused.length,
      nextItems
    };
  }, [visiblePeople]);

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
              <span className="hero-pill">{editingPersonId ? 'Edit and reassign flow' : (loginRequired ? 'Invite-ready access flow' : 'Profile-only host flow')}</span>
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

      <section className="glass card-lg section-card" style={{ marginBottom: 18 }}>
        <div className="app-banner">
          <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
            <div>
              <span className="eyebrow">People Ops Hub</span>
              <h2 className="page-title" style={{ marginTop: 6 }}>
                Keep tenant access coverage and host readiness in view.
              </h2>
              <p className="ui-muted">A compact mobile-first board before diving into filters, forms, and the full directory.</p>
            </div>
            <span className="status-chip neutral">Identity Ops</span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Admins</span>
              <strong>{peopleOpsHub.admins}</strong>
              <span className="ui-muted">Tenant leadership and high-access users in the current scope.</span>
            </div>
            <div className="info-tile">
              <span className="label">Hosts</span>
              <strong>{peopleOpsHub.hosts}</strong>
              <span className="ui-muted">Profiles tied to supply-side host operations.</span>
            </div>
            <div className="info-tile">
              <span className="label">Profile Only</span>
              <strong>{peopleOpsHub.profileOnly}</strong>
              <span className="ui-muted">People without login access yet.</span>
            </div>
            <div className="info-tile">
              <span className="label">Paused</span>
              <strong>{peopleOpsHub.paused}</strong>
              <span className="ui-muted">Profiles currently paused and needing follow-up.</span>
            </div>
          </div>
          {peopleOpsHub.nextItems.length ? (
            <div className="app-card-grid compact">
              {peopleOpsHub.nextItems.map((item) => (
                <section key={item.id} className="glass card section-card">
                  <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
                  <div className="ui-muted">{item.detail}</div>
                  <div className="surface-note">{item.note}</div>
                  <div className="inline-actions">
                    <button type="button" onClick={item.action}>{item.actionLabel}</button>
                  </div>
                </section>
              ))}
            </div>
          ) : null}
        </div>
      </section>

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
              <div className="section-title">{editingPersonId ? 'Edit Person' : 'Create Person'}</div>
              <div className="ui-muted">{editingPersonId ? 'Update tenant scope, profile details, and host setup.' : personTypeSummary(form.personType)}</div>
            </div>
          </div>

          <form className="stack" onSubmit={savePerson}>
            <div className="form-grid-2">
              {isSuper ? (
                <div className="stack">
                  <label className="label">Assigned Tenant</label>
                  <select value={form.tenantId || ''} onChange={(e) => setForm({ ...form, tenantId: e.target.value })}>
                    {tenants.map((tenant) => (
                      <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
                    ))}
                  </select>
                </div>
              ) : null}

              <div className="stack">
                <label className="label">Person Type</label>
                <select
                  value={form.personType}
                  onChange={(e) => {
                    const nextPersonType = e.target.value;
                    const nextRole = nextPersonType === 'ADMIN' ? 'ADMIN' : 'AGENT';
                    setForm({
                      ...form,
                      personType: nextPersonType,
                      role: nextRole,
                      enableLogin: nextPersonType === 'HOST' ? false : true
                    });
                    if (!editingPersonId) setUserModuleAccess(buildDefaultUserModuleAccess(nextPersonType, nextRole));
                  }}
                  disabled={!!editingPersonId}
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
                  onChange={(e) => {
                    const nextRole = e.target.value;
                    setForm({ ...form, role: nextRole });
                    if (!editingPersonId) setUserModuleAccess(buildDefaultUserModuleAccess(form.personType, nextRole));
                  }}
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

                {!editingPersonId ? (
                  <label className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                    <input
                      type="checkbox"
                      checked={form.enableLogin}
                      onChange={(e) => setForm({ ...form, enableLogin: e.target.checked })}
                    /> Enable host login
                  </label>
                ) : (
                  <div className="surface-note">
                    Existing host login access stays as-is here. This edit flow is for tenant reassignment, profile
                    updates, and payout setup.
                  </div>
                )}

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

                <div className="stack">
                  <label className="label">Host Status</label>
                  <select value={form.status || 'ACTIVE'} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    <option value="ACTIVE">ACTIVE</option>
                    <option value="PAUSED">PAUSED</option>
                    <option value="INACTIVE">INACTIVE</option>
                  </select>
                </div>
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

            {canManageModuleAccess && (editingPersonId ? !!editingPerson?.userId : loginRequired) ? (
              <div className="stack">
                <div className="section-title">User Module Access</div>
                <div className="surface-note">
                  Module access controls what this user can see. Tenant module settings still apply on top of these selections.
                </div>
                <div className="service-checks-grid">
                  {MODULE_DEFINITIONS.filter((item) => item.key !== 'tenants').map((item) => (
                    <label key={item.key} className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                      <input
                        type="checkbox"
                        checked={userModuleAccess[item.key] !== false}
                        onChange={(e) => setUserModuleAccess((current) => ({ ...current, [item.key]: e.target.checked }))}
                      /> {item.label}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="stack">
              <label className="label">Notes</label>
              <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>

            {hostMode && form.enableLogin && !editingPersonId ? (
              <div className="surface-note">
                Host login uses the current platform auth stack for now. In the next slice we can tighten host-specific
                navigation and permissions when we start shaping the host app.
              </div>
            ) : null}

            <div className="inline-actions">
              <button type="submit">{editingPersonId ? 'Save Changes' : 'Create Person'}</button>
              <button type="button" className="button-subtle" onClick={resetForm}>{editingPersonId ? 'Cancel Edit' : 'Reset Form'}</button>
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
                  {isSuper ? <th>Tenant</th> : null}
                  <th>Type</th>
                  <th>Role</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Access</th>
                  <th>Created By</th>
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
                    {isSuper ? <td>{person.tenantName || '-'}</td> : null}
                    <td>{person.personType}</td>
                    <td>{person.accessRole || '-'}</td>
                    <td>{person.email || '-'}</td>
                    <td>{person.phone || '-'}</td>
                    <td>
                      <span className={person.hasLogin ? 'status-chip good' : 'status-chip neutral'}>
                        {person.hasLogin ? 'Login Enabled' : 'Profile Only'}
                      </span>
                    </td>
                    <td>{person.createdByName || '-'}</td>
                    <td>
                      <span className={personStatusClass(person.status)}>{person.status}</span>
                    </td>
                    <td>
                      <div className="inline-actions">
                        {canEditPersonRecord(person) ? (
                          <button type="button" className="button-subtle" onClick={() => startEditPerson(person)}>Edit</button>
                        ) : (
                          <span className="ui-muted" style={{ fontSize: 12 }}>Created by another admin</span>
                        )}
                        {person.hasLogin && person.userId && canEditPersonRecord(person) ? (
                          <button type="button" onClick={() => resetPassword(person)}>Reset Password</button>
                        ) : null}
                      </div>
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
