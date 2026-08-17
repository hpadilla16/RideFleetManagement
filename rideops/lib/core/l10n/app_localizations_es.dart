// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Spanish Castilian (`es`).
class AppLocalizationsEs extends AppLocalizations {
  AppLocalizationsEs([String locale = 'es']) : super(locale);

  @override
  String get appTitle => 'RideOps';

  @override
  String get loginTitle => 'Iniciar sesión';

  @override
  String get loginEmailLabel => 'Correo electrónico';

  @override
  String get loginPasswordLabel => 'Contraseña';

  @override
  String get loginButton => 'Entrar';

  @override
  String get loginInvalidCredentials => 'Correo o contraseña incorrectos';

  @override
  String get forcedPasswordChangeTitle => 'Cambia tu contraseña temporal';

  @override
  String get forcedPasswordChangeBody =>
      'Antes de usar la app tienes que crear tu propia contraseña.';

  @override
  String get currentPasswordLabel => 'Contraseña actual';

  @override
  String get newPasswordLabel => 'Contraseña nueva';

  @override
  String get changePasswordButton => 'Cambiar contraseña';

  @override
  String get sessionExpired => 'Tu sesión venció. Vuelve a entrar.';

  @override
  String get locationDenied => 'No tienes acceso a esa ubicación.';

  @override
  String get errorConflictReloaded =>
      'Otra pantalla avanzó esta sesión. Se recargó el estado.';

  @override
  String get errorRateLimited => 'Demasiadas solicitudes. Reintentando…';

  @override
  String get errorOffline => 'Sin conexión. Se guardó para enviar después.';

  @override
  String get outboxDeadLetterTitle => 'Pendientes con error';

  @override
  String get retryButton => 'Reintentar';

  @override
  String get genericError => 'Algo salió mal. Intenta de nuevo.';
}
