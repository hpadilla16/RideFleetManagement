import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_error.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../application/checkout_entry_controller.dart';
import '../../domain/checkout_entry.dart';

/// Qué eligió el agente en el sheet de negativa (frames 11B–11D).
enum CheckoutEntrySheetAction {
  /// Volver a intentar el POST — el guard pudo caerse hace 10 s en otra
  /// superficie (nota 3: la card avisa, el servidor decide).
  retry,

  /// Buscar la reserva en conflicto (solo 11D, y solo si el número se pudo
  /// leer del mensaje del servidor).
  searchConflict,

  /// Abrir el selector de sedes (403 de ubicación — la 4D del M1).
  changeLocation,
}

/// Sheet de negativa de creación. Plate OPACO (política de blur del M1: nada
/// de BackdropFilter sin señal de capacidad), scrim de marca y radio 28
/// (`--r-2xl` del mockup, el mismo del selector de sedes).
///
/// Devuelve la acción elegida, o null si el agente canceló.
Future<CheckoutEntrySheetAction?> showCheckoutEntryGuardSheet(
  BuildContext context, {
  required String reservationId,
  required CheckoutEntryBlock block,
}) {
  return showModalBottomSheet<CheckoutEntrySheetAction>(
    context: context,
    isScrollControlled: true,
    barrierColor: const Color(0x6B17122B),
    useSafeArea: true,
    backgroundColor: RideTokens.n0,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
    ),
    builder: (_) => CheckoutEntryGuardSheet(
      reservationId: reservationId,
      block: block,
    ),
  );
}

/// El cuerpo del sheet. Público para poder montarlo aislado en tests.
class CheckoutEntryGuardSheet extends ConsumerWidget {
  const CheckoutEntryGuardSheet({
    super.key,
    required this.reservationId,
    required this.block,
  });

