import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/dto/reservation_display.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/telemetry/event_logger.dart';
import '../../../core/theme/ride_tokens.dart';
import '../application/checkout_wizard_controller.dart';
import '../application/terms_token_controller.dart';
import '../domain/terms_token.dart';
import 'widgets/qr_view.dart';

/// Abre el MODO PRESENTACIÓN (mockup 10B).
///
/// Se empuja sobre el navegador raíz en vez de ser una ruta de go_router a
/// propósito: el wizard queda MONTADO debajo, así su poll de 5 s sigue
/// corriendo y la firma del cliente se detecta aunque la pantalla esté
/// volteada. Una ruta que reemplazara al wizard apagaría justamente el
/// mecanismo por el que este paso se entera de que ya se firmó.
Future<void> openPresentMode(
  BuildContext context,
  WidgetRef ref, {
  required String reservationId,
  required String sessionId,
}) {
  ref.read(eventLoggerProvider).log(CheckoutEvents.presentModeShown);
  return Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => PresentModeScreen(
        reservationId: reservationId,
        sessionId: sessionId,
      ),
      fullscreenDialog: true,
    ),
  );
}

/// Pantalla volteada al CLIENTE: QR grande, marca del TENANT y **cero marca de
/// plataforma**.
///
/// Tres reglas, todas verificadas contra hallazgos previos:
///  1. **Ni "RideOps" ni "Ride Fleet"**. El nombre sale de
///     `TenantBranding.clientSafeCompanyName`, que además neutraliza el
///     centinela que el backend inyecta como default
///     (`reservations.routes.js:619`) — el QA del M1 ya cazó esa fuga una vez
///     en la firma del kiosco. Sin branding del tenant, la barra se omite
///     entera: no hay fallback de marca (GD-1).
///  2. **Modo presentación ≠ modo kiosco** (nota 11): aquí el teléfono NO
///     cambia de manos, el cliente solo apunta su cámara. Por eso NO se monta
///     la barra de kiosco, NO se suspende el candado de inactividad y NO se
///     pide PIN para salir: fortificar esto sería fricción pura. La salida es
///     un botón de 48 px al pie, en neutro del tenant.
///  3. **Al cliente no se le pone un reloj en la cara** (nota 12): el
///     countdown es herramienta del AGENTE. Aquí solo aparece bajo 2 min y con
///     copy tranquilizadora — presionar a alguien para que firme rápido un
///     documento legal es exactamente lo que no queremos diseñar.
///
/// ⚠️ Esta pantalla cumple su parte, pero **el DESTINO del QR todavía filtra la
/// marca de la plataforma** (gap #11 del PROJECT_PLAN, bloqueante de esta
/// historia): el WHY completo y su estado verificado están en
/// `terms_token_controller.dart`, donde se arma el enlace.
class PresentModeScreen extends ConsumerStatefulWidget {
  const PresentModeScreen({
    super.key,
    required this.reservationId,
    required this.sessionId,
  });

  final String reservationId;
  final String sessionId;

  @override
  ConsumerState<PresentModeScreen> createState() => _PresentModeScreenState();
}

