import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/dio_factory.dart';
import 'package:rideops/core/api/interceptors.dart';
import 'package:rideops/core/api/locations_api.dart';
import 'package:rideops/core/api/token_refresher.dart';

import 'helpers/auth_test_helpers.dart';

/// Herencia QA-H3: test ESPEJO del skip de x-view-location con el
/// [LocationsApi] REAL sobre el stack autenticado real (DioFactory +
/// AuthInterceptor + adapter capturado) — el test del interceptor prueba que
/// `skipViewLocation` funciona; este prueba que /selectable de verdad LO USA.
/// Si alguien borra el `Options(extra: ...)` de LocationsApi.selectable, el
/// selector quedaría envenenado por la sede activa y solo este test lo ve.

class CaptureAdapter implements HttpClientAdapter {
  CaptureAdapter(this.respond);

  final ResponseBody Function(RequestOptions options) respond;
  final captured = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    captured.add(options);
    return respond(options);
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  test(
      '/selectable en el Dio autenticado REAL: bearer SÍ, x-view-location NO '
      'aunque haya sede activa', () async {
    final token = fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)));
    final adapter = CaptureAdapter(
      (options) => ResponseBody.fromString(
        json.encode([
          {'id': 'loc-centro', 'name': 'Patio Centro'},
          {'id': 'loc-aero', 'name': 'Sucursal Aeropuerto'},
        ]),
        200,
        headers: {
          Headers.contentTypeHeader: ['application/json'],
        },
      ),
    );
    final dio = DioFactory(baseUrl: 'https://rideops.test').buildAuthedDio(
      refresher: TokenRefresher(
        readToken: () async => token,
        doRefresh: (t) async => t,
        storeToken: (_) async {},
      ),
      // Sede activa PINNEADA: cualquier ruta normal llevaría el header.
      readViewLocation: () => 'loc-centro',
      onSessionExpired: () {},
    );
    dio.httpClientAdapter = adapter;

    final list = await LocationsApi(authedDio: dio).selectable();

    expect(list, hasLength(2));
    expect(list.first.name, 'Patio Centro');
    final req = adapter.captured.single;
    expect(req.headers['Authorization'], 'Bearer $token');
    expect(
      req.headers.containsKey(AuthInterceptor.viewLocationHeader),
      isFalse,
      reason: 'con el header, el backend encogería la lista a la sede activa '
          'y el usuario no podría salirse de una sede denegada (4D)',
    );

    // Control: una ruta scoped normal por el MISMO Dio sí lleva el header —
    // el skip es de /selectable, no un apagón global.
    await dio.get<dynamic>('/api/employee-app/dashboard');
    expect(
      adapter.captured.last.headers[AuthInterceptor.viewLocationHeader],
      'loc-centro',
    );
  });
}
