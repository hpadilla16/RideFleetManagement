# Website-Only Mandatory Fees Implementation Plan

**Date:** 2026-04-21  
**Owner:** solution-architect  
**Status:** Ready for implementation (Step 1 of 10-step workflow)  
**Feature flag:** None (per-fee opt-in via `displayOnline` boolean)

---

## 1. Summary

**Problem:** Tenants need to expose **mandatory fees only** on the public booking website (customer-facing checkout). Today, the `Fee` model lacks a way to control which fees appear on the website. Non-mandatory fees with optional upsells should NOT appear online (that scope is deferred). Staff-facing flows (rental agreements, employee portal) remain unchanged.

**Solution:** Extend the `Fee` model with a boolean column `displayOnline` (defaults `false` for backward compatibility). At public checkout (`POST /api/public/checkout`), the backend automatically fetches tenant-scoped mandatory fees where `displayOnline=true`, applies them to the reservation total, and returns them as read-only line items to the frontend. The frontend renders them in the price breakdown (non-removable) but allows the customer to see what's included. Tenant settings UI gains a toggle to enable/disable online display per fee.

**Scope boundary:**
- ✅ Extend `Fee` model with `displayOnline` column.
- ✅ Update `fees.service.js` to include/persist `displayOnline`.
- ✅ Add a new public endpoint to fetch tenant-scoped website fees OR extend bootstrap endpoint.
- ✅ Integrate website fees into public checkout total calculation.
- ✅ Tenant settings UI: add toggle column for `displayOnline` in fees table.
- ✅ Frontend booking page: fetch + render website mandatory fees in price breakdown.
- ✅ Add unit tests (service + endpoint) + tenant-isolation suite case.
- ❌ Do NOT implement optional upsells (non-mandatory fees on website).
- ❌ Do NOT refactor the monolithic `frontend/src/app/book/page.js` (just add the mandatory fees display).
- ❌ Do NOT add mobile-specific UI changes (Capacitor shell will inherit from web).

**Out-of-band note:** This ships ahead of Wave 3 (competitive differentiation) in the 90-day production-readiness plan. It's a quick tenant-requested feature with minimal risk and high immediate value. Deploy during off-hours to avoid interrupting staff.

---

## 2. Schema Change

### 2.1 Prisma Migration

**File:** `backend/prisma/migrations/20260421_add_display_online_to_fee/migration.sql`

```sql
-- Add displayOnline column to Fee model
ALTER TABLE "Fee" ADD COLUMN "displayOnline" BOOLEAN NOT NULL DEFAULT false;

-- Index for public checkout queries: fetch active, mandatory, online fees for a tenant
CREATE INDEX "Fee_tenantId_isActive_mandatory_displayOnline_idx" ON "Fee"("tenantId", "isActive", "mandatory", "displayOnline") WHERE ("isActive" = true AND "mandatory" = true AND "displayOnline" = true);
```

### 2.2 Prisma Schema Update

**File:** `backend/prisma/schema.prisma` (lines 1799–1822)

```prisma
model Fee {
  id          String   @id @default(cuid())
  tenantId    String?
  tenant      Tenant?  @relation(fields: [tenantId], references: [id])
  code        String?
  name        String
  description String?
  mode        FeeMode
  amount      Decimal  @default(0) @db.Decimal(10, 2)
  taxable       Boolean  @default(false)
  isActive      Boolean  @default(true)
  mandatory     Boolean  @default(false)
  isUnderageFee       Boolean  @default(false)
  isAdditionalDriverFee Boolean  @default(false)
  displayOnline Boolean  @default(false)  // NEW: controls visibility on public website
  createdAt     DateTime @default(now())
  updatedAt   DateTime @updatedAt

  locationFees LocationFee[]
  linkedServices AdditionalService[] @relation("AdditionalServiceLinkedFee")

  @@index([isActive, name])
  @@unique([tenantId, code])
  @@index([tenantId, isActive])
  @@index([tenantId, isActive, mandatory, displayOnline])  // NEW: optimized for website fees fetch
}
```

### 2.3 Backward Compatibility

