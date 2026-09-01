import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../../core/api/dto/dashboard.dart';
import '../../../../core/api/dto/reservation_card.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/router/app_router.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../checkout/application/checkout_entry_controller.dart';
import '../../../checkout/domain/checkout_entry.dart';
import '../../../checkout/presentation/widgets/entry_guard_sheet.dart';
import '../../../shell/location_sheet.dart';
import '../../domain/dashboard_queues.dart';

/// Cards de cola (mockup 5A) y sus piezas. Regla de motion VINCULANTE: los
/// chips de HORA son estáticos — el dot solo existe en estados VIVOS (un
/// incidente abierto), jamás pulsando junto a un "Hoy 10:30".

/// Nombre localizado de cada cola — una sola tabla para headers, chips
/// colapsados y la vista de lista.
String queueNameOf(AppLocalizations l10n, DashboardQueue queue) =>
    switch (queue) {
      DashboardQueue.issueEscalations => l10n.queueIssueEscalations,
      DashboardQueue.checkout => l10n.queueCheckout,
      DashboardQueue.returns => l10n.queueReturns,
      DashboardQueue.precheckin => l10n.queuePrecheckin,
      DashboardQueue.loanerAdvisorFollowup => l10n.queueLoanerAdvisorFollowup,
      DashboardQueue.loanerReady => l10n.queueLoanerReady,
      DashboardQueue.loanerBillingReview => l10n.queueLoanerBillingReview,
      DashboardQueue.loanerReturns => l10n.queueLoanerReturns,
      DashboardQueue.active => l10n.queueActive,
    };

/// Hora corta según locale (es: 10:30 · en: 10:30 AM).
String _timeOf(String locale, DateTime dt) =>
    DateFormat.jm(locale).format(dt.toLocal());

/// "Hoy 10:30" / "Mañana 9:00" / "sáb, 22 ago 10:30" — fechas relativas
/// SOLO cuando son inequívocas; más allá de mañana, fecha completa.
String formatWhen(
  AppLocalizations l10n,
  String locale,
  DateTime dt,
  DateTime now,
) {
  final local = dt.toLocal();
  final today = DateTime(now.year, now.month, now.day);
  final day = DateTime(local.year, local.month, local.day);
  final diff = day.difference(today).inDays;
  if (diff == 0) return l10n.cardToday(_timeOf(locale, local));
  if (diff == 1) return l10n.cardTomorrow(_timeOf(locale, local));
  return '${DateFormat.MMMEd(locale).format(local)} ${_timeOf(locale, local)}';
}

/// "Vencido 1 h" / "Vencido 35 min" para retornos pasados de fecha.
String formatOverdue(AppLocalizations l10n, Duration overdue) {
  if (overdue.inHours >= 1) return l10n.cardOverdueHours(overdue.inHours);
  final minutes = overdue.inMinutes < 1 ? 1 : overdue.inMinutes;
  return l10n.cardOverdueMinutes(minutes);
}

enum ChipTone { neutral, warn, danger }

/// Chip de estado de las cards. [live] agrega el dot de "estado vivo" —
/// estático (el pulso queda para la fila de frescura; un grid de dots
/// latiendo en gama media es jank sin información).
class QueueStatusChip extends StatelessWidget {
  const QueueStatusChip({
    super.key,
    required this.label,
    this.tone = ChipTone.neutral,
    this.live = false,
  });

  final String label;
  final ChipTone tone;
  final bool live;

  @override
  Widget build(BuildContext context) {
    final (bg, bd, tx) = switch (tone) {
      ChipTone.neutral => (RideTokens.p50, RideTokens.brandA20, RideTokens.p800),
      ChipTone.warn => (RideTokens.warnBg, RideTokens.warnBd, RideTokens.warnTx),
      ChipTone.danger =>
        (RideTokens.dangerBg, RideTokens.dangerBd, RideTokens.dangerTx),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: bg,
        border: Border.all(color: bd),
        borderRadius: BorderRadius.circular(9),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (live) ...[
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(color: tx, shape: BoxShape.circle),
            ),
            const SizedBox(width: 5),
          ],
          Text(
            label,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w800,
              color: tx,
            ),
          ),
        ],
      ),
    );
  }
}

/// Esqueleto compartido de card: icono tonal 44 + cuerpo (nombre + chip +
/// meta). Plate blanco con borde — elevation = borde + sombra suave (regla
/// del sistema, nunca sombra sola).
class _QueueCardShell extends StatelessWidget {
  const _QueueCardShell({
    required this.icon,
    required this.iconBg,
    required this.iconColor,
    required this.title,
    required this.chip,
    required this.meta,
    this.trailing,
    this.onTap,
    this.busy = false,
  });

