import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../../core/api/dto/checkout_session.dart';
import '../../../../core/api/enums.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/router/app_router.dart';
import '../../../../core/telemetry/event_logger.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../../inspection/application/inspection_controller.dart';
import '../../../inspection/application/inspection_outbox_view.dart';
import '../../../inspection/application/inspection_state.dart';
import '../../../inspection/presentation/camera_capture_screen.dart';
import '../../../inspection/presentation/widgets/angle_labels.dart';
import '../../../inspection/presentation/widgets/inspection_bodies.dart';
import '../../../inspection/presentation/widgets/kiosk_signature_step.dart';
import '../../application/checkout_wizard_controller.dart';
import '../checkout_labels.dart';
import '../widgets/transition_button.dart';
import '../widgets/verify_cards.dart';
import '../widgets/wizard_banners.dart';
import '../widgets/wizard_dock.dart';

/// **Paso 4 del wizard — la inspección** (M2-H4, mockup 17A-17F).
///
/// La captura del M1 no se rediseña: se MONTA aquí. Los cuerpos de los tres
/// sub-pasos son los mismos widgets que usa `/inspection/:id`
/// (`inspection_bodies.dart`) y la cámara se abre igual, a pantalla completa.
/// Lo que H4 aporta es la verdad del paso dentro del wizard:
///
///  1. **Son DOS pasos del servidor**, no uno: `INSPECTION_HANDOFF` (6) y
///     `INSPECTION_IN_PROGRESS` (7). El rail de fases agrupa —presentación—
///     pero la stepline dice el número real. Nunca "paso 6.5".
///  2. **"Completa en este teléfono" ≠ completa** (17D). `finish()` solo
///     ENCOLA; el sello `inspectionCompletedAt` lo escribe el SERVIDOR al
///     drenar el complete (mobile-inspection.service.js:268), y sin ese sello
///     el paso 8 rebota con 409 `ENTRY_GUARD` (state-machine.js:80).
///  3. **Una foto obligatoria muerta es un callejón sin salida** (17E): un
///     dead-letter no bloquea al resto de la bandeja, así que el complete sale
///     igual y el servidor lo rechaza con `REQUIRED_ANGLES_MISSING`
///     (mobile-inspection.service.js:200-205). Aquí eso tiene banner, causa y
///     un botón que arregla las dos cosas.
///  4. **Un solo CTA a la vez**: mientras el paso está en captura, el
///     [WizardDock] hospeda el CTA del SUB-paso. El CTA de avance del wizard
///     solo reaparece cuando el servidor selló la inspección (17F).
class CheckoutInspectionStep extends ConsumerStatefulWidget {
  const CheckoutInspectionStep({
    super.key,
    required this.reservationId,
    required this.banners,
  });

  final String reservationId;

  /// Banners del shell (offline / avance ajeno / 409 reconciliado): los
  /// inyecta la pantalla del wizard y el paso decide dónde caen.
  final List<Widget> banners;

  @override
  ConsumerState<CheckoutInspectionStep> createState() =>
      _CheckoutInspectionStepState();
}

