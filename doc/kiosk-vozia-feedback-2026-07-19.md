# Kiosk → VozIA: feedback de contrato tras implementar el lado kiosk (2026-07-19)

Para el equipo/sesión de VozIA. El lado kiosk del contrato KIOSK-EMBED.md v2 está
IMPLEMENTADO (embed + postMessage + co-presencia + comandos, dark hasta que exista el
hosting prod). Dos notas de contrato que salieron del review:

## 1. `skip_step` de pasos de identidad — el kiosk lo RECHAZA (importante para el UX del agente)
El ejemplo del §3 del contrato usa `skip_step` de `license_scan` ("verifiqué manual"),
pero en RFM la verificación de identidad es **unskippable por diseño**: el gate
server-side de la firma exige `idVerifiedAt`, una columna que solo estampa un verify
real (scan/OCR confirmado, name-update con código, o staff-assist con PIN + fotos —
el ÚNICO bypass sancionado, auditado, y presencial). Un skip remoto de identidad sin
verify previo dejaría al guest PAGADO e incapaz de firmar.

Comportamiento del kiosk: `skip_step` de la familia de identidad SIN verify previo →
**rechazo cortés + ack** (el ack para el redelivery; el rechazo se muestra al guest).
Con verify ya pasado, el skip avanza normal. `signature`/`payment` se rechazan siempre
(igual que su server).

**Sugerencia para la consola del agente**: reflejar la semántica de rechazo — cuando el
kiosk rehúsa un skip, el agente debería verlo (hoy solo lo infiere porque kiosk-state no
avanza) e idealmente la consola sugiere el camino sancionado: "pide al staff on-site que
use Staff Assist en el kiosk" o "completa el check-in desde RFM y manda flow_completed".
Considerar añadir al contrato un ack extendido `{commandId, refused: true, reason}` en
una v3 — hoy el ack no distingue aplicado de rehusado.

## 2. Cierre del overlay = fin de conversación (implementado con confirm de dos toques)
Confirmado contra el contrato: `kiosk=1` = cero persistencia → cerrar el overlay mata la
conversación sin resume. El kiosk ahora pide confirmación de dos toques en el ✕ cuando
hay conversación activa (espejo de su "Empezar de nuevo" con humano en línea). Nota
operativa para agentes: si el guest cierra el chat, los comandos pendientes dejan de
entregarse (viajan en el poll del iframe) hasta el cierre server-side de 5 min.

## Estado del lado kiosk
- Ship: dark/fail-soft — sin `voziaKioskConfig` (tenant), Get Help mantiene el
  comportamiento pre-B3f. Se prende poniendo {host, widgetKey} en el admin de RFM
  (Settings del kiosk), sin re-deploy.
- Pendiente de infra (Hector): hosting prod de VozIA. El E2E real (CORS de
  kiosk-state/kiosk-ack desde el origin del kiosk, video en iPad, co-presencia en la
  consola) se prueba cuando haya host.
