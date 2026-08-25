'use client';

/**
 * Zones & Routes tab inside the Shuttle Monitor (Phase 2, approved mockup
 * Screen 4). Staff draw geofence zones (rectangle/polygon) and route
 * corridors (polyline) per location; the backend stores the record and
 * pushes ZONE geometry to the GPS provider best-effort.
 *
 * HONESTY RULES carried from the mockup + backend contract:
 *  - providerSyncStatus is shown as-is: SYNCED (detection live), PENDING
 *    (waiting on the provider / API key — the worker retries every ~minute),
 *    ERROR (provider rejected the push; also auto-retried), UNSUPPORTED
 *    (ROUTE rows: the provider exposes no corridor alerts yet, so the route
 *    is STORE-ONLY and the UI says "off-route detection: coming soon" —
 *    never promises detection).
 *  - There is no force-resync endpoint: the ERROR chip's refresh button
 *    re-reads the list; the scheduler does the actual retrying.
 *  - Zones/routes are ADMIN-gated server-side (/api/shuttle-zones); this tab
 *    is only rendered for ADMIN/SUPER_ADMIN, but the backend is the gate.
 *
 * Map = the SAME shared Google Maps loader as the monitor + public tracker.
 * No key → the list still fully works; drawing degrades with an honest note.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/client';
import { MAPS_KEY, loadGoogleMaps } from '../../lib/google-maps-loader';

const SYNC_META = {
  SYNCED: { cls: 'chip--ok', key: 'syncSynced', fallback: 'Synced' },
  PENDING: { cls: 'chip--warn', key: 'syncPending', fallback: 'Sync pending' },
  ERROR: { cls: 'chip--danger', key: 'syncError', fallback: 'Sync error' },
  UNSUPPORTED: { cls: 'chip--neutral', key: 'syncUnsupported', fallback: 'No detection' },
};

// Mirror of the backend's ROUTE tolerance bounds (shuttle-zone-alerts.js).
const TOL_MIN = 50;
const TOL_MAX = 5000;
const TOL_DEFAULT = 300;

export function SyncStatusChip({ zone }) {
  const { t } = useTranslation();
  const meta = SYNC_META[zone?.providerSyncStatus] || SYNC_META.PENDING;
  return (
    <span
      className={`chip ${meta.cls}`}
      data-testid="sync-chip"
      title={zone?.providerSyncError || undefined}
    >
      {t(`shuttleZones.${meta.key}`, meta.fallback)}
    </span>
  );
}

/** DrawingManager overlay → our geometry JSON ({type, points}). */
export function overlayToGeometry(type, overlay) {
  if (type === 'rectangle') {
    const b = overlay.getBounds();
    const ne = b.getNorthEast();
    const sw = b.getSouthWest();
    return {
      type: 'rectangle',
      points: [
        { lat: ne.lat(), lng: sw.lng() },
        { lat: ne.lat(), lng: ne.lng() },
        { lat: sw.lat(), lng: ne.lng() },
        { lat: sw.lat(), lng: sw.lng() },
      ],
    };
  }
  if (type === 'polygon' || type === 'polyline') {
    const points = overlay.getPath().getArray().map((p) => ({ lat: p.lat(), lng: p.lng() }));
    return { type: type === 'polyline' ? 'polyline' : 'polygon', points };
  }
  return null;
}

// ─── Editor (create or edit one zone/route) ─────────────────────────────────

