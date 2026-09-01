import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../../core/api/dto/checkout_session.dart';
import '../../../../core/api/enums.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/l10n/odometer_format.dart';
import '../../../../core/telemetry/event_logger.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../application/checkout_wizard_controller.dart';
import '../../application/checkout_wizard_state.dart';
import '../../domain/checkout_confirm.dart';
import '../widgets/transition_button.dart';
import '../widgets/vehicle_swap_sheet.dart';
import '../widgets/verify_cards.dart';
import '../widgets/wizard_banners.dart';
import '../widgets/wizard_dock.dart';

/// Paso CONFIRMING (M2-H2, mockup 9A-9E).
///
/// El agente confronta la pantalla con la licencia física y con la unidad que
/// tiene en la mano. **No hay checkbox "confirmo"**: el acto de avanzar ES la
/// confirmación, y queda en `events[]` con su `actorUserId` (nota 1).
///
/// Todo lo que se dibuja sale del servidor: la sesión (poll del wizard) y
/// display-data (contexto). La pantalla no guarda estado propio salvo qué
/// sheet está abierto.
class ConfirmingStep extends ConsumerStatefulWidget {
  const ConfirmingStep({
    super.key,
    required this.reservationId,
    required this.banners,
  });

  final String reservationId;

  /// Banners del shell (offline / avance ajeno / 409 ya reconciliado). Los
  /// inyecta la pantalla del wizard para que la matriz de errores viva en un
  /// solo lugar y el paso solo decida DÓNDE van dentro de su cuerpo.
  final List<Widget> banners;

  @override
  ConsumerState<ConfirmingStep> createState() => _ConfirmingStepState();
}

class _ConfirmingStepState extends ConsumerState<ConfirmingStep> {
  final _scroll = ScrollController();

  /// Hay una re-consulta del agente en vuelo ("Actualizar datos del cliente"
  /// o "Reintentar la consulta"). Vive aquí y no en el controller porque es
  /// una acción de PANTALLA: el wizard no distingue este refresh de los del
  /// poll.
  bool _rechecking = false;

