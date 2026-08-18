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

  /// Edad en SEGUNDOS — la necesita el wizard de checkout (M2-H1): el chip de presencia y el banner de avance ajeno miden en segundos, donde 'un momento' mentiría sobre la frescura del heartbeat (TTL 45 s).
  ///
  /// In es, this message translates to:
  /// **'{count} s'**
  String ageSeconds(int count);

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

  /// Card tocable de la cola de salidas (M2-H7). GD MC-2: {details} = nombre · hora del chip · meta — TalkBack no puede perder la hora ni el estado de pre-checkin
  ///
  /// In es, this message translates to:
  /// **'{details}: abrir el checkout'**
  String cardOpenCheckoutSemantics(String details);

  /// No description provided for @cardOpeningCheckoutChip.
  ///
  /// In es, this message translates to:
  /// **'Abriendo…'**
  String get cardOpeningCheckoutChip;

  /// No description provided for @cardOpeningCheckoutMeta.
  ///
  /// In es, this message translates to:
  /// **'abriendo checkout…'**
  String get cardOpeningCheckoutMeta;

  /// Frame 11A: la card en marcha. El estado se anuncia en la propia card, no en una pantalla nueva.
  ///
  /// In es, this message translates to:
  /// **'{details}: abriendo el checkout'**
  String cardOpeningCheckoutSemantics(String details);

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

  /// Título del wizbar del wizard de checkout (mockup 8A)
  ///
  /// In es, this message translates to:
  /// **'Checkout · {reservation}'**
  String coTitle(String reservation);

  /// No description provided for @coTitleNoNumber.
  ///
  /// In es, this message translates to:
  /// **'Checkout'**
  String get coTitleNoNumber;

  /// No description provided for @coPause.
  ///
  /// In es, this message translates to:
  /// **'Pausar'**
  String get coPause;

  /// Contador honesto del mockup (nota 4): la cadena lineal CONFIRMING→CLOSED son 10 pasos; CANCELLED es salida alterna, no el paso 11.
  ///
  /// In es, this message translates to:
  /// **'Paso {index} de {total}'**
  String coStepOf(int index, int total);

  /// No description provided for @coSeeAllSteps.
  ///
  /// In es, this message translates to:
  /// **'Ver todos los pasos'**
  String get coSeeAllSteps;

  /// No description provided for @coStepsSheetTitle.
  ///
  /// In es, this message translates to:
  /// **'{total} pasos + salida alterna'**
  String coStepsSheetTitle(int total);

  /// No description provided for @coStepsSheetSub.
  ///
  /// In es, this message translates to:
  /// **'Estado reportado por el servidor · actualizado hace {age}'**
  String coStepsSheetSub(String age);

  /// No description provided for @coSheetClose.
  ///
  /// In es, this message translates to:
  /// **'Cerrar'**
  String get coSheetClose;

  /// No description provided for @coPhaseConfirm.
  ///
  /// In es, this message translates to:
  /// **'Confirmar'**
  String get coPhaseConfirm;

  /// No description provided for @coPhaseTerms.
  ///
  /// In es, this message translates to:
  /// **'T&C'**
  String get coPhaseTerms;

  /// No description provided for @coPhasePayment.
  ///
  /// In es, this message translates to:
  /// **'Pago'**
  String get coPhasePayment;

  /// No description provided for @coPhaseInspection.
  ///
  /// In es, this message translates to:
  /// **'Inspección'**
  String get coPhaseInspection;

  /// No description provided for @coPhaseClosing.
  ///
  /// In es, this message translates to:
  /// **'Cierre'**
  String get coPhaseClosing;

  /// No description provided for @coStepConfirming.
  ///
  /// In es, this message translates to:
  /// **'Confirmar cliente y vehículo'**
  String get coStepConfirming;

  /// No description provided for @coStepTcPending.
  ///
  /// In es, this message translates to:
  /// **'Términos y condiciones'**
  String get coStepTcPending;

  /// No description provided for @coStepTcSigned.
  ///
  /// In es, this message translates to:
  /// **'Términos firmados'**
  String get coStepTcSigned;

  /// No description provided for @coStepPaymentPending.
  ///
  /// In es, this message translates to:
  /// **'Cobro en terminal'**
  String get coStepPaymentPending;

  /// No description provided for @coStepPaid.
  ///
  /// In es, this message translates to:
  /// **'Pago completo'**
  String get coStepPaid;

  /// No description provided for @coStepInspectionHandoff.
  ///
  /// In es, this message translates to:
  /// **'Pasar a inspección'**
  String get coStepInspectionHandoff;

  /// No description provided for @coStepInspectionInProgress.
  ///
  /// In es, this message translates to:
  /// **'Inspección en curso'**
  String get coStepInspectionInProgress;

  /// No description provided for @coStepCustomerSignPending.
  ///
  /// In es, this message translates to:
  /// **'Firma del cliente'**
  String get coStepCustomerSignPending;

  /// No description provided for @coStepFinalizing.
  ///
  /// In es, this message translates to:
  /// **'Generando contrato'**
  String get coStepFinalizing;

  /// No description provided for @coStepClosed.
  ///
  /// In es, this message translates to:
  /// **'Entregado'**
  String get coStepClosed;

  /// No description provided for @coStepCancelled.
  ///
  /// In es, this message translates to:
  /// **'Cancelado'**
  String get coStepCancelled;

  /// No description provided for @coStepCancelledHint.
  ///
  /// In es, this message translates to:
  /// **'Salida alterna desde cualquier paso no terminal'**
  String get coStepCancelledHint;

  /// Forward-compat (ADR-4): un currentStep que esta versión de la app no conoce se muestra CRUDO, sin corregirlo ni adivinar el siguiente.
  ///
  /// In es, this message translates to:
  /// **'Paso reportado por el servidor: {step}'**
  String coStepUnknown(String step);

  /// No description provided for @coStepPending.
  ///
  /// In es, this message translates to:
  /// **'Pendiente'**
  String get coStepPending;

  /// No description provided for @coStepInProgress.
  ///
  /// In es, this message translates to:
  /// **'En curso'**
  String get coStepInProgress;

  /// No description provided for @coStepDoneByYou.
  ///
  /// In es, this message translates to:
  /// **'Completado por ti · {time}'**
  String coStepDoneByYou(String time);

  /// No description provided for @coStepDoneKiosk.
  ///
  /// In es, this message translates to:
  /// **'Completado en el kiosco · {time}'**
  String coStepDoneKiosk(String time);

  /// No description provided for @coStepDoneOtherAgent.
  ///
  /// In es, this message translates to:
  /// **'Completado por otro agente · {time}'**
  String coStepDoneOtherAgent(String time);

  /// No description provided for @coStepDone.
  ///
  /// In es, this message translates to:
  /// **'Completado · {time}'**
  String coStepDone(String time);

  /// No description provided for @coGuardTcCompleted.
  ///
  /// In es, this message translates to:
  /// **'Espera: firma de T&C del cliente'**
  String get coGuardTcCompleted;

  /// No description provided for @coGuardPayment.
  ///
  /// In es, this message translates to:
  /// **'Espera: cobro registrado'**
  String get coGuardPayment;

  /// No description provided for @coGuardInspection.
  ///
  /// In es, this message translates to:
  /// **'Espera: inspección completa'**
  String get coGuardInspection;

  /// No description provided for @coGuardSignature.
  ///
  /// In es, this message translates to:
  /// **'Espera: firma del cliente'**
  String get coGuardSignature;

  /// No description provided for @coSurfaceKiosk.
  ///
  /// In es, this message translates to:
  /// **'kiosco'**
  String get coSurfaceKiosk;

  /// No description provided for @coSurfaceCounter.
  ///
  /// In es, this message translates to:
  /// **'mostrador'**
  String get coSurfaceCounter;

  /// No description provided for @coSurfaceRideops.
  ///
  /// In es, this message translates to:
  /// **'otro teléfono'**
  String get coSurfaceRideops;

  /// No description provided for @coSurfaceCustomer.
  ///
  /// In es, this message translates to:
  /// **'teléfono del cliente'**
  String get coSurfaceCustomer;

  /// No description provided for @coSurfaceOther.
  ///
  /// In es, this message translates to:
  /// **'otra superficie'**
  String get coSurfaceOther;

  /// Chip de presencia (P1). Informativo, jamás un candado.
  ///
  /// In es, this message translates to:
  /// **'{name} está en esta sesión · {surface} · hace {age}'**
  String coPresenceLine(String name, String surface, String age);

  /// No description provided for @coPresenceMore.
  ///
  /// In es, this message translates to:
  /// **'+{count}'**
  String coPresenceMore(int count);

  /// No description provided for @coAdvancedKiosk.
  ///
  /// In es, this message translates to:
  /// **'«{step}» se completó en el kiosco hace {age}.'**
  String coAdvancedKiosk(String step, String age);

  /// No description provided for @coAdvancedOtherAgent.
  ///
  /// In es, this message translates to:
  /// **'«{step}» lo completó otro agente hace {age}.'**
  String coAdvancedOtherAgent(String step, String age);

  /// No description provided for @coAdvancedOtherSurface.
  ///
  /// In es, this message translates to:
  /// **'«{step}» se completó en otra superficie hace {age}.'**
  String coAdvancedOtherSurface(String step, String age);

  /// No description provided for @coAdvancedNow.
  ///
  /// In es, this message translates to:
  /// **'Ya vas en: {step}.'**
  String coAdvancedNow(String step);

  /// No description provided for @coAdvancedSeeChanged.
  ///
  /// In es, this message translates to:
  /// **'Ver qué cambió'**
  String get coAdvancedSeeChanged;

  /// No description provided for @coStaleView.
  ///
  /// In es, this message translates to:
  /// **'vista de hace {age}'**
  String coStaleView(String age);

  /// No description provided for @coOfflineBanner.
  ///
  /// In es, this message translates to:
  /// **'Sin conexión. Esto es lo último que vio el servidor hace {age} — puede haber cambiado en otra superficie.'**
  String coOfflineBanner(String age);

  /// No description provided for @coBlockedOfflineWhy.
  ///
  /// In es, this message translates to:
  /// **'Avanzar un paso requiere confirmación del servidor. Sin red no se adivina: se espera.\nNada de este paso entra a la Bandeja de salida.'**
  String get coBlockedOfflineWhy;

  /// No description provided for @coBlockedOfflineShort.
  ///
  /// In es, this message translates to:
  /// **'Sin conexión: el avance lo confirma el servidor.'**
  String get coBlockedOfflineShort;

  /// No description provided for @coTransitionWhy.
  ///
  /// In es, this message translates to:
  /// **'El servidor confirma el avance; si otra superficie ya lo hizo, esta pantalla se actualiza sola.'**
  String get coTransitionWhy;

  /// No description provided for @coPauseTitle.
  ///
  /// In es, this message translates to:
  /// **'¿Guardar y pausar este checkout?'**
  String get coPauseTitle;

  /// No description provided for @coPauseSub.
  ///
  /// In es, this message translates to:
  /// **'La sesión queda guardada en el paso {index} de {total}. Nada se pierde.'**
  String coPauseSub(int index, int total);

  /// No description provided for @coPauseSubUnknownStep.
  ///
  /// In es, this message translates to:
  /// **'La sesión queda guardada en el paso que reporta el servidor. Nada se pierde.'**
  String get coPauseSubUnknownStep;

  /// No description provided for @coPauseKeeps.
  ///
  /// In es, this message translates to:
  /// **'Se conserva: cliente y vehículo verificados, el código de T&C vigente y el registro de quién hizo qué.'**
  String get coPauseKeeps;

  /// No description provided for @coPauseWarn.
  ///
  /// In es, this message translates to:
  /// **'Otro compañero (o el kiosco) puede retomarla desde donde va. Al volver, entras al paso que reporte el servidor, no al que dejaste.'**
  String get coPauseWarn;

  /// No description provided for @coPauseConfirm.
  ///
  /// In es, this message translates to:
  /// **'Guardar y pausar'**
  String get coPauseConfirm;

  /// No description provided for @coPauseStay.
  ///
  /// In es, this message translates to:
  /// **'Seguir aquí'**
  String get coPauseStay;

  /// No description provided for @coPauseFailed.
  ///
  /// In es, this message translates to:
  /// **'No se pudo pausar. Revisa la conexión e intenta de nuevo.'**
  String get coPauseFailed;

  /// No description provided for @coTerminalClosedTitle.
  ///
  /// In es, this message translates to:
  /// **'Este checkout ya se cerró'**
  String get coTerminalClosedTitle;

  /// No description provided for @coTerminalCancelledTitle.
  ///
  /// In es, this message translates to:
  /// **'Este checkout se canceló'**
  String get coTerminalCancelledTitle;

  /// No description provided for @coTerminalBody.
  ///
  /// In es, this message translates to:
  /// **'Esta sesión ya es terminal: no admite más pasos.'**
  String get coTerminalBody;

  /// Frame 11E: el 409 SESSION_TERMINAL no es un error, es una noticia — dice dónde y cuándo terminó
  ///
  /// In es, this message translates to:
  /// **'Se completó en el kiosco a las {time}. No hay nada más que hacer aquí.'**
  String coTerminalDoneKiosk(String time);

  /// No description provided for @coTerminalDoneByYou.
  ///
  /// In es, this message translates to:
  /// **'Lo cerraste tú a las {time}. No hay nada más que hacer aquí.'**
  String coTerminalDoneByYou(String time);

  /// No description provided for @coTerminalDoneOtherAgent.
  ///
  /// In es, this message translates to:
  /// **'Lo cerró otro agente a las {time}. No hay nada más que hacer aquí.'**
  String coTerminalDoneOtherAgent(String time);

  /// No description provided for @coTerminalDoneAt.
  ///
  /// In es, this message translates to:
  /// **'Se completó a las {time}. No hay nada más que hacer aquí.'**
  String coTerminalDoneAt(String time);

  /// No description provided for @coTerminalCancelledByYou.
  ///
  /// In es, this message translates to:
  /// **'Lo cancelaste tú a las {time}. Esta sesión ya no admite pasos.'**
  String coTerminalCancelledByYou(String time);

  /// No description provided for @coTerminalCancelledKiosk.
  ///
  /// In es, this message translates to:
  /// **'Se canceló en el kiosco a las {time}. Esta sesión ya no admite pasos.'**
  String coTerminalCancelledKiosk(String time);

  /// No description provided for @coTerminalCancelledOtherAgent.
  ///
  /// In es, this message translates to:
  /// **'Lo canceló otro agente a las {time}. Esta sesión ya no admite pasos.'**
  String coTerminalCancelledOtherAgent(String time);

  /// No description provided for @coTerminalCancelledAt.
  ///
  /// In es, this message translates to:
  /// **'Se canceló a las {time}. Esta sesión ya no admite pasos.'**
  String coTerminalCancelledAt(String time);

  /// Solo con autoEmailedAt sellado. Dice «se pidió», NUNCA «salió»: el backend estampa el sello ANTES de disparar el envío (checkout-session.service.js:597-612) y el envío es fire-and-forget — un SMTP caído deja el sello puesto igual. Afirmar la entrega sería mentirle al agente que se lo va a decir al cliente.
  ///
  /// In es, this message translates to:
  /// **'Se pidió el envío del contrato al correo del cliente a las {time}.'**
  String coTerminalContractRequested(String time);

  /// No description provided for @coTerminalByYou.
  ///
  /// In es, this message translates to:
  /// **'Tú'**
  String get coTerminalByYou;

  /// No description provided for @coTerminalByKiosk.
  ///
  /// In es, this message translates to:
  /// **'En el kiosco'**
  String get coTerminalByKiosk;

  /// No description provided for @coTerminalByOtherAgent.
  ///
  /// In es, this message translates to:
  /// **'Otro agente'**
  String get coTerminalByOtherAgent;

  /// No description provided for @coTerminalByOtherSurface.
  ///
  /// In es, this message translates to:
  /// **'Otra superficie'**
  String get coTerminalByOtherSurface;

  /// No description provided for @coTerminalBackToList.
  ///
  /// In es, this message translates to:
  /// **'Volver a la lista'**
  String get coTerminalBackToList;

  /// No description provided for @coTerminalWhy.
  ///
  /// In es, this message translates to:
  /// **'Si crees que se cerró por error, abre la reserva: desde aquí no se puede reabrir.'**
  String get coTerminalWhy;

  /// No description provided for @coTerminalLogTitle.
  ///
  /// In es, this message translates to:
  /// **'Registro de la sesión'**
  String get coTerminalLogTitle;

  /// No description provided for @coExit.
  ///
  /// In es, this message translates to:
  /// **'Salir'**
  String get coExit;

  /// No description provided for @coNoSessionTitle.
  ///
  /// In es, this message translates to:
  /// **'Aún no hay sesión de checkout'**
  String get coNoSessionTitle;

  /// No description provided for @coNoSessionBody.
  ///
  /// In es, this message translates to:
  /// **'Esta reserva todavía no tiene una sesión abierta. Se inicia desde la cola de salidas del inicio.'**
  String get coNoSessionBody;

  /// No description provided for @coLoadFailedTitle.
  ///
  /// In es, this message translates to:
  /// **'No se pudo abrir el checkout'**
  String get coLoadFailedTitle;

  /// No description provided for @coConflictEntryGuardTitle.
  ///
  /// In es, this message translates to:
  /// **'Falta un paso previo'**
  String get coConflictEntryGuardTitle;

  /// No description provided for @coConflictVehicleTitle.
  ///
  /// In es, this message translates to:
  /// **'El vehículo ya no está libre'**
  String get coConflictVehicleTitle;

  /// No description provided for @coConflictGenericTitle.
  ///
  /// In es, this message translates to:
  /// **'El servidor no aceptó el avance'**
  String get coConflictGenericTitle;

  /// No description provided for @coConflictSwapTitle.
  ///
  /// In es, this message translates to:
  /// **'El servidor no aceptó el cambio de unidad'**
  String get coConflictSwapTitle;

  /// No description provided for @coConflictDismiss.
  ///
  /// In es, this message translates to:
  /// **'Entendido'**
  String get coConflictDismiss;

  /// Tercera respuesta del patio en el header de sesión (8A): para cuándo
  ///
  /// In es, this message translates to:
  /// **'Salida hoy {time}'**
  String coPickupToday(String time);

  /// No description provided for @coPickupOn.
  ///
  /// In es, this message translates to:
  /// **'Salida {date} {time}'**
  String coPickupOn(String date, String time);

  /// No description provided for @coPrecheckinReady.
  ///
  /// In es, this message translates to:
  /// **'Pre-checkin listo'**
  String get coPrecheckinReady;

  /// No description provided for @coPrecheckinPending.
  ///
  /// In es, this message translates to:
  /// **'Pre-checkin pendiente'**
  String get coPrecheckinPending;

  /// No description provided for @coOdometer.
  ///
  /// In es, this message translates to:
  /// **'Odómetro {km} km'**
  String coOdometer(String km);

  /// No description provided for @coExitWithoutPausing.
  ///
  /// In es, this message translates to:
  /// **'Salir sin pausar'**
  String get coExitWithoutPausing;

  /// No description provided for @coExitWithoutPausingWhy.
  ///
  /// In es, this message translates to:
  /// **'Nada se bloquea: la sesión queda como está y el patio puede seguirla desde otra superficie.'**
  String get coExitWithoutPausingWhy;

  /// No description provided for @coPauseNeedsNetwork.
  ///
  /// In es, this message translates to:
  /// **'Pausar necesita conexión: es un aviso que se guarda en el servidor. Sin red puedes salir igual.'**
  String get coPauseNeedsNetwork;

  /// No description provided for @coStampsTitle.
  ///
  /// In es, this message translates to:
  /// **'Lo que el servidor ya tiene'**
  String get coStampsTitle;

  /// No description provided for @coStampTc.
  ///
  /// In es, this message translates to:
  /// **'Firma de T&C'**
  String get coStampTc;

  /// No description provided for @coStampPayment.
  ///
  /// In es, this message translates to:
  /// **'Cobro registrado'**
  String get coStampPayment;

  /// No description provided for @coStampInspection.
  ///
  /// In es, this message translates to:
  /// **'Inspección completa'**
  String get coStampInspection;

  /// No description provided for @coStampSignature.
  ///
  /// In es, this message translates to:
  /// **'Firma del cliente'**
  String get coStampSignature;

  /// No description provided for @coStampDone.
  ///
  /// In es, this message translates to:
  /// **'Listo · {time}'**
  String coStampDone(String time);

  /// No description provided for @coStampPending.
  ///
  /// In es, this message translates to:
  /// **'Pendiente'**
  String get coStampPending;

  /// No description provided for @coSessionAgeLabel.
  ///
  /// In es, this message translates to:
  /// **'Estado de hace {age}'**
  String coSessionAgeLabel(String age);

  /// Frame 11C — 422 NO_VEHICLE_ASSIGNED: sin unidad no hay entrega
  ///
  /// In es, this message translates to:
  /// **'Esta reserva no tiene vehículo asignado'**
  String get coEntryNoVehicleTitle;

  /// No description provided for @coEntryNoVehicleBody.
  ///
  /// In es, this message translates to:
  /// **'Sin unidad no se puede entregar. Asignar el vehículo a la reserva se hace hoy desde el escritorio; en cuanto quede asignado, vuelve a tocar la card.'**
  String get coEntryNoVehicleBody;

  /// Frame 11D — 409 VEHICLE_CONFLICT al CREAR: aquí la sesión NO llegó a existir
  ///
  /// In es, this message translates to:
  /// **'Esa unidad ya está en otra renta'**
  String get coEntryVehicleConflictTitle;

  /// No description provided for @coEntryVehicleConflictBody.
  ///
  /// In es, this message translates to:
  /// **'El servidor lo bloqueó para que la misma unidad no se entregue dos veces. Cambiar el vehículo de la reserva —o cerrar la otra renta— se hace hoy desde el escritorio.'**
  String get coEntryVehicleConflictBody;

  /// No description provided for @coEntryConflictWith.
  ///
  /// In es, this message translates to:
  /// **'Reserva en conflicto: {reservation}'**
  String coEntryConflictWith(String reservation);

  /// Salida real del 11D con lo que la app SÍ puede hacer hoy: buscar la reserva en conflicto (el detalle de reserva llega en M3)
  ///
  /// In es, this message translates to:
  /// **'Buscar {reservation}'**
  String coEntrySearchReservation(String reservation);

  /// Frame 11B — 422 PRECHECKIN_REQUIRED
  ///
  /// In es, this message translates to:
  /// **'Falta el pre-checkin del cliente'**
  String get coEntryPrecheckinTitle;

  /// No description provided for @coEntryPrecheckinBody.
  ///
  /// In es, this message translates to:
  /// **'Esta sucursal exige el pre-checkin del cliente antes de abrir el checkout.'**
  String get coEntryPrecheckinBody;

  /// No description provided for @coEntrySendPrecheckinLink.
  ///
  /// In es, this message translates to:
  /// **'Enviar pre-checkin al cliente'**
  String get coEntrySendPrecheckinLink;

  /// No description provided for @coEntrySendingPrecheckinLink.
  ///
  /// In es, this message translates to:
  /// **'Enviando…'**
  String get coEntrySendingPrecheckinLink;

  /// No description provided for @coEntryPrecheckinLinkSent.
  ///
  /// In es, this message translates to:
  /// **'Listo: el link de pre-checkin salió al correo del cliente. Cuando lo complete, vuelve a tocar la card.'**
  String get coEntryPrecheckinLinkSent;

  /// No description provided for @coEntryPrecheckinLinkFailed.
  ///
  /// In es, this message translates to:
  /// **'No se pudo enviar el link. {reason}'**
  String coEntryPrecheckinLinkFailed(String reason);

  /// 429 de send-request-email = cooldown POR RESERVA (routes:1621), no saturación. El hecho accionable es «ya salió», no «espera a que baje la carga».
  ///
  /// In es, this message translates to:
  /// **'Ese link ya se envió hace un momento: el servidor no manda otro tan seguido. Pídele al cliente que revise su correo (y el spam) antes de reintentar.'**
  String get coEntryPrecheckinLinkCooldown;

  /// 400 «No recipient email found» (routes:1634) — el fallo más probable de esta acción
  ///
  /// In es, this message translates to:
  /// **'La reserva no tiene correo del cliente, así que no hay a dónde mandarlo. Agrégalo desde el escritorio o pide el pre-checkin por teléfono.'**
  String get coEntryPrecheckinNoEmail;

  /// No description provided for @coEntryPrecheckinDeskNote.
  ///
  /// In es, this message translates to:
  /// **'Capturar los datos en el mostrador todavía se hace desde el escritorio: esta app aún no tiene ese formulario.'**
  String get coEntryPrecheckinDeskNote;

  /// No description provided for @coEntryReservationUntouched.
  ///
  /// In es, this message translates to:
  /// **'La reserva no se tocó. En cuanto el pre-checkin quede listo, la card se desbloquea sola.'**
  String get coEntryReservationUntouched;

  /// Frame 11B, variante AGE_RULES_*: la regla la fija la sucursal, así que la salida NO es una acción del agente
  ///
  /// In es, this message translates to:
  /// **'Las reglas de edad no permiten esta entrega'**
  String get coEntryAgeTitle;

  /// No description provided for @coEntryAgeBody.
  ///
  /// In es, this message translates to:
  /// **'La sucursal bloquea esta salida por su política de edad.'**
  String get coEntryAgeBody;

  /// No description provided for @coEntryAgeDeskNote.
  ///
  /// In es, this message translates to:
  /// **'La fecha de nacimiento se corrige en la reserva, desde el escritorio. Si la regla está mal, eso lo cambia tu supervisor en la configuración de la sucursal.'**
  String get coEntryAgeDeskNote;

  /// No description provided for @coEntryScopeChangedTitle.
  ///
  /// In es, this message translates to:
  /// **'Se interrumpió la apertura'**
  String get coEntryScopeChangedTitle;

  /// No description provided for @coEntryScopeChangedBody.
  ///
  /// In es, this message translates to:
  /// **'Cambió tu sede o tu sesión mientras se abría el checkout, así que la respuesta del servidor ya no corresponde a lo que ves.'**
  String get coEntryScopeChangedBody;

  /// No description provided for @coEntryScopeChangedFoot.
  ///
  /// In es, this message translates to:
  /// **'La sesión pudo haberse creado. Vuelve a tocar la card: si existe, se reanuda.'**
  String get coEntryScopeChangedFoot;

  /// No description provided for @coEntryOfflineTitle.
  ///
  /// In es, this message translates to:
  /// **'Sin conexión para abrir el checkout'**
  String get coEntryOfflineTitle;

  /// No description provided for @coEntryOfflineBody.
  ///
  /// In es, this message translates to:
  /// **'Abrir un checkout necesita la confirmación del servidor una sola vez. No se encola en la Bandeja: cuando haya señal, vuelve a tocar la card.'**
  String get coEntryOfflineBody;

  /// La petición SALIÓ del aparato y no volvió respuesta (timeout / socket caído). Distinto del corte sin señal: aquí el servidor pudo procesarla entera
  ///
  /// In es, this message translates to:
  /// **'Se cortó la conexión al abrir'**
  String get coEntryConnectionLostTitle;

  /// No description provided for @coEntryConnectionLostBody.
  ///
  /// In es, this message translates to:
  /// **'La solicitud salió del teléfono pero el servidor no alcanzó a responder, así que la app no puede saber si el checkout quedó abierto.'**
  String get coEntryConnectionLostBody;

  /// No description provided for @coEntryConnectionLostFoot.
  ///
  /// In es, this message translates to:
  /// **'La sesión pudo haberse creado. Cuando haya señal, vuelve a tocar la card: si existe, se reanuda.'**
  String get coEntryConnectionLostFoot;

  /// No description provided for @coEntryNotReadyTitle.
  ///
  /// In es, this message translates to:
  /// **'Un momento'**
  String get coEntryNotReadyTitle;

  /// No description provided for @coEntryNotReadyBody.
  ///
  /// In es, this message translates to:
  /// **'La app todavía está cargando tu ubicación activa. Intenta de nuevo en un segundo.'**
  String get coEntryNotReadyBody;

  /// No description provided for @coEntryNoSessionCreated.
  ///
  /// In es, this message translates to:
  /// **'No se creó ninguna sesión de checkout.'**
  String get coEntryNoSessionCreated;

  /// El texto del backend se muestra tal cual (DoD #5) junto al copy localizado: trae los datos concretos (la regla de edad exacta, el número de la otra reserva)
  ///
  /// In es, this message translates to:
  /// **'El servidor respondió: {message}'**
  String coEntryServerSaid(String message);

  /// No description provided for @coEntryClose.
  ///
  /// In es, this message translates to:
  /// **'Cerrar'**
  String get coEntryClose;

  /// No description provided for @coConfirmCustomer.
  ///
  /// In es, this message translates to:
  /// **'Cliente'**
  String get coConfirmCustomer;

  /// No description provided for @coConfirmVehicle.
  ///
  /// In es, this message translates to:
  /// **'Vehículo'**
  String get coConfirmVehicle;

  /// No description provided for @coConfirmVerified.
  ///
  /// In es, this message translates to:
  /// **'Verificado'**
  String get coConfirmVerified;

  /// No description provided for @coConfirmMissingPill.
  ///
  /// In es, this message translates to:
  /// **'Faltan datos'**
  String get coConfirmMissingPill;

  /// No description provided for @coConfirmConflictPill.
  ///
  /// In es, this message translates to:
  /// **'En conflicto'**
  String get coConfirmConflictPill;

  /// No description provided for @coConfirmName.
  ///
  /// In es, this message translates to:
  /// **'Nombre'**
  String get coConfirmName;

  /// No description provided for @coConfirmLicense.
  ///
  /// In es, this message translates to:
  /// **'Licencia'**
  String get coConfirmLicense;

  /// El vencimiento sale del snapshot del contrato: el modelo Customer no tiene esa columna.
  ///
  /// In es, this message translates to:
  /// **'{number} · vence {date}'**
  String coConfirmLicenseWithExpiry(String number, String date);

  /// No description provided for @coConfirmPhone.
  ///
  /// In es, this message translates to:
  /// **'Teléfono'**
  String get coConfirmPhone;

  /// No description provided for @coConfirmPrecheckin.
  ///
  /// In es, this message translates to:
  /// **'Pre-checkin'**
  String get coConfirmPrecheckin;

  /// VALOR de la fila cuya clave ya dice 'Pre-checkin' (review GD-MC-6): con coPrecheckinReady se leía 'Pre-checkin | Pre-checkin listo'. Se usa cuando el servidor sella el pre-checkin pero no llega la hora.
  ///
  /// In es, this message translates to:
  /// **'Completado'**
  String get coConfirmPrecheckinDone;

  /// Caso normal: display-data trae customerInfoCompletedAt, así que la fila dice CUÁNDO, como el mockup 9A.
  ///
  /// In es, this message translates to:
  /// **'Completado {time}'**
  String coConfirmPrecheckinDoneAt(String time);

  /// No description provided for @coConfirmPrecheckinPending.
  ///
  /// In es, this message translates to:
  /// **'Pendiente'**
  String get coConfirmPrecheckinPending;

  /// No description provided for @coConfirmMissingValue.
  ///
  /// In es, this message translates to:
  /// **'Sin capturar'**
  String get coConfirmMissingValue;

  /// No description provided for @coConfirmUnit.
  ///
  /// In es, this message translates to:
  /// **'Unidad'**
  String get coConfirmUnit;

  /// No description provided for @coConfirmOdometerLabel.
  ///
  /// In es, this message translates to:
  /// **'Odómetro'**
  String get coConfirmOdometerLabel;

  /// No description provided for @coOdometerValue.
  ///
  /// In es, this message translates to:
  /// **'{km} km'**
  String coOdometerValue(String km);

  /// No description provided for @coConfirmVehicleAvailable.
  ///
  /// In es, this message translates to:
  /// **'Disponible'**
  String get coConfirmVehicleAvailable;

  /// No description provided for @coConfirmChangeVehicle.
  ///
  /// In es, this message translates to:
  /// **'Cambiar vehículo'**
  String get coConfirmChangeVehicle;

  /// No description provided for @coConfirmCta.
  ///
  /// In es, this message translates to:
  /// **'Continuar a T&C'**
  String get coConfirmCta;

  /// No description provided for @coConfirmFieldName.
  ///
  /// In es, this message translates to:
  /// **'el nombre'**
  String get coConfirmFieldName;

  /// No description provided for @coConfirmFieldLicense.
  ///
  /// In es, this message translates to:
  /// **'la licencia'**
  String get coConfirmFieldLicense;

  /// No description provided for @coConfirmFieldPhone.
  ///
  /// In es, this message translates to:
  /// **'el teléfono'**
  String get coConfirmFieldPhone;

  /// No description provided for @coConfirmFieldJoin.
  ///
  /// In es, this message translates to:
  /// **'y'**
  String get coConfirmFieldJoin;

  /// Bloqueo LOCAL con causa nombrada (9B). El CTA no se esconde: se bloquea diciendo qué falta y dónde se resuelve. RideOps no captura datos del cliente (ADR-1: eso vive en el mostrador web).
  ///
  /// In es, this message translates to:
  /// **'Faltan {fields} del cliente. Se capturan en el mostrador o con el pre-checkin del cliente; esta pantalla se actualiza sola.'**
  String coConfirmBlockedWhy(String fields);

  /// Review GD-MC-5: la etiqueta NOMBRA el objeto. 'Volver a consultar' no decía qué se consulta y chocaba con el why de al lado, que ya promete que la pantalla se actualiza sola.
  ///
  /// In es, this message translates to:
  /// **'Actualizar datos del cliente'**
  String get coConfirmRecheck;

  /// No description provided for @coConfirmRecheckPending.
  ///
  /// In es, this message translates to:
  /// **'Consultando al servidor…'**
  String get coConfirmRecheckPending;

  /// Acuse del re-consultado (GD-MC-5b): el botón disparaba dos peticiones y NO mostraba nada. Reusa la misma lista legible de campos que el bloqueo.
  ///
  /// In es, this message translates to:
  /// **'Consultado ahora: el servidor sigue sin {fields}.'**
  String coConfirmRecheckedStill(String fields);

  /// No description provided for @coDeclineTitle.
  ///
  /// In es, this message translates to:
  /// **'El cliente declina el seguro'**
  String get coDeclineTitle;

  /// No description provided for @coDeclineOff.
  ///
  /// In es, this message translates to:
  /// **'Apagado · se cobra la cobertura estándar'**
  String get coDeclineOff;

  /// No description provided for @coDeclineOn.
  ///
  /// In es, this message translates to:
  /// **'Encendido · se agrega el anexo'**
  String get coDeclineOn;

  /// No description provided for @coDeclineLocked.
  ///
  /// In es, this message translates to:
  /// **'Los términos ya se firmaron: el anexo del seguro ya no cambia aquí'**
  String get coDeclineLocked;

  /// No description provided for @coDeclineNeedsNetwork.
  ///
  /// In es, this message translates to:
  /// **'Sin conexión: esta bandera la registra el servidor'**
  String get coDeclineNeedsNetwork;

  /// No description provided for @coDeclineConsequence.
  ///
  /// In es, this message translates to:
  /// **'Se agregará el anexo de rechazo de cobertura a los términos que firma el cliente y al contrato PDF. Puedes apagarlo mientras no se firmen los términos.'**
  String get coDeclineConsequence;

  /// No description provided for @coDeclineSignedNote.
  ///
  /// In es, this message translates to:
  /// **'El cliente ya firmó los términos con este anexo. Para cambiarlo, el contrato se ajusta desde el mostrador.'**
  String get coDeclineSignedNote;

  /// No description provided for @coConflictSwapCta.
  ///
  /// In es, this message translates to:
  /// **'Elegir otro vehículo'**
  String get coConflictSwapCta;

  /// No description provided for @coConflictSwapWhy.
  ///
  /// In es, this message translates to:
  /// **'Nada se perdió: al cambiar la unidad sigues en el paso 1 con el cliente ya verificado.'**
  String get coConflictSwapWhy;

  /// No description provided for @coSwapTitle.
  ///
  /// In es, this message translates to:
  /// **'Cambiar vehículo'**
  String get coSwapTitle;

  /// El endpoint filtra por tenant y ventana de la reserva, NO por la sede activa: la copy no promete una sede que el servidor no filtró; cada opción muestra la suya.
  ///
  /// In es, this message translates to:
  /// **'Disponibles según el servidor · hace {age}'**
  String coSwapSub(String age);

  /// No description provided for @coSwapSubLoading.
  ///
  /// In es, this message translates to:
  /// **'Preguntando al servidor qué unidades están libres…'**
  String get coSwapSubLoading;

  /// No description provided for @coSwapSameGroup.
  ///
  /// In es, this message translates to:
  /// **'Mismo grupo'**
  String get coSwapSameGroup;

  /// No description provided for @coSwapOtherGroup.
  ///
  /// In es, this message translates to:
  /// **'Otro grupo · puede cambiar la tarifa'**
  String get coSwapOtherGroup;

  /// No description provided for @coSwapCurrentReason.
  ///
  /// In es, this message translates to:
  /// **'Unidad actual · una unidad no se cambia por sí misma'**
  String get coSwapCurrentReason;

  /// Parte de MC-4 que no depende de la lámina: el 'motivo legible' de la unidad inerte era el string EN INGLÉS del servidor metido en un renglón de 12.5 px donde no cabe una cita. La cita del servidor vive en el banner del paso; aquí va copy propia.
  ///
  /// In es, this message translates to:
  /// **'Unidad actual · el servidor la reporta comprometida en otra renta'**
  String get coSwapCurrentCommitted;

  /// 409 SWAP_LOCKED (vehicle-swap.service.js:46-51). Línea de causa TRADUCIDA arriba del cuerpo del servidor — mismo tratamiento que ENTRY_GUARD. Importa especialmente aquí: el mensaje del backend filtra un enum crudo de base de datos (currentStep=INSPECTION_IN_PROGRESS), y el agente no tiene por qué descifrarlo.
  ///
  /// In es, this message translates to:
  /// **'La inspección de esta sesión ya empezó: a partir de ahí la unidad ya no se cambia.'**
  String get coSwapLockedCause;

  /// 409 VEHICLE_DOUBLE_BOOKED (vehicle-swap.service.js:86-91). El cuerpo del servidor sigue visible debajo: trae el número de la reserva que la aparta.
  ///
  /// In es, this message translates to:
  /// **'Esa unidad ya está reservada en esta misma ventana.'**
  String get coSwapDoubleBookedCause;

  /// 409 VEHICLE_TERMINAL (vehicle-swap.service.js:67-72): vendida o fuera de servicio. Cuál de las dos lo dice el cuerpo del servidor, debajo.
  ///
  /// In es, this message translates to:
  /// **'Esa unidad ya no se puede rentar.'**
  String get coSwapTerminalCause;

  /// No description provided for @coSwapConfirm.
  ///
  /// In es, this message translates to:
  /// **'Cambiar a {unit}'**
  String coSwapConfirm(String unit);

  /// No description provided for @coSwapConfirmNone.
  ///
  /// In es, this message translates to:
  /// **'Elige una unidad'**
  String get coSwapConfirmNone;

  /// No description provided for @coSwapCancel.
  ///
  /// In es, this message translates to:
  /// **'Cancelar'**
  String get coSwapCancel;

  /// No description provided for @coSwapEmpty.
  ///
  /// In es, this message translates to:
  /// **'El servidor no reporta otras unidades libres para esta ventana.'**
  String get coSwapEmpty;

  /// No description provided for @coSwapNeedsNetwork.
  ///
  /// In es, this message translates to:
  /// **'Cambiar de unidad necesita conexión: el cambio lo hace el servidor sobre la reserva y el contrato.'**
  String get coSwapNeedsNetwork;

  /// Etiqueta para lectores de pantalla del QR. Antes era la URL FIRMADA completa: TalkBack dictaba el token en voz alta y ese token es una credencial al portador (review GD-SC-8 / INN-S-4).
  ///
  /// In es, this message translates to:
  /// **'Código QR para firmar los términos'**
  String get coQrSemanticLabel;

  /// No description provided for @coTermsInstruction.
  ///
  /// In es, this message translates to:
  /// **'Que el cliente lo escanee con la cámara de su teléfono para firmar.'**
  String get coTermsInstruction;

  /// No description provided for @coTermsExpiresIn.
  ///
  /// In es, this message translates to:
  /// **'Vence en'**
  String get coTermsExpiresIn;

  /// No description provided for @coTermsExpired.
  ///
  /// In es, this message translates to:
  /// **'Vencido'**
  String get coTermsExpired;

  /// No description provided for @coTermsPresent.
  ///
  /// In es, this message translates to:
  /// **'Mostrar al cliente (pantalla completa)'**
  String get coTermsPresent;

  /// No description provided for @coTermsWaiting.
  ///
  /// In es, this message translates to:
  /// **'Esperando la firma del cliente. Esta pantalla se actualiza sola.'**
  String get coTermsWaiting;

  /// No description provided for @coTermsReissue.
  ///
  /// In es, this message translates to:
  /// **'Generar código nuevo'**
  String get coTermsReissue;

  /// No description provided for @coTermsReissueWhy.
  ///
  /// In es, this message translates to:
  /// **'Si al código vigente le quedan más de 2 minutos, el servidor devuelve el mismo: el cliente puede seguir con el QR que ya tiene.'**
  String get coTermsReissueWhy;

  /// Nota 9 del mockup: la re-emisión admite cuándo el backend reusó el token en vez de fingir que emitió otro.
  ///
  /// In es, this message translates to:
  /// **'Sigue siendo el mismo código: al vigente le quedan más de 2 minutos y el servidor lo reusa. Si el cliente ya lo escaneó, no tiene que volver a hacerlo.'**
  String get coTermsReused;

  /// No description provided for @coTermsReissued.
  ///
  /// In es, this message translates to:
  /// **'Código nuevo listo. El anterior dejó de servir.'**
  String get coTermsReissued;

  /// No description provided for @coTermsExpiredBanner.
  ///
  /// In es, this message translates to:
  /// **'El código venció a las {time}. Nada se perdió: genera uno nuevo y el cliente firma igual.'**
  String coTermsExpiredBanner(String time);

  /// No description provided for @coTermsExpiredOverlay.
  ///
  /// In es, this message translates to:
  /// **'Código vencido'**
  String get coTermsExpiredOverlay;

  /// No description provided for @coTermsExpiredWhy.
  ///
  /// In es, this message translates to:
  /// **'El código nuevo dura otros 15 minutos. Si el cliente ya había abierto el anterior, tendrá que abrir el nuevo.'**
  String get coTermsExpiredWhy;

  /// No description provided for @coTermsMinting.
  ///
  /// In es, this message translates to:
  /// **'Pidiendo el código al servidor…'**
  String get coTermsMinting;

  /// No description provided for @coTermsMintFailed.
  ///
  /// In es, this message translates to:
  /// **'No se pudo emitir el código.'**
  String get coTermsMintFailed;

  /// No description provided for @coTermsOfflineWhy.
  ///
  /// In es, this message translates to:
  /// **'El código lo emite el servidor: sin conexión no hay QR que mostrar.'**
  String get coTermsOfflineWhy;

  /// No description provided for @coTermsSignedTitle.
  ///
  /// In es, this message translates to:
  /// **'Términos firmados'**
  String get coTermsSignedTitle;

  /// No se afirma DÓNDE firmó: el sello puede venir del teléfono del cliente o del kiosco, y la sesión no lo distingue.
  ///
  /// In es, this message translates to:
  /// **'{name} firmó a las {time}. Ya puedes seguir con el cobro.'**
  String coTermsSignedBody(String name, String time);

  /// No description provided for @coTermsSignedBodyNoName.
  ///
  /// In es, this message translates to:
  /// **'Los términos se firmaron a las {time}. Ya puedes seguir con el cobro.'**
  String coTermsSignedBodyNoName(String time);

  /// No description provided for @coTermsRecord.
  ///
  /// In es, this message translates to:
  /// **'Registro'**
  String get coTermsRecord;

  /// No description provided for @coTermsRecordConfirmed.
  ///
  /// In es, this message translates to:
  /// **'Confirmado por el servidor'**
  String get coTermsRecordConfirmed;

  /// No description provided for @coTermsRecordSigned.
  ///
  /// In es, this message translates to:
  /// **'Firmado'**
  String get coTermsRecordSigned;

  /// No description provided for @coTermsRecordAddenda.
  ///
  /// In es, this message translates to:
  /// **'Anexos'**
  String get coTermsRecordAddenda;

  /// No description provided for @coTermsAddendaNone.
  ///
  /// In es, this message translates to:
  /// **'Ninguno (seguro aceptado)'**
  String get coTermsAddendaNone;

  /// No description provided for @coTermsAddendaDecline.
  ///
  /// In es, this message translates to:
  /// **'Anexo de rechazo de cobertura'**
  String get coTermsAddendaDecline;

  /// No description provided for @coTermsCta.
  ///
  /// In es, this message translates to:
  /// **'Continuar al cobro'**
  String get coTermsCta;

  /// No description provided for @coTermsCtaWhy.
  ///
  /// In es, this message translates to:
  /// **'Este botón solo existe porque el servidor ya tiene la firma registrada.'**
  String get coTermsCtaWhy;

  /// No description provided for @coPresentInstruction.
  ///
  /// In es, this message translates to:
  /// **'Escanee este código con la cámara de su teléfono para leer y firmar los términos.'**
  String get coPresentInstruction;

  /// No description provided for @coPresentHelp.
  ///
  /// In es, this message translates to:
  /// **'¿Problemas para escanear? El agente puede ayudarle.'**
  String get coPresentHelp;

  /// No description provided for @coPresentExit.
  ///
  /// In es, this message translates to:
  /// **'Salir de presentación'**
  String get coPresentExit;

  /// No description provided for @coPresentSubtitle.
  ///
  /// In es, this message translates to:
  /// **'Términos de renta · Reserva {number}'**
  String coPresentSubtitle(String number);

  /// No description provided for @coPresentSubtitleNoNumber.
  ///
  /// In es, this message translates to:
  /// **'Términos de renta'**
  String get coPresentSubtitleNoNumber;

  /// Nota 12: al cliente NO se le pone un reloj en la cara; el countdown solo aparece bajo 2 min y con copy tranquilizadora.
  ///
  /// In es, this message translates to:
  /// **'Quedan {mmss} — si se vence, el agente le genera otro al instante.'**
  String coPresentClosingSoon(String mmss);

  /// No description provided for @coInspWhatTitle.
  ///
  /// In es, this message translates to:
  /// **'Qué se captura aquí'**
  String get coInspWhatTitle;

  /// No description provided for @coInspWhatParts.
  ///
  /// In es, this message translates to:
  /// **'3 partes'**
  String get coInspWhatParts;

  /// No description provided for @coInspRowPhotos.
  ///
  /// In es, this message translates to:
  /// **'Fotos'**
  String get coInspRowPhotos;

  /// No description provided for @coInspWhatPhotos.
  ///
  /// In es, this message translates to:
  /// **'8 ángulos · Frente y Atrás obligatorios'**
  String get coInspWhatPhotos;

  /// No description provided for @coInspRowCondition.
  ///
  /// In es, this message translates to:
  /// **'Estado'**
  String get coInspRowCondition;

  /// No description provided for @coInspWhatMetrics.
  ///
  /// In es, this message translates to:
  /// **'Odómetro, combustible, limpieza y notas'**
  String get coInspWhatMetrics;

  /// No description provided for @coInspRowSignature.
  ///
  /// In es, this message translates to:
  /// **'Firma'**
  String get coInspRowSignature;

  /// No description provided for @coInspWhatSignature.
  ///
  /// In es, this message translates to:
  /// **'El cliente firma la revisión en este teléfono'**
  String get coInspWhatSignature;

  /// Nota 3 del 17A: la promesa offline y su LÍMITE van en la misma frase; separadas, la primera se lee como 'ya quedó'.
  ///
  /// In es, this message translates to:
  /// **'Las fotos se pueden tomar sin señal: quedan en la bandeja y se envían solas al reconectar. El paso avanza cuando el servidor las recibe.'**
  String get coInspOfflineNote;

  /// No description provided for @coInspLastReading.
  ///
  /// In es, this message translates to:
  /// **'Última lectura'**
  String get coInspLastReading;

  /// Sello paymentCompletedAt del servidor, no una suposición de la app.
  ///
  /// In es, this message translates to:
  /// **'Pagado {time}'**
  String coInspPaidPill(String time);

  /// No description provided for @coInspStartCta.
  ///
  /// In es, this message translates to:
  /// **'Comenzar inspección'**
  String get coInspStartCta;

  /// No description provided for @coInspStartWhy.
  ///
  /// In es, this message translates to:
  /// **'Al comenzar, el servidor marca la inspección en curso. Puedes pausar el checkout en cualquier momento sin perder las fotos.'**
  String get coInspStartWhy;

  /// No description provided for @coInspPhotosStep.
  ///
  /// In es, this message translates to:
  /// **'Inspección · fotos'**
  String get coInspPhotosStep;

  /// No description provided for @coInspMetricsStep.
  ///
  /// In es, this message translates to:
  /// **'Inspección · estado'**
  String get coInspMetricsStep;

  /// No description provided for @coInspSummaryStep.
  ///
  /// In es, this message translates to:
  /// **'Inspección · revisar y enviar'**
  String get coInspSummaryStep;

  /// No description provided for @coInspRequiredWhy.
  ///
  /// In es, this message translates to:
  /// **'Frente y Atrás listos. El resto suma evidencia y se puede capturar después de las métricas.'**
  String get coInspRequiredWhy;

  /// No description provided for @inspPhotoQueued.
  ///
  /// In es, this message translates to:
  /// **'{time} · en bandeja'**
  String inspPhotoQueued(String time);

  /// Solo se dice cuando la fila SALIÓ de la bandeja tras un 2xx del servidor (el drenado borra la fila únicamente con DrainOk).
  ///
  /// In es, this message translates to:
  /// **'Enviada al servidor'**
  String get inspPhotoSent;

  /// No description provided for @inspPhotoDead.
  ///
  /// In es, this message translates to:
  /// **'No llegó al servidor'**
  String get inspPhotoDead;

  /// Nota 9 del 17D: 'completa en este teléfono' ≠ completa. El sello inspectionCompletedAt lo escribe el servidor al drenar el complete (mobile-inspection.service.js:268); finish() solo ENCOLA.
  ///
  /// In es, this message translates to:
  /// **'{count, plural, =0{La inspección está completa en este teléfono. Falta el cierre por enviar; sale solo al reconectar.} one{La inspección está completa en este teléfono. Falta 1 foto y el cierre por enviar; salen solos al reconectar.} other{La inspección está completa en este teléfono. Faltan {count} fotos y el cierre por enviar; salen solos al reconectar.}}'**
  String coInspLocalDoneTitle(int count);

  /// No description provided for @coInspLocalDoneSending.
  ///
  /// In es, this message translates to:
  /// **'La inspección está completa en este teléfono. El envío está en curso; el paso avanza cuando el servidor lo reciba.'**
  String get coInspLocalDoneSending;

  /// No description provided for @coInspServerPhotos.
  ///
  /// In es, this message translates to:
  /// **'{count} de 8 recibidas'**
  String coInspServerPhotos(int count);

  /// No description provided for @coInspRowInspection.
  ///
  /// In es, this message translates to:
  /// **'Inspección'**
  String get coInspRowInspection;

  /// No description provided for @coInspReceivedAt.
  ///
  /// In es, this message translates to:
  /// **'Recibida {time}'**
  String coInspReceivedAt(String time);

  /// No description provided for @coInspContinueSign.
  ///
  /// In es, this message translates to:
  /// **'Continuar a firma y cierre'**
  String get coInspContinueSign;

  /// No description provided for @coInspBlockedWhy.
  ///
  /// In es, this message translates to:
  /// **'Este paso lo cierra el servidor cuando reciba la inspección, no esta pantalla. Nada se pierde: puedes pausar el checkout y volver.'**
  String get coInspBlockedWhy;

  /// No description provided for @coOpenOutbox.
  ///
  /// In es, this message translates to:
  /// **'Ver la bandeja ({count})'**
  String coOpenOutbox(int count);

  /// No description provided for @coOpenOutboxDead.
  ///
  /// In es, this message translates to:
  /// **'{count, plural, one{Ver la bandeja (1 falla)} other{Ver la bandeja ({count} fallas)}}'**
  String coOpenOutboxDead(int count);

  /// Nota 12 del 17E: un dead-letter NO bloquea al resto de la bandeja (drainer.dart), así que el complete sale igual y el servidor lo rechaza con REQUIRED_ANGLES_MISSING (mobile-inspection.service.js:200-205).
  ///
  /// In es, this message translates to:
  /// **'La foto de {angle} no se pudo enviar y es obligatoria. Sin ella el servidor rechazará el cierre de la inspección.'**
  String coInspRequiredDeadTitle(String angle);

  /// No description provided for @coInspRetakeCta.
  ///
  /// In es, this message translates to:
  /// **'Tomar {angle} otra vez'**
  String coInspRetakeCta(String angle);

  /// No description provided for @coInspRetakeWhy.
  ///
  /// In es, this message translates to:
  /// **'Al volver a tomarla se reintenta el cierre de la inspección automáticamente.'**
  String get coInspRetakeWhy;

  /// No description provided for @coInspCompleteDeadTitle.
  ///
  /// In es, this message translates to:
  /// **'El cierre de la inspección no se pudo enviar. El motivo y la decisión que falta están en la bandeja.'**
  String get coInspCompleteDeadTitle;

  /// No description provided for @coInspRequiredAnglesTitle.
  ///
  /// In es, this message translates to:
  /// **'Ángulos obligatorios'**
  String get coInspRequiredAnglesTitle;

  /// No description provided for @coInspRequiredMissingPill.
  ///
  /// In es, this message translates to:
  /// **'{count, plural, one{Falta 1} other{Faltan {count}}}'**
  String coInspRequiredMissingPill(int count);

  /// Chip de la stepline cuando un angulo OBLIGATORIO murio en la bandeja: el contador de progreso deja de tener sentido y se cuentan fallas (17E).
  ///
  /// In es, this message translates to:
  /// **'{count, plural, one{1 falla} other{{count} fallas}}'**
  String coInspAnglesFailedChip(int count);

  /// No description provided for @coInspDoneTitle.
  ///
  /// In es, this message translates to:
  /// **'Inspección de salida'**
  String get coInspDoneTitle;

  /// No description provided for @coInspSignatureTitle.
  ///
  /// In es, this message translates to:
  /// **'Firma del cliente'**
  String get coInspSignatureTitle;

  /// No description provided for @coInspSignedRow.
  ///
  /// In es, this message translates to:
  /// **'Firmó'**
  String get coInspSignedRow;

  /// Solo se afirma cuando customerSignedAt e inspectionCompletedAt son el MISMO instante: el complete de la inspección estampa los dos en un solo write (mobile-inspection.service.js:265-281). Sellos distintos ⇒ la firma vino de otra superficie y no se atribuye.
  ///
  /// In es, this message translates to:
  /// **'{name} · al terminar la inspección'**
  String coSignFromInspection(String name);

  /// No description provided for @coSignAlreadyBanner.
  ///
  /// In es, this message translates to:
  /// **'El cliente ya firmó, así que no hay que pedirle firma otra vez. Solo falta cerrar la entrega.'**
  String get coSignAlreadyBanner;

  /// No description provided for @coInspCloseCta.
  ///
  /// In es, this message translates to:
  /// **'Continuar al cierre'**
  String get coInspCloseCta;

  /// No description provided for @coInspCloseWhy.
  ///
  /// In es, this message translates to:
  /// **'El servidor ya tiene la inspección y la firma. Este botón avanza al cierre; el contrato se genera cuando la entrega quede cerrada.'**
  String get coInspCloseWhy;

  /// No description provided for @coHandoffTitle.
  ///
  /// In es, this message translates to:
  /// **'Voltea el teléfono al cliente'**
  String get coHandoffTitle;

  /// No description provided for @coHandoffBody.
  ///
  /// In es, this message translates to:
  /// **'{name} va a firmar la entrega del {vehicle}.'**
  String coHandoffBody(String name, String vehicle);

  /// Sin nombre o sin unidad no se rellena un hueco: se dice la frase que sí es cierta.
  ///
  /// In es, this message translates to:
  /// **'El cliente va a firmar la entrega del vehículo.'**
  String get coHandoffBodyGeneric;

  /// No description provided for @coHandoffRuleLock.
  ///
  /// In es, this message translates to:
  /// **'La app queda bloqueada en la firma: no se puede salir ni ver otra pantalla.'**
  String get coHandoffRuleLock;

  /// No description provided for @coHandoffRuleExit.
  ///
  /// In es, this message translates to:
  /// **'Para salir sin firma: mantén 3 s la barra de arriba y escribe tu PIN.'**
  String get coHandoffRuleExit;

  /// Nota 2 del 18A: el límite ya está construido (kiosk_exit_exhausted) y el agente merece saberlo ANTES de soltar el teléfono, no descubrirlo con el aparato en la mano.
  ///
  /// In es, this message translates to:
  /// **'Si fallas el PIN 3 veces, la app se bloquea y hay que volver a entrar.'**
  String get coHandoffRulePin;

  /// No description provided for @coHandoffRuleBrand.
  ///
  /// In es, this message translates to:
  /// **'El cliente ve la pantalla en español o inglés, con la marca de {tenant}.'**
  String coHandoffRuleBrand(String tenant);

  /// Sin branding del tenant la fila del nombre se oculta (clientSafeCompanyName): nunca un fallback con marca nuestra frente al cliente.
  ///
  /// In es, this message translates to:
  /// **'El cliente ve la pantalla en español o inglés, sin la marca de la plataforma.'**
  String get coHandoffRuleBrandNoTenant;

  /// No description provided for @coHandoffCta.
  ///
  /// In es, this message translates to:
  /// **'Entregar al cliente'**
  String get coHandoffCta;

  /// No description provided for @coHandoffWhy.
  ///
  /// In es, this message translates to:
  /// **'La firma se guarda en el contrato al confirmarla. Si el cliente se arrepiente, sales con tu PIN y el paso queda igual.'**
  String get coHandoffWhy;

  /// La firma NO tiene camino offline y no debe tenerlo: se bloquea la entrega del teléfono con causa en lugar de encolar una firma.
  ///
  /// In es, this message translates to:
  /// **'Sin conexión no se puede recoger la firma: se guarda en el contrato en el momento, no después.'**
  String get coHandoffOfflineBlocked;

  /// No description provided for @kioskSignSubtitleCheckout.
  ///
  /// In es, this message translates to:
  /// **'Entrega del vehículo · Reserva {reservation}'**
  String kioskSignSubtitleCheckout(String reservation);

  /// No description provided for @kioskSignPromptCheckout.
  ///
  /// In es, this message translates to:
  /// **'Firme para confirmar que recibe el vehículo y acepta el contrato de renta.'**
  String get kioskSignPromptCheckout;

  /// Pie del 18B: qué está firmando, al pie y sin jerga. Se arma uniendo lo que existe; lo que falte se omite.
  ///
  /// In es, this message translates to:
  /// **'Placa {plate}'**
  String kioskSignPlate(String plate);

  /// Nota 7 del 18C: es verdad en el instante en que se dice — customer-signature ya respondió 200. Lo que sigue no se afirma todavía.
  ///
  /// In es, this message translates to:
  /// **'Firma recibida. Ya puedes tomar el teléfono.'**
  String get coSignReceived;

  /// No description provided for @coCloseStep1.
  ///
  /// In es, this message translates to:
  /// **'Firma guardada en el contrato'**
  String get coCloseStep1;

  /// No description provided for @coCloseStep2.
  ///
  /// In es, this message translates to:
  /// **'Generando el contrato'**
  String get coCloseStep2;

  /// No description provided for @coCloseStep3.
  ///
  /// In es, this message translates to:
  /// **'Registrar la entrega'**
  String get coCloseStep3;

  /// No description provided for @coCloseLegWaiting.
  ///
  /// In es, this message translates to:
  /// **'Paso {index} de {total} · falta'**
  String coCloseLegWaiting(int index, int total);

  /// No description provided for @coClosingCta.
  ///
  /// In es, this message translates to:
  /// **'Cerrando…'**
  String get coClosingCta;

  /// Nota 8: el backend NO tiene cascada aquí. saveCustomerSignature solo sella y las dos transiciones son dos POST más desde el cliente.
  ///
  /// In es, this message translates to:
  /// **'No cierres la app: el cierre son tres confirmaciones del servidor y aquí vas por la segunda.'**
  String get coClosingWhy;

  /// No description provided for @coCloseRetry.
  ///
  /// In es, this message translates to:
  /// **'Reintentar el cierre'**
  String get coCloseRetry;

  /// No description provided for @coCloseRetryWhy.
  ///
  /// In es, this message translates to:
  /// **'Este tramo se puede volver a intentar: la sesión sigue abierta y nada de lo capturado se perdió.'**
  String get coCloseRetryWhy;

  /// No description provided for @coAlreadySignedTitle.
  ///
  /// In es, this message translates to:
  /// **'El cliente ya firmó'**
  String get coAlreadySignedTitle;

  /// No description provided for @coAlreadySignedBody.
  ///
  /// In es, this message translates to:
  /// **'Firmó al terminar la inspección, a las {time}. No hace falta pedirle el teléfono otra vez.'**
  String coAlreadySignedBody(String time);

  /// Solo se atribuye a la inspección cuando customerSignedAt e inspectionCompletedAt son el MISMO instante (un único write, mobile-inspection.service.js:265-281). Si no, la firma vino de otra superficie y no se inventa dónde.
  ///
  /// In es, this message translates to:
  /// **'La firma quedó registrada a las {time}. No hace falta pedirle el teléfono otra vez.'**
  String coAlreadySignedBodyOther(String time);

  /// No description provided for @coAlreadySignedChip.
  ///
  /// In es, this message translates to:
  /// **'Firma en el contrato · {time}'**
  String coAlreadySignedChip(String time);

  /// No description provided for @coSignedDocTitle.
  ///
  /// In es, this message translates to:
  /// **'Lo que se firmó'**
  String get coSignedDocTitle;

  /// No description provided for @coSignedSigner.
  ///
  /// In es, this message translates to:
  /// **'Firmante'**
  String get coSignedSigner;

  /// No description provided for @coSignedSignerUnknown.
  ///
  /// In es, this message translates to:
  /// **'No se registró el nombre'**
  String get coSignedSignerUnknown;

  /// No description provided for @coSignedDocument.
  ///
  /// In es, this message translates to:
  /// **'Documento'**
  String get coSignedDocument;

  /// No description provided for @coSignedDocumentValue.
  ///
  /// In es, this message translates to:
  /// **'Contrato de renta {number}'**
  String coSignedDocumentValue(String number);

  /// No description provided for @coSignedDocumentValueNoNumber.
  ///
  /// In es, this message translates to:
  /// **'Contrato de renta'**
  String get coSignedDocumentValueNoNumber;

  /// No description provided for @coResignLink.
  ///
  /// In es, this message translates to:
  /// **'Volver a pedir la firma'**
  String get coResignLink;

  /// Verificado: saveCustomerSignature pisa tcSignatureDataUrl/tcSignedAt/tcSignerName sin comprobar si ya había firma (checkout-session.service.js:668-690).
  ///
  /// In es, this message translates to:
  /// **'La firma nueva SUSTITUYE a la que ya está en el contrato. Úsalo solo si la anterior no es válida.'**
  String get coResignWarning;

  /// No description provided for @coResignTitle.
  ///
  /// In es, this message translates to:
  /// **'¿Sustituir la firma guardada?'**
  String get coResignTitle;

  /// No description provided for @coResignConfirm.
  ///
  /// In es, this message translates to:
  /// **'Sí, pedirla otra vez'**
  String get coResignConfirm;

  /// No description provided for @coCloseCta.
  ///
  /// In es, this message translates to:
  /// **'Cerrar la entrega'**
  String get coCloseCta;

  /// No description provided for @coCloseCtaWhy.
  ///
  /// In es, this message translates to:
  /// **'Se registra la entrega en la reserva y se genera el contrato.'**
  String get coCloseCtaWhy;

  /// No description provided for @coClosedTitle.
  ///
  /// In es, this message translates to:
  /// **'Entrega cerrada'**
  String get coClosedTitle;

  /// No description provided for @coBeforeTheyGoTitle.
  ///
  /// In es, this message translates to:
  /// **'Antes de que se vaya'**
  String get coBeforeTheyGoTitle;

  /// No description provided for @coBeforeKeysLabel.
  ///
  /// In es, this message translates to:
  /// **'Llaves'**
  String get coBeforeKeysLabel;

  /// No description provided for @coBeforeKeys.
  ///
  /// In es, this message translates to:
  /// **'Entrega las llaves y la tarjeta de circulación'**
  String get coBeforeKeys;

  /// No description provided for @coBeforeReturnLabel.
  ///
  /// In es, this message translates to:
  /// **'Regreso'**
  String get coBeforeReturnLabel;

  /// No description provided for @coRecordTitle.
  ///
  /// In es, this message translates to:
  /// **'Registro'**
  String get coRecordTitle;

  /// No description provided for @coRecordSessionClosed.
  ///
  /// In es, this message translates to:
  /// **'Sesión cerrada'**
  String get coRecordSessionClosed;

  /// No description provided for @coRecordSignatureLabel.
  ///
  /// In es, this message translates to:
  /// **'Firma'**
  String get coRecordSignatureLabel;

  /// No description provided for @coRecordContractLabel.
  ///
  /// In es, this message translates to:
  /// **'Contrato'**
  String get coRecordContractLabel;

  /// autoEmailedAt se estampa ANTES de disparar el envío, que es fire-and-forget (checkout-session.service.js:597-612): el sello prueba que se PIDIÓ, no que salió.
  ///
  /// In es, this message translates to:
  /// **'Se pidió enviarlo por correo a las {time}'**
  String coRecordEmailRequested(String time);

  /// No description provided for @coRecordEmailNotRequested.
  ///
  /// In es, this message translates to:
  /// **'No hay registro de envío por correo'**
  String get coRecordEmailNotRequested;

  /// No description provided for @coRecordHandoverLabel.
  ///
  /// In es, this message translates to:
  /// **'Entrega'**
  String get coRecordHandoverLabel;

  /// No description provided for @coRecordHandoverRecorded.
  ///
  /// In es, this message translates to:
  /// **'La reserva quedó marcada como entregada'**
  String get coRecordHandoverRecorded;

  /// display-data no respondió o mandó un estado desconocido. Es 'no lo sé', jamás 'no quedó registrada'.
  ///
  /// In es, this message translates to:
  /// **'No se pudo confirmar en la reserva'**
  String get coRecordHandoverUnverified;

  /// No description provided for @coBackHome.
  ///
  /// In es, this message translates to:
  /// **'Volver al inicio'**
  String get coBackHome;

  /// No description provided for @coSessionDetail.
  ///
  /// In es, this message translates to:
  /// **'Ver el detalle de la sesión'**
  String get coSessionDetail;

  /// No description provided for @coCloseFailedStepline.
  ///
  /// In es, this message translates to:
  /// **'Cierre con problema'**
  String get coCloseFailedStepline;

  /// No description provided for @coCloseFailedTitle.
  ///
  /// In es, this message translates to:
  /// **'El checkout se cerró, pero el servidor no registró la entrega. La reserva necesita que alguien la revise en el mostrador.'**
  String get coCloseFailedTitle;

  /// El caso silencioso: 200 en el cierre y la cascada se tragó su error (:526, :533, :557, :571). Se detecta leyendo Reservation.status DESPUÉS de cerrar.
  ///
  /// In es, this message translates to:
  /// **'El checkout se cerró, pero la reserva no quedó marcada como entregada. Necesita que alguien la revise en el mostrador.'**
  String get coCloseNotRecordedTitle;

  /// No description provided for @coCloseFailedStep.
  ///
  /// In es, this message translates to:
  /// **'Rechazado a las {time}'**
  String coCloseFailedStep(String time);

  /// No description provided for @coCloseReasonTitle.
  ///
  /// In es, this message translates to:
  /// **'Motivo'**
  String get coCloseReasonTitle;

  /// No description provided for @coServerReasonLabel.
  ///
  /// In es, this message translates to:
  /// **'Respuesta del servidor'**
  String get coServerReasonLabel;

  /// No description provided for @coCloseReasonPill.
  ///
  /// In es, this message translates to:
  /// **'Del servidor'**
  String get coCloseReasonPill;

  /// No description provided for @coCloseVerifiedPill.
  ///
  /// In es, this message translates to:
  /// **'Verificado en la reserva'**
  String get coCloseVerifiedPill;

  /// No description provided for @coCloseNotRecordedReason.
  ///
  /// In es, this message translates to:
  /// **'Se consultó la reserva después de cerrar y sigue sin registrar la entrega. El servidor no dio un motivo.'**
  String get coCloseNotRecordedReason;

  /// canTransition es false desde un estado terminal (state-machine.js:94): un botón de reintento daría 409 ILLEGAL_TRANSITION para siempre.
  ///
  /// In es, this message translates to:
  /// **'Esta sesión ya está cerrada, así que no se puede reintentar desde aquí. Nada de lo capturado se perdió.'**
  String get coCloseNoRetry;

  /// No description provided for @coCopyProblem.
  ///
  /// In es, this message translates to:
  /// **'Copiar el detalle del problema'**
  String get coCopyProblem;

  /// No description provided for @coCopiedProblem.
  ///
  /// In es, this message translates to:
  /// **'Detalle copiado al portapapeles'**
  String get coCopiedProblem;

  /// No description provided for @coHoldKeys.
  ///
  /// In es, this message translates to:
  /// **'No entregues las llaves hasta que el mostrador confirme.'**
  String get coHoldKeys;

  /// No description provided for @coCloseUnknownStepline.
  ///
  /// In es, this message translates to:
  /// **'Cierre sin confirmar'**
  String get coCloseUnknownStepline;

  /// No description provided for @coCloseUnknownTitle.
  ///
  /// In es, this message translates to:
  /// **'Se cortó la conexión mientras se cerraba. No sabemos si el cierre entró o no — hay que preguntárselo al servidor.'**
  String get coCloseUnknownTitle;

  /// No description provided for @coCloseUnknownStep.
  ///
  /// In es, this message translates to:
  /// **'Sin respuesta'**
  String get coCloseUnknownStep;

  /// No description provided for @coCloseConfirmedAt.
  ///
  /// In es, this message translates to:
  /// **'{time} · confirmado'**
  String coCloseConfirmedAt(String time);

  /// No description provided for @coWontHappenTitle.
  ///
  /// In es, this message translates to:
  /// **'Qué NO va a pasar'**
  String get coWontHappenTitle;

  /// No description provided for @coWontHappenPill.
  ///
  /// In es, this message translates to:
  /// **'Regla'**
  String get coWontHappenPill;

  /// No description provided for @coWontRetryLabel.
  ///
  /// In es, this message translates to:
  /// **'Reintento'**
  String get coWontRetryLabel;

  /// No description provided for @coWontRetry.
  ///
  /// In es, this message translates to:
  /// **'La app no reintenta el cierre sola.'**
  String get coWontRetry;

  /// No description provided for @coWontQueueLabel.
  ///
  /// In es, this message translates to:
  /// **'Bandeja'**
  String get coWontQueueLabel;

  /// No description provided for @coWontQueue.
  ///
  /// In es, this message translates to:
  /// **'El cierre no entra a la bandeja de salida.'**
  String get coWontQueue;

  /// No description provided for @coCheckStatus.
  ///
  /// In es, this message translates to:
  /// **'Consultar el estado'**
  String get coCheckStatus;

  /// No description provided for @coCheckStatusWhy.
  ///
  /// In es, this message translates to:
  /// **'Con señal, una consulta dice en qué paso quedó y desde ahí se continúa.'**
  String get coCheckStatusWhy;
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
