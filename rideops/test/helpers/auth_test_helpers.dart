import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/auth_api.dart';
import 'package:rideops/core/api/dashboard_api.dart';
import 'package:rideops/core/api/dto/dashboard.dart';
import 'package:rideops/core/api/dto/session_user.dart';
import 'package:rideops/core/session/biometric_auth.dart';
import 'package:rideops/core/session/kiosk_guard.dart';
import 'package:rideops/core/session/pin_store.dart';
import 'package:rideops/core/session/token_store.dart';
import 'package:rideops/core/telemetry/event_logger.dart';

/// Utilería compartida de los tests de auth (H1/H2).

/// user.id del fixture login_response.json — el `sub` de los JWT de test debe
/// coincidir cuando el escenario ata un PIN al usuario (H2: el candado
/// resuelve la identidad por user.id o, degradado, por el sub del token).
const kFixtureUserId = 'cmdusr001fixture0000000001';

/// JWT bien formado (sin firma real) con `exp` controlable — lo que
/// TokenRefresher.expiryOf necesita para decidir vivo/vencido.
/// [extraClaims] permite espejar el payload real de auth.service.js:19
/// (email, role, tenantId) en los tests de paridad.
String fakeJwt({
  required DateTime exp,
  String sub = 'u1',
  Map<String, Object?> extraClaims = const {},
}) {
  final header = base64Url.encode(utf8.encode('{"alg":"HS256","typ":"JWT"}'));
  final payload = base64Url.encode(
    utf8.encode(
      json.encode({
        'sub': sub,
        'exp': exp.millisecondsSinceEpoch ~/ 1000,
        ...extraClaims,
      }),
    ),
  );
  return '$header.$payload.firma';
}

/// Fixture real del serializer de login (test/fixtures/README.md).
Map<String, dynamic> readAuthFixture() {
  final file = File('test/fixtures/login_response.json');
  return json.decode(file.readAsStringSync()) as Map<String, dynamic>;
}

/// AuthResponse desde el fixture, con token vivo y flags de gate a gusto
/// del test.
AuthResponse authResponseFromFixture({
  bool mustChangePassword = false,
  bool screenLockExempt = false,
  String? token,
}) {
  final raw = readAuthFixture();
  final user = raw['user'] as Map<String, dynamic>;
  user['mustChangePassword'] = mustChangePassword;
  user['screenLockExempt'] = screenLockExempt;
  if (token != null) raw['token'] = token;
  return AuthResponse.fromJson(raw);
}

/// KioskGuardStore en memoria — como todo secreto del Keystore, el real hace
/// IO async que jamás resuelve dentro de testWidgets: TODO test que monte la
/// app (o toque lockControllerProvider) debe overridear
/// `kioskGuardStoreProvider` con esto.
class InMemoryKioskGuardStore implements KioskGuardStore {
  InMemoryKioskGuardStore({this.flag = false});

  bool flag;

  @override
  Future<bool> read() async => flag;

  @override
  Future<void> set() async => flag = true;

  @override
  Future<void> clear() async => flag = false;
}

class InMemoryTokenStore implements TokenStore {
  String? value;

  @override
  Future<String?> read() async => value;

  @override
  Future<void> write(String token) async => value = token;

  @override
  Future<void> clear() async => value = null;
}

class InMemoryPinStore implements PinStore {
  InMemoryPinStore([this.value]);

  /// PIN ya configurado (por default '1234') — para escenarios que arrancan
  /// con candado o que deben saltarse el gate de setup.
  factory InMemoryPinStore.configured({
    required String userId,
    String pin = '1234',
    bool biometricEnabled = false,
  }) =>
      InMemoryPinStore(StoredPin.create(
        userId: userId,
        pin: pin,
        biometricEnabled: biometricEnabled,
      ));

  StoredPin? value;

  @override
  Future<StoredPin?> read() async => value;

  @override
  Future<void> write(StoredPin pin) async => value = pin;

  @override
  Future<void> clear() async => value = null;
}