  /// Ya terminó una re-consulta lanzada a mano. Es el acuse que faltaba
  /// (review GD-MC-5): antes el botón disparaba dos peticiones y no mostraba
  /// absolutamente nada, así que el agente lo volvía a tocar.
  ///
  /// **Qué acuse se muestra lo decide el VEREDICTO, no esta bandera**: con
  /// `answered` el subtexto nombra los campos que el servidor sigue sin tener;
  /// con `unreachable` habla solo de la consulta. Mezclarlos era el defecto:
  /// una petición caída acababa diciendo "el servidor sigue sin el nombre, la
  /// licencia y el teléfono" con el servidor teniendo los tres.
  bool _recheckedStill = false;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  /// Vuelve a preguntarle al servidor. Es la MISMA acción para los dos
  /// bloqueos —datos faltantes y consulta caída— porque la salida honesta de
  /// ambos es idéntica: RideOps no captura datos de cliente (ADR-1), así que
  /// lo único que puede hacer es volver a consultar.
  Future<void> _recheck() async {
    if (_rechecking) return;
    setState(() {
      _rechecking = true;
      _recheckedStill = false;
    });
    final controller =
        ref.read(checkoutWizardProvider(widget.reservationId).notifier);
    // De qué bloqueo salió el toque: el evento mide si el reintento del dato
    // inalcanzable sirve de algo en el patio.
    final wasUnreachable = ref
            .read(checkoutWizardProvider(widget.reservationId))
            .contextVerdict ==
        ContextVerdict.unreachable;
    try {
      // Las dos lecturas: la sesión (por si otra superficie avanzó mientras
      // tanto) y display-data, que es donde viven los datos del cliente.
      await controller.refresh();
      final verdict = await controller.retryContext();
      if (wasUnreachable && mounted) {
        ref.read(eventLoggerProvider).log(
          CheckoutEvents.contextRetry,
          data: {'result': verdict.name},
        );
      }
    } finally {
      // El acuse se enciende SIEMPRE que la consulta terminó; si los datos ya
      // llegaron, el bloqueo entero desaparece y con él este texto.
      if (mounted) {
        setState(() {
          _rechecking = false;
          _recheckedStill = true;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final reservationId = widget.reservationId;
    final banners = widget.banners;
    final l10n = AppLocalizations.of(context)!;
    // Una negativa del servidor que aparece ARRIBA de una lista que el agente
    // dejó desplazada (p. ej. tras cerrar el sheet de swap) es una negativa
    // que no se ve, o sea ninguna. Al llegar un conflicto nuevo, el cuerpo
    // vuelve al principio.
    ref.listen(
      checkoutWizardProvider(reservationId).select((s) => s.conflict),
      (previous, next) {
        if (next == null || previous == next || !_scroll.hasClients) return;
        _scroll.animateTo(
          0,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
        );
      },
    );
    final state = ref.watch(checkoutWizardProvider(reservationId));
    final session = state.session;
    if (session == null) return const SizedBox.shrink();

    final ctx = state.context;
    final check = customerCheck(
      verdict: state.contextVerdict,
      customer: ctx?.customer,
      agreement: ctx?.agreement,
    );
    // 9D: el 409 del vehículo tiñe la tarjeta y reordena la pantalla — la
    // unidad en conflicto es lo primero que hay que leer.
    final vehicleConflict =
        state.conflict?.kind == CheckoutConflictKind.vehicleConflict;

    final customerCard = _CustomerCard(
      check: check,
      // Sin consulta tampoco se sabe si hubo pre-checkin: `precheckinDone`
      // es otro campo de display-data y su default `false` diría "Pendiente"
      // sobre un dato que nadie leyó.
      precheckinDone: ctx?.precheckinDone ?? false,
      precheckinAt: ctx?.precheckinAt,
      // El cuerpo CRUDO de la negativa (DoD #5). Vacío o ausente ⇒ la tarjeta
      // no inventa diagnóstico y se queda con su copy traducido.
      serverMessage: check.unreachable ? _serverMessage(state) : null,
    );

    final cards = <Widget>[
      if (vehicleConflict) ...[
        _VehicleCard(state: state, conflict: true, onSwap: null),
        const SizedBox(height: 12),
        customerCard,
      ] else ...[
        customerCard,
        const SizedBox(height: 12),
        _VehicleCard(
          state: state,
          conflict: false,
          // Nota 2: el enlace desaparece donde el servidor ya no acepta el
          // swap. Y sin red no se ofrece: el sheet solo sabe mentir sin
          // servidor (su lista y su escritura son del servidor).
          onSwap: swapAllowedFor(state.step) && !state.offline
              ? () => _openSwapSheet(context, ref)
              : null,
        ),
        // El seguro NO se declina en una reserva de cortesía (review INN-MC-3).
        // No es cosmético: el loaner SÍ recibe un `RentalAgreement` compañero
        // (checkout-session.service.js:245-255), así que el POST responde 200 y
        // estampa un anexo de RECHAZO DE COBERTURA sobre un contrato de $0. El
        // wizard web ya esconde este switch (checkout-wizard-v2/page.js:839);
        // esta app era la única que lo ofrecía.
        if (!(ctx?.isLoaner ?? false)) ...[
          const SizedBox(height: 12),
          _InsuranceSwitch(reservationId: reservationId, session: session),
        ],
      ],
    ];

    return Column(
      children: [
        Expanded(
          child: ListView(
            controller: _scroll,
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            children: [
              ...banners,
              ...cards,
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          child: vehicleConflict
              ? _ConflictDock(onSwap: () => _openSwapSheet(context, ref))
              : TransitionButton(
                  reservationId: reservationId,
                  // El destino lo conoce la PANTALLA por diseño de producto,
                  // nunca por inferencia sobre el catálogo (ADR-4).
                  toStep: CheckoutStep.tcPending,
                  label: l10n.coConfirmCta,
                  blockedWhy: _blockedWhy(l10n, check),
                  // Bloquear sin salida sería dejar al agente encerrado: la
                  // captura de datos del cliente NO vive en esta app (ADR-1,
                  // se queda en el mostrador web / pre-checkin), así que la
                  // salida honesta es volver a preguntarle al servidor.
                  //
                  // Mientras la consulta VIAJA no hay botón: reintentar algo
                  // que ya está en vuelo es una puerta falsa. El why lo dice.
                  secondary: check.complete || check.checking
                      ? null
                      : RideGhostButton(
                          label: check.unreachable
                              ? l10n.coConfirmRetryLookup
                              : l10n.coConfirmRecheck,
                          loading: _rechecking,
                          loadingLabel: l10n.coConfirmRecheckPending,
                          onPressed: _recheck,
                        ),
                ),
        ),
      ],
    );
  }

  Future<void> _openSwapSheet(BuildContext context, WidgetRef ref) =>
      showVehicleSwapSheet(context, reservationId: widget.reservationId);

  /// El cuerpo crudo de la negativa de display-data, o null si no hay ninguno
  /// que citar (la petición murió sin respuesta, o el servidor mandó un cuerpo
  /// vacío). Null ⇒ la tarjeta no escribe un renglón hueco.
  String? _serverMessage(CheckoutWizardState state) {
    final message = state.contextError?.message.trim() ?? '';
    return message.isEmpty ? null : message;
  }

  /// La causa del bloqueo, y **de qué naturaleza es**.
  ///
  /// Las tres ramas son tres historias distintas y esa distinción es el
  /// arreglo entero:
  ///  - `checking`: nadie ha contestado todavía ⇒ no se afirma nada.
  ///  - `unreachable`: la consulta no llegó ⇒ se bloquea porque sin ella no
  ///    hay identidad que confirmar, NO porque falten datos. El texto no dice
  ///    qué tiene el servidor porque no se sabe.
  ///  - `answered`: el servidor contestó ⇒ y solo aquí se pueden nombrar los
  ///    campos que faltan.
  String? _blockedWhy(AppLocalizations l10n, ConfirmCustomerCheck check) =>
      switch (check.verdict) {
        ContextVerdict.checking => l10n.coConfirmCheckingWhy,
        ContextVerdict.unreachable => _recheckedStill
            ? l10n.coConfirmRetryStillUnreachable
            : l10n.coConfirmUnreachableWhy,
        ContextVerdict.answered => check.complete
            ? null
            : (_recheckedStill
                ? l10n.coConfirmRecheckedStill(_missingLabel(l10n, check))
                : l10n.coConfirmBlockedWhy(_missingLabel(l10n, check))),
      };

  /// "licencia y teléfono" — lista legible, no una enumeración de campos de
  /// base de datos.
  String _missingLabel(AppLocalizations l10n, ConfirmCustomerCheck check) {
    final parts = [
      for (final field in check.missing)
        switch (field) {
          ConfirmMissingField.customerName => l10n.coConfirmFieldName,
          ConfirmMissingField.license => l10n.coConfirmFieldLicense,
          ConfirmMissingField.phone => l10n.coConfirmFieldPhone,
        },
    ];
    if (parts.length <= 1) return parts.join();
    return '${parts.sublist(0, parts.length - 1).join(', ')} '
        '${l10n.coConfirmFieldJoin} ${parts.last}';
  }
}

class _CustomerCard extends StatelessWidget {
  const _CustomerCard({
    required this.check,
    required this.precheckinDone,
    required this.precheckinAt,
    required this.serverMessage,
  });

  final ConfirmCustomerCheck check;
  final bool precheckinDone;

  /// Cuándo se selló el pre-checkin. El controller ya leía este campo y solo
  /// guardaba el bool (review GD-MC-6).
  final DateTime? precheckinAt;

  /// Negativa del servidor, sin tocar. Solo llega en el veredicto
  /// `unreachable` y solo cuando hubo cuerpo que citar.
  final String? serverMessage;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final expiry = check.licenseExpiry;
    final license = check.license == null
        ? null
        : (expiry == null
            ? check.license!
            : l10n.coConfirmLicenseWithExpiry(
                check.license!,
                DateFormat.yMMM(locale).format(expiry.toLocal()),
              ));

    // Los tres estados de la tarjeta. `unreachable` toma el ámbar de 19A-bis
    // —el escalón entre "todo bien" y "el servidor dijo que no"— porque eso es
    // exactamente lo que hay: ignorancia, no un hecho negativo. Pintarla en
    // rojo con "Faltan datos" era el bug: mismo color y misma palabra para una
    // acusación que nadie puede sostener.
    final (tone, pill) = switch (check.verdict) {
      ContextVerdict.checking =>
        (VerifyTone.neutral, l10n.coConfirmCheckingPill),
      ContextVerdict.unreachable =>
        (VerifyTone.warn, l10n.coConfirmUnknownPill),
      ContextVerdict.answered => check.complete
          ? (VerifyTone.ok, l10n.coConfirmVerified)
          : (VerifyTone.bad, l10n.coConfirmMissingPill),
    };

    // Valor de una fila que NO tiene dato. Con respuesta del servidor se dice
    // "Sin capturar" (un hecho suyo); sin ella, "No se pudo consultar" — que
    // es lo único cierto.
    String blank() => switch (check.verdict) {
          ContextVerdict.checking => l10n.coConfirmCheckingValue,
          ContextVerdict.unreachable => l10n.coConfirmUnknownValue,
          ContextVerdict.answered => l10n.coConfirmMissingValue,
        };
    final answered = check.verdict == ContextVerdict.answered;

    return VerifyCard(
      title: l10n.coConfirmCustomer,
      tone: tone,
      pillLabel: pill,
      children: [
        KvRow(
          label: l10n.coConfirmName,
          value: check.name ?? blank(),
          // `missing` pinta en rojo "el servidor no lo tiene". Solo se puede
          // afirmar cuando el servidor contestó.
          missing: answered && check.name == null,
          warn: check.unreachable,
          busy: check.checking,
        ),
        KvRow(
          label: l10n.coConfirmLicense,
          value: license ?? blank(),
          missing: answered && license == null,
          warn: check.unreachable,
          busy: check.checking,
        ),
        KvRow(
          label: l10n.coConfirmPhone,
          value: check.phone ?? blank(),
          missing: answered && check.phone == null,
          warn: check.unreachable,
          busy: check.checking,
          tabular: check.phone != null,
        ),
        KvRow(
          label: l10n.coConfirmPrecheckin,
          // "Pre-checkin | Completado 18:42", no "Pre-checkin | Pre-checkin
          // listo" (review GD-MC-6): la clave ya nombró el campo, el valor solo
          // tiene que decir su estado — y la hora, que es el dato con el que el
          // agente decide si confía en esa captura.
          //
          // Sin consulta NO se dice "Pendiente": el sello del pre-checkin vive
          // en el mismo payload que no llegó.
          value: !answered
              ? blank()
              : !precheckinDone
                  ? l10n.coConfirmPrecheckinPending
                  : precheckinAt == null
                      ? l10n.coConfirmPrecheckinDone
                      : l10n.coConfirmPrecheckinDoneAt(
                          DateFormat.Hm(locale).format(precheckinAt!.toLocal()),
                        ),
          warn: check.unreachable,
          busy: check.checking,
        ),
        // La negativa del servidor, literal. Va DENTRO de la tarjeta que no
        // pudo llenarse: es la explicación de por qué está vacía, no un error
        // suelto del paso.
        if (serverMessage != null)
          KvRow(
            label: l10n.coConfirmUnknownPill,
            value: l10n.coConfirmUnreachableServer(serverMessage!),
            warn: true,
          ),
      ],
    );
  }
}

class _VehicleCard extends StatelessWidget {
  const _VehicleCard({
    required this.state,
    required this.conflict,
    required this.onSwap,
  });

  final CheckoutWizardState state;
  final bool conflict;
  final VoidCallback? onSwap;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final ctx = state.context;
    final odometer = ctx?.odometer;
    final status = (ctx?.vehicleStatus ?? '').toUpperCase();
    final unit = [ctx?.vehicleLabel, ctx?.plate]
        .nonNulls
        .where((p) => p.isNotEmpty)
        .join(' · ');
    // La unidad viene del MISMO display-data que el cliente: sin consulta,
    // "Sin capturar" sería la misma acusación falsa un renglón más abajo.
    final unreachable =
        state.contextVerdict == ContextVerdict.unreachable && unit.isEmpty;
    final checking =
        state.contextVerdict == ContextVerdict.checking && unit.isEmpty;
    return VerifyCard(
      title: l10n.coConfirmVehicle,
      tone: conflict ? VerifyTone.bad : VerifyTone.neutral,
      // Solo se afirma "Disponible" cuando el servidor dice AVAILABLE; con
      // cualquier otro estado se muestra la palabra cruda del servidor.
      pillLabel: conflict
          ? l10n.coConfirmConflictPill
          : status == 'AVAILABLE'
              ? l10n.coConfirmVehicleAvailable
              : (status.isEmpty ? null : status),
      children: [
        KvRow(
          label: l10n.coConfirmUnit,
          value: unit.isNotEmpty
              ? unit
              : unreachable
                  ? l10n.coConfirmUnknownValue
                  : checking
                      ? l10n.coConfirmCheckingValue
                      : l10n.coConfirmMissingValue,
          missing: unit.isEmpty && !unreachable && !checking,
          warn: unreachable,
          busy: checking,
        ),
        if (odometer != null)
          KvRow(
            label: l10n.coConfirmOdometerLabel,
            value: formatOdometer(l10n, locale, odometer),
            tabular: true,
          ),
        if (onSwap != null)
          CardLink(label: l10n.coConfirmChangeVehicle, onTap: onSwap),
      ],
    );
  }
}

/// Switch del seguro declinado + su consecuencia declarada (9A/9C).
class _InsuranceSwitch extends ConsumerWidget {
  const _InsuranceSwitch({required this.reservationId, required this.session});

  final String reservationId;
  final CheckoutSessionDto session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final state = ref.watch(checkoutWizardProvider(reservationId));
    final declined = declinedInsuranceOf(
      session: session,
      agreement: state.context?.agreement,
    );
    final editable = insuranceEditable(session);
    final busy = state.mutating == CheckoutMutation.declinedInsurance;

    final subtitle = !editable
        ? l10n.coDeclineLocked
        : state.offline
            ? l10n.coDeclineNeedsNetwork
            : declined
                ? l10n.coDeclineOn
                : l10n.coDeclineOff;

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        DeclineSwitchRow(
          title: l10n.coDeclineTitle,
          subtitle: subtitle,
          value: declined,
          busy: busy,
          onChanged: !editable || state.offline || busy
              ? null
              : (next) => ref
                  .read(checkoutWizardProvider(reservationId).notifier)
                  .setDeclinedInsurance(next),
        ),
        // Consecuencia + ventana de arrepentimiento en el MISMO bloque. Sin
        // diálogo de confirmación a propósito (nota 6): el switch es
        // reversible hasta la firma, y el aviso dice exactamente eso.
        if (declined) ...[
          const SizedBox(height: 10),
          WizardBanner(
            icon: Icons.warning_amber_rounded,
            iconColor: RideTokens.warnTx,
            background: RideTokens.warnBg,
            border: RideTokens.warnBd,
            child: Text(
              editable ? l10n.coDeclineConsequence : l10n.coDeclineSignedNote,
              style: const TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: RideTokens.warnTx,
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// Dock del 9D: una salida PRIMARIA siempre. Prohibido dejar al agente con un
/// error y ningún botón (nota 8).
class _ConflictDock extends StatelessWidget {
  const _ConflictDock({required this.onSwap});

  final VoidCallback onSwap;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return WizardDock(
      why: l10n.coConflictSwapWhy,
      primary: RidePrimaryButton(
        label: l10n.coConflictSwapCta,
        onPressed: onSwap,
      ),
    );
  }
}
