'use client';

/**
 * Billing overview — `/tenants/billing`. SUPER_ADMIN only.
 *
 * Backend: GET /api/tenants/billing/overview  → { rows, totals, asOf }
 *          GET /api/tenants/billing/health    → webhook + reconciler health
 *
 * ONE ROW PER TENANT, NOT PER SUBSCRIPTION. A tenant with no subscription row at
 * all shows as NONE, and that is the most important row on the screen: revenue
 * that is missing rather than late.
 *
 * DEFAULT SORT IS SEVERITY, NOT THE ALPHABET. The question this screen answers
 * every morning is "who is in trouble today?"; the search box is for finding a
 * named tenant.
 *
 * WHAT THIS SCREEN DOES NOT DO: it takes no money action. Every write lives one
 * click away on the detail page, where there is room for the consequence to be
 * spelled out and confirmed. The inline buttons here are NAVIGATION — they say
 * what the next step for that row is and take you to where it can be done.
 * The approved mockup drew them as inline actions; putting a cancel or a suspend
 * one click from a list row is how a mis-click reaches a live subscriber, so
 * they navigate instead.
 *
 * Enrollment stays on /tenants (Phase 3) — see the note by the NONE row.
 *
 * English, hardcoded, no `t()`: matching /tenants, which is not i18n-converted.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/client';

/** UTC-pinned, always. A YYYY-MM-DD billing date rendered in local time shows
 *  the day BEFORE the one Authorize.Net will actually charge. */
export function billingDate(value) {
  const [y, m, d] = String(value || '').split('-').map(Number);
  if (!y || !m || !d) return '—';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function money(amount, currency = 'USD') {
  if (amount == null || amount === '') return '—';
  return `$${Number(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })} ${currency}`;
}

export const STATUS_LABEL = {
  NONE: 'Never enrolled',
  PENDING_AUTHORIZATION: 'Awaiting card',
  TRIALING: 'Trial',
  ACTIVE: 'Active',
  PAST_DUE: 'Past due',
  SUSPENDED: 'Suspended',
  CANCELLED: 'Cancelled',
  SUPERSEDED: 'Superseded',
  EXPIRED: 'Expired',
};

/**
 * The seven states are distinguishable without reading the text, and PAST_DUE
 * and SUSPENDED are the only two that read as alarms. NONE is neutral on
 * purpose: it is a gap, not a fault.
 */
export const STATUS_TONE = {
  NONE: 'chip--neutral',
  PENDING_AUTHORIZATION: 'chip--brand',
  TRIALING: 'chip--brand',
  ACTIVE: 'chip--ok',
  PAST_DUE: 'chip--danger',
  SUSPENDED: 'chip--danger',
  CANCELLED: 'chip--neutral',
  SUPERSEDED: 'chip--neutral',
  EXPIRED: 'chip--neutral',
};

export function cycleLabel(unit, length) {
  if (!unit) return '';
  if (unit === 'months' && length === 1) return 'monthly';
  if (unit === 'months' && length === 12) return 'annual';
  if (unit === 'months') return `every ${length} months`;
  return `every ${length} ${unit}`;
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'pastDue', label: 'Past due only', alarm: true },
  { key: 'suspended', label: 'Suspended' },
  { key: 'neverEnrolled', label: 'Never enrolled' },
  { key: 'cardExpiring', label: 'Card expiring' },
  { key: 'planDiverges', label: 'Plan divergent' },
];

export function applyFilter(rows, key) {
  switch (key) {
    case 'pastDue': return rows.filter((r) => r.status === 'PAST_DUE');
    case 'suspended': return rows.filter((r) => r.status === 'SUSPENDED');
    case 'neverEnrolled': return rows.filter((r) => r.status === 'NONE');
    case 'cardExpiring': return rows.filter((r) => r.cardExpiry);
    case 'planDiverges': return rows.filter((r) => r.planDiverges);
    default: return rows;
  }
}

export function applySearch(rows, term) {
  const q = String(term || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => [r.tenantName, r.tenantSlug, r.planCode, r.entitlementPlan, r.cardLast4]
    .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)));
}

const SEVERITY_ORDER = ['PAST_DUE', 'SUSPENDED', 'NONE', 'PENDING_AUTHORIZATION', 'TRIALING', 'ACTIVE'];

