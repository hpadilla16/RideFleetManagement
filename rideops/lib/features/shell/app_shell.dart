import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/db/outbox_providers.dart';
import '../../core/l10n/app_localizations.dart';
import '../../core/session/active_location.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/ride_tokens.dart';
import 'location_sheet.dart';
import 'shell_tabs.dart';

/// Shell de la app (blueprint §3, mockup 4A/4B): appbar con chip de ubicación
/// SIEMPRE visible + tab bar flotante tipo pill, con tabs derivadas de
/// role/moduleAccess ([tabsFor]).
///
/// Política de blur (nota 4 del mockup, VINCULANTE): default = plates opacos
/// ≥ .95 SIN BackdropFilter — el blur es progressive enhancement pendiente de
/// una señal real de capacidad del dispositivo (gama media + blur = jank).
/// Por eso ni el appbar (plate .96) ni la tab bar (plate .96) usan
/// BackdropFilter hoy; cuando exista la señal, el ÚNICO candidato de esta
/// pantalla es la tab bar (máx 1 BackdropFilter por pantalla).
///
/// Renderiza también con sesión DEGRADADA (`user == null`): tabs mínimas de
/// AGENT y las pantallas muestran su skeleton (4E). Al REANUDAR la app se
/// re-intenta /me ([SessionController.rehydrateUserIfMissing]) — un turno
/// entero sin señal no debe dejar el shell mudo para siempre.
class AppShell extends ConsumerStatefulWidget {
  const AppShell({super.key, required this.currentPath, required this.child});

  /// matchedLocation del router — decide la tab activa sin adivinar desde
  /// contexto heredado.
  final String currentPath;
  final Widget child;

  @override
  ConsumerState<AppShell> createState() => _AppShellState();
}

class _AppShellState extends ConsumerState<AppShell> {
  late final AppLifecycleListener _lifecycle;

  @override
  void initState() {
    super.initState();
    // Contrato de sesión degradada: re-intento de /me al volver a primer
    // plano. Vive en el shell (no en app.dart) porque solo aplica con sesión
    // — y así H2 (que toca app/router) no choca con este archivo.
    _lifecycle = AppLifecycleListener(
      onResume: () => ref
          .read(sessionControllerProvider.notifier)
          .rehydrateUserIfMissing(),
    );
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final user =
        ref.watch(sessionControllerProvider.select((s) => s.user));
    final tabs = tabsFor(user);
    return Scaffold(
      backgroundColor: RideTokens.n50,
      appBar: const _ShellAppBar(),
      // La tab bar flota sobre el contenido (mockup 4A); las pantallas
      // scrolleables deben dejar ~88 px de padding inferior.
      extendBody: true,
      body: widget.child,
      bottomNavigationBar: _FloatingTabBar(
        tabs: tabs,
        currentPath: widget.currentPath,
      ),
    );
  }
}

/// Appbar del shell: brand + chip de ubicación + avatar. Plate OPACO .96
/// compuesto sobre blanco (sin blur — nota 4 del mockup: el appbar no es
/// candidato a BackdropFilter).
class _ShellAppBar extends ConsumerWidget implements PreferredSizeWidget {
  const _ShellAppBar();

