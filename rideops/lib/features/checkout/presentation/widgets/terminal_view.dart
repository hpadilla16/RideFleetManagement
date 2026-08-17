import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../../core/api/dto/checkout_session.dart';
import '../../../../core/api/enums.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../domain/checkout_event_log.dart';
import '../checkout_labels.dart';

/// Frame 11E — sesión terminal (CLOSED / CANCELLED, y destino del 409
/// `SESSION_TERMINAL` al intentar crear).
///
/// Nota 6 del mockup: **esto no es un error, es una noticia.** Con 4
/// superficies conviviendo esta pantalla la va a ver mucha gente, así que
/// tiene el tono de un trabajo terminado (badge verde) y solo se pone en rojo
/// cuando de verdad se canceló. Nota 8: terminal significa terminal — no hay
/// "reintentar" ni "reabrir"; ofrecerlos sería mentir sobre la máquina de
/// estados. La única puerta es la reserva.
///
/// SOBRE "Ver el contrato" (el primario que dibuja el frame): NO se construye
/// en H7 y no es un olvido. El PDF vive detrás de un endpoint autenticado con
/// bearer, así que abrirlo en el navegador del sistema daría 401, y la app no
/// tiene visor ni `url_launcher` en el stack cerrado (ADR-2). Un botón que no
/// puede cumplir sería exactamente la "falsa puerta" que la nota 8 prohíbe.
/// En su lugar se muestra el DATO real que responde la misma pregunta cuando
/// existe: `autoEmailedAt` — "el contrato salió por correo a las 11:04".
class CheckoutTerminalView extends StatelessWidget {
  const CheckoutTerminalView({
    super.key,
    required this.session,
    required this.myUserId,
    required this.onExit,
  });

  final CheckoutSessionDto session;

  /// Empleado de ESTE teléfono — sin él no se afirma "tú" (sesión degradada).
  final String? myUserId;

  final VoidCallback onExit;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final format = DateFormat.Hm(Localizations.localeOf(context).toString());
    final cancelled = session.currentStep == CheckoutStep.cancelled.wire;

    // Log en orden CRONOLÓGICO (como el frame): el resumen se lee como una
    // historia — de 10:41 a 11:04 —, no como una bandeja de notificaciones.
    final events = [
      for (final e in parseCheckoutEvents(session.events))
        if (e.isTransition) e,
    ];
    final last = events.isEmpty ? null : events.last;

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 6),
            children: [
              _CenterState(
                cancelled: cancelled,
                title: cancelled
                    ? l10n.coTerminalCancelledTitle
                    : l10n.coTerminalClosedTitle,
                body: _heroBody(l10n, format, cancelled: cancelled, last: last),
              ),
              const SizedBox(height: 16),
              if (events.isNotEmpty)
                _EventLog(
                  events: events,
                  myUserId: myUserId,
                  format: format,
                ),
              if (session.autoEmailedAt != null) ...[
                const SizedBox(height: 10),
                Text(
                  l10n.coTerminalContractEmailed(
                    format.format(session.autoEmailedAt!.toLocal()),
                  ),
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: RideTokens.n700,
                  ),
                ),
              ],
            ],
          ),
        ),
        // Dock pegado (.dock): el resumen scrollea, la salida no se va de la
        // pantalla.
        Container(
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: RideTokens.n200)),
          ),
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
          child: Column(
            children: [
              RidePrimaryButton(
                label: l10n.coTerminalBackToList,
                onPressed: onExit,
              ),
              const SizedBox(height: 9),
              Text(
                l10n.coTerminalWhy,
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
    );
  }

  /// "Se completó en el kiosco a las 11:04. No hay nada más que hacer aquí."
  /// La atribución sale del events log (nota 7). Sin evento o sin hora no se
  /// inventa un dónde ni un cuándo: se dice lo único cierto.
  String _heroBody(
    AppLocalizations l10n,
    DateFormat format, {
    required bool cancelled,
    required CheckoutEvent? last,
  }) {
    final at = last?.at;
    if (cancelled || at == null) return l10n.coTerminalBody;
    final time = format.format(at.toLocal());
    return switch (last!.actorKind(myUserId)) {
      CheckoutActorKind.you => l10n.coTerminalDoneByYou(time),
      CheckoutActorKind.kiosk => l10n.coTerminalDoneKiosk(time),
      CheckoutActorKind.otherAgent => l10n.coTerminalDoneOtherAgent(time),
      CheckoutActorKind.otherSurface => l10n.coTerminalDoneAt(time),
    };
  }
}

