# View Payments redesign — findings, capability matrix & mockup notes

Reviewer: graphic-design + innovation pass, 2026-08-30.
Deliverable: `view-payments-redesign.html` — one self-contained mockup, three tenant states (iPOS+SPIn / Authorize.Net / Stripe–Square stub). Flat, brand #8752FE, tabular-nums, 40px touch targets, 11px floor, ~30% ES label slack.

Owner's brief (verbatim intent): "A. que se vea más moderno y B. que sea funcional con lo que tiene el tenant — ya IRC no tiene Authorize.Net, so no debería ver ese botón."

Scope discipline: design only. No application code touched. Every claim below cites the real code so the build phase doesn't re-derive.

The surface: `frontend/src/app/reservations/[id]/payments/page.js` (919 lines), reached from the reservation detail's "Record OTC Payment" button (`frontend/src/app/reservations/[id]/page.js:3398`).

---

## 1. What the current screen gets wrong (file:line into `payments/page.js`)

1. **Gateway-blind Authorize.Net furniture shown to every tenant.**
   - "Reconcile Latest AuthNet Payment" button in the page header (`page.js:586-589`) — renders unconditionally.
   - "Ride Fleet will keep checking Authorize.Net automatically…" paragraph whenever `unpaid > 0` (`page.js:597-601`) — unconditional.
   - The permanent tip: "paste the raw Authorize.Net `transId` or `AUTHNET:...` into `Reference`…" (`page.js:602-604`) — unconditional, and it's debug-speak on an 8-hour-a-day screen.
   - "Charge Saved Card" + "Authorize Hold / Release Hold" group (`page.js:682-713`) — Auth.Net CIM actions, rendered for every tenant; only the *button* disable checks `cardOnFileReady` (`page.js:187`), the panel itself always shows, with copy "Save a card from an Authorize.Net payment before charging on file" (`page.js:686`).
   - The silent auto-reconcile loop even *fires network calls* against Authorize.Net for any WEB- reservation with a balance (`page.js:502-526`), gateway or no gateway.
   IRC runs `gateway:'ipos'` + SPIn; none of this can ever succeed for them.

2. **The one correctly-conditioned block proves the pattern.** The "Dejavoo Spin · Card on File" operational panel renders only when the reservation itself carries evidence (`spinState.hasCardOnFile || spinState.depositHoldActive`, `page.js:715`, derived `page.js:60-75` from `rentalAgreement.cardOnFileLast4` / `depositHoldId`). Conditioning exists in this file — it just never got applied to the Auth.Net controls.

3. **No page hierarchy: five different jobs in one column.** Order today: banner KPIs (`530-573`) → header w/ Reconcile (`575-592`) → three label-lines repeating the same three numbers already in the KPIs (`594-596`) → two static tip paragraphs (`597-604`) → deposit note (`605-615`) → manual OTC form (`617-662`) → Auth.Net action grid (`682-713`) → Spin panel (`715-844`) → history table (`846-915`). "Record what happened" (OTC form) and "make money move" (gateway charges) are interleaved, and the history — the audit trail staff consult first on a dispute — is at the bottom below two screens of forms.

4. **Total/Collected/Unpaid rendered twice** — info-tiles (`543-558`) then again as text lines (`594-596`). Pure noise.

5. **Row actions are same-weight stacked buttons**: Refund, Void · no refund, Save Card To File all equal size per row (`880-910`) — same sin the tolls redesign already retired (one primary + overflow).

6. **Blocking browser dialogs on the money path**: `window.prompt` for refund amount (`428`), `window.confirm` + `window.prompt` for void (`466-473`), `window.confirm` for Spin release/re-auth (`359`, `372`). Un-themable, and a mistyped refund amount in a prompt has no field validation.

