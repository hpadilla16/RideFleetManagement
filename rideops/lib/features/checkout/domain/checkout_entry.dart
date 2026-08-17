/// Guards de CREACIÓN de la sesión de checkout (M2-H7, mockup 11B–11E).
///
/// `POST /api/checkout-sessions {reservationId}` es **idempotente por
/// reserva** (`reservationId @unique`): si ya hay sesión viva la devuelve, y
/// por eso "reanudar" es el camino normal y no un caso especial.
///
/// Antes de devolverla corre 4 guards, y el ORDEN es el del servicio real
/// (`checkout-session.service.js:109-181`), no el que uno esperaría:
///
///  1. 404 — la reserva no existe (service:127).
///  2. 422 `NO_VEHICLE_ASSIGNED` (service:128-134) — sin unidad no hay
///     entrega. Va PRIMERO que el conflicto porque el conflicto se calcula
///     sobre `resv.vehicleId`.
///  3. 409 `VEHICLE_CONFLICT` (service:136-147) — la unidad sigue en una
///     renta abierta o choca con otra reserva. **Aquí la sesión todavía NO
///     existe**: cualquier salida que hable de "esta sesión" mentiría.
///  4. 422 `PRECHECKIN_REQUIRED` / `AGE_RULES_*` (service:67-101, llamados en
///     service:151) — las dos compuertas por sede. Corren ANTES de buscar la
///     sesión existente a propósito: reanudar tampoco puede saltárselas.
///  5. 409 `SESSION_TERMINAL` (service:154-161) — ya hubo checkout y terminó.
///     La sesión SÍ existe (es la terminal), así que la salida es mostrarla.
///
/// Este archivo es PURO: clasifica un [ApiError] y no toca red ni UI. La
/// pantalla decide qué dibujar; el controller decide qué hacer.
library;

import 'package:flutter/foundation.dart';

import '../../../core/api/api_error.dart';

/// Por qué el servidor no abrió el checkout. Un valor por PANTALLA de salida
/// — si dos códigos merecen la misma pantalla, comparten valor.
enum CheckoutEntryBlockKind {
  /// 422 `NO_VEHICLE_ASSIGNED` (frame 11C).
  noVehicle,

  /// 409 `VEHICLE_CONFLICT` (frame 11D).
  vehicleConflict,

  /// 422 `PRECHECKIN_REQUIRED` (frame 11B).
  precheckin,

  /// 422 `AGE_RULES_*` (frame 11B con copy y salida propias: la regla la fija
  /// la sucursal, así que la salida NO es una acción del agente).
  ageRules,

  /// 409 `SESSION_TERMINAL` (frame 11E). La sesión existe y es terminal: la
  /// pantalla la ABRE en el wizard, que la lee de `by-reservation` con su
  /// events log real — el 409 no trae la fila.
  terminal,

  /// 403 del selector de sede (REGROUND §1, pantalla 4D del M1).
  locationDenied,

  /// 403 de módulo/RBAC — negativa con el mensaje del servidor.
  forbidden,

  /// Sin red: el arranque exige UNA confirmación del servidor y **no se
  /// encola** (ADR-5 aplica a todo el checkout, no solo al dinero).
  offline,

  /// 429/503: el patio está saturado; se espera y se reintenta a mano.
  rateLimited,

  /// La sede activa no terminó de hidratar: no se manda el POST sin saber qué
  /// `x-view-location` lleva (criterio registrado H4).
  locationNotReady,

  /// El alcance cambió con el POST en vuelo (el agente cambió de sede o de
  /// cuenta). La respuesta ya no pertenece a lo que está viendo, así que NO se
  /// aplica — pero tampoco se traga en silencio: la sesión pudo crearse y el
  /// agente tiene que saberlo para volver a tocar (Innovation #7).
  scopeChanged,

  /// Todo lo demás (404 de reserva, 500, `AGREEMENT_AUTO_CREATE_FAILED`…):
  /// mensaje del servidor tal cual, nunca "algo salió mal".
  unknown,
}

@immutable
class CheckoutEntryBlock {
  const CheckoutEntryBlock({
    required this.kind,
    this.message = '',
    this.code,
    this.status,
    this.conflictReservationNumber,
  });

  final CheckoutEntryBlockKind kind;

  /// Mensaje del backend (`error`), sin inventar (DoD #5). Se muestra como
  /// detalle técnico junto al copy localizado: el servidor escribe en inglés y
  /// esta app es es-primero, pero su texto es el único que trae los datos
  /// concretos (la regla de edad exacta, el número de la otra reserva).
  final String message;
  final String? code;
  final int? status;

