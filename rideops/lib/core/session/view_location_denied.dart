import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Señal pantalla→shell del 403 de ubicación (criterio registrado H4,
/// PROJECT_PLAN "Criterios H2/H3"): mientras un fetch scoped esté negado por
/// `x-view-location`, el chip de ubicación del shell se pinta en danger — la
/// negativa se ve DONDE se eligió la sede, no solo en el body de la pantalla.
///
/// Mecanismo mínimo a propósito: un bool que la pantalla dueña del fetch
/// levanta al clasificar el 403 (ApiError.isViewLocationDenied) y baja en
/// cuanto un fetch vuelve a pasar o la sede cambia. El shell solo lo observa;
/// jamás lo muta ni navega por él (DoD-4: la negativa la renderiza cada
/// pantalla con su propio ApiError).
///
/// **UN SOLO ESCRITOR por diseño** (Innovation OP-3, review H4): en M1 el
/// DashboardController es el ÚNICO que muta esta señal — un bool no soporta
/// dos escritores (el éxito de una pantalla apagaría la negativa viva de
/// otra). Si otra superficie scoped necesita pintarla (búsqueda M3, colas
/// M3), NO agregues un segundo `set()`: promueve la señal a un contador o a
/// un set de dueños, o consolida la clasificación en un provider compartido.
class ViewLocationDeniedSignal extends Notifier<bool> {
  @override
  bool build() => false;

  void set(bool denied) {
    if (state != denied) state = denied;
  }
}

final NotifierProvider<ViewLocationDeniedSignal, bool>
    viewLocationDeniedSignalProvider =
    NotifierProvider<ViewLocationDeniedSignal, bool>(
  ViewLocationDeniedSignal.new,
);