class _PresentModeScreenState extends ConsumerState<PresentModeScreen> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    // Mismo tick de 1 Hz del paso: aquí solo decide si ya toca mostrar el
    // aviso de "quedan menos de 2 minutos".
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final wizard = ref.watch(checkoutWizardProvider(widget.reservationId));
    final tokenState = ref.watch(termsTokenProvider(widget.sessionId));
    final url = ref.read(termsTokenProvider(widget.sessionId).notifier).signUrl;
    final countdown = TermsCountdown.of(tokenState.token?.expiresAt);
    final branding = wizard.context?.branding;
    final reservationNumber = wizard.context?.reservationNumber;

    // El cliente firmó (o el código venció) mientras la pantalla estaba
    // volteada: presentar un QR muerto es peor que no presentar nada, así que
    // el modo se cierra solo y el agente recupera su pantalla con el estado
    // real. Se hace en post-frame para no navegar durante el build.
    final done = wizard.session?.tcCompletedAt != null || countdown.isExpired;
    if (done || url == null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && Navigator.of(context).canPop()) {
          Navigator.of(context).pop();
        }
      });
    }

    return Scaffold(
      // Blanco puro: el QR necesita su fondo, y el morado de marca es lenguaje
      // de STAFF (misma regla que la firma en kiosco).
      backgroundColor: RideTokens.n0,
      body: SafeArea(
        child: Column(
          children: [
            _TenantBar(branding: branding, reservation: reservationNumber),
            Expanded(
              // Scroll aunque el diseño quepa: con el texto del sistema en
              // grande (o un teléfono corto) el QR de 230 px más las dos
              // instrucciones se salen, y un QR recortado es un QR que no
              // escanea. Centrado mientras sobra espacio.
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 300),
                      child: Text(
                        l10n.coPresentInstruction,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w800,
                          color: RideTokens.n900,
                        ),
                      ),
                    ),
                    const SizedBox(height: 14),
                    if (url != null)
                      // 230 px: se escanea de lejos, con guantes y con sol.
                      QrView(data: url, size: 230),
                    const SizedBox(height: 16),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 290),
                      child: Text(
                        // Nada que la app no pueda cumplir (nota 10): no se le
                        // promete al cliente un envío por mensaje que el
                        // contrato no tiene.
                        l10n.coPresentHelp,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w700,
                          color: RideTokens.n700,
                        ),
                      ),
                    ),
                    if (countdown.phase == TermsCountdownPhase.closing) ...[
                      const SizedBox(height: 14),
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 300),
                        child: Text(
                          l10n.coPresentClosingSoon(countdown.mmss),
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w800,
                            color: RideTokens.warnTx,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
              child: _ExitButton(
                label: l10n.coPresentExit,
                onTap: () => Navigator.of(context).pop(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Barra del TENANT. Se omite entera cuando no hay nombre: sin branding no hay
/// iniciales de plataforma ni logo genérico — un tenant sin configurar no
/// puede acabar mostrándole NUESTRA marca a su cliente.
class _TenantBar extends StatelessWidget {
  const _TenantBar({required this.branding, required this.reservation});

  final TenantBranding? branding;
  final String? reservation;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final name = branding?.clientSafeCompanyName ?? '';
    if (name.isEmpty) return const SizedBox(height: 8);
    final logoUrl = branding?.companyLogoUrl ?? '';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      color: RideTokens.n800,
      child: Row(
        children: [
          if (logoUrl.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(right: 10),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: Image.network(
                  logoUrl,
                  width: 36,
                  height: 36,
                  fit: BoxFit.cover,
                  // Un logo que no carga NO cae a un placeholder de marca:
                  // desaparece y queda el nombre del tenant en texto.
                  errorBuilder: (_, _, _) => const SizedBox.shrink(),
                ),
              ),
            ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w900,
                    color: RideTokens.n0,
                  ),
                ),
                Text(
                  reservation == null
                      ? l10n.coPresentSubtitleNoNumber
                      : l10n.coPresentSubtitle(reservation!),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFFE9E4F4),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Salida VISIBLE del modo presentación: 48 px, al pie, en neutro. No lleva
/// morado de marca (es superficie del cliente) ni pide PIN (no es kiosco).
class _ExitButton extends StatelessWidget {
  const _ExitButton({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: RideTokens.n0,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          width: double.infinity,
          constraints: const BoxConstraints(minHeight: 48),
          decoration: BoxDecoration(
            border: Border.all(color: RideTokens.n300, width: 1.5),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.arrow_back_rounded,
                  size: 17, color: RideTokens.n700),
              const SizedBox(width: 8),
              Text(
                label,
                style: const TextStyle(
                  fontSize: 14.5,
                  fontWeight: FontWeight.w800,
                  color: RideTokens.n700,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
