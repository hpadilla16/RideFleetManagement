# Tolls module redesign — innovation review & mockup notes

Reviewer: graphic-design + innovation pass, 2026-08-28.
Deliverables: `tolls-redesign-A.html` (confidence triage lanes), `tolls-redesign-B.html` (review workbench). Both are self-contained, flat (no glass), brand #8752FE, tabular-nums, 40px rows / 11px floor / 40–48px touch targets.

Scope discipline: design only. No application code touched. Everything below cites the real code so the build phase doesn't have to re-derive it.

---

## 1. What the current screen gets wrong (file:line into `frontend/src/app/tolls/page.js`)

1. **The raw match-reason string is shown twice per row, verbatim.**
   The reservation cell appends `latestAssignment.matchReason` untranslated (`page.js:868`), and the status cell repeats it through `tollReviewHint()` (`page.js:55` → rendered at `page.js:889-893`). Staff read `currentVehicleId,agreementVehicleId,plate,sello,withinGraceWindow,multipleCandidates` as if it were prose. These are scoring-engine tokens (`backend/src/modules/tolls/tolls.service.js:1013-1097`) — debug output leaking into an 8-hour-a-day UI.

2. **Up to seven controls stacked per row, all equal weight.**
   `page.js:900-940`: Dispatched, Remove, Confirm, Post, Reset, Dispute, Waive, plus a View link — every one rendered as a same-size 0.75rem button. The one action the row actually wants (Confirm on a 92-score suggestion) is visually identical to the destructive one (Waive).

3. **No confidence signal, even though the backend ships one.**
   `serializeTransaction` exposes `matchConfidence` and per-assignment `confidence` (`tolls.service.js:726, 757`). The frontend receives it and uses it only as a boolean existence test (`page.js:210`). The auto-confirm threshold is a hard number (85 — `tolls.service.js:1082-1092`, the RES-849093 cap comments), so "how close was this to auto" is computable today and rendered nowhere. Meanwhile the marketing mock draws a `.conf` bar (`design/design-system.css:829-836`) the product doesn't have — the promise-not-kept flagged in `design/INNOVATION-REVIEW.md:195-198`.

4. **No hierarchy between a solid match and a genuine ambiguity.**
   A $1.00 toll with plate+window agreement (score 92) renders exactly like a windowless, identifier-less 41. Both say NEEDS REVIEW (`page.js:884-898`). Triage cost is paid per-row by a human instead of once by the layout.

5. **The queue — the actual work — is below four config cards.**
   Auto-sync status (`page.js:592-636`), provider credentials (`638-681`), manual import (`683-708`), bulk CSV (`710-728`) all render *above* the Review Queue (`730`). Staff scroll past credential forms 200 times a day.

6. **Status cell mixes three vocabularies.**
   A styled chip, then the raw enum `billingStatus` (`POSTED_TO_RESERVATION`, `page.js:888`), then the raw reason string again. Three renderings of "state" per cell, none ranked.

7. **Tab chips look like action buttons.**
   `page.js:761-782`: seven `<button>`s in an inline-actions row, same component as Refresh next to them. Navigation and mutation are indistinguishable.

8. **Blocking browser dialogs for notes and bulk confirm.**
   `window.prompt` for dispute/waive/reset notes (`page.js:362`), `window.confirm` for bulk (`page.js:474`). Un-themable, un-cancelable-safely, and they freeze the tab.

9. **Off-palette inline hexes.**
   Auto-Match All is `#166534`, Confirm All is `#1d4ed8` (`page.js:746, 751`) — neither is in the design system; the brand action color is purple.

10. **Unmatched rows get a bare text input** (`page.js:876-882`) with no lookup assist, for the task that most needs one.

11. **Dead code observed (not a design issue, flag for cleanup):** `alerts` is fetched (`page.js:174-176`) and `acknowledgeAlert` defined (`245-255`), but nothing in this file renders alerts — the TollBridge "peajes por cobrar" bandeja appears to have lost its UI.

12. **CSV export doesn't exist.** The queue has bulk *import* only (`page.js:710-728`); no export route exists in `tolls.routes.js`. Both mockups draw the Export CSV button the brief requires — it's a small new backend endpoint, noted here so it isn't mistaken for an existing feature.

