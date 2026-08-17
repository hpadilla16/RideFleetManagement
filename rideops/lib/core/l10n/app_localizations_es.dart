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
  String cardOpenInspectionSemantics(String details) {
    return '$details: abrir inspección de salida';
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
  String get metricsOdometerUnit => 'mi';

  @override
  String metricsPrevReading(String value) {
    return 'Última lectura registrada: $value mi';
  }

  @override
  String get metricsOdometerLower =>
      'La lectura es menor que la última registrada. Revísala — se enviará tal cual.';

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
  String get coTerminalClosedTitle => 'Checkout entregado';

  @override
  String get coTerminalCancelledTitle => 'Checkout cancelado';

  @override
  String get coTerminalBody =>
      'Esta sesión ya es terminal: no admite más pasos.';

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
  String get coConflictDismiss => 'Entendido';

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
}
