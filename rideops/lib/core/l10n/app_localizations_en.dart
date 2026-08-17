// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get appTitle => 'RideOps';

  @override
  String get loginTitle => 'Sign in';

  @override
  String get loginEmailLabel => 'Email';

  @override
  String get loginPasswordLabel => 'Password';

  @override
  String get loginButton => 'Sign in';

  @override
  String get loginInvalidCredentials => 'Wrong email or password';

  @override
  String get forcedPasswordChangeTitle => 'Change your temporary password';

  @override
  String get forcedPasswordChangeBody =>
      'You need to create your own password before using the app.';

  @override
  String get currentPasswordLabel => 'Current password';

  @override
  String get newPasswordLabel => 'New password';

  @override
  String get changePasswordButton => 'Change password';

  @override
  String get sessionExpired => 'Your session expired. Please sign in again.';

  @override
  String get locationDenied => 'You do not have access to that location.';

  @override
  String get errorConflictReloaded =>
      'Another screen advanced this session. State was reloaded.';

  @override
  String get errorRateLimited => 'Too many requests. Retrying…';

  @override
  String get errorOffline => 'No connection. Saved to send later.';

  @override
  String get outboxDeadLetterTitle => 'Pending items with errors';

  @override
  String get retryButton => 'Retry';

  @override
  String get genericError => 'Something went wrong. Try again.';
}
