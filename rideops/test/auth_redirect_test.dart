import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/dto/session_user.dart';
import 'package:rideops/core/router/app_router.dart';
import 'package:rideops/core/session/lock_state.dart';
import 'package:rideops/core/session/session_state.dart';

/// Tabla de casos del redirect top-level (blueprint §3): orden de gates
/// (auth → PIN-lock → password-gate → PIN-setup), anti-loop y preservación
/// de destino en ?from=.
void main() {
  SessionUser user({bool mustChange = false, bool exempt = false}) =>
      SessionUser(
        id: 'u1',
        email: 'a@b.c',
        role: 'AGENT',
        mustChangePassword: mustChange,
        screenLockExempt: exempt,
      );

  // Candados de referencia: con PIN y abierto (el estado "normal"), con PIN
  // y bloqueado, sin PIN, e hidratando (ready=false).
  const lockIdle = LockState(
    ready: true,
    pinConfigured: true,
    biometricEnabled: false,
    locked: false,
    attemptsLeft: LockState.maxAttempts,
  );
  const lockLocked = LockState(
    ready: true,
    pinConfigured: true,
    biometricEnabled: false,
    locked: true,
    attemptsLeft: LockState.maxAttempts,
  );
  const lockNoPin = LockState(
    ready: true,
    pinConfigured: false,
    biometricEnabled: false,
    locked: false,
    attemptsLeft: LockState.maxAttempts,
  );
  const lockLoading = LockState.initial();

  String? redirect(
    SessionState session,
    String location, {
    LockState lock = lockIdle,
  }) {
    final uri = Uri.parse(location);
    return computeAuthRedirect(
      session: session,
      lock: lock,
      uri: uri,
      matchedLocation: uri.path,
    );
  }

  const unauth = SessionState.unauthenticated();
  const restoring = SessionState.restoring();
  final liveNoGate = SessionState.authenticated(token: 't', user: user());
  final liveMustChange =
      SessionState.authenticated(token: 't', user: user(mustChange: true));
  const liveUserNull = SessionState.authenticated(token: 't');
  final liveExempt =
      SessionState.authenticated(token: 't', user: user(exempt: true));

  group('gate auth (sin token)', () {
    test('ruta de app → /login preservando destino', () {
      expect(
        redirect(unauth, '/home'),
        '/login?from=${Uri.encodeComponent('/home')}',
      );
    });

    test('destino con query se preserva completo', () {
      expect(
        redirect(unauth, '/home?tab=2'),
        '/login?from=${Uri.encodeComponent('/home?tab=2')}',
      );
    });

    test('anti-loop: ya en /login → null', () {
      expect(redirect(unauth, '/login'), isNull);
      expect(redirect(unauth, '/login?from=%2Fhome'), isNull);
    });

    test('en /change-password sin sesión → /login SIN preservarla como from',
        () {
      expect(redirect(unauth, '/change-password'), '/login');
    });

    test('en /lock o /pin-setup sin sesión → /login sin preservarlas', () {
      expect(redirect(unauth, '/lock'), '/login');
      expect(redirect(unauth, '/pin-setup'), '/login');
    });

    test('en /splash sin sesión → /login (arrastrando from si lo hay)', () {
      expect(redirect(unauth, '/splash'), '/login');
      expect(redirect(unauth, '/splash?from=%2Fhome'),
          '/login?from=${Uri.encodeComponent('/home')}');
    });
  });

  group('restaurando', () {
    test('cualquier ruta → /splash arrastrando destino', () {
      expect(
        redirect(restoring, '/home'),
        '/splash?from=${Uri.encodeComponent('/home')}',
      );
    });

    test('anti-loop: ya en /splash → null', () {
      expect(redirect(restoring, '/splash'), isNull);
    });
  });

  group('gate PIN-lock (H2)', () {
    test('candado hidratando (!ready) retiene /splash — no flashear la app',
        () {
      expect(
        redirect(liveNoGate, '/home', lock: lockLoading),
        '/splash?from=${Uri.encodeComponent('/home')}',
      );
      expect(redirect(liveNoGate, '/splash', lock: lockLoading), isNull);
    });

    test('bloqueado: ruta de app → /lock preservando destino', () {
      expect(
        redirect(liveNoGate, '/home?tab=2', lock: lockLocked),
        '/lock?from=${Uri.encodeComponent('/home?tab=2')}',
      );
    });

    test('anti-loop: ya en /lock → null', () {
      expect(redirect(liveNoGate, '/lock', lock: lockLocked), isNull);
    });

    test('orden Innovation: el candado gana al password-gate', () {
      expect(
        redirect(liveMustChange, '/home', lock: lockLocked),
        '/lock?from=${Uri.encodeComponent('/home')}',
      );
    });

    test('bloqueado con user null (restore degradado) también bloquea', () {
      expect(
        redirect(liveUserNull, '/home', lock: lockLocked),
        '/lock?from=${Uri.encodeComponent('/home')}',
      );
    });

    test('desbloqueado en /lock → reanuda el destino preservado', () {
      expect(redirect(liveNoGate, '/lock?from=%2Fhome%3Ftab%3D2'),
          '/home?tab=2');
      expect(redirect(liveNoGate, '/lock'), AppRoutes.home);
    });
  });

  group('gate de contraseña (mustChangePassword)', () {
    test('ruta de app → /change-password preservando destino', () {
      expect(
        redirect(liveMustChange, '/home'),
        '/change-password?from=${Uri.encodeComponent('/home')}',
      );
    });

    test('desde /login arrastra el from original', () {
      expect(
        redirect(liveMustChange, '/login?from=%2Fhome'),
        '/change-password?from=${Uri.encodeComponent('/home')}',
      );
    });

    test('anti-loop: ya en /change-password → null', () {
      expect(redirect(liveMustChange, '/change-password'), isNull);
    });

    test('flag de estado con user NULL también bloquea (MUST-1 review H1)',
        () {
      final flagged = const SessionState.authenticated(token: 't')
          .withPasswordChangeRequired();
      expect(flagged.user, isNull);
      expect(
        redirect(flagged, '/home'),
        '/change-password?from=${Uri.encodeComponent('/home')}',
      );
      expect(redirect(flagged, '/change-password'), isNull);
    });

    test('password-gate gana al setup del PIN (2C encadena "crea tu PIN")',
        () {
      expect(
        redirect(liveMustChange, '/home', lock: lockNoPin),
        '/change-password?from=${Uri.encodeComponent('/home')}',
      );
    });
  });

  group('gate PIN-setup (H2)', () {
    test('sin PIN: ruta de app → /pin-setup preservando destino', () {
      expect(
        redirect(liveNoGate, '/home', lock: lockNoPin),
        '/pin-setup?from=${Uri.encodeComponent('/home')}',
      );
    });

    test('anti-loop: ya en /pin-setup → null', () {
      expect(redirect(liveNoGate, '/pin-setup', lock: lockNoPin), isNull);
    });

    test('screenLockExempt salta TODO el gate, incluido el setup', () {
      expect(redirect(liveExempt, '/home', lock: lockNoPin), isNull);
    });

    test('user null (restore degradado) NO fuerza setup por especulación',
        () {
      expect(redirect(liveUserNull, '/home', lock: lockNoPin), isNull);
    });

    test('/pin-setup con PIN ya configurado NO expulsa (frame de huella)',
        () {
      expect(redirect(liveNoGate, '/pin-setup'), isNull);
    });

    test('needsSetup NO expulsa /change-password (frame de éxito 2C)', () {
      expect(
        redirect(liveNoGate, '/change-password', lock: lockNoPin),
        isNull,
      );
    });
  });

  group('intersección H2 × H3 (candado × rutas del shell)', () {
    test('bloqueado en una ruta del shell → /lock preservando la tab', () {
      // El candado gana aunque el usuario esté parado en el shell con sede
      // activa: la ubicación es estado de datos, no un gate — no compite.
      expect(
        redirect(liveNoGate, '/search', lock: lockLocked),
        '/lock?from=${Uri.encodeComponent('/search')}',
      );
      expect(
        redirect(liveNoGate, '/outbox', lock: lockLocked),
        '/lock?from=${Uri.encodeComponent('/outbox')}',
      );
    });

    test('desbloqueado en /lock con from de shell → reanuda esa tab', () {
      expect(redirect(liveNoGate, '/lock?from=%2Fsearch'), '/search');
      expect(redirect(liveNoGate, '/lock?from=%2Foutbox'), '/outbox');
    });

    test('sin PIN parado en el shell → /pin-setup preservando la tab', () {
      expect(
        redirect(liveNoGate, '/search', lock: lockNoPin),
        '/pin-setup?from=${Uri.encodeComponent('/search')}',
      );
    });

    test('tras el setup, /login con from de shell aterriza en el shell', () {
      // pin-setup navega él mismo a su resumeTo; la tabla verifica que con
      // todos los gates pasados el from de shell se respeta desde cualquier
      // superficie de auth.
      expect(redirect(liveNoGate, '/login?from=%2Fsearch'), '/search');
      expect(redirect(liveNoGate, '/splash?from=%2Foutbox'), '/outbox');
    });
  });

  group('token vivo, sin gates', () {
    test('en /login → reanuda el destino preservado', () {
      expect(redirect(liveNoGate, '/login?from=%2Fhome%3Ftab%3D2'),
          '/home?tab=2');
    });

    test('en /login sin from → /home', () {
      expect(redirect(liveNoGate, '/login'), AppRoutes.home);
    });

    test('en /splash → destino o /home', () {
      expect(redirect(liveNoGate, '/splash'), AppRoutes.home);
    });

    test('ruta de app → null (sin redirect)', () {
      expect(redirect(liveNoGate, '/home'), isNull);
    });

    test('/change-password NO expulsa (ahí vive el frame de éxito)', () {
      expect(redirect(liveNoGate, '/change-password'), isNull);
    });

    test('user null (hidratación en vuelo) NO bloquea en el gate', () {
      expect(redirect(liveUserNull, '/home'), isNull);
    });
  });
}
