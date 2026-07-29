/**
 * NU SFTP transport (2026-07-27, NU confirmed SFTP at sftp.nucarrentals.com).
 *
 * NU drops ONE .REZ file per reservation/change; we list, download, parse, and
 * DELETE each file — delete-after-download IS the dedup mechanism (NU keeps a
 * file until we remove it), so there is no processed-file ledger to maintain.
 *
 * DORMANT UNTIL ACTIVATED: the ssh2-sftp-client dep is imported LAZILY (same
 * pattern as the tolls puppeteer client) so this module loads and the app boots
 * even before the dep is installed. NU_TRANSPORT defaults to 'http' (the
 * existing RadGrid scraper), so nothing here runs in prod until:
 *   1) npm i ssh2-sftp-client   (on the droplet)
 *   2) NU credentials set (encrypted) + NU_SFTP_HOST/PORT/DIR env
 *   3) NU_TRANSPORT=sftp
 * Then flip and shadow-diff via NU_TRANSPORT before cutover.
 */
import {
  SFTP_HOST, SFTP_PORT, SFTP_DIR, SFTP_FILE_GLOB
} from './nu.constants.js';

let _SftpClient = null;
async function resolveSftpClient() {
  if (_SftpClient) return _SftpClient;
  try {
    const mod = await import('ssh2-sftp-client');
    _SftpClient = mod.default || mod;
  } catch {
    throw new Error('ssh2-sftp-client is not installed on the backend — run `npm i ssh2-sftp-client` before enabling NU_TRANSPORT=sftp');
  }
  return _SftpClient;
}

function isRezFile(name) {
  return SFTP_FILE_GLOB.test(String(name || ''));
}

/**
 * Join the drop directory and a file name into the remote path we ask the
 * server for.
 *
 * 2026-07-29 (first live NU file): NU's SFTP server resolves a './' prefix to
 * the DIRECTORY, not the file — `stat('./x.REZ')` came back mode 40777/size 8
 * while `stat('x.REZ')` and `stat('/x.REZ')` came back mode 100777/size 733,
 * and `get('./x.REZ')` failed "Permission denied". Since the login already
 * lands inside the drop folder (NU_SFTP_DIR='.'), the naive `${dir}/${name}`
 * produced exactly that poisoned path and every sweep silently downloaded
 * nothing — the file stayed on the server and the run logged fetched: 0.
 *
 * A dot/empty dir therefore means "the login directory": emit the BARE name.
 * Pure + exported for tests.
 */
export function remotePath(dir, name) {
  const d = String(dir ?? '').trim();
  const base = String(name ?? '');
  if (!d || d === '.' || d === './') return base;
  return d.endsWith('/') ? `${d}${base}` : `${d}/${base}`;
}

/**
 * Connect, run fn(client), always disconnect. `creds` = { username, password }.
 */
export async function withSftp(creds, fn, opts = {}) {
  const Client = await resolveSftpClient();
  const client = new Client('nu-sftp');
  try {
    await client.connect({
      host: opts.host || SFTP_HOST,
      port: Number(opts.port || SFTP_PORT) || 22,
      username: creds?.username || '',
      password: creds?.password || '',
      readyTimeout: 20000,
      // NU is a managed SFTP host; accept its host key on first connect. If NU
      // later publishes a fixed fingerprint, pin it here.
    });
    return await fn(client);
  } finally {
    try { await client.end(); } catch { /* best effort */ }
  }
}

/** List the .REZ files currently in the drop directory. */
export async function listRezFiles(creds, opts = {}) {
  const dir = opts.dir || SFTP_DIR;
  return withSftp(creds, async (client) => {
    const entries = await client.list(dir);
    return entries
      .filter((e) => e.type === '-' && isRezFile(e.name))
      .map((e) => ({ name: e.name, size: e.size, modifyTime: e.modifyTime }));
  }, opts);
}

/**
 * Download every .REZ file, hand its text to `onFile(name, content)`, and
 * DELETE it only after onFile resolves without throwing (so a parse/ingest
 * failure leaves the file for the next run instead of losing it). Returns
 * { downloaded, deleted, failures }.
 */
export async function drainRezFiles(creds, onFile, opts = {}) {
  const dir = opts.dir || SFTP_DIR;
  const maxFiles = Number(opts.maxFiles || 1000);
  return withSftp(creds, async (client) => {
    const entries = (await client.list(dir))
      .filter((e) => e.type === '-' && isRezFile(e.name))
      .slice(0, maxFiles);
    let downloaded = 0;
    let deleted = 0;
    const failures = [];
    for (const entry of entries) {
      const remote = remotePath(dir, entry.name);
      try {
        const buf = await client.get(remote);
        const content = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
        downloaded += 1;
        await onFile(entry.name, content);
        await client.delete(remote);
        deleted += 1;
      } catch (err) {
        failures.push({ name: entry.name, error: String(err?.message || err) });
      }
    }
    return { downloaded, deleted, failures };
  }, opts);
}
