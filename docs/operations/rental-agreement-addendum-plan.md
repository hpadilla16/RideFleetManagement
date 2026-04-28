# Rental Agreement Addendum Implementation Plan

**Date:** 2026-04-23  
**Owner:** solution-architect  
**Status:** Ready for implementation (Feature branch: `feature/rental-agreement-addendum`)  
**Bug Fixed:** BUG-001 (signed agreement dates do not update when reservation dates change post-signature)

---

## 1. Summary

**Problem:** When a reservation's `pickupAt` / `returnAt` are edited after the customer has signed the rental agreement (especially post-`CHECKED_OUT`), the signed agreement still displays the original dates while the charges are silently recalculated for the new period. This is a legal/compliance risk: the customer's signed contract no longer matches the actual rental period.

**Solution:** Implement **Option C — Addendum Flow**. The original signed rental agreement becomes immutable (the legal record). When dates change after signing, the system creates a new `RentalAgreementAddendum` row that captures:
- New pickup/return dates
- Reason for change (admin override, customer request, system correction, etc.)
- New charges delta (what changed from original to new)
- Who initiated the change (admin user ID / customer / system)
- Timestamp and status lifecycle (`PENDING_SIGNATURE` → `SIGNED` → `VOID`)

The customer re-signs the addendum via the existing signature flow (parameterized by type). Both documents are rendered separately and both are stored as immutable legal records. Email notifications are sent to the customer and admin team.

This mirrors industry-standard car rental software (Hertz, Enterprise) for handling mid-rental extensions and date corrections.

**Scope boundary:**
- ✅ Add `RentalAgreementAddendum` model to Prisma schema.
- ✅ Create migration for new tables + indexes.
- ✅ Implement addendum service (create, sign, list, render).
- ✅ Add routes for addendum CRUD + signature + email.
- ✅ Implement gate: block reservation date edit if `PENDING_SIGNATURE` addendum exists.
- ✅ Frontend: display addendum on agreement detail page (chronologically below parent).
- ✅ Frontend: allow customer re-signature via existing `/customer/sign-agreement` flow with `type=addendum` parameter.
- ✅ Email notifications: customer + admin team on addendum creation.
- ✅ Unit + integration tests + tenant-isolation suite case.
- ❌ Do NOT implement customer self-service addendum requests (deferred; MVP = admin-initiated only).
- ❌ Do NOT allow SUPER_ADMIN silent edit bypass without audit (deferred; out of scope).
- ❌ Do NOT implement recurring addendums (e.g., "extend by 3 more days") — each extension is a new addendum.
- ❌ Do NOT implement addendum approval workflow (they auto-SIGNED when customer signs, no separate approval step).

**Deployment risk:** LOW. Backward compatible: existing agreements are unaffected. New behavior only applies to date edits after addendum feature is live. Rollback is simple (revert migration + code).

---

## 2. Schema Changes

### 2.1 Prisma Migration

**File:** `backend/prisma/migrations/20260423_add_rental_agreement_addendum/migration.sql`

```sql
-- New table for rental agreement addendums
CREATE TABLE "RentalAgreementAddendum" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "rentalAgreementId" TEXT NOT NULL,
  "tenantId" TEXT,
  "pickupAt" TIMESTAMP(3) NOT NULL,
  "returnAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "reason_category" TEXT DEFAULT 'admin_correction',
  "initiatedBy" TEXT,
  "initiatedByRole" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING_SIGNATURE',
  "signatureSignedBy" TEXT,
  "signatureDataUrl" TEXT,
  "signatureSignedAt" TIMESTAMP(3),
  "signatureIp" TEXT,
  "originalCharges" TEXT,
  "newCharges" TEXT,
  "chargeDelta" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RentalAgreementAddendum_rentalAgreementId_fkey" FOREIGN KEY ("rentalAgreementId") REFERENCES "RentalAgreement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RentalAgreementAddendum_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Indexes for common queries
CREATE INDEX "RentalAgreementAddendum_rentalAgreementId_idx" ON "RentalAgreementAddendum"("rentalAgreementId");
CREATE INDEX "RentalAgreementAddendum_tenantId_status_idx" ON "RentalAgreementAddendum"("tenantId", "status");
CREATE INDEX "RentalAgreementAddendum_status_createdAt_idx" ON "RentalAgreementAddendum"("status", "createdAt");
CREATE INDEX "RentalAgreementAddendum_tenantId_createdAt_idx" ON "RentalAgreementAddendum"("tenantId", "createdAt");
```

### 2.2 Prisma Schema Update

**File:** `backend/prisma/schema.prisma`

Find the `model RentalAgreement` block and add a relation field. Then add the new model:

```prisma
model RentalAgreement {
  // ... existing fields ...
  
  addendums RentalAgreementAddendum[]  // NEW: one-to-many relation
  
  // ... rest of model ...
}

// NEW MODEL: Rental Agreement Addendum
model RentalAgreementAddendum {
  id                   String   @id @default(cuid())
  rentalAgreementId    String
  rentalAgreement      RentalAgreement @relation(fields: [rentalAgreementId], references: [id])
  
  tenantId             String?
  tenant               Tenant?  @relation(fields: [tenantId], references: [id])
  
  pickupAt             DateTime
  returnAt             DateTime
  
  reason               String          // "Customer requested extension", "Admin correction", "System override", etc.
  reason_category      String?         // 'customer_request' | 'admin_correction' | 'system' | 'extension'
  
  initiatedBy          String?         // User ID who created this addendum
  initiatedByRole      String?         // Role of initiator ('ADMIN', 'SUPER_ADMIN', 'SYSTEM', 'CUSTOMER', etc.)
  
  status               String  @default("PENDING_SIGNATURE")  // PENDING_SIGNATURE | SIGNED | VOID
  
  // Signature (customer re-signs the addendum)
  signatureSignedBy    String?         // Name of signer
  signatureDataUrl     String?         // Data URL of signature image
  signatureSignedAt    DateTime?
  signatureIp          String?         // IP address of signer
  
  // Charges snapshot (for audit trail)
  originalCharges      String?         // JSON: charges from parent agreement at time of addendum creation
  newCharges           String?         // JSON: recalculated charges for new period
  chargeDelta          String?         // JSON: { added: [...], removed: [...], modified: [...] }
  
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
  
  @@index([rentalAgreementId])
  @@index([tenantId, status])
  @@index([status, createdAt])
  @@index([tenantId, createdAt])
}
```

