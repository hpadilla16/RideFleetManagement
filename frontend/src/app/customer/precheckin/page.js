'use client';

import { useEffect, useState } from 'react';
import { API_BASE } from '../../../lib/client';
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

  const uploadField = async (key, file) => {
    try {
      const dataUrl = await fileToDataUrl(file);
      setForm((prev) => ({ ...prev, [key]: dataUrl }));
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

  return (
    <main style={{ maxWidth: 920, margin: '24px auto', padding: 16 }}>
      <h1>Customer Pre-Check-in</h1>
      {loading ? <p>Loading...</p> : null}
      {error ? <p style={{ color: '#b91c1c' }}>{error}</p> : null}
      {ok ? <p style={{ color: '#065f46' }}>{ok}</p> : null}

      {!loading && model?.reservation ? (
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
            <strong>Reservation:</strong> {model.reservation.reservationNumber}<br />
            <strong>Status:</strong> {model.reservation.status}<br />
            <strong>Pickup:</strong> {model.reservation.pickupAt ? new Date(model.reservation.pickupAt).toLocaleString() : '-'} ({model.reservation.pickupLocation || '-'})<br />
            <strong>Return:</strong> {model.reservation.returnAt ? new Date(model.reservation.returnAt).toLocaleString() : '-'} ({model.reservation.returnLocation || '-'})<br />
            <strong>Vehicle:</strong> {model.reservation.vehicle || '-'}<br />
            <strong>Completed:</strong> {model.reservation.customerInfoCompletedAt ? new Date(model.reservation.customerInfoCompletedAt).toLocaleString() : 'Pending'}
          </div>

          <div style={{ display: 'grid', gap: 12, border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
            <h3>Contact Information</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <input placeholder="First Name" value={form.firstName} onChange={(e) => setForm((prev) => ({ ...prev, firstName: e.target.value }))} />
              <input placeholder="Last Name" value={form.lastName} onChange={(e) => setForm((prev) => ({ ...prev, lastName: e.target.value }))} />
              <input placeholder="Email" value={form.email} onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))} />
              <input placeholder="Phone" value={form.phone} onChange={(e) => setForm((prev) => ({ ...prev, phone: e.target.value }))} />
              <input type="date" value={form.dateOfBirth} onChange={(e) => setForm((prev) => ({ ...prev, dateOfBirth: e.target.value }))} />
              <input placeholder="Insurance Policy Number" value={form.insurancePolicyNumber} onChange={(e) => setForm((prev) => ({ ...prev, insurancePolicyNumber: e.target.value }))} />
            </div>

            <h3>Driver Information</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <input placeholder="License Number" value={form.licenseNumber} onChange={(e) => setForm((prev) => ({ ...prev, licenseNumber: e.target.value }))} />
              <input placeholder="License State" value={form.licenseState} onChange={(e) => setForm((prev) => ({ ...prev, licenseState: e.target.value }))} />
            </div>

            <h3>Address</h3>
            <div style={{ display: 'grid', gap: 10 }}>
              <input placeholder="Address 1" value={form.address1} onChange={(e) => setForm((prev) => ({ ...prev, address1: e.target.value }))} />
              <input placeholder="Address 2" value={form.address2} onChange={(e) => setForm((prev) => ({ ...prev, address2: e.target.value }))} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
                <input placeholder="City" value={form.city} onChange={(e) => setForm((prev) => ({ ...prev, city: e.target.value }))} />
                <input placeholder="State" value={form.state} onChange={(e) => setForm((prev) => ({ ...prev, state: e.target.value }))} />
                <input placeholder="ZIP" value={form.zip} onChange={(e) => setForm((prev) => ({ ...prev, zip: e.target.value }))} />
                <input placeholder="Country" value={form.country} onChange={(e) => setForm((prev) => ({ ...prev, country: e.target.value }))} />
              </div>
            </div>

            <h3>Document Uploads</h3>
            <div style={{ display: 'grid', gap: 10 }}>
              <label>
                Driver License / ID Photo
                <input type="file" accept="image/*,.pdf" onChange={(e) => uploadField('idPhotoUrl', e.target.files?.[0])} />
              </label>
              {form.idPhotoUrl ? <div style={{ color: '#065f46' }}>Document attached.</div> : null}

              <label>
                Insurance Document
                <input type="file" accept="image/*,.pdf" onChange={(e) => uploadField('insuranceDocumentUrl', e.target.files?.[0])} />
              </label>
              {form.insuranceDocumentUrl ? <div style={{ color: '#065f46' }}>Insurance document attached.</div> : null}
            </div>

            <button onClick={submit} disabled={saving || !token}>
              {saving ? 'Submitting...' : 'Complete Pre-Check-in'}
            </button>
          </div>

          <PortalTimelineCard portal={model?.portal} />
        </div>
      ) : null}
    </main>
  );
}
