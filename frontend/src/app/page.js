'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../components/AuthGate';
import { AppShell } from '../components/AppShell';
import MarketIntelligenceCard from '../components/MarketIntelligenceCard';
import { api } from '../lib/client';
import { DEFAULT_TENANT_TIMEZONE, tenantDayKey } from '../lib/tenant-time';

// 2026-05-26: both helpers used to read the raw "YYYY-MM-DD" / "HH:mm"
// prefix of an ISO string as if those digits were already the wall-clock
// value in the tenant TZ. That hack matched the pre-fix backend's
// local-as-UTC storage; after the storage was migrated to correct UTC the
// dashboard rendered every time in UTC (e.g. 16:00 UTC as 4 PM rather than
// 12 PM AST) and silently dropped any return between 8 PM AST and midnight
// from "today" because the UTC date had already rolled to tomorrow.
// Both now do proper UTC→tenant-TZ conversion via Intl.
const DASHBOARD_TZ = DEFAULT_TENANT_TIMEZONE;

function fmtWallClockTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('en-US', {
    timeZone: DASHBOARD_TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

// Operations Timeline timestamp: the list response doesn't always include
// updatedAt, which rendered "Invalid Date". Fall back to createdAt / pickupAt
// and format defensively.
function timelineTs(r) {
  return r?.updatedAt || r?.createdAt || r?.pickupAt || null;
}
function fmtTimeline(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

// Tenant-TZ "YYYY-MM-DD" so e.g. an 11 PM AST return whose storage UTC is 03:00
// the next calendar day still maps to the AST date the agent expects. Delegates
// to the shared, Intl-crash-resilient helper (Sentry NEXTJSFRONTEND-T).
function wallClockDate(value) {
  return tenantDayKey(value, DASHBOARD_TZ);
}

function VehicleStatusDonut({ metrics }) {
  const { t } = useTranslation();
  const counts = useMemo(() => {
    const available = Number(metrics?.availableFleet || 0);
    const onRent = Number(metrics?.onRent || 0);
    const out = Number(metrics?.vehiclesInMaintenance || 0) + Number(metrics?.vehiclesOutOfService || 0);
    const total = Math.max(available + onRent + out, 1);
    return { available, onRent, out, total };
  }, [metrics]);

  const size = 168;
  const stroke = 20;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const portions = [counts.available, counts.onRent, counts.out].map((n) => n / counts.total);
  const colors = ['#30D5C8', '#6C8FF6', '#3F3F3F'];

  let offsetAcc = 0;
  const circles = portions.map((p, idx) => {
    const dash = `${Math.max(4, p * circumference)} ${circumference}`;
    const c = (
      <circle
        key={idx}
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={colors[idx]}
        strokeWidth={stroke}
        strokeDasharray={dash}
        strokeDashoffset={-offsetAcc}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    );
    offsetAcc += p * circumference;
    return c;
  });

  return (
    <div className="donut-wrap">
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#eee8ff" strokeWidth={stroke} />
        {circles}
      </svg>
      <div className="donut-center">
        <div className="value" style={{ fontSize: 28 }}>{counts.onRent}</div>
        <div className="label">{t('dashboard.onRent')}</div>
      </div>
      <div className="stack" style={{ minWidth: 150 }}>
        <div className="row"><span className="label">● {t('dashboard.available')}</span><strong>{counts.available}</strong></div>
        <div className="row"><span className="label">● {t('dashboard.onRent')}</span><strong>{counts.onRent}</strong></div>
        <div className="row"><span className="label">● {t('dashboard.outOfService')}</span><strong>{counts.out}</strong></div>
      </div>
    </div>
  );
}

function deriveKpisFromVehicles(vehicles = []) {
  const rows = Array.isArray(vehicles) ? vehicles : [];
  const activeBlocks = rows
    .map((vehicle) => ({
      vehicle,
      block: (Array.isArray(vehicle?.availabilityBlocks) ? vehicle.availabilityBlocks : []).find((block) => !block?.releasedAt) || null
    }))
    .filter((row) => !!row.block);
  const fleetTotal = rows.length;
  const vehiclesInMaintenance = rows.filter((vehicle) => String(vehicle?.status || '').toUpperCase() === 'IN_MAINTENANCE').length;
  const vehiclesOutOfService = rows.filter((vehicle) => String(vehicle?.status || '').toUpperCase() === 'OUT_OF_SERVICE').length;
  const migrationHeld = activeBlocks.filter((row) => String(row?.block?.blockType || '').toUpperCase() === 'MIGRATION_HOLD').length;
  const washHeld = activeBlocks.filter((row) => String(row?.block?.blockType || '').toUpperCase() === 'WASH_HOLD').length;
  const availableFleet = rows.filter((vehicle) => {
    const status = String(vehicle?.status || '').toUpperCase();
    return !['ON_RENT', 'IN_MAINTENANCE', 'OUT_OF_SERVICE'].includes(status) && !activeBlocks.some((row) => row?.vehicle?.id === vehicle.id);
  }).length;
  const onRent = rows.filter((vehicle) => String(vehicle?.status || '').toUpperCase() === 'ON_RENT').length + migrationHeld;
  return {
    fleetTotal,
    availableFleet,
    migrationHeld,
    washHeld,
    vehiclesInMaintenance,
    vehiclesOutOfService,
    onRent
  };
}

function SalesRevenueChart({ reservations }) {
  const { t } = useTranslation();
  const svgRef = useRef(null);
  const [activeIdx, setActiveIdx] = useState(11);

  const data = useMemo(() => {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const nowYear = new Date().getFullYear();
    const current = new Array(12).fill(0);
    const previous = new Array(12).fill(0);

    reservations.forEach((r) => {
      const d = new Date(r.pickupAt);
      const m = d.getMonth();
      const val = Number(r.estimatedTotal || r.dailyRate || 0);
      if (d.getFullYear() === nowYear) current[m] += val;
      if (d.getFullYear() === nowYear - 1) previous[m] += val;
    });

    // Keep line continuous through Jan..Dec even when month has no value.
    const forwardFill = (arr) => {
      let last = 0;
      const out = arr.map((n) => {
        if (n > 0) {
          last = n;
          return n;
        }
        return last;
      });
      const firstNonZero = out.find((n) => n > 0) || 0;
      return out.map((n) => (n === 0 ? firstNonZero : n));
    };

    const currentFilled = forwardFill(current);
    const previousFilled = forwardFill(previous);

    const max = Math.max(1, ...currentFilled, ...previousFilled);
    return monthNames.map((label, i) => ({
      label,
      current: currentFilled[i],
      previous: previousFilled[i],
      rawCurrent: current[i],
      rawPrevious: previous[i],
      max
    }));
  }, [reservations]);

  const W = 720; const H = 240; const pad = 22;
  const x = (i) => pad + (i * (W - pad * 2)) / 11;
  const y = (v, max) => H - pad - (v / max) * (H - pad * 2);
  const areaPath = (series) => {
    const start = `M ${x(0)} ${H - pad}`;
    const line = data.map((d, i) => `L ${x(i)} ${y(d[series], d.max)}`).join(' ');
    const end = `L ${x(11)} ${H - pad} Z`;
    return `${start} ${line} ${end}`;
  };
  const linePath = (series) => data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(d[series], d.max)}`).join(' ');

  const updateByClientX = (clientX) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;

    const clamped = Math.min(Math.max(rect.left, clientX), rect.right);
    const rel = clamped - rect.left;
    const padPx = (pad / W) * rect.width;
    const usable = Math.max(1, rect.width - padPx * 2);

    let nearestIdx = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 12; i += 1) {
      const px = padPx + (i * usable) / 11;
      const dist = Math.abs(rel - px);
      if (dist < best) {
        best = dist;
        nearestIdx = i;
      }
    }
    setActiveIdx(nearestIdx);
  };

  const active = data[activeIdx] || data[0];

  const tipX = x(activeIdx);
  const tipY = Math.min(y(active.current, active.max), y(active.previous, active.max));

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 4 }}>
        <div className="label">{t('dashboard.salesRevenue')}</div>
        <div className="label"><strong>{active.label}</strong> · {t('dashboard.salesRevenueSummary', { current: active.rawCurrent.toFixed(2), previous: active.rawPrevious.toFixed(2) })}</div>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="sales-chart"
        onPointerDown={(e) => updateByClientX(e.clientX)}
        onPointerMove={(e) => updateByClientX(e.clientX)}
      >
        <defs>
          <linearGradient id="gCurrent" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#30D5C8" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#30D5C8" stopOpacity="0.05" />
          </linearGradient>
          <linearGradient id="gPrev" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#6C8FF6" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#6C8FF6" stopOpacity="0.05" />
          </linearGradient>
        </defs>
        <path d={areaPath('previous')} fill="url(#gPrev)" />
        <path d={areaPath('current')} fill="url(#gCurrent)" />
        <path d={linePath('previous')} stroke="#6C8FF6" strokeWidth="2" fill="none" />
        <path d={linePath('current')} stroke="#30D5C8" strokeWidth="2.4" fill="none" />
        <line x1={x(activeIdx)} x2={x(activeIdx)} y1={pad} y2={H - pad} stroke="#8752FE" strokeDasharray="4 4" opacity="0.7" />

        <g transform={`translate(${tipX}, ${Math.max(18, tipY - 14)})`}>
          <rect x={-72} y={-34} rx={8} width={144} height={28} fill="rgba(63,63,63,0.86)" />
          <text x="0" y="-15" textAnchor="middle" fill="#fff" fontSize="10">{`${active.label} · $${active.rawCurrent.toFixed(0)} / $${active.rawPrevious.toFixed(0)}`}</text>
          <circle cx="0" cy="0" r="4" fill="#8752FE" stroke="#fff" strokeWidth="2" />
        </g>
      </svg>
      <div className="chart-months">{data.map((d) => <span key={d.label}>{d.label}</span>)}</div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <AuthGate>
      {({ token, me, logout }) => <DashboardInner token={token} me={me} logout={logout} />}
    </AuthGate>
  );
}

function DashboardInner({ token, me, logout }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [reservations, setReservations] = useState([]);
  // Today's pickups/returns come from dedicated tenant-TZ date-scoped queries so
  // the Operations Board count+list match the Reservations page (the old
  // client-side filter over a capped /api/reservations?limit=500 dropped today's
  // pickups when a tenant had >500 reservations → showed 0).
  const [pickupsTodayRows, setPickupsTodayRows] = useState([]);
  const [shuttleOpen, setShuttleOpen] = useState(0);
  const [returnsTodayRows, setReturnsTodayRows] = useState([]);
  const [overview, setOverview] = useState(null);
  const [resSummary, setResSummary] = useState(null);
  const [mismatchCount, setMismatchCount] = useState(0);
  const [citSummary, setCitSummary] = useState(null);
  const [maintSummary, setMaintSummary] = useState(null);
  // Today-KPIs (2026-07-26, approved mockups): Collected today + Pending tolls.
  // 403 for agents/scoped users -> catch keeps it null and the tiles hide.
  const [todayKpis, setTodayKpis] = useState(null);
  const [docAlert, setDocAlert] = useState(null);
  const [msg, setMsg] = useState('');
  const canSeeOverview = me?.moduleAccess?.reports !== false;
  const canSeeVehicles = me?.moduleAccess?.vehicles !== false;

  const load = async () => {
    const [reservationsResult, overviewResult, vehiclesResult, summaryResult, reconResult] = await Promise.allSettled([
      // Used for the Operations Timeline + active/overdue fallback (not for the
      // Pickups/Returns board — that's a date-scoped fetch keyed to boardDate,
      // see the effect below, so it's correct for ANY selected day regardless of
      // total reservation volume).
      api('/api/reservations?limit=500', {}, token),
      canSeeOverview ? api('/api/reports/overview', {}, token) : Promise.resolve(null),
      !canSeeOverview && canSeeVehicles ? api('/api/vehicles?limit=2000', {}, token) : Promise.resolve([]),
      api('/api/reservations/summary', {}, token),
      canSeeVehicles ? api('/api/inventory/reconciliation/open', { bypassCache: true }, token) : Promise.resolve(null)
    ]);

    setMismatchCount(reconResult.status === 'fulfilled' && reconResult.value ? Number(reconResult.value.count || 0) : 0);

    // Shuttle arc (2026-08-05): open pickup requests for the action board.
    api('/api/shuttle-requests?status=open', { bypassCache: true }, token)
      .then((o) => setShuttleOpen(Array.isArray(o?.rows) ? o.rows.length : 0))
      .catch(() => setShuttleOpen(0));

    // Citations tile (module-gated; soft-fail so a 403/off-module never breaks the dashboard).
    if (me?.moduleAccess?.citations !== false) {
      api('/api/citations/summary', {}, token).then((s) => setCitSummary(s || null)).catch(() => setCitSummary(null));
    }

    // Maintenance Due tile (2026-07-13) — service intervals overdue / due soon,
    // miles-driven, counts only (no money). Same module-gated soft-fail pattern.
    if (me?.moduleAccess?.maintenance !== false) {
      api('/api/maintenance/summary', { bypassCache: true }, token).then((s) => setMaintSummary(s || null)).catch(() => setMaintSummary(null));
      api('/api/reports/today-kpis', { bypassCache: true }, token).then((k) => setTodayKpis(k && k.collectedToday != null ? k : null)).catch(() => setTodayKpis(null));
    }

    // Business documents expiring (2026-07-28). Lives behind the settings
    // module + ADMIN/OPS like the rest of /api/locations, so a 403 for anyone
    // else must stay silent rather than break the dashboard.
    if (me?.moduleAccess?.settings !== false) {
      api('/api/locations/documents/expiring', { bypassCache: true }, token)
        .then((d) => setDocAlert(d && (d.expiringCount || d.expiredCount) ? d : null))
        .catch(() => setDocAlert(null));
    }

    if (reservationsResult.status === 'fulfilled') {
      const val = reservationsResult.value;
      setReservations(Array.isArray(val) ? val : (Array.isArray(val?.items) ? val.items : []));
    } else setReservations([]);

    if (overviewResult.status === 'fulfilled' && overviewResult.value) {
      setOverview(overviewResult.value || null);
    } else if (!canSeeOverview && vehiclesResult.status === 'fulfilled') {
      setOverview({ kpis: deriveKpisFromVehicles(vehiclesResult.value || []) });
    } else {
      setOverview(null);
    }

    if (summaryResult.status === 'fulfilled') setResSummary(summaryResult.value || null);

    if (reservationsResult.status === 'rejected' && overviewResult.status === 'rejected' && vehiclesResult.status === 'rejected') {
      setMsg(reservationsResult.reason?.message || overviewResult.reason?.message || vehiclesResult.reason?.message || t('dashboard.msgUnableToLoad'));
    } else if (reservationsResult.status === 'rejected') {
      setMsg(t('dashboard.msgLimitedReservation'));
    } else if (canSeeOverview && overviewResult.status === 'rejected') {
      setMsg(t('dashboard.msgLimitedKpi'));
    } else if (!canSeeOverview && canSeeVehicles && vehiclesResult.status === 'rejected') {
      setMsg(t('dashboard.msgLimitedFleet'));
    } else {
      setMsg('');
    }
  };

  useEffect(() => {
    load();
  }, [token, canSeeOverview]);

  const startCheckout = async (id) => {
    router.push(`/reservations/${id}/checkout-wizard-v2`);
  };

  const markCancelled = async (id) => {
    const reason = window.prompt(t('dashboard.cancellationReasonPrompt'));
    if (!reason || !reason.trim()) { if (reason !== null) setMsg(t('dashboard.cancellationRequiresReason')); return; }
    try {
      await api(`/api/reservations/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'CANCELLED', cancellationReason: reason.trim() }) }, token);
      setMsg(t('dashboard.reservationCancelled'));
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const markNoShow = async (id) => {
    if (!window.confirm(t('dashboard.confirmNoShow'))) return;
    try {
      await api(`/api/reservations/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'NO_SHOW' }) }, token);
      setMsg(t('dashboard.reservationNoShow'));
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const requestCustomerInfo = async (id) => {
    try {
      const out = await api(`/api/reservations/${id}/request-customer-info`, { method: 'POST', body: JSON.stringify({}) }, token);
      const link = out?.link || '';
      if (link && navigator?.clipboard) {
        try { await navigator.clipboard.writeText(link); } catch {}
      }
      setMsg(link ? t('dashboard.customerInfoCopied', { link }) : t('dashboard.customerInfoIssued'));
    } catch (e) {
      setMsg(e.message);
    }
  };

  const startCheckin = (id) => {
    router.push(`/reservations/${id}/checkin-wizard`);
  };

  const openReservation = (id) => {
    router.push(`/reservations/${id}`);
  };

  const unpaidBalance = (r) => {
    const balance = Number(r?.rentalAgreement?.balance);
    return Number.isFinite(balance) && balance > 0 ? balance : 0;
  };

  const moneyShort = (n) => `$${Number(n || 0).toFixed(2)}`;

  const kpis = overview?.kpis || {};
  // Total Vehicles = effective fleet (kpis.fleetTotal excludes SOLD +
  // OUT_OF_SERVICE + IN_MAINTENANCE on the backend as of 2026-05-28).
  // Previously summed fleetTotal + maintenance + OOS to show "every
  // unit on file", but Hector wants the headline number to be the
  // live rentable fleet — SOLD and retired units shouldn't bloat
  // capacity. Maintenance / OOS are still surfaced separately in
  // their own tile.
  const totalVehicles = Number(kpis.fleetTotal || 0);
  const available = Number(kpis.availableFleet || 0);
  const migrationHeld = Number(kpis.migrationHeld || 0);
  const washHeld = Number(kpis.washHeld || 0);
  const serviceHeld = Number(kpis.vehiclesInMaintenance || 0) + Number(kpis.vehiclesOutOfService || 0);
  // Active = CHECKED_OUT with returnAt > now (still within plan). Backend
  // computes the canonical count tenant-wide; FE falls back to its own
  // strict filter if the KPI isn't available yet (e.g. pre-deploy).
  // Previously this counted NEW + CONFIRMED + all CHECKED_OUT which
  // ballooned to 298 by mixing future bookings + overdue rentals into
  // the 'active' bucket.
  const activeReservations = Number(
    kpis.activeReservations ?? reservations.filter((r) =>
      r.status === 'CHECKED_OUT' &&
      r.returnAt && new Date(r.returnAt) > new Date()
    ).length
  );
  // Overdue = CHECKED_OUT past planned returnAt. Backend computes the
  // canonical count (filtered by tenant + location server-side); FE falls
  // back to its own list filter in case the backend KPI isn't available
  // yet (e.g. pre-deploy).
  //
  // 2026-05-27: client-side fallback also respects overdueIgnored=true
  // (grandfathered stale data). Without this, the fallback over-counted
  // by ~400 whenever the backend dropped the kpi from its response,
  // since the FE list view doesn't filter ignored rows out of
  // `reservations` by default.
  const overdueReservations = Number(
    kpis.overdueReservations ?? reservations.filter((r) =>
      r.status === 'CHECKED_OUT' && r.returnAt &&
      new Date(r.returnAt) <= new Date() && !r.overdueIgnored
    ).length
  );
  const feeAdvisoryCount = reservations.filter((r) => /\[FEE_ADVISORY_OPEN\s+/i.test(String(r.notes || ''))).length;
  // Phase 1.8 — checkout sessions abandoned or stuck > 4h in a
  // non-terminal step. Surfaced as its own tile so the night-shift
  // can sweep them before customers return to wonder why their
  // payment hasn't settled. Backend-canonical; no client fallback
  // since we have no list of sessions on this page.
  const stuckCheckouts = Number(kpis.stuckCheckouts || 0);
  // Vehicle Profile pack (2026-06-10): counts for the two cards that replace
  // Stuck Checkouts + Fee Advisory Watch on the Ops Hub.
  const registrationsExpiring30d = Number(kpis.registrationsExpiring30d || 0);
  const readyToRotate = Number(kpis.readyToRotate || 0);
  const rotationRuleLabel = kpis.fleetRotationRule === 'MILEAGE' ? t('dashboard.rotationRuleMileage') : t('dashboard.rotationRuleTime');
  // Customer-led inspection Fase B (2026-06-11): submitted customer
  // inspections with damage reports awaiting soft/hard approval.
  const inspectionsToReview = Number(kpis.inspectionsToReview || 0);
  // 2026-07-05: storefront loaner requests waiting for advisor contact.
  const loanerRequestsPending = Number(kpis.loanerRequestsPending || 0);
  // Kiosk B3b (2026-07-05): escalated kiosk sessions waiting for a staff
  // member (backend KPI kioskEscalations, reports.service overview). Card
  // only renders when count > 0 AND the tenant has the kiosk module on
  // (module is opt-in / default OFF).
  const kioskEscalations = Number(kpis.kioskEscalations || 0);
  // Anchor "today" in the tenant timezone — not the browser's — so the
  // Operations Board agrees with the rest of the app for agents loading
  // from a non-PR browser. Both functions return "YYYY-MM-DD" in DASHBOARD_TZ.
  const [boardDate, setBoardDate] = useState(() => wallClockDate(new Date()));
  const todayStr = useMemo(() => wallClockDate(new Date()), []);
  const isToday = boardDate === todayStr;
  const boardLabel = isToday ? t('dashboard.today') : new Date(boardDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  // Date-scoped fetch keyed to the SELECTED board date (pickups by dateOn, returns
  // by returnDateOn). Works for ANY day regardless of total reservation volume —
  // the old capped client-side filter showed 0 for non-today dates.
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    const rowsOf = (res) => {
      if (res.status !== 'fulfilled') return [];
      const v = res.value;
      return Array.isArray(v?.rows) ? v.rows : (Array.isArray(v?.items) ? v.items : (Array.isArray(v) ? v : []));
    };
    (async () => {
      const [p, r] = await Promise.allSettled([
        api(`/api/reservations/page?dateOn=${boardDate}&limit=500`, {}, token),
        api(`/api/reservations/page?returnDateOn=${boardDate}&limit=500`, {}, token),
      ]);
      if (cancelled) return;
      setPickupsTodayRows(rowsOf(p));
      setReturnsTodayRows(rowsOf(r));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, boardDate]);
  const pickups = pickupsTodayRows.filter((r) => ['NEW', 'CONFIRMED'].includes(r.status));
  // Today's returns panel: vehicles still expected back. Drops:
  //   • CANCELLED / NO_SHOW — customer never showed; nothing to return
  //   • CHECKED_IN / CHECKED_IN_UNPAID — vehicle is already back, the
  //     agent doesn't need to be reminded to receive it (was surfacing
  //     already-closed rentals as "Next Return" — bug 2026-05-27)
  // This also fixes the count/list mismatch in the Operations Board
  // header by replacing the backend `resSummary.returnsToday` count
  // with `returns.length` (see below) — the two queries disagreed when
  // a return had been received earlier in the day.
  const returns = returnsTodayRows.filter((r) =>
    !['CANCELLED', 'NO_SHOW', 'CHECKED_IN', 'CHECKED_IN_UNPAID'].includes(r.status)
  );
  const timeline = reservations.slice().sort((a, b) => {
    const ta = new Date(timelineTs(a) || 0).getTime() || 0;
    const tb = new Date(timelineTs(b) || 0).getTime() || 0;
    return tb - ta;
  }).slice(0, 10);
  const workspaceOpsHub = useMemo(() => {
    const nextItems = [
      // Shuttle arc (2026-08-05): a customer standing at an airport curb
      // outranks everything else on the rail.
      shuttleOpen > 0
        ? {
            id: 'shuttle-requests',
            title: t('shuttle.railTitle', { defaultValue: 'Shuttle requests' }),
            detail: t('shuttle.railDetail', { defaultValue: '{{count}} customer(s) waiting for airport pickup', count: shuttleOpen }),
            note: t('shuttle.railNote', { defaultValue: 'Chloe validated the reservation; the floor dispatches the bus.' }),
            action: () => router.push('/shuttle'),
            actionLabel: t('shuttle.railOpen', { defaultValue: 'Open queue' })
          }
        : null,
      pickups[0]
        ? {
            id: `pickup-${pickups[0].id}`,
            title: t('dashboard.nextPickup'),
            detail: `#${pickups[0].reservationNumber} - ${pickups[0].customer?.firstName || ''} ${pickups[0].customer?.lastName || ''}`.trim(),
            note: t('dashboard.pickupAt', { time: new Date(pickups[0].pickupAt).toLocaleString('en-US', { timeZone: DASHBOARD_TZ }) }),
            action: () => startCheckout(pickups[0].id),
            actionLabel: t('dashboard.startCheckout')
          }
        : null,
      returns[0]
        ? {
            id: `return-${returns[0].id}`,
            title: t('dashboard.nextReturn'),
            detail: `#${returns[0].reservationNumber} - ${returns[0].customer?.firstName || ''} ${returns[0].customer?.lastName || ''}`.trim(),
            note: t('dashboard.returnAt', { time: new Date(returns[0].returnAt).toLocaleString('en-US', { timeZone: DASHBOARD_TZ }) }),
            action: () => router.push(`/reservations/${returns[0].id}/checkin-wizard`),
            actionLabel: t('dashboard.openCheckin')
          }
        : null,
      // Vehicle Profile pack (2026-06-10): these two cards REPLACE the old
      // "Stuck Checkouts" and "Fee Advisory Watch" cards (Hector's call).
      // Stuck checkouts remain reachable via /reservations?filter=stuck-checkouts.
      // Kiosk escalations banner (B3b): a guest is physically waiting at a
      // kiosk — highest-urgency card, deep-links to the filtered sessions list.
      (kioskEscalations > 0 && me?.moduleAccess?.kiosk !== false)
        ? {
            id: 'kiosk-escalations',
            title: t('dashboard.kioskEscalations'),
            detail: t('dashboard.kioskEscalationsDetail', { count: kioskEscalations }),
            note: t('dashboard.kioskEscalationsNote'),
            action: () => router.push('/kiosks?outcome=ESCALATED'),
            actionLabel: t('dashboard.openKiosks')
          }
        : null,
      inspectionsToReview > 0
        ? {
            id: 'inspections-to-review',
            title: t('dashboard.inspectionsToReview'),
            detail: t('dashboard.inspectionsToReviewDetail', { count: inspectionsToReview }),
            note: t('dashboard.inspectionsToReviewNote'),
            action: () => router.push('/inspections/review'),
            actionLabel: t('dashboard.reviewNow')
          }
        : null,
      registrationsExpiring30d > 0
        ? {
            id: 'registrations-expiring',
            title: t('dashboard.registrationsExpiring'),
            detail: t('dashboard.vehicleCount', { count: registrationsExpiring30d }),
            note: t('dashboard.registrationsExpiringNote'),
            action: () => router.push('/vehicles?registration=expiring'),
            actionLabel: t('dashboard.reviewVehicles')
          }
        : null,
      readyToRotate > 0
        ? {
            id: 'ready-to-rotate',
            title: t('dashboard.readyToRotate'),
            detail: t('dashboard.vehicleCount', { count: readyToRotate }),
            note: t('dashboard.readyToRotateNote', { rule: rotationRuleLabel }),
            action: () => router.push('/vehicles?rotation=ready'),
            actionLabel: t('dashboard.viewBatch')
          }
        : null,
      // 2026-07-05: NEW courtesy-car requests from the public storefront
      // waiting for an advisor. Same self-clearing pattern as Inspections
      // to Review — appears only when the queue is non-empty, click-through
      // to /loaner, disappears once requests move past RECEIVED.
      (me?.moduleAccess?.loaner === true && loanerRequestsPending > 0)
        ? {
            id: 'loaner-requests-pending',
            title: t('dashboard.loanerRequests'),
            detail: t('dashboard.loanerRequestsDetail', { count: loanerRequestsPending }),
            note: t('dashboard.loanerRequestsNote'),
            // Anchor to the queues section — the requests panel lives BELOW the
            // (long) intake wizard on /loaner; landing at the top defeats the card.
            action: () => router.push('/loaner#loaner-queues'),
            actionLabel: t('dashboard.reviewRequests')
          }
        : null,
      // Loaner Lane card only renders for tenants that have the dealership
      // loaner module enabled. moduleAccess.loaner is set by the backend in
      // lib/module-access.js based on tenant.dealershipLoanerEnabled (it's
      // false by default — loaner is opt-in).
      (me?.moduleAccess?.loaner === true)
        ? {
            id: 'loaner',
            title: t('dashboard.loanerLane'),
            detail: t('dashboard.loanerLaneDetail'),
            note: t('dashboard.loanerLaneNote'),
            action: () => router.push('/loaner'),
            actionLabel: t('dashboard.openLoaner')
          }
        : null
    ].filter(Boolean);

    return {
      totalVehicles,
      available,
      migrationHeld,
      washHeld,
      serviceHeld,
      activeReservations,
      overdueReservations,
      feeAdvisoryCount,
      nextItems
    };
  }, [shuttleOpen, pickups, returns, feeAdvisoryCount, registrationsExpiring30d, readyToRotate, rotationRuleLabel, inspectionsToReview, loanerRequestsPending, kioskEscalations, totalVehicles, available, migrationHeld, serviceHeld, activeReservations, overdueReservations, router, me?.moduleAccess?.loaner, me?.moduleAccess?.kiosk, t]);

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="app-banner">
          <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
            <div>
              <span className="eyebrow">{t('dashboard.opsHubEyebrow')}</span>
              <h2 className="page-title" style={{ marginTop: 6 }}>
                {t('dashboard.opsHubTitle')}
              </h2>
              <p className="ui-muted">{t('dashboard.opsHubSubtitle')}</p>
            </div>
            <span className="status-chip neutral">{t('dashboard.workspaceChip')}</span>
          </div>
          <div className="app-card-grid compact">
            <button type="button" className="info-tile" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => router.push('/vehicles')} title={t('dashboard.tileVehiclesTitle')}>
              <span className="label">{t('dashboard.tileVehicles')}</span>
              <strong>{workspaceOpsHub.totalVehicles}</strong>
              <span className="ui-muted">{t('dashboard.tileVehiclesDesc')}</span>
            </button>
            <button type="button" className="info-tile" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => router.push('/vehicles?status=available')} title={t('dashboard.tileAvailableTitle')}>
              <span className="label">{t('dashboard.tileAvailable')}</span>
              <strong>{workspaceOpsHub.available}</strong>
              <span className="ui-muted">{t('dashboard.tileAvailableDesc')}</span>
            </button>
            <button type="button" className="info-tile" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => router.push('/vehicles?status=migration')} title={t('dashboard.tileMigrationHoldsTitle')}>
              <span className="label">{t('dashboard.tileMigrationHolds')}</span>
              <strong>{workspaceOpsHub.migrationHeld}</strong>
              <span className="ui-muted">{t('dashboard.tileMigrationHoldsDesc')}</span>
            </button>
            <button type="button" className="info-tile" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => router.push('/vehicles?status=maintenance')} title={t('dashboard.tileMaintenanceOosTitle')}>
              <span className="label">{t('dashboard.tileMaintenanceOos')}</span>
              <strong>{workspaceOpsHub.serviceHeld}</strong>
              <span className="ui-muted">{t('dashboard.tileMaintenanceOosDesc')}</span>
            </button>
            {todayKpis ? (
              <button type="button" className="info-tile" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => router.push('/reports-v2/payments-by-day')} title={t('dashboard.tileCollectedTodayTitle')}>
                <span className="label">{t('dashboard.tileCollectedToday')}</span>
                <strong className="tnum" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {`$${Number(todayKpis.collectedToday || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                </strong>
                <span className="ui-muted">
                  {/* Per-location split (2026-08-06); the generic caption until
                      the day's first payment gives it something to say. */}
                  {Array.isArray(todayKpis.byLocation) && todayKpis.byLocation.length
                    ? todayKpis.byLocation.map((l) => `${l.code || l.name || '—'} $${Number(l.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`).join(' · ')
                    : t('dashboard.tileCollectedTodayDesc')}
                </span>
              </button>
            ) : null}
            {todayKpis ? (
              <button
                type="button"
                className="info-tile"
                onClick={() => router.push('/tolls')}
                style={{
                  textAlign: 'left',
                  cursor: 'pointer',
                  background: Number(todayKpis.pendingTolls || 0) > 0 ? 'var(--danger-bg)' : undefined,
                  borderColor: Number(todayKpis.pendingTolls || 0) > 0 ? 'var(--danger-bd)' : undefined,
                }}
                title={t('dashboard.tilePendingTollsTitle')}
              >
                <span className="label">{t('dashboard.tilePendingTolls')}</span>
                <strong style={{ fontVariantNumeric: 'tabular-nums', color: Number(todayKpis.pendingTolls || 0) > 0 ? 'var(--danger-tx)' : 'var(--ok-tx)' }}>
                  {Number(todayKpis.pendingTolls || 0)}
                </strong>
                <span className="ui-muted">{t('dashboard.tilePendingTollsDesc')}</span>
              </button>
            ) : null}
            {/* Maintenance Due (2026-07-13): service intervals from ServiceSchedule,
                miles-driven. Big number = OVERDUE (the alarm), due-soon in the desc.
                Red tint mirrors the overdue-returns tile. Renders only when the
                module is on AND /api/maintenance/summary answered (soft-fail). */}
            {/* Business documents expiring (2026-07-28). A branch that lets a
                permit or registration lapse cannot legally trade, and the
                usual way that surfaces is an inspector — so it gets a tile.
                Red once something has ALREADY lapsed, amber while there is
                still time to renew. Renders only when there is something to
                say. */}
            {docAlert ? (
              <button
                type="button"
                className="info-tile"
                onClick={() => router.push('/settings')}
                style={{
                  textAlign: 'left',
                  cursor: 'pointer',
                  background: Number(docAlert.expiredCount || 0) > 0 ? 'var(--danger-bg)' : 'var(--warn-bg)',
                  borderColor: Number(docAlert.expiredCount || 0) > 0 ? 'var(--danger-bd)' : 'var(--warn-bd)',
                }}
                title={t('dashboard.tileDocsExpiringTitle', { defaultValue: 'Business documents needing renewal' })}
              >
                <span className="label">{t('dashboard.tileDocsExpiring', { defaultValue: 'Documents expiring' })}</span>
                <strong style={{ color: Number(docAlert.expiredCount || 0) > 0 ? 'var(--danger-tx)' : 'var(--warn-tx)' }}>
                  {Number(docAlert.expiredCount || 0) + Number(docAlert.expiringCount || 0)}
                </strong>
                <span className="ui-muted">
                  {Number(docAlert.expiredCount || 0) > 0
                    ? t('dashboard.tileDocsExpiredDesc', {
                      defaultValue: '{{expired}} already expired',
                      expired: Number(docAlert.expiredCount || 0),
                    })
                    : t('dashboard.tileDocsExpiringDesc', {
                      defaultValue: 'within {{days}} days',
                      days: Number(docAlert.warnDays || 30),
                    })}
                </span>
              </button>
            ) : null}

            {maintSummary ? (
              <button
                type="button"
                className="info-tile"
                onClick={() => router.push('/maintenance')}
                style={{
                  textAlign: 'left',
                  cursor: 'pointer',
                  background: Number(maintSummary.overdue || 0) > 0 ? 'var(--danger-bg)' : undefined,
                  borderColor: Number(maintSummary.overdue || 0) > 0 ? 'var(--danger-bd)' : undefined,
                }}
                title={t('dashboard.tileMaintenanceDueTitle')}
              >
                <span className="label">{t('dashboard.tileMaintenanceDue')}</span>
                <strong style={{ color: Number(maintSummary.overdue || 0) > 0 ? 'var(--danger-tx)' : (Number(maintSummary.dueSoon || 0) === 0 ? 'var(--ok-tx)' : undefined) }}>
                  {Number(maintSummary.overdue || 0)}
                </strong>
                <span className="ui-muted">
                  {(() => {
                    const overdueN = Number(maintSummary.overdue || 0);
                    // dueSoonOnly is server-computed (soon, not yet overdue); fall back for a pre-deploy backend.
                    const soonN = Number(maintSummary.dueSoonOnly ?? Math.max(0, Number(maintSummary.dueSoon || 0) - overdueN));
                    if (overdueN > 0) return t('dashboard.tileMaintenanceDueDesc', { soon: soonN });
                    if (soonN > 0) return t('dashboard.tileMaintenanceDueSoonDesc', { soon: soonN });
                    return t('dashboard.tileMaintenanceDueOk');
                  })()}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              className="info-tile"
              onClick={() => router.push('/vehicles/reconciliation')}
              style={{
                textAlign: 'left',
                cursor: 'pointer',
                background: mismatchCount > 0 ? 'var(--danger-bg)' : undefined,
                borderColor: mismatchCount > 0 ? 'var(--danger-bd)' : undefined,
              }}
              title={t('dashboard.tileStatusMismatchesTitle')}
            >
              <span className="label">{t('dashboard.tileStatusMismatches')}</span>
              <strong style={{ color: mismatchCount > 0 ? 'var(--danger-tx)' : undefined }}>{mismatchCount}</strong>
              <span className="ui-muted">{t('dashboard.tileStatusMismatchesDesc')}</span>
            </button>
            <button type="button" className="info-tile" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => router.push('/reservations?filter=active')} title={t('dashboard.tileActiveReservationsTitle')}>
              <span className="label">{t('dashboard.tileActiveReservations')}</span>
              <strong>{workspaceOpsHub.activeReservations}</strong>
              <span className="ui-muted">{t('dashboard.tileActiveReservationsDesc')}</span>
            </button>
            <button
              type="button"
              className="info-tile"
              onClick={() => router.push('/reservations?filter=overdue')}
              style={{
                textAlign: 'left',
                cursor: 'pointer',
                background: workspaceOpsHub.overdueReservations > 0 ? 'var(--danger-bg)' : undefined,
                borderColor: workspaceOpsHub.overdueReservations > 0 ? 'var(--danger-bd)' : undefined,
              }}
              title={t('dashboard.tileOverdueReturnsTitle')}
            >
              <span className="label">{t('dashboard.tileOverdueReturns')}</span>
              <strong style={{ color: workspaceOpsHub.overdueReservations > 0 ? 'var(--danger-tx)' : undefined }}>
                {workspaceOpsHub.overdueReservations}
              </strong>
              <span className="ui-muted">{t('dashboard.tileOverdueReturnsDesc')}</span>
            </button>
            <div className="info-tile">
              <span className="label">{t('dashboard.tileFeeAdvisories')}</span>
              <strong>{workspaceOpsHub.feeAdvisoryCount}</strong>
              <span className="ui-muted">{t('dashboard.tileFeeAdvisoriesDesc')}</span>
            </div>
            {citSummary ? (
              <button type="button" className="info-tile" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => router.push('/citations')} title={t('dashboard.tileCitationsTitle')}>
                <span className="label">{t('dashboard.tileCitations')}</span>
                <strong>{citSummary.needsReview}</strong>
                <span className="ui-muted">{t('dashboard.tileCitationsDesc', { outstanding: Number(citSummary.outstanding || 0).toFixed(2) })}</span>
              </button>
            ) : null}
          </div>
          <div className="app-card-grid compact">
            {workspaceOpsHub.nextItems.map((item) => (
              <section key={item.id} className="glass card section-card">
                <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
                <div className="ui-muted">{item.detail}</div>
                <div className="surface-note">{item.note}</div>
                <div className="inline-actions">
                  <button type="button" onClick={item.action}>{item.actionLabel}</button>
                </div>
              </section>
            ))}
          </div>
        </div>
      </section>
      <section className="grid4">
        <div className="glass card"><div className="label">{t('dashboard.totalVehicles')}</div><div className="value">{totalVehicles}</div></div>
        <div className="glass card"><div className="label">{t('dashboard.availableVehicles')}</div><div className="value">{available}</div></div>
        <div className="glass card"><div className="label">{t('dashboard.reservations')}</div><div className="value">{Number.isFinite(Number(resSummary?.totalReservations)) ? Number(resSummary.totalReservations).toLocaleString() : reservations.length}</div></div>
        <div className="glass card"><div className="label">{t('dashboard.active')}</div><div className="value">{activeReservations}</div></div>
        <div className="glass card"><div className="label">{t('dashboard.tileFeeAdvisories')}</div><div className="value">{feeAdvisoryCount}</div></div>
      </section>
      {msg ? <p className="label" style={{ margin: '4px 0 10px 2px' }}>{msg}</p> : null}

      <section className="glass card-lg" style={{ marginBottom: 12 }}>
        <div className="row-between" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>{t('dashboard.opsBoard')}</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => { const d = new Date(boardDate + 'T00:00:00'); d.setDate(d.getDate() - 1); setBoardDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); }} style={{ padding: '4px 8px', minWidth: 0 }}>&larr;</button>
            <input type="date" value={boardDate} onChange={(e) => setBoardDate(e.target.value)} style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid var(--border-soft)', background: 'var(--bg-soft)', color: 'var(--text-1)', fontSize: 13, fontWeight: 600 }} />
            <button onClick={() => { const d = new Date(boardDate + 'T00:00:00'); d.setDate(d.getDate() + 1); setBoardDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); }} style={{ padding: '4px 8px', minWidth: 0 }}>&rarr;</button>
            {!isToday && <button onClick={() => { const d = new Date(); setBoardDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); }} style={{ padding: '4px 10px', fontSize: 12 }}>{t('dashboard.today')}</button>}
          </div>
        </div>
        <p className="label" style={{ marginTop: 6, marginBottom: 0 }}>
          {/* Counts mirror the filtered list shown below — using
              resSummary.{pickups,returns}Today caused the header to
              disagree with the list (e.g. "10 returns" but 9 cards)
              because the backend summary doesn't drop already-received
              returns. */}
          {boardLabel} — {t('dashboard.pickupsLabel')}: <strong>{pickups.length}</strong> · {t('dashboard.returnsLabel')}: <strong>{returns.length}</strong>
        </p>
      </section>

      <section className="grid2">
        <div className="glass card-lg">
          <div className="label" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--brand)', marginBottom: 8 }}>{t('dashboard.pickupsCount', { count: pickups.length })}</div>
          {pickups.length === 0 ? (
            <p className="ui-muted" style={{ textAlign: 'center', padding: 20, margin: 0 }}>{t('dashboard.noPickups')}</p>
          ) : (
            <div className="stack">
              {pickups.sort((a, b) => String(a.pickupAt).localeCompare(String(b.pickupAt))).map((r) => {
                const balance = unpaidBalance(r);
                return (
                  <div
                    key={r.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openReservation(r.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReservation(r.id); } }}
                    className="row"
                    style={{ alignItems: 'center', gap: 8, cursor: 'pointer', padding: '6px 4px', borderRadius: 8, transition: 'background 0.15s' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-soft)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ minWidth: 70, fontWeight: 600, fontSize: 13, color: 'var(--text-1)' }}>{fmtWallClockTime(r.pickupAt)}</span>
                    <span style={{ flex: 1 }}>
                      #{r.reservationNumber} · {r.customer?.firstName} {r.customer?.lastName}{r.vehicle ? ` · ${r.vehicle.year || ''} ${r.vehicle.make || ''} ${r.vehicle.model || ''}`.trim() : ''}
                      {balance > 0 ? <span className="status-chip warn" style={{ marginLeft: 6 }}>{t('dashboard.unpaid', { amount: moneyShort(balance) })}</span> : null}
                    </span>
                    <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                      <button onClick={(e) => { e.stopPropagation(); startCheckout(r.id); }}>{t('dashboard.startCheckout')}</button>
                      <button onClick={(e) => { e.stopPropagation(); requestCustomerInfo(r.id); }}>{t('dashboard.requestInfo')}</button>
                      <button onClick={(e) => { e.stopPropagation(); markNoShow(r.id); }}>{t('dashboard.noShow')}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="glass card-lg">
          <div className="label" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--teal-tx)', marginBottom: 8 }}>{t('dashboard.returnsCount', { count: returns.length })}</div>
          {returns.length === 0 ? (
            <p className="ui-muted" style={{ textAlign: 'center', padding: 20, margin: 0 }}>{t('dashboard.noReturns')}</p>
          ) : (
            <div className="stack">
              {returns.sort((a, b) => String(a.returnAt).localeCompare(String(b.returnAt))).map((r) => {
                const balance = unpaidBalance(r);
                // Already-returned rentals (CHECKED_IN / CHECKED_IN_UNPAID)
                // shouldn't keep prompting the agent for check-in. Show a
                // status badge in place of the action button so the row stays
                // visible (the count still includes them) but the actionable
                // affordance only renders for rentals that still need work.
                const alreadyCheckedIn = ['CHECKED_IN', 'CHECKED_IN_UNPAID'].includes(r.status);
                return (
                  <div
                    key={`ret-${r.id}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => openReservation(r.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReservation(r.id); } }}
                    className="row"
                    style={{ alignItems: 'center', gap: 8, cursor: 'pointer', padding: '6px 4px', borderRadius: 8, transition: 'background 0.15s' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-soft)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ minWidth: 70, fontWeight: 600, fontSize: 13, color: 'var(--text-1)' }}>{fmtWallClockTime(r.returnAt)}</span>
                    <span style={{ flex: 1 }}>
                      #{r.reservationNumber} · {r.customer?.firstName} {r.customer?.lastName}{r.vehicle ? ` · ${r.vehicle.year || ''} ${r.vehicle.make || ''} ${r.vehicle.model || ''}`.trim() : ''}
                      {balance > 0 ? <span className="status-chip warn" style={{ marginLeft: 6 }}>{t('dashboard.unpaid', { amount: moneyShort(balance) })}</span> : null}
                    </span>
                    <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                      {alreadyCheckedIn ? (
                        <span className="status-chip good">
                          {t('dashboard.checkedIn')}
                        </span>
                      ) : (
                        <button onClick={(e) => { e.stopPropagation(); startCheckin(r.id); }}>{t('dashboard.startCheckin')}</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Market Intelligence — between Pickups/Returns and Operations
          Timeline. Per-tenant gated: hidden if the role doesn't have
          marketIntelligence access OR the tenant flag is off. The component
          itself returns null in those cases. Sales Status section was
          removed 2026-06-07 — same data lives in the Reports module now. */}
      <MarketIntelligenceCard me={me} token={token} />

      <section className="glass card-lg">
        <h3>{t('dashboard.operationsTimeline')}</h3>
        <div className="stack">
          {timeline.map((r) => <div key={r.id} className="row"><span>{fmtTimeline(timelineTs(r))}</span><span>{t('dashboard.reservationLine', { number: r.reservationNumber, status: r.status })}</span></div>)}
        </div>
      </section>
    </AppShell>
  );
}
