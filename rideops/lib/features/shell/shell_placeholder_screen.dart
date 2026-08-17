import 'package:flutter/material.dart';

import '../../core/l10n/app_localizations.dart';
import '../../core/theme/ride_tokens.dart';

/// Destinos provisionales de las tabs sin historia todavía (Buscar M3,
/// Bandeja H5, Perfil H4+, Incidentes M3). Existen para que la navegación
/// del shell sea real desde H3 — cada historia reemplaza el suyo. El título
/// llega ya localizado desde la tab que lo montó.
class ShellPlaceholderScreen extends StatelessWidget {
  const ShellPlaceholderScreen({super.key, required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Center(
      child: Padding(
        // La tab bar flotante no debe tapar el texto (extendBody en el shell).
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 88),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              title,
              style: const TextStyle(
                fontSize: 20,
                fontWeight: FontWeight.w900,
                color: RideTokens.n900,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              l10n.shellPlaceholderBody,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
                color: RideTokens.n600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
