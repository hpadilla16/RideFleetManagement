# TL International — integración v2 (requisitos recibidos 2026-08-13)

## El email de TL, verbatim

> Hi Manuel,
>
> Integration can certainly be done, but it needs to be implemented correctly
> from the outset. We cannot have a repeat of the TSD integration, which caused
> a considerable number of issues on our side and resulted in many hours of
> additional development and support work simply to keep things functioning.
>
> Any solution that we integrate with must also be fully GDPR compliant.
> Unfortunately, the way the TSD integration was implemented was not compliant
> with the standards we require.
>
> As a minimum, the integration must be capable of:
>
> * Collecting reservation and booking data directly from our servers.
> * Sending updates back to our system when the vehicle has been collected.
> * Sending an update when the vehicle has been returned and the rental completed.
> * Forwarding all documents associated with the rental back to our servers,
>   including rental agreements, customer documentation, inspection records,
>   photographs and any other relevant rental documents.
> * Ensuring that all customer and rental data is transferred and stored
>   securely and in full compliance with GDPR requirements.
>
> These are the minimum prerequisites for the integration.

## Lectura honesta

La integración actual (`backend/src/modules/integrations/tl-international/`)
scrapea `newadmin.tlinternationalgroup.com` con una cookie de sesión copiada a
mano que muere cada 30–60 min, vía Puppeteer para evadir su detección de bots.
Desde el lado de TL eso es indistinguible del problema TSD que describen: una
sesión de staff compartida, tráfico de bot en su panel admin, sin contrato de
datos, sin canal sancionado. Su email no es un rechazo — es una invitación a
hacerlo bien, con canal servidor-a-servidor y GDPR.

## Mapa: lo que piden vs lo que RFM ya tiene

| Requisito TL | Estado en RFM | Falta |
|---|---|---|
| 1. Pull de reservas desde sus servidores | Worker de sync + dedup + pending-imports tray + promoción ya existen (source-agnostic desde R0) | Sustituir el fetch-por-scraping por su API oficial (necesitamos spec + credenciales) |
| 2. Update "vehicle collected" | El checkout/finalize es un evento interno claro | Cliente outbound que notifique a TL en esa transición (patrón MEX/TollBridge) |
| 3. Update "returned / completed" | checkin-close es un evento interno claro (incl. `returnedAt` real) | Igual que #2 |
| 4. Forward de documentos | Ya existen: agreement PDF, mobile-inspection (fotos), customer docs | Pipeline de recolección + upload a su endpoint; taxonomía de documentos de ellos |
| 5. GDPR | Credenciales cifradas (integration-crypto), TLS, Supabase cifrado at rest | DPA firmado, SCCs (hosting US: DO NYC + Supabase us-east-1), política de retención/borrado, lista de subprocesadores (DO, Supabase, MailerSend) |

## Qué NO hacer

- No construir nada hasta tener su spec de API y un entorno de staging (misma
  regla que NU: one-session build cuando lleguen las respuestas).
- No prometer residencia de datos EU sin decidirlo: hoy todo vive en US. GDPR
  permite transferencia con SCCs en el DPA; si TL exige residencia EU, eso es
  un proyecto de infraestructura aparte y hay que saberlo ANTES de diseñar.

## Preguntas mínimas para TL (bloqueo de diseño)

1. Documentación de la API + base URLs (producción y sandbox/staging).
2. Autenticación: API keys, OAuth2 client-credentials, ¿mTLS? ¿Quién emite
   credenciales y cómo se rotan?
3. Pull de bookings: ¿polling con delta/paginación o webhook push de ellos?
   ¿Cadencia esperada? ¿Campo de idempotencia?
4. Spec de los updates de estado (collected / returned): endpoint, payload,
   timestamps requeridos, semántica de error y reintentos.
5. Upload de documentos: endpoint, formatos aceptados (PDF/JPEG), límites de
   tamaño, metadata requerida (booking ref, tipo de documento), y qué
   documentos consideran obligatorios vs opcionales.
6. GDPR: su DPA estándar para firmar; ¿aceptan hosting US bajo SCCs o exigen
   residencia EU?; retención esperada; flujo para solicitudes de borrado
   (right to erasure); contacto y SLA de notificación de brechas.
7. Entorno de pruebas con bookings de test + criterios de aceptación de ellos
   para go-live (que TL defina "correcto" antes de escribir código — es
   exactamente lo que pidieron con "correctly from the outset").
8. Rate limits, ventanas de mantenimiento y política de versionado/deprecación.

## Borrador de respuesta (EN) — ver conversación 2026-08-13

Enviado a Hector para revisión; fases propuestas: (1) diseño firmado por ambas
partes, (2) pull read-only en staging, (3) status updates, (4) documentos,
(5) DPA + go-live. El scraping actual se retira al completar la fase 2.
