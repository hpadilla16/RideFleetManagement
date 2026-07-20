# Prompt para el equipo del KIOSK — Smart lookup de confirmación (S30, 2026-07-19)

## Contexto / problema (Hector)
El cliente llega con el número de confirmación QUE LE DIO LA OTA (Expedia etc.):
`ZE40809640BA`. Pero el sistema lo tiene con el prefijo del import de su
booking-source: TL International lo mete como `TL-ZE40809640BA`. Otras fuentes
(Economy, NU, Flexways, Advantage) tienen sus propios formatos. Además a veces
NO tenemos phone/email del cliente. Resultado hoy: el paso `find_reservation`
del kiosk hace exact-match y le dice "no encuentro tu reserva" a un guest que
SÍ tiene reserva — y ahí muere el check-in autónomo.

## Qué va a existir (lo construye el workstream VozIA/S30 en el backend RFM)
**UN SOLO matcher compartido** — no inventen su propio normalizador (misma
regla que vehicle-status-sync: una sola fuente de verdad):

- `backend/src/lib/reservation-smart-match.js` (puro, unit-tested, DB-free en
  su núcleo):
  - `generateCodeVariants(raw)` → candidatos normalizados: quita/añade los
    prefijos conocidos por booking-source (`TL-`…), case-insensitive, sin
    espacios/guiones, trim de ruido OCR/teclado común.
  - `smartMatchReservation({ code?, name?, dateWindow?, tenantId })` →
    candidatos rankeados `{ reservation, matchType: "exact"|"variant"|"name",
    confidence }`. Tenant-scoped SIEMPRE. Read-only.
- El contrato exacto (firma + shape) se congela cuando S30 lo construya —
  coordinen contra este doc y revisen el lib real antes de integrar.

## Lo que implementa el KIOSK (su lado)

1. **`find_reservation` usa el matcher**: primero exact (como hoy); si falla,
   `generateCodeVariants` + búsqueda por variantes; si falla, ofrecer fallback
   por **nombre + fecha de pickup** ("¿A nombre de quién está la reserva y
   para qué día?").

2. **UX de desambiguación**: si hay varios candidatos, pedir UN dato más
   (fecha de pickup o apellido completo) — nunca mostrar una lista de reservas
   para que el guest escoja.

3. **PRIVACIDAD (regla dura)**: un match que NO fue exact-por-código muestra
   solo datos ENMASCARADOS antes del verify de identidad ("Reserva de Juan
   P*** · pickup mañana · MCO — ¿es la tuya?"). El paso `verify_identity`
   existente sigue siendo el gate para TODO detalle/avance — el matcher no lo
   relaja NADA. Nunca exponer número de confirmación completo, teléfono, email
   ni vehículo pre-verify.

4. **Anti-enumeración**: cap de intentos de lookup por sesión de kiosk (p.ej.
   5) con backoff — un kiosk público no puede ser un oráculo para enumerar
   reservas por nombre común o por fuerza bruta de códigos. Al cap: "pídele
   ayuda al staff" / botón Get Help (VozIA).

5. **Telemetría**: registrar el `matchType` que resolvió cada lookup (exact /
   variant / name / fail) — con eso afinamos los patrones de variantes con
   data real de la tienda.

6. **Get Help coherente**: si el lookup falla del todo, el botón Get Help ya
   monta el chat de VozIA con `res=` vacío — Chloe tendrá el MISMO matcher vía
   su endpoint de service account, así que el guest no repite la pelea.

## Coordinación
- El lib compartido lo entrega S30 (workstream VozIA) — arranquen su
  integración/UX en paralelo con mocks del contrato de arriba, y se amarra
  cuando el lib esté en el árbol.
- Cambios de contrato o patrones de variantes nuevos que descubran en su data
  (formatos raros de import): al doc compartido + avisar, no forks locales.
- Como siempre: additive, read-only, tenant-scoped, y el gate de identidad
  (idVerifiedAt) NO se toca.

---

# CONTRACT FREEZE — aceptado por S30/VozIA (2026-07-19)

El kiosk team mandó sus NEEDS (B3g) y S30 los acepta TAL CUAL como contrato
congelado del lib compartido `backend/src/lib/reservation-smart-match.js`:

```
smartMatchReservation({ code?, name?, dateWindow?, tenantId }) =>
  Promise<Array<{
    reservation: { id: string },   // id estable (cuid) GARANTIZADO; puede
                                   // haber más campos pero NO son contrato
    matchType: 'exact' | 'variant' | 'name',
    confidence: number             // 0–100, rank monotónico, mejor primero
  }>>
```

Garantías que S30 se compromete a cumplir (= acceptance tests del lib):
1. **Tenant-scoped duro** — jamás retorna filas de otro tenant (y el kiosk
   igual re-fetchea cada id bajo su propio scope: cinturón y correa).
2. **Read-only absoluto** — el matcher nunca escribe.
3. **Array rankeado, mejor primero**; múltiples candidatos es comportamiento
   correcto (variante ambigua → >1 booking), no error.
4. `matchType` exacto al enum; el kiosk lo usa para telemetría.
5. El kiosk corre su exact-match ANTES de llamar al lib — el trabajo del
   matcher para el kiosk es el caso `variant`. `name`/`dateWindow` son
   additive para cuando el kiosk quiera delegarlos (VozIA sí los usará).
6. Variantes nuevas descubiertas en el field → al lib compartido + este doc,
   nunca forks locales.

Seam del kiosk: `backend/src/modules/kiosk/kiosk-smart-match.js` (una línea
cuando el lib aterrice). Los detalles de PII/masking son del kiosk (el lib
solo entrega ids). Aviso al kiosk team cuando el lib esté en el árbol.
