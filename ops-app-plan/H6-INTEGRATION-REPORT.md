# H6 — Pase de integración M1 en emulador (2026-08-17)

Cierre del M1 de RideOps: merge H4+H5, drenado en background (WorkManager),
CTA card→inspección, política kiosco-vs-exempt y pase e2e contra **backend
real** en el emulador `Medium_Phone_API_36.1` (Android 16, API 36,
emulator-5554). Evidencia visual en `ops-app-plan/h6-evidence/`.

## 0. Entorno (y la verdad sobre Docker)

- **Docker NO estuvo disponible**: el CLI existe (29.1.3) pero el daemon no
  arranca sin sesión interactiva/admin (`com.docker.service` denegado;
  Docker Desktop no levanta el engine en esta sesión). Registrado tal cual.
- **Fallback ELEGIDO: backend real nativo, no un mock.** Patrón documentado
  en `doc/SESSION-HANDOFF.md`: `embedded-postgres` (PG 18.4) en el puerto
  5455 (el 5433 estaba ocupado por otro worktree) + `prisma db push` +
  `npm run dev` en `backend/` (puerto 4000) + seeds oficiales de CI
  (`tenant-seed-beta.mjs`, `tenant-seed-superadmin.mjs`, como
  beta-ci.yml:159-176 pero sin contenedor). El pase corrió contra el MISMO
  código de backend que la CI — lo único no probado del stack Docker es el
  empaquetado del contenedor en sí.
- Datos extra para tener cola de salidas real: `h6-seed-extra.mjs`
  (archivado en `h6-evidence/scripts/`, se ejecuta con cwd `backend/`):
  2 vehículos (H6-001 Toyota Corolla 2023 · 41.250 mi, H6-002 Honda Civic
  2024) y 2 reservas CONFIRMED con pickup HOY (H6-RES-0001/0002,
  pre-checkin estampado). Ahí mismo: `h6-pg-boot.mjs` (embedded PG) y
  `h6-expire-token.mjs` (expiración del token, paso 12).
- App: `flutter build apk --flavor dev --debug
  --dart-define=RIDEOPS_API_BASE=http://10.0.2.2:4000` + `adb install`.
  Usuario del pase: `admin+a@fleetbeta.local` (ADMIN, tenant beta-a).

## 1. Bugs REALES encontrados por el pase (y arreglados)

1. **SQLCipher moría al abrir la bandeja en aparato** —
   `open.overrideFor(android, openCipherOnAndroid)` corría en el isolate
   principal, pero `NativeDatabase.createInBackground` abre la DB en OTRO
   isolate al que el override no viaja: `Failed to load dynamic library
   libsqlite3.so` (captura `06-inspection.png` de la primera corrida).
   Ningún unit test podía verlo (en host el sqlite3 del sistema existe).
   Fix: el override vive en `isolateSetup:` de drift
   (`outbox_open.dart`). Verificado en emulador: la bandeja cifrada abre,
   encola y drena.
2. **El APK release no tenía permiso INTERNET** — solo los manifests de
   debug/profile lo agregan (tooling de Flutter). Una app que vive de la
   API no puede salir así: agregado a `src/main/AndroidManifest.xml`.
3. **Cleartext HTTP para dev** — Android ≥9 bloquea `http://10.0.2.2` por
   default; nuevo `src/dev/AndroidManifest.xml` con
   `usesCleartextTraffic=true` SOLO en el flavor dev (stg/prod siguen
   estrictos).
4. (Del lado seed, no de la app) El guard de checkout rechazó la 2ª reserva
   por conflicto de vehículo — la pantalla de inspección mostró el error
   del servidor con Retry/Back (DoD-4 en vivo, sin crash). Evidencia de
   manejo de errores real contra backend real.

## 2. El pase, paso a paso (evidencia)

