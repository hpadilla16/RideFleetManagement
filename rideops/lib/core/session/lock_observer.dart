import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../lifecycle/app_visibility.dart';
import 'lock_controller.dart';

/// Sensor del candado (H2): vive en el `builder` de MaterialApp para cubrir
/// TODAS las rutas sin tocar cada pantalla.
///  - Cada pointer-down reinicia la ventana de inactividad (Listener
///    translúcido: observa sin robar ningún gesto).
///  - Los cambios de ciclo de vida alimentan el chequeo de background
///    (volver tras la gracia ⇒ lock).
///  - Y desde M2-H1, también [appVisibilityProvider]: la señal que PAUSA los
///    pollers. Vivía en el AppShell, que solo está montado en las rutas CON
///    tab bar — el wizard de checkout (como la inspección) es pantalla
///    completa FUERA del shell, así que ahí la señal se quedaba congelada en
///    "visible" y su poll de 5 s habría seguido corriendo en el bolsillo.
///    Un solo dueño para todas las superficies.
class LockObserver extends ConsumerStatefulWidget {
  const LockObserver({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<LockObserver> createState() => _LockObserverState();
}

class _LockObserverState extends ConsumerState<LockObserver>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    ref.read(lockControllerProvider.notifier).onLifecycleChanged(state);
    // `inactive` cuenta como VISIBLE a propósito (cortina de notificaciones,
    // diálogo de permisos): el WHY completo vive en app_visibility.dart.
    ref.read(appVisibilityProvider.notifier).setVisible(
          state == AppLifecycleState.resumed ||
              state == AppLifecycleState.inactive,
        );
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      behavior: HitTestBehavior.translucent,
      onPointerDown: (_) =>
          ref.read(lockControllerProvider.notifier).noteActivity(),
      child: widget.child,
    );
  }
}
