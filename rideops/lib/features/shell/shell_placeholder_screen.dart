import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/l10n/app_localizations.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/ride_tokens.dart';

/// Destinos provisionales de las tabs sin historia todavía (Bandeja H5,
/// Perfil e Incidentes M3). Existen para que la navegación del shell sea real
/// desde H3 — cada historia reemplaza el suyo. El título llega ya localizado
/// desde la tab que lo montó.
class ShellPlaceholderScreen extends ConsumerWidget {
  const ShellPlaceholderScreen({
    super.key,
    required this.title,
    this.showLogout = false,
  });

  final String title;

  /// Perfil (única tab que lo pide): logout provisional para poder probar el
  /// ciclo completo login→app→logout en teléfono real hasta que el Perfil de
  /// verdad llegue en M3. Vivía en el placeholder del home (H1) — la home
  /// real de H4 lo desalojó.
  final bool showLogout;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
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
            if (showLogout) ...[
              const SizedBox(height: 16),
              TextButton(
                style: TextButton.styleFrom(
                  minimumSize: const Size(48, 48), // target DoD #2
                  foregroundColor: RideTokens.p700,
                ),
                onPressed: () =>
                    ref.read(sessionControllerProvider.notifier).logout(),
                child: Text(l10n.logoutButton),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
