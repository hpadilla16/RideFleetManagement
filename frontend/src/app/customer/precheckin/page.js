'use client';

import { useEffect, useState } from 'react';
import { API_BASE } from '../../../lib/client';
import { PortalFrame, portalStyles } from '../_components/PortalFrame';
import { PortalTimelineCard } from '../_components/PortalTimelineCard';

const PRECHECKIN_DRAFT_PREFIX = 'customer.precheckin.';
const MAX_INLINE_PDF_BYTES = 350 * 1024;

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to process image'));
    image.src = dataUrl;
  });
}

function toDateInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

async function fileToDataUrl(file) {
  if (!file) return '';
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Unable to read file'));
    reader.readAsDataURL(file);
  });
}

async function compressImageDataUrl(dataUrl, { maxWidth = 1400, maxHeight = 1400, quality = 0.72 } = {}) {
  const image = await loadImage(dataUrl);
  let width = image.width || maxWidth;
  let height = image.height || maxHeight;
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

async function toCompactUploadPayload(file) {
  if (!file) return '';
  if (String(file.type || '').startsWith('image/')) {
    const raw = await fileToDataUrl(file);
    return compressImageDataUrl(raw);
  }
  if (String(file.type || '').includes('pdf')) {
    if (Number(file.size || 0) > MAX_INLINE_PDF_BYTES) {
      throw new Error(`PDF "${file.name}" is too large. Please keep PDFs under ${Math.round(MAX_INLINE_PDF_BYTES / 1024)} KB.`);
    }
    return fileToDataUrl(file);
  }
  return fileToDataUrl(file);
}

async function compactPrecheckinPayload(form) {
  const next = { ...form };
  if (String(next.idPhotoUrl || '').startsWith('data:image/')) {
    next.idPhotoUrl = await compressImageDataUrl(next.idPhotoUrl, { maxWidth: 1400, maxHeight: 1400, quality: 0.72 });
  }
  if (String(next.insuranceDocumentUrl || '').startsWith('data:image/')) {
    next.insuranceDocumentUrl = await compressImageDataUrl(next.insuranceDocumentUrl, { maxWidth: 1400, maxHeight: 1400, quality: 0.72 });
  }
  return next;
}

async function readJsonOrThrowFriendly(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    if (/entity too large|request entity too large|payload too large|413/i.test(text)) {
      throw new Error('The uploaded files are too large. Please use smaller photos or a PDF under 350 KB.');
    }
    if (/<html/i.test(text)) {
      throw new Error('The server rejected the pre-check-in upload. Please re-upload smaller document images and try again.');
    }
    throw new Error(text.slice(0, 240));
  }
}

const EMPTY_FORM = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  dateOfBirth: '',
  licenseNumber: '',
  licenseState: '',
  insurancePolicyNumber: '',
  insuranceDocumentUrl: '',
  address1: '',
  address2: '',
  city: '',
  state: '',
  zip: '',
  country: '',
  idPhotoUrl: ''
};

const PRECHECKIN_REQUIRED_FIELDS = [
  ['firstName', 'First Name'],
  ['lastName', 'Last Name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['dateOfBirth', 'Date of Birth'],
  ['licenseNumber', 'Driver License Number'],
  ['licenseState', 'Driver License State'],
  ['address1', 'Address Line 1'],
  ['city', 'City'],
  ['state', 'State'],
  ['zip', 'ZIP'],
  ['country', 'Country'],
  ['idPhotoUrl', 'ID / License Photo'],
  ['insuranceDocumentUrl', 'Insurance Document']
];

function precheckinDraftKey(token) {
  return `${PRECHECKIN_DRAFT_PREFIX}${token}`;
}

function restorePrecheckinDraft(token) {
  if (!token || typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(precheckinDraftKey(token));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      ...EMPTY_FORM,
      ...parsed
    };
  } catch {
    return null;
  }
}

