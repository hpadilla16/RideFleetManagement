import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/api/api_providers.dart';
import '../../../core/db/outbox_db.dart';
import '../../../core/db/outbox_providers.dart';
import '../../../core/outbox/drain_coordinator.dart';
import '../../../core/outbox/outbox_service.dart';
import '../../../core/session/active_location.dart';
import '../../../core/telemetry/event_logger.dart';
import 'inspection_outbox_view.dart';
import 'inspection_state.dart';

/// Orquestador del flujo de inspección nativa (H5, mockup 6A-6F).
///
/// Reglas de carga:
///  - Arrancar EXIGE red una vez: leer/crear la CheckoutSession (el id de
///    sesión sella las filas del outbox). Después, capturar/terminar
///    funciona 100 % offline vía la bandeja.
///  - Si `inspectionCompletedAt` ya está estampado → fase 6F: se cuenta en
///    pasado, se retiran de la bandeja los envíos de ESA sesión (purga
///    selectiva con rastro) y se ofrecen salidas.
///  - display-data (branding + vehículo + última lectura) y el estado de
///    ángulos del servidor son best-effort: sin ellos el flujo sigue, solo
///    con menos contexto (nota 7 del mockup: fallback silencioso a ocultar).
class InspectionController extends Notifier<InspectionFlowState> {
  InspectionController(this.reservationId);

  final String reservationId;

  /// Ángulos que la ÚLTIMA emisión de la bandeja mostró todavía encolados.
  ///
  /// Es la memoria mínima que permite afirmar "el servidor la tiene" sin
  /// mentir: un ángulo que estaba en la bandeja y ya no tiene fila salió por
  /// `markDrained`, y el drenador solo borra con `DrainOk` (2xx). Sin este
  /// "estaba antes", la primera emisión —o la ventana entre encolar y que el
  /// stream de drift emita— pintaría "enviada" una foto que sigue en el
  /// teléfono.
  Set<String> _queuedAnglesSeen = const {};

  @override
  InspectionFlowState build() {
    _queuedAnglesSeen = const {};
    // La bandeja es la mitad LOCAL de la verdad del paso: se escucha para
    // convertir "encolada" en "el servidor la tiene" (M2-H4, frames 17B/17D).
    ref.listen<AsyncValue<List<OutboxEntry>>>(outboxRowsProvider, (_, next) {
      final rows = next.value;
      if (rows != null) _reconcileWithOutbox(rows);
    });
    Future.microtask(load);
    return const InspectionFlowState();
  }

  EventLogger get _logger => ref.read(eventLoggerProvider);
  OutboxService get _outbox => ref.read(outboxServiceProvider);

