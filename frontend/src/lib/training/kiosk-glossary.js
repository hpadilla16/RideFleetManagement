/**
 * Ride University — what every kiosk button does.
 *
 * Hector, 2026-09-04: "explicar qué hacen todos los botones". The labels are
 * NOT written here — each entry names the kiosk's own translation key
 * (`kiosk.*`), so the glossary shows the exact words on the real screen, in
 * the viewer's language, and cannot drift when a button is reworded. Only the
 * explanation is authored here (English; Spanish lives in the locale under
 * training.glossary.kiosk, keyed by entry id).
 *
 * tone — how the chip is drawn: guest (violet), staff (deep violet),
 *        secondary (outlined), danger (undoes something), note (NOT a button:
 *        a message or rule quoted from the kiosk, drawn as plain text — the
 *        legend's premise is chip = real button, so nothing else gets one).
 */

export const KIOSK_GLOSSARY = Object.freeze({
  key: 'kiosk-buttons',
  title: 'What does every button do?',
  summary: 'Every button on the kiosk and on the staff panel, by screen.',
  legend: 'Violet = the guest · dark violet = staff · outlined = secondary · red = undoes something · plain text = a message, not a button.',
  groups: [
    {
      key: 'bar',
      title: 'Always on screen',
      entries: [
        { id: 'help', labels: ['kiosk.help'], tone: 'secondary', what: 'Opens the help chat with a Valet agent. It never ends the session or loses a step.' },
        { id: 'back', labels: ['kiosk.back'], tone: 'secondary', what: 'One step back without losing what was entered. On the payment screen it also discards the QR code being shown.' },
        { id: 'start-over', labels: ['kiosk.startOver'], tone: 'danger', what: 'Clears EVERYTHING the guest entered and returns to the welcome screen. There is no undo.' },
        { id: 'still-here', labels: ['kiosk.idleStillHere'], tone: 'guest', what: 'Answers “Still there?”. If nobody taps, the session resets on its own for privacy.' },
        { id: 'get-help', labels: ['kiosk.getHelp', 'kiosk.tryAgain'], tone: 'secondary', what: 'Shown after a generic error: escalate to a team member, or repeat the action that failed.' },
      ],
    },
    {
      key: 'lookup',
      title: 'Welcome and finding the reservation',
      entries: [
        { id: 'pickup', labels: ['kiosk.welcomePickupTitle'], tone: 'guest', what: 'Goes to “Find your reservation”.' },
        { id: 'walkup', labels: ['kiosk.welcomeWalkupTitle'], tone: 'secondary', what: 'Walk-up rentals. Today it shows “coming very soon” and sends the guest to the counter.' },
        { id: 'scan-qr', labels: ['kiosk.lookupScanQr'], tone: 'secondary', what: 'The QR from the confirmation email. Today it shows “coming soon” — type the confirmation number instead.' },
        { id: 'find', labels: ['kiosk.lookupFind'], tone: 'guest', what: 'Looks up by confirmation number. Attempts are limited; once spent, the kiosk pauses lookups for a few minutes.' },
        { id: 'by-name', labels: ['kiosk.lookupByName', 'kiosk.lookupDateToday', 'kiosk.lookupDateTomorrow', 'kiosk.lookupDatePick'], tone: 'secondary', what: 'Last name plus the pickup day, or the phone number on file. If several match, the kiosk asks for one more detail.' },
        { id: 'thats-me', labels: ['kiosk.summaryThatsMe', 'kiosk.summaryNotMine'], tone: 'guest', what: 'Confirms the reservation found — or goes back to search without spending an attempt.' },
      ],
    },
    {
      key: 'id',
      title: 'Driver’s license',
      entries: [
        { id: 'scan', labels: ['kiosk.scanLicenseBtn', 'kiosk.scanStopBtn'], tone: 'guest', what: 'Reads the PDF417 barcode on the BACK and fills in name, license number, date of birth and expiry. “Stop scanning” turns the camera off.' },
        { id: 'upload-barcode', labels: ['kiosk.scanUploadBtn'], tone: 'secondary', what: 'A still photo of the barcode — often readable when the live camera is not.' },
        { id: 'photo', labels: ['kiosk.idPhotoBackToPhoto', 'kiosk.idPhotoReady', 'kiosk.idPhotoRetake'], tone: 'guest', what: 'Reads the FRONT of the license from a photo, then shows “Is this correct?” with what it read. “Retake” starts over.' },
        { id: 'confirm-read', labels: ['kiosk.idPhotoConfirmYes'], tone: 'guest', what: 'The guest confirms the fields read from the photo are theirs.' },
        { id: 'upload-id', labels: ['kiosk.idPhotoUpload'], tone: 'secondary', what: 'When there is no camera.' },
        { id: 'cant-scan', labels: ['kiosk.idCantScan'], tone: 'secondary', what: 'Escalates: “A team member is on the way”. After several failed reads the kiosk does this on its own.' },
        { id: 'connect', labels: ['kiosk.connectAgent', 'kiosk.tryScanAgain'], tone: 'guest', what: 'Shown when verification fails: open the chat with Valet, or scan again.' },
      ],
    },
    {
      key: 'staff',
      title: 'Staff panel (PIN)',
      entries: [
        { id: 'entry', labels: ['kiosk.assistEntry'], tone: 'secondary', what: 'Your door into the panel, from the escalation screen. Employees with a PIN only.' },
        { id: 'unlock', labels: ['kiosk.assistUnlockBtn'], tone: 'staff', what: 'Name + PIN opens a TEN-MINUTE grant in your name (“Ana — 9:58 left”). Three failures lock the kiosk for fifteen minutes.' },
        { id: 'cancel', labels: ['kiosk.assistCancel'], tone: 'secondary', what: 'Closes the panel without a grant; the guest is exactly where they were.' },
        { id: 'capture', labels: ['kiosk.assistCaptureBtn', 'kiosk.assistUpload'], tone: 'secondary', what: 'Photos of the FRONT and BACK of the physical license. Both are required.' },
        { id: 'verify', labels: ['kiosk.assistVerifyBtn'], tone: 'staff', what: 'Runs the real rules — name, age, validity. YOUR PIN DOES NOT SKIP THEM.' },
        { id: 'name-confirm', labels: ['kiosk.assistNameConfirmBtn'], tone: 'staff', what: 'You certify the name matches after checking the physical license. Recorded under your name.' },
        { id: 'continue-guest', labels: ['kiosk.assistContinueGuest', 'kiosk.assistEndBtn'], tone: 'guest', what: 'Hands control back to the guest — or closes without verifying, and the counter decides the rental.' },
      ],
    },
    {
      key: 'name',
      title: 'Name does not match (guest’s own way out)',
      entries: [
        { id: 'send-code', labels: ['kiosk.nameUpdateSend'], tone: 'guest', what: 'Sends a 6-digit code to the email or phone ON THE RESERVATION. Expires in 10 minutes.' },
        { id: 'confirm-code', labels: ['kiosk.nameUpdateConfirmBtn', 'kiosk.nameUpdateResend'], tone: 'guest', what: 'Validates the code and updates the reservation to the license name. Resend has a cooldown; attempts are limited.' },
        { id: 'not-eligible', labels: ['kiosk.nameUpdateNotEligible'], tone: 'note', what: 'No button here: the correction is done by staff with “I verified this license belongs to the guest”.' },
      ],
    },
    {
      key: 'chat',
      title: 'Help chat (Valet, remote)',
      entries: [
        { id: 'close-chat', labels: ['kiosk.voziaClose', 'kiosk.voziaEndConfirm', 'kiosk.voziaEndCancel'], tone: 'secondary', what: 'Ends the conversation, with a confirmation. The check-in is not lost.' },
        { id: 'agent-can', labels: ['kiosk.voziaAppliedToast'], tone: 'note', what: 'The agent can UNLOCK, ENTER THE ID BY HAND (from the photos already on file) and CONFIRM THE NAME. The guest sees this toast and the violet/green notice.' },
        { id: 'agent-cannot', labels: ['kiosk.voziaSkipRefused'], tone: 'note', what: 'The agent cannot skip verification, sign or pay — and cannot open the car. Keys are handed at the front desk.' },
      ],
    },
    {
      key: 'extras',
      title: 'Protection & extras · Selfie',
      entries: [
        { id: 'add-extras', labels: ['kiosk.offersAddSelected_other', 'kiosk.continue'], tone: 'guest', what: 'Adds what is ticked to the total (prices are for the rental’s days), or continues without extras. Every option includes the deposit.' },
        { id: 'selfie', labels: ['kiosk.selfieStartCamera', 'kiosk.selfieTake', 'kiosk.selfieRetake', 'kiosk.selfieUpload'], tone: 'guest', what: 'Identity selfie. “Upload a photo” when there is no camera.' },
      ],
    },
    {
      key: 'pay',
      title: 'Payment',
      entries: [
        { id: 'show-qr', labels: ['kiosk.payShowQr'], tone: 'guest', what: 'Creates ONE payment link to the tenant’s hosted payment page and shows its QR. The guest pays on their phone; the kiosk shows “Waiting for payment…” and advances by itself.' },
        { id: 'retry', labels: ['kiosk.payRetry'], tone: 'guest', what: 'After “The payment didn’t go through” (no charge was made): reuses the same link if the amount is unchanged.' },
        { id: 'change-extras', labels: ['kiosk.payChangeExtras'], tone: 'secondary', what: 'Back to extras; if the total changes, the previous link is invalidated and a new one is created.' },
        { id: 'simulate', labels: ['kiosk.paySimulate'], tone: 'secondary', what: 'Test environments only. It does not appear in production.' },
        { id: 'pay-rule', labels: ['kiosk.payWaiting'], tone: 'note', what: 'NEVER charge by hand what the kiosk is charging. If it does not advance, wait 10–15 seconds and check Reservations → Payments.' },
      ],
    },
    {
      key: 'sign',
      title: 'Signature and Done',
      entries: [
        { id: 'initial-all', labels: ['kiosk.signInitialAll'], tone: 'secondary', what: 'Applies the initials drawn once to every section; sections can also be tapped one by one.' },
        { id: 'read-agreement', labels: ['kiosk.signReadAgreement', 'kiosk.signHideAgreement'], tone: 'secondary', what: 'Expands the full agreement text.' },
        { id: 'sign-finish', labels: ['kiosk.signFinish'], tone: 'guest', what: 'Blocked while initials, payment or ID verification are missing — the kiosk says which.' },
        { id: 'done', labels: ['kiosk.doneKeysStaff'], tone: 'note', what: 'The “All set!” screen has no buttons: keys at the counter, contract and receipt by email, a QR to photo-document the car. It resets on its own.' },
      ],
    },
    {
      key: 'pair',
      title: 'Pairing (admin)',
      entries: [
        { id: 'pair', labels: ['kiosk.pairSubmit'], tone: 'guest', what: 'Six-digit code from Ride Fleet → Kiosks → Pair. Attempts are limited; once spent, ask for a new code.' },
      ],
    },
  ],
});

const NS = 'training.glossary.kiosk';
export const glossaryKey = (field) => `${NS}.${field}`;
export const glossaryGroupKey = (group) => `${NS}.groups.${group.key}.title`;
export const glossaryEntryKey = (entry) => `${NS}.entries.${entry.id}`;

/** Every translatable string the glossary will ask for. */
export function glossaryKeys() {
  const keys = [glossaryKey('title'), glossaryKey('summary'), glossaryKey('legend')];
  for (const g of KIOSK_GLOSSARY.groups) {
    keys.push(glossaryGroupKey(g));
    for (const e of g.entries) keys.push(glossaryEntryKey(e));
  }
  return keys;
}
