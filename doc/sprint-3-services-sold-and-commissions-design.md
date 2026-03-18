# Sprint 3: Services Sold And Employee Commissions

## Goal

Add a sales reporting and commission layer that works for traditional rental operations now and can later extend into car-sharing or host-earnings flows.

This design assumes:

- commissions are earned on `closed rental agreements`
- each agreement can be attached to an employee profile
- each service or line item can have its own commission rule
- commission rules support either:
  - percentage of sold amount
  - fixed amount per unit sold

## Competitive Takeaways

Public competitor positioning suggests:

- `HQ Rental Software` pushes advanced reporting, bookkeeping, customer portal, and mobile operations
- `Rent Centric` pushes real-time reports, mobile agent workflows, webhooks, smart key, and P2P car sharing
- `TSD` pushes assignment-heavy operational workflows such as delivery/collection and tracked field work
- `RentALL` and Turo-style products make earnings and payout visibility much more explicit by actor

Opportunity for Ride Fleet:

- keep strong rental operations and tenant scoping
- add a clearer sales-performance and commission dashboard for employees
- later reuse the same earnings ledger pattern for hosts in a car-sharing module

## Core Business Rule

Commissions are calculated when a `RentalAgreement` reaches `CLOSED`.

They are not earned:

- at reservation creation
- at reservation confirmation
- at partial payment time
- on cancelled agreements

This keeps commission accounting stable and defendable.

## Attribution Model

Each agreement should have two separate employee links:

- `salesOwnerUserId`
  - the employee who owns the sale
  - used for sales reports and commission payout
- `closedByUserId`
  - the employee who closed the agreement
  - used for operational auditing

These are intentionally different because the closer is not always the seller.

## Commission Rule Model

Commission rules should be configurable per tenant and optionally per service.

Supported commission types:

- `PERCENT`
  - example: 5% of sold amount
- `FIXED_PER_UNIT`
  - example: $3 for each insurance policy sold
- `FIXED_PER_AGREEMENT`
  - optional future mode for fixed bonus per completed agreement

Example:

- service: `LDW Insurance`
- quantity sold: `1`
- line revenue: `$300`
- commission rule: `FIXED_PER_UNIT`
- fixed amount: `$3`

Expected commission result:

- employee commission = `$3`

Not:

- `$15`
- `5%`

## Recommended Data Model

### Existing records to extend

Add to `RentalAgreement`:

- `salesOwnerUserId`
- `closedByUserId`

Add to `RentalAgreementCharge`:

- `source`
- `sourceRefId`

This allows charge lines to point back to an `AdditionalService` or another source record.

### New enums

- `CommissionValueType`
  - `PERCENT`
  - `FIXED_PER_UNIT`
  - `FIXED_PER_AGREEMENT`
- `CommissionStatus`
  - `PENDING`
  - `APPROVED`
  - `PAID`
  - `VOID`

### New tables

`CommissionPlan`

- tenant scoped
- optional assignment to a specific user or role
- holds defaults for how that tenant pays commissions

Suggested fields:

- `id`
- `tenantId`
- `name`
- `isActive`
- `defaultValueType`
- `defaultPercentValue`
- `defaultFixedAmount`
- `createdAt`
- `updatedAt`

`CommissionRule`

- belongs to a plan
- can target a specific service or a charge pattern

Suggested fields:

- `id`
- `commissionPlanId`
- `tenantId`
- `name`
- `serviceId` nullable
- `chargeCode` nullable
- `chargeType` nullable
- `valueType`
- `percentValue` nullable
- `fixedAmount` nullable
- `priority`
- `isActive`
- `createdAt`
- `updatedAt`

`AgreementCommission`

- one record per employee per closed agreement
- frozen snapshot at close time

Suggested fields:

- `id`
- `tenantId`
- `rentalAgreementId`
- `employeeUserId`
- `commissionPlanId` nullable
- `status`
- `monthKey`
- `grossRevenue`
- `serviceRevenue`
- `eligibleRevenue`
- `commissionAmount`
- `calculatedAt`
- `approvedAt` nullable
- `paidAt` nullable
- `notes` nullable
- `createdAt`
- `updatedAt`

`AgreementCommissionLine`

- detailed breakdown by sold line

Suggested fields:

- `id`
- `agreementCommissionId`
- `rentalAgreementChargeId` nullable
- `serviceId` nullable
- `description`
- `quantity`
- `lineRevenue`
- `valueType`
- `percentValue` nullable
- `fixedAmount` nullable
- `commissionAmount`
- `createdAt`

## Calculation Strategy

When an agreement is closed:

1. Load all selected `RentalAgreementCharge` rows.
2. For each line:
   - detect whether it comes from an `AdditionalService`
   - match the best commission rule
   - if no rule exists, apply plan default
   - if no default exists, commission is `0`
3. Compute line commission:
   - `PERCENT` => `lineTotal * percent / 100`
   - `FIXED_PER_UNIT` => `quantity * fixedAmount`
   - `FIXED_PER_AGREEMENT` => applied once only when appropriate
4. Sum all line commissions.
5. Create:
   - `AgreementCommission`
   - `AgreementCommissionLine[]`
6. Mark the agreement with:
   - `closedByUserId`
   - default `salesOwnerUserId` if still empty

## Service-Sold Reporting

`Services Sold Report v1` should support:

- date range
- tenant filter
- location filter
- employee filter
- service filter

Metrics:

- units sold
- revenue sold
- agreements closed with service attached
- attach rate
- commission generated

## Employee Commission Dashboard

Each employee login should be able to see:

- current month commissions
- closed agreements attributed to them
- service lines sold
- total eligible revenue
- total commission earned
- commission status

Manager view should also support:

- by employee
- by month
- by tenant
- by location
- pending vs approved vs paid

## UX Rules

- employee-facing dashboard should never recalculate history live from mutable current rules
- use frozen commission snapshots
- managers can update status from `PENDING` to `APPROVED` to `PAID`
- payout history should remain auditable even if rules change later

## Rollout Plan

### Phase 1

- add `salesOwnerUserId`
- add `closedByUserId`
- add `source/sourceRefId` on agreement charges
- persist source linkage for additional services

### Phase 2

- add `CommissionPlan`
- add `CommissionRule`
- add `AgreementCommission`
- add `AgreementCommissionLine`
- calculate commission on agreement close

### Phase 3

- build `Services Sold Report v1`
- build employee monthly commission dashboard
- build manager approval/payout report

## Future Reuse For Car Sharing

This same ledger pattern can later support:

- `employee commission`
- `host earnings`
- `platform fee`

The long-term abstraction becomes:

- one closed transaction
- multiple beneficiaries
- each with a frozen payout rule and payout amount
