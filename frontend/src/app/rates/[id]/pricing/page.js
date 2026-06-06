/**
 * Rate Pricing Intelligence panel (V1, sibling route — task #61).
 *
 * /rates/[id]/pricing
 *
 * Renders the rule builder + live preview for a single Rate. This is a
 * standalone route (not embedded inside the existing rate-edit page yet) so
 * we can ship and iterate independently. Eventually the same Inner component
 * should be slotted into the Rate edit tab — see task #61 next iteration.
 *
 * Backend endpoints used:
 *   GET    /api/pricing-rules/by-rate/:rateId        (load existing rule; 404 = none)
 *   POST   /api/pricing-rules                        (upsert by rateId)
 *   PATCH  /api/pricing-rules/:id                    (edit existing — used here only if we have rule.id)
 *   DELETE /api/pricing-rules/:id                    (remove rule)
 *   GET    /api/rates                                (list; we find this rate client-side because the
 *                                                     backend currently has no GET-by-id route)
 *   GET    /api/market/summary?airport=:code         (live market position + topVendors for the preview)
 *
 * Mockup: doc/mockups/mockup-rate-pricing-panel.html
 *
 * Preview logic deliberately replicates what the backend engine does so the
 * "what would happen right now" card stays accurate without a server round
 * trip. The preview endpoint itself still returns 501 — see the route file
 * comment on /api/pricing-rules/:id/preview. Frontend-only math is fine for
 * V1 because the values shown are only used for human confirmation; the real
 * write happens server-side from the nightly engine using the saved rule.
 *
 * Auth: AuthGate + AppShell. Backend enforces ADMIN|OPS + module=settings.
 *
 * V1 deviations from spec:
 *   - The market position card's "↑ N positions in 14d" sub-text is omitted;
 *     summary endpoint doesn't yet carry rank trail, and faking it would be
 *     misleading. The other three cells (your price, median, 2nd cheapest)
 *     are real.
 *   - Padding default is -2 (undercut by 2 %) to match the mockup.
 *   - We respect ?chase=VENDOR_NAME query param to preselect CHASE_VENDOR
 *     mode and the vendor combobox value, which is how the SIPP detail
 *     leaderboard's "Chase →" link feeds into us.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';

const STRATEGY_OPTIONS = [
  { value: 'NTH_CHEAPEST', label: 'Be the Nth cheapest on Expedia' },
  { value: 'CHASE_VENDOR', label: 'Chase a specific competitor' },
  { value: 'MANUAL', label: 'Manual (just observe, no changes)' },
];

const SIPP_LABELS = {
  ECAR: 'Economy',
  CCAR: 'Compact',
  ICAR: 'Mid-size',
  SCAR: 'Standard',
  FCAR: 'Fullsize',
  CFAR: 'Compact SUV',
  IFAR: 'Mid-size SUV',
  SFAR: 'Standard SUV',
  FFAR: 'Full-size SUV',
};

function fmtMoney(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `$${Number(value).toFixed(2)}`;
}

function clamp(n, floor, ceiling) {
  let out = Number(n);
  if (Number.isFinite(floor) && out < floor) out = floor;
  if (Number.isFinite(ceiling) && out > ceiling) out = ceiling;
  return out;
}

function nthCheapestTarget(topVendors, targetN, paddingPct) {
  if (!Array.isArray(topVendors) || topVendors.length === 0) return null;
  const n = Math.max(1, Number(targetN) || 1);
  const target = topVendors[n - 1] || topVendors[topVendors.length - 1];
  if (!target || !Number.isFinite(Number(target.price))) return null;
  const padded = Number(target.price) * (1 + Number(paddingPct || 0) / 100);
  return { rawTarget: Number(target.price), padded, vendor: target.vendor };
}

function chaseVendorTarget(topVendors, vendorName, paddingPct) {
  if (!Array.isArray(topVendors) || !vendorName) return null;
  const needle = String(vendorName).trim().toLowerCase();
  const match = topVendors.find((v) =>
    String(v.vendor || '').trim().toLowerCase().includes(needle)
  );
  if (!match || !Number.isFinite(Number(match.price))) return null;
  const padded = Number(match.price) * (1 + Number(paddingPct || 0) / 100);
  return { rawTarget: Number(match.price), padded, vendor: match.vendor };
}

const EMPTY_FORM = {
  id: null,
  mode: 'AUTO',
  strategy: 'NTH_CHEAPEST',
  targetN: 2,
  targetVendor: '',
  paddingPct: -2,
  floorPrice: null,
  ceilingPrice: null,
  autoMaxDeltaPct: 15,
  active: true,
};

export default function RatePricingPage() {
  return (
    <AuthGate>
      {({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}
    </AuthGate>
  );
}

function Inner({ token, me, logout }) {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const rateId = String(params?.id || '');
  const chaseParam = searchParams?.get('chase') || '';

  const [rate, setRate] = useState(null);
  const [summary, setSummary] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  // Initial load: rate, then rule (404 = blank), then market summary scoped
  // to the rate's airport.
  useEffect(() => {
    if (!token || !rateId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        // Step 1: find the rate. No GET-by-id endpoint yet — list returns all
        // tenant rates including location, and the list is small (< few hundred).
        const allRates = await api('/api/rates', { bypassCache: true }, token);
        const found = Array.isArray(allRates) ? allRates.find((r) => r.id === rateId) : null;
        if (!found) {
          if (!cancelled) setError('Rate not found in your tenant');
          if (!cancelled) setLoading(false);
          return;
        }
        if (cancelled) return;
        setRate(found);

        // Step 2: market summary for the rate's location code (drives both
        // "current market position" stat cells and the topVendors combobox
        // used by CHASE_VENDOR).
        const airport = found?.location?.code || '';
        let summaryData = null;
        if (airport) {
          try {
            summaryData = await api(
              `/api/market/summary?airport=${encodeURIComponent(airport)}`,
              { bypassCache: true },
              token
            );
          } catch (e) {
            // Non-fatal — preview just won't have market data.
            // eslint-disable-next-line no-console
            console.warn('market/summary failed', e?.message);
          }
        }
        if (cancelled) return;
        setSummary(summaryData);

        // Step 3: existing rule. 404 → start from EMPTY_FORM.
        let initialForm = { ...EMPTY_FORM };
        try {
          const rule = await api(`/api/pricing-rules/by-rate/${encodeURIComponent(rateId)}`, { bypassCache: true }, token);
          if (rule && rule.id) {
            initialForm = {
              id: rule.id,
              mode: rule.mode || 'SUGGEST',
              strategy: rule.strategy || 'NTH_CHEAPEST',
              targetN: rule.targetN ?? 2,
              targetVendor: rule.targetVendor || '',
              paddingPct: rule.paddingPct ?? 0,
              floorPrice: rule.floorPrice ?? null,
              ceilingPrice: rule.ceilingPrice ?? null,
              autoMaxDeltaPct: rule.autoMaxDeltaPct ?? 15,
              active: rule.active ?? true,
            };
          }
        } catch (e) {
          // 404 is expected when no rule exists. Anything else: surface it.
          if (e?.status && e.status !== 404) {
            // eslint-disable-next-line no-console
            console.warn('pricing-rules/by-rate failed', e?.message);
          }
        }

        // Apply ?chase=VENDOR override if present and we don't already have a rule.
        if (chaseParam && !initialForm.id) {
          initialForm = {
            ...initialForm,
            strategy: 'CHASE_VENDOR',
            targetVendor: chaseParam,
          };
        }
        if (cancelled) return;
        setForm(initialForm);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load pricing panel');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, rateId, chaseParam]);

  // Derive the matching SIPP row out of the summary for this rate. Backend
  // attaches `yourRate.id` to the SIPP it considers ours; match on that.
  const sippRow = useMemo(() => {
    if (!summary?.sipps || !rate?.id) return null;
    return summary.sipps.find((s) => s?.yourRate?.id === rate.id) || null;
  }, [summary, rate]);

  // Compute live preview from current form state + the topVendors of our SIPP.
  const preview = useMemo(() => {
    if (!rate) return null;
    const currentPrice = Number(rate?.daily ?? 0);
    const topVendors = Array.isArray(sippRow?.topVendors) ? sippRow.topVendors : [];
    const floor = Number.isFinite(Number(form.floorPrice)) ? Number(form.floorPrice) : null;
    const ceiling = Number.isFinite(Number(form.ceilingPrice)) ? Number(form.ceilingPrice) : null;

    if (form.strategy === 'MANUAL') {
      return {
        kind: 'manual',
        currentPrice,
        suggestedPrice: currentPrice,
        deltaPct: 0,
        reason: 'Manual mode — Cowork will observe market data but never propose a price change for this rate.',
        guardrailHit: null,
        autoEligible: false,
      };
    }

    let target = null;
    if (form.strategy === 'NTH_CHEAPEST') {
      target = nthCheapestTarget(topVendors, form.targetN, form.paddingPct);
    } else if (form.strategy === 'CHASE_VENDOR') {
      target = chaseVendorTarget(topVendors, form.targetVendor, form.paddingPct);
    }

    if (!target) {
      return {
        kind: 'no-data',
        currentPrice,
        suggestedPrice: null,
        deltaPct: null,
        reason: form.strategy === 'CHASE_VENDOR' && form.targetVendor
          ? `No live observation for vendor "${form.targetVendor}" yet — preview will populate after tonight's scrape.`
          : 'Not enough vendor observations yet for this SIPP to compute a target.',
        guardrailHit: null,
        autoEligible: false,
      };
    }

    const raw = target.padded;
    const clamped = clamp(raw, floor ?? -Infinity, ceiling ?? Infinity);
    let guardrailHit = null;
    if (floor != null && raw < floor) guardrailHit = 'floor';
    else if (ceiling != null && raw > ceiling) guardrailHit = 'ceiling';

    const deltaAbs = clamped - currentPrice;
    const deltaPct = currentPrice > 0 ? (deltaAbs / currentPrice) * 100 : null;

    // Auto mode also requires |delta| <= autoMaxDeltaPct to actually write.
    const autoCap = Number.isFinite(Number(form.autoMaxDeltaPct)) ? Number(form.autoMaxDeltaPct) : null;
    const autoCapHit = form.mode === 'AUTO' && autoCap != null && deltaPct != null && Math.abs(deltaPct) > autoCap;
    const autoEligible = form.mode === 'AUTO' && !autoCapHit;

    let reason = '';
    if (form.strategy === 'NTH_CHEAPEST') {
      const n = Number(form.targetN) || 1;
      reason = `#${n} cheapest right now is ${target.vendor || 'unknown'} @ ${fmtMoney(target.rawTarget)}. Applying ${Number(form.paddingPct).toFixed(1)}% padding → ${fmtMoney(raw)}.`;
    } else {
      reason = `${target.vendor || form.targetVendor} is at ${fmtMoney(target.rawTarget)}. Applying ${Number(form.paddingPct).toFixed(1)}% padding → ${fmtMoney(raw)}.`;
    }
    if (guardrailHit === 'floor') reason += ` Clamped up to floor ${fmtMoney(floor)}.`;
    if (guardrailHit === 'ceiling') reason += ` Clamped down to ceiling ${fmtMoney(ceiling)}.`;
    if (autoCapHit) reason += ` Delta exceeds your ${autoCap}% auto-cap so it would fall through to suggest mode.`;
    else if (form.mode === 'AUTO') reason += ' Would write to your rate automatically after tonight\'s scrape.';
    else reason += ' Suggest mode — change will appear in your suggestions inbox for approval.';

    return {
      kind: 'ok',
      currentPrice,
      suggestedPrice: clamped,
      rawTarget: target.rawTarget,
      paddedTarget: raw,
      vendor: target.vendor,
      deltaAbs,
      deltaPct,
      reason,
      guardrailHit,
      autoEligible,
      autoCapHit,
    };
  }, [rate, sippRow, form]);

  function update(patch) {
    setForm((f) => ({ ...f, ...patch }));
  }

  async function handleSave() {
    if (!rate) return;
    setSaving(true);
    setMsg('');
    setError('');
    try {
      const body = {
        rateId: rate.id,
        mode: form.mode,
        strategy: form.strategy,
        targetN: form.strategy === 'NTH_CHEAPEST' ? Number(form.targetN) || 1 : null,
        targetVendor: form.strategy === 'CHASE_VENDOR' ? (form.targetVendor || null) : null,
        paddingPct: Number(form.paddingPct) || 0,
        floorPrice: form.floorPrice == null || form.floorPrice === '' ? null : Number(form.floorPrice),
        ceilingPrice: form.ceilingPrice == null || form.ceilingPrice === '' ? null : Number(form.ceilingPrice),
        autoMaxDeltaPct: form.mode === 'AUTO' && form.autoMaxDeltaPct !== null && form.autoMaxDeltaPct !== ''
          ? Number(form.autoMaxDeltaPct)
          : null,
        active: !!form.active,
      };
      const saved = await api('/api/pricing-rules', {
        method: 'POST',
        body: JSON.stringify(body),
      }, token);
      setForm((f) => ({ ...f, id: saved?.id ?? f.id }));
      setMsg('Pricing rule saved.');
    } catch (e) {
      setError(`Save failed: ${e?.message || 'unknown error'}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!form.id) return;
    if (typeof window !== 'undefined' && !window.confirm('Delete this pricing rule? The rate will no longer auto-react to market movements.')) return;
    setDeleting(true);
    setError('');
    setMsg('');
    try {
      await api(`/api/pricing-rules/${encodeURIComponent(form.id)}`, { method: 'DELETE' }, token);
      setForm({ ...EMPTY_FORM });
      setMsg('Pricing rule deleted.');
    } catch (e) {
      setError(`Delete failed: ${e?.message || 'unknown error'}`);
    } finally {
      setDeleting(false);
    }
  }

  function handleCancel() {
    router.back();
  }

  const rateLabel = rate?.name || rate?.rateCode || rateId;
  const locationCode = rate?.location?.code || '—';
  const dailyPrice = rate?.daily != null ? Number(rate.daily) : null;
  const sippCode = sippRow?.sipp;
  const sippLabel = sippCode ? (SIPP_LABELS[sippCode] || `Class ${sippCode}`) : null;

  return (
    <AppShell me={me} logout={logout}>
      <DarkPanel>
        <Breadcrumbs
          rateCode={rate?.rateCode}
          locationCode={locationCode}
          onBackToRates={() => router.push('/settings')}
        />

        <Header
          rateLabel={rateLabel}
          locationCode={locationCode}
          sippLabel={sippLabel}
          dailyPrice={dailyPrice}
        />

        {error && (
          <div role="alert" style={alertErrorStyle}>{error}</div>
        )}
        {msg && (
          <div role="status" style={alertOkStyle}>
            {msg}
            <button onClick={() => setMsg('')} style={alertDismissStyle} aria-label="Dismiss">×</button>
          </div>
        )}

        {loading && !rate ? (
          <PanelSkeleton />
        ) : (
          <>
            <MarketPositionCard
              sippRow={sippRow}
              rate={rate}
              summary={summary}
            />

            <RuleBuilder
              form={form}
              update={update}
              topVendors={sippRow?.topVendors || []}
            />

            <PreviewCard
              preview={preview}
              hasRule={!!form.id}
              saving={saving}
              deleting={deleting}
              onDelete={handleDelete}
              onCancel={handleCancel}
              onSave={handleSave}
            />
          </>
        )}
      </DarkPanel>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Header + breadcrumbs
// ---------------------------------------------------------------------------

function Breadcrumbs({ rateCode, locationCode, onBackToRates }) {
  return (
    <div style={{ fontSize: 13, color: '#6e7587', marginBottom: 14 }}>
      <a
        href="/settings"
        onClick={(e) => { e.preventDefault(); onBackToRates(); }}
        style={{ color: '#3b82f6', textDecoration: 'none', cursor: 'pointer' }}
      >Rates</a>
      {' / '}
      <span style={{ color: '#c8cfe0' }}>{rateCode || '—'} ({locationCode})</span>
      {' / '}
      <strong style={{ color: '#e7ebf2' }}>Pricing Intelligence</strong>
    </div>
  );
}

function Header({ rateLabel, locationCode, sippLabel, dailyPrice }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: '-0.4px', color: '#e7ebf2' }}>
        {rateLabel}
      </h1>
      <div style={{ color: '#8a93a6', fontSize: 14, marginTop: 4 }}>
        {sippLabel ? `${sippLabel} · ` : ''}{locationCode} · Currently {fmtMoney(dailyPrice)}/day
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 1 — market position
// ---------------------------------------------------------------------------

function MarketPositionCard({ sippRow, rate, summary }) {
  const yourPrice = rate?.daily != null ? Number(rate.daily) : null;
  const yourRank = sippRow?.yourRank;
  const vendorCount = sippRow?.vendorCount || 0;
  const median = sippRow?.median != null ? Number(sippRow.median) : null;
  const topVendors = Array.isArray(sippRow?.topVendors) ? sippRow.topVendors : [];
  // 2nd cheapest = topVendors[1] (or fall back to last if there's only one).
  const secondCheapest = topVendors[1] || null;
  const updatedAt = summary?.updatedAt;
  const updatedLabel = updatedAt
    ? new Date(updatedAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
    : '—';

  let rankColor = '#fbbf24';
  if (yourRank == null) rankColor = '#6e7587';
  else if (yourRank === 1) rankColor = '#4ade80';
  else if (yourRank >= 5) rankColor = '#f87171';

  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>Current market position</span>
        <span style={liveBadgeStyle}>Live</span>
      </div>

      {!sippRow ? (
        <div style={{ color: '#8a93a6', fontSize: 13, padding: '8px 4px' }}>
          No market data tied to this rate yet. The pricing engine matches a Rate to a SIPP
          using the targetRate set on a MarketScrapeProfile — once that mapping is in place
          and the scraper has run, your rank + median will show here.
        </div>
      ) : (
        <>
          <div style={marketCardStyle}>
            <MarketCell
              label="Your rank"
              value={yourRank != null ? `#${yourRank} of ${vendorCount}` : '—'}
              valueColor={rankColor}
              sub={vendorCount ? `${vendorCount} vendors observed` : null}
            />
            <MarketCell
              label="Your price"
              value={fmtMoney(yourPrice)}
              valueColor="#fbbf24"
              sub={null}
            />
            <MarketCell
              label="Market median"
              value={fmtMoney(median)}
              sub={median != null && yourPrice != null
                ? (median - yourPrice >= 0
                  ? `+${fmtMoney(median - yourPrice)} above you`
                  : `${fmtMoney(median - yourPrice)} vs you`)
                : null}
            />
            <MarketCell
              label="2nd cheapest"
              value={secondCheapest ? fmtMoney(secondCheapest.price) : '—'}
              sub={secondCheapest
                ? `${secondCheapest.vendor || 'Unknown vendor'}${yourPrice != null ? ' — ' + (Number(secondCheapest.price) - yourPrice >= 0 ? '+' : '') + fmtMoney(Number(secondCheapest.price) - yourPrice) + ' above you' : ''}`
                : null}
            />
          </div>
          <div style={{ fontSize: 13, color: '#8a93a6' }}>
            Based on the most recent scrape — <strong style={{ color: '#c8cfe0' }}>{updatedLabel}</strong>
            {vendorCount ? ` · ${vendorCount} vendors observed` : ''}
          </div>
        </>
      )}
    </div>
  );
}

function MarketCell({ label, value, valueColor, sub }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#8a93a6', textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: valueColor || '#e7ebf2' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#8a93a6', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 2 — rule builder
// ---------------------------------------------------------------------------

function RuleBuilder({ form, update, topVendors }) {
  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>Pricing rule</span>
      </div>

      <div style={helpBoxStyle}>
        Pick a strategy and Cowork will compute a target price daily after the 04:00 ET scrape.
        Choose <strong>auto-apply</strong> to write the new price straight to your rate
        (within floor/ceiling) or <strong>suggest</strong> to review each change manually.
      </div>

      {/* Strategy */}
      <Row label="Strategy" hint="How to position vs competitors">
        <select
          value={form.strategy}
          onChange={(e) => update({ strategy: e.target.value })}
          style={inputStyle}
        >
          {STRATEGY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </Row>

      {/* Target N (NTH_CHEAPEST only) */}
      {form.strategy === 'NTH_CHEAPEST' && (
        <Row label="Target rank" hint="Where you want to land in the rankings">
          <select
            value={String(form.targetN)}
            onChange={(e) => update({ targetN: Number(e.target.value) })}
            style={inputStyle}
          >
            <option value="1">#1 — Cheapest</option>
            <option value="2">#2 — Second cheapest</option>
            <option value="3">#3 — Third cheapest</option>
            <option value="4">#4 — Fourth cheapest</option>
            <option value="5">#5 — Fifth cheapest</option>
          </select>
        </Row>
      )}

      {/* Vendor combobox (CHASE_VENDOR only) */}
      {form.strategy === 'CHASE_VENDOR' && (
        <Row label="Target vendor" hint="The competitor whose price you want to track">
          <input
            list="rfm-pricing-vendors"
            type="text"
            value={form.targetVendor || ''}
            onChange={(e) => update({ targetVendor: e.target.value })}
            placeholder="e.g. Sixt"
            style={inputStyle}
          />
          <datalist id="rfm-pricing-vendors">
            {topVendors.map((v) => (
              <option key={v.vendor} value={v.vendor || ''}>{`${v.vendor} — ${fmtMoney(v.price)}`}</option>
            ))}
          </datalist>
        </Row>
      )}

      {/* Padding (hidden for MANUAL) */}
      {form.strategy !== 'MANUAL' && (
        <Row label="Padding" hint="Offset vs target price (negative = undercut by N%)">
          <Pair>
            <input
              type="number"
              step="0.5"
              value={form.paddingPct ?? 0}
              onChange={(e) => update({ paddingPct: e.target.value === '' ? 0 : Number(e.target.value) })}
              style={{ ...inputStyle, maxWidth: 110 }}
            />
            <span style={{ color: '#8a93a6', fontSize: 13 }}>%</span>
          </Pair>
        </Row>
      )}

      {/* Mode toggle */}
      <Row label="Apply mode" hint="Auto = write directly. Suggest = queue for your approval.">
        <div style={toggleGroupStyle}>
          <ToggleOption
            active={form.mode === 'AUTO'}
            onClick={() => update({ mode: 'AUTO' })}
            label="⚡ Auto-apply"
          />
          <ToggleOption
            active={form.mode === 'SUGGEST'}
            onClick={() => update({ mode: 'SUGGEST' })}
            label="✋ Suggest only"
          />
        </div>
      </Row>

      {/* Auto cap (AUTO only) */}
      {form.mode === 'AUTO' && (
        <Row label="Auto-apply only if delta ≤" hint="Bigger jumps will fall through to suggest mode">
          <Pair>
            <input
              type="number"
              step="1"
              min={0}
              value={form.autoMaxDeltaPct ?? ''}
              onChange={(e) => update({ autoMaxDeltaPct: e.target.value === '' ? null : Number(e.target.value) })}
              style={{ ...inputStyle, maxWidth: 110 }}
            />
            <span style={{ color: '#8a93a6', fontSize: 13 }}>%</span>
          </Pair>
        </Row>
      )}

      {/* Floor */}
      <Row label="Floor (minimum)" hint="Never auto-set below this — protects your margin">
        <Pair>
          <span style={{ color: '#8a93a6', fontSize: 13 }}>$</span>
          <input
            type="number"
            step="1"
            min={0}
            value={form.floorPrice ?? ''}
            onChange={(e) => update({ floorPrice: e.target.value === '' ? null : Number(e.target.value) })}
            placeholder="e.g. 42"
            style={{ ...inputStyle, maxWidth: 110 }}
          />
          <span style={{ color: '#8a93a6', fontSize: 12 }}>/day</span>
        </Pair>
      </Row>

      {/* Ceiling */}
      <Row label="Ceiling (maximum)" hint="Never auto-set above this — protects bookings">
        <Pair>
          <span style={{ color: '#8a93a6', fontSize: 13 }}>$</span>
          <input
            type="number"
            step="1"
            min={0}
            value={form.ceilingPrice ?? ''}
            onChange={(e) => update({ ceilingPrice: e.target.value === '' ? null : Number(e.target.value) })}
            placeholder="e.g. 85"
            style={{ ...inputStyle, maxWidth: 110 }}
          />
          <span style={{ color: '#8a93a6', fontSize: 12 }}>/day</span>
        </Pair>
      </Row>

      {/* Active flag — not in mockup but the model has it; expose so a user can pause without deleting. */}
      <Row label="Rule active" hint="Pause the rule without deleting it">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#c8cfe0' }}>
          <input
            type="checkbox"
            checked={!!form.active}
            onChange={(e) => update({ active: e.target.checked })}
            style={{ accentColor: '#3b82f6' }}
          />
          Active
        </label>
      </Row>
    </div>
  );
}

