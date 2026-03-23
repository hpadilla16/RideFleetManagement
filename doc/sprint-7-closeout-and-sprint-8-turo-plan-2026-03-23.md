# Sprint 7 Closeout And Sprint 8 Turo Plan

Fecha base: 2026-03-23

## Executive Closeout

`Sprint 7` dejo la plataforma en un punto mucho mas competitivo y comercializable.

Ya no estamos solo en una base fuerte de `rental ops`, sino en una plataforma con cuatro superficies claras:

- `Guest`
- `Host`
- `Employee`
- `Dealership Loaner`

Y todas comparten el mismo spine:

- `booking engine`
- `operations engine`
- `agreements`
- `inspections`
- `payments`
- `issues/disputes`
- `notifications`

## What Shipped In Sprint 7

### 1. Employee App

- lookup rapido por reservacion, cliente y vehiculo
- colas operativas para rental y loaner
- quick actions a workflow, checkout, check-in, inspections y payments
- lane de `Issue Escalations`

### 2. Guest App

- lookup por referencia y email
- continuity del booking
- timeline de journey
- downloads de documentos y recibos
- continuity a pre-check-in, signature y payment

### 3. Host App

- host dashboard real
- listing and trip management
- availability windows y blackouts
- host add-ons
- fleet submission and approval flow
- host rating/review surface

### 4. Dealership Loaner Program

- tenant feature flag
- intake con RO / claim / advisor
- borrower packet
- billing control
- advisor ops
- return exceptions
- extend / swap / complete service
- accounting closeout
- dealer invoice packet
- PO print
- monthly statement packet
- alerts y SLA views

### 5. Issue Center

- guest issue submission
- host issue submission
- customer service queue
- status handling
- issue history
- communications
- request-more-info emails
- public issue response portal
- host vehicle approval queue

### 6. Host Trust Layer

- host review survey after completed trip
- public host profile
- rolling average rating
- review count
- booking visibility of host reputation

## Competitive Read

The biggest remaining gap versus `Turo` is no longer the core backend.

The biggest gap is now:

- mobile execution
- listing quality
- speed and polish
- trust and communication UX
- day-to-day host usability

Turo's own host guidance emphasizes:

- mobile app usage for trip management
- high-quality listing photos
- delivery
- Extras
- pricing optimization
- ratings and reviews
- pre-trip and post-trip photo evidence

That validates the direction for `Sprint 8`.

## Sprint 8 Goal

Make the platform feel materially closer to a modern marketplace product, especially in `guest` and `host` daily usage.

This sprint should be judged less by raw module count and more by:

- conversion quality
- trust signals
- host usability
- mobile friendliness
- operational speed

## Sprint 8 Priorities

### Priority 1. Guest App Depth

- better mobile-first trip and reservation timeline
- guest wallet:
  - agreement
  - receipt
  - insurance decision
  - support documents
- stronger trip detail page
- guest issue/dispute continuity
- clearer pickup and return instructions
- post-trip review continuity

### Priority 2. Host App Depth

- stronger host profile page
- clearer listing presentation
- better image gallery UX
- host pricing controls:
  - weekday/weekend pricing
  - seasonal overrides
  - blackout clarity
- host trip inbox / communications feel
- issue follow-up and evidence handling from host side
- host onboarding and vehicle approval polish

### Priority 3. Employee App Depth

- more tablet-friendly execution
- better mixed queue management:
  - rental
  - loaner
  - disputes
  - host approvals
- faster handoff to workflow actions
- tighter status visibility
- more field-friendly review panels

### Priority 4. Marketplace Quality

- stronger listing cards in `/book`
- vehicle image hierarchy:
  - host photos first
  - fallback vehicle type image
- better host trust presentation:
  - rating
  - review count
  - completed trips
- clearer delivery / pickup presentation
- clearer add-ons and insurance presentation

### Priority 5. Notifications And Comms

- cleaner reminder cadence
- clearer transactional emails
- follow-up emails that match actual next step
- foundation for push notifications / app alerts later

## What We Do Not Need First

We should not chase every enterprise integration before the mobile/product experience feels great.

For the next competitive step, the highest leverage is:

- `guest app`
- `host app`
- `employee app`
- marketplace UX

not another large back-office-only module.

## Recommended Sprint 8 Output

By the end of `Sprint 8`, we should be able to demo:

1. guest finds a car, books, pays, signs, and manages trip from a mobile-friendly flow
2. host manages listing, pricing, photos, availability, issues, and reviews from a mobile-friendly flow
3. employee can operate rental + loaner + disputes from a compact operations hub
4. host trust and listing quality feel credible before booking

## Practical Definition Of "Closer To Turo"

We are closer when:

- host profiles feel trustworthy
- listings feel rich and visual
- delivery and extras are easy to understand
- host and guest can complete key actions from phone without friction
- review, issue, and evidence flows feel polished

We are not closer just because we added more admin screens.

## Sprint 8 Work Order

1. `Guest app` polish and depth
2. `Host app` polish and pricing/listing depth
3. `Employee app` compact operational polish
4. `Marketplace / booking` trust and listing quality pass
5. `Notification and communication` cleanup

## Sources Informing This Direction

- Turo getting started guide:
  - https://explore.turo.com/getting-started-guide/
- Turo host protection overview:
  - https://turo.com/us/en/car-rental/united-states/how-turo-works/vehicle-protection
