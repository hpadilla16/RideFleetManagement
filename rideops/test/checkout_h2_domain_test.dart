import 'dart:convert';

import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/dto/reservation_display.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/core/config/app_config.dart';
import 'package:rideops/features/checkout/domain/checkout_confirm.dart';
import 'package:rideops/features/checkout/domain/terms_token.dart';

import 'helpers/checkout_test_helpers.dart';

/// Dominio de M2-H2: lo que decide qué se puede tocar (swap, switch del
/// seguro), qué falta capturar y qué dice el countdown del token.

void main() {
  group('swap: espejo de STEPS_BLOCKING_SWAP (vehicle-swap.service.js:25-31)',
      () {
    test('se ofrece hasta INSPECTION_HANDOFF y se retira en cuanto la '
        'inspección empieza', () {
      expect(swapAllowedFor(CheckoutStep.confirming), isTrue);
      expect(swapAllowedFor(CheckoutStep.tcPending), isTrue);
      expect(swapAllowedFor(CheckoutStep.tcSigned), isTrue);
      expect(swapAllowedFor(CheckoutStep.paymentPending), isTrue);
      expect(swapAllowedFor(CheckoutStep.paid), isTrue);
      expect(swapAllowedFor(CheckoutStep.inspectionHandoff), isTrue);
      // A partir de aquí el backend responde 409 SWAP_LOCKED: las fotos ya se
      // tomaron sobre el otro coche.
      expect(swapAllowedFor(CheckoutStep.inspectionInProgress), isFalse);
      expect(swapAllowedFor(CheckoutStep.customerSignPending), isFalse);
      expect(swapAllowedFor(CheckoutStep.finalizing), isFalse);
      expect(swapAllowedFor(CheckoutStep.closed), isFalse);
      expect(swapAllowedFor(CheckoutStep.cancelled), isFalse);
    });

    test('paso desconocido ⇒ NO se ofrece (fail-closed): sin certeza no se '
        'reescribe el contrato', () {
      expect(swapAllowedFor(null), isFalse);
    });
  });

  group('seguro declinado', () {
    test('sin columna del servidor, manda el último DECLINED_INSURANCE del '
        'events[]', () {
      final raw = rawCheckoutSession();
      raw['events'] = json.encode([
        {'kind': 'SESSION_STARTED', 'actorUserId': kMyUserId},
        {'kind': 'DECLINED_INSURANCE', 'declined': true, 'actorUserId': kMyUserId},
        {'kind': 'DECLINED_INSURANCE', 'declined': false, 'actorUserId': kMyUserId},
        {'kind': 'DECLINED_INSURANCE', 'declined': true, 'actorUserId': kMyUserId},
      ]);
      final session = sessionFromRaw(raw);
      expect(declinedInsuranceOf(session: session), isTrue);
    });

    test('sin eventos ⇒ false: nadie lo ha declinado nunca', () {
      expect(
        declinedInsuranceOf(session: sessionAt(CheckoutStep.confirming)),
        isFalse,
      );
    });

    test('la COLUMNA del contrato gana sobre el log cuando el backend la '
        'mande (hoy llega null)', () {
      final raw = rawCheckoutSession();
      raw['events'] = json.encode([
        {'kind': 'DECLINED_INSURANCE', 'declined': true},
      ]);
      final session = sessionFromRaw(raw);
      const agreement = DisplayAgreement(id: 'a1', declinedInsurance: false);
      expect(
        declinedInsuranceOf(session: session, agreement: agreement),
        isFalse,
        reason: 'la columna es atómica; el log es un TEXT con lost-update',
      );
      // null NO es false: significa "el servidor no lo dice" y se cae al log.
      expect(
        declinedInsuranceOf(
          session: session,
          agreement: const DisplayAgreement(id: 'a1'),
        ),
        isTrue,
      );
    });

    test('el switch se cierra en cuanto tcCompletedAt existe: el anexo ya se '
        'firmó', () {
      expect(insuranceEditable(sessionAt(CheckoutStep.confirming)), isTrue);
      expect(
        insuranceEditable(
          sessionAt(CheckoutStep.tcPending, tc: DateTime(2026, 8, 17, 9, 47)),
        ),
        isFalse,
      );
    });
  });

  group('verificación del cliente (9A/9B)', () {
    test('el snapshot del contrato gana; la ficha del cliente es respaldo', () {
      final check = customerCheck(
        verdict: ContextVerdict.answered,
        customer: const DisplayCustomer(
          firstName: 'Laura',
          lastName: 'Méndez',
          licenseNumber: 'VIEJA-1',
          phone: '+52 55 0000 0000',
        ),
        agreement: DisplayAgreement(
          id: 'a1',
          licenseNumber: 'B-4482913',
          customerPhone: '+52 55 1234 5678',
          licenseExpiry: DateTime.utc(2029, 3, 31),
        ),
      );
      expect(check.license, 'B-4482913');
      expect(check.phone, '+52 55 1234 5678');
      expect(check.complete, isTrue);
      expect(check.missing, isEmpty);
    });

    test('sin snapshot cae a la ficha del cliente (reserva recién entrada al '
        'wizard)', () {
      final check = customerCheck(
        verdict: ContextVerdict.answered,
        customer: const DisplayCustomer(
          firstName: 'Laura',
          lastName: 'Méndez',
          licenseNumber: 'B-1',
          phone: '+52 55 1',
        ),
      );
      expect(check.license, 'B-1');
      expect(check.complete, isTrue);
    });

    test('vacío y espacios cuentan como FALTANTE, en orden de lectura', () {
      final check = customerCheck(
        verdict: ContextVerdict.answered,
        customer: const DisplayCustomer(
          firstName: 'Jorge',
          lastName: 'Salas',
          licenseNumber: '   ',
          phone: '',
        ),
      );
      expect(check.complete, isFalse);
      expect(check.missing, [
        ConfirmMissingField.license,
        ConfirmMissingField.phone,
      ]);
      expect(check.name, 'Jorge Salas');
    });

    test('sin cliente en display-data: falta todo, no se inventa nada', () {
      final check = customerCheck(verdict: ContextVerdict.answered);
      expect(check.missing, hasLength(3));
      expect(check.name, isNull);
    });

    // El veredicto de tres valores (hallazgo e2e, MAJOR). "No pude preguntar"
    // y "pregunté y no está" ya no comparten representación.
    test('unreachable: missing VACÍA — sin respuesta no hay nada que declarar '
        'faltante, aunque haya un cliente colgado del render anterior', () {
      final check = customerCheck(
        verdict: ContextVerdict.unreachable,
        customer: const DisplayCustomer(
          firstName: 'Laura',
          lastName: 'Méndez',
          licenseNumber: 'B-1',
          phone: '+52 55 1',
        ),
      );
      expect(check.missing, isEmpty);
      expect(check.unreachable, isTrue);
      // Y tampoco se filtran los campos: el veredicto manda sobre el payload.
      expect(check.name, isNull);
      expect(check.license, isNull);
      expect(check.phone, isNull);
    });

    test('unreachable NO es complete: `missing.isEmpty` por sí solo dejaría '
        'pasar la entrega sin haber verificado nada', () {
      final check = customerCheck(verdict: ContextVerdict.unreachable);
      expect(check.missing, isEmpty);
      expect(check.complete, isFalse);
    });

    test('checking tampoco es complete ni faltante: se está preguntando', () {
      final check = customerCheck(verdict: ContextVerdict.checking);
      expect(check.checking, isTrue);
      expect(check.complete, isFalse);
      expect(check.missing, isEmpty);
      expect(check.unreachable, isFalse);
    });
  });

  group('countdown del token (reloj falso)', () {
    final expiry = DateTime.utc(2026, 8, 17, 10, 0);

    TermsCountdown at(DateTime now) =>
        withClock(Clock.fixed(now), () => TermsCountdown.of(expiry));

    test('neutro por encima de 2 min, con mm:ss tabular', () {
      final c = at(DateTime.utc(2026, 8, 17, 9, 45, 28));
      expect(c.phase, TermsCountdownPhase.live);
      expect(c.mmss, '14:32');
      expect(c.isExpired, isFalse);
      expect(c.reMintWouldReuse, isTrue,
          reason: 're-emitir aquí devuelve el MISMO código');
    });

    test('el umbral de 2 min es EXACTAMENTE la frontera de re-uso del backend '
        '(comparación estricta, igual que el `gt` de Prisma)', () {
      // 2:00.001 restantes: el backend todavía reusa.
      final justAbove = at(DateTime.utc(2026, 8, 17, 9, 57, 59, 999));
      expect(justAbove.phase, TermsCountdownPhase.live);
      expect(justAbove.reMintWouldReuse, isTrue);

      // 2:00 exactos: `expiresAt > now + 2min` es FALSO ⇒ mintea fresco.
      final exactly = at(DateTime.utc(2026, 8, 17, 9, 58));
      expect(exactly.phase, TermsCountdownPhase.closing);
      expect(exactly.reMintWouldReuse, isFalse,
          reason: 'ámbar significa "si lo re-emites ahora, SÍ cambia"');
      expect(exactly.mmss, '02:00');
    });

    test('vencido satura en 00:00 (nunca un tiempo al revés)', () {
      final c = at(DateTime.utc(2026, 8, 17, 10, 3));
      expect(c.phase, TermsCountdownPhase.expired);
      expect(c.isExpired, isTrue);
      expect(c.mmss, '00:00');
      expect(c.reMintWouldReuse, isFalse);
    });

    test('sin expiresAt se trata como vencido: un QR sin caducidad conocida no '
        'se puede afirmar vivo', () {
      final c = TermsCountdown.of(null);
      expect(c.isExpired, isTrue);
      expect(c.mmss, '00:00');
    });

    test('el piso de re-uso y el TTL son los del backend', () {
      expect(kTermsTokenReuseFloor, const Duration(minutes: 2));
      expect(kTermsTokenTtl, const Duration(minutes: 15));
    });
  });

  test('la URL del QR apunta a la app WEB, con /sign/<token> y sin doble barra',
      () {
    expect(
      AppConfig.current.signUrl('abc123'),
      '${AppConfig.current.webBaseUrl}/sign/abc123',
    );
    expect(AppConfig.current.webBaseUrl, isNot(contains('4000')),
        reason: 'el QR no puede apuntar a la API: el cliente abre la web');
  });
}
