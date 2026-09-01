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
  String get loginKioskRelogin =>
      'Por seguridad, vuelve a entrar con tu contraseña.';

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
  String ageSeconds(int count) {
    return '$count s';
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

  @override
  String cardOpenCheckoutSemantics(String details) {
    return '$details: abrir el checkout';
  }

  @override
  String get cardOpeningCheckoutChip => 'Abriendo…';

  @override
  String get cardOpeningCheckoutMeta => 'abriendo checkout…';

  @override
  String cardOpeningCheckoutSemantics(String details) {
    return '$details: abriendo el checkout';
  }

  @override
  String get inspTitle => 'Inspección de salida';

  @override
  String inspProgressChip(int count) {
    return '$count de 8';
  }

  @override
  String get inspProgressDone => '8 de 8 ✓';

  @override
  String get angleFront => 'Frente';

  @override
  String get angleRear => 'Atrás';

  @override
  String get angleLeft => 'Lado izquierdo';

  @override
  String get angleRight => 'Lado derecho';

  @override
  String get angleFrontSeat => 'Asiento del.';

  @override
  String get angleRearSeat => 'Asiento tras.';

  @override
  String get angleDash => 'Tablero';

  @override
  String get angleTrunk => 'Cajuela';

  @override
  String get angleRequiredChip => 'Obligatorio';

  @override
  String get anglePending => 'Pendiente';

  @override
  String get angleCompressing => 'Comprimiendo…';

  @override
  String get angleFailedRetry => 'Falló — toca para reintentar';

  @override
  String get angleQueued => 'En bandeja';

  @override
  String get angleOnServer => 'Ya en el servidor';

  @override
  String get inspContinueMetrics => 'Continuar a métricas';

  @override
  String get inspRequiredFootnote =>
      'Frente y Atrás son obligatorios; el resto suma evidencia.';

  @override
  String get inspOfflineBanner =>
      'Sin conexión. Puedes terminar la inspección completa: todo queda en la bandeja y se enviará al reconectar.';

  @override
  String get inspOfflineChip => 'Sin red';

  @override
  String inspLinkExpires(String time) {
    return 'El enlace de esta sesión vence a las $time.';
  }

  @override
  String get inspLoadOffline =>
      'Sin conexión. Para iniciar la inspección se necesita señal una vez; después todo funciona sin red.';

  @override
  String get inspOutboxFull =>
      'La bandeja está llena. Conéctate a una red para que se vacíe antes de capturar más fotos.';

  @override
  String camAnglePill(String angle, int n) {
    return '$angle · $n de 8';
  }

  @override
  String get camHintExterior =>
      'Encuadra el vehículo completo dentro de las esquinas';

  @override
  String get camHintInterior =>
      'Encuadra el área completa dentro de las esquinas';

  @override
  String get camFlash => 'Flash';

  @override
  String get camClose => 'Cerrar';

  @override
  String get camShutter => 'Tomar foto';

  @override
  String get camErrorTitle => 'No se pudo abrir la cámara';

  @override
  String get camErrorPermissionHint =>
      'El permiso de cámara está denegado. Actívalo en los Ajustes del sistema y vuelve a intentar.';

  @override
  String get langSpanish => 'Español';

  @override
  String get langEnglish => 'English';

  @override
  String get metricsTitle => 'Métricas del vehículo';

  @override
  String get metricsOdometer => 'Odómetro';

  @override
  String get odometerUnit => 'mi';

  @override
  String odometerValue(String value, String unit) {
    return '$value $unit';
  }

  @override
  String metricsPrevReading(String reading) {
    return 'Última lectura registrada: $reading';
  }

  @override
  String get metricsOdometerLower =>
      'La lectura es menor que la última registrada. Revísala — se enviará tal cual.';

  @override
  String get metricsFieldOdometer => 'el odómetro';

  @override
  String get metricsFieldFuel => 'el combustible';

  @override
  String get metricsFieldCleanliness => 'la limpieza';

  @override
  String get metricsFieldJoin => 'y';

  @override
  String metricsBlockedWhy(String fields) {
    return 'Falta capturar $fields.';
  }

  @override
  String get metricsFuel => 'Combustible';

  @override
  String get fuelEmpty => 'Vacío';

  @override
  String get fuelFull => 'Lleno';

  @override
  String get metricsCleanliness => 'Limpieza';

  @override
  String get cleanDirty => 'Sucio';

  @override
  String get cleanSpotless => 'Impecable';

  @override
  String get metricsNotes => 'Notas (opcional)';

  @override
  String get inspContinueSignature => 'Continuar a firma';

  @override
  String get kioskBarLabel => 'Modo firma · bloqueo en pausa';

  @override
  String get kioskBarExit => 'Salir: mantener 3 s + PIN';

  @override
  String get kioskExitPinTitle => 'Salir del modo firma';

  @override
  String get kioskExitPinBody => 'Escribe tu PIN para volver al modo staff.';

  @override
  String kioskExitWrongPin(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'PIN incorrecto — te quedan $count intentos',
      one: 'PIN incorrecto — te queda 1 intento',
    );
    return '$_temp0';
  }

  @override
  String get kioskExitExhausted =>
      'Demasiados intentos. Volviendo al paso anterior.';

  @override
  String kioskSignSubtitle(String reservation) {
    return 'Inspección del vehículo · Reserva $reservation';
  }

  @override
  String get kioskSignPrompt =>
      'Firme para confirmar que revisó el estado del vehículo junto al agente.';

  @override
  String get kioskSignHint => 'Firme aquí con el dedo';

  @override
  String get kioskSignClear => 'Borrar';

  @override
  String get kioskSignConfirm => 'Confirmar firma';

  @override
  String summaryQueueTitle(int photos) {
    return '$photos fotos · métricas · firma';
  }

  @override
  String get summaryQueueBadgeOffline => 'Se enviará al reconectar';

  @override
  String get summaryQueueBadgeOnline => 'Listo para enviar';

  @override
  String get summaryQueueMeta =>
      'Guardado local cifrado · orden de envío garantizado';

  @override
  String get inspFinishOffline => 'Terminar — se enviará al reconectar';

  @override
  String get inspFinishOnline => 'Terminar y enviar';

  @override
  String get inspFinishQueued => 'Inspección en la bandeja de salida';

  @override
  String get alreadyCompletedTitle => 'Esta inspección ya se completó';

  @override
  String get alreadyCompletedBody =>
      'Otra pantalla la cerró mientras trabajabas. Tus envíos pendientes de esta sesión se retiraron de la bandeja — no se enviará nada duplicado.';

  @override
  String alreadyCompletedBodyAt(String time) {
    return 'Otra pantalla la cerró a las $time mientras trabajabas. Tus envíos pendientes de esta sesión se retiraron de la bandeja — no se enviará nada duplicado.';
  }

  @override
  String alreadyCompletedChip(String reservation) {
    return 'Reserva $reservation';
  }

  @override
  String get backToHome => 'Volver al inicio';

  @override
  String get outboxTitle => 'Bandeja de salida';

  @override
  String get outboxDraining => 'Enviando…';

  @override
  String outboxDrainProgress(int done, int total) {
    return '$done de $total enviados';
  }

  @override
  String outboxDrainRemaining(String size) {
    return 'quedan ~$size';
  }

  @override
  String outboxItemPhoto(String angle) {
    return 'Foto · $angle';
  }

  @override
  String get outboxItemComplete => 'Cierre de inspección';

  @override
  String outboxItemMetaPhoto(String reservation, String size) {
    return '$reservation · inspección de salida · $size';
  }

  @override
  String outboxItemMetaComplete(String reservation) {
    return '$reservation · métricas + firma · va al final de su cadena';
  }

  @override
  String get outboxStatusQueued => 'En cola';

  @override
  String get outboxStatusUploading => 'Subiendo';

  @override
  String get outboxStatusWaitsPhotos => 'Espera sus fotos';

  @override
  String get outboxStatusRejected => 'Rechazado';

  @override
  String outboxAttempts(int count, String time) {
    return 'intentado $count veces · último $time';
  }

  @override
  String get outboxReasonAnglesMissing =>
      'El servidor lo rechazó: faltan los ángulos frontal y trasero. Captúralos y reintenta.';

  @override
  String get outboxReasonToken =>
      'El permiso para subir venció o se consumió. Reintentar pedirá uno nuevo con tu sesión.';

  @override
  String get outboxReasonPhotoLost =>
      'La foto ya no está en este teléfono. Solo puedes descartar este envío.';

  @override
  String get outboxReasonSessionGone =>
      'La sesión de checkout ya no existe en el servidor.';

  @override
  String get outboxReasonNetwork =>
      'No se pudo enviar tras varios intentos. Reintenta cuando haya señal.';

  @override
  String get outboxReasonGeneric => 'El servidor rechazó este envío.';

  @override
  String outboxTechnicalDetail(String code, String message) {
    return 'Detalle técnico: $code · $message';
  }

  @override
  String get outboxActionOpenInspection => 'Abrir inspección';

  @override
  String get outboxActionDiscard => 'Descartar';

  @override
  String outboxDeadBanner(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other:
          '$count envíos necesitan tu decisión. El resto seguirá enviándose normal.',
      one: '1 envío necesita tu decisión. El resto seguirá enviándose normal.',
    );
    return '$_temp0';
  }

  @override
  String get outboxDiscardTitle => '¿Descartar este envío?';

  @override
  String outboxDiscardBodyPhoto(String angle, String reservation) {
    return 'Se borrará la foto ($angle) de $reservation de este teléfono. Habrá que capturarla de nuevo. Lo ya enviado al servidor no se toca.';
  }

  @override
  String outboxDiscardBodyComplete(String reservation) {
    return 'Se borrará el cierre de inspección de $reservation de este teléfono. Las métricas y la firma capturadas se perderán y habrá que repetirlas. Las fotos ya enviadas al servidor no se tocan.';
  }

  @override
  String get outboxDiscardConfirm => 'Sí, descartar';

  @override
  String get outboxDiscardKeep => 'Conservar en la bandeja';

  @override
  String get outboxEmptyTitle => 'Todo enviado';

  @override
  String get outboxEmptyBody =>
      'No hay nada esperando. Lo que captures sin señal aparecerá aquí y se enviará solo.';

  @override
  String outboxLastDrain(String time) {
    return 'Último envío: $time';
  }

  @override
  String get outboxFullTitle => 'La bandeja está llena';

  @override
  String outboxFullBody(int count) {
    return '$count envíos esperando (límite del teléfono). No cabe más — conéctate a una red para que se vacíe y puedas seguir capturando.';
  }

  @override
  String outboxFullChip(int count, int max, String size) {
    return '$count de $max · ~$size en espera';
  }

  @override
  String get outboxFullCapturesPaused =>
      'Las capturas nuevas están pausadas hasta liberar espacio.';

  @override
  String get outboxSendNow => 'Enviar ahora';

  @override
  String get outboxSendNowNoNetwork => 'Enviar ahora (sin red)';

  @override
  String get logoutPendingTitle => '¿Cerrar sesión?';

  @override
  String logoutPendingBody(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other:
          'Tienes $count envíos sin mandar; si cierras sesión se borran de este teléfono.',
      one:
          'Tienes 1 envío sin mandar; si cierras sesión se borra de este teléfono.',
    );
    return '$_temp0';
  }

  @override
  String get logoutAnyway => 'Cerrar sesión de todos modos';

  @override
  String coTitle(String reservation) {
    return 'Checkout · $reservation';
  }

  @override
  String get coTitleNoNumber => 'Checkout';

  @override
  String get coPause => 'Pausar';

  @override
  String coStepOf(int index, int total) {
    return 'Paso $index de $total';
  }

  @override
  String get coSeeAllSteps => 'Ver todos los pasos';

  @override
  String coStepsSheetTitle(int total) {
    return '$total pasos + salida alterna';
  }

  @override
  String coStepsSheetSub(String age) {
    return 'Estado reportado por el servidor · actualizado hace $age';
  }

  @override
  String get coSheetClose => 'Cerrar';

  @override
  String get coPhaseConfirm => 'Confirmar';

  @override
  String get coPhaseTerms => 'T&C';

  @override
  String get coPhasePayment => 'Pago';

  @override
  String get coPhaseInspection => 'Inspección';

  @override
  String get coPhaseClosing => 'Cierre';

  @override
  String get coStepConfirming => 'Confirmar cliente y vehículo';

  @override
  String get coStepTcPending => 'Términos y condiciones';

  @override
  String get coStepTcSigned => 'Términos firmados';

  @override
  String get coStepPaymentPending => 'Cobro en terminal';

  @override
  String get coStepPaid => 'Pago completo';

  @override
  String get coStepInspectionHandoff => 'Pasar a inspección';

  @override
  String get coStepInspectionInProgress => 'Inspección en curso';

  @override
  String get coStepCustomerSignPending => 'Firma del cliente';

  @override
  String get coStepFinalizing => 'Generando contrato';

  @override
  String get coStepClosed => 'Entregado';

  @override
  String get coStepCancelled => 'Cancelado';

  @override
  String get coStepCancelledHint =>
      'Salida alterna desde cualquier paso no terminal';

  @override
  String coStepUnknown(String step) {
    return 'Paso reportado por el servidor: $step';
  }

  @override
  String get coStepPending => 'Pendiente';

  @override
  String get coStepInProgress => 'En curso';

  @override
  String coStepDoneByYou(String time) {
    return 'Completado por ti · $time';
  }

  @override
  String coStepDoneKiosk(String time) {
    return 'Completado en el kiosco · $time';
  }

  @override
  String coStepDoneOtherAgent(String time) {
    return 'Completado por otro agente · $time';
  }

  @override
  String coStepDone(String time) {
    return 'Completado · $time';
  }

  @override
  String get coGuardTcCompleted => 'Espera: firma de T&C del cliente';

  @override
  String get coGuardPayment => 'Espera: cobro registrado';

  @override
  String get coGuardInspection => 'Espera: inspección completa';

  @override
  String get coGuardSignature => 'Espera: firma del cliente';

  @override
  String get coSurfaceKiosk => 'kiosco';

  @override
  String get coSurfaceCounter => 'mostrador';

  @override
  String get coSurfaceRideops => 'otro teléfono';

  @override
  String get coSurfaceCustomer => 'teléfono del cliente';

  @override
  String get coSurfaceOther => 'otra superficie';

  @override
  String coPresenceLine(String name, String surface, String age) {
    return '$name está en esta sesión · $surface · hace $age';
  }

  @override
  String coPresenceMore(int count) {
    return '+$count';
  }

  @override
  String coAdvancedKiosk(String step, String age) {
    return '«$step» se completó en el kiosco hace $age.';
  }

  @override
  String coAdvancedOtherAgent(String step, String age) {
    return '«$step» lo completó otro agente hace $age.';
  }

  @override
  String coAdvancedOtherSurface(String step, String age) {
    return '«$step» se completó en otra superficie hace $age.';
  }

  @override
  String coAdvancedNow(String step) {
    return 'Ya vas en: $step.';
  }

  @override
  String get coAdvancedSeeChanged => 'Ver qué cambió';

  @override
  String coStaleView(String age) {
    return 'vista de hace $age';
  }

  @override
  String coOfflineBanner(String age) {
    return 'Sin conexión. Esto es lo último que vio el servidor hace $age — puede haber cambiado en otra superficie.';
  }

  @override
  String get coBlockedOfflineWhy =>
      'Avanzar un paso requiere confirmación del servidor. Sin red no se adivina: se espera.\nNada de este paso entra a la Bandeja de salida.';

  @override
  String get coBlockedOfflineShort =>
      'Sin conexión: el avance lo confirma el servidor.';

  @override
  String get coTransitionWhy =>
      'El servidor confirma el avance; si otra superficie ya lo hizo, esta pantalla se actualiza sola.';

  @override
  String get coPauseTitle => '¿Guardar y pausar este checkout?';

  @override
  String coPauseSub(int index, int total) {
    return 'La sesión queda guardada en el paso $index de $total. Nada se pierde.';
  }

  @override
  String get coPauseSubUnknownStep =>
      'La sesión queda guardada en el paso que reporta el servidor. Nada se pierde.';

  @override
  String get coPauseKeeps =>
      'Se conserva: cliente y vehículo verificados, el código de T&C vigente y el registro de quién hizo qué.';

  @override
  String get coPauseWarn =>
      'Otro compañero (o el kiosco) puede retomarla desde donde va. Al volver, entras al paso que reporte el servidor, no al que dejaste.';

  @override
  String get coPauseConfirm => 'Guardar y pausar';

  @override
  String get coPauseStay => 'Seguir aquí';

  @override
  String get coPauseFailed =>
      'No se pudo pausar. Revisa la conexión e intenta de nuevo.';

  @override
  String get coTerminalClosedTitle => 'Este checkout ya se cerró';

  @override
  String get coTerminalCancelledTitle => 'Este checkout se canceló';

  @override
  String get coTerminalBody =>
      'Esta sesión ya es terminal: no admite más pasos.';

  @override
  String coTerminalDoneKiosk(String time) {
    return 'Se completó en el kiosco a las $time. No hay nada más que hacer aquí.';
  }

  @override
  String coTerminalDoneByYou(String time) {
    return 'Lo cerraste tú a las $time. No hay nada más que hacer aquí.';
  }

  @override
  String coTerminalDoneOtherAgent(String time) {
    return 'Lo cerró otro agente a las $time. No hay nada más que hacer aquí.';
  }

  @override
  String coTerminalDoneAt(String time) {
    return 'Se completó a las $time. No hay nada más que hacer aquí.';
  }

  @override
  String coTerminalCancelledByYou(String time) {
    return 'Lo cancelaste tú a las $time. Esta sesión ya no admite pasos.';
  }

  @override
  String coTerminalCancelledKiosk(String time) {
    return 'Se canceló en el kiosco a las $time. Esta sesión ya no admite pasos.';
  }

  @override
  String coTerminalCancelledOtherAgent(String time) {
    return 'Lo canceló otro agente a las $time. Esta sesión ya no admite pasos.';
  }

  @override
  String coTerminalCancelledAt(String time) {
    return 'Se canceló a las $time. Esta sesión ya no admite pasos.';
  }

  @override
  String coTerminalContractRequested(String time) {
    return 'Se pidió el envío del contrato al correo del cliente a las $time.';
  }

  @override
  String get coTerminalByYou => 'Tú';

  @override
  String get coTerminalByKiosk => 'En el kiosco';

  @override
  String get coTerminalByOtherAgent => 'Otro agente';

  @override
  String get coTerminalByOtherSurface => 'Otra superficie';

  @override
  String get coTerminalBackToList => 'Volver a la lista';

  @override
  String get coTerminalWhy =>
      'Si crees que se cerró por error, abre la reserva: desde aquí no se puede reabrir.';

  @override
  String get coTerminalLogTitle => 'Registro de la sesión';

  @override
  String get coExit => 'Salir';

  @override
  String get coNoSessionTitle => 'Aún no hay sesión de checkout';

  @override
  String get coNoSessionBody =>
      'Esta reserva todavía no tiene una sesión abierta. Se inicia desde la cola de salidas del inicio.';

  @override
  String get coLoadFailedTitle => 'No se pudo abrir el checkout';

  @override
  String get coConflictEntryGuardTitle => 'Falta un paso previo';

  @override
  String get coConflictVehicleTitle => 'El vehículo ya no está libre';

  @override
  String get coConflictGenericTitle => 'El servidor no aceptó el avance';

  @override
  String get coConflictSwapTitle => 'El servidor no aceptó el cambio de unidad';

  @override
  String get coConflictDismiss => 'Entendido';

  @override
  String coPickupToday(String time) {
    return 'Salida hoy $time';
  }

  @override
  String coPickupOn(String date, String time) {
    return 'Salida $date $time';
  }

  @override
  String get coPrecheckinReady => 'Pre-checkin listo';

  @override
  String get coPrecheckinPending => 'Pre-checkin pendiente';

  @override
  String coOdometerReading(String reading) {
    return 'Odómetro $reading';
  }

  @override
  String get coExitWithoutPausing => 'Salir sin pausar';

  @override
  String get coExitWithoutPausingWhy =>
      'Nada se bloquea: la sesión queda como está y el patio puede seguirla desde otra superficie.';

  @override
  String get coPauseNeedsNetwork =>
      'Pausar necesita conexión: es un aviso que se guarda en el servidor. Sin red puedes salir igual.';

  @override
  String get coStampsTitle => 'Lo que el servidor ya tiene';

  @override
  String get coStampTc => 'Firma de T&C';

  @override
  String get coStampPayment => 'Cobro registrado';

  @override
  String get coStampInspection => 'Inspección completa';

  @override
  String get coStampSignature => 'Firma del cliente';

  @override
  String coStampDone(String time) {
    return 'Listo · $time';
  }

  @override
  String get coStampPending => 'Pendiente';

  @override
  String coSessionAgeLabel(String age) {
    return 'Estado de hace $age';
  }

  @override
  String get coEntryNoVehicleTitle => 'Esta reserva no tiene vehículo asignado';

  @override
  String get coEntryNoVehicleBody =>
      'Sin unidad no se puede entregar. Asignar el vehículo a la reserva se hace hoy desde el escritorio; en cuanto quede asignado, vuelve a tocar la card.';

  @override
  String get coEntryVehicleConflictTitle => 'Esa unidad ya está en otra renta';

  @override
  String get coEntryVehicleConflictBody =>
      'El servidor lo bloqueó para que la misma unidad no se entregue dos veces. Cambiar el vehículo de la reserva —o cerrar la otra renta— se hace hoy desde el escritorio.';

  @override
  String coEntryConflictWith(String reservation) {
    return 'Reserva en conflicto: $reservation';
  }

  @override
  String coEntrySearchReservation(String reservation) {
    return 'Buscar $reservation';
  }

  @override
  String get coEntryPrecheckinTitle => 'Falta el pre-checkin del cliente';

  @override
  String get coEntryPrecheckinBody =>
      'Esta sucursal exige el pre-checkin del cliente antes de abrir el checkout.';

  @override
  String get coEntrySendPrecheckinLink => 'Enviar pre-checkin al cliente';

  @override
  String get coEntrySendingPrecheckinLink => 'Enviando…';

  @override
  String get coEntryPrecheckinLinkSent =>
      'Listo: el link de pre-checkin salió al correo del cliente. Cuando lo complete, vuelve a tocar la card.';

  @override
  String coEntryPrecheckinLinkFailed(String reason) {
    return 'No se pudo enviar el link. $reason';
  }

  @override
  String get coEntryPrecheckinLinkCooldown =>
      'Ese link ya se envió hace un momento: el servidor no manda otro tan seguido. Pídele al cliente que revise su correo (y el spam) antes de reintentar.';

  @override
  String get coEntryPrecheckinNoEmail =>
      'La reserva no tiene correo del cliente, así que no hay a dónde mandarlo. Agrégalo desde el escritorio o pide el pre-checkin por teléfono.';

  @override
  String get coEntryPrecheckinDeskNote =>
      'Capturar los datos en el mostrador todavía se hace desde el escritorio: esta app aún no tiene ese formulario.';

  @override
  String get coEntryReservationUntouched =>
      'La reserva no se tocó. En cuanto el pre-checkin quede listo, la card se desbloquea sola.';

  @override
  String get coEntryAgeTitle => 'Las reglas de edad no permiten esta entrega';

  @override
  String get coEntryAgeBody =>
      'La sucursal bloquea esta salida por su política de edad.';

  @override
  String get coEntryAgeDeskNote =>
      'La fecha de nacimiento se corrige en la reserva, desde el escritorio. Si la regla está mal, eso lo cambia tu supervisor en la configuración de la sucursal.';

  @override
  String get coEntryScopeChangedTitle => 'Se interrumpió la apertura';

  @override
  String get coEntryScopeChangedBody =>
      'Cambió tu sede o tu sesión mientras se abría el checkout, así que la respuesta del servidor ya no corresponde a lo que ves.';

  @override
  String get coEntryScopeChangedFoot =>
      'La sesión pudo haberse creado. Vuelve a tocar la card: si existe, se reanuda.';

  @override
  String get coEntryOfflineTitle => 'Sin conexión para abrir el checkout';

  @override
  String get coEntryOfflineBody =>
      'Abrir un checkout necesita la confirmación del servidor una sola vez. No se encola en la Bandeja: cuando haya señal, vuelve a tocar la card.';

  @override
  String get coEntryConnectionLostTitle => 'Se cortó la conexión al abrir';

  @override
  String get coEntryConnectionLostBody =>
      'La solicitud salió del teléfono pero el servidor no alcanzó a responder, así que la app no puede saber si el checkout quedó abierto.';

  @override
  String get coEntryConnectionLostFoot =>
      'La sesión pudo haberse creado. Cuando haya señal, vuelve a tocar la card: si existe, se reanuda.';

  @override
  String get coEntryNotReadyTitle => 'Un momento';

  @override
  String get coEntryNotReadyBody =>
      'La app todavía está cargando tu ubicación activa. Intenta de nuevo en un segundo.';

  @override
  String get coEntryNoSessionCreated =>
      'No se creó ninguna sesión de checkout.';

  @override
  String coEntryServerSaid(String message) {
    return 'El servidor respondió: $message';
  }

  @override
  String get coEntryClose => 'Cerrar';

  @override
  String get coConfirmCustomer => 'Cliente';

  @override
  String get coConfirmVehicle => 'Vehículo';

  @override
  String get coConfirmVerified => 'Verificado';

  @override
  String get coConfirmMissingPill => 'Faltan datos';

  @override
  String get coConfirmConflictPill => 'En conflicto';

  @override
  String get coConfirmName => 'Nombre';

  @override
  String get coConfirmLicense => 'Licencia';

  @override
  String coConfirmLicenseWithExpiry(String number, String date) {
    return '$number · vence $date';
  }

  @override
  String get coConfirmPhone => 'Teléfono';

  @override
  String get coConfirmPrecheckin => 'Pre-checkin';

  @override
  String get coConfirmPrecheckinDone => 'Completado';

  @override
  String coConfirmPrecheckinDoneAt(String time) {
    return 'Completado $time';
  }

  @override
  String get coConfirmPrecheckinPending => 'Pendiente';

  @override
  String get coConfirmMissingValue => 'Sin capturar';

  @override
  String get coConfirmUnit => 'Unidad';

  @override
  String get coConfirmOdometerLabel => 'Odómetro';

  @override
  String get coConfirmVehicleAvailable => 'Disponible';

  @override
  String get coConfirmChangeVehicle => 'Cambiar vehículo';

  @override
  String get coConfirmCta => 'Continuar a T&C';

  @override
  String get coConfirmFieldName => 'el nombre';

  @override
  String get coConfirmFieldLicense => 'la licencia';

  @override
  String get coConfirmFieldPhone => 'el teléfono';

  @override
  String get coConfirmFieldJoin => 'y';

  @override
  String coConfirmBlockedWhy(String fields) {
    return 'Faltan $fields del cliente. Se capturan en el mostrador o con el pre-checkin del cliente; esta pantalla se actualiza sola.';
  }

  @override
  String get coConfirmRecheck => 'Actualizar datos del cliente';

  @override
  String get coConfirmRecheckPending => 'Consultando al servidor…';

  @override
  String coConfirmRecheckedStill(String fields) {
    return 'Consultado ahora: el servidor sigue sin $fields.';
  }

  @override
  String get coConfirmStaleWhy =>
      'Estos datos son los de la última consulta que sí llegó. La de ahora no llegó: confírmalos contra la licencia antes de entregar.';

  @override
  String coConfirmStaleOldWhy(String age) {
    return 'Estos datos son de hace $age y la consulta de ahora no llegó. Vuelve a consultar antes de firmar: en ese tiempo el contrato pudo cambiar en el mostrador.';
  }

  @override
  String get coConfirmCheckingPill => 'Consultando';

  @override
  String get coConfirmCheckingValue => 'Consultando…';

  @override
  String get coConfirmCheckingWhy => 'Consultando la ficha del cliente…';

  @override
  String get coConfirmUnknownPill => 'Sin consultar';

  @override
  String get coConfirmUnknownValue => 'No se pudo consultar';

  @override
  String get coConfirmUnreachableWhy =>
      'No se pudo consultar la ficha del cliente, así que no se puede confirmar su identidad.';

  @override
  String get coConfirmServerReplyLabel => 'Respuesta del servidor';

  @override
  String get coConfirmRetryLookup => 'Reintentar la consulta';

  @override
  String get coConfirmRetryStillUnreachable =>
      'Reintentado ahora: la consulta sigue sin llegar.';

  @override
  String get coDeclineTitle => 'El cliente declina el seguro';

  @override
  String get coDeclineOff => 'Apagado · se cobra la cobertura estándar';

  @override
  String get coDeclineOn => 'Encendido · se agrega el anexo';

  @override
  String get coDeclineLocked =>
      'Los términos ya se firmaron: el anexo del seguro ya no cambia aquí';

  @override
  String get coDeclineNeedsNetwork =>
      'Sin conexión: esta bandera la registra el servidor';

  @override
  String get coDeclineConsequence =>
      'Se agregará el anexo de rechazo de cobertura a los términos que firma el cliente y al contrato PDF. Puedes apagarlo mientras no se firmen los términos.';

  @override
  String get coDeclineSignedNote =>
      'El cliente ya firmó los términos con este anexo. Para cambiarlo, el contrato se ajusta desde el mostrador.';

  @override
  String get coConflictSwapCta => 'Elegir otro vehículo';

  @override
  String get coConflictSwapWhy =>
      'Nada se perdió: al cambiar la unidad sigues en el paso 1 con el cliente ya verificado.';

  @override
  String get coSwapTitle => 'Cambiar vehículo';

  @override
  String coSwapSub(String age) {
    return 'Disponibles según el servidor · hace $age';
  }

  @override
  String get coSwapSubLoading =>
      'Preguntando al servidor qué unidades están libres…';

  @override
  String get coSwapSameGroup => 'Mismo grupo';

  @override
  String get coSwapOtherGroup => 'Otro grupo · puede cambiar la tarifa';

  @override
  String get coSwapCurrentReason =>
      'Unidad actual · una unidad no se cambia por sí misma';

  @override
  String get coSwapCurrentCommitted =>
      'Unidad actual · el servidor la reporta comprometida en otra renta';

  @override
  String get coSwapLockedCause =>
      'La inspección de esta sesión ya empezó: a partir de ahí la unidad ya no se cambia.';

  @override
  String get coSwapDoubleBookedCause =>
      'Esa unidad ya está reservada en esta misma ventana.';

  @override
  String get coSwapTerminalCause => 'Esa unidad ya no se puede rentar.';

  @override
  String coSwapConfirm(String unit) {
    return 'Cambiar a $unit';
  }

  @override
  String get coSwapConfirmNone => 'Elige una unidad';

  @override
  String get coSwapCancel => 'Cancelar';

  @override
  String get coSwapEmpty =>
      'El servidor no reporta otras unidades libres para esta ventana.';

  @override
  String get coSwapNeedsNetwork =>
      'Cambiar de unidad necesita conexión: el cambio lo hace el servidor sobre la reserva y el contrato.';

  @override
  String get coQrSemanticLabel => 'Código QR para firmar los términos';

  @override
  String get coTermsInstruction =>
      'Que el cliente lo escanee con la cámara de su teléfono para firmar.';

  @override
  String get coTermsExpiresIn => 'Vence en';

  @override
  String get coTermsExpired => 'Vencido';

  @override
  String get coTermsPresent => 'Mostrar al cliente (pantalla completa)';

  @override
  String get coTermsWaiting =>
      'Esperando la firma del cliente. Esta pantalla se actualiza sola.';

  @override
  String get coTermsReissue => 'Generar código nuevo';

  @override
  String get coTermsReissueWhy =>
      'Si al código vigente le quedan más de 2 minutos, el servidor devuelve el mismo: el cliente puede seguir con el QR que ya tiene.';

  @override
  String get coTermsReused =>
      'Sigue siendo el mismo código: al vigente le quedan más de 2 minutos y el servidor lo reusa. Si el cliente ya lo escaneó, no tiene que volver a hacerlo.';

  @override
  String get coTermsReissued =>
      'Código nuevo listo. El anterior dejó de servir.';

  @override
  String coTermsExpiredBanner(String time) {
    return 'El código venció a las $time. Nada se perdió: genera uno nuevo y el cliente firma igual.';
  }

  @override
  String get coTermsExpiredOverlay => 'Código vencido';

  @override
  String get coTermsExpiredWhy =>
      'El código nuevo dura otros 15 minutos. Si el cliente ya había abierto el anterior, tendrá que abrir el nuevo.';

  @override
  String get coTermsMinting => 'Pidiendo el código al servidor…';

  @override
  String get coTermsMintFailed => 'No se pudo emitir el código.';

  @override
  String get coTermsOfflineWhy =>
      'El código lo emite el servidor: sin conexión no hay QR que mostrar.';

  @override
  String get coTermsSignedTitle => 'Términos firmados';

  @override
  String coTermsSignedBody(String name, String time) {
    return '$name firmó a las $time. Ya puedes seguir con el cobro.';
  }

  @override
  String coTermsSignedBodyNoName(String time) {
    return 'Los términos se firmaron a las $time. Ya puedes seguir con el cobro.';
  }

  @override
  String get coTermsRecord => 'Registro';

  @override
  String get coTermsRecordConfirmed => 'Confirmado por el servidor';

  @override
  String get coTermsRecordSigned => 'Firmado';

  @override
  String get coTermsRecordAddenda => 'Anexos';

  @override
  String get coTermsAddendaNone => 'Ninguno (seguro aceptado)';

  @override
  String get coTermsAddendaDecline => 'Anexo de rechazo de cobertura';

  @override
  String get coTermsCta => 'Continuar al cobro';

  @override
  String get coTermsCtaWhy =>
      'Este botón solo existe porque el servidor ya tiene la firma registrada.';

  @override
  String get coPresentInstruction =>
      'Escanee este código con la cámara de su teléfono para leer y firmar los términos.';

  @override
  String get coPresentHelp =>
      '¿Problemas para escanear? El agente puede ayudarle.';

  @override
  String get coPresentExit => 'Salir de presentación';

  @override
  String coPresentSubtitle(String number) {
    return 'Términos de renta · Reserva $number';
  }

  @override
  String get coPresentSubtitleNoNumber => 'Términos de renta';

  @override
  String coPresentClosingSoon(String mmss) {
    return 'Quedan $mmss — si se vence, el agente le genera otro al instante.';
  }

  @override
  String get coInspWhatTitle => 'Qué se captura aquí';

  @override
  String get coInspWhatParts => '3 partes';

  @override
  String get coInspRowPhotos => 'Fotos';

  @override
  String get coInspWhatPhotos => '8 ángulos · Frente y Atrás obligatorios';

  @override
  String get coInspRowCondition => 'Estado';

  @override
  String get coInspWhatMetrics => 'Odómetro, combustible, limpieza y notas';

  @override
  String get coInspRowSignature => 'Firma';

  @override
  String get coInspWhatSignature =>
      'El cliente firma la revisión en este teléfono';

  @override
  String get coInspOfflineNote =>
      'Las fotos se pueden tomar sin señal: quedan en la bandeja y se envían solas al reconectar. El paso avanza cuando el servidor las recibe.';

  @override
  String get coInspLastReading => 'Última lectura';

  @override
  String coInspPaidPill(String time) {
    return 'Pagado $time';
  }

  @override
  String get coInspStartCta => 'Comenzar inspección';

  @override
  String get coInspStartWhy =>
      'Al comenzar, el servidor marca la inspección en curso. Puedes pausar el checkout en cualquier momento sin perder las fotos.';

  @override
  String get coInspPhotosStep => 'Inspección · fotos';

  @override
  String get coInspMetricsStep => 'Inspección · estado';

  @override
  String get coInspSummaryStep => 'Inspección · revisar y enviar';

  @override
  String get coInspRequiredWhy =>
      'Frente y Atrás listos. El resto suma evidencia y se puede capturar después de las métricas.';

  @override
  String inspPhotoQueued(String time) {
    return '$time · en bandeja';
  }

  @override
  String get inspPhotoSent => 'Enviada al servidor';

  @override
  String get inspPhotoDead => 'No llegó al servidor';

  @override
  String coInspLocalDoneTitle(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other:
          'La inspección está completa en este teléfono. Faltan $count fotos y el cierre por enviar; salen solos al reconectar.',
      one:
          'La inspección está completa en este teléfono. Falta 1 foto y el cierre por enviar; salen solos al reconectar.',
      zero:
          'La inspección está completa en este teléfono. Falta el cierre por enviar; sale solo al reconectar.',
    );
    return '$_temp0';
  }

  @override
  String get coInspLocalDoneSending =>
      'La inspección está completa en este teléfono. El envío está en curso; el paso avanza cuando el servidor lo reciba.';

  @override
  String coInspServerPhotos(int count) {
    return '$count de 8 recibidas';
  }

  @override
  String get coInspRowInspection => 'Inspección';

  @override
  String coInspReceivedAt(String time) {
    return 'Recibida $time';
  }

  @override
  String get coInspContinueSign => 'Continuar a firma y cierre';

  @override
  String get coInspBlockedWhy =>
      'Este paso lo cierra el servidor cuando reciba la inspección, no esta pantalla. Nada se pierde: puedes pausar el checkout y volver.';

  @override
  String coOpenOutbox(int count) {
    return 'Ver la bandeja ($count)';
  }

  @override
  String coOpenOutboxDead(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'Ver la bandeja ($count fallas)',
      one: 'Ver la bandeja (1 falla)',
    );
    return '$_temp0';
  }

  @override
  String coInspRequiredDeadTitle(String angle) {
    return 'La foto de $angle no se pudo enviar y es obligatoria. Sin ella el servidor rechazará el cierre de la inspección.';
  }

  @override
  String coInspRetakeCta(String angle) {
    return 'Tomar $angle otra vez';
  }

  @override
  String get coInspRetakeWhy =>
      'Al volver a tomarla se reintenta el cierre de la inspección automáticamente.';

  @override
  String get coInspCompleteDeadTitle =>
      'El cierre de la inspección no se pudo enviar. El motivo y la decisión que falta están en la bandeja.';

  @override
  String get coInspRequiredAnglesTitle => 'Ángulos obligatorios';

  @override
  String coInspRequiredMissingPill(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'Faltan $count',
      one: 'Falta 1',
    );
    return '$_temp0';
  }

  @override
  String coInspAnglesFailedChip(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count fallas',
      one: '1 falla',
    );
    return '$_temp0';
  }

  @override
  String get coInspDoneTitle => 'Inspección de salida';

  @override
  String get coInspSignatureTitle => 'Firma del cliente';

  @override
  String get coInspSignedRow => 'Firmó';

  @override
  String coSignFromInspection(String name) {
    return '$name · al terminar la inspección';
  }

  @override
  String get coSignAlreadyBanner =>
      'El cliente ya firmó, así que no hay que pedirle firma otra vez. Solo falta cerrar la entrega.';

  @override
  String get coInspCloseCta => 'Continuar al cierre';

  @override
  String get coInspCloseWhy =>
      'El servidor ya tiene la inspección y la firma. Este botón avanza al cierre; el contrato se genera cuando la entrega quede cerrada.';

  @override
  String get coHandoffTitle => 'Voltea el teléfono al cliente';

  @override
  String coHandoffBody(String name, String vehicle) {
    return '$name va a firmar la entrega del $vehicle.';
  }

  @override
  String get coHandoffBodyGeneric =>
      'El cliente va a firmar la entrega del vehículo.';

  @override
  String get coHandoffRuleLock =>
      'La app queda bloqueada en la firma: no se puede salir ni ver otra pantalla.';

  @override
  String get coHandoffRuleExit =>
      'Para salir sin firma: mantén 3 s la barra de arriba y escribe tu PIN.';

  @override
  String get coHandoffRulePin =>
      'Si fallas el PIN 3 veces, la app se bloquea y hay que volver a entrar.';

  @override
  String coHandoffRuleBrand(String tenant) {
    return 'El cliente ve la pantalla en español o inglés, con la marca de $tenant.';
  }

  @override
  String get coHandoffRuleBrandNoTenant =>
      'El cliente ve la pantalla en español o inglés, sin la marca de la plataforma.';

  @override
  String get coRetainedNote =>
      'El cliente ya firmó en este teléfono, pero el servidor todavía no lo confirmó. El trazo sigue aquí: no hace falta pedírselo otra vez.';

  @override
  String get coRetryWithSignature => 'Reintentar con la firma que ya dio';

  @override
  String get coRetryWithSignatureWhy =>
      'Se manda el MISMO trazo que el cliente dejó hace un momento. Vive solo en la memoria de este teléfono y nunca entra a la bandeja de salida.';

  @override
  String get coHandoffCta => 'Entregar al cliente';

  @override
  String get coHandoffWhy =>
      'La firma se guarda en el contrato al confirmarla. Si el cliente se arrepiente, sales con tu PIN y el paso queda igual.';

  @override
  String get coHandoffOfflineBlocked =>
      'Sin conexión no se puede recoger la firma: se guarda en el contrato en el momento, no después.';

  @override
  String kioskSignSubtitleCheckout(String reservation) {
    return 'Entrega del vehículo · Reserva $reservation';
  }

  @override
  String get kioskSignPromptCheckout =>
      'Firme para confirmar que recibe el vehículo y acepta el contrato de renta.';

  @override
  String kioskSignPlate(String plate) {
    return 'Placa $plate';
  }

  @override
  String get coSignReceived => 'Firma recibida. Ya puedes tomar el teléfono.';

  @override
  String get coCloseStep1 => 'Firma guardada en el contrato';

  @override
  String get coCloseStep2 => 'Generando el contrato';

  @override
  String get coCloseStep3 => 'Registrar la entrega';

  @override
  String coCloseLegWaiting(int index, int total) {
    return 'Paso $index de $total · falta';
  }

  @override
  String get coClosingCta => 'Cerrando…';

  @override
  String get coClosingWhy =>
      'No cierres la app: el cierre son tres confirmaciones del servidor y aquí vas por la segunda.';

  @override
  String get coCloseRetry => 'Reintentar el cierre';

  @override
  String get coCloseRetryWhy =>
      'Este tramo se puede volver a intentar: la sesión sigue abierta y nada de lo capturado se perdió.';

  @override
  String get coAlreadySignedTitle => 'El cliente ya firmó';

  @override
  String coAlreadySignedBody(String time) {
    return 'Firmó al terminar la inspección, a las $time. No hace falta pedirle el teléfono otra vez.';
  }

  @override
  String coAlreadySignedBodyOther(String time) {
    return 'La firma quedó registrada a las $time. No hace falta pedirle el teléfono otra vez.';
  }

  @override
  String coAlreadySignedChip(String time) {
    return 'Firma en el contrato · $time';
  }

  @override
  String get coSignedDocTitle => 'Lo que se firmó';

  @override
  String get coSignedSigner => 'Firmante';

  @override
  String get coSignedSignerUnknown => 'No se registró el nombre';

  @override
  String get coSignedDocument => 'Documento';

  @override
  String coSignedDocumentValue(String number) {
    return 'Contrato de renta $number';
  }

  @override
  String get coSignedDocumentValueNoNumber => 'Contrato de renta';

  @override
  String get coResignLink => 'Volver a pedir la firma';

  @override
  String get coResignWarning =>
      'La firma nueva SUSTITUYE a la que ya está en el contrato. Úsalo solo si la anterior no es válida.';

  @override
  String get coResignTitle => '¿Sustituir la firma guardada?';

  @override
  String get coResignConfirm => 'Sí, pedirla otra vez';

  @override
  String get coCloseCta => 'Cerrar la entrega';

  @override
  String get coCloseCtaWhy =>
      'Se registra la entrega en la reserva y se genera el contrato.';

  @override
  String get coClosedTitle => 'Entrega cerrada';

  @override
  String get coClosedTitleUnverified => 'Checkout cerrado';

  @override
  String get coRecordHandoverUnverifiedNotice =>
      'El cierre entró, pero no pudimos confirmarlo en la reserva. Compruébalo antes de dar por terminada la entrega.';

  @override
  String get coBeforeTheyGoTitle => 'Antes de que se vaya';

  @override
  String get coBeforeKeysLabel => 'Llaves';

  @override
  String get coBeforeKeys => 'Entrega las llaves y la tarjeta de circulación';

  @override
  String get coBeforeReturnLabel => 'Regreso';

  @override
  String get coBeforeScopeNote =>
      'El combustible y el kilometraje de salida quedaron en el registro de la inspección, no en esta pantalla.';

  @override
  String get coRecordTitle => 'Registro';

  @override
  String get coRecordPillRecorded => 'Registrada';

  @override
  String get coRecordPillChecking => 'Comprobando';

  @override
  String get coRecordPillUnverified => 'Sin confirmar';

  @override
  String get coRecordRowSession => 'Sesión';

  @override
  String coRecordSessionClosedAt(String time) {
    return 'Cerrada $time';
  }

  @override
  String get coRecordSignatureLabel => 'Firma';

  @override
  String get coRecordContractLabel => 'Contrato';

  @override
  String coRecordEmailRequested(String time) {
    return 'Se pidió enviarlo por correo a las $time';
  }

  @override
  String get coRecordEmailNotRequested => 'No hay registro de envío por correo';

  @override
  String get coRecordHandoverLabel => 'Entrega';

  @override
  String coRecordHandoverRecorded(String time) {
    return 'Registrada en la reserva · $time';
  }

  @override
  String get coRecordHandoverChecking => 'Comprobando en la reserva…';

  @override
  String get coRecordHandoverUnconfirmed => 'Sin confirmar';

  @override
  String get coRecordHandoverCheckingWhy =>
      'Nada bloquea: el agente puede salir. La comprobación no se pierde, queda en la sesión.';

  @override
  String get coRecordHandoverRecheck => 'Volver a comprobar';

  @override
  String get coRecordHandoverRecheckWhy =>
      'Es una consulta al servidor, no un reintento del cierre: la sesión ya está cerrada y no puede cerrarse dos veces.';

  @override
  String get coBackHome => 'Volver al inicio';

  @override
  String get coSessionDetail => 'Ver el detalle de la sesión';

  @override
  String get coBackToOutcome => 'Volver al resumen del cierre';

  @override
  String get coCloseFailedStepline => 'Cierre con problema';

  @override
  String get coCloseFailedTitle =>
      'El checkout se cerró, pero el servidor no registró la entrega. La reserva necesita que alguien la revise en el mostrador.';

  @override
  String get coCloseNotRecordedTitle =>
      'El checkout se cerró, pero la reserva no quedó marcada como entregada. Necesita que alguien la revise en el mostrador.';

  @override
  String coCloseFailedStep(String time) {
    return 'Rechazado a las $time';
  }

  @override
  String get coCloseReasonTitle => 'Motivo';

  @override
  String get coServerReasonLabel => 'Respuesta del servidor';

  @override
  String get coCloseReasonPill => 'Del servidor';

  @override
  String get coCloseVerifiedPill => 'Comprobado en la reserva';

  @override
  String get coCloseVerifiedTitle => 'Lo que comprobamos';

  @override
  String get coCloseVerifiedLabel => 'Estado de la reserva';

  @override
  String get coCloseNotRecordedReason =>
      'Se consultó la reserva después de cerrar y sigue sin registrar la entrega. El servidor no dio un motivo.';

  @override
  String get coCloseNoRetry =>
      'Esta sesión ya está cerrada, así que no se puede reintentar desde aquí. Nada de lo capturado se perdió.';

  @override
  String get coCopyProblem => 'Copiar el detalle para el mostrador';

  @override
  String get coCopiedProblem => 'Detalle copiado al portapapeles';

  @override
  String get coHoldKeys =>
      'No entregues las llaves hasta que el mostrador confirme.';

  @override
  String get coCloseUnknownStepline => 'Cierre sin confirmar';

  @override
  String get coCloseUnknownTitle =>
      'Se cortó la conexión mientras se cerraba. No sabemos si el cierre entró o no — hay que preguntárselo al servidor.';

  @override
  String get coCloseUnknownStep => 'Sin respuesta';

  @override
  String coCloseConfirmedAt(String time) {
    return '$time · confirmado';
  }

  @override
  String get coWontHappenTitle => 'Qué NO va a pasar';

  @override
  String get coWontHappenPill => 'Regla';

  @override
  String get coWontRetryLabel => 'Reintento';

  @override
  String get coWontRetry => 'La app no reintenta el cierre sola.';

  @override
  String get coWontQueueLabel => 'Bandeja';

  @override
  String get coWontQueue => 'El cierre no entra a la bandeja de salida.';

  @override
  String get coCheckStatus => 'Consultar el estado';

  @override
  String get coCheckStatusWhy =>
      'Con señal, una consulta dice en qué paso quedó y desde ahí se continúa.';

  @override
  String coPresenceChipSemantics(String line) {
    return '$line: ver quién está en esta sesión';
  }

  @override
  String get coPresenceNeverAlone =>
      'El chip solo afirma quién está. Que no aparezca nadie no significa que estés solo.';

  @override
  String get coWhoIsHereTitle => 'Quién está en esta sesión';

  @override
  String get coWhoIsHereSub =>
      'Ventana de 45 s del servidor · se actualiza con cada lectura';

  @override
  String get coWhoIsHereNow => 'ahora';

  @override
  String coWhoIsHereAge(String age) {
    return 'hace $age';
  }

  @override
  String get coWhoIsHereDeviceSub => 'Aparato · sin persona identificada';

  @override
  String get coWhoIsHereYou => 'Tú · RideOps';

  @override
  String coWhoIsHereYouSeenAs(String name) {
    return 'Los demás te ven como $name';
  }

  @override
  String get coWhoIsHereYouSeenAsUnknown =>
      'Los demás te ven con tu nombre completo';

  @override
  String get coWhoIsHereDisclosure =>
      'Apareces con tu nombre mientras esta pantalla esté abierta. Al salir o pausar dejas de aparecer en menos de un minuto. Esto no reserva nada: nadie queda bloqueado por estar aquí.';

  @override
  String get coPresenceEmpty =>
      'No hay nadie visible ahora mismo. Otra superficie puede estar avanzando sin aparecer aquí.';

  @override
  String get coPresenceEmptyShort => 'Nadie visible ahora mismo';

  @override
  String get coPresenceOfflineWhy =>
      'Sin red no se puede afirmar que alguien esté ahora. El punto verde se apaga; el chip no desaparece.';

  @override
  String coAdvancedOtherAgentNamed(String step, String name, String age) {
    return '«$step» lo completó $name hace $age.';
  }

  @override
  String coAdvancedStampLanded(String stamp, String age) {
    return '$stamp se registró en otra superficie hace $age.';
  }

  @override
  String get coAdvancedStepUnchanged =>
      'Sigue capturando: este paso no cambió.';

  @override
  String get coChangedTitle => 'Qué cambió desde que entraste';

  @override
  String coChangedSub(String time) {
    return 'Estado reportado por el servidor · $time';
  }

  @override
  String get coChangedStepMoved => 'El paso se movió';

  @override
  String coChangedStepMovedDetail(String from, String to) {
    return '$from → $to';
  }

  @override
  String coChangedByKiosk(String time) {
    return 'Completado en el kiosco · $time';
  }

  @override
  String coChangedByOtherAgent(String name, String time) {
    return 'Lo completó $name · $time';
  }

  @override
  String coChangedByOtherSurface(String time) {
    return 'Completado en otra superficie · $time';
  }

  @override
  String coChangedByYou(String time) {
    return 'Lo hiciste tú · $time · sin cambios';
  }

  @override
  String get coChangedUntouched => 'Pendiente · no lo ha tocado nadie';

  @override
  String get coChangedNothingLost => 'Nada de lo que hiciste se perdió.';

  @override
  String coChangedSomethingLost(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other:
          'Ojo: $count envíos no han llegado al servidor. Revisa la Bandeja antes de seguir.',
      one:
          'Ojo: 1 envío no ha llegado al servidor. Revisa la Bandeja antes de seguir.',
    );
    return '$_temp0';
  }

  @override
  String get coChangedNoChanges => 'Nadie ha tocado nada desde que entraste.';

  @override
  String coChangedStayCta(int index) {
    return 'Seguir en el paso $index';
  }

  @override
  String get coConflictTooEarlyTitle => 'Ese paso todavía no toca';

  @override
  String coConflictTooEarlyBody(
    String current,
    int index,
    String target,
    int targetIndex,
  ) {
    return 'La sesión está en $current (paso $index) y $target es el paso $targetIndex. El servidor solo deja avanzar de uno en uno.';
  }

  @override
  String get coConflictTooEarlyBodyShort =>
      'El servidor solo deja avanzar de uno en uno, y este no es el paso que sigue.';

  @override
  String coGoToStepCta(int index, String step) {
    return 'Ir al paso $index · $step';
  }

  @override
  String coGoToStepWhy(int index) {
    return 'Ir al paso $index es navegación dentro de esta app: siempre funciona.';
  }

  @override
  String coGuardOutboxCta(int n) {
    return 'Ver la Bandeja ($n)';
  }

  @override
  String get coGuardOutboxWhy =>
      'La Bandeja drena sola al recuperar señal; el paso avanza cuando el sello llegue.';

  @override
  String get coConflictSwapLockedBody =>
      'Esta unidad ya no se puede cambiar desde aquí: la inspección ya empezó. Se resuelve en el mostrador.';

  @override
  String coJoinBannerStarted(int index, int total) {
    return 'Esta salida ya empezó: va por el paso $index de $total.';
  }

  @override
  String coJoinBannerStartedAt(String time, int index, int total) {
    return 'Esta salida ya empezó. Se abrió a las $time y va por el paso $index de $total.';
  }

  @override
  String coJoinBannerStartedByOther(int index, int total) {
    return 'Esta salida la abrió otro agente y va por el paso $index de $total.';
  }

  @override
  String get coJoinDoneTitle => 'Lo que ya está hecho';

  @override
  String coJoinDonePill(int done, int total) {
    return '$done de $total fases';
  }

  @override
  String get coJoinPendingTitle => 'Lo que falta';

  @override
  String get coJoinPendingPill => 'Tuyo';

  @override
  String coJoinContinueCta(int index) {
    return 'Continuar desde el paso $index';
  }

  @override
  String get coJoinContinueCtaUnknownStep => 'Continuar';

  @override
  String get coJoinContinueWhy =>
      'Entras al paso que reporta el servidor, no al que dejó nadie. Nada se re-hace.';

  @override
  String get coJoinKioskActiveTitle =>
      'El cliente está usando el kiosco ahora mismo.';

  @override
  String get coJoinKioskActiveBody =>
      'Si avanzas desde aquí puedes interrumpir lo que está haciendo.';

  @override
  String get coJoinAdviceTitle => 'Qué conviene hacer';

  @override
  String get coJoinAdvicePill => 'Consejo';

  @override
  String get coJoinAdviceWaitKey => 'Esperar';

  @override
  String get coJoinAdviceWait =>
      'Esta pantalla se actualiza sola cuando el kiosco termine';

  @override
  String get coJoinAdviceLeaveKey => 'O irte';

  @override
  String get coJoinAdviceLeave => 'Nada se pierde: la sesión sigue igual';

  @override
  String get coJoinNotABlock =>
      'No es un bloqueo. Puedes avanzar igual — el servidor decide, no este aviso. Solo te decimos lo que está pasando del otro lado.';

  @override
  String get coJoinProceedAnyway => 'Avanzar de todas formas';

  @override
  String coJoinPausedByOther(String age) {
    return 'Otro agente pausó esta salida hace $age.';
  }

  @override
  String coJoinPausedBySomeone(String age) {
    return 'Esta salida quedó pausada hace $age.';
  }

  @override
  String coJoinPausedReason(String reason) {
    return 'Motivo: «$reason»';
  }

  @override
  String get coJoinWhereItStoppedTitle => 'Dónde quedó';

  @override
  String get coJoinNoStealWhy =>
      'Continuar no le quita nada a nadie: la sesión es una sola y el registro guarda quién hizo qué.';

  @override
  String get coJoinPausedAutoStalled =>
      'El sistema la marcó: lleva más de 4 h detenida. No la pausó nadie.';

  @override
  String coJoinPausedBySystem(String age) {
    return 'El sistema marcó esta salida hace $age.';
  }

  @override
  String get coConflictVehicleKept =>
      'Se conserva: el cliente ya verificado y el paso en el que vas.';

  @override
  String get coGuardWhyServer =>
      'Este paso lo cierra el servidor cuando reciba el sello, no esta pantalla. Nada se pierde: puedes pausar y volver.';

  @override
  String coPresenceChipLive(String name, String surface) {
    return '$name · $surface';
  }

  @override
  String coPresenceChipAged(String name, String age) {
    return '$name · hace $age';
  }

  @override
  String get coWhoIsHereYouOffline => 'Sin conexión';

  @override
  String get coWhoIsHereDisclosureOffline =>
      'Sin conexión tu latido no está llegando: en menos de un minuto dejas de aparecer para las demás superficies. Vuelves a aparecer solo al recuperar señal. Esto nunca reserva nada.';

  @override
  String get coPresenceEmptyUnverifiable =>
      'Y tampoco se puede leer como «no hay nadie»: otra superficie puede estar avanzando sin que lo veamos.';
}
