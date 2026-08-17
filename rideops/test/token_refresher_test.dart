import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/token_refresher.dart';

String fakeJwt({required DateTime exp}) {
  final header = base64Url.encode(utf8.encode('{"alg":"HS256","typ":"JWT"}'));
  final payload = base64Url.encode(
    utf8.encode(json.encode({'sub': 'u1', 'exp': exp.millisecondsSinceEpoch ~/ 1000})),
  );
  return '$header.$payload.firma';
}

void main() {
  final now = DateTime.utc(2026, 8, 16, 12, 0, 0);

  test('token lejos del exp pasa tal cual, sin refresh', () async {
    var refreshes = 0;
    final token = fakeJwt(exp: now.add(const Duration(hours: 2)));
    final r = TokenRefresher(
      readToken: () async => token,
      doRefresh: (t) async {
        refreshes++;
        return 'nuevo';
      },
      storeToken: (_) async {},
    );
    expect(await r.freshToken(now: () => now), token);
    expect(refreshes, 0);
  });

  test('dentro de la ventana de 60s refresca y guarda', () async {
    var stored = '';
    final old = fakeJwt(exp: now.add(const Duration(seconds: 30)));
    final fresh = fakeJwt(exp: now.add(const Duration(hours: 12)));
    final r = TokenRefresher(
      readToken: () async => old,
      doRefresh: (t) async => fresh,
      storeToken: (t) async => stored = t,
    );
    expect(await r.freshToken(now: () => now), fresh);
    expect(stored, fresh);
  });

  test('vencido devuelve null (re-login) y NO llama refresh', () async {
    var refreshes = 0;
    final dead = fakeJwt(exp: now.subtract(const Duration(minutes: 1)));
    final r = TokenRefresher(
      readToken: () async => dead,
      doRefresh: (t) async {
        refreshes++;
        return 'nuevo';
      },
      storeToken: (_) async {},
    );
    expect(await r.freshToken(now: () => now), isNull);
    expect(refreshes, 0, reason: 'ADR-3a: refresh tras vencer daría 401 igual');
  });

  test('mutex: N llamadas concurrentes → UN solo refresh', () async {
    var refreshes = 0;
    final old = fakeJwt(exp: now.add(const Duration(seconds: 30)));
    final fresh = fakeJwt(exp: now.add(const Duration(hours: 12)));
    final gate = Completer<void>();
    final r = TokenRefresher(
      readToken: () async => old,
      doRefresh: (t) async {
        refreshes++;
        await gate.future;
        return fresh;
      },
      storeToken: (_) async {},
    );
    final calls = [
      r.freshToken(now: () => now),
      r.freshToken(now: () => now),
      r.freshToken(now: () => now),
    ];
    gate.complete();
    final results = await Future.wait(calls);
    expect(refreshes, 1);
    expect(results, everyElement(fresh));
  });

  test('si el refresh falla, devuelve el token viejo aún válido', () async {
    final old = fakeJwt(exp: now.add(const Duration(seconds: 30)));
    final r = TokenRefresher(
      readToken: () async => old,
      doRefresh: (t) async => throw Exception('red caída'),
      storeToken: (_) async {},
    );
    expect(await r.freshToken(now: () => now), old);
  });

  test('expiryOf lee exp y tolera basura', () {
    final exp = DateTime.utc(2026, 8, 16, 23, 59, 0);
    expect(TokenRefresher.expiryOf(fakeJwt(exp: exp)), exp);
    expect(TokenRefresher.expiryOf('no-es-un-jwt'), isNull);
    expect(TokenRefresher.expiryOf('a.b.c'), isNull);
  });
}
