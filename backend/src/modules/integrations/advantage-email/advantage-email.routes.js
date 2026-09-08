/**
 * Admin routes for Advantage-by-EMAIL ingestion.
 *
 * Mounted at `/api/admin/integrations/advantage-email`. Same auth guard, same
 * tenant scoping and the same feature-flag posture as every other integration
 * panel: routes ALWAYS exist and config is ALWAYS editable;
 * ADVANTAGE_EMAIL_INTEGRATION_ENABLED gates only the autonomous poll, so
 * flipping it off leaves the panel usable and the cron dark.
 *
 * ITS OWN ROUTER, NOT MORE ENDPOINTS ON advantage.routes.js. The two share the
 * (tsdNumber, branch) → location mapping and the staged rows, but they are
 * different connections with different secrets and different failure modes: the
 * portal one dies on a TSD session, this one dies on an IMAP login. Merging
 * them would put one health pill over two systems, which is how "Advantage is
 * green" stops meaning anything. The LOCATION MAPPING is deliberately NOT
 * duplicated here — it is edited on the existing Advantage panel and read here,
 * because two screens writing one table is how they drift.
 *
 * SECRETS. POST /credentials takes {username, password, host, port, secure,
 * mailbox, processedMailbox} and hands them to the shared encrypted store
 * (AES-256-GCM, IntegrationCredential, sourceSystem 'ADVANTAGE_EMAIL'). The
 * password is never logged and never returned — GET /status reports presence,
 * host, folder and username only.
 *
 * Endpoint inventory:
 *   GET   /status                          → panel health summary
 *   PUT   /enabled          { enabled }    → per-tenant master switch
 *   POST  /credentials      { ... }        → set/rotate the mailbox connection
 *   POST  /test-connection                 → live IMAP probe (no message read)
 *   POST  /run-now                         → enqueue a one-off poll
 *   GET   /runs?limit=                     → recent ExternalSyncRun rows
 *   GET   /messages?limit=&status=         → the inbound ledger (quarantine tray)
 *   POST  /messages/:id/retry              → clear a quarantine so the next poll
 *                                            re-imports that message
 *
 * See doc/advantage-email-ingestion-2026-09-08.md
 */

import { Router } from 'express';
import { requireAuth, requireRole, isSuperAdmin } from '../../../middleware/auth.js';
import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { setCredentials, testConnection, redactedSettings } from './advantage-email.service.js';
import { enqueueOneOffSync } from './advantage-email.worker.js';
import { integrationEnabled } from './advantage-email.scheduler.js';
import {
  CREDENTIAL_SOURCE_SYSTEM,
  RUN_SOURCE_SYSTEM,
  CONFIG_KEY,
  INBOUND_STATUS,
  allowedSenders,
} from './advantage-email.constants.js';

export const advantageEmailRouter = Router();

advantageEmailRouter.use(requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'));

// ---------------------------------------------------------------------------
// Helpers (same shape as advantage.routes.js / flexways.routes.js)
// ---------------------------------------------------------------------------

/**
 * A SUPER_ADMIN belongs to no tenant, so every write has to name one. Omitting
 * it is a CALLER mistake and must read as one: the bare throw this used to do
 * surfaced as `500 Internal server error`, which sends whoever hit it looking
 * for a broken server instead of a missing field (2026-09-08, first real use).
 */
class TenantRequiredError extends Error {
  constructor() {
    super('tenantId is required (SUPER_ADMIN must pick one)');
    this.status = 400;
  }
}

function resolveTenantId(req) {
  if (isSuperAdmin(req.user)) {
    const t = req.query?.tenantId || req.body?.tenantId || req.user?.tenantId;
    if (!t) throw new TenantRequiredError();
    return String(t);
  }
  return req.user?.tenantId;
}

function resolveTenantIdOrNull(req) {
  try { return resolveTenantId(req); } catch { return null; }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    // A caller error carries its own status; anything else is a real fault and
    // still goes to the shared handler.
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    return next(err);
  });
}

function send400(res, message) {
  return res.status(400).json({ error: message });
}

async function readMasterEnabled(tenantId) {
  if (!tenantId) return false;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { integrationConfig: true },
  });
  const cfg = tenant?.integrationConfig;
  return !!(cfg && typeof cfg === 'object' && cfg[CONFIG_KEY] && cfg[CONFIG_KEY].enabled === true);
}

async function writeMasterEnabled(tenantId, enabled) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { integrationConfig: true },
  });
  const base = (tenant?.integrationConfig && typeof tenant.integrationConfig === 'object')
    ? tenant.integrationConfig
    : {};
  const next = {
    ...base,
    [CONFIG_KEY]: {
      ...(base[CONFIG_KEY] && typeof base[CONFIG_KEY] === 'object' ? base[CONFIG_KEY] : {}),
      enabled: !!enabled,
    },
  };
  await prisma.tenant.update({ where: { id: tenantId }, data: { integrationConfig: next } });
  return !!enabled;
}

