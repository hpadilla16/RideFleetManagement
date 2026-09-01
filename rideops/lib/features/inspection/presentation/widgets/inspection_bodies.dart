import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/l10n/odometer_format.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../application/inspection_controller.dart';
import '../../application/inspection_state.dart';
import 'angle_grid.dart';

/// **Cuerpos** de los tres sub-pasos de la captura (fotos → estado → resumen),
/// SIN su CTA.
///
/// Extraídos de `inspection_screen.dart` en M2-H4 y no reescritos: la captura
/// del M1 se integra al wizard, no se rediseña. Lo único que cambia es de
/// quién es el botón —el pie del wizard hospeda el CTA del sub-paso (nota 7
/// del mockup 17: jamás dos "Continuar")— así que el CTA sale del cuerpo y lo
/// pone cada superficie:
///  - la pantalla suelta del M1 (`/inspection/:id`) con su propio botón,
///  - el paso 4 del wizard dentro de [WizardDock].
///
/// Ninguno de estos widgets decide nada: reciben estado y lo pintan.

/// Barra de sub-paso: 3 segmentos de 5 px (fotos → estado → firma/resumen).
///
/// En el wizard SUSTITUYE al rail de 5 fases durante la captura (decisión de
/// cromo aprobada: "convive comprimido"). Es el mismo componente que ya usaba
/// la pantalla suelta del M1 — no uno nuevo (nota 6 del mockup 17).
class InspectionSubStepBar extends StatelessWidget {
  const InspectionSubStepBar({super.key, required this.step});

  final InspectionStep step;

