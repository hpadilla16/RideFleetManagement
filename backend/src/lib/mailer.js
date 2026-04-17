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

  const res = await fetch('https://api.resend.com/emails', {
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

async function sendViaMailersend({ to, subject, text, html, attachments }) {
  const apiKey = getEnvOrDotenv('MAILERSEND_API_KEY');
  const fromEmail = getEnvOrDotenv('MAILERSEND_FROM') || getEnvOrDotenv('SMTP_FROM') || getEnvOrDotenv('SMTP_USER');
  const fromName = getEnvOrDotenv('MAILERSEND_FROM_NAME') || 'Ride Fleet';
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

  const res = await fetch('https://api.mailersend.com/v1/email', {
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

export async function sendEmail({ to, subject, text, html, attachments }) {
  const provider = preferredProvider();
  if (provider === 'mailersend') {
    return sendViaMailersend({ to, subject, text, html, attachments });
  }
  if (provider === 'resend') {
    return sendViaResend({ to, subject, text, html, attachments });
  }
  return sendViaSmtp({ to, subject, text, html, attachments });
}
