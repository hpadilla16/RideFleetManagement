# Employee Mobile App (iOS + Android) — Plan end-to-end

Fecha: 2026-07-04 · Owner: Hector · PM: Claude (workflow multi-agente CLAUDE.md)

## Goal

App iOS + Android para **empleados de los tenants** que complemente las operaciones de
piso: cola de pickups/returns del día, checkout/check-in con fotos, scan de vehículo
(QR/VIN/placa), inspecciones de daño, maintenance/ROs, y **notificaciones push**
(reserva nueva, inspección por revisar, return overdue, RO asignado).

## Acceptance criteria

1. Un empleado instala la app (TestFlight/Play testing), hace login una vez, y la sesión
   persiste entre días (sin logouts aleatorios; re-entrada biométrica opcional después).
2. Desde el teléfono puede completar: ver su cola del día → escanear un carro → correr
   checkout/check-in completo con fotos, fuel en octavos y odómetro → inspección con
   diagrama → cerrar. Sin tocar una laptop.
3. Recibe push cuando: se crea/asigna una reserva de su location, hay inspección por
   revisar, un return está overdue, o se le asigna un RO. Tap → deep-link a la pantalla.
4. Los módulos visibles respetan module-access por persona (beta.212) — maintenance/
   citations/etc. se ocultan si no los tiene.
5. Descargas (contrato PDF, reportes) funcionan dentro de la app (share sheet / browser).
6. Cero lógica nueva de dinero: los wizards reusan la state machine y el fee-engine
   existentes tal cual.

## Decisión de arquitectura (Innovation review 2026-07-04 — APPROVED, con MUST-CHANGE)

**Retomar el wrapper Capacitor 8 existente** (Sprint 9, marzo 2026: `frontend/capacitor.config.js`,
`frontend/android/`, `frontend/ios/`, appId `com.ridefleet.mobile`, assets script, guías de
TestFlight/Play). Modo **hosted** (`server.url = https://ridefleetmanager.com`) — una sola base
de código, deploys del frontend actualizan la app sin re-submission. Descartados: Expo/RN
(reescribir wizards/scanners ya probados — inviable en velocity), PWA pura (push iOS débil,
sin distribución managed), empezar de cero (reproduciría el mismo scaffold).

Plan B documentado (solo si Apple rechaza hosted): static export (`output:'export'` — viable,
no hay next.config/API routes/middleware) + Capgo live-updates. Reversal = un cambio de config.

### MUST-CHANGE de Innovation (prerrequisitos de store)

1. **Bridge nativo del JWT**: WKWebView desaloja localStorage bajo presión → logouts
   aleatorios. Con `Capacitor.isNativePlatform()`, espejar `fleet_jwt`/`fleet_user` a
   Capacitor Preferences en login y rehidratar al boot. Touch point: `frontend/src/lib/client.js`.
2. **Push notifications como capability nativa** — es a la vez el feature estrella y la
   defensa contra Apple Guideline 4.2 (un wrapper sin funcionalidad nativa = rechazo).
   Unlisted distribution NO salta el review.
3. **Descargas en WebView**: contrato PDF, inventory reports, export.xlsx — WebView no
   maneja Content-Disposition/blob. Rutear por `@capacitor/browser` / filesystem + share sheet.
4. **Gate on-device de cámara**: getUserMedia (checkout/inspecciones) verificado en iPhone
   y Android reales ANTES de invertir más. Fallback si falla: `@capacitor/camera` detrás de
   `PhotoCapture.jsx` (ya es un wrapper único).
5. **Disciplina de version-skew de plugins** (modo hosted): set mínimo de plugins, feature
   detection (`Capacitor.isPluginAvailable()`), bumps de plugin = como migración (web deploy
   retrocompatible primero). Documentar junto a la regla del FILES[].

## Estado actual (Explore 2026-07-04)

- Wrapper: Capacitor 8.2 core-only (sin plugins), android/ (SDK 36, gradle 8.13, versioning
  por env) + ios/ generados, `mobile-shell/index.html` placeholder, `.well-known` app-links
  servidos por env vars, `scripts/generate_mobile_brand_assets.py`.
- Superficies web ya móviles: `/employee` hub (MobileAppShell), checkout/checkin wizard v2,
  inspecciones (getUserMedia + diagramas), `/vehicles/inventory-helper` + VehicleScanner
  (BarcodeDetector→zxing fallback), `/maintenance` (table-heavy — necesita cards móviles).
- Auth: localStorage JWT + Bearer (sin cookies → sin problemas ITP en WebView). Auto-refresh.
- Push: **cero infra** en backend (hoy email/SMS). Net-new.
- BarcodeDetector NO existe en WKWebView iOS → hoy cae a zxing (lento en PDF417); upgrade
  nativo `@capacitor-mlkit/barcode-scanning` en Fase 3 (manteniendo zxing como fallback).

## Fases

### Fase 0 — Gate técnico (go/no-go del modo hosted)
- `npm run mobile:sync`, build debug en device real (iPhone + Android).
- Smoke: login, sesión tras backgrounding, cámara getUserMedia en wizard/inspección,
  scan QR/VIN, descarga de contrato PDF.
- Salida: lista de qué funciona/qué no → confirma Fase 1.

### Fase 0 — estado 2026-07-05
- Mockups v2 APROBADOS por Hector. `npx cap sync` corre limpio.
- BLOQUEO de device smoke: este Mac no tiene Xcode ni Android Studio — Hector debe
  instalarlos (Xcode del App Store; Android Studio de developer.android.com) para el
  gate on-device (cámara/scan/login/descargas).

### Fase 1 — App shell de empleado + hardening (TestFlight internal + Play closed testing)

