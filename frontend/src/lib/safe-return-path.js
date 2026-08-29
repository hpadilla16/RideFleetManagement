/**
 * Validate a "come back here afterwards" path before navigating to it.
 *
 * Step 4 of the checkout can open the vehicle inspection on the SAME device —
 * an agent working alone on a tablet has nothing left to scan the QR with
 * (Hector, 2026-08-19) — and passes the wizard's path as `?return=`. The
 * inspection page is reachable with nothing but a handoff token, so a return
 * URL taken on faith would be an open redirect anyone holding a token could
 * aim at a look-alike login.
 *
 * Only a same-site path survives. Anything else returns '' and the caller
 * falls back to its previous behaviour — refusing must never leave someone
 * stranded on a dead end.
 */
const BACKSLASH = String.fromCharCode(92);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

export function safeReturnPath(raw) {
  const s = String(raw || '');
  if (!s.startsWith('/')) return '';         // absolute URLs and bare words out
  if (s.startsWith('//')) return '';         // protocol-relative points at another host
  if (s.includes(BACKSLASH)) return '';      // some browsers normalise \ to /
  if (s.includes(':')) return '';            // javascript: and friends
  if (s.includes(CR) || s.includes(LF)) return ''; // URL / header splitting
  return s;
}

export default safeReturnPath;