  final IconData icon;
  final Color iconBg;
  final Color iconColor;
  final String title;
  final Widget chip;
  final String meta;

  /// `.qcard.busy` del frame 11A: la card se tiñe tonal y su icono se vuelve
  /// spinner mientras el POST viaja. El arranque se siente EN la card — el
  /// agente sigue viendo su cola y puede tocar otra cosa; jamás una pantalla
  /// en blanco ni un overlay que secuestre la home.
  final bool busy;

  /// Affordance de acción al final de la fila (hoy: solo la cola de salidas
  /// — H6). Las demás cards siguen sin CTA a propósito: el detalle general
  /// de reserva es M3 y una card que "parece botón" sin destino miente.
  final Widget? trailing;

  /// GD MC-2 (review H6): con [onTap], la superficie es un [Material] BLANCO
  /// con [InkWell] encima — el ripple pinta de verdad (antes el Ink quedaba
  /// bajo un Container opaco y era invisible). La sombra vive en un wrapper
  /// sin color (la tinta no pinta sombras) y el margin inferior queda FUERA
  /// del target: el hueco entre cards no navega.
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final body = Row(
      children: [
        Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: busy ? RideTokens.p100 : iconBg,
            borderRadius: BorderRadius.circular(13),
          ),
          child: busy
              // `.spin.dk` — spinner de marca en el hueco del icono: el
              // movimiento vive donde el dedo tocó.
              ? const Padding(
                  padding: EdgeInsets.all(11),
                  child: CircularProgressIndicator(
                    strokeWidth: 3,
                    color: RideTokens.p600,
                  ),
                )
              : Icon(icon, size: 22, color: iconColor),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 14.5,
                        fontWeight: FontWeight.w800,
                        color: RideTokens.n900,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  chip,
                ],
              ),
              const SizedBox(height: 3),
              Text(
                meta,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                  color: RideTokens.n700,
                ),
              ),
            ],
          ),
        ),
        if (trailing != null) ...[
          const SizedBox(width: 8),
          trailing!,
        ],
      ],
    );

    if (onTap == null) {
      return Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: RideTokens.n0,
          border: Border.all(color: RideTokens.n200),
          borderRadius: BorderRadius.circular(20),
          boxShadow: const [
            BoxShadow(
              color: Color(0x1417122B),
              blurRadius: 14,
              offset: Offset(0, 4),
            ),
          ],
        ),
        child: body,
      );
    }

    return Padding(
      // Margin FUERA del hit-test (GD MC-2): entre cards no hay botón.
      padding: const EdgeInsets.only(bottom: 10),
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(20),
          boxShadow: const [
            BoxShadow(
              color: Color(0x1417122B),
              blurRadius: 14,
              offset: Offset(0, 4),
            ),
          ],
        ),
        child: Material(
          color: busy ? RideTokens.p50 : RideTokens.n0,
          clipBehavior: Clip.antiAlias,
          shape: RoundedRectangleBorder(
            side: BorderSide(
              color: busy ? RideTokens.brandA20 : RideTokens.n200,
            ),
            borderRadius: BorderRadius.circular(20),
          ),
          child: InkWell(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: body,
            ),
          ),
        ),
      ),
    );
  }
}

/// Card de reserva para cualquiera de las 8 colas de reservas. El chip y el
/// meta se derivan de la cola: la MISMA reserva se lee distinto en salidas
/// (pickup + pre-checkin) que en retornos (return + vencido).
class ReservationQueueCard extends ConsumerWidget {
  const ReservationQueueCard({
    super.key,
    required this.item,
    required this.queue,
    required this.now,
  });

  final ReservationCard item;
  final DashboardQueue queue;
  final DateTime now;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();

    final customer = [
      item.customer?.firstName,
      item.customer?.lastName,
    ].whereType<String>().where((s) => s.isNotEmpty).join(' ');
    final title = customer.isNotEmpty
        ? customer
        : (item.reservationNumber ?? item.id);

    // CTA de la cola de SALIDAS (M2-H7): la card ES el punto de partida del
    // checkout. SOLO esta cola — las demás cards siguen no-tocables a
    // propósito (detalle general en M3). Affordance explícita: chevron tonal
    // + toda la card tocable.
    final tappable = queue == DashboardQueue.checkout;
    // `.select`: la card solo re-construye por ESTE bool. Sin él, cada cambio
    // del sheet (enviando el link, link enviado, error) repintaría la card
    // entera detrás del scrim (Innovation #9).
    final busy = tappable &&
        ref.watch(
          checkoutEntryProvider(item.id).select((s) => s.starting),
        );

