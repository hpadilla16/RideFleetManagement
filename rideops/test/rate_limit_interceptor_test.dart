import 'dart:math';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/interceptors.dart';

/// Adaptador falso: entrega respuestas en orden y cuenta cuántas veces le
/// pegaron — suficiente para verificar reintentos sin red real.
class SeqAdapter implements HttpClientAdapter {
  SeqAdapter(this.responses);

  final List<ResponseBody> responses;
  int calls = 0;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    calls++;
    return responses.removeAt(0);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody res(int status, {String? retryAfter}) => ResponseBody.fromString(
      '{}',
      status,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
        if (retryAfter != null) 'retry-after': [retryAfter],
      },
    );

Dio buildDio(SeqAdapter adapter) {
  final dio = Dio(BaseOptions(baseUrl: 'https://rideops.test'));
  dio.httpClientAdapter = adapter;
  // baseDelayMs: 1 — los tests no esperan medio segundo real por intento.
  dio.interceptors.add(RateLimitRetryInterceptor(dio, baseDelayMs: 1));
  return dio;
}

void main() {
  test('Retry-After actúa como PISO del delay aunque el backoff sea menor',
      () {
    final i = RateLimitRetryInterceptor(Dio(), random: Random(7));
    // Backoff local del intento 0 = 500 ms; el servidor pide 10 s.
    final d = i.delayFor(0, retryAfterSeconds: 10);
    expect(d.inMilliseconds, inInclusiveRange(10000, 10249));
  });

  test('si el backoff local supera el Retry-After, gana el backoff', () {
    final i = RateLimitRetryInterceptor(Dio(), random: Random(7));
    // Intento 5 → 500 * 32 = 16000 ms > 1000 ms del servidor.
    final d = i.delayFor(5, retryAfterSeconds: 1);
    expect(d.inMilliseconds, inInclusiveRange(16000, 16249));
  });

  test('sin Retry-After el delay es solo backoff exponencial + jitter', () {
    final i = RateLimitRetryInterceptor(Dio(), random: Random(7));
    expect(i.delayFor(0).inMilliseconds, inInclusiveRange(500, 749));
    expect(i.delayFor(2).inMilliseconds, inInclusiveRange(2000, 2249));
  });

  test('el jitter viene de Random inyectable (determinista con semilla)', () {
    final a = RateLimitRetryInterceptor(Dio(), random: Random(42));
    final b = RateLimitRetryInterceptor(Dio(), random: Random(42));
    expect(a.delayFor(0), b.delayFor(0),
        reason: 'misma semilla, mismo jitter — ya no depende del reloj');
  });

  test('503 GET con Retry-After se reintenta y acaba en 200', () async {
    final adapter = SeqAdapter([res(503, retryAfter: '0'), res(200)]);
    final dio = buildDio(adapter);
    final r = await dio.get<dynamic>('/x');
    expect(r.statusCode, 200);
    expect(adapter.calls, 2);
  });

  test('503 SIN Retry-After no se reintenta (outage, no throttle)', () async {
    final adapter = SeqAdapter([res(503)]);
    final dio = buildDio(adapter);
    await expectLater(dio.get<dynamic>('/x'), throwsA(isA<DioException>()));
    expect(adapter.calls, 1);
  });

  test('503 POST con Retry-After NO se reintenta (solo GET/HEAD)', () async {
    final adapter = SeqAdapter([res(503, retryAfter: '0')]);
    final dio = buildDio(adapter);
    await expectLater(dio.post<dynamic>('/x'), throwsA(isA<DioException>()));
    expect(adapter.calls, 1,
        reason: 'un POST jamás se re-manda a ciegas desde aquí (ADR-5)');
  });

  test('429 GET se sigue reintentando como antes', () async {
    final adapter = SeqAdapter([res(429), res(200)]);
    final dio = buildDio(adapter);
    final r = await dio.get<dynamic>('/x');
    expect(r.statusCode, 200);
    expect(adapter.calls, 2);
  });

  test('tope de reintentos: tras maxRetries se rinde y propaga el error',
      () async {
    final adapter = SeqAdapter([res(429), res(429), res(429), res(429)]);
    final dio = buildDio(adapter);
    await expectLater(dio.get<dynamic>('/x'), throwsA(isA<DioException>()));
    expect(adapter.calls, 4, reason: '1 original + 3 reintentos');
  });

  test('503 con Retry-After no numérico NO se reintenta', () async {
    final adapter = SeqAdapter([res(503, retryAfter: 'Wed, 21 Oct 2026')]);
    final dio = buildDio(adapter);
    await expectLater(dio.get<dynamic>('/x'), throwsA(isA<DioException>()));
    expect(adapter.calls, 1);
  });
}