/// `.center-state` + `.big-ic` del mockup: badge circular de 76, título 22 y
/// párrafo de 300 px de ancho máximo, todo centrado.
class _CenterState extends StatelessWidget {
  const _CenterState({
    required this.cancelled,
    required this.title,
    required this.body,
  });

  final bool cancelled;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          // 76 y no los 64 del `.big-ic` base: es el tamaño con el que el
          // sistema dibuja los badges de VEREDICTO (.warn/.deny de los frames
          // 11B-11D) y esta pantalla es uno de ellos. Antes vivía aquí un
          // icono suelto de 34 sin superficie — se leía como un error menor,
          // que es justo lo contrario de lo que esta pantalla comunica.
          width: 76,
          height: 76,
          decoration: BoxDecoration(
            color: cancelled ? RideTokens.dangerBg : RideTokens.okBg,
            shape: BoxShape.circle,
            border: Border.all(
              color: cancelled ? RideTokens.dangerBd : RideTokens.okBd,
              width: 1.5,
            ),
          ),
          child: Icon(
            cancelled ? Icons.close_rounded : Icons.check_rounded,
            size: 30,
            color: cancelled ? RideTokens.dangerTx : RideTokens.okTx,
          ),
        ),
        const SizedBox(height: 12),
        Text(
          title,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 22,
            fontWeight: FontWeight.w900,
            color: RideTokens.n900,
            height: 1.2,
          ),
        ),
        const SizedBox(height: 8),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 300),
          child: Text(
            body,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: RideTokens.n700,
              height: 1.4,
            ),
          ),
        ),
      ],
    );
  }
}

/// `.evlog` — resumen del events log en lenguaje humano y con atribución.
/// Los eventos crudos quedan para soporte, no para el patio (nota 7).
class _EventLog extends StatelessWidget {
  const _EventLog({
    required this.events,
    required this.myUserId,
    required this.format,
  });

  final List<CheckoutEvent> events;
  final String? myUserId;
  final DateFormat format;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Container(
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
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
      child: Column(
        children: [
          for (var i = 0; i < events.length; i++)
            Container(
              padding: const EdgeInsets.symmetric(vertical: 9),
              decoration: BoxDecoration(
                border: i == events.length - 1
                    ? null
                    : const Border(
                        bottom: BorderSide(color: RideTokens.n100),
                      ),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 50,
                    child: Text(
                      events[i].at == null
                          ? '—'
                          : format.format(events[i].at!.toLocal()),
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w800,
                        // n700 y no n600: es el dato que se lee al sol para
                        // responder una reclamación (contraste medido 9.22:1).
                        color: RideTokens.n700,
                        fontFeatures: [FontFeature.tabularFigures()],
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          stepLabel(l10n, events[i].to!),
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w700,
                            color: RideTokens.n900,
                          ),
                        ),
                        const SizedBox(height: 1),
                        Text(
                          _actorLabel(l10n, events[i]),
                          style: const TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w600,
                            color: RideTokens.n700,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  String _actorLabel(AppLocalizations l10n, CheckoutEvent event) =>
      switch (event.actorKind(myUserId)) {
        CheckoutActorKind.you => l10n.coTerminalByYou,
        CheckoutActorKind.kiosk => l10n.coTerminalByKiosk,
        CheckoutActorKind.otherAgent => l10n.coTerminalByOtherAgent,
        CheckoutActorKind.otherSurface => l10n.coTerminalByOtherSurface,
      };
}
