'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import JSZip from 'jszip';
import QRCode from 'qrcode';
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

function activeAvailabilityBlock(vehicle) {
  const now = Date.now();
  return (Array.isArray(vehicle?.availabilityBlocks) ? vehicle.availabilityBlocks : []).find((block) => {
    const releasedAt = block?.releasedAt ? new Date(block.releasedAt).getTime() : null;
    const blockedFrom = block?.blockedFrom ? new Date(block.blockedFrom).getTime() : now;
    const availableFrom = block?.availableFrom ? new Date(block.availableFrom).getTime() : null;
    return !releasedAt && blockedFrom <= now && availableFrom && availableFrom > now;
  }) || null;
}

function blockTypeLabel(value) {
  switch (String(value || '').toUpperCase()) {
    case 'MAINTENANCE_HOLD': return 'Maintenance Hold';
    case 'OUT_OF_SERVICE_HOLD': return 'Out Of Service';
    default: return 'Migration Hold';
  }
}

function isMigrationHold(block) {
  return String(block?.blockType || '').toUpperCase() === 'MIGRATION_HOLD';
}

function isServiceHold(block) {
  return ['MAINTENANCE_HOLD', 'OUT_OF_SERVICE_HOLD'].includes(String(block?.blockType || '').toUpperCase());
}

function toLocalDateTimeInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function sanitizeFilenamePart(value, fallback = 'vehicle') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || fallback;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function buildVehicleQrLabelBlob(vehicle, qrUrl) {
  const qrDataUrl = await QRCode.toDataURL(qrUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 900,
    color: { dark: '#211a38', light: '#ffffffff' }
  });
  const qrImg = await loadImage(qrDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 1600;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
  grad.addColorStop(0, '#6d3df2');
  grad.addColorStop(1, '#1fc7aa');
  ctx.fillStyle = grad;
  ctx.fillRect(80, 80, canvas.width - 160, 180);

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 34px Aptos, Segoe UI, sans-serif';
  ctx.fillText('RIDE FLEET VEHICLE QR', 120, 150);
  ctx.font = '600 24px Aptos, Segoe UI, sans-serif';
  ctx.fillText('Scan to open the vehicle profile and return workflow.', 120, 195);

  ctx.fillStyle = '#211a38';
  ctx.font = '800 74px Aptos, Segoe UI, sans-serif';
  ctx.fillText(vehicle.plate || 'PLATE PENDING', 120, 360);

  ctx.font = '700 42px Aptos, Segoe UI, sans-serif';
  ctx.fillText(vehicle.internalNumber || 'UNIT', 120, 430);

  const vehicleLine = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle';
  ctx.font = '500 34px Aptos, Segoe UI, sans-serif';
  ctx.fillText(vehicleLine, 120, 486);

  ctx.strokeStyle = '#d7cbff';
  ctx.lineWidth = 3;
  ctx.strokeRect(120, 560, 960, 960);
  ctx.drawImage(qrImg, 180, 620, 840, 840);

  ctx.fillStyle = '#6f668f';
  ctx.font = '500 24px Aptos, Segoe UI, sans-serif';
  ctx.fillText(qrUrl, 120, 1555);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

function VehiclesInner({ token, me, logout }) {
  const router = useRouter();
  const role = String(me?.role || '').toUpperCase().trim();
  const isSuper = role === 'SUPER_ADMIN';
  const canManageVehicleSetup = ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(role);
  const [vehicles, setVehicles] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [tenantRows, setTenantRows] = useState([]);
  const [activeTenantId, setActiveTenantId] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [showRent, setShowRent] = useState(false);
  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showBlockVehicle, setShowBlockVehicle] = useState(false);
  const [showBlockUpload, setShowBlockUpload] = useState(false);
  const [showEditVehicle, setShowEditVehicle] = useState(false);
  const [msg, setMsg] = useState('');

  const [newVehicle, setNewVehicle] = useState({
    internalNumber: '', plate: '', tollTagNumber: '', tollStickerNumber: '', vin: '', make: '', model: '', color: '', year: '', mileage: '', vehicleTypeId: '', homeLocationId: '', fleetMode: 'RENTAL_ONLY'
  });
  const [editVehicleForm, setEditVehicleForm] = useState({
    internalNumber: '', plate: '', tollTagNumber: '', tollStickerNumber: '', vin: '', make: '', model: '', color: '', year: '', mileage: '', status: 'AVAILABLE', vehicleTypeId: '', homeLocationId: '', fleetMode: 'RENTAL_ONLY'
  });

  const [rentForm, setRentForm] = useState({
    customerId: '', pickupAt: '', returnAt: '', pickupLocationId: '', returnLocationId: '', dailyRate: ''
  });

  const [wizardStep, setWizardStep] = useState(1);
  const [uploadRows, setUploadRows] = useState([]);
  const [validationReport, setValidationReport] = useState(null);
  const [validating, setValidating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [blockForm, setBlockForm] = useState({
    blockType: 'MIGRATION_HOLD',
    blockedFrom: toLocalDateTimeInput(new Date()),
    availableFrom: '',
    reason: '',
    notes: ''
  });
  const [blockWizardStep, setBlockWizardStep] = useState(1);
  const [blockUploadRows, setBlockUploadRows] = useState([]);
  const [blockValidationReport, setBlockValidationReport] = useState(null);
  const [validatingBlockUpload, setValidatingBlockUpload] = useState(false);
  const [uploadingBlockRows, setUploadingBlockRows] = useState(false);
  const [exportingQrPack, setExportingQrPack] = useState(false);

  const scopedPath = (path) => {
    if (!isSuper || !activeTenantId) return path;
    const joiner = path.includes('?') ? '&' : '?';
    return `${path}${joiner}tenantId=${encodeURIComponent(activeTenantId)}`;
  };

  const openVehicleDetails = async (vehicle) => {
    if (!vehicle?.id) return;
    setSelected(vehicle);
    setSelectedLoading(true);
    try {
      const detail = await api(scopedPath(`/api/vehicles/${vehicle.id}`), {}, token);
      setSelected((current) => (current?.id === vehicle.id ? detail : current));
    } catch (error) {
      setMsg(error.message);
    } finally {
      setSelectedLoading(false);
    }
  };

  const load = async () => {
    if (isSuper && !activeTenantId) {
      setVehicles([]);
      setCustomers([]);
      setLocations([]);
      setVehicleTypes([]);
      return;
    }
    const [v, c, l, vt] = await Promise.allSettled([
      api(scopedPath('/api/vehicles'), {}, token),
      canManageVehicleSetup ? api(scopedPath('/api/customers'), {}, token) : Promise.resolve([]),
      canManageVehicleSetup ? api(scopedPath('/api/locations'), {}, token) : Promise.resolve([]),
      canManageVehicleSetup ? api(scopedPath('/api/vehicle-types'), {}, token) : Promise.resolve([])
    ]);
    if (v.status === 'fulfilled') setVehicles(v.value || []);
    else setVehicles([]);
    if (c.status === 'fulfilled') setCustomers(c.value || []);
    else setCustomers([]);
    if (l.status === 'fulfilled') setLocations(l.value || []);
    else setLocations([]);
    if (vt.status === 'fulfilled') setVehicleTypes(vt.value || []);
    else setVehicleTypes([]);

    if (v.status === 'rejected') setMsg(v.reason?.message || 'Unable to load vehicles');
    else if (canManageVehicleSetup && [c, l, vt].some((row) => row.status === 'rejected')) setMsg('Vehicles loaded with limited supporting data');
    else setMsg('');
  };

  useEffect(() => {
    if (!isSuper) return;
    api('/api/tenants', {}, token)
      .then((rows) => {
        setTenantRows(rows || []);
        if (!activeTenantId && rows?.length) {
          setActiveTenantId(rows[0].id);
        }
      })
      .catch((err) => setMsg(err.message));
  }, [token, isSuper]);

  useEffect(() => { load(); }, [token, activeTenantId, isSuper, canManageVehicleSetup]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return vehicles;
    return vehicles.filter((v) =>
      (v.internalNumber || '').toLowerCase().includes(q) ||
      (v.plate || '').toLowerCase().includes(q) ||
      (v.tollTagNumber || '').toLowerCase().includes(q) ||
      (v.tollStickerNumber || '').toLowerCase().includes(q) ||
      (v.vin || '').toLowerCase().includes(q) ||
      `${v.make || ''} ${v.model || ''}`.toLowerCase().includes(q)
    );
  }, [vehicles, query]);

  const fleetOpsHub = useMemo(() => {
    const activeBlocks = vehicles.map((vehicle) => ({ vehicle, block: activeAvailabilityBlock(vehicle) })).filter((row) => !!row.block);
    const migrationHolds = activeBlocks.filter((row) => isMigrationHold(row.block));
    const serviceBlocks = activeBlocks.filter((row) => isServiceHold(row.block));
    const available = vehicles.filter((v) => String(v?.status || '').toUpperCase() === 'AVAILABLE' && !activeAvailabilityBlock(v));
    const onRentIds = new Set(vehicles.filter((v) => String(v?.status || '').toUpperCase() === 'ON_RENT').map((v) => v.id));
    migrationHolds.forEach((row) => onRentIds.add(row.vehicle.id));
    const serviceRiskIds = new Set(vehicles.filter((v) => ['IN_MAINTENANCE', 'OUT_OF_SERVICE'].includes(String(v?.status || '').toUpperCase())).map((v) => v.id));
    serviceBlocks.forEach((row) => serviceRiskIds.add(row.vehicle.id));
    const onRent = vehicles.filter((v) => onRentIds.has(v.id));
    const serviceRisk = vehicles.filter((v) => serviceRiskIds.has(v.id));
    const carSharing = vehicles.filter((v) => ['CAR_SHARING_ONLY', 'BOTH'].includes(String(v?.fleetMode || '').toUpperCase()));

    const nextItems = [
      available[0]
        ? {
            id: `available-${available[0].id}`,
            title: 'Next Rentable Unit',
            detail: `${available[0].internalNumber} - ${available[0].make || ''} ${available[0].model || ''}`.trim(),
            note: `${available[0].homeLocation?.name || 'Home location pending'} - ready to go out now.`,
            action: () => openRent(available[0]),
            actionLabel: 'Rent Vehicle'
          }
        : null,
      serviceRisk[0]
        ? {
            id: `service-${serviceRisk[0].id}`,
            title: 'Service Risk Unit',
            detail: `${serviceRisk[0].internalNumber} - ${serviceRisk[0].make || ''} ${serviceRisk[0].model || ''}`.trim(),
            note: `${serviceRisk[0].status} - review this unit before assigning it again.`,
            action: () => openEditVehicle(serviceRisk[0]),
            actionLabel: 'Review Vehicle'
          }
        : null,
      onRent[0]
        ? {
            id: `onrent-${onRent[0].id}`,
            title: 'On-Rent Unit',
            detail: `${onRent[0].internalNumber} - ${onRent[0].make || ''} ${onRent[0].model || ''}`.trim(),
            note: 'This vehicle is currently out and may need return follow-up.',
            action: () => openVehicleDetails(onRent[0]),
            actionLabel: 'Open Unit'
          }
        : null
    ].filter(Boolean);

    return {
      total: vehicles.length,
      available: available.length,
      onRent: onRent.length,
      serviceRisk: serviceRisk.length,
      migrationHolds: migrationHolds.length,
      serviceBlocks: serviceBlocks.length,
      carSharing: carSharing.length,
      nextItems
    };
  }, [vehicles]);

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
    if (isSuper && !activeTenantId) {
      setMsg('Select a tenant before adding vehicles.');
      return;
    }
    try {
      await api(scopedPath('/api/vehicles'), {
        method: 'POST',
        body: JSON.stringify({
          ...newVehicle,
          tenantId: isSuper ? (activeTenantId || null) : undefined,
          year: newVehicle.year ? Number(newVehicle.year) : null,
          mileage: newVehicle.mileage ? Number(newVehicle.mileage) : 0,
          homeLocationId: newVehicle.homeLocationId || null,
          status: 'AVAILABLE'
        })
      }, token);
      setShowAddVehicle(false);
      setNewVehicle({ internalNumber: '', plate: '', tollTagNumber: '', tollStickerNumber: '', vin: '', make: '', model: '', color: '', year: '', mileage: '', vehicleTypeId: '', homeLocationId: '', fleetMode: 'RENTAL_ONLY' });
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
      tollTagNumber: vehicle.tollTagNumber || '',
      tollStickerNumber: vehicle.tollStickerNumber || '',
      vin: vehicle.vin || '',
      make: vehicle.make || '',
      model: vehicle.model || '',
      color: vehicle.color || '',
      year: vehicle.year || '',
      mileage: vehicle.mileage ?? '',
      status: vehicle.status || 'AVAILABLE',
      vehicleTypeId: vehicle.vehicleTypeId || '',
      homeLocationId: vehicle.homeLocationId || '',
      fleetMode: vehicle.fleetMode || 'RENTAL_ONLY'
    });
    setShowEditVehicle(true);
  };

  const openBlockVehicle = (vehicle) => {
    setSelected(vehicle);
    const activeBlock = activeAvailabilityBlock(vehicle);
    const baseStart = activeBlock?.blockedFrom ? toLocalDateTimeInput(activeBlock.blockedFrom) : toLocalDateTimeInput(new Date());
    setBlockForm({
      blockType: activeBlock?.blockType || 'MIGRATION_HOLD',
      blockedFrom: baseStart,
      availableFrom: activeBlock?.availableFrom ? toLocalDateTimeInput(activeBlock.availableFrom) : '',
      reason: activeBlock?.reason || '',
      notes: activeBlock?.notes || ''
    });
    setShowBlockVehicle(true);
  };

  const saveEditVehicle = async (e) => {
    e.preventDefault();
    if (!selected) return;
    try {
      await api(scopedPath(`/api/vehicles/${selected.id}`), {
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

  const openVehicleProfile = (vehicle) => {
    if (!vehicle?.id) return;
    router.push(`/vehicles/${vehicle.id}`);
  };

  const printVehicleQr = (vehicle) => {
    if (!vehicle?.id || typeof window === 'undefined') return;
    window.open(`/vehicles/${vehicle.id}?print=1`, '_blank', 'noopener,noreferrer');
  };

  const exportQrPack = async () => {
    if (typeof window === 'undefined') return;
    if (!vehicles.length) {
      setMsg('There are no vehicles in this tenant scope to export.');
      return;
    }
    setExportingQrPack(true);
    try {
      const origin = window.location.origin;
      const zip = new JSZip();
      for (let idx = 0; idx < vehicles.length; idx += 1) {
        const vehicle = vehicles[idx];
        const qrUrl = `${origin}/vehicles/${vehicle.id}`;
        const blob = await buildVehicleQrLabelBlob(vehicle, qrUrl);
        if (!blob) continue;
        const plateKey = sanitizeFilenamePart(vehicle.plate, 'plate-pending');
        const unitKey = sanitizeFilenamePart(vehicle.internalNumber, `vehicle-${idx + 1}`);
        zip.file(`${plateKey}__${unitKey}.png`, blob);
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const scopeName = sanitizeFilenamePart(
        isSuper
          ? (tenantRows.find((tenant) => tenant.id === activeTenantId)?.slug || activeTenantId || 'all-tenants')
          : (me?.tenantSlug || me?.tenantName || 'tenant'),
        'tenant'
      );
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vehicle-qr-pack-${scopeName}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg(`QR export complete. Packed ${vehicles.length} vehicle labels into a ZIP.`);
    } catch (error) {
      setMsg(error.message || 'Failed to export QR pack');
    } finally {
      setExportingQrPack(false);
    }
  };

  const downloadTemplate = () => {
    const sampleType = vehicleTypes[0]?.code || 'ECON';
    const csv = `internalNumber,plate,tollTagNumber,tollStickerNumber,vin,make,model,color,year,vehicleTypeCode\nUNIT-001,ABC123,TAG-1001,SELLO-1001,1HGBH41JXMN109186,Honda,Civic,Silver,2024,${sampleType}`;
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
      const report = await api(scopedPath('/api/vehicles/bulk/validate'), {
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
    if (isSuper && !activeTenantId) {
      setMsg('Select a tenant before uploading inventory.');
      setUploading(false);
      return;
    }
    try {
      const out = await api(scopedPath('/api/vehicles/bulk/import'), {
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

  const resetBlockWizard = () => {
    setBlockWizardStep(1);
    setBlockUploadRows([]);
    setBlockValidationReport(null);
  };

  const downloadBlockTemplate = () => {
    const sampleUnit = rows[0]?.internalNumber || 'UNIT-001';
    const csv = `internalNumber,blockType,blockedFrom,availableFrom,reason,notes\n${sampleUnit},MIGRATION_HOLD,${toLocalDateTimeInput(new Date())},2026-04-15T10:00,Legacy contract,Migrating active contract from prior system`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vehicle_availability_block_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const onSelectBlockUploadFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    setBlockUploadRows(parseCsv(text));
  };

  const validateBlockUpload = async () => {
    setValidatingBlockUpload(true);
    setBlockValidationReport(null);
    try {
      const report = await api(scopedPath('/api/vehicles/availability-blocks/validate'), {
        method: 'POST',
        body: JSON.stringify({ rows: blockUploadRows })
      }, token);
      setBlockValidationReport(report);
    } catch (e2) {
      setMsg(e2.message);
    } finally {
      setValidatingBlockUpload(false);
    }
  };

  const proceedBlockUpload = async () => {
    setUploadingBlockRows(true);
    try {
      const out = await api(scopedPath('/api/vehicles/availability-blocks/import'), {
        method: 'POST',
        body: JSON.stringify({ rows: blockUploadRows })
      }, token);
      setMsg(`Vehicle blocks uploaded. Created ${out.created}, skipped ${out.skipped}.`);
      setShowBlockUpload(false);
      resetBlockWizard();
      await load();
    } catch (e2) {
      setMsg(e2.message);
    } finally {
      setUploadingBlockRows(false);
    }
  };

  const saveVehicleBlock = async (e) => {
    e.preventDefault();
    if (!selected) return;
    try {
      await api(scopedPath(`/api/vehicles/${selected.id}/availability-blocks`), {
        method: 'POST',
        body: JSON.stringify(blockForm)
      }, token);
      setMsg(`Vehicle ${selected.internalNumber} blocked until ${new Date(blockForm.availableFrom).toLocaleString()}`);
      setShowBlockVehicle(false);
      setSelected(null);
      await load();
    } catch (e2) {
      setMsg(e2.message);
    }
  };

  const releaseVehicleBlock = async (blockId) => {
    try {
      await api(scopedPath(`/api/vehicles/availability-blocks/${blockId}/release`), {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      setMsg('Vehicle block released');
      setSelected(null);
      await load();
    } catch (e2) {
      setMsg(e2.message);
    }
  };

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg section-card" style={{ marginBottom: 16 }}>
        <div className="app-banner">
          <div className="row-between" style={{ alignItems: 'start', marginBottom: 0 }}>
            <div>
              <span className="eyebrow">Fleet Ops Hub</span>
              <h2 className="page-title" style={{ marginTop: 6 }}>
                Keep fleet availability and service risk in view.
              </h2>
              <p className="ui-muted">A quick mobile-first board before dropping into the full vehicle inventory table.</p>
            </div>
            <span className="status-chip neutral">Fleet Ops</span>
          </div>
          {isSuper ? (
            <div className="stack" style={{ maxWidth: 420, marginTop: 12 }}>
              <label className="label">Inventory Tenant Scope</label>
              <select value={activeTenantId} onChange={(e) => setActiveTenantId(e.target.value)}>
                <option value="">Select a tenant</option>
                {tenantRows.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>{tenant.name} ({tenant.slug})</option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="app-card-grid compact">
            <div className="info-tile">
              <span className="label">Total Units</span>
              <strong>{fleetOpsHub.total}</strong>
              <span className="ui-muted">Vehicles currently registered in this workspace.</span>
            </div>
            <div className="info-tile">
              <span className="label">Available</span>
              <strong>{fleetOpsHub.available}</strong>
              <span className="ui-muted">Units ready to rent or assign right now.</span>
            </div>
            <div className="info-tile">
              <span className="label">On Rent</span>
              <strong>{fleetOpsHub.onRent}</strong>
              <span className="ui-muted">Vehicles currently out with customers.</span>
            </div>
            <div className="info-tile">
              <span className="label">Service Risk</span>
              <strong>{fleetOpsHub.serviceRisk}</strong>
              <span className="ui-muted">Units in maintenance or out of service.</span>
            </div>
            <div className="info-tile">
              <span className="label">Temp Blocks</span>
              <strong>{fleetOpsHub.migrationHolds}</strong>
              <span className="ui-muted">Legacy-contract units still counted as fleet in rental.</span>
            </div>
            <div className="info-tile">
              <span className="label">Service Holds</span>
              <strong>{fleetOpsHub.serviceBlocks}</strong>
              <span className="ui-muted">Vehicles blocked for maintenance or out-of-service windows.</span>
            </div>
          </div>
          <div className="app-banner-list">
            <span className="app-banner-pill">Car Sharing Supply {fleetOpsHub.carSharing}</span>
            {canManageVehicleSetup ? <button type="button" className="button-subtle" onClick={() => setShowAddVehicle(true)} disabled={isSuper && !activeTenantId}>Add Vehicle</button> : null}
            {canManageVehicleSetup ? <button type="button" className="button-subtle" onClick={() => setShowUpload(true)} disabled={isSuper && !activeTenantId}>Upload Inventory</button> : null}
            <button type="button" className="button-subtle" onClick={() => setShowBlockUpload(true)} disabled={isSuper && !activeTenantId}>Upload Blocks</button>
            <button type="button" className="button-subtle" onClick={exportQrPack} disabled={(isSuper && !activeTenantId) || !vehicles.length || exportingQrPack}>{exportingQrPack ? 'Exporting QR Pack...' : 'Export QR Pack'}</button>
          </div>
          {fleetOpsHub.nextItems.length ? (
            <div className="app-card-grid compact">
              {fleetOpsHub.nextItems.map((item) => (
                <section key={item.id} className="glass card section-card">
                  <div className="section-title" style={{ fontSize: 15 }}>{item.title}</div>
                  <div className="ui-muted">{item.detail}</div>
                  <div className="surface-note">{item.note}</div>
                  <div className="inline-actions">
                    <button type="button" onClick={item.action}>{item.actionLabel}</button>
                  </div>
                </section>
              ))}
            </div>
          ) : null}
        </div>
      </section>
      <section className="glass card-lg">
        <div className="row-between">
          <h2>Vehicle Inventory</h2>
          <div style={{ display: 'flex', gap: 8, width: 'min(720px,100%)' }}>
            <input placeholder="Search unit, plate, toll tag, sticker, make/model, VIN" value={query} onChange={(e) => setQuery(e.target.value)} />
            {canManageVehicleSetup ? <button onClick={() => setShowAddVehicle(true)} disabled={isSuper && !activeTenantId}>Add Vehicle</button> : null}
            {canManageVehicleSetup ? <button onClick={() => setShowUpload(true)} disabled={isSuper && !activeTenantId}>Upload Inventory</button> : null}
            <button onClick={() => setShowBlockUpload(true)} disabled={isSuper && !activeTenantId}>Upload Blocks</button>
            <button className="button-subtle" onClick={exportQrPack} disabled={(isSuper && !activeTenantId) || !vehicles.length || exportingQrPack}>{exportingQrPack ? 'Exporting...' : 'Export QR Pack'}</button>
          </div>
        </div>
        {msg ? <p className="label">{msg}</p> : null}
        <table>
          <thead>
            <tr>
              <th>Unit ID</th>
              <th>License</th>
              <th>Toll Tag</th>
              <th>Toll Sticker</th>
              <th>Make</th>
              <th>Model</th>
              <th>Color</th>
              <th>VIN</th>
              <th>Type</th>
              <th>Current Location</th>
              <th>Status</th>
              <th>Block Type</th>
              <th>Blocked Until</th>
              <th>Fleet Mode</th>
              <th>Rent</th>
              <th>Profile</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => {
              const currentBlock = activeAvailabilityBlock(v);
              return (
              <tr key={v.id} onClick={() => openVehicleDetails(v)} style={{ cursor: 'pointer' }}>
                <td>{v.internalNumber}</td>
                <td>{v.plate || '-'}</td>
                <td>{v.tollTagNumber || '-'}</td>
                <td>{v.tollStickerNumber || '-'}</td>
                <td>{v.make || '-'}</td>
                <td>{v.model || '-'}</td>
                <td>{v.color || '-'}</td>
                <td>{v.vin || '-'}</td>
                <td>{v.vehicleType?.name || '-'}</td>
                <td>{v.homeLocation?.name || '-'}</td>
                <td><span className="badge">{v.status}</span></td>
                <td>{currentBlock ? blockTypeLabel(currentBlock.blockType) : '-'}</td>
                <td>{currentBlock ? `${new Date(currentBlock.availableFrom).toLocaleString()}` : '-'}</td>
                <td><span className="badge">{v.fleetMode || 'RENTAL_ONLY'}</span></td>
                <td>
                  <button onClick={(e) => { e.stopPropagation(); openRent(v); }} disabled={v.status !== 'AVAILABLE' || !!currentBlock}>Rent</button>
                </td>
                <td>
                  <div className="inline-actions">
                    <button onClick={(e) => { e.stopPropagation(); openVehicleProfile(v); }}>Open</button>
                    <button className="button-subtle" onClick={(e) => { e.stopPropagation(); printVehicleQr(v); }}>QR</button>
                  </div>
                </td>
              </tr>
            )})}
          </tbody>
        </table>
      </section>

      {selected && !showRent && (
        <aside className="detail-drawer glass">
          <div className="row-between"><h3>{selected.internalNumber}</h3><button onClick={() => setSelected(null)}>Close</button></div>
          {selectedLoading ? <div className="label" style={{ marginBottom: 8 }}>Loading latest vehicle detail...</div> : null}
          <div className="stack">
            <div><span className="label">VIN</span><div>{selected.vin || '-'}</div></div>
            <div><span className="label">Plate</span><div>{selected.plate || '-'}</div></div>
            <div><span className="label">Toll Tag</span><div>{selected.tollTagNumber || '-'}</div></div>
            <div><span className="label">Toll Sticker</span><div>{selected.tollStickerNumber || '-'}</div></div>
            <div><span className="label">Vehicle</span><div>{selected.year || ''} {selected.make || ''} {selected.model || ''}</div></div>
            <div><span className="label">Color</span><div>{selected.color || '-'}</div></div>
            <div><span className="label">Mileage</span><div>{selected.mileage ?? 0}</div></div>
            <div><span className="label">Type</span><div>{selected.vehicleType?.name || '-'}</div></div>
            <div><span className="label">Home Location</span><div>{selected.homeLocation?.name || '-'}</div></div>
            <div><span className="label">Fleet Mode</span><div>{selected.fleetMode || 'RENTAL_ONLY'}</div></div>
            <div>
              <span className="label">Temporary Block</span>
              <div>
                {activeAvailabilityBlock(selected)
                  ? `${blockTypeLabel(activeAvailabilityBlock(selected).blockType)} until ${new Date(activeAvailabilityBlock(selected).availableFrom).toLocaleString()}`
                  : 'No active temporary block'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => openRent(selected)} disabled={selected.status !== 'AVAILABLE' || !!activeAvailabilityBlock(selected)}>Rent this vehicle</button>
              <button onClick={() => openVehicleProfile(selected)}>Open profile</button>
              <button className="button-subtle" onClick={() => printVehicleQr(selected)}>Print QR label</button>
              <button onClick={() => openEditVehicle(selected)}>Edit vehicle</button>
              <button onClick={() => openBlockVehicle(selected)}>Block until available</button>
              {activeAvailabilityBlock(selected) ? (
                <button onClick={() => releaseVehicleBlock(activeAvailabilityBlock(selected).id)}>Release block</button>
              ) : null}
            </div>

            {activeAvailabilityBlock(selected) ? (
              <div className="glass card" style={{ padding: 10 }}>
                <div className="row-between">
                  <strong>Current Vehicle Hold</strong>
                  <span className="badge">BLOCKED</span>
                </div>
                <div className="label" style={{ marginTop: 6, textTransform: 'none', letterSpacing: 0 }}>Type: {blockTypeLabel(activeAvailabilityBlock(selected).blockType)}</div>
                <div className="label" style={{ marginTop: 6, textTransform: 'none', letterSpacing: 0 }}>
                  From {new Date(activeAvailabilityBlock(selected).blockedFrom).toLocaleString()} until {new Date(activeAvailabilityBlock(selected).availableFrom).toLocaleString()}
                </div>
                {activeAvailabilityBlock(selected).reason ? <div className="label" style={{ marginTop: 6, textTransform: 'none', letterSpacing: 0 }}>Reason: {activeAvailabilityBlock(selected).reason}</div> : null}
                {activeAvailabilityBlock(selected).notes ? <div className="label" style={{ marginTop: 6, textTransform: 'none', letterSpacing: 0 }}>Notes: {activeAvailabilityBlock(selected).notes}</div> : null}
              </div>
            ) : null}

            <div className="glass card" style={{ padding: 10, marginTop: 8 }}>
              <div className="row-between"><strong>Inspection History</strong><span className="badge">{(selected.rentalAgreements || []).filter((a) => !!agreementInspectionSummary(a)).length}</span></div>
              <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                {(selected.rentalAgreements || []).map((a) => {
                  const rep = agreementInspectionSummary(a);
                  if (!rep) return null;
                  return (
                    <div key={a.id} className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
                      {a.agreementNumber} | {a.reservation?.reservationNumber || '-'} | Checkout: {rep?.checkout?.at ? 'Yes' : 'No'} | Check-in: {rep?.checkin?.at ? 'Yes' : 'No'}
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
                <input placeholder="Toll Tag Number" value={newVehicle.tollTagNumber || ''} onChange={(e) => setNewVehicle({ ...newVehicle, tollTagNumber: e.target.value })} />
                <input placeholder="Toll Sticker Number" value={newVehicle.tollStickerNumber || ''} onChange={(e) => setNewVehicle({ ...newVehicle, tollStickerNumber: e.target.value })} />
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
              <select value={newVehicle.fleetMode} onChange={(e) => setNewVehicle({ ...newVehicle, fleetMode: e.target.value })}>
                <option value="RENTAL_ONLY">RENTAL_ONLY</option>
                <option value="CAR_SHARING_ONLY">CAR_SHARING_ONLY</option>
                <option value="BOTH">BOTH</option>
              </select>
              <div className="row-between"><button type="button" onClick={() => setShowAddVehicle(false)}>Cancel</button><button type="submit">Save Vehicle</button></div>
            </form>
          </div>
        </div>
      )}

      {showEditVehicle && selected && (
        <div className="modal-backdrop" onClick={() => setShowEditVehicle(false)}>
          <div className="rent-modal glass" onClick={(e) => e.stopPropagation()}>
            <h3>Edit Vehicle | {selected.internalNumber}</h3>
            <form className="stack" onSubmit={saveEditVehicle}>
              <div className="grid2">
                <input required placeholder="Unit ID" value={editVehicleForm.internalNumber} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, internalNumber: e.target.value })} />
                <input placeholder="License Plate" value={editVehicleForm.plate} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, plate: e.target.value })} />
              </div>
              <div className="grid2">
                <input placeholder="Toll Tag Number" value={editVehicleForm.tollTagNumber || ''} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, tollTagNumber: e.target.value })} />
                <input placeholder="Toll Sticker Number" value={editVehicleForm.tollStickerNumber || ''} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, tollStickerNumber: e.target.value })} />
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
              <select value={editVehicleForm.fleetMode} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, fleetMode: e.target.value })}>
                <option value="RENTAL_ONLY">RENTAL_ONLY</option>
                <option value="CAR_SHARING_ONLY">CAR_SHARING_ONLY</option>
                <option value="BOTH">BOTH</option>
              </select>
              <select value={editVehicleForm.status} onChange={(e) => setEditVehicleForm({ ...editVehicleForm, status: e.target.value })}>
                {['AVAILABLE', 'RESERVED', 'ON_RENT', 'IN_MAINTENANCE', 'OUT_OF_SERVICE'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <div className="row-between"><button type="button" onClick={() => setShowEditVehicle(false)}>Cancel</button><button type="submit">Save Changes</button></div>
            </form>
          </div>
        </div>
      )}

      {showBlockVehicle && selected && (
        <div className="modal-backdrop" onClick={() => setShowBlockVehicle(false)}>
          <div className="rent-modal glass" onClick={(e) => e.stopPropagation()}>
            <h3>Temporary Block | {selected.internalNumber}</h3>
            <form className="stack" onSubmit={saveVehicleBlock}>
              <div className="grid2">
                <select value={blockForm.blockType} onChange={(e) => setBlockForm({ ...blockForm, blockType: e.target.value })}>
                  <option value="MIGRATION_HOLD">Migration Hold</option>
                  <option value="MAINTENANCE_HOLD">Maintenance Hold</option>
                  <option value="OUT_OF_SERVICE_HOLD">Out Of Service Hold</option>
                </select>
                <div />
              </div>
              <div className="grid2">
                <div className="stack">
                  <label className="label">Blocked From</label>
                  <input type="datetime-local" value={blockForm.blockedFrom} onChange={(e) => setBlockForm({ ...blockForm, blockedFrom: e.target.value })} />
                </div>
                <div className="stack">
                  <label className="label">Available Again*</label>
                  <input required type="datetime-local" value={blockForm.availableFrom} onChange={(e) => setBlockForm({ ...blockForm, availableFrom: e.target.value })} />
                </div>
              </div>
              <input placeholder="Reason (migration hold, legacy contract, etc.)" value={blockForm.reason} onChange={(e) => setBlockForm({ ...blockForm, reason: e.target.value })} />
              <textarea rows={4} placeholder="Notes" value={blockForm.notes} onChange={(e) => setBlockForm({ ...blockForm, notes: e.target.value })} />
              <div className="surface-note">Migration holds count as fleet already out on legacy contracts. Maintenance and out-of-service holds remove the unit from rentable service until the selected release date.</div>
              <div className="row-between">
                <button type="button" onClick={() => setShowBlockVehicle(false)}>Cancel</button>
                <button type="submit">Save Block</button>
              </div>
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
                  <li>Required columns: <code>internalNumber</code>, <code>vehicleTypeCode</code> or <code>vehicleType</code>.</li>
                  <li>Recommended columns: plate, tollTagNumber, tollStickerNumber, vin, make, model, color, year.</li>
                  <li>Use the vehicle class code from this tenant, like <code>ECON</code>, <code>SUV</code>, or <code>CCAR</code>.</li>
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
                  <button type="button" onClick={validateUpload} disabled={!uploadRows.length || validating}>{validating ? 'Validating...' : 'Validate'}</button>
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

      {showBlockUpload && (
        <div className="modal-backdrop" onClick={() => { setShowBlockUpload(false); resetBlockWizard(); }}>
          <div className="rent-modal glass" onClick={(e) => e.stopPropagation()}>
            <h3>Upload Vehicle Blocks</h3>

            {blockWizardStep === 1 && (
              <div className="stack">
                <p className="label">Step 1: Review instructions</p>
                <ul>
                  <li>Use CSV format.</li>
                  <li>Required columns: <code>internalNumber</code> or <code>plate</code>, <code>blockType</code>, plus <code>availableFrom</code>.</li>
                  <li>Optional columns: <code>blockedFrom</code>, <code>reason</code>, <code>notes</code>.</li>
                  <li>Use <code>MIGRATION_HOLD</code>, <code>MAINTENANCE_HOLD</code>, or <code>OUT_OF_SERVICE_HOLD</code>.</li>
                  <li>These temporary blocks appear in the planner and are excluded from booking availability.</li>
                </ul>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={downloadBlockTemplate}>Download Template</button>
                  <button type="button" onClick={() => setBlockWizardStep(2)}>Next</button>
                </div>
              </div>
            )}

            {blockWizardStep === 2 && (
              <div className="stack">
                <p className="label">Step 2: Upload file and validate</p>
                <input type="file" accept=".csv,text/csv" onChange={(e) => onSelectBlockUploadFile(e.target.files?.[0])} />
                <p className="label">Rows loaded: {blockUploadRows.length}</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={resetBlockWizard}>Try again</button>
                  <button type="button" onClick={validateBlockUpload} disabled={!blockUploadRows.length || validatingBlockUpload}>{validatingBlockUpload ? 'Validating...' : 'Validate'}</button>
                </div>
              </div>
            )}

            {blockValidationReport && (
              <div className="stack" style={{ marginTop: 12 }}>
                <p><strong>Validation report</strong></p>
                <p className="label">Found: {blockValidationReport.found} · Valid: {blockValidationReport.valid} · Invalid: {blockValidationReport.invalid}</p>
                <div style={{ maxHeight: 140, overflow: 'auto', border: '1px solid #eee8ff', borderRadius: 8, padding: 8 }}>
                  {blockValidationReport.rows.slice(0, 50).map((r) => (
                    <div key={r.row} className="label">Row {r.row}: {r.valid ? 'valid' : r.errors.join(', ')}</div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={resetBlockWizard}>Try again</button>
                  <button type="button" onClick={proceedBlockUpload} disabled={blockValidationReport.valid === 0 || uploadingBlockRows}>{uploadingBlockRows ? 'Uploading…' : 'Proceed with Upload'}</button>
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
