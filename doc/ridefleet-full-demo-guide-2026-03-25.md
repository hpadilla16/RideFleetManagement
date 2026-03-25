# Ride Fleet Full Product Demo Guide

Date: 2026-03-25

## Purpose

This guide is for someone demoing Ride Fleet end to end. It is designed to help
them explore the full platform confidently, including the dealership loaner
program.

The goal is not to click every button. The goal is to show how Ride Fleet ties
together:

- marketplace booking
- customer journey
- employee operations
- host operations
- issue handling
- dealership loaner
- admin controls

## Demo Mindset

When presenting Ride Fleet, frame it as one platform with multiple operating
surfaces rather than disconnected tools.

The core story is:

1. a guest can book and self-serve
2. staff can run daily operations
3. hosts can manage car sharing inventory
4. customer service can resolve issues
5. dealerships can run a full loaner workflow
6. admins can control tenants, settings, payments, and permissions

## Recommended Demo Order

Use this order for the cleanest story:

1. Home / workspace overview
2. Marketplace booking
3. Guest account and customer portal
4. Employee app and reservation operations
5. Issue Center
6. Host app and car sharing
7. Dealership loaner
8. Settings, tenant controls, and access controls
9. Reports and closeout

## Suggested Demo Length

- fast pass: 15 to 20 minutes
- standard pass: 30 to 40 minutes
- deep pass: 45 to 60 minutes

## 1. Home / Workspace Overview

Start at:

- `/`

What to show:

- the workspace hub
- that the platform is multi-module
- that internal users can jump quickly into operations

Talking points:

- Ride Fleet is not only a booking tool
- it is built to support front office, customer portal, support, hosts, and
  dealership workflows in one system

## 2. Marketplace Booking

Go to:

- `/book`

Show:

- location-based marketplace search
- package selection
- guest details step
- confirmation page

Key points:

- the booking flow is customer-facing and does not expose tenant complexity
- duplicate public locations are grouped marketplace-style
- car sharing can show host trust, photos, and add-ons
- pricing can show customer-facing trip economics clearly

Good line to use:

- "This is the customer storefront. It is intentionally clean, location-first,
  and designed to feel like a marketplace rather than an internal admin page."

## 3. Guest Account And Customer Portal

Go to:

- `/guest`

Show:

- guest sign up
- guest sign in via magic link
- welcome banner and account identity
- My Bookings
- resume capability

Then show:

- `/customer/precheckin`
- `/customer/sign-agreement`
- `/customer/pay`

Key points:

- customers can self-serve key pre-rental steps
- continuity is preserved across reopen/background flows
- payment and signature are structured as guided steps
- the customer can also report issues from the guest side

Good line to use:

- "We reduce counter friction by pushing pre-check-in, agreement, and payment
  into a guided customer journey."

## 4. Employee App And Reservation Operations

Go to:

- `/employee`
- `/reservations`
- `/reservations/:id`

Show:

- employee hub
- quick create reservation
- reservation shift board
- reservation ops snapshot
- checkout, check-in, inspection, and payments

Key points:

- staff has a mobile-friendly operations hub
- reservations are the core workflow backbone
- inspections, payments, and additional drivers are tied into the same record
- the system supports both operational speed and auditability

Good line to use:

- "Employees do not need to jump between separate products to operate the
  reservation lifecycle."

## 5. Issue Center

Go to:

- `/issues`

Show:

- priority board
- issue history
- communications
- request-more-info workflow
- vehicle approval review

If available, also mention:

- guest and host can submit issues
- customer service can move the case through review and resolution

Key points:

- disputes and issues are handled in a structured queue
- customer service has case history and communications in one place
- the same service center also supports host vehicle approvals

Good line to use:

- "This turns support into an operational workflow, not just an email thread."

## 6. Host App And Car Sharing

Go to:

- `/host`
- `/host-profile/:id`
- `/car-sharing`

Show:

- host welcome snapshot
- fleet vehicles
- rates and availability
- vehicle approval workflow
- host trust profile
- car sharing control center

Key points:

- hosts can manage photos, pricing, add-ons, and availability
- host vehicle submissions can be reviewed and approved
- the guest can see host trust signals before booking
- marketplace economics are split cleanly between host and platform

Good line to use:

- "We support host operations as a real business workflow, not just listing
  creation."

## 7. Dealership Loaner Program

Go to:

- `/loaner`

Then open a loaner reservation workflow if available.

Show:

- loaner dashboard
- service lane priority board
- intake
- borrower packet
- advisor operations
- billing control
- return exceptions
- timeline
- accounting closeout
- invoice packet / purchase order / monthly packet

Key points:

- loaner is not a side note; it has its own operational depth
- it supports service-lane intake and billing workflows
- it includes print and accounting outputs
- it is built to compete with dealership loaner products, not just general
  rental software

Good line to use:

- "This is a dealership-ready workflow with intake, advisor ops, billing,
  exceptions, closeout, and accounting outputs in one system."

## 8. Settings, Tenant Controls, And Access Controls

Go to:

- `/settings`
- `/tenants`
- `/people`

Show:

- Settings Tenant Scope
- payment gateway by tenant
- tenant module controls
- user module controls
- tenant admins

Key points:

- Ride Fleet is multi-tenant by design
- tenants can have different payment gateways
- modules can be enabled or disabled per tenant
- users can be restricted to only the modules they need

Good line to use:

- "Admins can shape the platform per tenant and per user, which is critical for
  multi-rooftop and multi-role operations."

## 9. Reports And Closeout

Go to:

- `/reports`
- `/customers`
- `/vehicles`
- `/planner`

Show:

- leadership hub
- customer support hub
- fleet ops hub
- planner board

Key points:

- operations and leadership can review performance from the same platform
- the system is not only transactional; it also supports oversight and follow-up

## Demo Scripts By Audience

## If The Audience Is Rental / Operations

Focus on:

- marketplace booking
- customer portal
- employee app
- reservations
- issue center

## If The Audience Is Car Sharing / Host Marketplace

Focus on:

- host app
- car sharing control center
- host vehicle approval workflow
- public host trust profile
- guest booking flow

## If The Audience Is Dealership / Service Lane

Focus on:

- loaner dashboard
- intake
- advisor ops
- borrower packet
- billing control
- closeout and printouts

## If The Audience Is Admin / Ownership

Focus on:

- tenants
- settings
- payment gateways
- user access controls
- reports

## Suggested Demo Data To Point Out

If the environment has data, try to highlight:

- at least one active reservation
- one guest booking
- one issue ticket
- one host listing
- one approved or pending host vehicle
- one loaner workflow

## Common Questions And Suggested Answers

## "Can customers do this themselves?"

Answer:

- Yes. Guests can sign in, resume bookings, complete pre-check-in, sign,
  pay, and open issues through customer-facing flows.

## "Can staff still take over if needed?"

Answer:

- Yes. Employee and reservations workflows allow staff to pick up the process
  and continue from the operational side.

## "How do you handle support?"

Answer:

- Through the Issue Center, which tracks status, history, communications,
  and more-info requests in one place.

## "Can each tenant operate differently?"

Answer:

- Yes. Tenants can have different modules, settings, payment gateways, and
  user access rules.

## "Is the loaner program separate?"

Answer:

- It has its own operational surface and depth, but it still benefits from the
  shared reservation, payments, communications, and audit backbone.

## Demo Close

End with a summary like:

- Ride Fleet gives you one operating platform for customer booking, staff
  operations, support, host marketplace management, and dealership loaner
  workflows.

## Quick Demo Checklist

- open home/workspace
- show `/book`
- show `/guest`
- show customer portal pages
- show `/employee`
- show `/reservations`
- show `/issues`
- show `/host`
- show `/car-sharing`
- show `/loaner`
- show `/settings`, `/tenants`, `/people`
- show `/reports`

## Final Reminder

The best demos stay outcome-focused:

- less "here are all the buttons"
- more "here is how Ride Fleet runs the business from booking to closeout"