    final chip = busy
        ? QueueStatusChip(label: l10n.cardOpeningCheckoutChip, live: true)
        : _chipFor(l10n, locale);
    final meta = busy ? _metaFor(l10n, opening: true) : _metaFor(l10n);

    void open() {
      // Confirmación táctil ligera (GD O-1): la card es la única superficie
      // tocable del grid — el dedo merece saber que mordió.
      HapticFeedback.selectionClick();
      unawaited(_openCheckout(context, ref));
    }

    final shell = _QueueCardShell(
      icon: _iconFor(),
      iconBg: queue == DashboardQueue.loanerAdvisorFollowup
          ? RideTokens.warnBg
          : RideTokens.p50,
      iconColor: queue == DashboardQueue.loanerAdvisorFollowup
          ? RideTokens.warnTx
          : RideTokens.p700,
      title: title,
      chip: chip,
      meta: meta,
      busy: busy,
      onTap: tappable ? open : null,
      trailing: tappable
          ? Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(
                color: RideTokens.p50,
                border: Border.all(color: RideTokens.brandA20),
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Icon(
                Icons.chevron_right_rounded,
                size: 18,
                color: RideTokens.p700,
              ),
            )
          : null,
    );
    if (!tappable) return shell;

    // GD MC-3 (review H6): el label lleva título + hora del chip + meta —
    // TalkBack no puede perder "Hoy 2:03 PM" ni "Falta pre-checkin" por el
    // ExcludeSemantics. GD MC-1: la acción también en el nodo Semantics.
    //
    // En marcha, el `details` se arma con el chip y la meta ESTÁTICOS: si se
    // reusara el visual, el label diría "Abriendo… · abriendo checkout…"
    // además de la frase de acción — tres veces lo mismo en el oído del
    // agente. El estado lo aporta la frase de acción, una sola vez.
    final chipText =
        item.pickupAt == null ? null : formatWhen(l10n, locale, item.pickupAt!, now);
    final staticMeta = _metaFor(l10n);
    final details = [
      title,
      ?chipText,
      if (staticMeta.isNotEmpty) staticMeta,
    ].join(' · ');
    return Semantics(
      button: true,
      // liveRegion (GD MC-3): el nodo ya está enfocado cuando el label cambia,
      // y sin esto TalkBack NO re-anuncia — la card se tiñe y el lector calla
      // durante los 400 ms a 12 s que tarda el POST.
      liveRegion: busy,
      label: busy
          ? l10n.cardOpeningCheckoutSemantics(details)
          : l10n.cardOpenCheckoutSemantics(details),
      onTap: open,
      child: ExcludeSemantics(child: shell),
    );
  }

  /// Frame 11A → 11B–11E. `POST /api/checkout-sessions` (idempotente por
  /// reserva: si ya hay sesión la REANUDA) y, según lo que conteste el
  /// servidor, se navega o se explica.
  ///
  /// Nunca se navega optimistamente (nota 1): entrar al wizard para regresar
  /// con un error es peor que esperar mirando la propia cola.
  Future<void> _openCheckout(BuildContext context, WidgetRef ref) async {
    final controller = ref.read(checkoutEntryProvider(item.id).notifier);
    final outcome = await controller.start();
    if (!context.mounted) return;
    switch (outcome) {
      case CheckoutEntryOutcome.opened:
      case CheckoutEntryOutcome.terminal:
        // La sesión terminal también entra al wizard: ahí vive el frame 11E
        // con el events log REAL (el 409 no trae la fila).
        await context.push(AppRoutes.checkout(item.id));
      case CheckoutEntryOutcome.busy:
        return; // anti-doble-tap: ya hay un POST en vuelo
      case CheckoutEntryOutcome.aborted:
        // El alcance cambió con el POST en vuelo. El estado del controller ya
        // no aplica (es de otra sede), así que el bloque se construye AQUÍ y
        // se dice lo único cierto: pudo haberse creado, vuelve a tocar.
        await _showGuard(
          context,
          ref,
          const CheckoutEntryBlock(kind: CheckoutEntryBlockKind.scopeChanged),
        );
      case CheckoutEntryOutcome.blocked:
        final block = ref.read(checkoutEntryProvider(item.id)).block;
        if (block == null) return;
        await _showGuard(context, ref, block);
    }
  }

  /// Monta el sheet del guard y ejecuta su salida.
  ///
  /// El estado del sheet (link enviado / fallo) se limpia SIEMPRE al cerrarse
  /// —botón, swipe o toque en el scrim— (GD MC-7): si sobreviviera, el agente
  /// que desliza el sheet y vuelve a tocar la card se encontraría el aviso
  /// verde de un envío viejo y el primario ya consumido, sin explicación.
  Future<void> _showGuard(
    BuildContext context,
    WidgetRef ref,
    CheckoutEntryBlock block,
  ) async {
    final action = await showCheckoutEntryGuardSheet(
      context,
      reservationId: item.id,
      block: block,
    ).whenComplete(
      () => ref.read(checkoutEntryProvider(item.id).notifier).dismissBlock(),
    );
    if (!context.mounted) return;
    switch (action) {
      case CheckoutEntrySheetAction.retry:
        await _openCheckout(context, ref);
      case CheckoutEntrySheetAction.searchConflict:
        // Lo que la app SÍ puede hacer hoy con la otra reserva: buscarla.
        // El detalle de reserva llega en M3.
        final number = block.conflictReservationNumber;
        if (number != null) {
          await context.push(
            '${AppRoutes.search}?q=${Uri.encodeQueryComponent(number)}',
          );
        }
      case CheckoutEntrySheetAction.changeLocation:
        await showActiveLocationSheet(context);
      case null:
        return;
    }
  }

  IconData _iconFor() => switch (queue) {
        DashboardQueue.precheckin => Icons.assignment_outlined,
        DashboardQueue.loanerAdvisorFollowup => Icons.schedule_rounded,
        DashboardQueue.loanerBillingReview => Icons.receipt_long_outlined,
        DashboardQueue.returns ||
        DashboardQueue.loanerReturns ||
        DashboardQueue.active =>
          Icons.u_turn_left_rounded,
        _ => Icons.directions_car_outlined,
      };

  Widget _chipFor(AppLocalizations l10n, String locale) {
    switch (queue) {
      case DashboardQueue.checkout:
        final at = item.pickupAt;
        if (at == null) return const SizedBox.shrink();
        // Salida sin pre-checkin: hora en warn (mockup 5A) — el mostrador
        // sabrá que falta papeleo ANTES de que llegue el cliente.
        return QueueStatusChip(
          label: formatWhen(l10n, locale, at, now),
          tone: item.customerInfoCompletedAt == null
              ? ChipTone.warn
              : ChipTone.neutral,
        );
      case DashboardQueue.returns:
      case DashboardQueue.active:
      case DashboardQueue.loanerReturns:
        final at = item.returnAt;
        if (at == null) return const SizedBox.shrink();
        final overdue = now.difference(at.toLocal());
        if (overdue > Duration.zero) {
          return QueueStatusChip(
            label: formatOverdue(l10n, overdue),
            tone: ChipTone.danger,
          );
        }
        return QueueStatusChip(label: formatWhen(l10n, locale, at, now));
      case DashboardQueue.precheckin:
        return QueueStatusChip(
          label: item.customerInfoCompletedAt != null
              ? l10n.precheckinReady
              : l10n.precheckinMissing,
          tone: item.customerInfoCompletedAt != null
              ? ChipTone.neutral
              : ChipTone.warn,
        );
      case DashboardQueue.loanerReady:
        return QueueStatusChip(label: l10n.loanerReadyChip);
      case DashboardQueue.loanerAdvisorFollowup:
        return QueueStatusChip(
          label: _followupReason(l10n),
          tone: ChipTone.warn,
        );
      case DashboardQueue.loanerBillingReview:
        // Estado crudo del server (LoanerBillingStatus) — un valor nuevo no
        // crashea, se muestra tal cual (regla de resiliencia de enums.dart).
        return QueueStatusChip(
          label: item.loanerBillingStatus,
          tone: item.loanerBillingStatus == 'DENIED'
              ? ChipTone.danger
              : ChipTone.neutral,
        );
      case DashboardQueue.issueEscalations:
        return const SizedBox.shrink(); // los incidentes tienen su card
    }
  }

  /// Por qué esta reserva está en seguimiento — espejo del OR del server
  /// (employee-app.service.js: packet sin completar, servicio vencido sin
  /// ready, billing DENIED), en el mismo orden.
  String _followupReason(AppLocalizations l10n) {
    if (item.loanerBorrowerPacketCompletedAt == null) {
      return l10n.loanerFollowupPacket;
    }
    final est = item.estimatedServiceCompletionAt;
    if (item.readyForPickupAt == null &&
        est != null &&
        est.toLocal().isBefore(now)) {
      return l10n.loanerFollowupService;
    }
    return l10n.loanerFollowupBilling;
  }

  /// [opening]: frame 11A — mientras el POST viaja, la cola de la meta pasa de
  /// "Pre-checkin listo" a "abriendo checkout…". Se sustituye, no se agrega:
  /// la meta es una línea y el dato vivo manda.
  String _metaFor(AppLocalizations l10n, {bool opening = false}) {
    final v = item.vehicle;
    final parts = <String>[
      if (v?.make != null) '${v!.make}${v.year != null ? ' ${v.year}' : ''}',
      if (v?.internalNumber != null && v!.internalNumber!.isNotEmpty)
        v.internalNumber!,
      if (item.reservationNumber != null) item.reservationNumber!,
      if (opening)
        l10n.cardOpeningCheckoutMeta
      else if (queue == DashboardQueue.checkout)
        item.customerInfoCompletedAt != null
            ? l10n.precheckinReady
            : l10n.precheckinMissing,
      if (kLoanerQueues.contains(queue) && item.serviceAdvisorName.isNotEmpty)
        l10n.advisorLabel(item.serviceAdvisorName),
    ];
    return parts.join(' · ');
  }
}