The truncation notice (`page.js:783-789`) is the one thing the current screen gets *right* — honest about the 200-row window vs database counts (the 19→21 climbing-queue lesson, `page.js:212-216`). Both mockups keep it, compressed to one line.

---

## 2. The reason-token → human chip map

Tokens from `tolls.service.js` scoring (`scoreCandidate`, lines ~1013-1110) and the no-candidate paths (lines ~1160-1210). Chips carry tone: **ok** (supports the match), **warn** (weakens/complicates), **bad** (disqualifies or blocks). Spanish strings included since the team operates EN/ES.

| Token | Points | Chip label (EN) | Chip label (ES) | Tone |
|---|---|---|---|---|
| `vehicleResponsibilityWindow` | +70 | Vehicle responsible at that time | Vehículo responsable en ese momento | ok |
| `plate` | +25 | Plate match | Tablilla coincide | ok |
| `tag` | +20 | Toll tag match | Tag coincide | ok |
| `sello` | +20 | Sello match | Sello coincide | ok |
| `currentVehicleId` | +15 | Reservation's current vehicle | Vehículo actual de la reserva | ok |
| `agreementVehicleId` | +10 | Vehicle on rental agreement | Vehículo del contrato | ok |
| `withinTripWindow` | +25 | Inside rental window | Dentro del período de renta | ok |
| `effectiveVehicleTripWindow` | +20 | Trip & responsibility windows agree | Ventanas de viaje y responsabilidad coinciden | ok |
| `multiSignalOverride` | — | Multiple strong IDs agree | Varios identificadores fuertes coinciden | ok |
| `withinGraceWindow` | +10 | Grace window only | Solo ventana de gracia | warn |
| `dispatchConfirmationRequired` | cap 79 | Before formal checkout | Antes del checkout formal | warn |
| `noStrongIdentifier` | cap 79 | No plate / tag / sello | Sin tablilla / tag / sello | warn→bad |
| `multipleCandidates` | −10 / −30 | N possible reservations | N reservas posibles | warn |
| `vehicleNotOnRentalAtThatTime` | =0 | Different vehicle on rental (swap) | Otro vehículo en la renta (swap) | bad |
| `vehicle-not-found` | — | Vehicle not in fleet | Vehículo no está en la flota | bad |
| `vehicle-outside-location` | — | Vehicle outside this sede | Vehículo fuera de esta sede | bad |
| `vehicle-found-no-reservation-window` | — | Vehicle found, no rental at that time | Vehículo sin renta en ese momento | warn |
| `multiple-vehicles-no-reservation` | — | Multiple vehicles, none on rental | Varios vehículos, ninguno en renta | warn |
| `vehicle-found-no-responsibility-window` | — | Outside responsibility window | Fuera de la ventana de responsabilidad | warn |
| `manual-review` (fallback) | — | Needs manual review | Requiere revisión manual | warn |
| `manual-confirmed` / `bulk-confirmed` / `dispatch-confirmed` | — | Confirmed by staff | Confirmado por el personal | ok |
| "Covered by prepaid toll package" | — | Covered by toll package | Cubierto por paquete de peajes | info |

Rendering rules used in both mockups:
- Show at most **3 chips inline**, strongest signals first (identifier matches, then windows, then penalties); overflow behind "+N more" which opens the evidence view.
- The `multipleCandidates` chip should interpolate the real count when the backend can supply it ("2 possible reservations").
- Never show the raw comma string anywhere in the queue. It can survive in the evidence drawer as a `title` attribute / debug row for support calls.

---

## 3. Direction A — Confidence triage lanes (`tolls-redesign-A.html`)

**Thesis:** keep the table, fix the architecture. The page's information architecture becomes the triage itself.