function Row({ label, hint, children }) {
  return (
    <div style={rowStyle}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 13, color: '#e7ebf2' }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: '#8a93a6', marginTop: 3 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Pair({ children }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>{children}</div>
  );
}

function ToggleOption({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '9px 18px',
        fontSize: 13,
        cursor: 'pointer',
        border: 'none',
        background: active ? '#2563eb' : 'transparent',
        color: active ? '#fff' : '#c8cfe0',
      }}
    >{label}</button>
  );
}

// ---------------------------------------------------------------------------
// Section 3 — live preview + actions
// ---------------------------------------------------------------------------

function PreviewCard({ preview, hasRule, saving, deleting, onDelete, onCancel, onSave }) {
  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>
        <span>Live preview — what would happen right now</span>
      </div>

      <div style={previewBoxStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 22, fontWeight: 700, flexWrap: 'wrap' }}>
          <div>
            <div style={previewTinyLabelStyle}>Today</div>
            <div style={{ color: '#8a93a6', textDecoration: 'line-through', fontSize: 18, fontWeight: 500 }}>
              {fmtMoney(preview?.currentPrice)}
            </div>
          </div>
          <div style={{ color: previewArrowColor(preview), fontSize: 22 }}>→</div>
          <div>
            <div style={previewTinyLabelStyle}>Target</div>
            <div style={{ color: previewTargetColor(preview) }}>
              {preview?.suggestedPrice != null ? fmtMoney(preview.suggestedPrice) : '—'}
            </div>
            {preview?.deltaPct != null && (
              <div style={{ fontSize: 12, color: previewTargetColor(preview), marginTop: 3 }}>
                {(preview.deltaPct > 0 ? '+' : '') + preview.deltaPct.toFixed(1)}%
              </div>
            )}
          </div>
        </div>
        <div style={{ fontSize: 13, color: '#c8cfe0', lineHeight: 1.6 }}>
          {preview?.reason || 'Adjust the rule above to see a live preview.'}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
        {hasRule && (
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            style={btnDangerStyle}
          >{deleting ? 'Deleting…' : 'Delete rule'}</button>
        )}
        <button type="button" onClick={onCancel} style={btnSecondaryStyle}>Cancel</button>
        <button type="button" onClick={onSave} disabled={saving} style={btnPrimaryStyle}>
          {saving ? 'Saving…' : 'Save rule'}
        </button>
      </div>
    </div>
  );
}

