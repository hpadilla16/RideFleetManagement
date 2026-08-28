/**
 * Autopay enrollment invites — now a TABLE.
 *
 * This layer exists to solve exactly one problem: Authorize.Net's hosted-page token dies in
 * ~15 minutes, so it can never be the link in an email. Two tokens instead of one —
 *
 *   ours          long-lived, single-use, revocable   → goes in the email
 *   Authorize.Net ~15 minutes                          → minted when they click
 *
 * WHAT CHANGED ON THE PORT (2026-08-27, billing Phase 1)
 * ------------------------------------------------------------------
 * The proven groundwork kept invites in a globalThis Map inside the Next process. A server
 * restart lost every outstanding invitation and a second Next instance behind the load
 * balancer could not see the first one's invites at all. The comment there called the Map a
 * placeholder for a nearby database — but the Next app has no Prisma client and no database
 * access whatsoever, so it was a placeholder for a database that side could never reach.
 * Hence the whole layer moved here, behind Prisma.
 *
 * WE STORE THE HASH, NEVER THE TOKEN
 * ------------------------------------------------------------------
 * The plaintext token is generated once, returned once (to the caller that puts it in the
 * link), and never persisted. Precedent is already in this schema: Tenant.websiteTokenHash
 * — "We store ONLY the sha256; the plaintext is generated once and never persisted."
 *
 * ShuttleTrackerLink stores its token in the clear, and that is defensible: that token
 * reveals a van's position. This one lets the holder attach a card to a tenant's billing
 * relationship and read that tenant's plan and price out of a DB dump. Different blast
 * radius, different choice.
 *
 * The cost is real and worth naming: a link that has been sent can NEVER be shown again.
 * `tokenPrefix` (first 8 chars) exists so support can answer "is this the link I sent?"
 * without the hash being reversible, and "resend" means minting a fresh invite, not
 * recovering the old one.
 */
import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';

/** 256 bits, url-safe. Guessing is not a threat model at this width. */
export function newInviteToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * sha256 hex. Plain digest, no salt and no KDF, deliberately: the input is 256 bits of
 * CSPRNG output, so there is no dictionary to attack and a KDF would only slow the lookup
 * of a value that is already unguessable. Same reasoning as Tenant.websiteTokenHash.
 */
export function hashInviteToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** Never more than the first 8 characters — enough to recognise, useless to replay. */
export function tokenPrefixOf(token) {
  return String(token).slice(0, 8);
}

