'use client';

/**
 * Ride University — what the GUEST sees on the kiosk, drawn.
 * Every label comes from the kiosk's own translations, so these never say
 * something the real screen does not.
 */

import { useTranslation } from 'react-i18next';
import { KioskFrame, Heading, Btn, Callout, NoticePill, Card, Line, Lines, K, W, H, SAMPLE } from './KioskFrame';
import { FIGURE_TEXT, figureTextKey } from '../../../lib/training/figure-text.js';

export function ScanTrouble() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={2} label={t('kiosk.idTitle', 'Scan your driver’s license')}>
      <Heading title={t('kiosk.idTitle', 'Scan your driver’s license')} sub={t('kiosk.scanHoldSteady', 'Hold the BACK of the license steady')} />
      <rect x="32" y="112" width="250" height="120" rx="12" fill={K.chip} stroke={K.borderStrong} strokeDasharray="6 5" />
      <Line x={157} y={178} anchor="middle" text={t('kiosk.scanReading', 'Reading the barcode…')} color={K.muted} size={11} />
      <Btn x={310} y={116} w={280} label={t('kiosk.scanUploadBtn', 'Upload a photo of the barcode')} tone="secondary" callout={1} />
      <Btn x={310} y={160} w={280} label={t('kiosk.idPhotoBackToPhoto', 'Take a photo')} tone="secondary" callout={2} />
      <Btn x={310} y={204} w={280} label={t('kiosk.idCantScan', 'I can’t — get help')} tone="secondary" />
      <Line x={32} y={262} text={t('kiosk.scanSlowHint', 'Trouble scanning? Try uploading a photo of the barcode.')} color={K.muted} size={11} max={95} />
    </KioskFrame>
  );
}

export function Escalated() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={2} label={t('kiosk.escalatedTitle', 'A team member is on the way')}>
      <circle cx={W / 2} cy="112" r="26" fill={K.soft} />
      <Line x={W / 2} y={120} anchor="middle" text="🙋" size={24} />
      <Line x={W / 2} y={168} anchor="middle" text={t('kiosk.escalatedTitle', 'A team member is on the way')} size={18} weight={700} color={K.title} max={48} />
      <Lines x={W / 2} y={190} anchor="middle" text={t('kiosk.escalatedBody', 'We have notified the staff — someone will be right over to finish your check-in.')} size={11.5} color={K.muted} max={84} rows={2} />
      <Btn x={W / 2 - 110} y={228} w={220} label={t('kiosk.assistEntry', 'Staff assistance')} tone="secondary" callout={2} />
      <Callout n={1} x={W - 104} y={H - 27} />
    </KioskFrame>
  );
}

export function GuestNoticeDone() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={2} label={t('kiosk.assistInPersonDoneNamed', { name: SAMPLE.staff })}>
      <NoticePill tone="done" text={t('kiosk.assistInPersonDoneNamed', 'Your ID was confirmed by {{name}} from our team.', { name: SAMPLE.staff })} callout={1} />
      <Heading y={130} title={t('kiosk.selfieTitle', 'A quick selfie to confirm it is you')} sub={t('kiosk.selfieSub', 'Center your face in the circle and look at the camera.')} />
      <circle cx={W / 2} cy="222" r="46" fill={K.chip} stroke={K.borderStrong} strokeDasharray="6 5" />
      <Btn x={W / 2 - 80} y={276} w={160} label={t('kiosk.selfieTake', 'Take photo')} />
    </KioskFrame>
  );
}

export function GuestNoticeNow() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={2} label={t('kiosk.assistNowNamed', { name: SAMPLE.staff })}>
      <NoticePill tone="now" text={t('kiosk.assistNowNamed', '{{name}} from our team is helping you with this check-in right now.', { name: SAMPLE.staff })} callout={1} />
      <Card y={110} h={120}>
        <Line x={52} y={140} text={t('kiosk.voziaTitle', 'Help chat')} weight={700} size={13} color={K.title} />
        <rect x="52" y="152" width="300" height="22" rx="11" fill={K.chip} />
        <Line x={62} y={167} text={t('kiosk.voziaAppliedToast', '✓ Your agent updated your check-in')} size={11} color={K.deep} max={60} />
        <rect x="52" y="182" width="360" height="22" rx="11" fill={K.chip} />
        <Line x={62} y={197} text={t('kiosk.voziaAgentMsgTitle', 'Message from our team')} size={11} color={K.muted} max={70} />
        <Callout n={2} x={W - 60} y={163} />
      </Card>
      <Line x={32} y={268} text={t('kiosk.voziaSkipRefused', 'For your security, only you can complete the signature and payment, here at the kiosk.')} size={11} color={K.muted} max={100} />
      <Callout n={3} x={W - 60} y={264} />
    </KioskFrame>
  );
}

