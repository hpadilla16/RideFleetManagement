# Sprint 9 Android Studio Internal Build Guide

Fecha base: 2026-03-24

## Goal

Get the first internal Android build running from the new `Capacitor` wrapper.

## Current Wrapper State

- native Android project already exists in `frontend/android`
- app label is set to `Ride Fleet Beta`
- runtime points to:
  - `https://ridefleetmanager.com`

## Before Opening Android Studio

From `frontend`:

```bash
npm run mobile:sync
```

Then:

```bash
npm run mobile:open:android
```

## First Android Studio Flow

1. let Gradle finish syncing
2. if prompted, accept SDK/Gradle recommendations
3. choose either:
   - real Android phone
   - or emulator
4. run the app

## Recommended First Validation

Verify:

- app launches as `Ride Fleet Beta`
- hosted beta loads inside the wrapper
- login/session survives app background and reopen
- file picker still works
- mobile shell continuity still works in:
  - `/guest`
  - `/host`
  - `/employee`
  - `/issues`
  - `/loaner`
  - `/book`

## Build Targets

### Debug APK

Use this first for quick internal installs.

In Android Studio:

- `Build`
- `Build Bundle(s) / APK(s)`
- `Build APK(s)`

### Internal Testing AAB

Use this after the debug pass is stable.

In Android Studio:

- `Build`
- `Generate App Bundle(s) / APK(s)`
- `Generate App Bundle`

Then upload that bundle to:

- `Google Play internal testing`

## Notes

- keep this build pointed at beta while validating shell behavior
- do not switch to public production runtime yet
- icon and splash can still be polished after the first install/device pass