export function sortBySeverity(rows) {
  const rank = (s) => {
    const i = SEVERITY_ORDER.indexOf(s);
    return i === -1 ? SEVERITY_ORDER.length : i;
  };
  return [...rows].sort((a, b) => rank(a.status) - rank(b.status)
    || String(a.tenantName).localeCompare(String(b.tenantName)));
}

export function BillingOverviewClient({ token }) {
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    try {
      // cacheTtlMs: 0 — the 15s GET cache is right for a list that does not move
      // and wrong for one somebody is watching while they chase a payment.
      const [overview, healthOut] = await Promise.all([
        api('/api/tenants/billing/overview', { cacheTtlMs: 0 }, token),
        api('/api/tenants/billing/health', { cacheTtlMs: 0 }, token),
      ]);
      setData(overview);
      setHealth(healthOut);
      setMsg('');
    } catch (e) {
      setMsg(e.message);
    }
  };

  useEffect(() => { load(); }, [token]);

  const rows = useMemo(
    () => sortBySeverity(applySearch(applyFilter(data?.rows || [], filter), search)),
    [data, filter, search],
  );
  const totals = data?.totals || {};

  const counts = useMemo(() => {
    const all = data?.rows || [];
    return {
      all: all.length,
      pastDue: totals.pastDue || 0,
      suspended: totals.suspended || 0,
      neverEnrolled: totals.neverEnrolled || 0,
      cardExpiring: totals.cardExpiring || 0,
      planDiverges: totals.planDiverges || 0,
    };
  }, [data, totals]);

  return (
    <section className="glass card-lg stack">
      <div className="row-between">
        <div>
          <p className="eyebrow">Ride Fleet · Admin</p>
          <h2 className="page-title">Tenant Billing</h2>
          <p className="label">
            What Ride bills its tenants for Ride Fleet Manager. Not the payment gateway a tenant uses to
            charge its own renters.
          </p>
        </div>
        <div className="inline-actions">
          <button type="button" className="button-subtle" onClick={load}>Refresh</button>
          <Link href="/tenants" className="button-subtle">Tenants</Link>
        </div>
      </div>

      {msg ? <div className="error">{msg}</div> : null}

      {health ? <HealthStrip health={health} /> : null}

      <div className="app-card-grid compact">
        <Kpi label="Normalised MRR" value={money(totals.mrr)} foot="Annual plans ÷ 12. Excludes trial and suspended." />
        <Kpi label="Active" value={totals.active ?? 0} foot={`${totals.trialing ?? 0} trialing · ${totals.pendingAuthorization ?? 0} awaiting card`} />
        <Kpi label="Past due" value={totals.pastDue ?? 0} foot="Declined at Authorize.Net" />
        <Kpi label="Suspended" value={totals.suspended ?? 0} foot="Access cut by hand" />
        <Kpi label="Never enrolled" value={totals.neverEnrolled ?? 0} foot="Using the product, billed nothing" />
        <Kpi label="Plan divergent" value={totals.planDiverges ?? 0} foot="Billed one plan, entitled another" />
      </div>

      <div className="inline-actions">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={filter === f.key ? 'button' : 'button-subtle'}
            onClick={() => setFilter(f.key)}
          >
            {f.label} ({counts[f.key] ?? counts.all})
          </button>
        ))}
        <input
          type="search"
          placeholder="Search tenant, plan, last 4…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search tenants"
        />
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Tenant</th>
              <th>Plan billing / entitlement</th>
              <th>Amount · cycle</th>
              <th>Status</th>
              <th>Next charge</th>
              <th>Card</th>
              <th>Last charge</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => <Row key={r.tenantId} r={r} />)}
            {!rows.length ? (
              <tr><td colSpan={8} className="label">{data ? 'No tenants match this filter.' : 'Loading…'}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="label">
        Sorted by severity, not alphabetically. As of {data?.asOf || '—'}.
      </p>
    </section>
  );
}

function Kpi({ label, value, foot }) {
  return (
    <div className="kpi">
      <div className="klab">{label}</div>
      <div className="kval">{value}</div>
      <div className="kfoot">{foot}</div>
    </div>
  );
}

