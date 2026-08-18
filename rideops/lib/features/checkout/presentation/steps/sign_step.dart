import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../../core/api/dto/checkout_session.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../../inspection/presentation/widgets/kiosk_signature_step.dart';
import '../../application/checkout_close_controller.dart';
import '../../application/checkout_wizard_controller.dart';
import '../../application/checkout_wizard_state.dart';
import '../widgets/close_progress.dart';
import '../widgets/verify_cards.dart';
import '../widgets/wizard_banners.dart';
import '../widgets/wizard_dock.dart';

/// Paso `CUSTOMER_SIGN_PENDING` (y `FINALIZING`) — M2-H5, mockup 18.
///
/// **La decisión que define esta pantalla**: el paso se decide por el SELLO
/// `customerSignedAt`, no por `currentStep`. El complete de la inspección
/// estampa `customerSignedAt` JUNTO a `inspectionCompletedAt` cuando viene
/// firma (mobile-inspection.service.js:265-281), y la captura de RideOps
/// SIEMPRE manda firma (inspection_screen.dart). O sea: en el camino normal de
/// esta app el paso 8 llega ya cumplido, y 18D es lo que el agente va a ver
/// casi siempre. 18A/18B son el camino minoritario (inspección hecha en otra
/// superficie, o sin firma).
///
/// Construirlo por PASO en vez de por sello tendría dos consecuencias, las dos
/// graves: pedirle al cliente que firme dos veces la misma entrega, y que
/// `saveCustomerSignature` **sobrescriba** la firma ya guardada
/// (checkout-session.service.js:668-690 pisa `tcSignature*` sin condición).
class SignStep extends ConsumerWidget {
  const SignStep({
    super.key,
    required this.reservationId,
    required this.banners,
    required this.onPause,
  });

  final String reservationId;
  final List<Widget> banners;

  /// "Guardar y pausar" de 19C. Vive en el shell (es el mismo sheet del back),
  /// así que el paso lo recibe en vez de inventar otro.
  final VoidCallback onPause;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final wizard = ref.watch(checkoutWizardProvider(reservationId));
    final session = wizard.session;
    if (session == null) return const SizedBox.shrink();
    final close = ref.watch(checkoutCloseProvider(reservationId));

    // 19C — se cortó la conexión a media secuencia. Va PRIMERO porque es el
    // único estado en el que la pantalla no sabe qué pasó, y todo lo demás
    // que pudiera dibujarse encima sería una afirmación sin respaldo.
    if (close.isUnknown) {
      return _UnknownView(
        reservationId: reservationId,
        close: close,
        banners: banners,
        onPause: onPause,
      );
    }

    // 18C — el cierre está corriendo (o se cortó de forma reintentable).
    if (close.running || close.failureKind == CloseFailureKind.retryable) {
      return _ClosingView(
        reservationId: reservationId,
        close: close,
        banners: banners,
      );
    }

    // 18D — el sello ya existe: el paso informa y avanza, no pide nada.
    if (session.customerSignedAt != null) {
      return _AlreadySignedView(
        reservationId: reservationId,
        session: session,
        banners: banners,
      );
    }

    // 18A — hay que pedirle la firma al cliente.
    return _HandoffView(reservationId: reservationId, banners: banners);
  }
}

/// Superficie VOLTEADA al cliente para la firma de la entrega (18B). La monta
/// el shell del wizard sin ningún cromo de staff.
///
/// Es el kiosco del M1 tal cual —candado suspendido, back bloqueado, salida
/// por PIN con 3 intentos— apuntado a otro trámite. Se REUSA, no se clona.
class CheckoutSignatureSurface extends ConsumerWidget {
  const CheckoutSignatureSurface({super.key, required this.reservationId});

