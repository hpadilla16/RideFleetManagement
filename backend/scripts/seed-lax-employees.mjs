#!/usr/bin/env node
/**
 * One-off: create the LAX (Corpusa) staff accounts from the Rightcars
 * EmployeeListing export.
 *
 * WHY A SCRIPT AND NOT SQL. `User.passwordHash` is NOT NULL, so a raw INSERT
 * means inventing credentials for 33 real people. This goes through
 * peopleService.createPerson() instead, which is the same path the People UI uses:
 * it generates a random temp password, bcrypts it, enforces the tenant's plan
 * capacity, and (optionally) emails the invite. Nothing here is reimplemented.
 *
 * EVERYONE IS CREATED AS `AGENT` — least privilege. Hector promotes the
 * managers/owners afterwards from People. The source file's job titles are
 * carried into the log so he can see who is who, but they are NOT mapped to a
 * role here: role is access control and belongs to a human.
 *
 * DEFAULTS ARE SAFE: dry-run unless --commit, and invite emails are OFF unless
 * --send-invites. 33 invitations landing at once is a decision, not a side
 * effect of running a script.
 *
 * Usage (on the droplet, from ~/RideFleetManagement/backend):
 *   set -a && . ./.env && set +a
 *   node scripts/seed-lax-employees.mjs                 # dry run, changes nothing
 *   node scripts/seed-lax-employees.mjs --commit        # create, no emails
 *   node scripts/seed-lax-employees.mjs --commit --send-invites
 *
 * Re-runnable: an email that already exists is reported and skipped, never
 * duplicated or overwritten.
 */
import { prisma } from '../src/lib/prisma.js';
import { peopleService } from '../src/modules/people/people.service.js';

const TENANT_ID = 'cmqda70fo0004s60tbsbxbt4s';        // Corpusa
const LAX_LOCATION_ID = '6c7e78d9-6bc8-4876-a387-bcff2b27c36f';

// From "EmployeeListing.xlsx", Location Code LAXA01, Active = Yes.
// Employee 9998 / username SYS is deliberately absent: it is a shared
// kiosk-style login (laura.bejarano@zezgo.com), not a person.
const ROSTER = [
  { username: "HECTOR1", fullName: "Hector 1", email: "hpadilla160123@gmail.com", title: "RENTAL MANAGER" },
  { username: "HECTOR2", fullName: "Hector 2", email: "mveguilla1003@gmail.com", title: "RENTAL MANAGER" },
  { username: "ADRIANAB", fullName: "Adriana Bejarano", email: "adrianab@corpusarent.com", title: "OWNER" },
  { username: "VICTORIAB", fullName: "Victoria Brandani", email: "brandani1610@gmail.com", title: "RENTAL MANAGER" },
  { username: "ENRIQUECG4", fullName: "Enrique Cano", email: "enriquecg95@gmail.com", title: "OWNER" },
  { username: "MANUELM", fullName: "Manuel Marquez", email: "manuelmarquez@corpusarent.com", title: "OWNER" },
  { username: "KIMBERLYA", fullName: "Kimberly Acosta", email: "kimberlyacostasma2019@gmail.com", title: "FRONT DESK AGENT" },
  { username: "DAVIDA", fullName: "David Arteaga", email: "agaetra8835@gmail.com", title: "AGENT" },
  { username: "DANIELA", fullName: "Daniel Aude", email: "daude2665@gmail.com", title: "AGENT" },
  { username: "BETANCOURTA", fullName: "Adrian Betancourt", email: "adrianbtr00@gmail.com", title: "AGENT" },
  { username: "ERNESTOC", fullName: "Ernesto Cano", email: "cano.ernesto@gmail.com", title: "AGENT" },
  { username: "ADACAPRILES1", fullName: "Ada Capriles", email: "adacapriles@gmail.com", title: "AGENT" },
  { username: "LUISD", fullName: "Luis Daniel", email: "luisdaniel14042002@gmail.com", title: "AGENT" },
  { username: "JOAND", fullName: "Joan Davila", email: "joandpreciosmag@gmail.com", title: "AGENT" },
  { username: "MOISESD", fullName: "Moises Donado", email: "moisesdonado2504@gmail.com", title: "FRONT DESK AGENT" },
  { username: "EDGARDOC", fullName: "Chacon Edgardo", email: "edg23clavijo@gmail.com", title: "FRONT DESK AGENT" },
  { username: "JESUSE", fullName: "Jesus Estrada", email: "jesusaestrada04@gmail.com", title: "AGENT" },
  { username: "DANIELLAG", fullName: "Daniella Guedez", email: "dguedez1988@gmail.com", title: "AGENT" },
  { username: "JESUSL", fullName: "Jesus Lobo", email: "jalg2828@gmail.com", title: "AGENT" },
  { username: "ALEJANDRAM", fullName: "Alejandra Marrero", email: "alemarrero2004@gmail.com", title: "FRONT DESK AGENT" },
  { username: "JOSEM", fullName: "Jose Martinez", email: "martinezjoseitsup@gmail.com", title: "AGENT" },
  { username: "MANUELMO", fullName: "Manuel Moreno", email: "morenomanuel20021@gmail.com", title: "FRONT DESK AGENT" },
  { username: "LUISN", fullName: "Luis Nino", email: "luisfelnino@gmail.com", title: "AGENT" },
  { username: "LUISO", fullName: "Luis Olivier", email: "olivierluis06@gmail.com", title: "FRONT DESK AGENT" },
  { username: "DIEGOP", fullName: "Diego Perez", email: "dp527988@gmail.com", title: "FRONT DESK AGENT" },
  { username: "IVANS", fullName: "Ivan Serratos", email: "sithpokeluna@gmail.com", title: "AGENT" },
  { username: "AARONS", fullName: "Aaron Silva", email: "aaroneliassilva@gmail.com", title: "FRONT DESK AGENT" },
  { username: "ITZELT", fullName: "Itzel Torres", email: "itzeldlatorres@gmail.com", title: "AGENT" },
  { username: "JUANU", fullName: "Juan Urdaneta", email: "juanurdaneta997@gmail.com", title: "AGENT" },
  { username: "DVALLENILLA", fullName: "David Vallenilla", email: "davidvallenilla2@gmail.com", title: "AGENT" },
  { username: "AMBARV", fullName: "Ambar Velazquez", email: "ambarvelazquezluna@gmail.com", title: "AGENT" },
  { username: "KIMBERLYZ", fullName: "Kimberly Zaldivar", email: "kimberlyzaldivar26@yahoo.com", title: "FRONT DESK AGENT" },
  { username: "GABRIELAZ", fullName: "Gabriela Zambrano", email: "zambranoagis@gmail.com", title: "AGENT" },];

