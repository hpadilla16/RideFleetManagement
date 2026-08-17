import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/api/api_error.dart';
import '../../../core/api/dto/dashboard.dart';
import '../../../core/api/dto/session_user.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/router/app_router.dart';
import '../../../core/session/active_location.dart';
import '../../../core/session/session_controller.dart';
import '../../../core/theme/ride_tokens.dart';
import '../../shell/location_denied_view.dart';
import '../application/dashboard_controller.dart';
import '../domain/dashboard_queues.dart';
import 'home_skeleton.dart';
import 'widgets/queue_cards.dart';

/// Edad corta del dato para la fila de frescura y los banners.
String ageLabelOf(AppLocalizations l10n, Duration age) {
  if (age.inMinutes < 1) return l10n.ageMoment;
  if (age.inHours < 1) return l10n.ageMinutes(age.inMinutes);
  return l10n.ageHours(age.inHours);
}

/// Home de operaciones (H4, mockup 5A–5E): las 9 colas del dashboard
/// organizadas para patio — arriba lo accionable AHORA, abajo lo que respira,
/// colapsado lo vacío. El Scaffold exterior lo pone el shell; aquí solo body.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(sessionControllerProvider.select((s) => s.user));
    // Sesión degradada (token vivo, /me caído por red): skeleton 4E — el
    // re-intento corre al reanudar la app (AppShell).
    if (user == null) return const HomeSkeleton();

    final dash = ref.watch(dashboardControllerProvider);
    if (dash.firstLoad) return const HomeSkeleton(); // 5C: solo primer load

    void retry() =>
        ref.read(dashboardControllerProvider.notifier).refresh();

    // 403 de ubicación (pantalla 4D): SOLO con la firma completa — un 403 de
    // módulo cae al error genérico con el mensaje del servidor (NIT QA-H3).
    if (dash.viewLocationDenied) {
      return LocationDeniedView(
        locationName: ref.watch(activeLocationProvider).locationName,
        onRetry: retry,
      );
    }

    final data = dash.data;
    if (data == null) {
      return _HomeErrorView(error: dash.error!, onRetry: retry);
    }

    return RefreshIndicator(
      color: RideTokens.p600,
      onRefresh: () => ref.read(dashboardControllerProvider.notifier).refresh(),
      child: _HomeContent(user: user, state: dash, data: data, onRetry: retry),
    );
  }
}

class _HomeContent extends ConsumerWidget {
  const _HomeContent({
    required this.user,
    required this.state,
    required this.data,
    required this.onRetry,
  });

  final SessionUser user;
  final DashboardState state;
  final DashboardPayload data;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final now = DateTime.now();
    final sections = visibleSectionsFor(user);
    final activeVisible = queueInProgram(DashboardQueue.active, user);

    final withItems = [
      for (final q in sections)
        if (queueCountOf(data.queues, q) > 0) q,
    ];
    final emptyQueues = [
      for (final q in sections)
        if (queueCountOf(data.queues, q) == 0) q,
    ];
    // Todo-vacío = estado feliz (5D), nunca tono de error: incluye En renta,
    // cuyo camino en este estado es su chip (el bento no se pinta).
    final allEmpty = withItems.isEmpty &&
        (!activeVisible || data.queues.active.isEmpty);

    final children = <Widget>[
      if (state.error != null)
        _StaleBanner(
          error: state.error!,
          age: ageLabelOf(
            l10n,
            state.fetchedAt == null
                ? Duration.zero
                : now.difference(state.fetchedAt!),
          ),
          onRetry: onRetry,
        )
      else
        _FreshnessLine(fetchedAt: state.fetchedAt, now: now),
      if (allEmpty)
        _EmptyAllView(
          queues: [...sections, if (activeVisible) DashboardQueue.active],
        )
      else ...[
        _Bento(user: user, data: data, state: state, now: now),
        for (final q in withItems)
          _QueueSection(queue: q, data: data, now: now),
        if (emptyQueues.isNotEmpty) _CalmRow(queues: emptyQueues),
      ],
    ];

