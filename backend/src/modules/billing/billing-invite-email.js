/**
 * The enrollment link, delivered — Tenant Subscriptions Phase 7 (2026-08-28).
 *
 * Before this file the platform minted a link and showed it to the operator in
 * a banner, and a human copied it into their own mail client. That worked for
 * one subscriber and does not survive ten: the address is already on the
 * invite, so the copy step adds a chance to paste the wrong link, send it from
 * the wrong mailbox, or send it to the wrong person, and buys nothing.
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────
 * Delivery of the ENROLL link only. Card-expiry auto-invites, the dunning
 * ladder's own templates and MRR reporting are the rest of Phase 7 and are
 * deliberately not here. The UPDATE link already has its own sender in
 * billing-self.service.js and is left alone.
 *
 * ── LANGUAGE: BOTH, AND THAT IS NOT A DODGE ────────────────────────────────
 *
 * The enrollment pages default to ENGLISH with an always-visible Spanish
 * toggle (autopay-lang.jsx), and they are built that way because most tenants
 * are not in Puerto Rico. An email cannot offer a toggle — whatever it is
 * written in is what the reader gets.
 *
 * So the question is what DECIDES the language, and the honest answer is that
 * nothing in the data can. `Tenant`, `TenantSubscription` and `AutopayInvite`
 * carry no locale column between them (the only `locale` in the schema is on
 * `Customer`, a RENTER of a tenant's cars, which is a different person
 * entirely). There is no browser hint either: this message is composed on a
 * server, not in the recipient's browser.
 *
 * Three ways out, and why this one:
 *   - Spanish, inheriting the existing billing email. REJECTED. That address
 *     may belong to a fleet in Texas; the precedent is Spanish because it was
 *     written before the pages were bilingual, not because anybody decided it.
 *   - English, matching the page default. Defensible, but the page only
 *     defaults to English because it can offer the toggle a beat later. An
 *     email that guesses wrong has no second beat.
 *   - BOTH, English block first, then Spanish. CHOSEN. A guess about somebody
 *     else's inbox, made at the operator's keyboard, is replaced by carrying
 *     the answer for either reader. English leads so the email and the page it
 *     opens agree on which language comes first.
 *
 * ONE LINK, ONE SET OF NUMBERS. The two blocks are translations of the same
 * facts, not two offers — the amount is rendered once in a language-neutral
 * form and only the date and the cadence word change between them. If this
 * copy is ever edited, edit both halves or the email starts quoting two
 * different prices to the same reader.
 *
 * When a per-tenant billing language does get recorded (it would also fix the
 * hardcoded-Spanish consent archive flagged in Phase 3), this becomes a choice
 * instead of a both — `buildEnrollInviteEmail` already takes the copy apart
 * per language, so that change is a filter, not a rewrite.
 *
 * ── WHAT NEVER LEAVES THIS FILE ────────────────────────────────────────────
 *
 * The plaintext token goes into the message body and NOWHERE else: not a log
 * line, not audit metadata, not an error returned to the caller. Failures are
 * reported as our OWN coarse reason codes rather than the provider's free
 * text, because billing-notify already learned that lesson from Authorize.Net
 * echoing offending values back inside an error string. `scrubToken` is the
 * safety net under that rule, not a licence to relax it.
 */
import logger from '../../lib/logger.js';
import {
  formatMoney,
  formatCalendarDateEs,
  formatCalendarDateEn,
  cadenceLabelEs,
  cadenceLabelEn,
} from './billing-dates.js';

/** Coarse, OURS, and safe to hand back to a caller or write to a trail. */
export const INVITE_EMAIL_RESULT = Object.freeze({
  SENT: 'SENT',
  NO_RECIPIENT: 'NO_RECIPIENT',
  MAILER_NOT_CONFIGURED: 'MAILER_NOT_CONFIGURED',
  SEND_FAILED: 'SEND_FAILED',
});

/**
 * Is there a mail provider in the ENVIRONMENT?
 *
 * Reads `process.env` only, deliberately, while lib/mailer.js also falls back
 * to parsing backend/.env off disk. In production those are the same thing —
 * docker-compose.prod.yml loads `env_file: ./backend/.env` into the container,
 * so the values ARE in process.env. The two only diverge for a developer
 * running node directly against a checkout that has a .env with live SMTP
 * credentials in it, and there the divergence errs the way this module must
 * err: it declines to send rather than mailing a real tenant from someone's
 * laptop. The decline is reported, never silent.
 */