  @override
  Widget build(BuildContext context) {
    final active = switch (step) {
      InspectionStep.photos => 1,
      InspectionStep.metrics => 2,
      InspectionStep.signature || InspectionStep.summary => 3,
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 10, 18, 0),
      child: Row(
        children: [
          for (var i = 0; i < 3; i++) ...[
            if (i > 0) const SizedBox(width: 6),
            Expanded(
              child: Container(
                height: 5,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(3),
                  gradient: i < active
                      ? const LinearGradient(
                          colors: [Color(0xFF7F4FF0), RideTokens.p600])
                      : null,
                  color: i < active ? null : RideTokens.n200,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Sub-paso 1 — grid de los 8 ángulos (6A/17B).
class InspectionPhotosBody extends StatelessWidget {
  const InspectionPhotosBody({
    super.key,
    required this.state,
    required this.online,
    required this.onTapAngle,
    this.deadAngles = const {},
    this.leading = const [],
  });

  final InspectionFlowState state;
  final bool online;
  final void Function(String angleKey) onTapAngle;

  /// Ángulos muertos en la bandeja (17E) — el tile lo dice con palabras.
  final Set<String> deadAngles;

  /// Banners que la superficie inyecta encima del grid (los del shell del
  /// wizard, o el aviso de bandeja llena).
  final List<Widget> leading;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        ...leading,
        if (!online) ...[
          InspectionWarnBanner(text: l10n.inspOfflineBanner),
          const SizedBox(height: 10),
        ],
        if (state.outboxFull) ...[
          InspectionWarnBanner(text: l10n.inspOutboxFull),
          const SizedBox(height: 10),
        ],
        AngleGrid(
          angles: state.angles,
          onTapAngle: onTapAngle,
          deadAngles: deadAngles,
        ),
      ],
    );
  }
}

/// Sub-paso 2 — odómetro, combustible, limpieza y notas (6C/17B).
class InspectionMetricsBody extends StatefulWidget {
  const InspectionMetricsBody({
    super.key,
    required this.state,
    required this.controller,
    this.leading = const [],
  });

  final InspectionFlowState state;
  final InspectionController controller;
  final List<Widget> leading;

  @override
  State<InspectionMetricsBody> createState() => _InspectionMetricsBodyState();
}

class _InspectionMetricsBodyState extends State<InspectionMetricsBody> {
  late final TextEditingController _odometer;
  late final TextEditingController _notes;

  /// El foco del odómetro y el ancla de su bloque. Los dos existen por el
  /// mismo hallazgo e2e: con el teclado numérico abierto, el viewport del
  /// paso se encoge hasta el pie del wizard y la fila de LIMPIEZA —que está
  /// debajo del combustible— queda recortada contra el dock. El agente tenía
  /// que cerrar el teclado con el BACK físico para volver a verla.
  final _odometerFocus = FocusNode();
  final _odometerAnchor = GlobalKey();

  @override
  void initState() {
    super.initState();
    _odometer =
        TextEditingController(text: widget.state.odometer?.toString() ?? '');
    _notes = TextEditingController(text: widget.state.notes);
    _odometerFocus.addListener(_onOdometerFocus);
  }

  @override
  void dispose() {
    _odometerFocus.removeListener(_onOdometerFocus);
    _odometerFocus.dispose();
    _odometer.dispose();
    _notes.dispose();
    super.dispose();
  }

  /// Al enfocar el odómetro, su bloque sube al TOPE del viewport.
  ///
  /// El auto-scroll que trae `EditableText` solo garantiza que se vea el
  /// CURSOR: si el campo ya estaba visible no mueve nada, y todo lo que va
  /// debajo (combustible, limpieza, notas) se queda fuera. Alineando el
  /// bloque arriba, el espacio que el teclado deja libre se gasta entero en
  /// los controles que siguen, que es lo que el agente necesita tocar a
  /// continuación.
  ///
  /// Se agenda tras el frame porque el inset del teclado todavía no llegó
  /// cuando el foco cambia: pedir `ensureVisible` con la altura vieja
  /// dejaría el scroll donde no sirve.
  void _onOdometerFocus() {
    if (!_odometerFocus.hasFocus) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final context = _odometerAnchor.currentContext;
      if (!mounted || context == null) return;
      unawaited(
        Scrollable.ensureVisible(
          context,
          alignment: 0,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
        ),
      );
    });
  }

  /// Cierra el teclado, sea de quien sea el foco.
  ///
  /// Lo llama el toque FUERA de un campo: en Android el `onTapOutside` por
  /// defecto NO desenfoca (solo lo hace en escritorio/web), así que sin esto
  /// un toque en el selector de limpieza seleccionaba el número y dejaba el
  /// teclado puesto tapando media pantalla.
  ///
  /// Va por `FocusScope` y no por el nodo del odómetro (review SC-3): las
  /// NOTAS son multilínea y ahí el IME no trae acción de cierre por
  /// definición —la tecla es un salto de línea—, así que el toque fuera es la
  /// única salida que tiene ese campo.
  void _dismissKeyboard() => FocusScope.of(context).unfocus();

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final state = widget.state;
    final controller = widget.controller;
    final prev = state.previousOdometer;
    final lowerThanPrev =
        state.odometer != null && prev != null && state.odometer! < prev;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        ...widget.leading,
        _FieldLabel(key: _odometerAnchor, l10n.metricsOdometer),
        TextField(
          controller: _odometer,
          focusNode: _odometerFocus,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          // El odómetro es el ÚNICO campo numérico del paso y no hay ninguno
          // después: la acción del IME es "listo", no "siguiente". Explícita y
          // no heredada del default de Flutter, porque de este renglón depende
          // que el teclado tenga una salida propia.
          //
          // Sin `onEditingComplete` a propósito (review m-2): el default de
          // EditableText para `done` ya desenfoca, y un handler que repite el
          // comportamiento del framework es código que nadie puede romper y
          // ninguna prueba puede distinguir.
          textInputAction: TextInputAction.done,
          onTapOutside: (_) => _dismissKeyboard(),
          style: const TextStyle(
            fontSize: 24,
            fontWeight: FontWeight.w800,
            color: RideTokens.n900,
            fontFeatures: [FontFeature.tabularFigures()],
          ),
          // La unidad sale del catálogo compartido: este sufijo y el "9,800 mi"
          // del paso 1 ya no pueden discrepar (hallazgo e2e).
          decoration: _inputDecoration(suffixText: l10n.odometerUnit),
          onChanged: (v) => controller.setOdometer(int.tryParse(v)),
        ),
        if (prev != null) ...[
          const SizedBox(height: 6),
          Text(
            // Fuente: endpoint autenticado (display-data → Vehicle.mileage)
            // — nota 7 del mockup: el token de inspección NO trae esto. Se
            // formatea con el MISMO helper que el paso 1: antes esta línea
            // interpolaba el entero crudo ("9800 mi") mientras la tarjeta de
            // confirmación decía "9.800 km".
            l10n.metricsPrevReading(formatOdometer(l10n, locale, prev)),
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w600,
              color: RideTokens.n700,
            ),
          ),
        ],
        if (lowerThanPrev) ...[
          const SizedBox(height: 6),
          // Warning NO bloqueante: el backend acepta — la corrección es
          // humana (nota 7).
          InspectionWarnBanner(text: l10n.metricsOdometerLower),
        ],
        _FieldLabel(l10n.metricsFuel),
        _FuelBar(
          eighths: state.fuelEighths,
          onChanged: controller.setFuelEighths,
          emptyLabel: l10n.fuelEmpty,
          fullLabel: l10n.fuelFull,
        ),
        _FieldLabel(l10n.metricsCleanliness),
        _CleanlinessRow(
          selected: state.cleanliness,
          onChanged: controller.setCleanliness,
          dirtyLabel: l10n.cleanDirty,
          spotlessLabel: l10n.cleanSpotless,
        ),
        _FieldLabel(l10n.metricsNotes),
        TextField(
          controller: _notes,
          minLines: 3,
          maxLines: 5,
          maxLength: 2000,
          style: const TextStyle(fontSize: 14, color: RideTokens.n800),
          decoration: _inputDecoration(counterText: ''),
          // Multilínea: su tecla de acción ES un salto de línea, así que el
          // toque fuera es la ÚNICA forma de cerrar este teclado (SC-3).
          onTapOutside: (_) => _dismissKeyboard(),
          onChanged: controller.setNotes,
        ),
      ],
    );
  }

  static InputDecoration _inputDecoration({
    String? suffixText,
    String? counterText,
  }) =>
      InputDecoration(
        suffixText: suffixText,
        counterText: counterText,
        filled: true,
        fillColor: RideTokens.n0,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: const BorderSide(color: RideTokens.n300, width: 1.5),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          // Foco AZUL del sistema — nunca morado sobre morado.
          borderSide: const BorderSide(color: RideTokens.focus, width: 2),
        ),
      );
}