7. **Raw gateway references shown verbatim** in the table (`879`): `IPOS:K1a2b3…`, `AUTHNET:120058x…`, `****1234 · auth A8K2X9` — no truncation, no copy affordance, no human labeling. Method column shows raw enum (`CARD`, `ATH_MOVIL`, `AUTH_HOLD` + patch chips, `870-877`).

8. **"Estimated Total" label lies when an agreement exists** — since 2026-06-08 the number is the agreement's real total (`page.js:154-169`), but the tile still says "Estimated" (`544`).

9. **Off-system styling throughout**: inline hex `#ef4444` for required asterisks (`632`, `648`, `779`), ad-hoc chip styles (`872-875`), hardcoded rgba teal for the Spin panel (`718`) — none from design tokens.

10. **`send payment link` doesn't exist here at all** — the one action that is *already* gateway-routed server-side (see §3) lives only on the reservation detail page (`[id]/page.js:1295`). The payments screen, where the balance stares at you, can't send the customer a link to pay it.

What the current screen gets right (kept in the redesign): the capability-lock pattern with iPad-visible hints instead of hover-only titles (`page.js:582-584`, `853-861` — comments explain why), the "Payment Actions off" courtesy notice with its record-a-terminal-payment promise (`669-674`), AUTH_HOLD excluded from Collected (`174-179`), the CARD last-4 audit requirement (`252-255`), AUTH_HOLD's auth-code-required rule (`259-261`), and the stale-data warning discipline (`106-141`).

---

## 2. Control → backend → gateway matrix

Every existing function, what it calls, which gateway it needs, and when the redesign shows it. Nothing is deleted; everything is conditioned and re-homed.

| # | Control (today) | Endpoint | Backend | Gateway dependency | Redesign shows when |
|---|---|---|---|---|---|
| 1 | Record OTC Payment (form) | `POST /api/reservations/:id/payments` | `reservations.routes.js:950` | **None** — DB row only | Always (all tenants, all roles — backs the lock-notice promise) |
| 2 | Payments list | `GET /api/reservations/:id/payments` | `reservations.routes.js:940` | None | Always |
| 3 | Reconcile Latest AuthNet Payment | `POST /:id/payments/reconcile-authorizenet` | `reservations.routes.js:2756` → `rental-agreements.service.js:4585` | Authorize.Net | `authorizenet` tenants only, inside "Find a missing payment" disclosure |
| 4 | Silent auto-reconcile loop (WEB-*) | same, silent | `payments/page.js:502-526` | Authorize.Net | `authorizenet` tenants only |
| 5 | Charge Card On File (saved card) | `POST /:id/payments/charge-card-on-file` | `reservations.routes.js:2774` → service `:4541` (CIM) | Authorize.Net + `customer.authnetCustomerProfileId/authnetPaymentProfileId` (`page.js:187`) | `authorizenet` + profile exists |
| 6 | Authorize Hold / Release Hold | `POST /:id/agreement/security-deposit/capture` / `release` | `reservations.routes.js:2496,2511` → service `:4779,4834` (CIM auth-only) | Authorize.Net + saved profile | `authorizenet` tenants |
| 7 | Save Card To File (row action) | `POST /:id/payments/:paymentId/save-card-on-file` | `reservations.routes.js:2743` → service `:4479` (creates CIM profile from transId) | Authorize.Net; row must have `AUTHNET:` ref (`page.js:903`) | `authorizenet` + AUTHNET: rows, in row overflow |
| 8 | Spin: Charge Card on File | `POST /:id/agreement/spin/charge-card-on-file` | `reservations.routes.js:2531` → service `:4907` (iPOS Transact CNP, tokenized) | SPIn/iPOS + `agreement.cardOnFileToken` | iPOS/SPIn tenants + card captured (existing `page.js:715` gate, kept) |
| 9 | Spin: Release / Re-Authorize Deposit | `POST /:id/agreement/spin/release-deposit` / `reauth-deposit` | `reservations.routes.js:2547,2563` | SPIn/iPOS + active hold | iPOS/SPIn tenants + hold state (existing gate, kept) |
| 10 | Refund (row action) | `POST /:id/payments/:paymentId/refund` | `reservations.routes.js:2704` → service `:5257` — **routed by the payment's own reference prefix**: `PAYARC:`→PayArc API, `AUTHNET:`→Auth.Net void/refund, anything else→negative bookkeeping row | Follows the row, not the tenant | Always, in row overflow (label says what it will do: "Refund to card" vs "Record refund") |
| 11 | Void · no refund (row action) | `POST /:id/payments/:paymentId/void-no-refund` | `reservations.routes.js:2722` | None (bookkeeping) | ADMIN only (existing), row overflow |
| 12 | Send payment link *(exists, but not on this page)* | `POST /:id/request-payment` (`reservations.routes.js:1653`) and `POST /:id/send-request-email` kind=payment (`:1681`) | Customer lands on `/customer/pay?token=…` which routes to the **tenant's** gateway: Stripe Checkout / Square link / iPOS HPP / Auth.Net hosted page (`customer-portal.routes.js:1837-1955`; iPOS mint `payment-gateway/ipos-hpp-payment.service.js:71`, fails closed `GATEWAY_NOT_CONFIGURED`) | Any configured gateway | **Added to this page** for all tenants — it is the universal "collect remotely" verb |

