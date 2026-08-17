import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';

let transporter = null;

function getEnvOrDotenv(key) {
  if (process.env[key]) return process.env[key];
  try {
    const p = path.resolve(process.cwd(), '.env');
    const txt = fs.readFileSync(p, 'utf8');
    const line = txt.split(/\r?\n/).find((l) => l.trim().startsWith(`${key}=`));
    if (!line) return '';
    const val = line.slice(line.indexOf('=') + 1).trim();
    return val.replace(/^"|"$/g, '');
  } catch {
    return '';
  }
}

function preferredProvider() {
  const explicit = String(getEnvOrDotenv('MAIL_PROVIDER') || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (getEnvOrDotenv('MAILERSEND_API_KEY')) return 'mailersend';
  if (getEnvOrDotenv('RESEND_API_KEY')) return 'resend';
  return 'smtp';
}

function getTransporter() {
  if (transporter) return transporter;

  const host = getEnvOrDotenv('SMTP_HOST');
  const port = Number(getEnvOrDotenv('SMTP_PORT') || 587);
  const user = getEnvOrDotenv('SMTP_USER');
  const pass = getEnvOrDotenv('SMTP_PASS');

  if (!host || !user || !pass) {
    throw new Error('SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS)');
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });

  return transporter;
}

function toBase64(content) {
  if (!content) return '';
  if (Buffer.isBuffer(content)) return content.toString('base64');
  if (content instanceof Uint8Array) return Buffer.from(content).toString('base64');
  return Buffer.from(String(content)).toString('base64');
}

const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry transient upstream failures (gateway 5xx / rate-limit / network) when
// talking to an email provider. A single MailerSend edge 502 was surfacing as
// a guest-signin 500 (Sentry JAVASCRIPT-NEXTJSBACKEND-1K); a couple of short
// backoff retries absorb those without changing the success path.
async function fetchWithRetry(url, options, attempts = 3) {
  const transient = new Set([429, 502, 503, 504]);
  let lastRes = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, options);
      if (transient.has(res.status) && i < attempts - 1) {
        lastRes = res;
        await _sleep(300 * (i + 1));
        continue;
      }
      return res;
    } catch (err) {
      if (i < attempts - 1) {
        await _sleep(300 * (i + 1));
        continue;
      }
      throw err;
    }
  }
  return lastRes;
}

