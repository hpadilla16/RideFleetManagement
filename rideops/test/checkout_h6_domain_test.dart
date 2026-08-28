import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/dto/checkout_session.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/features/checkout/domain/checkout_attribution.dart';
import 'package:rideops/features/checkout/domain/checkout_changes.dart';
import 'package:rideops/features/checkout/domain/checkout_event_log.dart';
import 'package:rideops/features/checkout/domain/checkout_presence.dart';
import 'package:rideops/features/checkout/presentation/checkout_labels.dart';

import 'helpers/checkout_test_helpers.dart';

/// Dominio de M2-H6 — reconciliación multi-superficie.
///
/// Todo lo que se prueba aquí es una AFIRMACIÓN: cuándo la app puede decir
/// quién hizo qué, y cuándo tiene que callarse. La regla que atraviesa el
/// archivo entero es la misma que el módulo de presencia del backend:
/// **se puede afirmar presencia, jamás soledad**, y nunca se inventa un
/// culpable.

void main() {
  final now = DateTime.utc(2026, 8, 28, 10, 30);

  CheckoutPresenceDto p(
    String surface, {
    required String name,
    required Duration age,
    String? actorUserId,
  }) =>
      CheckoutPresenceDto(
        surface: surface,
        displayName: name,
        lastSeenAt: now.subtract(age),
        actorUserId: actorUserId,
      );

  group('CheckoutSurface — espejo del enum de Prisma (M2-H6)', () {
    test('el wire es el que el backend valida en normalizeSurface', () {
      expect(CheckoutSurface.rideops.wire, 'RIDEOPS');
      expect(CheckoutSurface.counter.wire, 'COUNTER');
      expect(CheckoutSurface.kiosk.wire, 'KIOSK');
      expect(CheckoutSurface.customer.wire, 'CUSTOMER');
    });

    test('una superficie desconocida NO tumba nada: sale null', () {
      expect(CheckoutSurface.tryParse('VOZIA'), isNull);
      expect(CheckoutSurface.tryParse(null), isNull);
    });

    test('aparato vs persona: el kiosco y el teléfono del cliente laten sin '
        'usuario a propósito', () {
      expect(CheckoutSurface.kiosk.isDevice, isTrue);
      expect(CheckoutSurface.customer.isDevice, isTrue);
      expect(CheckoutSurface.counter.isDevice, isFalse);
      expect(CheckoutSurface.rideops.isDevice, isFalse);
    });
  });

  group('presenceRoster (hoja 20B)', () {
    test('clasifica aparato y persona, y ordena por el más reciente', () {
      final roster = presenceRoster(
        [
          p('KIOSK', name: 'Kiosk', age: const Duration(seconds: 31)),
          p('COUNTER', name: 'Diego Torres', age: const Duration(seconds: 4)),
        ],
        now,
      );
      expect(roster.map((r) => r.displayName), ['Diego Torres', 'Kiosk']);
      expect(roster.first.isDevice, isFalse);
      expect(roster.first.freshness, PresenceFreshness.live);
      expect(roster.last.isDevice, isTrue);
      expect(roster.last.freshness, PresenceFreshness.fading);
    });

    test('una superficie DESCONOCIDA no se declara aparato: sin saber qué es, '
        'no se le quita el nombre a quien podría tenerlo', () {
      final roster = presenceRoster(
        [p('VOZIA', name: 'Alguien', age: const Duration(seconds: 3))],
        now,
      );
      expect(roster.single.surface, isNull);
      expect(roster.single.isDevice, isFalse);
    });

    test('el pasado el TTL no se pinta (el chip no puede afirmar lo que el '
        'heartbeat ya no sostiene)', () {
      final roster = presenceRoster(
        [p('COUNTER', name: 'Diego', age: const Duration(seconds: 46))],
        now,
      );
      expect(roster, isEmpty);
    });

    test('nunca se lista uno mismo — el filtro que H6 enciende junto al latido',
        () {
      final roster = presenceRoster(
        [
          p('RIDEOPS', name: 'Ana Ruiz', age: Duration.zero,
              actorUserId: kMyUserId),
          p('COUNTER', name: 'Diego', age: Duration.zero, actorUserId: 'u-99'),
        ],
        now,
        myUserId: kMyUserId,
      );
      expect(roster.map((r) => r.displayName), ['Diego']);
    });

    test('null y [] son indistinguibles por contrato: los dos dan lista vacía '
        '(y quien la pinta dice "nadie visible", no "estás solo")', () {
      expect(presenceRoster(null, now), isEmpty);
      expect(presenceRoster(const [], now), isEmpty);
    });
  });

  group('hasLiveDevicePresence (aviso 23B)', () {
    test('solo cuenta el aparato VIVO: "ahora mismo" con 40 s no es ahora', () {
      final fading = presenceRoster(
        [p('KIOSK', name: 'Kiosk', age: const Duration(seconds: 30))],
        now,
      );
      expect(hasLiveDevicePresence(fading), isFalse);

      final live = presenceRoster(
        [p('KIOSK', name: 'Kiosk', age: const Duration(seconds: 5))],
        now,
      );
      expect(hasLiveDevicePresence(live), isTrue);
    });

    test('una PERSONA viva no dispara el aviso del kiosco', () {
      final roster = presenceRoster(
        [p('COUNTER', name: 'Diego', age: Duration.zero)],
        now,
      );
      expect(hasLiveDevicePresence(roster), isFalse);
    });
  });

  group('resolveActorName — el único consumo de presence[].actorUserId', () {
    CheckoutEvent event(String? actor) =>
        CheckoutEvent(kind: 'TRANSITION', to: 'PAID', actorUserId: actor);

    test('HOY el serializer no manda el id ⇒ sin nombre, y el copy cae al '
        'genérico de H1 en vez de a un hueco', () {
      // Exactamente lo que devuelve `activePresence()` en main: sin actorUserId.
      final names = presenceNamesById([
        p('COUNTER', name: 'Diego Torres', age: Duration.zero),
      ]);
      expect(names, isEmpty);
      expect(
        resolveActorName(event('u-99'), namesById: names, myUserId: kMyUserId),
        isNull,
      );
    });

    test('cuando el backend lo emita, el nombre aparece sin tocar la UI', () {
      final names = presenceNamesById([
        p('COUNTER', name: 'Diego Torres', age: Duration.zero,
            actorUserId: 'u-99'),
      ]);
      expect(
        resolveActorName(event('u-99'), namesById: names, myUserId: kMyUserId),
        'Diego Torres',
      );
    });

    test('a uno mismo no se le llama por su nombre: eso se dice con "tú"', () {
      final names = presenceNamesById([
        p('RIDEOPS', name: 'Ana Ruiz', age: Duration.zero,
            actorUserId: kMyUserId),
      ]);
      expect(
        resolveActorName(event(kMyUserId), namesById: names,
            myUserId: kMyUserId),
        isNull,
      );
    });

    test('una fila con id pero sin nombre no se indexa: dibujaría "lo completó "'
        ' con un hueco al final', () {
      final names = presenceNamesById([
        p('COUNTER', name: '', age: Duration.zero, actorUserId: 'u-99'),
      ]);
      expect(names, isEmpty);
    });
  });

  group('stampIsCurrentStepBusiness — qué sello merece banner (21C)', () {
    test('el sello que ESTE paso está esperando NO es noticia ajena', () {
      // TC_PENDING existe para que caiga tcCompletedAt: anunciárselo al agente
      // como "otra superficie lo registró" sería contarle su propio trabajo.
      expect(
        stampIsCurrentStepBusiness(
          kind: CheckoutStampKind.tc,
          currentStep: CheckoutStep.tcPending,
        ),
        isTrue,
      );
      expect(
        stampIsCurrentStepBusiness(
          kind: CheckoutStampKind.signature,
          currentStep: CheckoutStep.customerSignPending,
        ),
        isTrue,
      );
    });

    test('el sello de un tramo YA PASADO sí lo es — el frame 21C exacto', () {
      // El mostrador registra el pago mientras el agente teclea el odómetro.
      expect(
        stampIsCurrentStepBusiness(
          kind: CheckoutStampKind.payment,
          currentStep: CheckoutStep.inspectionInProgress,
        ),
        isFalse,
      );
    });

    test('con un paso fuera del catálogo se calla: sin certeza no se le mete '
        'un aviso más a alguien que está capturando', () {
      expect(
        stampIsCurrentStepBusiness(
          kind: CheckoutStampKind.payment,
          currentStep: null,
        ),
        isTrue,
      );
    });
  });

  group('buildChangeSet (hoja 21B)', () {
    test('separa lo que CAYÓ mientras mirabas de lo que ya estaba, y no '
        'esconde lo pendiente', () {
      final baseline = sessionAt(CheckoutStep.tcPending,
          tc: null, payment: DateTime.utc(2026, 8, 28, 10, 0));
      final current = sessionAt(
        CheckoutStep.paymentPending,
        tc: DateTime.utc(2026, 8, 28, 10, 27),
        payment: DateTime.utc(2026, 8, 28, 10, 0),
      );
      final set = buildChangeSet(
        baseline: baseline,
        current: current,
        observedAt: now,
        myUserId: kMyUserId,
      );
      final byKind = {for (final s in set.stamps) s.kind: s};
      expect(byKind[CheckoutStampKind.tc]!.status, CheckoutStampStatus.landed);
      expect(byKind[CheckoutStampKind.payment]!.status,
          CheckoutStampStatus.wasAlreadyDone);
      expect(byKind[CheckoutStampKind.inspection]!.status,
          CheckoutStampStatus.pending);
      expect(set.stamps, hasLength(4), reason: 'inventario, no novedades');
      expect(set.stepMoved, isTrue);
      expect(set.stepFrom, 'TC_PENDING');
      expect(set.stepTo, 'PAYMENT_PENDING');
      expect(set.hasChanges, isTrue);
    });

    test('sin baseline (se entra a media sesión) NO se afirma que algo cayó '
        'mientras mirabas: se dice lo conservador', () {
      final set = buildChangeSet(
        baseline: null,
        current: sessionAt(CheckoutStep.paymentPending,
            tc: DateTime.utc(2026, 8, 28, 10, 27)),
        observedAt: now,
      );
      final tc = set.stamps
          .firstWhere((s) => s.kind == CheckoutStampKind.tc);
      expect(tc.status, CheckoutStampStatus.wasAlreadyDone);
      expect(set.stepMoved, isFalse);
      expect(set.hasChanges, isFalse);
    });

    test('la atribución sale del TRANSITION hacia el paso que el sello abre, '
        'y con el log ilegible se calla en vez de inventar', () {
      final raw = rawCheckoutSession();
      raw['currentStep'] = 'PAYMENT_PENDING';
      raw['tcCompletedAt'] = '2026-08-28T10:27:00.000Z';
      raw['events'] = json.encode([
        {
          'kind': 'TRANSITION',
          'to': 'TC_SIGNED',
          'actorUserId': null,
          'metadata': {'kiosk': true},
          'at': '2026-08-28T10:27:05.000Z',
        },
      ]);
      final withLog = buildChangeSet(
        baseline: null,
        current: sessionFromRaw(raw),
        observedAt: now,
        myUserId: kMyUserId,
      );
      expect(
        withLog.stamps.firstWhere((s) => s.kind == CheckoutStampKind.tc).actor,
        CheckoutActorKind.kiosk,
      );

      raw['events'] = '{no es json';
      final broken = buildChangeSet(
        baseline: null,
        current: sessionFromRaw(raw),
        observedAt: now,
        myUserId: kMyUserId,
      );
      expect(
        broken.stamps.firstWhere((s) => s.kind == CheckoutStampKind.tc).actor,
        isNull,
        reason: 'log ilegible ⇒ "completado" a secas, jamás un culpable',
      );
    });
  });

  group('phaseProgress (pill "3 de 5 fases" de la antesala)', () {
    test('cuenta solo las fases CERRADAS que reporta el servidor', () {
      expect(phaseProgress(6), (done: 3, total: 5));
      expect(phaseProgress(1), (done: 0, total: 5));
    });

    test('sin posición (paso desconocido) no se afirma progreso', () {
      expect(phaseProgress(null), (done: 0, total: 5));
    });
  });

  group('initialsOf (avatar de PERSONA, nunca de aparato)', () {
    test('dos iniciales como máximo', () {
      expect(initialsOf('Diego Torres'), 'DT');
      expect(initialsOf('María de los Ángeles Ruiz'), 'MD');
      expect(initialsOf('  ana  '), 'A');
    });

    test('nombre vacío ⇒ marcador neutro, no una letra inventada', () {
      expect(initialsOf(''), '·');
      expect(initialsOf('   '), '·');
    });
  });
}
