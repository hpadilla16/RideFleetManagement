'use client';

import { useEffect, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api, TOKEN_KEY, USER_KEY } from '../../lib/client';

const EMPTY_TENANT = { name: '', slug: '', status: 'ACTIVE', plan: 'BETA' };
const EMPTY_ADMIN = { email: '', fullName: '', password: 'TempPass123!' };

export default function TenantsPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const [msg, setMsg] = useState('');
  const [rows, setRows] = useState([]);
  const [tenantForm, setTenantForm] = useState(EMPTY_TENANT);
  const [adminForm, setAdminForm] = useState(EMPTY_ADMIN);
  const [activeTenantId, setActiveTenantId] = useState('');
  const [admins, setAdmins] = useState([]);

  const role = String(me?.role || '').toUpperCase().trim();
  const isSuper = role === 'SUPER_ADMIN';

  const load = async () => {
    try {
      const list = await api('/api/tenants', {}, token);
      setRows(list || []);
      if (!activeTenantId && list?.length) setActiveTenantId(list[0].id);
      setMsg('');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const loadAdmins = async (tenantId) => {
    if (!tenantId) return setAdmins([]);
    try {
      const list = await api(`/api/tenants/${tenantId}/admins`, {}, token);
      setAdmins(list || []);
    } catch (e) {
      setMsg(e.message);
    }
  };

  useEffect(() => { load(); }, [token]);
  useEffect(() => { loadAdmins(activeTenantId); }, [activeTenantId]);

  const createTenant = async () => {
    try {
      const created = await api('/api/tenants', { method: 'POST', body: JSON.stringify(tenantForm) }, token);
      setTenantForm(EMPTY_TENANT);
      setMsg(`Tenant created: ${created.slug}`);
      await load();
      setActiveTenantId(created.id);
    } catch (e) {
      setMsg(e.message);
    }
  };

  const saveTenant = async (row) => {
    try {
      await api(`/api/tenants/${row.id}`, { method: 'PATCH', body: JSON.stringify({ name: row.name, slug: row.slug, status: row.status, plan: row.plan }) }, token);
      setMsg('Tenant updated');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const createTenantAdmin = async () => {
    try {
      if (!activeTenantId) return setMsg('Select a tenant first');
      const created = await api(`/api/tenants/${activeTenantId}/admins`, { method: 'POST', body: JSON.stringify(adminForm) }, token);
      setAdminForm(EMPTY_ADMIN);
      setMsg(`Tenant admin created: ${created.email}`);
      await loadAdmins(activeTenantId);
    } catch (e) {
      setMsg(e.message);
    }
  };

  const resetAdminPassword = async (userId) => {
    try {
      if (!activeTenantId) return setMsg('Select a tenant first');
      const pwd = prompt('Set temporary password', 'TempPass123!');
      if (!pwd) return;
      const out = await api(`/api/tenants/${activeTenantId}/admins/${userId}/reset-password`, { method: 'POST', body: JSON.stringify({ password: pwd }) }, token);
      setMsg(`Password reset for ${out.email}. Temp password: ${out.tempPassword}`);
    } catch (e) {
      setMsg(e.message);
    }
  };

  const impersonateTenant = async (userId = null) => {
    try {
      if (!activeTenantId) return setMsg('Select a tenant first');
      const out = await api(`/api/tenants/${activeTenantId}/impersonate`, { method: 'POST', body: JSON.stringify({ userId }) }, token);
      // Keep a one-click return path to super-admin context.
      if (role === 'SUPER_ADMIN') {
        localStorage.setItem('superadmin_backup_token', token);
        localStorage.setItem('superadmin_backup_user', JSON.stringify(me || {}));
      }
      localStorage.setItem(TOKEN_KEY, out.token);
      localStorage.setItem(USER_KEY, JSON.stringify(out.user || {}));
      window.location.href = '/dashboard';
    } catch (e) {
      setMsg(e.message);
    }
  };

  if (!isSuper) {
    return <AppShell me={me} logout={logout}><section className="glass card-lg"><h2>Tenants</h2><p className="error">Super admin only.</p></section></AppShell>;
  }

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="row-between"><h2 className="page-title">Super Admin → Tenants</h2></div>
        {msg ? <div className="label">{msg}</div> : null}

        <div className="glass card" style={{ padding: 12 }}>
          <h3 className="section-title">Create Tenant</h3>
          <div className="grid-2">
            <input placeholder="Name" value={tenantForm.name} onChange={(e) => setTenantForm((f) => ({ ...f, name: e.target.value }))} />
            <input placeholder="Slug (e.g. acme-fleet)" value={tenantForm.slug} onChange={(e) => setTenantForm((f) => ({ ...f, slug: e.target.value }))} />
            <select value={tenantForm.status} onChange={(e) => setTenantForm((f) => ({ ...f, status: e.target.value }))}>
              <option value="ACTIVE">ACTIVE</option>
              <option value="SUSPENDED">SUSPENDED</option>
            </select>
            <select value={tenantForm.plan} onChange={(e) => setTenantForm((f) => ({ ...f, plan: e.target.value }))}>
              <option value="BETA">BETA</option>
              <option value="PRO">PRO</option>
              <option value="ENTERPRISE">ENTERPRISE</option>
            </select>
          </div>
          <button style={{ marginTop: 8 }} onClick={createTenant}>Create Tenant</button>
        </div>

        <div className="glass card" style={{ padding: 12 }}>
          <h3 className="section-title">Edit / Suspend Tenants</h3>
          <table>
            <thead><tr><th>Name</th><th>Slug</th><th>Status</th><th>Plan</th><th>Counts</th><th>Actions</th></tr></thead>
            <tbody>
              {(rows || []).map((r) => (
                <tr key={r.id}>
                  <td><input value={r.name || ''} onChange={(e) => setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, name: e.target.value } : x))} /></td>
                  <td><input value={r.slug || ''} onChange={(e) => setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, slug: e.target.value } : x))} /></td>
                  <td>
                    <select value={r.status || 'ACTIVE'} onChange={(e) => setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, status: e.target.value } : x))}>
                      <option value="ACTIVE">ACTIVE</option>
                      <option value="SUSPENDED">SUSPENDED</option>
                    </select>
                  </td>
                  <td>
                    <select value={r.plan || 'BETA'} onChange={(e) => setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, plan: e.target.value } : x))}>
                      <option value="BETA">BETA</option>
                      <option value="PRO">PRO</option>
                      <option value="ENTERPRISE">ENTERPRISE</option>
                    </select>
                  </td>
                  <td className="label">U:{r?._count?.users || 0} L:{r?._count?.locations || 0} C:{r?._count?.customers || 0} V:{r?._count?.vehicles || 0} R:{r?._count?.reservations || 0}</td>
                  <td><button onClick={() => { setActiveTenantId(r.id); saveTenant(r); }}>Save</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="glass card" style={{ padding: 12 }}>
          <h3 className="section-title">Create Tenant Admin</h3>
          <div className="grid-2">
            <select value={activeTenantId} onChange={(e) => setActiveTenantId(e.target.value)}>
              <option value="">Select Tenant</option>
              {(rows || []).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.slug})</option>)}
            </select>
            <input placeholder="Admin full name" value={adminForm.fullName} onChange={(e) => setAdminForm((f) => ({ ...f, fullName: e.target.value }))} />
            <input placeholder="Admin email" value={adminForm.email} onChange={(e) => setAdminForm((f) => ({ ...f, email: e.target.value }))} />
            <input placeholder="Temporary password" value={adminForm.password} onChange={(e) => setAdminForm((f) => ({ ...f, password: e.target.value }))} />
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button onClick={createTenantAdmin}>Create Tenant Admin</button>
            <button type="button" onClick={() => impersonateTenant(null)}>Impersonate Tenant</button>
          </div>

          <div style={{ marginTop: 10 }}>
            <div className="label">Current tenant admins</div>
            <ul>
              {(admins || []).map((a) => (
                <li key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>{a.fullName} — {a.email} ({a.role})</span>
                  <button type="button" onClick={() => resetAdminPassword(a.id)}>Reset Password</button>
                  <button type="button" onClick={() => impersonateTenant(a.id)}>Impersonate</button>
                </li>
              ))}
              {!admins?.length ? <li className="label">No admins</li> : null}
            </ul>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
