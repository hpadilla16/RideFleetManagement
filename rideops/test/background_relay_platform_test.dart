import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/outbox/background_drain.dart';

/// El relevo de background (H6 / ADR-7) solo debe agendarse donde EXISTE.
///
/// Por qué esta prueba existe: `workmanager` elige implementación por
/// `Platform`, y en Linux esa implementación es Dart plano que lanza
/// `systemd-run` con `Process.run`. El CI corre en ubuntu, así que el
/// coordinador estaba arrancando un proceso de verdad al encolar; los widget
/// tests morían con "Pending timers" y en Windows/macOS no se reproducía
/// (sin implementación / MissingPlugin tragado por el catch). De ahí la forma
/// de estas pruebas: TODAS corren igual en cualquier host, para que el
/// arreglo no dependa otra vez de en qué sistema se corrió la suite.
void main() {
  group('backgroundRelayAvailable', () {
    test('solo Android e iOS tienen relevo', () {
      // Android es el aparato del patio: si esto se pone en false, ADR-7
      // muere en silencio (la bandeja cifrada deja de drenar con la app
      // cerrada) y ninguna otra prueba grita.
      expect(backgroundRelayAvailable(operatingSystem: 'android'), isTrue);
      expect(backgroundRelayAvailable(operatingSystem: 'ios'), isTrue);

      for (final os in const ['linux', 'macos', 'windows', 'fuchsia']) {
        expect(
          backgroundRelayAvailable(operatingSystem: os),
          isFalse,
          reason: '$os no tiene relevo: agendar ahí lanza procesos o no hace '
              'nada',
        );
      }
    });
  });

  group('backgroundDrainSchedulerProvider', () {
    BackgroundDrainScheduler schedulerWith({bool? relayAvailable}) {
      final container = ProviderContainer(overrides: [
        if (relayAvailable != null)
          backgroundRelayAvailableProvider.overrideWithValue(relayAvailable),
      ]);
      addTearDown(container.dispose);
      return container.read(backgroundDrainSchedulerProvider);
    }

    test('con relevo disponible entrega el scheduler de WorkManager (Android)',
        () {
      // La rama que NO podemos ejercer desde el host: si alguien "arregla" el
      // CI cableando el no-op a secas, Android pierde el relevo y esto grita.
      expect(
        schedulerWith(relayAvailable: true),
        isA<WorkmanagerDrainScheduler>(),
      );
    });

    test('sin relevo entrega un no-op que no toca el plugin', () async {
      final scheduler = schedulerWith(relayAvailable: false);
      expect(scheduler, isA<NoopDrainScheduler>());
      // Y es un no-op de verdad: completa sin excepción y sin dejar nada
      // corriendo (el plugin de Linux dejaría un Process vivo aquí).
      await scheduler.ensureScheduled();
      await scheduler.cancel();
    });

    test(
        'cableado por defecto: en un host de test (nunca Android/iOS) NO se '
        'agenda nada', () {
      // Esta es la prueba que reproduce el fallo de CI en cualquier sistema:
      // sin overrides, el provider consulta la plataforma REAL del host y
      // `flutter test` nunca corre en Android ni en iOS. Si alguien deshace
      // el gate y vuelve a `const WorkmanagerDrainScheduler()`, esto falla en
      // Windows, en Linux y en macOS por igual.
      expect(
        Platform.isAndroid || Platform.isIOS,
        isFalse,
        reason: 'premisa de la prueba: la suite no corre en un móvil',
      );
      expect(schedulerWith(), isNot(isA<WorkmanagerDrainScheduler>()));
      expect(schedulerWith(), isA<NoopDrainScheduler>());
    });
  });
}
