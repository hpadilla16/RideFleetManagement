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
  String get loginSubtitle => 'Yard operations';

  @override
  String get loginEmailLabel => 'Email';

  @override
  String get loginPasswordLabel => 'Password';

  @override
  String get loginButton => 'Sign in';

  @override
  String get loginButtonLoading => 'Signing in…';

  @override
  String get loginInvalidCredentials =>
      'Wrong email or password. Check and try again.';

  @override
  String get loginOffline =>
      'No internet connection. Signing in requires a connection — check the signal and tap Retry now.';

  @override
  String get loginRetryNow => 'Retry now';

  @override
  String get loginHelpLine =>
      'Trouble signing in? Ask your admin to reset your password';

  @override
  String loginVersionLine(String version, String env, String locale) {
    return 'v$version ($env) · $locale';
  }

  @override
  String get showPassword => 'Show password';

  @override
  String get hidePassword => 'Hide password';

  @override
  String get changePasswordChip => 'Required step';

  @override
  String get changePasswordTitle => 'Create your password';

  @override
  String get changePasswordBody =>
      'You signed in with a temporary password. For security, create your own before continuing.';

  @override
  String get currentPasswordLabel => 'Temporary password (current)';

  @override
  String get newPasswordLabel => 'New password';

  @override
  String policyRuleMinLength(int count) {
    return 'At least $count characters';
  }

  @override
  String get policyRuleLowercase => 'At least one lowercase letter';

  @override
  String get policyRuleUppercase => 'At least one uppercase letter';

  @override
  String get policyRuleDigit => 'At least one number';

  @override
  String get policyRuleSpecial => 'At least one symbol (e.g. ! # \$)';

  @override
  String get policyRuleDifferent => 'Different from the temporary password';

  @override
  String get changePasswordButton => 'Save and continue';

  @override
  String get changePasswordSaving => 'Saving…';

  @override
  String get changePasswordCurrentWrong =>
      'The temporary password is not correct. Check it or ask your admin for a new one.';

  @override
  String get changePasswordSuccessTitle => 'Password updated';

  @override
  String get changePasswordSuccessBody =>
      'Your session is still active — no need to sign in again.';

  @override
  String get changePasswordFootnote =>
      'The temporary session stays alive during this step';

  @override
  String get continueButton => 'Continue';

  @override
  String get homePlaceholderTitle => 'Signed in';

  @override
  String get homePlaceholderBody =>
      'The yard dashboard arrives in the next story.';

  @override
  String get logoutButton => 'Sign out';

  @override
  String get sessionExpired => 'Your session expired. Please sign in again.';

  @override
  String get locationDenied => 'You do not have access to that location.';

  @override
  String get errorConflictReloaded =>
      'Another screen advanced this session. State was reloaded.';

  @override
  String get errorRateLimited =>
      'Too many requests. Wait a moment and try again.';

  @override
  String get errorNoConnectionRetry =>
      'No internet connection. Check the signal and try again.';

  @override
  String get errorOffline => 'No connection. Saved to send later.';

  @override
  String get outboxDeadLetterTitle => 'Pending items with errors';

  @override
  String get retryButton => 'Retry';

  @override
  String get genericError => 'Something went wrong. Try again.';
}
