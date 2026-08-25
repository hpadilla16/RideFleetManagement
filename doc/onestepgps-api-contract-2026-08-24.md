# OneStepGPS REST API — contract notes (for the shuttle tracker integration)

**Extracted:** 2026-08-24, from https://track.onestepgps.com/v3/apidoc/ (auth-gated; read via
Hector's session). API is marked "under development, subject to change — best-effort stability".

## Base + auth

- **Base URL:** `https://track.onestepgps.com/v3/api/public/`
- **Auth:** API key via **`Authorization: Bearer <API_KEY>`** header (a `api-key` query param also
  works — do NOT use it; keys in URLs end up in logs).
- **Obtaining a key:** by request — email `integration@onestepgps.com` with a brief description of
  intended use. (Check whether the account already has one.)
- **Rate limits:** not documented. Be conservative; our demand-driven poll is already light.
- **Webhooks/push:** none in the REST API → polling.

## Bulk current positions (THE endpoint for the tracker)

`GET /v3/api/public/device-info` — one call, **all devices** visible to the key, with the fields you
opt into via boolean query flags:

| Flag | Returns |
|---|---|
| `device_id=true` | device id |
| `display_name=true` | device display name |
| `lat_lng=true` | current `lat` / `lng` |
| `dt_tracker=true` | time the fix was recorded **on the device** |
| `license_plate=true` | plate (useful to auto-map device→vehicle) |
| `make=true` / `model=true` | vehicle make/model |
| `active_state=true`, `drive_status=true` | state |
| `latest_device_point=true` | the FULL latest point object (shape below) |

Response: JSON **array** of `{ device_id, display_name, lat, lng, ...requested fields }`.
Filters exist (`display_name_match`, `device_id_match`, `active_state_match` — regexps).

## Point shape (`latest_device_point` / `GET /device-point`)

```
{
  "device_point_id": "...",
  "dt_server":  "2018-08-27T05:35:05Z",   // RFC3339 UTC — server receive time
  "dt_tracker": "2018-08-27T05:34:55Z",   // RFC3339 UTC — device fix time (use THIS for eventAt)
  "lat": 12.345678, "lng": 23.456789,
  "altitude": 13.52,
  "angle": 146,                            // heading in degrees
  "speed": 0,                              // raw top-level number — ambiguous, do not trust alone
  "device_point_detail": {
    "gps_time": "...",
    "lat_lng": { "lat": ..., "lng": ... },
    "speed":   { "value": 0, "unit": "km/h", "display": "0 km/h" },  // ← UNIT-TAGGED, native km/h
    "heading": 146,
    "hdop": 0.7,
    ...vbus/fuel/odometer detail (unit-tagged {value,unit,display} objects)
  },
  "device_state": { "drive_status": "off", ... }
}
```

**⚠️ Units:** speed is **native km/h** (unit-tagged). Our `VehicleTelematicsEvent.speedMph` needs a
conversion — read `device_point_detail.speed.unit` and convert (`km/h` → ×0.621371; handle `mph`
passthrough in case an account is configured differently). OneStepGPS even publishes a units
conversion library (github.com/onestepgps/units) because of this.

## History

`GET /v3/api/public/device-point` — `device_id` (or repeated `device_id_list`), windowed by
`dt_server_from/to` or `dt_tracker_from/to` (`to` defaults to now). Devices transmit a point
**~every 1 minute** while running (plan-dependent). Paginated (`count`, `result_length`,
`result_list`). Doc tip: to tail new records, pass your previous call time as `dt_server_from`
(catches delayed points).

## Mapping to our house storage

| VehicleTelematicsEvent | OneStepGPS |
|---|---|
| latitude / longitude | `lat` / `lng` |
| heading | `angle` (top-level) or `device_point_detail.heading` |
| speedMph | `device_point_detail.speed` converted per its `unit` |
| eventAt | `dt_tracker` (RFC3339, UTC) |

Device identity for `VehicleTelematicsDevice.externalDeviceId` = `device_id`;
provider = `'ONESTEPGPS'` (String column — no migration needed). `license_plate` from device-info
enables plate-based auto-mapping to `Vehicle`.
