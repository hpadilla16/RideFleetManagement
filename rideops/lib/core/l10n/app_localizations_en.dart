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
      'No internet connection. Check the signal and tap Retry now.';

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
  String get loginKioskRelogin =>
      'For security, please sign in again with your password.';

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
  String ageSeconds(int count) {
    return '$count s';
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
  String cardOpenCheckoutSemantics(String details) {
    return '$details: open checkout';
  }

  @override
  String get cardOpeningCheckoutChip => 'Opening…';

  @override
  String get cardOpeningCheckoutMeta => 'opening checkout…';

  @override
  String cardOpeningCheckoutSemantics(String details) {
    return '$details: opening checkout';
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
  String get odometerUnit => 'mi';

  @override
  String odometerValue(String value, String unit) {
    return '$value $unit';
  }

  @override
  String metricsPrevReading(String reading) {
    return 'Last recorded reading: $reading';
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

  @override
  String coTitle(String reservation) {
    return 'Checkout · $reservation';
  }

  @override
  String get coTitleNoNumber => 'Checkout';

  @override
  String get coPause => 'Pause';

  @override
  String coStepOf(int index, int total) {
    return 'Step $index of $total';
  }

  @override
  String get coSeeAllSteps => 'See every step';

  @override
  String coStepsSheetTitle(int total) {
    return '$total steps + alternate exit';
  }

  @override
  String coStepsSheetSub(String age) {
    return 'State reported by the server · updated $age ago';
  }

  @override
  String get coSheetClose => 'Close';

  @override
  String get coPhaseConfirm => 'Confirm';

  @override
  String get coPhaseTerms => 'T&C';

  @override
  String get coPhasePayment => 'Payment';

  @override
  String get coPhaseInspection => 'Inspection';

  @override
  String get coPhaseClosing => 'Closing';

  @override
  String get coStepConfirming => 'Confirm customer and vehicle';

  @override
  String get coStepTcPending => 'Terms and conditions';

  @override
  String get coStepTcSigned => 'Terms signed';

  @override
  String get coStepPaymentPending => 'Charge on terminal';

  @override
  String get coStepPaid => 'Payment complete';

  @override
  String get coStepInspectionHandoff => 'Hand off to inspection';

  @override
  String get coStepInspectionInProgress => 'Inspection in progress';

  @override
  String get coStepCustomerSignPending => 'Customer signature';

  @override
  String get coStepFinalizing => 'Generating contract';

  @override
  String get coStepClosed => 'Delivered';

  @override
  String get coStepCancelled => 'Cancelled';

  @override
  String get coStepCancelledHint => 'Alternate exit from any non-terminal step';

  @override
  String coStepUnknown(String step) {
    return 'Step reported by the server: $step';
  }

  @override
  String get coStepPending => 'Pending';

  @override
  String get coStepInProgress => 'In progress';

  @override
  String coStepDoneByYou(String time) {
    return 'Completed by you · $time';
  }

  @override
  String coStepDoneKiosk(String time) {
    return 'Completed on the kiosk · $time';
  }

  @override
  String coStepDoneOtherAgent(String time) {
    return 'Completed by another agent · $time';
  }

  @override
  String coStepDone(String time) {
    return 'Completed · $time';
  }

  @override
  String get coGuardTcCompleted => 'Waiting on: customer\'s T&C signature';

  @override
  String get coGuardPayment => 'Waiting on: recorded payment';

  @override
  String get coGuardInspection => 'Waiting on: completed inspection';

  @override
  String get coGuardSignature => 'Waiting on: customer\'s signature';

  @override
  String get coSurfaceKiosk => 'kiosk';

  @override
  String get coSurfaceCounter => 'counter';

  @override
  String get coSurfaceRideops => 'another phone';

  @override
  String get coSurfaceCustomer => 'customer\'s phone';

  @override
  String get coSurfaceOther => 'another surface';

  @override
  String coPresenceLine(String name, String surface, String age) {
    return '$name is in this session · $surface · $age ago';
  }

  @override
  String coPresenceMore(int count) {
    return '+$count';
  }

  @override
  String coAdvancedKiosk(String step, String age) {
    return '“$step” was completed on the kiosk $age ago.';
  }

  @override
  String coAdvancedOtherAgent(String step, String age) {
    return '“$step” was completed by another agent $age ago.';
  }

  @override
  String coAdvancedOtherSurface(String step, String age) {
    return '“$step” was completed on another surface $age ago.';
  }

  @override
  String coAdvancedNow(String step) {
    return 'You are now on: $step.';
  }

  @override
  String get coAdvancedSeeChanged => 'See what changed';

  @override
  String coStaleView(String age) {
    return 'seen $age ago';
  }

  @override
  String coOfflineBanner(String age) {
    return 'No connection. This is the last thing the server reported $age ago — it may have changed on another surface.';
  }

  @override
  String get coBlockedOfflineWhy =>
      'Moving a step forward needs the server\'s confirmation. With no signal nothing is guessed: we wait.\nNothing from this step goes to the Outbox.';

  @override
  String get coBlockedOfflineShort =>
      'No connection: the server confirms the advance.';

  @override
  String get coTransitionWhy =>
      'The server confirms the advance; if another surface already did it, this screen updates on its own.';

  @override
  String get coPauseTitle => 'Save and pause this checkout?';

  @override
  String coPauseSub(int index, int total) {
    return 'The session stays saved on step $index of $total. Nothing is lost.';
  }

  @override
  String get coPauseSubUnknownStep =>
      'The session stays saved on the step the server reports. Nothing is lost.';

  @override
  String get coPauseKeeps =>
      'Kept: verified customer and vehicle, the live T&C code, and the record of who did what.';

  @override
  String get coPauseWarn =>
      'A teammate (or the kiosk) can pick it up from where it stands. When you come back, you enter the step the server reports, not the one you left.';

  @override
  String get coPauseConfirm => 'Save and pause';

  @override
  String get coPauseStay => 'Stay here';

  @override
  String get coPauseFailed =>
      'Could not pause. Check the connection and try again.';

  @override
  String get coTerminalClosedTitle => 'This checkout is already closed';

  @override
  String get coTerminalCancelledTitle => 'This checkout was cancelled';

  @override
  String get coTerminalBody =>
      'This session is already terminal: it takes no more steps.';

  @override
  String coTerminalDoneKiosk(String time) {
    return 'It was completed at the kiosk at $time. There is nothing left to do here.';
  }

  @override
  String coTerminalDoneByYou(String time) {
    return 'You closed it at $time. There is nothing left to do here.';
  }

  @override
  String coTerminalDoneOtherAgent(String time) {
    return 'Another agent closed it at $time. There is nothing left to do here.';
  }

  @override
  String coTerminalDoneAt(String time) {
    return 'It was completed at $time. There is nothing left to do here.';
  }

  @override
  String coTerminalCancelledByYou(String time) {
    return 'You cancelled it at $time. This session takes no more steps.';
  }

  @override
  String coTerminalCancelledKiosk(String time) {
    return 'It was cancelled at the kiosk at $time. This session takes no more steps.';
  }

  @override
  String coTerminalCancelledOtherAgent(String time) {
    return 'Another agent cancelled it at $time. This session takes no more steps.';
  }

  @override
  String coTerminalCancelledAt(String time) {
    return 'It was cancelled at $time. This session takes no more steps.';
  }

  @override
  String coTerminalContractRequested(String time) {
    return 'The contract email was requested at $time.';
  }

  @override
  String get coTerminalByYou => 'You';

  @override
  String get coTerminalByKiosk => 'At the kiosk';

  @override
  String get coTerminalByOtherAgent => 'Another agent';

  @override
  String get coTerminalByOtherSurface => 'Another surface';

  @override
  String get coTerminalBackToList => 'Back to the list';

  @override
  String get coTerminalWhy =>
      'If you think it closed by mistake, open the reservation: it cannot be reopened from here.';

  @override
  String get coTerminalLogTitle => 'Session log';

  @override
  String get coExit => 'Exit';

  @override
  String get coNoSessionTitle => 'No checkout session yet';

  @override
  String get coNoSessionBody =>
      'This reservation has no open session yet. It starts from the departures queue on Home.';

  @override
  String get coLoadFailedTitle => 'Could not open the checkout';

  @override
  String get coConflictEntryGuardTitle => 'A previous step is missing';

  @override
  String get coConflictVehicleTitle => 'The vehicle is no longer free';

  @override
  String get coConflictGenericTitle => 'The server refused the advance';

  @override
  String get coConflictSwapTitle => 'The server refused the vehicle change';

  @override
  String get coConflictDismiss => 'Got it';

  @override
  String coPickupToday(String time) {
    return 'Departs today $time';
  }

  @override
  String coPickupOn(String date, String time) {
    return 'Departs $date $time';
  }

  @override
  String get coPrecheckinReady => 'Pre-check-in done';

  @override
  String get coPrecheckinPending => 'Pre-check-in pending';

  @override
  String coOdometer(String km) {
    return 'Odometer $km km';
  }

  @override
  String get coExitWithoutPausing => 'Leave without pausing';

  @override
  String get coExitWithoutPausingWhy =>
      'Nothing gets locked: the session stays as it is and the yard can pick it up from another surface.';

  @override
  String get coPauseNeedsNetwork =>
      'Pausing needs a connection: it is a note saved on the server. With no signal you can still leave.';

  @override
  String get coStampsTitle => 'What the server already has';

  @override
  String get coStampTc => 'T&C signature';

  @override
  String get coStampPayment => 'Payment recorded';

  @override
  String get coStampInspection => 'Inspection completed';

  @override
  String get coStampSignature => 'Customer signature';

  @override
  String coStampDone(String time) {
    return 'Done · $time';
  }

  @override
  String get coStampPending => 'Pending';

  @override
  String coSessionAgeLabel(String age) {
    return 'State from $age ago';
  }

  @override
  String get coEntryNoVehicleTitle =>
      'This reservation has no vehicle assigned';

  @override
  String get coEntryNoVehicleBody =>
      'You cannot hand over without a unit. Assigning the vehicle to the reservation is still done from the desk; once it is assigned, tap the card again.';

  @override
  String get coEntryVehicleConflictTitle =>
      'That unit is already on another rental';

  @override
  String get coEntryVehicleConflictBody =>
      'The server blocked it so the same unit is not handed over twice. Changing the vehicle on the reservation — or closing the other rental — is still done from the desk.';

  @override
  String coEntryConflictWith(String reservation) {
    return 'Conflicting reservation: $reservation';
  }

  @override
  String coEntrySearchReservation(String reservation) {
    return 'Search $reservation';
  }

  @override
  String get coEntryPrecheckinTitle => 'The customer pre-check-in is missing';

  @override
  String get coEntryPrecheckinBody =>
      'This branch requires the customer pre-check-in before the checkout can start.';

  @override
  String get coEntrySendPrecheckinLink => 'Send pre-check-in to the customer';

  @override
  String get coEntrySendingPrecheckinLink => 'Sending…';

  @override
  String get coEntryPrecheckinLinkSent =>
      'Done: the pre-check-in link went to the customer\'s email. Tap the card again once they complete it.';

  @override
  String coEntryPrecheckinLinkFailed(String reason) {
    return 'Could not send the link. $reason';
  }

  @override
  String get coEntryPrecheckinLinkCooldown =>
      'That link was just sent: the server will not send another so soon. Ask the customer to check their email (and spam) before retrying.';

  @override
  String get coEntryPrecheckinNoEmail =>
      'The reservation has no customer email, so there is nowhere to send it. Add it from the desk, or take the pre-check-in over the phone.';

  @override
  String get coEntryPrecheckinDeskNote =>
      'Capturing the details at the counter is still done from the desk: this app does not have that form yet.';

  @override
  String get coEntryReservationUntouched =>
      'The reservation was not touched. As soon as the pre-check-in is done, the card unblocks by itself.';

  @override
  String get coEntryAgeTitle => 'Age rules do not allow this hand-over';

  @override
  String get coEntryAgeBody =>
      'The branch blocks this departure under its age policy.';

  @override
  String get coEntryAgeDeskNote =>
      'The date of birth is fixed on the reservation, from the desk. If the rule itself is wrong, your supervisor changes it in the branch settings.';

  @override
  String get coEntryScopeChangedTitle => 'Opening was interrupted';

  @override
  String get coEntryScopeChangedBody =>
      'Your location or your session changed while the checkout was opening, so the server\'s answer no longer matches what you see.';

  @override
  String get coEntryScopeChangedFoot =>
      'The session may have been created. Tap the card again: if it exists, it resumes.';

  @override
  String get coEntryOfflineTitle => 'No connection to open the checkout';

  @override
  String get coEntryOfflineBody =>
      'Opening a checkout needs the server to confirm it once. It is not queued in the Outbox: tap the card again when there is signal.';

  @override
  String get coEntryConnectionLostTitle =>
      'The connection dropped while opening';

  @override
  String get coEntryConnectionLostBody =>
      'The request left the phone but the server did not answer in time, so the app cannot tell whether the checkout was opened.';

  @override
  String get coEntryConnectionLostFoot =>
      'The session may have been created. Tap the card again when you have signal: if it exists, it resumes.';

  @override
  String get coEntryNotReadyTitle => 'One moment';

  @override
  String get coEntryNotReadyBody =>
      'The app is still loading your active location. Try again in a second.';

  @override
  String get coEntryNoSessionCreated => 'No checkout session was created.';

  @override
  String coEntryServerSaid(String message) {
    return 'The server said: $message';
  }

  @override
  String get coEntryClose => 'Close';

  @override
  String get coConfirmCustomer => 'Customer';

  @override
  String get coConfirmVehicle => 'Vehicle';

  @override
  String get coConfirmVerified => 'Verified';

  @override
  String get coConfirmMissingPill => 'Missing data';

  @override
  String get coConfirmConflictPill => 'In conflict';

  @override
  String get coConfirmName => 'Name';

  @override
  String get coConfirmLicense => 'License';

  @override
  String coConfirmLicenseWithExpiry(String number, String date) {
    return '$number · expires $date';
  }

  @override
  String get coConfirmPhone => 'Phone';

  @override
  String get coConfirmPrecheckin => 'Pre-check-in';

  @override
  String get coConfirmPrecheckinDone => 'Completed';

  @override
  String coConfirmPrecheckinDoneAt(String time) {
    return 'Completed $time';
  }

  @override
  String get coConfirmPrecheckinPending => 'Pending';

  @override
  String get coConfirmMissingValue => 'Not captured';

  @override
  String get coConfirmUnit => 'Unit';

  @override
  String get coConfirmOdometerLabel => 'Odometer';

  @override
  String get coConfirmVehicleAvailable => 'Available';

  @override
  String get coConfirmChangeVehicle => 'Change vehicle';

  @override
  String get coConfirmCta => 'Continue to T&C';

  @override
  String get coConfirmFieldName => 'the name';

  @override
  String get coConfirmFieldLicense => 'the license';

  @override
  String get coConfirmFieldPhone => 'the phone';

  @override
  String get coConfirmFieldJoin => 'and';

  @override
  String coConfirmBlockedWhy(String fields) {
    return 'The customer\'s $fields are missing. They are captured at the counter or through the customer\'s pre-check-in; this screen updates itself.';
  }

  @override
  String get coConfirmRecheck => 'Refresh customer data';

  @override
  String get coConfirmRecheckPending => 'Asking the server…';

  @override
  String coConfirmRecheckedStill(String fields) {
    return 'Checked just now: the server still doesn\'t have $fields.';
  }

  @override
  String get coConfirmCheckingPill => 'Checking';

  @override
  String get coConfirmCheckingValue => 'Checking…';

  @override
  String get coConfirmCheckingWhy => 'Checking the customer\'s record…';

  @override
  String get coConfirmUnknownPill => 'Not checked';

  @override
  String get coConfirmUnknownValue => 'Could not be checked';

  @override
  String get coConfirmUnreachableWhy =>
      'The customer\'s record could not be checked, so their identity cannot be confirmed. This says nothing about what data the server has.';

  @override
  String coConfirmUnreachableServer(String message) {
    return 'The server replied: $message';
  }

  @override
  String get coConfirmRetryLookup => 'Retry the lookup';

  @override
  String get coConfirmRetryStillUnreachable =>
      'Retried just now: the lookup still isn\'t getting through.';

  @override
  String get coDeclineTitle => 'Customer declines insurance';

  @override
  String get coDeclineOff => 'Off · standard coverage is charged';

  @override
  String get coDeclineOn => 'On · the addendum is added';

  @override
  String get coDeclineLocked =>
      'Terms are already signed: the insurance addendum can no longer change here';

  @override
  String get coDeclineNeedsNetwork =>
      'No connection: this flag is recorded by the server';

  @override
  String get coDeclineConsequence =>
      'The coverage-decline addendum will be added to the terms the customer signs and to the contract PDF. You can turn it off while the terms are unsigned.';

  @override
  String get coDeclineSignedNote =>
      'The customer already signed the terms with this addendum. To change it, the contract is adjusted at the counter.';

  @override
  String get coConflictSwapCta => 'Pick another vehicle';

  @override
  String get coConflictSwapWhy =>
      'Nothing was lost: after changing the unit you are still on step 1 with the customer already verified.';

  @override
  String get coSwapTitle => 'Change vehicle';

  @override
  String coSwapSub(String age) {
    return 'Available per the server · $age ago';
  }

  @override
  String get coSwapSubLoading => 'Asking the server which units are free…';

  @override
  String get coSwapSameGroup => 'Same class';

  @override
  String get coSwapOtherGroup => 'Different class · the rate may change';

  @override
  String get coSwapCurrentReason =>
      'Current unit · a unit cannot be swapped for itself';

  @override
  String get coSwapCurrentCommitted =>
      'Current unit · the server reports it committed to another rental';

  @override
  String get coSwapLockedCause =>
      'This session\'s inspection already started: from there on the unit cannot be changed.';

  @override
  String get coSwapDoubleBookedCause =>
      'That unit is already reserved for this same window.';

  @override
  String get coSwapTerminalCause => 'That unit can no longer be rented.';

  @override
  String coSwapConfirm(String unit) {
    return 'Switch to $unit';
  }

  @override
  String get coSwapConfirmNone => 'Pick a unit';

  @override
  String get coSwapCancel => 'Cancel';

  @override
  String get coSwapEmpty =>
      'The server reports no other free units for this window.';

  @override
  String get coSwapNeedsNetwork =>
      'Changing the unit needs a connection: the server makes the change on the reservation and the contract.';

  @override
  String get coQrSemanticLabel => 'QR code to sign the terms';

  @override
  String get coTermsInstruction =>
      'Have the customer scan it with their phone camera to sign.';

  @override
  String get coTermsExpiresIn => 'Expires in';

  @override
  String get coTermsExpired => 'Expired';

  @override
  String get coTermsPresent => 'Show to customer (full screen)';

  @override
  String get coTermsWaiting =>
      'Waiting for the customer\'s signature. This screen updates itself.';

  @override
  String get coTermsReissue => 'Generate a new code';

  @override
  String get coTermsReissueWhy =>
      'If the live code has more than 2 minutes left, the server returns the same one: the customer can keep using the QR they already have.';

  @override
  String get coTermsReused =>
      'It is still the same code: the live one has more than 2 minutes left and the server reuses it. If the customer already scanned it, they do not have to scan again.';

  @override
  String get coTermsReissued =>
      'New code ready. The previous one stopped working.';

  @override
  String coTermsExpiredBanner(String time) {
    return 'The code expired at $time. Nothing was lost — generate a new one and the customer signs just the same.';
  }

  @override
  String get coTermsExpiredOverlay => 'Code expired';

  @override
  String get coTermsExpiredWhy =>
      'The new code lasts another 15 minutes. If the customer had already opened the previous one, they will have to open the new one.';

  @override
  String get coTermsMinting => 'Asking the server for the code…';

  @override
  String get coTermsMintFailed => 'The code could not be issued.';

  @override
  String get coTermsOfflineWhy =>
      'The server issues the code: with no connection there is no QR to show.';

  @override
  String get coTermsSignedTitle => 'Terms signed';

  @override
  String coTermsSignedBody(String name, String time) {
    return '$name signed at $time. You can move on to payment.';
  }

  @override
  String coTermsSignedBodyNoName(String time) {
    return 'The terms were signed at $time. You can move on to payment.';
  }

  @override
  String get coTermsRecord => 'Record';

  @override
  String get coTermsRecordConfirmed => 'Confirmed by the server';

  @override
  String get coTermsRecordSigned => 'Signed';

  @override
  String get coTermsRecordAddenda => 'Addenda';

  @override
  String get coTermsAddendaNone => 'None (insurance accepted)';

  @override
  String get coTermsAddendaDecline => 'Coverage-decline addendum';

  @override
  String get coTermsCta => 'Continue to payment';

  @override
  String get coTermsCtaWhy =>
      'This button only exists because the server already has the signature on record.';

  @override
  String get coPresentInstruction =>
      'Scan this code with your phone camera to read and sign the terms.';

  @override
  String get coPresentHelp => 'Trouble scanning? The agent can help you.';

  @override
  String get coPresentExit => 'Exit presentation';

  @override
  String coPresentSubtitle(String number) {
    return 'Rental terms · Reservation $number';
  }

  @override
  String get coPresentSubtitleNoNumber => 'Rental terms';

  @override
  String coPresentClosingSoon(String mmss) {
    return '$mmss left — if it expires, the agent issues another one right away.';
  }

  @override
  String get coInspWhatTitle => 'What gets captured here';

  @override
  String get coInspWhatParts => '3 parts';

  @override
  String get coInspRowPhotos => 'Photos';

  @override
  String get coInspWhatPhotos => '8 angles · Front and Rear required';

  @override
  String get coInspRowCondition => 'Condition';

  @override
  String get coInspWhatMetrics => 'Odometer, fuel, cleanliness and notes';

  @override
  String get coInspRowSignature => 'Signature';

  @override
  String get coInspWhatSignature =>
      'The customer signs the walk-around on this phone';

  @override
  String get coInspOfflineNote =>
      'Photos can be taken with no signal: they stay in the outbox and send themselves once you reconnect. The step moves on when the server receives them.';

  @override
  String get coInspLastReading => 'Last reading';

  @override
  String coInspPaidPill(String time) {
    return 'Paid $time';
  }

  @override
  String get coInspStartCta => 'Start inspection';

  @override
  String get coInspStartWhy =>
      'Starting marks the inspection as in progress on the server. You can pause the checkout at any time without losing photos.';

  @override
  String get coInspPhotosStep => 'Inspection · photos';

  @override
  String get coInspMetricsStep => 'Inspection · details';

  @override
  String get coInspSummaryStep => 'Inspection · review and send';

  @override
  String get coInspRequiredWhy =>
      'Front and Rear are done. The rest adds evidence and can be captured after the details.';

  @override
  String inspPhotoQueued(String time) {
    return '$time · in outbox';
  }

  @override
  String get inspPhotoSent => 'Sent to the server';

  @override
  String get inspPhotoDead => 'Didn\'t reach the server';

  @override
  String coInspLocalDoneTitle(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other:
          'The inspection is complete on this phone. $count photos and the closing record are still queued; they send themselves once you reconnect.',
      one:
          'The inspection is complete on this phone. 1 photo and the closing record are still queued; they send themselves once you reconnect.',
      zero:
          'The inspection is complete on this phone. The closing record is still queued; it sends itself once you reconnect.',
    );
    return '$_temp0';
  }

  @override
  String get coInspLocalDoneSending =>
      'The inspection is complete on this phone. It is sending now; the step moves on when the server receives it.';

  @override
  String coInspServerPhotos(int count) {
    return '$count of 8 received';
  }

  @override
  String get coInspRowInspection => 'Inspection';

  @override
  String coInspReceivedAt(String time) {
    return 'Received $time';
  }

  @override
  String get coInspContinueSign => 'Continue to signature and close';

  @override
  String get coInspBlockedWhy =>
      'The server closes this step when it receives the inspection — this screen can\'t. Nothing is lost: you can pause the checkout and come back.';

  @override
  String coOpenOutbox(int count) {
    return 'Open outbox ($count)';
  }

  @override
  String coOpenOutboxDead(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'Open outbox ($count failures)',
      one: 'Open outbox (1 failure)',
    );
    return '$_temp0';
  }

  @override
  String coInspRequiredDeadTitle(String angle) {
    return 'The $angle photo couldn\'t be sent and it\'s required. Without it the server will reject the inspection close.';
  }

  @override
  String coInspRetakeCta(String angle) {
    return 'Retake $angle';
  }

  @override
  String get coInspRetakeWhy =>
      'Retaking it automatically retries the inspection close.';

  @override
  String get coInspCompleteDeadTitle =>
      'The inspection close couldn\'t be sent. The reason and the decision you need are in the outbox.';

  @override
  String get coInspRequiredAnglesTitle => 'Required angles';

  @override
  String coInspRequiredMissingPill(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count missing',
      one: '1 missing',
    );
    return '$_temp0';
  }

  @override
  String coInspAnglesFailedChip(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count failed',
      one: '1 failed',
    );
    return '$_temp0';
  }

  @override
  String get coInspDoneTitle => 'Check-out inspection';

  @override
  String get coInspSignatureTitle => 'Customer signature';

  @override
  String get coInspSignedRow => 'Signed by';

  @override
  String coSignFromInspection(String name) {
    return '$name · at the end of the inspection';
  }

  @override
  String get coSignAlreadyBanner =>
      'The customer already signed, so there\'s no need to ask again. All that\'s left is closing the handover.';

  @override
  String get coInspCloseCta => 'Continue to closing';

  @override
  String get coInspCloseWhy =>
      'The server already has the inspection and the signature. This button moves on to closing; the contract is generated once the hand-over is closed.';

  @override
  String get coHandoffTitle => 'Turn the phone to the customer';

  @override
  String coHandoffBody(String name, String vehicle) {
    return '$name is about to sign for the handover of the $vehicle.';
  }

  @override
  String get coHandoffBodyGeneric =>
      'The customer is about to sign for the handover of the vehicle.';

  @override
  String get coHandoffRuleLock =>
      'The app locks onto the signature: no exit, no other screen.';

  @override
  String get coHandoffRuleExit =>
      'To exit without signing: hold the top bar for 3 s and enter your PIN.';

  @override
  String get coHandoffRulePin =>
      'Three wrong PINs and the app locks; you\'ll have to sign back in.';

  @override
  String coHandoffRuleBrand(String tenant) {
    return 'The customer sees the screen in Spanish or English, branded as $tenant.';
  }

  @override
  String get coHandoffRuleBrandNoTenant =>
      'The customer sees the screen in Spanish or English, with no platform branding.';

  @override
  String get coRetainedNote =>
      'The customer already signed on this phone, but the server hasn\'t confirmed it yet. The stroke is still here: you don\'t have to ask them again.';

  @override
  String get coRetryWithSignature => 'Retry with the signature they gave';

  @override
  String get coRetryWithSignatureWhy =>
      'We send the SAME stroke the customer left a moment ago. It lives only in this phone\'s memory and never goes into the outbox.';

  @override
  String get coHandoffCta => 'Hand to the customer';

  @override
  String get coHandoffWhy =>
      'The signature is written to the agreement when confirmed. If the customer backs out, exit with your PIN and the step stays as it is.';

  @override
  String get coHandoffOfflineBlocked =>
      'The signature can\'t be collected offline: it\'s written to the agreement at that moment, not later.';

  @override
  String kioskSignSubtitleCheckout(String reservation) {
    return 'Vehicle handover · Reservation $reservation';
  }

  @override
  String get kioskSignPromptCheckout =>
      'Sign to confirm you are receiving the vehicle and accept the rental agreement.';

  @override
  String kioskSignPlate(String plate) {
    return 'Plate $plate';
  }

  @override
  String get coSignReceived =>
      'Signature received. You can take the phone back.';

  @override
  String get coCloseStep1 => 'Signature saved to the agreement';

  @override
  String get coCloseStep2 => 'Generating the agreement';

  @override
  String get coCloseStep3 => 'Recording the handover';

  @override
  String coCloseLegWaiting(int index, int total) {
    return 'Step $index of $total · pending';
  }

  @override
  String get coClosingCta => 'Closing…';

  @override
  String get coClosingWhy =>
      'Don\'t close the app: closing takes three server confirmations and you\'re on the second.';

  @override
  String get coCloseRetry => 'Retry closing';

  @override
  String get coCloseRetryWhy =>
      'This leg can be retried: the session is still open and nothing you captured was lost.';

  @override
  String get coAlreadySignedTitle => 'The customer already signed';

  @override
  String coAlreadySignedBody(String time) {
    return 'They signed at the end of the inspection, at $time. No need to hand them the phone again.';
  }

  @override
  String coAlreadySignedBodyOther(String time) {
    return 'The signature was recorded at $time. No need to hand them the phone again.';
  }

  @override
  String coAlreadySignedChip(String time) {
    return 'Signature on the agreement · $time';
  }

  @override
  String get coSignedDocTitle => 'What was signed';

  @override
  String get coSignedSigner => 'Signer';

  @override
  String get coSignedSignerUnknown => 'No name was recorded';

  @override
  String get coSignedDocument => 'Document';

  @override
  String coSignedDocumentValue(String number) {
    return 'Rental agreement $number';
  }

  @override
  String get coSignedDocumentValueNoNumber => 'Rental agreement';

  @override
  String get coResignLink => 'Ask for the signature again';

  @override
  String get coResignWarning =>
      'The new signature REPLACES the one already on the agreement. Only use this if the previous one isn\'t valid.';

  @override
  String get coResignTitle => 'Replace the saved signature?';

  @override
  String get coResignConfirm => 'Yes, ask again';

  @override
  String get coCloseCta => 'Close the handover';

  @override
  String get coCloseCtaWhy =>
      'The handover is recorded on the reservation and the agreement is generated.';

  @override
  String get coClosedTitle => 'Handover closed';

  @override
  String get coClosedTitleUnverified => 'Checkout closed';

  @override
  String get coRecordHandoverUnverifiedNotice =>
      'The close went through, but we couldn\'t confirm it on the reservation. Check it before you call the handover done.';

  @override
  String get coBeforeTheyGoTitle => 'Before they leave';

  @override
  String get coBeforeKeysLabel => 'Keys';

  @override
  String get coBeforeKeys => 'Hand over the keys and the registration card';

  @override
  String get coBeforeReturnLabel => 'Return';

  @override
  String get coBeforeScopeNote =>
      'The departure fuel level and odometer are stored in the inspection record, not on this screen.';

  @override
  String get coRecordTitle => 'Record';

  @override
  String get coRecordPillRecorded => 'Recorded';

  @override
  String get coRecordPillChecking => 'Checking';

  @override
  String get coRecordPillUnverified => 'Not confirmed';

  @override
  String get coRecordRowSession => 'Session';

  @override
  String coRecordSessionClosedAt(String time) {
    return 'Closed $time';
  }

  @override
  String get coRecordSignatureLabel => 'Signature';

  @override
  String get coRecordContractLabel => 'Agreement';

  @override
  String coRecordEmailRequested(String time) {
    return 'Email delivery was requested at $time';
  }

  @override
  String get coRecordEmailNotRequested => 'No email delivery on record';

  @override
  String get coRecordHandoverLabel => 'Handover';

  @override
  String coRecordHandoverRecorded(String time) {
    return 'Recorded on the reservation · $time';
  }

  @override
  String get coRecordHandoverChecking => 'Checking on the reservation…';

  @override
  String get coRecordHandoverUnconfirmed => 'Not confirmed';

  @override
  String get coRecordHandoverCheckingWhy =>
      'Nothing is blocked: you can leave. The check isn\'t lost — it stays on the session.';

  @override
  String get coRecordHandoverRecheck => 'Check again';

  @override
  String get coRecordHandoverRecheckWhy =>
      'This is a lookup, not a retry of the close: the session is already closed and can\'t be closed twice.';

  @override
  String get coBackHome => 'Back to home';

  @override
  String get coSessionDetail => 'See session detail';

  @override
  String get coBackToOutcome => 'Back to the closing summary';

  @override
  String get coCloseFailedStepline => 'Closing hit a problem';

  @override
  String get coCloseFailedTitle =>
      'The checkout closed, but the server did not record the handover. Someone at the counter needs to review this reservation.';

  @override
  String get coCloseNotRecordedTitle =>
      'The checkout closed, but the reservation was not marked as handed over. Someone at the counter needs to review it.';

  @override
  String coCloseFailedStep(String time) {
    return 'Rejected at $time';
  }

  @override
  String get coCloseReasonTitle => 'Reason';

  @override
  String get coServerReasonLabel => 'Server response';

  @override
  String get coCloseReasonPill => 'From the server';

  @override
  String get coCloseVerifiedPill => 'Checked on the reservation';

  @override
  String get coCloseVerifiedTitle => 'What we checked';

  @override
  String get coCloseVerifiedLabel => 'Reservation status';

  @override
  String get coCloseNotRecordedReason =>
      'We checked the reservation after closing and it still doesn\'t record the handover. The server gave no reason.';

  @override
  String get coCloseNoRetry =>
      'This session is already closed, so it can\'t be retried from here. Nothing you captured was lost.';

  @override
  String get coCopyProblem => 'Copy the details for the counter';

  @override
  String get coCopiedProblem => 'Details copied to the clipboard';

  @override
  String get coHoldKeys =>
      'Don\'t hand over the keys until the counter confirms.';

  @override
  String get coCloseUnknownStepline => 'Closing unconfirmed';

  @override
  String get coCloseUnknownTitle =>
      'The connection dropped mid-close. We don\'t know whether it went through — we have to ask the server.';

  @override
  String get coCloseUnknownStep => 'No response';

  @override
  String coCloseConfirmedAt(String time) {
    return '$time · confirmed';
  }

  @override
  String get coWontHappenTitle => 'What will NOT happen';

  @override
  String get coWontHappenPill => 'Rule';

  @override
  String get coWontRetryLabel => 'Retry';

  @override
  String get coWontRetry => 'The app won\'t retry the close on its own.';

  @override
  String get coWontQueueLabel => 'Outbox';

  @override
  String get coWontQueue => 'Closing never goes into the outbox.';

  @override
  String get coCheckStatus => 'Check the status';

  @override
  String get coCheckStatusWhy =>
      'With signal, one lookup tells you which step it stopped at, and you continue from there.';

  @override
  String coPresenceChipSemantics(String line) {
    return '$line: see who is in this session';
  }

  @override
  String get coPresenceNeverAlone =>
      'The chip can only state who is here. Nobody showing does not mean you are alone.';

  @override
  String get coWhoIsHereTitle => 'Who is in this session';

  @override
  String get coWhoIsHereSub =>
      'The server\'s 45 s window · refreshed on every read';

  @override
  String get coWhoIsHereNow => 'now';

  @override
  String coWhoIsHereAge(String age) {
    return '$age ago';
  }

  @override
  String get coWhoIsHereDeviceSub => 'Device · no person identified';

  @override
  String get coWhoIsHereYou => 'You · RideOps';

  @override
  String coWhoIsHereYouSeenAs(String name) {
    return 'Others see you as $name';
  }

  @override
  String get coWhoIsHereYouSeenAsUnknown => 'Others see you by your full name';

  @override
  String get coWhoIsHereDisclosure =>
      'You appear by name while this screen is open. When you leave or pause, you stop appearing in under a minute. This reserves nothing: nobody is blocked by your being here.';

  @override
  String get coPresenceEmpty =>
      'Nobody is visible right now. Another surface may be moving ahead without showing here.';

  @override
  String get coPresenceEmptyShort => 'Nobody visible right now';

  @override
  String get coPresenceOfflineWhy =>
      'With no signal we can\'t state that anyone is here right now. The green dot goes out; the chip does not disappear.';

  @override
  String coAdvancedOtherAgentNamed(String step, String name, String age) {
    return '“$step” was completed by $name $age ago.';
  }

  @override
  String coAdvancedStampLanded(String stamp, String age) {
    return '$stamp was recorded on another surface $age ago.';
  }

  @override
  String get coAdvancedStepUnchanged =>
      'Keep capturing: this step did not change.';

  @override
  String get coChangedTitle => 'What changed since you came in';

  @override
  String coChangedSub(String time) {
    return 'State reported by the server · $time';
  }

  @override
  String get coChangedStepMoved => 'The step moved';

  @override
  String coChangedStepMovedDetail(String from, String to) {
    return '$from → $to';
  }

  @override
  String coChangedByKiosk(String time) {
    return 'Completed on the kiosk · $time';
  }

  @override
  String coChangedByOtherAgent(String name, String time) {
    return 'Completed by $name · $time';
  }

  @override
  String coChangedByOtherSurface(String time) {
    return 'Completed on another surface · $time';
  }

  @override
  String coChangedByYou(String time) {
    return 'You did this · $time · unchanged';
  }

  @override
  String get coChangedUntouched => 'Pending · nobody has touched it';

  @override
  String get coChangedNothingLost => 'Nothing you did was lost.';

  @override
  String coChangedSomethingLost(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other:
          'Careful: $count uploads have not reached the server. Check the Outbox before moving on.',
      one:
          'Careful: 1 upload has not reached the server. Check the Outbox before moving on.',
    );
    return '$_temp0';
  }

  @override
  String get coChangedNoChanges =>
      'Nobody has touched anything since you came in.';

  @override
  String coChangedStayCta(int index) {
    return 'Stay on step $index';
  }

  @override
  String get coConflictTooEarlyTitle => 'That step isn\'t up yet';

  @override
  String coConflictTooEarlyBody(
    String current,
    int index,
    String target,
    int targetIndex,
  ) {
    return 'The session is on $current (step $index) and $target is step $targetIndex. The server only lets you move one step at a time.';
  }

  @override
  String get coConflictTooEarlyBodyShort =>
      'The server only lets you move one step at a time, and this is not the next one.';

  @override
  String coGoToStepCta(int index, String step) {
    return 'Go to step $index · $step';
  }

  @override
  String coGoToStepWhy(int index) {
    return 'Going to step $index is navigation inside this app: it always works.';
  }

  @override
  String coGuardOutboxCta(int n) {
    return 'Open the Outbox ($n)';
  }

  @override
  String get coGuardOutboxWhy =>
      'The Outbox drains itself once you have signal; the step moves on when the stamp lands.';

  @override
  String get coConflictSwapLockedBody =>
      'This unit can no longer be swapped from here: the inspection already started. It\'s handled at the desk.';

  @override
  String coJoinBannerStarted(int index, int total) {
    return 'This departure already started: it\'s on step $index of $total.';
  }

  @override
  String coJoinBannerStartedAt(String time, int index, int total) {
    return 'This departure already started. It was opened at $time and it\'s on step $index of $total.';
  }

  @override
  String coJoinBannerStartedByOther(int index, int total) {
    return 'Another agent opened this departure and it\'s on step $index of $total.';
  }

  @override
  String get coJoinDoneTitle => 'What\'s already done';

  @override
  String coJoinDonePill(int done, int total) {
    return '$done of $total phases';
  }

  @override
  String get coJoinPendingTitle => 'What\'s left';

  @override
  String get coJoinPendingPill => 'Yours';

  @override
  String coJoinContinueCta(int index) {
    return 'Continue from step $index';
  }

  @override
  String get coJoinContinueCtaUnknownStep => 'Continue';

  @override
  String get coJoinContinueWhy =>
      'You enter the step the server reports, not the one anyone left. Nothing is redone.';

  @override
  String get coJoinKioskActiveTitle =>
      'The customer is on the kiosk right now.';

  @override
  String get coJoinKioskActiveBody =>
      'Moving ahead from here may interrupt what they\'re doing.';

  @override
  String get coJoinAdviceTitle => 'What\'s worth doing';

  @override
  String get coJoinAdvicePill => 'Advice';

  @override
  String get coJoinAdviceWaitKey => 'Wait';

  @override
  String get coJoinAdviceWait =>
      'This screen updates itself when the kiosk finishes';

  @override
  String get coJoinAdviceLeaveKey => 'Or leave';

  @override
  String get coJoinAdviceLeave => 'Nothing is lost: the session stays as it is';

  @override
  String get coJoinNotABlock =>
      'This is not a block. You can move ahead — the server decides, not this notice. We\'re only telling you what\'s happening on the other side.';

  @override
  String get coJoinProceedAnyway => 'Move ahead anyway';

  @override
  String coJoinPausedByOther(String age) {
    return 'Another agent paused this departure $age ago.';
  }

  @override
  String coJoinPausedBySomeone(String age) {
    return 'This departure was left paused $age ago.';
  }

  @override
  String coJoinPausedReason(String reason) {
    return 'Reason: “$reason”';
  }

  @override
  String get coJoinWhereItStoppedTitle => 'Where it stopped';

  @override
  String get coJoinNoStealWhy =>
      'Continuing takes nothing away from anyone: there is one session and the log keeps who did what.';

  @override
  String get coJoinPausedAutoStalled =>
      'The system flagged it: it\'s been stopped for over 4 h. Nobody paused it.';

  @override
  String coJoinPausedBySystem(String age) {
    return 'The system flagged this departure $age ago.';
  }

  @override
  String get coConflictVehicleKept =>
      'Kept: the customer already verified and the step you\'re on.';

  @override
  String get coGuardWhyServer =>
      'The server closes this step when the stamp lands, not this screen. Nothing is lost: you can pause and come back.';

  @override
  String coPresenceChipLive(String name, String surface) {
    return '$name · $surface';
  }

  @override
  String coPresenceChipAged(String name, String age) {
    return '$name · $age ago';
  }

  @override
  String get coWhoIsHereYouOffline => 'No connection';

  @override
  String get coWhoIsHereDisclosureOffline =>
      'With no connection your heartbeat isn\'t landing: in under a minute you stop appearing to the other surfaces. You reappear on your own once you have signal. This never reserves anything.';

  @override
  String get coPresenceEmptyUnverifiable =>
      'And it can\'t be read as “nobody is here” either: another surface may be moving ahead without us seeing it.';
}