What changes:
- **Left lane rail** groups the existing six views (plus All) under three confidence headings: *Confident — no eyes needed* (Auto-matched, Ready to post, Usage only), *Needs eyes* (Needs review, Dispatch review), *No match found* (Unmatched). Every current tab remains a single click; the grouping is pure presentation, driven by the same `queueCounts` from the database.
- **Match column** = `.conf` bar + score number (green ≥85, amber 40–84, red <40) + up to three human chips. The evidence drawer (per row, keyboard `E`) shows the full score ledger with real points, the identifier grid (toll read vs vehicle on file), and the toll plotted against the rental window.
- **One primary action per row**, chosen by state: Confirm / Dispatched / Post / Review / Assign. Reset, Dispute, Waive move to a ⋯ overflow with descriptions ("Opens an Issue Center case"). View reservation is an icon button.
- **Selection + footer bulk bar** (confirm/waive selected with dollar total) replaces the eligible-only guesswork of the current Confirm All — which itself stays in the toolbar, with its count.
- **Setup exile:** provider credentials, auto-sync stats, manual import, CSV import, and import-run history move to an "Imports & sync" secondary tab (screen 2 of the mockup shows all of them). The queue owns the landing view.
- KPI strip adds one number the current tiles miss: **Pending to post in dollars** — the number an owner actually asks for.

What's deliberately kept: search, status filter, Review-only toggle, Refresh, Auto-Match All, Confirm All (count), CSV import, the truncation notice, the `?view=` deep-link behavior (lanes are the same views), tenant scope selector for SUPER_ADMIN, the module-disabled notice pattern, dispute→Issue Center linkage.

## 4. Direction B — Review workbench (`tolls-redesign-B.html`)

**Thesis:** the queue is not a table, it's a decision stream. Optimize decisions per minute.

What changes:
- **Master list grouped by reservation.** Eight crossings by the same renter are one decision: the group header shows customer, unit, window, toll count, dollar total, and the group's *minimum* confidence; "Confirm 3" commits the batch. Ungroupable tolls fall into an explicit "No reservation found" group at the bottom.
- **One-line 40px toll rows**: time, plaza, confidence dot + score, amount. No wrapped text, no buttons in rows.
- **Evidence pane** (right) for the focused toll: amount + provenance header, identifier comparison table, the score ledger ("Why 92 — the matcher's arithmetic"), the rental-window timeline, and — new — the *losing candidate explained* ("previous renter, window ended before this toll"), which is the exact doubt behind the RES-119005 mis-billing.
- **48px action bar**: Confirm → bill {customer} / Reset / Dispute… / Waive… / View reservation, each with its shortcut. Full keyboard loop: J/K tolls, ⇧J groups, C confirm, ⇧C confirm group, D/W with a proper note dialog.
- All six views compress into a segmented control; every toolbar function from A is present.

Trade-offs, honestly: B is a bigger build (grouping endpoint or client-side grouping over the 200-row window; group-confirm semantics vs the existing `bulk-confirm` API — the API already takes `ids[]`, so group-confirm is a client concern), and grouping fights the "most recent 200" cap (a group may be split across the window). B is also worse on a narrow counter monitor; A degrades more gracefully.

## 5. Recommendation

**Ship Direction A as the redesign; treat Direction B's evidence pane as phase 2.**

- A is a presentation-layer change over data the API already returns (`matchConfidence`, `matchReason`, `queueCounts`) — near-zero backend work beyond the CSV export endpoint. It retires every named sin (raw string, stacked buttons, no confidence, config-above-queue) in one step, and it *is* the adopted "3-bucket confidence triage" from INNOVATION-REVIEW made literal.
- B's genuinely new ideas — reservation grouping, the score ledger, the losing-candidate explanation, the keyboard loop — graft cleanly onto A: A's evidence drawer is B's evidence pane in embryo, and a "group by reservation" toggle can land on A's table later without another redesign.
- For the owner's stated goal ("más fácil de utilizar y mucho más moderno") A delivers the visible modernization immediately and keeps the table mental model 8-hour staff already trust; B changes how the job is done and deserves its own validation with the counter team before it becomes the default.

Build order suggestion: A's queue + lanes + chips + overflow menu → replace `window.prompt/confirm` with themed dialogs → Imports & sync tab split → CSV export endpoint → A's evidence drawer with B's ledger/timeline → measure, then pilot B's grouping + keyboard loop behind a toggle.