/// Card NEUTRA para resultados de búsqueda (GD MC-2, review H4): los
/// resultados son reservas en CUALQUIER estado — vestirlas de "salida"
/// mentía (una reserva ya en renta mostraba "Falta pre-checkin" y una hora
/// de pickup pasada). Chip neutral con la fecha de pickup o el número de
/// reserva, meta factual, CERO capa interpretativa warn/pre-checkin; el
/// juicio de estado llega con el detalle de reserva en M3.
class SearchResultCard extends StatelessWidget {
  const SearchResultCard({super.key, required this.item, required this.now});

  final ReservationCard item;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();

    final customer = [
      item.customer?.firstName,
      item.customer?.lastName,
    ].whereType<String>().where((s) => s.isNotEmpty).join(' ');
    final title = customer.isNotEmpty
        ? customer
        : (item.reservationNumber ?? item.id);

    final pickupAt = item.pickupAt;
    final chipLabel = pickupAt != null
        ? formatWhen(l10n, locale, pickupAt, now)
        : item.reservationNumber;

    final v = item.vehicle;
    final meta = <String>[
      if (v?.make != null) '${v!.make}${v.year != null ? ' ${v.year}' : ''}',
      if (v?.internalNumber != null && v!.internalNumber!.isNotEmpty)
        v.internalNumber!,
      if (item.reservationNumber != null) item.reservationNumber!,
    ].join(' · ');

