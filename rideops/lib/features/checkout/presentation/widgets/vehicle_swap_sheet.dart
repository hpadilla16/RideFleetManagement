import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_error.dart';
import '../../../../core/api/api_providers.dart';
import '../../../../core/api/dto/available_vehicle.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/l10n/odometer_format.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../application/checkout_wizard_controller.dart';
import '../../application/checkout_wizard_state.dart';
import '../checkout_labels.dart';

/// Sheet de cambio de unidad (mockup 9E).
///
/// Reglas del mockup que este archivo sostiene:
///  - **Solo unidades que el SERVIDOR da por disponibles**: la lista viene de
///    `GET /api/reservations/:id/available-vehicles`, que ya descarta solapes,
///    bloqueos y estados terminales. La app no filtra flota.
///  - La unidad **actual** (que el endpoint devuelve siempre, de primera)
///    aparece INERTE con su motivo legible en vez de omitirse: el agente la
///    tiene en la mano y necesita entender por qué no puede.
///  - Inerte **sin opacidad** (MUST de Graphic Design): superficie neutra y
///    texto en n700 (9.22:1). Atenuar la única explicación disponible sería
///    esconder justo lo que hay que leer.
///  - El sheet **declara la frescura** de su lista ("hace 4 s"), porque una
///    lista de disponibilidad envejece en segundos con 4 superficies vivas.
Future<void> showVehicleSwapSheet(
  BuildContext context, {
  required String reservationId,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    // Scrim de marca (mismo del selector de sedes y de la lista de pasos).
    barrierColor: const Color(0x6B17122B),
    useSafeArea: true,
    // Plate OPACO, no blur (política del M1).
    backgroundColor: RideTokens.n0,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
    ),
    constraints: const BoxConstraints(maxHeight: 640),
    builder: (_) => VehicleSwapSheet(reservationId: reservationId),
  );
}

class VehicleSwapSheet extends ConsumerStatefulWidget {
  const VehicleSwapSheet({super.key, required this.reservationId});

  final String reservationId;

  @override
  ConsumerState<VehicleSwapSheet> createState() => _VehicleSwapSheetState();
}

class _VehicleSwapSheetState extends ConsumerState<VehicleSwapSheet> {
  List<AvailableVehicle>? _rows;
  DateTime? _fetchedAt;
  ApiError? _loadError;

  /// Negativa del servidor sobre la unidad ELEGIDA (409 del swap). Vive en el
  /// sheet, no en un banner detrás: el agente tiene que elegir otra AQUÍ.
  String? _swapError;