export function mailerConfigured(env = process.env) {
  const has = (k) => !!String(env?.[k] || '').trim();
  if (has('MAILERSEND_API_KEY') || has('RESEND_API_KEY')) return true;
  return has('SMTP_HOST') && has('SMTP_USER') && has('SMTP_PASS');
}

/**
 * Remove a token from any string that is about to be logged.
 *
 * Second line of defence. The first is not putting it there.
 */
export function scrubToken(text, token) {
  const s = String(text ?? '');
  if (!token) return s;
  return s.split(String(token)).join('[redacted]');
}

/**
 * The message. PURE — no IO, no env — so the copy is testable on its own and a
 * wording change can never break the send path.
 *
 * `resent` is not cosmetic. Minting a new link REVOKES every outstanding one
 * (issueEnrollInvite), so a customer who has two of these emails holds exactly
 * one working link and one dead one. Saying which is which in the message is
 * cheaper than the support call, and the alternative — hoping they notice the
 * timestamps — puts the burden on the person least able to check.
 */
export function buildEnrollInviteEmail({
  companyName,
  planName,
  amount,
  currency = 'USD',
  intervalUnit,
  intervalLength,
  firstChargeDate,
  url,
  expiresAt,
  issuedAt,
  resent = false,
}) {
  // Rendered ONCE and shared: two blocks must never quote two prices.
  const money = `$${formatMoney(amount)} ${currency}`;
  const expiresIso = expiresAt ? new Date(expiresAt).toISOString().slice(0, 10) : null;
  const issuedIso = issuedAt ? new Date(issuedAt).toISOString().slice(0, 10) : null;

  const en = [
    'ENGLISH',
    '',
    `Hello ${companyName},`,
    '',
    'Ride Car Sharing LLC is ready to set up automatic payment for your Ride Fleet Manager'
    + ' subscription. Open the link at the bottom of this email to enter your card.',
    '',
    `Plan: ${planName}`,
    `Amount: ${money}, billed ${cadenceLabelEn(intervalUnit, intervalLength)}`,
    `First charge: ${formatCalendarDateEn(firstChargeDate)}`,
    // The word the page uses. NOT "next charge" — nothing has been charged yet,
    // and not "trial", because a deferred start is not one.
    'Nothing is charged when you enter the card. The first charge runs on the date above.',
    expiresIso ? `This link expires on ${formatCalendarDateEn(expiresIso)}.` : null,
    '',
    resent
      // Said plainly rather than left to timestamps: the reader cannot check
      // which link is live and we can.
      ? 'This link REPLACES any earlier one we sent you. The older links have been switched'
        + ' off and will no longer open — use only the link in this email, the most recent one.'
      : 'The link is single-use. Once your card is saved it stops working, which is expected.',
    '',
    'The full card number is entered on and stored by Authorize.Net. Ride Fleet Manager only'
    + ' ever receives a reference and the last four digits.',
    '',
    'If you were not expecting this, do not open the link — reply to this email instead.',
  ].filter((line) => line !== null).join('\n');

  const es = [
    'ESPAÑOL',
    '',
    `Hola ${companyName}:`,
    '',
    'Ride Car Sharing LLC está listo para configurar el cobro automático de su suscripción a'
    + ' Ride Fleet Manager. Abra el enlace al final de este correo para registrar su tarjeta.',
    '',
    `Plan: ${planName}`,
    `Monto: ${money}, con frecuencia ${cadenceLabelEs(intervalUnit, intervalLength)}`,
    `Primer cobro: ${formatCalendarDateEs(firstChargeDate)}`,
    'No se cobra nada al registrar la tarjeta. El primer cobro corre en la fecha indicada.',
    expiresIso ? `Este enlace vence el ${formatCalendarDateEs(expiresIso)}.` : null,
    '',
    resent
      ? 'Este enlace REEMPLAZA cualquier otro que le hayamos enviado antes. Los anteriores'
        + ' quedaron desactivados y ya no abren — use solamente el de este correo, el más reciente.'
      : 'El enlace es de un solo uso. Deja de funcionar cuando su tarjeta queda guardada, y eso'
        + ' es lo esperado.',
    '',
    'El número completo de la tarjeta se ingresa y se guarda en los servidores de Authorize.Net.'
    + ' Ride Fleet Manager solo recibe un identificador y los últimos cuatro dígitos.',
    '',
    'Si no esperaba este correo, no abra el enlace — respóndanos aquí.',
  ].filter((line) => line !== null).join('\n');

  return {
    // Both languages in the subject too: the subject line is the only part a
    // reader sees before deciding whether this is phishing.
    subject: `${resent ? 'Updated link — ' : ''}Set up automatic payment / Configure su cobro automático`
      + ` — Ride Fleet Manager (${companyName})`,
    text: [
      en,
      '',
      '────────────────────────────────────────',
      '',
      es,
      '',
      '────────────────────────────────────────',
      '',
      // ONE link, at the end, under both blocks — so neither language's reader
      // has to scroll past the other's copy to reach it, and so there is
      // visibly only one URL in the message.
      url,
      '',
      issuedIso ? `Issued / Emitido: ${issuedIso}` : null,
      'Ride Car Sharing LLC',
    ].filter((line) => line !== null).join('\n'),
  };
}

