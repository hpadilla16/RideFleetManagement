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
/// En su lugar se muestra el dato que SÍ existe: `autoEmailedAt`.
///
/// Y ese dato se afirma con cuidado (Innovation MUST-1): `autoEmailedAt` **no
/// es acuse de entrega**. `maybeSendFinalizeEmail`
/// (checkout-session.service.js:597-612) lo estampa ANTES de disparar el envío
/// —a propósito, con un `updateMany` guardado por null para ganar la carrera
/// entre dos transiciones simultáneas— y `scheduleEmailDelivery` es
/// fire-and-forget: si el SMTP está caído, el fallo va a logger/Sentry y jamás
/// vuelve a la fila. O sea: el sello prueba que el envío se PIDIÓ, no que el
/// correo llegó. Es la misma clase de trampa que el `emailSent:false` de
/// `send-request-email`, y el copy la respeta: "se pidió el envío", nunca
/// "salió". Si el agente necesita certeza, la reserva tiene el rastro.
class CheckoutTerminalView extends StatelessWidget {
  const CheckoutTerminalView({
    super.key,
    required this.session,
    required this.myUserId,
    required this.onExit,
    this.onBack,
  });

  final CheckoutSessionDto session;

  /// Empleado de ESTE teléfono — sin él no se afirma "tú" (sesión degradada).
  final String? myUserId;

  final VoidCallback onExit;

  /// Vuelta al RESUMEN del cierre (19A/19B), cuando esta pantalla se abrió
  /// desde ahí. Sin esto el detalle era una puerta de un solo sentido
  /// (GD-MC-3): el resumen es el único sitio donde vive "Copiar el detalle
  /// para el mostrador", y el motivo del rechazo no sobrevive al re-fetch.
  /// null = se entró directo a una sesión ya cerrada (11E puro).
  final VoidCallback? onBack;

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
            // Sin events log (log truncado o fila vieja) el hero se queda solo:
            // centrado, como manda `.center-state`, en vez de pegado arriba
            // con medio metro de blanco debajo.
            shrinkWrap: events.isEmpty,
            physics: events.isEmpty
                ? const NeverScrollableScrollPhysics()
                : null,
            children: [
              if (events.isEmpty) const SizedBox(height: 24),
              _CenterState(
                cancelled: cancelled,
                title: cancelled
                    ? l10n.coTerminalCancelledTitle
                    : l10n.coTerminalClosedTitle,
                body: _heroBody(l10n, format, cancelled: cancelled, last: last),
                // El dato del contrato sube AL HERO (GD): responde la pregunta
                // que el agente trae ("¿y el contrato?") en el mismo bloque
                // donde le contamos qué pasó, no como pie de página bajo un
                // log que hay que scrollear.
                contractLine: session.autoEmailedAt == null
                    ? null
                    : l10n.coTerminalContractRequested(
                        format.format(session.autoEmailedAt!.toLocal()),
                      ),
              ),
              const SizedBox(height: 16),
              if (events.isNotEmpty)
                _EventLog(
                  events: events,
                  myUserId: myUserId,
                  format: format,
                ),
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
              if (onBack case final back?) ...[
                const SizedBox(height: 9),
                RideGhostButton(label: l10n.coBackToOutcome, onPressed: back),
              ],
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
  ///
  /// CANCELLED tiene sus propias frases (GD): antes caía al copy de máquina
  /// ("esta sesión ya es terminal") y perdía justo lo que el patio pregunta
  /// cuando algo se cancela — quién y cuándo.
  String _heroBody(
    AppLocalizations l10n,
    DateFormat format, {
    required bool cancelled,
    required CheckoutEvent? last,
  }) {
    final at = last?.at;
    if (at == null) return l10n.coTerminalBody;
    final time = format.format(at.toLocal());
    final actor = last!.actorKind(myUserId);
    if (cancelled) {
      return switch (actor) {
        CheckoutActorKind.you => l10n.coTerminalCancelledByYou(time),
        CheckoutActorKind.kiosk => l10n.coTerminalCancelledKiosk(time),
        CheckoutActorKind.otherAgent =>
          l10n.coTerminalCancelledOtherAgent(time),
        CheckoutActorKind.otherSurface => l10n.coTerminalCancelledAt(time),
      };
    }
    return switch (actor) {
      CheckoutActorKind.you => l10n.coTerminalDoneByYou(time),
      CheckoutActorKind.kiosk => l10n.coTerminalDoneKiosk(time),
      CheckoutActorKind.otherAgent => l10n.coTerminalDoneOtherAgent(time),
      CheckoutActorKind.otherSurface => l10n.coTerminalDoneAt(time),
    };
  }
}

/// `.center-state` + `.big-ic` del mockup: badge circular, título 22 y párrafo
/// de 300 px de ancho máximo, todo centrado.
class _CenterState extends StatelessWidget {
  const _CenterState({
    required this.cancelled,
    required this.title,
    required this.body,
    this.contractLine,
  });

  final bool cancelled;
  final String title;
  final String body;

  /// Línea del contrato (solo con `autoEmailedAt` sellado). Va dentro del hero
  /// porque responde la misma pregunta que el hero contesta.
  final String? contractLine;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          // El TAMAÑO CODIFICA SEVERIDAD (dictamen de GD, review H7): 64 —el
          // `.big-ic` base, que es exactamente lo que el frame 11E renderiza
          // en su `.ok`— para el cierre normal, y 76 —el de `.warn`/`.deny`—
          // solo cuando se canceló. Un veredicto verde no puede ser el badge
          // más grande del sistema.
          //
          // Lo que sí se conserva del arreglo de H1 es la SUPERFICIE: el icono
          // suelto de 34 px se leía como un error menor; el disco tonal con
          // borde se lee como un sello.
          width: cancelled ? 76 : 64,
          height: cancelled ? 76 : 64,
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
          child: Column(
            children: [
              Text(
                body,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: RideTokens.n700,
                  height: 1.4,
                ),
              ),
              if (contractLine != null) ...[
                const SizedBox(height: 6),
                Text(
                  contractLine!,
                  textAlign: TextAlign.center,
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
    // El log no lleva encabezado visible (el frame no lo dibuja: la tarjeta se
    // explica sola), pero TalkBack sí necesita saber qué está leyendo antes de
    // recitar cinco horas seguidas — de ahí el label del contenedor.
    return Semantics(
      container: true,
      label: l10n.coTerminalLogTitle,
      child: Container(
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
                          // responder una reclamación (medido 9.22:1).
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
