import 'package:flutter/material.dart';

import '../../core/l10n/app_localizations.dart';
import '../../core/theme/ride_tokens.dart';
import '../../core/widgets/ride_buttons.dart';
import 'location_sheet.dart';

/// Pantalla 4D — negativa de ubicación (403 SIN code, REGROUND §1).
///
/// Se renderiza DENTRO del shell (appbar + tabs siguen visibles: chrome
/// completo, jamás pantalla vacía) por la pantalla cuyo fetch recibió el 403:
/// cada pantalla maneja su propio ApiError (DoD-4) y monta este widget cuando
/// `kind == forbidden && code == null` en una ruta que llevó
/// `x-view-location`. H4 (dashboard) es el primer consumidor real; H3 lo deja
/// construido y probado.
///
/// Dos salidas SIEMPRE: "Cambiar ubicación" (abre el sheet 4C — que consulta
/// /selectable SIN el header, así la lista de escape nunca está envenenada
/// por la sede denegada) y "Reintentar" ([onRetry], por si el admin
/// re-otorgó el acceso).
class LocationDeniedView extends StatelessWidget {
  const LocationDeniedView({super.key, this.locationName, required this.onRetry});

  /// Nombre de la sede denegada (del chip persistido) para el copy; null →
  /// copy genérico.
  final String? locationName;

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final body = locationName == null
        ? l10n.locationDeniedBodyGeneric
        : l10n.locationDeniedBody(locationName!);
    return SafeArea(
      child: Padding(
        // 96 abajo: la tab bar flotante (64 + margen) no debe tapar el pie.
        padding: const EdgeInsets.fromLTRB(24, 16, 24, 96),
        child: Column(
          children: [
            Expanded(
              // Center + scroll: centrado cuando sobra espacio y sin
              // desbordar cuando la pantalla anfitriona deja poco alto (la
              // 4D también se monta bajo el campo de búsqueda en H4).
              child: Center(
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 72,
                        height: 72,
                        decoration: BoxDecoration(
                          color: RideTokens.dangerBg,
                          shape: BoxShape.circle,
                          border: Border.all(color: RideTokens.dangerBd),
                        ),
                        child: const Icon(
                          Icons.gpp_bad_outlined,
                          size: 34,
                          color: RideTokens.dangerTx,
                        ),
                      ),
                      const SizedBox(height: 16),
                      Text(
                        l10n.locationDeniedTitle,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 19,
                          fontWeight: FontWeight.w900,
                          color: RideTokens.n900,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        body,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          color: RideTokens.n700,
                          height: 1.4,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            // GD MC-4: el .btn-primary REAL del design system (core/widgets)
            // — no un segundo "primario" inventado por pantalla.
            RidePrimaryButton(
              label: l10n.locationDeniedChangeButton,
              onPressed: () => showActiveLocationSheet(context),
            ),
            const SizedBox(height: 10),
            // Ghost con borde (GD SHOULD H3): a pleno sol el texto pelado
            // pierde affordance de botón.
            RideGhostButton(
              label: l10n.retryButton,
              onPressed: onRetry,
            ),
            const SizedBox(height: 8),
            Text(
              l10n.locationDeniedAdminNote,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 12.5,
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
