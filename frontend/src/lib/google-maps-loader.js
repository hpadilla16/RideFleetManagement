/**
 * Google Maps JS API loader — shared by the public shuttle tracker and the
 * staff Shuttle Monitor (extracted from TrackerClient 2026-08-24 so the
 * monitor reuses the SAME key wiring and bootstrap instead of growing a
 * second copy).
 *
 * This is Google's OFFICIAL inline bootstrap (their documented loader,
 * reformatted) — not a bare script tag. The first prod deploy used a plain
 * <script src=...&loading=async> and importLibrary was not yet a function
 * when onload fired ("t.maps.importLibrary is not a function", 2026-08-16).
 * The bootstrap defines google.maps.importLibrary SYNCHRONOUSLY and only
 * fetches the network script on first use, which removes the race entirely.
 *
 * Key comes from NEXT_PUBLIC_GOOGLE_MAPS_KEY (inlined at BUILD time — the
 * docker image must be built with it present). Without a key both pages
 * degrade to their card-only layouts.
 */

export const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY || '';

let bootstrapped = false;
function ensureMapsBootstrap() {
  if (!MAPS_KEY || bootstrapped || window.google?.maps?.importLibrary) { bootstrapped = true; return; }
  bootstrapped = true;
  /* eslint-disable */
  (g => { var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = document, b = window; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set, e = new URLSearchParams, u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement("script")); e.set("libraries", [...r] + ""); for (k in g) e.set(k.replace(/[A-Z]/g, t => "_" + t[0].toLowerCase()), g[k]); e.set("callback", c + ".maps." + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => h = n(Error(p + " could not load.")); a.nonce = m.querySelector("script[nonce]")?.nonce || ""; m.head.append(a) })); d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)) })({ key: MAPS_KEY, v: "weekly" });
  /* eslint-enable */
}

/** Resolve window.google once ready, or null (no key / blocked network). */
export async function loadGoogleMaps() {
  if (!MAPS_KEY) return null;
  ensureMapsBootstrap();
  try {
    // Force the bootstrap to actually fetch + settle before callers touch
    // importLibrary for their own libraries.
    await window.google.maps.importLibrary('core');
    return window.google;
  } catch {
    return null; // bad key / network blocked — pages degrade to card-only
  }
}