export function HelpChat() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={2} label={t('kiosk.voziaTitle', 'Help chat')}>
      <rect x="0" y="42" width={W} height={H - 42} fill="rgba(33,26,56,.35)" />
      <rect x="150" y="62" width="340" height="236" rx="14" fill={K.surface} />
      <Line x={172} y={92} text={t('kiosk.voziaTitle', 'Help chat')} weight={700} size={14} color={K.title} />
      <rect x="452" y="74" width="28" height="24" rx="8" fill={K.chip} />
      <Line x={466} y={91} anchor="middle" text="×" size={14} color={K.muted} />
      <rect x="172" y="108" width="220" height="30" rx="12" fill={K.chip} />
      <Line x={184} y={128} text={t(figureTextKey('chat-guest'), FIGURE_TEXT['chat-guest'])} size={11} color={K.ink} max={40} />
      <rect x="250" y="148" width="222" height="30" rx="12" fill={K.soft} />
      <Line x={262} y={168} text={t(figureTextKey('chat-agent'), FIGURE_TEXT['chat-agent'])} size={11} color={K.deep} max={40} />
      <rect x="172" y="240" width="300" height="34" rx="10" fill={K.ground} stroke={K.border} />
      <Line x={184} y={262} text="…" size={12} color={K.muted} />
      <Callout n={1} x={W - 104} y={H - 27} />
      <Callout n={2} x={138} y={120} />
    </KioskFrame>
  );
}

export function RemoteLimits() {
  const { t } = useTranslation();
  const can = [
    t('kiosk.assistUnlockBtn', 'Unlock'),
    t('kiosk.assistFormTitle', 'Enter the guest’s ID by hand'),
    t('kiosk.assistNameTitle', 'Confirm the guest’s name'),
  ];
  const cannot = [
    t(figureTextKey('remote-cannot-skip'), FIGURE_TEXT['remote-cannot-skip']),
    t(figureTextKey('remote-cannot-sign'), FIGURE_TEXT['remote-cannot-sign']),
    t(figureTextKey('remote-cannot-car'), FIGURE_TEXT['remote-cannot-car']),
  ];
  return (
    <KioskFrame step={2} help={false} label="Remote agent: can / cannot">
      <Card x={32} y={62} w={280} h={230}>
        <rect x="32" y="62" width="280" height="30" rx="12" fill={K.mint} />
        <Line x={172} y={82} anchor="middle" text="✓" weight={700} size={14} color={K.mintInk} />
        {can.map((s, i) => <Line key={s} x={48} y={122 + i * 40} text={s} size={11.5} color={K.ink} max={38} />)}
        <Callout n={1} x={300} y={77} />
      </Card>
      <Card x={328} y={62} w={280} h={230}>
        <rect x="328" y="62" width="280" height="30" rx="12" fill={K.bad} />
        <Line x={468} y={82} anchor="middle" text="✕" weight={700} size={14} color={K.badInk} />
        {cannot.map((s, i) => <Line key={s} x={344} y={122 + i * 40} text={s} size={11.5} color={K.ink} max={38} />)}
        <Callout n={2} x={596} y={77} />
        <Callout n={3} x={596} y={198} />
      </Card>
    </KioskFrame>
  );
}

export function NameMismatch() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={2} help={false} label={t('kiosk.reasonNameMismatch', 'The name on the license does not match the reservation.')}>
      <Heading title={t('kiosk.verifyFailedTitle', 'We couldn’t verify your ID')} />
      <Card y={104} h={120}>
        {[
          [t('kiosk.checkName', 'Name matches the reservation'), false],
          [t('kiosk.checkAge', 'Age requirement ({{age}}+)', { age: 21 }), true],
          [t('kiosk.checkExpiry', 'License valid during your rental'), true],
        ].map(([label, ok], i) => (
          <g key={label}>
            <circle cx="56" cy={132 + i * 30} r="8" fill={ok ? K.mint : K.bad} />
            <Line x={56} y={136 + i * 30} anchor="middle" text={ok ? '✓' : '✕'} size={10} weight={700} color={ok ? K.mintInk : K.badInk} />
            <Line x={76} y={136 + i * 30} text={label} size={12} color={K.ink} max={70} />
          </g>
        ))}
        <Callout n={1} x={W - 60} y={132} />
      </Card>
      <Line x={32} y={250} text={t('kiosk.reasonNameMismatch', 'The name on the license does not match the reservation.')} size={11.5} color={K.badInk} max={95} />
      <Btn x={32} y={262} w={270} label={t('kiosk.nameUpdateSend', 'Send my code')} callout={2} />
      <Btn x={330} y={262} w={210} label={t('kiosk.connectAgent', 'Connect me with the team')} tone="secondary" callout={3} />
    </KioskFrame>
  );
}