    return ListView(
      // AlwaysScrollable: el pull-to-refresh debe funcionar aunque el
      // contenido no llene la pantalla (5D pide "desliza para actualizar").
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 96),
      children: children,
    );
  }
}

/// "Actualizado hace X min · se actualiza solo" — frescura honesta SIEMPRE
/// visible (nota 1). El dot hace un TICK (un pulso corto) cada vez que llega
/// dato nuevo, en lugar del latido perpetuo ≤0.5 Hz que dibuja el mockup:
/// **enmienda aceptada por GD para M1 (review H4, S-4)** — un latido infinito
/// obliga un frame por ciclo para siempre (batería en patio de gama media) y
/// el tick cumple la misma nota de motion ("al terminar, la fila hace tick a
/// 'ahora'"). El PM registra la enmienda en el mockup. Con reduced-motion el
/// tick se omite.
class _FreshnessLine extends StatefulWidget {
  const _FreshnessLine({required this.fetchedAt, required this.now});

  final DateTime? fetchedAt;
  final DateTime now;

  @override
  State<_FreshnessLine> createState() => _FreshnessLineState();
}

class _FreshnessLineState extends State<_FreshnessLine>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 700),
  );

  /// 1 → 0.35 → 1 en un solo forward: un tick, no un loop.
  late final Animation<double> _opacity = TweenSequence<double>([
    TweenSequenceItem(tween: Tween(begin: 1, end: 0.35), weight: 1),
    TweenSequenceItem(tween: Tween(begin: 0.35, end: 1), weight: 1),
  ]).animate(_pulse);

  @override
  void didUpdateWidget(covariant _FreshnessLine old) {
    super.didUpdateWidget(old);
    if (widget.fetchedAt != old.fetchedAt &&
        !MediaQuery.of(context).disableAnimations) {
      _pulse.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final age = widget.fetchedAt == null
        ? Duration.zero
        : widget.now.difference(widget.fetchedAt!);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        children: [
          FadeTransition(
            opacity: _opacity,
            child: Container(
              width: 7,
              height: 7,
              decoration: const BoxDecoration(
                color: RideTokens.ok,
                shape: BoxShape.circle,
              ),
            ),
          ),
          const SizedBox(width: 7),
          Text(
            l10n.homeFreshnessLine(ageLabelOf(l10n, age)),
            style: const TextStyle(
              fontSize: 12,
              // n700 y no n600: 8.5:1 sobre n50 — margen al sol (contraste
              // verificado del mockup).
              fontWeight: FontWeight.w700,
              color: RideTokens.n700,
            ),
          ),
        ],
      ),
    );
  }
}

/// Banner de dato viejo (5E): offline honesto — edad real + Reintentar. Los
/// datos cacheados SIGUEN abajo, no se borran. Para errores no-red con cache,
/// mismo banner con copy genérico.
class _StaleBanner extends StatelessWidget {
  const _StaleBanner({
    required this.error,
    required this.age,
    required this.onRetry,
  });

  final ApiError error;
  final String age;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final offline = error.kind == ApiErrorKind.network;
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.fromLTRB(12, 10, 6, 10),
      decoration: BoxDecoration(
        color: RideTokens.warnBg,
        border: Border.all(color: RideTokens.warnBd),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          const Icon(
            Icons.wifi_off_rounded,
            size: 18,
            color: RideTokens.warnTx,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              offline ? l10n.homeOfflineBanner(age) : l10n.homeStaleBanner(age),
              style: const TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: RideTokens.warnTx,
                height: 1.35,
              ),
            ),
          ),
          TextButton(
            style: TextButton.styleFrom(
              minimumSize: const Size(48, 48), // target DoD #2
              foregroundColor: RideTokens.warnTx,
              textStyle: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w800,
              ),
            ),
            onPressed: onRetry,
            child: Text(l10n.retryButton),
          ),
        ],
      ),
    );
  }
}

/// Bento re-jerarquizado a "Para ahora" (nota 2): hero derivado SOLO de
/// métricas reales + items visibles de hoy; tiles satélite En renta (tappable
/// → lista de la cola `active`) y loaner — o pre-checkin en RENTAL_ONLY.
class _Bento extends StatelessWidget {
  const _Bento({
    required this.user,
    required this.data,
    required this.state,
    required this.now,
  });