  /// `code` de esa negativa: decide la línea de causa TRADUCIDA que va encima
  /// del mensaje del servidor (review INN-S-2). Los dos códigos que llegan
  /// hasta aquí son `VEHICLE_DOUBLE_BOOKED` y `VEHICLE_TERMINAL`.
  String? _swapErrorCode;
  String? _selectedId;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final rows = await ref
          .read(reservationsApiProvider)
          .getAvailableVehicles(widget.reservationId);
      if (!mounted) return;
      setState(() {
        _rows = rows;
        _fetchedAt = clock.now();
        _loading = false;
        // Una lista nueva puede haber dejado sin sentido la selección previa.
        if (_selectedId != null && !rows.any((v) => v.id == _selectedId)) {
          _selectedId = null;
        }
      });
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _loadError = e;
        _loading = false;
      });
    }
  }

  Future<void> _confirm(String vehicleId) async {
    final controller =
        ref.read(checkoutWizardProvider(widget.reservationId).notifier);
    setState(() {
      _swapError = null;
      _swapErrorCode = null;
    });
    final attempt = await controller.swapVehicle(vehicleId);
    if (!mounted) return;
    switch (attempt.outcome) {
      case CheckoutSwapOutcome.ok:
      case CheckoutSwapOutcome.lockedStep:
        // lockedStep: el swap dejó de existir para esta sesión; la negativa ya
        // quedó en el banner del paso, que sobrevive al cierre del sheet.
        Navigator.of(context).pop();
      case CheckoutSwapOutcome.vehicleRejected:
      case CheckoutSwapOutcome.failed:
        final l10n = AppLocalizations.of(context)!;
        setState(() {
          // Mensaje del servidor tal cual; un fallo SIN mensaje (5xx pelado)
          // no puede dejar un hueco en blanco.
          final message = attempt.message ?? '';
          _swapError = message.isEmpty ? l10n.genericError : message;
          _swapErrorCode = attempt.code;
          _selectedId = null;
        });
        // La lista que produjo esa elección ya es historia: se re-consulta.
        unawaited(_load());
      case CheckoutSwapOutcome.blocked:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final state = ref.watch(checkoutWizardProvider(widget.reservationId));
    final currentVehicleId = state.context?.vehicleId;
    final reservedTypeId = state.context?.vehicleTypeId;
    final busy = state.mutating == CheckoutMutation.vehicleSwap;
    final rows = _rows ?? const <AvailableVehicle>[];
    final selectable = [
      for (final v in rows)
        if (v.id != currentVehicleId) v,
    ];

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 44,
              height: 4,
              decoration: BoxDecoration(
                color: RideTokens.n300,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 14),
          Text(
            l10n.coSwapTitle,
            style: const TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w900,
              color: RideTokens.n900,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            _fetchedAt == null
                ? l10n.coSwapSubLoading
                : l10n.coSwapSub(
                    checkoutAgeLabel(l10n, clock.now().difference(_fetchedAt!)),
                  ),
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.n700,
            ),
          ),
          if (_swapError != null) ...[
            const SizedBox(height: 10),
            _SheetNotice(
              // Causa en el idioma del agente ARRIBA; cuerpo del servidor
              // debajo, intacto (DoD #5) — trae el número de la reserva que
              // aparta la unidad, o cuál de los dos estados terminales es.
              cause: switch (_swapErrorCode) {
                'VEHICLE_DOUBLE_BOOKED' => l10n.coSwapDoubleBookedCause,
                'VEHICLE_TERMINAL' => l10n.coSwapTerminalCause,
                _ => null,
              },
              message: _swapError!,
            ),
          ],
          const SizedBox(height: 10),
          Flexible(
            child: _body(
              l10n,
              rows: rows,
              selectable: selectable,
              currentVehicleId: currentVehicleId,
              reservedTypeId: reservedTypeId,
              busy: busy,
            ),
          ),
          const SizedBox(height: 10),
          RidePrimaryButton(
            label: _selectedId == null
                ? l10n.coSwapConfirmNone
                : l10n.coSwapConfirm(
                    rows.firstWhere((v) => v.id == _selectedId).label,
                  ),
            loading: busy,
            onPressed: _selectedId == null || busy || state.offline
                ? null
                : () => _confirm(_selectedId!),
          ),
          if (state.offline) ...[
            const SizedBox(height: 8),
            Text(
              l10n.coSwapNeedsNetwork,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: RideTokens.n700,
              ),
            ),
          ],
          const SizedBox(height: 9),
          RideGhostButton(
            label: l10n.coSwapCancel,
            onPressed: busy ? null : () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }

  Widget _body(
    AppLocalizations l10n, {
    required List<AvailableVehicle> rows,
    required List<AvailableVehicle> selectable,
    required String? currentVehicleId,
    required String? reservedTypeId,
    required bool busy,
  }) {
    if (_loading && _rows == null) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.symmetric(vertical: 28),
          child: CircularProgressIndicator(color: RideTokens.p600),
        ),
      );
    }
    if (_loadError != null && _rows == null) {
      return _SheetMessage(
        // Mensaje del backend tal cual (403 de sede incluido); si vino vacío,
        // copy traducido en vez de un hueco.
        message: _loadError!.message.isNotEmpty
            ? _loadError!.message
            : l10n.genericError,
        actionLabel: l10n.retryButton,
        onAction: _load,
      );
    }
    if (selectable.isEmpty) {
      return _SheetMessage(
        message: l10n.coSwapEmpty,
        actionLabel: l10n.retryButton,
        onAction: _load,
      );
    }
    return ListView(
      shrinkWrap: true,
      children: [
        for (final v in rows)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: v.id == currentVehicleId
                ? _InertOption(
                    label: v.label,
                    // Motivo LEGIBLE y PROPIO, no la cita del servidor: este
                    // renglón mide 12.5 px y el mensaje del backend viene en
                    // INGLÉS y del largo de una frase entera (parte de MC-4).
                    // La cita íntegra del servidor sigue visible donde sí cabe:
                    // el banner del paso, detrás de este sheet.
                    reason: ref
                                .watch(checkoutWizardProvider(
                                    widget.reservationId))
                                .vehicleConflictMessage !=
                            null
                        ? l10n.coSwapCurrentCommitted
                        : l10n.coSwapCurrentReason,
                  )
                : _Option(
                    vehicle: v,
                    selected: v.id == _selectedId,
                    reservedTypeId: reservedTypeId,
                    onTap: busy
                        ? null
                        : () => setState(() => _selectedId = v.id),
                  ),
          ),
      ],
    );
  }
}