export function NameCode() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={2} label={t('kiosk.nameUpdateCodeTitle', 'Enter your code')}>
      <Heading title={t('kiosk.nameUpdateCodeTitle', 'Enter your code')} sub={t('kiosk.nameUpdateSentTo', 'We sent a 6-digit code to {{destinations}}. It expires in 10 minutes.', { destinations: SAMPLE.maskedEmail })} />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <rect key={i} x={32 + i * 52} y="120" width="42" height="50" rx="9" fill={K.surface} stroke={i < 3 ? K.purple : K.border} strokeWidth={i < 3 ? 2 : 1} />
      ))}
      {['4', '8', '1'].map((d, i) => <Line key={i} x={53 + i * 52} y={154} anchor="middle" text={d} size={20} weight={700} color={K.ink} />)}
      <Btn x={32} y={196} w={200} label={t('kiosk.nameUpdateConfirmBtn', 'Confirm code')} callout={1} />
      <Btn x={244} y={196} w={200} label={t('kiosk.nameUpdateResendIn', 'Resend in {{count}}s', { count: 42 })} tone="secondary" callout={2} />
      <Line x={32} y={262} text={t('kiosk.nameUpdateInvalidCodeAttempts_other', 'That code isn’t right — {{count}} attempts left before this kiosk pauses.', { count: 2 })} size={11} color={K.muted} max={100} />
    </KioskFrame>
  );
}

export function PayQr() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={4} label={t('kiosk.payTitle', 'Pay securely on your phone')}>
      <Heading title={t('kiosk.payTitle', 'Pay securely on your phone')} sub={t('kiosk.payScanHint', 'Point your camera at the code. You can finish paying on your phone.')} />
      <Card x={32} y={110} w={300} h={170}>
        {[
          [t('kiosk.paySubtotal', 'Rental and extras'), '$186.00'],
          [t('kiosk.payTaxesFees', 'Taxes and fees'), '$21.39'],
          [t('kiosk.payToday', 'You pay today'), '$207.39'],
          [t('kiosk.payHold', 'Refundable hold on your card'), '$250.00'],
        ].map(([l, v], i) => (
          <g key={l}>
            <Line x={48} y={140 + i * 30} text={l} size={11.5} color={i === 2 ? K.title : K.muted} weight={i === 2 ? 700 : 400} max={38} />
            <Line x={316} y={140 + i * 30} anchor="end" text={v} size={12} weight={i === 2 ? 700 : 500} color={K.ink} />
          </g>
        ))}
        <Callout n={3} x={346} y={230} />
      </Card>
      <rect x="380" y="110" width="140" height="140" rx="10" fill={K.surface} stroke={K.border} />
      {Array.from({ length: 36 }, (_, i) => {
        const r = Math.floor(i / 6); const c = i % 6;
        return ((r * 7 + c * 3) % 4 !== 0) ? <rect key={i} x={392 + c * 19} y={122 + r * 19} width="14" height="14" fill={K.ink} /> : null;
      })}
      <Callout n={1} x={532} y={122} />
      <Line x={450} y={272} anchor="middle" text={t('kiosk.payWaiting', 'Waiting for payment…')} size={11.5} weight={600} color={K.deep} />
      <Callout n={2} x={540} y={268} />
    </KioskFrame>
  );
}

export function PayFailed() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={4} label={t('kiosk.payFailedTitle', 'The payment didn’t go through')}>
      <rect x="32" y="62" width="220" height="26" rx="13" fill={K.bad} />
      <Line x={142} y={80} anchor="middle" text={t('kiosk.payFailedChip', 'Payment failed or link expired')} size={11} weight={600} color={K.badInk} max={38} />
      <Heading y={126} title={t('kiosk.payFailedTitle', 'The payment didn’t go through')} sub={t('kiosk.payFailedBody', 'No charge was made. You can try again, or a team member can help.')} />
      <Btn x={32} y={190} w={200} label={t('kiosk.payRetry', 'Try again')} callout={1} />
      <Btn x={248} y={190} w={260} label={t('kiosk.payChangeExtras', 'Change protection & extras')} tone="secondary" callout={2} />
      <Btn x={32} y={236} w={200} label={t('kiosk.getHelp', 'Get help')} tone="secondary" />
    </KioskFrame>
  );
}