- Existing rows default to `displayOnline=false`, so no fees will appear on the website until tenants explicitly enable them.
- No data migration needed; the column is boolean with a safe default.
- Non-breaking: existing API calls to `POST /api/fees` and `PATCH /api/fees/:id` ignore `displayOnline` if not provided (Prisma skips undefined fields).

---

## 3. Backend Changes

### 3.1 Fees Service (`backend/src/modules/fees/fees.service.js`)

**Changes:** Include `displayOnline` in create/update/list operations.

**Lines ~10–25 (create method):**
```javascript
create(data, scope = {}) {
  return prisma.fee.create({
    data: {
      tenantId: scope?.tenantId || data.tenantId || null,
      code: data.code ?? null,
      name: data.name,
      description: data.description ?? null,
      mode: data.mode,
      amount: data.amount ?? 0,
      taxable: data.taxable ?? false,
      isActive: data.isActive ?? true,
      mandatory: data.mandatory ?? false,
      isUnderageFee: data.isUnderageFee ?? false,
      isAdditionalDriverFee: data.isAdditionalDriverFee ?? false,
      displayOnline: data.displayOnline ?? false  // NEW
    }
  });
}
```

**Lines ~27–33 (update method):**
No changes needed — the existing code already passes through all patch fields except `tenantId`. `displayOnline` will be forwarded to Prisma if present in the patch.

**No changes to `list()` or `getById()` — they already return all fields.**

### 3.2 Public Booking Endpoint: Website Fees

**File:** `backend/src/modules/public-booking/public-booking.service.js`

Add a new service method to fetch tenant-scoped website fees (to be called during checkout):

```javascript
async getWebsiteMandatoryFees({ tenantId, tenantSlug }) {
  // Resolve tenant from ID or slug (same pattern as resolvePublicCarSharingTenant)
  const scopedTenantId = tenantId ? String(tenantId).trim() : '';
  const scopedTenantSlug = tenantSlug ? String(tenantSlug).trim().toLowerCase() : '';
  if (!scopedTenantId && !scopedTenantSlug) throw new Error('tenantSlug or tenantId is required');

  const tenant = await prisma.tenant.findFirst({
    where: {
      status: 'ACTIVE',
      ...(scopedTenantId ? { id: scopedTenantId } : {}),
      ...(scopedTenantSlug ? { slug: scopedTenantSlug } : {})
    },
    select: { id: true }
  });

  if (!tenant) throw new Error('Tenant not found');

  // Fetch only mandatory, active, displayOnline=true fees
  const fees = await prisma.fee.findMany({
    where: {
      tenantId: tenant.id,
      isActive: true,
      mandatory: true,
      displayOnline: true  // NEW: only return online fees
    },
    orderBy: { createdAt: 'asc' }
  });

  return { tenantId: tenant.id, fees };
}
```

**File:** `backend/src/modules/public-booking/public-booking.routes.js`

