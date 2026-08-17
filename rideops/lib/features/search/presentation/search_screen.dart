import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/api/api_providers.dart';
import '../../../core/api/dto/reservation_card.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/session/active_location.dart';
import '../../../core/theme/ride_tokens.dart';
import '../../dashboard/domain/dashboard_queues.dart';
import '../../dashboard/presentation/widgets/queue_cards.dart';
import '../../shell/location_denied_view.dart';

/// Resultados de búsqueda — mismo endpoint del dashboard con `?q=` (take 12
/// en el server). family+autoDispose: cada término es su propia consulta y se
/// suelta al salir. El gate de `hydrated` lo aplica la PANTALLA (no fetchea
/// hasta que la sede activa terminó de hidratar — criterio registrado H4).
final searchResultsProvider = FutureProvider.autoDispose
    .family<List<ReservationCard>, String>((ref, query) async {
  final payload = await ref.watch(dashboardApiProvider).fetch(query: query);
  return payload.searchResults;
  // Sin auto-retry de Riverpod 3: el estado de error se muestra con su botón
  // Reintentar explícito, no un spinner eterno.
}, retry: (retryCount, error) => null);

/// Tab Buscar (H4, alcance mínimo declarado): campo + resultados como cards
/// de cola, estados vacío/cargando/error/403-ubicación. El detalle de reserva
/// y los filtros llegan en M3 — esta pantalla es sobria a propósito.
class SearchScreen extends ConsumerStatefulWidget {
  const SearchScreen({super.key});

  @override
  ConsumerState<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends ConsumerState<SearchScreen> {
  final _controller = TextEditingController();
  Timer? _debounce;
  String _query = '';

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    super.dispose();
  }

  /// Debounce de 350 ms: el patio teclea con guantes — un request por letra
  /// contra un endpoint que arma 13 queries sería castigo gratuito.
  void _onChanged(String raw) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      if (!mounted) return;
      setState(() => _query = raw.trim());
    });
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final location = ref.watch(activeLocationProvider);
    return SafeArea(
      bottom: false,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
            child: TextField(
              controller: _controller,
              onChanged: _onChanged,
              textInputAction: TextInputAction.search,
              style: const TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w600,
                color: RideTokens.n900,
              ),
              decoration: InputDecoration(
                labelText: l10n.searchFieldLabel,
                hintText: l10n.searchFieldHint,
                prefixIcon: const Icon(
                  Icons.search_rounded,
                  color: RideTokens.n600,
                ),
                filled: true,
                fillColor: RideTokens.n0,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 14, // campo ≥48 pt (DoD #2)
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(16),
                  borderSide: const BorderSide(color: RideTokens.n300),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(16),
                  borderSide: const BorderSide(color: RideTokens.n300),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(16),
                  // Foco AZUL del design system — nunca morado sobre morado.
                  borderSide:
                      const BorderSide(color: RideTokens.focus, width: 2),
                ),
              ),
            ),
          ),
          Expanded(
            child: _query.isEmpty
                ? _Message(text: l10n.searchPrompt)
                // Gate de hidratación: sin sede hidratada no se despacha el
                // request (saldría sin header y buscaría en TODAS las sedes).
                : !location.hydrated
                    ? const _Spinner()
                    : _Results(query: _query, pinned: location.isPinned),
          ),
        ],
      ),
    );
  }
}

class _Results extends ConsumerWidget {
  const _Results({required this.query, required this.pinned});

  final String query;

  /// Si la sede estaba pinneada al consultar, la request llevó el header —
  /// parte de la firma del 403 de ubicación.
  final bool pinned;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final results = ref.watch(searchResultsProvider(query));
    final now = DateTime.now();
    return results.when(
      loading: () => const _Spinner(),
      data: (list) => list.isEmpty
          ? _Message(text: l10n.searchNoResults(query))
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 96),
              children: [
                for (final r in list)
                  // La card genérica lee mejor como "salida" (pickup +
                  // pre-checkin) — los resultados son reservas de cualquier
                  // estado y el detalle real llega en M3.
                  ReservationQueueCard(
                    item: r,
                    queue: DashboardQueue.checkout,
                    now: now,
                  ),
              ],
            ),
      error: (e, _) {
        final err = e is ApiError
            ? e
            : ApiError(kind: ApiErrorKind.server, message: '$e');
        if (err.isViewLocationDenied(requestHadHeader: pinned)) {
          return LocationDeniedView(
            locationName: ref.watch(activeLocationProvider).locationName,
            onRetry: () => ref.invalidate(searchResultsProvider(query)),
          );
        }
        return _Message(
          // Mensaje del servidor en 403 de módulo (DoD #5); genérico para el
          // resto — con Reintentar real.
          text: err.kind == ApiErrorKind.forbidden
              ? err.message
              : (err.kind == ApiErrorKind.network
                  ? l10n.errorNoConnectionRetry
                  : l10n.genericError),
          action: TextButton(
            style: TextButton.styleFrom(
              minimumSize: const Size(48, 48),
              foregroundColor: RideTokens.p700,
            ),
            onPressed: () => ref.invalidate(searchResultsProvider(query)),
            child: Text(l10n.retryButton),
          ),
        );
      },
    );
  }
}

class _Spinner extends StatelessWidget {
  const _Spinner();

  @override
  Widget build(BuildContext context) => const Center(
        child: SizedBox(
          width: 24,
          height: 24,
          child: CircularProgressIndicator(
            strokeWidth: 2.5,
            color: RideTokens.p600,
          ),
        ),
      );
}

class _Message extends StatelessWidget {
  const _Message({required this.text, this.action});

  final String text;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 88),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                text,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                  color: RideTokens.n700,
                  height: 1.4,
                ),
              ),
              if (action != null) ...[const SizedBox(height: 8), action!],
            ],
          ),
        ),
      );
}
