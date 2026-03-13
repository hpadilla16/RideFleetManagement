'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';

function parseSelectedAddonsFromMemo(notes) {
  const txt = String(notes || '');
  const m = txt.match(/Services:\s*([^|\n]+)\|\s*Fees:\s*([^\n|]+)/i);
  if (!m) return { services: [], fees: [] };
  const services = String(m[1] || '').split(',').map((x)=>x.trim()).filter(Boolean).filter((x)=>x!=='-');
  const fees = String(m[2] || '').split(',').map((x)=>x.trim()).filter(Boolean).filter((x)=>x!=='-');
  return { services, fees };
}

function extractJsonAfterMarker(notes, marker) {
  const txt = String(notes || '');
  const start = txt.indexOf(marker);
  if (start < 0) return null;
  const jsonStart = txt.indexOf('{', start + marker.length);
  if (jsonStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = jsonStart; i < txt.length; i += 1) {
    const ch = txt[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return txt.slice(jsonStart, i + 1);
    }
  }
  return null;
}

const parseChargeMeta = (notes) => {
  const json = extractJsonAfterMarker(notes, '[RES_CHARGES_META]');
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
};


export default function ReservationDetailPage() {
return <AuthGate>{({ token, me, logout }) => <ReservationDetailInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function parseChargeRowsTotalFromNotes(notes) {
const json = extractJsonAfterMarker(notes, '[RES_CHARGES_META]');
if (!json) return 0;
try {
const j = JSON.parse(json);
const rows = Array.isArray(j?.chargeRows) ? j.chargeRows : [];
return Number(rows.reduce((s, r) => s + Number(r?.total || 0), 0).toFixed(2));
} catch {
return 0;
}
}

function parsePaymentsTotalFromNotes(notes) {
const txt = String(notes || '');
const re = /^\[PAYMENT\s+[^\]]+\]\s+[^\s]+\s+paid\s+([0-9]+(?:\.[0-9]+)?)\s+ref=.*$/gim;
let m;
let sum = 0;
while ((m = re.exec(txt)) !== null) sum += Number(m[1] || 0);
return Number(sum.toFixed(2));
}
const toMoneyNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const money = (n) => `$${toMoneyNum(n).toFixed(2)}`;

function ReservationDetailInner({ token, me, logout }) {
  const { id } = useParams();
  const router = useRouter();

  const [row, setRow] = useState(null);
  const [locations, setLocations] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [serviceOptions, setServiceOptions] = useState([]);
  const [feeOptions, setFeeOptions] = useState([]);
  const [servicePick, setServicePick] = useState('');
  const [feePick, setFeePick] = useState('');
  const [msg, setMsg] = useState('');
  const [activePanel, setActivePanel] = useState('overview');
  const [auditLogs, setAuditLogs] = useState([]);
  const [chargeEdit, setChargeEdit] = useState(false);
  const [chargeModel, setChargeModel] = useState({ dailyRate: '0', serviceFee: '0', taxRate: '11.5', serviceNames: '', feeNames: '' });
  const [form, setForm] = useState({ customerId: '', pickupAt: '', returnAt: '', pickupLocationId: '', returnLocationId: '', notes: '' });


  const cleanMojibake = (val) => {
    const s = String(val || '');
    if (!s) return '';
    try { return decodeURIComponent(escape(s)); } catch { return s; }
  };
  const load = async () => {
    const [r, l, c, svc, fee] = await Promise.all([
      api(`/api/reservations/${id}`, {}, token),
      api('/api/locations', {}, token),
      api('/api/customers', {}, token),
      api('/api/additional-services', {}, token).catch(() => []),
      api('/api/fees', {}, token).catch(() => [])
    ]);
    setRow(r);
    setLocations(l);
    setCustomers(c);
    setServiceOptions(Array.isArray(svc) ? svc : []);
    setFeeOptions(Array.isArray(fee) ? fee : []);
    setForm({
      customerId: r.customerId || '',
      pickupAt: r.pickupAt ? new Date(r.pickupAt).toISOString().slice(0, 16) : '',
      returnAt: r.returnAt ? new Date(r.returnAt).toISOString().slice(0, 16) : '',
      pickupLocationId: r.pickupLocationId || '',
      returnLocationId: r.returnLocationId || '',
      notes: r.notes || ''
    });
    const memoSel = parseSelectedAddonsFromMemo(r.notes);
    setChargeModel((prev) => ({ ...prev, dailyRate: String(r.dailyRate ?? '0'), serviceNames: memoSel.services.join(', '), feeNames: memoSel.fees.join(', ') }));
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

      setMsg(`${actionLabel} email sent to ${out?.sentTo?.join(', ') || recipients.join(', ')}`);
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
  const openLogs = async () => {
    try {
      const logs = await api(`/api/reservations/${id}/audit-logs`, {}, token);
      setAuditLogs(logs || []);
      setActivePanel('log');
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
    const dbPaid = Number((row?.payments || []).reduce((s, p) => s + Number(p?.amount || 0), 0));
    const notePaid = Number(parsePaymentsTotalFromNotes(row?.notes));
    const a = Number.isFinite(dbPaid) ? dbPaid : 0;
    const b = Number.isFinite(notePaid) ? notePaid : 0;
    return Number(Math.max(a, b).toFixed(2));
  }, [row?.payments, row?.notes]);

  const chargeTableTotal = useMemo(() => {
    return Number(toMoneyNum(parseChargeRowsTotalFromNotes(row?.notes)).toFixed(2));
  }, [row?.notes]);

  const effectiveChargeTotal = useMemo(() => {
    const table = Number(chargeTableTotal);
    const breakdownTotal = Number(breakdown?.total);
    const a = Number.isFinite(table) ? table : 0;
    const b = Number.isFinite(breakdownTotal) ? breakdownTotal : 0;
    return Number(Math.max(a, b).toFixed(2));
  }, [chargeTableTotal, breakdown?.total]);

  const unpaidBalance = useMemo(() => {
    const total = Number(effectiveChargeTotal);
    const paid = Number(paidTotal);
    const a = Number.isFinite(total) ? total : 0;
    const b = Number.isFinite(paid) ? paid : 0;
    return Number((a - b).toFixed(2));
  }, [effectiveChargeTotal, paidTotal]);

  const [depositOverrides, setDepositOverrides] = useState({
    depositDue: '',
    securityDeposit: ''
  });

  useEffect(() => {
    setDepositOverrides({
      depositDue:
        row?.depositSummary?.lines?.find((d) => /deposit \\(due now\\)/i.test(d.name || ''))?.total?.toString() || '',
      securityDeposit:
        row?.depositSummary?.lines?.find((d) => /security deposit/i.test(d.name || ''))?.total?.toString() || ''
    });
  }, [row?.depositSummary]);

  const handleEditToggle = () => {
    if (!chargeEdit) {
      const meta = parseChargeMeta(row?.notes);
      if (meta) {
        setChargeModel((prev) => ({
          ...prev,
          dailyRate: meta.dailyRate ?? prev.dailyRate,
          taxRate: meta.taxRate ?? prev.taxRate,
          serviceNames: (meta.selectedServices || []).join(', '),
          feeNames: (meta.selectedFees || []).join(', ')
        }));
      }
    }
    setChargeEdit((v) => !v);
  };

  const removeChargeRow = (row) => {
    const id = String(row?.id || '').toLowerCase();

    if (id.startsWith('svc-')) {
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
const cleanNotes = String(form.notes || '')
  .replace(/\n?\[RES_CHARGES_META][\s\S]*$/m, '')
  .trim();
const summaryLine = `Services: ${String(chargeModel.serviceNames || '').trim() || '-'} | Fees: ${String(
  chargeModel.feeNames || ''
).trim() || '-'}`;

const serviceNames = String(chargeModel.serviceNames || '')
.split(',')
.map((x) => x.trim())
.filter(Boolean);

const feeNames = String(chargeModel.feeNames || '')
.split(',')
.map((x) => x.trim())
.filter(Boolean);

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
taxable: opt?.taxable !== false
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
taxable: opt?.taxable !== false
};
});

const baseRow = {
id: 'daily',
name: 'Daily',
chargeType: 'DAILY',
quantity: breakdown.days,
rate: toMoneyNum(chargeModel.dailyRate || row?.dailyRate || 0),
total: toMoneyNum((chargeModel.dailyRate || row?.dailyRate || 0) * breakdown.days),
taxable: true
};

const coreRows = [baseRow, ...serviceRows, ...feeRows];

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
taxable: false
}
: null;

const normalizedRows = taxRow ? [...coreRows, taxRow] : coreRows;

const depositRows = [];
if (Number(depositOverrides.depositDue || 0) > 0) {
depositRows.push({
id: 'deposit-due',
name: 'Deposit (Due Now)',
chargeType: 'DEPOSIT',
quantity: 1,
rate: Number(depositOverrides.depositDue),
total: Number(depositOverrides.depositDue),
taxable: false
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
taxable: false
});
}

const meta = {
dailyRate: Number(chargeModel.dailyRate || row?.dailyRate || 0),
taxRate: Number(chargeModel.taxRate || 0),
selectedServices: String(chargeModel.serviceNames || '')
.split(',')
.map((x) => x.trim())
.filter(Boolean),
selectedFees: String(chargeModel.feeNames || '')
.split(',')
.map((x) => x.trim())
.filter(Boolean),
chargeRows: [...normalizedRows, ...depositRows]
};

const depositMeta = {
requireDeposit: Number(depositOverrides.depositDue || 0) > 0,
depositAmountDue: Number(depositOverrides.depositDue || 0)
};

const securityMeta = {
requireSecurityDeposit: Number(depositOverrides.securityDeposit || 0) > 0,
securityDepositAmount: Number(depositOverrides.securityDeposit || 0)
};

const notesWithMeta = `${cleanNotes}${cleanNotes ? '\n' : ''}${summaryLine}
[RES_CHARGES_META]${JSON.stringify(meta)}
[RES_DEPOSIT_META]${JSON.stringify(depositMeta)}
[SECURITY_DEPOSIT_META]${JSON.stringify(securityMeta)}`;

await api(
`/api/reservations/${id}`,
{
method: 'PATCH',
body: JSON.stringify({
notes: notesWithMeta,
dailyRate: Number(chargeModel.dailyRate || row?.dailyRate || 0)
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

  const selectedServiceRows = useMemo(() => {
    const json = extractJsonAfterMarker(row?.notes, '[RES_CHARGES_META]');
    try {
      const j = json ? JSON.parse(json) : null;
      const names = Array.isArray(j?.selectedServices) ? j.selectedServices : [];
      return names.map((n, i) => ({ id: `svc-${i}`, name: `Service: ${n}` }));
    } catch { return []; }
  }, [row?.notes]);

  const selectedFeeRows = useMemo(() => {
    const json = extractJsonAfterMarker(row?.notes, '[RES_CHARGES_META]');
    try {
      const j = json ? JSON.parse(json) : null;
      const names = Array.isArray(j?.selectedFees) ? j.selectedFees : [];
      return names.map((n, i) => ({ id: `fee-${i}`, name: `Fee: ${n}` }));
    } catch { return []; }
  }, [row?.notes]);

  const displayChargeRows = useMemo(() => {
    const notes = row?.notes;
    const metaJson = extractJsonAfterMarker(notes, '[RES_CHARGES_META]');
    const depJson = extractJsonAfterMarker(notes, '[RES_DEPOSIT_META]');

    let meta = null;
    let dep = null;
    try { meta = metaJson ? JSON.parse(metaJson) : null; } catch {}
    try { dep = depJson ? JSON.parse(depJson) : null; } catch {}

    const fromMeta = Array.isArray(meta?.chargeRows) ? meta.chargeRows : [];
    if (fromMeta.length) {
      return fromMeta.map((r, i) => ({
        id: `meta-${i}`,
        name: String(r?.name || r?.label || r?.code || `Charge ${i + 1}`),
        unit: toMoneyNum(r?.unit || 1),
        rate: toMoneyNum(r?.rate ?? r?.amount ?? r?.total ?? 0),
        total: toMoneyNum(r?.total ?? r?.amount ?? r?.rate ?? 0)
      }));
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

    const rows = [
      { id: 'daily', name: 'Daily', unit: breakdown.days, rate: breakdown.daily, total: breakdown.base, taxable: true },
      ...serviceRows,
      ...feeRows
    ];

    const taxRatePct = toMoneyNum(chargeModel.taxRate || breakdown.taxRate || 0);
    const taxableSubTotal = toMoneyNum(rows.reduce((s, r) => s + (r?.taxable === false ? 0 : toMoneyNum(r?.total)), 0));
    const taxTotal = toMoneyNum(taxableSubTotal * (taxRatePct / 100));
    if (taxTotal > 0) rows.push({ id: 'tax', name: `Sales Tax (${taxRatePct.toFixed(2)}%)`, unit: 1, rate: taxTotal, total: taxTotal, taxable: false });

    const depDue = toMoneyNum(dep?.depositAmountDue);
    if (depDue > 0) rows.push({ id: 'deposit-due', name: 'Deposit (Due Now)', unit: 1, rate: depDue, total: depDue });

    let locCfg = row?.pickupLocation?.locationConfig;
    try { if (typeof locCfg === 'string') locCfg = JSON.parse(locCfg); } catch { locCfg = {}; }
    const sec = toMoneyNum(locCfg?.securityDepositAmount ?? locCfg?.securityDeposit ?? 0);
    if (sec > 0) rows.push({ id: 'security-deposit', name: 'Security Deposit', unit: 1, rate: sec, total: sec });

    return rows;
  }, [row?.notes, row?.pickupLocation?.locationConfig, breakdown, selectedServiceRows, selectedFeeRows, serviceOptions, feeOptions, chargeModel?.taxRate]);

  const displayTotal = useMemo(() => toMoneyNum(displayChargeRows.reduce((s, r) => s + toMoneyNum(r?.total), 0)), [displayChargeRows]);


	if (!row) {
	return (
	<AppShell me={me} logout={logout}>
	<section className="glass card-lg">Loading reservation...</section>
	</AppShell>
	);
	}
  return (
    <AppShell me={me} logout={logout}>
      {msg ? <p className="label">{msg}</p> : null}
      <section className="grid2">
        <div className="glass card-lg">
          <div className="row-between"><h2>Reservation # {row.reservationNumber}</h2><button onClick={save}>Save</button></div>
          <div className="grid2">
            <div><span className="label">Status</span><div>{row.status}</div></div>
            <div><span className="label">Type</span><div>{row.vehicleType?.name || '-'}</div></div>
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
                  <button className="ios-action-btn" onClick={async () => { if (['CHECKED_OUT','CHECKED_IN'].includes(String(row?.status || '').toUpperCase())) { try { await api(`/api/reservations/${id}/start-rental`, { method: 'POST', body: JSON.stringify({}) }, token); } catch {} window.print(); } else { setMsg('Print Agreement is available after check-out.'); } }}>Print Agreement</button>
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
              <div className="row-between"><h3>Charges</h3><div style={{ display: 'flex', gap: 8 }}><button onClick={handleEditToggle}>{chargeEdit ? 'Cancel Edit' : 'Edit'}</button>{chargeEdit ? <button onClick={saveChargeOverrides}>Save Override</button> : null}</div></div>
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
              <table>
                <thead><tr><th>Charge</th><th>Unit</th><th>Rate</th><th>Total</th></tr></thead>
                <tbody>
                  {displayChargeRows.map((r) => {
                    const canDelete = ['service', 'fee', 'deposit-due', 'security-deposit'].some((key) =>
                      String(r.id || '').toLowerCase().includes(key.replace('-', ''))
                    );

                    return (
                      <tr key={r.id}>
                        <td style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {r.name}
                          {chargeEdit && canDelete ? (
                            <button
                              className="link"
                              onClick={() => removeChargeRow(r)}
                              title="Remove row"
                            >
                              Delete
                            </button>
                          ) : null}
                        </td>
                        <td>{toMoneyNum(r.unit || 1)}</td>
                        <td>{money(r.rate)}</td>
                        <td>{money(r.total)}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td colSpan={3}><strong>Total</strong></td>
                    <td><strong>{money(displayTotal)}</strong></td>
                  </tr>
                  <tr>
                    <td colSpan={3}><strong>Unpaid Balance</strong></td>
                    <td><strong>{money(Math.max(0, toMoneyNum(displayTotal) - toMoneyNum(paidTotal)))}</strong></td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>
      </section>
    </AppShell>
  );
}