### 2.3 Backward Compatibility

- No changes to `RentalAgreement` table; existing rows are unaffected.
- `RentalAgreementAddendum.status` defaults to `PENDING_SIGNATURE` (safe).
- Addendums only created when a date edit is made post-signature; pre-signature behavior unchanged.

---

## 3. Backend Changes

### 3.1 Rental Agreements Service — Addendum Methods

**File:** `backend/src/modules/rental-agreements/rental-agreements.service.js`

Add new methods to the service class (after existing methods like `finalize`, `signAgreement`, etc.):

```javascript
/**
 * Create a rental agreement addendum when reservation dates are edited post-signature.
 * Captures original charges + new charges for audit trail.
 */
async createAddendum(rentalAgreementId, {
  newPickupAt,
  newReturnAt,
  reason = 'Date correction',
  reason_category = 'admin_correction',
  initiatedBy = null,       // User ID
  initiatedByRole = 'ADMIN' // Role
} = {}) {
  // Validate inputs
  if (!rentalAgreementId) throw new Error('rentalAgreementId is required');
  if (!newPickupAt || !newReturnAt) throw new Error('newPickupAt and newReturnAt are required');
  
  // Fetch parent agreement with charges
  const agreement = await prisma.rentalAgreement.findUnique({
    where: { id: rentalAgreementId },
    include: {
      charges: true,
      reservation: { select: { pickupAt: true, returnAt: true, tenantId: true } }
    }
  });
  if (!agreement) throw new Error('Rental agreement not found');
  
  // Store original charges snapshot
  const originalCharges = agreement.charges.map(c => ({
    id: c.id,
    description: c.description,
    amount: c.amount.toString(),
    category: c.category
  }));
  
  // NOTE: In real implementation, recalculate charges for new dates using
  // reservationPricingService.calculateCharges or similar.
  // For now, placeholder.
  const newCharges = []; // TODO: recalculate charges for [newPickupAt, newReturnAt]
  
  // Create the addendum
  const addendum = await prisma.rentalAgreementAddendum.create({
    data: {
      rentalAgreementId,
      tenantId: agreement.tenantId,
      pickupAt: new Date(newPickupAt),
      returnAt: new Date(newReturnAt),
      reason: String(reason).trim(),
      reason_category: String(reason_category).trim(),
      initiatedBy: initiatedBy ? String(initiatedBy).trim() : null,
      initiatedByRole: String(initiatedByRole).trim(),
      status: 'PENDING_SIGNATURE',
      originalCharges: JSON.stringify(originalCharges),
      newCharges: JSON.stringify(newCharges),
      chargeDelta: JSON.stringify({ added: [], removed: [], modified: [] })
    }
  });
  
  return addendum;
}

/**
 * Sign a rental agreement addendum (customer submits signature via portal).
 */
async signAddendum(addendumId, {
  signatureDataUrl,
  signatureSignedBy,
  ip
} = {}) {
  if (!addendumId) throw new Error('addendumId is required');
  
  const signerName = String(signatureSignedBy || 'Unknown').trim();
  const dataUrl = String(signatureDataUrl || '').trim();
  if (!dataUrl) throw new Error('Signature is required');
  
  const addendum = await prisma.rentalAgreementAddendum.findUnique({
    where: { id: addendumId }
  });
  if (!addendum) throw new Error('Addendum not found');
  if (addendum.status !== 'PENDING_SIGNATURE') {
    throw new Error(`Cannot sign addendum with status ${addendum.status}`);
  }
  
  const signed = await prisma.rentalAgreementAddendum.update({
    where: { id: addendumId },
    data: {
      status: 'SIGNED',
      signatureSignedBy: signerName,
      signatureDataUrl: dataUrl,
      signatureSignedAt: new Date(),
      signatureIp: String(ip || '-').trim()
    }
  });
  
  return signed;
}

/**
 * List addendums for a rental agreement (sorted newest first).
 */
async listAddendums(rentalAgreementId, scope = {}) {
  if (!rentalAgreementId) throw new Error('rentalAgreementId is required');
  
  return prisma.rentalAgreementAddendum.findMany({
    where: {
      rentalAgreementId,
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
    },
    orderBy: { createdAt: 'desc' }
  });
}

/**
 * Get a single addendum by ID.
 */
async getAddendumById(addendumId, scope = {}) {
  if (!addendumId) throw new Error('addendumId is required');
  
  return prisma.rentalAgreementAddendum.findFirst({
    where: {
      id: addendumId,
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
    }
  });
}

/**
 * Void an addendum (mark as VOID, not deleted, for audit trail).
 */
async voidAddendum(addendumId, reason = 'Cancelled', scope = {}) {
  if (!addendumId) throw new Error('addendumId is required');
  
  const addendum = await this.getAddendumById(addendumId, scope);
  if (!addendum) throw new Error('Addendum not found');
  
  return prisma.rentalAgreementAddendum.update({
    where: { id: addendumId },
    data: {
      status: 'VOID'
    }
  });
}

/**
 * Render addendum as HTML (similar to agreement, but simpler).
 * For now, a simple template; can be extended with Puppeteer + PDF later.
 */
async renderAddendumHtml(addendumId) {
  if (!addendumId) throw new Error('addendumId is required');
  
  const addendum = await prisma.rentalAgreementAddendum.findUnique({
    where: { id: addendumId },
    include: {
      rentalAgreement: {
        select: {
          id: true,
          agreementNumber: true,
          customerFirstName: true,
          customerLastName: true
        }
      }
    }
  });
  
  if (!addendum) throw new Error('Addendum not found');
  
  // Simple HTML template (can be enhanced with a file template like agreement-modern.html)
  const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '';
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Rental Agreement Addendum</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .header { text-align: center; margin-bottom: 30px; }
        .section { margin: 20px 0; }
        .field-row { display: flex; margin: 10px 0; }
        .label { font-weight: bold; width: 200px; }
        .value { flex: 1; }
        .signature-box { border: 1px solid #ccc; padding: 20px; margin-top: 20px; text-align: center; }
        .sig-image { max-width: 300px; max-height: 100px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Rental Agreement Addendum</h1>
        <p>This addendum modifies the original rental agreement below.</p>
      </div>
      
      <div class="section">
        <h3>Original Agreement Reference</h3>
        <div class="field-row">
          <div class="label">Agreement Number:</div>
          <div class="value">${addendum.rentalAgreement?.agreementNumber || '-'}</div>
        </div>
        <div class="field-row">
          <div class="label">Customer:</div>
          <div class="value">${addendum.rentalAgreement?.customerFirstName || ''} ${addendum.rentalAgreement?.customerLastName || ''}</div>
        </div>
      </div>
      
      <div class="section">
        <h3>Updated Rental Dates</h3>
        <div class="field-row">
          <div class="label">New Pickup Date/Time:</div>
          <div class="value">${formatDate(addendum.pickupAt)} ${new Date(addendum.pickupAt).toLocaleTimeString()}</div>
        </div>
        <div class="field-row">
          <div class="label">New Return Date/Time:</div>
          <div class="value">${formatDate(addendum.returnAt)} ${new Date(addendum.returnAt).toLocaleTimeString()}</div>
        </div>
      </div>
      
      <div class="section">
        <h3>Reason for Change</h3>
        <div class="field-row">
          <div class="value">${String(addendum.reason || '').trim()}</div>
        </div>
      </div>
      
      ${addendum.status === 'SIGNED' ? `
        <div class="signature-box">
          <h3>Customer Signature</h3>
          ${addendum.signatureDataUrl ? `<img src="${addendum.signatureDataUrl}" class="sig-image" alt="Signature">` : '<p>No signature on file</p>'}
          <p>Signed by: ${addendum.signatureSignedBy || '-'}</p>
          <p>Date: ${formatDate(addendum.signatureSignedAt)}</p>
        </div>
      ` : `
        <div class="signature-box">
          <p><strong>Pending Customer Signature</strong></p>
          <p>Status: ${addendum.status}</p>
        </div>
      `}
      
      <hr>
      <p style="font-size: 0.9em; color: #666;">
        Created: ${new Date(addendum.createdAt).toLocaleString()}
      </p>
    </body>
    </html>
  `;
  
  return html;
}
```

### 3.2 Reservations Service — Date Edit Gate

**File:** `backend/src/modules/reservations/reservations.service.js`

In the `update` method (which handles PATCH), add a gate BEFORE allowing date changes:

```javascript
async update(id, patch = {}, scope = {}, actorUserId = null) {
  // ... existing validation code ...
  
  // NEW: Gate for date edits post-signature
  if ((patch.pickupAt || patch.returnAt) && current.status !== 'DRAFT') {
    // Check if a PENDING_SIGNATURE addendum exists
    const pendingAddendum = await prisma.rentalAgreementAddendum.findFirst({
      where: {
        rentalAgreement: { reservationId: id },
        status: 'PENDING_SIGNATURE'
      }
    });
    
    if (pendingAddendum) {
      const err = new Error(
        'Cannot edit dates while a pending addendum signature exists. ' +
        'Please have the customer sign or void the pending addendum first.'
      );
      err.statusCode = 409;
      throw err;
    }
    
    // If reservation status is SIGNED or post-SIGNED, CREATE an addendum instead
    const agreement = await prisma.rentalAgreement.findFirst({
      where: { reservationId: id },
      orderBy: { createdAt: 'desc' }
    });
    
    if (agreement && agreement.status !== 'DRAFT') {
      // Throw a helpful error OR auto-create addendum (decision point).
      // Recommended: auto-create, then reject the direct edit.
      const err = new Error(
        'Date changes after agreement signature require an addendum. ' +
        'Contact support to initiate an addendum flow.'
      );
      err.statusCode = 409;
      throw err;
    }
  }
  
  // ... continue with existing update logic ...
}
```

### 3.3 Rental Agreements Routes — Addendum Endpoints

**File:** `backend/src/modules/rental-agreements/rental-agreements.routes.js`

Add new routes for addendum operations (add after existing signature/finalize routes):

```javascript
// List addendums for a rental agreement
rentalAgreementsRouter.get('/:id/addendums', async (req, res, next) => {
  try {
    await ensureAccessible(req.params.id, req.user);
    const addendums = await rentalAgreementsService.listAddendums(req.params.id, scopeFor(req));
    res.json(addendums);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// Get a single addendum
rentalAgreementsRouter.get('/:id/addendums/:addendumId', async (req, res, next) => {
  try {
    await ensureAccessible(req.params.id, req.user);
    const addendum = await rentalAgreementsService.getAddendumById(req.params.addendumId, scopeFor(req));
    if (!addendum) return res.status(404).json({ error: 'Addendum not found' });
    res.json(addendum);
  } catch (e) {
    next(e);
  }
});

// Create an addendum (admin-initiated)
rentalAgreementsRouter.post('/:id/addendums', async (req, res, next) => {
  try {
    const agreement = await ensureEditable(req.params.id, req.user);
    
    const newPickupAt = String(req.body?.newPickupAt || '').trim();
    const newReturnAt = String(req.body?.newReturnAt || '').trim();
    const reason = String(req.body?.reason || 'Date correction').trim();
    
    if (!newPickupAt || !newReturnAt) {
      return res.status(400).json({ error: 'newPickupAt and newReturnAt are required' });
    }
    
    const addendum = await rentalAgreementsService.createAddendum(
      req.params.id,
      {
        newPickupAt: new Date(newPickupAt),
        newReturnAt: new Date(newReturnAt),
        reason,
        reason_category: String(req.body?.reason_category || 'admin_correction').trim(),
        initiatedBy: req.user?.sub || null,
        initiatedByRole: String(req.user?.role || 'ADMIN').toUpperCase()
      }
    );
    
    // Fire-and-forget email to customer + admin team
    rentalAgreementsService.scheduleAddendumNotification(req.params.id, addendum.id, req.user?.tenantId || null)
      .catch(e => logger.error('Failed to send addendum notification:', e));
    
    res.status(201).json(addendum);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    if (/pending signature/i.test(e.message)) return res.status(409).json({ error: e.message });
    next(e);
  }
});

// Sign an addendum (via customer portal or web)
rentalAgreementsRouter.post('/:id/addendums/:addendumId/signature', async (req, res, next) => {
  try {
    const addendum = await rentalAgreementsService.getAddendumById(req.params.addendumId, scopeFor(req));
    if (!addendum) return res.status(404).json({ error: 'Addendum not found' });
    
    const signatureDataUrl = String(req.body?.signatureDataUrl || '').trim();
    if (!signatureDataUrl) {
      return res.status(400).json({ error: 'Signature is required' });
    }
    
    const signed = await rentalAgreementsService.signAddendum(
      req.params.addendumId,
      {
        signatureDataUrl,
        signatureSignedBy: req.body?.signatureSignedBy || req.user?.fullName || 'Unknown',
        ip: req.ip || null
      }
    );
    
    res.json(signed);
  } catch (e) {
    if (/not found|cannot sign/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// Void an addendum
rentalAgreementsRouter.post('/:id/addendums/:addendumId/void', async (req, res, next) => {
  try {
    await ensureEditable(req.params.id, req.user);
    const voided = await rentalAgreementsService.voidAddendum(
      req.params.addendumId,
      req.body?.reason || 'Cancelled by user',
      scopeFor(req)
    );
    res.json(voided);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// Render addendum as HTML
rentalAgreementsRouter.get('/:id/addendums/:addendumId/print', async (req, res, next) => {
  try {
    const addendum = await rentalAgreementsService.getAddendumById(req.params.addendumId, scopeFor(req));
    if (!addendum) return res.status(404).json({ error: 'Addendum not found' });
    
    const html = await rentalAgreementsService.renderAddendumHtml(req.params.addendumId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});
```

### 3.4 Email Notification

**File:** `backend/src/modules/rental-agreements/rental-agreements.service.js`

Add a helper for fire-and-forget email on addendum creation:

```javascript
async scheduleAddendumNotification(rentalAgreementId, addendumId, tenantId = null) {
  // Fetch agreement + addendum + customer details
  const agreement = await prisma.rentalAgreement.findUnique({
    where: { id: rentalAgreementId },
    include: {
      reservation: {
        select: {
          id: true,
          customerEmail: true,
          pickupAt: true,
          returnAt: true
        }
      }
    }
  });
  
  const addendum = await prisma.rentalAgreementAddendum.findUnique({
    where: { id: addendumId }
  });
  
  if (!agreement || !addendum) return;
  
  const customerEmail = String(agreement.reservation?.customerEmail || '').trim();
  if (!customerEmail) return;
  
  // Email to customer
  const formatDate = (d) => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  
  const subject = `Rental Agreement Addendum - ${agreement.agreementNumber}`;
  const body = `
Dear Customer,

Your rental dates have been modified. An addendum to your rental agreement has been created and requires your signature.

Original Dates: ${formatDate(agreement.reservation?.pickupAt)} - ${formatDate(agreement.reservation?.returnAt)}
New Dates: ${formatDate(addendum.pickupAt)} - ${formatDate(addendum.returnAt)}
Reason: ${addendum.reason}

Please sign the addendum here: [TODO: generate portal link with token]

If you did not authorize this change, please contact us immediately.

Best regards,
Ride Fleet Management
  `;
  
  try {
    await sendEmail({
      to: customerEmail,
      subject,
      html: body
    });
  } catch (e) {
    logger.error('Failed to send addendum notification:', e);
  }
}
```

### 3.5 Tenant Scoping

Every new service method uses `scope` parameter and filters by `tenantId` (matching existing patterns):
- `listAddendums(rentalAgreementId, scope)` — scope param ensures tenant isolation.
- `getAddendumById(addendumId, scope)` — scope param ensures tenant isolation.
- `voidAddendum(addendumId, reason, scope)` — scope param ensures tenant isolation.
- Routes always pass `scopeFor(req)` to service methods.

---

## 4. Frontend Changes

### 4.1 Agreement Detail Page — Display Addendums

**File:** `frontend/src/app/agreements/[id]/page.js`

After rendering the parent agreement details, add an "Addendums" section:

```javascript
// Fetch addendums alongside agreement
const [agreement, addendums] = await Promise.all([
  api(`/api/rental-agreements/${id}`),
  api(`/api/rental-agreements/${id}/addendums`)
]);

// In JSX, after parent agreement section:
{addendums && addendums.length > 0 && (
  <section className="addendums-section">
    <h3>Agreement Modifications (Addendums)</h3>
    <div className="addendums-list">
      {addendums.map((addendum) => (
        <div key={addendum.id} className="addendum-card">
          <div className="addendum-header">
            <h4>Addendum #{addendum.id.slice(0, 8)}</h4>
            <span className={`status status-${addendum.status.toLowerCase()}`}>
              {addendum.status}
            </span>
          </div>
          
          <div className="addendum-details">
            <div className="detail-row">
              <label>New Pickup Date:</label>
              <span>{formatDate(addendum.pickupAt)}</span>
            </div>
            <div className="detail-row">
              <label>New Return Date:</label>
              <span>{formatDate(addendum.returnAt)}</span>
            </div>
            <div className="detail-row">
              <label>Reason:</label>
              <span>{addendum.reason}</span>
            </div>
            <div className="detail-row">
              <label>Initiated By:</label>
              <span>{addendum.initiatedByRole} on {formatDate(addendum.createdAt)}</span>
            </div>
          </div>
          
          {addendum.status === 'PENDING_SIGNATURE' && (
            <div className="addendum-actions">
              <button onClick={() => navigateTo(`/customer/sign-agreement?token=${generateToken(addendum.id)}&type=addendum`)}>
                Sign Addendum
              </button>
              <button onClick={() => voidAddendum(addendum.id)} className="secondary">
                Reject / Void
              </button>
            </div>
          )}
          
          {addendum.status === 'SIGNED' && (
            <div className="addendum-signature">
              <p>Signed by {addendum.signatureSignedBy} on {formatDate(addendum.signatureSignedAt)}</p>
              {addendum.signatureDataUrl && (
                <img src={addendum.signatureDataUrl} alt="Signature" className="signature-preview" />
              )}
            </div>
          )}
          
          <div className="addendum-actions">
            <a href={`/api/rental-agreements/${agreement.id}/addendums/${addendum.id}/print`} target="_blank">
              View / Print Addendum
            </a>
          </div>
        </div>
      ))}
    </div>
  </section>
)}
```

**Styling (CSS):**
```css
.addendums-section {
  margin-top: 40px;
  padding-top: 20px;
  border-top: 1px solid #e0e0e0;
}

.addendum-card {
  border: 1px solid #d0d0d0;
  border-radius: 4px;
  padding: 16px;
  margin: 12px 0;
  background: #f9f9f9;
}

.addendum-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.status {
  padding: 4px 8px;
  border-radius: 3px;
  font-size: 0.85em;
  font-weight: bold;
}

.status-pending_signature {
  background: #fff3cd;
  color: #856404;
}

.status-signed {
  background: #d4edda;
  color: #155724;
}

.status-void {
  background: #f8d7da;
  color: #721c24;
}

.addendum-details {
  margin: 12px 0;
}

.detail-row {
  display: flex;
  margin: 8px 0;
}

.detail-row label {
  font-weight: bold;
  width: 150px;
}

.addendum-actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
}

.signature-preview {
  max-width: 300px;
  max-height: 100px;
  margin-top: 8px;
  border: 1px solid #ccc;
}
```

### 4.2 Customer Portal — Addendum Signature

**File:** `frontend/src/app/customer/sign-agreement/page.js`

Extend existing signature flow to handle `type=agreement | type=addendum`:

```javascript
// Extract query param
const searchParams = useSearchParams();
const type = searchParams.get('type') || 'agreement'; // 'agreement' | 'addendum'
const token = searchParams.get('token');

// Fetch correct entity
let entityId, entity;
if (type === 'addendum') {
  // Use token to resolve addendum ID (or pass directly if authenticated)
  const addendumId = await resolveAddendumFromToken(token);
  entity = await api(`/api/rental-agreements/{agreementId}/addendums/${addendumId}`);
} else {
  // Existing agreement flow
  entity = await fetchAgreement(token);
}

// Signature submission (same canvas + pad code)
const handleSignatureSubmit = async (signatureDataUrl) => {
  const endpoint = type === 'addendum'
    ? `/api/rental-agreements/${agreementId}/addendums/${entity.id}/signature`
    : `/api/rental-agreements/${agreementId}/signature`;
  
  await api(endpoint, {
    method: 'POST',
    body: JSON.stringify({
      signatureDataUrl,
      signatureSignedBy: fullName
    })
  });
  
  setSuccessMsg('Thank you! Your signature has been recorded.');
};
```

### 4.3 Admin Dashboard — Addendum Creation Form

**File:** (New optional feature) `frontend/src/app/agreements/[id]/create-addendum.jsx`

A modal/form for admins to create an addendum. Triggered from agreement detail page via "Create Addendum" button.

```javascript
export default function CreateAddendumModal({ agreementId, onSuccess }) {
  const [newPickupAt, setNewPickupAt] = useState('');
  const [newReturnAt, setNewReturnAt] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  
  const handleCreate = async () => {
    setLoading(true);
    try {
      await api(`/api/rental-agreements/${agreementId}/addendums`, {
        method: 'POST',
        body: JSON.stringify({
          newPickupAt,
          newReturnAt,
          reason
        })
      });
      onSuccess();
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <dialog open>
      <h2>Create Agreement Addendum</h2>
      <input type="datetime-local" value={newPickupAt} onChange={e => setNewPickupAt(e.target.value)} placeholder="New Pickup" />
      <input type="datetime-local" value={newReturnAt} onChange={e => setNewReturnAt(e.target.value)} placeholder="New Return" />
      <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for change" />
      <button onClick={handleCreate} disabled={loading}>Create Addendum</button>
    </dialog>
  );
}
```

---

## 5. Tests

### 5.1 Backend Unit Tests

**File:** `backend/src/modules/rental-agreements/rental-agreements-addendum.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert';
import { rentalAgreementsService } from './rental-agreements.service.js';
import { fakeTx } from '../../lib/prisma-test-helpers.js';

test('rentalAgreementsService.createAddendum creates with correct fields', async () => {
  const addendum = await rentalAgreementsService.createAddendum('agreement-123', {
    newPickupAt: new Date('2026-05-01T10:00Z'),
    newReturnAt: new Date('2026-05-05T10:00Z'),
    reason: 'Customer requested extension',
    reason_category: 'customer_request',
    initiatedBy: 'user-456',
    initiatedByRole: 'ADMIN'
  });
  
  assert.strictEqual(addendum.status, 'PENDING_SIGNATURE');
  assert.strictEqual(addendum.reason, 'Customer requested extension');
  assert.strictEqual(addendum.signatureSignedBy, null);
});

test('rentalAgreementsService.signAddendum updates status to SIGNED', async () => {
  const addendum = await rentalAgreementsService.createAddendum('agreement-123', {
    newPickupAt: new Date('2026-05-01T10:00Z'),
    newReturnAt: new Date('2026-05-05T10:00Z'),
    reason: 'Test'
  });
  
  const signed = await rentalAgreementsService.signAddendum(addendum.id, {
    signatureDataUrl: 'data:image/png;base64,...',
    signatureSignedBy: 'John Doe'
  });
  
  assert.strictEqual(signed.status, 'SIGNED');
  assert.strictEqual(signed.signatureSignedBy, 'John Doe');
  assert(signed.signatureSignedAt);
});

test('rentalAgreementsService.listAddendums returns multiple addendums', async () => {
  const a1 = await rentalAgreementsService.createAddendum('agreement-123', {
    newPickupAt: new Date('2026-05-01T10:00Z'),
    newReturnAt: new Date('2026-05-05T10:00Z'),
    reason: 'First'
  });
  
  const a2 = await rentalAgreementsService.createAddendum('agreement-123', {
    newPickupAt: new Date('2026-06-01T10:00Z'),
    newReturnAt: new Date('2026-06-05T10:00Z'),
    reason: 'Second'
  });
  
  const list = await rentalAgreementsService.listAddendums('agreement-123');
  assert.strictEqual(list.length, 2);
});

test('rentalAgreementsService.voidAddendum sets status to VOID', async () => {
  const addendum = await rentalAgreementsService.createAddendum('agreement-123', {
    newPickupAt: new Date('2026-05-01T10:00Z'),
    newReturnAt: new Date('2026-05-05T10:00Z'),
    reason: 'Test'
  });
  
  const voided = await rentalAgreementsService.voidAddendum(addendum.id);
  assert.strictEqual(voided.status, 'VOID');
});
```

### 5.2 Backend Integration Tests

**File:** `backend/src/modules/rental-agreements/rental-agreements-addendum-routes.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert';
import { request } from '../../lib/test-request.js';

test('POST /api/rental-agreements/:id/addendums creates addendum', async () => {
  const agreementId = 'agreement-123';
  const res = await request('POST', `/api/rental-agreements/${agreementId}/addendums`, {
    newPickupAt: '2026-05-01T10:00Z',
    newReturnAt: '2026-05-05T10:00Z',
    reason: 'Extension'
  }, { role: 'ADMIN' });
  
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.status, 'PENDING_SIGNATURE');
});

test('GET /api/rental-agreements/:id/addendums lists addendums', async () => {
  const res = await request('GET', `/api/rental-agreements/agreement-123/addendums`, null, { role: 'ADMIN' });
  assert.strictEqual(res.status, 200);
  assert(Array.isArray(res.body));
});

test('POST /api/rental-agreements/:id/addendums rejects if PENDING_SIGNATURE exists', async () => {
  // Create first addendum
  await request('POST', `/api/rental-agreements/agreement-123/addendums`, {
    newPickupAt: '2026-05-01T10:00Z',
    newReturnAt: '2026-05-05T10:00Z',
    reason: 'First'
  }, { role: 'ADMIN' });
  
  // Try to create second — should fail
  const res = await request('POST', `/api/rental-agreements/agreement-123/addendums`, {
    newPickupAt: '2026-06-01T10:00Z',
    newReturnAt: '2026-06-05T10:00Z',
    reason: 'Second'
  }, { role: 'ADMIN' });
  
  assert.strictEqual(res.status, 409);
});
```

### 5.3 Tenant Isolation Suite Case

**File:** `backend/scripts/tenant-tests/v8-addendum-isolation.mjs`

```javascript
import { spawnSync } from 'node:child_process';

const tests = [];

async function testAddendumIsolation() {
  const tenantA = tenants[0];
  const tenantB = tenants[1];
  
  // Create reservation + agreement in tenant A
  const resA = await api(`/api/reservations`, 'POST', {
    pickupAt: '2026-05-01T10:00Z',
    returnAt: '2026-05-05T10:00Z',
    // ... other fields ...
  }, tenantA.token);
  
  // Create addendum in tenant A
  const addendumRes = await api(`/api/rental-agreements/${resA.agreementId}/addendums`, 'POST', {
    newPickupAt: '2026-06-01T10:00Z',
    newReturnAt: '2026-06-05T10:00Z',
    reason: 'Extension'
  }, tenantA.token);
  
  const addendumId = addendumRes.id;
  
  // Tenant B tries to read tenant A's addendum (should fail or return 404)
  const unauthorizedRes = await api(`/api/rental-agreements/${resA.agreementId}/addendums/${addendumId}`, 'GET', null, tenantB.token);
  assert.strictEqual(unauthorizedRes.status, 404 || 403, 'Tenant B should not see Tenant A addendum');
  
  console.log('✓ Addendum isolation');
}

export default testAddendumIsolation;
```

Then register in `run-suite.mjs`:

```javascript
const files = [
  'v3-read-isolation.mjs',
  'v4-write-isolation.mjs',
  'v5-superadmin.mjs',
  'v6-lifecycle.mjs',
  'v7-website-fees.mjs',
  'v8-addendum-isolation.mjs'  // NEW
];
```

---

## 6. PR Breakdown

Ship as **ONE PR** (`feature/rental-agreement-addendum`):

1. **Commit 1:** Prisma migration + schema. Files: `backend/prisma/migrations/20260423_add_rental_agreement_addendum/migration.sql`, `backend/prisma/schema.prisma`.
2. **Commit 2:** Service methods (create, sign, list, render, email). File: `backend/src/modules/rental-agreements/rental-agreements.service.js` (~200 lines added).
3. **Commit 3:** Routes (CRUD + signature). File: `backend/src/modules/rental-agreements/rental-agreements.routes.js` (~100 lines added).
4. **Commit 4:** Reservation date edit gate. File: `backend/src/modules/reservations/reservations.service.js` (~30 lines added).
5. **Commit 5:** Unit + integration tests. Files: `backend/src/modules/rental-agreements/rental-agreements-addendum.test.mjs` (new), `backend/src/modules/rental-agreements/rental-agreements-addendum-routes.test.mjs` (new).
6. **Commit 6:** Tenant isolation suite case. Files: `backend/scripts/tenant-tests/v8-addendum-isolation.mjs` (new), `backend/scripts/tenant-tests/run-suite.mjs` (1-line edit).
7. **Commit 7:** Frontend agreement detail page. File: `frontend/src/app/agreements/[id]/page.js` (~100 lines modified).
8. **Commit 8:** Customer portal signature flow (parameterized). File: `frontend/src/app/customer/sign-agreement/page.js` (~50 lines modified).
9. **Commit 9 (optional):** Admin addendum creation form. File: `frontend/src/app/agreements/[id]/create-addendum.jsx` (new, optional for MVP).

---

## 7. Agent Delegation

| Agent | Task | Input | Dependencies | Notes |
|-------|------|-------|--------------|-------|
| **supabase-db-expert** | Review & execute Prisma migration | Migration SQL, current schema | None | Verify indexes, FK constraints, no downtime on production. |
| **senior-backend-developer** | Implement service methods + routes | Migration (from above), CLAUDE.md, tenancy rules, test examples | Migration done | Ensure every addendum query filters by `tenantId`. Follow `scopeFor()` pattern. Charge delta calculation may need reservationPricingService integration (placeholder in plan). |
| **senior-react-developer** | Implement frontend detail page + portal signature | Backend contract (addendum shape, endpoint responses), signature pad code (reuse existing) | Backend implementation complete | Reuse existing signature capture code from current `/customer/sign-agreement`. No new UI libraries. |
| **qa-engineer** | Tenant isolation suite case v8 + verification | Test examples, CI job details | Backend + frontend done | Verify v8 runs green. No tenant A data visible to tenant B. |
| **security-engineer** (async) | Review addendum routes for auth/injection gaps | Routes spec, CLAUDE.md security patterns | Route definitions | Single concern: are addendum queries properly scoped? Are email addresses safe? Are signature data URLs validated? |
| **general-purpose × 2** (parallel review) | Architecture review (tenant isolation, race conditions, charge calc) | Full PR diff, feature brief, plan excerpt | All implementation complete | Look for: tenant scope leaks, per-worker cache issues (unlikely), concurrent addendum creation edge case, charge recalculation correctness. |
| **general-purpose × 2** (parallel review) | QA audit (test coverage, edge cases, repo patterns) | Full PR diff, test files, CLAUDE.md | All implementation complete | Look for: PENDING_SIGNATURE gate tested? Can customer void their own addendum? Are addendum timestamps consistent? Does CI pass? |

---

## 8. Acceptance Criteria

- [ ] Prisma migration executes cleanly on local + staging DB; no rollback needed.
- [ ] `RentalAgreementAddendum` table exists with all fields + indexes.
- [ ] `RentalAgreement` model has `addendums` relation field.
- [ ] Service methods: `createAddendum`, `signAddendum`, `listAddendums`, `getAddendumById`, `voidAddendum`, `renderAddendumHtml` all exist and pass unit tests.
- [ ] Routes: POST /addendums, GET /addendums, GET /addendums/:id, POST /addendums/:id/signature, POST /addendums/:id/void, GET /addendums/:id/print all mounted and functional.
- [ ] Gate in `reservations.service.js` prevents date edit if `PENDING_SIGNATURE` addendum exists (409 response).
- [ ] Gate in `reservations.service.js` detects post-signature date edit and throws helpful error (409 response).
- [ ] Email notification fires on addendum creation (to customer + admin team).
- [ ] Frontend agreement detail page displays addendums chronologically below parent agreement.
- [ ] Frontend addendum card shows pickup/return dates, reason, status, signature (if signed).
- [ ] Customer portal `/customer/sign-agreement?type=addendum&token=...` successfully signs addendum.
- [ ] Addendum can be voided by admin.
- [ ] Unit tests: addendum create/sign/list/void logic + edge cases.
- [ ] Integration tests: POST + GET routes return correct status codes + data.
- [ ] Tenant isolation test v8: tenant A's addendum not visible to tenant B.
- [ ] `npm test` passes locally (backend + frontend).
- [ ] `npm run verify` passes locally.
- [ ] CI job `tenant-isolation-suite` passes (now includes v8).
- [ ] Sentry logs clean (no new errors from addendum code).

---

## 9. Rollout

### 9.1 Development & Testing

1. Create branch `feature/rental-agreement-addendum` off current `develop`.
2. Implement commits 1–9 per section 6.
3. Local verify: `cd backend && npm test && npm run prisma:generate` → all green.
4. Docker sandbox: `docker compose up --build && npm run seed:bootstrap`.
5. Manual test: Create reservation → sign agreement → edit dates in admin → verify addendum gate (409) + addendum creation flow.
6. Manual test: Customer signs addendum via portal → verify signature recorded.

### 9.2 Code Review & Hardening

1. **Independent review (step 4):** Two `general-purpose` agents in parallel. Output: GREEN / YELLOW / RED + questions.
2. **Synthesize (step 5):** Address blockers in follow-up commit if any.
3. **Final verify (step 6):** Re-run tests after hardening. All files green.

### 9.3 Commit & Handoff (step 7)

1. `git add backend/prisma/migrations/...` (file-by-file, never `-A`)
2. `git add backend/src/modules/rental-agreements/...` ... etc.
3. `git commit -m "Add rental agreement addendum flow (feature/rental-agreement-addendum)..."` with co-authors.
4. `git push origin feature/rental-agreement-addendum`.
5. Hand off to Hector for local validation (step 8).

### 9.4 Local Validation by Hector (step 8)

On Windows + PowerShell:
```powershell
git checkout feature/rental-agreement-addendum
cd backend
npm install
npm run prisma:generate
npm test
```

Manual repro:
1. Spin up `docker compose up` locally.
2. Create a reservation, sign agreement via customer portal.
3. Try to edit dates in admin → should get 409 "requires addendum".
4. Navigate to admin tool to create addendum → specify new dates + reason.
5. Verify customer receives email with link to sign addendum.
6. Sign addendum as customer → verify signature recorded.
7. Refresh agreement detail page → verify addendum appears below parent.
8. Void addendum as admin → verify status changes to VOID.

### 9.5 Staging Deploy (step 9)

Tag: `v0.9.0-beta.5` (or next available).

```powershell
cd RideFleetManagement-working-clean
powershell -ExecutionPolicy Bypass -File .\ops\deploy-beta.ps1 -Tag v0.9.0-beta.5
```

Watch Sentry 24h:
- No new errors from `rental-agreements`, `reservations`, or addendum routes.
- Customer signature flow latency ≤ prev baseline (no regression).
- Email delivery success rate ≥ 95%.

### 9.6 Production Deploy (step 10)

Only after 24h soak on staging + Hector sign-off. Deploy during off-hours (per auto-memory).

```powershell
ops/deploy-beta.ps1 -Tag v0.9.0-beta.5
```

Feature is **OFF by default** (only applies when admins or customers initiate date edits post-signature). Gradual, safe rollout.

---

## 10. Out of Scope

- **Customer self-service addendum requests:** Deferred to Phase 2. MVP: admin-initiated only. Customers can only sign (via portal) or reject (void).
- **SUPER_ADMIN silent edit bypass:** Deferred. All date edits (even admin) go through addendum flow.
- **Addendum approval workflow:** Addendums auto-SIGNED when customer signs; no separate approval step.
- **Recurring addendums:** No "extend by X more days" shortcut. Each extension is a new, separate addendum.
- **Addendum for non-date changes:** MVP focuses on date corrections only. Other agreement modifications (charges, customers, drivers) remain manual edits (no addendum required).
- **Bulk addendum creation:** No batch create operation. One addendum per admin action.
- **Addendum PDF generation via Puppeteer:** MVP renders HTML only. PDF generation deferred to Phase 2 (use existing Puppeteer pipeline if needed).
- **Mobile app updates:** Frontend changes are web-only for MVP. Mobile inherits via responsive design.
- **Scheduled addendum expirations:** No auto-void after X days. Addendums remain in PENDING_SIGNATURE until explicitly signed or voided.

---

## 11. Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|-----------|
| Tenant scope leak: Tenant A's addendum visible to Tenant B | Low | High | Tenant isolation suite test case (v8). Code review by security-engineer. Explicit `tenantId` filter in all queries. Fail-closed: `scopeFor(req)` returns sentinel if tenant unknown. |
| Race condition: Admin creates addendum while customer editing reservation | Medium | Medium | Reservation edit gate checks for PENDING_SIGNATURE addendum atomically (single DB query). If collision occurs, customer gets 409; can retry after addendum is voided/signed. |
| Charge calculation incorrect: New charges don't match actual pricing | Medium | High | Charge delta calculation must use same logic as `reservationPricingService`. Unit tests verify charge delta shape. Manual repro tests pricing correctness. |
| Customer misses email: Addendum notification doesn't arrive | Low | Medium | Fire-and-forget email with retry via existing mailer (inherited from rental-agreements module). Addendum link also available in admin dashboard for manual resend. |
| Signature pad incompatibility: Existing pad doesn't work with `type=addendum` param | Low | Medium | Reuse existing signature capture code without modification. Parameterize only the endpoint URL (`/agreement/signature` vs `/addendum/:id/signature`). Test both flows in dev. |
| Performance: New addendum queries + renders slow down agreement detail pages | Very Low | Low | Addendum list query uses index on `(tenantId, createdAt)`. Typical rental agreement has ≤ 3 addendums. Lazy-load if concern arises. |
| Backward compat: Existing integrations break | Very Low | Low | No changes to `RentalAgreement` table. New table is additive. Existing GET /api/rental-agreements/:id returns same shape. No API breaking changes. |

---

## 12. Success Metrics

1. **Feature adoption:** Within 2 weeks, ≥10 addendums created across test tenants (manual validation).
2. **Legal compliance:** No more "signed agreement shows wrong dates" bugs filed (zero regression).
3. **Customer satisfaction:** Addendum email sent + customer successfully signs addendum (100% happy path).
4. **Tenant isolation:** Suite v8 passes on every CI run; no tenant sees another's addendums.
5. **Performance:** Addendum routes (POST, GET, signature) response time ≤ 500ms (no regression from baseline).
6. **Zero data loss:** All signed addendums persisted; signature images retrievable.

---

## 13. Timeline

- **Planning:** 2026-04-23 (this document).
- **Implementation:** 2026-04-24 through 2026-04-30 (4–6 days, parallelized).
- **Review:** 2026-05-01 (1 day).
- **Local validation:** 2026-05-02 (Hector's Windows machine).
- **Staging deploy:** 2026-05-03 (24h soak).
- **Production deploy:** 2026-05-04 (off-hours, after soak passes).

**Rationale:** Moderate complexity, high compliance value, no architectural risk. Parallelizable backend + frontend work.

---

## 14. Rollback Plan

If production issues occur:

1. **Immediate:** Revert via `ops/rollback-beta.ps1` to previous tag (e.g., `v0.9.0-beta.4`). Addendum feature disappears; date edit gate goes away; customers can edit freely again (as before).
2. **Diagnosis:** Check Sentry for errors in `rental-agreements`, `reservations` routes. Inspect database for orphaned addendum rows (unlikely).
3. **Fix:** Return to local dev, fix issue, re-implement in new PR, re-deploy under new tag.

**Expected RTO:** <30 min (revert is a tag change + `deploy-beta.ps1` call).

---

## 15. Decisions (Locked 2026-04-23 by Hector)

All 10 open questions were resolved in one review. Decisions below are binding for MVP implementation; anything marked "Phase 2" is an explicit roadmap item, not a deferred question.

1. **Customer self-service addendum requests — DECIDED:** Admin-initiated only for MVP. Customer self-service from their user profile is Phase 2.

2. **Electronic signature stack — DECIDED:** Reuse existing agreement signature flow. New addendum signing goes through `customer/sign-agreement/page.js` with a `type=addendum` parameter.

3. **Charge recalculation timing — DECIDED:** Recalculate at addendum creation time. Store in `newCharges` snapshot on the addendum row for audit trail.

4. **Approval workflow — DECIDED:** Customer signature = automatic acceptance (auto-transition to SIGNED). No separate admin approval step.

5. **SUPER_ADMIN silent override — DECIDED:** Deferred to Phase 2. For MVP, ALL date edits (including admin-initiated) go through addendum flow. No silent-edit escape hatch.

6. **Reason categories — DECIDED:** Enum starts with `['admin_correction', 'customer_request', 'system', 'extension']`. Free-form reason text field alongside the optional category enum.

7. **Email template — DECIDED:** HTML email with embedded "Sign Addendum" link, matching the pattern of the current agreement signature emails.

8. **Duplicate/same-date addendums — DECIDED:** System does NOT prevent duplicates. Admin can retry with same dates after a void.

9. **Addendum scope — DECIDED:** MVP covers DATE CHANGES ONLY. Charge modifications, location changes, vehicle swaps, and other field edits are Phase 2.

10. **Addendum reminder emails — DECIDED:** Deferred to Phase 2. MVP sends ONE email at creation; customer must check portal/email manually thereafter.

---

## 16. Appendix — File Manifest

**New files:**
- `backend/prisma/migrations/20260423_add_rental_agreement_addendum/migration.sql` (~50 lines)
- `backend/src/modules/rental-agreements/rental-agreements-addendum.test.mjs` (~100 lines)
- `backend/src/modules/rental-agreements/rental-agreements-addendum-routes.test.mjs` (~80 lines)
- `backend/scripts/tenant-tests/v8-addendum-isolation.mjs` (~60 lines)
- `frontend/src/app/agreements/[id]/create-addendum.jsx` (optional, ~80 lines)

**Modified files:**
- `backend/prisma/schema.prisma` (+50 lines: addendum model + relation)
- `backend/src/modules/rental-agreements/rental-agreements.service.js` (+250 lines: service methods + email helper)
- `backend/src/modules/rental-agreements/rental-agreements.routes.js` (+120 lines: addendum routes)
- `backend/src/modules/reservations/reservations.service.js` (+35 lines: date edit gate)
- `backend/scripts/tenant-tests/run-suite.mjs` (+1 line: register v8)
- `frontend/src/app/agreements/[id]/page.js` (+150 lines: addendum display section + CSS)
- `frontend/src/app/customer/sign-agreement/page.js` (+60 lines: parameterized signature flow for type=addendum)

**Total new lines of code:** ~1,100 (backend ~500, frontend ~300, tests ~300)

---

**End of Plan.**
