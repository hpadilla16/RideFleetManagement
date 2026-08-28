import 'package:clock/clock.dart';
import 'package:flutter/material.dart';

import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../application/checkout_wizard_state.dart';
import '../../domain/checkout_event_log.dart';
import '../../domain/checkout_step_catalog.dart';
import '../checkout_labels.dart';

/// Banners del shell: avance ajeno (8C) y sin red (8D).

/// Acción textual dentro de un banner ("Ver qué cambió", "Reintentar",
/// "Entendido").
///
/// 44 px de alto y padding horizontal REAL: el mockup manda 44 y el DoD pide
/// hit-slop cómodo. Un enlace cuyo área táctil es exactamente el ancho del
/// texto es un enlace que en el patio, con guantes, se falla.
class BannerAction extends StatelessWidget {
  const BannerAction({
    super.key,
    required this.label,
    required this.color,
    required this.onTap,
  });

  final String label;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(10),
          child: Container(
            constraints: const BoxConstraints(minHeight: 44),
            padding: const EdgeInsets.symmetric(horizontal: 10),
            alignment: Alignment.centerLeft,
            child: Text(
              label,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w900,
                color: color,
                decoration: TextDecoration.underline,
                decorationColor: color,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Contenedor común. El color del icono es semántico; el TEXTO siempre va en
/// la rampa neutra alta — un azul/ámbar de texto sobre su propio fondo no da
/// margen al sol del patio.
class WizardBanner extends StatelessWidget {
  const WizardBanner({
    super.key,
    required this.icon,
    required this.iconColor,
    required this.background,
    required this.border,
    required this.child,
  });

  final IconData icon;
  final Color iconColor;
  final Color background;
  final Color border;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(11, 10, 11, 10),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: iconColor),
          const SizedBox(width: 9),
          Expanded(child: child),
        ],
      ),
    );
  }
}

/// 8C — otra superficie avanzó este paso.
///
/// INFORMATIVO, nunca modal: con 4 superficies conviviendo, un diálogo por
/// avance ajeno sería un bloqueo cada pocos minutos. El stepper ya se movió
/// solo; esto solo explica por qué.
class ForeignAdvanceBanner extends StatelessWidget {
  const ForeignAdvanceBanner({
    super.key,
    required this.notice,
    required this.onSeeChanged,
  });

  final ForeignAdvanceNotice notice;
  final VoidCallback onSeeChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final age = notice.at == null
        ? l10n.ageMoment
        : checkoutAgeLabel(l10n, clock.now().difference(notice.at!));
    return WizardBanner(
      icon: Icons.info_outline_rounded,
      iconColor: RideTokens.focus,
      background: RideTokens.infoBg,
      border: RideTokens.infoBd,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            _line(l10n, age),
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.n800,
            ),
          ),
          BannerAction(
            label: l10n.coAdvancedSeeChanged,
            color: RideTokens.p700,
            onTap: onSeeChanged,
          ),
        ],
      ),
    );
  }

  String _line(AppLocalizations l10n, String age) {
    // 21C — cayó un SELLO y el paso NO se movió. La segunda frase es la que
    // importa: "este paso no cambió" le dice al agente que NO suelte el
    // formulario que está llenando. El banner es aditivo; el cuerpo del paso
    // es intocable.
    if (notice.kind == ForeignAdvanceKind.stampLanded) {
      final stamp = notice.stamp;
      final what = stamp == null
          ? l10n.coStampsTitle
          : stampLabel(l10n, stamp);
      return '${l10n.coAdvancedStampLanded(what, age)} '
          '${l10n.coAdvancedStepUnchanged}';
    }
    final completed = stepLabel(l10n, notice.completedStep);
    final name = notice.actorName;
    final head = switch (notice.actor) {
      CheckoutActorKind.kiosk => l10n.coAdvancedKiosk(completed, age),
      // Nombre propio cuando la presencia lo resuelve; si no, el copy genérico
      // de H1. **No se adivina**: sin `presence[].actorUserId` no se afirma un
      // nombre (checkout_attribution.dart).
      CheckoutActorKind.otherAgent => name == null
          ? l10n.coAdvancedOtherAgent(completed, age)
          : l10n.coAdvancedOtherAgentNamed(completed, name, age),
      // "otra superficie" cubre tanto al sistema como a un actor que el log
      // no identifica: se dice lo que se sabe, no más.
      _ => l10n.coAdvancedOtherSurface(completed, age),
    };
    return '$head ${l10n.coAdvancedNow(stepLabel(l10n, notice.currentStep))}';
  }
}

/// 8D — sin red, honesto.
///
/// La advertencia específica del M2 no es "dato viejo": es dato viejo
/// MIENTRAS otra superficie puede estar avanzando.
class OfflineBanner extends StatelessWidget {
  const OfflineBanner({super.key, required this.age, required this.onRetry});

