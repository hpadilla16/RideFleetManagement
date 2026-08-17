import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../../core/api/dto/checkout_session.dart';
import '../../../../core/api/enums.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../application/checkout_wizard_controller.dart';
import '../../application/checkout_wizard_state.dart';
import '../../domain/checkout_confirm.dart';
import '../widgets/transition_button.dart';
import '../widgets/vehicle_swap_sheet.dart';
import '../widgets/verify_cards.dart';
import '../widgets/wizard_banners.dart';

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

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
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
      customer: ctx?.customer,
      agreement: ctx?.agreement,
    );
    // 9D: el 409 del vehículo tiñe la tarjeta y reordena la pantalla — la
    // unidad en conflicto es lo primero que hay que leer.
    final vehicleConflict =
        state.conflict?.kind == CheckoutConflictKind.vehicleConflict;

    final cards = <Widget>[
      if (vehicleConflict) ...[
        _VehicleCard(state: state, conflict: true, onSwap: null),
        const SizedBox(height: 12),
        _CustomerCard(check: check, precheckinDone: ctx?.precheckinDone ?? false),
      ] else ...[
        _CustomerCard(check: check, precheckinDone: ctx?.precheckinDone ?? false),
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
        const SizedBox(height: 12),
        _InsuranceSwitch(reservationId: reservationId, session: session),
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
                  blockedWhy: check.complete
                      ? null
                      : l10n.coConfirmBlockedWhy(_missingLabel(l10n, check)),
                  // Bloquear sin salida sería dejar al agente encerrado: la
                  // captura de datos del cliente NO vive en esta app (ADR-1,
                  // se queda en el mostrador web / pre-checkin), así que la
                  // salida honesta es volver a preguntarle al servidor.
                  secondary: check.complete
                      ? null
                      : RideGhostButton(
                          label: l10n.coConfirmRecheck,
                          onPressed: () {
                            final controller = ref.read(
                              checkoutWizardProvider(reservationId).notifier,
                            );
                            controller.refresh();
                            controller.reloadContext();
                          },
                        ),
                ),
        ),
      ],
    );
  }

  Future<void> _openSwapSheet(BuildContext context, WidgetRef ref) =>
      showVehicleSwapSheet(context, reservationId: widget.reservationId);

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
  const _CustomerCard({required this.check, required this.precheckinDone});

  final ConfirmCustomerCheck check;
  final bool precheckinDone;

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
    return VerifyCard(
      title: l10n.coConfirmCustomer,
      tone: check.complete ? VerifyTone.ok : VerifyTone.bad,
      pillLabel:
          check.complete ? l10n.coConfirmVerified : l10n.coConfirmMissingPill,
      children: [
        KvRow(
          label: l10n.coConfirmName,
          value: check.name ?? l10n.coConfirmMissingValue,
          missing: check.name == null,
        ),
        KvRow(
          label: l10n.coConfirmLicense,
          value: license ?? l10n.coConfirmMissingValue,
          missing: license == null,
        ),
        KvRow(
          label: l10n.coConfirmPhone,
          value: check.phone ?? l10n.coConfirmMissingValue,
          missing: check.phone == null,
          tabular: check.phone != null,
        ),
        KvRow(
          label: l10n.coConfirmPrecheckin,
          value: precheckinDone
              ? l10n.coPrecheckinReady
              : l10n.coPrecheckinPending,
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
          value: unit.isEmpty ? l10n.coConfirmMissingValue : unit,
          missing: unit.isEmpty,
        ),
        if (odometer != null)
          KvRow(
            label: l10n.coConfirmOdometerLabel,
            value: l10n.coOdometerValue(
              NumberFormat.decimalPattern(locale).format(odometer),
            ),
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
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(0, 12, 0, 0),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: RideTokens.n200)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          RidePrimaryButton(
            label: l10n.coConflictSwapCta,
            onPressed: onSwap,
          ),
          const SizedBox(height: 9),
          Text(
            l10n.coConflictSwapWhy,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.n700,
            ),
          ),
        ],
      ),
    );
  }
}
