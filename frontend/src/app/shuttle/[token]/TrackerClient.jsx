'use client';

/**
 * The customer-facing shuttle map (fase 4 + demo feedback 2026-08-16).
 *
 * ARCHITECTURE (Innovation): plain HTTP polling every 12s — no SSE, no
 * websockets. The GET itself is the demand signal that keeps the worker's
 * fast poll armed.
 *
 * MAP = GOOGLE MAPS (Hector, 2026-08-16). MapLibre burned us twice in one
 * day: its v6 web worker loads as a module script whose bundler-resolved URL
 * fell into the /shuttle catch-all (HTML, dead worker, blank canvas), and the
 * "fixed" self-hosted worker turned out to be an 18KB stub that imports
 * MORE relative chunks — same trap one level deeper. Google's JS API is one
 * script tag, no workers, no bundler interaction, and the customers already
 * know the map. Key comes from NEXT_PUBLIC_GOOGLE_MAPS_KEY (inlined at
 * BUILD time — the docker image must be built with it present). Without a
 * key the page degrades to the card-only layout: instructions, request
 * button and live distance all still work.
 *
 * REFERRER NOTE: this page previously sent NO referrer anywhere (the token
 * lives in the URL path). Google validates referrer-restricted keys against
 * the Referer header, so total silence would break the key. The policy is
 * now `origin` — Google sees "https://ridefleetmanager.com/", the token
 * (path) is still never sent. Keep next.config.js and page metadata in sync
 * on this.
 *
 * FOLLOW RULE (GD review): the camera follows the bus only until the
 * customer pans — then THEY own the camera and a "recenter" chip hands it
 * back. Marker TWEENS between fixes; ETA is a headway sentence, never a
 * countdown.
 *
 * LANGUAGE: explicit ES | EN toggle; navigator.language only guesses the
 * default; localStorage remembers. Sede-written data stays as written.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../../../lib/client';

const POLL_MS = 12_000;
const TWEEN_MS = 1600;
const LANG_KEY = 'ride-shuttle-lang';
const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY || '';

const STRINGS = {
  es: {
    live: 'EN VIVO',
    agingMin: 'visto hace {m} min',
    offlineTitle: 'El shuttle no está transmitiendo ahora mismo',
    offlineBody: 'El servicio sigue corriendo — pasa aproximadamente cada {n} minutos.',
    headwayNote: 'El shuttle pasa aproximadamente cada {n} minutos.',
    where: 'Dónde esperar',
    recenter: 'Ver el shuttle',
    request: 'Solicitar el shuttle',
    requesting: 'Solicitando…',
    requested: 'Listo — el shuttle va en camino',
    requestedAgain: 'Ya estaba en camino — vamos contigo',
    party: 'Personas',
    goneTitle: 'Este enlace ya no está activo',
    goneBody: 'Los enlaces del shuttle son personales y expiran al terminar tu renta. Si necesitas el shuttle, llama al número que aparece en tu confirmación de reserva.',
    loading: 'Cargando el shuttle…',
    reconnecting: 'Reconectando…',
    tooFast: 'Espera un momento y vuelve a intentar.',
    failed: 'No se pudo enviar tu solicitud — intenta de nuevo.',
    shareLocation: '📍 Ver dónde estoy yo',
    locating: 'Buscando tu ubicación…',
    distanceAway: 'Estás a {d} del punto de espera',
    youAreHere: 'Aquí estás tú; el pin morado es donde esperas la guagua.',
    locationDenied: 'No pudimos acceder a tu ubicación — revisa el permiso del navegador.',
  },
  en: {
    live: 'LIVE',
    agingMin: 'seen {m} min ago',
    offlineTitle: 'The shuttle is not transmitting right now',
    offlineBody: 'Service is still running — it passes about every {n} minutes.',
    headwayNote: 'The shuttle passes about every {n} minutes.',
    where: 'Where to wait',
    recenter: 'Find the shuttle',
    request: 'Request the shuttle',
    requesting: 'Requesting…',
    requested: 'Done — the shuttle is on its way',
    requestedAgain: 'It was already on its way — hang tight',
    party: 'People',
    goneTitle: 'This link is no longer active',
    goneBody: 'Shuttle links are personal and expire when your rental ends. If you need the shuttle, call the number on your reservation confirmation.',
    loading: 'Loading your shuttle…',
    reconnecting: 'Reconnecting…',
    tooFast: 'Please wait a moment and try again.',
    failed: "Your request didn't go through — please try again.",
    shareLocation: '📍 Show where I am',
    locating: 'Finding your location…',
    distanceAway: 'You are {d} from the pickup spot',
    youAreHere: 'This is you; the purple pin is where to wait for the shuttle.',
    locationDenied: 'We could not access your location — check the browser permission.',
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

/**
 * Load the Google Maps JS API exactly once, however many components ask.
 *
 * This is Google's OFFICIAL inline bootstrap (their documented loader,
 * reformatted) — not a bare script tag. The first prod deploy used a plain
 * <script src=...&loading=async> and importLibrary was not yet a function
 * when onload fired ("t.maps.importLibrary is not a function", 2026-08-16).
 * The bootstrap defines google.maps.importLibrary SYNCHRONOUSLY and only
 * fetches the network script on first use, which removes the race entirely.
 */
