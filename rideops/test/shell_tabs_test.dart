import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/features/shell/shell_tabs.dart';

import 'helpers/shell_test_helpers.dart';

/// Tabla RBAC de tabs del shell (mockup 4A/4B): AGENT 4, ADMIN/OPS(/SUPER)
/// +Incidentes si moduleAccess.issueCenter, degradado = mínimas.
void main() {
  const base = [
    ShellTab.home,
    ShellTab.search,
    ShellTab.outbox,
    ShellTab.profile,
  ];
  const withIncidents = [
    ShellTab.home,
    ShellTab.search,
    ShellTab.incidents,
    ShellTab.outbox,
    ShellTab.profile,
  ];

  test('tabla role/moduleAccess → tabs', () {
    final cases = <(String, bool, List<ShellTab>)>[
      // AGENT nunca ve Incidentes, tenga o no el módulo.
      ('AGENT', true, base),
      ('AGENT', false, base),
      ('ADMIN', true, withIncidents),
      ('ADMIN', false, base),
      ('OPS', true, withIncidents),
      ('OPS', false, base),
      ('SUPER_ADMIN', true, withIncidents),
      // Role desconocido del futuro: tabs mínimas, no crash (tryParse null).
      ('ROLE_DEL_FUTURO', true, base),
    ];
    for (final (role, issueCenter, expected) in cases) {
      expect(
        tabsFor(sessionUserFixture(role: role, issueCenter: issueCenter)),
        expected,
        reason: 'role=$role issueCenter=$issueCenter',
      );
    }
  });

  test('sesión degradada (user null) → tabs mínimas de AGENT', () {
    expect(tabsFor(null), base);
  });

  test('el orden es el del mockup 4B: Incidentes entre Buscar y Bandeja', () {
    final tabs = tabsFor(sessionUserFixture(role: 'ADMIN'));
    expect(tabs.indexOf(ShellTab.incidents), 2);
    expect(tabs.indexOf(ShellTab.outbox), 3);
  });
}