  final SessionUser user;
  final DashboardPayload data;
  final DashboardState state;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final hero = deriveHero(data, now);

    final heroParts = <String>[
      if (hero.departuresToday > 0)
        hero.departuresCapped
            ? l10n.heroPartDeparturesCapped(hero.departuresToday)
            : l10n.heroPartDepartures(hero.departuresToday),
      if (hero.dueBackToday > 0) l10n.heroPartReturns(hero.dueBackToday),
      if (hero.issueOpen > 0) l10n.heroPartIncidents(hero.issueOpen),
    ];
    // Offline (5E): el pie del hero declara el CORTE del dato, no un desglose
    // que suena a "ahora".
    final heroFoot = state.error != null && state.fetchedAt != null
        ? l10n.heroCutoffFoot(
            DateFormat.jm(locale).format(state.fetchedAt!.toLocal()),
          )
        : (heroParts.isEmpty ? l10n.heroCalmFoot : heroParts.join(' · '));

    final loanerInProgram =
        queueInProgram(DashboardQueue.loanerReady, user);
    final followupCount = data.queues.loanerAdvisorFollowup.length;

    return SizedBox(
      height: 150,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: _HeroTile(
              value: hero.capped
                  ? l10n.queueCountCapped(hero.total)
                  : '${hero.total}',
              foot: heroFoot,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              children: [
                Expanded(
                  child: _SatelliteTile(
                    title: l10n.tileActiveTitle,
                    value: '${data.metrics.activeRentals}',
                    foot: l10n.tileActiveFoot(data.metrics.dueBackToday),
                    warn: false,
                    semanticsLabel:
                        l10n.tileActiveSemantics(data.metrics.activeRentals),
                    // El tile ES la ruta de la cola `active` (nota 2) — todo
                    // el tile tappable, ≥48 pt.
                    onTap: () => context.push(
                      AppRoutes.queueList(DashboardQueue.active.name),
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                Expanded(
                  child: loanerInProgram
                      ? _SatelliteTile(
                          title: l10n.tileLoanerTitle,
                          value: '${data.metrics.loanerOpen}',
                          foot: queueCapped(followupCount)
                              ? l10n.tileLoanerFootCapped(followupCount)
                              : l10n.tileLoanerFoot(followupCount),
                          warn: data.metrics.loanerOverdue > 0 ||
                              data.metrics.loanerBillingAttention > 0,
                        )
                      // RENTAL_ONLY (5B): el tile loaner NO existe — su lugar
                      // lo toma pre-checkin, que sí es de su programa.
                      : _SatelliteTile(
                          title: l10n.tilePrecheckinTitle,
                          value: '${data.metrics.precheckinQueue}',
                          foot: l10n.tilePrecheckinFoot,
                          warn: false,
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

class _HeroTile extends StatelessWidget {
  const _HeroTile({required this.value, required this.foot});

  final String value;
  final String foot;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        // Peor parada del gradiente del mockup: blanco 6.57:1 — verificado.
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [RideTokens.p600, RideTokens.p800],
        ),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            l10n.heroTitle,
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w800,
              color: Colors.white,
            ),
          ),
          const Spacer(),
          Text(
            value,
            style: const TextStyle(
              fontSize: 40,
              height: 1,
              fontWeight: FontWeight.w900,
              color: Colors.white,
              letterSpacing: -1,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            foot,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w700,
              // Blanco al 92% sobre p800: ≥5.5:1 (par del mockup).
              color: Color(0xEBFFFFFF),
            ),
          ),
        ],
      ),
    );
  }
}

class _SatelliteTile extends StatelessWidget {
  const _SatelliteTile({
    required this.title,
    required this.value,
    required this.foot,
    required this.warn,
    this.onTap,
    this.semanticsLabel,
  });

  final String title;
  final String value;
  final String foot;
  final bool warn;
  final VoidCallback? onTap;
  final String? semanticsLabel;

  @override
  Widget build(BuildContext context) {
    // height explícito en los tres textos: el bento reparte 70 px por tile y
    // el line-height 1.43 del theme M3 desbordaría la Column.
    final tile = Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: RideTokens.n0,
        border: Border.all(color: RideTokens.n200),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontSize: 11.5,
              height: 1.15,
              fontWeight: FontWeight.w800,
              color: RideTokens.n600,
            ),
          ),
          Text(
            value,
            style: TextStyle(
              fontSize: 21,
              height: 1.1,
              fontWeight: FontWeight.w900,
              color: warn ? RideTokens.warnTx : RideTokens.n900,
            ),
          ),
          Text(
            foot,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 10.5,
              height: 1.15,
              fontWeight: FontWeight.w700,
              color: RideTokens.n700,
            ),
          ),
        ],
      ),
    );
    if (onTap == null) return tile;
    // GD MC-1 (patrón del review H3): la acción va TAMBIÉN en Semantics.
    return Semantics(
      button: true,
      label: semanticsLabel,
      onTap: onTap,
      child: ExcludeSemantics(
        child: Material(
          color: Colors.transparent,
          borderRadius: BorderRadius.circular(20),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(20),
            child: tile,
          ),
        ),
      ),
    );
  }
}

