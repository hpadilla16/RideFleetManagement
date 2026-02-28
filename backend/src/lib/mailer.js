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

export async function sendEmail({ to, subject, text, html, attachments }) {
  const tx = getTransporter();
  const from = getEnvOrDotenv('SMTP_FROM') || getEnvOrDotenv('SMTP_USER');
  return tx.sendMail({ from, to, subject, text, html, attachments });
}
