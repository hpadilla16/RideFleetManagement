import 'package:flutter/material.dart';

/// Shell de la app (blueprint §3): scaffold común de las rutas internas.
///
/// En H1 solo pasa el child: el bottom nav flotante (mockup 4) y el banner de
/// ubicación activa llegan con H3/H4 — se deja el ShellRoute montado desde ya
/// para que esas historias no re-cableen navegación.
class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => child;
}
