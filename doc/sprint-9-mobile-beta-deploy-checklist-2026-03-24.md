# Sprint 9 Mobile Beta Deploy Checklist

## Goal

Prepare the current web platform to behave more like an installable mobile surface while we continue toward dedicated iOS and Android builds.

This is not the final App Store / Google Play release plan. It is the beta-readiness checklist for:

- phone testing
- tablet testing
- PWA-style install checks
- internal mobile UX validation

## What Is Ready In This Slice

- shared mobile shell across `guest`, `host`, and `employee`
- per-surface continuity for:
  - `guest`
  - `host`
  - `employee`
  - `issues`
  - `loaner`
- customer journey continuity for:
  - `/book`
  - `/customer/precheckin`
  - `/customer/sign-agreement`
  - `/customer/pay`
- web manifest configured
- mobile viewport metadata configured
- app icons wired to the current Ride Fleet logo

## Beta Install Checks

1. Open beta on Android Chrome.
2. Confirm the browser sees an installable app surface.
3. Test `Add to Home Screen`.
4. Launch from the installed icon.
5. Confirm standalone launch feels correct on:
   - `/guest`
   - `/host`
   - `/employee`
   - `/loaner`

## Session And Continuity Checks

### Guest

- sign in by magic link
- confirm `Welcome back` shows
- open a booking
- close browser/app
- reopen and confirm last booking resumes

### Host

- select host profile
- set a trip filter
- open a listing for edit
- open availability for a listing
- leave the page
- return and confirm context restores

### Employee

- run a reservation search
- start a quick create draft
- leave the page
- return and confirm search + draft restore

### Issues

- set search, status, and type filters
- open one incident in `Case Handling`
- open one host vehicle submission in `Vehicle Approval Review`
- leave and return
- confirm both restore

### Loaner

- set queue focus
- enter search
- set export filters
- begin a loaner intake draft
- leave and return
- confirm all restore

### Customer Portal

- start `/book`
- search inventory
- select a package
- enter guest details
- leave and return
- confirm draft remains

- start `/customer/precheckin`
- fill part of the form
- upload at least one doc
- leave and return
- confirm draft remains

- start `/customer/sign-agreement`
- enter signer name
- accept terms
- leave and return
- confirm draft remains

- start `/customer/pay`
- trigger return flow if available
- confirm payment return context remains after refresh

## UX Checks Before Native Wrapping

- sticky actions remain reachable on phone
- no page requires excessive vertical hunting for the next CTA
- key surfaces show context above the fold
- mobile buttons are easy to tap
- no tenant-facing internal language appears in guest flows
- public booking still feels marketplace-first

## Next After This Checklist

1. package the shared mobile shell for internal device builds
2. define native navigation wrapper strategy
3. prepare TestFlight internal and Google Play internal testing
4. add app icons / splash variants if branding gets updated