class _CheckoutInspectionStepState
    extends ConsumerState<CheckoutInspectionStep> {
  /// Cuándo vio ESTA pantalla que el complete quedó encolado — el numerador
  /// de `waited_s` en `inspection.completed_server`.
  DateTime? _completeQueuedSince;

  /// Ángulos obligatorios ya reportados como muertos: un evento por ángulo,
  /// no uno por repintado.
  final _deadAnglesLogged = <String>{};

  /// Sesión cuyo estado de bandeja ya se barrió una vez (ver
  /// [_scheduleFirstOutboxSync]).
  String? _syncedSessionId;

  InspectionController get _controller =>
      ref.read(inspectionControllerProvider(widget.reservationId).notifier);

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final wizard = ref.watch(checkoutWizardProvider(widget.reservationId));
    final session = wizard.session;
    if (session == null) return const SizedBox.shrink();

    // El servidor selló la inspección mientras el paso estaba abierto: se
    // retiran los envíos de ESTA sesión (purga selectiva con rastro) y se
    // cuenta cuánto esperó el agente. Va en listen y no en build porque es un
    // efecto, y build corre en cada repintado.
    ref.listen(
      checkoutWizardProvider(widget.reservationId)
          .select((s) => s.session?.inspectionCompletedAt),
      (previous, next) {
        if (next == null || previous != null) return;
        _logCompletedByServer();
        unawaited(_controller.noteCompletedByServer(next));
      },
    );

    // 17F — el SELLO manda sobre el sub-paso local: si el servidor ya tiene la
    // inspección, no hay nada que capturar aunque esta pantalla creyera que
    // seguía en fotos (otra superficie pudo cerrarla). Y manda también sobre el
    // paso: el complete móvil estampa `inspectionCompletedAt` SIN mirar
    // `currentStep` (mobile-inspection.service.js:263-270), así que una sesión
    // sellada puede seguir en el paso 6.
    //
    // Aquí el `watch` —y el montaje del controller que trae— es DELIBERADO: con
    // la sesión sellada, `load()` corta antes del mint (inspection_controller
    // :74-97) y lo que hace es la purga selectiva de la bandeja.
    if (session.inspectionCompletedAt != null) {
      final flow = ref.watch(inspectionControllerProvider(widget.reservationId));
      return _CompletedView(
        reservationId: widget.reservationId,
        session: session,
        banners: widget.banners,
        photosOnServer: _onServerCount(flow),
      );
    }

    // 17A — paso 6: todavía no se ha empezado.
    //
    // Va ANTES de mirar el flujo de captura a propósito (review INN-MC-1): leer
    // `inspectionControllerProvider` lo MONTA, y montarlo corre `load()`, que
    // mintea un `MOBILE_INSPECTION` — un token de enlace público, sin
    // autenticación y de 15 minutos (checkout-session.service.js:700-751) —
    // para un frame que no lee nada de eso. Es la misma regla que ya declara el
    // shell en checkout_wizard_screen.dart:124-133.
    if (session.currentStep == CheckoutStep.inspectionHandoff.wire) {
      return _HandoffView(
        reservationId: widget.reservationId,
        session: session,
        banners: widget.banners,
      );
    }

    final flow = ref.watch(inspectionControllerProvider(widget.reservationId));
    final view = flow.sessionId == null
        ? const InspectionOutboxView()
        : ref.watch(inspectionOutboxProvider(flow.sessionId!));

    // Los efectos que dispara la BANDEJA (telemetría del ángulo muerto y el
    // cronómetro de la espera) viven en un listen, no en build: build corre en
    // cada repintado.
    final sessionId = flow.sessionId;
    if (sessionId != null) {
      ref.listen(
        inspectionOutboxProvider(sessionId),
        (_, next) => _applyOutboxEffects(next),
      );
      _scheduleFirstOutboxSync(sessionId);
    }

    return switch (flow.phase) {
      // La captura necesita la sesión leída una vez (el id sella las filas de
      // la bandeja). Mientras tanto, el cromo del wizard ya está en pantalla.
      InspectionFlowPhase.loading => const Center(
          child: CircularProgressIndicator(color: RideTokens.p600),
        ),
      InspectionFlowPhase.offline => _LoadFailedView(
          banners: widget.banners,
          message: l10n.inspLoadOffline,
          onRetry: _controller.load,
        ),
      InspectionFlowPhase.failed => _LoadFailedView(
          banners: widget.banners,
          // Mensaje del backend tal cual (DoD #5); vacío ⇒ copy traducido.
          message: flow.error?.message.isNotEmpty ?? false
              ? flow.error!.message
              : l10n.genericError,
          onRetry: _controller.load,
        ),
      // El controller llegó a 6F por su cuenta (carga con la sesión ya
      // sellada). En el wizard esa historia la cuenta 17F, que ya se resolvió
      // arriba desde el sello; aquí solo queda esperar el siguiente poll.
      InspectionFlowPhase.alreadyCompleted => const Center(
          child: CircularProgressIndicator(color: RideTokens.p600),
        ),
      InspectionFlowPhase.active => _CaptureView(
          reservationId: widget.reservationId,
          banners: widget.banners,
          flow: flow,
          view: view,
          online: !wizard.offline,
          // De cuándo es la lectura del SERVIDOR que pinta el 17D: la tarjeta
          // de sellos afirma "2 de 8 recibidas · Pendiente" y sin edad no se
          // distingue una lectura viva de una congelada.
          dataAge: wizard.fetchedAt == null
              ? Duration.zero
              : clock.now().difference(wizard.fetchedAt!),
          onTapAngle: _openCamera,
          onRetakeDead: _retakeDead,
        ),
    };
  }

  int _onServerCount(InspectionFlowState flow) => flow.angles.values
      .where((a) => a.status == AngleStatus.onServer)
      .length;

  void _logCompletedByServer() {
    final since = _completeQueuedSince;
    // Sin haber visto el complete encolado en ESTA pantalla no hay espera que
    // medir (se entró con la inspección ya cerrada): el evento viaja sin tag
    // antes que con un número inventado.
    final waited =
        since == null ? null : clock.now().difference(since).inSeconds;
    ref.read(eventLoggerProvider).log(
      InspectionEvents.completedServer,
      data: {'waited_s': ?waited},
    );
  }

  /// Efectos de una emisión de la bandeja: un evento por ángulo obligatorio
  /// muerto (no uno por repintado) y el arranque/paro del cronómetro de la
  /// espera del 17D. Idempotente — se llama desde el listen y desde el primer
  /// barrido.
  void _applyOutboxEffects(InspectionOutboxView view) {
    for (final key in kRequiredAngleKeys) {
      if (!view.isDeadAngle(key) || !_deadAnglesLogged.add(key)) continue;
      ref
          .read(eventLoggerProvider)
          .log(InspectionEvents.requiredAngleDead, data: {'angle': key});
    }
    if (view.completeQueued) {
      _completeQueuedSince ??= clock.now();
    } else if (view.completeDelivery == null) {
      _completeQueuedSince = null;
    }
  }

  /// Primer barrido de la bandeja para esta sesión.
  ///
  /// El `ref.listen` de un widget en riverpod 3 NO admite `fireImmediately`
  /// (consumer.dart:543-545 lo dice con todas sus letras) y solo avisa de
  /// cambios POSTERIORES a la suscripción. El caso normal es justo el otro: la
  /// bandeja —una lectura local— ya emitió cuando la red devuelve el id de
  /// sesión y engancha este listen, así que un cierre encolado o una foto
  /// muerta que ya estaban ahí no dispararían nada. Se barre una vez por
  /// sesión, y después del frame: dentro de build no, que corre en cada
  /// repintado.
  void _scheduleFirstOutboxSync(String sessionId) {
    if (_syncedSessionId == sessionId) return;
    _syncedSessionId = sessionId;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _applyOutboxEffects(ref.read(inspectionOutboxProvider(sessionId)));
    });
  }

  /// Cámara a pantalla completa (17C): el cromo del wizard se SUSPENDE por
  /// completo — la pantalla ya construida en M1 se abre tal cual y al cerrarla
  /// se vuelve al paso con el grid actualizado. El poll del wizard sigue
  /// corriendo debajo.
  Future<void> _openCamera(String angleKey) async {
    final l10n = AppLocalizations.of(context)!;
    // Tope de la bandeja: se bloquea ANTES de abrir la cámara (mockup 7D).
    if (ref.read(inspectionControllerProvider(widget.reservationId)).outboxFull) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(l10n.inspOutboxFull)));
      return;
    }
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CameraCaptureScreen(
          reservationId: widget.reservationId,
          initialAngleKey: angleKey,
        ),
      ),
    );
  }

  /// 17E — "Tomar {ángulo} otra vez": UN botón, DOS operaciones (nota 13). La
  /// foto nueva reemplaza la fila muerta por su llave de idempotencia, y el
  /// `inspection_complete` que el servidor rechazó se resucita después: el
  /// agente no tiene por qué saber que su cierre quedó en una lista aparte.
  Future<void> _retakeDead(String angleKey) async {
    await _openCamera(angleKey);
    if (!mounted) return;
    await _controller.retryDeadRows();
  }
}