  final String reservationId;
  final CheckoutEntryBlock block;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final entry = ref.watch(checkoutEntryProvider(reservationId));

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 44,
                height: 5,
                margin: const EdgeInsets.only(top: 4, bottom: 12),
                decoration: BoxDecoration(
                  color: RideTokens.n300,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
            ),
            // Flexible + shrinkWrap (patrón de steps_sheet): a escala de texto
            // 1.5–2.0 —normal en un teléfono de patio— el copy + el mensaje
            // crudo del servidor + tres botones no caben en el alto del sheet.
            // Sin esto, overflow amarillo justo en la pantalla que explica un
            // bloqueo.
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  _Header(block: block, l10n: l10n),
                  const SizedBox(height: 14),
                  ..._actions(context, ref, l10n, entry),
                  const SizedBox(height: 12),
                  Text(
                    _footOf(l10n),
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: RideTokens.n700,
                      height: 1.4,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ── acciones ──────────────────────────────────────────────────────────────

  List<Widget> _actions(
    BuildContext context,
    WidgetRef ref,
    AppLocalizations l10n,
    CheckoutEntryState entry,
  ) {
    void close([CheckoutEntrySheetAction? action]) {
      Navigator.of(context).pop(action);
    }

    final actions = <Widget>[];

    switch (block.kind) {
      case CheckoutEntryBlockKind.precheckin:
        // Salida REAL: el backend emite un token nuevo y manda el correo
        // (POST /:id/send-request-email kind=customer-info). El sheet se queda
        // abierto con el resultado — en el patio, la confirmación es el
        // comprobante.
        //
        // Enviado ⇒ el primario se convierte en "Cerrar" (GD): dejar el botón
        // de enviar al 55 % sin decir por qué se lee como una app trabada.
        actions.add(
          entry.linkSent
              ? RidePrimaryButton(
                  label: l10n.coEntryClose,
                  onPressed: close,
                )
              : RidePrimaryButton(
                  label: l10n.coEntrySendPrecheckinLink,
                  loading: entry.sendingLink,
                  loadingLabel: l10n.coEntrySendingPrecheckinLink,
                  onPressed: entry.sendingLink
                      ? null
                      : () => ref
                          .read(checkoutEntryProvider(reservationId).notifier)
                          .sendPrecheckinLink(),
                ),
        );
        if (entry.linkSent) {
          actions.addAll([
            const SizedBox(height: 9),
            _Notice(text: l10n.coEntryPrecheckinLinkSent, ok: true),
          ]);
        } else if (entry.linkError != null) {
          actions.addAll([
            const SizedBox(height: 9),
            _Notice(text: _linkFailureOf(l10n, entry.linkError!), ok: false),
          ]);
        }

      case CheckoutEntryBlockKind.vehicleConflict:
        final number = block.conflictReservationNumber;
        if (number != null) {
          // "Abrir la otra reserva" con lo que la app SÍ tiene hoy: la
          // búsqueda. Jamás un swap sobre un `:id` de sesión que no existe —
          // en este guard la sesión no llegó a crearse.
          actions.add(
            RidePrimaryButton(
              label: l10n.coEntrySearchReservation(number),
              onPressed: () => close(CheckoutEntrySheetAction.searchConflict),
            ),
          );
        }

      case CheckoutEntryBlockKind.locationDenied:
        // La 4D del M1 ya resolvió esta negativa: la salida es el selector,
        // que consulta /selectable SIN el header (así la lista de escape nunca
        // está envenenada por la sede denegada). Lo ABRE la pantalla que montó
        // este sheet: sobre un context ya popeado no se puede.
        actions.add(
          RidePrimaryButton(
            label: l10n.locationDeniedChangeButton,
            onPressed: () => close(CheckoutEntrySheetAction.changeLocation),
          ),
        );

      case CheckoutEntryBlockKind.noVehicle:
      case CheckoutEntryBlockKind.ageRules:
      case CheckoutEntryBlockKind.terminal:
      case CheckoutEntryBlockKind.forbidden:
      case CheckoutEntryBlockKind.offline:
      case CheckoutEntryBlockKind.connectionLost:
      case CheckoutEntryBlockKind.rateLimited:
      case CheckoutEntryBlockKind.locationNotReady:
      case CheckoutEntryBlockKind.scopeChanged:
      case CheckoutEntryBlockKind.unknown:
        break;
    }

    if (block.retriable) {
      // Reintentar es honesto aquí y solo aquí: estos guards SÍ pueden caerse
      // solos (el pre-checkin se completó, la otra renta entró, volvió la
      // señal). En la sesión terminal no se ofrece — nota 8.
      //
      // Sube a PRIMARIO cuando es la única salida que la app puede cumplir
      // (11C: asignar el vehículo todavía se hace desde el escritorio) — la
      // recuperación va en primario, como en el resto del sistema.
      final onlyExit = actions.isEmpty;
      if (!onlyExit) actions.add(const SizedBox(height: 9));
      void retry() => close(CheckoutEntrySheetAction.retry);
      actions.add(
        onlyExit
            ? RidePrimaryButton(label: l10n.retryButton, onPressed: retry)
            : RideGhostButton(label: l10n.retryButton, onPressed: retry),
      );
    }

    actions.addAll([
      const SizedBox(height: 9),
      RideGhostButton(label: l10n.cancelButton, onPressed: close),
    ]);
    return actions;
  }

  /// Pie del sheet. La pregunta que responde es UNA: ¿quedó basura a medias?
  /// (nota 5). "No se creó ninguna sesión" es una AFIRMACIÓN, y solo se
  /// imprime donde la app puede sostenerla:
  ///
  ///  - los guards con veredicto del servidor (404/409/422/403): el backend
  ///    abortó antes del `checkoutSession.create` (service:127-181) y lo dijo;
  ///  - el corte por falta de red y el de sede sin hidratar: la petición nunca
  ///    salió del aparato.
  ///
  /// Los dos casos SIN veredicto —el POST salió y su respuesta se perdió (por
  /// timeout o por cambio de alcance)— llevan el pie honesto: el servidor pudo
  /// haber creado la sesión Y el contrato con sus renglones de precio
  /// (service:194-209) mientras la app se quedaba sin respuesta.
  String _footOf(AppLocalizations l10n) =>
      switch (block.kind) {
        CheckoutEntryBlockKind.precheckin => l10n.coEntryReservationUntouched,
        CheckoutEntryBlockKind.scopeChanged => l10n.coEntryScopeChangedFoot,
        CheckoutEntryBlockKind.connectionLost =>
          l10n.coEntryConnectionLostFoot,
        _ => l10n.coEntryNoSessionCreated,
      };

  /// Por qué falló el envío del link. Los dos casos que el backend produce de
  /// verdad NO son "algo salió mal":
  ///  - **429**: es un COOLDOWN POR RESERVA (reservations.routes.js:1621) —
  ///    "ese correo ya salió hace un momento", no saturación del sistema.
  ///    Decirle al agente que espere por carga lo invita a martillar el botón;
  ///    decirle que ya salió le da el hecho accionable (avisar al cliente que
  ///    revise su bandeja).
  ///  - **400**: la única 400 que esta app puede provocar es
  ///    `No recipient email found` (routes:1634) — el `kind` va fijo en el
  ///    cliente, así que no hay otro 400 alcanzable. Es el fallo MÁS probable
  ///    (cliente sin correo en la reserva) y merece copy propio en vez de un
  ///    mensaje en inglés incrustado.
  String _linkFailureOf(AppLocalizations l10n, ApiError error) =>
      switch (error) {
        ApiError(kind: ApiErrorKind.rateLimited) =>
          l10n.coEntryPrecheckinLinkCooldown,
        ApiError(status: 400) => l10n.coEntryPrecheckinNoEmail,
        ApiError(kind: ApiErrorKind.network) =>
          l10n.coEntryPrecheckinLinkFailed(l10n.errorNoConnectionRetry),
        _ => l10n.coEntryPrecheckinLinkFailed(
            error.message.isEmpty ? l10n.genericError : error.message,
          ),
      };
}

/// Badge + título + cuerpo + los datos que solo el servidor tiene.
class _Header extends StatelessWidget {
  const _Header({required this.block, required this.l10n});