/// Opción elegible. 48 px de alto real y radio táctil completo: la fila
/// entera es el objetivo, no el radio de 20 px.
class _Option extends StatelessWidget {
  const _Option({
    required this.vehicle,
    required this.selected,
    required this.reservedTypeId,
    required this.onTap,
  });

  final AvailableVehicle vehicle;
  final bool selected;
  final String? reservedTypeId;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final parts = <String>[
      // "Mismo grupo" solo se afirma cuando hay con qué compararlo. La
      // jerarquía de clases ("grupo superior") NO se inventa: el endpoint no
      // manda tarifas, así que se dice lo que sí se sabe.
      if (reservedTypeId != null && vehicle.vehicleTypeId != null)
        vehicle.vehicleTypeId == reservedTypeId
            ? l10n.coSwapSameGroup
            : l10n.coSwapOtherGroup,
      if (vehicle.mileage != null)
        formatOdometer(l10n, locale, vehicle.mileage!),
      if (vehicle.homeLocation?.name != null) vehicle.homeLocation!.name!,
      if (!vehicle.isAvailableNow && (vehicle.status ?? '').isNotEmpty)
        vehicle.status!,
    ];
    return Material(
      color: selected ? RideTokens.p50 : RideTokens.n0,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          constraints: const BoxConstraints(minHeight: 56),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: selected ? RideTokens.p600 : RideTokens.n200,
              width: selected ? 1.6 : 1,
            ),
          ),
          child: Row(
            children: [
              Icon(
                selected
                    ? Icons.radio_button_checked_rounded
                    : Icons.radio_button_unchecked_rounded,
                size: 22,
                color: selected ? RideTokens.p600 : RideTokens.n500,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      vehicle.label,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w900,
                        color: selected ? RideTokens.p800 : RideTokens.n900,
                      ),
                    ),
                    if (parts.isNotEmpty)
                      Text(
                        parts.join(' · '),
                        style: const TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w700,
                          color: RideTokens.n700,
                        ),
                      ),
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

/// Opción INERTE (la unidad actual / en conflicto).
///
/// **Sin opacidad** (MUST de GD): fondo n50 y texto n700/n800 a contraste
/// pleno. Lo que la vuelve inerte es que no tiene radio ni InkWell — y que su
/// motivo está escrito, que es la única forma de que el atenuado no sea el
/// portador de la información.
class _InertOption extends StatelessWidget {
  const _InertOption({required this.label, required this.reason});

  final String label;
  final String reason;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      enabled: false,
      label: label,
      hint: reason,
      child: ExcludeSemantics(
        child: Container(
          constraints: const BoxConstraints(minHeight: 56),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          decoration: BoxDecoration(
            color: RideTokens.n50,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: RideTokens.n200),
          ),
          child: Row(
            children: [
              const Icon(Icons.block_rounded, size: 20, color: RideTokens.n600),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      label,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w800,
                        color: RideTokens.n800,
                      ),
                    ),
                    Text(
                      reason,
                      style: const TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: RideTokens.n700,
                      ),
                    ),
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

/// Negativa del servidor dentro del sheet. Mismo patrón que el banner de
/// ENTRY_GUARD: [cause] traducida arriba, [message] del servidor debajo.
class _SheetNotice extends StatelessWidget {
  const _SheetNotice({required this.message, this.cause});

  final String message;
  final String? cause;

  @override
  Widget build(BuildContext context) {
    final cause_ = cause;
    return Container(
      padding: const EdgeInsets.fromLTRB(11, 10, 11, 10),
      decoration: BoxDecoration(
        color: RideTokens.dangerBg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: RideTokens.dangerBd),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.error_outline_rounded,
              size: 18, color: RideTokens.dangerTx),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (cause_ != null)
                  Text(
                    cause_,
                    style: const TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w900,
                      color: RideTokens.dangerTx,
                    ),
                  ),
                Text(
                  message,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: RideTokens.n800,
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

class _SheetMessage extends StatelessWidget {
  const _SheetMessage({
    required this.message,
    required this.actionLabel,
    required this.onAction,
  });

  final String message;
  final String actionLabel;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 13.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.n700,
            ),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: 200,
            child: RideGhostButton(label: actionLabel, onPressed: onAction),
          ),
        ],
      ),
    );
  }
}
