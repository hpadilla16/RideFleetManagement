# Spike 1 — Leer el token seguro desde un isolate de background

**Estado: ANDROID PASÓ (2026-08-16, emulador API 36.1). iOS diferido (requiere Mac/dispositivo).**

## Resultado Android

Probe: `rideops/lib/spike/token_probe.dart` (workmanager 0.10.7 +
flutter_secure_storage 9.2.4 con `encryptedSharedPreferences: true`), APK dev con
`--dart-define=RIDEOPS_SPIKE1=true`.

| Caso | Resultado |
|---|---|
| A · Tarea a 15 s con la app mandada a background y el proceso **matado** (`am kill`) | ✅ `ok:true, tokenLen:195` — WorkManager relanzó el proceso headless y el isolate leyó el token |
| B · Tarea pendiente + **reboot completo** del dispositivo, sin relanzar la app | ✅ `ok:true, tokenLen:195` — el job persistió el reboot y leyó el token post-boot |

**Decisión: el drenado en background por WorkManager queda APROBADO en Android.**

Caveats honestos:
- El emulador no tiene credencial de bloqueo → el caso Direct Boot (pre-primer-unlock) no
  se ejercitó. WorkManager difiere jobs a después del primer unlock por defecto (no usamos
  `directBootAware`), así que en un teléfono real con PIN el drenado espera al unlock — es
  el comportamiento aceptable definido en el protocolo. Re-validar en aparato real (QA M1-H6).
- (Innovation, 2026-08-16) El JWT de staff dura 12 h y el refresh exige JWT vivo: el
  background solo compra el resto del turno. Jamás pasar el JWT por `inputData` de
  WorkManager (se persiste en texto plano); el isolate lo lee de secure storage — que es
  exactamente lo que este spike validó.
- iOS: BGTaskScheduler es discrecional; el camino realista es drenar-al-abrir + Keychain
  `first_unlock`. Se prueba cuando toque iOS (§9-4).

## Qué decide

Si `flutter_secure_storage` puede leer el staff JWT desde el isolate que dispara
WorkManager (Android) / BGTaskScheduler (iOS) con la app cerrada. Si NO puede en una
plataforma, el drenado en background queda condicionado ahí a que la app hidrate el token
en primer plano — el drenador (`rideops/lib/core/outbox/drainer.dart`) ya está escrito en
Dart plano precisamente para correr igual en ambos modos.

## Los fallos históricos que hay que reproducir (no asumir)

- **Android:** Keystore accesible tras reboot ANTES del primer unlock (Direct Boot) — las
  llaves con `setUserAuthenticationRequired` o file-based encryption fallan con
  `KeyPermanentlyInvalidatedException`/`BadPaddingException` en ese estado. También:
  workmanager corre en un proceso/isolate sin `FlutterEngine` completo — los MethodChannels
  de plugins funcionan solo si el plugin registra en el background engine.
- **iOS:** Keychain con `kSecAttrAccessibleWhenUnlocked` (default) NO es legible cuando el
  BGTask corre con el teléfono bloqueado — hay que probar con
  `kSecAttrAccessibleAfterFirstUnlock` explícito y verificar que el plugin lo respete en
  isolate de background.

## Protocolo (Android — ejecutable ya en esta máquina: AVD `Medium_Phone` existe)

1. Añadir `workmanager` al pubspec (solo para el probe; se decide si queda).
2. Probe: `callbackDispatcher` que (a) lee el token de `flutter_secure_storage`
   (`aOptions: encryptedSharedPreferences: true` y sin auth requerida), (b) escribe
   resultado + timestamp a un archivo plano de app-support.
3. Casos: app en foreground → background → **cerrada del task switcher** → tarea one-shot
   a 15 s; reboot del emulador CON unlock; reboot SIN unlock (`adb shell locksettings` +
   Direct Boot) — este último es el que históricamente miente.
4. Criterio de éxito: el token se lee en los tres casos. Éxito parcial (falla solo
   pre-unlock) es aceptable: el drenado espera al primer unlock (WorkManager ya difiere
   por defecto — no usar `directBootAware`).

## Protocolo (iOS — diferido)

Requiere macOS + dispositivo físico (BGTaskScheduler no es fiable en simulador). Mismo
probe con `accessibility: KeychainAccessibility.first_unlock`. Hasta correrlo, el plan
asume drenado iOS condicionado a foreground-hydration (conservador). Depende además de la
decisión §9-4 (Android-first) — si iOS se pospone al M4, este spike se corre entonces.

## Qué NO cambia según el resultado

El problema del TTL de 15 min quedó resuelto por el spike 2 (re-emisión al drenar) — este
spike solo decide DÓNDE puede correr el drenado, no si las fotos sobreviven.
