'use client';

/**
 * Ride University — the STAFF panel on the kiosk (PIN unlock, manual ID,
 * name confirmation), drawn from the kiosk's own translated labels.
 */

import { useTranslation } from 'react-i18next';
import { KioskFrame, Heading, Btn, Callout, Card, Line, Lines, K, W, SAMPLE } from './KioskFrame';

function Keypad({ x, y }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  return (
    <g>
      <rect x={x} y={y} width="190" height="150" rx="12" fill={K.chip} />
      {keys.map((k, i) => k && (
        <Line key={i} x={x + 32 + (i % 3) * 63} y={y + 34 + Math.floor(i / 3) * 36} anchor="middle" text={k} size={15} weight={600} color={K.ink} />
      ))}
    </g>
  );
}

export function StaffPin() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={2} help={false} label={t('kiosk.assistTitle', 'Staff assistance')}>
      <Heading title={t('kiosk.assistTitle', 'Staff assistance')} sub={t('kiosk.assistSub', 'Select your name and enter your PIN to help this guest.')} />
      <rect x="32" y="116" width="280" height="36" rx="9" fill={K.surface} stroke={K.border} />
      <Line x={46} y={139} text={SAMPLE.staff} size={13} color={K.ink} />
      <Line x={296} y={139} anchor="end" text="▾" size={12} color={K.muted} />
      <Callout n={1} x={328} y={134} />
      <rect x="32" y="164" width="280" height="36" rx="9" fill={K.surface} stroke={K.border} />
      <Line x={46} y={188} text="● ● ● ●" size={15} color={K.ink} />
      <Callout n={2} x={328} y={182} />
      <Btn x={32} y={218} w={140} label={t('kiosk.assistUnlockBtn', 'Unlock')} tone="staff" callout={3} />
      <Btn x={190} y={218} w={200} label={t('kiosk.assistCancel', 'Cancel — back to the guest')} tone="secondary" />
      <Keypad x={400} y={110} />
      <Line x={32} y={284} text={t('kiosk.assistPinInvalidAttempts_other', 'Invalid PIN — {{count}} attempts left before this kiosk locks.', { count: 2 })} size={11} color={K.muted} max={100} />
    </KioskFrame>
  );
}

function GrantChip({ y = 58 }) {
  const { t } = useTranslation();
  return (
    <g>
      <rect x="380" y={y} width="228" height="26" rx="13" fill={K.mint} />
      <Line x={494} y={y + 17} anchor="middle" text={t('kiosk.assistGrantChip', '{{name}} — {{time}} left', { name: SAMPLE.staff, time: SAMPLE.timeLeft })} size={11} weight={600} color={K.mintInk} max={36} />
    </g>
  );
}

export function StaffManualId() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={2} help={false} label={t('kiosk.assistFormTitle', 'Enter the guest’s ID by hand')}>
      <Heading title={t('kiosk.assistFormTitle', 'Enter the guest’s ID by hand')} />
      <GrantChip y={62} />
      {[
        [t('kiosk.assistFirstName', 'First name'), 'ROBERTO'],
        [t('kiosk.assistLastName', 'Last name'), 'DIAZ'],
        [t('kiosk.idPhotoFieldDob', 'Date of birth'), '1985-04-02'],
        [t('kiosk.idPhotoFieldExpiry', 'Expires'), '2030-01-01'],
      ].map(([l, v], i) => (
        <g key={l}>
          <Line x={32} y={118 + i * 40} text={l} size={11} weight={700} color={K.muted} />
          <rect x="32" y={124 + i * 40} width="250" height="26" rx="7" fill={K.surface} stroke={K.border} />
          <Line x={42} y={142 + i * 40} text={v} size={12} color={K.ink} />
        </g>
      ))}
      <Card x={310} y={110} w={140} h={100}>
        <Line x={380} y={150} anchor="middle" text={t('kiosk.assistFront', 'FRONT of the license')} size={11} weight={700} color={K.muted} max={22} />
        <Line x={380} y={170} anchor="middle" text={t('kiosk.assistTapCapture', 'tap to capture')} size={11} color={K.muted} />
      </Card>
      <Card x={462} y={110} w={140} h={100}>
        <Line x={532} y={150} anchor="middle" text={t('kiosk.assistBack', 'BACK of the license')} size={11} weight={700} color={K.muted} max={22} />
        <Line x={532} y={170} anchor="middle" text={t('kiosk.assistTapCapture', 'tap to capture')} size={11} color={K.muted} />
      </Card>
      <Callout n={1} x={600} y={110} />
      <Btn x={310} y={222} w={140} label={t('kiosk.assistCaptureBtn', 'Capture')} tone="secondary" />
      <Btn x={462} y={222} w={140} label={t('kiosk.assistUpload', 'Upload')} tone="secondary" />
      <Line x={310} y={288} text={t('kiosk.assistBothPhotos', 'Photos of the FRONT and the BACK of the license are required.')} size={11} color={K.badInk} max={62} />
    </KioskFrame>
  );
}

