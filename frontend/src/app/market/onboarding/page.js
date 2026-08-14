/**
 * Market Intelligence onboarding wizard (beta.135).
 *
 * 4 steps: airports → discovery → SIPP↔VehicleType mapping → guardrails.
 * Orchestrates /api/market-onboarding/*. Everything it creates is additive and
 * SUGGEST-mode — no price is auto-applied. See market-onboarding.service.js.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';

const SIPP_LABELS = {
  ECAR: 'Economy', CCAR: 'Compact', ICAR: 'Mid-size', SCAR: 'Standard',
  FCAR: 'Fullsize', PCAR: 'Premium', LCAR: 'Luxury', CFAR: 'Compact SUV',
  IFAR: 'Mid-size SUV', SFAR: 'Standard SUV', FFAR: 'Fullsize SUV',
  PFAR: 'Premium SUV', LFAR: 'Luxury SUV', RFAR: 'Recreational',
  XFAR: 'Open-Air All-Terrain', FJAR: 'SUV (FJAR)', FVAR: 'Passenger Van',
  MVAR: 'Minivan', SPAR: 'Special', STAR: 'Sports/Convertible', PUAR: 'Pickup'
};

export default function MarketOnboardingPage() {
  return <AuthGate>{({ token, me, logout }) => <Wizard token={token} me={me} logout={logout} />}</AuthGate>;
}

function Wizard({ token, me, logout }) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Step 1
  const [airportInput, setAirportInput] = useState('');
  const [airports, setAirports] = useState([]);

  // Step 2
  const [discovery, setDiscovery] = useState(null);
  const [selectedSipps, setSelectedSipps] = useState([]); // codes

  // Step 3 — mapping: { [sipp]: { vehicleTypeId, seedDaily } }
  const [mapping, setMapping] = useState({});

  // Step 4 — guardrails
  const [guardrails, setGuardrails] = useState({ floorPct: 25, ceilingPct: 50, maxDeltaPct: 15, targetN: 2 });
  const [applyResult, setApplyResult] = useState(null);

  useEffect(() => {
    if (!token) return;
    api('/api/market-onboarding/state', { bypassCache: true }, token)
      .then((s) => {
        setState(s);
        if (Array.isArray(s?.airports) && s.airports.length) setAirports(s.airports);
      })
      .catch((e) => setErr(e?.message || 'Failed to load onboarding state'));
  }, [token]);

  const vehicleTypes = state?.vehicleTypes || [];
  const sippCatalog = state?.sippCatalog || discovery?.sippCatalog || [];

  const flash = (m) => { setMsg(m); setErr(''); };
  const fail = (e) => { setErr(typeof e === 'string' ? e : (e?.message || 'Something went wrong')); };

  const addAirport = () => {
    const code = String(airportInput || '').trim().toUpperCase();
    if (!code) return;
    if (!airports.includes(code)) setAirports([...airports, code]);
    setAirportInput('');
  };

  const createProfiles = async () => {
    if (!airports.length) return fail('Add at least one airport code.');
    setBusy(true); setErr('');
    try {
      const out = await api('/api/market-onboarding/airports', { method: 'POST', body: JSON.stringify({ airports }) }, token);
      flash(`Profiles ready: ${out.created.length} created, ${out.skipped.length} already existed.`);
      setStep(2);
      await runDiscovery();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const runDiscovery = async () => {
    setBusy(true); setErr('');
    try {
      const out = await api('/api/market-onboarding/discovery', { method: 'POST', body: JSON.stringify({ airports }) }, token);
      setDiscovery(out);
      // Pre-select discovered SIPPs + seed the mapping with suggested VT + median.
      const codes = (out.discovered || []).map((d) => d.sipp);
      setSelectedSipps(codes);
      const m = {};
      for (const d of out.discovered || []) {
        m[d.sipp] = { vehicleTypeId: d.suggestedVehicleTypeId || '', seedDaily: d.medianDaily || '' };
      }
      setMapping(m);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const toggleSipp = (code) => {
    setSelectedSipps((cur) => cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code]);
    setMapping((cur) => {
      if (cur[code]) return cur;
      const vt = vehicleTypes.find((v) => String(v.code).toUpperCase() === code);
      return { ...cur, [code]: { vehicleTypeId: vt?.id || '', seedDaily: '' } };
    });
  };

  const setMap = (sipp, field, value) => setMapping((cur) => ({ ...cur, [sipp]: { ...cur[sipp], [field]: value } }));

  const readyMappings = useMemo(() => selectedSipps
    .map((sipp) => ({ sipp, ...(mapping[sipp] || {}) }))
    .filter((m) => m.vehicleTypeId && Number(m.seedDaily) > 0), [selectedSipps, mapping]);

  const applyAll = async () => {
    if (!readyMappings.length) return fail('Map at least one SIPP to a vehicle type with a seed price > 0.');
    setBusy(true); setErr('');
    try {
      const out = await api('/api/market-onboarding/apply', {
        method: 'POST',
        body: JSON.stringify({
          mappings: readyMappings.map((m) => ({ sipp: m.sipp, vehicleTypeId: m.vehicleTypeId, seedDaily: Number(m.seedDaily) })),
          guardrails
        })
      }, token);
      setApplyResult(out);
      flash(`Applied ${out.applied} rule(s) in SUGGEST mode${out.failed ? `, ${out.failed} failed` : ''}.`);
      setStep(4);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const Stepper = () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
      {['Airports', 'Discovery', 'Mapping', 'Guardrails'].map((label, i) => {
        const n = i + 1;
        const active = step === n;
        const done = step > n;
        return (
          <div key={label} style={{
            padding: '6px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600,
            background: active ? '#6d28d9' : done ? '#ecfdf5' : '#f3f0ff',
            color: active ? '#fff' : done ? '#166534' : '#6f668f'
          }}>{done ? '✓ ' : `${n}. `}{label}</div>
        );
      })}
    </div>
  );

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="row-between" style={{ alignItems: 'start' }}>
          <div>
            <span className="eyebrow">Market Intelligence</span>
            <h2 className="page-title" style={{ marginTop: 6 }}>Onboarding wizard</h2>
            <p className="ui-muted">Stand up market-based pricing in four steps. Everything created here is in SUGGEST mode — nothing changes your live prices until you approve it in the Suggestions inbox.</p>
          </div>
          <button type="button" className="button-subtle" onClick={() => router.push('/settings')}>Back to Settings</button>
        </div>
      </section>

      {state && !state.marketIntelligenceEnabled && (
        <section className="glass card section-card" style={{ marginBottom: 16, borderLeft: '3px solid #f59e0b' }}>
          <strong>Market Intelligence is not enabled for this tenant.</strong>
          <div className="ui-muted">An admin must enable it in Settings → Access Control (module access) before the wizard can run.</div>
        </section>
      )}

      <section className="glass card-lg section-card">
        <Stepper />
        {msg ? <p className="label" style={{ color: '#166534' }}>{msg}</p> : null}
        {err ? <p className="error">{err}</p> : null}

        {step === 1 && (
          <div className="stack">
            <h3 style={{ margin: 0 }}>1. Airports</h3>
            <div className="ui-muted">Add the airport / location codes to track. We create the standard scrape profile set (1-14 daily, 15-28 weekly, 29-60 outlook) per airport. The scheduler scrapes them on its cadence.</div>
            {state?.locations?.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {state.locations.map((l) => (
                  <button key={l.code} type="button" className="button-subtle" onClick={() => { if (!airports.includes(l.code)) setAirports([...airports, l.code]); }}>
                    + {l.code} · {l.name}
                  </button>
                ))}
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input value={airportInput} onChange={(e) => setAirportInput(e.target.value)} placeholder="e.g. SJU" onKeyDown={(e) => { if (e.key === 'Enter') addAirport(); }} />
              <button type="button" onClick={addAirport}>Add</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {airports.map((a) => (
                <span key={a} style={{ padding: '4px 10px', borderRadius: 999, background: '#ede9fe', fontWeight: 600 }}>
                  {a} <button type="button" className="link" onClick={() => setAirports(airports.filter((x) => x !== a))} style={{ marginLeft: 6 }}>✕</button>
                </span>
              ))}
            </div>
            <div className="inline-actions" style={{ marginTop: 14 }}>
              <button type="button" onClick={createProfiles} disabled={busy || !airports.length}>{busy ? 'Working…' : 'Create profiles & continue'}</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="stack">
            <h3 style={{ margin: 0 }}>2. Discovery</h3>
            {discovery?.hasObservations ? (
              <>
                <div className="ui-muted">These SIPP classes already have market data for your airports. Tap to include/exclude. You&rsquo;ll map them next.</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  {discovery.discovered.map((d) => {
                    const sel = selectedSipps.includes(d.sipp);
                    return (
                      <button key={d.sipp} type="button" className={sel ? '' : 'button-subtle'} onClick={() => toggleSipp(d.sipp)}>
                        {sel ? '✓ ' : ''}{d.sipp} · {SIPP_LABELS[d.sipp] || d.sipp} — {d.observationCount} obs · median ${d.medianDaily}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <div className="ui-muted" style={{ borderLeft: '3px solid #f59e0b', paddingLeft: 10 }}>
                  No market observations yet — the scheduled scrape hasn&rsquo;t populated data for these airports. You can either come back after the next scheduled run, or pick the classes to set up now from the catalog below.
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  {sippCatalog.map((code) => {
                    const sel = selectedSipps.includes(code);
                    return (
                      <button key={code} type="button" className={sel ? '' : 'button-subtle'} onClick={() => toggleSipp(code)}>
                        {sel ? '✓ ' : ''}{code} · {SIPP_LABELS[code] || code}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <div className="inline-actions" style={{ marginTop: 14 }}>
              <button type="button" className="button-subtle" onClick={() => setStep(1)}>Back</button>
              <button type="button" className="button-subtle" onClick={runDiscovery} disabled={busy}>Re-check data</button>
              <button type="button" onClick={() => setStep(3)} disabled={!selectedSipps.length}>Continue ({selectedSipps.length})</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="stack">
            <h3 style={{ margin: 0 }}>3. Map SIPP → vehicle type</h3>
            <div className="ui-muted">Match each class to one of your vehicle types and set a seed daily price (we pre-fill the market median where we have it). This creates a Rate + RateItem + a SUGGEST pricing rule per class.</div>
            <table className="table" style={{ marginTop: 8 }}>
              <thead><tr><th>SIPP</th><th>Vehicle type</th><th>Seed daily ($)</th></tr></thead>
              <tbody>
                {selectedSipps.map((sipp) => (
                  <tr key={sipp}>
                    <td><strong>{sipp}</strong> · {SIPP_LABELS[sipp] || sipp}</td>
                    <td>
                      <select value={mapping[sipp]?.vehicleTypeId || ''} onChange={(e) => setMap(sipp, 'vehicleTypeId', e.target.value)}>
                        <option value="">— select —</option>
                        {vehicleTypes.map((v) => <option key={v.id} value={v.id}>{v.code} · {v.name}</option>)}
                      </select>
                    </td>
                    <td><input type="number" min="0" step="0.01" style={{ width: 100 }} value={mapping[sipp]?.seedDaily ?? ''} onChange={(e) => setMap(sipp, 'seedDaily', e.target.value)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!vehicleTypes.length ? <p className="error">No vehicle types found for this tenant — create them in Settings → Vehicle Types first.</p> : null}
            <div className="ui-muted">{readyMappings.length} of {selectedSipps.length} ready (need a vehicle type + seed price &gt; 0).</div>
            <div className="inline-actions" style={{ marginTop: 14 }}>
              <button type="button" className="button-subtle" onClick={() => setStep(2)}>Back</button>
              <button type="button" onClick={() => setStep(4)} disabled={!readyMappings.length}>Continue</button>
            </div>
          </div>
        )}

        {step === 4 && !applyResult && (
          <div className="stack">
            <h3 style={{ margin: 0 }}>4. Guardrails</h3>
            <div className="ui-muted">Safety limits applied to every rule. Floor/ceiling are computed from each seed price; max change caps how far an AUTO rule could move in one cycle (rules start in SUGGEST, so nothing auto-applies yet).</div>
            <div className="app-card-grid compact" style={{ marginTop: 8 }}>
              <div className="stack" style={{ gap: 4 }}><label className="label">Floor (% below seed)</label><input type="number" min="0" max="90" value={guardrails.floorPct} onChange={(e) => setGuardrails({ ...guardrails, floorPct: Number(e.target.value) })} /></div>
              <div className="stack" style={{ gap: 4 }}><label className="label">Ceiling (% above seed)</label><input type="number" min="0" max="300" value={guardrails.ceilingPct} onChange={(e) => setGuardrails({ ...guardrails, ceilingPct: Number(e.target.value) })} /></div>
              <div className="stack" style={{ gap: 4 }}><label className="label">Max change %/cycle</label><input type="number" min="0" max="100" value={guardrails.maxDeltaPct} onChange={(e) => setGuardrails({ ...guardrails, maxDeltaPct: Number(e.target.value) })} /></div>
              <div className="stack" style={{ gap: 4 }}><label className="label">Target (Nth cheapest)</label><input type="number" min="1" max="10" value={guardrails.targetN} onChange={(e) => setGuardrails({ ...guardrails, targetN: Number(e.target.value) })} /></div>
            </div>
            <div className="inline-actions" style={{ marginTop: 14 }}>
              <button type="button" className="button-subtle" onClick={() => setStep(3)}>Back</button>
              <button type="button" onClick={applyAll} disabled={busy}>{busy ? 'Applying…' : `Create ${readyMappings.length} rule(s) (SUGGEST)`}</button>
            </div>
          </div>
        )}

        {step === 4 && applyResult && (
          <div className="stack">
            <h3 style={{ margin: 0 }}>Done 🎉</h3>
            <div className="ui-muted">Created {applyResult.applied} pricing rule(s) in SUGGEST mode. The engine will produce suggestions after the next scheduled scrape — review and approve them in the Suggestions inbox.</div>
            <table className="table" style={{ marginTop: 8 }}>
              <thead><tr><th>SIPP</th><th>Result</th><th>Floor</th><th>Ceiling</th></tr></thead>
              <tbody>
                {applyResult.results.map((r) => (
                  <tr key={r.sipp}>
                    <td><strong>{r.sipp}</strong></td>
                    <td style={{ color: r.ok ? '#166534' : '#b91c1c' }}>{r.ok ? `✓ ${r.rateCode}` : `✕ ${r.error}`}</td>
                    <td>{r.ok ? `$${r.floorPrice}` : '—'}</td>
                    <td>{r.ok ? `$${r.ceilingPrice}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="inline-actions" style={{ marginTop: 14 }}>
              <button type="button" onClick={() => router.push('/suggestions')}>Go to Suggestions inbox</button>
              <button type="button" className="button-subtle" onClick={() => router.push('/settings')}>Back to Settings</button>
            </div>
          </div>
        )}
      </section>
    </AppShell>
  );
}
