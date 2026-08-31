import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../application/checkout_close_controller.dart';
import '../../domain/checkout_step_catalog.dart';

/// `.steps3` del mockup — **los tres tramos del cierre, uno por renglón**
/// (18C, y otra vez en 19B/19C).
///
/// Por qué tres renglones y no un spinner: el cierre son TRES llamadas del
/// cliente, no una cascada del servidor. `saveCustomerSignature` solo sella
/// (checkout-session.service.js:664-694) y las transiciones
/// `CUSTOMER_SIGN_PENDING → FINALIZING → CLOSED` son dos POST más. Un solo
/// spinner escondería exactamente dónde se rompe cuando se rompe — que es lo
/// único que el agente necesita saber en 19B y 19C.
///
/// Ningún renglón se adelanta al 200 del servidor: `done` significa "el
/// servidor ya respondió", nunca "ya casi".
class CloseProgressCard extends StatelessWidget {
  const CloseProgressCard({
    super.key,
    required this.signature,
    required this.finalizing,
    required this.closing,
    this.signatureAt,
    this.failedAt,
  });

  final CloseLegState signature;
  final CloseLegState finalizing;
  final CloseLegState closing;

  /// Sello del SERVIDOR (`customerSignedAt`), no la hora del teléfono.
  final DateTime? signatureAt;

  /// Cuándo se recibió la negativa (19B: "Rechazado a las 11:06").
  final DateTime? failedAt;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final format = DateFormat.Hm(Localizations.localeOf(context).toString());

    String? detailFor(CloseLegState state, {required int position}) =>
        switch (state) {
          CloseLegState.done => null,
          CloseLegState.running =>
            l10n.coStepOf(position, kCheckoutLinearStepCount),
          CloseLegState.pending =>
            l10n.coCloseLegWaiting(position, kCheckoutLinearStepCount),
          CloseLegState.unknown => l10n.coCloseUnknownStep,
          CloseLegState.failed => failedAt == null
              ? null
              : l10n.coCloseFailedStep(format.format(failedAt!.toLocal())),
        };

    return Container(
      decoration: BoxDecoration(
        color: RideTokens.n0,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: RideTokens.n200),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 4),
      child: Column(
        children: [
          _LegRow(
            index: 1,
            label: l10n.coCloseStep1,
            state: signature,
            // El único renglón cuya hora sale de un SELLO del servidor. Con el
            // cierre a medias (19C) además se dice "confirmado": es lo que
            // separa lo que sí sabemos de lo que no.
            detail: switch (signature) {
              CloseLegState.done when signatureAt != null =>
                closing == CloseLegState.unknown ||
                        finalizing == CloseLegState.unknown
                    ? l10n.coCloseConfirmedAt(
                        format.format(signatureAt!.toLocal()),
                      )
                    : format.format(signatureAt!.toLocal()),
              _ => detailFor(signature, position: 8),
            },
          ),
          _LegRow(
            index: 2,
            label: l10n.coCloseStep2,
            state: finalizing,
            detail: detailFor(finalizing, position: 9),
            divided: true,
          ),
          _LegRow(
            index: 3,
            label: l10n.coCloseStep3,
            state: closing,
            detail: detailFor(closing, position: 10),
            divided: true,
          ),
        ],
      ),
    );
  }
}

class _LegRow extends StatelessWidget {
  const _LegRow({
    required this.index,
    required this.label,
    required this.state,
    required this.detail,
    this.divided = false,
  });

  final int index;
  final String label;
  final CloseLegState state;
  final String? detail;
  final bool divided;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    // Etiqueta de accesibilidad: el estado del renglón NO puede vivir solo en
    // un icono de 14 px (DoD #2 — el color/forma nunca es el único portador).
    final spoken = switch (state) {
      CloseLegState.done => l10n.coStepDone(''),
      CloseLegState.running => l10n.coStepInProgress,
      CloseLegState.pending => l10n.coStepPending,
      CloseLegState.failed => l10n.coCloseReasonTitle,
      CloseLegState.unknown => l10n.coCloseUnknownStep,
    };
    return Semantics(
      label: '$label. $spoken${detail == null ? '' : '. $detail'}',
      child: ExcludeSemantics(
        child: Container(
          constraints: const BoxConstraints(minHeight: 48),
          padding: const EdgeInsets.symmetric(vertical: 9),
          decoration: BoxDecoration(
            border: divided
                ? const Border(top: BorderSide(color: RideTokens.n100))
                : null,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _LegBadge(index: index, state: state),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      label,
                      style: TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w800,
                        color: state == CloseLegState.pending
                            ? RideTokens.n700
                            : RideTokens.n900,
                      ),
                    ),
                    if (detail != null) ...[
                      const SizedBox(height: 1),
                      Text(
                        detail!,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                          color: state == CloseLegState.failed
                              ? RideTokens.dangerTx
                              : RideTokens.n700,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Disco de 24 px con el estado del tramo. El pendiente lleva su NÚMERO —no un
/// círculo vacío— porque el agente tiene que poder decir "voy por el 2 de 3".
class _LegBadge extends StatelessWidget {
  const _LegBadge({required this.index, required this.state});

  final int index;
  final CloseLegState state;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (state) {
      CloseLegState.done => (RideTokens.okBg, RideTokens.okTx),
      CloseLegState.running => (RideTokens.p50, RideTokens.n900),
      CloseLegState.pending => (RideTokens.n100, RideTokens.n700),
      CloseLegState.failed => (RideTokens.dangerBg, RideTokens.dangerTx),
      CloseLegState.unknown => (RideTokens.warnBg, RideTokens.warnTx),
    };
    return Container(
      width: 24,
      height: 24,
      decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
      alignment: Alignment.center,
      child: switch (state) {
        CloseLegState.done => Icon(Icons.check_rounded, size: 15, color: fg),
        CloseLegState.failed => Icon(Icons.close_rounded, size: 15, color: fg),
        CloseLegState.running => SizedBox(
            width: 13,
            height: 13,
            child: CircularProgressIndicator(strokeWidth: 2.4, color: fg),
          ),
        // El "?" no es adorno (nota 9 del 19C): distingue "no pasó" de "no sé".
        CloseLegState.unknown => Text(
            '?',
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w900,
              color: fg,
            ),
          ),
        CloseLegState.pending => Text(
            '$index',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w900,
              color: fg,
            ),
          ),
      },
    );
  }
}