/// Sub-paso 3 — qué viaja y cómo viaja (6E). El CTA ("Terminar") es de quien
/// hospeda el cuerpo.
class InspectionSummaryBody extends StatelessWidget {
  const InspectionSummaryBody({
    super.key,
    required this.state,
    required this.online,
    this.leading = const [],
  });

  final InspectionFlowState state;
  final bool online;
  final List<Widget> leading;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        ...leading,
        if (!online) ...[
          InspectionWarnBanner(text: l10n.inspOfflineBanner),
          const SizedBox(height: 10),
        ],
        // La bandeja llena mata el "Terminar": `finish()` devuelve
        // `EnqueueResult.full` y deja `outboxFull` puesto
        // (inspection_controller.dart:342-348). Sin este aviso el CTA primario
        // no hace nada y no dice nada. Vive en el cuerpo COMPARTIDO para que lo
        // hereden las dos superficies —el paso 4 del wizard descarta el
        // resultado del enqueue— igual que en [InspectionPhotosBody].
        if (state.outboxFull) ...[
          InspectionWarnBanner(text: l10n.inspOutboxFull),
          const SizedBox(height: 10),
        ],
        InspectionQueueCard(photos: state.capturedCount, online: online),
      ],
    );
  }
}

/// Tarjeta "esto es lo que va a salir de este teléfono" (6E/17D).
class InspectionQueueCard extends StatelessWidget {
  const InspectionQueueCard({
    super.key,
    required this.photos,
    required this.online,
  });