function estimateNextRunAt(lastRun) {
  if (!integrationEnabled()) return null;
  const minutes = Number(process.env.ADVANTAGE_EMAIL_SYNC_INTERVAL_MINUTES || 15);
  const cadenceMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60 * 1000;
  const base = lastRun?.finishedAt || lastRun?.startedAt;
  const from = base ? new Date(base).getTime() : Date.now();
  return new Date(from + cadenceMs);
}

/**
 * The header pill. Derived from the LIVE run history, not from the stale manual
 * test alone (the Flexways lesson) — a mailbox whose last poll quarantined
 * everything is not "healthy" just because someone pressed Test a week ago.
 */
export function computeHealth({ credential, lastRun, quarantinedOpen }) {
  if (!credential) return { state: 'unconfigured', reason: 'no mailbox connection saved yet' };
  if (lastRun?.status === 'AUTH_EXPIRED' || credential.lastTestStatus === 'EXPIRED') {
    return { state: 'failing', reason: 'the mail server rejected the login — check the mailbox user and password' };
  }
  if (lastRun?.status === 'FAILED') {
    return { state: 'failing', reason: 'the last poll failed — see the run notes' };
  }
  if (quarantinedOpen > 0 || lastRun?.status === 'ATTENTION' || lastRun?.status === 'PARTIAL') {
    return {
      state: 'attention',
      reason: quarantinedOpen > 0
        ? `${quarantinedOpen} message(s) could not be imported and are waiting on a human`
        : 'the last poll did not finish cleanly — see the run notes',
    };
  }
  if (!lastRun && !credential.lastTestedAt) {
    return { state: 'untested', reason: null };
  }
  return { state: 'healthy', reason: null };
}

// ---------------------------------------------------------------------------
// GET /status
// ---------------------------------------------------------------------------

advantageEmailRouter.get('/status', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantIdOrNull(req);
  if (!tenantId) {
    return res.json({ configured: false, tenantId: null, integrationEnabled: integrationEnabled() });
  }

  const [credential, lastRun, configs, masterEnabled, quarantinedOpen] = await Promise.all([
    prisma.integrationCredential.findUnique({
      where: { tenantId_sourceSystem: { tenantId, sourceSystem: CREDENTIAL_SOURCE_SYSTEM } },
      select: { id: true, rotatedAt: true, lastTestedAt: true, lastTestStatus: true },
    }),
    prisma.externalSyncRun.findFirst({
      where: { tenantId, sourceSystem: RUN_SOURCE_SYSTEM },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true, status: true, startedAt: true, finishedAt: true, durationMs: true,
        pickupsFound: true, newlyInserted: true, autoPromoted: true, needsReview: true, notes: true,
      },
    }),
    // READ-ONLY here. The mapping is edited on the Advantage panel; this screen
    // shows which pairs will route so an operator can see why a message
    // quarantined without going to look somewhere else.
    prisma.advantageLocationConfig.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, tsdNumber: true, branch: true, locationId: true, enabled: true },
    }),
    readMasterEnabled(tenantId),
    prisma.advantageInboundEmail.count({
      where: { tenantId, status: { in: [INBOUND_STATUS.QUARANTINED, INBOUND_STATUS.FAILED] } },
    }),
  ]);

  const senders = allowedSenders();

  res.json({
    configured: !!credential,
    tenantId,
    integrationEnabled: integrationEnabled(),
    masterEnabled,
    credential: credential
      ? {
        rotatedAt: credential.rotatedAt || null,
        lastTestedAt: credential.lastTestedAt || null,
        lastTestStatus: credential.lastTestStatus || null,
      }
      : null,
    mailbox: credential ? await redactedSettings(tenantId) : { configured: false },
    // Named plainly so an unrestricted mailbox is visible in the panel rather
    // than assumed away. See the note on allowedSenders().
    senderAllowlist: senders.length ? senders : 'unrestricted',
    routes: configs,
    quarantinedOpen,
    health: computeHealth({ credential, lastRun, quarantinedOpen }),
    lastRun: lastRun || null,
    nextRunAt: estimateNextRunAt(lastRun),
  });
}));

// ---------------------------------------------------------------------------
// PUT /enabled
// ---------------------------------------------------------------------------

advantageEmailRouter.put('/enabled', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return send400(res, 'enabled (boolean) is required');
  const next = await writeMasterEnabled(tenantId, enabled);
  logger.info('[advantage-email-routes] master enable toggled', { tenantId, enabled: next, userId: req.user?.id });
  res.json({ ok: true, masterEnabled: next });
}));

// ---------------------------------------------------------------------------
// POST /credentials — the mailbox connection. Password never logged/returned.
// ---------------------------------------------------------------------------

