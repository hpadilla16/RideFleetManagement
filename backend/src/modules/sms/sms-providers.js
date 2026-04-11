import logger from '../../lib/logger.js';

/**
 * Provider-agnostic SMS sender.
 * Supports: telnyx, twilio, plivo
 * Each provider uses their REST API directly (no SDK needed).
 */

async function sendViaTelnyx({ to, from, body, apiKey }) {
  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to,
      text: body,
      type: 'SMS',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || `Telnyx error (${res.status})`;
    throw new Error(msg);
  }
  return {
    provider: 'telnyx',
    messageId: data?.data?.id || '',
    to,
    status: data?.data?.to?.[0]?.status || 'queued',
  };
}

async function sendViaTwilio({ to, from, body, accountSid, authToken }) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || `Twilio error (${res.status})`);
  }
  return {
    provider: 'twilio',
    messageId: data?.sid || '',
    to,
    status: data?.status || 'queued',
  };
}

async function sendViaPlivo({ to, from, body, authId, authToken }) {
  const url = `https://api.plivo.com/v1/Account/${authId}/Message/`;
  const auth = Buffer.from(`${authId}:${authToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${auth}`,
    },
    body: JSON.stringify({ src: from, dst: to, text: body }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `Plivo error (${res.status})`);
  }
  return {
    provider: 'plivo',
    messageId: data?.message_uuid?.[0] || '',
    to,
    status: 'queued',
  };
}

/**
 * Send SMS using the configured provider.
 */
export async function sendSms({ to, from, body, provider, credentials }) {
  const cleanTo = String(to || '').replace(/[^\d+]/g, '');
  const cleanFrom = String(from || '').replace(/[^\d+]/g, '');
  if (!cleanTo || cleanTo.length < 10) throw new Error('Invalid phone number');
  if (!body || !String(body).trim()) throw new Error('Message body is required');
  const cleanBody = String(body).trim().slice(0, 1600); // SMS max ~1600 chars (10 segments)

  const providerName = String(provider || 'telnyx').toLowerCase();

  logger.info('SMS sending', { provider: providerName, to: cleanTo, bodyLength: cleanBody.length });

  let result;
  switch (providerName) {
    case 'telnyx':
      result = await sendViaTelnyx({ to: cleanTo, from: cleanFrom, body: cleanBody, apiKey: credentials?.apiKey });
      break;
    case 'twilio':
      result = await sendViaTwilio({ to: cleanTo, from: cleanFrom, body: cleanBody, accountSid: credentials?.accountSid, authToken: credentials?.authToken });
      break;
    case 'plivo':
      result = await sendViaPlivo({ to: cleanTo, from: cleanFrom, body: cleanBody, authId: credentials?.authId, authToken: credentials?.authToken });
      break;
    default:
      throw new Error(`Unknown SMS provider: ${providerName}`);
  }

  logger.info('SMS sent', { provider: providerName, messageId: result.messageId, to: cleanTo, status: result.status });
  return result;
}
