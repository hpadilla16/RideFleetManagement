import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../../core/api/dto/checkout_session.dart';
import '../../../../core/api/enums.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../domain/checkout_event_log.dart';
import '../../domain/checkout_step_catalog.dart';
import '../checkout_labels.dart';

/// Lista completa de pasos (mockup 8B): hechos · actual · pendientes, con los
/// guards de entrada anunciados ANTES de que produzcan un 409.
///
/// Lo que el servidor reporta es lo único que manda: el paso actual sale de
/// `currentStep`, los "hechos" de la POSICIÓN reportada (la cadena es lineal
/// estricta) y la atribución del `events[]`. Nada aquí adivina el futuro: los
/// pendientes se dibujan inertes.
///
/// `CANCELLED` va aparte con borde punteado: es terminal ALTERNO alcanzable
/// desde cualquier paso no terminal, no el paso 11 de una fila — pintarlo en
/// línea recta mentiría sobre el grafo.
class StepsSheet extends StatefulWidget {
  const StepsSheet({
    super.key,
    required this.session,
    required this.myUserId,
    required this.dataAge,
  });

  final CheckoutSessionDto session;
  final String? myUserId;

  /// Edad de la última lectura — el sheet dice de cuándo es lo que muestra.
  final Duration dataAge;

  @override
  State<StepsSheet> createState() => _StepsSheetState();
}

class _StepsSheetState extends State<StepsSheet> {
  final _scrollController = ScrollController();
  final _currentKey = GlobalKey();

  @override
  void initState() {
    super.initState();
    // Auto-scroll al paso actual: con 10 pasos y guantes, abrir la lista y
    // tener que buscar dónde vas es una tarea extra que nadie pidió.
    _scrollToCurrent();
  }

  @override
  void didUpdateWidget(StepsSheet oldWidget) {
    super.didUpdateWidget(oldWidget);
    // El sheet es VIVO: si otra superficie mueve el paso con la lista abierta,
    // se sigue al nodo nuevo. Solo cuando el paso cambió — un re-render por
    // envejecer la edad del dato no debe robarle el scroll al agente.
    if (oldWidget.session.currentStep != widget.session.currentStep) {
      _scrollToCurrent();
    }
  }

  void _scrollToCurrent() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final ctx = _currentKey.currentContext;
      if (ctx == null || !mounted) return;
      Scrollable.ensureVisible(
        ctx,
        alignment: 0.35,
        duration: MediaQuery.of(context).disableAnimations
            ? Duration.zero
            : const Duration(milliseconds: 260),
      );
    });
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final events = parseCheckoutEvents(widget.session.events);
    final current = widget.session.step;
    final currentPosition = infoFor(current)?.position;
    final timeFormat = DateFormat.Hm(Localizations.localeOf(context).toString());

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 42,
              height: 4,
              decoration: BoxDecoration(
                color: RideTokens.n300,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text(
            l10n.coStepsSheetTitle(kCheckoutLinearStepCount),
            style: const TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w900,
              color: RideTokens.n900,
            ),
          ),
          const SizedBox(height: 3),
          Text(
            l10n.coStepsSheetSub(checkoutAgeLabel(l10n, widget.dataAge)),
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.n700,
            ),
          ),
          const SizedBox(height: 10),
          Flexible(
            child: ListView(
              controller: _scrollController,
              shrinkWrap: true,
              children: [
                for (final info in kCheckoutLinearSteps)
                  _StepItem(
                    key: info.step == current ? _currentKey : null,
                    info: info,
                    state: _stateOf(info, current, currentPosition),
                    session: widget.session,
                    events: events,
                    myUserId: widget.myUserId,
                    timeFormat: timeFormat,
                  ),
                // Paso desconocido reportado por el servidor: nodo genérico
                // con el nombre CRUDO. La app sigue viva y no "corrige".
                if (current == null &&
                    widget.session.currentStep != CheckoutStep.cancelled.wire)
                  _UnknownStepItem(rawStep: widget.session.currentStep),
                const SizedBox(height: 8),
                _CancelledItem(isCurrent: current == CheckoutStep.cancelled),
              ],
            ),
          ),
          const SizedBox(height: 10),
          _SheetGhostButton(
            label: l10n.coSheetClose,
            onTap: () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }

  _ItemState _stateOf(
    CheckoutStepInfo info,
    CheckoutStep? current,
    int? currentPosition,
  ) {
    if (current != null && info.step == current) return _ItemState.current;
    if (currentPosition != null && info.position < currentPosition) {
      return _ItemState.done;
    }
    return _ItemState.todo;
  }
}

enum _ItemState { done, current, todo }

class _StepItem extends StatelessWidget {
  const _StepItem({
    super.key,
    required this.info,
    required this.state,
    required this.session,
    required this.events,
    required this.myUserId,
    required this.timeFormat,
  });

  final CheckoutStepInfo info;
  final _ItemState state;
  final CheckoutSessionDto session;
  final List<CheckoutEvent> events;
  final String? myUserId;
  final DateFormat timeFormat;

