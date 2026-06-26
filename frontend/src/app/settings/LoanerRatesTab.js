'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/client';

/**
 * LoanerRatesTab — per-class loaner daily-rate book (2026-06-25). Reads/writes the loaner-tagged
 * Rate via /api/settings/loaner-rates. A class with no rate set is "unset" = covered ($0). These
 * rates are isolated from rental quoting (Rate.purpose = LOANER). Mirrors the FeeRatesTab pattern.
 * Plan: doc/loaner-selfservice-class-upgrade-plan-2026-06-25.md.
 */
export function LoanerRatesTab({ token, tenantName, scopedSettingsPath, onPageMsg }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const out = await api(scopedSettingsPath('/api/settings/loaner-rates'), { bypassCache: true }, token);
      setRows(Array.isArray(out?.rates) ? out.rates : []);
    } catch (e) {
      onPageMsg?.(`Failed to load loaner rates: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [scopedSettingsPath]);

  const setRate = (vehicleTypeId, value) => {
    setRows((prev) => prev.map((r) => (r.vehicleTypeId === vehicleTypeId ? { ...r, dailyRate: value } : r)));
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = rows.map((r) => ({
        vehicleTypeId: r.vehicleTypeId,
        dailyRate: r.dailyRate === '' || r.dailyRate === null || r.dailyRate === undefined ? 0 : Number(r.dailyRate),
      }));
      const out = await api(scopedSettingsPath('/api/settings/loaner-rates'), { method: 'PUT', body: { rates: payload } }, token);
      setRows(Array.isArray(out?.rates) ? out.rates : rows);
      onPageMsg?.('Loaner rates saved.');
    } catch (e) {
      onPageMsg?.(`Failed to save loaner rates: ${e.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="row-between">
        <h2>Loaner Program Rates</h2>
        <button onClick={save} disabled={saving || loading}>{saving ? 'Saving…' : 'Save Rates'}</button>
      </div>
      <p style={{ color: '#666', maxWidth: 640 }}>
        Per-class <strong>daily loaner rate</strong> for {tenantName}. The customer is entitled to their
        service vehicle&apos;s class for free; choosing a higher class on the website bills the difference
        (this rate minus the entitled class&apos;s rate). A blank rate = covered ($0). These rates are
        separate from rental rates and never affect rental quotes.
      </p>
      {loading ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>No vehicle classes found for this tenant. Add vehicle types first.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Class</th><th>Code</th><th>Loaner daily rate ($)</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.vehicleTypeId}>
                <td>{r.name}</td>
                <td>{r.code}</td>
                <td>
                  <input
                    type="number" min="0" step="0.01"
                    value={r.dailyRate ?? ''}
                    placeholder="0.00 (covered)"
                    onChange={(e) => setRate(r.vehicleTypeId, e.target.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
