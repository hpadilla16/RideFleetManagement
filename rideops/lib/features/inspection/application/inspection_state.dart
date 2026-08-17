import 'package:flutter/foundation.dart';

import '../../../core/api/api_error.dart';
import '../../../core/api/dto/reservation_display.dart';

/// Los 8 ángulos canónicos EN SU ORDEN (INSPECTION_ANGLES,
/// mobile-inspection.service.js:35-44). Las etiquetas visibles salen de
/// l10n — aquí solo las llaves de wire.
const kInspectionAngleKeys = [
  'front',
  'rear',
  'left',
  'right',
  'front_seat',
  'rear_seat',
  'dash',
  'trunk',
];

/// front + rear obligatorios: el MISMO gate que el backend
/// (REQUIRED_ANGLES_MISSING, service:199-207) — la UI no inventa reglas, las
/// replica (nota 4 del mockup 6A).
const kRequiredAngleKeys = {'front', 'rear'};

enum InspectionFlowPhase {
  loading,

  /// Sin red en la carga inicial — para ARRANCAR el flujo se necesita señal
  /// una vez (crear/leer la sesión); capturar y terminar ya funcionan
  /// offline.
  offline,

  /// Error de negocio en la carga (403 de sede, NO_VEHICLE_ASSIGNED…): se
  /// muestra el mensaje del servidor, nunca "no hay datos".
  failed,

  /// 6F: otra superficie completó la inspección — reconciliación, con purga
  /// selectiva de la bandeja ya hecha.
  alreadyCompleted,

  active,
}

enum AngleStatus {
  pending,

  /// Foto tomada, compresión nativa corriendo (spinner del tile 6A).
  compressing,

  /// Captura/compresión falló — "toca para reintentar" reabre la cámara en
  /// ese ángulo. Los fallos de RED no viven aquí (son de la bandeja).
  failed,

  /// Comprimida, cifrada y ENCOLADA (fila inspection_photo con sede
  /// sellada). El tile muestra check + peso.
  queued,

  /// El servidor ya la tenía (captura previa vía la web u otra corrida) —
  /// cuenta para el gate front+rear sin re-capturar.
  onServer,
}

@immutable
class AngleUi {
  const AngleUi({
    required this.key,
    this.status = AngleStatus.pending,
    this.bytes,
    this.capturedAt,
    this.thumbnail,
  });

  final String key;
  final AngleStatus status;
  final int? bytes;
  final DateTime? capturedAt;

  /// Miniatura del tile (bytes JPEG comprimidos, pintados con cacheWidth).
  /// Solo para capturas de ESTA corrida — las restauradas de la bandeja
  /// muestran check sin foto (descifrar 8 archivos para pintar tiles sería
  /// pagar memoria/CPU por decoración).
  final Uint8List? thumbnail;

  bool get countsAsCaptured =>
      status == AngleStatus.queued || status == AngleStatus.onServer;

  AngleUi copyWith({
    AngleStatus? status,
    int? bytes,
    DateTime? capturedAt,
    Uint8List? thumbnail,
  }) =>
      AngleUi(
        key: key,
        status: status ?? this.status,
        bytes: bytes ?? this.bytes,
        capturedAt: capturedAt ?? this.capturedAt,
        thumbnail: thumbnail ?? this.thumbnail,
      );
}

/// Pasos del flujo (stepper de 3 del mockup): 0 = fotos, 1 = métricas,
/// 2 = firma (modo kiosco), 3 = resumen/terminar (6E).
enum InspectionStep { photos, metrics, signature, summary }

@immutable
class InspectionFlowState {
  const InspectionFlowState({
    this.phase = InspectionFlowPhase.loading,
    this.error,
    this.sessionId,
    this.reservationNumber,
    this.vehicleLabel,
    this.previousOdometer,
    this.branding,
    this.linkExpiresAt,
    this.angles = const {},
    this.step = InspectionStep.photos,
    this.odometer,
    this.fuelEighths,
    this.cleanliness,
    this.notes = '',
    this.signatureDataUrl,
    this.completeQueued = false,
    this.outboxFull = false,
    this.customerName,
    this.completedAt,
  });