**Slice 1 CONSTRUIDO 2026-07-05 (pendiente review Innovation/GD del built + QA gate):**
- `frontend/src/lib/nativeShell.js` — detección del shell (nativo o `?shell=employee`/`?shell=off`
  para QA en browser) + bridge de auth a Capacitor Preferences vía `window.Capacitor` inyectado
  (cero imports de @capacitor/* en código web = sin version-skew).
- MUST-CHANGE 1 (JWT bridge): AuthGate rehidrata de native storage ANTES de leer localStorage,
  espeja tras login/refresh y al backgrounding; `clearStoredAuth` limpia el mirror (client.js).
- `@capacitor/preferences@8` instalado y sincronizado en android/ + ios/ (1 plugin registrado).
- Offline shell: `mobile-shell/error.html` (branded, auto-retry con probe) + `server.errorPath`
  en capacitor.config.js.
- `EmployeeMobileNav` (bottom bar 5 slots, SVG inline tintables, gating por module-access,
  "More" abre el drawer existente) integrado en AppShell; estilos en globals.css
  (hit areas ≥44pt, labels 11px, safe-area iOS, dark mode).
- `/scan` page nueva: lookup-mode (QR perfil / VIN code-39 / placa manual) contra la flota,
  acciones contextuales por estado (ON_RENT → check-in wizard; upcoming → pickup; siempre →
  perfil/damage history). BarcodeDetector con fallback a placa (iOS WKWebView sin detector
  hasta ML Kit en Fase 3).
- `next build` compila limpio (/scan 2.94 kB); preview en browser sin errores de consola.

**Slice 1 pendiente:** pantalla Home "Today" phone-first del mockup A2 (hoy el tab Today aterriza
en /employee existente), estados D1-D3 (cola de fotos offline, empty state, resume card),
MUST-CHANGE 3 (descargas PDF/Excel en WebView).
- **UI**: modo "app shell" para empleados en el frontend (bottom nav 5 tabs: Today /
  Rentals / **Scan** central / Maintenance / More), pantallas phone-first según mockups
  `doc/employee-mobile-app-mockups-2026-07-04.html` (requiere aprobación de Hector).
  Detección `Capacitor.isNativePlatform()` (o `?shell=employee`) para activar el shell.
- MUST-CHANGE 1 (JWT bridge), 3 (descargas), 5 (skew) + offline/retry shell + app-resume
  refresh (`@capacitor/app` appStateChange → refetch de la cola).
- Scan contextual: escanear → acciones según Vehicle.status + reserva activa.
- Piloto: staff de Manuel Shop / International.

### Fase 2 — Push end-to-end (milestone de store review)
- Backend: modelo `DeviceToken` (userId, tenantId, platform, token, lastSeenAt — migración
  aditiva), `POST /api/push/register` (auth existente), fan-out `firebase-admin` (FCM v1;
  APNs vía FCM) enganchado a los mismos event points de los emails branded.
- Eventos v1: reserva creada/asignada (por location), inspección por revisar, return
  overdue, RO asignado.
- Frontend: `@capacitor/push-notifications`, registro post-login, deep-links
  (`pushNotificationActionPerformed` → ruta), Universal/App Links con los env vars ya
  soportados (`RIDEFLEET_ANDROID_SHA256_CERT_FINGERPRINTS`, `RIDEFLEET_APPLE_TEAM_ID`).

### Fase 3 — Scanning nativo + distribución amplia
- `@capacitor-mlkit/barcode-scanning` detrás de isNativePlatform() (mayor ganancia: PDF417
  de licencias en iOS); cadena BarcodeDetector→zxing queda como fallback web.
- iOS: solicitar **Unlisted App Distribution** (link-only, sin listing público; pasa review
  completo; el request tiene su propia cola — someter temprano). Android: Play closed
  testing por lista de emails → production. (Managed Play descartado: exigiría cuentas
  Google managed en cada tenant.)
- Store metadata: privacy nutrition labels / Data Safety (cámara + PII — no triviales).

### Fase 4 — Training (Step 7 del workflow)
- Tutorial PDF branded (español, pantallas anotadas de los mockups) → `training/` + INDEX.

## Gates del workflow
- Innovation review (2026-07-04): **APPROVED** — retomar wrapper Capacitor; MUST-CHANGE 1-5
  incorporados como prerrequisitos arriba.
- Graphic Design review (2026-07-04): v1 MUST-CHANGE (legibilidad/contraste, touch targets,
  estados no-felices, back/cancel) → corregidos → **v2 SIGN-OFF (OK)**. Notas para QA del
  build: (a) enforce texto funcional ≥11px/contraste 4.5:1 también en chips/labels del build
  (badge counts exentos); (b) mantener la regla honesta de offline — fotos se encolan pero el
  submit de un step del wizard requiere conexión (integridad de la state machine > heroísmo
  offline).
- Mockups v2 → **aprobación de Hector: PENDIENTE** (gate antes de cualquier build).
- Cada fase: Innovation + Graphic Design review → QA SHIP → deploy (ship script atómico,
  env-diff-check, verificación post-deploy).
- Money code intacto (regla dura): wizards reusan lógica existente; nada de auto-fix en
  payment paths.

## Riesgos
- Apple 4.2 pese a push nativo → Plan B bundled+Capgo (bajo costo de reversa).
- Cámara getUserMedia con regresión en algún iOS → fallback @capacitor/camera vía PhotoCapture.
- Version-skew hosted (plugin JS vs shell instalado) → regla de deploy retrocompatible.
- Keystore de upload de Android: crear y respaldar (`ridefleet-upload-key.jks`) — no perderlo.
