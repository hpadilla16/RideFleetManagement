/**
 * Shuttle tracker link invites — the DECISIONS (pure, no IO).
 *
 * SECURITY MODEL (Hector, 2026-08-15): there is no standing shuttle URL and no
 * shareable QR. Every link is minted per-reservation, tokenized, and expiring —
 * "no puede ser links que sean nada más para el cliente" — and it reaches the
 * customer by email AND SMS. This module decides who gets one, when it dies,
 * and what the messages say; the scheduler does the sending.
 *
 * WHY A SWEEP AND NOT A CONFIRMATION HOOK: reservations are born in at least
 * four places (admin UI, VozIA, storefront, imports). A hook covers the paths
 * someone remembered; a sweep over "pickup inside the lead window at a
 * tracker-enabled location" covers all of them, including reservations created
 * BEFORE the tenant turned the tracker on. Same reasoning as the pre-check-in
 * auto-invite (2026-06-28), whose shape this deliberately mirrors.
 */
import { renderBrandedEmail } from '../../lib/email-template.js';

/** Send the link this many hours before pickup — close enough to be relevant. */
export const LINK_LEAD_HOURS = 24;

/**
 * expiresAt = returnAt + 24h (Hector's spec): the same link keeps working for
 * the RETURN shuttle ride, then dies. Reservations without a return date fall
 * back to pickup + 48h; without either the link would be unmintable, so the
 * caller should never pass such a row.
 */
export function linkExpiresAt(reservation, now = new Date()) {
  const returnAt = reservation?.returnAt ? new Date(reservation.returnAt) : null;
  if (returnAt && !Number.isNaN(returnAt.getTime())) return new Date(returnAt.getTime() + 24 * 3600_000);
  const pickupAt = reservation?.pickupAt ? new Date(reservation.pickupAt) : null;
  if (pickupAt && !Number.isNaN(pickupAt.getTime())) return new Date(pickupAt.getTime() + 48 * 3600_000);
  return new Date(now.getTime() + 72 * 3600_000);
}

/**
 * Dedupe = the link row itself. ANY prior link for the reservation — active,
 * expired, even revoked — means no new invite: a revoked link is a staff
 * decision, and re-minting would silently overrule it.
 */
export function pickCandidates(rows, existingLinkReservationIds) {
  const taken = new Set(existingLinkReservationIds || []);
  return (rows || []).filter((r) => r && !taken.has(r.id));
}

/** A customer we cannot reach on ANY channel gets no link minted at all. */
export function reachable(customer) {
  return !!(String(customer?.email || '').trim() || String(customer?.phone || '').trim());
}

const isSpanish = (locale) => String(locale || '').toLowerCase().startsWith('es');

export function buildLinkEmail({ reservationNumber, customerName, link, locale, locationName }, brand) {
  const es = isSpanish(locale);
  const where = locationName || (es ? 'nuestra sede' : 'our location');
  const subject = es
    ? `Sigue tu shuttle en vivo${reservationNumber ? ` — Reserva ${reservationNumber}` : ''}`
    : `Track your shuttle live${reservationNumber ? ` — Reservation ${reservationNumber}` : ''}`;
  const heading = es ? 'Tu shuttle, en vivo' : 'Your shuttle, live';
  const greeting = es ? `Hola ${customerName || ''},`.trim() : `Hello ${customerName || ''},`.trim();
  const intro = es
    ? `Cuando llegues, abre este enlace para ver dónde está el shuttle de ${where} en tiempo real y las instrucciones de dónde esperarlo. El enlace es personal para tu reserva y expira después de tu renta.`
    : `When you arrive, open this link to see where the ${where} shuttle is in real time, with instructions on where to wait. The link is personal to your reservation and expires after your rental.`;
  const ctaLabel = es ? 'Ver mi shuttle' : 'Track my shuttle';
  const { html } = renderBrandedEmail({
    brand,
    heading,
    bodyHtml: `${greeting}<br/><br/>${intro}`,
    cta: link ? { label: ctaLabel, url: link } : null,
  });
  return { subject, text: `${greeting}\n\n${intro}\n\n${ctaLabel}: ${link}`, html };
}

/** SMS is one segment-ish and repeats nothing sensitive — just the link. */
export function buildLinkSms({ link, locale, locationName, companyName }) {
  const es = isSpanish(locale);
  const who = companyName || 'Ride Fleet';
  const where = locationName ? ` (${locationName})` : '';
  return es
    ? `${who}${where}: sigue tu shuttle en vivo y ve dónde esperarlo: ${link}`
    : `${who}${where}: track your shuttle live and see where to wait: ${link}`;
}