  final String reservationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final wizard = ref.watch(checkoutWizardProvider(reservationId));
    final controller = ref.read(checkoutCloseProvider(reservationId).notifier);
    final context_ = wizard.context;
    return KioskSignatureStep(
      purpose: KioskSignaturePurpose.checkout,
      // JAMÁS marca propia frente al cliente: el getter neutraliza además el
      // centinela 'Ride Fleet' que display-data manda como default.
      tenantName: context_?.branding?.clientSafeCompanyName ?? '',
      tenantLogoUrl: context_?.branding?.companyLogoUrl ?? '',
      reservationLabel: context_?.reservationNumber ?? '—',
      vehicleLabel: context_?.vehicleLabel,
      plate: context_?.plate,
      onConfirmed: controller.confirmSignature,
      // Salida deliberada: NO toca la sesión — el paso queda igual, que es
      // exactamente lo que 18A prometió antes de soltar el teléfono.
      onExitToStaff: controller.exitKiosk,
    );
  }
}

/// 18A — la entrega del aparato es una PANTALLA, no un botón suelto: el agente
/// tiene que poder decir en voz alta lo que va a pasar y saber cómo recuperar
/// el teléfono ANTES de soltarlo.
class _HandoffView extends ConsumerWidget {
  const _HandoffView({required this.reservationId, required this.banners});

