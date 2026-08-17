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

  @override
  String locationChipDeniedSemantics(String location) {
    return 'Ubicación activa: $location. Acceso denegado. Toca para cambiar.';
  }

  @override
  String get ageMoment => 'un momento';

  @override
  String ageMinutes(int count) {
    return '$count min';
  }

  @override
  String ageHours(int count) {
    return '$count h';
  }

  @override
  String homeFreshnessLine(String age) {
    return 'Actualizado hace $age · se actualiza solo';
  }

  @override
  String homeOfflineBanner(String age) {
    return 'Sin conexión — mostrando datos de hace $age. Se actualizará solo al volver la señal.';
  }

  @override
  String homeStaleBanner(String age) {
    return 'No se pudo actualizar — mostrando datos de hace $age.';
  }

  @override
  String get homeErrorTitle => 'No se pudo cargar el tablero';

  @override
  String get forbiddenTitle => 'Sin acceso';

  @override
  String get heroTitle => 'Para ahora';

  @override
  String heroPartDepartures(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count salidas',
      one: '1 salida',
    );
    return '$_temp0';
  }

  @override
  String heroPartDeparturesCapped(int count) {
    return '$count+ salidas';
  }

  @override
  String heroPartReturns(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count retornos',
      one: '1 retorno',
    );
    return '$_temp0';
  }

  @override
  String heroPartIncidents(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count incidentes',
      one: '1 incidente',
    );
    return '$_temp0';
  }

  @override
  String get heroCalmFoot => 'Sin pendientes inmediatos';

  @override
  String heroCutoffFoot(String time) {
    return 'al corte de las $time';
  }

  @override
  String get tileActiveTitle => 'En renta';

  @override
  String tileActiveFoot(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count vencen hoy · ver lista ›',
      one: '1 vence hoy · ver lista ›',
      zero: 'Ver lista ›',
    );
    return '$_temp0';
  }

  @override
  String tileActiveSemantics(int count) {
    return 'En renta: $count. Toca para ver la lista completa.';
  }

  @override
  String get tileLoanerTitle => 'Loaner';

  @override
  String tileLoanerFoot(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count piden seguimiento',
      one: '1 pide seguimiento',
      zero: 'Sin seguimientos',
    );
    return '$_temp0';
  }

  @override
  String tileLoanerFootCapped(int count) {
    return '$count+ piden seguimiento';
  }

  @override
  String get tilePrecheckinTitle => 'Pre-checkin';

  @override
  String get tilePrecheckinFoot => 'Enviado, sin completar';

  @override
  String get queueIssueEscalations => 'Incidentes';

  @override
  String get queueCheckout => 'Salidas (72 h)';

  @override
  String get queueReturns => 'Retornos (72 h)';

  @override
  String get queuePrecheckin => 'Pre-checkin';

  @override
  String get queueLoanerAdvisorFollowup => 'Seguimiento loaner';

  @override
  String get queueLoanerReady => 'Loaner listos';

  @override
  String get queueLoanerBillingReview => 'Facturación loaner';

  @override
  String get queueLoanerReturns => 'Retornos loaner';

  @override
  String get queueActive => 'En renta';

  @override
  String get seeAllButton => 'Ver todo';

  @override
  String queueCountCapped(int count) {
    return '$count+';
  }

  @override
  String get calmRowTitle => 'Sin actividad ahora';

  @override
  String calmChipSemantics(String queue) {
    return '$queue: sin pendientes. Toca para abrir la cola.';
  }

  @override
  String get emptyAllTitle => 'Patio en calma';

  @override
  String get emptyAllBody =>
      'No hay nada pendiente en ninguna cola ahora mismo. Desliza hacia abajo para actualizar cuando quieras.';

  @override
  String emptyAllQueuesLabel(int count) {
    return 'Las $count colas, en cero';
  }

  @override
  String cardToday(String time) {
    return 'Hoy $time';
  }

  @override
  String cardTomorrow(String time) {
    return 'Mañana $time';
  }

  @override
  String cardOverdueHours(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'Vencido $count h',
      one: 'Vencido 1 h',
    );
    return '$_temp0';
  }

  @override
  String cardOverdueMinutes(int count) {
    return 'Vencido $count min';
  }

  @override
  String get precheckinReady => 'Pre-checkin listo';

  @override
  String get precheckinMissing => 'Falta pre-checkin';

  @override
  String get incidentOpen => 'Abierto';

  @override
  String get incidentUnderReview => 'En revisión';

  @override
  String incidentReported(String time) {
    return 'Reportado $time';
  }

  @override
  String get loanerFollowupPacket => 'Expediente sin completar';

  @override
  String get loanerFollowupService => 'Servicio vencido';

  @override
  String get loanerFollowupBilling => 'Facturación rechazada';

  @override
  String get loanerReadyChip => 'Listo para entrega';

  @override
  String advisorLabel(String name) {
    return 'Asesor: $name';
  }

  @override
  String queueListShowingFirst(int count) {
    return 'Mostrando los primeros $count — puede haber más';
  }

  @override
  String queueListShowingOf(int shown, int total) {
    return 'Mostrando $shown de $total';
  }

  @override
  String get queueEmptyBody => 'Nada en esta cola ahora mismo.';

  @override
  String get searchFieldHint => 'Cliente, reserva, placa o unidad';

  @override
  String get searchFieldLabel => 'Buscar';

  @override
  String get searchClearLabel => 'Borrar búsqueda';

  @override
  String get searchPrompt => 'Busca en las reservas de tu sede activa.';

  @override
  String searchNoResults(String query) {
    return 'Sin resultados para “$query”.';
  }
}
