'use client';
// TEMPORARY measurement harness — NOT for commit. Renders the REAL kiosk
// screen components (exported copy of ../page.js) inside the real KioskShell
// so puppeteer can measure CTA positions vs the fold with the real CSS,
// real strings (en/es) and the real AssistNotice in flow.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setLanguage } from '../../../lib/i18n';
import { AssistNotice } from '../../../components/kiosk/AssistNotice';
import { ProgressSteps, LookupScreen, IdScreen, OffersScreen, PaymentScreen, SignScreen, SelfieScreen } from '../_screens.harness';

const noop = () => {};
const LONG = 'María de los Ángeles Rodríguez Martínez';
const SECTIONS = ['rental_period:Rental period', 'mileage_fuel:Mileage and fuel', 'insurance_coverage:Insurance and coverage',
  'liability_damages:Liability and damages', 'deposit_post_charges:Deposit and post-rental charges',
  'prohibited_use:Prohibited use and authorized drivers', 'declined_insurance:Declined insurance acknowledgement']
  .map((s) => { const [key, label] = s.split(':'); return { key, label, body: 'Lorem ipsum dolor sit amet. '.repeat(12) }; });
const svc = (id, name, rate) => ({ serviceId: id, name, pricingMode: 'PER_DAY', rate, total: rate * 3 });
const OFFERS = { days: 3, addons: [], packages: [
  { key: 'BASIC', name: 'Essential', perDay: 14.99, total: 44.97, serviceIds: ['cdw'], services: [svc('cdw', 'Collision Damage Waiver', 14.99)] },
  { key: 'RECOMMENDED', name: 'Peace of Mind', perDay: 24.99, total: 74.97, serviceIds: ['cdw', 'rsa', 'toll'], services: [svc('cdw', 'Collision Damage Waiver', 14.99), svc('rsa', 'Roadside Assistance', 5), svc('toll', 'Toll Pass', 5)] },
  { key: 'PREMIUM', name: 'Everything', perDay: 34.99, total: 104.97, serviceIds: ['cdw', 'rsa', 'toll', 'sli'], services: [svc('cdw', 'Collision Damage Waiver', 14.99), svc('rsa', 'Roadside Assistance', 5), svc('toll', 'Toll Pass', 5), svc('sli', 'Supplemental Liability', 10)] },
] };
const AGREEMENT = {
  agreement: { subtotal: 131.07, taxes: 20.0, fees: 8.96, total: 160.03, securityDepositAmount: 250, agreementNumber: 'RA-204817' },
  summary: { vehicle: { year: 2024, make: 'Toyota', model: 'Corolla', color: 'White', plate: 'ABC 123', internalNumber: '117' }, pickupWindow: { returnAt: '2026-09-07T10:00:00.000Z' } },
  sections: SECTIONS,
};
const STEP_OF = { LOOKUP: 1, ID: 2, SELFIE: 2, OFFERS: 3, PAYMENT: 4, SIGN: 5 };

export default function FoldHarness() {
  const { t, i18n } = useTranslation();
  const [q, setQ] = useState(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const lang = p.get('lang') === 'es' ? 'es' : 'en';
    setLanguage(lang);
    setQ({ screen: p.get('screen') || 'LOOKUP', notice: p.get('notice') || 'none', lang });
  }, []);
  useEffect(() => {
    if (q && i18n.language === q.lang) document.documentElement.setAttribute('data-harness-ready', '1');
  }, [q, i18n.language]);
  if (!q) return null;
  const notice = q.notice === '1' ? { open: true, helperName: null }
    : q.notice === '2' ? { open: false, verifiedBy: 'REMOTE', helperName: LONG }
    : null;
  const common = { t, busy: false, err: '' };
  let body = null;
  if (q.screen === 'LOOKUP') body = <LookupScreen {...common} onSubmit={noop} onBack={noop} />;
  if (q.screen === 'ID') body = <IdScreen {...common} verifyResult={null} clearVerify={noop} track={noop} onExtract={noop} onConfirm={noop} onScanned={noop} onScannerPhoto={noop} onEscalate={noop} onStaffAssist={noop} onStaffAssistName={null} onNameUpdate={noop} onBack={noop} />;
  if (q.screen === 'SELFIE') body = <SelfieScreen {...common} selfie={null} setSelfie={noop} verifyResult={null} onSubmit={noop} onContinue={noop} onRetryScan={noop} onEscalate={noop} onStaffAssist={noop} />;
  if (q.screen === 'OFFERS') body = <OffersScreen {...common} offers={OFFERS} agreement={AGREEMENT} maskedName="Alexandra P." onChoose={noop} />;
  if (q.screen === 'PAYMENT') body = <PaymentScreen {...common} agreement={AGREEMENT} payState="IDLE" onSimulate={noop} onHelp={noop} onBack={noop} />;
  if (q.screen === 'SIGN') body = <SignScreen {...common} sessionId={null} agreement={AGREEMENT} setAgreement={noop} vehicle={null} stub={null} fmtDateTime={(v) => new Date(v).toLocaleString(q.lang === 'es' ? 'es-PR' : 'en-US')} onSubmit={noop} routeFatal={() => false} />;
  return (
    <>
      <ProgressSteps t={t} current={STEP_OF[q.screen] || 1} />
      <AssistNotice state={notice} t={t} />
      {body}
    </>
  );
}
