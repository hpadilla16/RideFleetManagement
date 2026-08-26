'use client';

import { useEffect, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api, TOKEN_KEY, USER_KEY } from '../../lib/client';

const EMPTY_TENANT = { name: '', slug: '', status: 'ACTIVE', plan: 'BETA', carSharingEnabled: false, dealershipLoanerEnabled: false, tollsEnabled: false, citationsEnabled: false, marketIntelligenceEnabled: false };
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

/**
 * A calendar date, rendered in UTC to match how the backend built it.
 *
 * `timeZone: 'UTC'` is LOAD-BEARING, for the same reason it is on the customer's
 * enrollment page: billing dates are 'YYYY-MM-DD' strings because Authorize.Net
 * bills on a calendar day, and rendering one in es-PR/AST (UTC-4) without this
 * option shows the day BEFORE the one that will actually charge. The operator
 * must see the same date the customer consented to.
 */
function billingDate(value) {
  const [y, m, d] = String(value || '').split('-').map(Number);
  if (!y || !m || !d) return '—';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function money(amount, currency = 'USD') {
  if (amount == null || amount === '') return '';
  return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

/**
 * The first day of next month, as a calendar date.
 *
 * The default first-charge date offered in the form, because "start billing at
 * the top of the next cycle" is what the enrollment conversation almost always
 * lands on. Built in UTC so it agrees with every other billing date in the
 * system rather than shifting by a day for an operator west of Greenwich.
 */
function firstOfNextMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return d.toISOString().slice(0, 10);
}

/**
 * What the row says about a tenant's billing, in one line.
 *
 * "Not enrolled" is the important one and is why a tenant with no subscription
 * still gets a label instead of a blank cell: that is revenue nobody remembered
 * to collect, and a blank reads as "still loading" rather than "nobody did this".
 *
 * PENDING_AUTHORIZATION says "link sent, no card yet" rather than "pending",
 * because the operator's next question is always whether the ball is in the
 * customer's court.
 */
const BILLING_LABEL = {
  NONE: 'Not enrolled',
  PENDING_AUTHORIZATION: 'Link sent - awaiting card',
  TRIALING: 'Trial',
  ACTIVE: 'Active',
  PAST_DUE: 'Past due',
  SUSPENDED: 'Suspended',
};

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
  // Which row has the enroll form open, and what is typed in it. One at a time:
  // this mints a link that starts a real billing relationship, and two half
  // filled forms side by side is how the wrong price reaches the wrong tenant.
  const [enrollFor, setEnrollFor] = useState('');
  const [enrollForm, setEnrollForm] = useState(null);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollLink, setEnrollLink] = useState(null);

  const role = String(me?.role || '').toUpperCase().trim();
  const isSuper = role === 'SUPER_ADMIN';
  const activeTenant = rows.find((row) => row.id === activeTenantId) || null;
  const activeTenants = rows.filter((row) => row.status === 'ACTIVE').length;
  const suspendedTenants = rows.filter((row) => row.status === 'SUSPENDED').length;
  const carSharingTenants = rows.filter((row) => row.carSharingEnabled).length;
  const loanerTenants = rows.filter((row) => row.dealershipLoanerEnabled).length;
  const tollTenants = rows.filter((row) => row.tollsEnabled).length;
  const marketIntelligenceTenants = rows.filter((row) => row.marketIntelligenceEnabled).length;
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
          tollsEnabled: !!row.tollsEnabled,
          citationsEnabled: !!row.citationsEnabled,
          marketIntelligenceEnabled: !!row.marketIntelligenceEnabled
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

  /**
   * Reset the demo tenant (2026-08-17). Ride University's practice mode lets
   * trainees rehearse on the demo, which is also what sales demos run on —
   * this puts the stage back. Only ever offered for the tenant flagged as
   * demo; the server refuses anything else regardless of what we send.
   */
  const resetDemo = async () => {
    const target = rows.find((r) => r.id === activeTenantId);
    if (!target?.isDemo) return setMsg('Only the demo tenant can be reset.');
    const typed = prompt(
      [
        `This deletes every reservation, agreement and shuttle request in "${target.name}"`,
        'and puts all vehicles back on the lot.',
        '',
        'Fleet, customers, locations, rates and users are kept.',
        '',
        'Type RESET DEMO to confirm:',
      ].join('\n'),
      '',
    );
    if (typed === null) return undefined;
    try {
      const out = await api(`/api/tenants/${activeTenantId}/reset-demo`, {
        method: 'POST', body: JSON.stringify({ confirm: typed }),
      }, token);
      setMsg(`${out.tenantName} reset — ${out.summary}.`
        + (out.shuttleLinksInvalidated ? ' Shuttle demo links were removed; mint a new one before your next demo.' : ''));
      return undefined;
    } catch (e) {
      return setMsg(e.message);
    }
  };

  /**
   * Open the enroll form for one row, prefilled with the safest defaults.
   *
   * Prefilled, not pre-decided: every field is editable, because the price is
   * negotiated per tenant and the catalog default is only an opening offer. The
   * amount box is left EMPTY when the catalog has no price for the plan — an
   * empty box asks a question, whereas a 0 would quietly enroll somebody at
   * nothing and look deliberate afterwards.
   */
  const openEnroll = (row) => {
    const plan = planCatalog.find((p) => p.code === row.plan);
    setEnrollLink(null);
    setEnrollFor(row.id);
    setEnrollForm({
      email: '',
      planCode: row.plan || 'BETA',
      cycle: 'monthly',
      amount: plan?.priceMonthly == null ? '' : String(plan.priceMonthly),
      // The first charge date, and the page says exactly that. It is the date
      // the customer will read on their own enrollment screen as "Primer
      // cargo", so it is worth being deliberate about.
      startDate: firstOfNextMonth(),
    });
  };

  /**
   * Mint the link. The response carries the plaintext token exactly once — it is
   * stored only as a hash — so it is parked in state and shown until dismissed
   * rather than flashed in the transient message line. There is no way to ask
   * for it again; a lost link means minting a new invite.
   */
  const sendEnrollLink = async () => {
    if (!enrollFor || !enrollForm) return;
    if (!String(enrollForm.email || '').trim()) {
      setMsg('A billing contact email is required — it is who the receipts go to.');
      return;
    }
    setEnrollBusy(true);
    try {
      const out = await api(`/api/tenants/${enrollFor}/billing/enroll-link`, {
        method: 'POST',
        body: JSON.stringify(enrollForm),
      }, token);
      setEnrollLink(out);
      setEnrollFor('');
      setEnrollForm(null);
      setMsg(out.resent
        ? 'Previous links revoked and a new one minted.'
        : 'Enrollment link minted.');
      await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setEnrollBusy(false);
    }
  };

  const impersonateTenant = async (userId = null) => {
    try {
      if (!activeTenantId) return setMsg('Select a tenant first');
      const out = await api(`/api/tenants/${activeTenantId}/impersonate`, { method: 'POST', body: JSON.stringify({ userId }) }, token);
      if (role === 'SUPER_ADMIN') {
        localStorage.setItem('superadmin_backup_token', token);
        localStorage.setItem('superadmin_backup_user', JSON.stringify(me || {}));
        localStorage.setItem('superadmin_backup_viewlocation', localStorage.getItem('ui.viewLocationId') || '');
      }
      // The location we were viewing belongs to OUR tenant. Left in place it
      // rides along as x-view-location under the impersonated token, and every
      // scoped read 403s because that location is not theirs. Practice mode
      // already parks it the same way (PRACTICE_REAL_VIEW_LOCATION_KEY).
      localStorage.removeItem('ui.viewLocationId');
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
              <span className="label">Market Intelligence</span>
              <strong>{marketIntelligenceTenants}</strong>
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
          <div className="grid2">
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
            <label className="label"><input type="checkbox" checked={tenantForm.citationsEnabled} onChange={(e) => setTenantForm((f) => ({ ...f, citationsEnabled: e.target.checked }))} /> Citations Enabled</label>
            <label className="label"><input type="checkbox" checked={tenantForm.marketIntelligenceEnabled} onChange={(e) => setTenantForm((f) => ({ ...f, marketIntelligenceEnabled: e.target.checked }))} /> Market Intelligence Enabled</label>
          </div>
          <button style={{ marginTop: 8 }} onClick={createTenant}>Create Tenant</button>
        </div>

        <div id="tenant-edit-card" className="glass card" style={{ padding: 12 }}>
          <h3 className="section-title">Edit / Suspend Tenants</h3>
          {/* The link, shown until dismissed. It contains the plaintext invite
              token, which exists nowhere else — the invite row stores only a
              sha256 — so this is the single chance to copy it. */}
          {enrollLink ? (
            <div className="app-banner" style={{ marginBottom: 10 }}>
              <div className="stack" style={{ gap: 6 }}>
                <span className="eyebrow">Enrollment link - copy it now</span>
                <div className="label">
                  This is the only time this link is shown. It is stored hashed, so it cannot be
                  retrieved again — losing it means minting a new one. Send it to the billing
                  contact; it expires {billingDate(String(enrollLink.expiresAt).slice(0, 10))}.
                </div>
                <input readOnly value={enrollLink.url} onFocus={(e) => e.target.select()} />
                <div className="label">
                  {enrollLink.subscription.planName} - {money(enrollLink.subscription.amount, enrollLink.subscription.currency)}
                  {' '}/ {enrollLink.subscription.intervalLength === 12 ? 'year' : 'month'}
                  {' '}| First charge {billingDate(enrollLink.subscription.startDate)}
                  {/* trialEndsAt is null for a deferred start. Saying "trial"
                      here when there is none would be the same error the
                      customer-facing page is careful to avoid. */}
                  {enrollLink.subscription.trialEndsAt ? ' | Trial until ' + billingDate(enrollLink.subscription.trialEndsAt) : ' | No trial'}
                  {' '}| ref {enrollLink.tokenPrefix}...
                </div>
              </div>
              <div className="inline-actions">
                <button type="button" onClick={() => setEnrollLink(null)}>Done</button>
              </div>
            </div>
          ) : null}
          <table>
            <thead><tr><th>Name</th><th>Slug</th><th>Status</th><th>Plan</th><th>Billing</th><th>Car Sharing</th><th>Loaner</th><th>Tolls</th><th>Citations</th><th>Market Int.</th><th>Counts</th><th>Actions</th></tr></thead>
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
                  {/* Billing. One line of status plus ONE button — the panel
                      with history, events and the write actions is Phase 4. */}
                  <td>
                    <div className="label">
                      {BILLING_LABEL[r.billing?.status] || r.billing?.status || 'Not enrolled'}
                      {r.billing?.amount ? ` - ${money(r.billing.amount, r.billing.currency)}` : ''}
                    </div>
                    {r.billing?.nextChargeDate ? (
                      <div className="label">
                        {/* "First charge" until one has actually been taken.
                            After that it is the next one. authorizedAt alone is
                            not enough — a deferred start is authorised weeks
                            before any money moves. */}
                        {r.billing.status === 'ACTIVE' && r.billing.startDate === r.billing.nextChargeDate
                          ? 'First charge ' : 'Next charge '}
                        {billingDate(r.billing.nextChargeDate)}
                        {r.billing.cardLast4 ? ` | ${r.billing.cardBrand || 'card'} ...${r.billing.cardLast4}` : ''}
                      </div>
                    ) : null}
                    {r.billing?.planDiverges ? (
                      <div className="error">
                        Billed {r.billing.planCode}, entitled {r.plan}
                      </div>
                    ) : null}
                    {enrollFor === r.id && enrollForm ? (
                      <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                        <input
                          placeholder="Billing contact email"
                          value={enrollForm.email}
                          onChange={(e) => setEnrollForm((f) => ({ ...f, email: e.target.value }))}
                        />
                        <select
                          value={enrollForm.planCode}
                          onChange={(e) => setEnrollForm((f) => ({ ...f, planCode: e.target.value }))}
                        >
                          {(activePlanOptions.length ? activePlanOptions : [{ code: r.plan || 'BETA' }]).map((plan) => (
                            <option key={plan.code} value={plan.code}>{plan.code}</option>
                          ))}
                        </select>
                        <select
                          value={enrollForm.cycle}
                          onChange={(e) => setEnrollForm((f) => ({ ...f, cycle: e.target.value }))}
                        >
                          <option value="monthly">monthly</option>
                          <option value="annual">annual</option>
                        </select>
                        <input
                          type="number" min="0" step="0.01"
                          placeholder="Amount (negotiated)"
                          value={enrollForm.amount}
                          onChange={(e) => setEnrollForm((f) => ({ ...f, amount: e.target.value }))}
                        />
                        <input
                          type="date"
                          value={enrollForm.startDate}
                          onChange={(e) => setEnrollForm((f) => ({ ...f, startDate: e.target.value }))}
                        />
                        <div className="label">
                          First charge date. Setting it means a deferred start, not a trial -
                          the subscription goes ACTIVE and the customer is shown this exact
                          date as their first charge.
                        </div>
                        <div className="inline-actions">
                          <button type="button" onClick={sendEnrollLink} disabled={enrollBusy}>
                            {enrollBusy ? 'Minting...' : 'Mint link'}
                          </button>
                          <button
                            type="button"
                            className="button-subtle"
                            onClick={() => { setEnrollFor(''); setEnrollForm(null); }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (r.billing?.status === 'NONE' || r.billing?.status === 'PENDING_AUTHORIZATION') ? (
                      /* Offered ONLY where it can succeed. Once a card is
                         authorised the server refuses this (changing a running
                         subscription's price is a plan change, not a resend), so
                         showing the button there would be an invitation to a
                         400. Those tenants get the Phase 4 panel instead. */
                      <button type="button" className="button-subtle" onClick={() => openEnroll(r)}>
                        {r.billing.status === 'PENDING_AUTHORIZATION' ? 'Resend enroll link' : 'Send enroll link'}
                      </button>
                    ) : null}
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
                  <td>
                    <label className="label">
                      <input type="checkbox" checked={!!r.citationsEnabled} onChange={(e) => setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, citationsEnabled: e.target.checked } : x))} /> Enabled
                    </label>
                  </td>
                  <td>
                    <label className="label">
                      <input type="checkbox" checked={!!r.marketIntelligenceEnabled} onChange={(e) => setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, marketIntelligenceEnabled: e.target.checked } : x))} /> Enabled
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
          <div className="grid2">
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
            {rows.find((r) => r.id === activeTenantId)?.isDemo && (
              <button
                type="button"
                onClick={resetDemo}
                title="Clear trainee bookings and put the demo back to a clean stage"
                style={{ background: '#fbeceb', color: '#a32b1f', border: '1px solid #f0c8c4' }}
              >
                Reset Demo Data
              </button>
            )}
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