let bootstrapped = false;
function ensureMapsBootstrap() {
  if (!MAPS_KEY || bootstrapped || window.google?.maps?.importLibrary) { bootstrapped = true; return; }
  bootstrapped = true;
  /* eslint-disable */
  (g => { var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = document, b = window; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set, e = new URLSearchParams, u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement("script")); e.set("libraries", [...r] + ""); for (k in g) e.set(k.replace(/[A-Z]/g, t => "_" + t[0].toLowerCase()), g[k]); e.set("callback", c + ".maps." + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => h = n(Error(p + " could not load.")); a.nonce = m.querySelector("script[nonce]")?.nonce || ""; m.head.append(a) })); d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)) })({ key: MAPS_KEY, v: "weekly" });
  /* eslint-enable */
}
async function loadGoogleMaps() {
  if (!MAPS_KEY) return null;
  ensureMapsBootstrap();
  try {
    // Force the bootstrap to actually fetch + settle before callers touch
    // importLibrary for their own libraries.
    await window.google.maps.importLibrary('core');
    return window.google;
  } catch {
    return null; // bad key / network blocked — page degrades to card-only
  }
}

/** Meters between two coordinates — enough precision for "how far is my walk". */
function metersBetween(a, b) {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos((a.latitude * Math.PI) / 180) * Math.cos((b.latitude * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const formatDistance = (m) => (m < 950 ? `~${Math.max(10, Math.round(m / 10) * 10)} m` : `~${(m / 1000).toFixed(1)} km`);

const markerDiv = (css, text) => {
  const el = document.createElement('div');
  el.style.cssText = css;
  if (text) el.textContent = text;
  return el;
};

export function ShuttleTrackerClient({ token }) {
  const { t, lang, setLang } = useStrings();
  const [state, setState] = useState(null);   // last good payload
  const [gone, setGone] = useState(false);    // 404 — dead link, uniform
  const [stale, setStale] = useState(false);  // network error, keep last view
  const [reqStatus, setReqStatus] = useState('idle'); // idle|sending|done|again|cooldown|failed
  const [party, setParty] = useState(1);
  const [following, setFollowing] = useState(true);
  const [geo, setGeo] = useState('idle');     // idle|locating|on|denied
  const [userPos, setUserPos] = useState(null);

  const mapRef = useRef(null);
  const mapObj = useRef(null);
  const markerRef = useRef(null);
  const pickupMarkerRef = useRef(null);
  const userMarkerRef = useRef(null);
  const walkLineRef = useRef(null);
  const geoWatchId = useRef(null);
  const lastFix = useRef(null);
  const tweenRaf = useRef(0);
  const followRef = useRef(true);
  followRef.current = following;

  // ── polling ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/public/shuttle/${encodeURIComponent(token)}`, { cache: 'no-store' });
        if (!alive) return;
        if (res.status === 404) { setGone(true); return; } // dead links never revive — stop polling
        if (!res.ok) throw new Error(String(res.status));
        setState(await res.json());
        setStale(false);
      } catch {
        if (alive) setStale(true); // keep the last view; the badge says we're reconnecting
      }
      if (alive) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [token]);

  // ── map lifecycle: build once we have coordinates, tween on updates ──────
  const pos = state?.position;
  const pickup = state?.pickup;
  useEffect(() => {
    if (!pos || !mapRef.current || !MAPS_KEY) return;
    let cancelled = false;
    (async () => {
      const google = await loadGoogleMaps();
      if (!google || cancelled || !mapRef.current) return;
      const { Map } = await google.maps.importLibrary('maps');
      const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
      if (cancelled || !mapRef.current) return;

      // The map container unmounts whenever the payload goes OFFLINE — a Map
      // bound to a detached node leaves the next container blank (QA,
      // 2026-08-15). Container changed → rebuild everything on the fresh one.
      if (mapObj.current && mapObj.current.getDiv() !== mapRef.current) {
        mapObj.current = null;
        markerRef.current = null;
        pickupMarkerRef.current = null;
        userMarkerRef.current = null;
        walkLineRef.current = null;
      }

      if (!mapObj.current) {
        const map = new Map(mapRef.current, {
          center: { lat: pos.latitude, lng: pos.longitude },
          zoom: 15,
          // AdvancedMarkerElement requires a mapId; DEMO_MAP_ID is Google's
          // documented default-styling id. Register a real one in the Cloud
          // console later for custom styling — purely cosmetic.
          mapId: 'DEMO_MAP_ID',
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
          gestureHandling: 'greedy',
        });
        mapObj.current = map;
        // A drag means the CUSTOMER owns the camera now (GD review). Google
        // only fires dragstart for real gestures, never for our panTo.
        map.addListener('dragstart', () => setFollowing(false));

        markerRef.current = new AdvancedMarkerElement({
          map,
          position: { lat: pos.latitude, lng: pos.longitude },
          content: markerDiv(
            'width:38px;height:38px;display:flex;align-items:center;justify-content:center;'
            + 'background:#1a7f37;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.35);font-size:19px',
            '🚐',
          ),
        });
        lastFix.current = pos;
      } else {
        // Tween from the previous fix to this one.
        const from = lastFix.current || pos;
        const to = pos;
        lastFix.current = pos;
        cancelAnimationFrame(tweenRaf.current);
        const started = performance.now();
        const step = (now) => {
          const k = Math.min(1, (now - started) / TWEEN_MS);
          const ease = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;
          const lat = from.latitude + (to.latitude - from.latitude) * ease;
          const lng = from.longitude + (to.longitude - from.longitude) * ease;
          if (markerRef.current) markerRef.current.position = { lat, lng };
          if (k < 1) tweenRaf.current = requestAnimationFrame(step);
        };
        tweenRaf.current = requestAnimationFrame(step);
        if (followRef.current) mapObj.current.panTo({ lat: to.latitude, lng: to.longitude });
      }

      // The waiting spot — one pin, kept in sync (it effectively never moves).
      if (pickup && mapObj.current) {
        if (!pickupMarkerRef.current) {
          const pin = markerDiv(
            'width:34px;height:34px;display:flex;align-items:center;justify-content:center;'
            + 'background:#5b21b6;border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);'
            + 'box-shadow:0 2px 8px rgba(0,0,0,.35)',
          );
          pin.appendChild(markerDiv('transform:rotate(45deg);font-size:15px', '🧍'));
          pickupMarkerRef.current = new AdvancedMarkerElement({
            map: mapObj.current,
            position: { lat: pickup.latitude, lng: pickup.longitude },
            content: pin,
          });
        } else {
          pickupMarkerRef.current.position = { lat: pickup.latitude, lng: pickup.longitude };
        }
      }
    })();
    return () => { cancelled = true; };
  }, [pos?.latitude, pos?.longitude, pickup?.latitude, pickup?.longitude]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── the customer's own position: blue dot + dashed walk line ─────────────
  useEffect(() => {
    const map = mapObj.current;
    if (!userPos || !map || !MAPS_KEY) return;
    (async () => {
      const google = await loadGoogleMaps();
      if (!google) return;
      const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
      if (!userMarkerRef.current) {
        userMarkerRef.current = new AdvancedMarkerElement({
          map,
          position: { lat: userPos.latitude, lng: userPos.longitude },
          content: markerDiv(
            'width:18px;height:18px;background:#1d6ef2;border:3px solid #fff;border-radius:50%;'
            + 'box-shadow:0 0 0 6px rgba(29,110,242,.25)',
          ),
        });
        // First fix: frame the walk — you, the waiting spot, and the bus.
        try {
          const bounds = new google.maps.LatLngBounds();
          bounds.extend({ lat: userPos.latitude, lng: userPos.longitude });
          if (pickup) bounds.extend({ lat: pickup.latitude, lng: pickup.longitude });
          if (lastFix.current) bounds.extend({ lat: lastFix.current.latitude, lng: lastFix.current.longitude });
          setFollowing(false);
          map.fitBounds(bounds, 70);
        } catch { /* framing is cosmetic */ }
      } else {
        userMarkerRef.current.position = { lat: userPos.latitude, lng: userPos.longitude };
      }

      // Dashed line from you to the waiting spot — direction, not routing.
      if (pickup) {
        const path = [
          { lat: userPos.latitude, lng: userPos.longitude },
          { lat: pickup.latitude, lng: pickup.longitude },
        ];
        if (walkLineRef.current) {
          walkLineRef.current.setPath(path);
        } else {
          walkLineRef.current = new google.maps.Polyline({
            map,
            path,
            strokeOpacity: 0,
            icons: [{
              icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.85, strokeColor: '#5b21b6', strokeWeight: 3, scale: 3 },
              offset: '0',
              repeat: '14px',
            }],
          });
        }
      }
    })();
  }, [userPos?.latitude, userPos?.longitude, pickup?.latitude, pickup?.longitude]); // eslint-disable-line react-hooks/exhaustive-deps

  const shareLocation = () => {
    if (!navigator.geolocation) { setGeo('denied'); return; }
    setGeo('locating');
    geoWatchId.current = navigator.geolocation.watchPosition(
      (fix) => {
        setGeo('on');
        setUserPos({ latitude: fix.coords.latitude, longitude: fix.coords.longitude });
      },
      () => setGeo('denied'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
  };

  useEffect(() => () => {
    cancelAnimationFrame(tweenRaf.current);
    if (geoWatchId.current !== null) navigator.geolocation?.clearWatch?.(geoWatchId.current);
  }, []);

  const recenter = () => {
    setFollowing(true);
    const fix = lastFix.current;
    if (fix && mapObj.current) {
      mapObj.current.panTo({ lat: fix.latitude, lng: fix.longitude });
      mapObj.current.setZoom(15);
    }
  };

  // ── request the shuttle ──────────────────────────────────────────────────
  const requestShuttle = async () => {
    if (reqStatus === 'sending') return;
    setReqStatus('sending');
    try {
      const res = await fetch(`${API_BASE}/api/public/shuttle/${encodeURIComponent(token)}/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partySize: party }),
      });
      if (res.status === 429) { setReqStatus('cooldown'); return; }
      if (res.status === 404) { setGone(true); return; }
      // Anything else non-ok is a FAILURE and SAYS SO: the button comes back
      // with honest copy. Falling through here once showed "on its way" on a
      // 500 — the worst possible lie to someone standing at a curb. The 429
      // copy asserts nothing about receipt either: on hotel NAT the limiter
      // can trip on a customer's very FIRST tap.
      if (!res.ok) { setReqStatus('failed'); return; }
      const out = await res.json();
      setReqStatus(out?.ok ? (out.deduplicated ? 'again' : 'done') : 'failed');
    } catch {
      setReqStatus('failed');
    }
  };

  // ── views ────────────────────────────────────────────────────────────────
  const S = {
    page: { minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: '#f4f2f7', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#2a2333' },
    map: { flex: 1, minHeight: '46dvh', position: 'relative', background: '#eef0f2' },
    badge: (bg) => ({ position: 'absolute', top: 12, left: 12, zIndex: 5, background: bg, color: '#fff', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', padding: '4px 10px', borderRadius: 999, boxShadow: '0 1px 4px rgba(0,0,0,.25)' }),
    recenterChip: { position: 'absolute', bottom: 26, right: 12, zIndex: 5, background: '#fff', color: '#5b21b6', fontSize: 13, fontWeight: 700, padding: '10px 14px', border: 'none', borderRadius: 999, boxShadow: '0 2px 8px rgba(0,0,0,.25)', cursor: 'pointer' },
    cardOuter: { background: '#fff', borderRadius: '16px 16px 0 0', marginTop: -14, zIndex: 6, boxShadow: '0 -4px 18px rgba(0,0,0,.08)' },
    card: { maxWidth: 520, margin: '0 auto', padding: '18px 18px calc(24px + env(safe-area-inset-bottom, 0px))' },
    headRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
    h1: { margin: 0, fontSize: 17, fontWeight: 700 },
    langWrap: { display: 'flex', border: '1px solid #d8d3e0', borderRadius: 999, overflow: 'hidden', flexShrink: 0 },
    langBtn: (active) => ({ minHeight: 34, padding: '6px 12px', fontSize: 12, fontWeight: 700, border: 'none', cursor: 'pointer', background: active ? '#5b21b6' : '#fff', color: active ? '#fff' : '#5b5266' }),
    note: { margin: '6px 0 0', fontSize: 14, lineHeight: 1.5, color: '#5b5266' },
    where: { margin: '14px 0 0', padding: '10px 12px', background: '#f4f2f7', borderRadius: 10, fontSize: 14, lineHeight: 1.5 },
    whereTag: { display: 'block', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#5b5266', fontWeight: 700, marginBottom: 2 },
    geoBtn: { marginTop: 12, width: '100%', minHeight: 44, padding: '10px 14px', fontSize: 14, fontWeight: 700, color: '#5b21b6', background: '#fff', border: '2px solid #5b21b6', borderRadius: 12, cursor: 'pointer' },
    geoInfo: { marginTop: 10, padding: '10px 12px', background: '#eaf1fe', color: '#173e8a', borderRadius: 10, fontSize: 14, lineHeight: 1.5 },
    btn: (sending) => ({ marginTop: 16, width: '100%', minHeight: 48, padding: '14px 16px', fontSize: 16, fontWeight: 700, color: '#fff', background: '#5b21b6', opacity: sending ? 0.7 : 1, border: 'none', borderRadius: 12, cursor: sending ? 'default' : 'pointer' }),
    ok: { marginTop: 16, padding: '12px 14px', background: '#e7f6ec', color: '#166b2f', borderRadius: 12, fontSize: 15, fontWeight: 600, textAlign: 'center' },
    partyRow: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 14 },
    partySelect: { fontSize: 15, minHeight: 44, padding: '8px 14px', borderRadius: 10, border: '1px solid #d8d3e0', background: '#fff', color: '#2a2333' },
    center: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' },
  };

  const langToggle = (
    <div style={S.langWrap} role="group" aria-label="Language">
      <button type="button" style={S.langBtn(lang === 'es')} onClick={() => setLang('es')} aria-pressed={lang === 'es'}>ES</button>
      <button type="button" style={S.langBtn(lang === 'en')} onClick={() => setLang('en')} aria-pressed={lang === 'en'}>EN</button>
    </div>
  );

  if (gone) {
    return (
      <div style={S.page}>
        <div style={S.center}>
          <div style={{ fontSize: 42 }}>🚐</div>
          <h1 style={{ ...S.h1, marginTop: 12 }}>{t('goneTitle')}</h1>
          <p style={{ ...S.note, maxWidth: 420 }}>{t('goneBody')}</p>
          <div style={{ marginTop: 16 }}>{langToggle}</div>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div style={S.page}>
        <div style={S.center}>
          <div style={{ fontSize: 42 }}>🚐</div>
          <p style={S.note} role="status">{stale ? t('reconnecting') : t('loading')}</p>
        </div>
      </div>
    );
  }

  // No key at build time = no map surface at all; the card still carries the
  // instructions, the distance math and the request button.
  const offline = state.status === 'OFFLINE' || !state.position || !MAPS_KEY;
  // Legacy config rows can carry a null headway; never interpolate "null".
  const headway = Number(state.headwayMinutes) >= 1 ? Number(state.headwayMinutes) : 10;
  const ageMin = Math.floor((state.position?.ageSeconds ?? 0) / 60);
  const transmitting = state.status !== 'OFFLINE' && state.position;
  // Under a minute the freshness IS "live"; raw seconds read as telemetry and
  // freeze between polls (GD review). No position → no badge at all.
  const badge = stale
    ? { bg: '#8a8394', text: t('reconnecting') }
    : (transmitting && ageMin >= 1) ? { bg: '#b45309', text: t('agingMin', { m: ageMin }) }
      : transmitting ? { bg: '#1a7f37', text: t('live') }
        : null;

  const walkMeters = (userPos && pickup) ? metersBetween(userPos, pickup) : null;

  return (
    <div style={S.page}>
      {!offline && (
        <div style={S.map}>
          {badge && <div style={S.badge(badge.bg)} role="status" aria-live="polite">{badge.text}</div>}
          <div ref={mapRef} style={{ position: 'absolute', inset: 0 }} />
          {!following && (
            <button type="button" style={S.recenterChip} onClick={recenter}>🚐 {t('recenter')}</button>
          )}
        </div>
      )}
      <div style={offline ? { ...S.cardOuter, margin: 'auto 16px', borderRadius: 16 } : S.cardOuter}>
        <div style={S.card}>
          {offline && <div style={{ fontSize: 34, marginBottom: 6 }}>🚐</div>}
          <div style={S.headRow}>
            <h1 style={S.h1}>{state.locationName}</h1>
            {langToggle}
          </div>
          {!transmitting ? (
            <>
              <p style={{ ...S.note, fontWeight: 600 }}>{t('offlineTitle')}</p>
              <p style={S.note}>{t('offlineBody', { n: headway })}</p>
            </>
          ) : (
            <p style={S.note}>{t('headwayNote', { n: headway })}</p>
          )}
          {state.pickupInstructions && (
            <div style={S.where}>
              <span style={S.whereTag}>{t('where')}</span>
              {state.pickupInstructions}
            </div>
          )}
          {pickup && geo !== 'on' && geo !== 'locating' && (
            <button type="button" style={S.geoBtn} onClick={shareLocation}>{t('shareLocation')}</button>
          )}
          {geo === 'locating' && <p style={{ ...S.note, textAlign: 'center' }} role="status">{t('locating')}</p>}
          {geo === 'denied' && <p style={{ ...S.note, textAlign: 'center' }} role="status">{t('locationDenied')}</p>}
          {geo === 'on' && (
            <div style={S.geoInfo} role="status">
              {walkMeters !== null
                ? t('distanceAway', { d: formatDistance(walkMeters) })
                : t('youAreHere')}
            </div>
          )}
          {state.mode === 'ON_DEMAND' && (
            (reqStatus === 'done' || reqStatus === 'again') ? (
              <div style={S.ok} role="status">{t(reqStatus === 'done' ? 'requested' : 'requestedAgain')}</div>
            ) : (
              <>
                <div style={S.partyRow}>
                  <label htmlFor="shuttle-party">{t('party')}</label>
                  <select id="shuttle-party" value={party} onChange={(e) => setParty(Number(e.target.value))} style={S.partySelect}>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <button type="button" style={S.btn(reqStatus === 'sending')} disabled={reqStatus === 'sending'} onClick={requestShuttle}>
                  {reqStatus === 'sending' ? t('requesting') : t('request')}
                </button>
                {reqStatus === 'cooldown' && <p style={{ ...S.note, textAlign: 'center' }} role="status">{t('tooFast')}</p>}
                {reqStatus === 'failed' && <p style={{ ...S.note, textAlign: 'center', color: '#b3261e' }} role="status">{t('failed')}</p>}
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}
