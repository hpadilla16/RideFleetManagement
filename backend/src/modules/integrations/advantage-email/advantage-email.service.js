/**
 * advantage-email.service.js — the transport half: mailbox credentials, and a
 * session an operation can drive one message at a time.
 *
 * CREDENTIALS use the SAME shared, AES-256-GCM, Postgres-backed store every
 * other booking source uses (createCredentialStore → IntegrationCredential),
 * under sourceSystem 'ADVANTAGE_EMAIL' so it sits beside — and never evicts —
 * the TSD portal login the Advantage scraper keeps under 'ADVANTAGE'.
 *
 * The connection settings (host, port, TLS, folder) ride INSIDE the same
 * encrypted blob via the store's `extraFields`, because one person fills in one
 * panel form and splitting that across two tables buys nothing. Env defaults
 * fill in whatever the blob omits, so a droplet serving several tenants on one
 * mail provider is configured once. NOTHING here is ever logged: the password
 * is never read outside getCredentials, and mailboxSettings() returns a
 * redacted view for the panel.
 *
 * THE SESSION SHAPE, AND WHY IT MATTERS. `withMailbox` hands the caller
 * `listUnseen / fetch / complete` rather than returning an array of messages,
 * so a message is flagged \Seen ONLY after the worker has durably recorded it.
 * If the process dies between fetch and record, the message is still unseen and
 * the next run picks it up — a duplicated import is free (ExternalReservation
 * upserts on (sourceSystem, externalRef)) and a lost reservation is not.
 */

import logger from '../../../lib/logger.js';
import { createCredentialStore, AuthExpiredError } from '../booking-source/http-common.js';
import { ImapClient, ImapAuthError } from './imap-client.js';
import {
  CREDENTIAL_SOURCE_SYSTEM,
  LOG_PREFIX,
  defaultImapHost,
  defaultImapPort,
  defaultImapSecure,
  defaultMailbox,
  defaultProcessedMailbox,
  connectTimeoutMs,
  commandTimeoutMs,
} from './advantage-email.constants.js';

/** Mailbox login rejected / credentials missing. Mirrors the scrapers' shape. */
export class AdvantageEmailAuthExpiredError extends AuthExpiredError {}

/** Connection settings carried alongside {username,password} in the blob. */
export const CREDENTIAL_EXTRA_FIELDS = Object.freeze([
  'host', 'port', 'secure', 'mailbox', 'processedMailbox',
]);

const credentialStore = createCredentialStore({
  sourceSystem: CREDENTIAL_SOURCE_SYSTEM,
  sourceLabel: 'Advantage email',
  logPrefix: LOG_PREFIX,
  AuthError: AdvantageEmailAuthExpiredError,
  extraFields: CREDENTIAL_EXTRA_FIELDS,
});

export const setCredentials = credentialStore.setCredentials;
export const getCredentials = credentialStore.getCredentials;
export const recordTestStatus = credentialStore.recordTestStatus;

// Test seams — the suite injects both so the whole worker runs with no DB and
// no socket. Production leaves them null.
let _imapFactory = null;
export const __testHooks = {
  setCredentialsResolver(fn) { credentialStore.setCredentialsResolver(fn); },
  /** fn(settings) → an object with the ImapClient surface. */
  setImapFactory(fn) { _imapFactory = typeof fn === 'function' ? fn : null; },
};

const asBool = (v, fallback) => {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return !['false', '0', 'no', 'off'].includes(String(v).trim().toLowerCase());
};

/**
 * Resolve the effective mailbox settings for a tenant: the encrypted blob
 * first, env defaults second.
 *
 * @returns {Promise<{host,port,secure,mailbox,processedMailbox,username,password}>}
 */
