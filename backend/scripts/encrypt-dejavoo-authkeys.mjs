#!/usr/bin/env node
/**
 * Encrypt-at-rest migration for DejavooTerminal.authKeyEnc (2026-05-21).
 *
 * Reads every DejavooTerminal row. If `authKeyEnc` is plaintext (no
 * `enc:v1:` prefix) and is non-empty, encrypts it with the project's
 * INTEGRATION_ENC_KEY and writes back the prefixed ciphertext.
 *
 * Idempotent: rows already encrypted are skipped.
 *
 * Usage:
 *   node backend/scripts/encrypt-dejavoo-authkeys.mjs                  # dry-run
 *   node backend/scripts/encrypt-dejavoo-authkeys.mjs --commit          # apply
 *   node backend/scripts/encrypt-dejavoo-authkeys.mjs --commit --tenant <id>
 *
 * Run AFTER deploying the schema migration that adds DejavooTerminal, and
 * AFTER any backfill that populated authKeyEnc from legacy
 * Tenant.settingsJson.spinAuthKey plaintext.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ENCRYPTED_PREFIX = 'enc:v1:';

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx);
    const val = trimmed.slice(idx + 1).replace(/^"|"$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { commit: false, tenant: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--commit') args.commit = true;
    else if (argv[i] === '--tenant' && argv[i + 1]) args.tenant = String(argv[++i]);
  }
  return args;
}

async function main() {
  loadDotEnv();
  const args = parseArgs();

  const { encrypt, isEncryptionConfigured } = await import('../src/lib/integration-crypto.js');
  if (!isEncryptionConfigured()) {
    console.error('ERROR: INTEGRATION_ENC_KEY is not configured. Set it in backend/.env first.');
    process.exit(1);
  }

  const mod = await import('../src/lib/prisma.js');
  const prisma = mod.prisma;

  console.log(`Mode: ${args.commit ? 'COMMIT' : 'dry-run (no writes)'}`);
  if (args.tenant) console.log(`Tenant filter: ${args.tenant}`);

  const terminals = await prisma.dejavooTerminal.findMany({
    where: args.tenant ? { tenantId: args.tenant } : {},
    select: { id: true, tenantId: true, name: true, tpn: true, authKeyEnc: true },
  });
  console.log(`Found ${terminals.length} DejavooTerminal row(s).\n`);

  const counts = { encrypted: 0, alreadyEncrypted: 0, empty: 0, errors: 0 };

  for (const t of terminals) {
    const raw = t.authKeyEnc || '';
    if (!raw) {
      counts.empty += 1;
      console.log(`  SKIP empty: ${t.id} (${t.name})`);
      continue;
    }
    if (raw.startsWith(ENCRYPTED_PREFIX)) {
      counts.alreadyEncrypted += 1;
      console.log(`  SKIP already-encrypted: ${t.id} (${t.name})`);
      continue;
    }
    try {
      const enc = encrypt(raw);
      const stored = `${ENCRYPTED_PREFIX}${enc}`;
      if (args.commit) {
        await prisma.dejavooTerminal.update({
          where: { id: t.id },
          data: { authKeyEnc: stored },
        });
      }
      counts.encrypted += 1;
      console.log(`  ${args.commit ? 'OK  ' : 'WOULD'} encrypt: ${t.id} (${t.name})`);
    } catch (err) {
      counts.errors += 1;
      console.error(`  ERR  ${t.id}: ${err.message}`);
    }
  }

  console.log('\nSummary:');
  console.log(`  encrypted:          ${counts.encrypted}`);
  console.log(`  already encrypted:  ${counts.alreadyEncrypted}`);
  console.log(`  empty:              ${counts.empty}`);
  console.log(`  errors:             ${counts.errors}`);
  console.log(args.commit ? '\nDONE (committed).' : '\nDONE (dry-run — no writes).');

  await prisma.$disconnect();
  if (counts.errors > 0) process.exit(2);
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
      import.meta.url.endsWith(path.basename(process.argv[1] || ''));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

export { parseArgs, ENCRYPTED_PREFIX };
