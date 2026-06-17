/**
 * Market Intelligence dashboard.
 *
 * Single-page UI for the Rate Highway-style scraper pipeline:
 *   - Left rail: list of MarketScrapeProfile + create/edit/delete
 *   - Main area (when a profile is selected):
 *       - Recent runs with status pill (RUNNING / SUCCESS / PARTIAL / FAILED)
 *       - Comparison table for a selected run (cheapest competitor vs current
 *         RateDailyPrice, with willUpdate badges)
 *       - "Apply suggestions" button (force=true) when comparison has writable
 *         rows AND profile has a targetRate
 *
 * Backend endpoints:
 *   GET    /api/market-scraper/profiles
 *   POST   /api/market-scraper/profiles
 *   PATCH  /api/market-scraper/profiles/:id
 *   DELETE /api/market-scraper/profiles/:id
 *   GET    /api/market-scraper/profiles/:id/runs
 *   GET    /api/market-scraper/runs/:runId/comparison
 *   POST   /api/market-scraper/runs/:runId/apply  (body { force: true })
 *
 * Auth: requireModuleAccess('settings') + requireRole(ADMIN, OPS) — backend
 * enforces, frontend nav entry gates display via moduleKey: 'settings'.
 */
'use client';

import { useEffect, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api, API_BASE } from '../../lib/client';

const STRATEGIES = [
  { value: 'CHEAPEST_MINUS_AMOUNT', label: 'Cheapest minus amount' },
  { value: 'MATCH_CHEAPEST', label: 'Match cheapest' },
  { value: 'CHEAPEST_PLUS_PCT', label: 'Cheapest plus percent' },
  { value: 'STATIC_FLOOR', label: 'Static floor (max of cheapest, floor)' }
];

const FREQUENCIES = [
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' }
];

const STATUS_COLORS = {
  PENDING: '#94a3b8',
  RUNNING: '#0ea5e9',
  SUCCESS: '#10b981',
  PARTIAL: '#f59e0b',
  FAILED: '#ef4444'
};

const EMPTY_PROFILE = {
  name: '',
  locationCode: '',
  windowStartDay: 1,
  windowEndDay: 14,
  lorDays: 3,
  sources: ['EXPEDIA'],
  frequency: 'DAILY',
  scheduleHour: 4,
  scheduleMinute: 1,
  strategy: 'CHEAPEST_MINUS_AMOUNT',
  strategyAmount: 1,
  strategyPct: null,
  strategyFloor: null,
  targetRateId: '',
  autoApply: false,
  active: true
};

function fmtDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
}

function fmtMoney(value) {
  if (value == null) return '-';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));
}

function StatusPill({ status }) {
  const color = STATUS_COLORS[status] || '#64748b';
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 10px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: 0.5,
      color: '#fff',
      background: color
    }}>{status || 'NEW'}</span>
  );
}