/// 17A — el paso 4 antes de empezar (`INSPECTION_HANDOFF`, paso 6 de 10).
///
/// Existe porque la inspección es lo único del checkout que involucra al
/// cliente y al coche a la vez: el agente necesita saber ANTES de salir al
/// patio que al final tendrá que voltear el teléfono (nota 2).
class _HandoffView extends ConsumerWidget {
  const _HandoffView({
    required this.reservationId,
    required this.session,
    required this.banners,
  });

  final String reservationId;
  final CheckoutSessionDto session;
  final List<Widget> banners;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final ctx = ref.watch(checkoutWizardProvider(reservationId)).context;
    final paidAt = session.paymentCompletedAt;
    final odometer = ctx?.odometer;

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            children: [
              ...banners,
              VerifyCard(
                title: l10n.coInspWhatTitle,
                pillLabel: l10n.coInspWhatParts,
                children: [
                  KvRow(
                    label: l10n.coInspRowPhotos,
                    value: l10n.coInspWhatPhotos,
                  ),
                  KvRow(
                    label: l10n.coInspRowCondition,
                    value: l10n.coInspWhatMetrics,
                  ),
                  KvRow(
                    label: l10n.coInspRowSignature,
                    value: l10n.coInspWhatSignature,
                  ),
                ],
              ),
              const SizedBox(height: 12),
              // La promesa offline y su LÍMITE en la misma frase (nota 3):
              // separadas, la primera se lee como "ya quedó".
              WizardBanner(
                icon: Icons.info_outline_rounded,
                iconColor: RideTokens.focus,
                background: RideTokens.infoBg,
                border: RideTokens.infoBd,
                child: Text(
                  l10n.coInspOfflineNote,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: RideTokens.n800,
                  ),
                ),
              ),
              if (ctx?.vehicleLabel != null) ...[
                const SizedBox(height: 12),
                VerifyCard(
                  title: l10n.coConfirmVehicle,
                  // El pill afirma un SELLO del servidor, no una suposición:
                  // sin `paymentCompletedAt` no se dice "pagado".
                  pillLabel: paidAt == null
                      ? null
                      : l10n.coInspPaidPill(
                          DateFormat.Hm(locale).format(paidAt.toLocal()),
                        ),
                  tone: paidAt == null ? VerifyTone.neutral : VerifyTone.ok,
                  children: [
                    KvRow(
                      label: l10n.coConfirmUnit,
                      value: ctx!.vehicleLabel!,
                    ),
                    if (odometer != null)
                      KvRow(
                        label: l10n.coInspLastReading,
                        value: l10n.coOdometerValue(
                          NumberFormat.decimalPattern(locale).format(odometer),
                        ),
                        tabular: true,
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          child: TransitionButton(
            reservationId: reservationId,
            // El destino lo conoce la PANTALLA por diseño de producto, jamás
            // por inferencia sobre el catálogo (ADR-4). Sin entry guard: este
            // salto no exige sello.
            toStep: CheckoutStep.inspectionInProgress,
            label: l10n.coInspStartCta,
            why: l10n.coInspStartWhy,
          ),
        ),
      ],
    );
  }
}