Gateway reference vocabulary (for history-row chips): `IPOS:` / `AUTHNET:` / `SPIN:` are the machine prefixes (`backend/src/lib/payment-references.js:31`), `SPIN_RELEASE:` marks hold releases (`rental-agreements.service.js:5070`), `REFUND:<paymentId>` marks refund rows (service `:5371` area), `PAYARC:` exists on car-sharing rows. Everything else is human-typed (last-4, auth codes, `OTC-<ts>`).

Role/capability gates that must survive: `paymentActions` capability mirrors `requireCapability('paymentActions')` exactly (`page.js:444-462` — SUPER_ADMIN bypass, explicit `true`, deliberately not fail-open `isModuleEnabled`); void is ADMIN+ (`page.js:442`); OTC record is un-gated by design.

---

## 3. Can the page see the tenant's gateway today? No — and the smallest fix

**Signals the page can already read:** `me.moduleAccess.paymentActions` (`page.js:460-461`); `row.customer.authnetCustomerProfileId/authnetPaymentProfileId` (`page.js:187`); `row.rentalAgreement.cardOnFileLast4/Brand/CapturedAt`, `depositHoldId/Amount/VoidedAt`, `securityDeposit*` (`page.js:44-75`). All are *reservation-level evidence*, not tenant config. A fresh IRC reservation with no card captured yet shows zero iPOS affordances and full Auth.Net furniture — exactly the RES-282260 screenshot.

**The tenant gateway config exists server-side** as AppSetting `tenant:<id>:paymentGatewayConfig` (`settings.service.js:511-625` defaults; `gateway` ∈ ipos/authorizenet/stripe/square, plus per-processor `enabled` blocks including `spin.enabled`, `ipos.enabled/hasHppToken/hasApiKey`). But the only read endpoint is `GET /api/settings/payment-gateway`, gated `requireRole('ADMIN')` (`settings.routes.js:404`) and it returns credential material (loginId, tpn, …) — counter staff can't and shouldn't call it.

**Smallest additive change (flagged as NEW, ~30 lines):** `GET /api/settings/payment-capabilities` — any authenticated staff, booleans only, derived from `settingsService.getPaymentGatewayConfig()`:

```json
{
  "gateway": "ipos",
  "authorizenet": { "enabled": false },
  "spin":  { "enabled": true },
  "ipos":  { "enabled": true, "linkReady": true },
  "stripe": { "enabled": false },
  "square": { "enabled": false },
  "autocharge": { "mode": "MANUAL" }
}
```