async function sendViaResend({ to, subject, text, html, attachments }) {
  const apiKey = getEnvOrDotenv('RESEND_API_KEY');
  const from = getEnvOrDotenv('RESEND_FROM') || getEnvOrDotenv('SMTP_FROM') || getEnvOrDotenv('SMTP_USER');
  if (!apiKey || !from) {
    throw new Error('Resend is not configured (RESEND_API_KEY/RESEND_FROM)');
  }

  const recipientList = Array.isArray(to)
    ? to.filter(Boolean)
    : String(to || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

  const payload = {
    from,
    to: recipientList,
    subject,
    text,
    html
  };

  if (Array.isArray(attachments) && attachments.length) {
    payload.attachments = attachments.map((item) => ({
      filename: item.filename,
      content: toBase64(item.content),
      ...(item.contentType ? { content_type: item.contentType } : {})
    }));
  }

  const res = await fetchWithRetry('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {}
    throw new Error(`Resend request failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }

  return res.json();
}

async function sendViaMailersend({ to, subject, text, html, attachments, fromName: fromNameOverride, fromEmail: fromEmailOverride }) {
  const apiKey = getEnvOrDotenv('MAILERSEND_API_KEY');
  const defaultFrom = getEnvOrDotenv('MAILERSEND_FROM') || getEnvOrDotenv('SMTP_FROM') || getEnvOrDotenv('SMTP_USER');
  // A tenant's own from address — VALID ONLY when that domain is verified in
  // MailerSend. An unverified domain is a hard 422, not a spam-folder problem,
  // so a failed tenant-from send RETRIES on the platform default below: the
  // customer getting the email matters more than the address it came from.
  const fromEmail = String(fromEmailOverride || '').trim().toLowerCase() || defaultFrom;
  const fromName = String(fromNameOverride || '').trim() || getEnvOrDotenv('MAILERSEND_FROM_NAME') || 'Ride Fleet';
  if (!apiKey || !fromEmail) {
    throw new Error('MailerSend is not configured (MAILERSEND_API_KEY/MAILERSEND_FROM)');
  }

  const recipientList = Array.isArray(to)
    ? to.filter(Boolean)
    : String(to || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

  const payload = {
    from: { email: fromEmail, name: fromName },
    to: recipientList.map((email) => ({ email })),
    subject,
    text,
    html
  };

  if (Array.isArray(attachments) && attachments.length) {
    payload.attachments = attachments.map((item) => ({
      filename: item.filename,
      content: toBase64(item.content),
      disposition: 'attachment'
    }));
  }

  const res = await fetchWithRetry('https://api.mailersend.com/v1/email', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {}
    // A tenant-branded FROM that MailerSend refuses (unverified domain, DNS
    // drift, revoked verification) must not cost the customer their email —
    // retry once on the platform default. The degradation is the address,
    // never the delivery.
    if (fromEmailOverride && fromEmail !== defaultFrom) {
      console.warn(`[mailer] tenant from ${fromEmail} rejected (${res.status}) — retrying with platform default`);
      return sendViaMailersend({ to, subject, text, html, attachments, fromName: fromNameOverride });
    }
    throw new Error(`MailerSend request failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }

  // MailerSend returns 202 Accepted with no body on success
  if (res.status === 202) return { ok: true };
  try {
    return await res.json();
  } catch {
    return { ok: true };
  }
}

async function sendViaSmtp({ to, subject, text, html, attachments }) {
  const tx = getTransporter();
  const from = getEnvOrDotenv('SMTP_FROM') || getEnvOrDotenv('SMTP_USER');
  return tx.sendMail({ from, to, subject, text, html, attachments });
}

/**
 * Tenant sender resolution — the CHOKEPOINT (2026-08-17).
 *
 * Passing `fromName`/`fromEmail` by hand worked and did not scale: an audit
 * found 6 of ~46 send sites doing it, so a Rent & Go customer got their
 * confirmation from rentandgopr.com and their toll notice from
 * ridefleetmanager.com. Same failure shape as the export/x-view-location bug
 * (Hector, 2026-08-11): per-caller plumbing that a new caller silently
 * forgets. So resolution moved HERE — a call site only has to say WHICH
 * tenant, and this decides the sender. Explicit fromName/fromEmail still win,
 * for the few places that legitimately send as the platform.
 *
 * Cached 5 minutes per tenant: transactional email is bursty (a checkout
 * sends several), and this would otherwise add a settings read to each one.
 */
const SENDER_TTL_MS = 5 * 60 * 1000;
const _senderCache = new Map();
let _resolveBrand = null;

export function _clearSenderCache() { _senderCache.clear(); }

async function resolveTenantSender(tenantId) {
  if (!tenantId) return {};
  const hit = _senderCache.get(tenantId);
  if (hit && Date.now() - hit.at < SENDER_TTL_MS) return hit;
  try {
    // Dynamic: email-template pulls in settings → prisma, and mailer is
    // imported by nearly everything. Loading it lazily keeps that graph out
    // of module-init order.
    if (!_resolveBrand) ({ resolveEmailBrand: _resolveBrand } = await import('./email-template.js'));
    const brand = await _resolveBrand({ tenantId });
    const row = { at: Date.now(), fromEmail: brand?.fromEmail || '', fromName: brand?.companyName || '' };
    _senderCache.set(tenantId, row);
    return row;
  } catch {
    // Never let a settings hiccup stop an email — the platform default sends.
    return {};
  }
}

/**
 * `tenantId` (preferred): the sender is resolved from that tenant's settings —
 * display name always, and the FROM address when they have a verified domain
 * configured. `fromName`/`fromEmail` (optional) override it explicitly.
 *
 * The sender is the first branding anyone sees: a VPH customer's mail must
 * arrive from "Rent & Go by VPH Motors" <…@rentandgopr.com>, not from Ride
 * Fleet. An unverified from-domain is a hard reject at the provider, not a
 * spam-folder problem, so sendViaMailersend retries on the platform default —
 * a misconfigured tenant degrades the ADDRESS, never the delivery.
 */
export async function sendEmail({ to, subject, text, html, attachments, fromName, fromEmail, tenantId }) {
  if (tenantId && (!fromEmail || !fromName)) {
    const sender = await resolveTenantSender(tenantId);
    fromEmail = fromEmail || sender.fromEmail || undefined;
    fromName = fromName || sender.fromName || undefined;
  }
  const provider = preferredProvider();
  if (provider === 'mailersend') {
    return sendViaMailersend({ to, subject, text, html, attachments, fromName, fromEmail });
  }
  if (provider === 'resend') {
    return sendViaResend({ to, subject, text, html, attachments, fromName });
  }
  return sendViaSmtp({ to, subject, text, html, attachments, fromName });
}