/// 17B/17D/17E — la captura viva dentro del wizard.
class _CaptureView extends ConsumerWidget {
  const _CaptureView({
    required this.reservationId,
    required this.banners,
    required this.flow,
    required this.view,
    required this.online,
    required this.dataAge,
    required this.onTapAngle,
    required this.onRetakeDead,
  });

  final String reservationId;
  final List<Widget> banners;
  final InspectionFlowState flow;
  final InspectionOutboxView view;
  final bool online;

  /// Antigüedad de la última lectura de la sesión — la pill del 17D.
  final Duration dataAge;
  final void Function(String angleKey) onTapAngle;
  final Future<void> Function(String angleKey) onRetakeDead;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final controller =
        ref.read(inspectionControllerProvider(reservationId).notifier);
    final deadAngles = {
      for (final key in kInspectionAngleKeys)
        if (view.isDeadAngle(key)) key,
    };
    final deadRequired =
        kRequiredAngleKeys.where(view.isDeadAngle).toList(growable: false);

    // El aviso del ángulo obligatorio muerto viaja con TODOS los sub-pasos:
    // sin él, el paso se queda esperando un cierre que el servidor ya decidió
    // rechazar.
    final leading = <Widget>[
      ...banners,
      if (deadRequired.isNotEmpty) ...[
        _DeadBanner(
          title: l10n.coInspRequiredDeadTitle(
            angleLabel(l10n, deadRequired.first),
          ),
          reason: view.deadReasons[deadRequired.first],
        ),
        const SizedBox(height: 10),
      ] else if (view.completeDead) ...[
        // El cierre murió por un motivo que no es una foto obligatoria
        // (sesión que ya no existe, negativa nueva del backend): tampoco
        // puede quedarse sin explicación ni sin salida.
        _DeadBanner(title: l10n.coInspCompleteDeadTitle, reason: null),
        const SizedBox(height: 10),
      ],
    ];

    final body = switch (flow.step) {
      InspectionStep.photos => InspectionPhotosBody(
          state: flow,
          online: online,
          onTapAngle: onTapAngle,
          deadAngles: deadAngles,
          leading: leading,
        ),
      InspectionStep.metrics => InspectionMetricsBody(
          state: flow,
          controller: controller,
          leading: leading,
        ),
      // La firma la dibuja el SHELL a pantalla completa (kiosco): en cuanto
      // `flow.step` es la firma, `inspectionChromeOf` devuelve `fullBleed` y
      // `CheckoutWizardScreen` sustituye el árbol entero por
      // [InspectionSignatureSurface] — este cuerpo ya no está montado. La rama
      // existe porque el switch es exhaustivo, y queda vacía porque pintar
      // cromo de staff en el frame que el cliente tiene enfrente sería el
      // error que 6D/18B existen para impedir.
      InspectionStep.signature => const SizedBox.shrink(),
      InspectionStep.summary => _SummaryBody(
          flow: flow,
          view: view,
          online: online,
          leading: leading,
          deadRequired: deadRequired,
          dataAge: dataAge,
        ),
    };

    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            child: body,
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          child: _CaptureDock(
            reservationId: reservationId,
            flow: flow,
            view: view,
            online: online,
            deadRequired: deadRequired,
            onRetakeDead: onRetakeDead,
          ),
        ),
      ],
    );
  }
}

