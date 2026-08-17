#!/usr/bin/env node
/**
 * Paridad de enums backend ↔ Dart (M0-8 del PROJECT_PLAN de RideOps).
 *
 * Lee la verdad de DOS fuentes del backend — nunca del OpenAPI, que está
 * sin tipar:
 *   1. backend/prisma/schema.prisma  → todos los `enum X { ... }`
 *   2. backend/src/modules/checkout-session/state-machine.js → CHECKOUT_STEPS
 *      (verifica además que el array del runtime coincida con el enum
 *      CheckoutStep de Prisma: si el equipo web agrega un paso en uno y no
 *      en el otro, esto truena ANTES de que truene en producción)
 *
 * Y la compara contra los enums Dart de rideops/lib/core/api/enums.dart.
 * Solo se exige paridad para los enums que el Dart declara espejar con el
 * marcador `// mirrors: <PrismaEnumName>` en la línea anterior al enum.
 *
 * Falla (exit 1) si:
 *   - un valor existe en Prisma y no en Dart (backend agregó, app vieja)
 *   - un valor existe en Dart y no en Prisma (typo o valor inventado)
 *   - CHECKOUT_STEPS del runtime ≠ enum CheckoutStep de Prisma
 *   - un `// mirrors:` apunta a un enum de Prisma que no existe
 *
 * Uso:  node rideops/tool/check_enum_parity.mjs   (desde la raíz del repo)
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = path.join(repoRoot, 'backend', 'prisma', 'schema.prisma');
const STATE_MACHINE = path.join(repoRoot, 'backend', 'src', 'modules', 'checkout-session', 'state-machine.js');
const DART_ENUMS = path.join(repoRoot, 'rideops', 'lib', 'core', 'api', 'enums.dart');

function fail(msg) {
  process.exitCode = 1;
  console.error(`✖ ${msg}`);
}

// ── 1. Prisma: enum X { VALUE // comment \n ... } ───────────────────────────
function parsePrismaEnums(src) {
  const enums = new Map();
  const re = /^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const values = m[2]
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter((l) => /^[A-Z0-9_]+$/.test(l));
    enums.set(m[1], values);
  }
  return enums;
}

// ── 2. state-machine.js: export const CHECKOUT_STEPS = [ 'A', 'B', ... ] ────
function parseCheckoutSteps(src) {
  const m = src.match(/export\s+const\s+CHECKOUT_STEPS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return null;
  return [...m[1].matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]);
}

// ── 3. Dart: `// mirrors: PrismaName` + enum lines hasta `}` ────────────────
// Convención del enums.dart: cada valor lleva su nombre wire exacto en un
// comentario `// wire: VALUE` (el identificador Dart es lowerCamelCase), o,
// si no hay comentario, el nombre wire es el identificador en SCREAMING_SNAKE.
function parseDartMirrors(src) {
  const mirrors = new Map();
  const re = /\/\/\s*mirrors:\s*(\w+)\s*\n\s*enum\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = m[3];
    const values = [];
    // En un enum de Dart los VALORES terminan en el primer `;` (que separa
    // valores de miembros/métodos). Todo lo que siga son métodos — no valores.
    for (const line of body.split('\n')) {
      const clean = line.trim();
      if (!clean || clean.startsWith('//')) continue;
      const wire = clean.match(/\/\/\s*wire:\s*([A-Z0-9_]+)/);
      if (wire) { values.push(wire[1]); if (clean.includes(';')) break; continue; }
      const ident = clean.match(/^([a-zA-Z][a-zA-Z0-9_]*)\s*[,;(]/);
      if (ident) {
        values.push(ident[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
      }
      if (clean.includes(';')) break;
    }
    mirrors.set(m[1], { dartName: m[2], values });
  }
  return mirrors;
}

// ── run ─────────────────────────────────────────────────────────────────────
for (const f of [SCHEMA, STATE_MACHINE]) {
  if (!existsSync(f)) { fail(`no existe: ${f}`); process.exit(1); }
}

const prismaEnums = parsePrismaEnums(readFileSync(SCHEMA, 'utf8'));
const steps = parseCheckoutSteps(readFileSync(STATE_MACHINE, 'utf8'));

if (!steps) fail('no pude parsear CHECKOUT_STEPS de state-machine.js');

// Invariante backend-interno: runtime === Prisma
const prismaSteps = prismaEnums.get('CheckoutStep') || [];
if (steps && JSON.stringify(steps) !== JSON.stringify(prismaSteps)) {
  fail(`CHECKOUT_STEPS (runtime) ≠ enum CheckoutStep (Prisma):\n  runtime: ${steps.join(', ')}\n  prisma:  ${prismaSteps.join(', ')}`);
}

if (!existsSync(DART_ENUMS)) {
  console.warn(`⚠ ${path.relative(repoRoot, DART_ENUMS)} aún no existe — solo se verificó el invariante backend-interno.`);
} else {
  const mirrors = parseDartMirrors(readFileSync(DART_ENUMS, 'utf8'));
  if (mirrors.size === 0) fail('enums.dart no declara ningún `// mirrors:` — el chequeo no está protegiendo nada');
  for (const [prismaName, { dartName, values }] of mirrors) {
    const truth = prismaEnums.get(prismaName);
    if (!truth) { fail(`Dart ${dartName} espeja ${prismaName}, que no existe en schema.prisma`); continue; }
    const missing = truth.filter((v) => !values.includes(v));
    const extra = values.filter((v) => !truth.includes(v));
    if (missing.length) fail(`${dartName}: faltan valores del backend: ${missing.join(', ')}`);
    if (extra.length) fail(`${dartName}: valores que el backend no tiene: ${extra.join(', ')}`);
    if (!missing.length && !extra.length) console.log(`✓ ${dartName} ≡ ${prismaName} (${truth.length} valores)`);
  }
}

if (process.exitCode) {
  console.error('\nParidad de enums ROTA. Actualiza rideops/lib/core/api/enums.dart o revisa el cambio del backend.');
} else {
  console.log('✓ paridad de enums OK');
}
