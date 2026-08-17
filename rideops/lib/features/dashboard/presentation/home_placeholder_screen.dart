import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/db/outbox_providers.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/session/session_controller.dart';
import '../../../core/theme/ride_tokens.dart';
import 'home_skeleton.dart';

/// Destino post-login PROVISIONAL: el dashboard real (9 colas + bento) es la
/// historia H4. Esto solo confirma la sesión y ofrece logout — necesario para
/// probar el ciclo completo login→gate→app→logout en un teléfono real.
/// El Scaffold exterior lo pone el shell (H3); aquí solo el body.
class HomePlaceholderScreen extends ConsumerWidget {
  const HomePlaceholderScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final user = ref.watch(sessionControllerProvider).user;
    // Sesión degradada (token vivo, /me aún sin responder o caído por red):
    // skeleton 4E, no una pantalla a medias. El re-intento de /me corre al
    // reanudar la app (AppShell) y este user deja de ser null solo.
    if (user == null) return const HomeSkeleton();
    return ColoredBox(
      color: RideTokens.n50,
      child: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                l10n.homePlaceholderTitle,
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w900,
                  color: RideTokens.n900,
                ),
              ),
              if (user.fullName != null) ...[
                const SizedBox(height: 4),
                Text(
                  user.fullName!,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: RideTokens.n700,
                  ),
                ),
              ],
              const SizedBox(height: 8),
              Text(
                l10n.homePlaceholderBody,
                style: const TextStyle(fontSize: 13.5, color: RideTokens.n600),
              ),
              const SizedBox(height: 24),
              TextButton(
                style: TextButton.styleFrom(
                  minimumSize: const Size(48, 48), // target DoD #2
                  foregroundColor: RideTokens.p700,
                ),
                onPressed: () => _logout(context, ref, l10n),
                child: Text(l10n.logoutButton),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Logout con la advertencia del mockup 7C (nota 6): si hay envíos en la
  /// bandeja, se dice EXPLÍCITO que cerrarán con el teléfono — la bandeja
  /// pertenece a la cuenta y no sobrevive a otra (ADR-7). Bandeja vacía:
  /// sin fricción.
  Future<void> _logout(
    BuildContext context,
    WidgetRef ref,
    AppLocalizations l10n,
  ) async {
    final badge = ref.read(outboxBadgeProvider);
    final total = badge.waiting + badge.dead;
    if (total > 0) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(l10n.logoutPendingTitle),
          content: Text(l10n.logoutPendingBody(total)),
          actions: [
            TextButton(
              style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
              onPressed: () => Navigator.of(context).pop(false),
              child: Text(l10n.cancelButton),
            ),
            TextButton(
              style: TextButton.styleFrom(
                minimumSize: const Size(48, 48),
                foregroundColor: RideTokens.dangerTx,
              ),
              onPressed: () => Navigator.of(context).pop(true),
              child: Text(l10n.logoutAnyway),
            ),
          ],
        ),
      );
      if (confirmed != true) return;
    }
    await ref.read(sessionControllerProvider.notifier).logout();
  }
}
