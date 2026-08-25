'use client';

/**
 * Driver Mode — the tokenized driver surface (Shuttle v2 Phase 3, approved
 * mockup Screens 12–15 + 17a, 2026-08-25).
 *
 * ARCHITECTURE: same as the customer tracker — plain HTTP polling (12s for
 * the shift context, 30s for notifications), no SSE, no websockets. The GET
 * itself is the demand signal that keeps the worker's fast poll armed.
 *
 * AUTH: the per-shift token in the URL is the whole identity. Every dead
 * state (expired, revoked, tracker off, vehicle rotated out) is the same
 * bare 404 → one friendly "pide uno nuevo al counter" page, and polling
 * stops (dead links never revive).
 *
 * MAP: Google Maps via the shared lib/google-maps-loader (same key wiring
 * as the tracker + monitor). Without a build-time key the page degrades to
 * the stylized pickup-spot list — roster, actions, notifications and issue
 * reports all still work.
 *
 * OWN-GPS FALLBACK (Screen 12): "Transmitir mi ubicación" arms a
 * watchPosition + ~10s POST /position loop. The server stores a fix ONLY
 * when the van has no active telematics device; accepted:false with reason
 * DEVICE_MAPPED flips the UI to an honest "GPS del vehículo activo" chip and
 * stops the loop — a phone in a pocket must never fight the real device.
 * The payload does not (yet) say up front whether the van is device-mapped
 * (contract gap) — `deviceMapped` is read tolerantly if it ever appears.
 *
 * LANGUAGE: ES-primary (drivers in PR), explicit ES | EN toggle, same
 * STRINGS pattern as TrackerClient. Sede-written data stays as written.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../../../lib/client';
import { tenantBrandName } from '../../../lib/tenant-brand';
import { MAPS_KEY, loadGoogleMaps } from '../../../lib/google-maps-loader';

const POLL_MS = 12_000;
const NOTIF_POLL_MS = 30_000;
const POSITION_POST_MS = 10_000;
const TOAST_MS = 8_000;
const LANG_KEY = 'ride-driver-lang';
const readMarksKey = (token) => `ride-driver-read:${token}`;

/** The contract's issue enum (shuttle-driver.js DRIVER_ISSUE_CATEGORIES),
 *  with the approved Screen 15 labels. Order = the mockup's grid order. */
const ISSUE_CATEGORIES = [
  { id: 'MECANICO', icon: '🔧' },
  { id: 'ACCIDENTE', icon: '🚨' },
  { id: 'TRAFICO', icon: '🚦' },
  { id: 'CLIENTE_NO_APARECE', icon: '🧍' },
  { id: 'OTRO', icon: '✏️' },
];

const STRINGS = {
  es: {
    driverMode: 'Modo Conductor',
    shuttleWord: 'Shuttle',
    loading: 'Cargando tu turno…',
    reconnecting: 'Reconectando…',
    expiredTitle: 'Este enlace expiró',
    expiredBody: 'Pide uno nuevo al counter. · This link has expired — ask the counter for a new one.',
    shiftUntil: 'Turno hasta {t}',
    modeLoop: 'Circuito continuo · pasa cada {n} min',
    modeOnDemand: 'A demanda',
    tabHome: 'Mapa',
    tabRoster: 'Recogidas',
    tabNotifs: 'Avisos',
    tabIssue: 'Problema',
    nextStop: 'Próxima parada · Next stop',
    pickupsWaiting: '🧍 {n} pickups esperando',
    sharingCount: '📍 {n} compartiendo ubicación',
    noPickups: 'Sin recogidas pendientes ahora mismo',
    seeRoster: 'Ver personas por recoger · Roster',
    pickupSpots: 'Puntos de recogida',
    noSpots: 'Esta sede no tiene puntos de recogida definidos.',
    // own-GPS states
    transmitBtn: '📡 Transmitir mi ubicación',
    transmitting: '📡 Transmitiendo tu ubicación',
    transmitStop: 'Detener',
    deviceGps: '🛰 GPS del vehículo activo',
    gpsLocating: 'Buscando tu ubicación…',
    gpsDenied: 'No pudimos acceder a tu ubicación — revisa el permiso del navegador.',
    // roster
    rosterTitle: 'Personas por recoger',
    rosterCount: 'Personas por recoger · {n}',
    rosterEmpty: 'Nadie espera el shuttle ahora mismo.',
    pax: '{n} pax',
    bagsN: '{n} maletas',
    chipWaiting: 'esperando · {m} min',
    chipSharing: '📍 compartiendo · {s}s',
    chipPicked: '✓ recogido',
    chipNoShow: '✗ no-show',
    chipYours: '⭐ asignado a ti',
    chipOtherVan: 'asignado: {name}',
    pickedBtn: 'Recogido ✓',
    noShowBtn: 'No-show',
    pickedBig: '✓ Recogido · Picked up',
    noShowBig: '✗ No se presentó · No-show',
    requestedAgo: 'solicitó hace {m} min',
    customerDot: 'El punto azul es el cliente — sigue el pin en el mapa.',
    customerSharing: 'El cliente está compartiendo su ubicación.',
    noteLabel: 'Nota del cliente',
    back: '← Volver',
    actionFailed: 'No se pudo enviar — intenta de nuevo.',
    // no-show confirm (17a)
    confirmTitle: '¿Seguro?',
    confirmBody: 'Se notificará al cliente y al counter. · The customer and the counter will both be notified.',
    confirmYes: 'Confirmar no-show',
    confirmNo: 'Cancelar',
    // notifications
    notifTitle: 'Avisos del mostrador',
    notifUnread: '{n} sin leer',
    notifEmpty: 'Sin avisos por ahora.',
    counterWord: 'Counter:',
    // issues
    issueTitle: 'Reportar un problema',
    issueSub: 'va al mostrador',
    catMECANICO: 'Mecánico',
    catACCIDENTE: 'Accidente',
    catTRAFICO: 'Tráfico / retraso',
    catCLIENTE_NO_APARECE: 'Cliente no aparece',
    catOTRO: 'Otro',
    notePlaceholder: 'Nota (opcional) · Note (optional)',
    send: 'Enviar · Send',
    sendingWord: 'Enviando…',
    issueSentTitle: 'Enviado al mostrador',
    issueSentBody: 'Sent to the counter. Te avisaremos aquí si necesitan algo más.',
    backToMap: 'Volver al mapa · Back to map',
    issueFailed: 'No se pudo enviar el reporte — intenta de nuevo.',
  },
  en: {
    driverMode: 'Driver Mode',
    shuttleWord: 'Shuttle',
    loading: 'Loading your shift…',
    reconnecting: 'Reconnecting…',
    expiredTitle: 'This link has expired',
    expiredBody: 'Ask the counter for a new one. · Pide uno nuevo al counter.',
    shiftUntil: 'Shift until {t}',
    modeLoop: 'Continuous loop · passes every {n} min',
    modeOnDemand: 'On demand',
    tabHome: 'Map',
    tabRoster: 'Pickups',
    tabNotifs: 'Alerts',
    tabIssue: 'Issue',
    nextStop: 'Next stop · Próxima parada',
    pickupsWaiting: '🧍 {n} pickups waiting',
    sharingCount: '📍 {n} sharing location',
    noPickups: 'No pending pickups right now',
    seeRoster: 'See people to pick up · Roster',
    pickupSpots: 'Pickup spots',
    noSpots: 'This location has no pickup spots defined.',
    transmitBtn: '📡 Transmit my location',
    transmitting: '📡 Transmitting your location',
    transmitStop: 'Stop',
    deviceGps: '🛰 Vehicle GPS active',
    gpsLocating: 'Finding your location…',
    gpsDenied: 'We could not access your location — check the browser permission.',
    rosterTitle: 'People to pick up',
    rosterCount: 'People to pick up · {n}',
    rosterEmpty: 'Nobody is waiting for the shuttle right now.',
    pax: '{n} pax',
    bagsN: '{n} bags',
    chipWaiting: 'waiting · {m} min',
    chipSharing: '📍 sharing · {s}s',
    chipPicked: '✓ picked up',
    chipNoShow: '✗ no-show',
    chipYours: '⭐ assigned to you',
    chipOtherVan: 'assigned: {name}',
    pickedBtn: 'Picked up ✓',
    noShowBtn: 'No-show',
    pickedBig: '✓ Picked up · Recogido',
    noShowBig: '✗ No-show · No se presentó',
    requestedAgo: 'requested {m} min ago',
    customerDot: 'The blue dot is the customer — follow the pin on the map.',
    customerSharing: 'The customer is sharing their location.',
    noteLabel: 'Customer note',
    back: '← Back',
    actionFailed: "It didn't go through — please try again.",
    confirmTitle: 'Are you sure?',
    confirmBody: 'The customer and the counter will both be notified. · Se notificará al cliente y al counter.',
    confirmYes: 'Confirm no-show',
    confirmNo: 'Cancel',
    notifTitle: 'Messages from the counter',
    notifUnread: '{n} unread',
    notifEmpty: 'No messages yet.',
    counterWord: 'Counter:',
    issueTitle: 'Report an issue',
    issueSub: 'goes to the counter',
    catMECANICO: 'Mechanical',
    catACCIDENTE: 'Accident',
    catTRAFICO: 'Traffic / delay',
    catCLIENTE_NO_APARECE: 'Customer not showing',
    catOTRO: 'Other',
    notePlaceholder: 'Note (optional) · Nota (opcional)',
    send: 'Send · Enviar',
    sendingWord: 'Sending…',
    issueSentTitle: 'Sent to the counter',
    issueSentBody: 'Enviado al mostrador. We will let you know here if they need anything else.',
    backToMap: 'Back to map · Volver al mapa',
    issueFailed: 'The report did not go through — please try again.',
  },
};