    return _QueueCardShell(
      icon: Icons.description_outlined,
      iconBg: RideTokens.p50,
      iconColor: RideTokens.p700,
      title: title,
      chip: chipLabel == null
          ? const SizedBox.shrink()
          : QueueStatusChip(label: chipLabel),
      meta: meta,
    );
  }
}

/// Card de incidente (cola issueEscalations, shape incidentCard). Chip VIVO:
/// OPEN en danger, UNDER_REVIEW en warn — con dot, porque el estado respira.
class IncidentQueueCard extends StatelessWidget {
  const IncidentQueueCard({super.key, required this.item, required this.now});

  final IncidentCard item;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final open = item.status == 'OPEN';
    final title = (item.title?.isNotEmpty ?? false)
        ? item.title!
        : (item.type ?? item.id);
    final reported = item.createdAt == null
        ? null
        : l10n.incidentReported(
            formatWhen(l10n, locale, item.createdAt!, now),
          );
    return _QueueCardShell(
      icon: Icons.warning_amber_rounded,
      iconBg: RideTokens.dangerBg,
      iconColor: RideTokens.dangerTx,
      title: title,
      chip: QueueStatusChip(
        // Estado desconocido del server: crudo, sin crash (resiliencia).
        label: open
            ? l10n.incidentOpen
            : (item.status == 'UNDER_REVIEW'
                ? l10n.incidentUnderReview
                : (item.status ?? '')),
        tone: open ? ChipTone.danger : ChipTone.warn,
        live: true,
      ),
      meta: [
        ?reported,
        if (item.description.isNotEmpty) item.description,
      ].join(' · '),
    );
  }
}
