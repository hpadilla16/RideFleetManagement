/**
 * E2E — the kiosk and a remote Valet agent, over real HTTP against real Postgres.
 *
 * WHY THIS EXISTS SEPARATE FROM THE UNIT SUITES. The unit tests assert each piece
 * against a fake db; this asserts the CHAIN a real agent actually travels: device
 * authentication, the conversation binding, the service-account token version,
 * the default-deny allowlist, the per-user module gate, the grant, and the hard
 * stops. Several of the properties below are only true in combination — the
 * indistinguishable 404, the module gate covering reads AND writes, and the fact
 * that a caller cannot forge the photos-on-file waiver, all of which a fake db
 * would happily let you get wrong.
 *
 * HOW TO RUN (needs a live backend; that is why it is not in `npm test`):
 *   1. Apply the additive kiosk migrations to your local database.
 *   2. Start the backend on 4310 with JWT_SECRET=e2e-secret and
 *      DATABASE_URL pointing at a database you do not mind seeding into.
 *   3. npm run test:e2e-kiosk-remote-assist
 *
 * It seeds its own disposable tenant on every run and asserts 27 properties.
 * A NOTE THE RUN ITSELF TAUGHT US: the module grant is seeded BEFORE the first
 * request on purpose. Effective module access is cached per user inside the
 * backend process, so a grant written to the database after that user has been
 * read once does not take effect. That is exactly why the switch has to be
 * flipped in People — where the app invalidates its own cache — and never with
 * SQL against production.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const BASE = 'http://localhost:4310';
const SECRET = 'e2e-secret';
const prisma = new PrismaClient();
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const id = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); }
};

async function call(path, { method = 'GET', token, deviceToken, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (deviceToken) headers['x-kiosk-token'] = deviceToken;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

const world = {};

async function seed() {
  const tenantId = id('t');
  await prisma.tenant.create({ data: { id: tenantId, name: 'E2E Rentals', slug: id('slug'), updatedAt: new Date() } });
  const loc = await prisma.location.create({ data: { id: id('loc'), tenantId, name: 'E2E Airport', code: id('C').slice(0, 8), updatedAt: new Date() } });

  const deviceToken = id('devtok');
  const device = await prisma.kioskDevice.create({
    data: {
      id: id('dev'), tenantId, locationId: loc.id, name: 'E2E Kiosk',
      status: 'ACTIVE', tokenHash: sha(deviceToken),
    },
  });

  // The service account Valet authenticates as, and an admin to compare against.
  const svc = await prisma.user.create({
    data: {
      id: id('svc'), tenantId, email: `svc-${id('e')}@e2e.local`, fullName: 'Valet Service',
      role: 'AGENT', isActive: true, isServiceAccount: true, passwordHash: 'x',
    },
  });

  const customer = await prisma.customer.create({
    data: { id: id('cus'), tenantId, firstName: 'Roberto', lastName: 'Diaz', phone: '7870000000', email: `r-${id('e')}@e2e.local`, updatedAt: new Date() },
  });
  const reservation = await prisma.reservation.create({
    data: {
      id: id('res'), tenantId, reservationNumber: `E2E${Date.now() % 1000000}`,
      customerId: customer.id, pickupLocationId: loc.id, returnLocationId: loc.id,
      pickupAt: new Date(Date.now() + 3600e3), returnAt: new Date(Date.now() + 3 * 86400e3),
      status: 'CONFIRMED', updatedAt: new Date(),
    },
  });

  const svcNoModule = await prisma.user.create({
    data: {
      id: id('svc2'), tenantId, email: `svc2-${id('e')}@e2e.local`, fullName: 'Valet No Module',
      role: 'AGENT', isActive: true, isServiceAccount: true, passwordHash: 'x',
    },
  });

  Object.assign(world, { tenantId, loc, device, deviceToken, svc, svcNoModule, reservation });
  // Service accounts carry a token-version claim; a mismatch is an instant revoke.
  world.svcToken = jwt.sign({ sub: svc.id, email: svc.email, role: svc.role, tenantId, tv: 0 }, SECRET, { expiresIn: '1h' });
  world.noModuleToken = jwt.sign({ sub: svcNoModule.id, email: svcNoModule.email, role: svcNoModule.role, tenantId, tv: 0 }, SECRET, { expiresIn: '1h' });

  // The grant is seeded BEFORE the first request on purpose. Effective module
  // access is cached per user IN the backend process, so a grant written to the
  // database after that user has been read once does not take effect until the
  // cache expires — which is exactly why this switch has to be flipped in People
  // (the app invalidates its own cache) and not with SQL.
  await prisma.appSetting.create({
    data: { key: `user:${svc.id}:moduleAccess`, value: JSON.stringify({ kiosk: true }) },
  });

  // Tenant has the kiosk module ON; the service account does NOT yet.
  await prisma.appSetting.create({
    data: { key: `tenant:${tenantId}:moduleAccess`, value: JSON.stringify({ kiosk: true }) },
  });
}

async function newSession(overrides = {}) {
  return prisma.kioskSession.create({
    data: {
      id: id('ks'), tenantId: world.tenantId, deviceId: world.device.id, kind: 'PICKUP',
      step: 'ID', outcome: 'IN_PROGRESS', reservationId: world.reservation.id,
      eventsJson: [], lastActivityAt: new Date(), startedAt: new Date(),
      ...overrides,
    },
  });
}

async function run() {
  await seed();
  const CONV = `conv_${crypto.randomBytes(6).toString('hex')}`;

  console.log('\n1. The kiosk binds the guest\'s session to the conversation');
  const s1 = await newSession();
  const bind = await call(`/api/kiosk/sessions/${s1.id}/vozia-conversation`, {
    method: 'POST', deviceToken: world.deviceToken, body: { conversationId: CONV },
  });
  check(bind.status === 200 && bind.body?.bound === true, 'device binds its live session', `got ${bind.status}`);
  const row1 = await prisma.kioskSession.findUnique({ where: { id: s1.id } });
  check(!!row1.voziaBoundAt, 'the binding is stamped, so it can expire');

  console.log('\n2. Without the kiosk module an agent reaches NOTHING (config gate, not a bug)');
  const blocked = await call(`/api/kiosk/admin/sessions/${s1.id}/assist-view?conversationId=${CONV}`, { token: world.noModuleToken });
  check(blocked.status === 403, 'assist-view is 403 before the module is granted', `got ${blocked.status}`);
  const blockedWrite = await call(`/api/kiosk/admin/sessions/${s1.id}/remote-assist/unlock`, {
    method: 'POST', token: world.noModuleToken,
    body: { conversationId: CONV, agentRef: 'a1', agentName: 'Marta', reason: 'glare' },
  });
  check(blockedWrite.status === 403, 'remote unlock is 403 too — one switch gates both');

  console.log('\n3. The account that HAS the module sees the guest');
  const view = await call(`/api/kiosk/admin/sessions/${s1.id}/assist-view?conversationId=${CONV}`, { token: world.svcToken });
  check(view.status === 200, 'assist-view resolves for the granted account', `got ${view.status} ${JSON.stringify(view.body).slice(0, 120)}`);
  check(view.body?.truth && typeof view.body.truth.idVerified === 'boolean', 'truth comes back as server facts');
  check(!JSON.stringify(view.body || {}).includes('Roberto'), 'no guest PII in the agent view');

  console.log('\n4. A wrong conversation is the same 404 as a session that never existed');
  const wrong = await call(`/api/kiosk/admin/sessions/${s1.id}/assist-view?conversationId=conv_wrong`, { token: world.svcToken });
  const missing = await call(`/api/kiosk/admin/sessions/ks_nope/assist-view?conversationId=${CONV}`, { token: world.svcToken });
  check(wrong.status === 404 && missing.status === 404, 'both are 404');
  check(JSON.stringify(wrong.body) === JSON.stringify(missing.body), 'and identical bodies — no probing channel');

  console.log('\n5. A guest who is NOT stuck cannot be overridden at all');
  const healthy = await call(`/api/kiosk/admin/sessions/${s1.id}/remote-assist/unlock`, {
    method: 'POST', token: world.svcToken,
    body: { conversationId: CONV, agentRef: 'valet-77', agentName: 'Marta Ruiz', reason: 'curiosity' },
  });
  check(healthy.status === 409 && healthy.body?.code === 'NOT_ASSISTABLE',
    'an agent cannot reach into a check-in that is going fine', `got ${healthy.status} ${healthy.body?.code}`);

  // From here on, a guest who genuinely IS stuck: escalated, chat open.
  const stuck = await newSession({ outcome: 'ESCALATED', escalatedReason: 'ID_SCAN_FAILED' });
  const CONV2 = `conv_${crypto.randomBytes(6).toString('hex')}`;
  await call(`/api/kiosk/sessions/${stuck.id}/vozia-conversation`, {
    method: 'POST', deviceToken: world.deviceToken, body: { conversationId: CONV2 },
  });

  console.log('\n6. The override needs a grant, an identity and a reason');
  const noGrant = await call(`/api/kiosk/admin/sessions/${stuck.id}/remote-assist/verify-id`, {
    method: 'POST', token: world.svcToken,
    body: { conversationId: CONV2, agentRef: 'a1', agentName: 'Marta', fields: { firstName: 'R' } },
  });
  check(noGrant.status === 403 && noGrant.body?.code === 'ASSIST_GRANT_REQUIRED', 'no grant → 403', `got ${noGrant.status}`);

  const noReason = await call(`/api/kiosk/admin/sessions/${stuck.id}/remote-assist/unlock`, {
    method: 'POST', token: world.svcToken, body: { conversationId: CONV2, agentRef: 'a1', agentName: 'Marta' },
  });
  check(noReason.status === 400 && noReason.body?.code === 'REASON_REQUIRED', 'no reason → 400');

  const anon = await call(`/api/kiosk/admin/sessions/${stuck.id}/remote-assist/unlock`, {
    method: 'POST', token: world.svcToken, body: { conversationId: CONV2, reason: 'glare' },
  });
  check(anon.status === 400 && anon.body?.code === 'AGENT_REF_REQUIRED', 'anonymous → 400');

  console.log('\n7. The agent takes the grant, and it is audited as ASSERTED');
  const grant = await call(`/api/kiosk/admin/sessions/${stuck.id}/remote-assist/unlock`, {
    method: 'POST', token: world.svcToken,
    body: { conversationId: CONV2, agentRef: 'valet-77', agentName: 'Marta Ruiz', reason: 'Glare, two failed scans' },
  });
  check(grant.status === 200 && grant.body?.ttlMinutes === 10, 'grant minted, 10 min', `got ${grant.status}`);
  const audit = await prisma.auditLog.findFirst({
    where: { tenantId: world.tenantId, action: 'ADMIN_OVERRIDE' }, orderBy: { createdAt: 'desc' },
  });
  const meta = JSON.parse(audit?.metadata || '{}');
  check(meta.agentAssertedByValet?.name === 'Marta Ruiz', 'the human Valet asserts is named in the audit');
  // The central property of the actor fix, over real HTTP rather than a fake db:
  // the row names WHO AUTHENTICATED, and the session agrees with it. Before this,
  // an admin's override was filed under a service account nobody chose.
  check(meta.actorUserId === world.svc.id,
    'the audit names the caller RFM authenticated, not a robot it went looking for',
    `got ${meta.actorUserId}`);
  check(audit?.actorUserId === world.svc.id, 'and the AuditLog column agrees with the metadata');
  const grantedRow = await prisma.kioskSession.findUnique({ where: { id: stuck.id } });
  check(grantedRow.assistUserId === world.svc.id,
    'and the SESSION holds the same actor — one human across the whole chain');
  check(/Glare/.test(audit?.reason || ''), 'the stated reason survives to the audit');

  console.log('\n8. Hard stops survive going remote');
  const noPhotos = await call(`/api/kiosk/admin/sessions/${stuck.id}/remote-assist/verify-id`, {
    method: 'POST', token: world.svcToken,
    body: { conversationId: CONV2, agentRef: 'valet-77', agentName: 'Marta Ruiz', fields: { firstName: 'R', lastName: 'D' } },
  });
  check(noPhotos.status === 422 && noPhotos.body?.code === 'MISSING_PHOTO',
    'nothing on file → the same 422 the counter gets', `got ${noPhotos.status} ${noPhotos.body?.code}`);

  const forged = await call(`/api/kiosk/admin/sessions/${stuck.id}/remote-assist/verify-id`, {
    method: 'POST', token: world.svcToken,
    body: {
      conversationId: CONV2, agentRef: 'valet-77', agentName: 'Marta Ruiz',
      fields: { firstName: 'R', lastName: 'D' },
      allowPhotosOnFile: true, photosOnFile: true, idPhotosStoredAt: new Date().toISOString(),
    },
  });
  check(forged.status === 422 && forged.body?.code === 'MISSING_PHOTO',
    'a caller CANNOT claim the photos exist — the waiver is the server\'s column', `got ${forged.status} ${forged.body?.code}`);

  console.log('\n9. The two locks, over real HTTP');
  const done = await newSession({ outcome: 'COMPLETED' });
  const bindDone = await call(`/api/kiosk/sessions/${done.id}/vozia-conversation`, {
    method: 'POST', deviceToken: world.deviceToken, body: { conversationId: CONV },
  });
  check(bindDone.status === 409 && bindDone.body?.code === 'SESSION_NOT_BINDABLE',
    'a FINISHED session cannot be attached to a new conversation', `got ${bindDone.status}`);

  const esc = await newSession({ outcome: 'ESCALATED' });
  const bindEsc = await call(`/api/kiosk/sessions/${esc.id}/vozia-conversation`, {
    method: 'POST', deviceToken: world.deviceToken, body: { conversationId: `conv_${crypto.randomBytes(4).toString('hex')}` },
  });
  check(bindEsc.status === 200, 'an ESCALATED session still can — that is the whole point');

  const stale = await newSession();
  await prisma.kioskSession.update({
    where: { id: stale.id },
    data: { voziaConversationId: CONV, voziaBoundAt: new Date(Date.now() - 3 * 3600e3) },
  });
  const staleView = await call(`/api/kiosk/admin/sessions/${stale.id}/assist-view?conversationId=${CONV}`, { token: world.svcToken });
  check(staleView.status === 404, 'a binding older than the TTL is dead', `got ${staleView.status}`);

  const unstamped = await newSession();
  await prisma.kioskSession.update({ where: { id: unstamped.id }, data: { voziaConversationId: CONV } });
  const unstampedView = await call(`/api/kiosk/admin/sessions/${unstamped.id}/assist-view?conversationId=${CONV}`, { token: world.svcToken });
  check(unstampedView.status === 404, 'a pre-migration binding with no stamp is dead too');

  console.log('\n10. The guest closing the chat cuts the agent off immediately');
  const unbind = await call(`/api/kiosk/sessions/${s1.id}/vozia-conversation`, {
    method: 'POST', deviceToken: world.deviceToken, body: { conversationId: null },
  });
  check(unbind.status === 200 && unbind.body?.bound === false, 'the kiosk releases the binding');
  const afterUnbind = await call(`/api/kiosk/admin/sessions/${s1.id}/assist-view?conversationId=${CONV}`, { token: world.svcToken });
  check(afterUnbind.status === 404, 'and the agent can no longer read the guest');

  console.log(`\n${'='.repeat(56)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(56)}`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

run().catch(async (e) => { console.error('E2E CRASHED:', e); await prisma.$disconnect(); process.exit(1); });
