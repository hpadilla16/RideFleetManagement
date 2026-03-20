# Sprint 7-8 Plan - Guest, Host, Employee Apps And Dealership Loaner

Fecha base: 2026-03-20

## Decision

The next delivery order is:

1. `Sprint 7`
   - `employee app foundation`
   - `guest app depth`
   - `host app depth`
   - begin `dealership loaner program` foundation
2. `Sprint 8`
   - deepen `guest app` further
   - deepen `host app` further
   - deepen `employee app`
   - continue `dealership loaner` with dealership-specific workflows

This keeps momentum while using the shared engines already built:

- booking engine
- operations engine
- customer portal flow
- agreements
- payments
- inspections
- reporting

## Why This Order Makes Sense

We already have:

- booking web foundation
- guest app foundation
- host app foundation
- car sharing internal ops

What is still missing on the operational side is the mobile-first surface for internal staff. At the same time, the guest and host surfaces need another step forward so all three app tracks move together and feel like one connected platform.

At the same time, the `dealership loaner program` opportunity is too important to leave for later because it is one of the clearest commercial expansion paths beyond classic rental and car sharing.

## Competitive Read

### TSD

Signals from official TSD documentation show strong emphasis on:

- insurance verification workflows
- delivery and collection
- mobile field processes
- key reader integrations
- driver assignment and GPS

This suggests that a dealership loaner module must not only manage bookings, but also:

- capture coverage and risk decisions
- support service-lane and driveway handoff
- integrate with dealership operations

### Dealerware

Dealerware publicly positions strongly around:

- loaner / courtesy fleet management
- rental and dual-fleet programs
- mobile contracting
- insurance verification
- pickup and delivery
- utilization and reimbursement / cost recovery

That means our dealership loaner module must feel modern, mobile, and financially accountable from the start.

### Record360

Record360 is not the same full platform category, but it is a relevant adjacent competitor for:

- inspections
- photo and video damage documentation
- standardized checklists

That means our differentiation can be:

- one operational system
- one booking and agreement spine
- plus inspections built into the same workflow

## Dealership Loaner Program Module

### Product Goal

Support dealership service departments that need to:

- reserve courtesy / loaner vehicles
- verify driver and insurance requirements
- contract quickly at the service lane
- hand off and receive vehicles with inspections
- recover toll, fuel, mileage, damage, and optional paid rental charges
- track OEM / internal utilization and reimbursement

### Core Concepts

Add a dealership-specific program layer on top of the current platform:

- `Loaner Program`
- `Service Appointment / RO`
- `Courtesy Contract`
- `Loaner Eligibility Rule`
- `Insurance Verification Result`
- `Loaner Cost Recovery`
- `Pickup / Delivery Assignment`

### Must-Have Capabilities

1. `Service-to-loaner intake`
   - customer arrives for service
   - employee creates or links service appointment / RO
   - assign courtesy vehicle or convert to paid rental

2. `Insurance and liability handling`
   - own insurance verification
   - optional mandatory coverage proof
   - override rules by manager
   - signed liability acknowledgement

3. `Mobile contracting`
   - quick agreement
   - signature
   - damage acknowledgment
   - optional card capture / deposit

4. `Inspections`
   - checkout inspection
   - check-in inspection
   - photos
   - damage compare

5. `Operational controls`
   - service lane queue
   - ready vehicle queue
   - waitlist when no courtesy cars
   - substitute vehicle assignment

6. `Cost recovery`
   - fuel
   - tolls
   - mileage overages
   - damage
   - paid upgrade / paid rental conversion

7. `Dealer reporting`
   - utilization
   - open courtesy contracts
   - reimbursement-ready usage
   - damage exposure
   - service-lane throughput

## Sprint 7

### Primary Goal

Advance `employee`, `guest`, and `host` app surfaces together while starting the `dealership loaner` backbone.

### Sprint 7 Deliverables

1. `Employee App Foundation`
   - mobile-first page / shell for employees
   - reservation lookup
   - create reservation from phone/tablet
   - pre-check-in review
   - checkout / check-in shortcuts
   - payment capture entry points

2. `Guest App Depth`
   - stronger booking continuity
   - clearer booking status surface
   - documents and next-step emphasis
   - app-like shell improvements

3. `Host App Depth`
   - stronger trip queue
   - availability and listing management improvements
   - clearer host metrics and actions

4. `Dealership Loaner Foundation`
   - define data model for:
     - service appointment / RO reference
     - loaner program type
     - courtesy vs paid rental mode
     - insurance verification state
     - liability acceptance
   - create dealership loaner console placeholder
   - map existing reservation flow to service-lane usage

5. `Commercial enablement base`
   - product presentation v1
   - feature matrix by module
   - screenshots and workflow story

### Sprint 7 Success Criteria

- employee, guest, and host surfaces all move forward in the same sprint
- an employee can complete a meaningful operational workflow from a phone
- the loaner program model exists and is compatible with current reservations
- we can demo a dealership-specific story, not only rental and car sharing

## Sprint 8

### Primary Goal

Deepen all three app surfaces and extend dealership loaner workflows.

### Sprint 8 Deliverables

1. `Guest App Depth`
   - booking timeline improvements
   - persistent session / app shell behavior
   - wallet-style documents
   - better booking and payment continuity

2. `Host App Depth`
   - availability management from host surface
   - earnings and payout summary
   - trip inbox improvements
   - host-side trip actions and incident entry

3. `Employee App Depth`
   - faster lookup and create flow
   - stronger inspections and payment handling
   - service-lane and field-friendly actions

4. `Dealership Loaner Workflow v1`
   - service lane courtesy contract flow
   - courtesy vs paid conversion
   - insurance verification UX
   - quick checkout inspection for dealership loaners

### Sprint 8 Success Criteria

- guest, host, and employee surfaces feel like real apps, not just reused screens
- dealership loaner flow can be demoed end-to-end in a service context

## Product Architecture Direction

Do not fork the platform into separate business engines.

Instead:

- `loaner program` uses reservation + agreement + inspection + payment spine
- `employee app` uses the same operations engine as back office
- `guest app` uses the same portal and booking engine
- `host app` uses the same listing / trip / payout model

The dealership loaner module should be an additional program mode, not a disconnected product.

## Dealership Loaner MVP Scope

### First usable version

- create courtesy reservation from service lane
- capture customer info and liability
- verify or record insurance decision
- assign available loaner
- checkout inspection
- return inspection
- post recovery charges

### Nice-to-have after MVP

- telematics
- key reader
- RO system integration
- appointment scheduler integration
- automated OEM reimbursement exports

## Demo Positioning

When presenting this to prospects, the strongest narrative is:

- classic rental
- car sharing
- dealership loaner
- one platform
- one operations spine
- one reporting layer
- one mobile strategy

That is materially stronger than selling isolated modules.

## References

- Dealerware: https://www.dealerware.com/
- Dealerware loaner fleet page: https://www.dealerware.com/loaner-fleet/
- Dealerware dealership mobility overview: https://www.dealerware.com/about-us/
- TSD insurance verification doc: https://content.tsdweb.com/prod/help/cirro/hyundai/Content/Definitions/Require%20Axle%20Insurance%20Verification.htm
- TSD delivery & collection guide: https://content.tsdweb.com/prod/help/cirro/bmw/Content/PDFs/Delivery%20and%20Collection%20Setup%20Guide%20%287_5_23%29.pdf
- TSD key reader implementation: https://content.tsdweb.com/prod/help/cirro/bmw/Content/PDFs/KAI%20Key%20Reader%20Implementation.pdf
- Record360 dealer inspection page: https://record360.com/lp/equipment-dealer-service/