export default function MarketIntelligencePage() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const [profiles, setProfiles] = useState([]);
  const [selectedProfileId, setSelectedProfileId] = useState(null);
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [comparing, setComparing] = useState(false);
  const [editing, setEditing] = useState(null); // null | EMPTY_PROFILE | profile
  const [msg, setMsg] = useState('');
  const [applying, setApplying] = useState(false);
  const [tenants, setTenants] = useState([]);
  const role = String(me?.role || '').toUpperCase().trim();
  const isSuper = role === 'SUPER_ADMIN';

  useEffect(() => {
    loadProfiles();
    // Super admins manage profiles across tenants — load tenant list so the
    // editor can show a tenant picker. The service rejects creates that have
    // no tenantId in scope or body, which is how Hector hit "tenantId
    // required" the first time he tried to create a profile.
    if (isSuper) {
      api('/api/tenants', {}, token).then((list) => {
        setTenants(Array.isArray(list) ? list : []);
      }).catch(() => { /* non-fatal — editor will warn */ });
    }
  }, [isSuper, token]);

  async function loadProfiles() {
    try {
      const data = await api('/api/market-scraper/profiles', {}, token);
      setProfiles(Array.isArray(data) ? data : []);
    } catch (e) {
      setMsg(`Error loading profiles: ${e.message}`);
    }
  }

  async function loadRuns(profileId) {
    try {
      const data = await api(`/api/market-scraper/profiles/${profileId}/runs?limit=10`, {}, token);
      setRuns(Array.isArray(data) ? data : []);
      setSelectedRunId(null);
      setComparison(null);
    } catch (e) {
      setMsg(`Error loading runs: ${e.message}`);
    }
  }

  async function loadComparison(runId) {
    setComparing(true);
    setComparison(null);
    try {
      const data = await api(`/api/market-scraper/runs/${runId}/comparison`, {}, token);
      setComparison(data);
    } catch (e) {
      setMsg(`Error loading comparison: ${e.message}`);
    } finally {
      setComparing(false);
    }
  }

  async function saveProfile(profile) {
    try {
      if (profile.id) {
        await api(`/api/market-scraper/profiles/${profile.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profile)
        }, token);
      } else {
        await api('/api/market-scraper/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profile)
        }, token);
      }
      setEditing(null);
      setMsg('Profile saved.');
      await loadProfiles();
    } catch (e) {
      setMsg(`Save failed: ${e.message}`);
    }
  }

  async function deleteProfile(id) {
    if (!confirm('Delete this profile? Runs + observations will cascade-delete.')) return;
    try {
      await api(`/api/market-scraper/profiles/${id}`, { method: 'DELETE' }, token);
      setMsg('Profile deleted.');
      if (selectedProfileId === id) {
        setSelectedProfileId(null);
        setRuns([]);
        setComparison(null);
      }
      await loadProfiles();
    } catch (e) {
      setMsg(`Delete failed: ${e.message}`);
    }
  }

  async function applySuggestions() {
    if (!selectedRunId) return;
    setApplying(true);
    try {
      const result = await api(`/api/market-scraper/runs/${selectedRunId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true })
      }, token);
      setMsg(`Applied ${result.appliedCount} suggestions to RateDailyPrice.`);
      await loadComparison(selectedRunId); // refresh so willUpdate clears
      await loadRuns(selectedProfileId);    // refresh pricesApplied counter
    } catch (e) {
      setMsg(`Apply failed: ${e.message}`);
    } finally {
      setApplying(false);
    }
  }

  async function downloadExcel() {
    if (!selectedRunId) return;
    try {
      const res = await fetch(`${API_BASE}/api/market-scraper/runs/${selectedRunId}/export.xlsx`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        let m = `Export failed (${res.status})`;
        try { const j = await res.json(); if (j?.error) m = j.error; } catch { /* ignore */ }
        setMsg(m); return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `market-pricing-${selectedRunId}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { setMsg(`Export failed: ${e.message}`); }
  }

  function selectProfile(id) {
    setSelectedProfileId(id);
    loadRuns(id);
  }

  function selectRun(id) {
    setSelectedRunId(id);
    loadComparison(id);
  }

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

  return (
    <AppShell me={me} logout={logout}>
      <div style={{ display: 'flex', gap: 16, padding: 16, height: 'calc(100vh - 120px)' }}>
        {/* Left rail: profiles */}
        <div style={{ width: 340, borderRight: '1px solid #e2e8f0', paddingRight: 16, overflow: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Profiles</h2>
            <button
              onClick={() => setEditing({ ...EMPTY_PROFILE })}
              style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: '#0284c7', color: '#fff', cursor: 'pointer' }}
            >+ New</button>
          </div>
          {profiles.length === 0 && (
            <p style={{ color: '#64748b', fontSize: 13 }}>No profiles yet. Create one to start scraping.</p>
          )}
          {profiles.map((p) => (
            <div
              key={p.id}
              onClick={() => selectProfile(p.id)}
              style={{
                padding: 10,
                marginBottom: 6,
                borderRadius: 6,
                border: '1px solid #e2e8f0',
                cursor: 'pointer',
                background: selectedProfileId === p.id ? '#f0f9ff' : '#fff'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 14 }}>{p.name}</strong>
                <StatusPill status={p.lastRunStatus} />
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                {p.locationCode} • days {p.windowStartDay}-{p.windowEndDay} • LOR {p.lorDays} • {p.frequency}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                Last run: {fmtDate(p.lastRunAt)}
                {p.autoApply && <span style={{ marginLeft: 8, color: '#10b981', fontWeight: 600 }}>AUTO-APPLY</span>}
              </div>
              <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                <button
                  onClick={(e) => { e.stopPropagation(); setEditing({ ...p }); }}
                  style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #cbd5e1', color: '#0f172a', background: '#fff', borderRadius: 4, cursor: 'pointer' }}
                >Edit</button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteProfile(p.id); }}
                  style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #fecaca', color: '#dc2626', background: '#fff', borderRadius: 4, cursor: 'pointer' }}
                >Delete</button>
              </div>
            </div>
          ))}
        </div>

        {/* Main area */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {msg && (
            <div style={{ padding: 10, marginBottom: 12, background: '#f1f5f9', borderRadius: 6, fontSize: 13 }}>
              {msg}
              <button onClick={() => setMsg('')} style={{ marginLeft: 8, fontSize: 11, padding: '2px 6px', border: 'none', background: 'transparent', cursor: 'pointer' }}>✕</button>
            </div>
          )}

          {!selectedProfileId && (
            <div style={{ color: '#64748b', padding: 24 }}>
              Select a profile on the left to see its run history and comparison diff.
            </div>
          )}

          {selectedProfileId && selectedProfile && (
            <div>
              {runs.length === 0 && (
                <div style={{
                  padding: 12,
                  marginBottom: 12,
                  background: '#fef3c7',
                  border: '1px solid #fbbf24',
                  borderRadius: 6,
                  fontSize: 13,
                  color: '#92400e'
                }}>
                  <strong>This profile has no runs yet.</strong> Profiles are configuration
                  only — they don't run automatically until the scraper droplet is provisioned
                  (Phase 3) with Bright Data Browser API + a daily cron (Phase 6). Until then,
                  the profile sits idle. Manual run trigger from this UI is on the roadmap.
                </div>
              )}
              <h3 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>{selectedProfile.name} — Recent runs</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 24 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                    <th style={{ padding: 6 }}>Started</th>
                    <th style={{ padding: 6 }}>Status</th>
                    <th style={{ padding: 6, textAlign: 'right' }}>OK / Err</th>
                    <th style={{ padding: 6, textAlign: 'right' }}>Observations</th>
                    <th style={{ padding: 6, textAlign: 'right' }}>Applied</th>
                    <th style={{ padding: 6, textAlign: 'right' }}>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.length === 0 && (
                    <tr><td colSpan={6} style={{ padding: 12, color: '#94a3b8', textAlign: 'center' }}>No runs yet.</td></tr>
                  )}
                  {runs.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => selectRun(r.id)}
                      style={{
                        borderBottom: '1px solid #f1f5f9',
                        cursor: 'pointer',
                        background: selectedRunId === r.id ? '#f0f9ff' : 'transparent'
                      }}
                    >
                      <td style={{ padding: 6 }}>{fmtDate(r.startedAt)}</td>
                      <td style={{ padding: 6 }}><StatusPill status={r.status} /></td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{r.requestsOk}/{r.requestsErr}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{r.observationsCount}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{r.pricesApplied}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{r.durationSec ? `${r.durationSec}s` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Comparison */}
              {comparing && <div style={{ padding: 12, color: '#64748b' }}>Loading comparison...</div>}
              {comparison && (
                <ComparisonView
                  comparison={comparison}
                  onApply={applySuggestions}
                  applying={applying}
                  onExport={downloadExcel}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <ProfileEditor
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={saveProfile}
          tenants={isSuper ? tenants : null}
        />
      )}
    </AppShell>
  );
}

function ComparisonView({ comparison, onApply, applying, onExport }) {
  const writableRows = comparison.rows.filter((r) => r.willUpdate && r.vehicleTypeId);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          Comparison — {comparison.strategy} ({comparison.summary.sampled} cells sampled)
        </h4>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          onClick={onExport}
          style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', color: '#0f172a', cursor: 'pointer', fontSize: 13 }}>
          ⬇ Export Excel
        </button>
        <button
          onClick={onApply}
          disabled={applying || comparison.targetRateMissing || writableRows.length === 0}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: 'none',
            background: writableRows.length > 0 ? '#10b981' : '#cbd5e1',
            color: '#fff',
            cursor: writableRows.length > 0 ? 'pointer' : 'not-allowed',
            fontWeight: 600
          }}
        >
          {applying ? 'Applying...' : `Apply ${writableRows.length} suggestion${writableRows.length === 1 ? '' : 's'}`}
        </button>
        </div>
      </div>
      {comparison.targetRateMissing && (
        <div style={{ padding: 8, background: '#fef3c7', borderRadius: 6, fontSize: 13, marginBottom: 12, color: '#92400e' }}>
          Profile has no target rate set — currentPrice / delta columns blank. Set targetRateId on the profile to enable Apply.
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
            <th style={{ padding: 4 }}>Date</th>
            <th style={{ padding: 4 }}>SIPP</th>
            <th style={{ padding: 4, textAlign: 'right' }}>Cheapest</th>
            <th style={{ padding: 4 }}>Vendor</th>
            <th style={{ padding: 4, textAlign: 'right' }}>Sampled</th>
            <th style={{ padding: 4, textAlign: 'right' }}>Current</th>
            <th style={{ padding: 4, textAlign: 'right' }}>Suggested</th>
            <th style={{ padding: 4, textAlign: 'right' }}>Δ</th>
            <th style={{ padding: 4 }}>Update?</th>
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((r, i) => (
            <tr
              key={`${r.date}|${r.sipp}|${i}`}
              style={{
                borderBottom: '1px solid #f1f5f9',
                background: r.willUpdate ? '#fef9c3' : 'transparent',
                color: r.vehicleTypeMissing ? '#94a3b8' : 'inherit'
              }}
            >
              <td style={{ padding: 4 }}>{r.date}</td>
              <td style={{ padding: 4, fontFamily: 'monospace' }}>{r.sipp}</td>
              <td style={{ padding: 4, textAlign: 'right' }}>{fmtMoney(r.marketCheapest)}</td>
              <td style={{ padding: 4, fontSize: 11 }}>{r.marketVendor || '-'}</td>
              <td style={{ padding: 4, textAlign: 'right' }}>{r.marketSampled}</td>
              <td style={{ padding: 4, textAlign: 'right' }}>{fmtMoney(r.currentPrice)}</td>
              <td style={{ padding: 4, textAlign: 'right', fontWeight: 600 }}>{fmtMoney(r.suggestedPrice)}</td>
              <td style={{
                padding: 4,
                textAlign: 'right',
                color: r.deltaAbs == null ? '#94a3b8' : (r.deltaAbs > 0 ? '#10b981' : '#ef4444'),
                fontWeight: 600
              }}>
                {r.deltaAbs == null ? '-' : `${r.deltaAbs >= 0 ? '+' : ''}${r.deltaAbs.toFixed(2)}`}
                {r.deltaPct != null && ` (${r.deltaPct > 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%)`}
              </td>
              <td style={{ padding: 4 }}>
                {r.vehicleTypeMissing ? (
                  <span style={{ fontSize: 10, color: '#94a3b8' }}>no vehicle type</span>
                ) : r.willUpdate ? (
                  <span style={{ fontSize: 10, color: '#b45309', fontWeight: 600 }}>YES</span>
                ) : (
                  <span style={{ fontSize: 10, color: '#94a3b8' }}>no</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProfileEditor({ initial, onCancel, onSave, tenants }) {
  const [form, setForm] = useState(initial);
  const isSuper = tenants !== null && tenants !== undefined;

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSave() {
    // Coerce numeric fields back to numbers before POST/PATCH (text inputs
    // give us strings even for number-typed fields).
    const cleaned = {
      ...form,
      windowStartDay: Number(form.windowStartDay),
      windowEndDay: Number(form.windowEndDay),
      lorDays: Number(form.lorDays),
      scheduleHour: Number(form.scheduleHour),
      scheduleMinute: Number(form.scheduleMinute),
      strategyAmount: form.strategyAmount != null && form.strategyAmount !== '' ? Number(form.strategyAmount) : null,
      strategyPct: form.strategyPct != null && form.strategyPct !== '' ? Number(form.strategyPct) : null,
      strategyFloor: form.strategyFloor != null && form.strategyFloor !== '' ? Number(form.strategyFloor) : null,
      targetRateId: form.targetRateId || null
    };
    onSave(cleaned);
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100
    }}>
      <div style={{ background: '#fff', borderRadius: 8, padding: 24, width: 560, maxHeight: '90vh', overflow: 'auto' }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 600 }}>
          {form.id ? 'Edit profile' : 'New profile'}
        </h3>

        {isSuper && (
          <Field label="Tenant (Super Admin must pick which tenant owns this profile)">
            <select
              value={form.tenantId || ''}
              onChange={(e) => update('tenantId', e.target.value)}
              style={inputStyle}
              disabled={!!form.id /* can't move a profile across tenants */}
            >
              <option value="">— select tenant —</option>
              {(tenants || []).map((t) => (
                <option key={t.id} value={t.id}>{t.name || t.code || t.id}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Name (unique per tenant)">
          <input
            type="text" value={form.name || ''} onChange={(e) => update('name', e.target.value)}
            style={inputStyle} placeholder="e.g. SJU 1-14 Daily"
          />
        </Field>
        <Field label="Location code (airport)">
          <input
            type="text" value={form.locationCode || ''} onChange={(e) => update('locationCode', e.target.value.toUpperCase())}
            style={inputStyle} placeholder="e.g. SJU"
          />
        </Field>
        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="Window start day">
            <input type="number" min={1} max={90} value={form.windowStartDay}
              onChange={(e) => update('windowStartDay', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Window end day">
            <input type="number" min={1} max={90} value={form.windowEndDay}
              onChange={(e) => update('windowEndDay', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="LOR (days)">
            <input type="number" min={1} max={30} value={form.lorDays}
              onChange={(e) => update('lorDays', e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="Frequency">
            <select value={form.frequency} onChange={(e) => update('frequency', e.target.value)} style={inputStyle}>
              {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </Field>
          <Field label="Hour (0-23)">
            <input type="number" min={0} max={23} value={form.scheduleHour}
              onChange={(e) => update('scheduleHour', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Minute (0-59)">
            <input type="number" min={0} max={59} value={form.scheduleMinute}
              onChange={(e) => update('scheduleMinute', e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <Field label="Strategy">
          <select value={form.strategy} onChange={(e) => update('strategy', e.target.value)} style={inputStyle}>
            {STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </Field>
        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="Amount ($)">
            <input type="number" step="0.01" value={form.strategyAmount ?? ''}
              onChange={(e) => update('strategyAmount', e.target.value)}
              style={inputStyle} disabled={form.strategy !== 'CHEAPEST_MINUS_AMOUNT'} />
          </Field>
          <Field label="Percent (%)">
            <input type="number" step="0.01" value={form.strategyPct ?? ''}
              onChange={(e) => update('strategyPct', e.target.value)}
              style={inputStyle} disabled={form.strategy !== 'CHEAPEST_PLUS_PCT'} />
          </Field>
          <Field label="Floor ($)">
            <input type="number" step="0.01" value={form.strategyFloor ?? ''}
              onChange={(e) => update('strategyFloor', e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <Field label="Target Rate ID (leave blank for research-only)">
          <input type="text" value={form.targetRateId ?? ''}
            onChange={(e) => update('targetRateId', e.target.value)}
            style={inputStyle} placeholder="e.g. clxxx..." />
        </Field>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={!!form.active} onChange={(e) => update('active', e.target.checked)} />
            Active
          </label>
          <div>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
              opacity: !form.targetRateId ? 0.5 : 1
            }}>
              <input
                type="checkbox" checked={!!form.autoApply}
                onChange={(e) => update('autoApply', e.target.checked)}
                disabled={!form.targetRateId}
              />
              Auto-apply (writes to RateDailyPrice each run)
            </label>
            {!form.targetRateId && (
              <div style={{ fontSize: 11, color: '#b45309', marginLeft: 24, marginTop: 2 }}>
                Set a Target Rate ID above to enable auto-apply. Without a target, this profile runs as research-only — observations get persisted but no prices are written.
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button onClick={onCancel} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #cbd5e1', color: '#0f172a', background: '#fff', cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={handleSave} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#0284c7', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: '6px 8px',
  borderRadius: 4,
  border: '1px solid #cbd5e1',
  fontSize: 13
};

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 10, flex: 1 }}>
      <label style={{ display: 'block', fontSize: 12, color: '#475569', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}
