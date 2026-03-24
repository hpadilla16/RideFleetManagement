'use client';

import { useEffect, useState } from 'react';
import { API_BASE } from '../../../lib/client';
import { PortalFrame, portalStyles } from '../_components/PortalFrame';
import { PortalTimelineCard } from '../_components/PortalTimelineCard';

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
        setForm({
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
        });
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

  const uploadField = async (key, file) => {
    try {
      const dataUrl = await fileToDataUrl(file);
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
      const res = await fetch(`${API_BASE}/api/public/customer-info/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Unable to submit pre-check-in');
      setOk(json?.message || 'Pre-check-in completed.');
      setModel((prev) => ({
        ...(prev || {}),
        portal: json?.portal || prev?.portal || null,
        reservation: {
          ...(prev?.reservation || {}),
          customerInfoCompletedAt: json?.completedAt || new Date().toISOString(),
          customer: { ...(prev?.reservation?.customer || {}), ...form }
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
                <button onClick={submit} disabled={saving || !token} style={portalStyles.button}>
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
