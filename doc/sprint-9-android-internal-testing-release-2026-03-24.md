# Sprint 9 Android Internal Testing Release

Fecha base: 2026-03-24

## Goal

Close the first signed Android internal build for `Ride Fleet Beta` and upload it
to `Google Play internal testing`.

## Current Android App Identity

- app name: `Ride Fleet Beta`
- application id: `com.ridefleet.mobile`
- hosted runtime: `https://ridefleetmanager.com`

## Versioning

The Android project now accepts version overrides through Gradle properties or
environment variables:

```bash
RIDEFLEET_VERSION_CODE=2
RIDEFLEET_VERSION_NAME=1.0.0-beta.1
```

Default values if nothing is passed:

- `versionCode = 2`
- `versionName = 1.0.0-beta.1`

## Before Building

From `frontend`:

```bash
npm run mobile:sync
```

Then open Android Studio:

```bash
npm run mobile:open:android
```

## First Signed AAB Flow

In Android Studio:

1. `Build`
2. `Generate Signed Bundle / APK`
3. choose `Android App Bundle`
4. click `Next`
5. create a new keystore if you do not have one yet

Recommended upload key naming:

- keystore file: `ridefleet-upload-key.jks`
- alias: `ridefleet-upload`

Store that keystore somewhere safe and backed up.

## Recommended Release Values

For the first internal upload:

- `versionCode`: `2`
- `versionName`: `1.0.0-beta.1`

For the next internal upload, increment at least:

- `versionCode`: `3`
- `versionName`: `1.0.0-beta.2`

## Build Variant

Use:

- build variant: `release`

## Output

After generation, Android Studio will produce an `.aab` bundle.

Use that file for:

- `Google Play Console`
- `Internal testing`

## Play Console Flow

1. create the app in Play Console if it does not exist yet
2. choose `Internal testing`
3. create the first release
4. upload the generated `.aab`
5. add internal tester emails
6. roll out the release

## What To Verify Before Upload

- app launches cleanly
- splash looks correct
- `ridefleetmanager.com` loads in-app
- guest sign in works
- host and employee login route correctly
- uploads work on device
- app reopens with continuity

## Notes

- use `Ride Fleet Beta` for internal testing first
- keep production/public store submission for later after iOS/TestFlight is also ready
- never lose the upload keystore once the app is in Play Console
