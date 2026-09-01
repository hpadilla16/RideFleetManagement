import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/dto/checkout_session.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/features/checkout/domain/checkout_event_log.dart';
import 'package:rideops/features/checkout/domain/checkout_presence.dart';
import 'package:rideops/features/checkout/domain/checkout_step_catalog.dart';

import 'helpers/auth_test_helpers.dart';

/// Reglas de dominio del wizard (M2-H1): catálogo de PRESENTACIÓN de los
/// pasos, lectura del events log y frescura de la presencia. Todo puro —
/// ninguna de estas funciones puede decidir un paso.

Map<String, dynamic> _fixture(String name) =>
    json.decode(File('test/fixtures/$name').readAsStringSync())
        as Map<String, dynamic>;

void main() {
  group('catálogo de pasos', () {
    test('la cadena lineal son 10 pasos, en orden, sin CANCELLED', () {
      expect(kCheckoutLinearSteps, hasLength(kCheckoutLinearStepCount));
      expect(kCheckoutLinearStepCount, 10);
      expect(
        kCheckoutLinearSteps.map((s) => s.step),
        isNot(contains(CheckoutStep.cancelled)),
        reason: 'CANCELLED es salida alterna desde cualquier paso no '
            'terminal, no el paso 11 de una fila',
      );
      for (var i = 0; i < kCheckoutLinearSteps.length; i++) {
        expect(kCheckoutLinearSteps[i].position, i + 1);
      }
    });

    test('los 4 entry guards espejan ENTRY_REQUIRES del backend', () {
      Map<CheckoutStep, CheckoutEntryGuard?> guards() => {
            for (final s in kCheckoutLinearSteps) s.step: s.entryGuard,
          };
      expect(guards()[CheckoutStep.tcSigned], CheckoutEntryGuard.tcCompleted);
      expect(guards()[CheckoutStep.paid], CheckoutEntryGuard.payment);
      expect(
        guards()[CheckoutStep.customerSignPending],
        CheckoutEntryGuard.inspection,
      );
      expect(guards()[CheckoutStep.closed], CheckoutEntryGuard.signature);
      // Y ninguno más: un guard de más pintaría un candado que el backend no
      // aplica y bloquearía visualmente un paso legal.
      expect(
        kCheckoutLinearSteps.where((s) => s.entryGuard != null).length,
        4,
      );
    });

    test('infoFor tolera lo que no conoce (paso nuevo del backend)', () {
      expect(infoFor(CheckoutStep.tryParse('PASO_DEL_FUTURO')), isNull);
      expect(infoFor(CheckoutStep.cancelled), isNull);
      expect(infoFor(null), isNull);
    });

    test('el rail marca hecho/actual/pendiente desde la posición reportada',
        () {
      // Servidor en PAYMENT_PENDING (4): Confirmar y T&C hechas, Pago actual.
      const position = 4;
      expect(
        phaseStateFor(CheckoutPhase.confirm, position),
        PhaseNodeState.done,
      );
      expect(phaseStateFor(CheckoutPhase.terms, position), PhaseNodeState.done);
      expect(
        phaseStateFor(CheckoutPhase.payment, position),
        PhaseNodeState.current,
      );
      expect(
        phaseStateFor(CheckoutPhase.inspection, position),
        PhaseNodeState.pending,
      );
      expect(
        phaseStateFor(CheckoutPhase.closing, position),
        PhaseNodeState.pending,
      );
    });

    test('sin posición (paso desconocido) NADA se marca como hecho', () {
      for (final phase in kCheckoutPhases) {
        expect(phaseStateFor(phase, null), PhaseNodeState.pending);
      }
    });

    test('isAtOrPast: la pregunta que vuelve no-op un ILLEGAL_TRANSITION', () {
      expect(
        isAtOrPast(current: CheckoutStep.tcPending, target: CheckoutStep.tcPending),
        isTrue,
      );
      expect(
        isAtOrPast(current: CheckoutStep.paid, target: CheckoutStep.tcPending),
        isTrue,
      );
      expect(
        isAtOrPast(current: CheckoutStep.confirming, target: CheckoutStep.paid),
        isFalse,
      );
      // Fail-VISIBLE: sin certeza no se silencia un error.
      expect(
        isAtOrPast(current: CheckoutStep.cancelled, target: CheckoutStep.paid),
        isFalse,
      );
      expect(isAtOrPast(current: null, target: CheckoutStep.paid), isFalse);
    });

    test('stepsJumped es null cuando alguno cae fuera del catálogo', () {
      expect(
        stepsJumped(from: CheckoutStep.confirming, to: CheckoutStep.paid),
        4,
      );
      expect(
        stepsJumped(from: CheckoutStep.confirming, to: CheckoutStep.cancelled),
        isNull,
      );
    });
  });

  group('events log', () {
    test('lee el log real del fixture, incluidas filas SIN kind', () {
      final session =
          CheckoutSessionDto.fromJson(_fixture('checkout_session.json'));
      final events = parseCheckoutEvents(session.events);
      expect(events, hasLength(6));
      expect(events.first.kind, 'SESSION_STARTED');
      expect(events.first.isTransition, isFalse);
      // Fila legacy sin `kind` pero con destino: cuenta como transición.
      final legacy = events[2];
      expect(legacy.kind, isNull);
      expect(legacy.isTransition, isTrue);
      expect(legacy.to, 'TC_SIGNED');
    });

    test('atribución: kiosco por metadata, agente por actorUserId', () {
      final session =
          CheckoutSessionDto.fromJson(_fixture('checkout_session.json'));
      final events = parseCheckoutEvents(session.events);
      const me = 'cmdusr001fixture0000000001';

      final mine = lastTransitionTo(events, 'TC_PENDING')!;
      expect(mine.actorKind(me), CheckoutActorKind.you);
      expect(mine.actorKind('otro-usuario'), CheckoutActorKind.otherAgent);
      // Sin identidad (sesión degradada sin /me) jamás se afirma "ti".
      expect(mine.actorKind(null), CheckoutActorKind.otherAgent);

      final kiosk = lastTransitionTo(events, 'INSPECTION_HANDOFF')!;
      expect(kiosk.actorUserId, isNull);
      expect(kiosk.kiosk, isTrue);
      expect(kiosk.actorKind(me), CheckoutActorKind.kiosk);
    });

    test('un actor nulo sin marca de kiosco es "otra superficie"', () {
      final events = parseCheckoutEvents(
        '[{"kind":"TRANSITION","to":"CLOSED","actorUserId":null,"at":"2026-08-16T14:20:00.000Z"}]',
      );
      expect(events.single.actorKind('u1'), CheckoutActorKind.otherSurface);
    });

    test('log corrupto o vacío degrada a lista vacía, no a excepción', () {
      expect(parseCheckoutEvents(null), isEmpty);
      expect(parseCheckoutEvents(''), isEmpty);
      expect(parseCheckoutEvents('no soy json'), isEmpty);
      expect(parseCheckoutEvents('{"kind":"no soy lista"}'), isEmpty);
      expect(parseCheckoutEvents('[1, "dos", null]'), isEmpty);
    });
  });

  group('presencia', () {
    CheckoutPresenceDto p(String surface, Duration ago, {String name = 'X'}) =>
        CheckoutPresenceDto(
          surface: surface,
          displayName: name,
          lastSeenAt: DateTime(2026, 8, 16, 14, 0).subtract(ago),
        );
    final now = DateTime(2026, 8, 16, 14, 0);

    test('el punto sale de la EDAD, no de un booleano del servidor', () {
      expect(
        presenceFreshness(now.subtract(const Duration(seconds: 8)), now),
        PresenceFreshness.live,
      );
      expect(
        presenceFreshness(now.subtract(const Duration(seconds: 32)), now),
        PresenceFreshness.fading,
      );
      expect(
        presenceFreshness(now.subtract(const Duration(seconds: 46)), now),
        PresenceFreshness.expired,
      );
      expect(presenceFreshness(null, now), PresenceFreshness.expired);
      // Reloj del teléfono adelantado: desfase, no ausencia.
      expect(
        presenceFreshness(now.add(const Duration(seconds: 5)), now),
        PresenceFreshness.live,
      );
    });

    test('se muestra la más reciente y se cuenta el resto (+N)', () {
      final chip = pickPresenceChip([
        p('COUNTER', const Duration(seconds: 30), name: 'Jorge'),
        p('KIOSK', const Duration(seconds: 6), name: 'María'),
      ], now);
      expect(chip!.entry.displayName, 'María');
      expect(chip.freshness, PresenceFreshness.live);
      expect(chip.others, 1);
    });

    test('presencias vencidas no se pintan (no se afirma lo que el TTL no da)',
        () {
      expect(
        pickPresenceChip([p('KIOSK', const Duration(seconds: 90))], now),
        isNull,
      );
      expect(pickPresenceChip(const [], now), isNull);
      expect(pickPresenceChip(null, now), isNull);
    });

    test('MINOR-5 / M2-H6: el filtro de "no me listes a mí mismo" está VIVO — '
        'y sin el campo del backend degrada a verse uno mismo', () {
      final rows = [
        p('KIOSK', const Duration(seconds: 6), name: 'María'),
        p('RIDEOPS', const Duration(seconds: 3), name: 'Yo mismo'),
      ];
      // Backend viejo (o superficie que late sin usuario): sin actorUserId el
      // filtro no puede actuar y el agente se ve. Es la degradación aceptada;
      // la alternativa —no pintar ninguna presencia de la propia superficie—
      // taparía a un compañero real en otro teléfono RideOps.
      expect(pickPresenceChip(rows, now, myUserId: 'u-yo')!.entry.displayName,
          'Yo mismo');

      // Con el campo que `activePresence()` ya emite (:184), el propio latido
      // desaparece del chip. Esto es lo que hace publicable a H6: es la
      // historia que ENCIENDE el heartbeat.
      final withActor = [
        rows.first,
        rows.last.copyWith(actorUserId: 'u-yo'),
      ];
      final chip = pickPresenceChip(withActor, now, myUserId: 'u-yo')!;
      expect(chip.entry.displayName, 'María');
      expect(chip.others, 0, reason: 'tampoco se cuenta en el "+N"');
    });

    test('el fixture de P1 pinta el chip del kiosco', () {
      final session = CheckoutSessionDto.fromJson(
        _fixture('checkout_session_presence.json'),
      );
      final chip = pickPresenceChip(
        session.presence,
        DateTime.parse('2026-08-16T14:04:00.000Z'),
        // Desde M2-H6 el fixture incluye la fila que RideOps escribe con el
        // usuario de ESTE teléfono: sin el filtro, el agente se vería a sí
        // mismo (y encabezando, porque es la más reciente).
        myUserId: kFixtureUserId,
      );
      expect(chip!.entry.surface, 'KIOSK');
      expect(chip.freshness, PresenceFreshness.live); // 8 s
      expect(chip.others, 1); // COUNTER a 29 s sigue dentro del TTL
    });
  });
}
