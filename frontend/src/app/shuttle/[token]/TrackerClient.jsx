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
import { tenantBrandName } from '../../../lib/tenant-brand';
import { MAPS_KEY, loadGoogleMaps } from '../../../lib/google-maps-loader';

const POLL_MS = 12_000;
const TWEEN_MS = 1600;
const LANG_KEY = 'ride-shuttle-lang';
/** Phase 3 (Screen 9): cadence of the consented location POST while sharing. */
const SHARE_POST_MS = 10_000;
/** Phase 3 (Screen 7): silent fallback bounds when the public payload does not
 *  expose the sede's intake caps (contract gap — the flow still enforces the
 *  server's own defaults so a 400 can't be provoked by tapping "+"). The caps
 *  are never DISPLAYED unless the payload carries them. */
const PARTY_CAP_FALLBACK = 50;
const BAGS_CAP_FALLBACK = 20;

const STRINGS = {
  es: {
    live: 'EN VIVO',
    // NEW #7 (2026-08-24): freshness copy — same data, honest age.
    liveUpdated: 'EN VIVO · actualizado hace {s}s',
    trackerSub: 'Rastreo del shuttle',
    statusReceived: 'Recibimos tu solicitud — el counter fue avisado',
    statusOnWay: '✓ Tu shuttle va en camino',
    statusPickedUp: '✓ Recogido — ¡buen viaje!',
    stepRequested: 'Solicitado',
    stepOnWay: 'En camino',
    stepPickedUp: 'Recogido',
    lookFor: 'Busca el {desc}',
    plateWord: 'tablilla',
    howToGetThere: 'Cómo llegar',
    callCounter: '📞 ¿Problemas? Llama al counter',
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
    // Phase 3 (2026-08-25) — Screens 7 / 8a / 8b / 9 / 16.
    assignedTo: 'Tu shuttle: {name} · asignado a ti',
    goToSpot: '📍 Dirígete a: {spot}',
    loopNote: 'No necesitas solicitarla — sube a la próxima que llegue a tu punto.',
    shuttleLive: 'en vivo · hace {s}s',
    shuttleSeen: 'visto hace {m} min',
    shuttleOffline: 'sin señal ahora',
    consentTitle: '📍 Comparte tu ubicación para que el conductor te encuentre',
    consentBody: 'El conductor verá exactamente dónde estás — útil si no encuentras el punto de recogida.',
    consentShare: 'Compartir ubicación',
    consentNo: 'No, gracias',
    consentPriv: 'Solo mientras esperas tu shuttle · se borra al completar la recogida.',
    sharingPill: '📍 Compartiendo',
    sharingStop: 'Detener',
    shuttleDistance: 'Tu shuttle está a {d}',
    sharingFallback: 'Todo sigue funcionando sin compartir: usa las instrucciones para llegar al punto de recogida.',
    arrivedTitle: '¡Tu shuttle ya llegó!',
    arrivedGo: 'Ve a {spot}',
    intakeConfirmTitle: 'Confirma tu información',
    intakeNameLabel: 'Nombre',
    intakePrefilled: 'Ya te conocemos por tu reserva — el enlace es personal.',
    intakeContinue: 'Continuar',
    intakeBack: '← Atrás',
    intakePeople: '¿Cuántas personas?',
    intakeBags: '¿Cuántas maletas?',
    smsOptIn: 'Avísame por texto cuando llegue mi shuttle',
    stepFewer: 'Menos',
    stepMore: 'Más',
    intakeGoTo: 'Dirígete a {spot}',
    intakeGoGeneric: 'Tu punto de recogida',
  },
  en: {
    live: 'LIVE',
    // NEW #7 (2026-08-24): freshness copy — same data, honest age.
    liveUpdated: 'LIVE · updated {s}s ago',
    trackerSub: 'Shuttle tracker',
    statusReceived: 'We got your request — the counter has been alerted',
    statusOnWay: '✓ Your shuttle is on its way',
    statusPickedUp: '✓ Picked up — enjoy the ride!',
    stepRequested: 'Requested',
    stepOnWay: 'On its way',
    stepPickedUp: 'Picked up',
    lookFor: 'Look for the {desc}',
    plateWord: 'plate',
    howToGetThere: 'How to get there',
    callCounter: '📞 Having trouble? Call the counter',
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
    // Phase 3 (2026-08-25) — Screens 7 / 8a / 8b / 9 / 16.
    assignedTo: 'Your shuttle: {name} · assigned to you',
    goToSpot: '📍 Head to: {spot}',
    loopNote: 'No need to request it — board the next one that reaches your spot.',
    shuttleLive: 'live · {s}s ago',
    shuttleSeen: 'last known {m} min ago',
    shuttleOffline: 'no signal right now',
    consentTitle: '📍 Share your location so the driver can find you',
    consentBody: 'The driver will see exactly where you are — helpful if you cannot find the pickup spot.',
    consentShare: 'Share location',
    consentNo: 'No thanks',
    consentPriv: 'Only while you wait for your shuttle · deleted after pickup.',
    sharingPill: '📍 Sharing',
    sharingStop: 'Stop',
    shuttleDistance: 'Your shuttle is {d} away',
    sharingFallback: 'Everything still works without sharing — use the directions to reach the pickup spot.',
    arrivedTitle: 'Your shuttle has arrived!',
    arrivedGo: 'Go to {spot}',
    intakeConfirmTitle: 'Confirm your info',
    intakeNameLabel: 'Name',
    intakePrefilled: 'Prefilled from your reservation — the link is personal.',
    intakeContinue: 'Continue',
    intakeBack: '← Back',
    intakePeople: 'How many people?',
    intakeBags: 'How many bags?',
    smsOptIn: 'Text me when my shuttle arrives',
    stepFewer: 'Fewer',
    stepMore: 'More',
    intakeGoTo: 'Go to {spot}',
    intakeGoGeneric: 'Your pickup spot',
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

// Google Maps loader lives in lib/google-maps-loader.js (shared with the
// staff Shuttle Monitor since 2026-08-24) — same bootstrap, same key wiring.

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

/** Per-shuttle freshness sentence (Screen 8b) — freshness ages, never an ETA. */
const shuttleFreshLabel = (entry, t) => {
  if (entry?.status === 'LIVE') return t('shuttleLive', { s: entry.position?.ageSeconds ?? 0 });
  if (entry?.status === 'AGING') {
    return t('shuttleSeen', { m: Math.max(1, Math.round((entry.position?.ageSeconds ?? 60) / 60)) });
  }
  return t('shuttleOffline');
};

/** Big-touch-target stepper (Screen 7). The max is enforced silently; it is
 *  only the payload's business to SAY what the cap is (contract gap note). */
function Stepper({ value, min, max, onChange, decLabel, incLabel, testId }) {
  const atMin = value <= min;
  const atMax = max != null && value >= max;
  const btn = (disabled) => ({
    width: 56, height: 56, fontSize: 26, fontWeight: 700, borderRadius: '50%',
    border: '2px solid #5b21b6', background: '#fff', color: '#5b21b6',
    opacity: disabled ? 0.35 : 1, cursor: disabled ? 'default' : 'pointer',
  });
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 22, marginTop: 8 }}>
      <button type="button" data-testid={`${testId}-minus`} aria-label={decLabel} disabled={atMin} style={btn(atMin)} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <span data-testid={`${testId}-value`} style={{ fontSize: 34, fontWeight: 800, minWidth: 48, textAlign: 'center' }} aria-live="polite">{value}</span>
      <button type="button" data-testid={`${testId}-plus`} aria-label={incLabel} disabled={atMax} style={btn(atMax)} onClick={() => onChange(max != null ? Math.min(max, value + 1) : value + 1)}>+</button>
    </div>
  );
}

