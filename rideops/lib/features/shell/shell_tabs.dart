import '../../core/api/dto/session_user.dart';
import '../../core/api/enums.dart';
import '../../core/router/app_router.dart';

/// Tabs del shell (mockup 4A/4B). El orden ES el del mockup 4B:
/// Inicio · Buscar · [Incidentes] · Bandeja · Perfil.
enum ShellTab {
  home(AppRoutes.home),
  search(AppRoutes.search),
  incidents(AppRoutes.incidents),
  outbox(AppRoutes.outbox),
  profile(AppRoutes.profile);

  const ShellTab(this.route);

  final String route;
}

/// Tabla RBAC de tabs — FUNCIÓN PURA para testearla como tabla.
///
/// Reglas (mockup 4A/4B, nota 6):
///  - AGENT: 4 tabs (Inicio/Buscar/Bandeja/Perfil). Bandeja SIEMPRE visible:
///    es la ventana al outbox (ADR-7) y esconderla escondería trabajo
///    pendiente del usuario.
///  - ADMIN / OPS (y SUPER_ADMIN, que está por encima de ADMIN) suman
///    Incidentes SOLO si moduleAccess.issueCenter es true — chequeo
///    fail-closed: llave ausente = false ([SessionUser.can]).
///  - Sesión degradada (`user == null`, restore sin red) o role no parseable:
///    tabs mínimas de AGENT. La nav solo ESCONDE — el RBAC real lo aplica el
///    backend y cada pantalla maneja su 403 igual (DoD-4).
List<ShellTab> tabsFor(SessionUser? user) {
  final role = user?.roleEnum;
  final elevated = role == UserRole.admin ||
      role == UserRole.ops ||
      role == UserRole.superAdmin;
  final showIncidents = elevated && (user?.can('issueCenter') ?? false);
  return [
    ShellTab.home,
    ShellTab.search,
    if (showIncidents) ShellTab.incidents,
    ShellTab.outbox,
    ShellTab.profile,
  ];
}