  final Duration age;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return WizardBanner(
      icon: Icons.warning_amber_rounded,
      iconColor: RideTokens.warnTx,
      background: RideTokens.warnBg,
      border: RideTokens.warnBd,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            l10n.coOfflineBanner(checkoutAgeLabel(l10n, age)),
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.warnTx,
            ),
          ),
          BannerAction(
            label: l10n.retryButton,
            color: RideTokens.warnTx,
            onTap: onRetry,
          ),
        ],
      ),
    );
  }
}

/// Negativa del servidor tras un 409 ya reconciliado (matriz de ADR-4). El
/// mensaje SIEMPRE es el del backend; el título solo lo enmarca.
///
/// ── M2-H6: la matriz completa, con cara humana y sin puertas falsas ──────
///
/// Dos cosas cambian respecto de H1, y las dos son la historia:
///
///  1. **El color comunica gravedad, no categoría.** `tooEarly` es ÁMBAR
///     (mira lo que pediste: nadie hizo nada mal y no hay nada bloqueado);
///     `entryGuard` y `vehicleConflict` siguen ROJOS (algo bloquea de verdad).
///     Meter los cinco códigos en la misma franja roja obliga al agente a
///     traducir.
///  2. **Cada acción dibujada tiene que poder tener éxito.** Un botón que
///     contra una máquina lineal daría 409 para siempre no es una acción, es
///     una trampa que entrena al agente a machacarlo bajo el sol. Por eso
///     aquí NO existe "Reintentar" y el CTA de swap desaparece pasada la
///     inspección. Lo que sí se dibuja es NAVEGACIÓN local, que no pasa por
///     el servidor y no puede dar 409.
class ConflictBanner extends StatelessWidget {
  const ConflictBanner({
    super.key,
    required this.conflict,
    required this.onDismiss,
    this.onGoToStep,
    this.onOpenOutbox,
    this.onSearchReservation,
    this.pendingUploads = 0,
  });

  final CheckoutConflict conflict;
  final VoidCallback onDismiss;

  /// 22A — navegar al paso que el servidor SÍ reporta. Es una pantalla local:
  /// no puede fallar.
  final VoidCallback? onGoToStep;

  /// 22B — la Bandeja, que es donde el bloqueo es real y accionable (fotos sin
  /// enviar). Reintentar la transición volvería a rebotar hasta que el sello
  /// exista, porque lo estampa el SERVIDOR al drenar el `complete`.
  final VoidCallback? onOpenOutbox;

  /// 22C — buscar la reserva que se llevó la unidad. Solo cuando el número se
  /// pudo LEER del mensaje del servidor.
  final VoidCallback? onSearchReservation;

