import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/auth_api.dart';
import 'package:rideops/core/api/interceptors.dart';
import 'package:rideops/core/api/token_refresher.dart';

import 'helpers/auth_test_helpers.dart';

/// Tests del AuthInterceptor con adapter mockeado (Innovation S-1): bearer,
/// x-view-location, 401 → onSessionExpired, 403+code → onPasswordChangeRequired
/// — y el mapeo puro de ApiError.fromDio. Este archivo existe porque el bug
/// del MUST-1 (flag del gate perdido con user null) habría caído aquí.

/// Adapter que captura la request y responde lo que le digan.
class CaptureAdapter implements HttpClientAdapter {
  CaptureAdapter(this.respond);

  final ResponseBody Function() respond;
  RequestOptions? last;
  int calls = 0;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    calls++;
    last = options;
    return respond();
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody jsonRes(int status, Map<String, Object?> body) =>
    ResponseBody.fromString(
      json.encode(body),
      status,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );

TokenRefresher refresherFor(String? token) => TokenRefresher(
      readToken: () async => token,
      doRefresh: (t) async => t,
      storeToken: (_) async {},
    );

({Dio dio, CaptureAdapter adapter, List<String> calls}) build({
  String? token,
  String? viewLocation,
  required ResponseBody Function() respond,
}) {
  final calls = <String>[];
  final adapter = CaptureAdapter(respond);
  final dio = Dio(BaseOptions(baseUrl: 'https://rideops.test'));
  dio.httpClientAdapter = adapter;
  dio.interceptors.add(
    AuthInterceptor(
      refresher: refresherFor(
        token ?? fakeJwt(exp: DateTime.now().add(const Duration(hours: 8))),
      ),
      readViewLocation: () => viewLocation,
      onSessionExpired: () => calls.add('expired'),
      onPasswordChangeRequired: () => calls.add('pwd-gate'),
      onViewLocationDenied: () => calls.add('view-denied'),
    ),
  );
  return (dio: dio, adapter: adapter, calls: calls);
}

Future<ApiError> errorOf(Future<void> Function() run) async {
  try {
    await run();
    fail('esperaba DioException');
  } on DioException catch (e) {
    return e.error! as ApiError;
  }
}

void main() {
  test('inyecta el bearer y NO manda x-view-location sin ubicación activa',
      () async {
    final t = fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)));
    final h = build(token: t, respond: () => jsonRes(200, {'ok': true}));
    await h.dio.get<dynamic>('/x');
    expect(h.adapter.last!.headers['Authorization'], 'Bearer $t');
    expect(
      h.adapter.last!.headers.containsKey(AuthInterceptor.viewLocationHeader),
      isFalse,
    );
  });

  test('manda x-view-location cuando hay ubicación activa', () async {
    final h = build(
      viewLocation: 'loc-centro',
      respond: () => jsonRes(200, {'ok': true}),
    );
    await h.dio.get<dynamic>('/x');
    expect(
      h.adapter.last!.headers[AuthInterceptor.viewLocationHeader],
      'loc-centro',
    );
  });

  test('token vencido: rechaza SIN tocar la red y dispara onSessionExpired',
      () async {
    final dead =
        fakeJwt(exp: DateTime.now().subtract(const Duration(minutes: 5)));
    final h = build(token: dead, respond: () => jsonRes(200, {'ok': true}));
    final err = await errorOf(() => h.dio.get<dynamic>('/x'));
    expect(err.kind, ApiErrorKind.unauthorized);
    expect(h.adapter.calls, 0, reason: 'ADR-3a: JWT muerto no viaja');
    expect(h.calls, ['expired']);
  });

  test('401 del servidor → onSessionExpired + ApiError unauthorized',
      () async {
    final h = build(respond: () => jsonRes(401, {'error': 'Invalid session'}));
    final err = await errorOf(() => h.dio.get<dynamic>('/x'));
    expect(err.kind, ApiErrorKind.unauthorized);
    expect(h.calls, ['expired']);
  });

  test(
      '403 con code PASSWORD_CHANGE_REQUIRED → onPasswordChangeRequired '
      '(y NUNCA onSessionExpired)', () async {
    final h = build(
      respond: () => jsonRes(403, {
        'error': 'Password change required',
        'code': 'PASSWORD_CHANGE_REQUIRED',
      }),
    );
    final err = await errorOf(() => h.dio.get<dynamic>('/x'));
    expect(err.kind, ApiErrorKind.passwordChangeRequired);
    expect(err.code, 'PASSWORD_CHANGE_REQUIRED');
    expect(h.calls, ['pwd-gate']);
  });

  test(
      '403 SIN code y SIN header de ubicación → forbidden, sin callbacks '
      '(un 403 de módulo no contamina la métrica del selector)', () async {
    // REGROUND §1: el 403 del header x-view-location no trae code.
    final h = build(
      respond: () =>
          jsonRes(403, {'error': 'You do not have access to that location.'}),
    );
    final err = await errorOf(() => h.dio.get<dynamic>('/x'));
    expect(err.kind, ApiErrorKind.forbidden);
    expect(h.calls, isEmpty);
  });

  test('403 SIN code en request CON header → onViewLocationDenied (H3)',
      () async {
    final h = build(
      viewLocation: 'loc-quitada',
      respond: () =>
          jsonRes(403, {'error': 'You do not have access to that location.'}),
    );
    final err = await errorOf(() => h.dio.get<dynamic>('/x'));
    expect(err.kind, ApiErrorKind.forbidden);
    expect(h.calls, ['view-denied']);
  });

  test('403 CON code y header → pwd-gate, jamás view-denied', () async {
    final h = build(
      viewLocation: 'loc-centro',
      respond: () => jsonRes(403, {
        'error': 'Password change required',
        'code': 'PASSWORD_CHANGE_REQUIRED',
      }),
    );
    await errorOf(() => h.dio.get<dynamic>('/x'));
    expect(h.calls, ['pwd-gate']);
  });

  test(
      'extra skipViewLocation suprime el header aunque haya ubicación activa '
      '(/me y /locations/selectable — WHY en interceptors.dart)', () async {
    final h = build(
      viewLocation: 'loc-centro',
      respond: () => jsonRes(200, {'ok': true}),
    );
    await h.dio.get<dynamic>(
      '/x',
      options: Options(extra: {AuthInterceptor.skipViewLocation: true}),
    );
    expect(
      h.adapter.last!.headers.containsKey(AuthInterceptor.viewLocationHeader),
      isFalse,
    );
    expect(
      h.adapter.last!.headers['Authorization'],
      isNotNull,
      reason: 'solo salta la ubicación, el bearer va igual',
    );
  });

  test(
      'AuthApi REAL: ni /me ni /change-password mandan x-view-location con '
      'sede activa (MUST-1 review H3 — sede revocada + reset de contraseña '
      'dejaría al usuario atrapado en el gate)', () async {
    final h = build(
      viewLocation: 'loc-revocada',
      respond: () => jsonRes(200, readAuthFixture()),
    );
    final api = AuthApi(authedDio: h.dio, publicDio: Dio(), bareDio: Dio());

    await api.me();
    expect(h.adapter.last!.path, '/api/auth/me');
    expect(
      h.adapter.last!.headers.containsKey(AuthInterceptor.viewLocationHeader),
      isFalse,
      reason: '/me devuelve req.user YA reducido por el header',
    );

    await api.changePassword(currentPassword: 'Temp#1', newPassword: 'Nueva#2');
    expect(h.adapter.last!.path, '/api/auth/change-password');
    expect(
      h.adapter.last!.headers.containsKey(AuthInterceptor.viewLocationHeader),
      isFalse,
      reason: 'el gate de contraseña debe poder levantarse aunque la sede '
          'fijada ya no exista en el set del usuario',
    );
  });

  group('ApiError.fromDio — mapeo puro de kinds', () {
    ApiError map(int status, {Map<String, Object?>? body}) {
      final ro = RequestOptions(path: '/x');
      return ApiError.fromDio(
        DioException(
          requestOptions: ro,
          type: DioExceptionType.badResponse,
          response: Response<dynamic>(
            requestOptions: ro,
            statusCode: status,
            data: body ?? {'error': 'mensaje del backend'},
          ),
        ),
      );
    }

    test('tabla status → kind', () {
      expect(map(401).kind, ApiErrorKind.unauthorized);
      expect(
        map(403, body: {'error': 'x', 'code': 'PASSWORD_CHANGE_REQUIRED'})
            .kind,
        ApiErrorKind.passwordChangeRequired,
      );
      expect(map(403).kind, ApiErrorKind.forbidden);
      expect(map(409).kind, ApiErrorKind.conflict);
      expect(map(410).kind, ApiErrorKind.gone);
      expect(map(429).kind, ApiErrorKind.rateLimited);
      expect(map(400).kind, ApiErrorKind.badRequest);
      expect(map(422).kind, ApiErrorKind.badRequest);
      expect(map(500).kind, ApiErrorKind.server);
      expect(map(503).kind, ApiErrorKind.server);
    });

    test('conserva message, code y status del backend', () {
      final e = map(409, body: {'error': 'boom', 'code': 'ENTRY_GUARD'});
      expect(e.message, 'boom');
      expect(e.code, 'ENTRY_GUARD');
      expect(e.status, 409);
    });

    test('sin respuesta (timeout/DNS) → network', () {
      final ro = RequestOptions(path: '/x');
      final e = ApiError.fromDio(
        DioException(
          requestOptions: ro,
          type: DioExceptionType.connectionError,
        ),
      );
      expect(e.kind, ApiErrorKind.network);
    });
  });
}