export function ShuttleTrackerClient({ token }) {
  const { t, lang, setLang } = useStrings();
  const [state, setState] = useState(null);   // last good payload
  const [gone, setGone] = useState(false);    // 404 — dead link, uniform
  const [stale, setStale] = useState(false);  // network error, keep last view
  const [reqStatus, setReqStatus] = useState('idle'); // idle|sending|done|again|cooldown|failed
  const [party, setParty] = useState(1);
  const [following, setFollowing] = useState(true);
  const [geo, setGeo] = useState('idle');     // idle|locating|on|denied|stopped|off
  const [userPos, setUserPos] = useState(null);
  // Phase 3 (Screen 7): intake flow state. The flow only exists when the
  // payload says the sede opted in — see intakeCfg below.
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeStep, setIntakeStep] = useState(0);
  const [iParty, setIParty] = useState(1);
  const [iBags, setIBags] = useState(0);
  const [smsOpt, setSmsOpt] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  // NEW #7 (2026-08-24): tick locally between the 12s polls so the "updated
  // Ns ago" chip counts up instead of freezing on the last payload's age.
  const [nowTick, setNowTick] = useState(() => Date.now());
  const payloadAtRef = useRef(Date.now());

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
  // Phase 3 (Screen 9): consented sharing — the watch feeds the LOCAL blue dot
  // AND, only while sharingRef is true, the ~10s POST loop.
  const sharingRef = useRef(false);
  const userFixRef = useRef(null);
  const shareTimerRef = useRef(0);
  // Phase 3 (Screen 8b): loop markers, one per shuttles[] entry.
  const loopMarkersRef = useRef([]);

  // ── Phase 3 derived payload reads (all before the early returns) ─────────
  // The server's requestStatus is authoritative; a just-sent request shows
  // READY until the next poll confirms it. (Hoisted from the render section.)
  const requestStatus = state?.requestStatus
    || ((reqStatus === 'done' || reqStatus === 'again') ? 'READY' : null);
  const requestOpen = requestStatus === 'READY' || requestStatus === 'VIEWED';
  // CONTRACT GAP (2026-08-25): the public payload does not expose the sede's
  // intake config — parseIntakeConfig only feeds the AUTHED admin GET. The
  // page reads `state.intake` tolerantly: absent = the pre-Phase-3 one-tap
  // request, byte-for-byte. Caps fall back silently to the server defaults.
  const intakeCfg = state?.intake && typeof state.intake === 'object' ? state.intake : null;
  const intakeEnabled = intakeCfg?.enabled === true;
  const partyCap = Number.isInteger(Number(intakeCfg?.partySizeCap)) && Number(intakeCfg?.partySizeCap) >= 1
    ? Number(intakeCfg.partySizeCap) : PARTY_CAP_FALLBACK;
  const bagsCap = Number.isInteger(Number(intakeCfg?.bagsCap)) && Number(intakeCfg?.bagsCap) >= 1
    ? Number(intakeCfg.bagsCap) : BAGS_CAP_FALLBACK;
  // CONTRACT GAP (2026-08-25): no pickup-spot identity in the public payload —
  // the POST accepts pickupSpotZoneId but nothing public says which spot is
  // designated/closest. Tolerant read of a future `state.pickupSpot`; absent =
  // no id is sent and the spot step shows the location-level texts.
  const pickupSpot = state?.pickupSpot && typeof state.pickupSpot === 'object' ? state.pickupSpot : null;
  const spotName = pickupSpot?.name || null;
  const spotZoneId = pickupSpot?.zoneId || pickupSpot?.id || null;
  const spotDirections = pickupSpot?.walkingDirections || state?.walkingDirections || '';
  // Screen 8b: the loop — mode-aware markers come from shuttles[], never ids.
  const loopShuttles = state?.mode === 'NON_STOP' && Array.isArray(state?.shuttles) ? state.shuttles : null;
  const loopMode = !!(loopShuttles && loopShuttles.length);
  const loopModeRef = useRef(false);
  loopModeRef.current = loopMode;

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
        payloadAtRef.current = Date.now();
        setStale(false);
      } catch {
        if (alive) setStale(true); // keep the last view; the badge says we're reconnecting
      }
      if (alive) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [token]);

  // NEW #7: one-second heartbeat, armed only while a position is showing.
  useEffect(() => {
    if (!state?.position) return undefined;
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state?.position]);

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
        loopMarkersRef.current = [];
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
        setMapReady(true); // arms the loop-marker effect (Screen 8b)
        // A drag means the CUSTOMER owns the camera now (GD review). Google
        // only fires dragstart for real gestures, never for our panTo.
        map.addListener('dragstart', () => setFollowing(false));

        // Loop mode (Screen 8b) draws one marker PER shuttle in its own
        // effect — the single freshest-fix marker would duplicate one of them.
        if (!loopModeRef.current) {
          markerRef.current = new AdvancedMarkerElement({
            map,
            position: { lat: pos.latitude, lng: pos.longitude },
            content: markerDiv(
              'width:38px;height:38px;display:flex;align-items:center;justify-content:center;'
              + 'background:#1a7f37;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.35);font-size:19px',
              '🚐',
            ),
          });
        }
        lastFix.current = pos;
      } else if (loopModeRef.current) {
        lastFix.current = pos; // recenter still targets the freshest fix
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

  // ── Phase 3 (Screen 8b): one marker per loop shuttle, per-shuttle age ────
  const loopKey = loopShuttles
    ? JSON.stringify(loopShuttles.map((s2) => (s2.position
      ? [s2.position.latitude, s2.position.longitude, s2.position.ageSeconds]
      : null)))
    : '';
  useEffect(() => {
    if (!loopMode || !MAPS_KEY || !mapReady) return;
    let cancelled = false;
    (async () => {
      const google = await loadGoogleMaps();
      if (!google || cancelled || !mapObj.current) return;
      const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
      if (cancelled || !mapObj.current) return;
      loopShuttles.forEach((s2, i) => {
        const existing = loopMarkersRef.current[i];
        // OFFLINE entries carry no coordinates — a dead dot lies. Remove it.
        if (!s2.position) {
          if (existing) { existing.marker.map = null; loopMarkersRef.current[i] = null; }
          return;
        }
        const ll = { lat: s2.position.latitude, lng: s2.position.longitude };
        const label = shuttleFreshLabel(s2, t);
        const color = s2.status === 'AGING' ? '#b45309' : '#1a7f37';
        if (!existing) {
          const wrap = markerDiv('display:flex;flex-direction:column;align-items:center;gap:3px');
          const bubble = markerDiv(
            'width:34px;height:34px;display:flex;align-items:center;justify-content:center;'
            + `background:${color};border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.35);`
            + 'font-size:15px;font-weight:800;color:#fff',
            String(i + 1),
          );
          const tag = markerDiv(
            'background:#fff;color:#2a2333;font-size:10.5px;font-weight:700;padding:2px 7px;'
            + 'border-radius:999px;box-shadow:0 1px 4px rgba(0,0,0,.25);white-space:nowrap',
            label,
          );
          wrap.appendChild(bubble);
          wrap.appendChild(tag);
          loopMarkersRef.current[i] = {
            marker: new AdvancedMarkerElement({ map: mapObj.current, position: ll, content: wrap }),
            bubble, tag,
          };
        } else {
          existing.marker.position = ll;
          existing.bubble.style.background = color;
          existing.tag.textContent = label;
        }
      });
      // A shrunk list (shuttle removed from the config) drops its markers.
      for (let i = loopShuttles.length; i < loopMarkersRef.current.length; i += 1) {
        if (loopMarkersRef.current[i]) loopMarkersRef.current[i].marker.map = null;
      }
      loopMarkersRef.current.length = loopShuttles.length;
    })();
    return () => { cancelled = true; };
  }, [loopKey, loopMode, mapReady]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Phase 3 (Screen 9): consented sharing ────────────────────────────────
  // The POST carries lat/lng and NOTHING else; the server keeps it in Redis
  // with a short TTL and echoes only { ok, active } back. Best-effort — a
  // dropped push loses nothing durable.
  const postFix = useCallback(async (fix) => {
    try {
      await fetch(`${API_BASE}/api/public/shuttle/${encodeURIComponent(token)}/location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: fix.latitude, lng: fix.longitude }),
      });
    } catch { /* next tick retries */ }
  }, [token]);

  const stopSharing = useCallback((nextGeo = 'stopped') => {
    sharingRef.current = false;
    clearInterval(shareTimerRef.current);
    shareTimerRef.current = 0;
    if (geoWatchId.current !== null) {
      navigator.geolocation?.clearWatch?.(geoWatchId.current);
      geoWatchId.current = null;
    }
    setGeo(nextGeo);
  }, []);

  /**
   * One watch, two callers: the pre-Phase-3 "show where I am" button
   * (share=false — LOCAL blue dot only, nothing leaves the phone) and the
   * Screen 9 consent card (share=true — same dot plus the ~10s POST loop).
   */
  const startWatch = useCallback((share) => {
    if (!navigator.geolocation) { setGeo('denied'); return; }
    setGeo('locating');
    sharingRef.current = share === true;
    geoWatchId.current = navigator.geolocation.watchPosition(
      (fix) => {
        const p = { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
        const first = !userFixRef.current;
        userFixRef.current = p;
        setGeo('on');
        setUserPos(p);
        if (first && sharingRef.current) postFix(p); // don't sit silent for 10s
      },
      () => stopSharing('denied'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
    if (share === true) {
      clearInterval(shareTimerRef.current);
      shareTimerRef.current = setInterval(() => {
        if (sharingRef.current && userFixRef.current) postFix(userFixRef.current);
      }, SHARE_POST_MS);
    }
  }, [postFix, stopSharing]);

  const shareLocation = () => startWatch(false);

  // Sharing auto-stops (privacy constraints, binding): page hide/unload …
  useEffect(() => {
    const onHide = () => { if (sharingRef.current) stopSharing('stopped'); };
    const onVis = () => { if (document.visibilityState === 'hidden') onHide(); };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [stopSharing]);

  // … and the request closing (completed / cancelled / no-show → not open).
  useEffect(() => {
    if (!requestOpen && sharingRef.current) stopSharing('stopped');
  }, [requestOpen, stopSharing]);

  useEffect(() => () => {
    cancelAnimationFrame(tweenRaf.current);
    clearInterval(shareTimerRef.current);
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
  // The body is the caller's: the legacy one-tap button sends { partySize }
  // and NOTHING else (the pre-Phase-3 contract, byte-for-byte); the intake
  // flow (Screen 7) sends party/bags/smsOptIn and, when the payload named a
  // spot, pickupSpotZoneId. Identity always comes from the token.
  const requestShuttle = async (body) => {
    if (reqStatus === 'sending') return;
    setReqStatus('sending');
    try {
      const res = await fetch(`${API_BASE}/api/public/shuttle/${encodeURIComponent(token)}/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || { partySize: party }),
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
      const ok = out?.ok === true;
      setReqStatus(ok ? (out.deduplicated ? 'again' : 'done') : 'failed');
      if (ok) setIntakeOpen(false); // the status line takes over (Screen 7 → 8a)
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
    // NEW #6 (2026-08-24): larger accessibility-friendly type on the lines a
    // customer reads at a curb in sunlight (14→15.5 notes/instructions, 17→18
    // title) — approved mockup Screen 3 "bigtype".
    h1: { margin: 0, fontSize: 18, fontWeight: 700 },
    langWrap: { display: 'flex', border: '1px solid #d8d3e0', borderRadius: 999, overflow: 'hidden', flexShrink: 0 },
    langBtn: (active) => ({ minHeight: 34, padding: '6px 12px', fontSize: 12, fontWeight: 700, border: 'none', cursor: 'pointer', background: active ? '#5b21b6' : '#fff', color: active ? '#fff' : '#5b5266' }),
    note: { margin: '6px 0 0', fontSize: 15.5, lineHeight: 1.5, color: '#5b5266' },
    where: { margin: '14px 0 0', padding: '10px 12px', background: '#f4f2f7', borderRadius: 10, fontSize: 15.5, lineHeight: 1.5 },
    whereTag: { display: 'block', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#5b5266', fontWeight: 700, marginBottom: 2 },
    // NEW #1: tenant brand bar above the map.
    brandBar: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', background: '#fff', borderBottom: '1px solid #eee9f5', fontSize: 14, fontWeight: 800, color: '#2a2333' },
    brandSub: { marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: '#5b5266' },
    // NEW #2: request-state status line + 3-step progress.
    statusLine: { marginTop: 13, padding: '11px 13px', borderRadius: 12, fontSize: 15, fontWeight: 600, background: '#e7f6ec', color: '#166b2f', display: 'flex', alignItems: 'center', gap: 8 },
    steps: { display: 'flex', alignItems: 'flex-start', marginTop: 12 },
    step: (state_) => ({ flex: 1, textAlign: 'center', fontSize: 11.5, fontWeight: 700, color: state_ === 'todo' ? '#5b5266' : '#5b21b6', position: 'relative' }),
    stepDot: (state_) => ({ width: 12, height: 12, borderRadius: '50%', background: state_ === 'todo' ? '#d8d3e0' : '#5b21b6', margin: '0 auto 4px', position: 'relative', zIndex: 1 }),
    stepBar: (state_) => ({ content: '""', position: 'absolute', top: 5, left: '-50%', width: '100%', height: 2, background: state_ === 'todo' ? '#d8d3e0' : '#5b21b6', zIndex: 0 }),
    // NEW #5: tel: fallback to the counter.
    telBtn: { marginTop: 12, width: '100%', minHeight: 46, padding: '11px 14px', fontSize: 15, fontWeight: 700, color: '#2a2333', background: '#f4f2f7', border: '1px solid #d8d3e0', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, textDecoration: 'none', boxSizing: 'border-box' },
    geoBtn: { marginTop: 12, width: '100%', minHeight: 44, padding: '10px 14px', fontSize: 14, fontWeight: 700, color: '#5b21b6', background: '#fff', border: '2px solid #5b21b6', borderRadius: 12, cursor: 'pointer' },
    geoInfo: { marginTop: 10, padding: '10px 12px', background: '#eaf1fe', color: '#173e8a', borderRadius: 10, fontSize: 15, lineHeight: 1.5 },
    btn: (sending) => ({ marginTop: 16, width: '100%', minHeight: 48, padding: '14px 16px', fontSize: 16, fontWeight: 700, color: '#fff', background: '#5b21b6', opacity: sending ? 0.7 : 1, border: 'none', borderRadius: 12, cursor: sending ? 'default' : 'pointer' }),
    ok: { marginTop: 16, padding: '12px 14px', background: '#e7f6ec', color: '#166b2f', borderRadius: 12, fontSize: 15, fontWeight: 600, textAlign: 'center' },
    partyRow: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 14 },
    partySelect: { fontSize: 15, minHeight: 44, padding: '8px 14px', borderRadius: 10, border: '1px solid #d8d3e0', background: '#fff', color: '#2a2333' },
    center: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' },
    // ── Phase 3 (2026-08-25) — Screens 7 / 8a / 8b / 9 / 16 ────────────────
    arrival: { margin: '0 0 14px', padding: '18px 16px', background: '#0f8a68', color: '#fff', borderRadius: 14, textAlign: 'center', animation: 'shuttleArrive .6s ease-out 1' },
    arrivalTitle: { fontSize: 22, fontWeight: 800, lineHeight: 1.25 },
    arrivalSub: { marginTop: 6, fontSize: 16, fontWeight: 700 },
    assignChip: { marginTop: 10, display: 'inline-block', background: '#efe7ff', color: '#5b21b6', fontWeight: 800, fontSize: 14, padding: '8px 12px', borderRadius: 999 },
    goCard: { marginTop: 13, padding: '11px 13px', borderRadius: 12, fontSize: 15, fontWeight: 700, background: '#efe7ff', color: '#5b21b6' },
    loopRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 10px', borderBottom: '1px solid #eee9f5', fontSize: 15 },
    consentCard: { marginTop: 14, padding: 14, border: '2px solid #5b21b6', borderRadius: 14, background: '#faf8ff' },
    consentTitle: { fontSize: 16, fontWeight: 800, color: '#2a2333', lineHeight: 1.35 },
    consentBody: { marginTop: 6, fontSize: 14.5, lineHeight: 1.5, color: '#5b5266' },
    consentPriv: { marginTop: 10, fontSize: 12.5, lineHeight: 1.45, color: '#5b5266' },
    noThanks: { marginTop: 6, width: '100%', minHeight: 40, background: 'none', border: 'none', color: '#5b5266', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
    sharePill: { marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 10px 9px 14px', background: '#eaf1fe', color: '#173e8a', borderRadius: 999, fontSize: 14.5, fontWeight: 700 },
    stopBtn: { minHeight: 36, padding: '6px 14px', background: '#fff', color: '#173e8a', border: '1px solid #9db9ea', borderRadius: 999, fontWeight: 700, fontSize: 13, cursor: 'pointer' },
    stepDots: { display: 'flex', gap: 8, justifyContent: 'center', margin: '14px 0 2px' },
    stepDotI: (on) => ({ width: 10, height: 10, borderRadius: '50%', background: on ? '#5b21b6' : '#d8d3e0' }),
    intakeTitle: { margin: '12px 0 2px', fontSize: 19, fontWeight: 800, textAlign: 'center' },
    intakeField: { margin: '12px 0 0', padding: '11px 13px', background: '#f4f2f7', borderRadius: 12, fontSize: 16, fontWeight: 700 },
    smsRow: { display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 18, fontSize: 14.5, lineHeight: 1.4, cursor: 'pointer' },
    smsBox: { width: 22, height: 22, marginTop: 1, flexShrink: 0, accentColor: '#5b21b6' },
    backBtn: { marginTop: 8, width: '100%', minHeight: 40, background: 'none', border: 'none', color: '#5b5266', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
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
  // NEW #7: display age = payload age + seconds since the payload landed, so
  // the chip counts up honestly between polls instead of freezing.
  const displayAgeSec = Math.max(0, (state.position?.ageSeconds ?? 0)
    + Math.floor(Math.max(0, nowTick - payloadAtRef.current) / 1000));
  const ageMin = Math.floor(displayAgeSec / 60);
  const transmitting = state.status !== 'OFFLINE' && state.position;
  const badge = stale
    ? { bg: '#8a8394', text: t('reconnecting') }
    : (transmitting && ageMin >= 1) ? { bg: '#b45309', text: t('agingMin', { m: ageMin }) }
      : transmitting ? { bg: '#1a7f37', text: t('liveUpdated', { s: displayAgeSec }) }
        : null;

  const walkMeters = (userPos && pickup) ? metersBetween(userPos, pickup) : null;

  // NEW #1: tenant brand — the backend cascade never yields the platform
  // name, and tenantBrandName filters it again client-side. Empty = no bar.
  const brand = tenantBrandName({ companyName: state.brandName });

  // NEW #2: progress from the EXISTING request state machine (requestStatus
  // itself is hoisted above the effects — Phase 3 needs it there).
  const statusCopy = requestStatus === 'READY' ? t('statusReceived')
    : requestStatus === 'VIEWED' ? t('statusOnWay')
      : requestStatus === 'COMPLETED' ? t('statusPickedUp') : null;
  const stepStates = requestStatus === 'READY' ? ['now', 'todo', 'todo']
    : requestStatus === 'VIEWED' ? ['done', 'now', 'todo']
      : requestStatus === 'COMPLETED' ? ['done', 'done', 'now'] : null;
  const stepLabels = [t('stepRequested'), t('stepOnWay'), t('stepPickedUp')];

  // NEW #3: "look for the white Ford Transit · plate IKT-482". Sede-written
  // color stays as written (no translation), lowercased to read as prose.
  const vehicleDesc = state.vehicle
    ? [String(state.vehicle.color || '').toLowerCase(), state.vehicle.name].filter(Boolean).join(' ')
    : '';

  // NEW #5: tel: wants digits (+ leading +); the label shows the pretty form.
  const telHref = state.counterPhone ? `tel:${String(state.counterPhone).replace(/[^\d+]/g, '')}` : null;

  return (
    <div style={S.page}>
      {brand ? (
        <div style={S.brandBar}>
          {brand}
          <span style={S.brandSub}>{t('trackerSub')}</span>
        </div>
      ) : null}
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
          {/* Phase 3 (Screen 16): the geofence payoff. One-shot entrance
              animation; the banner itself persists while the payload keeps
              saying arrived. */}
          {state.arrivedAtSpot && (
            <div style={S.arrival} role="alert" data-testid="arrival-banner">
              <style>{'@keyframes shuttleArrive{0%{transform:scale(.92);opacity:0}60%{transform:scale(1.03)}100%{transform:scale(1);opacity:1}}'}</style>
              <div style={S.arrivalTitle}>🚐 {t('arrivedTitle')}</div>
              {state.arrivedSpotName && (
                <div style={S.arrivalSub}>{t('arrivedGo', { spot: state.arrivedSpotName })}</div>
              )}
            </div>
          )}
          {offline && <div style={{ fontSize: 34, marginBottom: 6 }}>🚐</div>}
          <div style={S.headRow}>
            <h1 style={S.h1}>{state.locationName}</h1>
            {langToggle}
          </div>
          {/* Phase 3 (Screen 8a): the manual assignment, named. */}
          {state.assigned && (
            <div style={S.assignChip} data-testid="assigned-chip">
              🚐 {t('assignedTo', { name: state.vehicle?.name || 'Shuttle' })}
            </div>
          )}
          {!transmitting ? (
            <>
              <p style={{ ...S.note, fontWeight: 600 }}>{t('offlineTitle')}</p>
              <p style={S.note}>{t('offlineBody', { n: headway })}</p>
            </>
          ) : (
            <p style={S.note}>{t('headwayNote', { n: headway })}</p>
          )}
          {/* Phase 3 (Screen 8b): the loop — guidance card + per-shuttle
              freshness rows (the card list keeps working with no map key). */}
          {loopMode && (
            <>
              {spotName && (
                <div style={S.goCard} data-testid="go-to-spot">{t('goToSpot', { spot: spotName })}</div>
              )}
              <p style={S.note}>{t('loopNote')}</p>
              <div style={{ marginTop: 8 }}>
                {loopShuttles.map((s2, i) => (
                  <div key={s2.plate || s2.name || i} style={S.loopRow} data-testid="loop-shuttle">
                    <span style={{ fontWeight: 600 }}>
                      🚐 {s2.name || `${i + 1}`}{s2.plate ? ` · ${s2.plate}` : ''}
                    </span>
                    <span style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', color: s2.status === 'LIVE' ? '#1a7f37' : s2.status === 'AGING' ? '#b45309' : '#8a8394' }}>
                      {shuttleFreshLabel(s2, t)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          {statusCopy && (
            <>
              <div style={S.statusLine} role="status">{statusCopy}</div>
              <div style={S.steps} aria-hidden="true">
                {stepStates.map((st, i) => (
                  <div key={stepLabels[i]} style={S.step(st)}>
                    {i > 0 && <span style={S.stepBar(st)} />}
                    <div style={S.stepDot(st)} />
                    {stepLabels[i]}
                  </div>
                ))}
              </div>
            </>
          )}
          {vehicleDesc && (
            <p style={{ ...S.note, marginTop: 12 }}>
              {t('lookFor', { desc: '' })}<strong>{vehicleDesc}</strong>
              {state.vehicle?.plate ? <> · {t('plateWord')} <strong>{state.vehicle.plate}</strong></> : null}
            </p>
          )}
          {state.pickupInstructions && (
            <div style={S.where}>
              <span style={S.whereTag}>{t('where')}</span>
              {state.pickupInstructions}
            </div>
          )}
          {state.walkingDirections && (
            <div style={{ ...S.where, marginTop: 8, whiteSpace: 'pre-line' }}>
              <span style={S.whereTag}>{t('howToGetThere')}</span>
              {state.walkingDirections}
            </div>
          )}
          {/* Phase 3 (Screen 9): with an OPEN request, sharing has a server
              side — consent card → active pill (+ server distance) → denied
              fallback with no nagging. Without one, the endpoint would 404,
              so the pre-Phase-3 LOCAL-only button stays exactly as it was. */}
          {requestOpen ? (
            <>
              {geo === 'idle' && (
                <div style={S.consentCard} data-testid="consent-card">
                  <div style={S.consentTitle}>{t('consentTitle')}</div>
                  <div style={S.consentBody}>{t('consentBody')}</div>
                  <button type="button" style={{ ...S.btn(false), marginTop: 12 }} onClick={() => startWatch(true)}>{t('consentShare')}</button>
                  <button type="button" style={S.noThanks} onClick={() => setGeo('off')}>{t('consentNo')}</button>
                  <div style={S.consentPriv}>🔒 {t('consentPriv')}</div>
                </div>
              )}
              {geo === 'stopped' && (
                <button type="button" style={S.geoBtn} onClick={() => startWatch(true)}>📍 {t('consentShare')}</button>
              )}
              {geo === 'locating' && <p style={{ ...S.note, textAlign: 'center' }} role="status">{t('locating')}</p>}
              {geo === 'denied' && (
                <>
                  <p style={{ ...S.note, textAlign: 'center' }} role="status">⚠ {t('locationDenied')}</p>
                  <p style={{ ...S.note, textAlign: 'center' }}>{t('sharingFallback')}</p>
                </>
              )}
              {geo === 'on' && (
                <>
                  <div style={S.sharePill} data-testid="sharing-pill">
                    <span>{t('sharingPill')}</span>
                    <button type="button" style={S.stopBtn} onClick={() => stopSharing('stopped')}>{t('sharingStop')}</button>
                  </div>
                  <div style={S.geoInfo} role="status" data-testid="sharing-distance">
                    {state.locationSharing?.active === true && Number.isFinite(state.locationSharing?.distanceMeters)
                      ? `🚐 ${t('shuttleDistance', { d: formatDistance(state.locationSharing.distanceMeters) })}`
                      : walkMeters !== null
                        ? t('distanceAway', { d: formatDistance(walkMeters) })
                        : t('youAreHere')}
                  </div>
                </>
              )}
            </>
          ) : (
            <>
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
            </>
          )}
          {/* NEW #2: an OPEN request (READY/VIEWED) is already telling its
              story in the status line above — no second button. COMPLETED or
              no request at all keeps the request UI available. */}
          {/* Phase 3 (Screen 7): the intake flow exists ONLY when the payload
              says the sede opted in — anything else keeps the pre-Phase-3
              one-tap request untouched. */}
          {state.mode === 'ON_DEMAND' && requestStatus !== 'READY' && requestStatus !== 'VIEWED' && (
            intakeEnabled ? (
              !intakeOpen ? (
                <>
                  <button type="button" style={S.btn(false)} data-testid="intake-start" onClick={() => { setIntakeOpen(true); setIntakeStep(0); }}>
                    {t('request')}
                  </button>
                  {reqStatus === 'cooldown' && <p style={{ ...S.note, textAlign: 'center' }} role="status">{t('tooFast')}</p>}
                  {reqStatus === 'failed' && <p style={{ ...S.note, textAlign: 'center', color: '#b3261e' }} role="status">{t('failed')}</p>}
                </>
              ) : (() => {
                // Step 1 (confirm) only exists when the payload carries the
                // reservation's name (contract gap: it does not today — the
                // flow tolerantly starts at the steppers). Identity is never
                // typed in; the token is the identity.
                const steps = state.customerName ? ['confirm', 'counts', 'spot'] : ['counts', 'spot'];
                const stepIdx = Math.min(intakeStep, steps.length - 1);
                const step = steps[stepIdx];
                const back = () => (stepIdx === 0 ? setIntakeOpen(false) : setIntakeStep(stepIdx - 1));
                return (
                  <div data-testid="intake-flow">
                    <div style={S.stepDots} aria-hidden="true">
                      {steps.map((name, i) => <span key={name} style={S.stepDotI(i === stepIdx)} />)}
                    </div>
                    {step === 'confirm' && (
                      <>
                        <h2 style={S.intakeTitle}>{t('intakeConfirmTitle')}</h2>
                        <div style={S.intakeField}>
                          <span style={S.whereTag}>{t('intakeNameLabel')}</span>
                          {state.customerName}
                        </div>
                        <p style={S.note}>{t('intakePrefilled')}</p>
                        <button type="button" style={S.btn(false)} data-testid="intake-continue" onClick={() => setIntakeStep(stepIdx + 1)}>{t('intakeContinue')}</button>
                        <button type="button" style={S.backBtn} onClick={back}>{t('intakeBack')}</button>
                      </>
                    )}
                    {step === 'counts' && (
                      <>
                        <h2 style={S.intakeTitle}>{t('intakePeople')}</h2>
                        <Stepper value={iParty} min={1} max={partyCap} onChange={setIParty} testId="party" decLabel={`${t('stepFewer')} · ${t('intakePeople')}`} incLabel={`${t('stepMore')} · ${t('intakePeople')}`} />
                        <h2 style={S.intakeTitle}>{t('intakeBags')}</h2>
                        <Stepper value={iBags} min={0} max={bagsCap} onChange={setIBags} testId="bags" decLabel={`${t('stepFewer')} · ${t('intakeBags')}`} incLabel={`${t('stepMore')} · ${t('intakeBags')}`} />
                        <label style={S.smsRow}>
                          <input type="checkbox" style={S.smsBox} checked={smsOpt} onChange={(e) => setSmsOpt(e.target.checked)} data-testid="sms-optin" />
                          <span>{t('smsOptIn')}</span>
                        </label>
                        <button type="button" style={S.btn(false)} data-testid="intake-continue" onClick={() => setIntakeStep(stepIdx + 1)}>{t('intakeContinue')}</button>
                        <button type="button" style={S.backBtn} onClick={back}>{t('intakeBack')}</button>
                      </>
                    )}
                    {step === 'spot' && (
                      <>
                        <h2 style={S.intakeTitle} data-testid="intake-spot-title">
                          {spotName ? t('intakeGoTo', { spot: spotName }) : t('intakeGoGeneric')}
                        </h2>
                        {spotDirections ? (
                          <div style={{ ...S.where, whiteSpace: 'pre-line' }}>
                            <span style={S.whereTag}>{t('howToGetThere')}</span>
                            {spotDirections}
                          </div>
                        ) : state.pickupInstructions ? (
                          <div style={S.where}>
                            <span style={S.whereTag}>{t('where')}</span>
                            {state.pickupInstructions}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          style={S.btn(reqStatus === 'sending')}
                          disabled={reqStatus === 'sending'}
                          data-testid="intake-submit"
                          onClick={() => requestShuttle({
                            partySize: iParty,
                            bags: iBags,
                            smsOptIn: smsOpt,
                            ...(spotZoneId ? { pickupSpotZoneId: spotZoneId } : {}),
                          })}
                        >
                          {reqStatus === 'sending' ? t('requesting') : t('request')}
                        </button>
                        {reqStatus === 'cooldown' && <p style={{ ...S.note, textAlign: 'center' }} role="status">{t('tooFast')}</p>}
                        {reqStatus === 'failed' && <p style={{ ...S.note, textAlign: 'center', color: '#b3261e' }} role="status">{t('failed')}</p>}
                        <button type="button" style={S.backBtn} onClick={back}>{t('intakeBack')}</button>
                      </>
                    )}
                  </div>
                );
              })()
            ) : (
              <>
                <div style={S.partyRow}>
                  <label htmlFor="shuttle-party">{t('party')}</label>
                  <select id="shuttle-party" value={party} onChange={(e) => setParty(Number(e.target.value))} style={S.partySelect}>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <button type="button" style={S.btn(reqStatus === 'sending')} disabled={reqStatus === 'sending'} onClick={() => requestShuttle({ partySize: party })}>
                  {reqStatus === 'sending' ? t('requesting') : t('request')}
                </button>
                {reqStatus === 'cooldown' && <p style={{ ...S.note, textAlign: 'center' }} role="status">{t('tooFast')}</p>}
                {reqStatus === 'failed' && <p style={{ ...S.note, textAlign: 'center', color: '#b3261e' }} role="status">{t('failed')}</p>}
              </>
            )
          )}
          {/* NEW #5: one-tap fallback to a human at the counter. */}
          {telHref && (
            <a href={telHref} style={S.telBtn}>{t('callCounter')}</a>
          )}
        </div>
      </div>
    </div>
  );
}