  Future<void> load() async {
    state = const InspectionFlowState(); // reset (reintentos)
    // Criterio registrado H4/H5: ningún fetch scoped por sede (display-data
    // va con x-view-location) ni sello de sede en filas nuevas con el
    // override a MEDIO hidratar. Espera acotada compartida (H7): una sola
    // implementación para todos los controllers imperativos.
    await awaitActiveLocationHydrated(ref);
    if (!ref.mounted) return;
    try {
      final api = ref.read(checkoutApiProvider);
      var session = await api.getByReservation(reservationId);
      session ??= await api.createForReservation(reservationId);
      if (!ref.mounted) return;

      if (session.inspectionCompletedAt != null) {
        // 6F: otra superficie terminó — retirar los envíos de esta sesión
        // (no se manda nada duplicado) y contar la historia en pasado, CON
        // reserva y hora (review GD: el chip debe pintar, el copy lleva la
        // hora del cierre).
        String? reservationNumber;
        try {
          final display = await ref
              .read(reservationsApiProvider)
              .getDisplayData(reservationId);
          reservationNumber = display.reservation.reservationNumber;
        } catch (_) {}
        try {
          await _outbox.discardSession(session.id);
        } catch (_) {}
        if (!ref.mounted) return;
        state = state.copyWith(
          phase: InspectionFlowPhase.alreadyCompleted,
          sessionId: session.id,
          reservationNumber: reservationNumber,
          completedAt: session.inspectionCompletedAt,
        );
        return;
      }

      var next = state.copyWith(
        phase: InspectionFlowPhase.active,
        sessionId: session.id,
        angles: {
          for (final key in kInspectionAngleKeys) key: AngleUi(key: key),
        },
        outboxFull: await _outbox.isFull(),
      );

      // Contexto best-effort (display-data): branding para la superficie del
      // cliente + vehículo + última lectura de odómetro.
      try {
        final display = await ref
            .read(reservationsApiProvider)
            .getDisplayData(reservationId);
        next = next.copyWith(
          reservationNumber: display.reservation.reservationNumber,
          vehicleLabel: display.reservation.vehicle?.label,
          previousOdometer: display.reservation.vehicle?.mileage,
          branding: display.branding,
          // Firmante para el complete (INN S-3): la firma legal no viaja
          // anónima si el dato existe.
          customerName: display.reservation.customer?.fullName,
        );
      } catch (_) {
        // Sin display-data el flujo sigue; la firma usa el fallback neutro.
      }

      // Ángulos ya capturados EN EL SERVIDOR (web u otra corrida): mint +
      // GET estado. Best-effort — offline más tarde no lo necesita.
      try {
        final token = await ref
            .read(checkoutApiProvider)
            .mintHandoffToken(session.id);
        final remote = await ref
            .read(checkoutApiProvider)
            .getInspectionState(token.token);
        final angles = Map<String, AngleUi>.of(next.angles);
        for (final angle in remote.angles) {
          if (angle.captured && angles.containsKey(angle.key)) {
            angles[angle.key] =
                angles[angle.key]!.copyWith(status: AngleStatus.onServer);
          }
        }
        next = next.copyWith(
          angles: angles,
          linkExpiresAt: token.expiresAt,
          reservationNumber:
              next.reservationNumber ?? remote.reservationNumber,
          vehicleLabel: next.vehicleLabel ?? remote.vehicle,
        );
      } catch (_) {}

      // Filas YA encoladas de esta sesión (el flujo se dejó a medias):
      // restaurar el estado del grid desde la bandeja.
      try {
        final rows = await ref
            .read(outboxDbProvider)
            .byGroupKey(session.id);
        final angles = Map<String, AngleUi>.of(next.angles);
        var completeQueued = next.completeQueued;
        for (final row in rows) {
          final payload = json.decode(row.payload) as Map<String, dynamic>;
          if (row.kind == OutboxKinds.inspectionPhoto) {
            final key = payload['angleKey'] as String?;
            if (key != null && angles.containsKey(key)) {
              angles[key] = angles[key]!.copyWith(
                status: AngleStatus.queued,
                bytes: payload['bytes'] as int?,
              );
            }
          } else if (row.kind == OutboxKinds.inspectionComplete) {
            completeQueued = true;
          }
        }
        next = next.copyWith(
          angles: angles,
          completeQueued: completeQueued,
          // Con el cierre YA encolado no hay nada que capturar: el flujo se
          // restaura donde de verdad quedó (esperando al servidor), no en
          // fotos. Sin esto, volver al checkout tras un "Terminar" sin red
          // aterrizaba en el grid y el paso 4 no podía contar por qué no
          // avanza (frame 17D).
          step: completeQueued ? InspectionStep.summary : next.step,
        );
      } catch (_) {}

      if (!ref.mounted) return;
      state = next;
    } on ApiError catch (e) {
      if (!ref.mounted) return;
      state = state.copyWith(
        phase: e.kind == ApiErrorKind.network
            ? InspectionFlowPhase.offline
            : InspectionFlowPhase.failed,
        error: e,
      );
    } catch (e) {
      if (!ref.mounted) return;
      state = state.copyWith(
        phase: InspectionFlowPhase.failed,
        error: ApiError(kind: ApiErrorKind.server, message: '$e'),
      );
    }
  }

  // ── captura ──────────────────────────────────────────────────────────────

  /// Siguiente ángulo pendiente después de [afterKey] (o el primero) — el
  /// flujo continuo de la cámara (nota 5 del mockup 6B).
  String? nextPendingAngle({String? afterKey}) {
    final keys = kInspectionAngleKeys;
    final start = afterKey == null ? 0 : keys.indexOf(afterKey) + 1;
    for (var i = 0; i < keys.length; i++) {
      final key = keys[(start + i) % keys.length];
      final status = state.angles[key]?.status;
      if (status == AngleStatus.pending || status == AngleStatus.failed) {
        return key;
      }
    }
    return null;
  }

  void markCompressing(String angleKey) =>
      _updateAngle(angleKey, (a) => a.copyWith(status: AngleStatus.compressing));

