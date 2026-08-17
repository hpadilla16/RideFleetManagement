import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/dto/checkout_session.dart';
import 'package:rideops/core/api/dto/dashboard.dart';
import 'package:rideops/core/api/dto/inspection.dart';
import 'package:rideops/core/api/dto/reservation_card.dart';
import 'package:rideops/core/api/dto/reservation_display.dart';
import 'package:rideops/core/api/dto/session_user.dart';
import 'package:rideops/core/api/dto/staff_location.dart';
import 'package:rideops/core/api/enums.dart';

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
    expect(d.branding.companyName, 'Autos del Valle');
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
    expect(d.reservation.vehicle, isNull);
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