Add a new GET endpoint (or extend the existing `/bootstrap` if that's the norm — check with Hector). Proposed: new endpoint at line ~48:

```javascript
publicBookingRouter.get('/website-fees', bookingReadGuard, async (req, res, next) => {
  try {
    const payload = await publicBookingService.getWebsiteMandatoryFees({
      tenantId: optionalString(req.query?.tenantId, { fallback: undefined }),
      tenantSlug: optionalString(req.query?.tenantSlug, { fallback: undefined })
    });
    res.json(payload);
  } catch (error) {
    if (/required|not found/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});
```

**Response shape:**
```json
{
  "tenantId": "tenant-123",
  "fees": [
    {
      "id": "fee-456",
      "code": "WEBSITE_FEE",
      "name": "Website Booking Fee",
      "description": "Mandatory online booking processing fee",
      "mode": "FIXED",
      "amount": "5.00",
      "taxable": false,
      "mandatory": true,
      "displayOnline": true
    }
  ]
}
```

### 3.3 Public Checkout Integration

**File:** `backend/src/modules/public-booking/public-booking.service.js` (existing `createBooking` method)

In the `createBooking` method (around line ~200–300, find where the reservation total is computed), **after resolving the tenant**, fetch website mandatory fees and **include them in the total**. Pseudo-code:

```javascript
async createBooking(payload = {}) {
  // ... existing validation ...

  const tenant = await resolveTenantFromPayload(payload);
  const reservation = await createReservationFromPayload(tenant.id, payload);

  // NEW: Fetch website mandatory fees for this tenant
  const { fees: websiteFees } = await this.getWebsiteMandatoryFees({ tenantId: tenant.id });

  // Compute total: base + website fees
  let total = reservation.baseTotal || 0;
  let websiteFeesTotal = 0;
  for (const fee of websiteFees) {
    const lineTotal = computeFeeTotal(fee, { baseAmount: total, days: reservation.days || 1 });
    websiteFeesTotal += lineTotal;
  }
  total += websiteFeesTotal;

  // Return to frontend
  return {
    reservation: { ...reservation, total, websiteFeesTotal },
    websiteFees: websiteFees.map((f) => ({
      ...f,
      lineTotal: computeFeeTotal(f, { baseAmount: reservation.baseTotal, days: reservation.days || 1 })
    }))
  };
}
```

**Helper function** (if not already present in `reservation-pricing.service.js`):

```javascript
function computeFeeTotal(fee, { baseAmount = 0, days = 1 } = {}) {
  const amount = Number(fee?.amount || 0);
  const mode = String(fee?.mode || 'FIXED').toUpperCase();
  if (mode === 'PERCENTAGE') return Number((baseAmount * (amount / 100)).toFixed(2));
  if (mode === 'PER_DAY') return Number((amount * Math.max(1, Number(days || 1))).toFixed(2));
  return Number(amount.toFixed(2));
}
```

This logic mirrors what `reservation-pricing.service.js` and `rental-agreements.service.js` already do for mandatory location fees.

### 3.4 Tenant Scoping (Critical for Multi-Tenancy)

The `getWebsiteMandatoryFees` method **already handles tenant scoping** correctly:
1. It resolves the tenant from `tenantId` or `tenantSlug`.
2. It filters fees by `tenantId = tenant.id` (fail-closed: returns empty if tenant not found).
3. It is called from a **public** endpoint (no JWT required), so it cannot use `scopeFor(req)`.
4. The tenant is resolved from query parameters, which is the existing pattern for `/api/public/*` endpoints (see `publicBookingRouter.get('/vehicle-classes', ...)`).

**Tenant Isolation Guarantee:** A request with `?tenantSlug=tenant-a` will ONLY see tenant-a's website fees, never tenant-b's.

---

## 4. Frontend Changes

### 4.1 Settings Page: Fees Toggle

**File:** `frontend/src/app/settings/page.js` (around line ~2428–2465, existing fees section)

Add a new column to the fees table: `displayOnline` toggle. Replace the existing fee row rendering:

**Current (lines ~2458–2465):**
```jsx
{fees.map((f) => (
  <tr key={f.id}>
    <td>{f.code || '-'}</td>
    <td>{f.name}</td>
    <td>{fmtMoney(f.amount)}</td>
    <td>{f.taxable ? 'Yes' : 'No'}</td>
    <td>
      <button onClick={async () => { await api(...); }}>{f.mandatory ? 'Unset Mandatory' : 'Set Mandatory'}</button>
      {/* ... more buttons ... */}
    </td>
  </tr>
))}
```

**Updated:**
```jsx
{fees.map((f) => (
  <tr key={f.id}>
    <td>{f.code || '-'}</td>
    <td>{f.name}</td>
    <td>{fmtMoney(f.amount)}</td>
    <td>{f.taxable ? 'Yes' : 'No'}</td>
    <td>{f.mandatory ? 'Yes' : 'No'}</td>
    <td>{f.displayOnline ? 'Yes' : 'No'}</td>
    <td>
      <button 
        onClick={async () => { 
          await api(scopedSettingsPath(`/api/fees/${f.id}`), { 
            method: 'PATCH', 
            body: JSON.stringify({ displayOnline: !f.displayOnline }) 
          }, token); 
          setMsg('Website display updated'); 
          await load(true); 
        }}
      >
        {f.displayOnline ? 'Hide from Website' : 'Show on Website'}
      </button>
    </td>
  </tr>
))}
```

Also, update the table header (around line ~2449):
```jsx
<thead>
  <tr>
    <th>Code</th>
    <th>Name</th>
    <th>Amount</th>
    <th>Taxable</th>
    <th>Mandatory</th>
    <th>Display Online</th>  // NEW
    <th>Actions</th>
  </tr>
</thead>
```

Update `EMPTY_FEE` constant in `settings-constants.js` to include `displayOnline`:

**File:** `frontend/src/app/settings/settings-constants.js` (line ~286)

```javascript
export const EMPTY_FEE = { 
  code: '', 
  name: '', 
  description: '', 
  mode: 'FIXED', 
  amount: '', 
  taxable: false, 
  isActive: true, 
  mandatory: false, 
  isUnderageFee: false, 
  isAdditionalDriverFee: false,
  displayOnline: false  // NEW
};
```

### 4.2 Booking Page: Website Fees Display

**File:** `frontend/src/app/book/page.js` (monolithic, ~1819 lines; no refactor — scoped addition only)

This is the customer-facing public booking flow. It already has a price breakdown section. Add website mandatory fees to the breakdown.

**Scope:** Find the section where the reservation total is displayed (price summary/breakdown). Likely around lines where `BASE_TOTAL`, `SERVICES_TOTAL`, `TAX`, etc. are rendered. The frontend needs to:

1. Fetch website fees when the booking form is initialized (after tenant is resolved).
2. Include website fees in the displayed total.
3. Render website fees as a read-only, non-removable line item in the price breakdown.

**Implementation sketch (find the exact line numbers during implementation):**

At page initialization or when the user selects a location/vehicle (when tenant becomes known):

```javascript
async function fetchWebsiteFees(tenantSlug) {
  const res = await api(`/api/public/booking/website-fees?tenantSlug=${encodeURIComponent(tenantSlug)}`);
  return res.fees || [];
}

// In the price breakdown JSX:
const websiteFees = await fetchWebsiteFees(selectedTenant.slug);
const websiteFeesTotal = websiteFees.reduce((sum, f) => sum + computeFeeLineTotal(f, { baseAmount, days }), 0);
const grandTotal = baseTotal + servicesTotal + websiteFeesTotal + tax;

// Render:
<section className="price-breakdown">
  <div>Base rental: {fmtMoney(baseTotal)}</div>
  {servicesTotal > 0 && <div>Services: {fmtMoney(servicesTotal)}</div>}
  {websiteFeesTotal > 0 && (
    <>
      <div className="website-fees-section">
        <strong>Mandatory Website Fees:</strong>
        {websiteFees.map((f) => (
          <div key={f.id} className="fee-line">
            <span>{f.name}</span>
            <span className="no-remove">{fmtMoney(computeFeeLineTotal(f, { baseAmount, days }))}</span>
          </div>
        ))}
        <div className="fee-subtotal">Website Fees Total: {fmtMoney(websiteFeesTotal)}</div>
      </div>
    </>
  )}
  <div>Tax: {fmtMoney(tax)}</div>
  <div className="grand-total">Total: {fmtMoney(grandTotal)}</div>
</section>
```

**Key styling:** Make it clear these are non-removable by using visual cues (lock icon, no delete button, gray background, or similar).

**Submission:** When the user clicks "Confirm Booking", the `POST /api/public/checkout` payload should include a breakdown of website fees applied, so the backend can verify them. Payload addition:

```javascript
const checkoutPayload = {
  // ... existing fields ...
  websiteFeesApplied: websiteFees.map((f) => ({
    feeId: f.id,
    amount: computeFeeLineTotal(f, { baseAmount, days })
  }))
};
```

---

## 5. Tests

### 5.1 Backend Unit Tests

**File:** `backend/src/modules/fees/fees.test.mjs` (new or extend existing if present)

```javascript
import { test } from 'node:test';
import assert from 'node:assert';
import { feesService } from './fees.service.js';

test('feesService.create includes displayOnline field', async () => {
  const fee = await feesService.create(
    { name: 'Test Fee', mode: 'FIXED', amount: 10, displayOnline: true },
    { tenantId: 'tenant-123' }
  );
  assert.strictEqual(fee.displayOnline, true);
});

test('feesService.create defaults displayOnline to false', async () => {
  const fee = await feesService.create(
    { name: 'Test Fee', mode: 'FIXED', amount: 10 },
    { tenantId: 'tenant-123' }
  );
  assert.strictEqual(fee.displayOnline, false);
});

test('feesService.update can set displayOnline', async () => {
  const original = await feesService.create(
    { name: 'Test Fee', mode: 'FIXED', amount: 10, displayOnline: false },
    { tenantId: 'tenant-123' }
  );
  const updated = await feesService.update(original.id, { displayOnline: true }, { tenantId: 'tenant-123' });
  assert.strictEqual(updated.displayOnline, true);
});
```

### 5.2 Backend Integration Test (Public Endpoint)

**File:** `backend/src/modules/public-booking/public-booking.test.mjs` (add to existing or new)

```javascript
test('publicBookingService.getWebsiteMandatoryFees returns only displayOnline fees', async () => {
  // Create test tenant
  const tenant = await prisma.tenant.create({ data: { name: 'Test', slug: 'test-tenant' } });

  // Create fees: one with displayOnline=true, one with displayOnline=false
  await prisma.fee.create({
    data: {
      tenantId: tenant.id,
      name: 'Website Fee',
      mode: 'FIXED',
      amount: 5,
      mandatory: true,
      displayOnline: true
    }
  });

  await prisma.fee.create({
    data: {
      tenantId: tenant.id,
      name: 'Hidden Fee',
      mode: 'FIXED',
      amount: 3,
      mandatory: true,
      displayOnline: false
    }
  });

  const result = await publicBookingService.getWebsiteMandatoryFees({ tenantId: tenant.id });
  
  assert.strictEqual(result.fees.length, 1);
  assert.strictEqual(result.fees[0].name, 'Website Fee');
  assert.strictEqual(result.fees[0].displayOnline, true);
});

test('getWebsiteMandatoryFees respects tenant isolation', async () => {
  const tenantA = await prisma.tenant.create({ data: { name: 'A', slug: 'a' } });
  const tenantB = await prisma.tenant.create({ data: { name: 'B', slug: 'b' } });

  await prisma.fee.create({
    data: {
      tenantId: tenantA.id,
      name: 'Fee A',
      mode: 'FIXED',
      amount: 5,
      mandatory: true,
      displayOnline: true
    }
  });

  const result = await publicBookingService.getWebsiteMandatoryFees({ tenantId: tenantB.id });
  assert.strictEqual(result.fees.length, 0, 'Tenant B should not see Tenant A fees');
});
```

### 5.3 Frontend Component Test

**File:** `frontend/test/website-mandatory-fees.test.jsx` (new)

```javascript
import { render, screen } from '@testing-library/react';
import { test } from 'vitest';
import BookingPage from '../src/app/book/page';

test('renders website mandatory fees in price breakdown', async () => {
  // Mock the API call to return website fees
  global.fetch = vi.fn(() =>
    Promise.resolve({
      json: () => Promise.resolve({
        fees: [
          {
            id: 'fee-1',
            name: 'Processing Fee',
            mode: 'FIXED',
            amount: 5.00
          }
        ]
      })
    })
  );

  render(<BookingPage />);
  
  // Wait for the fee to be rendered
  const feeElement = await screen.findByText('Processing Fee');
  expect(feeElement).toBeInTheDocument();
  expect(screen.getByText('$5.00')).toBeInTheDocument();
});

test('website fees are not removable (no delete button)', async () => {
  // Same mock as above
  render(<BookingPage />);
  
  const feeElement = await screen.findByText('Processing Fee');
  const parentRow = feeElement.closest('.fee-line');
  
  expect(parentRow.querySelector('button[data-action="remove"]')).toBeNull();
});
```

### 5.4 Tenant Isolation Suite Addition

**File:** `backend/scripts/tenant-tests/run-suite.mjs`

Add a test case within the existing suite to verify website fees don't leak between tenants:

```javascript
// New test case in the suite
async function testWebsiteFeesIsolation() {
  const tenantA = tenants[0]; // First seeded tenant
  const tenantB = tenants[1]; // Second seeded tenant

  // Create a website fee for tenant A only
  await apiCall(`/api/fees`, 'POST', {
    name: 'Website Fee A',
    mode: 'FIXED',
    amount: 5,
    mandatory: true,
    displayOnline: true
  }, tenantA.token);

  // Fetch website fees as tenant B (unauthenticated public call with tenantSlug)
  const resB = await apiCall(`/api/public/booking/website-fees?tenantSlug=${tenantB.slug}`, 'GET', null, null);
  
  assert.strictEqual(resB.fees.length, 0, 'Tenant B should see 0 website fees');
  
  // Fetch as tenant A
  const resA = await apiCall(`/api/public/booking/website-fees?tenantSlug=${tenantA.slug}`, 'GET', null, null);
  assert.strictEqual(resA.fees.length, 1, 'Tenant A should see 1 website fee');
  assert.strictEqual(resA.fees[0].name, 'Website Fee A');

  console.log('✓ Website fees isolation');
}

// Add to suite run queue
await testWebsiteFeesIsolation();
```

---

## 6. PR Breakdown

This feature ships as **one PR** (`feature/website-mandatory-fees`):

1. **Commit 1:** Prisma migration + schema.prisma update. File: `backend/prisma/migrations/20260421_add_display_online_to_fee/migration.sql`, `backend/prisma/schema.prisma`.
2. **Commit 2:** Backend fees service updates. Files: `backend/src/modules/fees/fees.service.js`, `backend/src/modules/fees/fees.test.mjs`.
3. **Commit 3:** Public booking endpoint. Files: `backend/src/modules/public-booking/public-booking.service.js`, `backend/src/modules/public-booking/public-booking.routes.js`, `backend/src/modules/public-booking/public-booking.test.mjs`.
4. **Commit 4:** Frontend settings page. Files: `frontend/src/app/settings/page.js`, `frontend/src/app/settings/settings-constants.js`.
5. **Commit 5:** Frontend booking page + tests. Files: `frontend/src/app/book/page.js`, `frontend/test/website-mandatory-fees.test.jsx`, `backend/scripts/tenant-tests/run-suite.mjs`.

**Why one PR:** All changes are tightly coupled and must ship together to avoid a half-baked state (backend without frontend, or vice versa).

**Rationale for commit separation:** Makes review easier (schema in isolation, services in isolation, frontend in isolation) while keeping the PR logically cohesive.

---

## 7. Agent Delegation

| Agent | Task | Input | Dependencies | Notes |
|-------|------|-------|--------------|-------|
| **supabase-db-expert** | Review & execute Prisma migration | Migration SQL, current schema, backward-compat audit | None | Review timing & index choices. Verify no downtime on production DB. |
| **senior-backend-developer** | Implement fees service + public endpoint + tests | Migration (from above), CLAUDE.md, tenancy rules, test examples | Migration done | Ensure `tenantId` scoping is airtight. Follow `scopeFor()` pattern for authenticated calls, explicit tenant resolution for public calls. |
| **senior-react-developer** | Implement frontend settings + booking page | Backend contract (endpoint shape, response), booking page structure, test examples | Backend implementation complete | Settings toggle is straightforward. Booking page fetch + render requires finding exact integration point; no refactor. |
| **qa-engineer** | Tenant isolation suite case + verification | Test examples, CI job details, tenant isolation checklist | Backend + frontend done | Verify the suite runs green. No tenant A data visible to tenant B. |
| **security-engineer** (async review) | Review public endpoint for injection/auth gaps | Public endpoint spec, CLAUDE.md security patterns, tenant isolation rules | Endpoint routes + service defined | Single concern: does the public endpoint properly isolate by tenant? Is the query safe? |
| **general-purpose × 2** (parallel review, step 4 of workflow) | Architect review (tenant isolation, race conditions, API contract) | Full PR diff, feature brief, plan excerpt | All implementation complete | Look for: tenant scope leaks, per-worker cache issues (unlikely here), consistent error handling, alignment with SCALING_ROADMAP. |
| **general-purpose × 2** (parallel review, step 4 of workflow) | QA audit (test coverage, edge cases, repo patterns) | Full PR diff, test files, CLAUDE.md patterns | All implementation complete | Look for: are mandatory+displayOnline=true and non-online fees both tested? Do tests run locally? Does CI pass? |

---

## 8. Acceptance Criteria

- [ ] Prisma migration executes cleanly on local + staging DB; no rollback needed.
- [ ] `displayOnline` column present on `Fee` table with default `false`; existing rows unaffected.
- [ ] `fees.service.js` accepts and persists `displayOnline` on create/update.
- [ ] New public endpoint `GET /api/public/booking/website-fees?tenantSlug=...` returns mandatory + displayOnline fees only, scoped by tenant.
- [ ] `createBooking` integrates website fees into total calculation; response includes fee breakdown.
- [ ] Settings UI displays fees table with new "Display Online" toggle column; toggle works and persists.
- [ ] Settings constants include `displayOnline: false` in `EMPTY_FEE`.
- [ ] Booking page fetches and renders website fees in price breakdown (non-removable, visually distinct).
- [ ] Unit tests: feesService.create/update + displayOnline field behavior.
- [ ] Integration tests: public endpoint returns correct fees + tenant isolation verified.
- [ ] Frontend component tests: fees rendered, not removable.
- [ ] Tenant isolation suite: new case confirms tenant A's online fees don't appear for tenant B.
- [ ] `npm test` passes locally (backend + frontend).
- [ ] `npm run verify` passes locally.
- [ ] CI job `tenant-isolation-suite` passes.
- [ ] Sentry logs clean (no new errors from new code).

---

## 9. Rollout

### 9.1 Development & Testing

1. **Local dev:** Create branch `feature/website-mandatory-fees` off current `develop`. Implement commits 1–5 per section 6.
2. **Local verify:** `cd backend && npm test && npm run prisma:generate` → all green.
3. **Docker sandbox:** `docker compose up --build && npm run seed:bootstrap && npm run verify:booking-fixtures`.
4. **Manual test:** Log into settings, create a fee, toggle `displayOnline=true`. Log into public booking (unauthenticated), verify fee appears in total + price breakdown.

### 9.2 Code Review & Hardening

1. **Independent review (step 4):** Two `general-purpose` agents review in parallel per section 7. Output: GREEN / YELLOW / RED + questions.
2. **Synthesize (step 5):** Address blockers in a follow-up commit if any.
3. **Final verify (step 6):** Re-run tests after hardening. Both files green. Syntax check clean.

### 9.3 Commit & Handoff (step 7)

1. `git add backend/prisma/migrations/...` (file-by-file, never `-A`)
2. `git add backend/src/modules/fees/...` ... etc.
3. `git commit -m "Add website-only mandatory fees display (feature/website-mandatory-fees-pr1)..."` with co-authored trailer.
4. `git push origin feature/website-mandatory-fees`.
5. Hand off to Hector for local validation (step 8).

### 9.4 Local Validation by Hector (step 8)

On Windows + PowerShell:
```powershell
git checkout feature/website-mandatory-fees
cd backend
npm install
npm run prisma:generate
npm test
```

Manual reproduction:
1. Spin up `docker compose up` locally.
2. Log into tenant settings as admin.
3. Create or edit a fee: toggle "Display Online" ON.
4. Open public booking page in incognito (no auth); verify fee shows in price breakdown.
5. Toggle "Display Online" OFF; refresh public page; fee should vanish.
6. Document timing: "Feature is live, users can now see website fees. No visible latency degradation."

### 9.5 Staging Deploy (step 9)

Tag the branch: `v0.9.0-beta.4` (or next available beta tag per version-control-and-release.md).

```powershell
cd RideFleetManagement-working-clean
powershell -ExecutionPolicy Bypass -File .\ops\deploy-beta.ps1 -Tag v0.9.0-beta.4
```

Watch Sentry for 24h:
- No new errors from `fees`, `public-booking`, or settings endpoints.
- P95 latency on `POST /api/public/checkout` should remain ≤ prev baseline (not regress).
- Public endpoint rate limiting is respected.

### 9.6 Production Deploy (step 10)

Only after 24h soak on staging + Hector sign-off. Deploy during off-hours (per auto-memory, never during business hours).

```powershell
ops/deploy-beta.ps1 -Tag v0.9.0-beta.4
```

Tenants will not see website fees until they opt-in (toggle `displayOnline=true` in settings), so rollout is **gradual and safe**.

---

## 10. Out of Scope

- **Optional upsells on website:** Non-mandatory fees with `displayOnline=true` should NOT appear on checkout. This is deferred to a future feature ("optional add-ons at checkout").
- **Mobile app UI changes:** Capacitor shell inherits the web booking page, so mobile "just works" with no additional changes.
- **Refactor `frontend/src/app/book/page.js`:** No architectural changes to the monolithic component. Website fees are a scoped addition (fetch + render in price breakdown).
- **Admin dashboard changes:** Staff-facing reservation/agreement flows are unaffected. Fees behave as today (auto-applied mandatory location fees, manually added services, etc.).
- **Fee scheduling:** No start/end dates for online visibility. A fee is either online or not (on/off toggle only).
- **Bulk operations:** No bulk enable/disable of `displayOnline` across multiple fees. User toggles one fee at a time in the UI.

---

## 11. Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|-----------|
| Tenant scope leak: website fees of tenant A appear for tenant B | Low | High | Tenant isolation suite test case (section 5.4). Code review by security-engineer (section 7). Explicit `tenantId` filter in query. |
| Double-charging: website fees added at checkout + again in rental agreement | Low | High | Checkout stores `websiteFeesApplied` in payload. Backend verifies fees were provided by customer during checkout, doesn't auto-add them to agreement (they're already reflected in the reservation). |
| Missing fees on frontend: fetch fails, customer sees incorrect total | Medium | Medium | Fetch happens early in page load with error handling + fallback (assume empty fee list if fetch fails). Tests verify fetch + render. |
| Performance: new index on `Fee` table slows writes | Very Low | Low | Index is on `(tenantId, isActive, mandatory, displayOnline)` with a WHERE clause (only indexes the small subset of mandatory online fees). Minimal impact on insert/update. |
| Backward compat: existing integrations break | Very Low | Low | `displayOnline` defaults to `false`; POST/PATCH ignore the field if not provided. No breaking API changes. |

