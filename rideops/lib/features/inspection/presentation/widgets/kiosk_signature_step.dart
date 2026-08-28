import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/session/lock_controller.dart';
import '../../../../core/theme/ride_tokens.dart';
import 'signature_pad.dart';

/// Paso 3 — firma en MODO KIOSCO (mockup 6D, §9-6 Variante A DEFINITIVA):
/// el teléfono se voltea al cliente. Reglas del modo:
///  - branding del TENANT (logo/nombre vía display-data), CERO "RideOps" ni
///    morado de marca a la vista del cliente; sin nombre de tenant, la fila
///    se OCULTA — jamás un fallback de marca nuestra (review GD-1);
///  - idioma del cliente conmutable ES|EN solo en la superficie volteada
///    (Localizations.override); la kioskbar de staff queda en el idioma del
///    empleado (review GD-2);
///  - kioskbar de Tanda A 3C ("Modo firma · bloqueo en pausa");
///  - [LockController.suspendLock] al montar / [resumeLock] al desmontar —
///    el candado por inactividad no puede saltar a media firma;
///  - navegación bloqueada: sin back del sistema; la ÚNICA salida sin firmar
///    es mantener 3 s la zona de salida + PIN, con reintentos LIMITADOS
///    (criterio registrado H5). El contador vive en ESTE estado — cerrar el
///    diálogo no lo resetea (review INN MC-1a) — y agotarlo BLOQUEA la app
///    tras el resume (INN MC-1b): la superficie de staff aterriza en /lock
///    con los intentos del candado normal, cuyo agotamiento ya purga PIN y
///    cierra sesión. Cadena cerrada.
/// Qué está firmando el cliente. Cambia SOLO el subtítulo y el prompt — la
/// mecánica del kiosco (candado, salida por PIN, override de idioma) es la
/// misma, y por eso el paso se reusa en vez de clonarse.
///
/// Los textos se resuelven DENTRO del `Localizations.override` de la
/// superficie del cliente, así que viaja el propósito y no la cadena ya
/// traducida: pasarla desde fuera la dejaría en el idioma del EMPLEADO.
enum KioskSignaturePurpose {
  /// M1-H5 / 6D — el cliente firma la revisión del vehículo.
  inspection,

  /// M2-H5 / 18B — el cliente firma la ENTREGA y acepta el contrato.
  checkout,
}

class KioskSignatureStep extends ConsumerStatefulWidget {
  const KioskSignatureStep({
    super.key,
    required this.tenantName,
    required this.tenantLogoUrl,
    required this.reservationLabel,
    required this.onConfirmed,
    required this.onExitToStaff,
    this.purpose = KioskSignaturePurpose.inspection,
    this.vehicleLabel,
    this.plate,
  });

  /// Nombre del tenant (display-data). Vacío ⇒ la fila del nombre no se
  /// pinta — nunca un fallback con marca propia frente al cliente.
  final String tenantName;
  final String tenantLogoUrl;
  final String reservationLabel;

  /// Firma confirmada (dataURL PNG >200 chars) — vuelve al staff.
  final void Function(String signatureDataUrl) onConfirmed;

  /// Salida deliberada sin firmar (PIN correcto o intentos agotados — en el
  /// segundo caso el paso además bloquea la app al desmontarse).
  final VoidCallback onExitToStaff;

  /// Qué trámite se firma (subtítulo + prompt).
  final KioskSignaturePurpose purpose;

  /// Identidad de lo firmado, al pie del lienzo (18B nota 6): el instante del
  /// consentimiento es el que tiene que llevar la unidad y la placa. Se arma
  /// con lo que exista — lo que falte se OMITE, nunca un "—".
  final String? vehicleLabel;
  final String? plate;

  /// Reintentos de PIN en la salida del kiosco (criterio registrado H5).
  static const maxPinAttempts = 3;

  @override
  ConsumerState<KioskSignatureStep> createState() =>
      _KioskSignatureStepState();
}

