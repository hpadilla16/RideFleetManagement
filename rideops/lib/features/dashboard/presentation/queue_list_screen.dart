import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/router/app_router.dart';
import '../../../core/theme/ride_tokens.dart';
import '../application/dashboard_controller.dart';
import '../domain/dashboard_queues.dart';
import 'home_skeleton.dart';
import 'widgets/queue_cards.dart';

/// Vista de lista de UNA cola (destino de "Ver todo", del tile "En renta" y
/// de los chips colapsados). Lee del MISMO provider del dashboard — no hay
/// endpoint de paginación en employee-app: el server manda hasta 8 por cola
/// (take:8) y esta vista lo declara en vez de fingir una lista completa.
class QueueListScreen extends ConsumerWidget {
  const QueueListScreen({super.key, required this.queueKey});

  final String queueKey;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final queue = DashboardQueue.tryParse(queueKey);
    final dash = ref.watch(dashboardControllerProvider);

    if (queue == null) {
      // Ruta escrita a mano con una cola inexistente: no hay nada que listar.
      return _Framed(
        title: l10n.tabHome,
        child: Center(child: Text(l10n.genericError)),
      );
    }
    if (dash.firstLoad || dash.data == null) return const HomeSkeleton();

    final data = dash.data!;
    final now = DateTime.now();
    final count = queueCountOf(data.queues, queue);
    final countLabel =
        queueCapped(count) ? l10n.queueCountCapped(count) : '$count';

    // Honestidad del cap: para `active` tenemos el total REAL en las métricas
    // (activeRentals); para el resto solo "los primeros 8".
    String? capNote;
    if (queueCapped(count)) {
      capNote = queue == DashboardQueue.active
          ? l10n.queueListShowingOf(count, data.metrics.activeRentals)
          : l10n.queueListShowingFirst(count);
    }

    return _Framed(
      title: '${queueNameOf(l10n, queue)} · $countLabel',
      child: count == 0
          ? Center(
              child: Text(
                l10n.queueEmptyBody,
                style: const TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                  color: RideTokens.n700,
                ),
              ),
            )
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 96),
              children: [
                if (capNote != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text(
                      capNote,
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        color: RideTokens.n600,
                      ),
                    ),
                  ),
                if (queue == DashboardQueue.issueEscalations)
                  for (final i in data.queues.issueEscalations)
                    IncidentQueueCard(item: i, now: now)
                else
                  for (final r in reservationItemsOf(data.queues, queue))
                    ReservationQueueCard(item: r, queue: queue, now: now),
              ],
            ),
    );
  }
}

/// Header propio dentro del shell (el appbar global no cambia): back de 48 +
/// título de la cola.
class _Framed extends StatelessWidget {
  const _Framed({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 4, 16, 0),
          child: Row(
            children: [
              IconButton(
                iconSize: 22,
                padding: const EdgeInsets.all(13), // 22 + 13*2 = 48 (DoD #2)
                tooltip: MaterialLocalizations.of(context).backButtonTooltip,
                color: RideTokens.n800,
                onPressed: () => context.canPop()
                    ? context.pop()
                    : context.go(AppRoutes.home),
                icon: const Icon(Icons.arrow_back_rounded),
              ),
              const SizedBox(width: 2),
              Expanded(
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w900,
                    color: RideTokens.n900,
                  ),
                ),
              ),
            ],
          ),
        ),
        Expanded(child: child),
      ],
    );
  }
}
