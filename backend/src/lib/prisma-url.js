/**
 * Pure helper for building the Prisma DATABASE_URL with pool + Postgres
 * timeout params. Kept in its own module so unit tests can import it
 * without instantiating PrismaClient (which spawns the query engine).
 */

/**
 * Append Prisma pool + Postgres statement timeout params to a DATABASE_URL.
 *
 * Why connection_limit=6 (per worker process, conservative default):
 *   - Production fan-out: ~2 API droplets x 4 workers = 8 web procs + 1
 *     BullMQ worker proc = 9 Prisma clients. 9 x 6 = 54 PG connections,
 *     leaving headroom against Supabase free-tier pooler cap (~60).
 *   - Raise via DATABASE_POOL_SIZE env when on a paid tier with a larger
 *     pooler. Do NOT raise blindly -- Supabase pgbouncer silently hangs
 *     `prisma db push` when oversubscribed (see memory:
 *     project_supabase_migration_pattern). pool_timeout=10 is the
 *     runtime protection; it does NOT cover `db push` (out of scope here).
 *
 * Also appends Postgres-level guards via the `options` GUC:
 *   - statement_timeout (default 15s) cancels runaway queries
 *   - idle_in_transaction_session_timeout (default 30s) reclaims sockets
 *     held by stuck transactions
 *
 * Exported pure for unit testing -- accepts the URL and an env-like object
 * (defaults to process.env) and returns the new URL string. If any of the
 * four params are already baked into the URL, they are preserved (env
 * overrides are intentionally ignored so deploy-platform config wins).
 *
 * @param {string} url
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {string}
 */
export function appendPoolParams(url, env = process.env) {
  if (!url || typeof url !== 'string') return url;

  const poolSize = env.DATABASE_POOL_SIZE || '6';
  const poolTimeout = env.DATABASE_POOL_TIMEOUT || '10';
  const statementTimeoutMs = env.DATABASE_STATEMENT_TIMEOUT_MS || '15000';
  const idleTxTimeoutMs = env.DATABASE_IDLE_TX_TIMEOUT_MS || '30000';

  const hasConnectionLimit = /[?&]connection_limit=/.test(url);
  const hasPoolTimeout = /[?&]pool_timeout=/.test(url);
  const hasOptions = /[?&]options=/.test(url);

  const additions = [];
  if (!hasConnectionLimit) additions.push(`connection_limit=${poolSize}`);
  if (!hasPoolTimeout) additions.push(`pool_timeout=${poolTimeout}`);
  if (!hasOptions) {
    // `options` is a Postgres GUC carrier. Each `-c key=value` sets a session
    // GUC at connect time. Values are URL-encoded; %20 = space, %3D = '='.
    const optionsValue =
      `-c%20statement_timeout%3D${statementTimeoutMs}` +
      `%20-c%20idle_in_transaction_session_timeout%3D${idleTxTimeoutMs}`;
    additions.push(`options=${optionsValue}`);
  }

  if (hasConnectionLimit || hasPoolTimeout || hasOptions) {
    const limitMatch = url.match(/[?&]connection_limit=([^&]+)/);
    const timeoutMatch = url.match(/[?&]pool_timeout=([^&]+)/);
    const optionsMatch = url.match(/[?&]options=([^&]+)/);
    console.log(
      `[prisma] DATABASE_URL has baked params ` +
      `connection_limit=${limitMatch ? limitMatch[1] : 'no'} ` +
      `pool_timeout=${timeoutMatch ? timeoutMatch[1] : 'no'} ` +
      `options=${optionsMatch ? 'yes' : 'no'} ` +
      `(env DATABASE_POOL_* values ignored for baked-in params)`
    );
  }

  if (additions.length === 0) return url;

  const separator = url.includes('?') ? '&' : '?';
  const appended = `${url}${separator}${additions.join('&')}`;
  // SECURITY (P0): never log the DATABASE_URL or its values — the connection
  // string carries the DB password. Log ONLY the non-sensitive parameter NAMES
  // we appended, so boot diagnostics stay useful without leaking credentials.
  const appendedNames = additions.map((a) => a.split('=')[0]).join(', ');
  console.log(`[prisma] appended pool params to DATABASE_URL: ${appendedNames}`);
  return appended;
}