| # | Paso | Resultado | Evidencia |
|---|------|-----------|-----------|
| 1 | Login (`admin+a@fleetbeta.local` / TempPass123!) | 200, JWT 12 h; `mustChangePassword=false` en el seed ⇒ el gate 2A-2C no aplicó en este pase (cubierto por widget tests) | `01-login.png`, backend log `POST /api/auth/login 200` |
| 2 | Setup de PIN (gate del router, mockup 3A) | 2 pasos, PIN 2468; sin oferta de huella (emulador sin biometría enrolada — fallback silencioso correcto) | `02-after-login.png` |
| 3 | Home con colas REALES | Hero "2 pickups", Pickups (72 h) con H6-RES-0001/0002 + chevron CTA (H6), Pre-checkin 2, frescura "moments ago" | `03-pin-done.png` |
| 4 | Selector de ubicación (4C) | Sheet con "All my locations" + "Location A" del endpoint real; pin a Location A refetch con `x-view-location` | `04-location-sheet.png`, `05-location-a.png` |
| 5 | Card de salidas → `/inspection/:id` | CheckoutSession creada en el server (`POST /api/checkout-sessions 201`), display-data real: "H6-RES-0001 · Toyota Corolla 2023 · H6-001" | `09-inspection-loaded.png` |
| 6 | **Modo avión** (`cmd connectivity airplane-mode enable`) | Banner offline en 6A; el flujo sigue | `12-angles-queued.png` |
| 7 | Cámara: Front + Rear (imagen sintética del emulador) | Compresión al capturar: 63 KB por foto, "In outbox", controlador liberado entre tomas | `10-camera.png`, `11-after-front.png`, `12-angles-queued.png` |
| 8 | Métricas | Odómetro 41300 con "Last recorded reading: 41250 mi" (dato REAL del vehículo), fuel 6/8, limpieza 4 | `13-metrics.png`, `13b-metrics-filled.png` |
| 9 | Firma en modo kiosco | Kioskbar "Signing mode · lock paused · Exit: hold 3 s + PIN", toggle ES/EN, firma con el dedo. El flag `kiosk_in_progress` se persiste aquí (H6) | `14-kiosk-signature.png` |
| 10 | Finish offline | "2 photos · metrics · signature — Will send on reconnect"; snackbar "Inspection placed in the outbox"; badge de Bandeja = 3 (ámbar) | `15-summary.png`, `16-after-finish.png`, `17-outbox-pending.png` |
| 11 | One-off de WorkManager agendada | `dumpsys jobscheduler`: job de `com.ridefleet.rideops.dev` con constraint `NET ... unsatisfied` (esperando red) | transcript en §3 |
| 12 | **>15 min**: el token del mint de carga se EXPIRÓ server-side (`backend/h6-expire-token.mjs`, expiresAt → pasado). Método elegido en vez de esperar: el TTL vive en el SERVIDOR — mover el reloj del emulador no lo tocaría; esto es el equivalente honesto e instantáneo | `{"expired":1}` | — |
| 13 | **Reboot del emulador con la bandeja llena y SIN red** | Tras el boot: el job de WorkManager REAPARECE en jobscheduler (persistido por el OS) | §3 |
| 14 | **Reconectar SIN abrir la app** | El isolate de background drenó solo: re-mint (token NUEVO `MsjS…` ≠ `QXhi…` del load), `photo front` 200, `photo rear` 200, pre-check by-reservation, `complete` 200 `photoCount:2, hasSignature:true` — backend log 12:24:51-53 | §3 |
| 15 | Verificación API | `GET by-reservation` → `currentStep: CONFIRMING`, `inspectionCompletedAt: 2026-08-17T16:24:53.014Z` | `scratchpad/session-after-drain.json` |
| 16 | Cold start tras reboot | Candado de PIN (3B, "Hi, Tenant"); al desbloquear, Bandeja = "All sent" | `18-postreboot-lock.png`, `19-outbox-empty.png` |
| 17 | Reconciliación 6F | Reabrir la card completada → "This inspection is already complete … at 12:24 PM", chip de reserva, purga selectiva sin duplicados | `20-already-complete.png` |