class _KioskSignatureStepState extends ConsumerState<KioskSignatureStep> {
  final _pad = SignaturePadController();
  Timer? _holdTimer;
  bool _confirming = false;

  /// Contador de intentos de la salida — en el ESTADO DEL PASO, no del
  /// diálogo: descartar el diálogo (tap fuera) no regala intentos nuevos.
  int _pinAttemptsLeft = KioskSignatureStep.maxPinAttempts;

  /// Intentos agotados: al desmontar, después del resume, se echa el
  /// candado — el lock por inactividad no protege contra un atacante ACTIVO.
  bool _lockOnExit = false;

  /// Idioma elegido por el cliente para la superficie volteada; null =
  /// heredar el del empleado.
  Locale? _clientLocale;

  /// Capturado en initState: `ref` no es seguro dentro de dispose() y el
  /// resume/lock DEBEN correr ahí (pares exactos suspend/resume).
  late final LockController _lock;

  @override
  void initState() {
    super.initState();
    // suspend/resume en pares exactos: suspend aquí, resume en dispose —
    // TODA salida del paso (firma, PIN, intentos agotados) pasa por el
    // desmontaje, así el contador del LockController nunca queda colgado.
    _lock = ref.read(lockControllerProvider.notifier);
    _lock.suspendLock();
    // H6 (política kiosco-vs-exempt): flag persistente "kiosco en curso" —
    // si el proceso muere aquí (cliente mata la app), el cold start aterriza
    // en el candado AUNQUE el usuario sea exempt. Se limpia en dispose.
    _lock.noteKioskEntered();
  }

  @override
  void dispose() {
    _holdTimer?.cancel();
    _lock.resumeLock();
    _lock.noteKioskExited(); // salida limpia: el flag de recuperación se va
    if (_lockOnExit) {
      // INN MC-1b: intentos del kiosco agotados ⇒ la superficie de staff NO
      // queda abierta — candado inmediato (el resume de arriba ya soltó la
      // suspensión, así que este lock sí muerde).
      _lock.lock(reason: 'kiosk_exit_exhausted');
    }
    _pad.dispose();
    super.dispose();
  }

  void _startHold() {
    _holdTimer?.cancel();
    // Mantener 3 s la zona de salida abre el diálogo de PIN (mockup 3C).
    _holdTimer = Timer(const Duration(seconds: 3), () {
      HapticFeedback.mediumImpact();
      _showExitPinDialog();
    });
  }

  void _cancelHold() => _holdTimer?.cancel();

  /// Verificación de UN intento. checkPin es puro (no cuenta) — el límite
  /// vive aquí y sobrevive a aperturas/cierres del diálogo.
  Future<({bool ok, int remaining})> _submitExitPin(String pin) async {
    final ok = await ref.read(lockControllerProvider.notifier).checkPin(pin);
    if (ok) return (ok: true, remaining: _pinAttemptsLeft);
    if (mounted) setState(() => _pinAttemptsLeft = _pinAttemptsLeft - 1);
    return (ok: false, remaining: _pinAttemptsLeft);
  }

  Future<void> _showExitPinDialog() async {
    if (_pinAttemptsLeft <= 0) return; // ya agotado: nada que reabrir
    final exited = await showDialog<bool>(
      context: context,
      barrierDismissible: true,
      builder: (context) => _KioskExitPinDialog(onSubmit: _submitExitPin),
    );
    if (!mounted) return;
    if (exited == true) {
      widget.onExitToStaff();
      return;
    }
    if (_pinAttemptsLeft <= 0) {
      // Agotado: volver al staff PERO bloqueado (ver dispose).
      _lockOnExit = true;
      widget.onExitToStaff();
    }
  }

