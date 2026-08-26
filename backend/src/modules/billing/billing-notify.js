/**
 * Billing state-change notifications — who finds out that a tenant stopped
 * paying, and how.
 *
 * RECIPIENT: THE PLATFORM OWNER, AND ONLY THE PLATFORM OWNER, IN THIS PHASE.
 * Design open question 11 asks whether a tenant gets a durable billing-contact
 * field, whose first ADMIN is emailed, or whether the address typed at invite
 * time is the one — and that question is UNANSWERED. Emailing a guess would be
 * worse than emailing nobody: the first PAST_DUE mail a customer ever receives
 * would land on whichever address a developer picked, possibly a personal
 * address of someone who does not handle the money, and it would look like a
 * phishing attempt for a bill they have not seen. So: the owner is told, the
 * owner decides who to call, and the tenant-facing dunning ladder ships with
 * Phase 5 once the question has an answer.
 *
 * The env chain follows the house idiom exactly (autocharge.worker.js
 * notifyStaffAutochargeFailed, long-term-billing.scheduler.js
 * notifyStaffCycleOverdue): a purpose-specific variable, falling back to the
 * shared ops address, and a WARN-and-return when neither is set. A missing
 * address must never throw into a webhook handler — the event is already safely
 * on disk by then, and losing the row to a mailer misconfiguration would be
 * trading a durable record for a notification.
 *
 * ONCE PER TRANSITION, NOT ONCE PER EVENT. The caller decides this, and it does
 * so from DATA rather than from a dedupe cache: a notification is sent only when
 * the stored status actually CHANGED. A second `subscription.suspended` against
 * an already-PAST_DUE row produces no status change and therefore no mail. That
 * rule works across every API worker and survives a restart, which an in-process
 * cache key would not.
 *
 * NOTHING HERE EVER PRINTS A TOKEN, A KEY, OR A CARD NUMBER. Brand + last4 is
 * the most card detail any of these messages carry, and that is what
 * Authorize.Net already gave us in masked form.
 */
import logger from '../../lib/logger.js';
import { formatMoney, formatCalendarDateEs } from './billing-dates.js';

/** Where owner-facing billing alarms go. */
export function ownerNotificationRecipient() {
  return String(
    process.env.BILLING_OWNER_NOTIFICATION_EMAIL
    || process.env.OPS_NOTIFICATION_EMAIL
    || '',
  ).trim();
}

/**
 * The message for each transition worth waking up for.
 *
 * PURE — no IO — so the copy is testable and so a phrasing change cannot break
 * the send path. Every one of these ends with WHAT THE TENANT MUST DO, because
 * an alert that says something is wrong without saying what fixes it just moves
 * the puzzle to the reader.
 */