class FakeBiometricAuth implements BiometricAuth {
  FakeBiometricAuth({this.available = false, this.authenticateResult = false});

  bool available;
  bool authenticateResult;
  int authenticateCalls = 0;

  @override
  Future<bool> isAvailable() async => available;

  @override
  Future<bool> authenticate({required String reason}) async {
    authenticateCalls++;
    return authenticateResult;
  }
}

/// AuthApi con handlers inyectables. Los Dio de super jamás se usan: cada
/// método está sobreescrito.
class FakeAuthApi extends AuthApi {
  FakeAuthApi() : super(authedDio: Dio(), publicDio: Dio(), bareDio: Dio());

  Future<AuthResponse> Function(String email, String password)? onLogin;
  Future<SessionUser> Function()? onMe;
  Future<AuthResponse> Function(String current, String next)? onChangePassword;
  Future<AuthResponse> Function(String currentToken)? onRefresh;

  @override
  Future<AuthResponse> login({
    required String email,
    required String password,
  }) =>
      onLogin!(email, password);

  @override
  Future<SessionUser> me() => onMe!();

  @override
  Future<AuthResponse> changePassword({
    required String currentPassword,
    required String newPassword,
  }) =>
      onChangePassword!(currentPassword, newPassword);

  @override
  Future<AuthResponse> refreshWithToken(String currentToken) =>
      onRefresh!(currentToken);
}

/// DashboardApi con handler inyectable. Default: el fixture real de
/// dashboard.json — los tests de flujo de auth que aterrizan en la home (H4)
/// necesitan que el fetch RESUELVA: con la red real del harness colgando, el
/// skeleton animaría por siempre y pumpAndSettle avanzaría el reloj fake
/// hasta disparar el lock de inactividad (5 min) a mitad del assert.
class FakeDashboardApi extends DashboardApi {
  FakeDashboardApi() : super(authedDio: Dio());

  Future<DashboardPayload> Function(String query)? onFetch;
  int calls = 0;
  String? lastQuery;

  @override
  Future<DashboardPayload> fetch({
    String query = '',
    bool skipRateLimitRetry = false,
  }) {
    calls++;
    lastQuery = query;
    if (onFetch != null) return onFetch!(query);
    return Future.value(
      DashboardPayload.fromJson(readJsonFixture('dashboard.json')),
    );
  }
}

/// Fixture arbitrario de test/fixtures (dashboard.json, reservation_card…).
Map<String, dynamic> readJsonFixture(String name) {
  final file = File('test/fixtures/$name');
  return json.decode(file.readAsStringSync()) as Map<String, dynamic>;
}

/// Fixture de un endpoint que responde ARRAY PLANO (sin envoltura), como
/// `GET /api/reservations/:id/available-vehicles` o `/locations/selectable`.
/// El fixture guarda la forma REAL del serializer; envolverlo en un objeto
/// para que quepa en [readJsonFixture] sería falsear el contrato.
List<Map<String, dynamic>> readJsonListFixture(String name) {
  final file = File('test/fixtures/$name');
  return [
    for (final row in json.decode(file.readAsStringSync()) as List<dynamic>)
      row as Map<String, dynamic>,
  ];
}

/// Logger que captura eventos para asertar la taxonomía.
class CapturingEventLogger implements EventLogger {
  final events = <(String, Map<String, Object?>)>[];

  @override
  void log(String event, {Map<String, Object?> data = const {}}) {
    events.add((event, data));
  }

  bool has(String event) => events.any((e) => e.$1 == event);
}

/// Errores de API listos para usar en fakes.
///
/// [status] NO es decorativo: el cliente decide por [kind], pero una prueba que
/// no puede escribir el status acaba inventando pares que el backend jamás
/// emite (un 409 con `NO_VEHICLE_ASSIGNED`, que en realidad es 422) y probando
/// una rama distinta de la que dice probar.
ApiError apiError(
  ApiErrorKind kind, {
  String message = 'x',
  String? code,
  int? status,
}) =>
    ApiError(kind: kind, message: message, code: code, status: status);
