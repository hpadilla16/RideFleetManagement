/**
 * Embedded-Postgres boot helper for node:test integration tests.
 *
 * Boots a throwaway Postgres on a free port, sets DATABASE_URL, applies the
 * Prisma schema with `prisma db push`, generates the client, and returns a
 * connected PrismaClient plus a stop() to tear everything down.
 *
 * Per repo convention, callers install embedded-postgres + run prisma via:
 *   npm install --no-save embedded-postgres   (inside backend/)
 *   npx prisma db push --skip-generate --accept-data-loss
 *   npx prisma generate
 * This helper performs the db push + generate; the install + node --test
 * invocation lives in the run script.
 */

import net from 'node:net';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_DIR = path.join(__dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function bootEmbeddedPg() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = await freePort();
  const os = await import('node:os');
  const fs = await import('node:fs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfm-pg-'));

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('rfm_test');

  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/rfm_test`;
  process.env.DATABASE_URL = databaseUrl;

  // Apply schema + generate client against this DB.
  execFileSync(
    'npx',
    ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: BACKEND_DIR, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit' }
  );
  execFileSync('npx', ['prisma', 'generate'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit'
  });

  const mod = await import('@prisma/client');
  const prisma = new mod.PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();

  async function stop() {
    try { await prisma.$disconnect(); } catch { /* ignore */ }
    try { await pg.stop(); } catch { /* ignore */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return { prisma, databaseUrl, port, stop };
}