  /// ¿El sello que este paso exige ya está puesto? Con el sello puesto el
  /// candado sobra: el guard ya no bloquea.
  bool get _guardSatisfied {
    return switch (info.entryGuard) {
      null => true,
      CheckoutEntryGuard.tcCompleted => session.tcCompletedAt != null,
      CheckoutEntryGuard.payment => session.paymentCompletedAt != null,
      CheckoutEntryGuard.inspection => session.inspectionCompletedAt != null,
      CheckoutEntryGuard.signature => session.customerSignedAt != null,
    };
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final event = lastTransitionTo(events, info.step.wire);
    final showLock =
        state == _ItemState.todo && info.entryGuard != null && !_guardSatisfied;

    final subtitle = switch (state) {
      _ItemState.done => doneLabel(
          l10n,
          event: event,
          myUserId: myUserId,
          time: event?.at == null ? '—' : timeFormat.format(event!.at!.toLocal()),
        ),
      _ItemState.current => l10n.coStepInProgress,
      _ItemState.todo => showLock
          ? guardLabel(l10n, info.entryGuard!)
          : l10n.coStepPending,
    };

    final bg = state == _ItemState.current ? RideTokens.p50 : RideTokens.n0;
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
      // 52 px explícitos: la lista se lee y se recorre con el pulgar, y una
      // fila que encoge según el largo del subtítulo hace saltar el ritmo.
      constraints: const BoxConstraints(minHeight: 52),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: state == _ItemState.current
              ? RideTokens.p200
              : RideTokens.n200,
        ),
      ),
      child: Row(
        children: [
          _Bullet(state: state, index: info.position),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  stepLabel(l10n, info.step.wire),
                  style: const TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w900,
                    color: RideTokens.n900,
                  ),
                ),
                Text(
                  subtitle,
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: RideTokens.n700,
                  ),
                ),
              ],
            ),
          ),
          if (showLock)
            const Icon(Icons.lock_outline_rounded,
                size: 17, color: RideTokens.n600),
        ],
      ),
    );
  }
}

class _Bullet extends StatelessWidget {
  const _Bullet({required this.state, required this.index});

  final _ItemState state;
  final int index;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (state) {
      _ItemState.done => (RideTokens.okBg, RideTokens.okTx),
      _ItemState.current => (RideTokens.p600, RideTokens.n0),
      _ItemState.todo => (RideTokens.n100, RideTokens.n700),
    };
    return Container(
      width: 26,
      height: 26,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
      child: state == _ItemState.done
          ? const Icon(Icons.check_rounded, size: 15, color: RideTokens.okTx)
          : Text(
              '$index',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w900,
                color: fg,
              ),
            ),
    );
  }
}

/// Paso que esta versión de la app no conoce: se muestra el nombre crudo del
/// servidor, sin traducirlo ni ubicarlo en la fila.
class _UnknownStepItem extends StatelessWidget {
  const _UnknownStepItem({required this.rawStep});

  final String rawStep;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
      decoration: BoxDecoration(
        color: RideTokens.p50,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: RideTokens.p200),
      ),
      child: Row(
        children: [
          const Icon(Icons.play_circle_outline_rounded,
              size: 22, color: RideTokens.p800),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              l10n.coStepUnknown(rawStep),
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w800,
                color: RideTokens.n900,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CancelledItem extends StatelessWidget {
  const _CancelledItem({required this.isCurrent});

  final bool isCurrent;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return DottedBorderBox(
      highlighted: isCurrent,
      child: Row(
        children: [
          const Icon(Icons.close_rounded, size: 18, color: RideTokens.n600),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  l10n.coStepCancelled,
                  style: const TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w900,
                    color: RideTokens.n900,
                  ),
                ),
                Text(
                  l10n.coStepCancelledHint,
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: RideTokens.n700,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Caja de borde punteado (la salida alterna). Flutter no trae dashed border;
/// se aproxima con un borde tenue + fondo neutro, que es lo que el mockup
/// comunica: "esto no está en la fila".
class DottedBorderBox extends StatelessWidget {
  const DottedBorderBox({
    super.key,
    required this.child,
    this.highlighted = false,
  });

  final Widget child;
  final bool highlighted;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
      decoration: BoxDecoration(
        color: highlighted ? RideTokens.dangerBg : RideTokens.n50,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: highlighted ? RideTokens.dangerBd : RideTokens.n300,
          style: BorderStyle.solid,
        ),
      ),
      child: child,
    );
  }
}

class _SheetGhostButton extends StatelessWidget {
  const _SheetGhostButton({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: RideTokens.n0,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          constraints: const BoxConstraints(minHeight: 48),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            border: Border.all(color: RideTokens.n300, width: 1.5),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Text(
            label,
            style: const TextStyle(
              fontSize: 14.5,
              fontWeight: FontWeight.w800,
              color: RideTokens.n800,
            ),
          ),
        ),
      ),
    );
  }
}
