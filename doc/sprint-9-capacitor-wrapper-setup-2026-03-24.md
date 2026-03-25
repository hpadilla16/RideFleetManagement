# Sprint 9 Capacitor Wrapper Setup

Fecha base: 2026-03-24

## Goal

Leave the project ready for internal iOS and Android wrapper builds without
forking the frontend.

## Current Approach

- `Capacitor` is installed in `frontend`
- the wrapper loads the hosted runtime by default:
  - `https://beta.ridefleetmanager.com`
- `mobile-shell` exists only as the minimal packaged shell required by the
  native projects

## Files Added

- `frontend/capacitor.config.js`
- `frontend/mobile-shell/index.html`
- `scripts/generate_mobile_brand_assets.py`

## Branding Assets

Mobile icon and splash assets can be regenerated from the current Ride Fleet logo with:

```bash
python scripts/generate_mobile_brand_assets.py
```

This updates:

- Android launcher icons
- Android splash assets
- iOS app icon
- iOS splash assets

## Frontend Commands

Run these from `frontend`:

```bash
npm run mobile:add:android
npm run mobile:add:ios
npm run mobile:sync
npm run mobile:open:android
npm run mobile:open:ios
```

## Runtime Override

To point the wrapper to a different hosted environment:

```bash
set RIDEFLEET_MOBILE_APP_URL=https://app.ridefleetmanager.com
```

Then run:

```bash
npm run mobile:sync
```

## Internal Build Path

### Android

1. `npm run mobile:add:android`
2. `npm run mobile:sync`
3. `npm run mobile:open:android`
4. build debug or release from Android Studio
5. distribute through `Google Play internal testing`

### iOS

1. run the same repo on a Mac
2. `npm run mobile:add:ios`
3. `npm run mobile:sync`
4. `npm run mobile:open:ios`
5. archive through Xcode
6. distribute through `TestFlight internal`

## Notes

- Android can be prepared from this workspace first
- iOS still needs a Mac/Xcode environment for final archive/signing
- this keeps the product on one shared frontend while we validate app-shell,
  session continuity, uploads, and customer workflows on real devices