export function Idle() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={3} label={t('kiosk.idleTitle', 'Still there?')}>
      <rect x="0" y="42" width={W} height={H - 42} fill="rgba(33,26,56,.35)" />
      <rect x="110" y="84" width="420" height="176" rx="14" fill={K.surface} />
      <Line x={W / 2} y={120} anchor="middle" text={t('kiosk.idleTitle', 'Still there?')} size={18} weight={700} color={K.title} />
      {/* The real string ends in a preposition on purpose: kiosk/layout.js
          appends the live countdown in amber right after it. Mirror that. */}
      <Lines x={W / 2} y={144} anchor="middle" text={`${t('kiosk.idleBody', 'For your privacy, this session will reset and clear everything you entered in')} 30s`} size={11} color={K.muted} max={62} rows={2} />
      <Btn x={130} y={200} w={200} label={t('kiosk.idleStillHere', 'I’m still here — continue')} callout={1} />
      <Btn x={360} y={200} w={150} label={t('kiosk.idleStartOver', 'Start over')} tone="danger" callout={2} />
    </KioskFrame>
  );
}

export function NotMine() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={1} label={t('kiosk.summaryTitle', 'We found your reservation', { name: SAMPLE.guestFirst })}>
      <Heading title={t('kiosk.summaryTitle', 'Hi {{name}}! We found your reservation 🎉', { name: SAMPLE.guestFirst })} />
      <Card y={104} h={110}>
        {[
          [t('kiosk.summaryDriver', 'Driver'), SAMPLE.guestFull],
          [t('kiosk.summaryDates', 'Dates'), 'Sep 4 → Sep 8'],
          [t('kiosk.summaryClass', 'Vehicle class'), 'Compact SUV'],
        ].map(([l, v], i) => (
          <g key={l}>
            <Line x={48} y={132 + i * 28} text={l} size={11} color={K.muted} />
            <Line x={200} y={132 + i * 28} text={v} size={12} weight={600} color={K.ink} />
          </g>
        ))}
      </Card>
      <Btn x={32} y={236} w={220} label={t('kiosk.summaryThatsMe', 'That’s me — continue')} callout={1} />
      <Btn x={282} y={236} w={240} label={t('kiosk.summaryNotMine', 'This isn’t my reservation')} tone="secondary" callout={2} />
    </KioskFrame>
  );
}

export function Locked() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={2} help={false} label={t('kiosk.assistLockedTitle', 'This kiosk is temporarily locked')}>
      <circle cx={W / 2} cy="112" r="26" fill={K.warn} />
      <Line x={W / 2} y={121} anchor="middle" text="🔒" size={24} />
      <Line x={W / 2} y={166} anchor="middle" text={t('kiosk.assistLockedTitle', 'This kiosk is temporarily locked')} size={18} weight={700} color={K.title} max={50} />
      <Lines x={W / 2} y={186} anchor="middle" text={t('kiosk.assistLockedBody', 'Too many attempts — the kiosk pauses staff unlock and lookups for a few minutes. An admin can issue a new pairing code to clear it right away.')} size={11.5} color={K.muted} max={80} rows={3} gap={13} />
      {/* No countdown is drawn: neither locked screen shows one (QA, 2026-09-04). */}
      <Callout n={1} x={W / 2 + 250} y={182} />
      <Callout n={2} x={W / 2 + 250} y={208} />
    </KioskFrame>
  );
}

export function Done() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={5} help={false} label={t('kiosk.doneTitle', 'All set, {{name}}!', { name: SAMPLE.guestFirst })}>
      <Heading title={t('kiosk.doneTitle', 'All set, {{name}}!', { name: SAMPLE.guestFirst })} sub={t('kiosk.doneEnjoy', 'Enjoy the ride!')} />
      {[
        [t('kiosk.doneKeys', 'Keys'), t('kiosk.doneKeysStaff', 'Stop by the counter — a team member hands you the keys.'), 1],
        [t('kiosk.doneContract', 'Contract & receipt'), t('kiosk.doneContractSent', 'Sent to your email'), 2],
        [t('kiosk.doneInspection', 'Before you leave'), t('kiosk.doneInspectionScan', 'Scan to photo-document the car’s condition'), 3],
      ].map(([l, v, n], i) => (
        <g key={l}>
          <rect x="32" y={112 + i * 50} width={W - 64} height="42" rx="10" fill={K.surface} stroke={K.border} />
          <Line x={48} y={129 + i * 50} text={l} size={11} weight={700} color={K.muted} />
          <Line x={48} y={146 + i * 50} text={v} size={12} color={K.ink} max={80} />
          <Callout n={n} x={W - 56} y={133 + i * 50} />
        </g>
      ))}
      <Line x={32} y={284} text={t('kiosk.doneReset', 'The screen resets in {{count}}s', { count: 20 })} size={11} color={K.muted} />
    </KioskFrame>
  );
}