export function buildOwnerNotification(kind, subscription = {}, extra = {}) {
  const company = subscription.authorizedName || subscription.tenantName || subscription.tenantId || 'un tenant';
  const plan = subscription.planNameSnapshot || subscription.planCode || 'su plan';
  const amount = subscription.amount == null ? null : `$${formatMoney(subscription.amount)} ${subscription.currency || 'USD'}`;
  const card = subscription.cardLast4
    ? `${subscription.cardBrand || 'tarjeta'} ····${subscription.cardLast4}`
    : 'la tarjeta registrada';
  // The fix is the same sentence in every message on purpose. There is exactly
  // one remedy for all of these, and it is not "call Authorize.Net".
  const remedy = `El tenant tiene que ACTUALIZAR SU MÉTODO DE PAGO: envíale un enlace de actualización de autopago (mode=update) para ${company}. `
    + 'Authorize.Net reintenta el cobro automáticamente, pero SOLO después de que se actualice el método de pago — '
    + 'la suscripción se queda suspendida indefinidamente hasta entonces. Esperar no la arregla.';

  const facts = [
    `Tenant: ${company}`,
    `Plan: ${plan}${amount ? ` — ${amount}` : ''}`,
    `Suscripción (referencia Authorize.Net): ${subscription.arbSubscriptionId || 'sin referencia'}`,
    `Método en archivo: ${card}`,
    subscription.nextChargeDate ? `Próximo cobro programado: ${formatCalendarDateEs(subscription.nextChargeDate)}` : null,
    extra.detectedBy ? `Detectado por: ${extra.detectedBy}` : null,
  ].filter(Boolean).join('\n');

  switch (kind) {
    case 'PAST_DUE':
      return {
        subject: `[Suscripción EN MORA] ${company} — ${amount || 'cobro'} rechazado`,
        text: `El cobro recurrente de ${company} falló y la suscripción quedó EN MORA (PAST_DUE).\n\n`
          + `${facts}\n\n${remedy}\n\n`
          + 'El acceso al sistema NO se ha cortado. Esto es solo un aviso.',
      };
    case 'SUSPENDED':
      return {
        subject: `[Suscripción SUSPENDIDA] ${company} — acceso cortado`,
        text: `${company} lleva en mora más allá del período de gracia y su suscripción pasó a SUSPENDED.\n\n`
          + `${facts}\n`
          + `${extra.pastDueSince ? `En mora desde: ${new Date(extra.pastDueSince).toISOString().slice(0, 10)}\n` : ''}`
          + `\n${remedy}`,
      };
    case 'CANCELLED':
      return {
        subject: `[Suscripción CANCELADA] ${company} — ya no se cobra`,
        text: `La suscripción de ${company} terminó en Authorize.Net (${subscription.cancelReason || 'sin razón registrada'}) `
          + 'y ya NO va a generar cobros.\n\n'
          + `${facts}\n\n`
          + 'Si nosotros no pedimos esta cancelación, revísala en el portal de Authorize.Net: '
          + 'una suscripción que se detiene sola es ingreso que deja de entrar sin que nadie lo pida.',
      };
    case 'RECOVERED':
      return {
        subject: `[Suscripción AL DÍA] ${company} — cobro liquidado`,
        text: `Entró un cobro liquidado de ${company} y la suscripción volvió a ACTIVE.\n\n${facts}\n\n`
          + 'No hay nada que hacer. Este aviso existe para cerrar el ciclo del aviso de mora anterior.',
      };
    case 'DRIFT':
      return {
        subject: `[Deriva de estado] ${company} — Authorize.Net dice ${extra.arbStatus || '?'}`,
        text: `La reconciliación diaria encontró que Authorize.Net y nosotros no coincidimos sobre ${company}.\n\n`
          + `Nosotros teníamos: ${extra.wasStatus}\n`
          + `Authorize.Net reporta: ${extra.arbStatus}\n`
          + `Se adoptó lo que dice Authorize.Net (${extra.becameStatus}) — es la fuente de verdad sobre si el dinero se mueve.\n\n`
          + `${facts}\n\n`
          + 'Se asentó un evento sintético reconcile.status-drift. Vale la pena entender POR QUÉ divergieron: '
          + 'casi siempre significa que un webhook no llegó.',
      };
    case 'NO_CHARGE_OBSERVED':
      return {
        subject: `[Cobro AUSENTE] ${company} — no hay transacción para una fecha que debió cobrar`,
        text: `La fecha de cobro de ${company} pasó hace más de ${extra.graceDays ?? '?'} días y Authorize.Net `
          + 'no reporta NINGUNA transacción que la cubra — ni aprobada ni rechazada.\n\n'
          + `${facts}\n\n`
          + 'Esto no es una tarjeta rechazada. Significa que o Authorize.Net no cobró, o nuestro entendimiento '
          + 'de cómo cobra está equivocado. Requiere que una persona lo mire en el portal.',
      };
    case 'WEBHOOK_SILENCE':
      return {
        subject: '[Webhooks de facturación EN SILENCIO] cero eventos verificados en 72 h',
        text: 'No ha llegado NI UN evento de webhook verificado a la cuenta de facturación de Ride en 72 horas.\n\n'
          + `Último evento verificado: ${extra.lastEventAt ? new Date(extra.lastEventAt).toISOString() : 'ninguno registrado'}\n`
          + `Suscripciones activas que deberían estar generando eventos: ${extra.liveSubscriptions ?? '?'}\n\n`
          + 'Nada más en el sistema detecta que el endpoint quedó silenciosamente inalcanzable — y esa es justo '
          + 'la falla que deja a los demás detectores viéndose sanos mientras nada funciona.\n\n'
          + 'Revisar, en este orden:\n'
          + '  1. La suscripción de webhooks en el portal de Authorize.Net (¿sigue activa? ¿apunta a la URL correcta?)\n'
          + '  2. El DNS y el certificado del endpoint público\n'
          + '  3. Si la Signature Key rotó — una llave vieja hace que TODO se rechace con 401 y nada se guarde\n'
          + '  4. BILLING_AUTHNET_SIGNATURE_KEY en el entorno del contenedor de API',
      };
    default:
      return null;
  }
}

/**
 * Send one owner notification. BEST-EFFORT, like recordAudit: it logs its own
 * failure and never throws into the caller.
 *
 * A webhook handler that died because the SMTP host was down would return a
 * non-2xx, Authorize.Net would retry a finite number of times, and the event
 * would eventually be lost — trading a durable row we control for a retry we
 * do not. The mail is the least important thing happening on this path.
 */
export async function notifyOwner(kind, subscription, extra = {}, deps = {}) {
  const log = deps.logger || logger;
  const message = buildOwnerNotification(kind, subscription, extra);
  if (!message) return { sent: false, reason: 'unknown-kind' };

  const to = deps.recipient || ownerNotificationRecipient();
  if (!to) {
    log.warn('[billing-notify] no BILLING_OWNER_NOTIFICATION_EMAIL / OPS_NOTIFICATION_EMAIL configured', {
      kind,
      subscriptionId: subscription?.id || null,
    });
    return { sent: false, reason: 'no-recipient' };
  }

  try {
    // Lazy so this module stays importable in the DB-free test chain, matching
    // how every other background sender in the repo pulls the mailer in.
    const sendEmail = deps.sendEmail || (await import('../../lib/mailer.js')).sendEmail;
    await sendEmail({
      // The TENANT's brand resolves the sender. This is Ride writing to Ride
      // about a tenant, so no tenantId: it must go out as the platform, not as
      // the customer whose bill bounced.
      to,
      subject: message.subject,
      text: message.text,
    });
    log.info('[billing-notify] owner notified', {
      kind,
      subscriptionId: subscription?.id || null,
      tenantId: subscription?.tenantId || null,
    });
    return { sent: true };
  } catch (err) {
    log.error('[billing-notify] owner notification failed', {
      kind,
      subscriptionId: subscription?.id || null,
      message: err?.message || String(err),
    });
    return { sent: false, reason: 'send-failed' };
  }
}

export const billingNotify = {
  ownerNotificationRecipient,
  buildOwnerNotification,
  notifyOwner,
};
