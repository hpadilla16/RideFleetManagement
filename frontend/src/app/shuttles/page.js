'use client';

/**
 * Staff Shuttle Monitor — /shuttles (2026-08-24, approved mockup Screen 1).
 *
 * All the tenant's shuttle-configured vehicles on one live map, with the open
 * request queue of each location beside them. Reads ONLY the staff endpoint
 * /api/shuttle-monitor/positions (house-stored positions — Redis + telematics
 * fallback; never a provider call from the browser).
 *
 * HONESTY RULES carried over from the mockup: requests are queued per
 * LOCATION, not dispatched per bus, so the "assignment" block is the open
 * queue of the location that shuttle serves. Freshness pills reuse the exact
 * backend thresholds (LIVE <90s · last known 90s–4min · offline >4min). No
 * ETA anywhere.
 *
 * Map = Google Maps via the SAME shared loader/key as the public tracker
 * (lib/google-maps-loader). No key → the panel still works, the map area
 * explains itself.
 *
 * PHASE 2 (2026-08-24, approved mockup Screens 4+5): a "Zones & Routes" tab
 * (ZonesRoutesTab — ADMIN-gated server-side) and the geofence alert feed in
 * the side panel + a toast for alerts newer than the previous poll. The feed
 * rides the SAME 12s cycle as positions and is best-effort: a feed failure
 * never takes the monitor down.
 *
 * PHASE 3 STAFF UI (2026-08-25, approved mockup Screens 10 + 17c):
 *  - waiting-customer pins — initials dots for customers actively SHARING
 *    their location (Redis-TTL fix in waitingCustomers[]); non-sharers stay
 *    list-only. Same 12s cycle, no extra endpoint.
 *  - the Waiting side-panel list with the ON_DEMAND assignment picker
 *    (POST/DELETE /api/shuttle-requests/:id/assign).
 *  - a "Driver shifts" tab (DriverShiftsTab): mint/revoke/notify the
 *    per-shift driver links; the tokenized link is shown ONCE at mint.
 *  - REQUEST_NO_SHOW alerts render in the existing feed/toast with a
 *    "View requests" deep-link into the queue.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';
import { MAPS_KEY, loadGoogleMaps } from '../../lib/google-maps-loader';
import { AlertFeed, AlertToast } from './AlertFeed';
import { ZonesRoutesTab } from './ZonesRoutesTab';
import { WaitingPanel } from './WaitingPanel';
import { DriverShiftsTab } from './DriverShiftsTab';
import { alertsNewerThan, newestAlertTs } from '../../lib/shuttle-alert-feed';
import { initialsOf, sharingPins } from '../../lib/shuttle-staff';

const POLL_MS = 12_000; // same cadence as the customer tracker page
const ALERT_FEED_LIMIT = 20; // mockup Screen 5: "last ~20, today-ish"
const TOAST_MS = 8_000;

const STATUS_META = {
  LIVE: { label: 'live', color: '#1a7f37', chipClass: 'good' },
  AGING: { label: 'last known', color: '#b45309', chipClass: 'warn' },
  OFFLINE: { label: 'offline', color: '#8a819f', chipClass: '' },
  NO_DEVICE: { label: 'no device', color: '#8a819f', chipClass: '' },
};

function ageText(seconds) {
  if (seconds == null) return null;
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

const markerDiv = (n, color) => {
  const el = document.createElement('div');
  el.style.cssText = 'width:32px;height:32px;display:flex;align-items:center;justify-content:center;'
    + `background:${color};border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.35);`
    + 'color:#fff;font-size:14px;font-weight:800';
  el.textContent = String(n);
  return el;
};

// Customer initials dot (mockup Screen 10 `.cdot`) — deliberately smaller
// and blue-haloed so it can never be confused with a shuttle marker.
const CUST_PIN_COLOR = '#1d6ef2';
const custPinDiv = (initials) => {
  const el = document.createElement('div');
  el.style.cssText = 'width:24px;height:24px;display:flex;align-items:center;justify-content:center;'
    + `background:${CUST_PIN_COLOR};border:2.5px solid #fff;border-radius:50%;`
    + 'box-shadow:0 0 0 5px rgba(29,110,242,.22),0 1px 4px rgba(0,0,0,.3);'
    + 'color:#fff;font-size:9px;font-weight:800';
  el.textContent = String(initials);
  return el;
};

function ShuttleMonitorInner({ me, token, logout }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [data, setData] = useState(null);   // last good monitor payload
  const [error, setError] = useState('');
  const [locationId, setLocationId] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState(null); // Phase 3 (Screen 10)
  const [nowTick, setNowTick] = useState(() => Date.now());
  const payloadAtRef = useRef(Date.now());
  const [tab, setTab] = useState('monitor'); // 'monitor' | 'zones' | 'drivers'
  const [alerts, setAlerts] = useState([]);  // Phase 2 feed (mockup Screen 5)
  const [toastAlert, setToastAlert] = useState(null);
  const prevNewestAlertRef = useRef(null);   // null = first poll → never toast
  // Bumped after an assignment write so the fresh truth shows now, not in 12s.
  const [refreshNonce, setRefreshNonce] = useState(0);

  const mapRef = useRef(null);
  const mapObj = useRef(null);
  const markersRef = useRef({}); // vehicleId → AdvancedMarkerElement
  const custMarkersRef = useRef({}); // requestId → AdvancedMarkerElement (sharing customers)
  const fittedRef = useRef(false);

  // ── poll every 12s ───────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const out = await api('/api/shuttle-monitor/positions', { bypassCache: true }, token);
        if (!alive) return;
        setData(out);
        payloadAtRef.current = Date.now();
        setError('');
      } catch (e) {
        if (alive) setError(e?.message || 'Could not load shuttle positions');
      }
      // Alert feed rides the same 12s cycle — additive: a feed failure must
      // never take the position monitor down with it.
      try {
        const out = await api(`/api/shuttle-monitor/alerts?limit=${ALERT_FEED_LIMIT}`, { bypassCache: true }, token);
        const list = Array.isArray(out?.alerts) ? out.alerts : [];
        if (alive) {
          const prev = prevNewestAlertRef.current;
          const fresh = alertsNewerThan(list, prev);
          if (fresh.length) setToastAlert(fresh[0]); // newest-first from the API
          prevNewestAlertRef.current = newestAlertTs(list) ?? prev;
          setAlerts(list);
        }
      } catch { /* feed is best-effort */ }
      if (alive) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [token, refreshNonce]);

  // Toast auto-dismisses; a newer alert replaces it and restarts the clock.
  useEffect(() => {
    if (!toastAlert) return undefined;
    const timer = setTimeout(() => setToastAlert(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toastAlert]);

  // "last update Ns ago" ticks locally between polls.
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const sinceUpdate = Math.max(0, Math.floor((nowTick - payloadAtRef.current) / 1000));

  const shuttles = useMemo(() => {
    const list = Array.isArray(data?.shuttles) ? data.shuttles : [];
    return locationId ? list.filter((s) => s.locationId === locationId) : list;
  }, [data, locationId]);
  const requestsByLocation = data?.requestsByLocation || {};
  const locations = Array.isArray(data?.locations) ? data.locations : [];
  // Phase 3 (Screen 10): the waiting list mirrors the location filter.
  const waitingCustomers = useMemo(() => {
    const list = Array.isArray(data?.waitingCustomers) ? data.waitingCustomers : [];
    return locationId ? list.filter((c) => c.locationId === locationId) : list;
  }, [data, locationId]);

  const transmitting = shuttles.filter((s) => s.status === 'LIVE' || s.status === 'AGING').length;
  const noDevice = shuttles.filter((s) => s.status === 'NO_DEVICE').length;
  const anyDeviceInTenant = (data?.shuttles || []).some((s) => s.status !== 'NO_DEVICE');

  // ── map lifecycle ────────────────────────────────────────────────────────
  const custPins = useMemo(() => sharingPins(waitingCustomers), [waitingCustomers]);

  useEffect(() => {
    if (!MAPS_KEY || !mapRef.current) return;
    if (!shuttles.some((s) => s.position) && !custPins.length) return;
    let cancelled = false;
    (async () => {
      const google = await loadGoogleMaps();
      if (!google || cancelled || !mapRef.current) return;
      const { Map } = await google.maps.importLibrary('maps');
      const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
      if (cancelled || !mapRef.current) return;

      if (mapObj.current && mapObj.current.getDiv() !== mapRef.current) {
        mapObj.current = null;
        markersRef.current = {};
        custMarkersRef.current = {};
        fittedRef.current = false;
      }
      if (!mapObj.current) {
        mapObj.current = new Map(mapRef.current, {
          center: { lat: 18.4, lng: -66.0 },
          zoom: 12,
          mapId: 'DEMO_MAP_ID',
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
          gestureHandling: 'greedy',
        });
      }
      const map = mapObj.current;

      const seen = new Set();
      shuttles.forEach((s, i) => {
        if (!s.position) return;
        seen.add(s.vehicleId);
        const pos = { lat: s.position.latitude, lng: s.position.longitude };
        const color = (STATUS_META[s.status] || STATUS_META.OFFLINE).color;
        const existing = markersRef.current[s.vehicleId];
        if (existing) {
          existing.position = pos;
          existing.content = markerDiv(i + 1, color);
        } else {
          const marker = new AdvancedMarkerElement({ map, position: pos, content: markerDiv(i + 1, color), title: s.label });
          marker.addListener('click', () => setSelectedId(s.vehicleId));
          markersRef.current[s.vehicleId] = marker;
        }
      });
      // A shuttle that went OFFLINE loses its marker — a stale dot lies.
      for (const [vehicleId, marker] of Object.entries(markersRef.current)) {
        if (!seen.has(vehicleId)) {
          marker.map = null;
          delete markersRef.current[vehicleId];
        }
      }

      // Phase 3 (Screen 10): initials dots for customers actively sharing.
      // The Redis fix has a 5-min TTL — a customer who stops sharing drops
      // out of custPins on the next poll and their dot is removed here.
      const seenCustomers = new Set();
      custPins.forEach((c) => {
        seenCustomers.add(c.requestId);
        const pos = { lat: Number(c.lat), lng: Number(c.lng) };
        const existing = custMarkersRef.current[c.requestId];
        if (existing) {
          existing.position = pos;
          existing.content = custPinDiv(initialsOf(c.name));
        } else {
          const marker = new AdvancedMarkerElement({ map, position: pos, content: custPinDiv(initialsOf(c.name)), title: c.name, zIndex: 5 });
          marker.addListener('click', () => setSelectedCustomerId(c.requestId));
          custMarkersRef.current[c.requestId] = marker;
        }
      });
      for (const [requestId, marker] of Object.entries(custMarkersRef.current)) {
        if (!seenCustomers.has(requestId)) {
          marker.map = null;
          delete custMarkersRef.current[requestId];
        }
      }

      if (!fittedRef.current && (seen.size || seenCustomers.size)) {
        try {
          const bounds = new google.maps.LatLngBounds();
          shuttles.forEach((s) => { if (s.position) bounds.extend({ lat: s.position.latitude, lng: s.position.longitude }); });
          custPins.forEach((c) => bounds.extend({ lat: Number(c.lat), lng: Number(c.lng) }));
          if (seen.size + seenCustomers.size === 1) { map.setCenter(bounds.getCenter()); map.setZoom(14); } else { map.fitBounds(bounds, 60); }
          fittedRef.current = true;
        } catch { /* framing is cosmetic */ }
      }
    })();
    return () => { cancelled = true; };
    // `tab` is a dep so the map rebuilds promptly when the user returns from
    // the Zones & Routes tab (the map div remounts with a fresh ref).
  }, [shuttles, custPins, tab]);

  // Re-frame when the location filter changes.
  useEffect(() => { fittedRef.current = false; }, [locationId]);

  const focusShuttle = (s) => {
    setSelectedId(s.vehicleId);
    if (s.position && mapObj.current) {
      mapObj.current.panTo({ lat: s.position.latitude, lng: s.position.longitude });
      mapObj.current.setZoom(15);
    }
  };

  // Phase 3 (Screen 10): waiting-list row / pin click → focus the customer.
  const focusCustomer = (c) => {
    setSelectedCustomerId(c.requestId);
    if (c?.sharing && mapObj.current && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng))) {
      mapObj.current.panTo({ lat: Number(c.lat), lng: Number(c.lng) });
      mapObj.current.setZoom(16);
    }
  };

  const statusChip = (s) => {
    const meta = STATUS_META[s.status] || STATUS_META.OFFLINE;
    const age = ageText(s.ageSeconds);
    const text = s.status === 'LIVE' ? `${t('shuttleMonitor.live', 'live')} · ${age}`
      : s.status === 'AGING' ? `${t('shuttleMonitor.lastKnown', 'last known')} · ${age}`
        : s.status === 'OFFLINE' ? t('shuttleMonitor.offline', 'offline')
          : t('shuttleMonitor.noDevice', 'no device');
    return <span className={`status-chip ${meta.chipClass}`}>{text}</span>;
  };

  const loading = data == null && !error;
  const enabled = data?.enabled !== false;
  // Zones & Routes is ADMIN-gated server-side (/api/shuttle-zones); hiding
  // the tab for other staff is cosmetic — the backend is the enforcement.
  const canManageZones = ['SUPER_ADMIN', 'ADMIN'].includes(String(me?.role || '').toUpperCase());

  const tabBtnStyle = (on) => ({
    fontSize: 12.5, fontWeight: 700, padding: '9px 14px', cursor: 'pointer',
    background: 'none', border: 'none', borderRadius: 0,
    borderBottom: on ? '2px solid var(--brand, #8752FE)' : '2px solid transparent',
    color: on ? 'var(--p-700, #5a26c9)' : 'var(--text-3, #736a8b)', boxShadow: 'none',
  });

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>{t('shuttleMonitor.title', 'Shuttle Monitor')}</h2>
          {tab === 'monitor' ? (
            <>
              {data?.enabled ? (
                <>
                  <span className="status-chip good">{t('shuttleMonitor.transmitting', { defaultValue: '{{count}} transmitting', count: transmitting })}</span>
                  {noDevice ? <span className="status-chip">{t('shuttleMonitor.noDeviceCount', { defaultValue: '{{count}} no device', count: noDevice })}</span> : null}
                </>
              ) : null}
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ marginLeft: 'auto' }}>
                <option value="">{t('shuttleMonitor.allLocations', 'All my locations')}</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <span className="ui-muted" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                {t('shuttleMonitor.refreshNote', { defaultValue: '⟳ positions refresh every 12s · last update {{s}}s ago', s: sinceUpdate })}
              </span>
            </>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: 2, marginTop: 12, borderBottom: '1px solid var(--border, #e9e4f4)' }} role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'monitor'} style={tabBtnStyle(tab === 'monitor')} onClick={() => setTab('monitor')}>
            {t('shuttleMonitor.tabMonitor', 'Live map')}
          </button>
          {/* Driver shifts share the monitor's staff gate — every monitor
              viewer can mint/revoke/notify (server enforces scope). */}
          <button type="button" role="tab" aria-selected={tab === 'drivers'} style={tabBtnStyle(tab === 'drivers')} onClick={() => setTab('drivers')}>
            {t('shuttleMonitor.tabDrivers', 'Driver shifts')}
          </button>
          {canManageZones ? (
            <button type="button" role="tab" aria-selected={tab === 'zones'} style={tabBtnStyle(tab === 'zones')} onClick={() => setTab('zones')}>
              {t('shuttleMonitor.tabZones', 'Zones & Routes')}
            </button>
          ) : null}
        </div>

        {tab === 'zones' ? <ZonesRoutesTab token={token} /> : null}
        {tab === 'drivers' ? <DriverShiftsTab token={token} shuttles={data?.shuttles || []} /> : null}

        {tab === 'monitor' && error ? <p className="surface-note warn" style={{ marginTop: 10 }}>{error}</p> : null}
        {tab === 'monitor' && loading ? <p className="ui-muted" style={{ marginTop: 12 }}>{t('shuttleMonitor.loading', 'Loading shuttles…')}</p> : null}

        {/* Empty state 1: no location has the tracker on. */}
        {tab === 'monitor' && data && !enabled ? (
          <div style={{ textAlign: 'center', padding: '44px 24px' }}>
            <div style={{ fontSize: 34 }}>🚐</div>
            <h3 style={{ marginTop: 10 }}>{t('shuttleMonitor.notConfiguredTitle', 'The shuttle tracker is not turned on yet')}</h3>
            <p className="ui-muted" style={{ maxWidth: 460, margin: '8px auto 0' }}>
              {t('shuttleMonitor.notConfiguredBody', 'No location has the shuttle tracker enabled. Turn it on per location — pick the shuttle vehicles and the mode — in the location settings.')}
            </p>
            <button type="button" style={{ marginTop: 14 }} onClick={() => router.push('/settings?tab=locations')}>
              {t('shuttleMonitor.openSettings', 'Shuttle settings')}
            </button>
          </div>
        ) : null}

        {/* Empty state 2: tracker ON but nothing can transmit. */}
        {tab === 'monitor' && data && enabled && !anyDeviceInTenant ? (
          <div style={{ textAlign: 'center', padding: '44px 24px' }}>
            <div style={{ fontSize: 34 }}>🛰️</div>
            <h3 style={{ marginTop: 10 }}>{t('shuttleMonitor.noDevicesTitle', 'Shuttle is on, but no vehicle is transmitting')}</h3>
            <p className="ui-muted" style={{ maxWidth: 520, margin: '8px auto 0' }}>
              {t('shuttleMonitor.noDevicesBody', 'The shuttle tracker is enabled, but none of the selected shuttle vehicles has a GPS device mapped — so there is nothing to draw yet. Map a device in the GPS connector, or check the vehicle selection in the location’s shuttle settings.')}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
              <button type="button" onClick={() => router.push('/settings?tab=telematics')}>{t('shuttleMonitor.openConnector', 'Open GPS connector')}</button>
              <button type="button" className="button-subtle" onClick={() => router.push('/settings?tab=telematics')}>{t('shuttleMonitor.openSettings', 'Shuttle settings')}</button>
            </div>
          </div>
        ) : null}

        {tab === 'monitor' && data && enabled && anyDeviceInTenant ? (
          <div style={{ display: 'flex', gap: 14, marginTop: 14, flexWrap: 'wrap' }}>
            {/* map */}
            <div style={{ flex: '1 1 460px', minHeight: 480, position: 'relative', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border-2, #d9d2ea)', background: 'var(--surface-2, #f7f5fd)' }}>
              {MAPS_KEY ? (
                <div ref={mapRef} style={{ position: 'absolute', inset: 0 }} />
              ) : (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
                  <p className="ui-muted">{t('shuttleMonitor.noMapsKey', 'No Google Maps key is configured for this build — positions are listed on the right.')}</p>
                </div>
              )}
              <div style={{ position: 'absolute', left: 10, bottom: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span className="status-chip good">{t('shuttleMonitor.legendLive', 'live < 90s')}</span>
                <span className="status-chip warn">{t('shuttleMonitor.legendAging', 'last known 90s–4m')}</span>
                <span className="status-chip">{t('shuttleMonitor.legendOffline', 'offline / no device')}</span>
                <span className="status-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: '#1d6ef2', display: 'inline-block' }} />
                  {t('shuttleMonitor.legendCustomer', 'customer sharing location')}
                </span>
              </div>
            </div>

            {/* side panel */}
            <aside style={{ flex: '0 1 330px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span className="label">{t('shuttleMonitor.configured', { defaultValue: 'Shuttles · {{count}} configured', count: shuttles.length })}</span>
              {shuttles.length === 0 ? (
                <p className="ui-muted">{t('shuttleMonitor.noneAtLocation', 'No shuttle vehicles at this location.')}</p>
              ) : null}
              {shuttles.map((s, i) => {
                const q = requestsByLocation[s.locationId];
                const selected = selectedId === s.vehicleId;
                const meta = STATUS_META[s.status] || STATUS_META.OFFLINE;
                return (
                  <div
                    key={s.vehicleId}
                    className="glass card"
                    style={{ padding: 12, cursor: s.position ? 'pointer' : 'default', border: selected ? '1px solid var(--brand, #8752FE)' : undefined }}
                    onClick={() => focusShuttle(s)}
                  >
                    <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                      <span style={{ width: 24, height: 24, borderRadius: '50%', background: meta.color, color: '#fff', fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>{i + 1}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.3 }}>{s.label}</div>
                        <div className="ui-muted" style={{ fontSize: 12 }}>
                          {[s.plate, s.locationName].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      {statusChip(s)}
                      {s.status === 'LIVE' && Number.isFinite(Number(s.position?.speedMph)) ? (
                        <span className="status-chip">{Math.round(Number(s.position.speedMph))} mph</span>
                      ) : null}
                      <span className="status-chip">
                        {s.mode === 'NON_STOP'
                          ? t('shuttleMonitor.modeLoop', { defaultValue: 'non-stop · every {{n}} min', n: s.headwayMinutes || 10 })
                          : t('shuttleMonitor.modeOnDemand', 'on demand')}
                      </span>
                    </div>
                    <div className="surface-note" style={{ marginTop: 9, fontSize: 12.5, lineHeight: 1.5 }}>
                      {q?.openCount ? (
                        <>
                          <strong>{t('shuttleMonitor.waitingAt', { defaultValue: '{{count}} waiting at {{loc}}', count: q.openCount, loc: s.locationName })}</strong>
                          {q.oldest ? (
                            <> — {t('shuttleMonitor.oldest', 'oldest:')} <strong>{q.oldest.customerName}</strong> ×{q.oldest.partySize}
                              {q.oldest.pickupNote ? ` · ${q.oldest.pickupNote}` : ''}
                              {q.oldest.waitingMinutes != null ? ` · ${q.oldest.waitingMinutes} min` : ''}
                            </>
                          ) : null}
                          {q.next?.length ? (
                            <div className="ui-muted">{t('shuttleMonitor.then', 'then:')} {q.next.map((n) => `${n.customerName} ×${n.partySize}`).join(' · ')}</div>
                          ) : null}
                        </>
                      ) : s.status === 'NO_DEVICE' ? (
                        <span className="ui-muted">{t('shuttleMonitor.noDeviceNote', 'This unit has no GPS device mapped. It never appears on the map or the customer page.')}</span>
                      ) : (
                        <span className="ui-muted">
                          {s.mode === 'NON_STOP'
                            ? t('shuttleMonitor.loopNote', { defaultValue: 'No open requests — loop mode. Customers see “the shuttle passes about every {{n}} minutes.”', n: s.headwayMinutes || 10 })
                            : t('shuttleMonitor.noOpen', 'No open requests right now.')}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
                      <button
                        type="button"
                        style={{ fontSize: 12 }}
                        onClick={(e) => { e.stopPropagation(); router.push(`/shuttle?locationId=${encodeURIComponent(s.locationId || '')}`); }}
                      >
                        {t('shuttleMonitor.viewRequests', 'View requests')}
                      </button>
                      {s.status === 'NO_DEVICE' ? (
                        <button type="button" className="button-subtle" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); router.push('/settings?tab=telematics'); }}>
                          {t('shuttleMonitor.openConnector', 'Open GPS connector')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}

              {/* Phase 3 waiting list (mockup Screen 10) — same payload/cycle. */}
              <div style={{ marginTop: 4 }}>
                <WaitingPanel
                  customers={waitingCustomers}
                  shuttles={shuttles}
                  token={token}
                  selectedRequestId={selectedCustomerId}
                  onFocus={focusCustomer}
                  onViewRequests={(c) => router.push(`/shuttle?locationId=${encodeURIComponent(c.locationId || '')}`)}
                  onChanged={() => setRefreshNonce((n) => n + 1)}
                />
              </div>

              {/* Phase 2 alert feed (mockup Screen 5) — same 12s poll cycle. */}
              <div style={{ marginTop: 4 }}>
                <AlertFeed
                  alerts={alerts}
                  onSelect={(a) => {
                    const s = shuttles.find((x) => x.vehicleId === a?.vehicle?.id);
                    if (s?.position) focusShuttle(s);
                  }}
                  onOpenRequests={(a) => {
                    const loc = a?.zone?.locationId || '';
                    router.push(loc ? `/shuttle?locationId=${encodeURIComponent(loc)}` : '/shuttle');
                  }}
                />
              </div>
            </aside>
          </div>
        ) : null}

        {toastAlert ? (
          <AlertToast
            alert={toastAlert}
            onClose={() => setToastAlert(null)}
            onShow={() => {
              setTab('monitor');
              const s = shuttles.find((x) => x.vehicleId === toastAlert?.vehicle?.id);
              if (s?.position) focusShuttle(s);
              setToastAlert(null);
            }}
          />
        ) : null}
      </section>
    </AppShell>
  );
}

export default function ShuttleMonitorPage() {
  return (
    <AuthGate>
      {({ me, token, logout }) => <ShuttleMonitorInner me={me} token={token} logout={logout} />}
    </AuthGate>
  );
}
