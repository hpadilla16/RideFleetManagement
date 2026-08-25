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
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';
import { MAPS_KEY, loadGoogleMaps } from '../../lib/google-maps-loader';

const POLL_MS = 12_000; // same cadence as the customer tracker page

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

function ShuttleMonitorInner({ me, token, logout }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [data, setData] = useState(null);   // last good monitor payload
  const [error, setError] = useState('');
  const [locationId, setLocationId] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const payloadAtRef = useRef(Date.now());

  const mapRef = useRef(null);
  const mapObj = useRef(null);
  const markersRef = useRef({}); // vehicleId → AdvancedMarkerElement
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
      if (alive) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [token]);

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

  const transmitting = shuttles.filter((s) => s.status === 'LIVE' || s.status === 'AGING').length;
  const noDevice = shuttles.filter((s) => s.status === 'NO_DEVICE').length;
  const anyDeviceInTenant = (data?.shuttles || []).some((s) => s.status !== 'NO_DEVICE');

  // ── map lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!MAPS_KEY || !mapRef.current || !shuttles.some((s) => s.position)) return;
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
      if (!fittedRef.current && seen.size) {
        try {
          const bounds = new google.maps.LatLngBounds();
          shuttles.forEach((s) => { if (s.position) bounds.extend({ lat: s.position.latitude, lng: s.position.longitude }); });
          if (seen.size === 1) { map.setCenter(bounds.getCenter()); map.setZoom(14); } else { map.fitBounds(bounds, 60); }
          fittedRef.current = true;
        } catch { /* framing is cosmetic */ }
      }
    })();
    return () => { cancelled = true; };
  }, [shuttles]);

  // Re-frame when the location filter changes.
  useEffect(() => { fittedRef.current = false; }, [locationId]);

  const focusShuttle = (s) => {
    setSelectedId(s.vehicleId);
    if (s.position && mapObj.current) {
      mapObj.current.panTo({ lat: s.position.latitude, lng: s.position.longitude });
      mapObj.current.setZoom(15);
    }
  };

  const statusChip = (s) => {
    const meta = STATUS_META[s.status] || STATUS_META.OFFLINE;
    const age = ageText(s.ageSeconds);
    const text = s.status === 'LIVE' ? `live · ${age}`
      : s.status === 'AGING' ? `${t('shuttleMonitor.lastKnown', 'last known')} · ${age}`
        : s.status === 'OFFLINE' ? t('shuttleMonitor.offline', 'offline')
          : t('shuttleMonitor.noDevice', 'no device');
    return <span className={`status-chip ${meta.chipClass}`}>{text}</span>;
  };

  const loading = data == null && !error;
  const enabled = data?.enabled !== false;

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>{t('shuttleMonitor.title', 'Shuttle Monitor')}</h2>
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
        </div>

        {error ? <p className="surface-note warn" style={{ marginTop: 10 }}>{error}</p> : null}
        {loading ? <p className="ui-muted" style={{ marginTop: 12 }}>{t('shuttleMonitor.loading', 'Loading shuttles…')}</p> : null}

        {/* Empty state 1: no location has the tracker on. */}
        {data && !enabled ? (
          <div style={{ textAlign: 'center', padding: '44px 24px' }}>
            <div style={{ fontSize: 34 }}>🚐</div>
            <h3 style={{ marginTop: 10 }}>{t('shuttleMonitor.notConfiguredTitle', 'The shuttle tracker is not turned on yet')}</h3>
            <p className="ui-muted" style={{ maxWidth: 460, margin: '8px auto 0' }}>
              {t('shuttleMonitor.notConfiguredBody', 'No location has the shuttle tracker enabled. Turn it on per location — pick the shuttle vehicles and the mode — in the location settings.')}
            </p>
            <button type="button" style={{ marginTop: 14 }} onClick={() => router.push('/settings')}>
              {t('shuttleMonitor.openSettings', 'Shuttle settings')}
            </button>
          </div>
        ) : null}

        {/* Empty state 2: tracker ON but nothing can transmit. */}
        {data && enabled && !anyDeviceInTenant ? (
          <div style={{ textAlign: 'center', padding: '44px 24px' }}>
            <div style={{ fontSize: 34 }}>🛰️</div>
            <h3 style={{ marginTop: 10 }}>{t('shuttleMonitor.noDevicesTitle', 'Shuttle is on, but no vehicle is transmitting')}</h3>
            <p className="ui-muted" style={{ maxWidth: 520, margin: '8px auto 0' }}>
              {t('shuttleMonitor.noDevicesBody', 'The shuttle tracker is enabled, but none of the selected shuttle vehicles has a GPS device mapped — so there is nothing to draw yet. Map a device in the GPS connector, or check the vehicle selection in the location’s shuttle settings.')}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
              <button type="button" onClick={() => router.push('/settings')}>{t('shuttleMonitor.openConnector', 'Open GPS connector')}</button>
              <button type="button" className="button-subtle" onClick={() => router.push('/settings')}>{t('shuttleMonitor.openSettings', 'Shuttle settings')}</button>
            </div>
          </div>
        ) : null}

        {data && enabled && anyDeviceInTenant ? (
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
                        <button type="button" className="button-subtle" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); router.push('/settings'); }}>
                          {t('shuttleMonitor.openConnector', 'Open GPS connector')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </aside>
          </div>
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