advantageEmailRouter.post('/credentials', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password ?? '');
  if (!username) return send400(res, 'username is required');
  if (!password) return send400(res, 'password is required');

  const host = String(req.body?.host || '').trim();
  const portRaw = req.body?.port;
  const port = portRaw === undefined || portRaw === null || portRaw === '' ? '' : Number(portRaw);
  if (port !== '' && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    return send400(res, 'port must be a TCP port number');
  }
  // A CR/LF in any of these would be smuggled into the IMAP command stream.
  for (const [field, value] of Object.entries({ username, host, mailbox: req.body?.mailbox, processedMailbox: req.body?.processedMailbox })) {
    if (value && /[\r\n]/.test(String(value))) return send400(res, `${field} may not contain a line break`);
  }

  const row = await setCredentials(tenantId, {
    username,
    password,
    host,
    port: port === '' ? '' : String(port),
    secure: req.body?.secure === undefined ? '' : String(req.body.secure !== false),
    mailbox: String(req.body?.mailbox || '').trim(),
    processedMailbox: String(req.body?.processedMailbox || '').trim(),
  }, req.user?.id || null);

  logger.info('[advantage-email-routes] mailbox connection set', {
    tenantId, credentialId: row.id, userId: req.user?.id, host: host || '(env default)',
  });
  res.json({ ok: true, credentialId: row.id, rotatedAt: row.rotatedAt });
}));

// ---------------------------------------------------------------------------
// POST /test-connection — log in, open the folder, count unread. Reads nothing.
// ---------------------------------------------------------------------------

advantageEmailRouter.post('/test-connection', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const result = await testConnection(tenantId);
  res.status(result.ok ? 200 : 502).json(result);
}));

// ---------------------------------------------------------------------------
// POST /run-now
// ---------------------------------------------------------------------------

advantageEmailRouter.post('/run-now', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!(await readMasterEnabled(tenantId))) {
    return res.status(409).json({ error: 'Advantage email ingestion is disabled for this tenant. Enable it before polling.' });
  }
  const jobId = await enqueueOneOffSync(tenantId, `manual:${req.user?.id || 'unknown'}`);
  if (!jobId) return res.status(503).json({ error: 'Queue disabled (REDIS_URL unset)' });
  logger.info('[advantage-email-routes] manual poll enqueued', { tenantId, jobId, userId: req.user?.id });
  res.json({ ok: true, jobId, tenantId });
}));

// ---------------------------------------------------------------------------
// GET /runs
// ---------------------------------------------------------------------------

advantageEmailRouter.get('/runs', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantIdOrNull(req);
  const limit = Math.min(Math.max(parseInt(req.query?.limit || '50', 10), 1), 200);
  const where = tenantId
    ? { tenantId, sourceSystem: RUN_SOURCE_SYSTEM }
    : { sourceSystem: RUN_SOURCE_SYSTEM };
  const runs = await prisma.externalSyncRun.findMany({
    where, orderBy: { startedAt: 'desc' }, take: limit,
  });
  res.json({ runs });
}));

// ---------------------------------------------------------------------------
// GET /messages — the inbound ledger, quarantine first.
//
// rawBody is NOT selected. It is the verbatim message and holds the renter's
// name, phone and email; the panel needs the reason a message was refused, not
// the person's contact details, and the sweep deletes it at 90 days anyway.
// ---------------------------------------------------------------------------

advantageEmailRouter.get('/messages', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantIdOrNull(req);
  if (!tenantId) return res.json({ rows: [] });
  const limit = Math.min(Math.max(parseInt(req.query?.limit || '50', 10), 1), 200);
  const status = String(req.query?.status || '').trim().toUpperCase();

  const rows = await prisma.advantageInboundEmail.findMany({
    where: {
      tenantId,
      ...(status ? { status } : {}),
    },
    orderBy: { receivedAt: 'desc' },
    take: limit,
    select: {
      id: true, messageId: true, receivedAt: true, fromAddress: true, subject: true,
      docType: true, docTypeRaw: true, externalRef: true, tsdNumber: true, branch: true,
      status: true, failureReason: true, failureDetail: true, rawPurgedAt: true, createdAt: true,
    },
  });
  res.json({ rows });
}));

// ---------------------------------------------------------------------------
// POST /messages/:id/retry
//
// Clears the ledger row so the NEXT poll treats the message as new. It does not
// re-fetch anything by itself: the message has already been flagged \Seen, so
// this is only useful together with marking it unread in the mailbox (or with a
// processed folder the operator moves it back out of). The response says so
// rather than implying a re-import happened.
// ---------------------------------------------------------------------------

advantageEmailRouter.post('/messages/:id/retry', asyncHandler(async (req, res) => {
  const tenantId = resolveTenantId(req);
  const row = await prisma.advantageInboundEmail.findFirst({
    where: { id: String(req.params.id), tenantId },
    select: { id: true, messageId: true, status: true },
  });
  if (!row) return res.status(404).json({ error: 'Message not found for this tenant' });

  await prisma.advantageInboundEmail.delete({ where: { id: row.id } });
  logger.info('[advantage-email-routes] inbound ledger row cleared for retry', {
    tenantId, messageId: row.messageId, userId: req.user?.id,
  });
  res.json({
    ok: true,
    cleared: row.messageId,
    note: 'Mark the message unread in the mailbox (and move it back to the polled folder if you use one); the next poll will re-import it.',
  });
}));

export default advantageEmailRouter;
