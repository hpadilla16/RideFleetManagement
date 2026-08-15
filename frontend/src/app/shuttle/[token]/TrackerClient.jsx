'use client';

/**
 * The customer-facing shuttle map (fase 4, mockup aprobado 2026-08-15;
 * Graphic Design review applied same day — see the FOLLOW/AGING/404 notes).
 *
 * ARCHITECTURE (Innovation): plain HTTP polling every 12s — no SSE, no
 * websockets. The GET itself is the demand signal that keeps the worker's
 * fast poll armed, so simply having the page open makes positions fresh.
 * MapLibre GL + OpenFreeMap vector tiles (no API key, no per-view billing),
 * loaded dynamically so the ops bundle never carries a map library.
 *
 * The marker TWEENS between fixes (~1.6s) instead of jumping: a 15s poll on a
 * moving bus reads as teleporting, and teleporting reads as broken. ETA is a
 * HEADWAY sentence, never a countdown — a countdown that misses by two
 * minutes destroys trust in the whole page.
 *
 * FOLLOW RULE (GD review): the camera follows the bus only until the customer
 * pans or zooms — then THEY own the camera and a "recenter" chip hands it
 * back. A page that yanks the map back every 12s mid-gesture is the classic
 * tracker failure.
 *
 * Language: navigator.language, Spanish default — customers here are PR-first
 * and the page has no login to read a locale from.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../../../lib/client';
import 'maplibre-gl/dist/maplibre-gl.css';

const POLL_MS = 12_000;
const TWEEN_MS = 1600;
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

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
  },
};

function useStrings() {
  const [lang, setLang] = useState('es');
  useEffect(() => {
    const nav = String(navigator.language || 'es').toLowerCase();
    setLang(nav.startsWith('en') ? 'en' : 'es');
  }, []);
  const t = useCallback((key, vars = {}) => {
    let s = STRINGS[lang][key] || STRINGS.es[key] || key;
    for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
    return s;
  }, [lang]);
  return t;
}

export function ShuttleTrackerClient({ token }) {
  const t = useStrings();
  const [state, setState] = useState(null);   // last good payload
  const [gone, setGone] = useState(false);    // 404 — dead link, uniform
  const [stale, setStale] = useState(false);  // network error, keep last view
  const [reqStatus, setReqStatus] = useState('idle'); // idle|sending|done|again|cooldown
  const [party, setParty] = useState(1);
  const [following, setFollowing] = useState(true);

  const mapRef = useRef(null);
  const mapObj = useRef(null);
  const markerRef = useRef(null);
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
  useEffect(() => {
    if (!pos || !mapRef.current) return;
    let cancelled = false;
    (async () => {
      // CJS/ESM interop differs between dev and the prod bundle — take
      // whichever shape carries Map.
      const mod = await import('maplibre-gl');
      const maplibregl = mod?.default?.Map ? mod.default : mod;
      if (cancelled || !mapRef.current) return;

      // The map container unmounts whenever the payload goes OFFLINE. A Map
      // instance bound to that detached node would leave the NEXT container
      // blank forever (QA, 2026-08-15) — so if the container changed, the old
      // map dies and a fresh one is built.
      if (mapObj.current && mapObj.current.getContainer() !== mapRef.current) {
        mapObj.current.remove();
        mapObj.current = null;
        markerRef.current = null;
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
        return;
      }

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
    })();
    return () => { cancelled = true; };
  }, [pos?.latitude, pos?.longitude]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { cancelAnimationFrame(tweenRaf.current); mapObj.current?.remove?.(); }, []);

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
    h1: { margin: 0, fontSize: 17, fontWeight: 700 },
    note: { margin: '6px 0 0', fontSize: 14, lineHeight: 1.5, color: '#5b5266' },
    where: { margin: '14px 0 0', padding: '10px 12px', background: '#f4f2f7', borderRadius: 10, fontSize: 14, lineHeight: 1.5 },
    whereTag: { display: 'block', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#5b5266', fontWeight: 700, marginBottom: 2 },
    btn: (sending) => ({ marginTop: 16, width: '100%', minHeight: 48, padding: '14px 16px', fontSize: 16, fontWeight: 700, color: '#fff', background: '#5b21b6', opacity: sending ? 0.7 : 1, border: 'none', borderRadius: 12, cursor: sending ? 'default' : 'pointer' }),
    ok: { marginTop: 16, padding: '12px 14px', background: '#e7f6ec', color: '#166b2f', borderRadius: 12, fontSize: 15, fontWeight: 600, textAlign: 'center' },
    partyRow: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 14 },
    partySelect: { fontSize: 15, minHeight: 44, padding: '8px 14px', borderRadius: 10, border: '1px solid #d8d3e0', background: '#fff', color: '#2a2333' },
    center: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' },
  };

  if (gone) {
    return (
      <div style={S.page}>
        <div style={S.center}>
          <div style={{ fontSize: 42 }}>🚐</div>
          <h1 style={{ ...S.h1, marginTop: 12 }}>{t('goneTitle')}</h1>
          <p style={{ ...S.note, maxWidth: 420 }}>{t('goneBody')}</p>
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
          <h1 style={S.h1}>{state.locationName}</h1>
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