/// El pie del wizard hospedando el CTA del SUB-paso (nota 7). Es la única
/// costura de código real de H4: la captura del M1 renunció a su botón propio
/// para que jamás convivan dos "Continuar".
class _CaptureDock extends ConsumerWidget {
  const _CaptureDock({
    required this.reservationId,
    required this.flow,
    required this.view,
    required this.online,
    required this.deadRequired,
    required this.onRetakeDead,
  });

  final String reservationId;
  final InspectionFlowState flow;
  final InspectionOutboxView view;
  final bool online;
  final List<String> deadRequired;
  final Future<void> Function(String angleKey) onRetakeDead;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final controller =
        ref.read(inspectionControllerProvider(reservationId).notifier);

    switch (flow.step) {
      case InspectionStep.photos:
        return WizardDock(
          why: flow.requiredCaptured
              ? l10n.coInspRequiredWhy
              : l10n.inspRequiredFootnote,
          primary: RidePrimaryButton(
            label: l10n.inspContinueMetrics,
            onPressed: flow.requiredCaptured
                ? () => controller.goToStep(InspectionStep.metrics)
                : null,
          ),
        );

      case InspectionStep.metrics:
        return WizardDock(
          primary: RidePrimaryButton(
            label: l10n.inspContinueSignature,
            onPressed: flow.metricsComplete
                ? () => controller.goToStep(InspectionStep.signature)
                : null,
          ),
        );

      case InspectionStep.signature:
        // Sin pie: el shell ya tomó la pantalla completa por `fullBleed` y la
        // superficie del cliente pone su propia salida (PIN). Un dock del
        // wizard aquí sería cromo de staff frente al cliente.
        return const SizedBox.shrink();

      case InspectionStep.summary:
        // 17E — con una foto OBLIGATORIA muerta el cierre está condenado
        // (REQUIRED_ANGLES_MISSING). El dock deja de ofrecer "Terminar" y pasa
        // a ofrecer la salida real.
        if (deadRequired.isNotEmpty) {
          final angle = angleLabel(l10n, deadRequired.first);
          return WizardDock(
            why: l10n.coInspRetakeWhy,
            primary: RidePrimaryButton(
              label: l10n.coInspRetakeCta(angle),
              onPressed: () => onRetakeDead(deadRequired.first),
            ),
            secondary: RideGhostButton(
              label: l10n.coOpenOutboxDead(view.deadRows),
              onPressed: () => context.push(AppRoutes.outbox),
            ),
          );
        }

        // El cierre murió sin foto obligatoria de por medio: el paso no puede
        // avanzar y la decisión vive en la bandeja. Se manda ahí en PRIMARIO
        // — un botón bloqueado y nada más sería el callejón sin salida.
        if (view.completeDead) {
          return WizardDock(
            why: l10n.coInspBlockedWhy,
            primary: RidePrimaryButton(
              label: l10n.coOpenOutboxDead(view.deadRows),
              onPressed: () => context.push(AppRoutes.outbox),
            ),
          );
        }

        // 17D — el complete ya está encolado y el sello NO ha llegado: el CTA
        // del wizard se muestra BLOQUEADO con su causa (tocarlo devolvería 409
        // ENTRY_GUARD) y con una salida de verdad al lado.
        if (view.completeQueued || flow.completeQueued) {
          return TransitionButton(
            reservationId: reservationId,
            toStep: CheckoutStep.customerSignPending,
            label: l10n.coInspContinueSign,
            blockedWhy: l10n.coInspBlockedWhy,
            secondary: RideGhostButton(
              label: l10n.coOpenOutbox(view.totalRows),
              onPressed: () => context.push(AppRoutes.outbox),
            ),
          );
        }

        return WizardDock(
          primary: RidePrimaryButton(
            // El CTA dice la verdad según la red: encolar no es enviar.
            label: online ? l10n.inspFinishOnline : l10n.inspFinishOffline,
            onPressed: flow.signatureDataUrl == null
                ? null
                : () => controller.finish(),
          ),
        );
    }
  }
}

