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
  /// **'{count, plural, one{Mínimo 1 carácter} other{Mínimo {count} caracteres}}'**
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
  /// **'{count, plural, one{1 pendiente de envío} other{{count} pendientes de envío}}'**
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
  /// **'Todas las colas, en cero'**
  String get emptyAllQueuesLabel;

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
  /// **'{count, plural, one{Mostrando el primero — puede haber más} other{Mostrando los primeros {count} — puede haber más}}'**
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

  /// El muro de verdad: aquí es donde el agente descubre que no puede capturar. Decía solo «conéctate a una red para que se vacíe», y desde que un dead-letter conserva su binario esa frase puede mandar a caminar hacia la ventana por filas que la red no mueve (review GD-MC-5). Va con inspOutboxFullAction al lado.
  ///
  /// In es, this message translates to:
  /// **'La bandeja está llena: no cabe otra foto. Con red, lo que espera se envía solo; lo que el servidor rechazó solo se va cuando tú decides.'**
  String get inspOutboxFull;

  /// Salida real desde el muro (BannerAction, 44 dp). Sin ella el aviso describe un bloqueo y no ofrece dónde resolverlo — y la bandeja es la única pantalla donde se decide.
  ///
  /// In es, this message translates to:
  /// **'Ver la bandeja'**
  String get inspOutboxFullAction;

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

  /// Obturador colgado (corrida e2e 2, GPU por software): takePicture() nunca resuelve. NO se dice 'no se pudo abrir la cámara' —abrió y estaba mostrando imagen— para no mandar al agente a revisar un permiso que sí tiene.
  ///
  /// In es, this message translates to:
  /// **'La cámara no devolvió la foto'**
  String get camShutterStuckTitle;

  /// Dice QUÉ pasó, qué hizo la app (soltó el controlador) y las dos salidas reales. La última frase existe porque la causa es del aparato: reintentar en el mismo teléfono puede no bastar.
  ///
  /// In es, this message translates to:
  /// **'El disparo se quedó esperando y no volvió. Cerramos la cámara; vuelve a abrirla e inténtalo otra vez. Si se repite, usa otro teléfono para este vehículo.'**
  String get camShutterStuckHint;

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

  /// LA unidad del odómetro, escrita UNA sola vez en todo el catálogo. El paso 1 decía 'km' y el paso de métricas 'mi' para el MISMO número (hallazgo e2e). La verdad es millas y sale del backend: Vehicle.targetFleetMiles, includedMilesPerDay y computeExcessMileage() facturan por milla (fee-engine.service.js:163-176), y el mostrador web ya rotula 'mi'. No hay ninguna configuración de unidad por tenant — se buscó y no existe.
  ///
  /// In es, this message translates to:
  /// **'mi'**
  String get odometerUnit;

  /// Número ya formateado + la unidad. La unidad se INYECTA desde odometerUnit para que ninguna traducción pueda volver a inventar una distinta.
  ///
  /// In es, this message translates to:
  /// **'{value} {unit}'**
  String odometerValue(String value, String unit);

  /// {reading} llega ya compuesto por odometerValue — mismo separador de miles y misma unidad que el paso 1.
  ///
  /// In es, this message translates to:
  /// **'Última lectura registrada: {reading}'**
  String metricsPrevReading(String reading);

  /// No description provided for @metricsOdometerLower.
  ///
  /// In es, this message translates to:
  /// **'La lectura es menor que la última registrada. Revísala — se enviará tal cual.'**
  String get metricsOdometerLower;

  /// No description provided for @metricsFieldOdometer.
  ///
  /// In es, this message translates to:
  /// **'el odómetro'**
  String get metricsFieldOdometer;

  /// No description provided for @metricsFieldFuel.
  ///
  /// In es, this message translates to:
  /// **'el combustible'**
  String get metricsFieldFuel;

  /// No description provided for @metricsFieldCleanliness.
  ///
  /// In es, this message translates to:
  /// **'la limpieza'**
  String get metricsFieldCleanliness;

  /// No description provided for @metricsFieldJoin.
  ///
  /// In es, this message translates to:
  /// **'y'**
  String get metricsFieldJoin;

  /// El pie del sub-paso de métricas NOMBRA lo que falta, como ya hace el paso 1. Con el teclado abierto tapando combustible y limpieza, el agente mira abajo y ve un CTA muerto: el why es lo que hace aceptable ese límite de viewport.
  ///
  /// In es, this message translates to:
  /// **'Falta capturar {fields}.'**
  String metricsBlockedWhy(String fields);

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
  /// **'{photos, plural, one{1 foto · métricas · firma} other{{photos} fotos · métricas · firma}}'**
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
  /// **'{total, plural, one{{done} de 1 enviado} other{{done} de {total} enviados}}'**
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
  /// **'{count, plural, one{intentado 1 vez · último {time}} other{intentado {count} veces · último {time}}}'**
  String outboxAttempts(int count, String time);

  /// Esta fila NO ofrece Reintentar (canRetry:false) y sin reservationId tampoco ofrece 'Abrir inspección'. El texto anterior decía «Captúralos y reintenta» y nombraba un botón que no está — review GD-MC-4.
  ///
  /// In es, this message translates to:
  /// **'El servidor lo rechazó: faltan los ángulos frontal y trasero. Se capturan en la inspección; desde aquí este envío no se puede reenviar.'**
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

  /// Brazo sin Reintentar. Sigue el modelo de coCloseNoRetry (review GD-MC-4): por qué no hay reintento + qué NO se perdió. Antes era un hecho a secas y el agente se quedaba mirando una fila con una sola salida sin saber si estaba destruyendo algo.
  ///
  /// In es, this message translates to:
  /// **'La sesión de checkout ya no existe en el servidor, así que este envío no se puede reintentar desde aquí. Lo que sí llegó a subirse sigue en la reserva.'**
  String get outboxReasonSessionGone;

  /// Fila `dead` cuya sesión selló otra superficie (6F/17F, columna sessionSealedAt). Nace SIN Reintentar: contra una inspección cerrada el re-mint muere con SESSION_GONE. Dice las dos cosas que el agente necesita — que no se perdió la inspección, y que su evidencia sigue aquí esperándolo.
  ///
  /// In es, this message translates to:
  /// **'Otra pantalla cerró esta inspección antes que este envío, así que ya no se puede reenviar. La inspección quedó sellada con lo que sí llegó; esta foto sigue en el teléfono hasta que decidas.'**
  String get outboxReasonSessionSealed;

  /// SOLO cuando nunca llegó respuesta (lastErrorStatus null). Mandar a alguien a buscar señal por un rechazo del servidor es el defecto que arregló este texto.
  ///
  /// In es, this message translates to:
  /// **'No se pudo enviar tras varios intentos. Reintenta cuando haya señal.'**
  String get outboxReasonNetwork;

  /// 5xx/429 que agotó reintentos: hubo respuesta, pero no fue un rechazo de lo que se envió.
  ///
  /// In es, this message translates to:
  /// **'No es tu señal: el servidor falló y no pudo recibir este envío. Reintenta más tarde.'**
  String get outboxReasonServerUnavailable;

  /// No description provided for @outboxReasonGeneric.
  ///
  /// In es, this message translates to:
  /// **'El servidor rechazó este envío. Abre el detalle técnico y pásaselo a soporte antes de descartarlo.'**
  String get outboxReasonGeneric;

  /// El hueco lo arma la pantalla con el code del backend y/o el status HTTP unidos por ' · ' — solo con lo que de verdad existe.
  ///
  /// In es, this message translates to:
  /// **'Detalle técnico: {detail}'**
  String outboxTechnicalDetail(String detail);

  /// Sin code ni status (fallo de red puro): la etiqueta sola, jamás un separador colgando.
  ///
  /// In es, this message translates to:
  /// **'Detalle técnico'**
  String get outboxTechnicalDetailBare;

  /// Dato de transporte para soporte. No se traduce el error del servidor: esto es el status, no su cuerpo.
  ///
  /// In es, this message translates to:
  /// **'HTTP {status}'**
  String outboxTechnicalHttp(int status);

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
  /// **'{count, plural, one{1 envío esperando (límite del teléfono). No cabe más — conéctate a una red para que se vacíe y puedas seguir capturando.} other{{count} envíos esperando (límite del teléfono). No cabe más — conéctate a una red para que se vacíe y puedas seguir capturando.}}'**
  String outboxFullBody(int count);

  /// Aparece en el cuerpo de bandeja llena SOLO si hay dead-letters ocupando cupo: desde 2026-09 el binario de un rechazado se conserva hasta que el humano decide, así que 'conéctate y se vaciará' sería media verdad. SIN conteo (review GD-SC-1): el número ya lo dice el banner rojo de arriba y repetirlo aquí era el mismo dato en dos colores. SIN nombrar botones (GD-SC-2): la decisión son las filas de abajo, y sus acciones cambian según por qué murió cada una.
  ///
  /// In es, this message translates to:
  /// **'Los rechazados esperan tu decisión abajo: hasta que la tomes, su espacio no se libera.'**
  String get outboxFullDeadHint;

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
  /// **'{total, plural, one{1 paso + salida alterna} other{{total} pasos + salida alterna}}'**
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

  /// Cabecera de sesión. {reading} llega ya compuesto por odometerValue: la unidad NO se escribe aquí. Decía 'Odómetro {km} km' y contradecía a la tarjeta del mismo wizard, que ya decía 'mi'.
  ///
  /// In es, this message translates to:
  /// **'Odómetro {reading}'**
  String coOdometerReading(String reading);

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

  /// Acuse del re-consultado (GD-MC-5b): el botón disparaba dos peticiones y NO mostraba nada. Reusa la misma lista legible de campos que el bloqueo. SOLO se usa cuando display-data RESPONDIÓ: afirmar esto sobre una consulta caída era la acusación falsa que encontró la corrida e2e.
  ///
  /// In es, this message translates to:
  /// **'Consultado ahora: el servidor sigue sin {fields}.'**
  String coConfirmRecheckedStill(String fields);

  /// Regla 8D aplicada al dato del cliente: el dato viejo se queda, pero diciendo que es viejo. No bloquea — bloquear una entrega porque un refresco de fondo falló sería una puerta falsa nueva.
  ///
  /// In es, this message translates to:
  /// **'Estos datos son los de la última consulta que sí llegó. La de ahora no llegó: confírmalos contra la licencia antes de entregar.'**
  String get coConfirmStaleWhy;

  /// Escalón del aviso de vejez a partir de kStaleCustomerDataHorizon (los 15 min de HANDOFF_TOKEN_TTL_MIN). A esa antigüedad la pregunta ya no es «¿coincide con la licencia?» —eso el agente lo está haciendo— sino «¿alguien reescribió el contrato?», que una licencia en la mano no detecta. Lleva la EDAD y no el umbral: es el dato con el que se decide.
  ///
  /// In es, this message translates to:
  /// **'Estos datos son de hace {age} y la consulta de ahora no llegó. Vuelve a consultar antes de firmar: en ese tiempo el contrato pudo cambiar en el mostrador.'**
  String coConfirmStaleOldWhy(String age);

  /// Vejez CON ORIGEN (corrida e2e 2): POST /vehicle devolvió 200 y la re-lectura de display-data se cayó. Gana a coConfirmStaleWhy/coConfirmStaleOldWhy porque esos dos hablan de la licencia y del contrato, y aquí lo que miente es la tarjeta del vehículo. No bloquea el CTA: el swap SÍ quedó en el servidor. SIN direcciones (review GD-MC-3): este texto se pinta en el DOCK, al pie, y las tarjetas están arriba — «el vehículo de abajo» apuntaba al lado contrario.
  ///
  /// In es, this message translates to:
  /// **'El cambio de unidad se guardó, pero la reserva no se pudo volver a leer: la unidad que se muestra puede ser la que acabas de reemplazar. Actualiza los datos antes de entregar.'**
  String get coConfirmSwapStaleWhy;

  /// No description provided for @coConfirmSwapStaleLabel.
  ///
  /// In es, this message translates to:
  /// **'Cambio de unidad'**
  String get coConfirmSwapStaleLabel;

  /// Fila dentro de la tarjeta del vehículo, ARRIBA de la unidad: avisa que el renglón siguiente puede ser la unidad reemplazada. El hecho es doble y las dos mitades importan: el cambio no se perdió, y lo que se ve no es lo que hay. «Releer» es vocabulario nuestro, no del mostrador (review GD-SC-6).
  ///
  /// In es, this message translates to:
  /// **'El servidor ya lo tiene · esta pantalla no se ha actualizado'**
  String get coConfirmSwapStaleValue;

  /// No description provided for @coConfirmCheckingPill.
  ///
  /// In es, this message translates to:
  /// **'Consultando'**
  String get coConfirmCheckingPill;

  /// No description provided for @coConfirmCheckingValue.
  ///
  /// In es, this message translates to:
  /// **'Consultando…'**
  String get coConfirmCheckingValue;

  /// Bloqueo mientras la consulta VIAJA. No afirma nada del servidor: todavía no ha contestado.
  ///
  /// In es, this message translates to:
  /// **'Consultando la ficha del cliente…'**
  String get coConfirmCheckingWhy;

  /// No description provided for @coConfirmUnknownPill.
  ///
  /// In es, this message translates to:
  /// **'Sin consultar'**
  String get coConfirmUnknownPill;

  /// Valor de cada fila cuando display-data no respondió. NO es 'Sin capturar': ese texto afirma que el servidor no tiene el dato, y aquí no se sabe.
  ///
  /// In es, this message translates to:
  /// **'No se pudo consultar'**
  String get coConfirmUnknownValue;

  /// Hallazgo e2e (MAJOR): el bloqueo cambia de naturaleza. No se bloquea por 'faltan datos' —que sería una acusación al servidor— sino porque sin consulta no hay identidad que confirmar.
  ///
  /// In es, this message translates to:
  /// **'No se pudo consultar la ficha del cliente, así que no se puede confirmar su identidad.'**
  String get coConfirmUnreachableWhy;

  /// Clave de la fila que cita la negativa CRUDA (DoD #5). El valor es el mensaje del servidor tal cual, sin envoltorio: la clave ya dice qué es. La fila entera se omite cuando la petición murió sin cuerpo.
  ///
  /// In es, this message translates to:
  /// **'Respuesta del servidor'**
  String get coConfirmServerReplyLabel;

  /// Acción que SÍ puede tener éxito (nada de puertas falsas): repite el GET de display-data. Distinta de 'Actualizar datos del cliente', que se ofrece cuando el servidor sí contestó y faltan campos.
  ///
  /// In es, this message translates to:
  /// **'Reintentar la consulta'**
  String get coConfirmRetryLookup;

  /// Acuse del reintento fallido. Habla de la CONSULTA, jamás de los datos.
  ///
  /// In es, this message translates to:
  /// **'Reintentado ahora: la consulta sigue sin llegar.'**
  String get coConfirmRetryStillUnreachable;

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

  /// INN S-1. La tinta retenida vive solo en memoria y solo hasta el 200; volver a pedirle la firma al cliente sería cobrarle el error de la app.
  ///
  /// In es, this message translates to:
  /// **'El cliente ya firmó en este teléfono, pero el servidor todavía no lo confirmó. El trazo sigue aquí: no hace falta pedírselo otra vez.'**
  String get coRetainedNote;

  /// No description provided for @coRetryWithSignature.
  ///
  /// In es, this message translates to:
  /// **'Reintentar con la firma que ya dio'**
  String get coRetryWithSignature;

  /// No description provided for @coRetryWithSignatureWhy.
  ///
  /// In es, this message translates to:
  /// **'Se manda el MISMO trazo que el cliente dejó hace un momento. Vive solo en la memoria de este teléfono y nunca entra a la bandeja de salida.'**
  String get coRetryWithSignatureWhy;

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

  /// 19A-bis, variantes verifying/unverified: el 200 prueba el CHECKOUT, no la entrega. Mismo verde, misma posición — una palabra que no sobreafirma (vocabulario ya aprobado en coCloseFailedTitle).
  ///
  /// In es, this message translates to:
  /// **'Checkout cerrado'**
  String get coClosedTitleUnverified;

  /// Banner ámbar SOLO en unverified. A propósito NO dice "no entregues las llaves": esa línea es de 19B, donde hay un rechazo real — aquí solo hay ignorancia (decisión aprobada, nota 10).
  ///
  /// In es, this message translates to:
  /// **'El cierre entró, pero no pudimos confirmarlo en la reserva. Compruébalo antes de dar por terminada la entrega.'**
  String get coRecordHandoverUnverifiedNotice;

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

  /// SC-1 camino B (aprobado por Hector). Dice "registro de la inspección" y NO "contrato": la copia al contrato es best-effort dentro de un catch que se traga el error (checkout-session.service.js:551-557, :562). Incondicional: la tarjeta nunca baja de dos renglones.
  ///
  /// In es, this message translates to:
  /// **'El combustible y el kilometraje de salida quedaron en el registro de la inspección, no en esta pantalla.'**
  String get coBeforeScopeNote;

  /// No description provided for @coRecordTitle.
  ///
  /// In es, this message translates to:
  /// **'Registro'**
  String get coRecordTitle;

  /// No description provided for @coRecordPillRecorded.
  ///
  /// In es, this message translates to:
  /// **'Registrada'**
  String get coRecordPillRecorded;

  /// No description provided for @coRecordPillChecking.
  ///
  /// In es, this message translates to:
  /// **'Comprobando'**
  String get coRecordPillChecking;

  /// No description provided for @coRecordPillUnverified.
  ///
  /// In es, this message translates to:
  /// **'Sin confirmar'**
  String get coRecordPillUnverified;

  /// No description provided for @coRecordRowSession.
  ///
  /// In es, this message translates to:
  /// **'Sesión'**
  String get coRecordRowSession;

  /// Fila ancla del 19A-bis: el hecho que el 200 SÍ prueba, con la hora del SERVIDOR (finishedAt). Era la pastilla coRecordSessionClosed; se muda a fila y gana la hora, como 17F-bis hizo con la hora de la inspección.
  ///
  /// In es, this message translates to:
  /// **'Cerrada {time}'**
  String coRecordSessionClosedAt(String time);

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

  /// La única formulación que la app puede firmar: se preguntó y la reserva lo confirma. No dice 'avanzó a CHECKED_OUT' ni 'el vehículo quedó rentado'.
  ///
  /// In es, this message translates to:
  /// **'Registrada en la reserva · {time}'**
  String coRecordHandoverRecorded(String time);

  /// Fila Entrega mientras la consulta viaja (19A-bis). Ningún renglón afirma un resultado antes de que vuelva la llamada que lo produce.
  ///
  /// In es, this message translates to:
  /// **'Comprobando en la reserva…'**
  String get coRecordHandoverChecking;

  /// display-data no respondió o mandó un estado desconocido. Es 'no lo sé', jamás 'no quedó registrada' — el negativo definitivo enruta a 19B.
  ///
  /// In es, this message translates to:
  /// **'Sin confirmar'**
  String get coRecordHandoverUnconfirmed;

  /// No description provided for @coRecordHandoverCheckingWhy.
  ///
  /// In es, this message translates to:
  /// **'Nada bloquea: el agente puede salir. La comprobación no se pierde, queda en la sesión.'**
  String get coRecordHandoverCheckingWhy;

  /// No description provided for @coRecordHandoverRecheck.
  ///
  /// In es, this message translates to:
  /// **'Volver a comprobar'**
  String get coRecordHandoverRecheck;

  /// No description provided for @coRecordHandoverRecheckWhy.
  ///
  /// In es, this message translates to:
  /// **'Es una consulta al servidor, no un reintento del cierre: la sesión ya está cerrada y no puede cerrarse dos veces.'**
  String get coRecordHandoverRecheckWhy;

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

  /// GD-MC-3: el detalle NO puede ser una puerta de un solo sentido — el motivo del rechazo no sobrevive al re-fetch y 'Copiar el detalle' solo existe en el resumen.
  ///
  /// In es, this message translates to:
  /// **'Volver al resumen del cierre'**
  String get coBackToOutcome;

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
  /// **'Comprobado en la reserva'**
  String get coCloseVerifiedPill;

  /// Rama SIN motivo del servidor (19B silencioso): la tarjeta no cita a nadie, cuenta lo que la app verificó por su cuenta. Titularla 'Motivo' prometía una cita que no existe.
  ///
  /// In es, this message translates to:
  /// **'Lo que comprobamos'**
  String get coCloseVerifiedTitle;

  /// No description provided for @coCloseVerifiedLabel.
  ///
  /// In es, this message translates to:
  /// **'Estado de la reserva'**
  String get coCloseVerifiedLabel;

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
  /// **'Copiar el detalle para el mostrador'**
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

  /// Semántica del chip de presencia, que en H6 se vuelve TOCABLE (abre la hoja 20B). El label recita primero la línea visible y después la acción: TalkBack lee lo que hay antes de lo que se puede hacer.
  ///
  /// In es, this message translates to:
  /// **'{line}: ver quién está en esta sesión'**
  String coPresenceChipSemantics(String line);

  /// La regla antisoledad, EN PANTALLA y no en un comentario de código: con el latido encendido el agente se acostumbra a confiar en el dato, y el vacío es justo lo que la presencia no puede afirmar.
  ///
  /// In es, this message translates to:
  /// **'El chip solo afirma quién está. Que no aparezca nadie no significa que estés solo.'**
  String get coPresenceNeverAlone;

  /// No description provided for @coWhoIsHereTitle.
  ///
  /// In es, this message translates to:
  /// **'Quién está en esta sesión'**
  String get coWhoIsHereTitle;

  /// El TTL se NOMBRA en vez de esconderse: evita la pregunta de patio «¿por qué desapareció María si sigue ahí?» — tres polls perdidos y te vas.
  ///
  /// In es, this message translates to:
  /// **'Ventana de 45 s del servidor · se actualiza con cada lectura'**
  String get coWhoIsHereSub;

  /// No description provided for @coWhoIsHereNow.
  ///
  /// In es, this message translates to:
  /// **'ahora'**
  String get coWhoIsHereNow;

  /// No description provided for @coWhoIsHereAge.
  ///
  /// In es, this message translates to:
  /// **'hace {age}'**
  String coWhoIsHereAge(String age);

  /// El kiosco y el teléfono del cliente laten con actorUserId null A PROPÓSITO. Ese nulo no es un hueco: es el dato.
  ///
  /// In es, this message translates to:
  /// **'Aparato · sin persona identificada'**
  String get coWhoIsHereDeviceSub;

  /// No description provided for @coWhoIsHereYou.
  ///
  /// In es, this message translates to:
  /// **'Tú · RideOps'**
  String get coWhoIsHereYou;

  /// El reverso del latido, con nombre completo (decisión de Hector: el usuario se identifica).
  ///
  /// In es, this message translates to:
  /// **'Los demás te ven como {name}'**
  String coWhoIsHereYouSeenAs(String name);

  /// Variante sin /me hidratado: se dice QUÉ se anuncia sin fingir saber el nombre exacto que resolverá el servidor.
  ///
  /// In es, this message translates to:
  /// **'Los demás te ven con tu nombre completo'**
  String get coWhoIsHereYouSeenAsUnknown;

  /// Qué se anuncia, a quién y cuánto dura — y el cierre que importa: la presencia NO es un candado. El riesgo real de encender el latido no es la identidad, es que alguien lea la presencia como una reserva y se quede esperando.
  ///
  /// In es, this message translates to:
  /// **'Apareces con tu nombre mientras esta pantalla esté abierta. Al salir o pausar dejas de aparecer en menos de un minuto. Esto no reserva nada: nadie queda bloqueado por estar aquí.'**
  String get coWhoIsHereDisclosure;

  /// Lo que la app dice cuando la lista llega VACÍA con red. Lo que jamás dice: «nadie más está en esta sesión».
  ///
  /// In es, this message translates to:
  /// **'No hay nadie visible ahora mismo. Otra superficie puede estar avanzando sin aparecer aquí.'**
  String get coPresenceEmpty;

  /// Versión corta para el chip de la antesala (23C): llegar a una sesión abandonada e inferir «está libre» es la tentación exacta que esta frase corta.
  ///
  /// In es, this message translates to:
  /// **'Nadie visible ahora mismo'**
  String get coPresenceEmptyShort;

  /// Dos vacíos distintos, dos frases distintas: «no verificable» (sin red) y «nadie visible» (con red). Fundirlas sería más barato y exactamente igual de mentiroso en uno de los dos casos.
  ///
  /// In es, this message translates to:
  /// **'Sin red no se puede afirmar que alguien esté ahora. El punto verde se apaga; el chip no desaparece.'**
  String get coPresenceOfflineWhy;

  /// Atribución CON nombre. Solo se usa cuando la presencia resuelve el actorUserId del evento; si no, cae a coAdvancedOtherAgent («otro agente»).
  ///
  /// In es, this message translates to:
  /// **'«{step}» lo completó {name} hace {age}.'**
  String coAdvancedOtherAgentNamed(String step, String name, String age);

  /// Frame 21C: cayó un SELLO sin que el paso se moviera. No se nombra la superficie porque el backend no la escribe en los eventos SIDE_EFFECT — se dice lo que se sabe.
  ///
  /// In es, this message translates to:
  /// **'{stamp} se registró en otra superficie hace {age}.'**
  String coAdvancedStampLanded(String stamp, String age);

  /// La frase que desarma la alarma. El avance ajeno ocurrió en OTRO sitio y no exige nada del agente ahora — sobre todo, no exige que suelte el formulario a medio llenar.
  ///
  /// In es, this message translates to:
  /// **'Sigue capturando: este paso no cambió.'**
  String get coAdvancedStepUnchanged;

  /// No description provided for @coChangedTitle.
  ///
  /// In es, this message translates to:
  /// **'Qué cambió desde que entraste'**
  String get coChangedTitle;

  /// No description provided for @coChangedSub.
  ///
  /// In es, this message translates to:
  /// **'Estado reportado por el servidor · {time}'**
  String coChangedSub(String time);

  /// No description provided for @coChangedStepMoved.
  ///
  /// In es, this message translates to:
  /// **'El paso se movió'**
  String get coChangedStepMoved;

  /// No description provided for @coChangedStepMovedDetail.
  ///
  /// In es, this message translates to:
  /// **'{from} → {to}'**
  String coChangedStepMovedDetail(String from, String to);

  /// No description provided for @coChangedByKiosk.
  ///
  /// In es, this message translates to:
  /// **'Completado en el kiosco · {time}'**
  String coChangedByKiosk(String time);

  /// No description provided for @coChangedByOtherAgent.
  ///
  /// In es, this message translates to:
  /// **'Lo completó {name} · {time}'**
  String coChangedByOtherAgent(String name, String time);

  /// No description provided for @coChangedByOtherSurface.
  ///
  /// In es, this message translates to:
  /// **'Completado en otra superficie · {time}'**
  String coChangedByOtherSurface(String time);

  /// No description provided for @coChangedByYou.
  ///
  /// In es, this message translates to:
  /// **'Lo hiciste tú · {time} · sin cambios'**
  String coChangedByYou(String time);

  /// No description provided for @coChangedUntouched.
  ///
  /// In es, this message translates to:
  /// **'Pendiente · no lo ha tocado nadie'**
  String get coChangedUntouched;

  /// La única frase que el agente vino a leer. El miedo real al ver «alguien más avanzó» no es de proceso: es «¿perdí mi trabajo?». Se responde primero y en verde.
  ///
  /// In es, this message translates to:
  /// **'Nada de lo que hiciste se perdió.'**
  String get coChangedNothingLost;

  /// Cuando SÍ hay algo en riesgo la franja verde cambia a ámbar y NOMBRA qué. Nunca se queda en verde por comodidad.
  ///
  /// In es, this message translates to:
  /// **'{count, plural, one{Ojo: 1 envío no ha llegado al servidor. Revisa la Bandeja antes de seguir.} other{Ojo: {count} envíos no han llegado al servidor. Revisa la Bandeja antes de seguir.}}'**
  String coChangedSomethingLost(int count);

  /// Estado vacío honesto de la hoja: se puede abrir sin que haya avance ajeno.
  ///
  /// In es, this message translates to:
  /// **'Nadie ha tocado nada desde que entraste.'**
  String get coChangedNoChanges;

  /// No description provided for @coChangedStayCta.
  ///
  /// In es, this message translates to:
  /// **'Seguir en el paso {index}'**
  String coChangedStayCta(int index);

  /// No description provided for @coConflictTooEarlyTitle.
  ///
  /// In es, this message translates to:
  /// **'Ese paso todavía no toca'**
  String get coConflictTooEarlyTitle;

  /// El MISMO code ILLEGAL_TRANSITION, la situación opuesta a «ya lo hicieron»: se pidió un paso que la cadena lineal aún no permite.
  ///
  /// In es, this message translates to:
  /// **'La sesión está en {current} (paso {index}) y {target} es el paso {targetIndex}. El servidor solo deja avanzar de uno en uno.'**
  String coConflictTooEarlyBody(
    String current,
    int index,
    String target,
    int targetIndex,
  );

  /// Variante para cuando alguno de los dos pasos no está en el catálogo (paso nuevo del backend): se dice la regla sin inventar números.
  ///
  /// In es, this message translates to:
  /// **'El servidor solo deja avanzar de uno en uno, y este no es el paso que sigue.'**
  String get coConflictTooEarlyBodyShort;

  /// No description provided for @coGoToStepCta.
  ///
  /// In es, this message translates to:
  /// **'Ir al paso {index} · {step}'**
  String coGoToStepCta(int index, String step);

  /// Por qué esta acción SÍ puede tener éxito: es una pantalla local, no una transición. La puerta falsa que aquí NO se dibuja es «Reintentar», que contra una máquina lineal daría 409 para siempre.
  ///
  /// In es, this message translates to:
  /// **'Ir al paso {index} es navegación dentro de esta app: siempre funciona.'**
  String coGoToStepWhy(int index);

  /// No description provided for @coGuardOutboxCta.
  ///
  /// In es, this message translates to:
  /// **'Ver la Bandeja ({n})'**
  String coGuardOutboxCta(int n);

  /// «Ver la Bandeja» sí puede tener éxito; «reintentar el paso» no: el sello lo estampa el servidor al drenar el complete, no esta pantalla.
  ///
  /// In es, this message translates to:
  /// **'La Bandeja drena sola al recuperar señal; el paso avanza cuando el sello llegue.'**
  String get coGuardOutboxWhy;

  /// El callejón se NOMBRA en vez de ofrecer un CTA imposible: pasada INSPECTION_IN_PROGRESS el swap responde 409 SWAP_LOCKED para siempre (vehicle-swap.service.js:46-51).
  ///
  /// In es, this message translates to:
  /// **'Esta unidad ya no se puede cambiar desde aquí: la inspección ya empezó. Se resuelve en el mostrador.'**
  String get coConflictSwapLockedBody;

  /// No se nombra QUIÉN la abrió: startedByUserId viaja como id y el servidor no manda su nombre. Se dice lo que se sabe.
  ///
  /// In es, this message translates to:
  /// **'Esta salida ya empezó: va por el paso {index} de {total}.'**
  String coJoinBannerStarted(int index, int total);

  /// No description provided for @coJoinBannerStartedAt.
  ///
  /// In es, this message translates to:
  /// **'Esta salida ya empezó. Se abrió a las {time} y va por el paso {index} de {total}.'**
  String coJoinBannerStartedAt(String time, int index, int total);

  /// No description provided for @coJoinBannerStartedByOther.
  ///
  /// In es, this message translates to:
  /// **'Esta salida la abrió otro agente y va por el paso {index} de {total}.'**
  String coJoinBannerStartedByOther(int index, int total);

  /// No description provided for @coJoinDoneTitle.
  ///
  /// In es, this message translates to:
  /// **'Lo que ya está hecho'**
  String get coJoinDoneTitle;

  /// No description provided for @coJoinDonePill.
  ///
  /// In es, this message translates to:
  /// **'{total, plural, one{{done} de 1 fase} other{{done} de {total} fases}}'**
  String coJoinDonePill(int done, int total);

  /// No description provided for @coJoinPendingTitle.
  ///
  /// In es, this message translates to:
  /// **'Lo que falta'**
  String get coJoinPendingTitle;

  /// No description provided for @coJoinPendingPill.
  ///
  /// In es, this message translates to:
  /// **'Tuyo'**
  String get coJoinPendingPill;

  /// No description provided for @coJoinContinueCta.
  ///
  /// In es, this message translates to:
  /// **'Continuar desde el paso {index}'**
  String coJoinContinueCta(int index);

  /// Sin posición en el catálogo (paso nuevo del backend) no se inventa un número.
  ///
  /// In es, this message translates to:
  /// **'Continuar'**
  String get coJoinContinueCtaUnknownStep;

  /// ADR-4 en idioma de patio. Es la misma promesa que hace la hoja de pausa: se prometió al pausar y se cumple al volver.
  ///
  /// In es, this message translates to:
  /// **'Entras al paso que reporta el servidor, no al que dejó nadie. Nada se re-hace.'**
  String get coJoinContinueWhy;

  /// No description provided for @coJoinKioskActiveTitle.
  ///
  /// In es, this message translates to:
  /// **'El cliente está usando el kiosco ahora mismo.'**
  String get coJoinKioskActiveTitle;

  /// No description provided for @coJoinKioskActiveBody.
  ///
  /// In es, this message translates to:
  /// **'Si avanzas desde aquí puedes interrumpir lo que está haciendo.'**
  String get coJoinKioskActiveBody;

  /// No description provided for @coJoinAdviceTitle.
  ///
  /// In es, this message translates to:
  /// **'Qué conviene hacer'**
  String get coJoinAdviceTitle;

  /// No description provided for @coJoinAdvicePill.
  ///
  /// In es, this message translates to:
  /// **'Consejo'**
  String get coJoinAdvicePill;

  /// No description provided for @coJoinAdviceWaitKey.
  ///
  /// In es, this message translates to:
  /// **'Esperar'**
  String get coJoinAdviceWaitKey;

  /// No description provided for @coJoinAdviceWait.
  ///
  /// In es, this message translates to:
  /// **'Esta pantalla se actualiza sola cuando el kiosco termine'**
  String get coJoinAdviceWait;

  /// No description provided for @coJoinAdviceLeaveKey.
  ///
  /// In es, this message translates to:
  /// **'O irte'**
  String get coJoinAdviceLeaveKey;

  /// No description provided for @coJoinAdviceLeave.
  ///
  /// In es, this message translates to:
  /// **'Nada se pierde: la sesión sigue igual'**
  String get coJoinAdviceLeave;

  /// La presencia viva cambia el CONSEJO, nunca el permiso. Presencia que bloquea es un lease, y un kiosco sin batería a mitad de firma atascaría la salida hasta que expire el TTL.
  ///
  /// In es, this message translates to:
  /// **'No es un bloqueo. Puedes avanzar igual — el servidor decide, no este aviso. Solo te decimos lo que está pasando del otro lado.'**
  String get coJoinNotABlock;

  /// No description provided for @coJoinProceedAnyway.
  ///
  /// In es, this message translates to:
  /// **'Avanzar de todas formas'**
  String get coJoinProceedAnyway;

  /// No description provided for @coJoinPausedByOther.
  ///
  /// In es, this message translates to:
  /// **'Otro agente pausó esta salida hace {age}.'**
  String coJoinPausedByOther(String age);

  /// Sin actor identificable en el log no se afirma «otro agente».
  ///
  /// In es, this message translates to:
  /// **'Esta salida quedó pausada hace {age}.'**
  String coJoinPausedBySomeone(String age);

  /// abandonedReason es el dato que decide: «el cliente fue por su tarjeta» y «la unidad no arranca» llevan a acciones opuestas.
  ///
  /// In es, this message translates to:
  /// **'Motivo: «{reason}»'**
  String coJoinPausedReason(String reason);

  /// No description provided for @coJoinWhereItStoppedTitle.
  ///
  /// In es, this message translates to:
  /// **'Dónde quedó'**
  String get coJoinWhereItStoppedTitle;

  /// Hay una sola CheckoutSession por reserva (reservationId @unique): no existe transferir, reclamar ni desbloquear. Decirlo evita que el agente busque un botón de «tomar el control» que ninguna versión de esta app va a tener.
  ///
  /// In es, this message translates to:
  /// **'Continuar no le quita nada a nadie: la sesión es una sola y el registro guarda quién hizo qué.'**
  String get coJoinNoStealWhy;

  /// El barrido nocturno escribe `auto_flagged_stalled_at_<paso>` (scheduler:71). Decir «otro agente la pausó» sería inventar un culpable de algo que hizo un cron.
  ///
  /// In es, this message translates to:
  /// **'El sistema la marcó: lleva más de 4 h detenida. No la pausó nadie.'**
  String get coJoinPausedAutoStalled;

  /// No description provided for @coJoinPausedBySystem.
  ///
  /// In es, this message translates to:
  /// **'El sistema marcó esta salida hace {age}.'**
  String coJoinPausedBySystem(String age);

  /// «Qué se conserva» es la tercera pregunta de cada cara de la matriz 409 y 22C era la única que se había quedado sin responderla.
  ///
  /// In es, this message translates to:
  /// **'Se conserva: el cliente ya verificado y el paso en el que vas.'**
  String get coConflictVehicleKept;

  /// Línea de causa que se muestra SIEMPRE, también con la Bandeja en cero: sin ella el agente que acaba de terminar la inspección lee «falta la inspección completada» y no tiene nada que explique la brecha.
  ///
  /// In es, this message translates to:
  /// **'Este paso lo cierra el servidor cuando reciba el sello, no esta pantalla. Nada se pierde: puedes pausar y volver.'**
  String get coGuardWhyServer;

  /// Forma CORTA del chip, la que dibujan los marcos aprobados (20A). El chip vive con ~111 px utiles a 360 dp: la linea larga de `coPresenceLine` se corta en 19 caracteres y se come justo la SUPERFICIE, que es el proposito declarado del chip (a Diego le gritas desde la otra punta del patio; al kiosco hay que caminarle). Con el punto VIVO la edad es irrelevante —es ahora— asi que los dos datos que caben son nombre y superficie.
  ///
  /// In es, this message translates to:
  /// **'{name} · {surface}'**
  String coPresenceChipLive(String name, String surface);

  /// Forma corta del chip cuando el punto ya NO esta vivo (20C: «El kiosco · hace 38 s»). Ahi la noticia es la EDAD, no la superficie. La linea completa —nombre, superficie y edad— sigue llegando entera al lector de pantalla por `coPresenceChipSemantics`, que no tiene limite de ancho: nada se pierde para accesibilidad.
  ///
  /// In es, this message translates to:
  /// **'{name} · hace {age}'**
  String coPresenceChipAged(String name, String age);

  /// Estado de la fila «Tú» sin red. El latido es un POST: sin red no aterriza, y a los 45 s el agente deja de estar visible para las demas superficies.
  ///
  /// In es, this message translates to:
  /// **'Sin conexión'**
  String get coWhoIsHereYouOffline;

  /// La divulgacion NO puede afirmar «apareces con tu nombre» justo cuando es falso. Es el espejo exacto del defecto del vacio: la unica pantalla construida para explicar el reverso del latido seria, sin red, la unica que no puede sostener lo que dice.
  ///
  /// In es, this message translates to:
  /// **'Sin conexión tu latido no está llegando: en menos de un minuto dejas de aparecer para las demás superficies. Vuelves a aparecer solo al recuperar señal. Esto nunca reserva nada.'**
  String get coWhoIsHereDisclosureOffline;

  /// Complementa el subtitulo de la hoja cuando NO hay red y la lista viene vacia. La causa («sin red no se puede afirmar que alguien este ahora») ya la dice el subtitulo dos lineas mas arriba; repetirla seria la misma frase dos veces a ~100 px. Lo que falta decir es que el vacio tampoco autoriza la lectura contraria.
  ///
  /// In es, this message translates to:
  /// **'Y tampoco se puede leer como «no hay nadie»: otra superficie puede estar avanzando sin que lo veamos.'**
  String get coPresenceEmptyUnverifiable;
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
