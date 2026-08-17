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
  String get changePasswordNextPin =>
      'Next: create your PIN to unlock quickly in the yard.';

  @override
  String get pinSetupTitle => 'Create your PIN';

  @override
  String get pinSetupSubtitle =>
      'You\'ll use it to unlock RideOps in the yard. 4 digits.';

  @override
  String get pinSetupConfirmTitle => 'Confirm your PIN';

  @override
  String get pinSetupConfirmSubtitle => 'Type it again to confirm.';

  @override
  String pinSetupStep(int step) {
    return 'Step $step of 2';
  }

  @override
  String get pinSetupMismatch => 'The PINs don\'t match. Start over.';

  @override
  String get pinBioOfferTitle => 'Enable fingerprint?';

  @override
  String get pinBioOfferBody =>
      'Unlock with your fingerprint, no PIN typing. Your PIN always keeps working.';

  @override
  String get pinBioEnable => 'Enable fingerprint';

  @override
  String get pinBioSkip => 'Not now';

  @override
  String get pinBioEnrollFailed =>
      'Couldn\'t enable fingerprint. You can keep using your PIN.';

  @override
  String get pinBioPrompt => 'Confirm your identity to unlock RideOps';

  @override
  String get pinBioKeyLabel => 'Unlock with fingerprint';

  @override
  String get keypadDeleteLabel => 'Delete digit';

  @override
  String pinDigitsProgress(int count) {
    return '$count of 4 digits';
  }

  @override
  String lockGreeting(String name) {
    return 'Hi, $name';
  }

  @override
  String get lockTitleGeneric => 'Unlock RideOps';

  @override
  String get lockSubtitle => 'Enter your PIN to continue';

  @override
  String lockWrongPin(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'Wrong PIN — $count attempts left',
      one: 'Wrong PIN — 1 attempt left',
    );
    return '$_temp0';
  }

  @override
  String get lockForgotPin => 'Forgot your PIN? Sign out';

  @override
  String get logoutButton => 'Sign out';

  @override
  String get tabHome => 'Home';

  @override
  String get tabSearch => 'Search';

  @override
  String get tabIncidents => 'Incidents';

  @override
  String get tabOutbox => 'Outbox';

  @override
  String get tabProfile => 'Profile';

  @override
  String outboxBadgeSemantics(int count) {
    return '$count pending to send';
  }

  @override
  String get shellPlaceholderBody => 'This section arrives in a later story.';

  @override
  String get locationChipAll => 'All';

  @override
  String locationChipSemantics(String location) {
    return 'Active location: $location. Tap to change.';
  }

  @override
  String get locationSheetTitle => 'Active location';

  @override
  String get locationSheetSubtitle => 'Filters queues, search and new captures';

  @override
  String get locationAllMine => 'All my locations';

  @override
  String get locationCurrentLabel => 'Current location';

  @override
  String get locationSheetError =>
      'Could not load your locations. Check the signal and try again.';

  @override
  String get cancelButton => 'Cancel';

  @override
  String get locationDeniedTitle => 'No access to this location';

  @override
  String locationDeniedBody(String location) {
    return 'Your account no longer has access to $location. Pick another location to keep working.';
  }

  @override
  String get locationDeniedBodyGeneric =>
      'Your account no longer has access to this location. Pick another location to keep working.';

  @override
  String get locationDeniedChangeButton => 'Change location';

  @override
  String get locationDeniedAdminNote =>
      'If you think this is a mistake, tell your administrator.';

  @override
  String get loadingLabel => 'Loading…';

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

  @override
  String locationChipDeniedSemantics(String location) {
    return 'Active location: $location. Access denied. Tap to change.';
  }

  @override
  String get ageMoment => 'moments';

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
    return 'Updated $age ago · refreshes itself';
  }

  @override
  String homeOfflineBanner(String age) {
    return 'No connection — showing data from $age ago. It will refresh itself when the signal returns.';
  }

  @override
  String homeStaleBanner(String age) {
    return 'Couldn\'t refresh — showing data from $age ago.';
  }

  @override
  String get homeErrorTitle => 'Couldn\'t load the board';

  @override
  String get forbiddenTitle => 'No access';

  @override
  String get heroTitle => 'For right now';

  @override
  String heroPartDepartures(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count pickups',
      one: '1 pickup',
    );
    return '$_temp0';
  }

  @override
  String heroPartDeparturesCapped(int count) {
    return '$count+ pickups';
  }

  @override
  String heroPartReturns(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count returns',
      one: '1 return',
    );
    return '$_temp0';
  }

  @override
  String heroPartIncidents(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count incidents',
      one: '1 incident',
    );
    return '$_temp0';
  }

  @override
  String get heroCalmFoot => 'Nothing pressing right now';

  @override
  String heroCutoffFoot(String time) {
    return 'as of $time';
  }

  @override
  String get tileActiveTitle => 'On rent';

  @override
  String tileActiveFoot(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count due today · see list ›',
      one: '1 due today · see list ›',
      zero: 'See list ›',
    );
    return '$_temp0';
  }

  @override
  String tileActiveSemantics(int count) {
    return 'On rent: $count. Tap to see the full list.';
  }

  @override
  String get tileLoanerTitle => 'Loaner';

  @override
  String tileLoanerFoot(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count need follow-up',
      one: '1 needs follow-up',
      zero: 'No follow-ups',
    );
    return '$_temp0';
  }

  @override
  String tileLoanerFootCapped(int count) {
    return '$count+ need follow-up';
  }

  @override
  String get tilePrecheckinTitle => 'Pre-checkin';

  @override
  String get tilePrecheckinFoot => 'Sent, not completed';

  @override
  String get queueIssueEscalations => 'Incidents';

  @override
  String get queueCheckout => 'Pickups (72 h)';

  @override
  String get queueReturns => 'Returns (72 h)';

  @override
  String get queuePrecheckin => 'Pre-checkin';

  @override
  String get queueLoanerAdvisorFollowup => 'Loaner follow-up';

  @override
  String get queueLoanerReady => 'Loaners ready';

  @override
  String get queueLoanerBillingReview => 'Loaner billing';

  @override
  String get queueLoanerReturns => 'Loaner returns';

  @override
  String get queueActive => 'On rent';

  @override
  String get seeAllButton => 'See all';

  @override
  String queueCountCapped(int count) {
    return '$count+';
  }

  @override
  String get calmRowTitle => 'No activity right now';

  @override
  String calmChipSemantics(String queue) {
    return '$queue: nothing pending. Tap to open the queue.';
  }

  @override
  String get emptyAllTitle => 'Yard at ease';

  @override
  String get emptyAllBody =>
      'Nothing pending in any queue right now. Pull down to refresh whenever you want.';

  @override
  String emptyAllQueuesLabel(int count) {
    return 'All $count queues at zero';
  }

  @override
  String cardToday(String time) {
    return 'Today $time';
  }

  @override
  String cardTomorrow(String time) {
    return 'Tomorrow $time';
  }

  @override
  String cardOverdueHours(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'Overdue $count h',
      one: 'Overdue 1 h',
    );
    return '$_temp0';
  }

  @override
  String cardOverdueMinutes(int count) {
    return 'Overdue $count min';
  }

  @override
  String get precheckinReady => 'Pre-checkin done';

  @override
  String get precheckinMissing => 'Pre-checkin missing';

  @override
  String get incidentOpen => 'Open';

  @override
  String get incidentUnderReview => 'Under review';

  @override
  String incidentReported(String time) {
    return 'Reported $time';
  }

  @override
  String get loanerFollowupPacket => 'Packet incomplete';

  @override
  String get loanerFollowupService => 'Service overdue';

  @override
  String get loanerFollowupBilling => 'Billing denied';

  @override
  String get loanerReadyChip => 'Ready for pickup';

  @override
  String advisorLabel(String name) {
    return 'Advisor: $name';
  }

  @override
  String queueListShowingFirst(int count) {
    return 'Showing the first $count — there may be more';
  }

  @override
  String queueListShowingOf(int shown, int total) {
    return 'Showing $shown of $total';
  }

  @override
  String get queueEmptyBody => 'Nothing in this queue right now.';

  @override
  String get searchFieldHint => 'Customer, reservation, plate or unit';

  @override
  String get searchFieldLabel => 'Search';

  @override
  String get searchClearLabel => 'Clear search';

  @override
  String get searchPrompt => 'Search reservations in your active location.';

  @override
  String searchNoResults(String query) {
    return 'No results for “$query”.';
  }

  @override
  String cardOpenInspectionSemantics(String name) {
    return '$name: open checkout inspection';
  }

  @override
  String get inspTitle => 'Checkout inspection';

  @override
  String inspProgressChip(int count) {
    return '$count of 8';
  }

  @override
  String get inspProgressDone => '8 of 8 ✓';

  @override
  String get angleFront => 'Front';

  @override
  String get angleRear => 'Rear';

  @override
  String get angleLeft => 'Left side';

  @override
  String get angleRight => 'Right side';

  @override
  String get angleFrontSeat => 'Front seat';

  @override
  String get angleRearSeat => 'Rear seat';

  @override
  String get angleDash => 'Dashboard';

  @override
  String get angleTrunk => 'Trunk';

  @override
  String get angleRequiredChip => 'Required';

  @override
  String get anglePending => 'Pending';

  @override
  String get angleCompressing => 'Compressing…';

  @override
  String get angleFailedRetry => 'Failed — tap to retry';

  @override
  String get angleQueued => 'In outbox';

  @override
  String get angleOnServer => 'Already on server';

  @override
  String get inspContinueMetrics => 'Continue to metrics';

  @override
  String get inspRequiredFootnote =>
      'Front and Rear are required; the rest adds evidence.';

  @override
  String get inspOfflineBanner =>
      'No connection. You can finish the whole inspection: everything stays in the outbox and will send once you reconnect.';

  @override
  String get inspOfflineChip => 'No signal';

  @override
  String inspLinkExpires(String time) {
    return 'This session\'s link expires at $time.';
  }

  @override
  String get inspLoadOffline =>
      'No connection. Starting an inspection needs signal once; after that everything works offline.';

  @override
  String get inspOutboxFull =>
      'The outbox is full. Connect to a network so it can drain before capturing more photos.';

  @override
  String camAnglePill(String angle, int n) {
    return '$angle · $n of 8';
  }

  @override
  String get camHintExterior => 'Frame the whole vehicle inside the corners';

  @override
  String get camHintInterior => 'Frame the whole area inside the corners';

  @override
  String get camFlash => 'Flash';

  @override
  String get camClose => 'Close';

  @override
  String get camShutter => 'Take photo';

  @override
  String get camErrorTitle => 'Could not open the camera';

  @override
  String get camErrorPermissionHint =>
      'Camera permission is denied. Enable it in the system Settings and try again.';

  @override
  String get langSpanish => 'Español';

  @override
  String get langEnglish => 'English';

  @override
  String get metricsTitle => 'Vehicle metrics';

  @override
  String get metricsOdometer => 'Odometer';

  @override
  String get metricsOdometerUnit => 'mi';

  @override
  String metricsPrevReading(String value) {
    return 'Last recorded reading: $value mi';
  }

  @override
  String get metricsOdometerLower =>
      'The reading is lower than the last recorded one. Double-check it — it will be sent as is.';

  @override
  String get metricsFuel => 'Fuel';

  @override
  String get fuelEmpty => 'Empty';

  @override
  String get fuelFull => 'Full';

  @override
  String get metricsCleanliness => 'Cleanliness';

  @override
  String get cleanDirty => 'Dirty';

  @override
  String get cleanSpotless => 'Spotless';

  @override
  String get metricsNotes => 'Notes (optional)';

  @override
  String get inspContinueSignature => 'Continue to signature';

  @override
  String get kioskBarLabel => 'Signing mode · lock paused';

  @override
  String get kioskBarExit => 'Exit: hold 3 s + PIN';

  @override
  String get kioskExitPinTitle => 'Exit signing mode';

  @override
  String get kioskExitPinBody => 'Enter your PIN to return to staff mode.';

  @override
  String kioskExitWrongPin(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'Wrong PIN — $count attempts left',
      one: 'Wrong PIN — 1 attempt left',
    );
    return '$_temp0';
  }

  @override
  String get kioskExitExhausted =>
      'Too many attempts. Going back to the previous step.';

  @override
  String kioskSignSubtitle(String reservation) {
    return 'Vehicle inspection · Reservation $reservation';
  }

  @override
  String get kioskSignPrompt =>
      'Sign to confirm you reviewed the vehicle\'s condition with the agent.';

  @override
  String get kioskSignHint => 'Sign here with your finger';

  @override
  String get kioskSignClear => 'Clear';

  @override
  String get kioskSignConfirm => 'Confirm signature';

  @override
  String summaryQueueTitle(int photos) {
    return '$photos photos · metrics · signature';
  }

  @override
  String get summaryQueueBadgeOffline => 'Will send on reconnect';

  @override
  String get summaryQueueBadgeOnline => 'Ready to send';

  @override
  String get summaryQueueMeta =>
      'Encrypted local storage · guaranteed send order';

  @override
  String get inspFinishOffline => 'Finish — will send on reconnect';

  @override
  String get inspFinishOnline => 'Finish and send';

  @override
  String get inspFinishQueued => 'Inspection placed in the outbox';

  @override
  String get alreadyCompletedTitle => 'This inspection is already complete';

  @override
  String get alreadyCompletedBody =>
      'Another screen closed it while you were working. Your pending items for this session were removed from the outbox — nothing duplicate will be sent.';

  @override
  String alreadyCompletedBodyAt(String time) {
    return 'Another screen closed it at $time while you were working. Your pending items for this session were removed from the outbox — nothing duplicate will be sent.';
  }

  @override
  String alreadyCompletedChip(String reservation) {
    return 'Reservation $reservation';
  }

  @override
  String get backToHome => 'Back to home';

  @override
  String get outboxTitle => 'Outbox';

  @override
  String get outboxDraining => 'Sending…';

  @override
  String outboxDrainProgress(int done, int total) {
    return '$done of $total sent';
  }

  @override
  String outboxDrainRemaining(String size) {
    return '~$size left';
  }

  @override
  String outboxItemPhoto(String angle) {
    return 'Photo · $angle';
  }

  @override
  String get outboxItemComplete => 'Inspection completion';

  @override
  String outboxItemMetaPhoto(String reservation, String size) {
    return '$reservation · checkout inspection · $size';
  }

  @override
  String outboxItemMetaComplete(String reservation) {
    return '$reservation · metrics + signature · goes last in its chain';
  }

  @override
  String get outboxStatusQueued => 'Queued';

  @override
  String get outboxStatusUploading => 'Uploading';

  @override
  String get outboxStatusWaitsPhotos => 'Waits for its photos';

  @override
  String get outboxStatusRejected => 'Rejected';

  @override
  String outboxAttempts(int count, String time) {
    return 'tried $count times · last $time';
  }

  @override
  String get outboxReasonAnglesMissing =>
      'The server rejected it: the front and rear angles are missing. Capture them and retry.';

  @override
  String get outboxReasonToken =>
      'The upload permit expired or was consumed. Retrying will request a new one with your session.';

  @override
  String get outboxReasonPhotoLost =>
      'The photo is no longer on this phone. You can only discard this item.';

  @override
  String get outboxReasonSessionGone =>
      'The checkout session no longer exists on the server.';

  @override
  String get outboxReasonNetwork =>
      'Could not send after several attempts. Retry when there is signal.';

  @override
  String get outboxReasonGeneric => 'The server rejected this item.';

  @override
  String outboxTechnicalDetail(String code, String message) {
    return 'Technical detail: $code · $message';
  }

  @override
  String get outboxActionOpenInspection => 'Open inspection';

  @override
  String get outboxActionDiscard => 'Discard';

  @override
  String outboxDeadBanner(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other:
          '$count items need your decision. Everything else keeps sending normally.',
      one:
          '1 item needs your decision. Everything else keeps sending normally.',
    );
    return '$_temp0';
  }

  @override
  String get outboxDiscardTitle => 'Discard this item?';

  @override
  String outboxDiscardBodyPhoto(String angle, String reservation) {
    return 'The photo ($angle) for $reservation will be deleted from this phone. It will need to be captured again. Anything already sent to the server is untouched.';
  }

  @override
  String outboxDiscardBodyComplete(String reservation) {
    return 'The inspection completion for $reservation will be deleted from this phone. The captured metrics and signature will be lost and must be redone. Photos already sent to the server are untouched.';
  }

  @override
  String get outboxDiscardConfirm => 'Yes, discard';

  @override
  String get outboxDiscardKeep => 'Keep in outbox';

  @override
  String get outboxEmptyTitle => 'All sent';

  @override
  String get outboxEmptyBody =>
      'Nothing is waiting. Anything you capture without signal will show up here and send on its own.';

  @override
  String outboxLastDrain(String time) {
    return 'Last send: $time';
  }

  @override
  String get outboxFullTitle => 'The outbox is full';

  @override
  String outboxFullBody(int count) {
    return '$count items waiting (phone limit). Nothing more fits — connect to a network so it drains and you can keep capturing.';
  }

  @override
  String outboxFullChip(int count, int max, String size) {
    return '$count of $max · ~$size waiting';
  }

  @override
  String get outboxFullCapturesPaused =>
      'New captures are paused until space is freed.';

  @override
  String get outboxSendNow => 'Send now';

  @override
  String get outboxSendNowNoNetwork => 'Send now (no signal)';

  @override
  String get logoutPendingTitle => 'Sign out?';

  @override
  String logoutPendingBody(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other:
          'You have $count items not sent; signing out deletes them from this phone.',
      one: 'You have 1 item not sent; signing out deletes it from this phone.',
    );
    return '$_temp0';
  }

  @override
  String get logoutAnyway => 'Sign out anyway';
}
