import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_providers.dart';
import '../../core/api/dto/staff_location.dart';
import '../../core/l10n/app_localizations.dart';
import '../../core/session/active_location.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/ride_tokens.dart';

/// Sedes para el selector. autoDispose: cada apertura del sheet re-consulta —
/// la lista de sedes de un usuario cambia poco, pero cuando cambia (admin
/// quitó una sede → pantalla 4D → "Cambiar ubicación") servir un caché viejo
/// re-ofrecería justo la sede denegada.
final FutureProvider<List<StaffLocation>> staffLocationsProvider =
    FutureProvider.autoDispose<List<StaffLocation>>(
  (ref) => ref.watch(locationsApiProvider).selectable(),
  // SIN el auto-retry default de Riverpod 3: enmascararía el estado de error
  // del sheet (el usuario vería un spinner eterno en vez de la negativa
  // honesta) y aquí ya hay botón Reintentar explícito.
  retry: (retryCount, error) => null,
);

/// Abre el sheet 4C. Scrim OBLIGATORIO rgba(23,18,43,.42) — nota 7 del
/// mockup: garantiza el foco sobre el sheet.
Future<void> showActiveLocationSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    barrierColor: const Color(0x6B17122B), // 0x6B = alpha .42
    backgroundColor: Colors.transparent,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => const ActiveLocationSheet(),
  );
}

/// Bottom sheet del selector de ubicación (mockup 4C): "Todas mis
/// ubicaciones" + SOLO las sedes visibles del usuario (el backend ya filtra
/// /selectable a `userAllowedLocationIds`; aquí se re-filtra por
/// `user.locationIds` como cinturón — si el contrato del endpoint se
/// ensancha algún día, la UI no ofrece sedes fuera del set).
///
/// Plate del sheet: blanco OPACO .97 (nota 7 pide .92 + blur; la política de
/// blur — nota 4, vinculante — manda default opaco ≥ .95 sin BackdropFilter,
/// así que se sube el alpha y el blur queda como enhancement futuro).
class ActiveLocationSheet extends ConsumerWidget {
  const ActiveLocationSheet({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final active = ref.watch(activeLocationProvider);
    final user = ref.watch(sessionControllerProvider.select((s) => s.user));
    final locations = ref.watch(staffLocationsProvider);

    return Container(
      decoration: const BoxDecoration(
        color: Color(0xF7FFFFFF), // alpha .97 — plate opaco anotado
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
        border: Border(top: BorderSide(color: RideTokens.n200)),
      ),
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 20),
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
            l10n.locationSheetTitle,
            style: const TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w900,
              color: RideTokens.n900,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            l10n.locationSheetSubtitle,
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w600,
              color: RideTokens.n600,
            ),
          ),
          const SizedBox(height: 10),
          // "Todas mis ubicaciones" SIEMPRE presente (null = sin override).
          _LocationOption(
            label: l10n.locationAllMine,
            selected: !active.isPinned,
            onTap: () => _select(context, ref, null, null),
          ),
          locations.when(
            data: (list) {
              final allowed = user?.locationIds;
              final visible = (allowed == null || allowed.isEmpty)
                  ? list
                  : list.where((loc) => allowed.contains(loc.id)).toList();
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final loc in visible)
                    _LocationOption(
                      label: loc.name,
                      sublabel: loc.id == active.locationId
                          ? l10n.locationCurrentLabel
                          : null,
                      selected: loc.id == active.locationId,
                      onTap: () => _select(context, ref, loc.id, loc.name),
                    ),
                ],
              );
            },
            loading: () => const Padding(
              padding: EdgeInsets.symmetric(vertical: 20),
              child: Center(
                child: SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(strokeWidth: 2.5),
                ),
              ),
            ),
            // Error REAL manejado (DoD #5): sin red o 4xx, el sheet lo dice y
            // ofrece reintentar — nunca una lista vacía muda.
            error: (_, _) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Column(
                children: [
                  Text(
                    l10n.locationSheetError,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: RideTokens.dangerTx,
                    ),
                  ),
                  TextButton(
                    style: TextButton.styleFrom(
                      minimumSize: const Size(48, 48),
                      foregroundColor: RideTokens.p700,
                    ),
                    onPressed: () => ref.invalidate(staffLocationsProvider),
                    child: Text(l10n.retryButton),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 4),
          TextButton(
            style: TextButton.styleFrom(
              minimumSize: const Size(48, 48),
              foregroundColor: RideTokens.n700,
            ),
            onPressed: () => Navigator.of(context).pop(),
            child: Text(l10n.cancelButton),
          ),
        ],
      ),
    );
  }

  void _select(
    BuildContext context,
    WidgetRef ref,
    String? locationId,
    String? locationName,
  ) {
    // set() persiste y loguea session.view_location_set; el REFRESH de datos
    // ocurre porque los providers scoped (dashboard H4+) observan
    // activeLocationProvider y se invalidan con el cambio.
    ref
        .read(activeLocationProvider.notifier)
        .set(locationId: locationId, locationName: locationName);
    Navigator.of(context).pop();
  }
}

/// Opción de 56 px (mockup 4C) con radio — target táctil > 48 (DoD #2).
class _LocationOption extends StatelessWidget {
  const _LocationOption({
    required this.label,
    this.sublabel,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final String? sublabel;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      child: ExcludeSemantics(
        child: Material(
          color: selected ? RideTokens.tonal : Colors.transparent,
          borderRadius: BorderRadius.circular(16),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(16),
            child: Container(
              height: 56,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: [
                  Container(
                    width: 20,
                    height: 20,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: selected ? RideTokens.p600 : RideTokens.n400,
                        width: selected ? 6 : 2,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 14.5,
                            fontWeight: FontWeight.w700,
                            color: RideTokens.n800,
                          ),
                        ),
                        if (sublabel != null)
                          Text(
                            sublabel!,
                            style: const TextStyle(
                              fontSize: 11.5,
                              fontWeight: FontWeight.w600,
                              color: RideTokens.n600,
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
