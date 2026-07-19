# Kiosk ↔ VozIA "Get Help" — handoff al equipo del kiosk (2026-07-19)

**Contrato completo y canónico**: `voice-ai-customer-service/KIOSK-EMBED.md` (v2).
Este doc es el resumen de QUÉ construir en el lado del kiosk. El lado de VozIA
está TERMINADO y probado (S27 W-E + S28, video E2E verificado con cámara real).

## Qué hace el sistema
El botón **Get Help** del kiosk abre el chat de VozIA (Chloe, la AI) en un
iframe. Si la AI no puede, o el cliente pide humano, pasa a un agente en vivo
por chat **o videollamada** (LiveKit). El agente ve en qué paso del check-in
está el cliente (co-presencia) y puede mandarle comandos al kiosk (retry, skip,
restart, mensaje, "listo — pantalla final") e incluso **terminar el check-in
por el cliente** desde RFM (deployado en beta.328).

## Tareas del kiosk team (su lado del contrato)

1. **Botón Get Help → montar el iframe**
   ```html
   <iframe
     src="https://<vozia-host>/chat?embed=1&kiosk=1&location=<RFM locationId>&res=<RES en curso, opcional>&key=<KIOSK_WIDGET_KEY>&parentOrigin=<origin del kiosk>"
     allow="camera; microphone" />
   ```
   Sin `allow="camera; microphone"` el video NO funciona. `res` se pasa solo si
   hay un check-in en curso (Chloe lo busca proactivamente).

2. **Listener postMessage** (el iframe le pasa al shell la identidad de la
   conversación y los comandos del agente):
   - `{source:"vozia", type:"conversation", conversationId, secret}` al crear —
     y `{...conversationId:null, secret:null}` al reset/cierre → **descartar la
     identidad al instante** (un secret stale jamás puede escribir en la
     conversación del próximo cliente).
   - `{source:"vozia", type:"commands", commands:[...]}` — re-llegan en cada
     poll (~2s) hasta el ack: aplicar **idempotente por `command.id`** y ackear
     con `POST /api/conversations/:id/kiosk-ack {"commandId": N}` (header
     `x-conversation-secret`).
   - Verificar `e.origin` contra el host de VozIA; ignorar todo lo demás.

3. **Co-presencia** — en CADA transición de step del flujo de check-in, el
   shell postea `POST /api/conversations/:id/kiosk-state` (secret):
   `{flow:"checkin", step, stepNumber, totalSteps, attempts, errorCode?}`.
   `step`/`errorCode` son ENUM estrictos (texto libre = 400):
   - steps: `find_reservation · verify_identity · license_scan ·
     additional_drivers · upsells · signature · payment · done`
   - errores: `GLARE_ERROR · SCAN_TIMEOUT · CARD_DECLINED ·
     SIGNATURE_TIMEOUT · ID_MISMATCH · UNKNOWN`

4. **Aplicar los comandos del agente**:
   `retry_step · skip_step (trae reason) · restart_flow · show_message (mostrar
   message del agente) · flow_completed (→ pantalla final "aquí está tu carro")`.
   **`skip_step` de `signature`/`payment` se rechaza client-side también** (el
   server ya lo rechaza — esos pasos se COMPLETAN, nunca se saltan).

5. **Video**: lo maneja el iframe completo (botón, tile, colgar) — el shell
   solo aporta el `allow` del iframe. Nada que construir.

6. **Config**: recibir el `KIOSK_WIDGET_KEY` (sube el rate-limit de 10→60
   conversaciones/hora/IP — la tienda comparte IP NAT; sin key funciona igual
   con el límite normal).

## Gotchas
- El kiosk NO persiste nada del cliente (el iframe ya es memory-only y se
  auto-resetea a los 90s idle; el server cierra a los 5 min).
- Comandos cuyo `conversationId` no sea el activo → descartar.
- `GET /api/conversations/video-health` no le hace falta al shell (el iframe
  esconde el botón de video solo si LiveKit no está sano).

## Pendiente de infra (Hector / VozIA)
- `<vozia-host>`: VozIA aún corre en dev — el hosting prod de VozIA es un
  paso aparte antes del go-live del kiosk (envs: Supabase + LiveKit +
  KIOSK_WIDGET_KEY + RFM service account).
