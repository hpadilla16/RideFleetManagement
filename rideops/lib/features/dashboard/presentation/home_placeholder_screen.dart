import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/session/session_controller.dart';
import '../../../core/theme/ride_tokens.dart';

/// Destino post-login PROVISIONAL: el dashboard real (9 colas + bento) es la
/// historia H4. Esto solo confirma la sesión y ofrece logout — necesario para
/// probar el ciclo completo login→gate→app→logout en un teléfono real.
class HomePlaceholderScreen extends ConsumerWidget {
  const HomePlaceholderScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final user = ref.watch(sessionControllerProvider).user;
    return Scaffold(
      backgroundColor: RideTokens.n50,
      body: SafeArea(
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
              if (user?.fullName != null) ...[
                const SizedBox(height: 4),
                Text(
                  user!.fullName!,
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
                onPressed: () =>
                    ref.read(sessionControllerProvider.notifier).logout(),
                child: Text(l10n.logoutButton),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