  final InspectionFlowPhase phase;
  final ApiError? error;
  final String? sessionId;
  final String? reservationNumber;
  final String? vehicleLabel;

  /// "Última lectura registrada" (Vehicle.mileage vía display-data — nota 7
  /// del mockup 6C). null = la línea no se pinta.
  final int? previousOdometer;

  /// Branding del tenant para la superficie volteada (6D).
  final TenantBranding? branding;

  /// Vencimiento del enlace minteado al cargar (pie informativo de 6E). El
  /// drenador re-mintea al drenar — esto es información, no un límite.
  final DateTime? linkExpiresAt;

  final Map<String, AngleUi> angles;
  final InspectionStep step;

  final int? odometer;

  /// Combustible en OCTAVOS en la UI (fuelbar de 8) → fracción 0..1 al
  /// contrato del complete. SIN default (review GD-5/INN S-4): es evidencia
  /// contractual — un "lleno" que nadie tocó registraría datos falsos. El
  /// CTA a firma lo exige igual que odómetro y limpieza.
  final int? fuelEighths;
  final int? cleanliness;
  final String notes;
  final String? signatureDataUrl;
  final bool completeQueued;

  /// Tope de la bandeja alcanzado: la captura nueva se bloquea ANTES de
  /// abrir la cámara (mockup 7D nota 7).
  final bool outboxFull;

  /// Nombre del cliente (display-data) — se SELLA como signerName en el
  /// complete: la firma legal queda con firmante (review INN S-3).
  final String? customerName;

  /// inspectionCompletedAt de la sesión cuando otra superficie ya terminó —
  /// el 6F cuenta la historia con hora (review GD).
  final DateTime? completedAt;

  int get capturedCount =>
      angles.values.where((a) => a.countsAsCaptured).length;

  bool get requiredCaptured =>
      kRequiredAngleKeys.every((k) => angles[k]?.countsAsCaptured ?? false);

  double? get fuelFraction =>
      fuelEighths == null ? null : fuelEighths! / 8;

  bool get metricsComplete =>
      odometer != null && cleanliness != null && fuelEighths != null;

  InspectionFlowState copyWith({
    InspectionFlowPhase? phase,
    ApiError? error,
    String? sessionId,
    String? reservationNumber,
    String? vehicleLabel,
    int? previousOdometer,
    TenantBranding? branding,
    DateTime? linkExpiresAt,
    Map<String, AngleUi>? angles,
    InspectionStep? step,
    int? odometer,
    int? fuelEighths,
    int? cleanliness,
    String? notes,
    String? signatureDataUrl,
    bool? completeQueued,
    bool? outboxFull,
    String? customerName,
    DateTime? completedAt,
  }) =>
      InspectionFlowState(
        phase: phase ?? this.phase,
        error: error ?? this.error,
        sessionId: sessionId ?? this.sessionId,
        reservationNumber: reservationNumber ?? this.reservationNumber,
        vehicleLabel: vehicleLabel ?? this.vehicleLabel,
        previousOdometer: previousOdometer ?? this.previousOdometer,
        branding: branding ?? this.branding,
        linkExpiresAt: linkExpiresAt ?? this.linkExpiresAt,
        angles: angles ?? this.angles,
        step: step ?? this.step,
        odometer: odometer ?? this.odometer,
        fuelEighths: fuelEighths ?? this.fuelEighths,
        cleanliness: cleanliness ?? this.cleanliness,
        notes: notes ?? this.notes,
        signatureDataUrl: signatureDataUrl ?? this.signatureDataUrl,
        completeQueued: completeQueued ?? this.completeQueued,
        outboxFull: outboxFull ?? this.outboxFull,
        customerName: customerName ?? this.customerName,
        completedAt: completedAt ?? this.completedAt,
      );
}