function useStrings() {
  const [lang, setLangState] = useState('es');
  useEffect(() => {
    let saved = null;
    try { saved = window.localStorage.getItem(LANG_KEY); } catch { saved = null; }
    if (saved === 'es' || saved === 'en') { setLangState(saved); return; }
    const nav = String(navigator.language || 'es').toLowerCase();
    setLangState(nav.startsWith('en') ? 'en' : 'es');
  }, []);
  const setLang = useCallback((next) => {
    setLangState(next);
    try { window.localStorage.setItem(LANG_KEY, next); } catch { /* private browsing */ }
  }, []);
  const t = useCallback((key, vars = {}) => {
    let s = STRINGS[lang][key] || STRINGS.es[key] || key;
    for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
    return s;
  }, [lang]);
  return { t, lang, setLang };
}

/** Zone geometry is the Phase-2 {type, points:[{lat,lng}]} JSON. Prisma
 *  hands it over as an object, but tolerate a string (older rows). */
function geometryPoints(geometry) {
  let g = geometry;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { return []; } }
  const pts = Array.isArray(g?.points) ? g.points : [];
  return pts.filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)))
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
}

const centroid = (pts) => ({
  lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length,
  lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length,
});

const markerDiv = (css, text) => {
  const el = document.createElement('div');
  el.style.cssText = css;
  if (text) el.textContent = text;
  return el;
};

const initials = (name) => String(name || '').trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0]).join('').toUpperCase() || '·';

/** Open = the driver still owes this person an action. */
const isOpen = (entry) => entry?.status === 'READY' || entry?.status === 'VIEWED';

