'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGate } from '../../../../components/AuthGate';
import { AppShell } from '../../../../components/AppShell';
import { api } from '../../../../lib/client';

export default function Page() {
  return <AuthGate>{({ token, me, logout }) => <Inner token={token} me={me} logout={logout} />}</AuthGate>;
}

function Inner({ token, me, logout }) {
  const { id } = useParams();
  const router = useRouter();
  const [row, setRow] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [msg, setMsg] = useState('');
  const [draft, setDraft] = useState({
    firstName: '',
    lastName: '',
    address: '',
    dateOfBirth: '',
    licenseNumber: '',
    licenseImageDataUrl: ''
  });

  const load = async () => {
    const [reservation, driverRows] = await Promise.all([
      api(`/api/reservations/${id}`, {}, token),
      api(`/api/reservations/${id}/additional-drivers`, {}, token).catch(() => [])
    ]);
    setRow(reservation);
    setDrivers(Array.isArray(driverRows) ? driverRows : []);
  };

  useEffect(() => { load(); }, [id, token]);

  const pickLicense = async (file) => {
    if (!file) return setDraft((d) => ({ ...d, licenseImageDataUrl: '' }));
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      setDraft((d) => ({ ...d, licenseImageDataUrl: dataUrl }));
    } catch {
      setMsg('Could not read license image');
    }
  };

  const addDriver = () => {
    if (!draft.firstName || !draft.lastName || !draft.address || !draft.dateOfBirth || !draft.licenseNumber || !draft.licenseImageDataUrl) {
      setMsg('Complete all fields including license picture');
      return;
    }
    setDrivers((prev) => [...prev, { ...draft, licenseImageUploaded: true }]);
    setDraft({
      firstName: '',
      lastName: '',
      address: '',
      dateOfBirth: '',
      licenseNumber: '',
      licenseImageDataUrl: ''
    });
  };

  const save = async () => {
    try {
      const compactDrivers = (drivers || []).map((d) => ({
        firstName: d.firstName,
        lastName: d.lastName,
        address: d.address,
        dateOfBirth: d.dateOfBirth,
        licenseNumber: d.licenseNumber,
        licenseImageUploaded: !!(d.licenseImageUploaded || d.licenseImageDataUrl)
      }));
      await api(`/api/reservations/${id}/additional-drivers`, {
        method: 'PUT',
        body: JSON.stringify({ drivers: compactDrivers })
      }, token);

      await load();
      setMsg('Additional drivers saved');
      router.push(`/reservations/${id}`);
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg">
        <div className="row-between"><h2>Additional Drivers</h2><button onClick={() => router.push(`/reservations/${id}`)}>Back</button></div>
        <div className="label" style={{ marginBottom: 8 }}>Reservation: {row?.reservationNumber || '-'}</div>
        {msg ? <div className="label" style={{ marginBottom: 8 }}>{msg}</div> : null}

        <div className="grid2">
          <div className="stack"><label className="label">First Name</label><input value={draft.firstName} onChange={(e) => setDraft({ ...draft, firstName: e.target.value })} /></div>
          <div className="stack"><label className="label">Last Name</label><input value={draft.lastName} onChange={(e) => setDraft({ ...draft, lastName: e.target.value })} /></div>
          <div className="stack"><label className="label">Address</label><input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} /></div>
          <div className="stack"><label className="label">Date of Birth</label><input type="date" value={draft.dateOfBirth} onChange={(e) => setDraft({ ...draft, dateOfBirth: e.target.value })} /></div>
          <div className="stack"><label className="label">License Number</label><input value={draft.licenseNumber} onChange={(e) => setDraft({ ...draft, licenseNumber: e.target.value })} /></div>
          <div className="stack"><label className="label">License Picture</label><input type="file" accept="image/*" capture="environment" onChange={(e) => pickLicense(e.target.files?.[0] || null)} /></div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button onClick={addDriver}>Add Driver</button>
          <button onClick={save}>Save Drivers</button>
        </div>

        <table>
          <thead><tr><th>Name</th><th>DOB</th><th>License #</th><th>License Image</th><th>Action</th></tr></thead>
          <tbody>
            {drivers.map((d, i) => (
              <tr key={d.id || i}>
                <td>{d.firstName} {d.lastName}</td>
                <td>{d.dateOfBirth ? String(d.dateOfBirth).slice(0, 10) : '-'}</td>
                <td>{d.licenseNumber}</td>
                <td>{(d.licenseImageUploaded || d.licenseImageDataUrl) ? 'Uploaded' : '-'}</td>
                <td><button onClick={() => setDrivers((prev) => prev.filter((_, idx) => idx !== i))}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
