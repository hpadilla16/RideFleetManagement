import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/dto/session_user.dart';
import 'package:rideops/core/router/app_router.dart';
import 'package:rideops/core/session/session_state.dart';

/// Tabla de casos del redirect top-level (blueprint §3): orden de gates,
/// anti-loop y preservación de destino en ?from=.
void main() {
  SessionUser user({bool mustChange = false}) => SessionUser(
        id: 'u1',
        email: 'a@b.c',
        role: 'AGENT',
        mustChangePassword: mustChange,
      );

  String? redirect(SessionState session, String location) {
    final uri = Uri.parse(location);
    return computeAuthRedirect(
      session: session,
      uri: uri,
      matchedLocation: uri.path,
    );
  }

  const unauth = SessionState.unauthenticated();
  const restoring = SessionState.restoring();
  final liveNoGate =
      SessionState.authenticated(token: 't', user: user());
  final liveMustChange =
      SessionState.authenticated(token: 't', user: user(mustChange: true));
  const liveUserNull = SessionState.authenticated(token: 't');

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