/// Sección de cola con actividad: header (nombre + contador honesto +
/// Ver todo) y las cards en el orden del backend.
class _QueueSection extends StatelessWidget {
  const _QueueSection({
    required this.queue,
    required this.data,
    required this.now,
  });

  final DashboardQueue queue;
  final DashboardPayload data;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final count = queueCountOf(data.queues, queue);
    final countLabel =
        queueCapped(count) ? l10n.queueCountCapped(count) : '$count';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 14, bottom: 6),
          child: Row(
            children: [
              Text(
                queueNameOf(l10n, queue),
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w900,
                  color: RideTokens.n800,
                ),
              ),
              const SizedBox(width: 7),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
                decoration: BoxDecoration(
                  color: RideTokens.p100,
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Text(
                  countLabel,
                  style: const TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w900,
                    color: RideTokens.p800,
                  ),
                ),
              ),
              const Spacer(),
              TextButton(
                style: TextButton.styleFrom(
                  minimumSize: const Size(48, 48),
                  foregroundColor: RideTokens.p700,
                  textStyle: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                onPressed: () =>
                    context.push(AppRoutes.queueList(queue.name)),
                child: Text(l10n.seeAllButton),
              ),
            ],
          ),
        ),
        // Key por id (nota 1 del mockup: diff por id — el polling no debe
        // recrear cards que no cambiaron ni mover el scroll).
        if (queue == DashboardQueue.issueEscalations)
          for (final i in data.queues.issueEscalations)
            IncidentQueueCard(key: ValueKey(i.id), item: i, now: now)
        else
          for (final r in reservationItemsOf(data.queues, queue))
            ReservationQueueCard(
              key: ValueKey(r.id),
              item: r,
              queue: queue,
              now: now,
            ),
      ],
    );
  }
}

/// Colapso de colas vacías (nota 3): UNA fila punteada al final con chips
/// "cola · 0" tocables (target 48 con hit-slop) — jamás 9 secciones de
/// "no hay nada".
class _CalmRow extends StatelessWidget {
  const _CalmRow({required this.queues});

  final List<DashboardQueue> queues;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Container(
      margin: const EdgeInsets.only(top: 16),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        border: Border.all(color: RideTokens.n300),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            l10n.calmRowTitle,
            style: const TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w800,
              color: RideTokens.n600,
            ),
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final q in queues) _CalmChip(queue: q),
            ],
          ),
        ],
      ),
    );
  }
}

class _CalmChip extends ConsumerWidget {
  const _CalmChip({required this.queue});

