import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/dto/session_user.dart';
import 'package:rideops/core/outbox/background_drain.dart';

import 'helpers/auth_test_helpers.dart';

/// Decisión de corte del worker de background (INN S-2, review H6): la
/// identidad viene ENTERA del JWT — sin Riverpod, sin Keystore, sin red.
/// `null` = la tarea de WorkManager se consume con `true` (no hay nada que
/// drenar ni sentido en reintentar).
void main() {
  final live = DateTime.now().add(const Duration(hours: 8));
  final dead = DateTime.now().subtract(const Duration(minutes: 5));

  test('token vivo: identidad con sub y tenantId de los claims', () async {
    final jwt = fakeJwt(
      exp: live,
      sub: 'u-42',
      extraClaims: {'tenantId': 't-7'},
    );
    final id = await resolveBackgroundIdentity(readToken: () async => jwt);
    expect(id, isNotNull);
    expect(id!.userId, 'u-42');
    expect(id.tenantId, 't-7');
    expect(id.token, jwt);
  });

  test('token VENCIDO (el JWT de 12 h acota el background al turno) → null',
      () async {
    final jwt = fakeJwt(exp: dead, sub: 'u-42');
    // El reloj se inyecta: el caso ">15 min en el bolsillo, turno terminado"
    // no depende del reloj real del harness.
    final id = await resolveBackgroundIdentity(
      readToken: () async => jwt,
      now: DateTime.now,
    );
    expect(id, isNull, reason: 'el background jamás re-loguea');
  });

  test('vencimiento decidido con el reloj INYECTADO, no el del sistema',
      () async {
    final jwt = fakeJwt(exp: live, sub: 'u-42');
    final afterShift = live.add(const Duration(minutes: 1));
    final id = await resolveBackgroundIdentity(
      readToken: () async => jwt,
      now: () => afterShift,
    );
    expect(id, isNull);
  });

  test('sin token (nadie logueado) → null', () async {
    expect(
      await resolveBackgroundIdentity(readToken: () async => null),
      isNull,
    );
    expect(
      await resolveBackgroundIdentity(readToken: () async => ''),
      isNull,
    );
  });

  test('Keystore ROTO (lanza): null — jamás reintento eterno (INN O-1)',
      () async {
    final id = await resolveBackgroundIdentity(
      readToken: () async => throw StateError('keystore corrupto'),
    );
    expect(id, isNull);
  });

  test('token sin claim sub (irreconocible) → null', () async {
    final id = await resolveBackgroundIdentity(
      readToken: () async => 'no.es.jwt',
    );
    expect(id, isNull);
  });

  test('sin claim tenantId: cadena vacía (mismo default del enqueue owner)',
      () async {
    final jwt = fakeJwt(exp: live, sub: 'u-42');
    final id = await resolveBackgroundIdentity(readToken: () async => jwt);
    expect(id!.tenantId, '');
  });

  test(
      'PARIDAD (INN S-3): el claim tenantId del JWT (auth.service.js:19) '
      'espeja el user.tenantId de /me — mismas filas del outbox en '
      'foreground y background', () async {
    // Fixture REAL del serializer de login: si el shape del user o el del
    // claim divergen algún día, este test truena en vez de degradar el
    // drenado de background en silencio (dueño distinto ⇒ 0 filas).
    final raw = readAuthFixture();
    final user = SessionUser.fromJson(raw['user'] as Map<String, dynamic>);
    expect(user.tenantId, isNotNull,
        reason: 'el fixture debe traer tenantId — sin él no hay paridad que probar');

    final jwt = fakeJwt(
      exp: live,
      sub: user.id,
      extraClaims: {
        'email': user.email,
        'role': user.role,
        'tenantId': user.tenantId,
      },
    );
    final id = await resolveBackgroundIdentity(readToken: () async => jwt);
    expect(id!.userId, user.id,
        reason: 'sub del claim == user.id de /me (dueño de las filas)');
    expect(id.tenantId, user.tenantId,
        reason: 'tenant del claim == tenant de /me (aislamiento por tenant)');
  });
}
