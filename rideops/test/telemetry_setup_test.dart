import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/core/telemetry/sentry_setup.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

/// Cableado de observabilidad (QA de milestone M1): el paquete estaba en el
/// pubspec pero nadie inicializaba Sentry. Estos tests clavan las dos piezas
/// que sí se pueden probar sin levantar el SDK: la selección de logger y el
/// scrub de PII del `beforeSend`.
void main() {
  group('pickEventLogger', () {
    test('sin DSN en release: nadie reporta y nadie imprime', () {
      final logger = pickEventLogger(sentryEnabled: false, debugMode: false);
      expect(logger, isA<NoopEventLogger>());
    });

    test('sin DSN en debug: imprime para verificar la taxonomía', () {
      final logger = pickEventLogger(sentryEnabled: false, debugMode: true);
      expect(logger, isA<DebugEventLogger>());
    });

    test('con DSN: gana Sentry aunque sea debug', () {
      expect(
        pickEventLogger(sentryEnabled: true, debugMode: true),
        isA<SentryEventLogger>(),
      );
      expect(
        pickEventLogger(sentryEnabled: true, debugMode: false),
        isA<SentryEventLogger>(),
      );
    });

    test('SentryEventLogger sin SDK inicializado no truena', () {
      // El caso real de los tests y de un arranque sin DSN: el Hub es no-op.
      const logger = SentryEventLogger();
      expect(
        () => logger.log(AuthEvents.loginOk, data: const {'fail_reason': null}),
        returnsNormally,
      );
      expect(() => logger.log(OutboxEvents.enqueued), returnsNormally);
    });
  });

  group('scrubSentryEvent', () {
    test('redacta el JWT de staff y deja el resto intacto', () {
      final event = SentryEvent(
        request: SentryRequest(
          headers: const {
            'Authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.REAL.TOKEN',
            'x-view-location': 'loc-123',
            'Accept': 'application/json',
          },
        ),
      );

      final scrubbed = scrubSentryEvent(event)!;
      final headers = scrubbed.request!.headers;

      expect(headers['Authorization'], '[redacted]');
      expect(headers['Authorization'], isNot(contains('eyJ')));
      // La sede activa no es secreto: sirve para diagnosticar y ya viaja como
      // tag de la taxonomía.
      expect(headers['x-view-location'], 'loc-123');
      expect(headers['Accept'], 'application/json');
    });

    test('es insensible a mayúsculas en el nombre de la cabecera', () {
      final event = SentryEvent(
        request: SentryRequest(
          headers: const {'authorization': 'Bearer x', 'COOKIE': 'a=b'},
        ),
      );
      final headers = scrubSentryEvent(event)!.request!.headers;
      expect(headers['authorization'], '[redacted]');
      expect(headers['COOKIE'], '[redacted]');
    });

    test('evento sin request pasa tal cual', () {
      final event = SentryEvent();
      expect(scrubSentryEvent(event), same(event));
    });

    test('request sin cabeceras sensibles pasa sin copiar', () {
      final event = SentryEvent(
        request: SentryRequest(headers: const {'Accept': 'application/json'}),
      );
      expect(scrubSentryEvent(event), same(event));
    });
  });
}
