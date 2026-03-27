'use client';

function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(',').map((c) => c.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ''; });
    return row;
  });
}

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';

const EMPTY = {
  id: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  dateOfBirth: '',
  address1: '',
  address2: '',
  city: '',
  state: '',
  zip: '',
  country: 'Puerto Rico',
  licenseNumber: '',
  licenseState: '',
  insurancePolicyNumber: '',
  insuranceDocumentUrl: '',
  idPhotoUrl: '',
  notes: ''
};

const STEPS = ['Basic', 'Address', 'License & Insurance', 'ID Photo & Notes'];

export default function CustomersPage() {
  return <AuthGate>{({ token, me, logout }) => <CustomersInner token={token} me={me} logout={logout} />}</AuthGate>;
}

function CustomersInner({ token, me, logout }) {
  const [rows, setRows] = useState([]);
  const [query, setQuery] = useState('');
  const [showOnlyHold, setShowOnlyHold] = useState(false);
  const [msg, setMsg] = useState('');
  const [supportFocus, setSupportFocus] = useState('ALL');

  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(EMPTY);
  const [showImport, setShowImport] = useState(false);
  const [importStep, setImportStep] = useState(1);
  const [importRows, setImportRows] = useState([]);
  const [importReport, setImportReport] = useState(null);
  const [validatingImport, setValidatingImport] = useState(false);
  const [importingRows, setImportingRows] = useState(false);

  const load = async () => setRows(await api('/api/customers', {}, token));
  useEffect(() => { load(); }, [token]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return rows.filter((r) => {
      const name = `${r.firstName || ''} ${r.lastName || ''}`.toLowerCase();
      const match = !q || name.includes(q) || String(r.phone || '').toLowerCase().includes(q) || String(r.email || '').toLowerCase().includes(q);
      if (!match) return false;
      if (showOnlyHold && !r.doNotRent) return false;
      return true;
    });
  }, [rows, query, showOnlyHold]);

  const customerSupportHub = useMemo(() => {
    const holds = rows.filter((r) => r.doNotRent);
    const docsMissing = rows.filter((r) => !r.idPhotoUrl || !r.insuranceDocumentUrl);
    const withEmail = rows.filter((r) => !!r.email);
    const recentNeedAttention = [
      holds[0]
        ? {
            id: `hold-${holds[0].id}`,
            title: 'Hold Review',
            detail: `${holds[0].firstName || ''} ${holds[0].lastName || ''}`.trim(),
            note: holds[0].doNotRentReason || 'Customer is currently on hold and may need support review.',
            href: `/customers/${holds[0].id}`,
            actionLabel: 'Open Profile'
          }
        : null,
      docsMissing[0]
        ? {
            id: `docs-${docsMissing[0].id}`,
            title: 'Missing Documents',
            detail: `${docsMissing[0].firstName || ''} ${docsMissing[0].lastName || ''}`.trim(),
            note: `${docsMissing[0].idPhotoUrl ? 'ID ready' : 'ID missing'} - ${docsMissing[0].insuranceDocumentUrl ? 'Insurance ready' : 'Insurance missing'}`,
            href: `/customers/${docsMissing[0].id}`,
            actionLabel: 'Review Docs'
          }
        : null,
      withEmail[0]
        ? {
            id: `email-${withEmail[0].id}`,
            title: 'Email-Ready Customer',
            detail: `${withEmail[0].firstName || ''} ${withEmail[0].lastName || ''}`.trim(),
            note: withEmail[0].email,
            href: `/customers/${withEmail[0].id}`,
            actionLabel: 'Open Profile'
          }
        : null
    ].filter(Boolean);

    return {
      total: rows.length,
      holds: holds.length,
      docsMissing: docsMissing.length,
      withEmail: withEmail.length,
      recentNeedAttention
    };
  }, [rows]);

  const supportFocusOptions = useMemo(() => ([
    { id: 'ALL', label: 'All Queues', count: customerSupportHub.recentNeedAttention.length },
    { id: 'HOLDS', label: 'Holds', count: customerSupportHub.recentNeedAttention.filter((item) => item.id.startsWith('hold-')).length },
    { id: 'DOCS', label: 'Docs', count: customerSupportHub.recentNeedAttention.filter((item) => item.id.startsWith('docs-')).length },
    { id: 'EMAIL', label: 'Email', count: customerSupportHub.recentNeedAttention.filter((item) => item.id.startsWith('email-')).length }
  ]), [customerSupportHub]);

  const supportFocusSummary = useMemo(() => {
    switch (supportFocus) {
      case 'HOLDS':
        return 'Focus the shift on hold reviews first so blocked customers get a fast decision.';
      case 'DOCS':
        return 'Keep missing document work visible to close out ID and insurance gaps faster from phone.';
      case 'EMAIL':
        return 'Show customers ready for email actions like resets and support follow-up without scanning the full table.';
      default:
        return 'A compact mobile-first board before you drop into the full customer table.';
    }
  }, [supportFocus]);

  const visibleSupportItems = useMemo(() => {
    if (supportFocus === 'ALL') return customerSupportHub.recentNeedAttention;
    if (supportFocus === 'HOLDS') return customerSupportHub.recentNeedAttention.filter((item) => item.id.startsWith('hold-'));
    if (supportFocus === 'DOCS') return customerSupportHub.recentNeedAttention.filter((item) => item.id.startsWith('docs-'));
    if (supportFocus === 'EMAIL') return customerSupportHub.recentNeedAttention.filter((item) => item.id.startsWith('email-'));
    return customerSupportHub.recentNeedAttention;
  }, [customerSupportHub, supportFocus]);

  const openCreate = () => {
    setForm(EMPTY);
    setStep(0);
    setWizardOpen(true);
  };

  const openEdit = (c) => {
    setForm({
      ...EMPTY,
      ...c,
      dateOfBirth: c.dateOfBirth ? new Date(c.dateOfBirth).toISOString().slice(0, 10) : ''
    });
    setStep(0);
    setWizardOpen(true);
  };

  const onPickIdPhoto = (file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => setForm((f) => ({ ...f, idPhotoUrl: String(r.result || '') }));
    r.readAsDataURL(file);
  };

  const onPickInsuranceDoc = (file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => setForm((f) => ({ ...f, insuranceDocumentUrl: String(r.result || '') }));
    r.readAsDataURL(file);
  };

  const validateStep = () => {
    if (step === 0) {
      if (!form.firstName || !form.lastName) return 'First and last name are required';
      if (!form.phone) return 'Phone is required';
    }
    if (step === 1) {
      if (!form.address1 || !form.city || !form.state || !form.zip) {
        return 'Address Line 1, City, State, and ZIP are required';
      }
    }
    if (step === 2) {
      if (!form.licenseNumber) return 'License number is required';
    }
    return null;
  };

  const next = () => {
    const err = validateStep();
    if (err) return setMsg(err);
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };

  const prev = () => setStep((s) => Math.max(0, s - 1));

  const save = async () => {
    const err = validateStep();
    if (err) return setMsg(err);

    const payload = {
      ...form,
      dateOfBirth: form.dateOfBirth || null,
      email: form.email || null,
      insuranceDocumentUrl: form.insuranceDocumentUrl || null,
      idPhotoUrl: form.idPhotoUrl || null
    };

    if (form.id) {
      await api(`/api/customers/${form.id}`, { method: 'PATCH', body: JSON.stringify(payload) }, token);
      setMsg('Customer updated');
    } else {
      await api('/api/customers', { method: 'POST', body: JSON.stringify(payload) }, token);
      setMsg('Customer created');
    }

    setWizardOpen(false);
    setForm(EMPTY);
    setStep(0);
    await load();
  };

  const removeRow = async (id) => {
    if (!window.confirm('Delete this customer?')) return;
    await api(`/api/customers/${id}`, { method: 'DELETE' }, token);
    setMsg('Customer removed');
    await load();
  };

  const issuePasswordReset = async (c) => {
    try {
      if (me?.role !== 'ADMIN') return setMsg('Admin approval required');
      const out = await api(`/api/customers/${c.id}/password-reset`, { method: 'POST' }, token);
      const link = out?.resetLink || '';
      if (link && navigator?.clipboard) {
        try { await navigator.clipboard.writeText(link); } catch {}
      }
      window.alert(`Password reset link created for ${c.firstName} ${c.lastName}.\n\n${link}${link ? '\n\n(Link copied to clipboard if allowed.)' : ''}`);
      setMsg('Password reset link issued');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const quickToggleHold = async (c) => {
    await api(`/api/customers/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        doNotRent: !c.doNotRent,
        doNotRentReason: c.doNotRent ? null : (c.doNotRentReason || 'Internal hold')
      })
    }, token);
    setMsg(!c.doNotRent ? 'Customer placed on hold' : 'Customer hold removed');
    await load();
  };

  const downloadImportTemplate = () => {
    const sampleTenantSlug = me?.tenantId ? '' : 'tenantSlug,';
    const sampleTenantValue = me?.tenantId ? '' : 'demo,';
    const csv = `${sampleTenantSlug}firstName,lastName,email,phone,dateOfBirth,address1,city,state,zip,country,licenseNumber,licenseState,insurancePolicyNumber,creditBalance,doNotRent,doNotRentReason,notes\n${sampleTenantValue}Jose,Diaz,jose@example.com,7875550101,1990-05-10,123 Main St,San Juan,PR,00901,Puerto Rico,D1234567,PR,POL-1001,0,false,,Imported from legacy CRM`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'customer_migration_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const onSelectImportFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    setImportRows(parseCsv(text));
  };

  const validateImport = async () => {
    setValidatingImport(true);
    setImportReport(null);
    try {
      const report = await api('/api/customers/bulk/validate', {
        method: 'POST',
        body: JSON.stringify({ rows: importRows })
      }, token);
      setImportReport(report);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setValidatingImport(false);
    }
  };

  const proceedImport = async () => {
    setImportingRows(true);
    try {
      const out = await api('/api/customers/bulk/import', {
        method: 'POST',
        body: JSON.stringify({ rows: importRows })
      }, token);
      setMsg(`Customer upload successful. Created ${out.created}, skipped ${out.skipped}.`);
      setShowImport(false);
      setImportStep(1);
      setImportRows([]);
      setImportReport(null);
      await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setImportingRows(false);
    }
  };

  const resetImportWizard = () => {
    setImportStep(1);
    setImportRows([]);
    setImportReport(null);
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="app-banner">
          <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
            <div>
              <span className="eyebrow">Customer Support Hub</span>
              <h2 className="page-title" style={{ marginTop: 6 }}>
                Keep customer readiness and holds in view.
              </h2>
              <p className="ui-muted">{supportFocusSummary}</p>
            </div>
            <span className="status-chip neutral">Customer Ops</span>
          </div>
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Customers</span>
              <strong>{customerSupportHub.total}</strong>
              <span className="ui-muted">Profiles currently available in the tenant workspace.</span>
            </div>
            <div className="info-tile">
              <span className="label">On Hold</span>
              <strong>{customerSupportHub.holds}</strong>
              <span className="ui-muted">Customers currently blocked from renting.</span>
            </div>
            <div className="info-tile">
              <span className="label">Docs Missing</span>
              <strong>{customerSupportHub.docsMissing}</strong>
              <span className="ui-muted">Customers missing ID or insurance documentation.</span>
            </div>
            <div className="info-tile">
              <span className="label">Email Ready</span>
              <strong>{customerSupportHub.withEmail}</strong>
              <span className="ui-muted">Customers who can receive support emails and password resets.</span>
            </div>
          </div>
          <div className="app-banner-list">
            {supportFocusOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={supportFocus === option.id ? '' : 'button-subtle'}
                onClick={() => setSupportFocus(option.id)}
                style={{ minHeight: 36, paddingInline: 14 }}
              >
                {option.label} · {option.count}
              </button>
            ))}
          </div>
          {visibleSupportItems.length ? (
            <div className="app-card-grid compact">
              {visibleSupportItems.map((item) => (
                <section key={item.id} className="glass card section-card">
                  <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
                  <div className="ui-muted">{item.detail}</div>
                  <div className="surface-note">{item.note}</div>
                  <div className="inline-actions">
                    <Link href={item.href}><button type="button">{item.actionLabel}</button></Link>
                  </div>
                </section>
              ))}
            </div>
          ) : customerSupportHub.recentNeedAttention.length ? (
            <div className="surface-note">No customer cases match this focus right now. Switch filters to review another lane.</div>
          ) : null}
        </div>
      </section>
      <section className="glass card-lg stack">
        <div className="row-between">
          <h2>Customers</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="badge" onClick={() => setShowOnlyHold((v) => !v)}>{showOnlyHold ? 'Showing: Hold Only' : 'Filter: Hold'}</button>
            <input placeholder="Search name/phone/email" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button onClick={() => setShowImport(true)}>Upload Customers</button>
            <button onClick={openCreate}>Add New Customer</button>
          </div>
        </div>
        {msg ? <p className="label">{msg}</p> : null}

        <table>
          <thead><tr><th>Name</th><th>Status</th><th>Phone</th><th>Email</th><th>Address</th><th>DL</th><th>ID Photo</th><th>Actions</th></tr></thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.id}>
                <td><Link href={`/customers/${c.id}`}>{c.firstName} {c.lastName}</Link></td>
                <td><span className="label">{c.doNotRent ? 'Hold' : 'Active'}</span></td>
                <td>{c.phone}</td>
                <td>{c.email || '-'}</td>
                <td>{[c.city, c.state].filter(Boolean).join(', ') || '-'}</td>
                <td>{c.licenseNumber || '-'}</td>
                <td>{c.idPhotoUrl ? 'Yes' : 'No'}</td>
                <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => openEdit(c)}>Edit</button>
                  {me?.role === 'ADMIN' ? <button onClick={() => issuePasswordReset(c)}>Password Reset</button> : null}
                  <button onClick={() => quickToggleHold(c)}>{c.doNotRent ? 'Remove Hold' : 'Place Hold'}</button>
                  <button onClick={() => removeRow(c.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {wizardOpen && (
        <div className="modal-backdrop" onClick={() => setWizardOpen(false)}>
          <div className="rent-modal glass" style={{ width: 'min(860px, 96vw)' }} onClick={(e) => e.stopPropagation()}>
            <div className="row-between"><h3>{form.id ? 'Edit Customer' : 'New Customer Wizard'}</h3><button onClick={() => setWizardOpen(false)}>Close</button></div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 6, marginBottom: 12 }}>
              {STEPS.map((s, i) => <button key={s} style={{ opacity: i <= step ? 1 : .55 }} onClick={() => i <= step && setStep(i)}>{i + 1}. {s}</button>)}
            </div>

            {step === 0 && (
              <div className="stack">
                <div className="grid2">
                  <div className="stack"><label className="label">First Name*</label><input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></div>
                  <div className="stack"><label className="label">Last Name*</label><input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></div>
                </div>
                <div className="grid2">
                  <div className="stack"><label className="label">Phone*</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
                  <div className="stack"><label className="label">Email</label><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
                </div>
                <div className="stack"><label className="label">Date of Birth</label><input type="date" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} /></div>
              </div>
            )}

            {step === 1 && (
              <div className="stack">
                <div className="stack"><label className="label">Address Line 1*</label><input required value={form.address1} onChange={(e) => setForm({ ...form, address1: e.target.value })} /></div>
                <div className="stack"><label className="label">Address Line 2</label><input value={form.address2} onChange={(e) => setForm({ ...form, address2: e.target.value })} /></div>
                <div className="grid2">
                  <div className="stack"><label className="label">City*</label><input required value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></div>
                  <div className="stack"><label className="label">State*</label><input required value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} /></div>
                </div>
                <div className="grid2">
                  <div className="stack"><label className="label">ZIP*</label><input required value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} /></div>
                  <div className="stack"><label className="label">Country</label><input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} /></div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="stack">
                <div className="grid2">
                  <div className="stack"><label className="label">License Number*</label><input value={form.licenseNumber} onChange={(e) => setForm({ ...form, licenseNumber: e.target.value })} /></div>
                  <div className="stack"><label className="label">License State</label><input value={form.licenseState} onChange={(e) => setForm({ ...form, licenseState: e.target.value })} /></div>
                </div>
                <div className="grid2">
                  <div className="stack"><label className="label">Insurance Policy #</label><input value={form.insurancePolicyNumber} onChange={(e) => setForm({ ...form, insurancePolicyNumber: e.target.value })} /></div>
                  <div className="stack">
                    <label className="label">Insurance Document Upload</label>
                    <input type="file" accept="image/*,.pdf" onChange={(e) => onPickInsuranceDoc(e.target.files?.[0])} />
                    <label className="label">Or Take Photo</label>
                    <input type="file" accept="image/*" capture="environment" onChange={(e) => onPickInsuranceDoc(e.target.files?.[0])} />
                  </div>
                </div>
                {form.insuranceDocumentUrl ? <div className="label">Insurance document uploaded ✓</div> : <div className="label">No insurance document uploaded.</div>}
              </div>
            )}

            {step === 3 && (
              <div className="stack">
                <div className="stack">
                  <label className="label">ID Photo Upload</label>
                  <input type="file" accept="image/*" onChange={(e) => onPickIdPhoto(e.target.files?.[0])} />
                  <label className="label">Or Take ID Photo</label>
                  <input type="file" accept="image/*" capture="environment" onChange={(e) => onPickIdPhoto(e.target.files?.[0])} />
                </div>
                {form.idPhotoUrl ? <img src={form.idPhotoUrl} alt="ID preview" style={{ maxWidth: 260, borderRadius: 8, border: '1px solid #ddd' }} /> : <div className="label">No ID photo uploaded yet.</div>}
                <div className="stack"><label className="label">Notes</label><textarea rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
              </div>
            )}

            <div className="row-between" style={{ marginTop: 14 }}>
              <button onClick={prev} disabled={step === 0}>Back</button>
              {step < STEPS.length - 1 ? <button onClick={next}>Next</button> : <button onClick={save}>{form.id ? 'Update Customer' : 'Create Customer'}</button>}
            </div>
          </div>
        </div>
      )}

      {showImport && (
        <div className="modal-backdrop" onClick={() => { setShowImport(false); resetImportWizard(); }}>
          <div className="rent-modal glass" style={{ width: 'min(820px, 95vw)' }} onClick={(e) => e.stopPropagation()}>
            <h3>Upload Customer Migration</h3>

            {importStep === 1 && (
              <div className="stack">
                <p className="label">Step 1: Review instructions</p>
                <ul>
                  <li>Use CSV format exported from the legacy CRM or rental platform.</li>
                  <li>Required columns: <code>firstName</code>, <code>lastName</code>, and <code>phone</code>.</li>
                  <li>Recommended columns: <code>email</code>, <code>dateOfBirth</code>, address fields, <code>licenseNumber</code>, <code>licenseState</code>, and <code>insurancePolicyNumber</code>.</li>
                  <li>Rows matching an existing email, phone, or license number are skipped.</li>
                  {!me?.tenantId ? <li>For super admin imports, include <code>tenantSlug</code> in every row.</li> : null}
                </ul>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={downloadImportTemplate}>Download Template</button>
                  <button type="button" onClick={() => setImportStep(2)}>Next</button>
                </div>
              </div>
            )}

            {importStep === 2 && (
              <div className="stack">
                <p className="label">Step 2: Upload file and validate</p>
                <input type="file" accept=".csv,text/csv" onChange={(e) => onSelectImportFile(e.target.files?.[0])} />
                <p className="label">Rows loaded: {importRows.length}</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={resetImportWizard}>Try again</button>
                  <button type="button" onClick={validateImport} disabled={!importRows.length || validatingImport}>{validatingImport ? 'Validating…' : 'Validate'}</button>
                </div>
              </div>
            )}

            {importReport && (
              <div className="stack" style={{ marginTop: 12 }}>
                <p><strong>Validation report</strong></p>
                <p className="label">Found: {importReport.found} · Valid: {importReport.valid} · Duplicates: {importReport.duplicates} · Invalid: {importReport.invalid}</p>
                <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid #eee8ff', borderRadius: 8, padding: 8 }}>
                  {importReport.rows.slice(0, 60).map((row) => (
                    <div key={row.row} className="label" style={{ marginBottom: 6 }}>
                      Row {row.row}: {row.valid ? 'valid' : [...row.errors, ...row.duplicateReasons].join(', ')}
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={resetImportWizard}>Try again</button>
                  <button type="button" onClick={proceedImport} disabled={importReport.valid === 0 || importingRows}>{importingRows ? 'Uploading…' : 'Proceed with Upload'}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}