  /// Filas de la bandeja sin enviar, para el contador del CTA de 22B.
  final int pendingUploads;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final title = switch (conflict.kind) {
      CheckoutConflictKind.tooEarly => l10n.coConflictTooEarlyTitle,
      CheckoutConflictKind.entryGuard => l10n.coConflictEntryGuardTitle,
      CheckoutConflictKind.vehicleConflict => l10n.coConflictVehicleTitle,
      CheckoutConflictKind.terminal => l10n.coTerminalBody,
      CheckoutConflictKind.swapLocked => l10n.coConflictSwapTitle,
      CheckoutConflictKind.generic => l10n.coConflictGenericTitle,
    };
    // Línea de CAUSA traducida encima del cuerpo del servidor. Nació con
    // ENTRY_GUARD (se nombra QUÉ falta, con el mismo copy que la lista de
    // pasos ya anticipaba con el candado) y la reusa `SWAP_LOCKED`, cuyo
    // mensaje del backend filtra un enum crudo de base de datos
    // (`currentStep=INSPECTION_IN_PROGRESS`, review INN-S-2). El cuerpo del
    // servidor NO se sustituye: se enmarca.
    final guardLine = switch (conflict.kind) {
      CheckoutConflictKind.swapLocked => l10n.coSwapLockedCause,
      CheckoutConflictKind.tooEarly => _tooEarlyLine(l10n),
      // 22C pasada la inspección: el swap ya no existe, así que en vez de un
      // CTA imposible se NOMBRA el callejón y dónde vive la puerta verdadera.
      CheckoutConflictKind.vehicleConflict when !conflict.swapAvailable =>
        l10n.coConflictSwapLockedBody,
      _ => conflict.guard == null ? null : guardLabel(l10n, conflict.guard!),
    };
    // `tooEarly` es ámbar: nadie hizo nada mal y nada está bloqueado — solo
    // se pidió un paso fuera de turno. Rojo sería gritarle al agente por un
    // doble toque.
    final soft = conflict.kind == CheckoutConflictKind.tooEarly;
    final accent = soft ? RideTokens.warnTx : RideTokens.dangerTx;
    return WizardBanner(
      icon: soft ? Icons.warning_amber_rounded : Icons.error_outline_rounded,
      iconColor: accent,
      background: soft ? RideTokens.warnBg : RideTokens.dangerBg,
      border: soft ? RideTokens.warnBd : RideTokens.dangerBd,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            title,
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w900,
              color: accent,
            ),
          ),
          if (guardLine != null)
            Text(
              guardLine,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w800,
                color: accent,
              ),
            ),
          // El mensaje del servidor se ENMARCA, jamás se sustituye (DoD #5).
          // Va en la rampa neutra alta para que se lea al sol.
          Text(
            conflict.message,
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.n800,
            ),
          ),
          ..._actions(l10n, accent),
          BannerAction(
            label: l10n.coConflictDismiss,
            color: accent,
            onTap: onDismiss,
          ),
        ],
      ),
    );
  }

  /// "La sesión está en T&C (paso 2) y Cobrar es el paso 4."
  ///
  /// Los dos números salen del catálogo de PRESENTACIÓN, no de una máquina de
  /// estados en Dart. Si alguno de los dos pasos no está en el catálogo (paso
  /// nuevo del backend) se dice la REGLA sin inventar números.
  String _tooEarlyLine(AppLocalizations l10n) {
    final current = infoFor(conflict.currentStep);
    final target = infoFor(conflict.attemptedStep);
    if (current == null || target == null) {
      return l10n.coConflictTooEarlyBodyShort;
    }
    return l10n.coConflictTooEarlyBody(
      stepLabel(l10n, current.step.wire),
      current.position,
      stepLabel(l10n, target.step.wire),
      target.position,
    );
  }

  /// La última columna de la matriz, hecha código: **cada acción que se dibuja
  /// aquí tiene que poder tener éxito.** Si no se puede llenar esa frase, el
  /// botón no existe — y el `Entendido` de abajo, más el re-render de lo ya
  /// reconciliado, siguen siendo una salida honesta.
  List<Widget> _actions(AppLocalizations l10n, Color accent) {
    switch (conflict.kind) {
      case CheckoutConflictKind.tooEarly:
        // Navegación local: no pasa por el servidor, no puede dar 409.
        final position = infoFor(conflict.currentStep)?.position;
        if (onGoToStep == null || position == null) return const [];
        return [
          BannerAction(
            label: l10n.coGoToStepCta(
              position,
              stepLabel(l10n, conflict.currentStep!.wire),
            ),
            color: accent,
            onTap: onGoToStep!,
          ),
          // POR QUÉ esa acción puede tener éxito — la última columna de la
          // matriz, dicha en pantalla. Es lo que impide que el agente busque
          // un "Reintentar" que aquí no existe.
          _Why(text: l10n.coGoToStepWhy(position)),
        ];

      case CheckoutConflictKind.entryGuard:
        // Solo si hay algo REAL que drenar. Un "Ver la Bandeja (0)" mandaría
        // al agente a una pantalla vacía a resolver un bloqueo que no está
        // ahí — otra puerta falsa, más educada.
        if (onOpenOutbox == null || pendingUploads <= 0) return const [];
        return [
          BannerAction(
            label: l10n.coGuardOutboxCta(pendingUploads),
            color: accent,
            onTap: onOpenOutbox!,
          ),
          _Why(text: l10n.coGuardOutboxWhy),
        ];

      case CheckoutConflictKind.vehicleConflict:
        // OJO con lo que NO va aquí: "Elegir otro vehículo". El paso
        // CONFIRMING ya lo ofrece como PRIMARIO en su `_ConflictDock` (H2), y
        // repetirlo en el banner rompería "hay UN dock, no tres" (GD-SC-3) —
        // dos botones idénticos a 10 px uno del otro. `swapAvailable` sigue
        // decidiendo aquí lo único que le toca al banner: si NOMBRA el
        // callejón (arriba, `guardLine`) porque el swap ya no existe.
        //
        // Lo que sí es exclusivo del banner es la otra reserva: ningún dock la
        // ofrece, y solo aparece si el número se pudo LEER del mensaje del
        // servidor.
        if (conflict.conflictReservationRef == null ||
            onSearchReservation == null) {
          return const [];
        }
        return [
          BannerAction(
            label: l10n.coEntrySearchReservation(
              conflict.conflictReservationRef!,
            ),
            color: accent,
            onTap: onSearchReservation!,
          ),
        ];

      // Terminal, swapLocked y genérico no tienen acción que pueda triunfar
      // desde aquí: terminal significa terminal, el swap ya no existe, y sobre
      // un código que la app no sabe clasificar no se inventa una salida.
      case CheckoutConflictKind.terminal:
      case CheckoutConflictKind.swapLocked:
      case CheckoutConflictKind.generic:
        return const [];
    }
  }
}

/// Línea de "por qué esta acción sí puede tener éxito". No es decoración: es
/// la última columna de la matriz 409 puesta donde el agente la lee, y lo que
/// evita que busque el botón que esta historia decidió NO dibujar.
class _Why extends StatelessWidget {
  const _Why({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Text(
        text,
        style: const TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w700,
          color: RideTokens.n700,
          height: 1.35,
        ),
      ),
    );
  }
}