export function hashDisclosure(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/** The link that goes in the enrollment email. */
export function enrollmentUrl(token) {
  const base = (process.env.BILLING_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/autopay/${token}`;
}

export const DEFAULT_INVITE_VALID_DAYS = 14;

/**
 * Mint an invite. Returns { invite, token, url } — `token` is the ONLY time the plaintext
 * exists on this side of the wire. Callers must put it straight into the link and drop it;
 * it must never be logged, audited, or returned from a read endpoint.
 */
export async function createInvite(input = {}, deps = {}) {
  const db = deps.prisma || prisma;
  const now = deps.now ? deps.now() : new Date();
  const token = deps.token || newInviteToken();
  const validForDays = Number(input.validForDays ?? DEFAULT_INVITE_VALID_DAYS);

  const disclosureText = String(input.disclosureText || '');
  if (!disclosureText.trim()) {
    // The disclosure is the consent artefact. An invite without one cannot produce a
    // defensible enrollment, so it is not allowed to exist.
    throw new Error('createInvite: disclosureText is required (it is the consent artefact).');
  }

  const invite = await db.autopayInvite.create({
    data: {
      tokenHash: hashInviteToken(token),
      tokenPrefix: tokenPrefixOf(token),
      mode: input.mode === 'update' ? 'update' : 'enroll',
      tenantId: String(input.tenantId),
      subscriptionId: input.subscriptionId ?? null,
      // Truncated here as well as in ensureCustomerProfile: the column is VARCHAR(20) and
      // a value that would be silently cut at the API is better cut at the source, so the
      // stored value and the value Authorize.Net dedupes on are the same string.
      merchantCustomerId: String(input.merchantCustomerId).slice(0, 20),
      email: String(input.email),
      companyName: String(input.companyName),
      planCode: String(input.planCode),
      planName: String(input.planName),
      amount: input.amount,
      intervalUnit: input.intervalUnit || 'months',
      intervalLength: Number(input.intervalLength ?? 1),
      startDate: String(input.startDate),
      nextChargeDate: input.nextChargeDate ?? null,
      trialOccurrences: Number(input.trialOccurrences ?? 0),
      trialAmount: input.trialAmount ?? null,
      customerProfileId: input.customerProfileId ?? null,
      customerPaymentProfileId: input.customerPaymentProfileId ?? null,
      disclosureText,
      disclosureHash: hashDisclosure(disclosureText),
      expiresAt: new Date(now.getTime() + validForDays * 86_400_000),
      createdByUserId: input.createdByUserId ?? null,
    },
  });

  return { invite, token, url: enrollmentUrl(token) };
}

/** Raw lookup by plaintext token. Hashes, then matches on the hash — never the reverse. */
export async function findInviteByToken(token, deps = {}) {
  const db = deps.prisma || prisma;
  if (!token) return null;
  return db.autopayInvite.findUnique({ where: { tokenHash: hashInviteToken(token) } });
}

/** Usable means: exists, not consumed, not revoked, not expired. */
export function isUsable(invite, now = new Date()) {
  return !!invite
    && !invite.usedAt
    && !invite.revokedAt
    && new Date(invite.expiresAt).getTime() > now.getTime();
}

/**
 * The gate for the enrollment page and the hosted-token mint.
 *
 * Returns null for missing, expired, used AND revoked alike — the route turns every one of
 * those into the SAME bare 404. A distinct "this link expired" page is an oracle that tells
 * an enumerator which tokens were ever real.
 */
export async function resolveUsableInvite(token, deps = {}) {
  const now = deps.now ? deps.now() : new Date();
  const invite = await findInviteByToken(token, deps);
  return isUsable(invite, now) ? invite : null;
}

/**
 * The gate for the RETURN leg, which is deliberately laxer in exactly one direction.
 *
 * Authorize.Net sends the customer back here after they save a card, and a refresh, a
 * double-click or back-then-forward all land here again. An already-CONSUMED invite must
 * therefore still resolve, so the receipt re-renders instead of 404-ing at somebody who
 * just successfully gave us their card. Revoked stays dead, and expired-but-never-used
 * stays dead.
 */
export async function resolveInviteForReturn(token, deps = {}) {
  const now = deps.now ? deps.now() : new Date();
  const invite = await findInviteByToken(token, deps);
  if (!invite) return null;
  if (invite.revokedAt) return null;
  if (invite.usedAt) return invite;
  return new Date(invite.expiresAt).getTime() > now.getTime() ? invite : null;
}

/**
 * Atomically claim the invite for a single enrollment attempt.
 *
 * THE RACE THIS CLOSES: two return-leg requests arriving together (a double-click, or a
 * browser that prefetches) would each read a usable invite and each call
 * ARBCreateSubscription — and the tenant would be billed twice a month with no visible
 * cause. The claim is an UPDATE guarded by `usedAt: null`, so exactly one caller can win;
 * the loser sees count 0 and falls through to the idempotent receipt path.
 *
 * Returns true if this caller won the claim.
 */
export async function claimInvite(inviteId, deps = {}) {
  const db = deps.prisma || prisma;
  const now = deps.now ? deps.now() : new Date();
  const { count } = await db.autopayInvite.updateMany({
    where: { id: inviteId, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now, attempts: { increment: 1 } },
  });
  return count === 1;
}

/**
 * Give the claim back after a FAILED activation.
 *
 * Only ever called when we are certain no ARB subscription was created — i.e. the create
 * threw outright. A timeout is NOT that case: there the state is unknown, the invite stays
 * consumed, and a human resolves it. Releasing on an unknown state is how a customer ends
 * up with two subscriptions.
 */
export async function releaseInviteClaim(inviteId, deps = {}) {
  const db = deps.prisma || prisma;
  await db.autopayInvite.updateMany({
    where: { id: inviteId },
    data: { usedAt: null },
  });
}

export async function updateInvite(inviteId, patch, deps = {}) {
  const db = deps.prisma || prisma;
  return db.autopayInvite.update({ where: { id: inviteId }, data: patch });
}

export async function markInviteOpened(inviteId, deps = {}) {
  const db = deps.prisma || prisma;
  const now = deps.now ? deps.now() : new Date();
  // First open only — the column answers "did they ever look at it", not "how often".
  await db.autopayInvite.updateMany({
    where: { id: inviteId, openedAt: null },
    data: { openedAt: now },
  });
}

export async function revokeInvite(inviteId, deps = {}) {
  const db = deps.prisma || prisma;
  const now = deps.now ? deps.now() : new Date();
  const { count } = await db.autopayInvite.updateMany({
    where: { id: inviteId, revokedAt: null, usedAt: null },
    data: { revokedAt: now },
  });
  return count === 1;
}

/**
 * The ONLY shape an unauthenticated caller ever sees.
 *
 * An explicit allowlist, not a delete-list: a column added to the model later must not
 * appear on a public surface because somebody forgot to exclude it. Notably absent —
 * tokenHash, tokenPrefix, disclosureHash, createdByUserId, and every Authorize.Net handle
 * (customerProfileId, arbSubscriptionId). The page needs none of them.
 */
export function publicInviteView(invite) {
  return {
    mode: invite.mode,
    companyName: invite.companyName,
    email: invite.email,
    planName: invite.planName,
    amount: String(invite.amount),
    currency: 'USD',
    intervalUnit: invite.intervalUnit,
    intervalLength: invite.intervalLength,
    startDate: invite.startDate,
    nextChargeDate: invite.nextChargeDate,
    trialOccurrences: invite.trialOccurrences,
    disclosureText: invite.disclosureText,
    cardBrand: invite.cardBrand,
    cardLast4: invite.cardLast4,
    alreadyEnrolled: invite.mode !== 'update' && !!invite.arbSubscriptionId,
  };
}

export const autopayInvitesService = {
  createInvite,
  findInviteByToken,
  resolveUsableInvite,
  resolveInviteForReturn,
  claimInvite,
  releaseInviteClaim,
  updateInvite,
  markInviteOpened,
  revokeInvite,
  publicInviteView,
  isUsable,
  enrollmentUrl,
  hashInviteToken,
  newInviteToken,
};
