'use client';

import { useEffect, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api, TOKEN_KEY, USER_KEY } from '../../lib/client';

const EMPTY_TENANT = { name: '', slug: '', status: 'ACTIVE', plan: 'BETA', carSharingEnabled: false, dealershipLoanerEnabled: false, tollsEnabled: false };
const EMPTY_ADMIN = { email: '', fullName: '', password: 'TempPass123!' };
const EMPTY_PLAN = {
  code: '',
  name: '',
  maxAdmins: '',
  maxUsers: '',
  maxVehicles: '',
  smartPlannerIncluded: true,
  plannerCopilotIncluded: false,
  plannerCopilotMonthlyQueryCap: '',
  plannerCopilotAllowedModels: ['gpt-4.1-mini'],
  telematicsIncluded: false,
  inspectionIntelligenceIncluded: true,
  isActive: true
};

function limitLabel(value) {
  return value == null || value === '' ? 'Unlimited' : String(value);
}

export default function TenantsPage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const [msg, setMsg] = useState('');
  const [rows, setRows] = useState([]);
  const [planCatalog, setPlanCatalog] = useState([]);
  const [tenantForm, setTenantForm] = useState(EMPTY_TENANT);
  const [adminForm, setAdminForm] = useState(EMPTY_ADMIN);
  const [activeTenantId, setActiveTenantId] = useState('');
  const [admins, setAdmins] = useState([]);

  const role = String(me?.role || '').toUpperCase().trim();
  const isSuper = role === 'SUPER_ADMIN';
  const activeTenant = rows.find((row) => row.id === activeTenantId) || null;
  const activeTenants = rows.filter((row) => row.status === 'ACTIVE').length;
  const suspendedTenants = rows.filter((row) => row.status === 'SUSPENDED').length;
  const carSharingTenants = rows.filter((row) => row.carSharingEnabled).length;
  const loanerTenants = rows.filter((row) => row.dealershipLoanerEnabled).length;
  const tollTenants = rows.filter((row) => row.tollsEnabled).length;
  const enterpriseTenants = rows.filter((row) => row.plan === 'ENTERPRISE').length;
  const activePlanOptions = planCatalog.filter((row) => row.isActive !== false);

  const load = async () => {
    try {
      const [list, plans] = await Promise.all([
        api('/api/tenants', {}, token),
        api('/api/tenants/plan-catalog', {}, token)
      ]);
      setRows(list || []);
      setPlanCatalog(plans || []);
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

  const savePlanCatalog = async () => {
    try {
      const payload = planCatalog.map((row) => ({
        ...row,
        code: String(row.code || '').trim().toUpperCase(),
        name: String(row.name || '').trim(),
        maxAdmins: row.maxAdmins === '' ? null : Number(row.maxAdmins),
        maxUsers: row.maxUsers === '' ? null : Number(row.maxUsers),
        maxVehicles: row.maxVehicles === '' ? null : Number(row.maxVehicles),
        smartPlannerIncluded: row.smartPlannerIncluded !== false,
        plannerCopilotIncluded: !!row.plannerCopilotIncluded,
        plannerCopilotMonthlyQueryCap: row.plannerCopilotMonthlyQueryCap === '' ? null : Number(row.plannerCopilotMonthlyQueryCap),
        plannerCopilotAllowedModels: Array.isArray(row.plannerCopilotAllowedModels) ? row.plannerCopilotAllowedModels : [],
        telematicsIncluded: !!row.telematicsIncluded,
        inspectionIntelligenceIncluded: row.inspectionIntelligenceIncluded !== false,
        isActive: !!row.isActive
      }));
      const saved = await api('/api/tenants/plan-catalog', {
        method: 'PUT',
        body: JSON.stringify({ plans: payload })
      }, token);
      setPlanCatalog(saved || []);
      setMsg('Tenant plan catalog updated');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const saveTenant = async (row) => {
    try {
      await api(`/api/tenants/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: row.name,
          slug: row.slug,
          status: row.status,
          plan: row.plan,
          carSharingEnabled: !!row.carSharingEnabled,
          dealershipLoanerEnabled: !!row.dealershipLoanerEnabled,
          tollsEnabled: !!row.tollsEnabled
        })
      }, token);
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
        <div className="row-between"><h2 className="page-title">Super Admin - Tenants</h2></div>
        {msg ? <div className="label">{msg}</div> : null}

        <div className="app-banner">
          <div className="row-between" style={{ marginBottom: 0 }}>
            <div className="stack" style={{ gap: 6 }}>
              <span className="eyebrow">Tenant Hub</span>
              <h2 style={{ margin: 0 }}>Workspace Portfolio</h2>
              <p className="ui-muted">
                Review tenant health, enabled products, and the active support scope before creating admins or changing feature flags.
              </p>
            </div>
            <span className={`status-chip ${activeTenant?.status === 'ACTIVE' ? 'good' : activeTenant ? 'warn' : 'neutral'}`}>
              {activeTenant ? `${activeTenant.name} focused` : 'Choose tenant'}
            </span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Active Tenants</span>
              <strong>{activeTenants}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Suspended</span>
              <strong>{suspendedTenants}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Car Sharing</span>
              <strong>{carSharingTenants}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Loaner Enabled</span>
              <strong>{loanerTenants}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Tolls Enabled</span>
              <strong>{tollTenants}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Enterprise Plan</span>
              <strong>{enterpriseTenants}</strong>
            </div>
            <div className="info-tile">
              <span className="label">Focused Tenant</span>
              <strong>{activeTenant?.slug || 'Select one'}</strong>
            </div>
          </div>
          <div className="inline-actions">
            <button type="button" onClick={() => document.getElementById('tenant-plan-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Plan Catalog</button>
            <button type="button" onClick={() => document.getElementById('tenant-create-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Create Tenant</button>
            <button type="button" onClick={() => document.getElementById('tenant-edit-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Edit Tenants</button>
            <button type="button" onClick={() => document.getElementById('tenant-admin-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Tenant Admins</button>
          </div>
        </div>

        <div id="tenant-plan-card" className="glass card" style={{ padding: 12 }}>
          <div className="row-between">
            <div>
              <h3 className="section-title">Plan Catalog</h3>
              <div className="label">Define the tenant plans you sell and the limits for admins, users, and fleet size.</div>
            </div>
            <div className="inline-actions">
              <button type="button" onClick={() => setPlanCatalog((prev) => [...prev, { ...EMPTY_PLAN, code: `PLAN${prev.length + 1}` }])}>Add Plan</button>
              <button type="button" onClick={savePlanCatalog}>Save Plan Catalog</button>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Max Admins</th>
                <th>Max Users</th>
                <th>Max Vehicles</th>
                <th>Copilot</th>
                <th>Cap</th>
                <th>Models</th>
                <th>Telematics</th>
                <th>Inspection</th>
                <th>Active</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {planCatalog.length ? planCatalog.map((plan, idx) => (
                <tr key={`${plan.code || 'new'}-${idx}`}>
                  <td><input value={plan.code || ''} onChange={(e) => setPlanCatalog((prev) => prev.map((row, rowIdx) => rowIdx === idx ? { ...row, code: e.target.value.toUpperCase() } : row))} /></td>
                  <td><input value={plan.name || ''} onChange={(e) => setPlanCatalog((prev) => prev.map((row, rowIdx) => rowIdx === idx ? { ...row, name: e.target.value } : row))} /></td>
                  <td><input type="number" min="0" placeholder="Unlimited" value={plan.maxAdmins ?? ''} onChange={(e) => setPlanCatalog((prev) => prev.map((row, rowIdx) => rowIdx === idx ? { ...row, maxAdmins: e.target.value } : row))} /></td>
                  <td><input type="number" min="0" placeholder="Unlimited" value={plan.maxUsers ?? ''} onChange={(e) => setPlanCatalog((prev) => prev.map((row, rowIdx) => rowIdx === idx ? { ...row, maxUsers: e.target.value } : row))} /></td>
                  <td><input type="number" min="0" placeholder="Unlimited" value={plan.maxVehicles ?? ''} onChange={(e) => setPlanCatalog((prev) => prev.map((row, rowIdx) => rowIdx === idx ? { ...row, maxVehicles: e.target.value } : row))} /></td>
                  <td><label className="label"><input type="checkbox" checked={plan.plannerCopilotIncluded === true} onChange={(e) => setPlanCatalog((prev) => prev.map((row, rowIdx) => rowIdx === idx ? { ...row, plannerCopilotIncluded: e.target.checked } : row))} /> Included</label></td>
                  <td><input type="number" min="0" placeholder="Unlimited" value={plan.plannerCopilotMonthlyQueryCap ?? ''} onChange={(e) => setPlanCatalog((prev) => prev.map((row, rowIdx) => rowIdx === idx ? { ...row, plannerCopilotMonthlyQueryCap: e.target.value } : row))} /></td>
                  <td><input value={Array.isArray(plan.plannerCopilotAllowedModels) ? plan.plannerCopilotAllowedModels.join(', ') : ''} onChange={(e) => setPlanCatalog((prev) => prev.map((row, rowIdx) => rowIdx === idx ? { ...row, plannerCopilotAllowedModels: e.target.value.split(',').map((item) => item.trim()).filter(Boolean) } : row))} placeholder="gpt-4.1-mini, gpt-4.1" /></td>
                  <td><label className="label"><input type="checkbox" checked={plan.telematicsIncluded === true} onChange={(e) => setPlanCatalog((prev) => prev.map((row, rowIdx) => rowIdx === idx ? { ...row, telematicsIncluded: e.target.checked } : row))} /> Included</label></td>
                  <td><label className="label"><input type="checkbox" checked={plan.inspectionIntelligenceIncluded !== false} onChange={(e) => setPlanCatalog((prev) => prev.map((row, rowIdx) => rowIdx === idx ? { ...row, inspectionIntelligenceIncluded: e.target.checked } : row))} /> Included</label></td>
                  <td><label className="label"><input type="checkbox" checked={plan.isActive !== false} onChange={(e) => setPlanCatalog((prev) => prev.map((row, rowIdx) => rowIdx === idx ? { ...row, isActive: e.target.checked } : row))} /> Active</label></td>
                  <td><button type="button" className="button-subtle" onClick={() => setPlanCatalog((prev) => prev.filter((_, rowIdx) => rowIdx !== idx))}>Remove</button></td>
                </tr>
              )) : (
                <tr><td colSpan="12">No plans configured yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div id="tenant-create-card" className="glass card" style={{ padding: 12 }}>
          <h3 className="section-title">Create Tenant</h3>
          <div className="grid-2">
            <input placeholder="Name" value={tenantForm.name} onChange={(e) => setTenantForm((f) => ({ ...f, name: e.target.value }))} />
            <input placeholder="Slug (e.g. acme-fleet)" value={tenantForm.slug} onChange={(e) => setTenantForm((f) => ({ ...f, slug: e.target.value }))} />
            <select value={tenantForm.status} onChange={(e) => setTenantForm((f) => ({ ...f, status: e.target.value }))}>
              <option value="ACTIVE">ACTIVE</option>
              <option value="SUSPENDED">SUSPENDED</option>
            </select>
            <select value={tenantForm.plan} onChange={(e) => setTenantForm((f) => ({ ...f, plan: e.target.value }))}>
              {(activePlanOptions.length ? activePlanOptions : [{ code: 'BETA', name: 'Beta' }]).map((plan) => (
                <option key={plan.code} value={plan.code}>{plan.code}</option>
              ))}
            </select>
            <label className="label"><input type="checkbox" checked={tenantForm.carSharingEnabled} onChange={(e) => setTenantForm((f) => ({ ...f, carSharingEnabled: e.target.checked }))} /> Car Sharing Enabled</label>
            <label className="label"><input type="checkbox" checked={tenantForm.dealershipLoanerEnabled} onChange={(e) => setTenantForm((f) => ({ ...f, dealershipLoanerEnabled: e.target.checked }))} /> Dealership Loaner Enabled</label>
            <label className="label"><input type="checkbox" checked={tenantForm.tollsEnabled} onChange={(e) => setTenantForm((f) => ({ ...f, tollsEnabled: e.target.checked }))} /> Tolls Enabled</label>
          </div>
          <button style={{ marginTop: 8 }} onClick={createTenant}>Create Tenant</button>
        </div>

        <div id="tenant-edit-card" className="glass card" style={{ padding: 12 }}>
          <h3 className="section-title">Edit / Suspend Tenants</h3>
          <table>
            <thead><tr><th>Name</th><th>Slug</th><th>Status</th><th>Plan</th><th>Car Sharing</th><th>Loaner</th><th>Tolls</th><th>Counts</th><th>Actions</th></tr></thead>
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
                      {Array.from(new Map([...activePlanOptions, ...(r.plan && !activePlanOptions.some((plan) => plan.code === r.plan) ? [{ code: r.plan, name: r.plan, isActive: false }] : [])].map((plan) => [plan.code, plan])).values()).map((plan) => (
                        <option key={plan.code} value={plan.code}>{plan.code}</option>
                      ))}
                    </select>
                    <div className="label">
                      {r.planConfig?.name || r.plan || 'Plan'} | Admins {limitLabel(r.planConfig?.maxAdmins)} | Users {limitLabel(r.planConfig?.maxUsers)} | Vehicles {limitLabel(r.planConfig?.maxVehicles)}
                    </div>
                  </td>
                  <td>
                    <label className="label">
                      <input type="checkbox" checked={!!r.carSharingEnabled} onChange={(e) => setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, carSharingEnabled: e.target.checked } : x))} /> Enabled
                    </label>
                  </td>
                  <td>
                    <label className="label">
                      <input type="checkbox" checked={!!r.dealershipLoanerEnabled} onChange={(e) => setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, dealershipLoanerEnabled: e.target.checked } : x))} /> Enabled
                    </label>
                  </td>
                  <td>
                    <label className="label">
                      <input type="checkbox" checked={!!r.tollsEnabled} onChange={(e) => setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, tollsEnabled: e.target.checked } : x))} /> Enabled
                    </label>
                  </td>
                  <td className="label">
                    Staff {r?.planUsage?.users ?? 0}/{limitLabel(r?.planConfig?.maxUsers)} | Admins {r?.planUsage?.admins ?? 0}/{limitLabel(r?.planConfig?.maxAdmins)} | Vehicles {r?.planUsage?.vehicles ?? 0}/{limitLabel(r?.planConfig?.maxVehicles)}
                    <div>L:{r?._count?.locations || 0} C:{r?._count?.customers || 0} R:{r?._count?.reservations || 0}</div>
                    {r?.planStatus?.overUsers || r?.planStatus?.overAdmins || r?.planStatus?.overVehicles ? <div className="error">Over current plan limit</div> : null}
                  </td>
                  <td><button onClick={() => { setActiveTenantId(r.id); saveTenant(r); }}>Save</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div id="tenant-admin-card" className="glass card" style={{ padding: 12 }}>
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
                  <span>{a.fullName} - {a.email} ({a.role})</span>
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