const args = new Set(process.argv.slice(2));
const COMMIT = args.has('--commit');
const SEND_INVITES = args.has('--send-invites');

function log(...a) { console.log(...a); }

async function main() {
  const tenant = await prisma.tenant.findUnique({
    where: { id: TENANT_ID },
    select: { id: true, name: true, plan: true }
  });
  if (!tenant) throw new Error(`Tenant ${TENANT_ID} not found`);

  const loc = await prisma.location.findFirst({
    where: { id: LAX_LOCATION_ID, tenantId: TENANT_ID },
    select: { id: true, code: true, name: true }
  });
  if (!loc) throw new Error(`Location ${LAX_LOCATION_ID} not found on this tenant`);

  log(`Tenant : ${tenant.name} (plan ${tenant.plan})`);
  log(`Branch : ${loc.code} — ${loc.name}`);
  log(`Roster : ${ROSTER.length} people`);
  log(COMMIT ? (SEND_INVITES ? 'MODE   : COMMIT + INVITE EMAILS' : 'MODE   : COMMIT (no emails)') : 'MODE   : DRY RUN — nothing will be written');
  log('');

  // One query instead of 33: User.email is globally unique ACROSS tenants, so a
  // person who already has an account anywhere blocks creation here. Three are
  // known at time of writing (a SUPER_ADMIN and two accounts on other tenants).
  const emails = ROSTER.map((r) => r.email.toLowerCase());
  const existing = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { email: true, role: true, tenantId: true, isActive: true }
  });
  const taken = new Map(existing.map((u) => [u.email.toLowerCase(), u]));

  const created = []; const skipped = []; const failed = [];

  for (const person of ROSTER) {
    const email = person.email.toLowerCase();
    const clash = taken.get(email);
    if (clash) {
      skipped.push({ ...person, reason: `email already in use (role ${clash.role}, tenant ${clash.tenantId || 'CROSS-TENANT'})` });
      continue;
    }
    if (!COMMIT) { created.push({ ...person, tempPassword: '(dry run)' }); continue; }
    try {
      const out = await peopleService.createPerson({
        personType: 'EMPLOYEE',
        fullName: person.fullName,
        email,
        role: 'AGENT',
        enableLogin: true,
        locationIds: [LAX_LOCATION_ID],
        sendInvite: SEND_INVITES,
      }, { tenantId: TENANT_ID });
      created.push({ ...person, tempPassword: out?.tempPassword || null });
    } catch (e) {
      failed.push({ ...person, reason: String(e?.message || e) });
    }
  }

  log(`— WOULD CREATE / CREATED (${created.length}) —`);
  for (const c of created) log(`  ${c.username.padEnd(14)} ${c.email.padEnd(34)} ${c.title}`);
  if (skipped.length) {
    log(`\n— SKIPPED (${skipped.length}) — these need a decision, not a retry:`);
    for (const s of skipped) log(`  ${s.username.padEnd(14)} ${s.email.padEnd(34)} ${s.reason}`);
  }
  if (failed.length) {
    log(`\n— FAILED (${failed.length}) —`);
    for (const f of failed) log(`  ${f.username.padEnd(14)} ${f.email.padEnd(34)} ${f.reason}`);
  }

  if (COMMIT && !SEND_INVITES && created.some((c) => c.tempPassword)) {
    log('\n— TEMP PASSWORDS (no invite emails were sent; deliver these yourself) —');
    for (const c of created) if (c.tempPassword) log(`  ${c.email.padEnd(34)} ${c.tempPassword}`);
    log('\n  These are shown ONCE and are not recoverable — they are bcrypt-hashed at rest.');
  }

  log(`\nEveryone was created as AGENT scoped to ${loc.code}. Promote the managers/owners from People.`);
  if (!COMMIT) log('Dry run — nothing was written. Re-run with --commit.');
}

main()
  .catch((e) => { console.error('FAILED:', e?.message || e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