function previewArrowColor(preview) {
  if (!preview) return '#8a93a6';
  if (preview.deltaPct == null) return '#8a93a6';
  if (preview.deltaPct < -0.05) return '#4ade80';
  if (preview.deltaPct > 0.05) return '#f87171';
  return '#8a93a6';
}

function previewTargetColor(preview) {
  if (!preview) return '#e7ebf2';
  if (preview.deltaPct == null) return '#e7ebf2';
  if (preview.deltaPct < -0.05) return '#4ade80';
  if (preview.deltaPct > 0.05) return '#f87171';
  return '#e7ebf2';
}

// ---------------------------------------------------------------------------
// Skeleton + Dark panel wrapper + shared styles
// ---------------------------------------------------------------------------

function PanelSkeleton() {
  const shimmer = {
    background: 'linear-gradient(90deg, #1b1f29 0%, #232838 50%, #1b1f29 100%)',
    backgroundSize: '200% 100%',
    borderRadius: 8,
    animation: 'rfm-pricing-shimmer 1.4s ease-in-out infinite',
  };
  return (
    <div aria-busy="true">
      <style>{'@keyframes rfm-pricing-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }'}</style>
      <div style={{ ...shimmer, height: 160, marginBottom: 18 }} />
      <div style={{ ...shimmer, height: 420, marginBottom: 18 }} />
      <div style={{ ...shimmer, height: 200 }} />
    </div>
  );
}

