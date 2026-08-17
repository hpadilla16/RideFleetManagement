import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:rideops/core/api/dto/session_user.dart';
import 'package:rideops/core/l10n/app_localizations.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';

import 'auth_test_helpers.dart';

/// Utilería compartida de los tests del shell/ubicación (H3).

class InMemoryActiveLocationStore implements ActiveLocationStore {
  InMemoryActiveLocationStore([this.raw]);

  String? raw;
  int writes = 0;
  int clears = 0;

  @override
  Future<String?> read() async => raw;

  @override
  Future<void> write(String value) async {
    raw = value;
    writes++;
  }

  @override
  Future<void> clear() async {
    raw = null;
    clears++;
  }
}

/// SessionController con estado FIJO — sin restore ni red. Para tests que
/// solo necesitan "hay una sesión así".
class StubSessionController extends SessionController {
  StubSessionController(this._initial);

  final SessionState _initial;

  @override
  SessionState build() => _initial;
}

/// SessionUser del fixture real con role/locationIds a gusto del test.
/// `locationIdsOverride: null` con `unrestricted: true` = usuario sin
/// restricción (ve todas las sedes del tenant).
///
/// `screenLockExempt` es true por default A PROPÓSITO: los tests del shell
/// montan la app completa y un usuario no exento sin PIN caería en el gate
/// /pin-setup del router (H2), secuestrando la navegación que se quiere
/// asertar. El interjuego de gates tiene su propia tabla en
/// auth_redirect_test y sus suites (lock_controller/pin_*_screen).
SessionUser sessionUserFixture({
  String role = 'AGENT',
  bool unrestricted = false,
  List<String>? locationIdsOverride,
  bool issueCenter = true,
  bool screenLockExempt = true,
  String programScope = 'BOTH',
}) {
  final raw = readAuthFixture()['user'] as Map<String, dynamic>;
  raw['role'] = role;
  raw['screenLockExempt'] = screenLockExempt;
  raw['programScope'] = programScope;
  if (unrestricted) {
    raw['locationIds'] = null;
  } else if (locationIdsOverride != null) {
    raw['locationIds'] = locationIdsOverride;
  }
  (raw['moduleAccess'] as Map<String, dynamic>)['issueCenter'] = issueCenter;
  return SessionUser.fromJson(raw);
}

/// MaterialApp mínimo con l10n para montar widgets del shell. El harness
/// corre en locale `en` → se asierta contra app_en.arb (misma convención que
/// login_screen_test).
Widget l10nApp(Widget home) => MaterialApp(
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: const [Locale('es'), Locale('en')],
      home: home,
    );
