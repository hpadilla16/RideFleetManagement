'use client';

/**
 * Settings → Upsell catalog & rules (Kiosk) — Fase B3b, mockup A2 in
 * doc/kiosk-mockups-2026-07-04.html.
 *
 * - Products list = READ-ONLY view of the AdditionalService catalog (managed
 *   in Settings → Additional Services — the kiosk never duplicates it).
 * - Channel rules: GET/PUT /api/kiosk/upsell-rules. One rule per channel;
 *   '*' is the tenant default. NOTE: EXPEDIA/PRICELINE rules only take effect
 *   once bookings carry that normalized bookingChannel (TSD/OTA connector
 *   acceptance item) — until then every OTA booking falls back to '*'.
 * - Packages: GET/PUT /api/kiosk/packages — BASIC/RECOMMENDED/PREMIUM built
 *   from AdditionalService IDs (never codes), validated server-side.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/client';

const CHANNEL_PRESETS = ['*', 'EXPEDIA', 'PRICELINE', 'WEBSITE', 'STAFF', 'KIOSK_WALKUP'];
const STRATEGIES = ['PACKAGES_3', 'UPGRADE_FIRST'];
const PACKAGE_KEYS = ['BASIC', 'RECOMMENDED', 'PREMIUM'];

const money = (v) => `$${Number(v || 0).toFixed(2)}`;

export function KioskUpsellSettings({ token, scopedPath }) {
  const [services, setServices] = useState([]);
  const [rules, setRules] = useState([]);
  const [packages, setPackages] = useState({}); // key → { enabled, name, serviceIds[] }
  const [ruleDraft, setRuleDraft] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const activeServices = useMemo(() => services.filter((s) => s.isActive !== false), [services]);
  const serviceName = (id) => services.find((s) => s.id === id)?.name || id;

  async function reload() {
    try {
      const [servicesOut, rulesOut, packagesOut] = await Promise.all([
        api(scopedPath('/api/additional-services'), { bypassCache: true }, token),
        api(scopedPath('/api/kiosk/upsell-rules'), { bypassCache: true }, token),
        api(scopedPath('/api/kiosk/packages'), { bypassCache: true }, token),
      ]);
      setServices(Array.isArray(servicesOut) ? servicesOut : []);
      setRules(Array.isArray(rulesOut) ? rulesOut : []);
      const byKey = {};
      for (const pkg of (packagesOut?.packages || [])) {
        byKey[pkg.key] = { enabled: true, name: pkg.name || pkg.key, serviceIds: pkg.serviceIds || [] };
      }
      for (const key of PACKAGE_KEYS) {
        if (!byKey[key]) byKey[key] = { enabled: false, name: key.charAt(0) + key.slice(1).toLowerCase(), serviceIds: [] };
      }
      setPackages(byKey);
    } catch (e) { setMsg(String(e?.message || e)); }
  }
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [token]);

  async function saveRule() {
    if (!ruleDraft?.channel?.trim()) { setMsg('Channel is required (use * for the default rule)'); return; }
    setBusy(true); setMsg('');
    try {
      await api(scopedPath('/api/kiosk/upsell-rules'), {
        method: 'PUT',
        body: JSON.stringify({
          channel: ruleDraft.channel.trim().toUpperCase(),
          strategy: ruleDraft.strategy,
          isActive: ruleDraft.isActive !== false,
          offerServiceIds: ruleDraft.offerServiceIds,
          prepaidServiceIds: ruleDraft.prepaidServiceIds,
        }),
      }, token);
      setRuleDraft(null);
      setMsg('Channel rule saved');
      await reload();
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  }

  async function savePackages() {
    const payload = PACKAGE_KEYS
      .filter((key) => packages[key]?.enabled && (packages[key]?.serviceIds || []).length)
      .map((key) => ({ key, name: packages[key].name || key, serviceIds: packages[key].serviceIds }));
    setBusy(true); setMsg('');
    try {
      await api(scopedPath('/api/kiosk/packages'), { method: 'PUT', body: JSON.stringify({ packages: payload }) }, token);
      setMsg('Packages saved');
      await reload();
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  }

  const toggleId = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const ServicePicker = ({ selected, onToggle, disabledIds = [] }) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {activeServices.map((service) => {
        const on = selected.includes(service.id);
        const disabled = disabledIds.includes(service.id);
        return (
          <button
            key={service.id}
            type="button"
            className={on ? '' : 'button-subtle'}
            disabled={disabled}
            title={disabled ? 'Already in the other list' : (service.code || '')}
            style={{ opacity: disabled ? 0.4 : 1, fontSize: 12.5, padding: '6px 10px' }}
            onClick={() => onToggle(service.id)}
          >
            {on ? '✓ ' : ''}{service.name}
            {Number(service.dailyRate || 0) > 0 ? ` · ${money(service.dailyRate)}/day` : ` · ${money(service.rate)}`}
          </button>
        );
      })}
      {!activeServices.length ? <span className="ui-muted">No active services — add them in Additional Services first.</span> : null}
    </div>
  );

  return (
    <div className="stack">
      <h2>Kiosk — Upsell catalog &amp; rules</h2>
      <p className="ui-muted" style={{ marginTop: -6 }}>
        What the kiosk offers at the “Protection &amp; extras” step, per booking channel. The kiosk never offers what the
        broker already collected, and prices always come from the server-side catalog.
      </p>
      {msg ? <p className="label">{msg}</p> : null}

      <section className="glass card section-card">
        <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
          <div className="stack" style={{ gap: 4 }}>
            <h3 style={{ margin: 0 }}>Products (ancillaries) — read-only</h3>
            <div className="ui-muted">
              This is the tenant&apos;s AdditionalService catalog. Add or edit products in
              {' '}<strong>Settings → Additional Services</strong>; the kiosk composes rules and packages from it.
            </div>
          </div>
        </div>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Code</th>
                <th style={{ textAlign: 'left' }}>Product</th>
                <th style={{ textAlign: 'left' }}>Charge</th>
                <th style={{ textAlign: 'left' }}>Price</th>
                <th style={{ textAlign: 'left' }}>Taxable</th>
                <th style={{ textAlign: 'left' }}>Active</th>
              </tr>
            </thead>
            <tbody>
              {services.map((service) => (
                <tr key={service.id}>
                  <td className="ui-muted">{service.code || '—'}</td>
                  <td><strong>{service.name}</strong>{service.linkedFeeId ? <span className="ui-muted" title="Linked-fee services are excluded from kiosk offers until Fase B3/B4."> · linked fee (kiosk-excluded)</span> : null}</td>
                  <td>{Number(service.dailyRate || 0) > 0 ? 'Daily' : 'One-time'}</td>
                  <td>{Number(service.dailyRate || 0) > 0 ? `${money(service.dailyRate)}/day` : money(service.rate)}</td>
                  <td>{service.taxable ? 'Yes' : 'No'}</td>
                  <td>{service.isActive === false ? <span className="status-chip bad">Off</span> : <span className="status-chip good">On</span>}</td>
                </tr>
              ))}
              {!services.length ? <tr><td colSpan={6} className="ui-muted">No services configured yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="glass card section-card">
        <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
          <div className="stack" style={{ gap: 4 }}>
            <h3 style={{ margin: 0 }}>Channel rules — what to offer per broker</h3>
            <div className="ui-muted">
              One rule per channel; <code>*</code> is the fallback for everything without its own rule. “Prepaid by broker”
              services are <strong>never</strong> offered (not as add-ons, not inside packages). Heads-up: <code>EXPEDIA</code>/<code>PRICELINE</code>
              {' '}rules only apply once bookings actually carry that channel (they will after the TSD/OTA connector stamps
              {' '}<code>bookingChannel</code>) — today most bookings are WEBSITE/STAFF and use the <code>*</code> rule.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setRuleDraft({ channel: '*', strategy: 'PACKAGES_3', isActive: true, offerServiceIds: [], prepaidServiceIds: [] })}
          >
            + Add / edit rule
          </button>
        </div>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Channel</th>
                <th style={{ textAlign: 'left' }}>Offer</th>
                <th style={{ textAlign: 'left' }}>Prepaid by broker (never offer)</th>
                <th style={{ textAlign: 'left' }}>Strategy</th>
                <th style={{ textAlign: 'left' }}>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id || rule.channel}>
                  <td><strong>{rule.channel === '*' ? '* (default)' : rule.channel}</strong></td>
                  <td className="ui-muted">{(rule.offerServiceIds || []).map(serviceName).join(' · ') || '—'}</td>
                  <td className="ui-muted">{(rule.prepaidServiceIds || []).map(serviceName).join(' · ') || 'nothing'}</td>
                  <td><span className="status-chip neutral">{rule.strategy === 'UPGRADE_FIRST' ? 'Upgrade-first' : '3 packages + decline'}</span></td>
                  <td>{rule.isActive === false ? 'No' : 'Yes'}</td>
                  <td>
                    <button
                      type="button"
                      className="button-subtle"
                      onClick={() => setRuleDraft({
                        channel: rule.channel,
                        strategy: rule.strategy || 'PACKAGES_3',
                        isActive: rule.isActive !== false,
                        offerServiceIds: [...(rule.offerServiceIds || [])],
                        prepaidServiceIds: [...(rule.prepaidServiceIds || [])],
                      })}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
              {!rules.length ? (
                <tr><td colSpan={6} className="ui-muted">No rules yet — without a <code>*</code> rule (or packages below) the kiosk has nothing to offer and skips straight to payment.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {ruleDraft ? (
          <div className="glass card" style={{ marginTop: 10, padding: 14 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <label className="label" style={{ margin: 0 }}>Channel</label>
              <select
                value={CHANNEL_PRESETS.includes(ruleDraft.channel) ? ruleDraft.channel : 'CUSTOM'}
                onChange={(e) => setRuleDraft({ ...ruleDraft, channel: e.target.value === 'CUSTOM' ? '' : e.target.value })}
              >
                {CHANNEL_PRESETS.map((c) => <option key={c} value={c}>{c === '*' ? '* (default)' : c}</option>)}
                <option value="CUSTOM">Custom…</option>
              </select>
              {!CHANNEL_PRESETS.includes(ruleDraft.channel) ? (
                <input
                  placeholder="CHANNEL (normalized, e.g. FRANCHISE_TL)"
                  value={ruleDraft.channel}
                  onChange={(e) => setRuleDraft({ ...ruleDraft, channel: e.target.value.toUpperCase() })}
                  style={{ width: 220 }}
                />
              ) : null}
              <label className="label" style={{ margin: 0 }}>Strategy</label>
              <select value={ruleDraft.strategy} onChange={(e) => setRuleDraft({ ...ruleDraft, strategy: e.target.value })}>
                {STRATEGIES.map((s) => <option key={s} value={s}>{s === 'UPGRADE_FIRST' ? 'Upgrade-first' : '3 packages + decline'}</option>)}
              </select>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={ruleDraft.isActive !== false}
                  onChange={(e) => setRuleDraft({ ...ruleDraft, isActive: e.target.checked })}
                />
                Active
              </label>
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="label">Offer (in order)</div>
              <ServicePicker
                selected={ruleDraft.offerServiceIds}
                disabledIds={ruleDraft.prepaidServiceIds}
                onToggle={(id) => setRuleDraft({ ...ruleDraft, offerServiceIds: toggleId(ruleDraft.offerServiceIds, id) })}
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="label">Prepaid by broker — never offer</div>
              <ServicePicker
                selected={ruleDraft.prepaidServiceIds}
                disabledIds={ruleDraft.offerServiceIds}
                onToggle={(id) => setRuleDraft({ ...ruleDraft, prepaidServiceIds: toggleId(ruleDraft.prepaidServiceIds, id) })}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button type="button" disabled={busy} onClick={saveRule}>Save rule</button>
              <button type="button" className="button-subtle" onClick={() => setRuleDraft(null)}>Cancel</button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="glass card section-card">
        <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
          <div className="stack" style={{ gap: 4 }}>
            <h3 style={{ margin: 0 }}>Packages (Basic / Recommended / Premium)</h3>
            <div className="ui-muted">
              The 3-card grid on the kiosk&apos;s “Protection &amp; extras” screen. Each package is a bundle of catalog
              services; the kiosk always shows an honest “Continue with Basic — no extras” decline in addition to these.
              Services a channel rule marks as prepaid are automatically dropped from packages for that booking.
            </div>
          </div>
          <button type="button" disabled={busy} onClick={savePackages}>Save packages</button>
        </div>
        <div className="stack" style={{ marginTop: 10, gap: 12 }}>
          {PACKAGE_KEYS.map((key) => {
            const pkg = packages[key] || { enabled: false, name: key, serviceIds: [] };
            return (
              <div key={key} className="glass card" style={{ padding: 12 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 700, minWidth: 150 }}>
                    <input
                      type="checkbox"
                      checked={!!pkg.enabled}
                      onChange={(e) => setPackages({ ...packages, [key]: { ...pkg, enabled: e.target.checked } })}
                    />
                    {key}
                  </label>
                  <input
                    placeholder="Display name shown to the guest"
                    value={pkg.name}
                    onChange={(e) => setPackages({ ...packages, [key]: { ...pkg, name: e.target.value } })}
                    style={{ width: 260 }}
                  />
                  {pkg.enabled && !pkg.serviceIds.length ? (
                    <span className="ui-muted" style={{ fontSize: 12.5 }}>needs at least one service to save</span>
                  ) : null}
                </div>
                {pkg.enabled ? (
                  <ServicePicker
                    selected={pkg.serviceIds}
                    onToggle={(id) => setPackages({ ...packages, [key]: { ...pkg, serviceIds: toggleId(pkg.serviceIds, id) } })}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section className="glass card section-card">
        <h3 style={{ margin: 0 }}>Key handoff</h3>
        <p className="ui-muted" style={{ marginTop: 6 }}>
          The per-location key-handoff config (staff vs. lockbox note on the kiosk&apos;s DONE screen) lives on the
          {' '}<a href="/kiosks">Kiosks</a> page, next to the devices it applies to.
        </p>
      </section>
    </div>
  );
}
