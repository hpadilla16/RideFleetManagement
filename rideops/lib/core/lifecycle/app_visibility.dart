import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Visibilidad de la app en primer plano — la señal que PAUSA el polling del
/// dashboard (nota 1 del mockup 5A: "se PAUSA con la app en background y al
/// volver dispara un refresh inmediato").
///
/// La alimenta el AppLifecycleListener del AppShell (única superficie con
/// sesión donde el polling importa); vive como provider aparte para que el
/// DashboardController pueda `ref.listen` sin acoplarse a widgets y para que
/// los tests con fakeAsync la muevan a mano sin montar un árbol.
///
/// `inactive` cuenta como visible A PROPÓSITO: es un estado transitorio
/// (cortina de notificaciones, diálogo de permisos) — pausar ahí y refrescar
/// al volver dispararía un fetch extra por cada interrupción de dos segundos.
/// Background real = hidden/paused.
class AppVisibility extends Notifier<bool> {
  @override
  bool build() => true;

  void setVisible(bool visible) {
    if (state != visible) state = visible;
  }
}

final NotifierProvider<AppVisibility, bool> appVisibilityProvider =
    NotifierProvider<AppVisibility, bool>(AppVisibility.new);