export default function PrecheckinPage() {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [model, setModel] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [insurancePlans, setInsurancePlans] = useState([]);
  const [additionalServices, setAdditionalServices] = useState([]);
  const [existingCharges, setExistingCharges] = useState([]);
  const [insuranceSelection, setInsuranceSelection] = useState({
    selectedPlanCode: '',
    declinedCoverage: false,
    denyInitials: '',
    responsibilityInitials: '',
    chargeInitials: '',
    ownPolicyNumber: ''
  });
  const [selectedServices, setSelectedServices] = useState({});
  const [thirdPartyBooking, setThirdPartyBooking] = useState({ isThirdParty: null, voucherUrl: '' });
  const [precheckinDiscount, setPrecheckinDiscount] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get('token') || '');
  }, []);

  useEffect(() => {
    const run = async () => {
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/api/public/customer-info/${encodeURIComponent(token)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || 'Unable to load pre-check-in');
        setModel(json);
        setInsurancePlans(json?.insurancePlans || []);
        setAdditionalServices(json?.additionalServices || []);
        setPrecheckinDiscount(json?.precheckinDiscount || null);
        setExistingCharges(json?.existingCharges || []);

        // Restore existing insurance selection from charges
        const existingInsuranceCharge = (json?.existingCharges || []).find(c => c.source === 'INSURANCE' && c.selected);
        if (existingInsuranceCharge) {
          setInsuranceSelection(prev => ({ ...prev, selectedPlanCode: existingInsuranceCharge.sourceRefId || '' }));
        }

        // Restore existing service selections from charges
        const svcState = {};
        (json?.existingCharges || []).filter(c => (c.source === 'ADDITIONAL_SERVICE' || c.source === 'ADDITIONAL_SERVICE_PRECHECKIN') && c.selected).forEach(c => {
          svcState[c.sourceRefId] = { selected: true, quantity: Number(c.quantity || 1) };
        });
        // Also mark mandatory services
        (json?.additionalServices || []).forEach(s => {
          if (s.mandatory && !svcState[s.id]) svcState[s.id] = { selected: true, quantity: s.defaultQty || 1 };
        });
        setSelectedServices(svcState);

        const serverForm = {
          firstName: json?.reservation?.customer?.firstName || '',
          lastName: json?.reservation?.customer?.lastName || '',
          email: json?.reservation?.customer?.email || '',
          phone: json?.reservation?.customer?.phone || '',
          dateOfBirth: toDateInput(json?.reservation?.customer?.dateOfBirth),
          licenseNumber: json?.reservation?.customer?.licenseNumber || '',
          licenseState: json?.reservation?.customer?.licenseState || '',
          insurancePolicyNumber: json?.reservation?.customer?.insurancePolicyNumber || '',
          insuranceDocumentUrl: json?.reservation?.customer?.insuranceDocumentUrl || '',
          address1: json?.reservation?.customer?.address1 || '',
          address2: json?.reservation?.customer?.address2 || '',
          city: json?.reservation?.customer?.city || '',
          state: json?.reservation?.customer?.state || '',
          zip: json?.reservation?.customer?.zip || '',
          country: json?.reservation?.customer?.country || '',
          idPhotoUrl: json?.reservation?.customer?.idPhotoUrl || ''
        };
        const draft = restorePrecheckinDraft(token);
        setForm(draft ? { ...serverForm, ...draft } : serverForm);
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [token]);

  const updateField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  useEffect(() => {
    if (!token) return;
    try {
      const hasDraft = Object.values(form).some((value) => !!value);
      if (hasDraft) localStorage.setItem(precheckinDraftKey(token), JSON.stringify(form));
      else localStorage.removeItem(precheckinDraftKey(token));
    } catch {}
  }, [form, token]);

  const uploadField = async (key, file) => {
    try {
      const dataUrl = await toCompactUploadPayload(file);
      updateField(key, dataUrl);
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  const submit = async () => {
    try {
      setSaving(true);
      setError('');
      setOk('');
      if (missingRequiredFields.length) {
        throw new Error(`Complete the required pre-check-in items first: ${missingRequiredFields.join(', ')}`);
      }
      const payload = await compactPrecheckinPayload(form);
      payload.insuranceSelection = insuranceSelection;
      payload.selectedServices = Object.entries(selectedServices)
        .filter(([, v]) => v.selected)
        .map(([serviceId, v]) => ({ serviceId, selected: true, quantity: v.quantity || 1 }));
      if (thirdPartyBooking.isThirdParty !== null) {
        let voucherUrl = thirdPartyBooking.voucherUrl || '';
        if (String(voucherUrl).startsWith('data:image/')) {
          voucherUrl = await compressImageDataUrl(voucherUrl, { maxWidth: 1400, maxHeight: 1400, quality: 0.72 });
        }
        payload.thirdPartyBooking = { isThirdParty: thirdPartyBooking.isThirdParty, voucherUrl };
      }
      const res = await fetch(`${API_BASE}/api/public/customer-info/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await readJsonOrThrowFriendly(res);
      if (!res.ok) throw new Error(json?.error || 'Unable to submit pre-check-in');
      setOk(json?.message || 'Pre-check-in completed.');
      try { localStorage.removeItem(precheckinDraftKey(token)); } catch {}
      setModel((prev) => ({
        ...(prev || {}),
        portal: json?.portal || prev?.portal || null,
        reservation: {
          ...(prev?.reservation || {}),
          customerInfoCompletedAt: json?.completedAt || new Date().toISOString(),
          customer: { ...(prev?.reservation?.customer || {}), ...payload }
        }
      }));
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  const reservation = model?.reservation;
  const nextPortalStep = model?.portal?.nextStep;
  const profileFieldsComplete = [
    form.firstName,
    form.lastName,
    form.email,
    form.phone,
    form.dateOfBirth,
    form.licenseNumber,
    form.licenseState,
    form.address1,
    form.city,
    form.state,
    form.zip,
    form.country
  ].filter(Boolean).length;
  const customerSelectedOurInsurance = !!insuranceSelection.selectedPlanCode && !insuranceSelection.declinedCoverage;
  const uploadedDocs = [form.idPhotoUrl, ...(customerSelectedOurInsurance ? [] : [form.insuranceDocumentUrl])].filter(Boolean).length;
  const totalDocsNeeded = customerSelectedOurInsurance ? 1 : 2;
  const precheckinRequiredFields = [
    ['firstName', 'First Name'],
    ['lastName', 'Last Name'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['dateOfBirth', 'Date of Birth'],
    ['licenseNumber', 'Driver License Number'],
    ['licenseState', 'Driver License State'],
    ['address1', 'Address Line 1'],
    ['city', 'City'],
    ['state', 'State'],
    ['zip', 'ZIP'],
    ['country', 'Country'],
    ['idPhotoUrl', 'ID / License Photo'],
    ...(customerSelectedOurInsurance ? [] : [['insuranceDocumentUrl', 'Insurance Document']])
  ];
  const missingRequiredFields = precheckinRequiredFields
    .filter(([key]) => !String(form?.[key] || '').trim())
    .map(([, label]) => label);

  const notices = (
    <div style={portalStyles.stack}>
      {loading ? <div style={{ ...portalStyles.notice, background: 'rgba(79, 70, 229, 0.08)', color: '#4338ca' }}>Loading your pre-check-in checklist...</div> : null}
      {error ? <div style={{ ...portalStyles.notice, background: 'rgba(220, 38, 38, 0.12)', color: '#991b1b' }}>{error}</div> : null}
      {ok ? <div style={{ ...portalStyles.notice, background: 'rgba(22, 163, 74, 0.12)', color: '#166534' }}>{ok}</div> : null}
    </div>
  );

  return (
    <PortalFrame
      eyebrow="Ride Fleet Self-Service"
      title="Complete Your Pre-Check-in"
      subtitle="Share your contact details, driver information, and supporting documents before pickup so the counter team can get you on the road faster."
      aside={(
        <PortalTimelineCard
          portal={model?.portal}
          reservation={reservation}
          currentStepKey="customerInfo"
          currentStepLabel="Pre-check-in"
          portalKind="customer-info"
          token={token}
          onPortalUpdate={(nextPortal) => setModel((prev) => ({ ...(prev || {}), portal: nextPortal }))}
        />
      )}
    >
      {notices}

      {!loading && reservation ? (
        <>
          <div style={{ ...portalStyles.card, border: thirdPartyBooking.isThirdParty === null ? '2px solid rgba(245,158,11,0.4)' : '1px solid rgba(110,73,255,0.12)' }}>
            <h2 style={portalStyles.cardTitle}>Booking Source</h2>
            <p style={{ color: '#55456f', lineHeight: 1.6, marginBottom: 16 }}>
              Did you book this reservation through a third-party website (e.g. Expedia, Priceline, AutoSlash, or another travel agency)?
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => setThirdPartyBooking((prev) => ({ ...prev, isThirdParty: true }))}
                style={{
                  padding: '12px 24px', borderRadius: 12, fontWeight: 800, fontSize: '0.95rem', cursor: 'pointer',
                  border: thirdPartyBooking.isThirdParty === true ? '2px solid #6e49ff' : '1.5px solid rgba(110,73,255,.18)',
                  background: thirdPartyBooking.isThirdParty === true ? 'rgba(110,73,255,.08)' : 'rgba(255,255,255,.9)',
                  color: thirdPartyBooking.isThirdParty === true ? '#4c1d95' : '#53607b',
                  transition: 'all 0.18s',
                }}
              >
                Yes — I booked through a third party
              </button>
              <button
                type="button"
                onClick={() => setThirdPartyBooking({ isThirdParty: false, voucherUrl: '' })}
                style={{
                  padding: '12px 24px', borderRadius: 12, fontWeight: 800, fontSize: '0.95rem', cursor: 'pointer',
                  border: thirdPartyBooking.isThirdParty === false ? '2px solid #16a34a' : '1.5px solid rgba(110,73,255,.18)',
                  background: thirdPartyBooking.isThirdParty === false ? 'rgba(22,163,74,.08)' : 'rgba(255,255,255,.9)',
                  color: thirdPartyBooking.isThirdParty === false ? '#166534' : '#53607b',
                  transition: 'all 0.18s',
                }}
              >
                No — I booked directly
              </button>
            </div>

            {thirdPartyBooking.isThirdParty === true && (
              <div style={{ marginTop: 20, display: 'grid', gap: 14, padding: '18px 20px', borderRadius: 14, background: 'rgba(110,73,255,.04)', border: '1px solid rgba(110,73,255,.14)' }}>
                <div style={{ fontWeight: 700, color: '#1e2847' }}>Upload your booking voucher or confirmation</div>
                <p style={{ color: '#6b7a9a', fontSize: '0.88rem', lineHeight: 1.6, margin: 0 }}>
                  Please upload a screenshot or PDF of your booking confirmation from the third-party website. This serves as your prepaid voucher.
                </p>
                <input
                  style={portalStyles.input}
                  type="file"
                  accept="image/*,.pdf"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    toCompactUploadPayload(file)
                      .then((dataUrl) => setThirdPartyBooking((prev) => ({ ...prev, voucherUrl: dataUrl })))
                      .catch((err) => setError(String(err.message || err)));
                  }}
                />
                <div style={{ fontSize: '0.84rem', color: thirdPartyBooking.voucherUrl ? '#166534' : '#6b7a9a' }}>
                  {thirdPartyBooking.voucherUrl ? '✓ Voucher attached' : 'Required — upload your third-party booking confirmation'}
                </div>
                <div style={{ ...portalStyles.notice, background: 'rgba(245,158,11,0.1)', color: '#92400e', fontSize: '0.88rem' }}>
                  Since your trip was prepaid through a third party, the daily rate and standard charges will be removed from this reservation. Only add-on services selected here will apply.
                </div>
              </div>
            )}
            {thirdPartyBooking.isThirdParty === false && (
              <div style={{ marginTop: 12, fontSize: '0.88rem', color: '#166534', fontWeight: 600 }}>
                ✓ Direct booking — your reservation rates apply as quoted.
              </div>
            )}
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Pre-Check-in Snapshot</h2>
            <div style={portalStyles.statGrid}>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Profile Fields</div>
                <div style={portalStyles.statValue}>{profileFieldsComplete}/12</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Documents</div>
                <div style={portalStyles.statValue}>{uploadedDocs}/{totalDocsNeeded}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Trip Protection</div>
                <div style={portalStyles.statValue}>
                  {insuranceSelection.selectedPlanCode ? 'Plan Selected'
                    : insuranceSelection.declinedCoverage ? 'Declined'
                    : 'Not Selected'}
                </div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Missing Required Items</div>
                <div style={portalStyles.statValue}>{missingRequiredFields.length}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Current Status</div>
                <div style={portalStyles.statValue}>{reservation.customerInfoCompletedAt ? 'Submitted' : 'In Progress'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Next Step</div>
                <div style={portalStyles.statValue}>{nextPortalStep?.key && nextPortalStep.key !== 'customerInfo' ? nextPortalStep.label : 'Counter team review'}</div>
              </div>
            </div>
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Before You Submit</h2>
            <div style={portalStyles.statGrid}>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>What We Need</div>
                <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.35 }}>Your contact details, license, address, and support documents.</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>What Happens Next</div>
                <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.35 }}>{nextPortalStep?.key && nextPortalStep.key !== 'customerInfo' ? nextPortalStep.label : 'Counter team review'}</div>
              </div>
            </div>
            <div style={{ marginTop: 12, color: '#55456f', lineHeight: 1.6 }}>
              After this step, keep an eye on your email. We send the next secure link there so you can finish everything before pickup.
            </div>
            {missingRequiredFields.length ? (
              <div style={{ ...portalStyles.notice, marginTop: 12, background: 'rgba(245, 158, 11, 0.15)', color: '#92400e' }}>
                Missing before submit: {missingRequiredFields.join(', ')}
              </div>
            ) : null}
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Reservation Summary</h2>
            <div style={portalStyles.statGrid}>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Reservation</div>
                <div style={portalStyles.statValue}>{reservation.reservationNumber}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Status</div>
                <div style={portalStyles.statValue}>{reservation.status || '-'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Vehicle</div>
                <div style={portalStyles.statValue}>{reservation.vehicle || '-'}</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Pre-check-in</div>
                <div style={portalStyles.statValue}>{reservation.customerInfoCompletedAt ? 'Submitted' : 'Pending'}</div>
              </div>
            </div>
            <div style={{ marginTop: 14, color: '#55456f', lineHeight: 1.6 }}>
              <div><strong>Pickup:</strong> {reservation.pickupAt ? new Date(reservation.pickupAt).toLocaleString() : '-'} ({reservation.pickupLocation || '-'})</div>
              <div><strong>Return:</strong> {reservation.returnAt ? new Date(reservation.returnAt).toLocaleString() : '-'} ({reservation.returnLocation || '-'})</div>
              <div><strong>Last completed:</strong> {reservation.customerInfoCompletedAt ? new Date(reservation.customerInfoCompletedAt).toLocaleString() : 'Not yet submitted'}</div>
            </div>
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Contact Information</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <div>
                <label style={portalStyles.sectionTitle}>First Name</label>
                <input style={portalStyles.input} value={form.firstName} onChange={(e) => updateField('firstName', e.target.value)} />
              </div>
              <div>
                <label style={portalStyles.sectionTitle}>Last Name</label>
                <input style={portalStyles.input} value={form.lastName} onChange={(e) => updateField('lastName', e.target.value)} />
              </div>
              <div>
                <label style={portalStyles.sectionTitle}>Email</label>
                <input style={portalStyles.input} type="email" value={form.email} onChange={(e) => updateField('email', e.target.value)} />
              </div>
              <div>
                <label style={portalStyles.sectionTitle}>Phone</label>
                <input style={portalStyles.input} value={form.phone} onChange={(e) => updateField('phone', e.target.value)} />
              </div>
              <div>
                <label style={portalStyles.sectionTitle}>Date of Birth</label>
                <input style={portalStyles.input} type="date" value={form.dateOfBirth} onChange={(e) => updateField('dateOfBirth', e.target.value)} />
              </div>
              <div>
                <label style={portalStyles.sectionTitle}>Insurance Policy Number</label>
                <input style={portalStyles.input} value={form.insurancePolicyNumber} onChange={(e) => updateField('insurancePolicyNumber', e.target.value)} />
              </div>
            </div>
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Driver Information</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <div>
                <label style={portalStyles.sectionTitle}>License Number</label>
                <input style={portalStyles.input} value={form.licenseNumber} onChange={(e) => updateField('licenseNumber', e.target.value)} />
              </div>
              <div>
                <label style={portalStyles.sectionTitle}>License State</label>
                <input style={portalStyles.input} value={form.licenseState} onChange={(e) => updateField('licenseState', e.target.value)} />
              </div>
            </div>
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Home Address</h2>
            <div style={portalStyles.stack}>
              <div>
                <label style={portalStyles.sectionTitle}>Address Line 1</label>
                <input style={portalStyles.input} value={form.address1} onChange={(e) => updateField('address1', e.target.value)} />
              </div>
              <div>
                <label style={portalStyles.sectionTitle}>Address Line 2</label>
                <input style={portalStyles.input} value={form.address2} onChange={(e) => updateField('address2', e.target.value)} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                <div>
                  <label style={portalStyles.sectionTitle}>City</label>
                  <input style={portalStyles.input} value={form.city} onChange={(e) => updateField('city', e.target.value)} />
                </div>
                <div>
                  <label style={portalStyles.sectionTitle}>State</label>
                  <input style={portalStyles.input} value={form.state} onChange={(e) => updateField('state', e.target.value)} />
                </div>
                <div>
                  <label style={portalStyles.sectionTitle}>ZIP</label>
                  <input style={portalStyles.input} value={form.zip} onChange={(e) => updateField('zip', e.target.value)} />
                </div>
                <div>
                  <label style={portalStyles.sectionTitle}>Country</label>
                  <input style={portalStyles.input} value={form.country} onChange={(e) => updateField('country', e.target.value)} />
                </div>
              </div>
            </div>
          </div>

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Upload Documents</h2>
            <div style={portalStyles.statGrid}>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>ID / License Photo</div>
                <div style={portalStyles.statValue}>{form.idPhotoUrl ? 'Attached' : 'Missing'}</div>
              </div>
              {!customerSelectedOurInsurance && (
                <div style={portalStyles.statTile}>
                  <div style={portalStyles.statLabel}>Insurance Document</div>
                  <div style={portalStyles.statValue}>{form.insuranceDocumentUrl ? 'Attached' : 'Missing'}</div>
                </div>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginTop: 14 }}>
              <div>
                <label style={portalStyles.sectionTitle}>Driver License / ID Photo</label>
                <input style={portalStyles.input} type="file" accept="image/*,.pdf" onChange={(e) => uploadField('idPhotoUrl', e.target.files?.[0])} />
              </div>
              {!customerSelectedOurInsurance && !insuranceSelection.declinedCoverage && (
                <div>
                  <label style={portalStyles.sectionTitle}>Insurance Document</label>
                  <input style={portalStyles.input} type="file" accept="image/*,.pdf" onChange={(e) => uploadField('insuranceDocumentUrl', e.target.files?.[0])} />
                </div>
              )}
            </div>
          </div>

          {/* Trip Protection */}
          {insurancePlans.length > 0 && (
            <div style={portalStyles.card}>
              <h2 style={portalStyles.cardTitle}>Trip Protection</h2>
              <p style={{ color: '#55456f', lineHeight: 1.6, marginBottom: 16 }}>
                Choose a protection plan for your trip, or use your own insurance.
              </p>
              {precheckinDiscount && (
                <div style={{ marginBottom: 16, padding: '12px 16px', borderRadius: 12, background: 'linear-gradient(135deg, rgba(22,163,74,.08), rgba(110,73,255,.06))', border: '1px solid rgba(22,163,74,.2)', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: '1.2rem' }}>🏷️</span>
                  <div>
                    <div style={{ fontWeight: 800, color: '#166534', fontSize: '0.92rem' }}>
                      Pre-check-in discount: {precheckinDiscount.type === 'PERCENTAGE' ? `${precheckinDiscount.value}% off` : `$${Number(precheckinDiscount.value).toFixed(2)} off`}
                    </div>
                    <div style={{ fontSize: '0.82rem', color: '#55456f' }}>Select insurance or add-ons now and save vs. counter pricing.</div>
                  </div>
                </div>
              )}

              <div style={{ display: 'grid', gap: 12 }}>
                {insurancePlans.map((plan) => {
                  const isSelected = insuranceSelection.selectedPlanCode === plan.code && !insuranceSelection.declinedCoverage;
                  const counterPrice = Number(plan.total || plan.amount || plan.rate || 0);
                  const discountedPrice = precheckinDiscount
                    ? precheckinDiscount.type === 'PERCENTAGE'
                      ? Number((counterPrice * (1 - precheckinDiscount.value / 100)).toFixed(2))
                      : Number(Math.max(0, counterPrice - precheckinDiscount.value).toFixed(2))
                    : counterPrice;
                  const hasDiscount = precheckinDiscount && discountedPrice < counterPrice;
                  return (
                    <label key={plan.code} style={{
                      display: 'grid', gap: 8, padding: '16px 18px', borderRadius: 14, cursor: 'pointer',
                      border: `2px solid ${isSelected ? '#6e49ff' : 'rgba(110,73,255,.15)'}`,
                      background: isSelected ? 'rgba(110,73,255,.05)' : 'rgba(255,255,255,.8)',
                      transition: 'all 0.18s'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <input type="radio" name="insurancePlan" checked={isSelected}
                            onChange={() => setInsuranceSelection({ selectedPlanCode: plan.code, declinedCoverage: false, denyInitials: '', responsibilityInitials: '', chargeInitials: '', ownPolicyNumber: '' })}
                            style={{ accentColor: '#6e49ff', width: 18, height: 18 }} />
                          <strong style={{ color: '#1e2847' }}>{plan.name}</strong>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          {hasDiscount ? (
                            <>
                              <span style={{ fontSize: '0.78rem', color: '#94a3b8', textDecoration: 'line-through', marginRight: 6 }}>${counterPrice.toFixed(2)}</span>
                              <span style={{ fontWeight: 900, color: '#166534' }}>${discountedPrice.toFixed(2)}</span>
                            </>
                          ) : (
                            <span style={{ fontWeight: 800, color: '#1e2847' }}>${counterPrice.toFixed(2)}</span>
                          )}
                        </div>
                      </div>
                      {plan.description && <div style={{ fontSize: '0.88rem', color: '#6b7a9a', paddingLeft: 28 }}>{plan.description}</div>}
                      {hasDiscount && <div style={{ fontSize: '0.78rem', color: '#166534', fontWeight: 700, paddingLeft: 28 }}>You save ${(counterPrice - discountedPrice).toFixed(2)} by selecting now</div>}
                    </label>
                  );
                })}

                {/* Decline coverage option */}
                <label style={{
                  display: 'grid', gap: 8, padding: '16px 18px', borderRadius: 14, cursor: 'pointer',
                  border: `2px solid ${insuranceSelection.declinedCoverage ? '#dc2626' : 'rgba(110,73,255,.15)'}`,
                  background: insuranceSelection.declinedCoverage ? 'rgba(220,38,38,.04)' : 'rgba(255,255,255,.8)',
                  transition: 'all 0.18s'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <input type="radio" name="insurancePlan"
                      checked={insuranceSelection.declinedCoverage}
                      onChange={() => setInsuranceSelection({ selectedPlanCode: '', declinedCoverage: true, denyInitials: '', responsibilityInitials: '', chargeInitials: '', ownPolicyNumber: '' })}
                      style={{ accentColor: '#dc2626', width: 18, height: 18 }} />
                    <strong style={{ color: '#991b1b' }}>I will use my own insurance</strong>
                  </div>
                </label>
              </div>

              {/* Decline flow */}
              {insuranceSelection.declinedCoverage && (
                <div style={{ marginTop: 20, display: 'grid', gap: 16, padding: '20px', borderRadius: 14, background: 'rgba(220,38,38,.04)', border: '1px solid rgba(220,38,38,.18)' }}>
                  <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 800, color: '#991b1b' }}>Insurance Decline Acknowledgment</h3>
                  <p style={{ color: '#7f1d1d', fontSize: '0.9rem', lineHeight: 1.6, margin: 0 }}>
                    By declining coverage, you must acknowledge the following three statements by entering your initials.
                  </p>

                  <div style={{ display: 'grid', gap: 6, padding: '14px 16px', borderRadius: 12, background: 'rgba(255,255,255,.9)', border: '1px solid rgba(220,38,38,.12)' }}>
                    <div style={{ fontSize: '0.9rem', color: '#1e2847', lineHeight: 1.6, fontWeight: 600 }}>
                      1. I hereby decline the vehicle protection coverage offered by the rental company. I understand that I am forgoing the company&apos;s damage waiver and liability coverage options.
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <label style={{ fontSize: '0.82rem', fontWeight: 700, color: '#6b7a9a', whiteSpace: 'nowrap' }}>Your initials:</label>
                      <input style={{ ...portalStyles.input, maxWidth: 100, textAlign: 'center', fontWeight: 800, fontSize: '1.1rem', letterSpacing: '.06em' }}
                        value={insuranceSelection.denyInitials}
                        onChange={(e) => setInsuranceSelection(prev => ({ ...prev, denyInitials: e.target.value.toUpperCase().slice(0, 5) }))}
                        placeholder="A.B."
                        maxLength={5} />
                    </div>
                  </div>

                  <div style={{ display: 'grid', gap: 6, padding: '14px 16px', borderRadius: 12, background: 'rgba(255,255,255,.9)', border: '1px solid rgba(220,38,38,.12)' }}>
                    <div style={{ fontSize: '0.9rem', color: '#1e2847', lineHeight: 1.6, fontWeight: 600 }}>
                      2. I understand and accept that I am 100% financially responsible for the vehicle during the rental period. Any damage, loss, or theft that occurs will be my sole responsibility regardless of fault.
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <label style={{ fontSize: '0.82rem', fontWeight: 700, color: '#6b7a9a', whiteSpace: 'nowrap' }}>Your initials:</label>
                      <input style={{ ...portalStyles.input, maxWidth: 100, textAlign: 'center', fontWeight: 800, fontSize: '1.1rem', letterSpacing: '.06em' }}
                        value={insuranceSelection.responsibilityInitials}
                        onChange={(e) => setInsuranceSelection(prev => ({ ...prev, responsibilityInitials: e.target.value.toUpperCase().slice(0, 5) }))}
                        placeholder="A.B."
                        maxLength={5} />
                    </div>
                  </div>

                  <div style={{ display: 'grid', gap: 6, padding: '14px 16px', borderRadius: 12, background: 'rgba(255,255,255,.9)', border: '1px solid rgba(220,38,38,.12)' }}>
                    <div style={{ fontSize: '0.9rem', color: '#1e2847', lineHeight: 1.6, fontWeight: 600 }}>
                      3. I authorize the rental company to charge any damages, loss, or associated costs to the credit card on file. I understand I will need to file a claim with my own insurance provider for reimbursement.
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <label style={{ fontSize: '0.82rem', fontWeight: 700, color: '#6b7a9a', whiteSpace: 'nowrap' }}>Your initials:</label>
                      <input style={{ ...portalStyles.input, maxWidth: 100, textAlign: 'center', fontWeight: 800, fontSize: '1.1rem', letterSpacing: '.06em' }}
                        value={insuranceSelection.chargeInitials}
                        onChange={(e) => setInsuranceSelection(prev => ({ ...prev, chargeInitials: e.target.value.toUpperCase().slice(0, 5) }))}
                        placeholder="A.B."
                        maxLength={5} />
                    </div>
                  </div>

                  <div>
                    <label style={portalStyles.sectionTitle}>Your Insurance Policy Number</label>
                    <input style={portalStyles.input}
                      value={insuranceSelection.ownPolicyNumber || form.insurancePolicyNumber}
                      onChange={(e) => {
                        setInsuranceSelection(prev => ({ ...prev, ownPolicyNumber: e.target.value }));
                        updateField('insurancePolicyNumber', e.target.value);
                      }}
                      placeholder="Enter your insurance policy number" />
                  </div>

                  <div>
                    <label style={portalStyles.sectionTitle}>Upload Your Insurance Policy Document</label>
                    <input style={portalStyles.input} type="file" accept="image/*,.pdf"
                      onChange={(e) => uploadField('insuranceDocumentUrl', e.target.files?.[0])} />
                    <div style={{ fontSize: '0.82rem', color: '#6b7a9a', marginTop: 4 }}>
                      {form.insuranceDocumentUrl ? 'Document attached' : 'Required -- upload a photo or PDF of your insurance card/policy'}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Trip Add-ons */}
          {additionalServices.length > 0 && (
            <div style={portalStyles.card}>
              <h2 style={portalStyles.cardTitle}>Trip Add-ons</h2>
              <p style={{ color: '#55456f', lineHeight: 1.6, marginBottom: 16 }}>
                Enhance your trip with these optional services.
              </p>
              {precheckinDiscount && (
                <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 12, background: 'rgba(22,163,74,.06)', border: '1px solid rgba(22,163,74,.16)', fontSize: '0.84rem', color: '#166534', fontWeight: 600 }}>
                  🏷️ Pre-check-in pricing active — add services now to save {precheckinDiscount.type === 'PERCENTAGE' ? `${precheckinDiscount.value}%` : `$${Number(precheckinDiscount.value).toFixed(2)}`} vs. counter rates.
                </div>
              )}
              <div style={{ display: 'grid', gap: 10 }}>
                {additionalServices.map((svc) => {
                  const state = selectedServices[svc.id] || { selected: !!svc.mandatory, quantity: svc.defaultQty || 1 };
                  const counterRate = Number(svc.rate || 0);
                  const discountedRate = precheckinDiscount
                    ? precheckinDiscount.type === 'PERCENTAGE'
                      ? Number((counterRate * (1 - precheckinDiscount.value / 100)).toFixed(2))
                      : Number(Math.max(0, counterRate - precheckinDiscount.value).toFixed(2))
                    : counterRate;
                  const hasDiscount = precheckinDiscount && discountedRate < counterRate;
                  const unitLabel = svc.chargeType === 'UNIT' ? `/ ${svc.unitLabel || 'unit'}` : '/ day';
                  return (
                    <div key={svc.id} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
                      padding: '14px 16px', borderRadius: 14,
                      border: `1.5px solid ${state.selected ? 'rgba(110,73,255,.25)' : 'rgba(110,73,255,.1)'}`,
                      background: state.selected ? 'rgba(110,73,255,.04)' : 'rgba(255,255,255,.8)',
                    }}>
                      <div style={{ flex: 1 }}>
                        <strong style={{ color: '#1e2847' }}>{svc.name}</strong>
                        {svc.description && <div style={{ fontSize: '0.84rem', color: '#6b7a9a', marginTop: 2 }}>{svc.description}</div>}
                        <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {hasDiscount ? (
                            <>
                              <span style={{ fontSize: '0.82rem', color: '#94a3b8', textDecoration: 'line-through' }}>${counterRate.toFixed(2)} {unitLabel}</span>
                              <span style={{ fontSize: '0.88rem', fontWeight: 800, color: '#166534' }}>${discountedRate.toFixed(2)} {unitLabel}</span>
                            </>
                          ) : (
                            <span style={{ fontSize: '0.84rem', color: '#6b7a9a' }}>${counterRate.toFixed(2)} {unitLabel}</span>
                          )}
                        </div>
                        {hasDiscount && state.selected && <div style={{ fontSize: '0.76rem', color: '#166534', fontWeight: 700, marginTop: 2 }}>Saving ${(counterRate - discountedRate).toFixed(2)} {unitLabel}</div>}
                      </div>
                      <div>
                        {svc.mandatory ? (
                          <span style={{ padding: '4px 10px', borderRadius: 999, background: 'rgba(22,163,74,.1)', color: '#15803d', fontSize: '0.78rem', fontWeight: 800 }}>Required</span>
                        ) : (
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                            <input type="checkbox" checked={!!state.selected}
                              onChange={(e) => setSelectedServices(prev => ({
                                ...prev,
                                [svc.id]: { selected: e.target.checked, quantity: Math.max(1, Number(prev[svc.id]?.quantity || svc.defaultQty || 1)) }
                              }))}
                              style={{ accentColor: '#6e49ff', width: 18, height: 18 }} />
                            <span style={{ fontWeight: 700, color: state.selected ? '#6e49ff' : '#6b7a9a', fontSize: '0.88rem' }}>Add</span>
                          </label>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Submit for Review</h2>
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ color: '#55456f', lineHeight: 1.6 }}>
                Once you submit, our team can review your information before pickup and help shorten your time at the counter.
              </div>
              <div>
                <button onClick={submit} disabled={saving || !token || missingRequiredFields.length > 0} style={portalStyles.button}>
                  {saving ? 'Submitting...' : 'Complete Pre-Check-in'}
                </button>
              </div>
              {nextPortalStep?.key && nextPortalStep.key !== 'customerInfo' && nextPortalStep.link ? (
                <div className="inline-actions">
                  <a href={nextPortalStep.link} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                    <button type="button" className="button-subtle">Continue to {nextPortalStep.label}</button>
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </PortalFrame>
  );
}