  final DashboardQueue queue;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final name = queueNameOf(l10n, queue);
    void open() => context.push(AppRoutes.queueList(queue.name));
    return Semantics(
      button: true,
      label: l10n.calmChipSemantics(name),
      onTap: open,
      child: ExcludeSemantics(
        // Hit-slop: 48 de alto táctil con el chip visual de 32 centrado.
        child: SizedBox(
          height: 48,
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: open,
              borderRadius: BorderRadius.circular(11),
              child: Center(
                child: Container(
                  height: 32,
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  decoration: BoxDecoration(
                    color: RideTokens.n0,
                    border: Border.all(color: RideTokens.n200),
                    borderRadius: BorderRadius.circular(11),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        name,
                        style: const TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w700,
                          color: RideTokens.n700,
                        ),
                      ),
                      const SizedBox(width: 5),
                      // Contador decorativo (n400 no pasa AA a propósito):
                      // el número accesible vive en el label de Semantics.
                      const Text(
                        '0',
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w800,
                          color: RideTokens.n400,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Todo-vacío = estado feliz (5D): check verde + chips que confirman que las
/// colas SÍ se consultaron y están en cero (distinción explícita frente a un
/// fallo de red).
class _EmptyAllView extends StatelessWidget {
  const _EmptyAllView({required this.queues});

  final List<DashboardQueue> queues;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Column(
      children: [
        const SizedBox(height: 48),
        Container(
          width: 64,
          height: 64,
          decoration: BoxDecoration(
            color: RideTokens.okBg,
            shape: BoxShape.circle,
            border: Border.all(color: RideTokens.okBd),
          ),
          child: const Icon(
            Icons.check_rounded,
            size: 30,
            color: RideTokens.okTx,
          ),
        ),
        const SizedBox(height: 14),
        Text(
          l10n.emptyAllTitle,
          style: const TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w900,
            color: RideTokens.n900,
          ),
        ),
        const SizedBox(height: 6),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Text(
            l10n.emptyAllBody,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 13.5,
              fontWeight: FontWeight.w600,
              color: RideTokens.n700,
              height: 1.4,
            ),
          ),
        ),
        const SizedBox(height: 28),
        Align(
          alignment: Alignment.centerLeft,
          child: Container(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
            decoration: BoxDecoration(
              border: Border.all(color: RideTokens.n300),
              borderRadius: BorderRadius.circular(18),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  l10n.emptyAllQueuesLabel(queues.length),
                  style: const TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w800,
                    color: RideTokens.n600,
                  ),
                ),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final q in queues) _CalmChip(queue: q),
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// Error SIN cache: pantalla completa con el mensaje del servidor cuando lo
/// hay (DoD #5 — un 403 de módulo se muestra como negativa con su copy, un
/// 429 con su espera, la red con su reintento).
class _HomeErrorView extends StatelessWidget {
  const _HomeErrorView({required this.error, required this.onRetry});

  final ApiError error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final forbidden = error.kind == ApiErrorKind.forbidden;
    final title = forbidden ? l10n.forbiddenTitle : l10n.homeErrorTitle;
    final body = switch (error.kind) {
      // 403 de módulo: el backend escribe mensajes legibles
      // (moduleDeniedMessage) — se muestran tal cual, no se inventan.
      ApiErrorKind.forbidden => error.message,
      ApiErrorKind.rateLimited => l10n.errorRateLimited,
      ApiErrorKind.network => l10n.errorNoConnectionRetry,
      _ => l10n.genericError,
    };
    return Center(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 88),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 64,
              height: 64,
              decoration: BoxDecoration(
                color: forbidden ? RideTokens.dangerBg : RideTokens.warnBg,
                shape: BoxShape.circle,
                border: Border.all(
                  color: forbidden ? RideTokens.dangerBd : RideTokens.warnBd,
                ),
              ),
              child: Icon(
                forbidden ? Icons.block_rounded : Icons.cloud_off_rounded,
                size: 28,
                color: forbidden ? RideTokens.dangerTx : RideTokens.warnTx,
              ),
            ),
            const SizedBox(height: 14),
            Text(
              title,
              style: const TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w900,
                color: RideTokens.n900,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              body,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
                color: RideTokens.n700,
                height: 1.4,
              ),
            ),
            const SizedBox(height: 16),
            TextButton(
              style: TextButton.styleFrom(
                minimumSize: const Size(48, 48),
                foregroundColor: RideTokens.p700,
                textStyle: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w800,
                ),
              ),
              onPressed: onRetry,
              child: Text(l10n.retryButton),
            ),
          ],
        ),
      ),
    );
  }
}
