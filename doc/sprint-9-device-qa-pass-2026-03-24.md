# Sprint 9 Device QA Pass

Fecha base: 2026-03-24

## Goal

Run the first serious device QA pass against the new mobile wrapper and the hosted Ride Fleet beta runtime.

## Target Runtime

- Android wrapper label: `Ride Fleet Beta`
- hosted runtime:
  - `https://ridefleetmanager.com`

## Android Prep

Before the pass:

```bash
cd frontend
npm run mobile:sync
npm run mobile:open:android
```

## Core Device Checks

### App Launch

- app launches from home screen without browser chrome
- splash appears cleanly
- wrapper lands in hosted beta correctly
- reopening the app keeps session continuity when expected

### Link Handling

- open a `ridefleetmanager.com` link on Android
- confirm the wrapper can open it
- test at least:
  - guest sign-in magic link
  - issue response public link
  - host review public link

### Guest Checks

- sign in with guest magic link
- confirm `Welcome back` appears
- open a booking
- background app
- reopen app
- confirm last booking resumes
- create or review an issue ticket from guest side

### Host Checks

- open host area
- confirm host context restores
- edit one listing
- open availability
- upload host vehicle photo
- submit or edit host vehicle information

### Employee Checks

- run reservation search
- leave partial quick-create draft
- background app
- reopen
- confirm draft and search survive

### Issues Checks

- open one case
- change filters
- reopen app
- confirm active case and filters restore
- test `Email Guest For Info` or `Email Host For Info`

### Loaner Checks

- start loaner intake draft
- set queue focus
- set export filters
- background app
- reopen
- confirm everything restores

### Booking And Portal Checks

- begin `/book`
- search inventory
- choose package
- fill guest details partially
- background app
- reopen
- confirm draft survives

- open `/customer/precheckin`
- fill part of form
- upload at least one document
- background app
- reopen
- confirm form still has draft state

- open `/customer/sign-agreement`
- enter signer name
- accept terms
- background app
- reopen
- confirm draft survives

- open `/customer/pay`
- confirm payment return context survives refresh/reopen if applicable

## Upload Checks

Test these specifically on device:

- host vehicle photo upload
- host docs upload
- issue response file upload
- customer pre-check-in document upload

## Keyboard And Layout Checks

- no critical CTA hidden behind the keyboard
- sticky summary/actions remain reachable
- no page feels like it requires hunting for the next action

## Known Stage Limits

Current goal is internal testing, not public store readiness.

Still pending later:

- final polished icons
- final splash assets
- full universal links / app links hardening
- push notifications
- store listing assets

## Pass / Fail Rule

This device QA pass is successful if:

1. the wrapper opens and feels app-like
2. hosted beta loads reliably
3. login and magic-link continuity are usable
4. uploads work on device
5. key contexts restore after background/reopen
