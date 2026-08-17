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
  String get loginSubtitle => 'Operaciones de patio';

  @override
  String get loginEmailLabel => 'Correo';

  @override
  String get loginPasswordLabel => 'Contraseña';

  @override
  String get loginButton => 'Entrar';

  @override
  String get loginButtonLoading => 'Entrando…';

  @override
  String get loginInvalidCredentials =>
      'Correo o contraseña incorrectos. Revisa e intenta de nuevo.';

  @override
  String get loginOffline =>
      'No hay conexión a internet. Revisa la señal y toca Reintentar ahora.';

  @override
  String get loginRetryNow => 'Reintentar ahora';

  @override
  String get loginHelpLine =>
      '¿Problemas para entrar? Pide a tu admin restablecer tu contraseña';

  @override
  String loginVersionLine(String version, String env, String locale) {
    return 'v$version ($env) · $locale';
  }

  @override
  String get showPassword => 'Mostrar contraseña';

  @override
  String get hidePassword => 'Ocultar contraseña';

  @override
  String get changePasswordChip => 'Paso obligatorio';

  @override
  String get changePasswordTitle => 'Crea tu contraseña';

  @override
  String get changePasswordBody =>
      'Entraste con una contraseña temporal. Por seguridad, crea la tuya antes de continuar.';

  @override
  String get currentPasswordLabel => 'Contraseña temporal (actual)';

  @override
  String get newPasswordLabel => 'Nueva contraseña';

  @override
  String policyRuleMinLength(int count) {
    return 'Mínimo $count caracteres';
  }

  @override
  String get policyRuleLowercase => 'Al menos una minúscula';

  @override
  String get policyRuleUppercase => 'Al menos una mayúscula';

  @override
  String get policyRuleDigit => 'Al menos un número';

  @override
  String get policyRuleSpecial => 'Al menos un símbolo (p. ej. ! # \$)';

  @override
  String get policyRuleDifferent => 'Distinta de la contraseña temporal';

  @override
  String get changePasswordButton => 'Guardar y continuar';

  @override
  String get changePasswordSaving => 'Guardando…';

  @override
  String get changePasswordCurrentWrong =>
      'La contraseña temporal no es correcta. Revísala o pide a tu admin una nueva.';

  @override
  String get changePasswordSuccessTitle => 'Contraseña actualizada';

  @override
  String get changePasswordSuccessBody =>
      'Tu sesión sigue activa — no necesitas volver a entrar.';

  @override
  String get changePasswordFootnote =>
      'La sesión temporal sigue viva durante este paso';

  @override
  String get continueButton => 'Continuar';

  @override
  String get changePasswordNextPin =>
      'Siguiente: crea tu PIN para desbloquear rápido en el patio.';

  @override
  String get pinSetupTitle => 'Crea tu PIN';

  @override
  String get pinSetupSubtitle =>
      'Lo usarás para desbloquear RideOps en el patio. 4 dígitos.';

  @override
  String get pinSetupConfirmTitle => 'Confirma tu PIN';

  @override
  String get pinSetupConfirmSubtitle => 'Escríbelo otra vez para confirmarlo.';

  @override
  String pinSetupStep(int step) {
    return 'Paso $step de 2';
  }

  @override
  String get pinSetupMismatch => 'Los PIN no coinciden. Empieza de nuevo.';

  @override
  String get pinBioOfferTitle => '¿Activar huella?';

  @override
  String get pinBioOfferBody =>
      'Desbloquea con tu huella, sin escribir el PIN. Tu PIN sigue funcionando siempre.';

  @override
  String get pinBioEnable => 'Activar huella';

  @override
  String get pinBioSkip => 'Ahora no';

  @override
  String get pinBioEnrollFailed =>
      'No se pudo activar la huella. Puedes seguir con tu PIN.';

  @override
  String get pinBioPrompt => 'Confirma tu identidad para desbloquear RideOps';

  @override
  String get pinBioKeyLabel => 'Desbloquear con huella';

  @override
  String get keypadDeleteLabel => 'Borrar dígito';

  @override
  String pinDigitsProgress(int count) {
    return '$count de 4 dígitos';
  }

  @override
  String lockGreeting(String name) {
    return 'Hola, $name';
  }

  @override
  String get lockTitleGeneric => 'Desbloquea RideOps';

  @override
  String get lockSubtitle => 'Ingresa tu PIN para continuar';

  @override
  String lockWrongPin(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'PIN incorrecto — te quedan $count intentos',
      one: 'PIN incorrecto — te queda 1 intento',
    );
    return '$_temp0';
  }

  @override
  String get lockForgotPin => '¿Olvidaste tu PIN? Cerrar sesión';

  @override
  String get homePlaceholderTitle => 'Sesión iniciada';

  @override
  String get homePlaceholderBody =>
      'El tablero de patio llega en la siguiente historia.';

  @override
  String get logoutButton => 'Cerrar sesión';

  @override
  String get tabHome => 'Inicio';

  @override
  String get tabSearch => 'Buscar';

  @override
  String get tabIncidents => 'Incidentes';

  @override
  String get tabOutbox => 'Bandeja';

  @override
  String get tabProfile => 'Perfil';

  @override
  String outboxBadgeSemantics(int count) {
    return '$count pendientes de envío';
  }

  @override
  String get shellPlaceholderBody =>
      'Esta sección llega en una historia siguiente.';

  @override
  String get locationChipAll => 'Todas';

  @override
  String locationChipSemantics(String location) {
    return 'Ubicación activa: $location. Toca para cambiar.';
  }

  @override
  String get locationSheetTitle => 'Ubicación activa';

  @override
  String get locationSheetSubtitle =>
      'Filtra colas, búsqueda y capturas nuevas';

  @override
  String get locationAllMine => 'Todas mis ubicaciones';

  @override
  String get locationCurrentLabel => 'Ubicación actual';

  @override
  String get locationSheetError =>
      'No se pudieron cargar tus ubicaciones. Revisa la señal e intenta de nuevo.';

  @override
  String get cancelButton => 'Cancelar';

  @override
  String get locationDeniedTitle => 'Sin acceso a esta ubicación';

  @override
  String locationDeniedBody(String location) {
    return 'Tu cuenta ya no tiene acceso a $location. Elige otra ubicación para seguir trabajando.';
  }

  @override
  String get locationDeniedBodyGeneric =>
      'Tu cuenta ya no tiene acceso a esta ubicación. Elige otra ubicación para seguir trabajando.';

  @override
  String get locationDeniedChangeButton => 'Cambiar ubicación';

  @override
  String get locationDeniedAdminNote =>
      'Si crees que es un error, avisa a tu administrador.';

  @override
  String get loadingLabel => 'Cargando…';

  @override
  String get sessionExpired => 'Tu sesión venció. Vuelve a entrar.';

  @override
  String get locationDenied => 'No tienes acceso a esa ubicación.';

  @override
  String get errorConflictReloaded =>
      'Otra pantalla avanzó esta sesión. Se recargó el estado.';

  @override
  String get errorRateLimited =>
      'Demasiadas solicitudes. Espera un momento e intenta de nuevo.';

  @override
  String get errorNoConnectionRetry =>
      'No hay conexión a internet. Revisa la señal e intenta de nuevo.';

  @override
  String get errorOffline => 'Sin conexión. Se guardó para enviar después.';

  @override
  String get outboxDeadLetterTitle => 'Pendientes con error';

  @override
  String get retryButton => 'Reintentar';

  @override
  String get genericError => 'Algo salió mal. Intenta de nuevo.';
}
