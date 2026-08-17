import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/presentation/change_password_screen.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/auth/presentation/splash_screen.dart';
import '../../features/dashboard/presentation/home_placeholder_screen.dart';
import '../../features/shell/app_shell.dart';
import '../../features/shell/shell_placeholder_screen.dart';
import '../l10n/app_localizations.dart';
import '../session/session_controller.dart';
import '../session/session_state.dart';

/// Rutas nombradas una sola vez — el redirect y las pantallas comparan contra
/// estas constantes, nunca contra strings sueltos.
abstract final class AppRoutes {
  static const splash = '/splash';
  static const login = '/login';
  static const changePassword = '/change-password';
  static const home = '/home';

  // Tabs del shell (H3). Incidentes existe como ruta aunque la nav la
  // esconda por RBAC: esconder no es proteger — el RBAC real lo aplica el
  // backend y la pantalla maneja su 403 (DoD-4).
  static const search = '/search';
  static const incidents = '/incidents';
  static const outbox = '/outbox';
  static const profile = '/profile';
}

/// Superficies del flujo de auth: NUNCA se preservan como destino de retorno
/// (mandar a alguien "de vuelta" a /login tras loguearse sería un loop).
const _authSurfaces = {
  AppRoutes.splash,
  AppRoutes.login,
  AppRoutes.changePassword,
};

/// Redirect top-level (blueprint §3) como FUNCIÓN PURA para testear la tabla
/// de casos sin montar un router.
///
/// Orden de gates: auth → [PIN-lock, HUECO H2] → password-gate → app.
/// Regla anti-loop: devolver null cuando [matchedLocation] ya es el destino
/// del gate activo. Regla de reanudación: el destino original viaja en
/// `?from=` y se restaura al pasar todos los gates.
String? computeAuthRedirect({
  required SessionState session,
  required Uri uri,
  required String matchedLocation,
}) {
  // Destino a preservar: la ruta actual si es "de la app"; si ya estamos en
  // una superficie de auth, arrastrar el `from` que traiga (o nada).
  final from = _authSurfaces.contains(matchedLocation)
      ? uri.queryParameters['from']
      : uri.toString();

  String withFrom(String target) =>
      from == null ? target : '$target?from=${Uri.encodeComponent(from)}';

  switch (session.status) {
    case SessionStatus.restoring:
      return matchedLocation == AppRoutes.splash
          ? null
          : withFrom(AppRoutes.splash);

    case SessionStatus.unauthenticated:
      return matchedLocation == AppRoutes.login
          ? null
          : withFrom(AppRoutes.login);

    case SessionStatus.authenticated:
      // ── HUECO H2 (PIN-lock) ─────────────────────────────────────────────
      // Aquí va el gate de bloqueo por PIN/biometría cuando exista:
      //   if (locked) return matched == AppRoutes.lock ? null : AppRoutes.lock;
      // Va ANTES del password-gate a propósito: un teléfono desbloqueable no
      // debe exponer ni la pantalla de cambio de contraseña.
      // ────────────────────────────────────────────────────────────────────

      if (session.mustChangePassword) {
        return matchedLocation == AppRoutes.changePassword
            ? null
            : withFrom(AppRoutes.changePassword);
      }

      // Gates pasados: sacar al usuario de splash/login hacia su destino.
      // /change-password NO se expulsa: ahí vive el frame de éxito post-gate
      // (mockup 2C) y su botón "Continuar" navega explícitamente.
      if (matchedLocation == AppRoutes.splash ||
          matchedLocation == AppRoutes.login) {
        return from ?? AppRoutes.home;
      }
      return null;
  }
}

/// Puente sesión → router: go_router re-evalúa redirect cuando este
/// Listenable notifica; lo bumpeamos con ref.listen sobre la sesión.
class _SessionRouterBump extends ChangeNotifier {
  _SessionRouterBump(Ref ref) {
    ref.listen<SessionState>(
      sessionControllerProvider,
      (_, _) => notifyListeners(),
    );
  }
}

final appRouterProvider = Provider<GoRouter>((ref) {
  final bump = _SessionRouterBump(ref);
  ref.onDispose(bump.dispose);

  final router = GoRouter(
    initialLocation: AppRoutes.splash,
    refreshListenable: bump,
    redirect: (context, state) => computeAuthRedirect(
      session: ref.read(sessionControllerProvider),
      uri: state.uri,
      matchedLocation: state.matchedLocation,
    ),
    routes: [
      GoRoute(
        path: AppRoutes.splash,
        builder: (context, state) => const SplashScreen(),
      ),
      GoRoute(
        path: AppRoutes.login,
        builder: (context, state) => const LoginScreen(),
      ),
      GoRoute(
        path: AppRoutes.changePassword,
        builder: (context, state) => ChangePasswordScreen(
          resumeTo: state.uri.queryParameters['from'],
        ),
      ),
      // Shell de la app (blueprint §3, H3): appbar con chip de ubicación +
      // tab bar flotante RBAC. Los destinos sin historia todavía montan
      // ShellPlaceholderScreen — cada historia reemplaza el suyo.
      ShellRoute(
        builder: (context, state, child) => AppShell(
          currentPath: state.matchedLocation,
          child: child,
        ),
        routes: [
          GoRoute(
            path: AppRoutes.home,
            builder: (context, state) => const HomePlaceholderScreen(),
          ),
          GoRoute(
            path: AppRoutes.search,
            builder: (context, state) => ShellPlaceholderScreen(
              title: AppLocalizations.of(context)!.tabSearch,
            ),
          ),
          GoRoute(
            path: AppRoutes.incidents,
            builder: (context, state) => ShellPlaceholderScreen(
              title: AppLocalizations.of(context)!.tabIncidents,
            ),
          ),
          GoRoute(
            path: AppRoutes.outbox,
            builder: (context, state) => ShellPlaceholderScreen(
              title: AppLocalizations.of(context)!.tabOutbox,
            ),
          ),
          GoRoute(
            path: AppRoutes.profile,
            builder: (context, state) => ShellPlaceholderScreen(
              title: AppLocalizations.of(context)!.tabProfile,
            ),
          ),
        ],
      ),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});
