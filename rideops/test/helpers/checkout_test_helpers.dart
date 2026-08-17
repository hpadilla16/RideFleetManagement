import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:rideops/core/api/checkout_api.dart';
import 'package:rideops/core/api/dto/checkout_session.dart';
import 'package:rideops/core/api/dto/reservation_display.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/core/api/reservations_api.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';

import 'auth_test_helpers.dart';

/// Utilería compartida de los tests del wizard de checkout (M2-H1).

const kReservationId = 'cmdres001fixture0000000001';
const kSessionId = 'cmdcks001fixture0000000001';

/// El empleado de ESTE teléfono — coincide con el actor del fixture.
const kMyUserId = kFixtureUserId;

Map<String, dynamic> rawCheckoutSession() =>
    json.decode(File('test/fixtures/checkout_session.json').readAsStringSync())
        as Map<String, dynamic>;

/// Sesión del fixture con el paso, los sellos y la ATRIBUCIÓN que pida el
/// escenario. El `events` se re-escribe con la forma exacta de `appendEvent`.
CheckoutSessionDto sessionAt(
  CheckoutStep step, {
  String? actorUserId = kMyUserId,
  bool kiosk = false,
  DateTime? tc,
  DateTime? payment,
  DateTime? inspection,
  DateTime? signature,
  String? rawStep,
  List<CheckoutPresenceDto>? presence,
  DateTime? abandonedAt,

  /// Columna de P2. null = backend sin desplegar (el fence cae al epoch
  /// local); un entero permite probar el descarte por versión.
  int? stateVersion,
}) {
  final raw = rawCheckoutSession();
  raw['currentStep'] = rawStep ?? step.wire;
  raw['stateVersion'] = stateVersion;
  raw['events'] = json.encode([
    {
      'kind': 'SESSION_STARTED',
      'actorUserId': kMyUserId,
      'at': '2026-08-16T14:02:11.000Z',
    },
    {
      'kind': 'TRANSITION',
      'from': 'CONFIRMING',
      'to': rawStep ?? step.wire,
      'actorUserId': actorUserId,
      'metadata': kiosk ? {'kiosk': true} : null,
      'at': '2026-08-16T14:03:40.000Z',
    },
  ]);
  raw['tcCompletedAt'] = tc?.toIso8601String();
  raw['paymentCompletedAt'] = payment?.toIso8601String();
  raw['inspectionCompletedAt'] = inspection?.toIso8601String();
  raw['customerSignedAt'] = signature?.toIso8601String();
  raw['abandonedAt'] = abandonedAt?.toIso8601String();
  if (presence != null) {
    raw['presence'] = [
      for (final p in presence)
        {
          'surface': p.surface,
          'displayName': p.displayName,
          'lastSeenAt': p.lastSeenAt?.toIso8601String(),
        },
    ];
  }
  return CheckoutSessionDto.fromJson(raw);
}

/// CheckoutApi con handlers inyectables. Los Dio de super nunca se usan.
class FakeCheckoutApi extends CheckoutApi {
  FakeCheckoutApi() : super(authedDio: Dio(), publicDio: Dio());

  /// Lo que responde `GET /:id` (y el arranque si [onByReservation] es null).
  CheckoutSessionDto? current = sessionAt(CheckoutStep.confirming);

  int byReservationCalls = 0;
  int getCalls = 0;
  int transitionCalls = 0;
  int abandonCalls = 0;
  final transitions = <String>[];

  Future<CheckoutSessionDto?> Function()? onByReservation;
  Future<CheckoutSessionDto> Function()? onGet;
  Future<CheckoutSessionDto> Function(String toStep)? onTransition;
  Future<CheckoutSessionDto> Function()? onAbandon;

  /// Cuando está puesto, TODA respuesta espera a que el test lo complete —
  /// así se prueban el skip con request en vuelo y el anti-doble-tap.
  Completer<void>? gate;

  Future<T> _maybeGate<T>(T value) async {
    if (gate != null) await gate!.future;
    return value;
  }

  /// `skipRateLimitRetry` de cada lectura, en orden — el poll debe pedir que
  /// el interceptor NO reintente; el re-fetch del agente, sí.
  final skipRetryFlags = <bool>[];

  @override
  Future<CheckoutSessionDto?> getByReservation(
    String reservationId, {
    bool skipViewLocation = false,
    bool skipRateLimitRetry = false,
  }) async {
    byReservationCalls++;
    skipRetryFlags.add(skipRateLimitRetry);
    if (onByReservation != null) return onByReservation!();
    return _maybeGate(current);
  }

  @override
  Future<CheckoutSessionDto> getSession(
    String id, {
    bool skipRateLimitRetry = false,
  }) async {
    getCalls++;
    skipRetryFlags.add(skipRateLimitRetry);
    if (onGet != null) return onGet!();
    return _maybeGate(current!);
  }

  @override
  Future<CheckoutSessionDto> transition({
    required String id,
    required String toStep,
    Map<String, Object?>? metadata,
  }) async {
    transitionCalls++;
    transitions.add(toStep);
    if (onTransition != null) return onTransition!(toStep);
    return _maybeGate(current!);
  }

  @override
  Future<CheckoutSessionDto> abandon({
    required String id,
    String? reason,
  }) async {
    abandonCalls++;
    if (onAbandon != null) return onAbandon!();
    return _maybeGate(current!);
  }
}

/// display-data del fixture real (contexto best-effort del header).
class FakeReservationsApi extends ReservationsApi {
  FakeReservationsApi({this.fail = false}) : super(authedDio: Dio());

  final bool fail;

  @override
  Future<ReservationDisplayData> getDisplayData(String reservationId) async {
    if (fail) throw StateError('display-data caído');
    return ReservationDisplayData.fromJson(
      readJsonFixture('reservation_display_data.json'),
    );
  }
}

class StubActiveLocation extends ActiveLocationController {
  StubActiveLocation(this.initial);

  final ActiveLocation initial;

  @override
  ActiveLocation build() => initial;
}

class MutableSessionController extends SessionController {
  MutableSessionController(this.initial);

  final SessionState initial;

  @override
  SessionState build() => initial;

  void emit(SessionState next) => state = next;
}
