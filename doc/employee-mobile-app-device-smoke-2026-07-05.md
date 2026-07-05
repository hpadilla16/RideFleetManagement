# Employee App — Fase 0 device smoke (runbook para el main computer)

Fecha: 2026-07-05 · Rama: `feat/employee-mobile-app` · Plan: `doc/employee-mobile-app-plan-2026-07-04.md`

El laptop no tiene espacio para Xcode (29 GB libres, se necesitan ~35-40) — las pruebas
de dispositivo se hacen en el main computer. El smoke en BROWSER ya pasó en el laptop
(2026-07-05): login + bottom nav + /scan por placa + deep-link, sin errores de consola.

## Setup en el main computer (una vez)

1. `git fetch && git checkout feat/employee-mobile-app`
2. `cd frontend && npm install` (trae `@capacitor/preferences`)
3. `npx cap sync` — debe decir "Found 1 Capacitor plugin" para android e ios.
4. Xcode instalado y con sesión de Apple ID (personal team basta para correr en un
   iPhone propio; el Developer Program $99 es para TestFlight, después).
   - Si Xcode es fresco: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
     y `sudo xcodebuild -runFirstLaunch`, instalar plataforma iOS.
5. iPhone por cable + Developer Mode ON (Ajustes → Privacidad y Seguridad).

## Build iOS

```bash
cd frontend && npm run mobile:open:ios
```
En Xcode: target **App** → *Signing & Capabilities* → Team = el tuyo → selecciona el
iPhone → ▶ Run. (Android: `npm run mobile:open:android` en Android Studio, build debug.)

OJO: el wrapper carga **https://ridefleetmanager.com (PROD)**. El JWT-bridge y el error.html
de esta rama solo actúan cuando el FRONTEND deployado los incluya — para el smoke de Fase 0
eso NO bloquea: cámara, scan, login y descargas se prueban contra prod tal cual está.
Para probar el bridge/nav en el device antes del deploy: `RIDEFLEET_MOBILE_APP_URL=http://<IP-del-main>:3100 npx cap sync`
con el dev server corriendo (y `?shell=employee` ya no hace falta — el nav detecta nativo).

## Checklist Fase 0 (go/no-go del modo hosted) — apuntar TODO lo que falle

| # | Prueba | Esperado |
|---|--------|----------|
| 1 | App abre y carga el sitio | Sin pantalla blanca |
| 2 | Login empleado | Entra normal |
| 3 | Backgroundear el app 5+ min, apps pesadas en medio, volver | **Sigue logueado** (bridge) — sin bridge deployado puede fallar: anotar |
| 4 | Checkout wizard → paso de fotos → cámara | Prompt de permiso + cámara abre (getUserMedia en WKWebView) |
| 5 | Tomar y adjuntar foto | La foto queda en el paso |
| 6 | /scan → cámara (Android) / placa manual (iOS, sin BarcodeDetector) | Identifica el carro |
| 7 | Descargar contrato PDF de una reserva | ¿Abre/descarga o no pasa nada? (se espera que FALLE — es el MUST-CHANGE 3, anotar comportamiento exacto) |
| 8 | Matar el app y reabrir | Vuelve a la sesión |
| 9 | Modo avión → abrir app | Página de error branded con retry (solo si error.html ya sincronizado en el build local — sí lo está en esta rama) |

Resultados → responder en la sesión de Claude o anotar en este doc. Con 4/5 OK el modo
hosted queda confirmado y seguimos Fase 1; si la cámara falla, plan B = @capacitor/camera
detrás de PhotoCapture.jsx.

## Qué hay en esta rama (slice 1 de Fase 1)

- `frontend/src/lib/nativeShell.js` — detección de shell + bridge JWT→Capacitor Preferences
  (vía `window.Capacitor` inyectado; cero imports @capacitor/* en web).
- `AuthGate.jsx` / `client.js` — rehidratar sesión al boot, espejar en login/refresh/background,
  logout limpia el mirror.
- `EmployeeMobileNav.jsx` + globals.css — bottom nav 5 slots (Today/Rentals/Scan/Maint./More),
  SVGs, ≥44pt, module-access, dark mode. Activo en nativo o con `?shell=employee` (off: `?shell=off`).
- `/scan` — lookup QR/VIN/placa → acciones contextuales (check-in si ON_RENT, pickup si upcoming,
  perfil siempre).
- `mobile-shell/error.html` + `errorPath` — offline retry branded.
- `@capacitor/preferences@8` registrado en android/ + ios/.

## Dev local en el laptop (quedó corriendo)

Backend: `DATABASE_URL='postgresql://hectorpadilla@localhost:5432/fleet_management?schema=public' npm run dev`
(postgres de brew; Docker Desktop del laptop está roto — remanente de cask). Seed: `scripts/seed-dev.mjs`
→ `admin@dev.local / admin`, Corolla placa `DEV-001`, reserva `dev-res-001`.
Frontend: puerto 3100 (`npx next dev -p 3100`). URL smoke: `http://localhost:3100/employee?shell=employee`.