No credentials, no TPNs, no keys — safe at any role, cacheable client-side (the config changes ~never intra-session). `linkReady` = `ipos.enabled && hasHppToken` so the Send-link button can warn *before* minting fails closed. Alternative considered and rejected: embedding this in `GET /api/reservations/:id` bloats every reservation read for a per-tenant constant.

Frontend rule set (the whole point of the brief):
- `gateway==='ipos'` (± `spin.enabled`) → matrix rows 8, 9, 12; rows 3–7 never render, auto-reconcile never fires.
- `gateway==='authorizenet'` → rows 3–7, 12; Spin panel keeps its existing evidence gate (a legacy reservation with a Spin card still shows its tools — functions stay reachable).
- `gateway==='stripe'|'square'` → rows 1, 2, 10, 11, 12 only; an honest "no card-on-file actions for this processor" note (no backend exists for Stripe/Square CoF — do not draw buttons for math we don't have).
- Rows 1, 2, 10, 11 render for everyone, always.

---

## 4. The redesign — hierarchy that matches the counter

**Thesis:** the page mixes two different jobs. *Recording what already happened* (cash/ATH Móvil/terminal slip → un-gated, high-frequency) and *making money move* (charge a token, send a link, hold a deposit → capability-gated, gateway-specific). The redesign gives each a zone, in the order the counter works:

1. **Snapshot band** — Total / Collected / Balance due / Deposit hold as four tiles, once (kills the duplicate text lines). The deposit tile carries its state chip (Active · Manual / Pending / Released). "Estimated Total" becomes "Agreement total" when `hasAgreementTotals` (`page.js:163`), "Estimated total" otherwise — the label follows the data source.
2. **Collect zone** (left card) — *make money move*. Exactly one primary button, chosen by gateway + state, prefilled with the balance (keeps `page.js:196-222` prefill logic). Secondary: Send payment link (universal). Tertiary/overflow: gateway extras (find-missing-AuthNet-payment disclosure; link status). The Auth.Net auto-watch line and the iPOS link-watch line become one honest status row that names the *tenant's* processor and only appears when it can be true.
3. **Record zone** (right card) — *write down what happened*. The OTC form, always rendered, never capability-locked (Hector's standing rule, `page.js:664-674` comment preserved verbatim in spirit). Method-conditional fields kept: CARD→last-4 required, AUTH_HOLD→auth code required + explainer.
4. **Deposit band** — full-width strip: amount, state, reference, and the gateway-correct actions (SPIn release/re-auth with reason field inline — replacing `window.confirm` — or Auth.Net authorize/release). Manual holds keep their MANUAL chip and no-terminal-void copy (`page.js:786-790`).
5. **History table** — one primary action per row max, everything else in a ⋯ overflow with consequence copy ("Refund to card via Authorize.Net" / "Record refund — no card movement" / "Void · bookkeeping only"). Gateway refs render as a processor chip + truncated mono ref with copy button (honest truncation, tolls precedent). Negative rows and VOID rows visually recede.

Stolen from the tolls redesign because it earned it: one-primary-action rows, ⋯ overflow with described consequences, chips instead of raw strings, KPI strip with the dollar number an owner asks for, honest truncation, config/setup exiled from the work surface.

**Innovation additions (small, real-data only):**
- **Processor identity in the header** — a chip naming the tenant's gateway ("iPOSpays · SPIn terminal" / "Authorize.Net" / "Stripe"). Staff at multi-tenant Ride support see instantly why the buttons differ. Data: the new capabilities endpoint.
- **Payment-link state line** — after Send link, show "Link sent · expires in 2 days" from the existing `paymentRequestToken/ExpiresAt` fields already on the reservation row (`reservations.routes.js:1670-1671`) — zero new backend.
- **"Balance → one tap" default**: primary button label carries the amount ("Charge card on file · $212.40"), so the 90% case is one confirmation, no typing.

Deliberately NOT invented: partial-capture UI for holds, Stripe/Square card-on-file, payment plans, tips/surcharges — all need backend math that doesn't exist.

---

## 5. Copy, EN + ES (≈30% slack budgeted in all buttons/chips)

| Where | EN | ES |
|---|---|---|
| Zone titles | Collect the balance / Record a payment / Payment history | Cobrar el balance / Registrar un pago / Historial de pagos |
| Snapshot | Agreement total · Collected · Balance due · Deposit hold | Total del contrato · Cobrado · Balance pendiente · Depósito en garantía |
| Status chips | Balance due / Paid in full | Balance pendiente / Pagado en su totalidad |
| Primary (SPIn) | Charge card on file · $212.40 | Cobrar tarjeta guardada · $212.40 |
| Primary (AuthNet) | Charge saved card · $145.00 | Cobrar tarjeta guardada · $145.00 |
| Universal | Send payment link | Enviar enlace de pago |
| Link state | Link sent · expires in 2 days | Enlace enviado · expira en 2 días |
| Watch line (iPOS) | Watching for the payment link to be paid | Esperando el pago del enlace enviado |
| Watch line (AuthNet) | Checking Authorize.Net for a recent hosted payment | Verificando pagos recientes en Authorize.Net |
| Disclosure | Find a missing Authorize.Net payment | Buscar un pago de Authorize.Net no registrado |
| Deposit actions | Authorize hold / Release hold / Re-authorize | Autorizar retención / Liberar retención / Re-autorizar |
| Release reason | Reason (required) — e.g. clean return | Motivo (requerido) — ej. devolución sin daños |
| Row overflow | Refund to card / Record refund (no card movement) / Void · bookkeeping only / Save card to file / Copy reference | Reembolsar a la tarjeta / Registrar reembolso (sin mover dinero) / Anular · solo contable / Guardar tarjeta / Copiar referencia |
| Lock notice | Payment Actions is off for your account. You can still record a payment taken on the terminal. | Payment Actions está desactivado en tu cuenta. Aún puedes registrar un pago hecho en el terminal. |
| Stripe/Square note | This processor supports payment links only — no card-on-file actions. | Este procesador solo permite enlaces de pago — sin acciones de tarjeta guardada. |
| OTC helper (CARD) | Last 4 required · audit trail for counter swipes | Últimos 4 requeridos · auditoría de cobros en terminal |
| AUTH_HOLD helper | Authorization only — funds are not settled. Enter the auth code. | Solo autorización — los fondos no se liquidan. Anota el código de autorización. |

---

## 6. Recommendation & build order

**Build the capability endpoint first (§3) — it is the entire unlock for "B".** Then this is a presentation-layer rebuild over existing endpoints:

1. `GET /api/settings/payment-capabilities` (new, additive, booleans only) + frontend fetch alongside the existing three loads (`page.js:119-122`).
2. Gate matrix rows 3–7 on `authorizenet`, rows 8–9 on `ipos/spin` — IRC stops seeing Auth.Net furniture the same day. Kill the auto-reconcile network loop for non-AuthNet tenants (it 400s today for nothing).
3. Re-zone the page (snapshot / collect / record / deposit / history) per the mockup; add Send payment link using the existing `request-payment` + `send-request-email` routes.
4. Replace `window.prompt/confirm` with themed inline dialogs (refund amount with max validation, void reason, release reason — reason field is already inline in the Spin panel, extend the pattern).
5. Row overflow menu + reference chips + copy button.
6. Phase 2 (optional): link-state line from `paymentRequestTokenExpiresAt`; ES i18n pass using the table above.

Risk notes for the build: don't touch the Collected/AUTH_HOLD math (`page.js:174-183`) or the agreement-totals precedence (`154-169`) — both carry dated bug-fix rationale. Keep OTC recording un-gated. Keep the Spin evidence gate as an AND with the new tenant gate, not a replacement (legacy reservations with Spin cards on a tenant that later switches gateways must keep their release/re-auth tools reachable — "nothing deleted, only conditioned").
