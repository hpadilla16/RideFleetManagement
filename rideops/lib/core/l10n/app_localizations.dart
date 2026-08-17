import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_en.dart';
import 'app_localizations_es.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'l10n/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations? of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations);
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('en'),
    Locale('es'),
  ];

  /// No description provided for @appTitle.
  ///
  /// In es, this message translates to:
  /// **'RideOps'**
  String get appTitle;

  /// No description provided for @loginTitle.
  ///
  /// In es, this message translates to:
  /// **'Iniciar sesión'**
  String get loginTitle;

  /// No description provided for @loginSubtitle.
  ///
  /// In es, this message translates to:
  /// **'Operaciones de patio'**
  String get loginSubtitle;

  /// No description provided for @loginEmailLabel.
  ///
  /// In es, this message translates to:
  /// **'Correo'**
  String get loginEmailLabel;

  /// No description provided for @loginPasswordLabel.
  ///
  /// In es, this message translates to:
  /// **'Contraseña'**
  String get loginPasswordLabel;

  /// No description provided for @loginButton.
  ///
  /// In es, this message translates to:
  /// **'Entrar'**
  String get loginButton;

  /// No description provided for @loginButtonLoading.
  ///
  /// In es, this message translates to:
  /// **'Entrando…'**
  String get loginButtonLoading;

  /// No description provided for @loginInvalidCredentials.
  ///
  /// In es, this message translates to:
  /// **'Correo o contraseña incorrectos. Revisa e intenta de nuevo.'**
  String get loginInvalidCredentials;

  /// Backlog (ya NO depende de H4: connectivity_plus entró con H5): cuando el login gane auto-reintento al volver la señal, volver al copy del mockup 1C ('se reintentará al volver la señal'). Hoy el reintento es manual — no prometerlo.
  ///
  /// In es, this message translates to:
  /// **'No hay conexión a internet. Revisa la señal y toca Reintentar ahora.'**
  String get loginOffline;

  /// No description provided for @loginRetryNow.
  ///
  /// In es, this message translates to:
  /// **'Reintentar ahora'**
  String get loginRetryNow;

  /// No description provided for @loginHelpLine.
  ///
  /// In es, this message translates to:
  /// **'¿Problemas para entrar? Pide a tu admin restablecer tu contraseña'**
  String get loginHelpLine;

  /// Pie del login: versión de la app, flavor y locale activo
  ///
  /// In es, this message translates to:
  /// **'v{version} ({env}) · {locale}'**
  String loginVersionLine(String version, String env, String locale);

  /// No description provided for @showPassword.
  ///
  /// In es, this message translates to:
  /// **'Mostrar contraseña'**
  String get showPassword;

  /// No description provided for @hidePassword.
  ///
  /// In es, this message translates to:
  /// **'Ocultar contraseña'**
  String get hidePassword;

  /// No description provided for @changePasswordChip.
  ///
  /// In es, this message translates to:
  /// **'Paso obligatorio'**
  String get changePasswordChip;

  /// No description provided for @changePasswordTitle.
  ///
  /// In es, this message translates to:
  /// **'Crea tu contraseña'**
  String get changePasswordTitle;

  /// No description provided for @changePasswordBody.
  ///
  /// In es, this message translates to:
  /// **'Entraste con una contraseña temporal. Por seguridad, crea la tuya antes de continuar.'**
  String get changePasswordBody;

  /// No description provided for @currentPasswordLabel.
  ///
  /// In es, this message translates to:
  /// **'Contraseña temporal (actual)'**
  String get currentPasswordLabel;

  /// No description provided for @newPasswordLabel.
  ///
  /// In es, this message translates to:
  /// **'Nueva contraseña'**
  String get newPasswordLabel;

  /// No description provided for @policyRuleMinLength.
  ///
  /// In es, this message translates to:
  /// **'Mínimo {count} caracteres'**
  String policyRuleMinLength(int count);

  /// No description provided for @policyRuleLowercase.
  ///
  /// In es, this message translates to:
  /// **'Al menos una minúscula'**
  String get policyRuleLowercase;

  /// No description provided for @policyRuleUppercase.
  ///
  /// In es, this message translates to:
  /// **'Al menos una mayúscula'**
  String get policyRuleUppercase;

  /// No description provided for @policyRuleDigit.
  ///
  /// In es, this message translates to:
  /// **'Al menos un número'**
  String get policyRuleDigit;

  /// No description provided for @policyRuleSpecial.
  ///
  /// In es, this message translates to:
  /// **'Al menos un símbolo (p. ej. ! # \$)'**
  String get policyRuleSpecial;

  /// No description provided for @policyRuleDifferent.
  ///
  /// In es, this message translates to:
  /// **'Distinta de la contraseña temporal'**
  String get policyRuleDifferent;

  /// No description provided for @changePasswordButton.
  ///
  /// In es, this message translates to:
  /// **'Guardar y continuar'**
  String get changePasswordButton;

  /// No description provided for @changePasswordSaving.
  ///
  /// In es, this message translates to:
  /// **'Guardando…'**
  String get changePasswordSaving;

  /// No description provided for @changePasswordCurrentWrong.
  ///
  /// In es, this message translates to:
  /// **'La contraseña temporal no es correcta. Revísala o pide a tu admin una nueva.'**
  String get changePasswordCurrentWrong;

  /// No description provided for @changePasswordSuccessTitle.
  ///
  /// In es, this message translates to:
  /// **'Contraseña actualizada'**
  String get changePasswordSuccessTitle;

  /// No description provided for @changePasswordSuccessBody.
  ///
  /// In es, this message translates to:
  /// **'Tu sesión sigue activa — no necesitas volver a entrar.'**
  String get changePasswordSuccessBody;

  /// No description provided for @changePasswordFootnote.
  ///
  /// In es, this message translates to:
  /// **'La sesión temporal sigue viva durante este paso'**
  String get changePasswordFootnote;

  /// No description provided for @continueButton.
  ///
  /// In es, this message translates to:
  /// **'Continuar'**
  String get continueButton;

  /// No description provided for @changePasswordNextPin.
  ///
  /// In es, this message translates to:
  /// **'Siguiente: crea tu PIN para desbloquear rápido en el patio.'**
  String get changePasswordNextPin;

  /// No description provided for @pinSetupTitle.
  ///
  /// In es, this message translates to:
  /// **'Crea tu PIN'**
  String get pinSetupTitle;

  /// No description provided for @pinSetupSubtitle.
  ///
  /// In es, this message translates to:
  /// **'Lo usarás para desbloquear RideOps en el patio. 4 dígitos.'**
  String get pinSetupSubtitle;

  /// No description provided for @pinSetupConfirmTitle.
  ///
  /// In es, this message translates to:
  /// **'Confirma tu PIN'**
  String get pinSetupConfirmTitle;

  /// No description provided for @pinSetupConfirmSubtitle.
  ///
  /// In es, this message translates to:
  /// **'Escríbelo otra vez para confirmarlo.'**
  String get pinSetupConfirmSubtitle;

  /// No description provided for @pinSetupStep.
  ///
  /// In es, this message translates to:
  /// **'Paso {step} de 2'**
  String pinSetupStep(int step);

  /// No description provided for @pinSetupMismatch.
  ///
  /// In es, this message translates to:
  /// **'Los PIN no coinciden. Empieza de nuevo.'**
  String get pinSetupMismatch;

  /// No description provided for @pinBioOfferTitle.
  ///
  /// In es, this message translates to:
  /// **'¿Activar huella?'**
  String get pinBioOfferTitle;

  /// No description provided for @pinBioOfferBody.
  ///
  /// In es, this message translates to:
  /// **'Desbloquea con tu huella, sin escribir el PIN. Tu PIN sigue funcionando siempre.'**
  String get pinBioOfferBody;

  /// No description provided for @pinBioEnable.
  ///
  /// In es, this message translates to:
  /// **'Activar huella'**
  String get pinBioEnable;

  /// No description provided for @pinBioSkip.
  ///
  /// In es, this message translates to:
  /// **'Ahora no'**
  String get pinBioSkip;

  /// No description provided for @pinBioEnrollFailed.
  ///
  /// In es, this message translates to:
  /// **'No se pudo activar la huella. Puedes seguir con tu PIN.'**
  String get pinBioEnrollFailed;

  /// No description provided for @pinBioPrompt.
  ///
  /// In es, this message translates to:
  /// **'Confirma tu identidad para desbloquear RideOps'**
  String get pinBioPrompt;

  /// No description provided for @pinBioKeyLabel.
  ///
  /// In es, this message translates to:
  /// **'Desbloquear con huella'**
  String get pinBioKeyLabel;

  /// No description provided for @keypadDeleteLabel.
  ///
  /// In es, this message translates to:
  /// **'Borrar dígito'**
  String get keypadDeleteLabel;

  /// Semántica de los dots del PIN para lector de pantalla
  ///
  /// In es, this message translates to:
  /// **'{count} de 4 dígitos'**
  String pinDigitsProgress(int count);

  /// No description provided for @lockGreeting.
  ///
  /// In es, this message translates to:
  /// **'Hola, {name}'**
  String lockGreeting(String name);

  /// No description provided for @lockTitleGeneric.
  ///
  /// In es, this message translates to:
  /// **'Desbloquea RideOps'**
  String get lockTitleGeneric;

  /// No description provided for @lockSubtitle.
  ///
  /// In es, this message translates to:
  /// **'Ingresa tu PIN para continuar'**
  String get lockSubtitle;

  /// No description provided for @lockWrongPin.
  ///
  /// In es, this message translates to:
  /// **'{count, plural, one{PIN incorrecto — te queda 1 intento} other{PIN incorrecto — te quedan {count} intentos}}'**
  String lockWrongPin(int count);

  /// No description provided for @lockForgotPin.
  ///
  /// In es, this message translates to:
  /// **'¿Olvidaste tu PIN? Cerrar sesión'**
  String get lockForgotPin;

  /// No description provided for @logoutButton.
  ///
  /// In es, this message translates to:
  /// **'Cerrar sesión'**
  String get logoutButton;

  /// No description provided for @tabHome.
  ///
  /// In es, this message translates to:
  /// **'Inicio'**
  String get tabHome;

  /// No description provided for @tabSearch.
  ///
  /// In es, this message translates to:
  /// **'Buscar'**
  String get tabSearch;

  /// No description provided for @tabIncidents.
  ///
  /// In es, this message translates to:
  /// **'Incidentes'**
  String get tabIncidents;

  /// No description provided for @tabOutbox.
  ///
  /// In es, this message translates to:
  /// **'Bandeja'**
  String get tabOutbox;

  /// No description provided for @tabProfile.
  ///
  /// In es, this message translates to:
  /// **'Perfil'**
  String get tabProfile;

  /// Etiqueta de accesibilidad del badge de la tab Bandeja
  ///
  /// In es, this message translates to:
  /// **'{count} pendientes de envío'**
  String outboxBadgeSemantics(int count);

  /// No description provided for @shellPlaceholderBody.
  ///
  /// In es, this message translates to:
  /// **'Esta sección llega en una historia siguiente.'**
  String get shellPlaceholderBody;

  /// No description provided for @locationChipAll.
  ///
  /// In es, this message translates to:
  /// **'Todas'**
  String get locationChipAll;

  /// No description provided for @locationChipSemantics.
  ///
  /// In es, this message translates to:
  /// **'Ubicación activa: {location}. Toca para cambiar.'**
  String locationChipSemantics(String location);

  /// No description provided for @locationSheetTitle.
  ///
  /// In es, this message translates to:
  /// **'Ubicación activa'**
  String get locationSheetTitle;

  /// No description provided for @locationSheetSubtitle.
  ///
  /// In es, this message translates to:
  /// **'Filtra colas, búsqueda y capturas nuevas'**
  String get locationSheetSubtitle;

  /// No description provided for @locationAllMine.
  ///
  /// In es, this message translates to:
  /// **'Todas mis ubicaciones'**
  String get locationAllMine;

  /// No description provided for @locationCurrentLabel.
  ///
  /// In es, this message translates to:
  /// **'Ubicación actual'**
  String get locationCurrentLabel;

  /// No description provided for @locationSheetError.
  ///
  /// In es, this message translates to:
  /// **'No se pudieron cargar tus ubicaciones. Revisa la señal e intenta de nuevo.'**
  String get locationSheetError;

  /// No description provided for @cancelButton.
  ///
  /// In es, this message translates to:
  /// **'Cancelar'**
  String get cancelButton;

  /// No description provided for @locationDeniedTitle.
  ///
  /// In es, this message translates to:
  /// **'Sin acceso a esta ubicación'**
  String get locationDeniedTitle;

  /// No description provided for @locationDeniedBody.
  ///
  /// In es, this message translates to:
  /// **'Tu cuenta ya no tiene acceso a {location}. Elige otra ubicación para seguir trabajando.'**
  String locationDeniedBody(String location);

  /// No description provided for @locationDeniedBodyGeneric.
  ///
  /// In es, this message translates to:
  /// **'Tu cuenta ya no tiene acceso a esta ubicación. Elige otra ubicación para seguir trabajando.'**
  String get locationDeniedBodyGeneric;

  /// No description provided for @locationDeniedChangeButton.
  ///
  /// In es, this message translates to:
  /// **'Cambiar ubicación'**
  String get locationDeniedChangeButton;

  /// No description provided for @locationDeniedAdminNote.
  ///
  /// In es, this message translates to:
  /// **'Si crees que es un error, avisa a tu administrador.'**
  String get locationDeniedAdminNote;

  /// No description provided for @loadingLabel.
  ///
  /// In es, this message translates to:
  /// **'Cargando…'**
  String get loadingLabel;

  /// No description provided for @sessionExpired.
  ///
  /// In es, this message translates to:
  /// **'Tu sesión venció. Vuelve a entrar.'**
  String get sessionExpired;

  /// Aviso en login tras la recuperación de kiosco sin PIN (política H6): la expulsión fue deliberada, no un crash
  ///
  /// In es, this message translates to:
  /// **'Por seguridad, vuelve a entrar con tu contraseña.'**
  String get loginKioskRelogin;

  /// No description provided for @locationDenied.
  ///
  /// In es, this message translates to:
  /// **'No tienes acceso a esa ubicación.'**
  String get locationDenied;

  /// No description provided for @errorConflictReloaded.
  ///
  /// In es, this message translates to:
  /// **'Otra pantalla avanzó esta sesión. Se recargó el estado.'**
  String get errorConflictReloaded;

  /// No description provided for @errorRateLimited.
  ///
  /// In es, this message translates to:
  /// **'Demasiadas solicitudes. Espera un momento e intenta de nuevo.'**
  String get errorRateLimited;

  /// No description provided for @errorNoConnectionRetry.
  ///
  /// In es, this message translates to:
  /// **'No hay conexión a internet. Revisa la señal e intenta de nuevo.'**
  String get errorNoConnectionRetry;

  /// No description provided for @errorOffline.
  ///
  /// In es, this message translates to:
  /// **'Sin conexión. Se guardó para enviar después.'**
  String get errorOffline;

  /// No description provided for @outboxDeadLetterTitle.
  ///
  /// In es, this message translates to:
  /// **'Pendientes con error'**
  String get outboxDeadLetterTitle;

  /// No description provided for @retryButton.
  ///
  /// In es, this message translates to:
  /// **'Reintentar'**
  String get retryButton;

  /// No description provided for @genericError.
  ///
  /// In es, this message translates to:
  /// **'Algo salió mal. Intenta de nuevo.'**
  String get genericError;

  /// Chip del shell en danger mientras el 403 de view-location esté activo
  ///
  /// In es, this message translates to:
  /// **'Ubicación activa: {location}. Acceso denegado. Toca para cambiar.'**
  String locationChipDeniedSemantics(String location);

  /// No description provided for @ageMoment.
  ///
  /// In es, this message translates to:
  /// **'un momento'**
  String get ageMoment;

  /// Edad corta del dato (fila de frescura y banners)
  ///
  /// In es, this message translates to:
  /// **'{count} min'**
  String ageMinutes(int count);

  /// No description provided for @ageHours.
  ///
  /// In es, this message translates to:
  /// **'{count} h'**
  String ageHours(int count);

  /// No description provided for @homeFreshnessLine.
  ///
  /// In es, this message translates to:
  /// **'Actualizado hace {age} · se actualiza solo'**
  String homeFreshnessLine(String age);

  /// No description provided for @homeOfflineBanner.
  ///
  /// In es, this message translates to:
  /// **'Sin conexión — mostrando datos de hace {age}. Se actualizará solo al volver la señal.'**
  String homeOfflineBanner(String age);

  /// No description provided for @homeStaleBanner.
  ///
  /// In es, this message translates to:
  /// **'No se pudo actualizar — mostrando datos de hace {age}.'**
  String homeStaleBanner(String age);

  /// No description provided for @homeErrorTitle.
  ///
  /// In es, this message translates to:
  /// **'No se pudo cargar el tablero'**
  String get homeErrorTitle;

  /// No description provided for @forbiddenTitle.
  ///
  /// In es, this message translates to:
  /// **'Sin acceso'**
  String get forbiddenTitle;

  /// No description provided for @heroTitle.
  ///
  /// In es, this message translates to:
  /// **'Para ahora'**
  String get heroTitle;

  /// No description provided for @heroPartDepartures.
  ///
  /// In es, this message translates to:
  /// **'{count, plural, one{1 salida} other{{count} salidas}}'**
  String heroPartDepartures(int count);

  /// La cola de salidas tocó el take:8 con puros items de hoy — el total real puede ser mayor
  ///
  /// In es, this message translates to:
  /// **'{count}+ salidas'**
  String heroPartDeparturesCapped(int count);

  /// No description provided for @heroPartReturns.
  ///
  /// In es, this message translates to:
  /// **'{count, plural, one{1 retorno} other{{count} retornos}}'**
  String heroPartReturns(int count);

  /// No description provided for @heroPartIncidents.
  ///
  /// In es, this message translates to:
  /// **'{count, plural, one{1 incidente} other{{count} incidentes}}'**
  String heroPartIncidents(int count);

  /// No description provided for @heroCalmFoot.
  ///
  /// In es, this message translates to:
  /// **'Sin pendientes inmediatos'**
  String get heroCalmFoot;

  /// Pie del hero en offline: hora del último dato bueno (mockup 5E)
  ///
  /// In es, this message translates to:
  /// **'al corte de las {time}'**
  String heroCutoffFoot(String time);

  /// No description provided for @tileActiveTitle.
  ///
  /// In es, this message translates to:
  /// **'En renta'**
  String get tileActiveTitle;

  /// No description provided for @tileActiveFoot.
  ///
  /// In es, this message translates to:
  /// **'{count, plural, =0{Ver lista ›} one{1 vence hoy · ver lista ›} other{{count} vencen hoy · ver lista ›}}'**
  String tileActiveFoot(int count);

  /// No description provided for @tileActiveSemantics.
  ///
  /// In es, this message translates to:
  /// **'En renta: {count}. Toca para ver la lista completa.'**
  String tileActiveSemantics(int count);

  /// No description provided for @tileLoanerTitle.
  ///
  /// In es, this message translates to:
  /// **'Loaner'**
  String get tileLoanerTitle;

  /// No description provided for @tileLoanerFoot.
  ///
  /// In es, this message translates to:
  /// **'{count, plural, =0{Sin seguimientos} one{1 pide seguimiento} other{{count} piden seguimiento}}'**
  String tileLoanerFoot(int count);

  /// No description provided for @tileLoanerFootCapped.
  ///
  /// In es, this message translates to:
  /// **'{count}+ piden seguimiento'**
  String tileLoanerFootCapped(int count);

  /// No description provided for @tilePrecheckinTitle.
  ///
  /// In es, this message translates to:
  /// **'Pre-checkin'**
  String get tilePrecheckinTitle;

  /// No description provided for @tilePrecheckinFoot.
  ///
  /// In es, this message translates to:
  /// **'Enviado, sin completar'**
  String get tilePrecheckinFoot;

  /// No description provided for @queueIssueEscalations.
  ///
  /// In es, this message translates to:
  /// **'Incidentes'**
  String get queueIssueEscalations;

  /// No description provided for @queueCheckout.
  ///
  /// In es, this message translates to:
  /// **'Salidas (72 h)'**
  String get queueCheckout;

  /// No description provided for @queueReturns.
  ///
  /// In es, this message translates to:
  /// **'Retornos (72 h)'**
  String get queueReturns;

  /// No description provided for @queuePrecheckin.
  ///
  /// In es, this message translates to:
  /// **'Pre-checkin'**
  String get queuePrecheckin;

  /// No description provided for @queueLoanerAdvisorFollowup.
  ///
  /// In es, this message translates to:
  /// **'Seguimiento loaner'**
  String get queueLoanerAdvisorFollowup;

  /// No description provided for @queueLoanerReady.
  ///
  /// In es, this message translates to:
  /// **'Loaner listos'**
  String get queueLoanerReady;

  /// No description provided for @queueLoanerBillingReview.
  ///
  /// In es, this message translates to:
  /// **'Facturación loaner'**
  String get queueLoanerBillingReview;

  /// No description provided for @queueLoanerReturns.
  ///
  /// In es, this message translates to:
  /// **'Retornos loaner'**
  String get queueLoanerReturns;

  /// No description provided for @queueActive.
  ///
  /// In es, this message translates to:
  /// **'En renta'**
  String get queueActive;

  /// No description provided for @seeAllButton.
  ///
  /// In es, this message translates to:
  /// **'Ver todo'**
  String get seeAllButton;

  /// Contador honesto al tocar el take:8 del server — nunca un total inventado
  ///
  /// In es, this message translates to:
  /// **'{count}+'**
  String queueCountCapped(int count);

  /// No description provided for @calmRowTitle.
  ///
  /// In es, this message translates to:
  /// **'Sin actividad ahora'**
  String get calmRowTitle;

  /// No description provided for @calmChipSemantics.
  ///
  /// In es, this message translates to:
  /// **'{queue}: sin pendientes. Toca para abrir la cola.'**
  String calmChipSemantics(String queue);

  /// No description provided for @emptyAllTitle.
  ///
  /// In es, this message translates to:
  /// **'Patio en calma'**
  String get emptyAllTitle;

  /// No description provided for @emptyAllBody.
  ///
  /// In es, this message translates to:
  /// **'No hay nada pendiente en ninguna cola ahora mismo. Desliza hacia abajo para actualizar cuando quieras.'**
  String get emptyAllBody;

  /// No description provided for @emptyAllQueuesLabel.
  ///
  /// In es, this message translates to:
  /// **'Las {count} colas, en cero'**
  String emptyAllQueuesLabel(int count);

  /// No description provided for @cardToday.
  ///
  /// In es, this message translates to:
  /// **'Hoy {time}'**
  String cardToday(String time);

  /// No description provided for @cardTomorrow.
  ///
  /// In es, this message translates to:
  /// **'Mañana {time}'**
  String cardTomorrow(String time);

  /// No description provided for @cardOverdueHours.
  ///
  /// In es, this message translates to:
  /// **'{count, plural, one{Vencido 1 h} other{Vencido {count} h}}'**
  String cardOverdueHours(int count);

  /// No description provided for @cardOverdueMinutes.
  ///
  /// In es, this message translates to:
  /// **'Vencido {count} min'**
  String cardOverdueMinutes(int count);

  /// No description provided for @precheckinReady.
  ///
  /// In es, this message translates to:
  /// **'Pre-checkin listo'**
  String get precheckinReady;

  /// No description provided for @precheckinMissing.
  ///
  /// In es, this message translates to:
  /// **'Falta pre-checkin'**
  String get precheckinMissing;

  /// No description provided for @incidentOpen.
  ///
  /// In es, this message translates to:
  /// **'Abierto'**
  String get incidentOpen;

  /// No description provided for @incidentUnderReview.
  ///
  /// In es, this message translates to:
  /// **'En revisión'**
  String get incidentUnderReview;

  /// No description provided for @incidentReported.
  ///
  /// In es, this message translates to:
  /// **'Reportado {time}'**
  String incidentReported(String time);

  /// No description provided for @loanerFollowupPacket.
  ///
  /// In es, this message translates to:
  /// **'Expediente sin completar'**
  String get loanerFollowupPacket;

  /// No description provided for @loanerFollowupService.
  ///
  /// In es, this message translates to:
  /// **'Servicio vencido'**
  String get loanerFollowupService;

  /// No description provided for @loanerFollowupBilling.
  ///
  /// In es, this message translates to:
  /// **'Facturación rechazada'**
  String get loanerFollowupBilling;

  /// No description provided for @loanerReadyChip.
  ///
  /// In es, this message translates to:
  /// **'Listo para entrega'**
  String get loanerReadyChip;

  /// No description provided for @advisorLabel.
  ///
  /// In es, this message translates to:
  /// **'Asesor: {name}'**
  String advisorLabel(String name);

  /// No description provided for @queueListShowingFirst.
  ///
  /// In es, this message translates to:
  /// **'Mostrando los primeros {count} — puede haber más'**
  String queueListShowingFirst(int count);

  /// No description provided for @queueListShowingOf.
  ///
  /// In es, this message translates to:
  /// **'Mostrando {shown} de {total}'**
  String queueListShowingOf(int shown, int total);

  /// No description provided for @queueEmptyBody.
  ///
  /// In es, this message translates to:
  /// **'Nada en esta cola ahora mismo.'**
  String get queueEmptyBody;

  /// No description provided for @searchFieldHint.
  ///
  /// In es, this message translates to:
  /// **'Cliente, reserva, placa o unidad'**
  String get searchFieldHint;

  /// No description provided for @searchFieldLabel.
  ///
  /// In es, this message translates to:
  /// **'Buscar'**
  String get searchFieldLabel;

  /// No description provided for @searchClearLabel.
  ///
  /// In es, this message translates to:
  /// **'Borrar búsqueda'**
  String get searchClearLabel;

  /// No description provided for @searchPrompt.
  ///
  /// In es, this message translates to:
  /// **'Busca en las reservas de tu sede activa.'**
  String get searchPrompt;

  /// No description provided for @searchNoResults.
  ///
  /// In es, this message translates to:
  /// **'Sin resultados para “{query}”.'**
  String searchNoResults(String query);

  /// Card tocable de la cola de salidas (H6). GD MC-2: {details} = nombre · hora del chip · meta — TalkBack no puede perder la hora ni el estado de pre-checkin
  ///
  /// In es, this message translates to:
  /// **'{details}: abrir inspección de salida'**
  String cardOpenInspectionSemantics(String details);

  /// No description provided for @inspTitle.
  ///
  /// In es, this message translates to:
  /// **'Inspección de salida'**
  String get inspTitle;

  /// No description provided for @inspProgressChip.
  ///
  /// In es, this message translates to:
  /// **'{count} de 8'**
  String inspProgressChip(int count);

  /// No description provided for @inspProgressDone.
  ///
  /// In es, this message translates to:
  /// **'8 de 8 ✓'**
  String get inspProgressDone;

  /// No description provided for @angleFront.
  ///
  /// In es, this message translates to:
  /// **'Frente'**
  String get angleFront;

  /// No description provided for @angleRear.
  ///
  /// In es, this message translates to:
  /// **'Atrás'**
  String get angleRear;

  /// No description provided for @angleLeft.
  ///
  /// In es, this message translates to:
  /// **'Lado izquierdo'**
  String get angleLeft;

  /// No description provided for @angleRight.
  ///
  /// In es, this message translates to:
  /// **'Lado derecho'**
  String get angleRight;

  /// No description provided for @angleFrontSeat.
  ///
  /// In es, this message translates to:
  /// **'Asiento del.'**
  String get angleFrontSeat;

  /// No description provided for @angleRearSeat.
  ///
  /// In es, this message translates to:
  /// **'Asiento tras.'**
  String get angleRearSeat;

  /// No description provided for @angleDash.
  ///
  /// In es, this message translates to:
  /// **'Tablero'**
  String get angleDash;

  /// No description provided for @angleTrunk.
  ///
  /// In es, this message translates to:
  /// **'Cajuela'**
  String get angleTrunk;

  /// No description provided for @angleRequiredChip.
  ///
  /// In es, this message translates to:
  /// **'Obligatorio'**
  String get angleRequiredChip;

  /// No description provided for @anglePending.
  ///
  /// In es, this message translates to:
  /// **'Pendiente'**
  String get anglePending;

  /// No description provided for @angleCompressing.
  ///
  /// In es, this message translates to:
  /// **'Comprimiendo…'**
  String get angleCompressing;

  /// No description provided for @angleFailedRetry.
  ///
  /// In es, this message translates to:
  /// **'Falló — toca para reintentar'**
  String get angleFailedRetry;

  /// No description provided for @angleQueued.
  ///
  /// In es, this message translates to:
  /// **'En bandeja'**
  String get angleQueued;

  /// No description provided for @angleOnServer.
  ///
  /// In es, this message translates to:
  /// **'Ya en el servidor'**
  String get angleOnServer;

  /// No description provided for @inspContinueMetrics.
  ///
  /// In es, this message translates to:
  /// **'Continuar a métricas'**
  String get inspContinueMetrics;

  /// No description provided for @inspRequiredFootnote.
  ///
  /// In es, this message translates to:
  /// **'Frente y Atrás son obligatorios; el resto suma evidencia.'**
  String get inspRequiredFootnote;

  /// No description provided for @inspOfflineBanner.
  ///
  /// In es, this message translates to:
  /// **'Sin conexión. Puedes terminar la inspección completa: todo queda en la bandeja y se enviará al reconectar.'**
  String get inspOfflineBanner;

  /// No description provided for @inspOfflineChip.
  ///
  /// In es, this message translates to:
  /// **'Sin red'**
  String get inspOfflineChip;

  /// No description provided for @inspLinkExpires.
  ///
  /// In es, this message translates to:
  /// **'El enlace de esta sesión vence a las {time}.'**
  String inspLinkExpires(String time);

  /// No description provided for @inspLoadOffline.
  ///
  /// In es, this message translates to:
  /// **'Sin conexión. Para iniciar la inspección se necesita señal una vez; después todo funciona sin red.'**
  String get inspLoadOffline;

  /// No description provided for @inspOutboxFull.
  ///
  /// In es, this message translates to:
  /// **'La bandeja está llena. Conéctate a una red para que se vacíe antes de capturar más fotos.'**
  String get inspOutboxFull;

  /// No description provided for @camAnglePill.
  ///
  /// In es, this message translates to:
  /// **'{angle} · {n} de 8'**
  String camAnglePill(String angle, int n);

  /// No description provided for @camHintExterior.
  ///
  /// In es, this message translates to:
  /// **'Encuadra el vehículo completo dentro de las esquinas'**
  String get camHintExterior;

  /// No description provided for @camHintInterior.
  ///
  /// In es, this message translates to:
  /// **'Encuadra el área completa dentro de las esquinas'**
  String get camHintInterior;

  /// No description provided for @camFlash.
  ///
  /// In es, this message translates to:
  /// **'Flash'**
  String get camFlash;

  /// No description provided for @camClose.
  ///
  /// In es, this message translates to:
  /// **'Cerrar'**
  String get camClose;

  /// No description provided for @camShutter.
  ///
  /// In es, this message translates to:
  /// **'Tomar foto'**
  String get camShutter;

  /// No description provided for @camErrorTitle.
  ///
  /// In es, this message translates to:
  /// **'No se pudo abrir la cámara'**
  String get camErrorTitle;

  /// No description provided for @camErrorPermissionHint.
  ///
  /// In es, this message translates to:
  /// **'El permiso de cámara está denegado. Actívalo en los Ajustes del sistema y vuelve a intentar.'**
  String get camErrorPermissionHint;

  /// No description provided for @langSpanish.
  ///
  /// In es, this message translates to:
  /// **'Español'**
  String get langSpanish;

  /// No description provided for @langEnglish.
  ///
  /// In es, this message translates to:
  /// **'English'**
  String get langEnglish;

  /// No description provided for @metricsTitle.
  ///
  /// In es, this message translates to:
  /// **'Métricas del vehículo'**
  String get metricsTitle;

  /// No description provided for @metricsOdometer.
  ///
  /// In es, this message translates to:
  /// **'Odómetro'**
  String get metricsOdometer;

  /// No description provided for @metricsOdometerUnit.
  ///
  /// In es, this message translates to:
  /// **'mi'**
  String get metricsOdometerUnit;

  /// No description provided for @metricsPrevReading.
  ///
  /// In es, this message translates to:
  /// **'Última lectura registrada: {value} mi'**
  String metricsPrevReading(String value);

  /// No description provided for @metricsOdometerLower.
  ///
  /// In es, this message translates to:
  /// **'La lectura es menor que la última registrada. Revísala — se enviará tal cual.'**
  String get metricsOdometerLower;

  /// No description provided for @metricsFuel.
  ///
  /// In es, this message translates to:
  /// **'Combustible'**
  String get metricsFuel;

  /// No description provided for @fuelEmpty.
  ///
  /// In es, this message translates to:
  /// **'Vacío'**
  String get fuelEmpty;

  /// No description provided for @fuelFull.
  ///
  /// In es, this message translates to:
  /// **'Lleno'**
  String get fuelFull;

  /// No description provided for @metricsCleanliness.
  ///
  /// In es, this message translates to:
  /// **'Limpieza'**
  String get metricsCleanliness;

  /// No description provided for @cleanDirty.
  ///
  /// In es, this message translates to:
  /// **'Sucio'**
  String get cleanDirty;

  /// No description provided for @cleanSpotless.
  ///
  /// In es, this message translates to:
  /// **'Impecable'**
  String get cleanSpotless;

  /// No description provided for @metricsNotes.
  ///
  /// In es, this message translates to:
  /// **'Notas (opcional)'**
  String get metricsNotes;

  /// No description provided for @inspContinueSignature.
  ///
  /// In es, this message translates to:
  /// **'Continuar a firma'**
  String get inspContinueSignature;

  /// No description provided for @kioskBarLabel.
  ///
  /// In es, this message translates to:
  /// **'Modo firma · bloqueo en pausa'**
  String get kioskBarLabel;

  /// No description provided for @kioskBarExit.
  ///
  /// In es, this message translates to:
  /// **'Salir: mantener 3 s + PIN'**
  String get kioskBarExit;

  /// No description provided for @kioskExitPinTitle.
  ///
  /// In es, this message translates to:
  /// **'Salir del modo firma'**
  String get kioskExitPinTitle;

  /// No description provided for @kioskExitPinBody.
  ///
  /// In es, this message translates to:
  /// **'Escribe tu PIN para volver al modo staff.'**
  String get kioskExitPinBody;

  /// No description provided for @kioskExitWrongPin.
  ///
  /// In es, this message translates to:
  /// **'{count, plural, one{PIN incorrecto — te queda 1 intento} other{PIN incorrecto — te quedan {count} intentos}}'**
  String kioskExitWrongPin(int count);

  /// No description provided for @kioskExitExhausted.
  ///
  /// In es, this message translates to:
  /// **'Demasiados intentos. Volviendo al paso anterior.'**
  String get kioskExitExhausted;

  /// No description provided for @kioskSignSubtitle.
  ///
  /// In es, this message translates to:
  /// **'Inspección del vehículo · Reserva {reservation}'**
  String kioskSignSubtitle(String reservation);

  /// No description provided for @kioskSignPrompt.
  ///
  /// In es, this message translates to:
  /// **'Firme para confirmar que revisó el estado del vehículo junto al agente.'**
  String get kioskSignPrompt;

  /// No description provided for @kioskSignHint.
  ///
  /// In es, this message translates to:
  /// **'Firme aquí con el dedo'**
  String get kioskSignHint;

  /// No description provided for @kioskSignClear.
  ///
  /// In es, this message translates to:
  /// **'Borrar'**
  String get kioskSignClear;

  /// No description provided for @kioskSignConfirm.
  ///
  /// In es, this message translates to:
  /// **'Confirmar firma'**
  String get kioskSignConfirm;

  /// No description provided for @summaryQueueTitle.
  ///
  /// In es, this message translates to:
  /// **'{photos} fotos · métricas · firma'**
  String summaryQueueTitle(int photos);

  /// No description provided for @summaryQueueBadgeOffline.
  ///
  /// In es, this message translates to:
  /// **'Se enviará al reconectar'**
  String get summaryQueueBadgeOffline;

  /// No description provided for @summaryQueueBadgeOnline.
  ///
  /// In es, this message translates to:
  /// **'Listo para enviar'**
  String get summaryQueueBadgeOnline;

  /// No description provided for @summaryQueueMeta.
  ///
  /// In es, this message translates to:
  /// **'Guardado local cifrado · orden de envío garantizado'**
  String get summaryQueueMeta;

  /// No description provided for @inspFinishOffline.
  ///
  /// In es, this message translates to:
  /// **'Terminar — se enviará al reconectar'**
  String get inspFinishOffline;

  /// No description provided for @inspFinishOnline.
  ///
  /// In es, this message translates to:
  /// **'Terminar y enviar'**
  String get inspFinishOnline;

  /// No description provided for @inspFinishQueued.
  ///
  /// In es, this message translates to:
  /// **'Inspección en la bandeja de salida'**
  String get inspFinishQueued;

  /// No description provided for @alreadyCompletedTitle.
  ///
  /// In es, this message translates to:
  /// **'Esta inspección ya se completó'**
  String get alreadyCompletedTitle;

  /// No description provided for @alreadyCompletedBody.
  ///
  /// In es, this message translates to:
  /// **'Otra pantalla la cerró mientras trabajabas. Tus envíos pendientes de esta sesión se retiraron de la bandeja — no se enviará nada duplicado.'**
  String get alreadyCompletedBody;

  /// No description provided for @alreadyCompletedBodyAt.
  ///
  /// In es, this message translates to:
  /// **'Otra pantalla la cerró a las {time} mientras trabajabas. Tus envíos pendientes de esta sesión se retiraron de la bandeja — no se enviará nada duplicado.'**
  String alreadyCompletedBodyAt(String time);

  /// No description provided for @alreadyCompletedChip.
  ///
  /// In es, this message translates to:
  /// **'Reserva {reservation}'**
  String alreadyCompletedChip(String reservation);

  /// No description provided for @backToHome.
  ///
  /// In es, this message translates to:
  /// **'Volver al inicio'**
  String get backToHome;

  /// No description provided for @outboxTitle.
  ///
  /// In es, this message translates to:
  /// **'Bandeja de salida'**
  String get outboxTitle;

  /// No description provided for @outboxDraining.
  ///
  /// In es, this message translates to:
  /// **'Enviando…'**
  String get outboxDraining;

  /// No description provided for @outboxDrainProgress.
  ///
  /// In es, this message translates to:
  /// **'{done} de {total} enviados'**
  String outboxDrainProgress(int done, int total);

  /// No description provided for @outboxDrainRemaining.
  ///
  /// In es, this message translates to:
  /// **'quedan ~{size}'**
  String outboxDrainRemaining(String size);

  /// No description provided for @outboxItemPhoto.
  ///
  /// In es, this message translates to:
  /// **'Foto · {angle}'**
  String outboxItemPhoto(String angle);

  /// No description provided for @outboxItemComplete.
  ///
  /// In es, this message translates to:
  /// **'Cierre de inspección'**
  String get outboxItemComplete;

  /// No description provided for @outboxItemMetaPhoto.
  ///
  /// In es, this message translates to:
  /// **'{reservation} · inspección de salida · {size}'**
  String outboxItemMetaPhoto(String reservation, String size);

  /// No description provided for @outboxItemMetaComplete.
  ///
  /// In es, this message translates to:
  /// **'{reservation} · métricas + firma · va al final de su cadena'**
  String outboxItemMetaComplete(String reservation);

  /// No description provided for @outboxStatusQueued.
  ///
  /// In es, this message translates to:
  /// **'En cola'**
  String get outboxStatusQueued;

  /// No description provided for @outboxStatusUploading.
  ///
  /// In es, this message translates to:
  /// **'Subiendo'**
  String get outboxStatusUploading;

  /// No description provided for @outboxStatusWaitsPhotos.
  ///
  /// In es, this message translates to:
  /// **'Espera sus fotos'**
  String get outboxStatusWaitsPhotos;

  /// No description provided for @outboxStatusRejected.
  ///
  /// In es, this message translates to:
  /// **'Rechazado'**
  String get outboxStatusRejected;

  /// No description provided for @outboxAttempts.
  ///
  /// In es, this message translates to:
  /// **'intentado {count} veces · último {time}'**
  String outboxAttempts(int count, String time);

  /// No description provided for @outboxReasonAnglesMissing.
  ///
  /// In es, this message translates to:
  /// **'El servidor lo rechazó: faltan los ángulos frontal y trasero. Captúralos y reintenta.'**
  String get outboxReasonAnglesMissing;

  /// No description provided for @outboxReasonToken.
  ///
  /// In es, this message translates to:
  /// **'El permiso para subir venció o se consumió. Reintentar pedirá uno nuevo con tu sesión.'**
  String get outboxReasonToken;

  /// No description provided for @outboxReasonPhotoLost.
  ///
  /// In es, this message translates to:
  /// **'La foto ya no está en este teléfono. Solo puedes descartar este envío.'**
  String get outboxReasonPhotoLost;

  /// No description provided for @outboxReasonSessionGone.
  ///
  /// In es, this message translates to:
  /// **'La sesión de checkout ya no existe en el servidor.'**
  String get outboxReasonSessionGone;

  /// No description provided for @outboxReasonNetwork.
  ///
  /// In es, this message translates to:
  /// **'No se pudo enviar tras varios intentos. Reintenta cuando haya señal.'**
  String get outboxReasonNetwork;

  /// No description provided for @outboxReasonGeneric.
  ///
  /// In es, this message translates to:
  /// **'El servidor rechazó este envío.'**
  String get outboxReasonGeneric;

  /// No description provided for @outboxTechnicalDetail.
  ///
  /// In es, this message translates to:
  /// **'Detalle técnico: {code} · {message}'**
  String outboxTechnicalDetail(String code, String message);

  /// No description provided for @outboxActionOpenInspection.
  ///
  /// In es, this message translates to:
  /// **'Abrir inspección'**
  String get outboxActionOpenInspection;

  /// No description provided for @outboxActionDiscard.
  ///
  /// In es, this message translates to:
  /// **'Descartar'**
  String get outboxActionDiscard;

  /// No description provided for @outboxDeadBanner.
  ///
  /// In es, this message translates to:
  /// **'{count, plural, one{1 envío necesita tu decisión. El resto seguirá enviándose normal.} other{{count} envíos necesitan tu decisión. El resto seguirá enviándose normal.}}'**
  String outboxDeadBanner(int count);

  /// No description provided for @outboxDiscardTitle.
  ///
  /// In es, this message translates to:
  /// **'¿Descartar este envío?'**
  String get outboxDiscardTitle;

  /// No description provided for @outboxDiscardBodyPhoto.
  ///
  /// In es, this message translates to:
  /// **'Se borrará la foto ({angle}) de {reservation} de este teléfono. Habrá que capturarla de nuevo. Lo ya enviado al servidor no se toca.'**
  String outboxDiscardBodyPhoto(String angle, String reservation);

  /// No description provided for @outboxDiscardBodyComplete.
  ///
  /// In es, this message translates to:
  /// **'Se borrará el cierre de inspección de {reservation} de este teléfono. Las métricas y la firma capturadas se perderán y habrá que repetirlas. Las fotos ya enviadas al servidor no se tocan.'**
  String outboxDiscardBodyComplete(String reservation);

  /// No description provided for @outboxDiscardConfirm.
  ///
  /// In es, this message translates to:
  /// **'Sí, descartar'**
  String get outboxDiscardConfirm;

  /// No description provided for @outboxDiscardKeep.
  ///
  /// In es, this message translates to:
  /// **'Conservar en la bandeja'**
  String get outboxDiscardKeep;

  /// No description provided for @outboxEmptyTitle.
  ///
  /// In es, this message translates to:
  /// **'Todo enviado'**
  String get outboxEmptyTitle;

  /// No description provided for @outboxEmptyBody.
  ///
  /// In es, this message translates to:
  /// **'No hay nada esperando. Lo que captures sin señal aparecerá aquí y se enviará solo.'**
  String get outboxEmptyBody;

  /// No description provided for @outboxLastDrain.
  ///
  /// In es, this message translates to:
  /// **'Último envío: {time}'**
  String outboxLastDrain(String time);

  /// No description provided for @outboxFullTitle.
  ///
  /// In es, this message translates to:
  /// **'La bandeja está llena'**
  String get outboxFullTitle;

  /// No description provided for @outboxFullBody.
  ///
  /// In es, this message translates to:
  /// **'{count} envíos esperando (límite del teléfono). No cabe más — conéctate a una red para que se vacíe y puedas seguir capturando.'**
  String outboxFullBody(int count);

  /// No description provided for @outboxFullChip.
  ///
  /// In es, this message translates to:
  /// **'{count} de {max} · ~{size} en espera'**
  String outboxFullChip(int count, int max, String size);

  /// No description provided for @outboxFullCapturesPaused.
  ///
  /// In es, this message translates to:
  /// **'Las capturas nuevas están pausadas hasta liberar espacio.'**
  String get outboxFullCapturesPaused;

  /// No description provided for @outboxSendNow.
  ///
  /// In es, this message translates to:
  /// **'Enviar ahora'**
  String get outboxSendNow;

  /// No description provided for @outboxSendNowNoNetwork.
  ///
  /// In es, this message translates to:
  /// **'Enviar ahora (sin red)'**
  String get outboxSendNowNoNetwork;

  /// No description provided for @logoutPendingTitle.
  ///
  /// In es, this message translates to:
  /// **'¿Cerrar sesión?'**
  String get logoutPendingTitle;

  /// No description provided for @logoutPendingBody.
  ///
  /// In es, this message translates to:
  /// **'{count, plural, one{Tienes 1 envío sin mandar; si cierras sesión se borra de este teléfono.} other{Tienes {count} envíos sin mandar; si cierras sesión se borran de este teléfono.}}'**
  String logoutPendingBody(int count);

  /// No description provided for @logoutAnyway.
  ///
  /// In es, this message translates to:
  /// **'Cerrar sesión de todos modos'**
  String get logoutAnyway;
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['en', 'es'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'en':
      return AppLocalizationsEn();
    case 'es':
      return AppLocalizationsEs();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