  void markCaptureFailed(String angleKey) =>
      _updateAngle(angleKey, (a) => a.copyWith(status: AngleStatus.failed));

  /// Foto comprimida y lista: cifrar + encolar con la sede activa SELLADA
  /// (criterio registrado H5) y disparar el drenado en foreground.
  Future<void> enqueueCapturedPhoto({
    required String angleKey,
    required Uint8List bytes,
    required int msCompress,
  }) async {
    final sessionId = state.sessionId;
    if (sessionId == null) return;
    try {
      final result = await _outbox.enqueuePhoto(
        checkoutSessionId: sessionId,
        reservationId: reservationId,
        reservationNumber: state.reservationNumber,
        angleKey: angleKey,
        jpegBytes: bytes,
      );
      if (!ref.mounted) return;
      if (result == EnqueueResult.full) {
        state = state.copyWith(outboxFull: true);
        markCaptureFailed(angleKey);
        return;
      }
      _logger.log(InspectionEvents.photoCaptured, data: {
        'angle': angleKey,
        'bytes_after_compress': bytes.length,
        'ms_compress': msCompress,
      });
      _updateAngle(
        angleKey,
        (a) => a.copyWith(
          status: AngleStatus.queued,
          bytes: bytes.length,
          capturedAt: DateTime.now(),
          thumbnail: bytes,
        ),
      );
      state = state.copyWith(outboxFull: await _outbox.isFull());
      // El drenado decide solo si hay red; encolar es siempre local-primero.
      await ref.read(drainCoordinatorProvider.notifier).kick('enqueue');
    } catch (_) {
      if (ref.mounted) markCaptureFailed(angleKey);
    }
  }

  // ── métricas / firma / cierre ────────────────────────────────────────────

  void setOdometer(int? value) => state = InspectionFlowState(
        // Constructor COMPLETO (no copyWith): borrar el campo debe poder
        // volver a null. Al agregar campos al estado, agregarlos AQUÍ —
        // omitirlos los resetea en silencio (mordió con customerName).
        phase: state.phase,
        error: state.error,
        sessionId: state.sessionId,
        reservationNumber: state.reservationNumber,
        vehicleLabel: state.vehicleLabel,
        previousOdometer: state.previousOdometer,
        branding: state.branding,
        linkExpiresAt: state.linkExpiresAt,
        angles: state.angles,
        step: state.step,
        odometer: value, // copyWith no puede volver a null
        fuelEighths: state.fuelEighths,
        cleanliness: state.cleanliness,
        notes: state.notes,
        signatureDataUrl: state.signatureDataUrl,
        completeQueued: state.completeQueued,
        outboxFull: state.outboxFull,
        customerName: state.customerName,
        completedAt: state.completedAt,
      );

  void setFuelEighths(int eighths) =>
      state = state.copyWith(fuelEighths: eighths.clamp(0, 8));

  void setCleanliness(int value) =>
      state = state.copyWith(cleanliness: value.clamp(1, 5));

  void setNotes(String value) => state = state.copyWith(notes: value);

  void goToStep(InspectionStep step) => state = state.copyWith(step: step);

  /// Firma confirmada en el modo kiosco: guardar y volver a la superficie
  /// del staff (resumen 6E). El resumeLock lo hace el widget del kiosco al
  /// desmontarse.
  void confirmSignature(String signatureDataUrl) {
    state = state.copyWith(
      signatureDataUrl: signatureDataUrl,
      step: InspectionStep.summary,
    );
  }

  /// "Terminar": encola el inspection_complete con dependsOn a la última
  /// foto (la cadena del spike 2) y dispara el drenado. El CTA dice la
  /// verdad según la red (lo decide la pantalla).
  Future<EnqueueResult> finish() async {
    final sessionId = state.sessionId;
    if (sessionId == null) return EnqueueResult.full;
    final result = await _outbox.enqueueComplete(
      checkoutSessionId: sessionId,
      reservationId: reservationId,
      reservationNumber: state.reservationNumber,
      body: {
        'odometer': state.odometer,
        'fuelLevel': state.fuelFraction,
        'cleanliness': state.cleanliness,
        'notes': state.notes.isEmpty ? null : state.notes,
        'signatureDataUrl': state.signatureDataUrl,
        // INN S-3: el firmante viaja sellado desde display-data — la firma
        // del agreement queda atribuida.
        'signerName': state.customerName,
      },
    );
    if (!ref.mounted) return result;
    if (result == EnqueueResult.ok) {
      state = state.copyWith(completeQueued: true);
      await ref.read(drainCoordinatorProvider.notifier).kick('complete');
    } else {
      state = state.copyWith(outboxFull: true);
    }
    return result;
  }