## 3. Evidencia clave del drenado en background

`dumpsys jobscheduler` con la bandeja llena y sin red (antes y después del
reboot — el job PERSISTE):

```
JOB androidx.work.systemjobscheduler:u0a228/0 …SystemJobService
  Source: uid=u0a228 user=0 pkg=com.ridefleet.rideops.dev
  … NET satisfied:0x3600000 unsatisfied:0x10000000   ← esperando red
```

Backend log al reconectar (la app NUNCA se abrió después del reboot):

```
12:24:51 POST /api/checkout-sessions/cmsxfjypo…/handoff-token 201   ← re-mint (el viejo expiró)
12:24:52 [mobile-inspection] photo saved {angleKey: front}
12:24:52 [mobile-inspection] photo saved {angleKey: rear}
12:24:52 GET /api/checkout-sessions/by-reservation/… 200            ← pre-check del complete
12:24:53 [mobile-inspection] completed {photoCount: 2, hasSignature: true}
12:24:53 POST /api/mobile-inspection/…/complete 200
```

## 4. Artefactos de deploy (Parte 6)

- `app-dev-debug.apk`: 174 MB (debug, JIT+assets de debug — no
  representativo de release).
- `app-prod-release.apk`: **73.7 MB** (`flutter build apk --flavor prod
  --release`). **Firmado con la llave de DEBUG**: el firmado real espera
  los secretos `RIDEOPS_*` (keystore) de Hector — hasta entonces el APK
  prod no es distribuible por Play, solo instalable a mano. Verificado en
  el emulador: instala, arranca y muestra el login "v0.1.0 (prod)" sin
  banner de debug (`21-prod-release-login.png`).
- API base del build prod: sin `RIDEOPS_API_BASE` el default compilado es
  el de dev (`http://10.0.2.2:4000`) — el build de DISTRIBUCIÓN debe pasar
  el define real por CI. *Post-review (INN S-4):* `bootstrap()` ahora
  TRUENA en el primer frame si un build prod apunta a `http://` — el APK
  archivado de este pase es anterior al guard; cualquier rebuild prod sin
  el define correcto ya no llega ni al login (deliberado).

## 5. Riesgos residuales DECLARADOS (no probados aquí)

1. **Huella real sobre FragmentActivity** — el emulador no tiene biometría
   enrolada; local_auth en hardware real (y el requisito FlutterFragmentActivity)
   queda para teléfono físico.
2. **OOM de cámara en gama media física** — la síntesis del emulador no
   ejercita presión de memoria real de sensor; el guard `camera.oom_guard`
   queda sin señal de campo.
3. **Rendimiento del cifrado (SQLCipher + AES-GCM) en flash barato** — el
   host presta NVMe al emulador; medir en aparato de patio.
4. **Back gesture predictivo / navegación del sistema en hardware** — el
   candado del kiosco contra el app-switcher real se aproximó con reboot
   del emulador; teléfono físico pendiente.
5. **Kiosco-vs-exempt en vivo**: el usuario del pase NO es
   `screenLockExempt`, así que el aterrizaje forzado post-kill se validó
   con el candado normal + los 4 unit tests nuevos de la política (flag
   consumido, exempt bloqueado, exempt sin PIN → re-login, login fresco
   limpia). Un pase manual con usuario exempt real queda anotado para QA
   de M2.
6. **Contrato Docker/compose** — el pase corrió el backend nativo; el
   empaquetado del contenedor no se ejercitó aquí (lo cubre la CI de beta).

## 6. Estado final

- Suite completa: **309 tests** verdes (`flutter test`).
- `flutter analyze --fatal-infos`: limpio.
- Paridad de enums: OK (CheckoutStep 11 · HandoffTokenKind 3 · UserRole 4 ·
  InspectionPhase 2).
- openapi.json: sin cambios de contrato (el pase solo CONSUMIÓ endpoints
  existentes).
