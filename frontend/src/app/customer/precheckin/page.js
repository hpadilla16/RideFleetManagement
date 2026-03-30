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
  const uploadedDocs = [form.idPhotoUrl, form.insuranceDocumentUrl].filter(Boolean).length;
  const missingRequiredFields = PRECHECKIN_REQUIRED_FIELDS
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
      aside={<PortalTimelineCard portal={model?.portal} reservation={reservation} currentStepKey="customerInfo" currentStepLabel="Pre-check-in" />}
    >
      {notices}

      {!loading && reservation ? (
        <>
          <div style={portalStyles.card}>
            <h2 style={portalStyles.cardTitle}>Pre-Check-in Snapshot</h2>
            <div style={portalStyles.statGrid}>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Profile Fields</div>
                <div style={portalStyles.statValue}>{profileFieldsComplete}/12</div>
              </div>
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Documents</div>
                <div style={portalStyles.statValue}>{uploadedDocs}/2</div>
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
              <div style={portalStyles.statTile}>
                <div style={portalStyles.statLabel}>Insurance Document</div>
                <div style={portalStyles.statValue}>{form.insuranceDocumentUrl ? 'Attached' : 'Missing'}</div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginTop: 14 }}>
              <div>
                <label style={portalStyles.sectionTitle}>Driver License / ID Photo</label>
                <input style={portalStyles.input} type="file" accept="image/*,.pdf" onChange={(e) => uploadField('idPhotoUrl', e.target.files?.[0])} />
              </div>
              <div>
                <label style={portalStyles.sectionTitle}>Insurance Document</label>
                <input style={portalStyles.input} type="file" accept="image/*,.pdf" onChange={(e) => uploadField('insuranceDocumentUrl', e.target.files?.[0])} />
              </div>
            </div>
          </div>

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