export async function resolveSettings(tenantId) {
  const creds = await getCredentials(tenantId);
  const host = (creds.host || defaultImapHost() || '').trim();
  if (!host) {
    throw new AdvantageEmailAuthExpiredError(
      `No IMAP host for tenant ${tenantId} — set it on the Advantage email panel or ADVANTAGE_EMAIL_IMAP_HOST`,
    );
  }
  return {
    host,
    port: Number(creds.port) > 0 ? Number(creds.port) : defaultImapPort(),
    secure: asBool(creds.secure, defaultImapSecure()),
    mailbox: (creds.mailbox || defaultMailbox() || 'INBOX').trim(),
    processedMailbox: (creds.processedMailbox || defaultProcessedMailbox() || '').trim(),
    username: creds.username,
    password: creds.password,
  };
}

/** The same settings with the secret removed — safe for the panel and logs. */
export async function redactedSettings(tenantId) {
  try {
    const s = await resolveSettings(tenantId);
    return {
      host: s.host,
      port: s.port,
      secure: s.secure,
      mailbox: s.mailbox,
      processedMailbox: s.processedMailbox || null,
      username: s.username,
      configured: true,
    };
  } catch {
    return { configured: false };
  }
}

function buildClient(settings) {
  if (_imapFactory) return _imapFactory(settings);
  return new ImapClient({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    connectTimeoutMs: connectTimeoutMs(),
    commandTimeoutMs: commandTimeoutMs(),
    logger,
  });
}

/**
 * Open a mailbox session, run `fn(session)`, and always close.
 *
 * session:
 *   settings            the resolved (redacted-safe) connection settings
 *   listUnseen()        → UIDs, oldest first
 *   fetch(uid)          → Buffer of the raw RFC 822 message (BODY.PEEK — the
 *                         message stays unread)
 *   complete(uid)       → flag \Seen, and move to the processed folder when one
 *                         is configured. Call ONLY after the message is recorded.
 */
export async function withMailbox(tenantId, fn) {
  const settings = await resolveSettings(tenantId);
  const client = buildClient(settings);
  let movedFolderBroken = false;

  try {
    await client.connect();
    try {
      await client.login(settings.username, settings.password);
    } catch (err) {
      if (err instanceof ImapAuthError) {
        throw new AdvantageEmailAuthExpiredError(err.message);
      }
      throw err;
    }
    await client.select(settings.mailbox);

    const session = {
      settings: {
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        mailbox: settings.mailbox,
        processedMailbox: settings.processedMailbox || null,
      },
      listUnseen: () => client.searchUnseen(),
      fetch: (uid) => client.fetchRaw(uid),
      complete: async (uid) => {
        await client.markSeen(uid);
        if (!settings.processedMailbox || movedFolderBroken) return;
        const ok = await client.move(uid, settings.processedMailbox);
        if (!ok) {
          // Report once per run, then stop trying: an unsupported MOVE or a
          // missing folder is a housekeeping preference, and the message is
          // already \Seen so nothing re-imports.
          movedFolderBroken = true;
          logger.warn(`${LOG_PREFIX} could not move a handled message; leaving it flagged \\Seen in place`, {
            tenantId, mailbox: settings.mailbox, processedMailbox: settings.processedMailbox,
          });
        }
      },
    };

    return await fn(session);
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Panel probe: log in, open the folder, count what is waiting. Side-effect
 * free — nothing is fetched, read or flagged.
 */
export async function testConnection(tenantId) {
  try {
    const result = await withMailbox(tenantId, async (session) => {
      const uids = await session.listUnseen();
      return {
        ok: true,
        status: 'OK',
        mailbox: session.settings.mailbox,
        host: session.settings.host,
        unseen: uids.length,
      };
    });
    await recordTestStatus(tenantId, 'OK');
    return result;
  } catch (err) {
    const expired = err instanceof AdvantageEmailAuthExpiredError;
    await recordTestStatus(tenantId, expired ? 'EXPIRED' : 'ERROR');
    logger.warn(`${LOG_PREFIX} mailbox test failed`, { tenantId, message: err.message });
    return {
      ok: false,
      status: expired ? 'EXPIRED' : 'ERROR',
      message: err.message,
    };
  }
}

export default {
  setCredentials,
  getCredentials,
  resolveSettings,
  redactedSettings,
  withMailbox,
  testConnection,
  AdvantageEmailAuthExpiredError,
};
