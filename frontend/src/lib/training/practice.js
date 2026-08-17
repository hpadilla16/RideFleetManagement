/**
 * Ride University practice mode — the client half of the session swap.
 *
 * The app keeps ONE session per origin (fleet_jwt / fleet_user in
 * localStorage), so "practice on the demo tenant" necessarily means swapping
 * the live session out and back. These helpers make the swap total and
 * reversible: the REAL session — token, user, AND the location-switcher
 * selection (QA #4: a stale x-view-location from the real tenant turns every
 * demo list into an inexplicable empty page) — is backed up before the
 * practice token goes in, and exit restores it byte-for-byte.
 *
 * The key constants live in lib/client.js so clearStoredAuth (logout and
 * auth-expiry) wipes practice state with the session — on a shared counter
 * PC, surviving backups meant the next employee could restore the previous
 * employee's real session (QA #3).
 *
 * SUPER_ADMIN tenant impersonation does its own backup dance with
 * superadmin_backup_token; nesting the two swaps would tangle their backups
 * (QA #9), so practice refuses to start while an impersonation is active.
 *
 * If the backup is missing on exit — cleared storage, private browsing —
 * exit degrades to a plain sign-out: worse UX, never a stuck half-session.
 */
import {
  TOKEN_KEY, USER_KEY,
  PRACTICE_FLAG_KEY, PRACTICE_REAL_TOKEN_KEY, PRACTICE_REAL_USER_KEY, PRACTICE_REAL_VIEW_LOCATION_KEY,
} from '../client';

export { PRACTICE_FLAG_KEY };

const VIEW_LOCATION_KEY = 'ui.viewLocationId';
const SUPERADMIN_BACKUP_KEY = 'superadmin_backup_token';

export function inPracticeMode() {
  try { return window.localStorage.getItem(PRACTICE_FLAG_KEY) === '1'; } catch { return false; }
}

/** A super admin mid-impersonation must exit that first — two nested swaps
 *  would each think the other's session is "real". */
export function practiceBlockedByImpersonation() {
  try { return !!window.localStorage.getItem(SUPERADMIN_BACKUP_KEY); } catch { return false; }
}

/** Swap the live session for the practice one. Returns false if refused. */
export function enterPractice({ token, user }) {
  try {
    const ls = window.localStorage;
    if (ls.getItem(SUPERADMIN_BACKUP_KEY)) return false;
    // Never stack swaps: entering practice FROM practice would overwrite the
    // real backup with the practice session and strand the person.
    if (ls.getItem(PRACTICE_FLAG_KEY) === '1') return true;
    ls.setItem(PRACTICE_REAL_TOKEN_KEY, ls.getItem(TOKEN_KEY) || '');
    ls.setItem(PRACTICE_REAL_USER_KEY, ls.getItem(USER_KEY) || '');
    ls.setItem(PRACTICE_REAL_VIEW_LOCATION_KEY, ls.getItem(VIEW_LOCATION_KEY) || '');
    ls.removeItem(VIEW_LOCATION_KEY);
    ls.setItem(TOKEN_KEY, token);
    ls.setItem(USER_KEY, JSON.stringify(user));
    ls.setItem(PRACTICE_FLAG_KEY, '1');
    return true;
  } catch { return false; }
}

/** Restore the real session. Returns true when a session was restored. */
export function exitPractice() {
  try {
    const ls = window.localStorage;
    const realToken = ls.getItem(PRACTICE_REAL_TOKEN_KEY);
    const realUser = ls.getItem(PRACTICE_REAL_USER_KEY);
    const realViewLocation = ls.getItem(PRACTICE_REAL_VIEW_LOCATION_KEY);
    ls.removeItem(PRACTICE_FLAG_KEY);
    ls.removeItem(PRACTICE_REAL_TOKEN_KEY);
    ls.removeItem(PRACTICE_REAL_USER_KEY);
    ls.removeItem(PRACTICE_REAL_VIEW_LOCATION_KEY);
    if (realToken) {
      ls.setItem(TOKEN_KEY, realToken);
      if (realUser) ls.setItem(USER_KEY, realUser);
      if (realViewLocation) ls.setItem(VIEW_LOCATION_KEY, realViewLocation);
      else ls.removeItem(VIEW_LOCATION_KEY);
      return true;
    }
    // No backup to restore — leave the person signed out rather than signed
    // into the practice account without knowing it.
    ls.removeItem(TOKEN_KEY);
    ls.removeItem(USER_KEY);
    ls.removeItem(VIEW_LOCATION_KEY);
    return false;
  } catch { return false; }
}
