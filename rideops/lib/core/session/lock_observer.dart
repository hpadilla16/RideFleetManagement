import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'lock_controller.dart';

/// Sensor del candado (H2): vive en el `builder` de MaterialApp para cubrir
/// TODAS las rutas sin tocar cada pantalla.
///  - Cada pointer-down reinicia la ventana de inactividad (Listener
///    translúcido: observa sin robar ningún gesto).
///  - Los cambios de ciclo de vida alimentan el chequeo de background
///    (volver tras la gracia ⇒ lock).
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
