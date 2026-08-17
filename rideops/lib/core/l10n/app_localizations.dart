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

  /// TODO H4: al integrar connectivity_plus y el auto-reintento, volver al copy del mockup 1C ('se reintentará al volver la señal'). Hoy el reintento es manual — no prometerlo.
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
