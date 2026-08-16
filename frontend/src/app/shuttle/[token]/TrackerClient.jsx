'use client';

/**
 * The customer-facing shuttle map (fase 4 + demo feedback 2026-08-16).
 *
 * ARCHITECTURE (Innovation): plain HTTP polling every 12s — no SSE, no
 * websockets. The GET itself is the demand signal that keeps the worker's
 * fast poll armed. MapLibre GL + OpenFreeMap vector tiles, loaded dynamically
 * so the ops bundle never carries a map library.
 *
 * WORKER (the prod-blank-map lesson, 2026-08-16): maplibre v6 loads its web
 * worker as a MODULE script whose URL webpack resolves at runtime — and in
 * the production bundle that resolution landed under /shuttle/, a catch-all
 * route that answers HTML with a 200. The worker died, tiles never rendered,
 * and dev never showed it because dev resolves the URL correctly. So the
 * worker is SELF-HOSTED: predev/prebuild copy the exact installed version to
 * /public and setWorkerUrl pins it. Deterministic in every bundler mood.
 *
 * FOLLOW RULE (GD review): the camera follows the bus only until the customer
 * pans or zooms — then THEY own the camera and a "recenter" chip hands it
 * back. Marker TWEENS between fixes; ETA is a headway sentence, never a
 * countdown.
 *
 * LANGUAGE (Hector, demo feedback): explicit ES | EN toggle on the card —
 * navigator.language guesses the default, the customer decides, localStorage
 * remembers. Sede-written data (pickup instructions) stays as written.
 *
 * LOCATION (Hector, demo feedback): the payload's `pickup` point (the sede's
 * own coordinates) renders as a pin; "share my location" adds the customer's
 * blue dot, a dashed walk line, and live distance to the waiting spot.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../../../lib/client';
import 'maplibre-gl/dist/maplibre-gl.css';

const POLL_MS = 12_000;
const TWEEN_MS = 1600;
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const WORKER_URL = '/maplibre-gl-worker.mjs';
const LANG_KEY = 'ride-shuttle-lang';

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
    if (!pos || !mapRef.current) return;
    let cancelled = false;
    (async () => {
      // CJS/ESM interop differs between dev and the prod bundle — take
      // whichever shape carries Map.
      const mod = await import('maplibre-gl');
      const maplibregl = mod?.default?.Map ? mod.default : mod;
      // Pin the worker to our self-hosted copy BEFORE any Map exists — see
      // the WORKER note in the header. setWorkerUrl lives on both shapes.
      try { (maplibregl.setWorkerUrl || mod.setWorkerUrl)?.(WORKER_URL); } catch { /* older builds */ }
      if (cancelled || !mapRef.current) return;

      // The map container unmounts whenever the payload goes OFFLINE. A Map
      // instance bound to that detached node would leave the NEXT container
      // blank forever (QA, 2026-08-15) — so if the container changed, the old
      // map dies and a fresh one is built.
      if (mapObj.current && mapObj.current.getContainer() !== mapRef.current) {
        mapObj.current.remove();
        mapObj.current = null;
        markerRef.current = null;
        pickupMarkerRef.current = null;
        userMarkerRef.current = null;
      }

      if (!mapObj.current) {
        const map = new maplibregl.Map({
          container: mapRef.current,
          style: MAP_STYLE,
          center: [pos.longitude, pos.latitude],
          zoom: 15,
          attributionControl: { compact: true },
        });
        mapObj.current = map;
        // A gesture means the CUSTOMER owns the camera now (GD review). Only
        // user-originated moves count — our own easeTo has no originalEvent.
        const handoff = (e) => { if (e.originalEvent) setFollowing(false); };
        map.on('dragstart', handoff);
        map.on('zoomstart', handoff);
        map.on('rotatestart', handoff);
        const el = document.createElement('div');
        el.style.cssText = 'width:38px;height:38px;display:flex;align-items:center;justify-content:center;'
          + 'background:#1a7f37;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.35);'
          + 'font-size:19px';
        el.textContent = '🚐';
        markerRef.current = new maplibregl.Marker({ element: el })
          .setLngLat([pos.longitude, pos.latitude])
          .addTo(map);
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
          const lng = from.longitude + (to.longitude - from.longitude) * ease;
          const lat = from.latitude + (to.latitude - from.latitude) * ease;
          markerRef.current?.setLngLat([lng, lat]);
          if (k < 1) tweenRaf.current = requestAnimationFrame(step);
        };
        tweenRaf.current = requestAnimationFrame(step);
        if (followRef.current) mapObj.current.easeTo({ center: [to.longitude, to.latitude], duration: TWEEN_MS });
      }

      // The waiting spot — one pin, kept in sync (it effectively never moves).
      if (pickup && mapObj.current) {
        if (!pickupMarkerRef.current) {
          const pin = document.createElement('div');
          pin.style.cssText = 'width:34px;height:34px;display:flex;align-items:center;justify-content:center;'
            + 'background:#5b21b6;border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);'
            + 'box-shadow:0 2px 8px rgba(0,0,0,.35)';
          const glyph = document.createElement('span');
          glyph.style.cssText = 'transform:rotate(45deg);font-size:15px';
          glyph.textContent = '🧍';
          pin.appendChild(glyph);
          pickupMarkerRef.current = new maplibregl.Marker({ element: pin, anchor: 'bottom' })
            .setLngLat([pickup.longitude, pickup.latitude])
            .addTo(mapObj.current);
        } else {
          pickupMarkerRef.current.setLngLat([pickup.longitude, pickup.latitude]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [pos?.latitude, pos?.longitude, pickup?.latitude, pickup?.longitude]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── the customer's own position: blue dot + dashed walk line ─────────────
  useEffect(() => {
    const map = mapObj.current;
    if (!userPos || !map) return;
    (async () => {
      const mod = await import('maplibre-gl');
      const maplibregl = mod?.default?.Map ? mod.default : mod;
      if (!userMarkerRef.current) {
        const dot = document.createElement('div');
        dot.style.cssText = 'width:18px;height:18px;background:#1d6ef2;border:3px solid #fff;border-radius:50%;'
          + 'box-shadow:0 0 0 6px rgba(29,110,242,.25)';
        userMarkerRef.current = new maplibregl.Marker({ element: dot })
          .setLngLat([userPos.longitude, userPos.latitude])
          .addTo(map);
        // First fix: frame the walk — you, the waiting spot, and the bus.
        try {
          const bounds = new maplibregl.LngLatBounds();
          bounds.extend([userPos.longitude, userPos.latitude]);
          if (pickup) bounds.extend([pickup.longitude, pickup.latitude]);
          if (lastFix.current) bounds.extend([lastFix.current.longitude, lastFix.current.latitude]);
          setFollowing(false);
          map.fitBounds(bounds, { padding: 70, duration: 800, maxZoom: 16.5 });
        } catch { /* framing is cosmetic */ }
      } else {
        userMarkerRef.current.setLngLat([userPos.longitude, userPos.latitude]);
      }

      // Dashed line from you to the waiting spot — direction, not routing.
      if (pickup) {
        const data = {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [[userPos.longitude, userPos.latitude], [pickup.longitude, pickup.latitude]],
          },
        };
        const draw = () => {
          try {
            const src = map.getSource('walk-line');
            if (src) { src.setData(data); return; }
            map.addSource('walk-line', { type: 'geojson', data });
            map.addLayer({
              id: 'walk-line', type: 'line', source: 'walk-line',
              paint: { 'line-color': '#5b21b6', 'line-width': 3, 'line-dasharray': [1.2, 1.6], 'line-opacity': 0.85 },
            });
          } catch { /* style still loading — the next fix redraws */ }
        };
        if (map.isStyleLoaded()) draw(); else map.once('load', draw);
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
    mapObj.current?.remove?.();
  }, []);

  const recenter = () => {
    setFollowing(true);
    const fix = lastFix.current;
    if (fix && mapObj.current) mapObj.current.easeTo({ center: [fix.longitude, fix.latitude], zoom: 15, duration: 600 });
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

  const offline = state.status === 'OFFLINE' || !state.position;
  // Legacy config rows can carry a null headway; never interpolate "null".
  const headway = Number(state.headwayMinutes) >= 1 ? Number(state.headwayMinutes) : 10;
  const ageMin = Math.floor((state.position?.ageSeconds ?? 0) / 60);
  // Under a minute the freshness IS "live"; raw seconds read as telemetry and
  // freeze between polls (GD review). No position → no badge at all.
  const badge = stale
    ? { bg: '#8a8394', text: t('reconnecting') }
    : (!offline && ageMin >= 1) ? { bg: '#b45309', text: t('agingMin', { m: ageMin }) }
      : !offline ? { bg: '#1a7f37', text: t('live') }
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
          {offline ? (
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
          {!offline && pickup && geo !== 'on' && geo !== 'locating' && (
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