  final String reservationId;
  final List<Widget> banners;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final wizard = ref.watch(checkoutWizardProvider(reservationId));
    final name = wizard.context?.customerName;
    final vehicle = wizard.context?.vehicleLabel;
    final tenant = wizard.context?.tenantName;
    // Sin red la firma NO se pide: se escribe en el contrato en el momento y
    // no existe camino offline (jamás se encola una firma). Se bloquea la
    // entrega del teléfono CON CAUSA, que es lo contrario de esconder el CTA.
    final offline = wizard.offline;

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            children: [
              ...banners,
              Container(
                padding: const EdgeInsets.fromLTRB(16, 18, 16, 18),
                decoration: BoxDecoration(
                  color: RideTokens.n0,
                  borderRadius: BorderRadius.circular(22),
                  border: Border.all(color: RideTokens.n200),
                ),
                child: Column(
                  children: [
                    const Icon(
                      Icons.phone_iphone_rounded,
                      size: 46,
                      color: RideTokens.n700,
                    ),
                    const SizedBox(height: 10),
                    Text(
                      l10n.coHandoffTitle,
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontSize: 19,
                        fontWeight: FontWeight.w900,
                        color: RideTokens.n900,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      // Sin nombre o sin unidad no se rellena un hueco.
                      name == null || vehicle == null
                          ? l10n.coHandoffBodyGeneric
                          : l10n.coHandoffBody(name, vehicle),
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w700,
                        color: RideTokens.n700,
                        height: 1.4,
                      ),
                    ),
                    const SizedBox(height: 14),
                    // Las cuatro reglas son las que el modo kiosco YA cumple
                    // en código; ninguna es una promesa nueva.
                    _Rule(
                      icon: Icons.lock_outline_rounded,
                      text: l10n.coHandoffRuleLock,
                    ),
                    _Rule(
                      icon: Icons.schedule_rounded,
                      text: l10n.coHandoffRuleExit,
                    ),
                    // El LÍMITE, dicho aquí y no descubierto con el teléfono
                    // en la mano del cliente: 3 intentos y la app se bloquea
                    // (kiosk_exit_exhausted, ya construido en M1-H5).
                    _Rule(
                      icon: Icons.gpp_maybe_outlined,
                      text: l10n.coHandoffRulePin,
                    ),
                    _Rule(
                      icon: Icons.translate_rounded,
                      text: tenant == null || tenant.isEmpty
                          ? l10n.coHandoffRuleBrandNoTenant
                          : l10n.coHandoffRuleBrand(tenant),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          child: WizardDock(
            why: offline ? l10n.coHandoffOfflineBlocked : l10n.coHandoffWhy,
            primary: Semantics(
              button: true,
              enabled: !offline,
              label: l10n.coHandoffCta,
              hint: offline ? l10n.coHandoffOfflineBlocked : null,
              child: ExcludeSemantics(
                child: RidePrimaryButton(
                  label: l10n.coHandoffCta,
                  onPressed: offline
                      ? null
                      : () => ref
                          .read(checkoutCloseProvider(reservationId).notifier)
                          .openKiosk(),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _Rule extends StatelessWidget {
  const _Rule({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 16, color: RideTokens.n700),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: RideTokens.n800,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 18D — la firma YA venía de la inspección. El camino NORMAL de RideOps: el
/// paso no pide nada, informa y avanza.
class _AlreadySignedView extends ConsumerWidget {
  const _AlreadySignedView({
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
    final wizard = ref.watch(checkoutWizardProvider(reservationId));
    final format = DateFormat.Hm(Localizations.localeOf(context).toString());
    final signedAt = session.customerSignedAt!;
    final time = format.format(signedAt.toLocal());
    // Solo se atribuye a la inspección cuando los dos sellos son el MISMO
    // instante: el complete los escribe en un único write. Sellos distintos =
    // la firma vino de otra superficie y no se inventa de dónde.
    final fromInspection = session.inspectionCompletedAt == signedAt;
    final name = wizard.context?.customerName;
    final number = wizard.context?.reservationNumber;

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            children: [
              ...banners,
              const SizedBox(height: 2),
              Center(
                child: Container(
                  width: 64,
                  height: 64,
                  decoration: BoxDecoration(
                    color: RideTokens.okBg,
                    shape: BoxShape.circle,
                    border: Border.all(color: RideTokens.okBd, width: 1.5),
                  ),
                  child: const Icon(
                    Icons.check_rounded,
                    size: 30,
                    color: RideTokens.okTx,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Text(
                l10n.coAlreadySignedTitle,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w900,
                  color: RideTokens.n900,
                ),
              ),
              const SizedBox(height: 6),
              Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 300),
                  child: Text(
                    fromInspection
                        ? l10n.coAlreadySignedBody(time)
                        : l10n.coAlreadySignedBodyOther(time),
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w700,
                      color: RideTokens.n700,
                      height: 1.4,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 10),
              Center(child: VerifyPill(
                label: l10n.coAlreadySignedChip(time),
                tone: VerifyTone.ok,
              )),
              const SizedBox(height: 16),
              VerifyCard(
                title: l10n.coSignedDocTitle,
                children: [
                  KvRow(
                    label: l10n.coSignedSigner,
                    value: name ?? l10n.coSignedSignerUnknown,
                    missing: name == null,
                  ),
                  KvRow(
                    label: l10n.coSignedDocument,
                    value: number == null
                        ? l10n.coSignedDocumentValueNoNumber
                        : l10n.coSignedDocumentValue(number),
                  ),
                  // Existe, pero es DISCRETO y avisa antes: el endpoint pisa
                  // la firma guardada sin condición. Ofrecerlo sin decir que
                  // SUSTITUYE sería la trampa; esconderlo dejaría sin remedio
                  // al caso real (firmó otra persona, el nombre iba mal).
                  CardLink(
                    label: l10n.coResignLink,
                    icon: Icons.draw_outlined,
                    onTap: wizard.offline
                        ? null
                        : () => _confirmResign(context, ref),
                  ),
                ],
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          child: WizardDock(
            why: wizard.offline ? l10n.coBlockedOfflineWhy : l10n.coCloseCtaWhy,
            primary: Semantics(
              button: true,
              enabled: wizard.canTransition,
              label: l10n.coCloseCta,
              hint: wizard.offline ? l10n.coBlockedOfflineShort : null,
              child: ExcludeSemantics(
                child: RidePrimaryButton(
                  label: l10n.coCloseCta,
                  onPressed: wizard.canTransition
                      ? () => ref
                          .read(checkoutCloseProvider(reservationId).notifier)
                          .close()
                      : null,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _confirmResign(BuildContext context, WidgetRef ref) async {
    final l10n = AppLocalizations.of(context)!;
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: RideTokens.n0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        title: Text(
          l10n.coResignTitle,
          style: const TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w800,
            color: RideTokens.n900,
          ),
        ),
        content: Text(
          l10n.coResignWarning,
          style: const TextStyle(
            fontSize: 13.5,
            fontWeight: FontWeight.w600,
            color: RideTokens.n700,
            height: 1.4,
          ),
        ),
        actions: [
          TextButton(
            style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(l10n.cancelButton),
          ),
          TextButton(
            style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(l10n.coResignConfirm),
          ),
        ],
      ),
    );
    if (ok != true) return;
    ref.read(checkoutCloseProvider(reservationId).notifier).openKiosk();
  }
}

/// 18C — vuelve a manos del agente. Tres renglones, nunca un spinner único.
class _ClosingView extends ConsumerWidget {
  const _ClosingView({
    required this.reservationId,
    required this.close,
    required this.banners,
  });

  final String reservationId;
  final CheckoutCloseState close;
  final List<Widget> banners;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final wizard = ref.watch(checkoutWizardProvider(reservationId));
    final failed = close.failureKind == CloseFailureKind.retryable;

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            children: [
              ...banners,
              // "Firma recibida" solo cuando el 200 ya llegó: en ese instante
              // es verdad, y lo que sigue todavía no se afirma.
              if (close.signature == CloseLegState.done) ...[
                WizardBanner(
                  icon: Icons.check_circle_outline,
                  iconColor: RideTokens.ok,
                  background: RideTokens.okBg,
                  border: RideTokens.okBd,
                  child: Text(
                    l10n.coSignReceived,
                    style: const TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: RideTokens.okTx,
                    ),
                  ),
                ),
                const SizedBox(height: 12),
              ],
              CloseProgressCard(
                signature: close.signature,
                finalizing: close.finalizing,
                closing: close.closing,
                signatureAt: close.signatureAt,
                failedAt: close.failedAt,
              ),
              if (failed && close.failureMessage != null) ...[
                const SizedBox(height: 12),
                ServerReasonCard(message: close.failureMessage!),
              ],
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          child: WizardDock(
            why: failed ? l10n.coCloseRetryWhy : l10n.coClosingWhy,
            primary: RidePrimaryButton(
              label: failed ? l10n.coCloseRetry : l10n.coClosingCta,
              loading: close.running,
              // Nunca un error sin botón: el tramo reintentable se reintenta,
              // y mientras corre el CTA está en carga (anti-doble-tap).
              onPressed: failed && !wizard.offline
                  ? () => ref
                      .read(checkoutCloseProvider(reservationId).notifier)
                      .retry()
                  : null,
            ),
          ),
        ),
      ],
    );
  }
}

/// 19C — se cayó la red a media cascada. **No se sabe si entró**: se consulta,
/// jamás se reintenta a ciegas (la misma regla del dinero, ADR-5, aplicada al
/// cierre). Aquí el riesgo no es cobrar dos veces: es dejar una reserva a
/// medio entregar creyendo que se arregló.
class _UnknownView extends ConsumerWidget {
  const _UnknownView({
    required this.reservationId,
    required this.close,
    required this.banners,
    required this.onPause,
  });

  final String reservationId;
  final CheckoutCloseState close;
  final List<Widget> banners;
  final VoidCallback onPause;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            children: [
              ...banners,
              WizardBanner(
                icon: Icons.warning_amber_rounded,
                iconColor: RideTokens.warnTx,
                background: RideTokens.warnBg,
                border: RideTokens.warnBd,
                child: Text(
                  l10n.coCloseUnknownTitle,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: RideTokens.n800,
                    height: 1.4,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              CloseProgressCard(
                signature: close.signature,
                finalizing: close.finalizing,
                closing: close.closing,
                signatureAt: close.signatureAt,
              ),
              const SizedBox(height: 12),
              // Las dos reglas se DECLARAN, no se dejan suponer: son las que
              // impiden que el agente se quede esperando un rescate que no va
              // a llegar.
              VerifyCard(
                title: l10n.coWontHappenTitle,
                pillLabel: l10n.coWontHappenPill,
                children: [
                  KvRow(label: l10n.coWontRetryLabel, value: l10n.coWontRetry),
                  KvRow(label: l10n.coWontQueueLabel, value: l10n.coWontQueue),
                ],
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          child: WizardDock(
            why: l10n.coCheckStatusWhy,
            primary: RidePrimaryButton(
              label: l10n.coCheckStatus,
              loading: close.checking,
              onPressed: () => ref
                  .read(checkoutCloseProvider(reservationId).notifier)
                  .checkStatus(),
            ),
            secondary: RideGhostButton(
              label: l10n.coPauseConfirm,
              onPressed: onPause,
            ),
          ),
        ),
      ],
    );
  }
}

/// `.quote` — el motivo del servidor va CITADO, no traducido (mismo patrón que
/// D2 de H2): la app pone el marco y el texto crudo dentro. Traducirlo a mano
/// sería inventar reglas de negocio en el cliente.
class ServerReasonCard extends StatelessWidget {
  const ServerReasonCard({
    super.key,
    required this.message,
    this.title,
    this.pillLabel,
    this.label,
  });

  final String message;
  final String? title;
  final String? pillLabel;
  final String? label;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return VerifyCard(
      title: title ?? l10n.coCloseReasonTitle,
      tone: VerifyTone.bad,
      pillLabel: pillLabel ?? l10n.coCloseReasonPill,
      children: [
        Container(
          width: double.infinity,
          margin: const EdgeInsets.only(top: 4),
          padding: const EdgeInsets.fromLTRB(11, 9, 11, 10),
          decoration: BoxDecoration(
            color: RideTokens.n25,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: RideTokens.n200),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label ?? l10n.coServerReasonLabel,
                style: const TextStyle(
                  fontSize: 11.5,
                  fontWeight: FontWeight.w900,
                  // n700 (9.0:1) y no n600: el rótulo va bajo 12 px.
                  color: RideTokens.n700,
                ),
              ),
              const SizedBox(height: 3),
              SelectableText(
                message,
                style: const TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w700,
                  color: RideTokens.n800,
                  height: 1.4,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Copia al portapapeles el detalle que el mostrador necesita para resolverlo.
///
/// Es la acción REAL de 19B: el motivo del rechazo **no sobrevive al
/// re-fetch** (el 409 no queda en `events[]` — pedido P10 al backend), así que
/// este caso tiene que resolverse en el momento o se pierde.
Future<void> copyProblemDetail(
  BuildContext context,
  WidgetRef ref, {
  required String reservationId,
  required CheckoutSessionDto session,
  required CheckoutCloseState close,
  required CheckoutReservationContext? reservationContext,
}) async {
  final l10n = AppLocalizations.of(context)!;
  final messenger = ScaffoldMessenger.maybeOf(context);
  final lines = <String>[
    if (reservationContext?.reservationNumber case final number?)
      'Reserva: $number',
    'Reserva ID: $reservationId',
    'Sesión: ${session.id}',
    'Paso: ${session.currentStep}',
    if (close.failedAt case final at?) 'Rechazado: ${at.toIso8601String()}',
    if (close.failureCode case final code?) 'Código: $code',
    if (close.failureMessage case final message?) 'Motivo: $message',
    if (reservationContext?.reservationStatus case final status?)
      'Estado de la reserva: $status',
  ];
  await Clipboard.setData(ClipboardData(text: lines.join('\n')));
  messenger?.showSnackBar(SnackBar(content: Text(l10n.coCopiedProblem)));
}
