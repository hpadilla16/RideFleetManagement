/**
 * The autopay invite lifecycle — create → resolve → consume → dead.
 *
 * WHAT CARRIES THE OPERATION HERE:
 *   - the token is stored ONLY as a hash, and the plaintext never appears in a
 *     row or in any payload an unauthenticated caller receives;
 *   - a dead token is dead the SAME WAY for every reason (missing, expired,
 *     used, revoked), so the surface is not an oracle;
 *   - the single-use claim is ATOMIC, because the thing it prevents is a
 *     double-click creating two ARB subscriptions and billing a tenant twice a
 *     month with no visible cause;
 *   - the return leg still resolves a CONSUMED invite, so a refresh re-renders
 *     the receipt instead of 404-ing at somebody who just paid us.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Env BEFORE the imports: the service statically imports lib/prisma.js, whose
// PrismaClient constructor refuses an undefined datasource URL. The suite is
// DB-FREE — every query runs against the in-memory stand-in — so this is only
// what it takes to let the module graph load on a laptop with no Postgres.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';

const { makePrisma } = await import('./billing-test-prisma.mjs');
const {
  createInvite,
  findInviteByToken,
  resolveUsableInvite,
  resolveInviteForReturn,
  claimInvite,
  releaseInviteClaim,
  revokeInvite,
  publicInviteView,
  hashInviteToken,
  newInviteToken,
  isUsable,
} = await import('./autopay-invites.service.js');

const NOW = new Date('2026-08-27T12:00:00Z');

function ctx(now = NOW) {
  const prisma = makePrisma();
  return { prisma, now: () => now };
}

const BASE = {
  tenantId: 'tenant_1',
  subscriptionId: 'sub_1',
  merchantCustomerId: 'tenant_1',
  email: 'owner@autosdelvalle.com',
  companyName: 'Autos del Valle',
  planCode: 'PRO',
  planName: 'Pro',
  amount: 199,
  intervalUnit: 'months',
  intervalLength: 1,
  startDate: '2026-09-30',
  disclosureText: 'Autos del Valle autoriza el cobro automático de $199.00 USD mensual.',
};

// ── The token never lands in the database ──────────────────────────────────

test('the row stores the HASH; the plaintext appears nowhere in it', async () => {
  const deps = ctx();
  const { invite, token } = await createInvite(BASE, deps);

  assert.equal(invite.tokenHash, hashInviteToken(token));
  assert.equal(invite.tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.notEqual(invite.tokenHash, token);

  // Exhaustive, not field-by-field: a column added later must not become a
  // place the plaintext can hide.
  for (const [key, value] of Object.entries(invite)) {
    if (typeof value !== 'string') continue;
    assert.ok(!value.includes(token), `invite.${key} contains the plaintext token`);
  }
});

test('tokenPrefix is 8 characters of the token and nothing more', async () => {
  // Enough for support to answer "is this the link I sent?", useless to replay.
  const { invite, token } = await createInvite(BASE, ctx());
  assert.equal(invite.tokenPrefix.length, 8);
  assert.ok(token.startsWith(invite.tokenPrefix));
});

test('the minted token is 256 bits of url-safe randomness', () => {
  const a = newInviteToken();
  const b = newInviteToken();
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test('an invite cannot be created without a disclosure', async () => {
  // The disclosure IS the consent artefact. An invite without one cannot
  // produce a defensible enrollment, so it is not allowed to exist.
  await assert.rejects(
    () => createInvite({ ...BASE, disclosureText: '   ' }, ctx()),
    /disclosureText is required/,
  );
});

test('the disclosure is hashed alongside the verbatim text', async () => {
  const { invite } = await createInvite(BASE, ctx());
  assert.equal(invite.disclosureText, BASE.disclosureText);
  assert.equal(
    invite.disclosureHash,
    crypto.createHash('sha256').update(BASE.disclosureText).digest('hex'),
  );
});

test('merchantCustomerId is capped at 20 characters at the source', async () => {
  const { invite } = await createInvite(
    { ...BASE, merchantCustomerId: 'clz9abcdefghijklmnopqrstu' },
    ctx(),
  );
  assert.equal(invite.merchantCustomerId.length, 20);
});

// ── Resolve ────────────────────────────────────────────────────────────────

test('a fresh token resolves; an unknown one does not', async () => {
  const deps = ctx();
  const { token } = await createInvite(BASE, deps);
  assert.ok(await resolveUsableInvite(token, deps));
  assert.equal(await resolveUsableInvite('not-a-real-token', deps), null);
  assert.equal(await resolveUsableInvite('', deps), null);
  assert.equal(await resolveUsableInvite(null, deps), null);
});

test('lookup is by hash — a row whose hash does not match is unreachable', async () => {
  const deps = ctx();
  const { token } = await createInvite(BASE, deps);
  // The stored hash, offered as if it were the token, must NOT open the door.
  assert.equal(await findInviteByToken(hashInviteToken(token), deps), null);
});

// ── Every dead token dies the same way ─────────────────────────────────────

test('expired, used, revoked and missing are all indistinguishable', async () => {
  const deps = ctx();

  const expired = await createInvite({ ...BASE, validForDays: 14 }, deps);
  const used = await createInvite({ ...BASE, validForDays: 14 }, deps);
  const revoked = await createInvite({ ...BASE, validForDays: 14 }, deps);

  // 15 days on: the first has lapsed.
  const later = { ...deps, now: () => new Date(NOW.getTime() + 15 * 86_400_000) };
  await claimInvite(used.invite.id, deps);
  await revokeInvite(revoked.invite.id, deps);

  assert.equal(await resolveUsableInvite(expired.token, later), null);
  assert.equal(await resolveUsableInvite(used.token, deps), null);
  assert.equal(await resolveUsableInvite(revoked.token, deps), null);
  assert.equal(await resolveUsableInvite(newInviteToken(), deps), null);
  // All four are literally the same value, which is what makes the route's
  // single bare 404 honest rather than four screens an enumerator can tell apart.
});

test('isUsable agrees with the resolver on every dimension', () => {
  const future = new Date(NOW.getTime() + 86_400_000);
  const past = new Date(NOW.getTime() - 86_400_000);
  assert.equal(isUsable({ expiresAt: future }, NOW), true);
  assert.equal(isUsable({ expiresAt: past }, NOW), false);
  assert.equal(isUsable({ expiresAt: future, usedAt: NOW }, NOW), false);
  assert.equal(isUsable({ expiresAt: future, revokedAt: NOW }, NOW), false);
  assert.equal(isUsable(null, NOW), false);
});

// ── Single use ─────────────────────────────────────────────────────────────

test('exactly ONE caller can claim an invite', async () => {
  // The double-click race. Both readers see a usable invite; only one may go on
  // to create an ARB subscription.
  const deps = ctx();
  const { invite } = await createInvite(BASE, deps);

  const [a, b] = await Promise.all([
    claimInvite(invite.id, deps),
    claimInvite(invite.id, deps),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);

  // And a third attempt, later, still loses.
  assert.equal(await claimInvite(invite.id, deps), false);
});

test('claiming stamps usedAt and counts the attempt', async () => {
  const deps = ctx();
  const { invite } = await createInvite(BASE, deps);
  await claimInvite(invite.id, deps);
  const row = deps.prisma.autopayInvite.rows[0];
  assert.deepEqual(row.usedAt, NOW);
  assert.equal(row.attempts, 1);
});

test('a released claim is usable again — the retry path after a failed activation', async () => {
  // Only ever released when we KNOW no ARB subscription was created. On an
  // unknown state (a timeout) the invite must stay consumed, or the tenant can
  // end up with two live subscriptions.
  const deps = ctx();
  const { invite, token } = await createInvite(BASE, deps);
  assert.equal(await claimInvite(invite.id, deps), true);
  assert.equal(await resolveUsableInvite(token, deps), null);

  await releaseInviteClaim(invite.id, deps);
  assert.ok(await resolveUsableInvite(token, deps));
  assert.equal(await claimInvite(invite.id, deps), true);
});

test('an expired invite cannot be claimed even by a caller holding the token', async () => {
  const deps = ctx();
  const { invite } = await createInvite({ ...BASE, validForDays: 1 }, deps);
  const later = { ...deps, now: () => new Date(NOW.getTime() + 2 * 86_400_000) };
  assert.equal(await claimInvite(invite.id, later), false);
});

test('a revoked invite cannot be claimed', async () => {
  const deps = ctx();
  const { invite } = await createInvite(BASE, deps);
  await revokeInvite(invite.id, deps);
  assert.equal(await claimInvite(invite.id, deps), false);
});

test('revoke is a one-way door and does not fire twice', async () => {
  const deps = ctx();
  const { invite } = await createInvite(BASE, deps);
  assert.equal(await revokeInvite(invite.id, deps), true);
  assert.equal(await revokeInvite(invite.id, deps), false);
});

// ── The return leg's deliberate laxness ────────────────────────────────────

test('the return leg still resolves a CONSUMED invite, so a refresh re-renders', async () => {
  const deps = ctx();
  const { invite, token } = await createInvite(BASE, deps);
  await claimInvite(invite.id, deps);

  assert.equal(await resolveUsableInvite(token, deps), null, 'the enrollment page must not reopen');
  assert.ok(await resolveInviteForReturn(token, deps), 'the receipt must still render');
});

test('the return leg is NOT lax about revoked, or about expired-and-never-used', async () => {
  const deps = ctx();
  const revoked = await createInvite(BASE, deps);
  await revokeInvite(revoked.invite.id, deps);
  assert.equal(await resolveInviteForReturn(revoked.token, deps), null);

  const stale = await createInvite({ ...BASE, validForDays: 1 }, deps);
  const later = { ...deps, now: () => new Date(NOW.getTime() + 2 * 86_400_000) };
  assert.equal(await resolveInviteForReturn(stale.token, later), null);
});

test('a consumed invite survives its own expiry on the return leg', async () => {
  // Somebody who enrolled on day 13 and refreshes on day 20 gets their receipt,
  // not a dead end.
  const deps = ctx();
  const { invite, token } = await createInvite({ ...BASE, validForDays: 14 }, deps);
  await claimInvite(invite.id, deps);
  const later = { ...deps, now: () => new Date(NOW.getTime() + 20 * 86_400_000) };
  assert.ok(await resolveInviteForReturn(token, later));
});

// ── What the public ever sees ──────────────────────────────────────────────

test('publicInviteView leaks no hash, no handle, and no token', async () => {
  const deps = ctx();
  const { invite, token } = await createInvite(
    { ...BASE, customerProfileId: '9111', customerPaymentProfileId: '22' },
    deps,
  );
  const view = publicInviteView({ ...invite, arbSubscriptionId: null });
  const serialized = JSON.stringify(view);

  for (const forbidden of [
    'tokenHash', 'tokenPrefix', 'disclosureHash',
    'customerProfileId', 'customerPaymentProfileId', 'arbSubscriptionId',
    'createdByUserId', 'tenantId', 'subscriptionId',
  ]) {
    assert.ok(!(forbidden in view), `publicInviteView exposes ${forbidden}`);
  }
  assert.ok(!serialized.includes(token));
  assert.ok(!serialized.includes(invite.tokenHash));
  assert.ok(!serialized.includes(invite.tokenPrefix));

  // And it DOES carry what the page actually renders — including the two fields
  // the groundwork's pages read against a model that had neither.
  assert.equal(view.mode, 'enroll');
  assert.equal(view.startDate, '2026-09-30');
  assert.ok('nextChargeDate' in view);
  assert.equal(view.disclosureText, BASE.disclosureText);
});

test('the public routes never log an Authorize.Net error MESSAGE', async () => {
  // The hosted-token mint is the one call that sends Authorize.Net a URL
  // containing the invite token — it has to, because that is where the customer
  // must be returned to. Authorize.Net echoes offending setting values back
  // inside its error text, so logging that text would write a LIVE enrollment
  // token into the log stream and undo the entire point of storing only a hash.
  // The shared redactor masks a field NAMED token; it cannot see one embedded
  // in a sentence.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./billing-public.routes.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\.message/.test(code), 'a public billing route logs or returns an error message verbatim');
  assert.ok(!/req\.params\.token[^)]*logger/.test(code));
});

test('an already-enrolled invite says so without exposing the ARB id', async () => {
  const deps = ctx();
  const { invite } = await createInvite(BASE, deps);
  const view = publicInviteView({ ...invite, arbSubscriptionId: '7788' });
  assert.equal(view.alreadyEnrolled, true);
  assert.ok(!JSON.stringify(view).includes('7788'));
});
