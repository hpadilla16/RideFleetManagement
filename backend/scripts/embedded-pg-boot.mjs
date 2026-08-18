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
import { createRequire } from 'node:module';
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
    persistent: false,
    // Match production, which is UTF8. Without this, initdb derives the
    // encoding from the host locale — on a Windows box that is WIN1252, and any
    // test fixture carrying a character outside it fails with 22P05 ("no
    // equivalent in encoding WIN1252") against a schema that is fine in prod.
    // The `×` this repo already writes into charge notes survives WIN1252 by
    // luck; an arrow or a dash would not. The C locale comes with it because
    // initdb refuses UTF8 under a WIN1252 locale, and collation order is not
    // something these suites assert on.
    initdbFlags: ['--encoding=UTF8', '--locale=C']
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('rfm_test');

  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/rfm_test`;
  process.env.DATABASE_URL = databaseUrl;

  // Apply schema + generate client against this DB.
  //
  // Prisma's own JS entry point is run with THIS node binary, rather than
  // shelling out to `npx`. On Windows npx is a .cmd shim: execFileSync does not
  // apply PATHEXT, so the bare name was ENOENT, and since Node 18.20/20.12/22
  // (CVE-2024-27980) spawning a .cmd without `shell: true` is EINVAL by design.
  // Every `.embedded.test.mjs` in the repo therefore died in before() on this
  // line, on the platform the team develops on. Reaching the entry point
  // directly avoids both, needs no shell to re-parse these arguments, and drops
  // npx's registry lookup — see `bin` in prisma/package.json.
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const runPrisma = (args) => execFileSync(process.execPath, [prismaCli, ...args], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit'
  });
  runPrisma(['db', 'push', '--skip-generate', '--accept-data-loss']);
  runPrisma(['generate']);

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