/// Cuerpo del sub-paso de resumen. Antes de "Terminar" cuenta qué va a salir
/// (6E); después, lo que el SERVIDOR tiene (17D).
class _SummaryBody extends StatelessWidget {
  const _SummaryBody({
    required this.flow,
    required this.view,
    required this.online,
    required this.leading,
    required this.deadRequired,
    required this.dataAge,
  });

  final InspectionFlowState flow;
  final InspectionOutboxView view;
  final bool online;
  final List<Widget> leading;
  final List<String> deadRequired;
  final Duration dataAge;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    // 17E — con un obligatorio muerto, lo primero es el estado de los DOS
    // ángulos que el servidor exige: es lo que explica por qué el cierre no
    // va a pasar.
    if (deadRequired.isNotEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          ...leading,
          VerifyCard(
            title: l10n.coInspRequiredAnglesTitle,
            tone: VerifyTone.bad,
            pillLabel: l10n.coInspRequiredMissingPill(deadRequired.length),
            children: [
              for (final key in kRequiredAngleKeys)
                KvRow(
                  label: angleLabel(l10n, key),
                  value: view.isDeadAngle(key)
                      ? l10n.inspPhotoDead
                      : flow.angles[key]?.status == AngleStatus.onServer
                          ? l10n.inspPhotoSent
                          : l10n.angleQueued,
                  missing: view.isDeadAngle(key),
                ),
            ],
          ),
        ],
      );
    }

    final queued = view.completeQueued || flow.completeQueued;
    if (!queued) {
      return InspectionSummaryBody(
        state: flow,
        online: online,
        leading: leading,
      );
    }

    final onServer = flow.angles.values
        .where((a) => a.status == AngleStatus.onServer)
        .length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        ...leading,
        // "Completa en este teléfono" ≠ completa (nota 9). El copy cambia con
        // la red porque "salen solos al reconectar" es falso con señal.
        InspectionWarnBanner(
          text: online
              ? l10n.coInspLocalDoneSending
              : l10n.coInspLocalDoneTitle(view.queuedPhotos),
        ),
        const SizedBox(height: 10),
        InspectionQueueCard(photos: flow.capturedCount, online: online),
        const SizedBox(height: 12),
        VerifyCard(
          title: l10n.coStampsTitle,
          // Esta es LA pantalla donde el agente se queda mirando "Pendiente"
          // esperando que cambie: sin la edad del dato no puede distinguir una
          // lectura viva de una congelada. Tono neutro — la edad informa, no
          // acusa (mismo trato que `_StampsCard` del shell).
          pillLabel: l10n.coSessionAgeLabel(checkoutAgeLabel(l10n, dataAge)),
          children: [
            // El contador sale del estado de ángulos del SERVIDOR (fila que
            // salió de la bandeja = 2xx), no de lo que hay encolado.
            if (onServer > 0)
              KvRow(
                label: l10n.coInspRowPhotos,
                value: l10n.coInspServerPhotos(onServer),
              ),
            // Pendiente NO es un error: es el estado normal mientras la
            // bandeja no drene. Se pinta neutro, con su palabra.
            KvRow(
              label: l10n.coInspRowInspection,
              value: l10n.coStampPending,
            ),
            KvRow(
              label: l10n.coInspRowSignature,
              value: l10n.coStampPending,
            ),
          ],
        ),
      ],
    );
  }
}

/// 17E — algo de esta inspección murió en la bandeja, con la negativa del
/// servidor tal cual.
class _DeadBanner extends StatelessWidget {
  const _DeadBanner({required this.title, required this.reason});

  final String title;
  final String? reason;

