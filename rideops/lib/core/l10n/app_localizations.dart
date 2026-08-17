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

  /// No description provided for @homePlaceholderTitle.
  ///
  /// In es, this message translates to:
  /// **'Sesión iniciada'**
  String get homePlaceholderTitle;

  /// No description provided for @homePlaceholderBody.
  ///
  /// In es, this message translates to:
  /// **'El tablero de patio llega en la siguiente historia.'**
  String get homePlaceholderBody;

  /// No description provided for @logoutButton.
  ///
  /// In es, this message translates to:
  /// **'Cerrar sesión'**
  String get logoutButton;

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