function DarkPanel({ children }) {
  return (
    <div style={{
      background: '#0f1115',
      color: '#e7ebf2',
      padding: 24,
      minHeight: 'calc(100vh - 120px)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{ maxWidth: 920, margin: '0 auto' }}>{children}</div>
    </div>
  );
}

const sectionStyle = {
  background: '#161922',
  border: '1px solid #232838',
  borderRadius: 14,
  padding: 22,
  marginBottom: 18,
};

const sectionTitleStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 16,
  fontWeight: 600,
  marginBottom: 16,
  color: '#e7ebf2',
};

const liveBadgeStyle = {
  background: 'rgba(34, 197, 94, 0.15)',
  color: '#4ade80',
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 4,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
};

const marketCardStyle = {
  background: 'linear-gradient(135deg, rgba(59,130,246,0.08), rgba(168,85,247,0.06))',
  border: '1px solid #2a3a5c',
  borderRadius: 10,
  padding: 18,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: 18,
  marginBottom: 18,
};

const helpBoxStyle = {
  background: '#1b1f29',
  borderLeft: '3px solid #3b82f6',
  padding: '10px 14px',
  borderRadius: 6,
  fontSize: 13,
  color: '#c8cfe0',
  marginBottom: 16,
  lineHeight: 1.5,
};

const rowStyle = {
  display: 'grid',
  gridTemplateColumns: '220px 1fr',
  gap: 16,
  alignItems: 'center',
  padding: '12px 0',
  borderBottom: '1px dashed #232838',
};

const inputStyle = {
  background: '#1b1f29',
  border: '1px solid #2a2f3d',
  color: '#e7ebf2',
  padding: '9px 12px',
  borderRadius: 8,
  fontSize: 14,
  width: '100%',
  maxWidth: 360,
};

const toggleGroupStyle = {
  display: 'inline-flex',
  background: '#1b1f29',
  border: '1px solid #2a2f3d',
  borderRadius: 8,
  overflow: 'hidden',
};

const previewBoxStyle = {
  background: 'linear-gradient(135deg, #1a2030 0%, #1a1d2b 100%)',
  border: '1px solid #2d3a52',
  borderRadius: 12,
  padding: 20,
  display: 'grid',
  gridTemplateColumns: '2fr 3fr',
  gap: 24,
  alignItems: 'center',
};

const previewTinyLabelStyle = {
  fontSize: 11,
  color: '#8a93a6',
  textTransform: 'uppercase',
  letterSpacing: 0.7,
};

const btnPrimaryStyle = {
  padding: '11px 22px',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  border: 0,
  background: '#2563eb',
  color: '#fff',
};

const btnSecondaryStyle = {
  padding: '11px 22px',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  background: '#1b1f29',
  color: '#c8cfe0',
  border: '1px solid #2a2f3d',
};

const btnDangerStyle = {
  padding: '11px 22px',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  background: 'transparent',
  color: '#f87171',
  border: '1px solid rgba(185, 28, 28, 0.25)',
};

const alertErrorStyle = {
  background: 'rgba(239,68,68,0.12)',
  border: '1px solid rgba(239,68,68,0.4)',
  color: '#fca5a5',
  padding: 12,
  borderRadius: 8,
  marginBottom: 16,
  fontSize: 13,
};

const alertOkStyle = {
  background: 'rgba(34,197,94,0.12)',
  border: '1px solid rgba(34,197,94,0.4)',
  color: '#bbf7d0',
  padding: 12,
  borderRadius: 8,
  marginBottom: 16,
  fontSize: 13,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const alertDismissStyle = {
  background: 'transparent',
  border: 'none',
  color: '#bbf7d0',
  cursor: 'pointer',
  fontSize: 18,
  lineHeight: 1,
  padding: 0,
};
