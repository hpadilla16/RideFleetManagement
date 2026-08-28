import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/checkout_api.dart';
import 'package:rideops/core/api/dto/available_vehicle.dart';
import 'package:rideops/core/api/dto/checkout_session.dart';
import 'package:rideops/core/api/dto/inspection.dart';
import 'package:rideops/core/api/dto/reservation_display.dart';
import 'package:rideops/core/api/enums.dart';
// PrecheckinLinkResult vive junto a ReservationsApi.
import 'package:rideops/core/api/reservations_api.dart';
import 'package:rideops/features/inspection/application/inspection_state.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/lock_controller.dart';
import 'package:rideops/core/session/lock_state.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/features/checkout/presentation/widgets/join_view.dart';

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

/// Sesión a partir de un mapa ya manipulado por el test (events a medida).
CheckoutSessionDto sessionFromRaw(Map<String, dynamic> raw) =>
    CheckoutSessionDto.fromJson(raw);

/// Token de T&C del fixture, vivo por [ttl] desde ahora.
///
/// [reused] refleja el re-uso idempotente del backend (>2 min restantes
/// devuelven el MISMO token) — es lo que decide la copy de la re-emisión.
HandoffToken termsToken({
  Duration ttl = const Duration(minutes: 15),
  bool reused = false,
  String token = 'tok_terms_fixture_0001',
}) {
  return HandoffToken(
    token: token,
    expiresAt: clock.now().add(ttl),
    kind: 'TERMS_SIGNING',
    reused: reused,
  );
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
  int createCalls = 0;
  final transitions = <String>[];

  /// reservationIds con los que se llamó al POST de creación (M2-H7): la
  /// idempotencia se prueba contando llamadas, no adivinando.
  final created = <String>[];

  int termsTokenCalls = 0;
  int declinedInsuranceCalls = 0;
  int swapCalls = 0;
  final declinedValues = <bool>[];
  final swappedVehicleIds = <String>[];

  Future<CheckoutSessionDto?> Function()? onByReservation;
  Future<CheckoutSessionDto> Function()? onGet;
  Future<CheckoutSessionDto> Function(String toStep)? onTransition;
  Future<CheckoutSessionDto> Function()? onAbandon;
  Future<CheckoutSessionDto> Function(String reservationId)? onCreate;
  Future<HandoffToken> Function()? onMintTermsToken;
  Future<CheckoutSessionDto> Function(bool declined)? onDeclinedInsurance;
  Future<VehicleSwapResult> Function(String newVehicleId)? onSwapVehicle;

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

  /// `POST /:id/customer-signature` (M2-H5). Se guardan el dataURL y el
  /// `signerName` PORQUE son la prueba de dos reglas: que la firma llega
  /// completa al contrato y que no viaja anónima.
  int signatureCalls = 0;
  final signatureDataUrls = <String>[];
  final signerNames = <String?>[];
  Future<CheckoutSessionDto> Function(String dataUrl, String? signerName)?
      onSaveCustomerSignature;

  @override
  Future<CheckoutSessionDto> saveCustomerSignature({
    required String id,
    required String signatureDataUrl,
    String? signerName,
  }) async {
    signatureCalls++;
    signatureDataUrls.add(signatureDataUrl);
    signerNames.add(signerName);
    if (onSaveCustomerSignature != null) {
      return onSaveCustomerSignature!(signatureDataUrl, signerName);
    }
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

  /// Mint del token de T&C. Responde SIEMPRE algo válido por defecto: sin
  /// esto, cualquier test que aterrice en TC_PENDING dejaría la pantalla en
  /// "pidiendo el código" con su spinner — y un spinner vivo hace que
  /// `pumpAndSettle` no termine nunca.
  @override
  Future<HandoffToken> mintTermsToken(String checkoutSessionId) async {
    termsTokenCalls++;
    if (onMintTermsToken != null) return onMintTermsToken!();
    return _maybeGate(termsToken());
  }

  /// Mint del handoff de inspección + estado de ángulos del servidor. El
  /// flujo de captura (M2-H4) los pide al cargar, como contexto best-effort:
  /// sin estos overrides saldrían por el Dio real de `super` y el test
  /// dependería de que ese fallo caiga en el catch correcto.
  int handoffTokenCalls = 0;
  int inspectionStateCalls = 0;
  Future<HandoffToken> Function()? onMintHandoffToken;
  Future<MobileInspectionState> Function()? onInspectionState;

  @override
  Future<HandoffToken> mintHandoffToken(String checkoutSessionId) async {
    handoffTokenCalls++;
    if (onMintHandoffToken != null) return onMintHandoffToken!();
    return _maybeGate(termsToken(token: 'tok_handoff_fixture_0001'));
  }

  @override
  Future<MobileInspectionState> getInspectionState(String token) async {
    inspectionStateCalls++;
    if (onInspectionState != null) return onInspectionState!();
    return _maybeGate(
      MobileInspectionState(
        angles: [
          for (final key in kInspectionAngleKeys)
            InspectionAngle(key: key, label: key),
        ],
      ),
    );
  }

  @override
  Future<CheckoutSessionDto> setDeclinedInsurance({
    required String id,
    required bool declined,
  }) async {
    declinedInsuranceCalls++;
    declinedValues.add(declined);
    if (onDeclinedInsurance != null) return onDeclinedInsurance!(declined);
    return _maybeGate(current!);
  }

  @override
  Future<VehicleSwapResult> swapVehicle({
    required String id,
    required String newVehicleId,
  }) async {
    swapCalls++;
    swappedVehicleIds.add(newVehicleId);
    if (onSwapVehicle != null) return onSwapVehicle!(newVehicleId);
    return _maybeGate(
      VehicleSwapResult(
        sessionId: id,
        fromVehicleId: 'cmea77xh20003vehu112',
        toVehicleId: newVehicleId,
        session: current!,
      ),
    );
  }

  /// `POST /:id/presence` — el LATIDO (M2-H6). Sin este override salía por el
  /// `Dio()` pelado de `super`, que en un widget test abre un HttpClient real:
  /// de ahí venían los "A Timer is still pending" que aparecieron al encender
  /// el latido.
  ///
  /// Se cuenta y se guarda la superficie porque las dos cosas son contrato:
  /// que el latido viaje colgado del poll (no de un temporizador propio) y que
  /// la app mande `RIDEOPS` y NUNCA un `label` — el nombre lo resuelve el
  /// servidor con `fullName`, una sola fuente de verdad.
  int presenceCalls = 0;
  final presenceSurfaces = <String>[];

  /// Con esto puesto el latido FALLA. Es la prueba de que su fallo no puede
  /// tocar la pantalla: la presencia es informativa y no bloquea nada.
  bool presenceFails = false;

  @override
  Future<void> heartbeatPresence({
    required String id,
    CheckoutSurface surface = CheckoutSurface.rideops,
  }) async {
    presenceCalls++;
    presenceSurfaces.add(surface.wire);
    if (presenceFails) throw StateError('presencia caída');
  }

  @override
  Future<CheckoutSessionDto> createForReservation(String reservationId) async {
    createCalls++;
    created.add(reservationId);
    if (onCreate != null) return onCreate!(reservationId);
    return _maybeGate(current!);
  }
}

/// ReservationsApi con el envío del link de pre-checkin inyectable (frame
/// 11B). El backend responde 200 CON `emailSent:false` cuando el SMTP falla —
/// por eso el fake devuelve el record completo y no un bool suelto.
class FakePrecheckinReservationsApi extends FakeReservationsApi {
  FakePrecheckinReservationsApi({super.fail});

  int linkCalls = 0;
  Future<PrecheckinLinkResult> Function()? onSendLink;

  @override
  Future<PrecheckinLinkResult> sendPrecheckinLink(String reservationId) async {
    linkCalls++;
    if (onSendLink != null) return onSendLink!();
    return (sent: true, warning: null);
  }
}

/// display-data del fixture real (contexto best-effort del header) y las
/// unidades disponibles del sheet de swap.
class FakeReservationsApi extends ReservationsApi {
  FakeReservationsApi({this.fail = false}) : super(authedDio: Dio());

  final bool fail;

  /// Permite mutar el payload por escenario (dato faltante, unidad cambiada
  /// tras el swap) sin tocar el fixture en disco.
  Map<String, dynamic> Function(Map<String, dynamic> raw)? patchDisplayData;

  int displayDataCalls = 0;
  int availableVehiclesCalls = 0;
  Future<List<AvailableVehicle>> Function()? onAvailableVehicles;

  /// Retiene `display-data` en vuelo. Es lo que permite mirar el FRAME de
  /// "comprobando" del 19A-bis: sin esta compuerta la consulta resuelve en el
  /// mismo microtask y la prueba nunca ve el estado intermedio que la lámina
  /// existe para hacer expresable.
  Completer<void>? displayGate;

  @override
  Future<ReservationDisplayData> getDisplayData(String reservationId) async {
    displayDataCalls++;
    if (displayGate != null) await displayGate!.future;
    if (fail) throw StateError('display-data caído');
    final raw = readJsonFixture('reservation_display_data.json');
    return ReservationDisplayData.fromJson(
      patchDisplayData == null ? raw : patchDisplayData!(raw),
    );
  }

  @override
  Future<List<AvailableVehicle>> getAvailableVehicles(
    String reservationId,
  ) async {
    availableVehiclesCalls++;
    if (onAvailableVehicles != null) return onAvailableVehicles!();
    return [
      for (final row
          in readJsonListFixture('reservation_available_vehicles.json'))
        AvailableVehicle.fromJson(row),
    ];
  }
}

class StubActiveLocation extends ActiveLocationController {
  StubActiveLocation(this.initial);

  final ActiveLocation initial;

  @override
  ActiveLocation build() => initial;

  /// Cambio de sede EN VIVO: los controllers que hacen
  /// `ref.watch(activeLocationProvider)` se reconstruyen, que es justo el
  /// escenario del fencing (una escritura en vuelo cuyo alcance cambió).
  void emit(ActiveLocation next) => state = next;
}

/// Candado de personal INERTE que cuenta pares suspend/resume.
///
/// El real lee Keystore en `build()` (y en un widget test eso es un plugin que
/// no existe); aquí lo único que interesa es que el modo presentación suspenda
/// EXACTAMENTE una vez y reanude exactamente una vez — el candado de 5 min no
/// puede saltar mientras el cliente lee los términos (review INN-S-3).
class StubLockController extends LockController {
  int suspends = 0;
  int resumes = 0;

  @override
  LockState build() => const LockState.initial();

  @override
  void suspendLock() => suspends++;

  @override
  void resumeLock() => resumes++;
}

class MutableSessionController extends SessionController {
  MutableSessionController(this.initial);

  final SessionState initial;

  @override
  SessionState build() => initial;

  void emit(SessionState next) => state = next;
}

/// Salta la antesala de enganche (M2-H6, frames 23A/B/C) cuando el escenario
/// del test entra a media sesión.
///
/// Existe porque la antesala es una pantalla NUEVA en el camino de entrada:
/// desde H6, abrir una sesión que no está en el paso 1 —o que abrió otra
/// persona— muestra primero "qué hay hecho / qué falta". Los tests que van a
/// probar el CUERPO de un paso no deberían tener que saber eso; los que
/// prueban la antesala la tocan de verdad (checkout_join_test.dart).
///
/// No-op cuando la antesala no está: así el mismo helper sirve para escenarios
/// que arrancan en CONFIRMING.
Future<void> skipJoinGate(WidgetTester tester) async {
  final finder = find.byType(CheckoutJoinView);
  if (finder.evaluate().isEmpty) return;
  tester.widget<CheckoutJoinView>(finder).onContinue();
  await tester.pumpAndSettle();
}
