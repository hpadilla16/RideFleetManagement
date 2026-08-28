import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/dto/available_vehicle.dart';
import 'package:rideops/core/api/dto/checkout_session.dart';
import 'package:rideops/core/api/dto/dashboard.dart';
import 'package:rideops/core/api/dto/inspection.dart';
import 'package:rideops/core/api/dto/reservation_card.dart';
import 'package:rideops/core/api/dto/reservation_display.dart';
import 'package:rideops/core/api/dto/session_user.dart';
import 'package:rideops/core/api/dto/staff_location.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/features/checkout/domain/checkout_presence.dart';

/// Los 6 DTOs calientes contra fixtures de JSON real (M0-5). Cada fixture
/// está derivado del serializer del backend — ver test/fixtures/README.md.
Map<String, dynamic> readFixture(String name) {
  final file = File('test/fixtures/$name');
  return json.decode(file.readAsStringSync()) as Map<String, dynamic>;
}

void main() {
  test('login_response.json → AuthResponse/SessionUser', () {
    final auth = AuthResponse.fromJson(readFixture('login_response.json'));
    expect(auth.token, isNotEmpty);
    expect(auth.user.roleEnum, UserRole.agent);
    expect(auth.user.isLocationRestricted, isTrue);
    expect(auth.user.locationIds, hasLength(2));
    expect(auth.user.mustChangePassword, isFalse);
    expect(auth.user.can('reservations'), isTrue);
    expect(auth.user.can('paymentActions'), isFalse);
    expect(auth.user.can('modulo_inexistente'), isFalse);
  });

  test(
      'herencia QA-H3: SessionUser.can() es fail-closed — llave AUSENTE del '
      'mapa == false, igual que llave presente en false', () {
    final raw = readFixture('login_response.json');
    final access =
        (raw['user'] as Map<String, dynamic>)['moduleAccess'] as Map<String, dynamic>;
    access.remove('reservations'); // presente en el fixture → ausente
    final user = AuthResponse.fromJson(raw).user;
    expect(access.containsKey('reservations'), isFalse);
    expect(user.can('reservations'), isFalse,
        reason: 'ausencia = NO (el ?? false del DTO): un backend viejo que '
            'aún no emite la llave jamás debe encender superficies nuevas');
    expect(user.can('paymentActions'), isFalse,
        reason: 'presente y en false — mismo resultado por otra vía');
  });

  test('locationIds null significa UNRESTRICTED, no lista vacía', () {
    final raw = readFixture('login_response.json');
    (raw['user'] as Map<String, dynamic>)['locationIds'] = null;
    final auth = AuthResponse.fromJson(raw);
    expect(auth.user.locationIds, isNull);
    expect(auth.user.isLocationRestricted, isFalse);
  });

  test('checkout_session.json → CheckoutSessionDto', () {
    final cs = CheckoutSessionDto.fromJson(readFixture('checkout_session.json'));
    expect(cs.step, CheckoutStep.inspectionHandoff);
    expect(cs.isTerminal, isFalse);
    expect(cs.paymentCompletedAt, isNotNull);
    expect(cs.inspectionCompletedAt, isNull);
  });

  test(
      'checkout_session.json (API de HOY, sin P1) → presence es NULL, no lista '
      'vacía: la app no puede afirmar quién más está en la sesión', () {
    final cs = CheckoutSessionDto.fromJson(readFixture('checkout_session.json'));
    expect(cs.presence, isNull);
    expect(cs.stateVersion, isNull, reason: 'columna de P2 aún no desplegada');
    expect(pickPresenceChip(cs.presence, DateTime.now()), isNull);
  });

  test('presence: [] NO afirma soledad — withPresence() degrada a lista vacía '
      'ante un fallo de lectura, así que "vacío" y "no hay nadie" son '
      'indistinguibles desde el cliente', () {
    final raw = readFixture('checkout_session_presence.json');
    raw['presence'] = <dynamic>[];
    final cs = CheckoutSessionDto.fromJson(raw);
    expect(cs.presence, isEmpty);
    // Se pinta IGUAL que null (sin chip): la UI nunca dice "estás solo".
    expect(pickPresenceChip(cs.presence, DateTime.now()), isNull);
  });

  test('checkout_session_presence.json (P1 desplegado) → presence tipada', () {
    final cs =
        CheckoutSessionDto.fromJson(readFixture('checkout_session_presence.json'));
    expect(cs.presence, hasLength(2));
    expect(cs.presence!.first.surface, 'KIOSK');
    expect(cs.presence!.first.displayName, 'María G.');
    expect(cs.presence!.first.lastSeenAt, isNotNull);
    expect(cs.step, CheckoutStep.tcPending);
    // `stateVersion` (columna de P2) se lee para el FENCING de respuestas
    // tardías; NO se envía como `expectedVersion` todavía (eso es H6).
    expect(cs.stateVersion, 3);
  });

  test('presence con una superficie DESCONOCIDA no rompe el parseo', () {
    final raw = readFixture('checkout_session_presence.json');
    (raw['presence'] as List<dynamic>).add({
      'surface': 'SUPERFICIE_DEL_FUTURO',
      'displayName': 'Alguien',
      'lastSeenAt': '2026-08-16T14:03:55.000Z',
    });
    final cs = CheckoutSessionDto.fromJson(raw);
    expect(cs.presence, hasLength(3));
    expect(cs.presence!.last.surface, 'SUPERFICIE_DEL_FUTURO');
  });

  test('un currentStep desconocido no crashea (resiliencia de enum)', () {
    final raw = readFixture('checkout_session.json');
    raw['currentStep'] = 'PASO_NUEVO_DEL_FUTURO';
    final cs = CheckoutSessionDto.fromJson(raw);
    expect(cs.step, isNull);
    expect(cs.currentStep, 'PASO_NUEVO_DEL_FUTURO');
    expect(cs.isTerminal, isFalse);
  });

  test('reservation_card.json → ReservationCard', () {
    final card = ReservationCard.fromJson(readFixture('reservation_card.json'));
    expect(card.reservationNumber, 'R-20260816-0042');
    // Decimal de Prisma llega como string — el converter lo vuelve double.
    expect(card.estimatedTotal, 412.50);
    expect(card.vehicle?.plate, 'IKL-427');
    expect(card.customer?.firstName, 'María');
  });

  test('estimatedTotal acepta número o string', () {
    final raw = readFixture('reservation_card.json');
    raw['estimatedTotal'] = 99.5;
    expect(ReservationCard.fromJson(raw).estimatedTotal, 99.5);
    raw['estimatedTotal'] = '99.50';
    expect(ReservationCard.fromJson(raw).estimatedTotal, 99.5);
    raw['estimatedTotal'] = null;
    expect(ReservationCard.fromJson(raw).estimatedTotal, isNull);
  });

  test('dashboard.json → DashboardPayload (11 métricas, 9 colas)', () {
    final dash = DashboardPayload.fromJson(readFixture('dashboard.json'));
    expect(dash.metrics.openReservations, 14);
    expect(dash.metrics.issueUnderReview, 1);
    expect(dash.queues.issueEscalations, hasLength(1));
    expect(dash.queues.issueEscalations.first.amountClaimed, 250.0);
    expect(dash.self?.commissions?.monthKey, '2026-08');
    expect(dash.self?.profile?.role, 'AGENT');
  });

  test('una cola con reservationCard embebida deserializa', () {
    final raw = readFixture('dashboard.json');
    final card = readFixture('reservation_card.json');
    ((raw['queues'] as Map<String, dynamic>)['checkout'] as List).add(card);
    final dash = DashboardPayload.fromJson(raw);
    expect(dash.queues.checkout.single.id, card['id']);
  });

  test('handoff_token.json → HandoffToken', () {
    final t = HandoffToken.fromJson(readFixture('handoff_token.json'));
    expect(HandoffTokenKind.tryParse(t.kind), HandoffTokenKind.mobileInspection);
    expect(t.reused, isFalse);
    // Vivo con margen de 2 min a las 14:20; muerto a las 14:26.
    expect(
      t.aliveFor(const Duration(minutes: 2),
          now: () => DateTime.utc(2026, 8, 16, 14, 20)),
      isTrue,
    );
    expect(
      t.aliveFor(const Duration(minutes: 2),
          now: () => DateTime.utc(2026, 8, 16, 14, 26)),
      isFalse,
    );
  });

  test('locations_selectable.json → List<StaffLocation> (array plano)', () {
    final raw = json.decode(
      File('test/fixtures/locations_selectable.json').readAsStringSync(),
    ) as List<dynamic>;
    final list = raw
        .map((e) => StaffLocation.fromJson(e as Map<String, dynamic>))
        .toList();
    expect(list, hasLength(2));
    expect(list.first.name, 'Patio Centro');
    expect(list.first.code, 'CEN');
    expect(list[1].city, isNull, reason: 'city/state son nullable en Prisma');
  });

  test('reservation_display_data.json → ReservationDisplayData (H5)', () {
    final d = ReservationDisplayData.fromJson(
      readFixture('reservation_display_data.json'),
    );
    expect(d.reservation.reservationNumber, 'R-20260816-0042');
    expect(d.reservation.vehicle?.mileage, 48190,
        reason: 'la "última lectura registrada" del odómetro (mockup 6C n.7)');
    expect(d.reservation.vehicle?.label, 'Toyota Corolla 2023 · U-112');
    expect(d.reservation.customer?.fullName, 'María González',
        reason: 'el firmante que se sella como signerName (INN S-3)');
    expect(d.branding.companyName, 'Autos del Valle');
    expect(d.branding.clientSafeCompanyName, 'Autos del Valle',
        reason: 'un nombre real de tenant pasa intacto');
    expect(d.branding.companyLogoUrl, isNotEmpty);
  });

  test('display-data tolera branding con defaults del backend', () {
    final raw = readFixture('reservation_display_data.json');
    // routes:618-622: defaults 'Ride Fleet' / '' — y un vehicle null (reserva
    // sin unidad asignada) no puede tirar el flujo.
    raw['branding'] = {'companyName': 'Ride Fleet', 'companyLogoUrl': '', 'companyPhone': ''};
    (raw['reservation'] as Map<String, dynamic>)['vehicle'] = null;
    final d = ReservationDisplayData.fromJson(raw);
    expect(d.branding.companyName, 'Ride Fleet');
    // QA MAJOR: el centinela de plataforma se NEUTRALIZA para superficies
    // de cara al cliente — un tenant sin branding jamás muestra 'Ride
    // Fleet' (ni "RF") durante la firma legal.
    expect(d.branding.clientSafeCompanyName, '');
    expect(d.reservation.vehicle, isNull);
  });

  test('display-data trae lo que el CIERRE necesita para verificar (M2-H5)',
      () {
    final d = ReservationDisplayData.fromJson(
      readFixture('reservation_display_data.json'),
    );
    // `getById` usa un `include` de nivel superior, así que TODO escalar de
    // Reservation llega — incluido `status`, que es lo único con lo que 19B
    // puede distinguir "cerrado" de "entregado".
    expect(d.reservation.status, 'CONFIRMED');
    expect(
      ReservationStatus.tryParse(d.reservation.status)?.handoverRecorded,
      isFalse,
      reason: 'CONFIRMED = la cascada del finalize no avanzó la reserva',
    );
    // La lista de "ya entregada" espeja EXACTO el guard anti-downgrade del
    // backend (checkout-session.service.js:453) — ni uno más, ni uno menos.
    expect(ReservationStatus.checkedOut.handoverRecorded, isTrue);
    expect(ReservationStatus.checkedIn.handoverRecorded, isTrue);
    expect(ReservationStatus.checkedInUnpaid.handoverRecorded, isTrue);
    expect(ReservationStatus.cancelled.handoverRecorded, isFalse);
    expect(ReservationStatus.noShow.handoverRecorded, isFalse);
    // `NEW` es palabra reservada de Dart: el wire va explícito para que no se
    // parta en `N_E_W`.
    expect(ReservationStatus.tryParse('NEW'), ReservationStatus.newReservation);
    // Un estado que esta versión no conozca sale null ⇒ "no lo sé", jamás
    // "no quedó registrada".
    expect(ReservationStatus.tryParse('TELEPORTED'), isNull);

    // Las dos filas de "Antes de que se vaya" (19A). La sede es la de
    // DEVOLUCIÓN de la reserva, no la del selector del agente.
    expect(d.reservation.returnAt, DateTime.utc(2026, 8, 19, 17, 30));
    expect(d.reservation.returnLocation?.name, 'Patio Centro');
  });

  test('display-data trae lo que verifica el paso CONFIRMING (M2-H2)', () {
    final d = ReservationDisplayData.fromJson(
      readFixture('reservation_display_data.json'),
    );
    // Licencia y teléfono: las dos filas que el agente confronta con la
    // licencia física y las dos que 9B nombra cuando faltan.
    expect(d.reservation.customer?.licenseNumber, 'B-4482913');
    expect(d.reservation.customer?.phone, '+52 998 123 4567');
    // El VENCIMIENTO no está en Customer (no existe la columna): viaja en el
    // snapshot del contrato.
    expect(d.reservation.rentalAgreement?.licenseExpiry?.year, 2029);
    expect(d.reservation.rentalAgreement?.customerPhone, isNotNull);
    expect(d.reservation.vehicleTypeId, 'cme9r1t2b0002vtcompact');
    expect(d.reservation.vehicle?.status, 'AVAILABLE');
    // CONTRATO VERIFICADO: el select de getById NO incluye declinedInsurance
    // (solo el select de LISTA la trae). Null ⇒ "el servidor no lo dice", y
    // por eso el switch se deriva del events[] de la sesión.
    expect(d.reservation.rentalAgreement?.declinedInsurance, isNull);
  });

  test('reservation_available_vehicles.json → AvailableVehicle (array plano)',
      () {
    final rows = [
      for (final row in json.decode(
        File('test/fixtures/reservation_available_vehicles.json')
            .readAsStringSync(),
      ) as List<dynamic>)
        AvailableVehicle.fromJson(row as Map<String, dynamic>),
    ];
    expect(rows, hasLength(3));
    // La unidad YA asignada viaja siempre y de primera (routes:1064-1067).
    expect(rows.first.id, 'cmea77xh20003vehu112');
    expect(rows[1].label, 'U-118 · Toyota Corolla 2023');
    expect(rows[1].isAvailableNow, isTrue);
    // Un candidato que el servidor devuelve sin estar AVAILABLE existe: la UI
    // muestra su estado crudo en vez de afirmar "disponible".
    expect(rows[2].isAvailableNow, isFalse);
    expect(rows[2].status, 'RESERVED');
    expect(rows[2].homeLocation?.name, 'Aeropuerto');
  });

  test('mobile_inspection_state.json → MobileInspectionState', () {
    final s = MobileInspectionState.fromJson(
      readFixture('mobile_inspection_state.json'),
    );
    expect(s.angles, hasLength(8));
    expect(s.angles.where((a) => a.captured), hasLength(2));
    expect(s.angles.first.key, 'front');
  });
}
