# Sprint 9 Wrapper And Internal Store Path

Fecha base: 2026-03-24

## Decision

For `Sprint 9`, the recommended path is:

- keep the current `Next.js` frontend as the main UI surface
- package it for mobile internal testing with a light native wrapper
- continue using the shared backend and existing web workflows

Do not rebuild the app stack in React Native right now.

## Recommended Wrapper

Use a `Capacitor`-style wrapper strategy first.

Why this fits the current repo:

- the product already has strong mobile-first web surfaces
- guest, host, employee, issue, loaner, and customer portal flows already exist
- the team can move faster by reusing the same frontend and APIs
- it gets us to device installs and internal store testing much faster than a full native rebuild

## Why Not Full Native First

Starting with a full React Native rewrite right now would slow the team down because it would require:

- duplicating UI and navigation too early
- rebuilding uploads, auth continuity, and workflow detail pages
- revalidating every booking, support, host, and loaner flow again in a second client

That can still come later if needed, but it is the wrong first move for `Sprint 9`.

## Sprint 9 Output

The target for this sprint is not public launch.

The target is:

- app-like mobile shell
- continuity across main surfaces
- installable behavior
- internal device builds
- internal store testing

## What We Already Have

### Shared Mobile Foundation

- shared mobile shell for:
  - `guest`
  - `host`
  - `employee`
- continuity for:
  - guest
  - host
  - employee
  - issues
  - loaner
  - booking funnel
  - customer portal

### Web App Packaging Base

- `manifest.webmanifest`
- mobile viewport metadata
- theme color
- basic app icons
- beta mobile checklist

## Wrapper Build Order

### Phase 1. Internal Wrapper Setup

- create native shell project
- point it to the hosted beta URL first
- verify login/session behavior
- verify file uploads, camera/file picker behavior, and portal redirects

### Phase 2. Internal Device Validation

Focus on:

- `/guest`
- `/host`
- `/employee`
- `/issues`
- `/loaner`
- `/book`
- `/customer/precheckin`
- `/customer/sign-agreement`
- `/customer/pay`

### Phase 3. Internal Store Channels

- Apple `TestFlight internal`
- Google Play `internal testing`

The purpose here is:

- install on real devices
- verify standalone app feel
- catch keyboard, browser, upload, and navigation issues

## Technical Strategy

### Runtime Strategy

Use the hosted app as the primary runtime first.

That means:

- the wrapper loads the current beta or app environment
- backend stays unchanged
- frontend stays shared
- auth/session behavior is debugged in one UI codebase

This is the lowest-risk path to internal mobile testing.

### Native Features To Delay

Do not block `Sprint 9` on:

- push notifications
- offline sync
- deep native camera integrations
- biometric login
- full native navigation rewrite

Those are follow-up hardening items, not prerequisites for internal testing.

## Definition Of Done For Internal Testing

We should be able to say:

1. the app installs on iPhone and Android devices
2. guest, host, and employee can log in and resume context
3. booking and customer portal flows still work
4. uploads and support flows still work
5. the app can be distributed in:
   - `TestFlight internal`
   - `Google Play internal testing`

## Not Yet Promise For Sprint 9

Do not promise public App Store / Play Store availability in this sprint.

Public release usually still needs:

- privacy and support copy
- screenshots
- final icons/splash set
- device QA pass
- notification decisions
- account management policy checks
- store review buffer

## Safer Public Release Target

Use `Sprint 10` for:

- store hardening
- submission assets
- final QA
- public submission readiness

## Bottom Line

The best path right now is:

- shared mobile web
- light native wrapper
- internal device builds
- internal store channels first

That keeps momentum high and gets Ride Fleet much closer to real iOS and Android distribution without a costly rewrite too early.
