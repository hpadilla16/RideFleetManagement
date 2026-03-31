'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api, API_BASE } from '../../../lib/client';

function stripChargePrefix(name = '', prefix) {
  return String(name || '').replace(prefix, '').trim();
}

function pricingEditorState(pricing, reservation) {
  const snapshot = pricing?.snapshot || null;
  const charges = Array.isArray(pricing?.charges) ? pricing.charges : [];
  if (snapshot || charges.length) {
    const serviceNames = charges
      .filter((c) => ['SERVICE', 'ADDITIONAL_SERVICE'].includes(String(c?.source || '').toUpperCase()))
      .map((c) => stripChargePrefix(c?.name, /^Service:\s*/i))
      .filter(Boolean)
      .join(', ');
    const feeNames = charges
      .filter((c) => ['FEE', 'SERVICE_LINKED_FEE'].includes(String(c?.source || '').toUpperCase()))
      .map((c) => stripChargePrefix(c?.name, /^Fee:\s*/i))
      .filter(Boolean)
      .join(', ');
    return {
      dailyRate: String(snapshot?.dailyRate ?? reservation?.dailyRate ?? '0'),
      serviceFee: '0',
      taxRate: String(snapshot?.taxRate ?? '11.5'),
      serviceNames,
      feeNames,
      insuranceCode: snapshot?.selectedInsuranceCode || ''
    };
  }
  return {
    dailyRate: String(reservation?.dailyRate ?? '0'),
    serviceFee: '0',
    taxRate: '11.5',
    serviceNames: '',
    feeNames: '',
    insuranceCode: ''
  };
}

function structuredDisplayChargeRows(pricingRows = []) {
  return (Array.isArray(pricingRows) ? pricingRows : []).map((r, idx) => {
    const source = String(r?.source || '').toUpperCase();
    let displayId = String(r?.id || idx);
    if (['SERVICE', 'ADDITIONAL_SERVICE'].includes(source)) displayId = `service-${r?.sourceRefId || idx}`;
    if (['FEE', 'SERVICE_LINKED_FEE'].includes(source)) displayId = `fee-${r?.sourceRefId || idx}`;
    if (source === 'DEPOSIT_DUE') displayId = 'deposit-due';
    if (source === 'SECURITY_DEPOSIT') displayId = 'security-deposit';
    if (source === 'INSURANCE') displayId = `insurance-${r?.sourceRefId || idx}`;
    return {
      id: displayId,
      name: String(r?.name || `Charge ${idx + 1}`),
      unit: Number(r?.quantity || 1),
      rate: Number(r?.rate || 0),
      total: Number(r?.total || 0),
      taxable: !!r?.taxable,
      source
    };
  });
}

function isSecurityDepositDisplayRow(row = {}) {
  const source = String(row?.source || '').trim().toUpperCase();
  const id = String(row?.id || '').trim().toLowerCase();
  const name = String(row?.name || '').trim().toUpperCase();
  return source === 'SECURITY_DEPOSIT' || id === 'security-deposit' || name === 'SECURITY DEPOSIT';
}


export default function ReservationDetailPage() {
return <AuthGate>{({ token, me, logout }) => <ReservationDetailInner token={token} me={me} logout={logout} />}</AuthGate>;
}
const toMoneyNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const money = (n) => `$${toMoneyNum(n).toFixed(2)}`;

function toLocalDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLoanerPacket(raw) {
  try {
    if (!raw) return {};
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
}

function parseAuditMetadata(raw) {
  try {
    if (!raw) return {};
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
}

function formatLoanerTimelineDetail(meta = {}, fallback = '') {
  if (meta.dealershipLoanerBorrowerPacketSaved) {
    return meta.complete ? 'Borrower packet completed and validated by staff' : 'Borrower packet updated';
  }
  if (meta.dealershipLoanerBillingSaved) {
    return `Billing ${String(meta.loanerBillingStatus || '').replaceAll('_', ' ').toLowerCase()} for ${String(meta.loanerBillingMode || '').replaceAll('_', ' ').toLowerCase() || 'loaner'}`.trim();
  }
  if (meta.dealershipLoanerAdvisorOpsSaved) {
    return meta.readyForPickup ? 'Service lane marked the loaner ready for customer pickup' : 'Advisor operations updated';
  }
  if (meta.dealershipLoanerReturnExceptionSaved) {
    return meta.flagged ? 'Return exception flagged for staff review' : 'Return exception cleared';
  }
  if (meta.dealershipLoanerExtended) {
    return 'Return date extended to keep the customer mobile during service';
  }
  if (meta.dealershipLoanerVehicleSwapped) {
    return 'Loaner vehicle swapped';
  }
  if (meta.dealershipLoanerServiceCompleted) {
    return 'Service completed and loaner case ready for closeout';
  }
  return fallback || 'Reservation workflow updated';
}

function ReservationDetailInner({ token, me, logout }) {
  const { id } = useParams();
  const router = useRouter();
  const role = String(me?.role || '').toUpperCase();

  const [row, setRow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pricing, setPricing] = useState(null);
  const [paymentRows, setPaymentRows] = useState([]);
  const [commissionOwnerContext, setCommissionOwnerContext] = useState(null);
  const [commissionOwnerPick, setCommissionOwnerPick] = useState('');
  const [locations, setLocations] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [serviceOptions, setServiceOptions] = useState([]);
  const [feeOptions, setFeeOptions] = useState([]);
  const [insurancePlans, setInsurancePlans] = useState([]);
  const [tollSummary, setTollSummary] = useState(null);
  const [servicePick, setServicePick] = useState('');
  const [feePick, setFeePick] = useState('');
  const [msg, setMsg] = useState('');
  const [activePanel, setActivePanel] = useState('overview');
  const [auditLogs, setAuditLogs] = useState([]);
  const [chargeEdit, setChargeEdit] = useState(false);
  const [chargeModel, setChargeModel] = useState({ dailyRate: '0', serviceFee: '0', taxRate: '11.5', serviceNames: '', feeNames: '', insuranceCode: '' });
  const [form, setForm] = useState({ customerId: '', pickupAt: '', returnAt: '', pickupLocationId: '', returnLocationId: '', notes: '' });
  const [loanerPacketForm, setLoanerPacketForm] = useState({
    driverLicenseChecked: false,
    insuranceCardCollected: false,
    registrationConfirmed: false,
    walkaroundCompleted: false,
    fuelAndMileageCaptured: false,
    notes: ''
  });
  const [loanerBillingForm, setLoanerBillingForm] = useState({
    loanerBillingMode: 'COURTESY',
    loanerBillingStatus: 'DRAFT',
    loanerBillingContactName: '',
    loanerBillingContactEmail: '',
    loanerBillingContactPhone: '',
    loanerBillingAuthorizationRef: '',
    loanerBillingNotes: ''
  });
  const [loanerAdvisorForm, setLoanerAdvisorForm] = useState({
    serviceAdvisorName: '',
    serviceAdvisorEmail: '',
    serviceAdvisorPhone: '',
    serviceAdvisorNotes: '',
    estimatedServiceCompletionAt: '',
    readyForPickup: false,
    readyForPickupNote: ''
  });
  const [loanerReturnForm, setLoanerReturnForm] = useState({
    flagged: false,
    loanerReturnExceptionNotes: ''
  });
  const [loanerAccountingForm, setLoanerAccountingForm] = useState({
    loanerPurchaseOrderNumber: '',
    loanerDealerInvoiceNumber: '',
    loanerAccountingNotes: '',
    closeoutComplete: false
  });
  const [loanerOpsForm, setLoanerOpsForm] = useState({
    vehicleId: '',
    returnAt: '',
    estimatedServiceCompletionAt: '',
    loanerCloseoutNotes: '',
    note: ''
  });
  const canManagePrecheckin = ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(role);
  const canManagePricingOverrides = ['SUPER_ADMIN', 'ADMIN', 'OPS', 'AGENT'].includes(role);
  const canManageCommissionOwner = ['SUPER_ADMIN', 'ADMIN'].includes(role);
  const canLoadSupportingCatalogs = ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(role);


  const cleanMojibake = (val) => {
    const s = String(val || '');
    if (!s) return '';
    try { return decodeURIComponent(escape(s)); } catch { return s; }
  };
  const load = async () => {
    setLoading(true);
    try {
      const reservationResult = await api(`/api/reservations/${id}`, {}, token);
      setRow(reservationResult);

      const optionalCalls = await Promise.allSettled([
        canLoadSupportingCatalogs ? api('/api/locations', {}, token) : Promise.resolve([]),
        api('/api/customers', {}, token).catch(() => []),
        api('/api/vehicles', {}, token).catch(() => []),
        canManagePricingOverrides ? api('/api/additional-services', {}, token) : Promise.resolve([]),
        canManagePricingOverrides ? api('/api/fees', {}, token) : Promise.resolve([]),
        canManagePricingOverrides ? api('/api/settings/insurance-plans', {}, token) : Promise.resolve([]),
        api(`/api/reservations/${id}/pricing`, {}, token).catch(() => null),
        api(`/api/reservations/${id}/payments`, {}, token).catch(() => []),
        api(`/api/reservations/${id}/audit-logs`, {}, token).catch(() => []),
        canLoadSupportingCatalogs ? api(`/api/tolls/reservations/${id}`, {}, token).catch(() => null) : Promise.resolve(null)
      ]);

      const valueOr = (index, fallback) => optionalCalls[index]?.status === 'fulfilled' ? optionalCalls[index].value : fallback;
      const locationsOut = valueOr(0, []);
      const customersOut = valueOr(1, []);
      const vehiclesOut = valueOr(2, []);
      const servicesOut = valueOr(3, []);
      const feesOut = valueOr(4, []);
      const insuranceOut = valueOr(5, []);
      const pricingOut = valueOr(6, null);
      const paymentsOut = valueOr(7, []);
      const logsOut = valueOr(8, []);
      const tollsOut = valueOr(9, null);

      setPricing(pricingOut);
      setPaymentRows(Array.isArray(paymentsOut) ? paymentsOut : []);
      setAuditLogs(Array.isArray(logsOut) ? logsOut : []);
      setLocations(Array.isArray(locationsOut) ? locationsOut : []);
      setCustomers(Array.isArray(customersOut) ? customersOut : []);
      setVehicles(Array.isArray(vehiclesOut) ? vehiclesOut : []);
      setServiceOptions(Array.isArray(servicesOut) ? servicesOut : []);
      setFeeOptions(Array.isArray(feesOut) ? feesOut : []);
      setInsurancePlans(Array.isArray(insuranceOut) ? insuranceOut : []);
      setTollSummary(tollsOut);
      setForm({
        customerId: reservationResult.customerId || '',
        pickupAt: reservationResult.pickupAt ? new Date(reservationResult.pickupAt).toISOString().slice(0, 16) : '',
        returnAt: reservationResult.returnAt ? new Date(reservationResult.returnAt).toISOString().slice(0, 16) : '',
        pickupLocationId: reservationResult.pickupLocationId || '',
        returnLocationId: reservationResult.returnLocationId || '',
        notes: reservationResult.notes || ''
      });
      const loanerPacket = parseLoanerPacket(reservationResult.loanerBorrowerPacketJson);
      setLoanerPacketForm({
        driverLicenseChecked: !!loanerPacket.driverLicenseChecked,
        insuranceCardCollected: !!loanerPacket.insuranceCardCollected,
        registrationConfirmed: !!loanerPacket.registrationConfirmed,
        walkaroundCompleted: !!loanerPacket.walkaroundCompleted,
        fuelAndMileageCaptured: !!loanerPacket.fuelAndMileageCaptured,
        notes: loanerPacket.notes || ''
      });
      setLoanerBillingForm({
        loanerBillingMode: reservationResult.loanerBillingMode || 'COURTESY',
        loanerBillingStatus: reservationResult.loanerBillingStatus || 'DRAFT',
        loanerBillingContactName: reservationResult.loanerBillingContactName || '',
        loanerBillingContactEmail: reservationResult.loanerBillingContactEmail || '',
        loanerBillingContactPhone: reservationResult.loanerBillingContactPhone || '',
        loanerBillingAuthorizationRef: reservationResult.loanerBillingAuthorizationRef || '',
        loanerBillingNotes: reservationResult.loanerBillingNotes || ''
      });
      setLoanerAdvisorForm({
        serviceAdvisorName: reservationResult.serviceAdvisorName || '',
        serviceAdvisorEmail: reservationResult.serviceAdvisorEmail || '',
        serviceAdvisorPhone: reservationResult.serviceAdvisorPhone || '',
        serviceAdvisorNotes: reservationResult.serviceAdvisorNotes || '',
        estimatedServiceCompletionAt: toLocalDateTime(reservationResult.estimatedServiceCompletionAt),
        readyForPickup: !!reservationResult.readyForPickupAt,
        readyForPickupNote: reservationResult.readyForPickupOverrideNote || ''
      });
      setLoanerReturnForm({
        flagged: !!reservationResult.loanerReturnExceptionFlag,
        loanerReturnExceptionNotes: reservationResult.loanerReturnExceptionNotes || ''
      });
      setLoanerAccountingForm({
        loanerPurchaseOrderNumber: reservationResult.loanerPurchaseOrderNumber || '',
        loanerDealerInvoiceNumber: reservationResult.loanerDealerInvoiceNumber || '',
        loanerAccountingNotes: reservationResult.loanerAccountingNotes || '',
        closeoutComplete: !!reservationResult.loanerAccountingClosedAt
      });
      setLoanerOpsForm({
        vehicleId: reservationResult.vehicleId || '',
        returnAt: reservationResult.returnAt ? new Date(reservationResult.returnAt).toISOString().slice(0, 16) : '',
        estimatedServiceCompletionAt: toLocalDateTime(reservationResult.estimatedServiceCompletionAt),
        loanerCloseoutNotes: reservationResult.loanerCloseoutNotes || '',
        note: ''
      });
      setChargeModel(pricingEditorState(pricingOut, reservationResult));
      if (canManageCommissionOwner && reservationResult?.rentalAgreement?.id) {
        try {
          const commissionCtx = await api(`/api/rental-agreements/${reservationResult.rentalAgreement.id}/commission-owner`, {}, token);
          setCommissionOwnerContext(commissionCtx || null);
          setCommissionOwnerPick(String(commissionCtx?.currentOwnerUserId || commissionCtx?.checkoutActorUserId || ''));
        } catch {
          setCommissionOwnerContext(null);
          setCommissionOwnerPick('');
        }
      } else {
        setCommissionOwnerContext(null);
        setCommissionOwnerPick('');
      }
    } catch (e) {
      setMsg(e.message || 'Unable to load reservation');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (id) load(); }, [id, token]);

  const save = async () => {
    try {
      const updated = await api(`/api/reservations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          customerId: form.customerId,
          pickupAt: form.pickupAt,
          returnAt: form.returnAt,
          pickupLocationId: form.pickupLocationId,
          returnLocationId: form.returnLocationId,
          notes: form.notes
        })
      }, token);
      setRow(updated);
      setMsg('Reservation updated');
    } catch (e) { setMsg(e.message); }
  };

  const setStatus = async (status) => {
    try {
      await api(`/api/reservations/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }, token);
      await load();
      setMsg(`Reservation set to ${status}`);
    } catch (e) { setMsg(e.message); }
  };

  const postReservationToll = async (transactionId) => {
    try {
      await api(`/api/tolls/transactions/${transactionId}/post-to-reservation`, {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      setMsg('Toll posted to reservation charges');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const startCheckout = () => router.push(`/agreements?start=${id}`);

  const printReservation = () => window.print();

  const deleteReservation = async () => {
    if (!window.confirm('Delete this reservation?')) return;
    try {
      await api(`/api/reservations/${id}`, { method: 'DELETE' }, token);
      router.push('/reservations');
    } catch (e) { setMsg(e.message); }
  };

  const duplicateReservation = async () => {
    try {
      const reservationNumber = `DUP-${Date.now().toString().slice(-6)}`;
      await api('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({
          reservationNumber,
          customerId: row.customerId,
          vehicleId: row.vehicleId,
          vehicleTypeId: row.vehicleTypeId,
          pickupAt: row.pickupAt,
          returnAt: row.returnAt,
          pickupLocationId: row.pickupLocationId,
          returnLocationId: row.returnLocationId,
          dailyRate: row.dailyRate,
          estimatedTotal: row.estimatedTotal,
          status: 'CONFIRMED',
          sendConfirmationEmail: false,
          notes: `Duplicate of ${row.reservationNumber}`
        })
      }, token);
      setMsg('Duplicate reservation created');
    } catch (e) { setMsg(e.message); }
  };

  const issueLinkAction = async (kind) => {
    try {
      const primary = String(row?.customer?.email || '').trim();
      const extra = window.prompt('Additional email recipient (optional, comma separated):', '') || '';
      const extraEmails = extra.split(',').map((x) => x.trim()).filter(Boolean);
      const recipients = [primary, ...extraEmails].filter(Boolean);

      if (!recipients.length) {
        setMsg('No customer email available for this customer');
        return;
      }

      const actionLabel = kind === 'signature' ? 'Signature Request' : kind === 'customer-info' ? 'Customer Information Request' : 'Payment Request';
      const sure = window.confirm(`Send ${actionLabel} email to:\n\n${recipients.join('\n')}`);
      if (!sure) {
        setMsg('Email send cancelled');
        return;
      }

      const out = await api(`/api/reservations/${id}/send-request-email`, {
        method: 'POST',
        body: JSON.stringify({ kind, extraEmails })
      }, token);

      if (out?.emailSent === false) {
        const text = `${out?.warning || `${actionLabel} email could not be sent.`}\n\nManual link:\n${out?.link || 'Unavailable'}`;
        try {
          if (out?.link && navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(out.link);
          }
        } catch {}
        window.alert(text);
        setMsg(`${actionLabel} email could not be sent. Link generated${out?.link ? ' and copied to clipboard' : ''}.`);
      } else {
        setMsg(`${actionLabel} email sent to ${out?.sentTo?.join(', ') || recipients.join(', ')}`);
      }
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const emailReservationDetail = async () => {
    try {
      const primary = String(row?.customer?.email || '').trim();
      const extra = window.prompt('Additional email recipient (optional, comma separated):', '') || '';
      const extraEmails = extra.split(',').map((x) => x.trim()).filter(Boolean);
      const recipients = [primary, ...extraEmails].filter(Boolean);
      if (!recipients.length) return setMsg('No customer email available for this customer');

      const sure = window.confirm(`Send Reservation Detail email to:\n\n${recipients.join('\n')}`);
      if (!sure) return setMsg('Email send cancelled');

      const out = await api(`/api/reservations/${id}/send-detail-email`, {
        method: 'POST',
        body: JSON.stringify({ extraEmails })
      }, token);

      setMsg(`Reservation Detail email sent to ${out?.sentTo?.join(', ') || recipients.join(', ')}`);
      await load();
    } catch (e) { setMsg(e.message); }
  };
  const emailAgreementToCustomer = async () => {
    try {
      const s = String(row?.status || '').toUpperCase();
      if (!(s === 'CHECKED_OUT' || s === 'CHECKED_IN')) return setMsg('Agreement email is enabled after check-out is complete.');
      const agreement = await api(`/api/reservations/${id}/start-rental`, { method: 'POST', body: JSON.stringify({}) }, token);
      const agreementId = agreement?.id;
      if (!agreementId) return setMsg('No agreement available to email.');

      const primary = String(row?.customer?.email || '').trim();
      const extra = window.prompt('Additional email recipient (optional, comma separated):', '') || '';
      const extraEmails = extra.split(',').map((x) => x.trim()).filter(Boolean);
      const to = primary || extraEmails[0] || '';
      if (!to) return setMsg('No customer email available for this customer');

      await api(`/api/rental-agreements/${agreementId}/email-agreement`, {
        method: 'POST',
        body: JSON.stringify({ to, cc: extraEmails.filter((x) => x !== to).join(',') || undefined })
      }, token);
      setMsg('Agreement emailed successfully');
      await load();
    } catch (e) { setMsg(e.message); }
  };

  const handlePrintAgreement = async () => {
    const status = String(row?.status || '').toUpperCase();
    if (!(status === 'CHECKED_OUT' || status === 'CHECKED_IN')) {
      setMsg('Print Agreement is available after check-out.');
      return;
    }
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setMsg('Pop-up blocked. Please allow pop-ups to view the agreement.');
      return;
    }
    printWindow.opener = null;
    printWindow.document.write('<html><body style="font-family:Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;padding:32px;text-align:center;background:#0b0a12;color:#fff;">Preparing agreement...</body></html>');
    printWindow.document.close();
    try {
      const agreement = await api(`/api/reservations/${id}/start-rental`, { method: 'POST', body: JSON.stringify({}) }, token);
      const agreementId = agreement?.id || row?.rentalAgreement?.id;
      if (!agreementId) throw new Error('No agreement available to print.');

      const res = await fetch(`${API_BASE}/api/rental-agreements/${agreementId}/print`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`Print failed (${res.status})`);
      const html = await res.text();
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
    } catch (e) {
      printWindow.document.open();
      printWindow.document.write(`<p style="font-family: sans-serif; padding: 24px;">${e.message || 'Unable to print agreement'}</p>`);
      printWindow.document.close();
      setMsg(e.message || 'Unable to print agreement');
    }
  };
  const handlePrintLoanerHandoff = async () => {
    if (!isLoanerWorkflow) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setMsg('Pop-up blocked. Please allow pop-ups to print the loaner handoff packet.');
      return;
    }
    printWindow.opener = null;
    printWindow.document.write('<html><body style="font-family:Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;padding:32px;text-align:center;background:#0b0a12;color:#fff;">Preparing loaner handoff packet...</body></html>');
    printWindow.document.close();
    try {
      const res = await fetch(`${API_BASE}/api/dealership-loaner/reservations/${id}/handoff-print`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`Print failed (${res.status})`);
      const html = await res.text();
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
    } catch (e) {
      printWindow.document.open();
      printWindow.document.write(`<p style="font-family: sans-serif; padding: 24px;">${e.message || 'Unable to print loaner handoff packet'}</p>`);
      printWindow.document.close();
      setMsg(e.message || 'Unable to print loaner handoff packet');
    }
  };
  const handlePrintLoanerBillingSummary = async () => {
    if (!isLoanerWorkflow) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setMsg('Pop-up blocked. Please allow pop-ups to print the billing summary.');
      return;
    }
    printWindow.opener = null;
    printWindow.document.write('<html><body style="font-family:Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;padding:32px;text-align:center;background:#0b0a12;color:#fff;">Preparing billing summary...</body></html>');
    printWindow.document.close();
    try {
      const res = await fetch(`${API_BASE}/api/dealership-loaner/reservations/${id}/billing-print`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`Print failed (${res.status})`);
      const html = await res.text();
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
    } catch (e) {
      printWindow.document.open();
      printWindow.document.write(`<p style="font-family: sans-serif; padding: 24px;">${e.message || 'Unable to print billing summary'}</p>`);
      printWindow.document.close();
      setMsg(e.message || 'Unable to print billing summary');
    }
  };
  const handlePrintLoanerPurchaseOrder = async () => {
    if (!isLoanerWorkflow) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setMsg('Pop-up blocked. Please allow pop-ups to print the purchase order.');
      return;
    }
    printWindow.opener = null;
    printWindow.document.write('<html><body style="font-family:Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;padding:32px;text-align:center;background:#0b0a12;color:#fff;">Preparing purchase order...</body></html>');
    printWindow.document.close();
    try {
      const res = await fetch(`${API_BASE}/api/dealership-loaner/reservations/${id}/purchase-order-print`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`Print failed (${res.status})`);
      const html = await res.text();
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
    } catch (e) {
      printWindow.document.open();
      printWindow.document.write(`<p style="font-family: sans-serif; padding: 24px;">${e.message || 'Unable to print purchase order'}</p>`);
      printWindow.document.close();
      setMsg(e.message || 'Unable to print purchase order');
    }
  };
  const openLogs = async () => {
    try {
      const logs = await api(`/api/reservations/${id}/audit-logs`, {}, token);
      setAuditLogs(logs || []);
      setActivePanel('log');
    } catch (e) {
      setMsg(e.message);
    }
  };
  const markPrecheckinReviewed = async () => {
    const note = window.prompt('Optional review note for staff:', row?.customerInfoReviewNote || '') || '';
    try {
      await api(`/api/reservations/${id}/precheckin/review`, {
        method: 'POST',
        body: JSON.stringify({ note })
      }, token);
      await load();
      setMsg('Pre-check-in reviewed');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const setReadyForPickup = async (ready) => {
    const needsOverride = ready && !precheckinStatus.isChecklistComplete;
    const promptLabel = ready
      ? (needsOverride ? 'Override note is required because items are still missing:' : 'Optional ready-for-pickup note:')
      : 'Optional note for clearing ready-for-pickup:';
    const note = window.prompt(promptLabel, ready ? (row?.readyForPickupOverrideNote || '') : '') || '';
    if (needsOverride && !String(note).trim()) {
      setMsg('Override note is required when marking ready with missing items');
      return;
    }
    try {
      await api(`/api/reservations/${id}/precheckin/ready`, {
        method: 'POST',
        body: JSON.stringify({ ready, note })
      }, token);
      await load();
      setMsg(ready ? 'Reservation marked ready for pickup' : 'Ready-for-pickup cleared');
    } catch (e) {
      setMsg(e.message);
    }
  };
  const breakdown = useMemo(() => {
    const daily = toMoneyNum(chargeModel.dailyRate || row?.dailyRate || 0);

    const pickupMs = new Date(form.pickupAt || row?.pickupAt || Date.now()).getTime();
    const returnMs = new Date(form.returnAt || row?.returnAt || Date.now()).getTime();
    const msDiff = Number.isFinite(returnMs - pickupMs) ? (returnMs - pickupMs) : 0;
    const days = Math.max(1, Math.ceil(msDiff / (1000 * 60 * 60 * 24)));

    const base = toMoneyNum(daily * days);
    const fees = toMoneyNum(chargeModel.serviceFee || 0);
    const taxRatePct = toMoneyNum(chargeModel.taxRate || 0);
    const taxRate = taxRatePct / 100;
    const tax = toMoneyNum((base + fees) * taxRate);
    const total = toMoneyNum(base + fees + tax);

    return {
      days,
      daily,
      base,
      fees,
      tax,
      total,
      taxRate: taxRatePct
    };
  }, [row, form.pickupAt, form.returnAt, chargeModel]);

  const paidTotal = useMemo(() => {
    return Number((paymentRows || []).reduce((sum, payment) => sum + Number(payment?.amount || 0), 0).toFixed(2));
  }, [paymentRows]);

  const precheckinStatus = useMemo(() => {
    const customer = row?.customer || {};
    const items = [
      { label: 'Contact Info', done: !!(customer.firstName && customer.lastName && customer.email && customer.phone) },
      { label: 'Date of Birth', done: !!customer.dateOfBirth },
      { label: 'Driver License', done: !!(customer.licenseNumber && customer.licenseState) },
      { label: 'Address', done: !!(customer.address1 && customer.city && customer.state && customer.zip) },
      { label: 'ID / License Photo', done: !!customer.idPhotoUrl },
      { label: 'Insurance Document', done: !!customer.insuranceDocumentUrl }
    ];
    const completed = items.filter((item) => item.done).length;
    const missingItems = items.filter((item) => !item.done);
    const hasSubmitted = !!row?.customerInfoCompletedAt;
    const isChecklistComplete = completed === items.length;
    const isStaffReviewed = !!row?.customerInfoReviewedAt;
    const isReadyForPickup = !!row?.readyForPickupAt;
    let statusLabel = 'Not Requested';
    if (isReadyForPickup) statusLabel = 'Ready For Pickup';
    else if (isStaffReviewed && isChecklistComplete) statusLabel = 'Reviewed - Awaiting Pickup';
    else if (hasSubmitted && isChecklistComplete) statusLabel = 'Submitted - Awaiting Review';
    else if (hasSubmitted) statusLabel = 'Submitted - Missing Items';
    else if (row?.customerInfoToken) statusLabel = 'Requested';
    return {
      items,
      completed,
      total: items.length,
      missingItems,
      hasSubmitted,
      isStaffReviewed,
      isChecklistComplete,
      isReadyForPickup,
      hasActiveToken: !!row?.customerInfoToken,
      statusLabel
    };
  }, [row]);
  const canMarkDocsReviewed = precheckinStatus.hasSubmitted || precheckinStatus.isChecklistComplete;
  const readyNeedsOverride = !precheckinStatus.isChecklistComplete;
  const isLoanerWorkflow = String(row?.workflowMode || '').toUpperCase() === 'DEALERSHIP_LOANER';
  const loanerPacketComplete = useMemo(() => {
    return !!(
      loanerPacketForm.driverLicenseChecked &&
      loanerPacketForm.insuranceCardCollected &&
      loanerPacketForm.registrationConfirmed &&
      loanerPacketForm.walkaroundCompleted &&
      loanerPacketForm.fuelAndMileageCaptured
    );
  }, [loanerPacketForm]);
  const loanerVehicleChoices = useMemo(() => {
    return (Array.isArray(vehicles) ? vehicles : []).filter((vehicle) => {
      const status = String(vehicle?.status || '').toUpperCase();
      if (vehicle?.id === row?.vehicleId) return true;
      return !['IN_MAINTENANCE', 'OUT_OF_SERVICE', 'ON_RENT'].includes(status);
    });
  }, [vehicles, row?.vehicleId]);
  const loanerTimeline = useMemo(() => {
    if (!isLoanerWorkflow || !row) return [];
    const events = [];
    const pushEvent = (at, label, detail, tone = 'neutral') => {
      if (!at) return;
      events.push({
        at: new Date(at),
        label,
        detail,
        tone
      });
    };

    pushEvent(row.createdAt, 'Loaner Created', `Reservation ${row.reservationNumber} opened for service lane`, 'good');
    pushEvent(row.loanerBillingSubmittedAt, 'Billing Submitted', `${row.loanerBillingMode || 'Loaner'} moved into ${row.loanerBillingStatus || 'DRAFT'}`, 'warn');
    pushEvent(row.loanerBorrowerPacketCompletedAt, 'Borrower Packet Complete', row.loanerBorrowerPacketCompletedBy || 'Packet validated by staff', 'good');
    pushEvent(row.customerInfoCompletedAt, 'Customer Info Completed', 'Guest finished pre-check-in details', 'good');
    pushEvent(row.customerInfoReviewedAt, 'Pre-check-in Reviewed', row.customerInfoReviewNote || 'Docs reviewed by staff', 'neutral');
    pushEvent(row.readyForPickupAt, 'Ready For Pickup', row.readyForPickupOverrideNote || 'Marked ready for service lane handoff', 'good');
    pushEvent(row.signatureSignedAt, 'Agreement Signed', row.signatureSignedBy || 'Agreement executed', 'good');
    pushEvent(row.loanerLastExtendedAt, 'Loaner Extended', 'Return window updated', 'warn');
    pushEvent(row.loanerLastVehicleSwapAt, 'Vehicle Swapped', 'Replacement loaner assigned', 'warn');
    pushEvent(row.loanerServiceCompletedAt, 'Service Completed', row.loanerCloseoutNotes || row.loanerServiceCompletedBy || 'Service marked complete', 'good');
    pushEvent(row.loanerBillingSettledAt, 'Billing Settled', 'Billing responsibility closed out', 'good');

    (Array.isArray(auditLogs) ? auditLogs : []).forEach((log) => {
      const meta = parseAuditMetadata(log.metadata);
      if (meta.dealershipLoanerBorrowerPacketSaved || meta.dealershipLoanerBillingSaved || meta.dealershipLoanerAdvisorOpsSaved || meta.dealershipLoanerReturnExceptionSaved || meta.dealershipLoanerExtended || meta.dealershipLoanerVehicleSwapped || meta.dealershipLoanerServiceCompleted) {
        const label = meta.dealershipLoanerBorrowerPacketSaved
          ? 'Borrower Packet Updated'
          : meta.dealershipLoanerBillingSaved
            ? 'Billing Updated'
            : meta.dealershipLoanerAdvisorOpsSaved
              ? 'Advisor Ops Updated'
              : meta.dealershipLoanerReturnExceptionSaved
                ? 'Return Exception Updated'
                : meta.dealershipLoanerExtended
                  ? 'Loaner Extended'
                  : meta.dealershipLoanerVehicleSwapped
                    ? 'Vehicle Swapped'
                    : 'Service Completed';
        const tone = meta.dealershipLoanerReturnExceptionSaved && meta.flagged
          ? 'warn'
          : meta.dealershipLoanerBillingSaved && meta.loanerBillingStatus === 'DENIED'
            ? 'warn'
            : 'neutral';
        pushEvent(log.createdAt, label, formatLoanerTimelineDetail(meta, log.reason || ''), tone);
      }
      if (meta.dealershipLoanerReturnExceptionSaved && meta.flagged) {
        pushEvent(log.createdAt, 'Return Exception Flagged', meta.notes || 'Return exception needs review', 'warn');
      }
      if (meta.dealershipLoanerBillingSaved && meta.loanerBillingStatus === 'DENIED') {
        pushEvent(log.createdAt, 'Billing Denied', meta.loanerBillingAuthorizationRef || 'Billing was denied and needs follow-up', 'warn');
      }
      if (meta.dealershipLoanerAdvisorOpsSaved && meta.readyForPickup) {
        pushEvent(log.createdAt, 'Advisor Marked Ready', meta.serviceAdvisorName || 'Service lane marked ready for pickup', 'good');
      }
      if (meta.dealershipLoanerAccountingCloseoutSaved) {
        pushEvent(log.createdAt, 'Accounting Closeout Updated', meta.closeoutComplete ? 'Accounting marked this dealer packet closed out' : 'Accounting closeout details updated', meta.closeoutComplete ? 'good' : 'neutral');
      }
    });

    return events
      .filter((event) => Number.isFinite(event.at?.getTime?.()))
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 12);
  }, [auditLogs, isLoanerWorkflow, row]);
  const loanerBillingSummary = useMemo(() => {
    if (!isLoanerWorkflow || !row) return null;
    const estimate = toMoneyNum(row.estimatedTotal || 0);
    const agreementTotal = toMoneyNum(row?.rentalAgreement?.total || 0);
    const agreementBalance = toMoneyNum(row?.rentalAgreement?.balance || 0);
    const dueNow = Math.max(0, agreementBalance);
    const coveredByDealer = ['COURTESY', 'WARRANTY', 'INTERNAL'].includes(String(row.loanerBillingMode || '').toUpperCase());
    return {
      estimate,
      agreementTotal,
      agreementBalance,
      dueNow,
      coveredByDealer,
      paymentStatus: row.paymentStatus || 'PENDING',
      accountingClosed: !!row.loanerAccountingClosedAt
    };
  }, [isLoanerWorkflow, row]);

  const saveLoanerPacket = async () => {
    try {
      await api(`/api/dealership-loaner/reservations/${id}/borrower-packet`, {
        method: 'POST',
        body: JSON.stringify(loanerPacketForm)
      }, token);
      await load();
      setMsg('Loaner borrower packet saved');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const saveLoanerBilling = async () => {
    try {
      await api(`/api/dealership-loaner/reservations/${id}/billing`, {
        method: 'POST',
        body: JSON.stringify(loanerBillingForm)
      }, token);
      await load();
      setMsg('Loaner billing details saved');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const saveLoanerAccountingCloseout = async () => {
    try {
      await api(`/api/dealership-loaner/reservations/${id}/accounting-closeout`, {
        method: 'POST',
        body: JSON.stringify(loanerAccountingForm)
      }, token);
      await load();
      setMsg('Loaner accounting closeout saved');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const saveLoanerAdvisor = async () => {
    try {
      await api(`/api/dealership-loaner/reservations/${id}/advisor-ops`, {
        method: 'POST',
        body: JSON.stringify(loanerAdvisorForm)
      }, token);
      await load();
      setMsg('Loaner advisor operations saved');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const saveLoanerReturnException = async () => {
    try {
      await api(`/api/dealership-loaner/reservations/${id}/return-exception`, {
        method: 'POST',
        body: JSON.stringify(loanerReturnForm)
      }, token);
      await load();
      setMsg(loanerReturnForm.flagged ? 'Loaner return exception saved' : 'Loaner return exception cleared');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const extendLoaner = async () => {
    try {
      await api(`/api/dealership-loaner/reservations/${id}/extend`, {
        method: 'POST',
        body: JSON.stringify({
          returnAt: loanerOpsForm.returnAt,
          estimatedServiceCompletionAt: loanerOpsForm.estimatedServiceCompletionAt || loanerOpsForm.returnAt,
          note: loanerOpsForm.note
        })
      }, token);
      await load();
      setMsg('Loaner return window updated');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const swapLoanerVehicle = async () => {
    try {
      await api(`/api/dealership-loaner/reservations/${id}/swap-vehicle`, {
        method: 'POST',
        body: JSON.stringify({
          vehicleId: loanerOpsForm.vehicleId,
          note: loanerOpsForm.note
        })
      }, token);
      await load();
      setMsg('Loaner vehicle swapped');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const completeLoanerService = async () => {
    try {
      await api(`/api/dealership-loaner/reservations/${id}/complete-service`, {
        method: 'POST',
        body: JSON.stringify({
          estimatedServiceCompletionAt: loanerOpsForm.estimatedServiceCompletionAt || null,
          loanerCloseoutNotes: loanerOpsForm.loanerCloseoutNotes
        })
      }, token);
      await load();
      setMsg('Loaner service marked complete');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const [depositOverrides, setDepositOverrides] = useState({
    depositDue: '',
    securityDeposit: ''
  });

  useEffect(() => {
    setDepositOverrides({
      depositDue: pricing?.snapshot?.depositAmountDue != null ? String(pricing.snapshot.depositAmountDue) : '',
      securityDeposit: pricing?.snapshot?.securityDepositAmount != null ? String(pricing.snapshot.securityDepositAmount) : ''
    });
  }, [pricing?.snapshot]);

  const handleEditToggle = () => {
    if (!canManagePricingOverrides) return;
    if (!chargeEdit) {
      setChargeModel(pricingEditorState(pricing, row));
    }
    setChargeEdit((v) => !v);
  };

  const removeChargeRow = (row) => {
    const id = String(row?.id || '').toLowerCase();

    if (id.startsWith('svc-') || id.startsWith('service-')) {
      const current = String(chargeModel.serviceNames || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const target = row.name.replace(/^Service:\s*/i, '').trim();
      setChargeModel((prev) => ({
        ...prev,
        serviceNames: current.filter((n) => n !== target).join(', ')
      }));
      return;
    }

    if (id.startsWith('fee-')) {
      const current = String(chargeModel.feeNames || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const target = row.name.replace(/^Fee:\s*/i, '').trim();
      setChargeModel((prev) => ({
        ...prev,
        feeNames: current.filter((n) => n !== target).join(', ')
      }));
      return;
    }

    if (id.startsWith('ins-') || id.startsWith('insurance-') || id === 'insurance') {
      setChargeModel((prev) => ({ ...prev, insuranceCode: '' }));
      return;
    }

    if (id === 'deposit-due') {
      setDepositOverrides((prev) => ({ ...prev, depositDue: '' }));
      return;
    }

    if (id === 'security-deposit') {
      setDepositOverrides((prev) => ({ ...prev, securityDeposit: '' }));
    }
  };

  const saveChargeOverrides = async () => {
    try {
const serviceNames = String(chargeModel.serviceNames || '')
.split(',')
.map((x) => x.trim())
.filter(Boolean);

const feeNames = String(chargeModel.feeNames || '')
.split(',')
.map((x) => x.trim())
.filter(Boolean);

const insuranceCode = String(chargeModel.insuranceCode || '').trim();
const insurancePlan = insuranceCode
  ? (insurancePlans || []).find((p) => String(p.code || '').trim().toUpperCase() === insuranceCode.toUpperCase())
  : null;

const serviceRows = serviceNames.map((name, idx) => {
const opt = serviceOptions.find((s) => (s.name || s.code || '').trim().toLowerCase() === name.toLowerCase());
const rate = toMoneyNum(opt?.price ?? opt?.rate ?? opt?.amount ?? 0);
const perDay = [/PER_DAY|DAILY|DAY/i.test(String(opt?.mode || ''))] ||
['true', '1'].includes(String(opt?.isPerDay || opt?.perDay || '').toLowerCase());
const unit = perDay ? breakdown.days : 1;
return {
id: `svc-${idx}`,
name: `Service: ${name}`,
chargeType: 'UNIT',
quantity: unit,
rate,
total: toMoneyNum(rate * unit),
 taxable: opt?.taxable !== false,
 source: 'SERVICE',
 sourceRefId: opt?.id || null
};
});

const feeRows = feeNames.map((name, idx) => {
const opt = feeOptions.find((f) => (f.name || f.code || '').trim().toLowerCase() === name.toLowerCase());
const rate = toMoneyNum(opt?.amount ?? opt?.price ?? opt?.rate ?? 0);
const perDay = [/PER_DAY|DAILY|DAY/i.test(String(opt?.mode || ''))] ||
['true', '1'].includes(String(opt?.isPerDay || opt?.perDay || '').toLowerCase());
const unit = perDay ? breakdown.days : 1;
return {
id: `fee-${idx}`,
name: `Fee: ${name}`,
chargeType: 'UNIT',
quantity: unit,
rate,
total: toMoneyNum(rate * unit),
 taxable: opt?.taxable !== false,
 source: 'FEE',
 sourceRefId: opt?.id || null
};
});

const linkedFeeRows = serviceRows
  .map((serviceRow, idx) => {
    const serviceName = String(serviceRow.name || '').replace(/^Service:\s*/i, '').trim().toLowerCase();
    const serviceOpt = serviceOptions.find((s) => (s.name || s.code || '').trim().toLowerCase() === serviceName);
    const linkedFee = serviceOpt?.linkedFee;
    if (!linkedFee?.id) return null;
    const baseAmount = toMoneyNum(
      toMoneyNum((chargeModel.dailyRate || row?.dailyRate || 0) * breakdown.days)
      + serviceRows.reduce((sum, currentRow) => sum + toMoneyNum(currentRow.total), 0)
    );
    const feeAmount = toMoneyNum(linkedFee.amount || 0);
    const mode = String(linkedFee.mode || 'FIXED').toUpperCase();
    const total = mode === 'PERCENTAGE'
      ? toMoneyNum(baseAmount * (feeAmount / 100))
      : mode === 'PER_DAY'
        ? toMoneyNum(feeAmount * breakdown.days)
        : feeAmount;
    return {
      id: `linked-fee-${idx}`,
      name: `${linkedFee.name} | ${serviceOpt?.name || serviceRow.name}`,
      chargeType: 'UNIT',
      quantity: 1,
      rate: mode === 'PERCENTAGE' ? feeAmount : total,
      total,
      taxable: linkedFee.taxable !== false,
      source: 'SERVICE_LINKED_FEE',
      sourceRefId: `${linkedFee.id}:${serviceOpt?.id || idx}`
    };
  })
  .filter(Boolean);

const insuranceRows = [];
if (insurancePlan) {
  const planLabel = insurancePlan.label || insurancePlan.name || insurancePlan.code;
  const mode = String(insurancePlan.chargeBy || insurancePlan.mode || 'FIXED').toUpperCase();
  const amount = toMoneyNum(insurancePlan.amount || 0);
  let quantity = 1;
  let rate = amount;
  let total = amount;
  if (mode === 'PER_DAY') {
    quantity = Math.max(1, breakdown.days || 1);
    total = toMoneyNum(amount * quantity);
  } else if (mode === 'PERCENTAGE') {
    quantity = 1;
    total = toMoneyNum(toMoneyNum((chargeModel.dailyRate || row?.dailyRate || 0) * breakdown.days) * (amount / 100));
    rate = total;
  }
  insuranceRows.push({
    id: `ins-${insurancePlan.code}`,
    name: `Insurance: ${planLabel}`,
    chargeType: 'UNIT',
    quantity,
    rate,
    total,
    taxable: !!insurancePlan.taxable,
    source: 'INSURANCE',
    sourceRefId: insurancePlan.code
  });
}

const baseRow = {
id: 'daily',
name: 'Daily',
chargeType: 'DAILY',
quantity: breakdown.days,
rate: toMoneyNum(chargeModel.dailyRate || row?.dailyRate || 0),
total: toMoneyNum((chargeModel.dailyRate || row?.dailyRate || 0) * breakdown.days),
 taxable: true,
 source: 'DAILY'
};

const coreRows = [baseRow, ...serviceRows, ...feeRows, ...insuranceRows];

const taxableSubTotal = coreRows.reduce(
(sum, r) => sum + (r.taxable === false ? 0 : toMoneyNum(r.total)),
0
);

const taxRow =
Number(chargeModel.taxRate || 0) > 0
? {
id: 'tax',
name: `Sales Tax (${Number(chargeModel.taxRate).toFixed(2)}%)`,
chargeType: 'TAX',
quantity: 1,
rate: toMoneyNum(taxableSubTotal * (Number(chargeModel.taxRate) / 100)),
total: toMoneyNum(taxableSubTotal * (Number(chargeModel.taxRate) / 100)),
 taxable: false,
 source: 'TAX'
}
: null;

const normalizedRows = taxRow ? [...coreRows, ...linkedFeeRows, taxRow] : [...coreRows, ...linkedFeeRows];

const depositRows = [];
if (Number(depositOverrides.depositDue || 0) > 0) {
depositRows.push({
id: 'deposit-due',
name: 'Deposit (Due Now)',
chargeType: 'DEPOSIT',
quantity: 1,
rate: Number(depositOverrides.depositDue),
total: Number(depositOverrides.depositDue),
 taxable: false,
 source: 'DEPOSIT_DUE'
});
}
if (Number(depositOverrides.securityDeposit || 0) > 0) {
depositRows.push({
id: 'security-deposit',
name: 'Security Deposit',
chargeType: 'DEPOSIT',
quantity: 1,
rate: Number(depositOverrides.securityDeposit),
total: Number(depositOverrides.securityDeposit),
 taxable: false,
 source: 'SECURITY_DEPOSIT'
});
}

await api(
`/api/reservations/${id}/pricing`,
{
method: 'PUT',
body: JSON.stringify({
dailyRate: Number(chargeModel.dailyRate || row?.dailyRate || 0),
taxRate: Number(chargeModel.taxRate || 0),
selectedInsuranceCode: insurancePlan ? insurancePlan.code : '',
selectedInsuranceName: insurancePlan ? (insurancePlan.label || insurancePlan.name || insurancePlan.code) : null,
depositRequired: Number(depositOverrides.depositDue || 0) > 0,
depositMode: Number(depositOverrides.depositDue || 0) > 0 ? 'FIXED' : null,
depositValue: Number(depositOverrides.depositDue || 0),
depositBasis: [],
depositAmountDue: Number(depositOverrides.depositDue || 0),
securityDepositRequired: Number(depositOverrides.securityDeposit || 0) > 0,
securityDepositAmount: Number(depositOverrides.securityDeposit || 0),
source: 'UI_MANUAL',
charges: [...normalizedRows, ...depositRows]
})
},
token
);

  await load();
  setChargeEdit(false);
  setMsg('Charges updated');
    } catch (e) {
      setMsg(e.message);
    }
    };

  const saveCommissionOwnerOverride = async () => {
    if (!canManageCommissionOwner || !row?.rentalAgreement?.id) return;
    try {
      const employeeUserId = String(commissionOwnerPick || '').trim();
      if (!employeeUserId) return setMsg('Select an employee first');
      await api(`/api/rental-agreements/${row.rentalAgreement.id}/commission-owner`, {
        method: 'POST',
        body: JSON.stringify({ employeeUserId })
      }, token);
      const refreshed = await api(`/api/rental-agreements/${row.rentalAgreement.id}/commission-owner`, {}, token);
      setCommissionOwnerContext(refreshed || null);
      setCommissionOwnerPick(String(refreshed?.currentOwnerUserId || refreshed?.checkoutActorUserId || employeeUserId));
      setMsg('Commission owner updated');
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  };

  const selectedServiceRows = useMemo(() => {
    const editorRows = String(chargeModel.serviceNames || '')
      .split(',')
      .map((name, i) => ({ id: `svc-editor-${i}`, name: `Service: ${String(name || '').trim()}` }))
      .filter((row) => row.name !== 'Service:');
    if (chargeEdit) return editorRows;
    return (pricing?.charges || [])
      .filter((j) => ['SERVICE', 'ADDITIONAL_SERVICE'].includes(String(j?.source || '').toUpperCase()))
      .map((j, i) => ({ id: `svc-${j?.sourceRefId || i}`, name: String(j?.name || '') }));
  }, [pricing?.charges, chargeEdit, chargeModel.serviceNames]);

  const selectedFeeRows = useMemo(() => {
    const editorRows = String(chargeModel.feeNames || '')
      .split(',')
      .map((name, i) => ({ id: `fee-editor-${i}`, name: `Fee: ${String(name || '').trim()}` }))
      .filter((row) => row.name !== 'Fee:');
    if (chargeEdit) return editorRows;
    return (pricing?.charges || [])
      .filter((j) => ['FEE', 'SERVICE_LINKED_FEE'].includes(String(j?.source || '').toUpperCase()))
      .map((j, i) => ({ id: `fee-${j?.sourceRefId || i}`, name: String(j?.name || '') }));
  }, [pricing?.charges, chargeEdit, chargeModel.feeNames]);

  const filteredInsurancePlans = useMemo(() => {
    const vtId = row?.vehicleTypeId;
    const locId = row?.pickupLocationId;
    return (insurancePlans || []).filter((plan) => {
      if (plan?.isActive === false) return false;
      const locIds = Array.isArray(plan?.locationIds) ? plan.locationIds : [];
      const vtIds = Array.isArray(plan?.vehicleTypeIds) ? plan.vehicleTypeIds : [];
      if (locIds.length && locId && !locIds.includes(locId)) return false;
      if (vtIds.length && vtId && !vtIds.includes(vtId)) return false;
      return true;
    });
  }, [insurancePlans, row?.vehicleTypeId, row?.pickupLocationId]);

  const selectedInsurancePlan = useMemo(() => {
    if (!chargeModel.insuranceCode) return null;
    const code = String(chargeModel.insuranceCode || '').trim().toUpperCase();
    return filteredInsurancePlans.find((p) => String(p.code || '').trim().toUpperCase() === code) || null;
  }, [filteredInsurancePlans, chargeModel.insuranceCode]);

  const displayChargeRows = useMemo(() => {
    if (!chargeEdit && pricing?.charges?.length) {
      return structuredDisplayChargeRows(pricing.charges);
    }

    const serviceRows = selectedServiceRows.map((r) => {
      const raw = String(r.name || '').replace(/^Service:\s*/i, '').trim().toLowerCase();
      const opt = (serviceOptions || []).find((s) => {
        const n = String(s?.name || s?.code || '').trim().toLowerCase();
        return n === raw;
      });
      const rate = toMoneyNum(opt?.price ?? opt?.rate ?? opt?.amount ?? 0);
      const mode = String(opt?.mode || opt?.billingType || opt?.chargeType || opt?.calculationType || opt?.priceType || opt?.amountType || opt?.frequency || opt?.apply || '').toUpperCase();
      const perDay =
        ['1', 'TRUE', 'YES', 'Y', 'PER_DAY', 'PER-DAY', 'DAILY', 'DAY', 'BY_DAY', 'PERDAY'].includes(String(opt?.isPerDay).toUpperCase()) ||
        ['1', 'TRUE', 'YES', 'Y', 'PER_DAY', 'PER-DAY', 'DAILY', 'DAY', 'BY_DAY', 'PERDAY'].includes(String(opt?.perDay).toUpperCase()) ||
        ['PER_DAY', 'PER-DAY', 'DAILY', 'DAY', 'BY_DAY', 'PERDAY'].includes(mode);
      const taxable = opt?.taxable === undefined ? true : !!opt?.taxable;
      const unit = perDay ? toMoneyNum(breakdown.days) : 1;
      const total = toMoneyNum(rate * unit);
      return { id: r.id, name: r.name, unit, rate, total, taxable };
    });

    const feeRows = selectedFeeRows.map((r) => {
      const raw = String(r.name || '').replace(/^Fee:\s*/i, '').trim().toLowerCase();
      const opt = (feeOptions || []).find((f) => {
        const n = String(f?.name || f?.code || '').trim().toLowerCase();
        return n === raw;
      });
      const rate = toMoneyNum(opt?.amount ?? opt?.price ?? opt?.rate ?? 0);
      const mode = String(opt?.mode || opt?.billingType || opt?.chargeType || opt?.calculationType || opt?.priceType || opt?.amountType || opt?.frequency || opt?.apply || '').toUpperCase();
      const perDay =
        ['1', 'TRUE', 'YES', 'Y', 'PER_DAY', 'PER-DAY', 'DAILY', 'DAY', 'BY_DAY', 'PERDAY'].includes(String(opt?.isPerDay).toUpperCase()) ||
        ['1', 'TRUE', 'YES', 'Y', 'PER_DAY', 'PER-DAY', 'DAILY', 'DAY', 'BY_DAY', 'PERDAY'].includes(String(opt?.perDay).toUpperCase()) ||
        ['PER_DAY', 'PER-DAY', 'DAILY', 'DAY', 'BY_DAY', 'PERDAY'].includes(mode);
      const taxable = opt?.taxable === undefined ? true : !!opt?.taxable;
      const unit = perDay ? toMoneyNum(breakdown.days) : 1;
      const total = toMoneyNum(rate * unit);
      return { id: r.id, name: r.name, unit, rate, total, taxable };
    });

    const linkedFeeRows = serviceRows
      .map((serviceRow, idx) => {
        const raw = String(serviceRow.name || '').replace(/^Service:\s*/i, '').trim().toLowerCase();
        const serviceOpt = (serviceOptions || []).find((s) => {
          const n = String(s?.name || s?.code || '').trim().toLowerCase();
          return n === raw;
        });
        const linkedFee = serviceOpt?.linkedFee;
        if (!linkedFee?.id) return null;
        const baseAmount = toMoneyNum(breakdown.base + serviceRows.reduce((sum, currentRow) => sum + toMoneyNum(currentRow.total), 0));
        const feeAmount = toMoneyNum(linkedFee.amount || 0);
        const mode = String(linkedFee.mode || 'FIXED').toUpperCase();
        const total = mode === 'PERCENTAGE'
          ? toMoneyNum(baseAmount * (feeAmount / 100))
          : mode === 'PER_DAY'
            ? toMoneyNum(feeAmount * breakdown.days)
            : feeAmount;
        return {
          id: `linked-fee-preview-${idx}`,
          name: `${linkedFee.name} | ${serviceOpt?.name || serviceRow.name}`,
          unit: 1,
          rate: mode === 'PERCENTAGE' ? feeAmount : total,
          total,
          taxable: linkedFee.taxable !== false
        };
      })
      .filter(Boolean);

    const rows = [
      { id: 'daily', name: 'Daily', unit: breakdown.days, rate: breakdown.daily, total: breakdown.base, taxable: true },
      ...serviceRows,
      ...feeRows,
      ...linkedFeeRows
    ];

    const taxRatePct = toMoneyNum(chargeModel.taxRate || breakdown.taxRate || 0);
    const taxableSubTotal = toMoneyNum(rows.reduce((s, r) => s + (r?.taxable === false ? 0 : toMoneyNum(r?.total)), 0));
    const taxTotal = toMoneyNum(taxableSubTotal * (taxRatePct / 100));
    if (taxTotal > 0) rows.push({ id: 'tax', name: `Sales Tax (${taxRatePct.toFixed(2)}%)`, unit: 1, rate: taxTotal, total: taxTotal, taxable: false });

    if (Number(depositOverrides.depositDue || 0) > 0) {
      rows.push({ id: 'deposit-due', name: 'Deposit (Due Now)', unit: 1, rate: toMoneyNum(depositOverrides.depositDue), total: toMoneyNum(depositOverrides.depositDue) });
    }
    if (Number(depositOverrides.securityDeposit || 0) > 0) {
      rows.push({ id: 'security-deposit', name: 'Security Deposit', unit: 1, rate: toMoneyNum(depositOverrides.securityDeposit), total: toMoneyNum(depositOverrides.securityDeposit) });
    }

    return rows;
  }, [chargeEdit, pricing?.charges, breakdown, selectedServiceRows, selectedFeeRows, serviceOptions, feeOptions, chargeModel?.taxRate, depositOverrides.depositDue, depositOverrides.securityDeposit]);

  const securityDepositDisplayTotal = useMemo(
    () => toMoneyNum(displayChargeRows.filter((r) => isSecurityDepositDisplayRow(r)).reduce((s, r) => s + toMoneyNum(r?.total), 0)),
    [displayChargeRows]
  );
  const displayTotal = useMemo(
    () => toMoneyNum(displayChargeRows.filter((r) => !isSecurityDepositDisplayRow(r)).reduce((s, r) => s + toMoneyNum(r?.total), 0)),
    [displayChargeRows]
  );
  const effectiveChargeTotal = displayTotal;
  const unpaidBalance = useMemo(
    () => Number((Math.max(0, toMoneyNum(displayTotal) - toMoneyNum(paidTotal))).toFixed(2)),
    [displayTotal, paidTotal]
  );
  const reservationOpsSnapshot = useMemo(() => {
    const status = String(row?.status || '').toUpperCase();
    let nextAction = 'Review reservation workflow';
    let nextActionDetail = 'Open the workflow and continue from the current booking state.';

    if (!precheckinStatus.hasActiveToken && !precheckinStatus.hasSubmitted) {
      nextAction = 'Request customer information';
      nextActionDetail = 'Kick off pre-check-in so the guest can upload license, insurance, and profile details.';
    } else if (precheckinStatus.hasSubmitted && !precheckinStatus.isStaffReviewed) {
      nextAction = 'Review pre-check-in';
      nextActionDetail = 'Customer details are in. Staff should review the documents and checklist.';
    } else if (precheckinStatus.isStaffReviewed && !precheckinStatus.isReadyForPickup) {
      nextAction = 'Mark ready for pickup';
      nextActionDetail = 'Pre-check-in looks good. The booking is waiting for the final ready-for-pickup step.';
    } else if (!row?.signatureSignedAt) {
      nextAction = 'Collect signature';
      nextActionDetail = 'Agreement still needs to be signed before the booking can be handed off cleanly.';
    } else if (unpaidBalance > 0) {
      nextAction = 'Resolve payment due';
      nextActionDetail = `There is still ${money(unpaidBalance)} left to collect on this booking.`;
    } else if (status === 'CONFIRMED') {
      nextAction = 'Start check-out';
      nextActionDetail = 'Booking is ready to move into vehicle handoff and agreement execution.';
    } else if (status === 'CHECKED_OUT') {
      nextAction = 'Prepare check-in';
      nextActionDetail = 'The vehicle is out. Keep an eye on return timing, inspection, and balance closeout.';
    } else if (status === 'CHECKED_IN') {
      nextAction = 'Booking complete';
      nextActionDetail = 'Closeout is done. Use the notes, logs, and charges if anything still needs review.';
    }

    return {
      customerName: [row?.customer?.firstName, row?.customer?.lastName].filter(Boolean).join(' ') || row?.customer?.email || 'Guest pending',
      vehicleLabel: row?.vehicle ? `${row.vehicle.year || ''} ${row.vehicle.make || ''} ${row.vehicle.model || ''}`.trim() : 'No vehicle assigned',
      nextAction,
      nextActionDetail
    };
  }, [precheckinStatus, row, unpaidBalance]);


	if (loading || !row) {
	return (
	<AppShell me={me} logout={logout}>
	<section className="glass card-lg">{loading ? 'Loading reservation...' : (msg || 'Unable to load reservation')}</section>
	</AppShell>
	);
	}
  return (
    <AppShell me={me} logout={logout}>
      {msg ? <p className="label">{msg}</p> : null}
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="app-banner">
          <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
            <div>
              <span className="eyebrow">Reservation Ops Snapshot</span>
              <h2 className="page-title" style={{ marginTop: 6 }}>
                {reservationOpsSnapshot.nextAction}
              </h2>
              <p className="ui-muted">{reservationOpsSnapshot.nextActionDetail}</p>
            </div>
            <span className={`status-chip ${unpaidBalance > 0 ? 'warn' : 'neutral'}`}>{row.status}</span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Reservation</span>
              <strong>{row.reservationNumber}</strong>
              <span className="ui-muted">{String(row.workflowMode || 'RENTAL').replaceAll('_', ' ')}</span>
            </div>
            <div className="info-tile">
              <span className="label">Customer</span>
              <strong>{reservationOpsSnapshot.customerName}</strong>
              <span className="ui-muted">{row?.customer?.email || row?.customer?.phone || 'Customer contact pending'}</span>
            </div>
            <div className="info-tile">
              <span className="label">Vehicle</span>
              <strong>{reservationOpsSnapshot.vehicleLabel}</strong>
              <span className="ui-muted">{row?.pickupLocation?.name || 'Pickup location pending'}</span>
            </div>
            <div className="info-tile">
              <span className="label">Payment Snapshot</span>
              <strong>{money(unpaidBalance)}</strong>
              <span className="ui-muted">{unpaidBalance > 0 ? 'Remaining balance' : 'Balance cleared'}</span>
            </div>
          </div>
          <div className="app-banner-list">
            <button type="button" className="button-subtle" onClick={() => router.push(`/reservations/${id}/checkout`)}>Start Check-out</button>
            <button type="button" className="button-subtle" onClick={() => router.push(`/reservations/${id}/checkin`)}>Start Check-in</button>
            <button type="button" className="button-subtle" onClick={() => router.push(`/reservations/${id}/payments?total=${Number(effectiveChargeTotal || 0)}`)}>Payments</button>
            <button type="button" className="button-subtle" onClick={() => router.push(`/reservations/${id}/inspection`)}>Inspection</button>
          </div>
        </div>
      </section>
      <section className="grid2">
        <div className="glass card-lg">
          <div className="row-between"><h2>Reservation # {row.reservationNumber}</h2><button onClick={save}>Save</button></div>
          <div className="grid2">
            <div><span className="label">Status</span><div>{row.status}</div></div>
            <div><span className="label">Type</span><div>{row.vehicleType?.name || '-'}</div></div>
            <div><span className="label">Workflow Mode</span><div>{row.workflowMode || 'RENTAL'}</div></div>
            <div><span className="label">Pre-check-in</span><div>{precheckinStatus.statusLabel}</div></div>
            <div><span className="label">Pre-check-in Completed At</span><div>{row.customerInfoCompletedAt ? new Date(row.customerInfoCompletedAt).toLocaleString() : '-'}</div></div>
            <div><span className="label">Docs Reviewed At</span><div>{row.customerInfoReviewedAt ? new Date(row.customerInfoReviewedAt).toLocaleString() : '-'}</div></div>
            <div><span className="label">Ready For Pickup At</span><div>{row.readyForPickupAt ? new Date(row.readyForPickupAt).toLocaleString() : '-'}</div></div>
            <div><span className="label">Signature</span><div>{row.signatureSignedAt ? 'Signed' : 'Pending'}</div></div>
            <div><span className="label">Signed By</span><div>{row.signatureSignedBy || '-'}</div></div>
            <div><span className="label">Signed At</span><div>{row.signatureSignedAt ? new Date(row.signatureSignedAt).toLocaleString() : '-'}</div></div>
            <div><span className="label">Signature File</span><div>{row.signatureDataUrl ? 'Available' : '-'}</div></div>
            <div>
              <span className="label">Customer</span>
              <select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
                <option value="">Select customer</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{String(c.firstName || "").trim()} {String(c.lastName || "").trim()}</option>)}
              </select>
            </div>
            <div><span className="label">Vehicle</span><div>{row.vehicle ? `${row.vehicle.year || ''} ${row.vehicle.make || ''} ${row.vehicle.model || ''}` : 'No vehicle assigned'}</div></div>
            <div><span className="label">Pickup Date</span><input type="datetime-local" value={form.pickupAt} onChange={(e) => setForm({ ...form, pickupAt: e.target.value })} /></div>
            <div><span className="label">Return Date</span><input type="datetime-local" value={form.returnAt} onChange={(e) => setForm({ ...form, returnAt: e.target.value })} /></div>
            <div><span className="label">Pickup Location</span><select value={form.pickupLocationId} onChange={(e) => setForm({ ...form, pickupLocationId: e.target.value })}><option value="">Select</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
            <div><span className="label">Return Location</span><select value={form.returnLocationId} onChange={(e) => setForm({ ...form, returnLocationId: e.target.value })}><option value="">Select</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
          </div>

          {isLoanerWorkflow ? (
            <div className="glass card" style={{ marginTop: 12, padding: 10 }}>
              <div className="row-between" style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 700 }}>Dealership Loaner Workflow</div>
                <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  RO {row.repairOrderNumber || '-'} · Billing {row.loanerBillingMode || '-'}
                </div>
              </div>

              <div className="grid2" style={{ marginBottom: 10 }}>
                <div><span className="label">Service Advisor</span><div>{row.serviceAdvisorName || '-'}</div></div>
                <div><span className="label">Claim Number</span><div>{row.claimNumber || '-'}</div></div>
                <div><span className="label">Service Vehicle</span><div>{[row.serviceVehicleYear, row.serviceVehicleMake, row.serviceVehicleModel, row.serviceVehiclePlate].filter(Boolean).join(' - ') || '-'}</div></div>
                <div><span className="label">Liability Accepted</span><div>{row.loanerLiabilityAccepted ? 'Yes' : 'No'}</div></div>
                <div><span className="label">Borrower Packet</span><div>{row.loanerBorrowerPacketCompletedAt ? `Completed ${new Date(row.loanerBorrowerPacketCompletedAt).toLocaleString()}` : 'Pending'}</div></div>
                <div><span className="label">Packet Completed By</span><div>{row.loanerBorrowerPacketCompletedBy || '-'}</div></div>
                <div><span className="label">Billing Contact</span><div>{row.loanerBillingContactName || '-'}</div></div>
                <div><span className="label">Billing Auth Ref</span><div>{row.loanerBillingAuthorizationRef || '-'}</div></div>
                <div><span className="label">Billing Status</span><div>{row.loanerBillingStatus || 'DRAFT'}</div></div>
                <div><span className="label">Billing Submitted</span><div>{row.loanerBillingSubmittedAt ? new Date(row.loanerBillingSubmittedAt).toLocaleString() : '-'}</div></div>
                <div><span className="label">Billing Settled</span><div>{row.loanerBillingSettledAt ? new Date(row.loanerBillingSettledAt).toLocaleString() : '-'}</div></div>
                <div><span className="label">PO Number</span><div>{row.loanerPurchaseOrderNumber || '-'}</div></div>
                <div><span className="label">Dealer Invoice #</span><div>{row.loanerDealerInvoiceNumber || '-'}</div></div>
                <div><span className="label">Accounting Closed</span><div>{row.loanerAccountingClosedAt ? new Date(row.loanerAccountingClosedAt).toLocaleString() : 'Open'}</div></div>
                <div><span className="label">Accounting Closed By</span><div>{row.loanerAccountingClosedBy || '-'}</div></div>
                <div><span className="label">Advisor Notes Updated</span><div>{row.serviceAdvisorUpdatedAt ? new Date(row.serviceAdvisorUpdatedAt).toLocaleString() : '-'}</div></div>
                <div><span className="label">Return Exception</span><div>{row.loanerReturnExceptionFlag ? 'Flagged' : 'Clear'}</div></div>
                <div><span className="label">Service Completion ETA</span><div>{row.estimatedServiceCompletionAt ? new Date(row.estimatedServiceCompletionAt).toLocaleString() : '-'}</div></div>
                <div><span className="label">Service Completed</span><div>{row.loanerServiceCompletedAt ? new Date(row.loanerServiceCompletedAt).toLocaleString() : '-'}</div></div>
                <div><span className="label">Completed By</span><div>{row.loanerServiceCompletedBy || '-'}</div></div>
                <div><span className="label">Last Extended</span><div>{row.loanerLastExtendedAt ? new Date(row.loanerLastExtendedAt).toLocaleString() : '-'}</div></div>
                <div><span className="label">Last Vehicle Swap</span><div>{row.loanerLastVehicleSwapAt ? new Date(row.loanerLastVehicleSwapAt).toLocaleString() : '-'}</div></div>
              </div>

              <div className="loaner-workflow-grid" style={{ marginBottom: 0 }}>
                <section className="glass card section-card">
                  <div className="section-title">Loaner Operations</div>
                  <select value={loanerOpsForm.vehicleId} onChange={(e) => setLoanerOpsForm({ ...loanerOpsForm, vehicleId: e.target.value })}>
                    <option value="">Select assigned loaner vehicle</option>
                    {loanerVehicleChoices.map((vehicle) => (
                      <option key={vehicle.id} value={vehicle.id}>
                        {[vehicle.year, vehicle.make, vehicle.model, vehicle.internalNumber].filter(Boolean).join(' ')}
                      </option>
                    ))}
                  </select>
                  <input type="datetime-local" value={loanerOpsForm.returnAt} onChange={(e) => setLoanerOpsForm({ ...loanerOpsForm, returnAt: e.target.value })} />
                  <input type="datetime-local" value={loanerOpsForm.estimatedServiceCompletionAt} onChange={(e) => setLoanerOpsForm({ ...loanerOpsForm, estimatedServiceCompletionAt: e.target.value })} />
                  <textarea rows={2} value={loanerOpsForm.note} onChange={(e) => setLoanerOpsForm({ ...loanerOpsForm, note: e.target.value })} placeholder="Extension or swap note" />
                  <textarea rows={3} value={loanerOpsForm.loanerCloseoutNotes} onChange={(e) => setLoanerOpsForm({ ...loanerOpsForm, loanerCloseoutNotes: e.target.value })} placeholder="Closeout notes once the service is complete" />
                  <div className="inline-actions">
                    <button type="button" onClick={extendLoaner}>Extend Loaner</button>
                    <button type="button" className="button-subtle" onClick={swapLoanerVehicle}>Swap Vehicle</button>
                    <button type="button" className="button-subtle" onClick={completeLoanerService}>Complete Service</button>
                    <button type="button" className="button-subtle" onClick={handlePrintLoanerHandoff}>Print Handoff Packet</button>
                    <button type="button" className="button-subtle" onClick={handlePrintLoanerPurchaseOrder}>Print PO</button>
                  </div>
                </section>

                <section className="glass card section-card">
                  <div className="section-title">Advisor Operations</div>
                  <input value={loanerAdvisorForm.serviceAdvisorName} onChange={(e) => setLoanerAdvisorForm({ ...loanerAdvisorForm, serviceAdvisorName: e.target.value })} placeholder="Service advisor name" />
                  <input value={loanerAdvisorForm.serviceAdvisorEmail} onChange={(e) => setLoanerAdvisorForm({ ...loanerAdvisorForm, serviceAdvisorEmail: e.target.value })} placeholder="Service advisor email" />
                  <input value={loanerAdvisorForm.serviceAdvisorPhone} onChange={(e) => setLoanerAdvisorForm({ ...loanerAdvisorForm, serviceAdvisorPhone: e.target.value })} placeholder="Service advisor phone" />
                  <input type="datetime-local" value={loanerAdvisorForm.estimatedServiceCompletionAt} onChange={(e) => setLoanerAdvisorForm({ ...loanerAdvisorForm, estimatedServiceCompletionAt: e.target.value })} />
                  <textarea rows={4} value={loanerAdvisorForm.serviceAdvisorNotes} onChange={(e) => setLoanerAdvisorForm({ ...loanerAdvisorForm, serviceAdvisorNotes: e.target.value })} placeholder="Lane notes, promised completion, customer communication, parts delays, etc." />
                  <label className="label"><input type="checkbox" checked={loanerAdvisorForm.readyForPickup} onChange={(e) => setLoanerAdvisorForm({ ...loanerAdvisorForm, readyForPickup: e.target.checked })} /> Mark ready for pickup</label>
                  <textarea rows={2} value={loanerAdvisorForm.readyForPickupNote} onChange={(e) => setLoanerAdvisorForm({ ...loanerAdvisorForm, readyForPickupNote: e.target.value })} placeholder="Ready note for service lane / cashier" />
                  <button type="button" onClick={saveLoanerAdvisor}>Save Advisor Ops</button>
                </section>

                <section className="glass card section-card">
                  <div className="section-title">Borrower Packet</div>
                  <label className="label"><input type="checkbox" checked={loanerPacketForm.driverLicenseChecked} onChange={(e) => setLoanerPacketForm({ ...loanerPacketForm, driverLicenseChecked: e.target.checked })} /> Driver license checked</label>
                  <label className="label"><input type="checkbox" checked={loanerPacketForm.insuranceCardCollected} onChange={(e) => setLoanerPacketForm({ ...loanerPacketForm, insuranceCardCollected: e.target.checked })} /> Insurance card collected</label>
                  <label className="label"><input type="checkbox" checked={loanerPacketForm.registrationConfirmed} onChange={(e) => setLoanerPacketForm({ ...loanerPacketForm, registrationConfirmed: e.target.checked })} /> Registration confirmed</label>
                  <label className="label"><input type="checkbox" checked={loanerPacketForm.walkaroundCompleted} onChange={(e) => setLoanerPacketForm({ ...loanerPacketForm, walkaroundCompleted: e.target.checked })} /> Walkaround complete</label>
                  <label className="label"><input type="checkbox" checked={loanerPacketForm.fuelAndMileageCaptured} onChange={(e) => setLoanerPacketForm({ ...loanerPacketForm, fuelAndMileageCaptured: e.target.checked })} /> Fuel and mileage captured</label>
                  <textarea rows={3} value={loanerPacketForm.notes} onChange={(e) => setLoanerPacketForm({ ...loanerPacketForm, notes: e.target.value })} placeholder="Borrower packet notes" />
                  <div className="inline-actions">
                    <button type="button" onClick={saveLoanerPacket}>Save Packet</button>
                    <span className={`status-chip ${loanerPacketComplete ? 'good' : 'warn'}`}>{loanerPacketComplete ? 'Packet Complete' : 'Packet Pending'}</span>
                  </div>
                </section>

                <section className="glass card section-card">
                  <div className="section-title">Billing Control</div>
                  <select value={loanerBillingForm.loanerBillingMode} onChange={(e) => setLoanerBillingForm({ ...loanerBillingForm, loanerBillingMode: e.target.value })}>
                    <option value="COURTESY">Courtesy</option>
                    <option value="CUSTOMER_PAY">Customer Pay</option>
                    <option value="WARRANTY">Warranty</option>
                    <option value="INSURANCE">Insurance</option>
                    <option value="INTERNAL">Internal</option>
                  </select>
                  <select value={loanerBillingForm.loanerBillingStatus} onChange={(e) => setLoanerBillingForm({ ...loanerBillingForm, loanerBillingStatus: e.target.value })}>
                    <option value="DRAFT">Draft</option>
                    <option value="PENDING_APPROVAL">Pending Approval</option>
                    <option value="APPROVED">Approved</option>
                    <option value="INVOICED">Invoiced</option>
                    <option value="SETTLED">Settled</option>
                    <option value="DENIED">Denied</option>
                  </select>
                  <input value={loanerBillingForm.loanerBillingContactName} onChange={(e) => setLoanerBillingForm({ ...loanerBillingForm, loanerBillingContactName: e.target.value })} placeholder="Billing contact name" />
                  <input value={loanerBillingForm.loanerBillingContactEmail} onChange={(e) => setLoanerBillingForm({ ...loanerBillingForm, loanerBillingContactEmail: e.target.value })} placeholder="Billing contact email" />
                  <input value={loanerBillingForm.loanerBillingContactPhone} onChange={(e) => setLoanerBillingForm({ ...loanerBillingForm, loanerBillingContactPhone: e.target.value })} placeholder="Billing contact phone" />
                  <input value={loanerBillingForm.loanerBillingAuthorizationRef} onChange={(e) => setLoanerBillingForm({ ...loanerBillingForm, loanerBillingAuthorizationRef: e.target.value })} placeholder="Authorization / approval ref" />
                  <textarea rows={3} value={loanerBillingForm.loanerBillingNotes} onChange={(e) => setLoanerBillingForm({ ...loanerBillingForm, loanerBillingNotes: e.target.value })} placeholder="Warranty, insurer, or dealership billing notes" />
                  <button type="button" onClick={saveLoanerBilling}>Save Billing</button>
                </section>

                <section className="glass card section-card">
                  <div className="section-title">Billing Summary</div>
                  <div className="inline-actions" style={{ marginBottom: 10 }}>
                    <button type="button" className="button-subtle" onClick={handlePrintLoanerBillingSummary}>Print Billing Summary</button>
                    <button type="button" className="button-subtle" onClick={handlePrintLoanerPurchaseOrder}>Print PO</button>
                  </div>
                  <div className="grid2" style={{ marginBottom: 0 }}>
                    <div><span className="label">Billing Mode</span><div>{row.loanerBillingMode || '-'}</div></div>
                    <div><span className="label">Billing Status</span><div>{row.loanerBillingStatus || 'DRAFT'}</div></div>
                    <div><span className="label">Estimate</span><div>{money(loanerBillingSummary?.estimate || 0)}</div></div>
                    <div><span className="label">Payment Status</span><div>{loanerBillingSummary?.paymentStatus || 'PENDING'}</div></div>
                    <div><span className="label">Agreement Total</span><div>{money(loanerBillingSummary?.agreementTotal || 0)}</div></div>
                    <div><span className="label">Agreement Balance</span><div>{money(loanerBillingSummary?.agreementBalance || 0)}</div></div>
                    <div><span className="label">Due Now</span><div>{money(loanerBillingSummary?.dueNow || 0)}</div></div>
                    <div><span className="label">Dealer Covered</span><div>{loanerBillingSummary?.coveredByDealer ? 'Yes' : 'No'}</div></div>
                    <div><span className="label">Billing Contact</span><div>{row.loanerBillingContactName || '-'}</div></div>
                    <div><span className="label">Billing Email</span><div>{row.loanerBillingContactEmail || '-'}</div></div>
                    <div><span className="label">Billing Phone</span><div>{row.loanerBillingContactPhone || '-'}</div></div>
                    <div><span className="label">Auth Ref</span><div>{row.loanerBillingAuthorizationRef || '-'}</div></div>
                    <div><span className="label">PO Number</span><div>{row.loanerPurchaseOrderNumber || '-'}</div></div>
                    <div><span className="label">Dealer Invoice #</span><div>{row.loanerDealerInvoiceNumber || '-'}</div></div>
                    <div><span className="label">Service Completed</span><div>{row.loanerServiceCompletedAt ? new Date(row.loanerServiceCompletedAt).toLocaleString() : 'Not yet'}</div></div>
                    <div><span className="label">Last Billing Activity</span><div>{row.loanerBillingSettledAt ? new Date(row.loanerBillingSettledAt).toLocaleString() : (row.loanerBillingSubmittedAt ? new Date(row.loanerBillingSubmittedAt).toLocaleString() : '-')}</div></div>
                    <div><span className="label">Accounting Closed</span><div>{loanerBillingSummary?.accountingClosed ? 'Yes' : 'No'}</div></div>
                    <div><span className="label">Accounting Closed By</span><div>{row.loanerAccountingClosedBy || '-'}</div></div>
                  </div>
                  {row.loanerBillingNotes ? (
                    <div>
                      <span className="label">Billing Notes</span>
                      <div>{row.loanerBillingNotes}</div>
                    </div>
                  ) : null}
                </section>

                <section className="glass card section-card">
                  <div className="section-title">Accounting Closeout</div>
                  <input value={loanerAccountingForm.loanerPurchaseOrderNumber} onChange={(e) => setLoanerAccountingForm({ ...loanerAccountingForm, loanerPurchaseOrderNumber: e.target.value })} placeholder="Purchase order number" />
                  <input value={loanerAccountingForm.loanerDealerInvoiceNumber} onChange={(e) => setLoanerAccountingForm({ ...loanerAccountingForm, loanerDealerInvoiceNumber: e.target.value })} placeholder="Dealer invoice number" />
                  <textarea rows={4} value={loanerAccountingForm.loanerAccountingNotes} onChange={(e) => setLoanerAccountingForm({ ...loanerAccountingForm, loanerAccountingNotes: e.target.value })} placeholder="Accounting closeout notes, dealer references, settlement context" />
                  <label className="label"><input type="checkbox" checked={loanerAccountingForm.closeoutComplete} onChange={(e) => setLoanerAccountingForm({ ...loanerAccountingForm, closeoutComplete: e.target.checked })} /> Mark accounting closeout complete</label>
                  <div className="inline-actions">
                    <button type="button" onClick={saveLoanerAccountingCloseout}>Save Accounting Closeout</button>
                    <button type="button" className="button-subtle" onClick={handlePrintLoanerBillingSummary}>Print Dealer Invoice Packet</button>
                  </div>
                </section>

                <section className="glass card section-card">
                  <div className="section-title">Return Exceptions</div>
                  <label className="label"><input type="checkbox" checked={loanerReturnForm.flagged} onChange={(e) => setLoanerReturnForm({ ...loanerReturnForm, flagged: e.target.checked })} /> Flag return exception</label>
                  <textarea rows={6} value={loanerReturnForm.loanerReturnExceptionNotes} onChange={(e) => setLoanerReturnForm({ ...loanerReturnForm, loanerReturnExceptionNotes: e.target.value })} placeholder="Fuel shortage, damage, odor, late return, missing docs, etc." />
                  <button type="button" onClick={saveLoanerReturnException}>
                    {loanerReturnForm.flagged ? 'Save Exception' : 'Clear Exception'}
                  </button>
                </section>

                <section className="glass card section-card">
                  <div className="section-title">Service Lane Timeline</div>
                  {loanerTimeline.length ? (
                    <div className="stack">
                      {loanerTimeline.map((event) => (
                        <div key={`${event.label}-${event.at.toISOString()}`} className="surface-note" style={{ display: 'grid', gap: 6 }}>
                          <div className="row-between" style={{ marginBottom: 0 }}>
                            <strong>{event.label}</strong>
                            <span className={`status-chip ${event.tone}`}>{event.at.toLocaleString()}</span>
                          </div>
                          <div>{event.detail}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="surface-note">Timeline events will appear here as the loaner moves through service-lane operations.</div>
                  )}
                </section>
              </div>
            </div>
          ) : null}

          <div className="glass card" style={{ marginTop: 12, padding: 10 }}>
            <div className="row-between" style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 700 }}>Pre-check-in Status</div>
              <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                {precheckinStatus.completed}/{precheckinStatus.total} items complete
              </div>
            </div>
            <div className="grid2" style={{ marginBottom: 10 }}>
              <div><span className="label">Portal Status</span><div>{precheckinStatus.statusLabel}</div></div>
              <div><span className="label">Ready For Pickup</span><div>{precheckinStatus.isReadyForPickup ? 'Yes' : (precheckinStatus.hasSubmitted ? (precheckinStatus.isChecklistComplete ? 'Awaiting staff review' : 'Missing requirements') : 'Pending customer info')}</div></div>
              <div><span className="label">Staff Review</span><div>{precheckinStatus.isStaffReviewed ? 'Reviewed' : 'Pending review'}</div></div>
              <div><span className="label">Reviewed By</span><div>{row?.customerInfoReviewedByUser?.fullName || row?.customerInfoReviewedByUser?.email || '-'}</div></div>
              <div><span className="label">ID / License Photo</span><div>{row?.customer?.idPhotoUrl ? 'Uploaded' : 'Missing'}</div></div>
              <div><span className="label">Insurance Doc</span><div>{row?.customer?.insuranceDocumentUrl ? 'Uploaded' : 'Missing'}</div></div>
              <div><span className="label">Ready By</span><div>{row?.readyForPickupByUser?.fullName || row?.readyForPickupByUser?.email || '-'}</div></div>
              <div><span className="label">Override Note</span><div>{row?.readyForPickupOverrideNote || '-'}</div></div>
            </div>
            {row?.customerInfoReviewNote ? (
              <div style={{ marginBottom: 10 }}>
                <span className="label">Staff Review Note</span>
                <div>{row.customerInfoReviewNote}</div>
              </div>
            ) : null}
            {precheckinStatus.missingItems.length ? (
              <div style={{ marginBottom: 10 }}>
                <span className="label">Missing Items</span>
                <div>{precheckinStatus.missingItems.map((item) => item.label).join(', ')}</div>
              </div>
            ) : null}
            {!canMarkDocsReviewed ? (
              <div className="surface-note" style={{ marginBottom: 10 }}>
                Customer has not submitted the full pre-check-in packet yet. Staff review stays locked until the guest submits their checklist.
              </div>
            ) : null}
            {readyNeedsOverride && !precheckinStatus.isReadyForPickup ? (
              <div className="surface-note warning" style={{ marginBottom: 10 }}>
                Marking this reservation ready right now would be an override because required pre-check-in items are still missing.
              </div>
            ) : null}
            {canManagePrecheckin ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <button type="button" onClick={markPrecheckinReviewed} disabled={!canMarkDocsReviewed}>
                  {canMarkDocsReviewed ? 'Mark Docs Reviewed' : 'Awaiting Customer Submission'}
                </button>
                {!precheckinStatus.isReadyForPickup ? (
                  <button type="button" onClick={() => setReadyForPickup(true)}>
                    {readyNeedsOverride ? 'Override Ready For Pickup' : 'Mark Ready For Pickup'}
                  </button>
                ) : (
                  <button type="button" onClick={() => setReadyForPickup(false)}>Clear Ready For Pickup</button>
                )}
              </div>
            ) : null}
            <table>
              <thead><tr><th>Requirement</th><th>Status</th></tr></thead>
              <tbody>
                {precheckinStatus.items.map((item) => (
                  <tr key={item.label}>
                    <td>{item.label}</td>
                    <td>{item.done ? 'Done' : 'Missing'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ios-actions-wrap" style={{ marginTop: 12 }}>
            <div className="label ios-actions-title">Reservation Actions</div>
            <div className="ios-actions-grid">
              <section className="ios-action-card">
                <div className="ios-action-head">Operations</div>
                <div className="ios-action-list">
                  <button className="ios-action-btn" onClick={() => router.push(`/reservations/${id}/checkout`)}>Start Check-out</button>
                  <button className="ios-action-btn" onClick={() => router.push(`/reservations/${id}/checkin`)}>Start Check-in</button>
                  <button className="ios-action-btn" onClick={() => router.push(`/reservations/${id}/ops-view?section=checkout`)}>View Check-out</button>
                  <button className="ios-action-btn" onClick={() => router.push(`/reservations/${id}/ops-view?section=checkin`)}>View Check-in</button>
                  <button className="ios-action-btn" onClick={() => setStatus('NO_SHOW')}>Mark No Show</button>
                  <button className="ios-action-btn" onClick={() => setStatus('CANCELLED')}>Cancel Reservation</button>
                </div>
              </section>

              <section className="ios-action-card">
                <div className="ios-action-head">Customer Requests</div>
                <div className="ios-action-list">
                  <button className="ios-action-btn" onClick={() => issueLinkAction('customer-info')}>Request Customer Information</button>
                  <button className="ios-action-btn" onClick={() => issueLinkAction('signature')}>Request Signature</button>
                  <button className="ios-action-btn" onClick={() => issueLinkAction('payment')}>Request Payment</button>
                  <button className="ios-action-btn" onClick={emailReservationDetail}>Email Reservation Detail</button>
                  <button className="ios-action-btn" onClick={emailAgreementToCustomer} disabled={!['CHECKED_OUT','CHECKED_IN'].includes(String(row?.status || '').toUpperCase())}>Email Agreement</button>
                </div>
              </section>

              <section className="ios-action-card">
                <div className="ios-action-head">Agreement & Internal</div>
                <div className="ios-action-list">
                  <button className="ios-action-btn" onClick={() => router.push(`/reservations/${id}/payments?total=${Number(effectiveChargeTotal || 0)}`)}>View Payments</button>
                  <button className="ios-action-btn" onClick={() => router.push(`/reservations/${id}/payments?total=${Number(effectiveChargeTotal || 0)}&mode=otc`)}>Record OTC Payment</button>
                  <button className="ios-action-btn" onClick={() => router.push(`/reservations/${id}/additional-drivers`)}>Additional Drivers</button>
                  <button className="ios-action-btn" onClick={handlePrintAgreement}>Print Agreement</button>
                  <button className="ios-action-btn" onClick={() => setActivePanel('notes')}>Notes Page</button>
                  <button className="ios-action-btn" onClick={openLogs}>Log</button>
                </div>
              </section>
            </div>
          </div>

          <div className="glass card" style={{ marginTop: 12, padding: 10 }}>
            <div className="row-between" style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 700 }}>Vehicle</div>
              <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                {row?.vehicle ? `${String(row.vehicle.year || '').trim()} ${String(row.vehicle.make || '').trim()} ${String(row.vehicle.model || '').trim()}`.trim() : 'No vehicle assigned'}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <button className="ios-action-btn" onClick={() => router.push(`/reservations/${id}/inspection`)}>Initiate Inspection Wizard</button>
              <button className="ios-action-btn" onClick={() => router.push(`/reservations/${id}/inspection-report`)}>View Inspections</button>
              <button className="ios-action-btn" onClick={() => router.push(`/reservations/${id}/inspection-report`)}>Print Inspection Report</button>
              <button className="ios-action-btn" onClick={() => router.push(`/reservations/${id}/ops-view`)}>Vehicle Ops View</button>
            </div>
          </div>

          <div className="glass card" style={{ marginTop: 12, padding: 10 }}>
            <div className="row-between" style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 700 }}>Toll Review</div>
              <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                {tollSummary?.totals?.reviewCount ? `${tollSummary.totals.reviewCount} need review` : 'Reservation-linked tolls'}
              </div>
            </div>
            <div className="grid2" style={{ marginBottom: 10 }}>
              <div><span className="label">Total Tolls</span><div>{money(tollSummary?.totals?.totalAmount || 0)}</div></div>
              <div><span className="label">Posted To Charges</span><div>{money(tollSummary?.totals?.postedAmount || 0)}</div></div>
            </div>
            {Array.isArray(tollSummary?.transactions) && tollSummary.transactions.length ? (
              <div className="stack" style={{ gap: 8 }}>
                {tollSummary.transactions.map((toll) => (
                  <div key={toll.id} className="surface-note" style={{ display: 'grid', gap: 8 }}>
                    <div className="row-between" style={{ marginBottom: 0 }}>
                      <strong>{money(toll.amount)} {toll.location ? `- ${toll.location}` : ''}</strong>
                      <span className={`status-chip ${toll.needsReview ? 'warn' : toll.billingStatus === 'POSTED_TO_RESERVATION' ? 'good' : 'neutral'}`}>
                        {toll.needsReview ? 'Needs review' : toll.billingStatus.replaceAll('_', ' ').toLowerCase()}
                      </span>
                    </div>
                    <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                      {new Date(toll.transactionAt).toLocaleString()} · Plate {toll.plateRaw || '-'} · Tag {toll.tagRaw || '-'} · Sello {toll.selloRaw || '-'}
                    </div>
                    <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                      Match: {toll.latestAssignment?.matchReason || toll.reviewNotes || 'reservation-linked'} · Score {toll.latestAssignment?.confidence ?? toll.matchConfidence ?? 0}
                    </div>
                    {toll.billingStatus === 'PENDING' ? (
                      <div className="inline-actions">
                        <button type="button" className="button-subtle" onClick={() => postReservationToll(toll.id)}>Post Toll To Charges</button>
                        <button type="button" className="button-subtle" onClick={() => router.push('/tolls')}>Open Toll Queue</button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="surface-note">
                No tolls are linked to this reservation yet. Once imported into the tenant toll queue, matching uses the assigned vehicle, toll tag, toll sticker, and pickup/return timestamps.
              </div>
            )}
          </div>

          <div style={{ marginTop: 12 }}>
            <div className="label">Memo</div>
            <textarea rows={5} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>

        <div className="glass card-lg">
          {activePanel === 'log' ? (
            <>
              <div className="row-between"><h3>Reservation Log</h3><button onClick={() => setActivePanel('overview')}>Back</button></div>
              <table>
                <thead><tr><th>When</th><th>Action</th><th>User</th><th>From</th></tr></thead>
                <tbody>
                  {auditLogs.map((l) => (
                    <tr key={l.id}>
                      <td>{new Date(l.createdAt).toLocaleString()}</td>
                      <td>{l.action}</td>
                      <td>{l.actorUser?.fullName || l.actorUser?.email || '-'}</td>
                      <td>{l.fromStatus || '-'}</td>                      
                      
                      <td>{l.reason || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : activePanel === 'notes' ? (
            <>
              <div className="row-between"><h3>Reservation Notes</h3><button onClick={() => setActivePanel('overview')}>Back</button></div>
              <textarea rows={18} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              <button onClick={save}>Save Notes</button>
            </>
          ) : (
            <>
              <div className="row-between"><h3>Charges</h3><div style={{ display: 'flex', gap: 8 }}>{canManagePricingOverrides ? <button onClick={handleEditToggle}>{chargeEdit ? 'Cancel Edit' : 'Edit'}</button> : null}{chargeEdit && canManagePricingOverrides ? <button onClick={saveChargeOverrides}>Save Override</button> : null}</div></div>
              {chargeEdit ? (
                <><div className="grid3" style={{ marginBottom: 10 }}>
                      <div className="stack"><label className="label">Daily Rate</label><input value={chargeModel.dailyRate} onChange={(e) => setChargeModel({ ...chargeModel, dailyRate: e.target.value })} /></div>
                      <div className="stack"><label className="label">Tax %</label><input value={chargeModel.taxRate} onChange={(e) => setChargeModel({ ...chargeModel, taxRate: e.target.value })} /></div>
                      <div className="stack"><label className="label">Services</label>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <select value={servicePick} onChange={(e) => setServicePick(e.target.value)}>
                            <option value="">Select service</option>
                            {serviceOptions.map((s) => { const label = (s.name || s.code || s.id || '').trim(); return <option key={s.id} value={label}>{label}</option>; })}
                          </select>
                          <button type="button" onClick={() => { const v = String(servicePick || '').trim(); if (!v) return; const curr = String(chargeModel.serviceNames || '').split(',').map((x) => x.trim()).filter(Boolean); if (!curr.includes(v)) setChargeModel({ ...chargeModel, serviceNames: [...curr, v].join(', ') }); setServicePick(''); } }>Add</button>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                          {String(chargeModel.serviceNames || '').split(',').map((x) => x.trim()).filter(Boolean).map((n) => (
                            <span key={n} className="label" style={{ textTransform: 'none', letterSpacing: 0, border: '1px solid #3a2d5f', borderRadius: 12, padding: '2px 8px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                              {n}
                              <button type="button" title="Remove service" onClick={() => { const next = String(chargeModel.serviceNames || '').split(',').map((x) => x.trim()).filter(Boolean).filter((v) => v !== n); setChargeModel({ ...chargeModel, serviceNames: next.join(', ') }); } }>×</button>
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="stack"><label className="label">Fees</label>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <select value={feePick} onChange={(e) => setFeePick(e.target.value)}>
                            <option value="">Select fee</option>
                            {feeOptions.map((f) => { const label = (f.name || f.code || f.id || '').trim(); return <option key={f.id} value={label}>{label}</option>; })}
                          </select>
                          <button type="button" onClick={() => { const v = String(feePick || '').trim(); if (!v) return; const curr = String(chargeModel.feeNames || '').split(',').map((x) => x.trim()).filter(Boolean); if (!curr.includes(v)) setChargeModel({ ...chargeModel, feeNames: [...curr, v].join(', ') }); setFeePick(''); } }>Add</button>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                          {String(chargeModel.feeNames || '').split(',').map((x) => x.trim()).filter(Boolean).map((n) => (
                            <span key={n} className="label" style={{ textTransform: 'none', letterSpacing: 0, border: '1px solid #3a2d5f', borderRadius: 12, padding: '2px 8px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                              {n}
                              <button type="button" title="Remove fee" onClick={() => { const next = String(chargeModel.feeNames || '').split(',').map((x) => x.trim()).filter(Boolean).filter((v) => v !== n); setChargeModel({ ...chargeModel, feeNames: next.join(', ') }); } }>×</button>
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="stack">
                        <label className="label">Insurance</label>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <select value={chargeModel.insuranceCode || ''} onChange={(e) => setChargeModel({ ...chargeModel, insuranceCode: e.target.value })}>
                            <option value="">No insurance selected</option>
                            {filteredInsurancePlans.map((plan) => {
                              const label = (plan.label || plan.name || plan.code || '').trim();
                              const mode = String(plan.chargeBy || plan.mode || 'FIXED').toUpperCase();
                              const amount = toMoneyNum(plan.amount || 0);
                              const descriptor = mode === 'PERCENTAGE' ? `${amount}%` : money(amount);
                              return <option key={plan.id || plan.code} value={plan.code}>{`${label} — ${descriptor}`}</option>;
                            })}
                          </select>
                          {chargeModel.insuranceCode ? (
                            <button type="button" onClick={() => setChargeModel({ ...chargeModel, insuranceCode: '' })}>Clear</button>
                          ) : null}
                        </div>
                        <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                          {selectedInsurancePlan
                            ? (selectedInsurancePlan.description || 'Plan applied to this reservation.')
                            : 'Optional protection plan for this reservation.'}
                        </div>
                      </div>
                    </div><div className="grid2">
                        <div className="stack">
                          <label className="label">Deposit (Due Now)</label>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={depositOverrides.depositDue}
                            onChange={(e) => setDepositOverrides((prev) => ({
                              ...prev,
                              depositDue: e.target.value
                            }))} />
                        </div>
                        <div className="stack">
                          <label className="label">Security Deposit</label>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={depositOverrides.securityDeposit}
                            onChange={(e) => setDepositOverrides((prev) => ({
                              ...prev,
                              securityDeposit: e.target.value
                            }))} />
                        </div>
                      </div></>
              ) : null}
              <div className="table-shell">
                <table style={{ minWidth: 0, tableLayout: 'fixed' }}>
                  <thead>
                    <tr>
                      <th style={{ width: '48%' }}>Charge</th>
                      <th style={{ width: '14%' }}>Unit</th>
                      <th style={{ width: '18%' }}>Rate</th>
                      <th style={{ width: '20%', textAlign: 'right' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayChargeRows.map((r) => {
                      const canDelete = ['service', 'fee', 'deposit-due', 'security-deposit'].some((key) =>
                        String(r.id || '').toLowerCase().includes(key.replace('-', ''))
                      );

                      return (
                        <tr key={r.id}>
                          <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <span>{r.name}</span>
                              {chargeEdit && canDelete ? (
                                <button
                                  className="link"
                                  onClick={() => removeChargeRow(r)}
                                  title="Remove row"
                                >
                                  Delete
                                </button>
                              ) : null}
                            </div>
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>{toMoneyNum(r.unit || 1)}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{money(r.rate)}</td>
                          <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>{money(r.total)}</td>
                        </tr>
                      );
                    })}
                    <tr>
                      <td colSpan={3}><strong>Total</strong></td>
                      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}><strong>{money(displayTotal)}</strong></td>
                    </tr>
                    {securityDepositDisplayTotal > 0 ? (
                      <tr>
                        <td colSpan={3}><strong>Security Deposit Hold</strong></td>
                        <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                          <strong>{money(securityDepositDisplayTotal)}</strong>
                          <div className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                            {row?.rentalAgreement?.securityDepositCaptured ? 'Authorized in payments' : 'Pending authorization'}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                    <tr>
                      <td colSpan={3}><strong>Unpaid Balance</strong></td>
                      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}><strong>{money(unpaidBalance)}</strong></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {canManageCommissionOwner && row?.rentalAgreement?.id ? (
                <div className="card" style={{ marginTop: 14 }}>
                  <div className="row-between" style={{ marginBottom: 8 }}>
                    <h3 style={{ margin: 0 }}>Commission Owner</h3>
                    <span className="label">Admin only</span>
                  </div>
                  <div className="grid3">
                    <div>
                      <div className="label">Current Owner</div>
                      <div>{commissionOwnerContext?.currentOwner?.fullName || '-'}</div>
                    </div>
                    <div>
                      <div className="label">Checkout User</div>
                      <div>
                        {commissionOwnerContext?.employees?.find((employee) => employee.id === commissionOwnerContext?.checkoutActorUserId)?.fullName
                          || commissionOwnerContext?.checkoutActorUserId
                          || '-'}
                      </div>
                    </div>
                    <div>
                      <div className="label">Rule</div>
                      <div>Commission follows checkout user unless admin overrides it.</div>
                    </div>
                  </div>
                  <div className="grid2" style={{ marginTop: 10, alignItems: 'end' }}>
                    <div className="stack">
                      <label className="label">Assign Commission To</label>
                      <select value={commissionOwnerPick} onChange={(e) => setCommissionOwnerPick(e.target.value)}>
                        <option value="">Select employee</option>
                        {(commissionOwnerContext?.employees || []).map((employee) => (
                          <option key={employee.id} value={employee.id}>
                            {employee.fullName} ({employee.role})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" onClick={() => setCommissionOwnerPick(String(commissionOwnerContext?.checkoutActorUserId || ''))}>
                        Reset To Checkout User
                      </button>
                      <button type="button" onClick={saveCommissionOwnerOverride}>
                        Save Commission Owner
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>
    </AppShell>
  );
}