function Row({ r }) {
  const detail = `/tenants/billing/${r.tenantId}`;
  return (
    <tr>
      <td>
        <div><strong>{r.tenantName}</strong></div>
        <div className="label">{r.tenantSlug}</div>
      </td>
      <td>
        {r.planCode
          ? <span className="chip chip--neutral">{r.planCode}</span>
          : <span className="chip chip--neutral">— no billing</span>}
        {' '}
        {/* The divergence badge. Tenant.plan is the ENTITLEMENT key and
            TenantSubscription.planCode is the BILLING key; billing never
            rewrites entitlements on its own, so when they disagree somebody has
            to see it. */}
        {r.planDiverges
          ? <span className="chip chip--warn" title="Billing plan and entitlement plan disagree">≠ {r.entitlementPlan}</span>
          : <span className="label">/ {r.entitlementPlan}</span>}
      </td>
      <td className="nowrap">
        {r.amount ? money(r.amount, r.currency) : <span className="label">—</span>}
        <div className="label">{cycleLabel(r.intervalUnit, r.intervalLength)}</div>
      </td>
      <td>
        <span className={`chip ${STATUS_TONE[r.status] || 'chip--neutral'}`}>
          <span className="led" />{STATUS_LABEL[r.status] || r.status}
        </span>
        {/* PAST_DUE says what is true and offers the one thing that fixes it.
            It does NOT show an attempt count or a predicted retry date:
            Authorize.Net runs no fixed retry schedule, and inventing one would
            give the operator a deadline nobody is keeping. */}
        {r.status === 'PAST_DUE'
          ? <div className="label">Suspended at Authorize.Net — needs a new card</div> : null}
        {r.status === 'SUSPENDED' && r.billingSuspendedAt
          ? <div className="label">Access cut {new Date(r.billingSuspendedAt).toISOString().slice(0, 10)}</div> : null}
        {r.status === 'NONE'
          ? <div className="label">No subscription — billed nothing</div> : null}
      </td>
      <td className="nowrap">
        {r.nextChargeDate ? billingDate(r.nextChargeDate) : <span className="label">—</span>}
        {r.nextChargeDate && r.startDate === r.nextChargeDate
          ? <div className="label">first charge</div> : null}
      </td>
      <td className="nowrap">
        {r.cardLast4
          ? <>{r.cardBrand || 'card'} ••{r.cardLast4}</>
          : <span className="label">— none</span>}
        {r.cardExpiry ? (
          <div className="label">
            {r.cardExpiry.expired ? 'EXPIRED ' : 'expires '}
            {String(r.cardExpiry.cardExpMonth).padStart(2, '0')}/{String(r.cardExpiry.cardExpYear).slice(-2)}
          </div>
        ) : null}
      </td>
      <td className="nowrap">
        {r.lastCharge ? (
          <>
            {money(r.lastCharge.amount, r.lastCharge.currency)}
            <div className="label">{r.lastCharge.status} · {billingDate(r.lastCharge.chargeDate)}</div>
          </>
        ) : <span className="label">— nothing yet</span>}
      </td>
      <td>
        <div className="inline-actions">
          {/* Enrollment stays on /tenants: that page already owns the plan,
              amount and start-date form the invite needs, and onboarding is
              where enrolling actually happens. */}
          {r.status === 'NONE'
            ? <Link href="/tenants" className="button-subtle">Enroll on Tenants</Link>
            : <Link href={detail} className="button-subtle">Open billing</Link>}
        </div>
      </td>
    </tr>
  );
}

/**
 * The failure that kills this module is the one that leaves every other
 * indicator looking healthy: the webhook endpoint silently unreachable. So the
 * heartbeat gets a line of its own, above everything else.
 */
function HealthStrip({ health }) {
  if (health.silenceAlarm) {
    return (
      <div className="error">
        <strong>No verified Authorize.Net webhook has arrived in 72 hours</strong>, and {health.liveSubscriptions}{' '}
        live subscription(s) should be producing them. Check the webhook subscription in the Authorize.Net
        portal, the endpoint DNS, and whether the Signature Key rotated.
      </div>
    );
  }
  return (
    <div className="surface-note">
      Webhooks healthy — last verified event{' '}
      {health.hoursSinceLastEvent == null ? 'never' : `${health.hoursSinceLastEvent}h ago`}
      {' · '}{health.eventsLast24h} in 24h
      {health.unprocessed
        ? <> · <strong>{health.unprocessed} unprocessed</strong>{health.unprocessedStuck ? ` (${health.unprocessedStuck} gave up after 10 tries)` : ''}</>
        : ' · 0 unprocessed'}
      {' · '}{health.liveSubscriptions} live subscription(s)
    </div>
  );
}