  @override
  Widget build(BuildContext context) {
    return WizardBanner(
      icon: Icons.error_outline_rounded,
      iconColor: RideTokens.dangerTx,
      background: RideTokens.dangerBg,
      border: RideTokens.dangerBd,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w900,
              color: RideTokens.dangerTx,
            ),
          ),
          if (reason != null && reason!.isNotEmpty) ...[
            // Aire entre la afirmación y su prueba: pegadas y casi del mismo
            // tamaño se leían como un párrafo de dos renglones.
            const SizedBox(height: 4),
            Text(
              // Mensaje del backend sin reescribir (DoD #5), un escalón por
              // debajo del título: es la cita, no el titular.
              reason!,
              style: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w700,
                color: RideTokens.n800,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 17F — la inspección SELLADA por el servidor.
///
/// Todo lo que afirma sale de la sesión: `inspectionCompletedAt` y
/// `customerSignedAt` con hora del servidor.
///
/// Odómetro, combustible y limpieza NO se pintan aquí, y no es porque el
/// endpoint no los tenga: display-data → `getById` SÍ selecciona
/// `odometerOut` / `fuelOut` / `cleanlinessOut` del agreement
/// (reservations.service.js:1585-1622). Es que en el paso 7 siguen NULOS. El
/// complete móvil los escribe en `RentalAgreementInspection`
/// (mobile-inspection.service.js:253-262) y a las columnas del contrato solo
/// se copian AL FINALIZAR (checkout-session.service.js:490-521). Pintar la
/// fila leyendo esos campos daría un "—" permanente; se OMITE en vez de
/// rellenarse con lo que este teléfono mandó (nota 14: si un dato no llega, se
/// omite la fila).
class _CompletedView extends ConsumerWidget {
  const _CompletedView({
    required this.reservationId,
    required this.session,
    required this.banners,
    required this.photosOnServer,
  });

  final String reservationId;
  final CheckoutSessionDto session;
  final List<Widget> banners;
  final int photosOnServer;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final format = DateFormat.Hm(locale);
    final completedAt = session.inspectionCompletedAt!;
    final signedAt = session.customerSignedAt;
    final name = ref
        .watch(checkoutWizardProvider(reservationId))
        .context
        ?.customer
        ?.fullName;
    // La firma vino CON la inspección solo si los dos sellos son el mismo
    // instante: el complete los escribe en un único write
    // (mobile-inspection.service.js:265-281). Sellos distintos = la firma la
    // puso otra superficie y esta pantalla no se la atribuye a la inspección.
    final signedWithInspection = signedAt != null && signedAt == completedAt;

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            children: [
              ...banners,
              VerifyCard(
                title: l10n.coInspDoneTitle,
                tone: VerifyTone.ok,
                pillLabel: l10n.coInspReceivedAt(
                  format.format(completedAt.toLocal()),
                ),
                children: [
                  if (photosOnServer > 0)
                    KvRow(
                      label: l10n.coInspRowPhotos,
                      value: l10n.coInspServerPhotos(photosOnServer),
                    ),
                ],
              ),
              if (signedAt != null) ...[
                const SizedBox(height: 12),
                VerifyCard(
                  title: l10n.coInspSignatureTitle,
                  tone: VerifyTone.ok,
                  pillLabel: l10n.coInspReceivedAt(
                    format.format(signedAt.toLocal()),
                  ),
                  children: [
                    KvRow(
                      label: l10n.coInspSignedRow,
                      value: name != null && signedWithInspection
                          ? l10n.coSignFromInspection(name)
                          : format.format(signedAt.toLocal()),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                // Nota 16: pedir firma otra vez sería hacer firmar dos veces
                // lo mismo y SOBRESCRIBIR la guardada
                // (`saveCustomerSignature` pisa `tcSignature*` sin condición,
                // checkout-session.service.js:668-690).
                WizardBanner(
                  icon: Icons.info_outline_rounded,
                  iconColor: RideTokens.focus,
                  background: RideTokens.infoBg,
                  border: RideTokens.infoBd,
                  child: Text(
                    l10n.coSignAlreadyBanner,
                    style: const TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: RideTokens.n800,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          child: TransitionButton(
            reservationId: reservationId,
            toStep: CheckoutStep.customerSignPending,
            label: l10n.coInspCloseCta,
            // Sin firma sellada no se promete que no haga falta pedirla.
            why: signedAt == null ? null : l10n.coInspCloseWhy,
          ),
        ),
      ],
    );
  }
}

/// La carga del flujo falló (sin red al entrar, o negativa del servidor).
/// Nunca un error sin botón: el reintento vive en el pie, donde el agente ya
/// busca la acción del paso.
class _LoadFailedView extends StatelessWidget {
  const _LoadFailedView({
    required this.banners,
    required this.message,
    required this.onRetry,
  });

  final List<Widget> banners;
  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            children: [
              ...banners,
              InspectionWarnBanner(text: message),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          child: WizardDock(
            primary: RidePrimaryButton(
              label: l10n.retryButton,
              onPressed: onRetry,
            ),
          ),
        ),
      ],
    );
  }
}

/// Cromo que el paso 4 le pide al shell del wizard.
///
/// Decisión de cromo aprobada por Hector: **convive comprimido** en la
/// superficie de staff (wizbar + header mini + stepline con sub-progreso,
/// guardando el rail de 5 fases) y **se suspende del todo** en la cámara y en
/// la firma de kiosco — ningún cromo de staff frente al cliente.
@immutable
class InspectionChrome {
  const InspectionChrome({
    this.label,
    this.subStep,
    this.captured = 0,
    this.deadRequired = 0,
    this.fullBleed = false,
  });

  /// Override del NOMBRE del paso en la stepline. El contador nunca cambia.
  final String? label;

  /// Sub-paso vivo ⇒ cromo comprimido: fuera el rail, dentro la barra de
  /// sub-progreso. null = cromo completo.
  final InspectionStep? subStep;

  /// Ángulos ya capturados, para el chip "{n} de 8".
  final int captured;

  /// Ángulos OBLIGATORIOS con la fila muerta en la bandeja (17E).
  ///
  /// `captured` no sabe de filas muertas —cuenta `queued || onServer`
  /// (inspection_state.dart:84-85)—, así que con las 8 tomadas y Frente muerta
  /// el chip leería "8 de 8 ✓" en verde justo encima del banner que avisa de
  /// que el cierre será rechazado. Con esto el chip cambia de fallo, no de
  /// progreso.
  final int deadRequired;

  /// La superficie está volteada al cliente: el shell no dibuja NADA.
  final bool fullBleed;

  bool get compact => subStep != null;
}

/// Qué cromo toca, mirando el paso del servidor y el sub-paso local.
///
/// Vive aquí y no en el shell porque es conocimiento del paso 4; el shell solo
/// obedece. Sin flujo activo (cargando, error, o el paso 6) el cromo es
/// COMPLETO: comprimirlo sin sub-progreso que mostrar sería perder el rail a
/// cambio de nada.
InspectionChrome inspectionChromeOf({
  required AppLocalizations l10n,
  required CheckoutStep? step,
  required DateTime? inspectionCompletedAt,
  required InspectionFlowState flow,
  required InspectionOutboxView view,
}) {
  if (step != CheckoutStep.inspectionInProgress) {
    return const InspectionChrome();
  }
  if (inspectionCompletedAt != null) {
    // 17F: el paso sigue siendo el 7 y la stepline lo dice; lo que cambia es
    // el nombre, porque "en curso" ya sería falso.
    return InspectionChrome(label: l10n.coStampInspection);
  }
  if (flow.phase != InspectionFlowPhase.active) {
    return const InspectionChrome();
  }
  return InspectionChrome(
    label: switch (flow.step) {
      InspectionStep.photos => l10n.coInspPhotosStep,
      InspectionStep.metrics => l10n.coInspMetricsStep,
      InspectionStep.signature || InspectionStep.summary =>
        l10n.coInspSummaryStep,
    },
    subStep: flow.step,
    captured: flow.capturedCount,
    deadRequired: kRequiredAngleKeys.where(view.isDeadAngle).length,
    fullBleed: flow.step == InspectionStep.signature,
  );
}

/// Superficie volteada al cliente para la firma (6D/18B), montada por el shell
/// del wizard SIN su cromo. Es el widget del M1 tal cual: modo kiosco con el
/// candado suspendido y salida deliberada por PIN.
class InspectionSignatureSurface extends ConsumerWidget {
  const InspectionSignatureSurface({super.key, required this.reservationId});

  final String reservationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final flow = ref.watch(inspectionControllerProvider(reservationId));
    final controller =
        ref.read(inspectionControllerProvider(reservationId).notifier);
    return KioskSignatureStep(
      // JAMÁS marca propia frente al cliente: el getter neutraliza además el
      // centinela 'Ride Fleet' que el backend manda como default.
      tenantName: flow.branding?.clientSafeCompanyName ?? '',
      tenantLogoUrl: flow.branding?.companyLogoUrl ?? '',
      reservationLabel: flow.reservationNumber ?? '—',
      // Pie de identidad (GD-MC-7): en un mismo checkout el cliente firma DOS
      // veces en este teléfono con cinco minutos de diferencia —la revisión y
      // la entrega—, y sin este renglón la primera no dice QUÉ se está
      // firmando. Sin placa el widget arma "…· Corolla 2023"; sin unidad omite
      // el pie entero (kiosk_signature_step.dart:_footLine).
      vehicleLabel: flow.vehicleLabel,
      onConfirmed: controller.confirmSignature,
      onExitToStaff: () => controller.goToStep(InspectionStep.metrics),
    );
  }
}