export function DriverClient({ token }) {
  const { t, lang, setLang } = useStrings();
  const [state, setState] = useState(null);   // last good shift payload
  const [gone, setGone] = useState(false);    // bare 404 — dead link, stop polling
  const [stale, setStale] = useState(false);  // network error, keep last view
  const [tab, setTab] = useState('home');     // home | roster | notifs | issue
  const [detailId, setDetailId] = useState(null);      // roster → rider detail
  const [confirmId, setConfirmId] = useState(null);    // 17a dialog target
  const [actioned, setActioned] = useState({});        // id → 'picked' | 'noshow' (until the poll removes the row)
  const [actionErr, setActionErr] = useState(false);
  // own-GPS: off | locating | on | denied | device (DEVICE_MAPPED)
  const [geo, setGeo] = useState('off');
  // notifications
  const [messages, setMessages] = useState([]);
  const [readIds, setReadIds] = useState(() => new Set());
  const [toast, setToast] = useState(null);
  // issue form: pick | sending | sent
  const [issueCat, setIssueCat] = useState(null);
  const [issueNote, setIssueNote] = useState('');
  const [issuePhase, setIssuePhase] = useState('pick');
  const [issueErr, setIssueErr] = useState(false);

  const mapRef = useRef(null);
  const mapObj = useRef(null);
  const mapDrawn = useRef(false);
  const ownMarkerRef = useRef(null);
  const detailMapRef = useRef(null);
  const detailMapObj = useRef(null);
  const custMarkerRef = useRef(null);
  const geoWatchId = useRef(null);
  const ownFixRef = useRef(null);
  const postTimerRef = useRef(0);
  const transmittingRef = useRef(false);
  const seenMsgIds = useRef(null); // null until the first notifications load
  const toastTimer = useRef(0);

  const api = useCallback((path) => `${API_BASE}/api/public/driver/${encodeURIComponent(token)}${path}`, [token]);

  // ── read-marks: local, per token (the contract has no server read state) ──
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(readMarksKey(token));
      if (raw) setReadIds(new Set(JSON.parse(raw)));
    } catch { /* private browsing */ }
  }, [token]);
  const markAllRead = useCallback((msgs) => {
    setReadIds((prev) => {
      const next = new Set(prev);
      msgs.forEach((m) => next.add(m.id));
      try { window.localStorage.setItem(readMarksKey(token), JSON.stringify([...next].slice(-100))); } catch { /* best-effort */ }
      return next;
    });
  }, [token]);

  // ── shift-context polling (~12s) ─────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const res = await fetch(api(''), { cache: 'no-store' });
        if (!alive) return;
        if (res.status === 404) { setGone(true); return; } // dead links never revive
        if (!res.ok) throw new Error(String(res.status));
        const payload = await res.json();
        setState(payload);
        setStale(false);
        // Rows the server no longer lists have left the queue — drop their
        // local "just actioned" marks so the map counts stay honest.
        const ids = new Set((payload.roster || []).map((r) => r.id));
        setActioned((prev) => {
          const next = {};
          for (const [id, v] of Object.entries(prev)) if (ids.has(id)) next[id] = v;
          return next;
        });
      } catch {
        if (alive) setStale(true);
      }
      if (alive) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [api]);

  // ── notifications polling (~30s) + toast on new ──────────────────────────
  useEffect(() => {
    if (gone) return undefined;
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const res = await fetch(api('/notifications'), { cache: 'no-store' });
        if (!alive) return;
        if (res.status === 404) { setGone(true); return; }
        if (res.ok) {
          const out = await res.json();
          const msgs = Array.isArray(out?.messages) ? out.messages : [];
          if (seenMsgIds.current === null) {
            // First load: badge from read-marks, but never toast the backlog.
            seenMsgIds.current = new Set(msgs.map((m) => m.id));
          } else {
            const fresh = msgs.filter((m) => !seenMsgIds.current.has(m.id));
            fresh.forEach((m) => seenMsgIds.current.add(m.id));
            if (fresh.length) {
              setToast(fresh[0]);
              clearTimeout(toastTimer.current);
              toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
            }
          }
          setMessages(msgs);
        }
      } catch { /* next tick retries */ }
      if (alive) timer = setTimeout(poll, NOTIF_POLL_MS);
    };
    poll();
    return () => { alive = false; clearTimeout(timer); clearTimeout(toastTimer.current); };
  }, [api, gone]);

  // Opening the inbox reads everything (local read-marks only).
  useEffect(() => {
    if (tab === 'notifs' && messages.length) markAllRead(messages);
  }, [tab, messages, markAllRead]);

  // ── own-GPS transmit (Screen 12) ─────────────────────────────────────────
  const stopTransmit = useCallback((nextGeo = 'off') => {
    transmittingRef.current = false;
    clearInterval(postTimerRef.current);
    postTimerRef.current = 0;
    if (geoWatchId.current !== null) {
      navigator.geolocation?.clearWatch?.(geoWatchId.current);
      geoWatchId.current = null;
    }
    setGeo(nextGeo);
  }, []);

  const postFix = useCallback(async (fix) => {
    try {
      const res = await fetch(api('/position'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: fix.latitude, lng: fix.longitude }),
      });
      if (res.status === 404) { setGone(true); stopTransmit('off'); return; }
      if (!res.ok) return; // transient — next tick retries
      const out = await res.json();
      // The device is the truth: the server said so, the page says so too.
      if (out?.accepted === false && out?.reason === 'DEVICE_MAPPED') stopTransmit('device');
    } catch { /* next tick retries */ }
  }, [api, stopTransmit]);

  const startTransmit = useCallback(() => {
    if (!navigator.geolocation) { setGeo('denied'); return; }
    setGeo('locating');
    transmittingRef.current = true;
    geoWatchId.current = navigator.geolocation.watchPosition(
      (fix) => {
        const p = { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
        const first = !ownFixRef.current;
        ownFixRef.current = p;
        setGeo((g) => (g === 'device' ? g : 'on'));
        if (first && transmittingRef.current) postFix(p); // don't sit silent for 10s
      },
      () => stopTransmit('denied'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
    clearInterval(postTimerRef.current);
    postTimerRef.current = setInterval(() => {
      if (transmittingRef.current && ownFixRef.current) postFix(ownFixRef.current);
    }, POSITION_POST_MS);
  }, [postFix, stopTransmit]);

  useEffect(() => () => {
    clearInterval(postTimerRef.current);
    if (geoWatchId.current !== null) navigator.geolocation?.clearWatch?.(geoWatchId.current);
  }, []);

  // Tolerant read of a future contract field: nothing public says up front
  // whether the van is device-mapped; the POST's DEVICE_MAPPED echo is the
  // fallback teacher (contract gap, reported).
  const deviceMapped = state?.deviceMapped === true || geo === 'device';

  // ── roster derived data ──────────────────────────────────────────────────
  const roster = Array.isArray(state?.roster) ? state.roster : [];
  const zones = Array.isArray(state?.zones) ? state.zones : [];
  const pickupSpots = zones.filter((z) => z.isPickupSpot);
  const openRoster = roster.filter((r) => isOpen(r) && !actioned[r.id]);
  const sharingCount = openRoster.filter((r) => r.sharing).length;

  // "Next stop" = the pickup spot with the most open pickups (Screen 12).
  let nextStop = null;
  if (openRoster.length) {
    const bySpot = new Map();
    openRoster.forEach((r) => {
      const key = r.pickupSpot || '';
      bySpot.set(key, (bySpot.get(key) || 0) + 1);
    });
    let best = null;
    for (const [name, count] of bySpot.entries()) {
      if (!best || count > best.count) best = { name, count };
    }
    nextStop = best;
  }

  const unreadCount = messages.filter((m) => !readIds.has(m.id)).length;
  const detail = detailId ? roster.find((r) => r.id === detailId) || null : null;

  // ── home map: zones + numbered pickup spots (+ own dot) ──────────────────
  const zonesKey = JSON.stringify(zones.map((z) => z.id));
  useEffect(() => {
    if (!MAPS_KEY || !state || tab !== 'home' || !mapRef.current) return undefined;
    let cancelled = false;
    (async () => {
      const google = await loadGoogleMaps();
      if (!google || cancelled || !mapRef.current) return;
      const { Map } = await google.maps.importLibrary('maps');
      const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
      if (cancelled || !mapRef.current) return;
      // Container remounts on tab switches — a Map bound to a detached node
      // leaves the fresh container blank (QA 2026-08-15). Rebuild.
      if (mapObj.current && mapObj.current.getDiv() !== mapRef.current) {
        mapObj.current = null;
        mapDrawn.current = false;
        ownMarkerRef.current = null;
      }
      if (!mapObj.current) {
        const loc = state.location || {};
        const center = Number.isFinite(Number(loc.latitude)) && Number.isFinite(Number(loc.longitude))
          ? { lat: Number(loc.latitude), lng: Number(loc.longitude) }
          : (geometryPoints(zones[0]?.geometry)[0] || { lat: 18.4394, lng: -66.0021 });
        mapObj.current = new Map(mapRef.current, {
          center,
          zoom: 15,
          mapId: 'DEMO_MAP_ID',
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
          gestureHandling: 'greedy',
        });
      }
      if (!mapDrawn.current) {
        mapDrawn.current = true;
        const bounds = new google.maps.LatLngBounds();
        let spotNum = 0;
        zones.forEach((z) => {
          const pts = geometryPoints(z.geometry);
          if (!pts.length) return;
          pts.forEach((p) => bounds.extend(p));
          if (z.kind === 'ROUTE') {
            new google.maps.Polyline({
              map: mapObj.current, path: pts,
              strokeColor: '#5b21b6', strokeWeight: 3.5, strokeOpacity: 0.9,
            });
          } else {
            new google.maps.Polygon({
              map: mapObj.current, paths: pts,
              strokeColor: z.isPickupSpot ? '#0f8a68' : '#5b21b6', strokeWeight: 2,
              fillColor: z.isPickupSpot ? '#0f8a68' : '#5b21b6', fillOpacity: 0.12,
            });
          }
          if (z.isPickupSpot) {
            spotNum += 1;
            const pin = markerDiv(
              'width:30px;height:30px;display:flex;align-items:center;justify-content:center;'
              + 'background:#0f8a68;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.35);'
              + 'color:#fff;font-size:14px;font-weight:800',
              String(spotNum),
            );
            new AdvancedMarkerElement({ map: mapObj.current, position: centroid(pts), content: pin });
          }
        });
        if (!bounds.isEmpty()) mapObj.current.fitBounds(bounds, 40);
      }
      // Own dot while transmitting (local echo of what the counter sees).
      if (geo === 'on' && ownFixRef.current) {
        const ll = { lat: ownFixRef.current.latitude, lng: ownFixRef.current.longitude };
        if (!ownMarkerRef.current) {
          ownMarkerRef.current = new AdvancedMarkerElement({
            map: mapObj.current,
            position: ll,
            content: markerDiv(
              'width:36px;height:36px;display:flex;align-items:center;justify-content:center;'
              + 'background:#1a7f37;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.35);font-size:18px',
              '🚐',
            ),
          });
        } else {
          ownMarkerRef.current.position = ll;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [state?.generatedAt, tab, geo, zonesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── detail map: the sharing customer's pin (Screen 13b) ──────────────────
  useEffect(() => {
    if (!MAPS_KEY || !detail?.sharing || !Number.isFinite(detail?.lat) || !detailMapRef.current) return undefined;
    let cancelled = false;
    (async () => {
      const google = await loadGoogleMaps();
      if (!google || cancelled || !detailMapRef.current) return;
      const { Map } = await google.maps.importLibrary('maps');
      const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
      if (cancelled || !detailMapRef.current) return;
      if (detailMapObj.current && detailMapObj.current.getDiv() !== detailMapRef.current) {
        detailMapObj.current = null;
        custMarkerRef.current = null;
      }
      const ll = { lat: detail.lat, lng: detail.lng };
      if (!detailMapObj.current) {
        detailMapObj.current = new Map(detailMapRef.current, {
          center: ll,
          zoom: 17,
          mapId: 'DEMO_MAP_ID',
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
          gestureHandling: 'greedy',
        });
      }
      if (!custMarkerRef.current) {
        const pin = markerDiv(
          'width:34px;height:34px;display:flex;align-items:center;justify-content:center;'
          + 'background:#1d6ef2;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 6px rgba(29,110,242,.25);'
          + 'color:#fff;font-size:12px;font-weight:800',
          initials(detail.name),
        );
        custMarkerRef.current = new AdvancedMarkerElement({ map: detailMapObj.current, position: ll, content: pin });
      } else {
        custMarkerRef.current.position = ll;
      }
    })();
    return () => { cancelled = true; };
  }, [detail?.lat, detail?.lng, detail?.sharing, detailId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── roster actions ───────────────────────────────────────────────────────
  const markPicked = async (id) => {
    setActionErr(false);
    try {
      const res = await fetch(api(`/requests/${encodeURIComponent(id)}/picked-up`), { method: 'POST' });
      if (res.status === 404) { setGone(true); return; }
      if (!res.ok) { setActionErr(true); return; }
      setActioned((prev) => ({ ...prev, [id]: 'picked' }));
      setDetailId(null);
    } catch { setActionErr(true); }
  };

  // 17a: the dialog is a CONTRACT — no POST leaves the phone until Confirmar.
  const confirmNoShow = async (id) => {
    setActionErr(false);
    try {
      const res = await fetch(api(`/requests/${encodeURIComponent(id)}/no-show`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      });
      if (res.status === 404) { setGone(true); return; }
      if (!res.ok) { setConfirmId(null); setActionErr(true); return; }
      setActioned((prev) => ({ ...prev, [id]: 'noshow' }));
      setConfirmId(null);
      setDetailId(null);
    } catch { setConfirmId(null); setActionErr(true); }
  };

  // ── issue report (Screen 15) ─────────────────────────────────────────────
  const sendIssue = async () => {
    if (!issueCat || issuePhase === 'sending') return;
    setIssueErr(false);
    setIssuePhase('sending');
    try {
      const res = await fetch(api('/issues'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: issueCat, ...(issueNote.trim() ? { note: issueNote.trim() } : {}) }),
      });
      if (res.status === 404) { setGone(true); return; }
      if (!res.ok) { setIssuePhase('pick'); setIssueErr(true); return; }
      setIssuePhase('sent');
    } catch { setIssuePhase('pick'); setIssueErr(true); }
  };
  const resetIssue = () => { setIssueCat(null); setIssueNote(''); setIssuePhase('pick'); setIssueErr(false); setTab('home'); };

  // ── styles ───────────────────────────────────────────────────────────────
  const S = {
    page: { minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: '#f4f2f7', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#2a2333' },
    bar: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: '#2a2333', color: '#fff' },
    barTitle: { fontSize: 15.5, fontWeight: 800, lineHeight: 1.2 },
    barSub: { fontSize: 12, fontWeight: 600, color: '#cfc9dd', lineHeight: 1.3 },
    bell: { position: 'relative', marginLeft: 'auto', background: 'none', border: 'none', fontSize: 21, cursor: 'pointer', color: '#fff', minWidth: 44, minHeight: 44 },
    bellBadge: { position: 'absolute', top: 2, right: 2, minWidth: 18, height: 18, padding: '0 4px', background: '#e0483f', color: '#fff', fontSize: 11, fontWeight: 800, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' },
    langWrap: { display: 'flex', border: '1px solid #57506a', borderRadius: 999, overflow: 'hidden', flexShrink: 0 },
    langBtn: (active) => ({ minHeight: 32, padding: '4px 10px', fontSize: 11.5, fontWeight: 700, border: 'none', cursor: 'pointer', background: active ? '#5b21b6' : 'transparent', color: '#fff' }),
    map: { position: 'relative', height: '38dvh', minHeight: 220, background: '#eef0f2' },
    body: { flex: 1, overflowY: 'auto', paddingBottom: 90 },
    card: { background: '#fff', borderRadius: 14, margin: '12px 14px 0', padding: 14, boxShadow: '0 1px 6px rgba(0,0,0,.06)' },
    tag: { display: 'block', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#5b5266', fontWeight: 700, marginBottom: 3 },
    nsName: { fontSize: 17, fontWeight: 800, lineHeight: 1.3 },
    facts: { display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 9 },
    chip: (kind) => ({
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 999,
      fontSize: 12.5, fontWeight: 700,
      background: kind === 'info' ? '#eaf1fe' : kind === 'warn' ? '#fdf0e3' : kind === 'ok' ? '#e7f6ec' : kind === 'bad' ? '#fdecea' : kind === 'star' ? '#efe7ff' : '#f4f2f7',
      color: kind === 'info' ? '#173e8a' : kind === 'warn' ? '#8a4b09' : kind === 'ok' ? '#166b2f' : kind === 'bad' ? '#8f2a23' : kind === 'star' ? '#5b21b6' : '#5b5266',
    }),
    btn: (disabled) => ({ marginTop: 12, width: '100%', minHeight: 50, padding: '14px 16px', fontSize: 16, fontWeight: 800, color: '#fff', background: '#5b21b6', opacity: disabled ? 0.6 : 1, border: 'none', borderRadius: 12, cursor: disabled ? 'default' : 'pointer' }),
    okBtn: { marginTop: 12, width: '100%', minHeight: 52, fontSize: 16.5, fontWeight: 800, color: '#fff', background: '#0f8a68', border: 'none', borderRadius: 12, cursor: 'pointer' },
    ghostBtn: { marginTop: 8, width: '100%', minHeight: 48, fontSize: 15, fontWeight: 700, color: '#8f2a23', background: '#fff', border: '2px solid #e5b6b2', borderRadius: 12, cursor: 'pointer' },
    plainBtn: { marginTop: 8, width: '100%', minHeight: 44, background: 'none', border: 'none', color: '#5b5266', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
    gpsChip: (bg, color) => ({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 12px', borderRadius: 12, fontSize: 14.5, fontWeight: 700, background: bg, color }),
    stopBtn: { minHeight: 36, padding: '6px 14px', background: '#fff', color: '#173e8a', border: '1px solid #9db9ea', borderRadius: 999, fontWeight: 700, fontSize: 13, cursor: 'pointer' },
    riderRow: (dim) => ({ display: 'flex', alignItems: 'flex-start', gap: 10, background: '#fff', borderRadius: 14, margin: '10px 14px 0', padding: '12px 12px', boxShadow: '0 1px 6px rgba(0,0,0,.06)', opacity: dim ? 0.62 : 1 }),
    avatar: { width: 40, height: 40, flexShrink: 0, borderRadius: '50%', background: '#efe7ff', color: '#5b21b6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800 },
    rName: { fontSize: 16, fontWeight: 800, lineHeight: 1.25 },
    rMeta: { fontSize: 13.5, color: '#5b5266', fontWeight: 600, marginTop: 2 },
    pickBtn: { flexShrink: 0, minHeight: 46, padding: '8px 13px', fontSize: 14, fontWeight: 800, color: '#fff', background: '#0f8a68', border: 'none', borderRadius: 11, cursor: 'pointer' },
    nosBtn: { flexShrink: 0, minHeight: 46, padding: '8px 13px', fontSize: 14, fontWeight: 800, color: '#8f2a23', background: '#fff', border: '2px solid #e5b6b2', borderRadius: 11, cursor: 'pointer' },
    note: { margin: '8px 0 0', fontSize: 14.5, lineHeight: 1.5, color: '#5b5266' },
    err: { margin: '10px 14px 0', padding: '10px 12px', background: '#fdecea', color: '#8f2a23', borderRadius: 10, fontSize: 14, fontWeight: 700 },
    tabs: { position: 'fixed', bottom: 0, left: 0, right: 0, display: 'flex', background: '#fff', borderTop: '1px solid #e5e0ee', paddingBottom: 'env(safe-area-inset-bottom, 0px)', zIndex: 20 },
    tabBtn: (active) => ({ flex: 1, minHeight: 58, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 800, color: active ? '#5b21b6' : '#5b5266', position: 'relative' }),
    tabIco: { fontSize: 20 },
    tabBadge: { position: 'absolute', top: 6, right: '26%', minWidth: 17, height: 17, padding: '0 4px', background: '#e0483f', color: '#fff', fontSize: 10.5, fontWeight: 800, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' },
    center: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' },
    scrim: { position: 'fixed', inset: 0, background: 'rgba(20,14,30,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 22, zIndex: 50 },
    dlg: { background: '#fff', borderRadius: 16, padding: '22px 18px', maxWidth: 340, width: '100%', textAlign: 'center', boxShadow: '0 8px 40px rgba(0,0,0,.35)' },
    dlgTitle: { fontSize: 20, fontWeight: 800, marginTop: 6 },
    dlgBody: { fontSize: 14.5, lineHeight: 1.5, color: '#5b5266', marginTop: 8 },
    dlgConfirm: { marginTop: 16, width: '100%', minHeight: 50, fontSize: 15.5, fontWeight: 800, color: '#fff', background: '#c03428', border: 'none', borderRadius: 12, cursor: 'pointer' },
    dlgCancel: { marginTop: 8, width: '100%', minHeight: 46, fontSize: 15, fontWeight: 700, color: '#2a2333', background: '#f4f2f7', border: 'none', borderRadius: 12, cursor: 'pointer' },
    inboxRow: (unread) => ({ display: 'flex', gap: 9, alignItems: 'flex-start', background: unread ? '#faf8ff' : '#fff', border: unread ? '1.5px solid #cdb6f2' : '1px solid #eee9f5', borderRadius: 13, margin: '10px 14px 0', padding: '12px 12px', fontSize: 14.5, lineHeight: 1.45 }),
    inboxTime: { marginLeft: 'auto', flexShrink: 0, fontSize: 12, fontWeight: 700, color: '#5b5266' },
    toast: { position: 'fixed', top: 12, left: 12, right: 12, zIndex: 60, display: 'flex', gap: 9, alignItems: 'flex-start', background: '#2a2333', color: '#fff', borderRadius: 13, padding: '12px 13px', fontSize: 14, lineHeight: 1.4, boxShadow: '0 6px 24px rgba(0,0,0,.4)' },
    toastX: { marginLeft: 'auto', flexShrink: 0, background: 'none', border: 'none', color: '#cfc9dd', fontSize: 16, cursor: 'pointer', minWidth: 32, minHeight: 32 },
    catGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginTop: 4 },
    catBtn: (sel, wide) => ({
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, minHeight: 78, padding: '13px 8px',
      fontSize: 14.5, fontWeight: 800, borderRadius: 13, cursor: 'pointer',
      background: sel ? '#efe7ff' : '#fff', color: sel ? '#5b21b6' : '#2a2333',
      border: sel ? '2.5px solid #5b21b6' : '1.5px solid #ddd6ea',
      ...(wide ? { gridColumn: '1 / -1' } : {}),
    }),
    noteArea: { marginTop: 11, width: '100%', minHeight: 88, padding: '11px 12px', fontSize: 15, lineHeight: 1.45, borderRadius: 12, border: '1.5px solid #ddd6ea', background: '#fff', color: '#2a2333', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' },
    spotRow: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0', borderBottom: '1px solid #eee9f5' },
    spotNum: { width: 28, height: 28, flexShrink: 0, borderRadius: '50%', background: '#0f8a68', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800 },
    staleBadge: { position: 'absolute', top: 10, left: 10, zIndex: 5, background: '#8a8394', color: '#fff', fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 999 },
  };

  const langToggle = (
    <div style={S.langWrap} role="group" aria-label="Language">
      <button type="button" style={S.langBtn(lang === 'es')} onClick={() => setLang('es')} aria-pressed={lang === 'es'}>ES</button>
      <button type="button" style={S.langBtn(lang === 'en')} onClick={() => setLang('en')} aria-pressed={lang === 'en'}>EN</button>
    </div>
  );

  // ── dead link (bare 404 on anything) ─────────────────────────────────────
  if (gone) {
    return (
      <div style={S.page}>
        <div style={S.center}>
          <div style={{ fontSize: 44 }}>🚐</div>
          <h1 style={{ margin: '12px 0 0', fontSize: 19, fontWeight: 800 }}>{t('expiredTitle')}</h1>
          <p style={{ ...S.note, maxWidth: 420 }}>{t('expiredBody')}</p>
          <div style={{ marginTop: 16 }}>{langToggle}</div>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div style={S.page}>
        <div style={S.center}>
          <div style={{ fontSize: 44 }}>🚐</div>
          <p style={S.note} role="status">{stale ? t('reconnecting') : t('loading')}</p>
        </div>
      </div>
    );
  }

  // CONTRACT GAP: the payload carries no tenant brand name — location.name is
  // the honest second line. tenantBrandName filters a future brandName field.
  const brand = tenantBrandName({ companyName: state.brandName });
  const subLine = [brand, state.location?.name].filter(Boolean).join(' · ') || t('shuttleWord');
  const vehicleName = state.vehicle?.name || t('shuttleWord');
  const expiresLabel = state.expiresAt
    ? new Date(state.expiresAt).toLocaleTimeString(lang === 'es' ? 'es-PR' : 'en-US', { hour: 'numeric', minute: '2-digit' })
    : null;
  const headway = Number(state.headwayMinutes) >= 1 ? Number(state.headwayMinutes) : null;

  const statusChip = (r) => {
    const mark = actioned[r.id];
    if (mark === 'picked' || r.status === 'COMPLETED') return <span style={S.chip('ok')}>{t('chipPicked')}</span>;
    if (mark === 'noshow' || r.status === 'NO_SHOW') return <span style={S.chip('bad')}>{t('chipNoShow')}</span>;
    if (r.sharing) return <span style={S.chip('info')}>{t('chipSharing', { s: r.ageSeconds ?? 0 })}</span>;
    const m = r.waitingMinutes ?? 0;
    return <span style={S.chip(m >= 10 ? 'warn' : undefined)}>{t('chipWaiting', { m })}</span>;
  };

  const riderMeta = (r) => [
    t('pax', { n: r.partySize }),
    r.bags != null ? t('bagsN', { n: r.bags }) : null,
    r.pickupSpot || null,
  ].filter(Boolean).join(' · ');

  const gpsControl = deviceMapped ? (
    <div style={S.gpsChip('#e7f6ec', '#166b2f')} data-testid="gps-device">{t('deviceGps')}</div>
  ) : geo === 'on' ? (
    <div style={S.gpsChip('#eaf1fe', '#173e8a')} data-testid="gps-on">
      <span>{t('transmitting')}</span>
      <button type="button" style={S.stopBtn} onClick={() => stopTransmit('off')}>{t('transmitStop')}</button>
    </div>
  ) : geo === 'locating' ? (
    <div style={S.gpsChip('#eaf1fe', '#173e8a')} role="status">{t('gpsLocating')}</div>
  ) : geo === 'denied' ? (
    <div style={S.gpsChip('#fdecea', '#8f2a23')} role="status">⚠ {t('gpsDenied')}</div>
  ) : (
    <button type="button" style={{ ...S.btn(false), marginTop: 0 }} data-testid="gps-start" onClick={startTransmit}>
      {t('transmitBtn')}
    </button>
  );

  // ── rider detail (Screen 13b) ────────────────────────────────────────────
  const detailView = detail && (
    <>
      <div style={{ ...S.card, marginTop: 12 }}>
        <button type="button" style={{ ...S.plainBtn, marginTop: 0, textAlign: 'left', paddingLeft: 0 }} onClick={() => setDetailId(null)}>
          {t('back')}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={S.avatar}>{initials(detail.name)}</span>
          <div>
            <div style={S.rName}>{detail.name}</div>
            <div style={S.rMeta}>
              {[detail.pickupSpot, detail.waitingMinutes != null ? t('requestedAgo', { m: detail.waitingMinutes }) : null].filter(Boolean).join(' · ')}
            </div>
          </div>
        </div>
        <div style={S.facts}>
          <span style={S.chip()}>👥 {t('pax', { n: detail.partySize })}</span>
          {detail.bags != null && <span style={S.chip()}>🧳 {t('bagsN', { n: detail.bags })}</span>}
          {detail.sharing && <span style={S.chip('info')}>{t('chipSharing', { s: detail.ageSeconds ?? 0 })}</span>}
          {detail.assignedToYou && <span style={S.chip('star')}>{t('chipYours')}</span>}
        </div>
        {detail.pickupNote && (
          <div style={{ ...S.note, background: '#f4f2f7', borderRadius: 10, padding: '9px 11px' }}>
            <span style={S.tag}>{t('noteLabel')}</span>
            {detail.pickupNote}
          </div>
        )}
      </div>
      {detail.sharing && Number.isFinite(detail.lat) && MAPS_KEY ? (
        <div style={{ ...S.map, height: '30dvh', minHeight: 180, margin: '12px 14px 0', borderRadius: 14, overflow: 'hidden' }}>
          <div ref={detailMapRef} style={{ position: 'absolute', inset: 0 }} />
        </div>
      ) : detail.sharing ? (
        <p style={{ ...S.note, margin: '10px 18px 0' }} data-testid="detail-sharing-note">📍 {t('customerSharing')}</p>
      ) : null}
      {detail.sharing && MAPS_KEY && <p style={{ ...S.note, margin: '8px 18px 0' }}>{t('customerDot')}</p>}
      <div style={{ margin: '4px 14px 0' }}>
        {isOpen(detail) && !actioned[detail.id] ? (
          <>
            <button type="button" style={S.okBtn} data-testid="detail-picked" onClick={() => markPicked(detail.id)}>
              {t('pickedBig')}
            </button>
            <button type="button" style={S.ghostBtn} data-testid="detail-noshow" onClick={() => setConfirmId(detail.id)}>
              {t('noShowBig')}
            </button>
          </>
        ) : (
          <div style={{ textAlign: 'center', marginTop: 10 }}>{statusChip(detail)}</div>
        )}
      </div>
    </>
  );

  return (
    <div style={S.page}>
      {/* header (Screen 12) */}
      <div style={S.bar}>
        <span style={{ fontSize: 20 }}>🚐</span>
        <div>
          <div style={S.barTitle}>{t('driverMode')} · {vehicleName}</div>
          <div style={S.barSub}>
            {subLine}
            {state.driverName ? ` · ${state.driverName}` : ''}
          </div>
        </div>
        <button type="button" style={S.bell} aria-label={t('notifTitle')} data-testid="bell" onClick={() => setTab('notifs')}>
          🔔
          {unreadCount > 0 && <span style={S.bellBadge} data-testid="bell-badge">{unreadCount}</span>}
        </button>
        {langToggle}
      </div>

      {/* store→driver toast (Screen 14) */}
      {toast && (
        <div style={S.toast} role="status" data-testid="driver-toast">
          <span>📣</span>
          <span><b>{t('counterWord')}</b> {toast.message}</span>
          <button type="button" style={S.toastX} aria-label="✕" onClick={() => setToast(null)}>✕</button>
        </div>
      )}

      <div style={S.body}>
        {actionErr && <div style={S.err} role="alert">{t('actionFailed')}</div>}

        {/* ── HOME (Screen 12) ── */}
        {tab === 'home' && (
          <>
            {MAPS_KEY ? (
              <div style={S.map}>
                {stale && <div style={S.staleBadge} role="status">{t('reconnecting')}</div>}
                <div ref={mapRef} style={{ position: 'absolute', inset: 0 }} />
              </div>
            ) : (
              <div style={S.card} data-testid="spots-fallback">
                <span style={S.tag}>{t('pickupSpots')}</span>
                {pickupSpots.length ? pickupSpots.map((z, i) => (
                  <div key={z.id} style={{ ...S.spotRow, ...(i === pickupSpots.length - 1 ? { borderBottom: 'none' } : {}) }}>
                    <span style={S.spotNum}>{i + 1}</span>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 800 }}>{z.name}</div>
                      {z.walkingDirections && <div style={{ ...S.note, marginTop: 2 }}>{z.walkingDirections}</div>}
                    </div>
                  </div>
                )) : <p style={S.note}>{t('noSpots')}</p>}
              </div>
            )}

            <div style={S.card}>
              <span style={S.tag}>{t('nextStop')}</span>
              {nextStop ? (
                <>
                  <div style={S.nsName} data-testid="next-stop">{nextStop.name || t('rosterTitle')}</div>
                  <div style={S.facts}>
                    <span style={S.chip()}>{t('pickupsWaiting', { n: openRoster.length })}</span>
                    {sharingCount > 0 && <span style={S.chip('info')}>{t('sharingCount', { n: sharingCount })}</span>}
                  </div>
                </>
              ) : (
                <p style={{ ...S.note, marginTop: 4 }}>{t('noPickups')}</p>
              )}
              <button type="button" style={S.btn(false)} data-testid="open-roster" onClick={() => setTab('roster')}>
                {t('seeRoster')}
              </button>
            </div>

            <div style={{ ...S.card, marginBottom: 12 }}>
              {gpsControl}
              <p style={{ ...S.note, marginBottom: 0 }}>
                {headway ? t('modeLoop', { n: headway }) : t('modeOnDemand')}
                {expiresLabel ? ` · ${t('shiftUntil', { t: expiresLabel })}` : ''}
              </p>
            </div>
          </>
        )}

        {/* ── ROSTER (Screen 13) ── */}
        {tab === 'roster' && (detail ? detailView : (
          <>
            <div style={{ ...S.card, paddingBottom: 12 }}>
              <div style={S.nsName}>{t('rosterCount', { n: openRoster.length })}</div>
              {nextStop?.name && <div style={S.rMeta}>{vehicleName} · {nextStop.name}</div>}
            </div>
            {roster.length === 0 && <p style={{ ...S.note, margin: '14px 18px 0' }}>{t('rosterEmpty')}</p>}
            {roster.map((r) => {
              const done = !isOpen(r) || !!actioned[r.id];
              return (
                <div key={r.id} style={S.riderRow(done)} data-testid="rider-row">
                  <span style={S.avatar}>{initials(r.name)}</span>
                  <div
                    style={{ flex: 1, cursor: 'pointer' }}
                    role="button"
                    tabIndex={0}
                    data-testid="rider-open"
                    onClick={() => setDetailId(r.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setDetailId(r.id); }}
                  >
                    <div style={S.rName}>{r.name}</div>
                    <div style={S.rMeta}>{riderMeta(r)}</div>
                    <div style={{ marginTop: 5, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {statusChip(r)}
                      {r.assignedToYou && <span style={S.chip('star')}>{t('chipYours')}</span>}
                      {!r.assignedToYou && r.assignedVehicle?.name && (
                        <span style={S.chip()}>{t('chipOtherVan', { name: r.assignedVehicle.name })}</span>
                      )}
                    </div>
                  </div>
                  {!done && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <button type="button" style={S.pickBtn} data-testid="row-picked" onClick={() => markPicked(r.id)}>
                        {t('pickedBtn')}
                      </button>
                      <button type="button" style={S.nosBtn} data-testid="row-noshow" onClick={() => setConfirmId(r.id)}>
                        {t('noShowBtn')}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        ))}

        {/* ── NOTIFICATIONS (Screen 14) ── */}
        {tab === 'notifs' && (
          <>
            <div style={{ ...S.card, paddingBottom: 12 }}>
              <div style={S.nsName}>🔔 {t('notifTitle')}</div>
              {unreadCount > 0 && <div style={S.rMeta}>{t('notifUnread', { n: unreadCount })}</div>}
            </div>
            {messages.length === 0 && <p style={{ ...S.note, margin: '14px 18px 0' }}>{t('notifEmpty')}</p>}
            {messages.map((m) => (
              <div key={m.id} style={S.inboxRow(!readIds.has(m.id))} data-testid="inbox-row">
                <span>📣</span>
                <span><b>{t('counterWord')}</b> {m.message}</span>
                {m.at && (
                  <span style={S.inboxTime}>
                    {new Date(m.at).toLocaleTimeString(lang === 'es' ? 'es-PR' : 'en-US', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                )}
              </div>
            ))}
          </>
        )}

        {/* ── ISSUE REPORT (Screen 15) ── */}
        {tab === 'issue' && (issuePhase === 'sent' ? (
          <div style={{ ...S.card, textAlign: 'center', padding: '34px 16px 30px' }} data-testid="issue-sent">
            <div style={{ fontSize: 46 }}>✅</div>
            <div style={{ ...S.nsName, marginTop: 10 }}>{t('issueSentTitle')}</div>
            <p style={S.note}>{t('issueSentBody')}</p>
            <button type="button" style={S.btn(false)} onClick={resetIssue}>{t('backToMap')}</button>
          </div>
        ) : (
          <div style={S.card}>
            <div style={S.nsName}>⚠ {t('issueTitle')}</div>
            <div style={S.rMeta}>{vehicleName} · {t('issueSub')}</div>
            {issueErr && <div style={{ ...S.err, margin: '10px 0 0' }} role="alert">{t('issueFailed')}</div>}
            <div style={{ ...S.catGrid, marginTop: 12 }}>
              {ISSUE_CATEGORIES.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  style={S.catBtn(issueCat === c.id, i === ISSUE_CATEGORIES.length - 1)}
                  data-testid={`cat-${c.id}`}
                  aria-pressed={issueCat === c.id}
                  onClick={() => setIssueCat(c.id)}
                >
                  <span style={{ fontSize: 24 }}>{c.icon}</span>
                  {t(`cat${c.id}`)}
                </button>
              ))}
            </div>
            <textarea
              style={S.noteArea}
              placeholder={t('notePlaceholder')}
              value={issueNote}
              maxLength={500}
              data-testid="issue-note"
              onChange={(e) => setIssueNote(e.target.value)}
            />
            <button
              type="button"
              style={S.btn(!issueCat || issuePhase === 'sending')}
              disabled={!issueCat || issuePhase === 'sending'}
              data-testid="issue-send"
              onClick={sendIssue}
            >
              {issuePhase === 'sending' ? t('sendingWord') : t('send')}
            </button>
          </div>
        ))}
      </div>

      {/* no-show confirm dialog (Screen 17a) — the POST only exists past it */}
      {confirmId && (
        <div style={S.scrim} role="dialog" aria-modal="true" aria-label={t('confirmTitle')} data-testid="noshow-dialog">
          <div style={S.dlg}>
            <div style={{ fontSize: 32 }}>⚠️</div>
            <div style={S.dlgTitle}>{t('confirmTitle')}</div>
            <div style={S.dlgBody}>{t('confirmBody')}</div>
            <button type="button" style={S.dlgConfirm} data-testid="noshow-confirm" onClick={() => confirmNoShow(confirmId)}>
              {t('confirmYes')}
            </button>
            <button type="button" style={S.dlgCancel} data-testid="noshow-cancel" onClick={() => setConfirmId(null)}>
              {t('confirmNo')}
            </button>
          </div>
        </div>
      )}

      {/* bottom tabs */}
      <nav style={S.tabs} aria-label={t('driverMode')}>
        <button type="button" style={S.tabBtn(tab === 'home')} data-testid="tab-home" onClick={() => { setTab('home'); setDetailId(null); }}>
          <span style={S.tabIco}>🗺</span>{t('tabHome')}
        </button>
        <button type="button" style={S.tabBtn(tab === 'roster')} data-testid="tab-roster" onClick={() => { setTab('roster'); setDetailId(null); }}>
          <span style={S.tabIco}>🧍</span>{t('tabRoster')}
          {openRoster.length > 0 && <span style={S.tabBadge}>{openRoster.length}</span>}
        </button>
        <button type="button" style={S.tabBtn(tab === 'notifs')} data-testid="tab-notifs" onClick={() => { setTab('notifs'); setDetailId(null); }}>
          <span style={S.tabIco}>🔔</span>{t('tabNotifs')}
          {unreadCount > 0 && <span style={S.tabBadge} data-testid="tab-notifs-badge">{unreadCount}</span>}
        </button>
        <button type="button" style={S.tabBtn(tab === 'issue')} data-testid="tab-issue" onClick={() => { setTab('issue'); setDetailId(null); }}>
          <span style={S.tabIco}>⚠️</span>{t('tabIssue')}
        </button>
      </nav>
    </div>
  );
}