/**
 * Send it. BEST-EFFORT: this function NEVER throws.
 *
 * THE FAILURE THIS SHAPE EXISTS FOR. The invite is already minted and stored
 * hashed by the time we get here. If a mailer outage were allowed to propagate
 * as an error, the natural reading at the route would be "the request failed",
 * and the operator would be left with a live PENDING_AUTHORIZATION row, a
 * revoked predecessor, and a link that exists nowhere retrievable. So the send
 * reports its outcome as DATA and the caller decides what to say — which is
 * why the route still returns the URL, and the banner still shows it.
 *
 * `sendEmail` is injectable and the real mailer is imported LAZILY, both for
 * the same reason as billing-notify: the billing suites must stay runnable on
 * a laptop with no Postgres and no SMTP, and a test must not be one forgotten
 * stub away from mailing a real tenant.
 */
export async function sendEnrollInviteEmail(input = {}, deps = {}) {
  const log = deps.logger || logger;
  const env = deps.env || process.env;
  const token = input.token || null;

  const to = String(input.to || '').trim();
  if (!to) {
    // Should be unreachable — issueEnrollInvite refuses an invite with no
    // billing contact — but an unsent email must never look like a sent one.
    log.warn('[billing-invite-email] no recipient on the invite; nothing sent', {
      inviteId: input.inviteId || null,
    });
    return { sent: false, reason: INVITE_EMAIL_RESULT.NO_RECIPIENT };
  }

  if (!deps.sendEmail && !mailerConfigured(env)) {
    log.warn('[billing-invite-email] no mail provider configured; link NOT emailed', {
      inviteId: input.inviteId || null,
      // The prefix identifies the invite for support. Never the token.
      tokenPrefix: input.tokenPrefix || null,
    });
    return { sent: false, reason: INVITE_EMAIL_RESULT.MAILER_NOT_CONFIGURED, to };
  }

  const message = buildEnrollInviteEmail(input);

  try {
    const sendEmail = deps.sendEmail || (await import('../../lib/mailer.js')).sendEmail;
    await sendEmail({
      // NO tenantId. That argument resolves the sender from the TENANT's brand,
      // and this is Ride writing to a tenant about Ride's own invoice — it must
      // arrive from the platform, not from the customer's own company. Same
      // call billing-notify makes, for the same reason.
      to,
      subject: message.subject,
      text: message.text,
    });
    log.info('[billing-invite-email] enrollment link emailed', {
      inviteId: input.inviteId || null,
      tenantId: input.tenantId || null,
      tokenPrefix: input.tokenPrefix || null,
    });
    return { sent: true, reason: INVITE_EMAIL_RESULT.SENT, to };
  } catch (err) {
    // The provider's own message is scrubbed and kept to the LOG. It is never
    // returned to the caller and never audited: a mail provider that rejects a
    // body tends to quote the body back, and the body contains the link.
    log.error('[billing-invite-email] send failed; the link was NOT delivered', {
      inviteId: input.inviteId || null,
      tenantId: input.tenantId || null,
      tokenPrefix: input.tokenPrefix || null,
      message: scrubToken(err?.message || String(err), token),
    });
    return { sent: false, reason: INVITE_EMAIL_RESULT.SEND_FAILED, to };
  }
}

export const billingInviteEmail = {
  buildEnrollInviteEmail,
  sendEnrollInviteEmail,
  mailerConfigured,
  scrubToken,
  INVITE_EMAIL_RESULT,
};