  @override
  Size get preferredSize => const Size.fromHeight(60);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final user = ref.watch(sessionControllerProvider.select((s) => s.user));
    return Container(
      decoration: const BoxDecoration(
        // 0xF5 = alpha .96 — plate opaco anotado (política de blur).
        color: Color(0xF5FFFFFF),
        border: Border(bottom: BorderSide(color: RideTokens.n200)),
      ),
      child: SafeArea(
        bottom: false,
        child: SizedBox(
          height: 60,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                Text(
                  l10n.appTitle,
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w900,
                    color: RideTokens.n900,
                    letterSpacing: -0.3,
                  ),
                ),
                const SizedBox(width: 12),
                const _LocationChip(),
                const Spacer(),
                // Avatar decorativo (iniciales); el Perfil real vive en su
                // tab — sin acción aquí todavía, fuera del árbol semántico.
                ExcludeSemantics(
                  child: CircleAvatar(
                    radius: 16,
                    backgroundColor: RideTokens.p100,
                    child: Text(
                      _initials(user?.fullName, user?.email),
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w800,
                        color: RideTokens.p700,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  static String _initials(String? fullName, String? email) {
    final source = (fullName?.trim().isNotEmpty ?? false)
        ? fullName!.trim()
        : (email ?? '');
    if (source.isEmpty) return '·';
    final parts =
        source.split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return source.substring(0, 1).toUpperCase();
  }
}

/// Chip de ubicación activa — SIEMPRE visible (nota 1 del mockup): visual de
/// 44 px dentro de un área táctil de 48 (hit-slop anotado, DoD #2). Abre el
/// sheet 4C. Pinta el nombre persistido — funciona offline sin esperar a
/// /api/locations/selectable.
class _LocationChip extends ConsumerWidget {
  const _LocationChip();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final active = ref.watch(activeLocationProvider);
    final label = active.locationName ?? l10n.locationChipAll;
    // GD MC-1 (review H3): la acción de tap TAMBIÉN va en el nodo Semantics —
    // con ExcludeSemantics debajo, el InkWell pierde su acción y TalkBack
    // anunciaría "botón" sin que el doble-tap hiciera nada.
    return Semantics(
      button: true,
      label: l10n.locationChipSemantics(label),
      onTap: () => showActiveLocationSheet(context),
      child: ExcludeSemantics(
        // Área táctil 48 px (hit-slop): el InkWell cubre el SizedBox de 48;
        // el chip visual de 44 vive centrado adentro.
        child: SizedBox(
          height: 48,
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: () => showActiveLocationSheet(context),
              borderRadius: BorderRadius.circular(14),
              child: Center(
                child: Container(
                  height: 44,
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  decoration: BoxDecoration(
                    color: RideTokens.p50,
                    // Silueta aprobada del mockup (GD SHOULD H3): radio 14,
                    // no píldora, con borde de marca al 20 %.
                    border: Border.all(color: RideTokens.brandA20),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Flexible(
                        child: Text(
                          label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w800,
                            color: RideTokens.p800,
                          ),
                        ),
                      ),
                      const SizedBox(width: 4),
                      const Icon(
                        Icons.keyboard_arrow_down_rounded,
                        size: 18,
                        color: RideTokens.p800,
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

/// Tab bar flotante tipo pill (mockup 4A, nota 4). Plate opaco .96 con doble
/// elevación borde+sombra (regla del sistema: nunca sombra sola). SIN
/// BackdropFilter por la política de blur — ver doc de [AppShell].
class _FloatingTabBar extends ConsumerWidget {
  const _FloatingTabBar({required this.tabs, required this.currentPath});

  final List<ShellTab> tabs;
  final String currentPath;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SafeArea(
      minimum: const EdgeInsets.fromLTRB(16, 0, 16, 10),
      child: Container(
        height: 64,
        padding: const EdgeInsets.all(6),
        decoration: BoxDecoration(
          // 0xF5 = alpha .96 ≥ .95 — fallback opaco anotado (nota 4).
          color: const Color(0xF5FFFFFF),
          borderRadius: BorderRadius.circular(32),
          border: Border.all(color: RideTokens.n200),
          boxShadow: const [
            BoxShadow(
              color: Color(0x2417122B),
              blurRadius: 24,
              offset: Offset(0, 10),
            ),
          ],
        ),
        child: Row(
          children: [
            for (final tab in tabs)
              Expanded(
                child: _TabItem(
                  tab: tab,
                  active: currentPath == tab.route ||
                      currentPath.startsWith('${tab.route}/'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _TabItem extends ConsumerWidget {
  const _TabItem({required this.tab, required this.active});

  final ShellTab tab;
  final bool active;

  static const _icons = <ShellTab, IconData>{
    ShellTab.home: Icons.home_outlined,
    ShellTab.search: Icons.search_rounded,
    ShellTab.incidents: Icons.warning_amber_rounded,
    ShellTab.outbox: Icons.outbox_outlined,
    ShellTab.profile: Icons.person_outline_rounded,
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final label = switch (tab) {
      ShellTab.home => l10n.tabHome,
      ShellTab.search => l10n.tabSearch,
      ShellTab.incidents => l10n.tabIncidents,
      ShellTab.outbox => l10n.tabOutbox,
      ShellTab.profile => l10n.tabProfile,
    };
    // Badge de Bandeja: cuenta de filas 'pending' del outbox. Hoy la DB abre
    // en H5 — el provider corto devuelve 0 y el badge no se pinta.
    final pending = tab == ShellTab.outbox
        ? (ref.watch(outboxPendingCountProvider).value ?? 0)
        : 0;
    // GD MC-1: onTap en Semantics — ver _LocationChip.
    return Semantics(
      button: true,
      selected: active,
      label: pending > 0 ? '$label. ${l10n.outboxBadgeSemantics(pending)}' : label,
      onTap: () => context.go(tab.route),
      child: ExcludeSemantics(
        child: Material(
          color: active ? RideTokens.p100 : Colors.transparent,
          borderRadius: BorderRadius.circular(26),
          child: InkWell(
            onTap: () => context.go(tab.route),
            borderRadius: BorderRadius.circular(26),
            // Pill de 52 px de alto dentro de la barra de 64 — target ≥ 48
            // (DoD #2).
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Stack(
                  clipBehavior: Clip.none,
                  children: [
                    Icon(
                      _icons[tab],
                      size: 20,
                      color: active ? RideTokens.p800 : RideTokens.n700,
                    ),
                    if (pending > 0)
                      Positioned(
                        top: -4,
                        right: -8,
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 4,
                            vertical: 1,
                          ),
                          decoration: BoxDecoration(
                            // GD MC-2: el badge es contador de trabajo
                            // PENDIENTE — rojo danger (blanco ≈6.3:1), no
                            // morado de marca.
                            color: RideTokens.danger,
                            borderRadius: BorderRadius.circular(8),
                          ),
                          constraints: const BoxConstraints(minWidth: 14),
                          child: Text(
                            '$pending',
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              fontSize: 9,
                              fontWeight: FontWeight.w800,
                              color: Colors.white,
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: active ? FontWeight.w800 : FontWeight.w600,
                    color: active ? RideTokens.p800 : RideTokens.n700,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