  // ── reconciliación con la bandeja y con el servidor (M2-H4) ──────────────

  /// Una emisión de la bandeja: promueve a `onServer` los ángulos cuya fila
  /// DESAPARECIÓ después de haber estado encolada.
  ///
  /// Con la sesión ya sellada por el servidor NO se promueve nada: ahí las
  /// filas desaparecen por la purga selectiva ([noteCompletedByServer] →
  /// `discardSession`), y decir "enviada" de una foto que se descartó sería
  /// exactamente la mentira que este paso existe para evitar.
  void _reconcileWithOutbox(List<OutboxEntry> rows) {
    final sessionId = state.sessionId;
    if (sessionId == null) return;
    final view = inspectionOutboxViewOf(rows, checkoutSessionId: sessionId);
    final stillQueued = {
      for (final entry in view.photos.entries)
        if (entry.value == OutboxDelivery.queued) entry.key,
    };
    final gone = _queuedAnglesSeen
        .difference(stillQueued)
        // Con fila todavía presente (muerta) no salió a ningún lado.
        .where((key) => !view.photos.containsKey(key))
        .toList();
    _queuedAnglesSeen = stillQueued;
    if (gone.isEmpty || state.completedAt != null) return;

    final angles = Map<String, AngleUi>.of(state.angles);
    var changed = false;
    for (final key in gone) {
      final angle = angles[key];
      if (angle == null || angle.status != AngleStatus.queued) continue;
      angles[key] = angle.copyWith(status: AngleStatus.onServer);
      changed = true;
    }
    if (changed && ref.mounted) state = state.copyWith(angles: angles);
  }

  /// El wizard vio caer `inspectionCompletedAt` con el paso abierto (frame
  /// 17F). El servidor ya tiene la inspección, así que los envíos de ESTA
  /// sesión se retiran con rastro — la misma purga selectiva del 6F: reenviar
  /// re-estamparía sellos sobre una sesión que puede estar cerrándose
  /// (mobile-inspection.service.js:265-281 escribe sin guard de re-estampado).
  ///
  /// Idempotente: el poll trae el sello en CADA lectura posterior.
  Future<void> noteCompletedByServer(DateTime completedAt) async {
    final sessionId = state.sessionId;
    if (sessionId == null || state.completedAt != null) return;
    state = state.copyWith(completedAt: completedAt);
    try {
      await _outbox.discardSession(sessionId);
    } catch (_) {
      // La purga es higiene, no corrección: si falla, el drenado se topará
      // con `inspectionAlreadyCompleted` y descartará la fila igual.
    }
  }

  /// Reintento del 17E: resucita TODAS las filas muertas de esta sesión y
  /// dispara el drenado.
  ///
  /// Nota 13 del mockup: volver a tomar la foto obligatoria son DOS
  /// operaciones (encolar la foto de nuevo + revivir el `inspection_complete`
  /// que el servidor rechazó con `REQUIRED_ANGLES_MISSING`) y UN botón — el
  /// agente no tiene por qué saber que su cierre quedó en una lista aparte.
  /// Devuelve cuántas filas revivió.
  Future<int> retryDeadRows() async {
    final sessionId = state.sessionId;
    if (sessionId == null) return 0;
    final List<OutboxEntry> rows;
    try {
      rows = await ref.read(outboxDbProvider).byGroupKey(sessionId);
    } catch (_) {
      return 0;
    }
    final dead = rows.where((r) => r.status == 'dead').toList();
    for (final row in dead) {
      await _outbox.retryDead(row.id);
    }
    if (dead.isNotEmpty) {
      await ref.read(drainCoordinatorProvider.notifier).kick('inspection_retry');
    }
    return dead.length;
  }

  void _updateAngle(String key, AngleUi Function(AngleUi) fn) {
    final current = state.angles[key];
    if (current == null) return;
    state = state.copyWith(
      angles: {...state.angles, key: fn(current)},
    );
  }
}

final inspectionControllerProvider = NotifierProvider.family<
    InspectionController, InspectionFlowState, String>(
  InspectionController.new,
);
