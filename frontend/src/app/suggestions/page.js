/**
 * Pricing Suggestions Inbox (V1, task #62).
 *
 * /suggestions
 *
 * Lists PricingSuggestion rows produced by the nightly pricing engine. The
 * user can Approve (writes to Rate.daily), Reject (with a reason), or Snooze
 * (visual-only placeholder for V1 — see snooze section below).
 *
 * Backend endpoints:
 *   GET  /api/pricing-suggestions?status=PENDING|APPLIED|AUTO_APPLIED|REJECTED|EXPIRED
 *   POST /api/pricing-suggestions/:id/apply
 *   POST /api/pricing-suggestions/:id/reject  { reason }
 *
 * The list endpoint already includes rule + rate (with location.code) so we
 * don't need extra round-trips for the card display.
 *
 * Mockup: doc/mockups/mockup-suggestions-inbox.html
 *
 * V1 deviations from spec:
 *   - Snooze 24h: backend has no snooze endpoint. We surface the button as a
 *     visual no-op with a TODO toast — calls neither apply nor reject. See
 *     project_pillar2_followups_shipped + task #62 for the eventual endpoint.
 *   - SIPP badge: PricingSuggestion doesn't carry a SIPP directly. We derive
 *     a "Rule: …" badge from rule.strategy/targetN/targetVendor instead, which
 *     matches the mockup pattern ("Rule: Chase Sixt − 5%").
 *   - Auto-applied "Undo →" link is rendered but currently navigates to the
 *     rate pricing panel (where the user can manually flip the price). No
 *     dedicated undo endpoint yet.
 *   - Reject reason prompt uses window.prompt — replace with a styled modal
 *     in a follow-up.
 *
 * Auth: AuthGate + AppShell. Backend enforces ADMIN|OPS + module=settings.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

const STATUS_FILTERS = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'AUTO_APPLIED', label: 'Auto-applied' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'EXPIRED', label: 'Expired' },
];

const COUNT_STATUSES = ['PENDING', 'AUTO_APPLIED', 'REJECTED', 'EXPIRED'];

const POLL_INTERVAL_MS = 60_000;

function fmtMoney(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `$${Number(value).toFixed(2)}`;
}

function fmtPct(pct) {
  if (pct == null || Number.isNaN(Number(pct))) return '0.0%';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${Number(pct).toFixed(1)}%`;
}

function fmtTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
}

function ruleBadgeLabel(rule) {
  if (!rule) return 'Rule';
  const strat = rule.strategy;
  if (strat === 'NTH_CHEAPEST') {
    const n = rule.targetN || 1;
    const ordinal = n === 1 ? '#1 cheapest' : `#${n} cheapest`;
    const pad = rule.targetN != null && rule._padding != null ? ` ${rule._padding}%` : '';
    return `Rule: Be ${ordinal}${pad}`;
  }
  if (strat === 'CHASE_VENDOR') {
    return `Rule: Chase ${rule.targetVendor || 'vendor'}`;
  }
  if (strat === 'MANUAL') return 'Rule: Manual (observe only)';
  return `Rule: ${strat || 'unknown'}`;
}

function expiresInLabel(expiresAt) {
  if (!expiresAt) return null;
  const target = new Date(expiresAt).getTime();
  if (Number.isNaN(target)) return null;
  const diffMs = target - Date.now();
  if (diffMs <= 0) return 'Expired';
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `Expires in ${hours}h ${minutes}m`;
  return `Expires in ${minutes}m`;
}

function buildReason(suggestion) {
  // Build a sentence that says: "<vendor> moved their <sipp> @ <airport> to
  // <market price>, vs your <current>. Applying <rule> → <suggested>. Delta is X%."
  const r = suggestion?.reason || {};
  const rate = suggestion?.rate;
  const rule = suggestion?.rule;
  const airport = rate?.location?.code || 'this market';
  const current = Number(suggestion?.currentPrice);
  const suggested = Number(suggestion?.suggestedPrice);
  const deltaPct = Number(suggestion?.deltaPct);

  const parts = [];
  if (rule?.strategy === 'CHASE_VENDOR') {
    const vendor = rule.targetVendor || r.targetVendor || 'Competitor';
    parts.push(`${vendor} moved at ${airport} to ${fmtMoney(r.marketMin)}, your current is ${fmtMoney(current)}.`);
  } else if (rule?.strategy === 'NTH_CHEAPEST') {
    const n = rule.targetN || r.targetN || 1;
    parts.push(`Market shifted at ${airport}. New #${n} cheapest is ${fmtMoney(r.marketMin)}; your current is ${fmtMoney(current)}.`);
  } else {
    parts.push(`Market shifted at ${airport}; engine recomputed your target.`);
  }
  parts.push(`Applying your rule → ${fmtMoney(suggested)}.`);
  if (Number.isFinite(deltaPct)) parts.push(`Delta is ${fmtPct(deltaPct)}.`);
  if (Array.isArray(r.guardrailsHit) && r.guardrailsHit.length) {
    parts.push(`Guardrail: ${r.guardrailsHit.join(', ')}.`);
  }
  return parts.join(' ');
}

export default function SuggestionsInboxPage() {
  return (
    <AuthGate>
      {({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}
    </AuthGate>
  );
}

function Inner({ token, me, logout }) {
  const router = useRouter();
  const [status, setStatus] = useState('PENDING');
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [lastRefreshAt, setLastRefreshAt] = useState(null);

  // Don't double-fire when polling overlaps a manual refresh.
  const inflightRef = useRef(false);

  const loadCurrent = useCallback(async () => {
    if (!token) return;
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const data = await api(
        `/api/pricing-suggestions?status=${encodeURIComponent(status)}`,
        { bypassCache: true },
        token
      );
      setItems(Array.isArray(data) ? data : []);
      setError('');
      setLastRefreshAt(new Date());
    } catch (e) {
      setError(e?.message || 'Failed to load suggestions');
    } finally {
      setLoading(false);
      inflightRef.current = false;
    }
  }, [token, status]);

  // Fetch counts for every status pill in parallel. Cheap because each is just
  // a single tenant-scoped findMany capped at 200. Refresh on poll cycles too.
  const loadCounts = useCallback(async () => {
    if (!token) return;
    const results = await Promise.all(
      COUNT_STATUSES.map((s) =>
        api(`/api/pricing-suggestions?status=${encodeURIComponent(s)}`, { bypassCache: true }, token)
          .then((arr) => [s, Array.isArray(arr) ? arr.length : 0])
          .catch(() => [s, 0])
      )
    );
    const next = {};
    for (const [s, n] of results) next[s] = n;
    setCounts(next);
  }, [token]);

  useEffect(() => {
    setLoading(true);
    setSelected(new Set());
    loadCurrent();
  }, [loadCurrent]);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  // Polling — refresh both the current list and the counts. 60s is a
  // reasonable compromise: the engine only runs nightly so quicker polling
  // adds API load without payoff.
  useEffect(() => {
    if (!token) return undefined;
    const id = setInterval(() => {
      loadCurrent();
      loadCounts();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [token, loadCurrent, loadCounts]);

  function toggleSelected(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((i) => i.id)));
    }
  }

  async function approve(id) {
    try {
      await api(`/api/pricing-suggestions/${encodeURIComponent(id)}/apply`, { method: 'POST' }, token);
      setItems((arr) => arr.filter((i) => i.id !== id));
      setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
      setToast('Suggestion approved & applied.');
      loadCounts();
    } catch (e) {
      setError(`Approve failed: ${e?.message || 'unknown'}`);
    }
  }

  async function reject(id) {
    let reason = '';
    if (typeof window !== 'undefined') {
      // V1 — replace with a styled modal later (TODO).
      reason = window.prompt('Reject reason (optional)?', '') || '';
    }
    try {
      await api(`/api/pricing-suggestions/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }, token);
      setItems((arr) => arr.filter((i) => i.id !== id));
      setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
      setToast('Suggestion rejected.');
      loadCounts();
    } catch (e) {
      setError(`Reject failed: ${e?.message || 'unknown'}`);
    }
  }

  async function approveSelected() {
    if (!selected.size) return;
    const ids = Array.from(selected);
    // Sequential to keep ordering predictable + avoid hammering Prisma's
    // transaction pool when the inbox is large. The action is rare so the
    // latency hit is fine.
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await api(`/api/pricing-suggestions/${encodeURIComponent(id)}/apply`, { method: 'POST' }, token);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setSelected(new Set());
    setToast(`Approved ${ok} suggestion${ok === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}.`);
    await loadCurrent();
    await loadCounts();
  }

  function snoozePlaceholder() {
    // TODO: wire to a real /:id/snooze endpoint once it ships.
    setToast('Snooze is coming soon — for V1, suggestions auto-expire on the date the engine set.');
  }

  function goToRatePricing(rateId) {
    if (!rateId) return;
    router.push(`/rates/${encodeURIComponent(rateId)}/pricing`);
  }

  const total = useMemo(() => Object.values(counts).reduce((acc, n) => acc + Number(n || 0), 0), [counts]);

  return (
    <AppShell me={me} logout={logout}>
      <DarkPanel>
        <Header lastRefreshAt={lastRefreshAt} onRefresh={() => { loadCurrent(); loadCounts(); }} />

        <FilterBar
          current={status}
          counts={counts}
          total={total}
          onChange={(next) => {
            setStatus(next);
            setSelected(new Set());
          }}
        />

        {error && <div role="alert" style={alertErrorStyle}>{error}</div>}
        {toast && (
          <div role="status" style={alertOkStyle}>
            {toast}
            <button onClick={() => setToast('')} style={alertDismissStyle} aria-label="Dismiss">×</button>
          </div>
        )}

        {status === 'PENDING' && items.length > 0 && (
          <BulkActions
            allSelected={selected.size === items.length && items.length > 0}
            selectedCount={selected.size}
            onSelectAll={selectAll}
            onApproveSelected={approveSelected}
            onSnooze={snoozePlaceholder}
          />
        )}

        {loading ? (
          <SkeletonList />
        ) : items.length === 0 ? (
          <EmptyState status={status} onGoDashboard={() => router.push('/market')} />
        ) : (
          items.map((s) => (
            status === 'AUTO_APPLIED'
              ? <AutoAppliedRow key={s.id} suggestion={s} onUndo={() => goToRatePricing(s?.rate?.id)} />
              : <SuggestionCard
                  key={s.id}
                  suggestion={s}
                  isPending={status === 'PENDING'}
                  selected={selected.has(s.id)}
                  onToggle={() => toggleSelected(s.id)}
                  onApprove={() => approve(s.id)}
                  onReject={() => reject(s.id)}
                  onSnooze={snoozePlaceholder}
                />
          ))
        )}
      </DarkPanel>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Header / filter pills / bulk actions
// ---------------------------------------------------------------------------

function Header({ lastRefreshAt, onRefresh }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, gap: 12, flexWrap: 'wrap' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: '-0.4px', color: '#e7ebf2' }}>
          Pricing Suggestions
        </h1>
        <div style={{ color: '#8a93a6', fontSize: 14, marginTop: 4 }}>
          Review and approve rate changes computed from last night's market scrape
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#8a93a6' }}>
          Last refresh: <strong style={{ color: '#c8cfe0' }}>{fmtTimestamp(lastRefreshAt)}</strong>
        </span>
        <button
          type="button"
          onClick={onRefresh}
          style={refreshBtnStyle}
        >Refresh</button>
      </div>
    </div>
  );
}

function FilterBar({ current, counts, total, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap', alignItems: 'center' }}>
      {STATUS_FILTERS.map((f) => {
        const active = current === f.key;
        const n = counts[f.key];
        return (
          <button
            key={f.key}
            type="button"
            onClick={() => onChange(f.key)}
            style={active ? pillActiveStyle : pillStyle}
          >
            {f.label}
            <span style={active ? countActiveStyle : countStyle}>
              {Number.isFinite(n) ? n : '…'}
            </span>
          </button>
        );
      })}
      <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6e7587' }}>
        {Number.isFinite(total) ? `${total} total in all queues` : ''}
      </span>
    </div>
  );
}

function BulkActions({ allSelected, selectedCount, onSelectAll, onApproveSelected, onSnooze }) {
  return (
    <div style={{
      background: '#161922',
      border: '1px solid #232838',
      borderRadius: 8,
      padding: '10px 14px',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      marginBottom: 12,
      fontSize: 13,
      color: '#c8cfe0',
      flexWrap: 'wrap',
    }}>
      <input
        type="checkbox"
        checked={allSelected}
        onChange={onSelectAll}
        style={{ accentColor: '#3b82f6' }}
        aria-label="Select all pending"
      />
      <span>
        {selectedCount > 0 ? `${selectedCount} selected` : 'Select all pending'}
      </span>
      <button
        type="button"
        onClick={onApproveSelected}
        disabled={selectedCount === 0}
        style={{ ...bulkBtnStyle, marginLeft: 'auto', opacity: selectedCount === 0 ? 0.5 : 1, cursor: selectedCount === 0 ? 'not-allowed' : 'pointer' }}
      >Approve selected</button>
      <button
        type="button"
        onClick={onSnooze}
        style={bulkBtnStyle}
      >Snooze 24h</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suggestion card (Pending / Rejected / Expired)
// ---------------------------------------------------------------------------

function SuggestionCard({ suggestion, isPending, selected, onToggle, onApprove, onReject, onSnooze }) {
  const rate = suggestion?.rate;
  const rule = suggestion?.rule;
  const reasonData = suggestion?.reason || {};
  const current = Number(suggestion?.currentPrice);
  const suggested = Number(suggestion?.suggestedPrice);
  const deltaPct = Number(suggestion?.deltaPct);
  const isUp = Number.isFinite(deltaPct) && deltaPct > 0;
  const locationCode = rate?.location?.code || '';
  const expiresLabel = expiresInLabel(suggestion?.expiresAt);

  return (
    <div style={{ ...cardStyle, gridTemplateColumns: '24px 1fr 200px' }}>
      <div style={{ paddingTop: 4 }}>
        {isPending && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            style={{ accentColor: '#3b82f6', width: 16, height: 16 }}
            aria-label="Select suggestion"
          />
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#e7ebf2' }}>
            {rate?.name || rate?.rateCode || 'Unknown rate'}
          </div>
          {locationCode && <Badge variant="loc">{locationCode}</Badge>}
          <Badge variant="rule">{ruleBadgeLabel(rule)}</Badge>
          {suggestion?.status && suggestion.status !== 'PENDING' && (
            <Badge variant="status">{String(suggestion.status).replace('_', ' ')}</Badge>
          )}
        </div>

        <PriceRow current={current} suggested={suggested} deltaPct={deltaPct} isUp={isUp} />

        <div style={{ fontSize: 13, lineHeight: 1.55, color: '#c8cfe0' }}>
          {buildReason(suggestion)}
        </div>

        <MarketMini reasonData={reasonData} />

        {suggestion?.status === 'REJECTED' && suggestion?.rejectedReason && (
          <div style={{ fontSize: 12, color: '#f87171' }}>
            Rejected: {suggestion.rejectedReason}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {isPending ? (
          <>
            <button type="button" onClick={onApprove} style={btnApproveStyle}>✓ Approve & apply</button>
            <button type="button" onClick={onReject} style={btnRejectStyle}>✕ Reject</button>
            <button type="button" onClick={onSnooze} style={btnSnoozeStyle}>Snooze 24h</button>
            {expiresLabel && (
              <div style={{ fontSize: 11, color: '#8a93a6', textAlign: 'center', marginTop: 4 }}>{expiresLabel}</div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12, color: '#8a93a6', textAlign: 'right' }}>
            {suggestion?.appliedAt
              ? `Decided ${fmtTimestamp(suggestion.appliedAt)}`
              : `Created ${fmtTimestamp(suggestion?.createdAt)}`}
          </div>
        )}
      </div>
    </div>
  );
}

function PriceRow({ current, suggested, deltaPct, isUp }) {
  const arrowColor = isUp ? '#f87171' : '#4ade80';
  const toColor = isUp ? '#f87171' : '#4ade80';
  const deltaBg = isUp ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)';
  const deltaFg = isUp ? '#f87171' : '#4ade80';
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      background: '#1a1e29',
      borderRadius: 8,
      padding: '12px 16px',
      fontSize: 17,
      flexWrap: 'wrap',
    }}>
      <span style={{ color: '#8a93a6', textDecoration: 'line-through', fontWeight: 500 }}>{fmtMoney(current)}</span>
      <span style={{ color: arrowColor, fontSize: 20, fontWeight: 600 }}>→</span>
      <span style={{ color: toColor, fontWeight: 700, fontSize: 20 }}>{fmtMoney(suggested)}</span>
      {Number.isFinite(deltaPct) && (
        <span style={{
          background: deltaBg,
          color: deltaFg,
          fontSize: 12,
          padding: '3px 8px',
          borderRadius: 4,
          fontWeight: 600,
          marginLeft: 'auto',
        }}>{fmtPct(deltaPct)}</span>
      )}
    </div>
  );
}

function MarketMini({ reasonData }) {
  const items = [
    { label: 'Market min', value: reasonData?.marketMin != null ? fmtMoney(reasonData.marketMin) : '—' },
    { label: 'Median', value: reasonData?.marketMedian != null ? fmtMoney(reasonData.marketMedian) : '—' },
    {
      label: 'Your rank if applied',
      value: reasonData?.yourRankAfter != null ? `#${reasonData.yourRankAfter}` : '—',
      valueColor: reasonData?.yourRankAfter === 1 ? '#4ade80' : reasonData?.yourRankAfter >= 5 ? '#f87171' : '#fbbf24',
    },
    {
      label: 'Guardrails',
      value: Array.isArray(reasonData?.guardrailsHit) && reasonData.guardrailsHit.length
        ? reasonData.guardrailsHit.join(', ')
        : '—',
    },
  ];
  return (
    <div style={{ display: 'flex', gap: 14, fontSize: 12, color: '#8a93a6', marginTop: 4, flexWrap: 'wrap' }}>
      {items.map((it) => (
        <div key={it.label} style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6, color: '#6e7587' }}>{it.label}</span>
          <span style={{ color: it.valueColor || '#c8cfe0', fontWeight: 600, fontSize: 13 }}>{it.value}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auto-applied row (collapsed style per mockup)
// ---------------------------------------------------------------------------

function AutoAppliedRow({ suggestion, onUndo }) {
  const rate = suggestion?.rate;
  const rule = suggestion?.rule;
  const current = Number(suggestion?.currentPrice);
  const suggested = Number(suggestion?.suggestedPrice);
  const deltaPct = Number(suggestion?.deltaPct);
  const ruleLabel = ruleBadgeLabel(rule);
  const appliedAt = suggestion?.appliedAt || suggestion?.createdAt;

  return (
    <div style={{ ...cardStyle, ...autoCardStyle, gridTemplateColumns: '24px 1fr 80px', padding: '14px 18px', alignItems: 'center' }}>
      <div />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Badge variant="auto">⚡ Auto-applied {fmtTimestamp(appliedAt)}</Badge>
        <strong style={{ fontSize: 14, color: '#e7ebf2' }}>{rate?.name || rate?.rateCode || 'Unknown rate'}</strong>
        <span style={{ color: '#c8cfe0', fontSize: 14 }}>
          {fmtMoney(current)} → {fmtMoney(suggested)}
        </span>
        {Number.isFinite(deltaPct) && (
          <span style={{
            color: deltaPct > 0 ? '#f87171' : '#4ade80',
            fontSize: 12,
            fontWeight: 600,
          }}>{fmtPct(deltaPct)}</span>
        )}
        <span style={{ fontSize: 12, color: '#8a93a6' }}>{ruleLabel}</span>
      </div>
      <a
        href="#undo"
        onClick={(e) => { e.preventDefault(); onUndo(); }}
        style={{ color: '#3b82f6', fontSize: 12, textAlign: 'right', textDecoration: 'none' }}
      >Edit rule →</a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty / skeleton states
// ---------------------------------------------------------------------------

function EmptyState({ status, onGoDashboard }) {
  const msg = {
    PENDING: 'No pending suggestions. The pricing engine will queue new ones after tomorrow\'s 04:00 ET scrape.',
    AUTO_APPLIED: 'No auto-applied rate changes yet. Switch a pricing rule to AUTO mode to enable this queue.',
    REJECTED: 'No rejected suggestions in your inbox.',
    EXPIRED: 'No expired suggestions — your inbox is clean.',
  }[status] || 'No suggestions to show.';
  return (
    <div style={{
      padding: 40,
      textAlign: 'center',
      color: '#8a93a6',
      background: '#161922',
      border: '1px solid #232838',
      borderRadius: 12,
    }}>
      <div style={{ fontSize: 14, marginBottom: 8 }}>{msg}</div>
      <button
        type="button"
        onClick={onGoDashboard}
        style={{
          background: 'transparent',
          color: '#3b82f6',
          border: '1px solid #1d3556',
          padding: '8px 14px',
          borderRadius: 8,
          fontSize: 13,
          cursor: 'pointer',
        }}
      >Go to Market Intelligence dashboard →</button>
    </div>
  );
}

function SkeletonList() {
  const shimmer = {
    background: 'linear-gradient(90deg, #1b1f29 0%, #232838 50%, #1b1f29 100%)',
    backgroundSize: '200% 100%',
    borderRadius: 12,
    animation: 'rfm-suggestions-shimmer 1.4s ease-in-out infinite',
  };
  return (
    <div aria-busy="true">
      <style>{'@keyframes rfm-suggestions-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }'}</style>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ ...shimmer, height: 180, marginBottom: 12 }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared styles + Badge
// ---------------------------------------------------------------------------

function Badge({ variant = 'rule', children }) {
  const map = {
    loc: { background: 'rgba(59,130,246,0.15)', color: '#60a5fa' },
    sipp: { background: 'rgba(168,85,247,0.15)', color: '#c084fc' },
    rule: { background: 'rgba(251,191,36,0.15)', color: '#fbbf24' },
    auto: { background: 'rgba(34,197,94,0.18)', color: '#4ade80' },
    status: { background: 'rgba(148,163,184,0.18)', color: '#cbd5e1' },
  };
  const style = map[variant] || map.rule;
  return (
    <span style={{
      display: 'inline-block',
      fontSize: 11,
      padding: '2px 8px',
      borderRadius: 4,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      ...style,
    }}>{children}</span>
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
      <div style={{ maxWidth: 980, margin: '0 auto' }}>{children}</div>
    </div>
  );
}

const pillStyle = {
  background: '#1b1f29',
  border: '1px solid #2a2f3d',
  color: '#c8cfe0',
  padding: '7px 14px',
  borderRadius: 7,
  fontSize: 13,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
};

const pillActiveStyle = {
  ...pillStyle,
  background: '#2563eb',
  borderColor: '#2563eb',
  color: '#fff',
};

const countStyle = {
  background: '#1b1f29',
  padding: '2px 7px',
  borderRadius: 4,
  fontSize: 11,
  marginLeft: 6,
  color: '#8a93a6',
};

const countActiveStyle = {
  ...countStyle,
  background: 'rgba(255,255,255,0.18)',
  color: '#fff',
};

const refreshBtnStyle = {
  background: '#1b1f29',
  border: '1px solid #2a2f3d',
  color: '#c8cfe0',
  padding: '7px 14px',
  borderRadius: 7,
  fontSize: 13,
  cursor: 'pointer',
};

const cardStyle = {
  background: '#161922',
  border: '1px solid #232838',
  borderRadius: 12,
  marginBottom: 12,
  padding: 18,
  display: 'grid',
  gap: 16,
  alignItems: 'start',
};

const autoCardStyle = {
  borderColor: '#1f3a2e',
  background: 'linear-gradient(180deg, #161e1a 0%, #131915 100%)',
};

const btnApproveStyle = {
  width: '100%',
  padding: '10px 14px',
  borderRadius: 7,
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
  border: 0,
  background: '#22c55e',
  color: '#052e16',
};

const btnRejectStyle = {
  width: '100%',
  padding: '10px 14px',
  borderRadius: 7,
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
  background: 'transparent',
  color: '#f87171',
  border: '1px solid rgba(185,28,28,0.25)',
};

const btnSnoozeStyle = {
  width: '100%',
  padding: '10px 14px',
  borderRadius: 7,
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
  background: '#1b1f29',
  color: '#c8cfe0',
  border: '1px solid #2a2f3d',
};

const bulkBtnStyle = {
  background: 'transparent',
  border: '1px solid #2a2f3d',
  color: '#c8cfe0',
  padding: '6px 12px',
  borderRadius: 6,
  fontSize: 12,
  cursor: 'pointer',
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
