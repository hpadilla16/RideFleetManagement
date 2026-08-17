import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/presentation/change_password_screen.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/auth/presentation/pin_lock_screen.dart';
import '../../features/auth/presentation/pin_setup_screen.dart';
import '../../features/auth/presentation/splash_screen.dart';
import '../../features/dashboard/presentation/home_screen.dart';
import '../../features/dashboard/presentation/queue_list_screen.dart';
import '../../features/inspection/presentation/inspection_screen.dart';
import '../../features/outbox/presentation/outbox_screen.dart';
import '../../features/search/presentation/search_screen.dart';
import '../../features/shell/app_shell.dart';
import '../../features/shell/shell_placeholder_screen.dart';
import '../l10n/app_localizations.dart';
import '../session/lock_controller.dart';
import '../session/lock_state.dart';
import '../session/session_controller.dart';
import '../session/session_state.dart';

/// Rutas nombradas una sola vez — el redirect y las pantallas comparan contra
/// estas constantes, nunca contra strings sueltos.
abstract final class AppRoutes {
  static const splash = '/splash';
  static const login = '/login';
  static const changePassword = '/change-password';
  static const lock = '/lock';
  static const pinSetup = '/pin-setup';
  static const home = '/home';

  // Tabs del shell (H3). Incidentes existe como ruta aunque la nav la
  // esconda por RBAC: esconder no es proteger — el RBAC real lo aplica el
  // backend y la pantalla maneja su 403 (DoD-4).
  static const search = '/search';
  static const incidents = '/incidents';
  static const outbox = '/outbox';
  static const profile = '/profile';

  /// Vista de lista de una cola del dashboard (H4): destino de "Ver todo",
  /// del tile "En renta" y de los chips colapsados. [key] es el name del
  /// enum DashboardQueue (= llave del JSON del payload).
  static String queueList(String key) => '$home/queue/$key';

  // Flujo de inspección (H5): pantalla completa FUERA del shell — sin tabs
  // ni chip de sede (el header propio del flujo manda; el paso de firma es
  // superficie del cliente). La entrada desde las cards del home es H6:
  // la card de la cola de salidas gana su CTA hacia esta ruta.
  static const inspectionPattern = '/inspection/:reservationId';
  static String inspection(String reservationId) =>
      '/inspection/$reservationId';
}

/// Superficies del flujo de auth: NUNCA se preservan como destino de retorno
/// (mandar a alguien "de vuelta" a /login tras loguearse sería un loop).
const _authSurfaces = {
  AppRoutes.splash,
  AppRoutes.login,
  AppRoutes.changePassword,
  AppRoutes.lock,
  AppRoutes.pinSetup,
};

/// Redirect top-level (blueprint §3) como FUNCIÓN PURA para testear la tabla
/// de casos sin montar un router.
///
/// Orden de gates (Innovation H1): auth → PIN-lock → password-gate →
/// PIN-setup → app. Regla anti-loop: devolver null cuando [matchedLocation]
/// ya es el destino del gate activo. Regla de reanudación: el destino
/// original viaja en `?from=` y se restaura al pasar todos los gates.
String? computeAuthRedirect({
  required SessionState session,
  required LockState lock,
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
      // ── Gate PIN-lock (H2) — ANTES del password-gate a propósito: un
      // teléfono desbloqueable no debe exponer ni la pantalla de cambio de
      // contraseña. Mientras el candado hidrata su registro del Keystore
      // (!ready) se retiene /splash para no flashear contenido protegido en
      // un cold start bloqueado.
      if (!lock.ready) {
        return matchedLocation == AppRoutes.splash
            ? null
            : withFrom(AppRoutes.splash);
      }
      if (lock.locked) {
        return matchedLocation == AppRoutes.lock
            ? null
            : withFrom(AppRoutes.lock);
      }

      if (session.mustChangePassword) {
        return matchedLocation == AppRoutes.changePassword
            ? null
            : withFrom(AppRoutes.changePassword);
      }

      // Setup del PIN (mockup 3A): DESPUÉS del password-gate — el éxito 2C
      // encadena "Siguiente: crea tu PIN". screenLockExempt salta el gate
      // completo; user null (restore degradado) no fuerza setup.
      // /change-password se tolera: ahí vive el frame de éxito 2C (recién
      // cayó mustChangePassword) y su "Continuar" navega — entonces sí, este
      // gate atrapa el destino.
      if (lock.needsSetupFor(session.user) &&
          matchedLocation != AppRoutes.pinSetup &&
          matchedLocation != AppRoutes.changePassword) {
        return withFrom(AppRoutes.pinSetup);
      }

      // Gates pasados: sacar al usuario de splash/login/lock hacia su
      // destino. /change-password y /pin-setup NO se expulsan: ahí viven los
      // frames de éxito/oferta de huella y navegan explícitamente.
      if (matchedLocation == AppRoutes.splash ||
          matchedLocation == AppRoutes.login ||
          matchedLocation == AppRoutes.lock) {
        return from ?? AppRoutes.home;
      }
      return null;
  }
}

/// Puente sesión/candado → router: go_router re-evalúa redirect cuando este
/// Listenable notifica; lo bumpeamos con ref.listen sobre sesión Y candado.
class _SessionRouterBump extends ChangeNotifier {
  _SessionRouterBump(Ref ref) {
    ref.listen<SessionState>(
      sessionControllerProvider,
      (_, _) => notifyListeners(),
    );
    ref.listen<LockState>(
      lockControllerProvider,
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
      lock: ref.read(lockControllerProvider),
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
      // /lock y /pin-setup viven FUERA del ShellRoute a propósito: el candado
      // no debe mostrar chip de ubicación ni tabs (superficie de auth, no de
      // app).
      GoRoute(
        path: AppRoutes.lock,
        builder: (context, state) => const PinLockScreen(),
      ),
      GoRoute(
        path: AppRoutes.pinSetup,
        builder: (context, state) => PinSetupScreen(
          resumeTo: state.uri.queryParameters['from'],
        ),
      ),
      GoRoute(
        path: AppRoutes.inspectionPattern,
        builder: (context, state) => InspectionScreen(
          reservationId: state.pathParameters['reservationId']!,
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
            builder: (context, state) => const HomeScreen(),
            routes: [
              GoRoute(
                path: 'queue/:key',
                builder: (context, state) => QueueListScreen(
                  queueKey: state.pathParameters['key'] ?? '',
                ),
              ),
            ],
          ),
          GoRoute(
            path: AppRoutes.search,
            builder: (context, state) => const SearchScreen(),
          ),
          GoRoute(
            path: AppRoutes.incidents,
            builder: (context, state) => ShellPlaceholderScreen(
              title: AppLocalizations.of(context)!.tabIncidents,
            ),
          ),
          GoRoute(
            path: AppRoutes.outbox,
            builder: (context, state) => const OutboxScreen(),
          ),
          GoRoute(
            path: AppRoutes.profile,
            // showLogout: el logout vivía en el placeholder del home (H1);
            // con la home real (H4) su casa provisional es Perfil — donde
            // vivirá el de verdad.
            builder: (context, state) => ShellPlaceholderScreen(
              title: AppLocalizations.of(context)!.tabProfile,
              showLogout: true,
            ),
          ),
        ],
      ),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});
