/**
 * Stamp a build identity the running app can compare against.
 *
 * Counter tablets keep the same tab open for days. A deploy swaps the server
 * while their browser keeps running the PREVIOUS bundle, and Next answers
 * their requests with "Failed to find Server Action ..." — which reaches the
 * agent as screens that will not load their cars or reservations. It happened
 * on 2026-08-22 and produced 346 errors before anyone connected the two.
 *
 * The value goes to public/build-id.txt (served by whatever deployment is
 * live NOW) and is inlined into the client bundle by next.config.js (frozen
 * at the moment that bundle was built). When they differ, the tab is stale.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

let sha = '';
try {
  sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch { sha = ''; }
const id = `${sha || 'nogit'}-${Date.now()}`;

mkdirSync('public', { recursive: true });
writeFileSync('public/build-id.txt', id, 'utf8');
console.log(`[build] stamped ${id}`);
