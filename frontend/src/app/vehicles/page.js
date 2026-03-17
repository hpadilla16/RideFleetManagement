'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

export default function VehiclesPage() {
  return <AuthGate>{({ token, me, logout }) => <VehiclesInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(',').map((c) => c.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ''; });
    return row;
  });
}

function agreementInspectionSummary(agreement) {
  const inspections = Array.isArray(agreement?.inspections) ? agreement.inspections : [];
  if (!inspections.length) return null;
  const checkout = inspections.find((x) => String(x?.phase || '').toUpperCase() === 'CHECKOUT') || null;
  const checkin = inspections.find((x) => String(x?.phase || '').toUpperCase() === 'CHECKIN') || null;
  return {
    checkout: checkout ? { at: checkout.capturedAt } : null,
    checkin: checkin ? { at: checkin.capturedAt } : null
  };
}

function VehiclesInner({ token, me, logout }) {
  const [vehicles, setVehicles] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [showRent, setShowRent] = useState(false);
  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showEditVehicle, setShowEditVehicle] = useState(false);
  const [msg, setMsg] = useState('');

  const [newVehicle, setNewVehicle] = useState({
    internalNumber: '', plate: '', vin: '', make: '', model: '', color: '', year: '', mileage: '', vehicleTypeId: '', homeLocationId: ''
  });
  const [editVehicleForm, setEditVehicleForm] = useState({
    internalNumber: '', plate: '', vin: '', make: '', model: '', color: '', year: '', mileage: '', status: 'AVAILABLE', vehicleTypeId: '', homeLocationId: ''
  });

  const [rentForm, setRentForm] = useState({
    customerId: '', pickupAt: '', returnAt: '', pickupLocationId: '', returnLocationId: '', dailyRate: ''
  });

  const [wizardStep, setWizardStep] = useState(1);
  const [uploadRows, setUploadRows] = useState([]);
  const [validationReport, setValidationReport] = useState(null);
  const [validating, setValidating] = useState(false);
  const [uploading, setUploading] = useState(false);

  const load = async () => {
    const [v, c, l, vt] = await Promise.all([
      api('/api/vehicles', {}, token),
      api('/api/customers', {}, token),
      api('/api/locations', {}, token),
      api('/api/vehicle-types', {}, token)
    ]);
    setVehicles(v);
    setCustomers(c);
    setLocations(l);
    setVehicleTypes(vt);
  };

  useEffect(() => { load(); }, [token]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return vehicles;
    return vehicles.filter((v) =>
      (v.internalNumber || '').toLowerCase().includes(q) ||
      (v.plate || '').toLowerCase().includes(q) ||
      (v.vin || '').toLowerCase().includes(q) ||
      `${v.make || ''} ${v.model || ''}`.toLowerCase().includes(q)
    );
  }, [vehicles, query]);

  const openRent = (vehicle) => {
    const now = new Date();
    const ret = new Date(now); ret.setDate(now.getDate() + 1);
    setSelected(vehicle);
    setRentForm({
      customerId: '',
      pickupAt: now.toISOString().slice(0, 16),
      returnAt: ret.toISOString().slice(0, 16),
      pickupLocationId: vehicle.homeLocationId || '',
      returnLocationId: vehicle.homeLocationId || '',
      dailyRate: ''
    });
    setShowRent(true);
  };

  const createReservation = async (e) => {
    e.preventDefault();
    if (!selected) return;
    try {
      const reservationNumber = `R-${Date.now().toString().slice(-8)}`;
      await api('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({
          reservationNumber,
          customerId: rentForm.customerId,
          vehicleId: selected.id,
          vehicleTypeId: selected.vehicleTypeId || null,
          pickupLocationId: rentForm.pickupLocationId,
          returnLocationId: rentForm.returnLocationId,
          pickupAt: rentForm.pickupAt,
          returnAt: rentForm.returnAt,
          dailyRate: rentForm.dailyRate ? Number(rentForm.dailyRate) : null,
          estimatedTotal: rentForm.dailyRate ? Number(rentForm.dailyRate) : null,
          status: 'CONFIRMED',
          sendConfirmationEmail: false,
          notes: `Created from Vehicles page for unit ${selected.internalNumber}`
        })
      }, token);
      setMsg(`Reservation started for ${selected.internalNumber}`);
      setShowRent(false);
    } catch (e2) {
      setMsg(e2.message);
    }
  };

  const addVehicle = async (e) => {
    e.preventDefault();
    try {
      await api('/api/vehicles', {
        method: 'POST',
        body: JSON.stringify({
          ...newVehicle,
          year: newVehicle.year ? Number(newVehicle.year) : null,
          mileage: newVehicle.mileage ? Number(newVehicle.mileage) : 0,
          homeLocationId: newVehicle.homeLocationId || null,
          status: 'AVAILABLE'
        })
      }, token);
      setShowAddVehicle(false);
      setNewVehicle({ internalNumber: '', plate: '', vin: '', make: '', model: '', color: '', year: '', mileage: '', vehicleTypeId: '', homeLocationId: '' });
      setMsg('Vehicle added successfully');
      await load();
    } catch (e2) {
      setMsg(e2.message);
    }
  };

  const openEditVehicle = (vehicle) => {
    setSelected(vehicle);
    setEditVehicleForm({
      internalNumber: vehicle.internalNumber || '',
      plate: vehicle.plate || '',
      vin: vehicle.vin || '',
      make: vehicle.make || '',
      model: vehicle.model || '',
      color: vehicle.color || '',
      year: vehicle.year || '',
      mileage: vehicle.mileage ?? '',
      status: vehicle.status || 'AVAILABLE',
      vehicleTypeId: vehicle.vehicleTypeId || '',
      homeLocationId: vehicle.homeLocationId || ''
    });
    setShowEditVehicle(true);
  };

  const saveEditVehicle = async (e) => {
    e.preventDefault();
    if (!selected) return;
    try {
      await api(`/api/vehicles/${selected.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...editVehicleForm,
          year: editVehicleForm.year ? Number(editVehicleForm.year) : null,
          mileage: editVehicleForm.mileage ? Number(editVehicleForm.mileage) : 0,
          homeLocationId: editVehicleForm.homeLocationId || null
        })
      }, token);
      setShowEditVehicle(false);
      setMsg('Vehicle updated successfully');
      await load();
    } catch (e2) {
      setMsg(e2.message);
    }
  };

  const downloadTemplate = () => {
    const sampleType = vehicleTypes[0]?.id || 'PUT_VEHICLE_TYPE_ID_HERE';
    const csv = `internalNumber,plate,vin,make,model,color,vehicleTypeId\nUNIT-001,ABC123,1HGBH41JXMN109186,Honda,Civic,Silver,${sampleType}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vehicle_inventory_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const onSelectUploadFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    const rowsParsed = parseCsv(text);
    setUploadRows(rowsParsed);
  };

  const validateUpload = async () => {
    setValidating(true);
    setValidationReport(null);
    try {
      const report = await api('/api/vehicles/bulk/validate', {
        method: 'POST',
        body: JSON.stringify({ rows: uploadRows })
      }, token);
      setValidationReport(report);
    } catch (e2) {
      setMsg(e2.message);
    } finally {
      setValidating(false);
    }
  };

  const proceedUpload = async () => {
    setUploading(true);
    try {
      const out = await api('/api/vehicles/bulk/import', {
        method: 'POST',
        body: JSON.stringify({ rows: uploadRows })
      }, token);
      setMsg(`Upload successful. Created ${out.created}, skipped ${out.skipped}.`);
      setShowUpload(false);
      setWizardStep(1);
      setUploadRows([]);
      setValidationReport(null);
      await load();
    } catch (e2) {
      setMsg(e2.message);
    } finally {
      setUploading(false);
    }
  };

  const resetWizard = () => {
    setWizardStep(1);
    setUploadRows([]);
    setValidationReport(null);
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg">
        <div className="row-between">
          <h2>Vehicle Inventory</h2>
          <div style={{ display: 'flex', gap: 8, width: 'min(720px,100%)' }}>
            <input placeholder="Search unit, plate, make/model, VIN" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button onClick={() => setShowAddVehicle(true)}>Add Vehicle</button>
            <button onClick={() => setShowUpload(true)}>Upload Inventory</button>
          </div>
        </div>
        {msg ? <p className="label">{msg}</p> : null}
        <table>
          <thead>
            <tr>
              <th>Unit ID</th>
              <th>License</th>
              <th>Make</th>
              <th>Model</th>
              <th>Color</th>
              <th>VIN</th>
              <th>Type</th>
              <th>Current Location</th>
              <th>Status</th>
              <th>Rent</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id} onClick={() => setSelected(v)} style={{ cursor: 'pointer' }}>
                <td>{v.internalNumber}</td>
                <td>{v.plate || '-'}</td>
                <td>{v.make || '-'}</td>
                <td>{v.model || '-'}</td>
                <td>{v.color || '-'}</td>
                <td>{v.vin || '-'}</td>
                <td>{v.vehicleType?.name || '-'}</td>
                <td>{v.homeLocation?.name || '-'}</td>
                <td><span className="badge">{v.status}</span></td>
                <td>
                  <button onClick={(e) => { e.stopPropagation(); openRent(v); }} disabled={v.status !== 'AVAILABLE'}>Rent</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {selected && !showRent && (
        <aside className="detail-drawer glass">
          <div className="row-between"><h3>{selected.internalNumber}</h3><button onClick={() => setSelected(null)}>Close</button></div>
          <div className="stack">
            <div><span className="label">VIN</span><div>{selected.vin || '-'}</div></div>
            <div><span className="label">Plate</span><div>{selected.plate || '-'}</div></div>
            <div><span className="label">Vehicle</span><div>{selected.year || ''} {selected.make || ''} {selected.model || ''}</div></div>
            <div><span className="label">Color</span><div>{selected.color || '-'}</div></div>
            <div><span className="label">Mileage</span><div>{selected.mileage ?? 0}</div></div>
            <div><span className="label">Type</span><div>{selected.vehicleType?.name || '-'}</div></div>
            <div><span className="label">Home Location</span><div>{selected.homeLocation?.name || '-'}</div></div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => openRent(selected)} disabled={selected.status !== 'AVAILABLE'}>Rent this vehicle</button>
              <button onClick={() => openEditVehicle(selected)}>Edit vehicle</button>
            </div>

            <div className="glass card" style={{ padding: 10, marginTop: 8 }}>
              <div className="row-between"><strong>Inspection History</strong><span className="badge">{(selected.rentalAgreements || []).filter((a) => !!agreementInspectionSummary(a)).length}</span></div>
              <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                {(selected.rentalAgreements || []).map((a) => {
                  const rep = agreementInspectionSummary(a);
                  if (!rep) return null;
                  return (
                    <div key={a.id} className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                      {a.agreementNumber} • {a.reservation?.reservationNumber || '-'} • Checkout: {rep?.checkout?.at ? 'Yes' : 'No'} • Check-in: {rep?.checkin?.at ? 'Yes' : 'No'}
                    </div>
                  );
                })}
                {!(selected.rentalAgreements || []).some((a) => !!agreementInspectionSummary(a)) ? <div className="label">No inspection reports yet.</div> : null}
              </div>
            </div>
          </div>
        </aside>
      )}

      {showAddVehicle && (
        <div className="modal-backdrop" onClick={() => setShowAddVehicle(false)}>
          <div className="rent-modal glass" onClick={(e) => e.stopPropagation()}>
            <h3>Add Vehicle</h3>
            <form className="stack" onSubmit={addVehicle}>
              <div className="grid2">
                <input required placeholder="Unit ID" value={newVehicle.internalNumber} onChange={(e) => setNewVehicle({ ...newVehicle, internalNumber: e.target.value })} />
                <input placeholder="License Plate" value={newVehicle.plate} onChange={(e) => setNewVehicle({ ...newVehicle, plate: e.target.value })} />
              </div>
              <div className="grid2">
                <input placeholder="VIN" value={newVehicle.vin} onChange={(e) => setNewVehicle({ ...newVehicle, vin: e.target.value })} />
                <input placeholder="Make" value={newVehicle.make} onChange={(e) => setNewVehicle({ ...newVehicle, make: e.target.value })} />
              </div>
              <div className="grid2">
                <input placeholder="Model" value={newVehicle.model} onChange={(e) => setNewVehicle({ ...newVehicle, model: e.target.value })} />
                <input placeholder="Color" value={newVehicle.color} onChange={(e) => setNewVehicle({ ...newVehicle, color: e.target.value })} />
              </div>
              <div className="grid2">
                <input placeholder="Year" value={newVehicle.year} onChange={(e) => setNewVehicle({ ...newVehicle, year: e.target.value })} />
                <input placeholder="Mileage" value={newVehicle.mileage} onChange={(e) => setNewVehicle({ ...newVehicle, mileage: e.target.value })} />
              </div>
              <div className="grid2">
                <select required value={newVehicle.vehicleTypeId} onChange={(e) => setNewVehicle({ ...newVehicle, vehicleTypeId: e.target.value })}>
                  <option value="">Vehicle type</option>
                  {vehicleTypes.map((vt) => <option key={vt.id} value={vt.id}>{vt.name}</option>)}
                </select>
                <select value={newVehicle.homeLocationId} onChange={(e) => setNewVehicle({ ...newVehicle, homeLocationId: e.target.value })}>
                  <option value="">Home location</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <div className="row-between"><button type="button" onClick={() => setShowAddVehicle(false)}>Cancel</button><button type="submit">Save Vehicle</button></div>
            </form>
          </div>
        </div>
      )}

      {showEditVehicle && selected && (
        <div className="modal-backdrop" onClick={() => setShowEditVehicle(false)}>
          <div className="rent-modal glass" onClick={(e) => e.stopPropagation()}>
            <h3>Edit Vehicle · {selected.internalNumber}</h3>
            <form className="stack" onSubmit={saveEditVehicle}>
              <div className="grid2">
                <input required placeholder="Unit ID" value={editVehicleForm.internalNumber} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, internalNumber: e.target.value })} />
                <input placeholder="License Plate" value={editVehicleForm.plate} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, plate: e.target.value })} />
              </div>
              <div className="grid2">
                <input placeholder="VIN" value={editVehicleForm.vin} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, vin: e.target.value })} />
                <input placeholder="Make" value={editVehicleForm.make} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, make: e.target.value })} />
              </div>
              <div className="grid2">
                <input placeholder="Model" value={editVehicleForm.model} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, model: e.target.value })} />
                <input placeholder="Color" value={editVehicleForm.color} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, color: e.target.value })} />
              </div>
              <div className="grid2">
                <input placeholder="Year" value={editVehicleForm.year} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, year: e.target.value })} />
                <input placeholder="Mileage" value={editVehicleForm.mileage} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, mileage: e.target.value })} />
              </div>
              <div className="grid2">
                <select required value={editVehicleForm.vehicleTypeId} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, vehicleTypeId: e.target.value })}>
                  <option value="">Vehicle type</option>
                  {vehicleTypes.map((vt) => <option key={vt.id} value={vt.id}>{vt.name}</option>)}
                </select>
                <select value={editVehicleForm.homeLocationId} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, homeLocationId: e.target.value })}>
                  <option value="">Home location</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <select value={editVehicleForm.status} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, status: e.target.value })}>
                {['AVAILABLE', 'RESERVED', 'ON_RENT', 'IN_MAINTENANCE', 'OUT_OF_SERVICE'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <div className="row-between"><button type="button" onClick={() => setShowEditVehicle(false)}>Cancel</button><button type="submit">Save Changes</button></div>
            </form>
          </div>
        </div>
      )}

      {showUpload && (
        <div className="modal-backdrop" onClick={() => { setShowUpload(false); resetWizard(); }}>
          <div className="rent-modal glass" onClick={(e) => e.stopPropagation()}>
            <h3>Upload Vehicle Inventory</h3>

            {wizardStep === 1 && (
              <div className="stack">
                <p className="label">Step 1: Review instructions</p>
                <ul>
                  <li>Use CSV format.</li>
                  <li>Required columns: <code>internalNumber</code>, <code>vehicleTypeId</code>.</li>
                  <li>Recommended columns: plate, vin, make, model, color.</li>
                  <li>Rows matching existing internalNumber/VIN/plate are rejected (not uploaded).</li>
                </ul>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={downloadTemplate}>Download Template</button>
                  <button type="button" onClick={() => setWizardStep(2)}>Next</button>
                </div>
              </div>
            )}

            {wizardStep === 2 && (
              <div className="stack">
                <p className="label">Step 2: Upload file and validate</p>
                <input type="file" accept=".csv,text/csv" onChange={(e) => onSelectUploadFile(e.target.files?.[0])} />
                <p className="label">Rows loaded: {uploadRows.length}</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={resetWizard}>Try again</button>
                  <button type="button" onClick={validateUpload} disabled={!uploadRows.length || validating}>{validating ? 'Validating…' : 'Validate'}</button>
                </div>
              </div>
            )}

            {validationReport && (
              <div className="stack" style={{ marginTop: 12 }}>
                <p><strong>Validation report</strong></p>
                <p className="label">Found: {validationReport.found} · Valid: {validationReport.valid} · Duplicates: {validationReport.duplicates} · Invalid: {validationReport.invalid}</p>
                <div style={{ maxHeight: 140, overflow: 'auto', border: '1px solid #eee8ff', borderRadius: 8, padding: 8 }}>
                  {validationReport.rows.slice(0, 50).map((r) => (
                    <div key={r.row} className="label">Row {r.row}: {r.valid ? '✅ valid' : `❌ ${[...r.errors, ...r.duplicateReasons].join(', ')}`}</div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={resetWizard}>Try again</button>
                  <button type="button" onClick={proceedUpload} disabled={validationReport.valid === 0 || uploading}>{uploading ? 'Uploading…' : 'Proceed with Upload'}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showRent && selected && (
        <div className="modal-backdrop" onClick={() => setShowRent(false)}>
          <div className="rent-modal glass" onClick={(e) => e.stopPropagation()}>
            <h3>Start Reservation · {selected.internalNumber}</h3>
            <form className="stack" onSubmit={createReservation}>
              <select required value={rentForm.customerId} onChange={(e) => setRentForm({ ...rentForm, customerId: e.target.value })}>
                <option value="">Select customer</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.firstName} {c.lastName}</option>)}
              </select>
              <div className="grid2">
                <input type="datetime-local" required value={rentForm.pickupAt} onChange={(e) => setRentForm({ ...rentForm, pickupAt: e.target.value })} />
                <input type="datetime-local" required value={rentForm.returnAt} onChange={(e) => setRentForm({ ...rentForm, returnAt: e.target.value })} />
              </div>
              <div className="grid2">
                <select required value={rentForm.pickupLocationId} onChange={(e) => setRentForm({ ...rentForm, pickupLocationId: e.target.value })}>
                  <option value="">Pickup location</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <select required value={rentForm.returnLocationId} onChange={(e) => setRentForm({ ...rentForm, returnLocationId: e.target.value })}>
                  <option value="">Return location</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <input placeholder="Daily rate (optional)" value={rentForm.dailyRate} onChange={(e) => setRentForm({ ...rentForm, dailyRate: e.target.value })} />
              <div className="row-between">
                <button type="button" onClick={() => setShowRent(false)}>Cancel</button>
                <button type="submit">Create Reservation</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  );
}