---

## 12. Success Metrics

1. **Feature adoption:** Within 2 weeks, ≥50% of active tenants have set `displayOnline=true` on at least one fee.
2. **Checkout conversion:** No regression in public booking completion rate (measure before/after deploy).
3. **Zero data loss:** Tenant isolation suite passes on every CI run; no tenant sees another's fees.
4. **Performance:** P95 latency on `POST /api/public/checkout` stays ≤ 8s (includes website fee fetch + apply).
5. **User satisfaction:** Hector confirms tenants report the feature as working and valuable.

---

## 13. Timeline

- **Planning:** 2026-04-21 (this document).
- **Implementation:** 2026-04-22 through 2026-04-25 (3–4 days, parallelized).
- **Review:** 2026-04-26 (1 day).
- **Local validation:** 2026-04-27 (Hector's Windows machine).
- **Staging deploy:** 2026-04-28 (24h soak).
- **Production deploy:** 2026-04-29 (off-hours, after soak passes).

**Rationale:** Fast-track out of band. Minimal complexity, high tenant value, no architectural risk.

---

## 14. Rollback Plan

If production issues occur:

1. **Immediate:** Revert the feature via `ops/rollback-beta.ps1` to the previous tag (e.g., `v0.9.0-beta.3`). Tenants will still see their fees in staff portal, but website checkout won't show them (safe fallback — customers can still book).
2. **Diagnosis:** Check Sentry for errors in `fees`, `public-booking`, or settings routes. Inspect database for data corruption (unlikely).
3. **Fix:** Return to local dev, fix issue, re-implement in a new PR, and re-deploy under a new tag.

**Expected RTO:** <30 min (revert is a tag change + `deploy-beta.ps1` call).

---

## Appendix A: File Manifest

**New files:**
- `backend/prisma/migrations/20260421_add_display_online_to_fee/migration.sql`
- `frontend/test/website-mandatory-fees.test.jsx`

**Modified files:**
- `backend/prisma/schema.prisma`
- `backend/src/modules/fees/fees.service.js`
- `backend/src/modules/fees/fees.test.mjs` (new or extend)
- `backend/src/modules/public-booking/public-booking.service.js`
- `backend/src/modules/public-booking/public-booking.routes.js`
- `backend/src/modules/public-booking/public-booking.test.mjs` (extend)
- `backend/scripts/tenant-tests/run-suite.mjs`
- `frontend/src/app/settings/page.js`
- `frontend/src/app/settings/settings-constants.js`
- `frontend/src/app/book/page.js`

---

**End of Plan.**