  final int photos;
  final bool online;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: RideTokens.n0,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0x248752FE)),
      ),
      child: Row(
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: const Color(0x148752FE),
              borderRadius: BorderRadius.circular(14),
            ),
            child: const Icon(Icons.outbox_outlined,
                size: 20, color: RideTokens.p700),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  l10n.summaryQueueTitle(photos),
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w800,
                    color: RideTokens.n900,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  // "Guardado local cifrado" — respaldado por ADR-7
                  // (SQLCipher + AES-GCM de la bóveda), no adorno.
                  l10n.summaryQueueMeta,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: RideTokens.n600,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: RideTokens.infoBg,
              border: Border.all(color: RideTokens.infoBd),
              borderRadius: BorderRadius.circular(7),
            ),
            child: Text(
              online
                  ? l10n.summaryQueueBadgeOnline
                  : l10n.summaryQueueBadgeOffline,
              style: const TextStyle(
                fontSize: 10.5,
                fontWeight: FontWeight.w800,
                color: RideTokens.n800,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Aviso ámbar del flujo de inspección (sin red, bandeja llena, odómetro más
/// bajo que la última lectura).
class InspectionWarnBanner extends StatelessWidget {
  const InspectionWarnBanner({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: RideTokens.warnBg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: RideTokens.warnBd),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.warning_amber_rounded,
              size: 18, color: RideTokens.warnTx),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
                color: RideTokens.warnTx,
                height: 1.45,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _FieldLabel extends StatelessWidget {
  const _FieldLabel(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 6),
      child: Text(
        text.toUpperCase(),
        style: const TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.6,
          color: RideTokens.n600,
        ),
      ),
    );
  }
}

/// Combustible en octavos (fuelbar del mockup 6C) — targets por segmento
/// ≥48 px de alto vía el gesto sobre toda la fila. [eighths] null = SIN
/// seleccionar (GD-5/INN S-4: sin default de "lleno" — evidencia
/// contractual se captura, no se presume).
class _FuelBar extends StatelessWidget {
  const _FuelBar({
    required this.eighths,
    required this.onChanged,
    required this.emptyLabel,
    required this.fullLabel,
  });

  final int? eighths;
  final ValueChanged<int> onChanged;
  final String emptyLabel;
  final String fullLabel;

  @override
  Widget build(BuildContext context) {
    final filled = eighths ?? 0;
    return Column(
      children: [
        Row(
          children: [
            for (var i = 1; i <= 8; i++) ...[
              if (i > 1) const SizedBox(width: 4),
              Expanded(
                child: Semantics(
                  button: true,
                  label: '$i/8',
                  selected: eighths == i,
                  onTap: () => onChanged(i),
                  child: ExcludeSemantics(
                    child: InkWell(
                      onTap: () => onChanged(i),
                      borderRadius: BorderRadius.circular(7),
                      child: Container(
                        height: 48,
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(7),
                          gradient: i <= filled
                              ? const LinearGradient(
                                  begin: Alignment.topCenter,
                                  end: Alignment.bottomCenter,
                                  colors: [Color(0xFF9F79FF), RideTokens.p600],
                                )
                              : null,
                          color: i <= filled ? null : RideTokens.n200,
                          border: Border.all(
                            color:
                                i <= filled ? RideTokens.p600 : RideTokens.n300,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
        const SizedBox(height: 6),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(emptyLabel, style: edgeStyle),
            Text(
              eighths == null ? '—' : '$eighths/8',
              style: const TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w800,
                color: RideTokens.n900,
                fontFeatures: [FontFeature.tabularFigures()],
              ),
            ),
            Text(fullLabel, style: edgeStyle),
          ],
        ),
      ],
    );
  }

  static const edgeStyle = TextStyle(
    fontSize: 12.5,
    fontWeight: FontWeight.w700,
    color: RideTokens.n700,
  );
}

/// Limpieza 1-5 en segmentos de 52 px con NÚMERO (nota 8: bajo el sol el
/// color se lava, el dígito no).
class _CleanlinessRow extends StatelessWidget {
  const _CleanlinessRow({
    required this.selected,
    required this.onChanged,
    required this.dirtyLabel,
    required this.spotlessLabel,
  });

  final int? selected;
  final ValueChanged<int> onChanged;
  final String dirtyLabel;
  final String spotlessLabel;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Row(
          children: [
            for (var i = 1; i <= 5; i++) ...[
              if (i > 1) const SizedBox(width: 8),
              Expanded(
                child: Semantics(
                  button: true,
                  label: '$i',
                  selected: selected == i,
                  onTap: () => onChanged(i),
                  child: ExcludeSemantics(
                    child: Material(
                      color: selected == i ? RideTokens.p50 : RideTokens.n0,
                      borderRadius: BorderRadius.circular(14),
                      child: InkWell(
                        onTap: () => onChanged(i),
                        borderRadius: BorderRadius.circular(14),
                        child: Container(
                          height: 52,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(14),
                            border: Border.all(
                              color: selected == i
                                  ? RideTokens.p600
                                  : RideTokens.n300,
                              width: 1.5,
                            ),
                          ),
                          child: Text(
                            '$i',
                            style: TextStyle(
                              fontSize: 14.5,
                              fontWeight: FontWeight.w800,
                              color: selected == i
                                  ? RideTokens.p800
                                  : RideTokens.n700,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
        const SizedBox(height: 6),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(dirtyLabel, style: _FuelBar.edgeStyle),
            Text(spotlessLabel, style: _FuelBar.edgeStyle),
          ],
        ),
      ],
    );
  }
}
