# Platform And App Roadmap 2026-03-19

## Goal

Organize Ride Fleet into one shared booking platform that can power:

- public web booking for rental reservations
- public web booking for car sharing trips
- guest mobile experience
- host mobile experience
- employee mobile operations

The key decision is:

- do not build separate business logic per app
- build one `booking engine` and one `operations engine`
- let each app be a client of the same platform

## Product Surfaces

### 1. Fleet Manager Back Office

Internal web console for:

- reservations
- rental agreements
- payments
- inspections
- reports
- commissions
- car sharing host/listing/trip management

### 2. Public Booking Web

Customer-facing web flow where a guest can:

- search availability
- see pricing
- reserve
- pay
- complete pre-check-in
- sign agreements
- download receipts and trip documents

This should support both:

- traditional rental bookings
- car sharing bookings

### 3. Guest App

Customer app for:

- booking and rebooking
- reservation/trip timeline
- pre-check-in
- signature
- payments
- receipts
- messages / reminders
- pickup / return instructions

### 4. Host App

Car sharing host app for:

- listings
- availability calendar
- pricing
- trip requests
- trip status
- earnings
- payout status
- incident handling

### 5. Employee App

Operational app for non-car-sharing rental staff:

- create reservation
- update reservation
- collect documents
- pre-check-in review
- checkout / checkin
- inspections
- agreements
- payments
- delivery / collection

## Core Platform Principle

Build shared platform layers first.

### Shared Booking Engine

Must power:

- reservation quote
- trip quote
- availability search
- taxes and fees
- pricing rules
- deposits
- booking confirmation
- cancellation and changes

### Shared Operations Engine

Must power:

- agreements
- inspections
- payment posting
- status transitions
- timeline events
- notifications
- audit

### Shared Identity And Roles

Need clear actor separation:

- `Guest`
- `Host`
- `Employee`
- `Tenant Admin`
- `Platform Admin`

### Shared Notification Layer

One place for:

- email
- SMS / WhatsApp later
- push notifications later
- reminders
- booking confirmations
- host alerts

## Recommended Delivery Strategy

Do not start with three fully native apps at once.

Recommended order:

1. mobile-friendly responsive web plus PWA behavior
2. shared booking engine APIs
3. host and guest mobile-first web flows
4. employee mobile ops flows
5. native app packaging only after the workflows are stable

Why:

- much faster to ship
- less duplicated logic
- easier QA
- better fit for the current team and codebase

## Booking System Requirement

We need a real booking system that customers can use from:

- the website
- the future guest app

This system must support two booking modes:

### Rental Booking Mode

- tenant inventory
- branch/location pickup-return
- rate tables and fees
- classic reservation lifecycle

### Car Sharing Booking Mode

- listing-based inventory
- host-owned or fleet-owned listings
- availability windows
- trip lifecycle
- host/platform earnings

The system should share:

- search inputs
- pricing pipeline
- payment flow
- agreement / signature flow
- customer portal / timeline

## App Strategy By Surface

### Guest App

Phase 1:

- make the public booking web responsive and app-like
- allow login/session for reservation and trip access
- expose booking timeline, receipts, documents, and payments

Phase 2:

- save favorites
- rebooking
- trip and reservation notifications
- profile and license wallet

### Host App

Phase 1:

- host login
- listing management
- availability windows
- trip queue
- earnings summary

Phase 2:

- payout details
- incident reporting
- messaging
- trip performance analytics

### Employee App

Phase 1:

- reservation search and creation
- pre-check-in review
- checkout / checkin
- inspection capture
- payment collection

Phase 2:

- delivery / collection
- offline support
- mobile uploads and scan helpers
- ops dashboard by location

## Recommended Next Sprints

### Sprint 6

Goal:

- stabilize car sharing internal MVP
- define the shared booking engine contract
- begin responsive/mobile polish for key screens

Deliverables:

- finalize availability windows and trip operations
- define booking engine interfaces for rental and car sharing
- add booking/timeline event normalization
- start UX polish pass for car sharing, reports, portal, and reservations

### Sprint 7

Goal:

- build public booking web foundation

Deliverables:

- public listing detail page
- rental booking search scaffold
- quote API for rental and car sharing
- reserve request flow
- mobile-first responsive patterns for booking

### Sprint 8

Goal:

- launch guest booking experience v1

Deliverables:

- guest portal upgraded into booking app shell
- booking confirmation
- trip/reservation timeline
- payment and signature continuity across devices
- saved session flow for guest users

### Sprint 9

Goal:

- launch host app foundation

Deliverables:

- host login
- host dashboard
- listing management mobile layout
- calendar / availability management
- trip inbox / upcoming trips

### Sprint 10

Goal:

- launch employee app foundation for traditional rental

Deliverables:

- employee mobile shell
- reservation lookup and creation
- pre-check-in review
- checkout / checkin
- inspection and payment capture

### Sprint 11

Goal:

- expand booking and ops depth

Deliverables:

- cancellations / modifications
- guest reminders and notifications
- host trip actions
- employee delivery / collection
- better mobile timeline and status UX

### Sprint 12

Goal:

- harden the whole experience and prepare for broader launch

Deliverables:

- responsive polish pass across desktop / tablet / phone
- PWA installability and icon setup
- push notification plan
- analytics / conversion tracking
- readiness checklist for beta expansion

## UX Direction For End Of Sprint

At the end of the current sprint, include a dedicated UI pass for:

- desktop readability
- tablet layouts
- phone layouts
- bigger tap targets
- cleaner information hierarchy
- fewer admin-looking forms
- clearer empty states
- better action grouping

This should be treated as a deliverable, not an afterthought.

## Success Criteria

We are on the right path if:

- one booking engine supports both rental and car sharing
- guests can book from web first, then app shell
- hosts can manage availability and trips without using back office
- employees can complete core rental operations from mobile
- the UI feels modern and usable on desktop, tablet, and phone
