# Car Sharing Discovery

## Goal

Launch a car sharing track that can compete with Turo-style products while reusing the strongest operational pieces already built in Ride Fleet.

The intent is:

- keep Fleet Manager as the operational back office
- add a host/listing/trip layer on top
- reuse existing reservation, payment, agreement, inspection, and portal workflows where possible

## Product Position

Ride Fleet should not try to clone every marketplace feature at once.

The better first move is:

- strong internal operations
- clean customer self-service
- clear host earnings and platform fee visibility
- a modular path from rental fleet to car sharing

## Core Actors

### Platform Admin

- manages overall marketplace policy
- controls payout rules and verification rules
- monitors disputes and incidents

### Tenant Operator

- uses Fleet Manager back office
- can manage listings for their organization
- can support hosts and guests operationally

### Host

- owns or controls vehicles
- publishes listings
- sets availability and trip rules
- tracks earnings and upcoming trips

### Guest

- searches and books vehicles
- completes verification and pre-check-in
- signs trip documents and pays
- receives receipts and post-trip status

## Recommended Data Model

### New Models

- `HostProfile`
- `HostVehicleListing`
- `ListingAvailabilityWindow`
- `Trip`
- `TripPayout`
- `TripIncident`
- `TripMessage` or `TripTimelineEvent`

### Reused Existing Models

- `Vehicle`
- `Customer`
- `Reservation`
- `ReservationPricingSnapshot`
- `ReservationCharge`
- `ReservationPayment`
- `RentalAgreement`
- `RentalAgreementInspection`

## Integration Strategy

Use existing rental records as the operations engine, but add car-sharing-specific wrappers:

- `HostVehicleListing` describes the public marketplace item
- `Trip` maps to a marketplace booking lifecycle
- `Reservation` can remain the internal operational booking record
- `RentalAgreement` remains the signed trip document

This gives us:

- one operational spine
- separate public marketplace semantics
- less duplication

## MVP Scope

### Phase 1: Discovery And Schema

- define host, listing, trip, and payout entities
- decide whether hosts are tenant users, separate actors, or both
- define how a listing connects to `Vehicle`

### Phase 2: Internal Listing Management

- create listings from Fleet Manager
- set vehicle photos, pricing, trip rules, availability windows
- manage listing state: draft, published, paused

### Phase 3: Guest Booking Flow

- listing detail page
- trip quote
- reserve and pay
- pre-check-in
- agreement signature

### Phase 4: Trip Operations

- pickup and return workflow
- inspection and damage evidence
- fees, reimbursements, and disputes
- status timeline

### Phase 5: Earnings And Payouts

- host earnings ledger
- platform fee ledger
- payout review and release
- incident holds and adjustments

## Business Rules To Decide Early

- can one tenant manage multiple hosts
- can one host belong to multiple tenants
- whether inventory can be both fleet-owned and host-owned
- payout release timing
- who is liable for tolls, tickets, damage, and cleaning
- whether guest verification is required before booking or before pickup

## Reuse Opportunities From Current System

- `Sprint 3` commission ledger patterns can become host/platform earnings ledgers
- `Sprint 4` pre-check-in can become guest verification intake
- `Sprint 5` customer portal can become trip portal for guest actions and document downloads
- rental agreement and inspection flows already solve major trip handoff problems

## Recommended Next Build Slice

1. Add internal `Car Sharing` discovery page in the app.
2. Design schema for `HostProfile`, `HostVehicleListing`, `Trip`, and `TripPayout`.
3. Decide actor model:
   - tenant-managed host
   - standalone host account
   - hybrid
4. Build listing management inside Fleet Manager before building public marketplace search.

## Suggested Definition Of Success

For MVP, success is:

- a host vehicle can be listed
- a guest can request and book a trip
- the guest can complete pre-check-in, signature, and payment
- ops can execute pickup and return
- host and platform earnings are visible and auditable