  Future<void> _confirm() async {
    if (!_pad.hasInk || _confirming) return;
    setState(() => _confirming = true);
    try {
      final dataUrl = await _pad.toPngDataUrl();
      if (mounted) widget.onConfirmed(dataUrl);
    } finally {
      if (mounted) setState(() => _confirming = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final staffL10n = AppLocalizations.of(context)!;
    // PopScope: el back del sistema NO sale del kiosco (navegación
    // bloqueada mientras el teléfono está en manos del cliente).
    return PopScope(
      canPop: false,
      child: ColoredBox(
        color: RideTokens.n0,
        child: Column(
          children: [
            // Kioskbar (Tanda A 3C) — superficie de STAFF: fuera del
            // override de idioma del cliente a propósito.
            Semantics(
              label: '${staffL10n.kioskBarLabel}. ${staffL10n.kioskBarExit}',
              child: ExcludeSemantics(
                child: GestureDetector(
                  onTapDown: (_) => _startHold(),
                  onTapUp: (_) => _cancelHold(),
                  onTapCancel: _cancelHold,
                  behavior: HitTestBehavior.opaque,
                  child: Container(
                    constraints: const BoxConstraints(minHeight: 48),
                    padding: const EdgeInsets.symmetric(
                        horizontal: 14, vertical: 10),
                    // TINTA NEUTRA, no morado de plataforma (decisión de
                    // Hector sobre la nota 3 del 18B). Esta barra vive 60
                    // segundos A LA VISTA DEL CLIENTE mientras firma un
                    // contrato: la regla de la casa es cero marca de
                    // plataforma en superficies del cliente, y el gradiente
                    // p-900→p-800 la rompía aunque no llevara logo. El
                    // contraste no se sacrifica: blanco sobre n-900→n-800
                    // mide 18.1:1 / 13.8:1 (peor parada), contra 11.2:1 del
                    // morado. Alcanza también a la firma de inspección del M1
                    // — es la misma barra.
                    decoration: const BoxDecoration(
                      gradient: LinearGradient(
                        colors: [RideTokens.n900, RideTokens.n800],
                      ),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.lock_outline_rounded,
                            size: 15, color: Colors.white),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            staffL10n.kioskBarLabel,
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 12.5,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 0.4,
                            ),
                          ),
                        ),
                        Text(
                          staffL10n.kioskBarExit,
                          style: const TextStyle(
                            color: Color(0xEBFFFFFF),
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            // Superficie del CLIENTE: idioma propio (GD-2). El override solo
            // cubre lo que el cliente lee — tenantbar, prompt, lienzo,
            // botones.
            Expanded(
              child: Localizations.override(
                context: context,
                locale: _clientLocale,
                child: Builder(
                  builder: (clientContext) =>
                      _buildClientSurface(clientContext),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildClientSurface(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Column(
      children: [
        // Tenantbar: la marca del TENANT, tinta neutra (nota 10). Sin
        // nombre no hay fila de nombre — solo el subtítulo del trámite.
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          decoration: const BoxDecoration(
            color: RideTokens.n0,
            border: Border(bottom: BorderSide(color: RideTokens.n200)),
          ),
          child: Row(
            children: [
              Container(
                width: 38,
                height: 38,
                clipBehavior: Clip.antiAlias,
                decoration: BoxDecoration(
                  color: RideTokens.n800,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: widget.tenantLogoUrl.isNotEmpty
                    ? Image.network(
                        widget.tenantLogoUrl,
                        fit: BoxFit.cover,
                        errorBuilder: (_, _, _) =>
                            _initialsLogo(widget.tenantName),
                      )
                    : _initialsLogo(widget.tenantName),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (widget.tenantName.isNotEmpty)
                      Text(
                        widget.tenantName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w800,
                          color: RideTokens.n900,
                        ),
                      ),
                    Text(
                      switch (widget.purpose) {
                        KioskSignaturePurpose.inspection =>
                          l10n.kioskSignSubtitle(widget.reservationLabel),
                        KioskSignaturePurpose.checkout =>
                          l10n.kioskSignSubtitleCheckout(
                            widget.reservationLabel,
                          ),
                      },
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: RideTokens.n600,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              _LanguageToggle(
                selected: _clientLocale ?? Localizations.localeOf(context),
                onChanged: (locale) =>
                    setState(() => _clientLocale = locale),
                spanishLabel: l10n.langSpanish,
                englishLabel: l10n.langEnglish,
              ),
            ],
          ),
        ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 12, 18, 22),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  switch (widget.purpose) {
                    KioskSignaturePurpose.inspection => l10n.kioskSignPrompt,
                    KioskSignaturePurpose.checkout =>
                      l10n.kioskSignPromptCheckout,
                  },
                  style: const TextStyle(
                    fontSize: 14.5,
                    fontWeight: FontWeight.w600,
                    color: RideTokens.n800,
                  ),
                ),
                const SizedBox(height: 8),
                Expanded(
                  child: SignaturePad(
                    controller: _pad,
                    hint: l10n.kioskSignHint,
                  ),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: _NeutralButton(
                        label: l10n.kioskSignClear,
                        filled: false,
                        onTap: _pad.clear,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: AnimatedBuilder(
                        animation: _pad,
                        builder: (context, _) => _NeutralButton(
                          label: l10n.kioskSignConfirm,
                          filled: true,
                          // Sin tinta no hay firma que confirmar.
                          onTap:
                              _pad.hasInk && !_confirming ? _confirm : null,
                        ),
                      ),
                    ),
                  ],
                ),
                if (_footLine(l10n) case final foot?) ...[
                  const SizedBox(height: 10),
                  Text(
                    foot,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      // n700 (9.22:1) y no n600 (5.04:1): esto se lee al sol,
                      // en el patio, antes de firmar.
                      color: RideTokens.n700,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }

  /// "Autos del Valle · Corolla 2023 · Placa MXA-4471". Se OMITE entera si no
  /// hay nada que decir; el nombre del tenant ya viene filtrado por
  /// `clientSafeCompanyName`, así que aquí nunca aparece marca de plataforma.
  String? _footLine(AppLocalizations l10n) {
    final vehicle = widget.vehicleLabel ?? '';
    final plate = widget.plate ?? '';
    // Sin UNIDAD el pie no existe: el nombre del tenant solo repetiría la
    // tenantbar que está tres centímetros arriba, y este renglón está aquí
    // para decir QUÉ se firma, no quién lo emite.
    if (vehicle.isEmpty && plate.isEmpty) return null;
    return [
      widget.tenantName,
      vehicle,
      plate.isEmpty ? '' : l10n.kioskSignPlate(plate),
    ].where((p) => p.isNotEmpty).join(' · ');
  }

  static Widget _initialsLogo(String name) {
    final initials = name
        .split(RegExp(r'\s+'))
        .where((p) => p.isNotEmpty)
        .take(2)
        .map((p) => p[0])
        .join()
        .toUpperCase();
    return Center(
      child: Text(
        initials.isEmpty ? '·' : initials,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 14,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

/// Conmutador ES|EN de la superficie del cliente (GD-2). Los rótulos son
/// CÓDIGOS de idioma (idénticos en ambos locales) — la parte localizable es
/// la etiqueta de accesibilidad. Tinta neutra: nada de morado de marca.
class _LanguageToggle extends StatelessWidget {
  const _LanguageToggle({
    required this.selected,
    required this.onChanged,
    required this.spanishLabel,
    required this.englishLabel,
  });

  final Locale selected;
  final ValueChanged<Locale> onChanged;
  final String spanishLabel;
  final String englishLabel;

  @override
  Widget build(BuildContext context) {
    Widget option(String code, String semantics, Locale locale) {
      final active = selected.languageCode == locale.languageCode;
      return Semantics(
        button: true,
        selected: active,
        label: semantics,
        onTap: () => onChanged(locale),
        child: ExcludeSemantics(
          child: Material(
            color: active ? RideTokens.n800 : RideTokens.n0,
            borderRadius: BorderRadius.circular(10),
            child: InkWell(
              onTap: () => onChanged(locale),
              borderRadius: BorderRadius.circular(10),
              child: Container(
                constraints:
                    const BoxConstraints(minWidth: 48, minHeight: 48),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(10),
                  border: active
                      ? null
                      : Border.all(color: RideTokens.n300, width: 1.5),
                ),
                child: Text(
                  code,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                    color: active ? Colors.white : RideTokens.n700,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        option('ES', spanishLabel, const Locale('es')),
        const SizedBox(width: 6),
        option('EN', englishLabel, const Locale('en')),
      ],
    );
  }
}

/// Botonera NEUTRA del kiosco: n-800 lleno / ghost — nunca el morado de
/// marca frente al cliente (nota 10 del mockup).
class _NeutralButton extends StatelessWidget {
  const _NeutralButton({
    required this.label,
    required this.filled,
    required this.onTap,
  });

  final String label;
  final bool filled;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return Opacity(
      opacity: enabled ? 1 : 0.55,
      child: Material(
        color: filled ? RideTokens.n800 : RideTokens.n0,
        borderRadius: BorderRadius.circular(18),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(18),
          child: Container(
            constraints: const BoxConstraints(minHeight: 56),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(18),
              border:
                  filled ? null : Border.all(color: RideTokens.n300, width: 1.5),
            ),
            child: Text(
              label,
              style: TextStyle(
                color: filled ? Colors.white : RideTokens.n800,
                fontSize: 16,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Diálogo de PIN de salida. NO cuenta intentos (INN MC-1a): cada envío
/// pasa por [onSubmit] del paso, que es quien descuenta y decide — cerrar y
/// reabrir este diálogo no resetea nada.
class _KioskExitPinDialog extends StatefulWidget {
  const _KioskExitPinDialog({required this.onSubmit});

  final Future<({bool ok, int remaining})> Function(String pin) onSubmit;

  @override
  State<_KioskExitPinDialog> createState() => _KioskExitPinDialogState();
}

class _KioskExitPinDialogState extends State<_KioskExitPinDialog> {
  final _pinController = TextEditingController();
  bool _checking = false;
  int? _remainingAfterError;

  @override
  void dispose() {
    _pinController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final pin = _pinController.text.trim();
    if (pin.length < 4 || _checking) return;
    setState(() => _checking = true);
    final result = await widget.onSubmit(pin);
    if (!mounted) return;
    if (result.ok) {
      Navigator.of(context).pop(true);
      return;
    }
    if (result.remaining <= 0) {
      // Agotado: el paso vuelve al staff BLOQUEADO (kiosk_exit_exhausted).
      final l10n = AppLocalizations.of(context)!;
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(content: Text(l10n.kioskExitExhausted)),
      );
      Navigator.of(context).pop(false);
      return;
    }
    setState(() {
      _remainingAfterError = result.remaining;
      _checking = false;
      _pinController.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return AlertDialog(
      backgroundColor: RideTokens.n0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      title: Text(
        l10n.kioskExitPinTitle,
        style: const TextStyle(
          fontSize: 18,
          fontWeight: FontWeight.w800,
          color: RideTokens.n900,
        ),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            l10n.kioskExitPinBody,
            style: const TextStyle(
              fontSize: 13.5,
              color: RideTokens.n700,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _pinController,
            autofocus: true,
            obscureText: true,
            keyboardType: TextInputType.number,
            maxLength: 4,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 24,
              fontWeight: FontWeight.w800,
              letterSpacing: 8,
            ),
            decoration: const InputDecoration(counterText: ''),
            onSubmitted: (_) => _submit(),
          ),
          if (_remainingAfterError != null) ...[
            const SizedBox(height: 6),
            Text(
              l10n.kioskExitWrongPin(_remainingAfterError!),
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: RideTokens.dangerTx,
              ),
            ),
          ],
        ],
      ),
      actions: [
        TextButton(
          style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(l10n.cancelButton),
        ),
        TextButton(
          style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
          onPressed: _checking ? null : _submit,
          child: Text(l10n.continueButton),
        ),
      ],
    );
  }
}