function ZoneEditor({ token, location, zone, kind, onSaved, onCancel }) {
  const { t } = useTranslation();
  const isRoute = kind === 'ROUTE';
  const [name, setName] = useState(zone?.name || '');
  const [isPickupSpot, setIsPickupSpot] = useState(!!zone?.isPickupSpot);
  const [walkingDirections, setWalkingDirections] = useState(zone?.walkingDirections || '');
  const [notifyOnEnter, setNotifyOnEnter] = useState(!!zone?.notifyOnEnter);
  const [notifyOnExit, setNotifyOnExit] = useState(!!zone?.notifyOnExit);
  const [notifyOnOffRoute, setNotifyOnOffRoute] = useState(!!zone?.notifyOnOffRoute);
  const [toleranceM, setToleranceM] = useState(
    Number.isFinite(Number(zone?.toleranceM)) && zone?.toleranceM != null ? Number(zone.toleranceM) : TOL_DEFAULT
  );
  const [draftGeometry, setDraftGeometry] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const mapRef = useRef(null);
  const draftOverlayRef = useRef(null);

  // Map + DrawingManager — one instance per editor mount.
  useEffect(() => {
    if (!MAPS_KEY || !mapRef.current) return undefined;
    let cancelled = false;
    (async () => {
      const google = await loadGoogleMaps();
      if (!google || cancelled || !mapRef.current) return;
      const { Map } = await google.maps.importLibrary('maps');
      const { DrawingManager } = await google.maps.importLibrary('drawing');
      if (cancelled || !mapRef.current) return;

      const lat = Number(location?.latitude);
      const lng = Number(location?.longitude);
      const center = Number.isFinite(lat) && Number.isFinite(lng)
        ? { lat, lng }
        : { lat: 18.4, lng: -66.0 };
      const map = new Map(mapRef.current, {
        center,
        zoom: 14,
        mapId: 'DEMO_MAP_ID',
        disableDefaultUI: true,
        zoomControl: true,
        clickableIcons: false,
        gestureHandling: 'greedy',
      });

      // Existing geometry, drawn read-only; a new drawing replaces it.
      const pts = Array.isArray(zone?.geometry?.points) ? zone.geometry.points : [];
      if (pts.length) {
        const path = pts.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
        if (isRoute) {
          new google.maps.Polyline({ map, path, strokeColor: '#8752FE', strokeWeight: 3.5 });
        } else {
          new google.maps.Polygon({
            map, paths: path, strokeColor: '#0f8a68', strokeWeight: 2.5,
            fillColor: '#0f8a68', fillOpacity: 0.14,
          });
        }
        try {
          const bounds = new google.maps.LatLngBounds();
          path.forEach((p) => bounds.extend(p));
          map.fitBounds(bounds, 48);
        } catch { /* framing is cosmetic */ }
      }

      const dm = new DrawingManager({
        map,
        drawingControl: true,
        drawingControlOptions: {
          position: google.maps.ControlPosition.TOP_CENTER,
          drawingModes: isRoute ? ['polyline'] : ['rectangle', 'polygon'],
        },
        polygonOptions: { strokeColor: '#0f8a68', fillColor: '#0f8a68', fillOpacity: 0.14 },
        rectangleOptions: { strokeColor: '#0f8a68', fillColor: '#0f8a68', fillOpacity: 0.14 },
        polylineOptions: { strokeColor: '#8752FE', strokeWeight: 3.5 },
      });
      google.maps.event.addListener(dm, 'overlaycomplete', (e) => {
        const g = overlayToGeometry(e.type, e.overlay);
        if (!g) { e.overlay.setMap(null); return; }
        if (draftOverlayRef.current) draftOverlayRef.current.setMap(null);
        draftOverlayRef.current = e.overlay;
        dm.setDrawingMode(null);
        setDraftGeometry(g);
      });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    const nm = name.trim();
    if (!nm) { setErr(t('shuttleZones.nameRequired', 'Name is required.')); return; }
    if (!zone && !draftGeometry) {
      setErr(t('shuttleZones.geometryRequired', 'Draw the shape on the map before saving.'));
      return;
    }
    const body = {
      name: nm,
      kind,
      ...(isRoute
        ? { toleranceM, notifyOnOffRoute }
        : {
          isPickupSpot,
          walkingDirections: isPickupSpot ? walkingDirections : '',
          notifyOnEnter,
          notifyOnExit,
        }),
      ...(draftGeometry ? { geometry: draftGeometry } : {}),
    };
    setBusy(true);
    setErr('');
    try {
      const out = zone
        ? await api(`/api/shuttle-zones/${zone.id}`, { method: 'PUT', body }, token)
        : await api('/api/shuttle-zones', { method: 'POST', body: { ...body, locationId: location.id } }, token);
      onSaved(out?.zone);
    } catch (e) {
      setErr(e?.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass card" style={{ padding: 14, marginTop: 12 }} data-testid="zone-editor">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>
          {zone
            ? t('shuttleZones.editTitle', { defaultValue: 'Edit — {{name}}', name: zone.name })
            : isRoute
              ? t('shuttleZones.newRouteTitle', 'New route')
              : t('shuttleZones.newZoneTitle', 'New zone')}
        </strong>
        <span className={`chip ${isRoute ? 'chip--brand' : 'chip--neutral'}`}>
          {isRoute ? t('shuttleZones.kindRoute', 'Route') : t('shuttleZones.kindZone', 'Zone')}
        </span>
        {isRoute ? (
          <span className="badge-building">{t('shuttleZones.routeComingSoon', 'Off-route detection: coming soon')}</span>
        ) : null}
      </div>

      {/* Draw canvas */}
      {MAPS_KEY ? (
        <>
          <div
            ref={mapRef}
            style={{ marginTop: 10, height: 320, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border, #e9e4f4)' }}
          />
          <p className="ui-muted" style={{ fontSize: 12, marginTop: 6 }}>
            {isRoute
              ? t('shuttleZones.drawHintRoute', 'Draw the route as a line on the map — click points, double-click to finish.')
              : t('shuttleZones.drawHintZone', 'Draw the zone on the map — rectangle or polygon.')}
            {draftGeometry ? ` ${t('shuttleZones.shapeCaptured', { defaultValue: '✓ shape captured ({{n}} points)', n: draftGeometry.points.length })}` : ''}
          </p>
        </>
      ) : (
        <p className="surface-note warn" style={{ marginTop: 10 }}>
          {t('shuttleZones.noMapsKeyDraw', 'No Google Maps key is configured for this build — shapes cannot be drawn. Existing zones can still be renamed and toggled.')}
        </p>
      )}

      {/* Form */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12 }}>
          <span className="label">{t('shuttleZones.nameLabel', 'Name')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            style={{ minWidth: 200 }}
            aria-label={t('shuttleZones.nameLabel', 'Name')}
          />
        </label>

        {isRoute ? (
          <>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, minWidth: 220 }}>
              <span className="label">
                {t('shuttleZones.toleranceLabel', { defaultValue: 'Off-route tolerance: {{m}} m', m: toleranceM })}
              </span>
              <input
                type="range"
                min={TOL_MIN}
                max={TOL_MAX}
                step={50}
                value={toleranceM}
                onChange={(e) => setToleranceM(Number(e.target.value))}
                aria-label={t('shuttleZones.toleranceAria', 'Off-route tolerance (meters)')}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={notifyOnOffRoute}
                onChange={(e) => setNotifyOnOffRoute(e.target.checked)}
              />
              {t('shuttleZones.notifyOffRoute', 'notify when off-route')}
            </label>
          </>
        ) : (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={isPickupSpot}
                onChange={(e) => setIsPickupSpot(e.target.checked)}
              />
              {t('shuttleZones.pickupSpot', 'Pickup spot')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={notifyOnEnter}
                onChange={(e) => setNotifyOnEnter(e.target.checked)}
              />
              {t('shuttleZones.notifyEnter', 'notify on enter')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={notifyOnExit}
                onChange={(e) => setNotifyOnExit(e.target.checked)}
              />
              {t('shuttleZones.notifyExit', 'notify on exit')}
            </label>
          </>
        )}
      </div>

      {!isRoute && isPickupSpot ? (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, marginTop: 10 }}>
          <span className="label">{t('shuttleZones.walkingDirections', 'Walking directions (shown to the customer on arrival)')}</span>
          <textarea
            value={walkingDirections}
            onChange={(e) => setWalkingDirections(e.target.value)}
            maxLength={500}
            rows={3}
            aria-label={t('shuttleZones.walkingDirections', 'Walking directions (shown to the customer on arrival)')}
          />
        </label>
      ) : null}

      {isRoute ? (
        <p className="ui-muted" style={{ fontSize: 12, marginTop: 8 }}>
          {t('shuttleZones.routeUnsupportedNote', 'The GPS provider does not expose route-corridor alerts yet — this route is stored, but no off-route detection runs.')}
        </p>
      ) : null}

      {err ? <p className="surface-note warn" style={{ marginTop: 10 }}>{err}</p> : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" onClick={save} disabled={busy || (!zone && !draftGeometry)}>
          {t('shuttleZones.save', 'Save')}
        </button>
        <button type="button" className="button-subtle" onClick={onCancel} disabled={busy}>
          {t('shuttleZones.cancel', 'Cancel')}
        </button>
      </div>
    </div>
  );
}

// ─── Recipients mini-panel ("Who gets alerted", per location) ───────────────

function RecipientsPanel({ token, locationId }) {
  const { t } = useTranslation();
  const [recipients, setRecipients] = useState(null); // null = loading
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '', email_on: true, sms_on: false });

  useEffect(() => {
    let alive = true;
    setRecipients(null);
    setErr('');
    if (!locationId) return undefined;
    api(`/api/shuttle-zones/recipients?locationId=${encodeURIComponent(locationId)}`, { bypassCache: true }, token)
      .then((out) => { if (alive) setRecipients(Array.isArray(out?.recipients) ? out.recipients : []); })
      .catch((e) => { if (alive) { setRecipients([]); setErr(e?.message || 'Could not load recipients'); } });
    return () => { alive = false; };
  }, [locationId, token]);

  const saveList = async (list) => {
    setBusy(true);
    setErr('');
    try {
      const out = await api('/api/shuttle-zones/recipients', {
        method: 'PUT',
        body: { locationId, recipients: list },
      }, token);
      setRecipients(Array.isArray(out?.recipients) ? out.recipients : []);
      return true;
    } catch (e) {
      setErr(e?.message || 'Could not save recipients');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const email = form.email.trim();
    const phone = form.phone.trim();
    const channels = [
      ...(form.email_on && email ? ['EMAIL'] : []),
      ...(form.sms_on && phone ? ['SMS'] : []),
    ];
    if (!channels.length) {
      setErr(t('shuttleZones.recipientNeedsChannel', 'Pick at least one channel that has a matching contact (email for EMAIL, phone for SMS).'));
      return;
    }
    const next = [...(recipients || []), { name: form.name.trim() || null, email: email || null, phone: phone || null, channels }];
    if (await saveList(next)) setForm({ name: '', email: '', phone: '', email_on: true, sms_on: false });
  };

  const remove = (idx) => saveList((recipients || []).filter((_, i) => i !== idx));

  return (
    <div className="glass card" style={{ padding: 14 }} data-testid="recipients-panel">
      <span className="label">{t('shuttleZones.recipientsTitle', 'Who gets alerted')}</span>
      {recipients == null ? (
        <p className="ui-muted" style={{ fontSize: 12, marginTop: 6 }}>{t('shuttleZones.loading', 'Loading…')}</p>
      ) : recipients.length === 0 ? (
        <p className="ui-muted" style={{ fontSize: 12, marginTop: 6 }}>
          {t('shuttleZones.recipientsEmpty', 'No recipients yet — alerts only show in the Monitor feed.')}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 6 }}>
          {recipients.map((r, idx) => (
            <div
              key={`${r.email || ''}|${r.phone || ''}|${idx}`}
              data-testid="recipient-row"
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', fontSize: 12.5, borderBottom: '1px solid var(--border, #e9e4f4)' }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <strong>{r.name || r.email || r.phone}</strong>
                {r.name && (r.email || r.phone) ? <span className="ui-muted"> · {r.email || r.phone}</span> : null}
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, flexShrink: 0 }}>
                {(r.channels || []).map((c) => (
                  <span key={c} className="chip chip--neutral">
                    {c === 'SMS' ? t('shuttleZones.channelSms', 'SMS') : t('shuttleZones.channelEmail', 'email')}
                  </span>
                ))}
                <button
                  type="button"
                  className="button-subtle"
                  style={{ fontSize: 11 }}
                  disabled={busy}
                  onClick={() => remove(idx)}
                >
                  {t('shuttleZones.remove', 'Remove')}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
        <input
          placeholder={t('shuttleZones.recipientName', 'Name')}
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          style={{ width: 110 }}
        />
        <input
          placeholder={t('shuttleZones.recipientEmail', 'Email')}
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          style={{ width: 160 }}
        />
        <input
          placeholder={t('shuttleZones.recipientPhone', 'Phone')}
          value={form.phone}
          onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          style={{ width: 120 }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={form.email_on}
            onChange={(e) => setForm((f) => ({ ...f, email_on: e.target.checked }))}
          />
          {t('shuttleZones.channelEmail', 'email')}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={form.sms_on}
            onChange={(e) => setForm((f) => ({ ...f, sms_on: e.target.checked }))}
          />
          {t('shuttleZones.channelSms', 'SMS')}
        </label>
        <button type="button" disabled={busy} onClick={add} style={{ fontSize: 12 }}>
          {t('shuttleZones.addRecipient', 'Add')}
        </button>
      </div>
      <p className="ui-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        {t('shuttleZones.recipientsNote', 'Alerts also show in the Monitor feed.')}
      </p>
      {err ? <p className="surface-note warn" style={{ marginTop: 8 }}>{err}</p> : null}
    </div>
  );
}

// ─── The tab ────────────────────────────────────────────────────────────────

export function ZonesRoutesTab({ token }) {
  const { t } = useTranslation();
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [zones, setZones] = useState(null); // null = loading
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // { zone|null, kind }
  const [busyZoneId, setBusyZoneId] = useState(null);

  useEffect(() => {
    let alive = true;
    api('/api/locations', {}, token)
      .then((out) => {
        if (!alive) return;
        const list = Array.isArray(out) ? out : [];
        setLocations(list);
        setLocationId((cur) => cur || list[0]?.id || '');
      })
      .catch((e) => { if (alive) setError(e?.message || 'Could not load locations'); });
    return () => { alive = false; };
  }, [token]);

  const loadZones = useCallback(async () => {
    if (!locationId) return;
    try {
      const out = await api(`/api/shuttle-zones?locationId=${encodeURIComponent(locationId)}`, { bypassCache: true }, token);
      setZones(Array.isArray(out?.zones) ? out.zones : []);
      setError('');
    } catch (e) {
      setZones([]);
      setError(e?.message || 'Could not load zones');
    }
  }, [locationId, token]);

  useEffect(() => {
    setZones(null);
    setEditing(null);
    loadZones();
  }, [loadZones]);

  const location = locations.find((l) => l.id === locationId) || null;

  const patchZone = async (zone, patch) => {
    setBusyZoneId(zone.id);
    try {
      const out = await api(`/api/shuttle-zones/${zone.id}`, { method: 'PUT', body: patch }, token);
      if (out?.zone) setZones((zs) => (zs || []).map((z) => (z.id === zone.id ? out.zone : z)));
      setError('');
    } catch (e) {
      setError(e?.message || 'Update failed');
    } finally {
      setBusyZoneId(null);
    }
  };

  const deleteZone = async (zone) => {
    if (!window.confirm(t('shuttleZones.deleteConfirm', 'Delete this zone? Provider detection stops immediately.'))) return;
    setBusyZoneId(zone.id);
    try {
      await api(`/api/shuttle-zones/${zone.id}`, { method: 'DELETE' }, token);
      setZones((zs) => (zs || []).filter((z) => z.id !== zone.id));
      setEditing((cur) => (cur?.zone?.id === zone.id ? null : cur));
      setError('');
    } catch (e) {
      setError(e?.message || 'Delete failed');
    } finally {
      setBusyZoneId(null);
    }
  };

  const onSaved = (zone) => {
    setEditing(null);
    if (zone) {
      setZones((zs) => {
        const list = zs || [];
        return list.some((z) => z.id === zone.id)
          ? list.map((z) => (z.id === zone.id ? zone : z))
          : [...list, zone];
      });
    }
    loadZones();
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="label">
          {t('shuttleZones.count', { defaultValue: 'Zones & routes · {{count}}', count: (zones || []).length })}
        </span>
        <select
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          aria-label={t('shuttleZones.locationLabel', 'Location')}
        >
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            type="button"
            style={{ fontSize: 12 }}
            disabled={!locationId}
            onClick={() => setEditing({ zone: null, kind: 'ZONE' })}
          >
            {t('shuttleZones.newZone', '+ New zone')}
          </button>
          <button
            type="button"
            className="button-subtle"
            style={{ fontSize: 12 }}
            disabled={!locationId}
            onClick={() => setEditing({ zone: null, kind: 'ROUTE' })}
          >
            {t('shuttleZones.newRoute', '+ New route')}
          </button>
        </span>
      </div>

      {error ? <p className="surface-note warn" style={{ marginTop: 10 }}>{error}</p> : null}
      {zones == null && !error ? (
        <p className="ui-muted" style={{ marginTop: 12 }}>{t('shuttleZones.loading', 'Loading zones…')}</p>
      ) : null}

      <div style={{ display: 'flex', gap: 14, marginTop: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* Zone list */}
        <div style={{ flex: '1 1 460px', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {zones != null && zones.length === 0 ? (
            <p className="ui-muted">{t('shuttleZones.empty', 'No zones or routes yet for this location.')}</p>
          ) : null}
          {(zones || []).map((zone) => {
            const isRoute = zone.kind === 'ROUTE';
            const busy = busyZoneId === zone.id;
            return (
              <div key={zone.id} className="glass card" style={{ padding: 12 }} data-testid="zone-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13.5 }}>{zone.name}</strong>
                  <span className={`chip ${isRoute ? 'chip--brand' : 'chip--neutral'}`}>
                    {isRoute ? t('shuttleZones.kindRoute', 'Route') : t('shuttleZones.kindZone', 'Zone')}
                  </span>
                  {zone.isPickupSpot ? (
                    <span className="chip chip--brand">{t('shuttleZones.pickupSpot', 'Pickup spot')}</span>
                  ) : null}
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                    <SyncStatusChip zone={zone} />
                    {zone.providerSyncStatus === 'ERROR' ? (
                      <button
                        type="button"
                        className="button-subtle"
                        style={{ fontSize: 11 }}
                        title={t('shuttleZones.syncErrorHint', 'Provider sync failed — it retries automatically about every minute.')}
                        onClick={loadZones}
                      >
                        {t('shuttleZones.syncRetry', 'Refresh')}
                      </button>
                    ) : null}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {isRoute ? (
                    <>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5 }} className="ui-muted">
                        <input
                          type="checkbox"
                          checked={!!zone.notifyOnOffRoute}
                          disabled={busy}
                          onChange={(e) => patchZone(zone, { notifyOnOffRoute: e.target.checked })}
                          aria-label={t('shuttleZones.notifyOffRoute', 'notify when off-route')}
                        />
                        {t('shuttleZones.notifyOffRoute', 'notify when off-route')}
                      </label>
                      {Number.isFinite(Number(zone.toleranceM)) ? (
                        <span className="chip chip--neutral">
                          {t('shuttleZones.toleranceChip', { defaultValue: 'tolerance {{m}} m', m: zone.toleranceM })}
                        </span>
                      ) : null}
                      <span className="badge-building">{t('shuttleZones.routeComingSoon', 'Off-route detection: coming soon')}</span>
                    </>
                  ) : (
                    <>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5 }} className="ui-muted">
                        <input
                          type="checkbox"
                          checked={!!zone.notifyOnEnter}
                          disabled={busy}
                          onChange={(e) => patchZone(zone, { notifyOnEnter: e.target.checked })}
                          aria-label={t('shuttleZones.notifyEnter', 'notify on enter')}
                        />
                        {t('shuttleZones.notifyEnter', 'notify on enter')}
                      </label>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5 }} className="ui-muted">
                        <input
                          type="checkbox"
                          checked={!!zone.notifyOnExit}
                          disabled={busy}
                          onChange={(e) => patchZone(zone, { notifyOnExit: e.target.checked })}
                          aria-label={t('shuttleZones.notifyExit', 'notify on exit')}
                        />
                        {t('shuttleZones.notifyExit', 'notify on exit')}
                      </label>
                    </>
                  )}
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="button-subtle"
                      style={{ fontSize: 11.5 }}
                      disabled={busy}
                      onClick={() => setEditing({ zone, kind: zone.kind })}
                    >
                      {t('shuttleZones.edit', 'Edit')}
                    </button>
                    <button
                      type="button"
                      className="button-subtle"
                      style={{ fontSize: 11.5 }}
                      disabled={busy}
                      onClick={() => deleteZone(zone)}
                    >
                      {t('shuttleZones.delete', 'Delete')}
                    </button>
                  </span>
                </div>
              </div>
            );
          })}

          {editing ? (
            <ZoneEditor
              key={editing.zone?.id || `new-${editing.kind}`}
              token={token}
              location={location}
              zone={editing.zone}
              kind={editing.kind}
              onSaved={onSaved}
              onCancel={() => setEditing(null)}
            />
          ) : null}
        </div>

        {/* Recipients */}
        <aside style={{ flex: '0 1 340px', minWidth: 280 }}>
          {locationId ? <RecipientsPanel token={token} locationId={locationId} /> : null}
        </aside>
      </div>
    </div>
  );
}