  /// Número de la reserva en conflicto extraído del mensaje (solo
  /// [CheckoutEntryBlockKind.vehicleConflict]). Null = no se pudo leer y
  /// entonces la pantalla NO ofrece el botón de buscarla.
  final String? conflictReservationNumber;

  /// ¿Este bloqueo puede desaparecer solo? Determina si la pantalla ofrece
  /// "Reintentar": el pre-checkin puede haberse completado hace 10 s en otra
  /// superficie y la otra renta puede haber entrado. La sesión terminal, en
  /// cambio, es terminal para siempre — ofrecer reintentar ahí sería mentir
  /// sobre la máquina de estados (nota 8 del mockup).
  bool get retriable => switch (kind) {
        CheckoutEntryBlockKind.terminal ||
        CheckoutEntryBlockKind.locationDenied =>
          false,
        _ => true,
      };
}

/// Clasifica el error del POST de creación.
///
/// [requestHadHeader]: la request llevó `x-view-location` (la firma completa
/// del 403 de ubicación vive en [ApiError.isViewLocationDenied] — un 403 de
/// módulo trae otro mensaje y NO debe montar la 4D).
CheckoutEntryBlock classifyEntryError(
  ApiError error, {
  required bool requestHadHeader,
}) {
  final code = error.code;
  // El code manda cuando existe: es contrato de máquina. El status queda de
  // respaldo para los caminos que el backend responde sin code.
  final kind = switch (code) {
    'NO_VEHICLE_ASSIGNED' => CheckoutEntryBlockKind.noVehicle,
    'VEHICLE_CONFLICT' => CheckoutEntryBlockKind.vehicleConflict,
    'PRECHECKIN_REQUIRED' => CheckoutEntryBlockKind.precheckin,
    // AGE_RULES_NO_DOB / AGE_RULES_UNDER_MIN / AGE_RULES_OVER_MAX: el sufijo
    // lo pone `evaluateAgeRules` (service:97) y puede crecer — se matchea el
    // prefijo para que una regla nueva caiga en su pantalla, no en el genérico.
    _ when code != null && code.startsWith('AGE_RULES_') =>
      CheckoutEntryBlockKind.ageRules,
    'SESSION_TERMINAL' || 'CHECKOUT_TERMINAL' => CheckoutEntryBlockKind.terminal,
    _ => switch (error.kind) {
        ApiErrorKind.network => CheckoutEntryBlockKind.offline,
        ApiErrorKind.rateLimited => CheckoutEntryBlockKind.rateLimited,
        ApiErrorKind.forbidden =>
          error.isViewLocationDenied(requestHadHeader: requestHadHeader)
              ? CheckoutEntryBlockKind.locationDenied
              : CheckoutEntryBlockKind.forbidden,
        _ => CheckoutEntryBlockKind.unknown,
      },
  };
  return CheckoutEntryBlock(
    kind: kind,
    message: error.message,
    code: code,
    status: error.status,
    conflictReservationNumber: kind == CheckoutEntryBlockKind.vehicleConflict
        ? conflictingReservationNumberOf(error.message)
        : null,
  );
}

/// Número de la reserva en conflicto dentro del mensaje del backend.
///
/// PUENTE DOCUMENTADO (mismo espíritu que [ApiError.viewLocationDeniedMessage]):
/// `ensureNoVehicleConflict` (reservations.service.js:911 y :932) mete el
/// `reservationNumber` DENTRO del texto y no lo manda como campo. Las dos
/// formas hoy:
///   - `Vehicle is still out on open rental RES-1001 — complete its check-in …`
///   - `Vehicle conflict with reservation RES-1001`
/// Si el copy del servidor cambia, esto devuelve null y la pantalla
/// simplemente no ofrece "buscar la otra reserva": degradación VISIBLE (el
/// mensaje del servidor se sigue mostrando entero), nunca un botón que
/// navega a una búsqueda vacía.
String? conflictingReservationNumberOf(String message) {
  final match = RegExp(
    r'(?:open rental|reservation)\s+([A-Za-z0-9][A-Za-z0-9._/-]*)',
  ).firstMatch(message);
  final raw = match?.group(1);
  if (raw == null) return null;
  // Puntuación de cierre pegada al token (". " / ", ") fuera.
  final cleaned = raw.replaceAll(RegExp(r'[.,;:]+$'), '');
  // Un número de reserva SIEMPRE trae dígitos (RES-1001, TL-42, WEB-7). Sin
  // ellos lo capturado es una palabra suelta de una frase que cambió.
  if (cleaned.isEmpty || !RegExp(r'\d').hasMatch(cleaned)) return null;
  return cleaned;
}
