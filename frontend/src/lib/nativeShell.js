// Native app shell helpers (Capacitor wrapper, 2026-07-05).
//
// The employee mobile app is the hosted web frontend running inside the
// Capacitor WebView (frontend/capacitor.config.js). The native runtime injects
// `window.Capacitor` into the page — we NEVER import @capacitor/* npm packages
// in web code. Everything here feature-detects the injected global so the same
// bundle runs on the plain web (where all of this is a no-op).
//
// WKWebView evicts localStorage under storage pressure and after long
// backgrounding, which would randomly log employees out. The auth bridge
// mirrors the JWT + user into native storage (Capacitor Preferences plugin)
// and rehydrates localStorage on boot.

// Keys duplicated from lib/client.js to avoid a circular import
// (client.js -> nativeShell.js -> client.js).
const TOKEN_KEY = 'fleet_jwt';
const USER_KEY = 'fleet_user';
const SHELL_FLAG_KEY = 'fleet_shell';

export function isNativePlatform() {
  if (typeof window === 'undefined') return false;
  try {
    return window.Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

// Employee app shell = native app, or a browser session forced into shell mode
// with ?shell=employee (persisted; ?shell=off clears it) for development and QA
// without a device build.
export function isEmployeeShell() {
  if (typeof window === 'undefined') return false;
  if (isNativePlatform()) return true;
  try {
    return localStorage.getItem(SHELL_FLAG_KEY) === 'employee';
  } catch {
    return false;
  }
}

// Reads ?shell=employee|off from the current URL and persists the override.
// Returns true when the flag changed (caller may want to re-render).
export function applyShellQueryOverride() {
  if (typeof window === 'undefined') return false;
  try {
    const shell = new URLSearchParams(window.location.search).get('shell');
    if (!shell) return false;
    const current = localStorage.getItem(SHELL_FLAG_KEY);
    if (shell === 'employee' && current !== 'employee') {
      localStorage.setItem(SHELL_FLAG_KEY, 'employee');
      return true;
    }
    if (shell === 'off' && current) {
      localStorage.removeItem(SHELL_FLAG_KEY);
      return true;
    }
  } catch {}
  return false;
}

function preferencesPlugin() {
  if (!isNativePlatform()) return null;
  try {
    const cap = window.Capacitor;
    if (typeof cap?.isPluginAvailable === 'function' && !cap.isPluginAvailable('Preferences')) return null;
    return cap?.Plugins?.Preferences || null;
  } catch {
    return null;
  }
}

// Mirrors the current localStorage auth into native Preferences. Safe to call
// often (login, token refresh, app backgrounding); no-op on the plain web.
export async function mirrorAuthToNative() {
  const prefs = preferencesPlugin();
  if (!prefs) return;
  try {
    const token = localStorage.getItem(TOKEN_KEY) || '';
    const user = localStorage.getItem(USER_KEY) || '';
    if (token) {
      await prefs.set({ key: TOKEN_KEY, value: token });
      if (user) await prefs.set({ key: USER_KEY, value: user });
    } else {
      await prefs.remove({ key: TOKEN_KEY });
      await prefs.remove({ key: USER_KEY });
    }
  } catch {}
}

// Explicit logout must also clear the native mirror, otherwise the next boot
// would rehydrate a session the user signed out of.
export async function clearNativeAuth() {
  const prefs = preferencesPlugin();
  if (!prefs) return;
  try {
    await prefs.remove({ key: TOKEN_KEY });
    await prefs.remove({ key: USER_KEY });
  } catch {}
}

// Boot-time restore: if the WebView evicted localStorage but native storage
// still has the session, put it back BEFORE AuthGate reads localStorage.
// Returns true when a session was restored.
export async function rehydrateAuthFromNative() {
  const prefs = preferencesPlugin();
  if (!prefs) return false;
  try {
    if (localStorage.getItem(TOKEN_KEY)) return false;
    const { value: token } = await prefs.get({ key: TOKEN_KEY });
    if (!token) return false;
    localStorage.setItem(TOKEN_KEY, token);
    const { value: user } = await prefs.get({ key: USER_KEY });
    if (user) localStorage.setItem(USER_KEY, user);
    return true;
  } catch {
    return false;
  }
}

let bridgeStarted = false;

// Keeps the native mirror fresh: mirrors on backgrounding (the moment before
// WKWebView may evict storage). Call once from AuthGate's boot effect.
export function startNativeAuthBridge() {
  if (bridgeStarted || !isNativePlatform()) return;
  bridgeStarted = true;
  const onHide = () => {
    if (document.visibilityState === 'hidden') mirrorAuthToNative();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', () => mirrorAuthToNative());
}