  final CheckoutEntryBlock block;
  final AppLocalizations l10n;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _Badge(tone: _toneOf(block.kind), icon: _iconOf(block.kind)),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                _titleOf(l10n),
                style: const TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w900,
                  color: RideTokens.n900,
                  height: 1.25,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                _bodyOf(l10n),
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: RideTokens.n700,
                  height: 1.4,
                ),
              ),
              if (block.conflictReservationNumber != null) ...[
                const SizedBox(height: 6),
                Text(
                  l10n.coEntryConflictWith(block.conflictReservationNumber!),
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                    color: RideTokens.n900,
                  ),
                ),
              ],
              // Notas de cierre por guard: la del 11B sostiene la decisión de
              // NO dibujar "Capturar sus datos aquí" (esa captura vive en el
              // escritorio) — sin renderizarla, el agente busca en la app un
              // botón que no existe.
              if (_noteOf(l10n) case final note?) ...[
                const SizedBox(height: 8),
                Text(
                  note,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: RideTokens.n700,
                    height: 1.4,
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  String _titleOf(AppLocalizations l10n) => switch (block.kind) {
        CheckoutEntryBlockKind.noVehicle => l10n.coEntryNoVehicleTitle,
        CheckoutEntryBlockKind.vehicleConflict =>
          l10n.coEntryVehicleConflictTitle,
        CheckoutEntryBlockKind.precheckin => l10n.coEntryPrecheckinTitle,
        CheckoutEntryBlockKind.ageRules => l10n.coEntryAgeTitle,
        CheckoutEntryBlockKind.offline => l10n.coEntryOfflineTitle,
        CheckoutEntryBlockKind.connectionLost =>
          l10n.coEntryConnectionLostTitle,
        CheckoutEntryBlockKind.locationNotReady => l10n.coEntryNotReadyTitle,
        CheckoutEntryBlockKind.scopeChanged => l10n.coEntryScopeChangedTitle,
        CheckoutEntryBlockKind.locationDenied => l10n.locationDeniedTitle,
        CheckoutEntryBlockKind.forbidden => l10n.forbiddenTitle,
        CheckoutEntryBlockKind.rateLimited ||
        CheckoutEntryBlockKind.terminal ||
        CheckoutEntryBlockKind.unknown =>
          l10n.coLoadFailedTitle,
      };

  String _bodyOf(AppLocalizations l10n) {
    switch (block.kind) {
      case CheckoutEntryBlockKind.noVehicle:
        return l10n.coEntryNoVehicleBody;
      case CheckoutEntryBlockKind.vehicleConflict:
        // El mensaje del servidor es el ÚNICO portador de la diferencia entre
        // "still out on open rental RES-1001" (la unidad no volvió al patio:
        // hay que cerrar esa renta o buscar el carro) y "conflict with
        // reservation RES-1001" (choque de fechas: hay que reasignar). Dos
        // siguientes pasos distintos que sin esta línea se ven idénticos.
        return '${l10n.coEntryVehicleConflictBody}\n'
            '${l10n.coEntryServerSaid(block.message)}';
      case CheckoutEntryBlockKind.precheckin:
        return l10n.coEntryPrecheckinBody;
      case CheckoutEntryBlockKind.ageRules:
        // El mensaje del servidor ES la regla ("must be at least 25…"): se
        // muestra pegado al copy porque ahí vive el dato concreto.
        return '${l10n.coEntryAgeBody}\n${l10n.coEntryServerSaid(block.message)}';
      case CheckoutEntryBlockKind.offline:
        return l10n.coEntryOfflineBody;
      case CheckoutEntryBlockKind.connectionLost:
        return l10n.coEntryConnectionLostBody;
      case CheckoutEntryBlockKind.locationNotReady:
        return l10n.coEntryNotReadyBody;
      case CheckoutEntryBlockKind.scopeChanged:
        return l10n.coEntryScopeChangedBody;
      case CheckoutEntryBlockKind.locationDenied:
        return l10n.locationDeniedBodyGeneric;
      case CheckoutEntryBlockKind.forbidden:
        // 403 de módulo/RBAC: el backend escribe mensajes legibles; se
        // muestran tal cual (DoD #5), no se inventan.
        return block.message.isEmpty ? l10n.genericError : block.message;
      case CheckoutEntryBlockKind.rateLimited:
        return l10n.errorRateLimited;
      case CheckoutEntryBlockKind.terminal:
      case CheckoutEntryBlockKind.unknown:
        return block.message.isEmpty ? l10n.genericError : block.message;
    }
  }

  /// Nota que nombra DÓNDE vive lo que esta app todavía no hace.
  String? _noteOf(AppLocalizations l10n) => switch (block.kind) {
        CheckoutEntryBlockKind.precheckin => l10n.coEntryPrecheckinDeskNote,
        CheckoutEntryBlockKind.ageRules => l10n.coEntryAgeDeskNote,
        _ => null,
      };

  _Tone _toneOf(CheckoutEntryBlockKind kind) => switch (kind) {
        // Ámbar = falta algo que se puede resolver; rojo = negativa dura.
        CheckoutEntryBlockKind.vehicleConflict ||
        CheckoutEntryBlockKind.locationDenied ||
        CheckoutEntryBlockKind.forbidden =>
          _Tone.deny,
        _ => _Tone.warn,
      };

  IconData _iconOf(CheckoutEntryBlockKind kind) => switch (kind) {
        CheckoutEntryBlockKind.noVehicle => Icons.no_transfer_rounded,
        CheckoutEntryBlockKind.vehicleConflict => Icons.car_crash_outlined,
        CheckoutEntryBlockKind.precheckin => Icons.assignment_late_outlined,
        CheckoutEntryBlockKind.ageRules => Icons.badge_outlined,
        CheckoutEntryBlockKind.offline => Icons.wifi_off_rounded,
        // Distinto del wifi_off a propósito: "salió y no volvió" no es "no hay
        // señal", y el icono es lo primero que el agente lee en el patio.
        CheckoutEntryBlockKind.connectionLost => Icons.sync_problem_rounded,
        CheckoutEntryBlockKind.locationDenied ||
        CheckoutEntryBlockKind.forbidden =>
          Icons.gpp_bad_outlined,
        _ => Icons.error_outline_rounded,
      };
}

enum _Tone { warn, deny }

/// `.big-ic` de 52 del frame (el sheet usa el badge chico; el grande es el de
/// la pantalla terminal).
class _Badge extends StatelessWidget {
  const _Badge({required this.tone, required this.icon});

  final _Tone tone;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final (bg, bd, fg) = switch (tone) {
      _Tone.warn => (RideTokens.warnBg, RideTokens.warnBd, RideTokens.warnTx),
      _Tone.deny =>
        (RideTokens.dangerBg, RideTokens.dangerBd, RideTokens.dangerTx),
    };
    return Container(
      width: 52,
      height: 52,
      decoration: BoxDecoration(
        color: bg,
        shape: BoxShape.circle,
        border: Border.all(color: bd, width: 1.5),
      ),
      child: Icon(icon, size: 24, color: fg),
    );
  }
}

/// Confirmación (o fallo) del envío del link, DENTRO del sheet.
class _Notice extends StatelessWidget {
  const _Notice({required this.text, required this.ok});

  final String text;
  final bool ok;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: ok ? RideTokens.okBg : RideTokens.dangerBg,
        border: Border.all(color: ok ? RideTokens.okBd : RideTokens.dangerBd),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            ok ? Icons.mark_email_read_outlined : Icons.error_outline_rounded,
            size: 18,
            color: ok ? RideTokens.okTx : RideTokens.dangerTx,
          ),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: ok ? RideTokens.okTx : RideTokens.dangerTx,
                height: 1.35,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
