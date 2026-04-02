# Ride Car Sharing Website Action Plan

Effective date: April 2, 2026

## Objective

Build a new public-facing website for `ride-carsharing.com` that connects to Ride Fleet through API integrations and eventually replaces the current WordPress-led booking experience.

## Working approach

1. Keep the current production booking stack stable on the main branch and existing WordPress site.
2. Build the new guest-facing website on the development branch and preview routes first.
3. Move the production domain only after the public website covers the required guest journeys.

## Guest journeys to support

- Standard car rental discovery and booking
- Car sharing discovery and booking
- Post-booking customer portal actions
- Host and partner lead capture

## Recommended rollout

### Phase 1: public shell

- Homepage
- Rent landing page
- Car sharing landing page
- Fleet page
- Contact page
- Shared public navigation and branding

### Phase 2: rental integration

- Search by pickup and return details
- Results with pricing and availability
- Checkout handoff into Ride Fleet
- Confirmation and payment follow-up

### Phase 3: car sharing integration

- Distinct car sharing search and merchandising
- Shorter-trip checkout experience
- Host-focused storytelling and support pages

### Phase 4: content migration

- FAQ
- Policies
- Become a host
- Contact and support

### Phase 5: cutover

- Launch preview on a subdomain first
- Validate analytics, SEO redirects, and booking flow
- Repoint `ride-carsharing.com` when ready

## Technical notes

- Keep Ride Fleet as the operational system of record
- Reuse current public booking and customer portal APIs where possible
- Treat the new website as a dedicated guest UI layer, not an extension of the admin dashboard
- Preserve a separate UX language for standard rentals and car sharing while sharing backend services