export function StaffVerify() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={2} help={false} label={t('kiosk.assistVerifyBtn', 'Verify and continue')}>
      <GrantChip y={62} />
      <Heading y={96} title={t('kiosk.assistFormTitle', 'Enter the guest’s ID by hand')} />
      <Card y={116} h={104}>
        {[
          [t('kiosk.checkName', 'Name matches the reservation'), true],
          [t('kiosk.checkAge', 'Age requirement ({{age}}+)', { age: 21 }), false],
          [t('kiosk.checkExpiry', 'Licence valid during your rental'), true],
        ].map(([label, ok], i) => (
          <g key={label}>
            <circle cx="56" cy={142 + i * 28} r="8" fill={ok ? K.mint : K.bad} />
            <Line x={56} y={146 + i * 28} anchor="middle" text={ok ? '✓' : '✕'} size={11} weight={700} color={ok ? K.mintInk : K.badInk} />
            <Line x={76} y={146 + i * 28} text={label} size={12} color={K.ink} max={70} />
          </g>
        ))}
        <Callout n={1} x={W - 60} y={170} />
      </Card>
      <Lines x={32} y={238} text={t('kiosk.assistCorrectHint', 'Fix a typo in the fields and verify again, or end the assistance.')} size={11} color={K.muted} max={90} rows={2} gap={13} />
      <Btn x={32} y={270} w={220} label={t('kiosk.assistVerifyBtn', 'Verify and continue')} tone="staff" callout={2} />
      <Btn x={282} y={270} w={200} label={t('kiosk.assistEndBtn', 'End assistance')} tone="danger" callout={3} />
    </KioskFrame>
  );
}

export function StaffNameConfirm() {
  const { t } = useTranslation();
  return (
    <KioskFrame step={2} help={false} label={t('kiosk.assistNameTitle', 'Confirm the guest’s name')}>
      <GrantChip y={62} />
      <Heading y={96} title={t('kiosk.assistNameTitle', 'Confirm the guest’s name')} />
      <Card x={32} y={116} w={280} h={70}>
        <Line x={48} y={138} text={t('kiosk.assistNameLicense', 'Name on the license')} size={11} weight={700} color={K.muted} />
        <Line x={48} y={166} text={SAMPLE.guestLicenceName} size={14} weight={600} color={K.ink} />
      </Card>
      <Card x={328} y={116} w={280} h={70}>
        <Line x={344} y={138} text={t('kiosk.assistNameReservation', 'Name on the reservation')} size={11} weight={700} color={K.muted} />
        <Line x={344} y={166} text={SAMPLE.guestReservationName} size={14} weight={600} color={K.ink} />
      </Card>
      <Callout n={1} x={600} y={116} />
      <Lines x={32} y={210} text={t('kiosk.assistNameHint', 'You are certifying that you checked the physical license and it belongs to this guest.')} size={11} color={K.muted} max={90} rows={2} gap={13} />
      <Btn x={32} y={244} w={330} label={t('kiosk.assistNameConfirmBtn', 'I verified this license belongs to the guest')} tone="staff" callout={2} />
      <Btn x={392} y={244} w={160} label={t('kiosk.assistEndBtn', 'End assistance')} tone="danger" />
    </KioskFrame>
  );
}
