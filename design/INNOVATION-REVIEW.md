# Innovation Review — "Make the app look like the marketing site"

Reviewer role: product-design strategy pressure-test. No implementation here.
Scope of evidence: every claim below cites a file path or a number measured in this repo on branch `release/deposit-balance-fix-beta119`.

Measured baseline (counted, not estimated):

| Measurement | Value |
|---|---|
| Inline `style={{` occurrences | **5,303** across **163** of 206 .js/.jsx files (156 .js + 50 .jsx; 213 incl. .mjs tests) |
| Worst inline-style offenders | `settings/page.js` 369 (7,460 lines), `reservations/[id]/page.js` 225 (3,761 lines), `kiosk/page.js` 127 (2,629 lines), `checkout-wizard-v2/page.js` 112, `AdvantageIntegrationPanel.jsx` 110, `FlexwaysIntegrationPanel.jsx` 110, `customer/precheckin/page.js` 106, `customer-display/page.js` 106, `vehicles/[id]/page.js` 103, `host/page.js` 101, `NuIntegrationPanel.jsx` 100 |
| `globals.css` | 1,807 lines, 352 unique class selectors, of which **100** are `.pl-*` planner classes |
| `.glass` (backdrop-blur) usages in JSX | **459** className usages; `backdrop-filter` declared in 3 files (`globals.css`, `wizard/WizardShell.jsx`, `wizard/PhotoCapture.jsx`) |
| Hardcoded brand-purple literals | `rgba(135,82,254,…)` 34× in globals.css + 56× inline in JS/JSX; `#8752FE` 21× in JS/JSX |
| `reservations/[id]/` subroutes | 13 (checkin, checkin-wizard, checkout, checkout-wizard, checkout-wizard-v2, inspection, inspection-compare, inspection-report, payments, swap, ops-view, customer-view, additional-drivers) |
| reports-v2 pages | 22 page.js files (19 reports + landing + builder + custom/[id]) |
| Mobile wrapper | Capacitor 8.2 (android/ios/core/cli in `frontend/package.json`) wrapping this exact web UI |

---

## 1. Verdict summary

| # | Question | Verdict |
|---|---|---|
| 1 | Density vs. airiness | **ADAPT** — compact-by-default for staff, marketing spacing only for customer-facing and empty states |
| 2 | Animated score ring | **REJECT** in operational chrome; ADAPT as a static arc on one report page at most |
| 3 | Floating annotation callouts | **REJECT** — the marketing page itself hides them below 1340px; anomalies already have a better in-row pattern |
| 4 | Glass → flat | **ADOPT** — the repo's own bug history already voted for flat |
| 5 | Environment survival (sun, glare, gloves) | **ADAPT** — the target fails at 6 specific points; overrides mandated in section 4 |
| 6 | Brand hue #8752FE → #7f4ff0 | **REJECT as design work** — the delta that matters is treatment, not hue; tokenize first, swap later if desired |
| 7 | One language vs. forks | **ADAPT** — one token layer, four deliberate surface forks (back-office, planner, kiosk, customer) |
| 8 | Full vs. targeted migration | **REJECT full** — targeted scope in section 6; settings/integration panels explicitly out |

---

## 2. Reasoning

### Q1 — Density vs. airiness: ADAPT

The marketing surfaces are already denser than the marketing *page* around them — `design/C-productled.html` gives the fake app 13px table cells, 11.5px chips, 28px icon buttons, while the page itself breathes at `--sec-y: 96px`. The owner is reacting to the *surfaces*, and the surfaces are close to app density already. So the honest line is:

- **Staff back-office and planner: compact is the default, and it is not optional.** The app's `globals.css` body is 14px/1.45 and the planner (`.pl-*`) runs 11–13.5px labels with 44px rows. Keep that. Concrete numbers: base font 14px, table row padding 10–11px vertical (≈40px rows, matching `table.data td` 11px in `design/design-system.css`), card padding 14–16px, grid gaps 10–12px, section gaps 16–18px. Do NOT import `--sp-24`/`--sec-y` rhythm into any staff screen.
- **Customer-facing (precheckin, sign-agreement, book, customer-display) and kiosk: marketing spacing is correct.** These are eight-second surfaces. Kiosk already does this deliberately (`kiosk/kiosk.css`: 36px h1, 60px buttons, 48px minimum targets per its Fase B3b header comment). Card padding 20–30px, 17px+ body, generous max-widths — as built.
- **Empty states everywhere get airiness**: `.pl-state` already pads 48px 24px and centers — that is the pattern; extend it, don't invent one.
- One densifying win to actually take from the target: **tabular numerals on all data surfaces** (`design/design-system.css` §2 applies `font-variant-numeric: tabular-nums` to `table, .money, .kpi…`). The app has no equivalent rule in `globals.css`. This is a five-line, zero-risk adoption that improves every report and the planner date nav.

### Q2 — The score ring: REJECT (in production chrome)

The marketing dial (`C-productled.html` lines 668–685: animated stroke-dashoffset count-up to "88 / score") earns its place on a landing page because a stranger needs one number in eight seconds. Staff do not consume their own fleet as one number. Look at the marketing card itself: the actionable content is the two chips next to the ring — "112 ready / 11 blocked (wash, fuel, maintenance)". The chips are the UI; the ring is packaging.

- A composite fleet score has **no decision attached**. "88" tells a counter agent nothing about which car to assign; the planner's suggest panel (`PlannerSuggestPanel.jsx`, `POST /api/planner/suggest` with per-vehicle score + "why") already does the per-decision version correctly, as text.
- An **animated** count-up replayed dozens of times a day is noise; the marketing page itself gates it behind `prefers-reduced-motion`.
- Rules if the owner insists: static SVG arc, no animation, only on `reports-v2/fleet-status/page.js`, and always rendered beside the breakdown table that explains it (the marketing page's own "Explainable score" callout concedes that a bare number is not trustworthy). Never in the planner, topbar, or dashboard KPI row.
- What replaces it operationally: per-vehicle **blocked-reason chips** (see Innovation C), which is what "turn-ready" actually decomposes into in this codebase — wash bars (`.pl-bar-wash`), holds (`PlannerHoldModal.jsx`), maintenance WOs (`/maintenance` module).

### Q3 — Annotation callouts: REJECT

Decisive answer: they are decorative, and the marketing page knows it — `@media(max-width:1340px){.callout{display:none}}` (`C-productled.html` line 478). A component the designer deletes on any screen narrower than 1340px cannot carry operational meaning.

- **Anomaly flags**: the planner already has the correct production-grade pattern — `.pl-dcard-overbooked` (red border + 2px ring) and `.pl-bar-pulse` on the affected element itself, plus `.pl-toast` for transient events. In-place treatment scrolls, pans, and z-indexes with the data; floating pinned bubbles on a horizontally-scrolling board (`.pl-board-scroll`) would detach from their anchors on the first pan.
- **Onboarding coach marks**: legitimate need, wrong component. Callouts pinned to live data occlude the data being learned. If onboarding is wanted, use a dismissible first-run checklist panel (the `.pl-panel` / slideover chassis exists) — not this.
- Kill entirely for customer surfaces and kiosk: `kiosk.css` is `user-select: none`, fixed-inset, and every pixel is a touch target.

### Q4 — Glass → flat: ADOPT

This is the strongest ADOPT in the review because the repo already ran the experiment and recorded the results:

1. `globals.css` lines 58–62: the translucent sticky topbar "bled through … looked like the header was covering / smearing content. Make it fully opaque." The chrome's most prominent glass surface was reverted to opaque for **legibility**, not taste.
2. `globals.css` `.button-danger` comment: "The explicit fill (not a translucent tint) keeps the contrast deterministic over `.glass` surfaces." Translucency makes every contrast ratio a function of what happens to be behind it — you cannot certify AA on a surface whose background is undefined.
3. The planner — the densest, most operationally serious screen, rebuilt 2026-07-14 — uses **zero** backdrop-filter. All 100 `.pl-*` classes are flat variable-driven surfaces with a dark theme. The newest, best screen in the app already speaks the target's language.
4. Render cost: `.glass` = `backdrop-filter: blur(14px) saturate(1.1)` and appears on **459** JSX className usages — sidebar, topbar, and essentially every content card, so a typical page composites several independent blur regions. On a mid-range Android GPU (Mali-G5x/Adreno 6xx class — exactly what a Capacitor 8.2 build of this UI ships to, `frontend/package.json`), each backdrop-filter forces an offscreen readback of the layer behind it and a re-blur on every scrolled frame; stacked over a `radial-gradient` body it is the classic recipe for sub-30fps scroll and hot devices at a counter that runs the app all day. Flat layered neutrals + borders + the target's 3-layer shadows (`--sh-1/2/3`) render as cheap cached layers.

Adopt flat fully: replace `.glass` with an opaque `--surface-1` card + `--border` + `--sh-1`, and replace the radial-gradient body with the target's flat `--n-25/--n-50` layering. Keep exactly one glass exception if any: none. (The camera overlay in `wizard/PhotoCapture.jsx` can keep its blur — it sits over video, where blur is functional.)

### Q5 — Environment: ADAPT — named failures and replacements in section 4

The rental counter and lot reality: direct sun and glare wash out low-contrast hairlines and shadows; gloves and one-handed phone use demand big targets; a customer-display monitor faces a window. Product-Led Premium as drawn fails at specific points — every one is listed with its replacement value in section 4. The short version: nothing under 11px ever; no state-bearing text below `--text-3` (5.04:1); no interactive target under 40px on staff surfaces / 48px on kiosk (which `kiosk.css` already enforces); no meaning carried by shadow or by a 1px `--n-100` hairline alone.

Notably, the target's own token sheet is honest about most of this — `design/design-system.css` annotates `--n-400` "2.21 on white, NOT text" and `--n-500` "NOT text". The mandate is to keep those annotations enforceable, and to override the places where the *marketing surfaces* cheat their own rules (10px table headers, 9.5px group labels, 28px icon buttons).

### Q6 — Brand hue: treatment, not hue. REJECT hue change as part of this work

Plainly: **the delta is purely treatment.** #8752FE (app) vs #7f4ff0 (target) is a ~3% shift in the same violet; no user will identify it in isolation. The app already straddles the two: its primary button gradient runs `#9f79ff → #8752FE`, and `globals.css` line ~369 sets `border-color: #7f4ff0` on the active mobile nav pill — both hues have coexisted in production chrome without anyone noticing.

What actually changes the perceived brand is: gradient→flat fills, 999px pills→6–11px rectangles, blur→border+shadow, and tabular numerals. Do those.

The reason hue change is rejected *now* is cost, not taste: brand purple exists as `rgba(135,82,254,…)` **34 times in globals.css plus 56 times inline in JS/JSX**, plus 21 `#8752FE` literals in components, plus `--kio-purple` and `--pl-purple` duplicating it. A hue swap today means chasing ~110 literals. Correct order: (1) collapse all literals onto one `--brand` token + alpha variants as part of the migration below; (2) then, if the owner still wants #7f4ff0, it is a one-line change. Deciding the hue before tokenizing is buying paint before building the wall.

### Q7 — Consistency vs. context: one token layer, four deliberate forks

The codebase has already forked three times, each time for a defensible ergonomic reason, and each fork is scoped cleanly (`.kio-root` fixed-inset namespace; `.pl-*` namespace with its own dark-mode variables; customer pages on their own routes). Do not flatten them. Define:

- **Shared foundation (all four)**: color ramps and semantic status colors, focus ring (adopt the target's blue `#0b63d6` — deliberately not brand purple, `design-system.css` §1.14), type stack, tabular-numeral rule, radius scale, spacing scale, dark-theme variable pattern (planner's `:root` + `[data-theme='dark']` approach, which `globals.css` documents as the fix for the 2026-07-14 "invisible primary button" scoping bug).
- **Fork 1 — staff back-office** (`AppShell.jsx` + ~40 routes): flat, compact, mouse+touch, dark mode supported.
- **Fork 2 — planner board** (`frontend/src/app/planner/`): keeps its 100-class `.pl-*` system and interaction model untouched; only its variable *values* re-point to the shared ramp. If a change breaks the planner, the change is wrong — so change the planner's inputs, never its structure.
- **Fork 3 — kiosk** (`.kio-root`): keeps 48px targets, `user-select:none`, no dark mode, oversized type; adopts only shared color/status tokens.
- **Fork 4 — customer-facing** (precheckin, sign-agreement, sign-loaner, book, customer-display): the one fork that adopts Product-Led Premium most completely — airiness, `--sh-2/3` shadows, large radii. These are the app's marketing surfaces in real life.

### Q8 — Cost honesty: REJECT full migration

Numbers first: 5,303 inline styles across 163 files; `settings/page.js` alone is 7,460 lines with 369 of them; three booking-source integration panels carry 100+ each. A "full visual migration" is a rewrite of most of 206 files, with regression risk concentrated on money paths (checkout-wizard-v2, payments, deposit handling — this branch is literally named `deposit-balance-fix`). The comment history in `globals.css` (NOTE_STYLE bug, beta.320/321 promotions of inline styles into classes) shows inline-style churn is already a known bug source; a big-bang restyle multiplies it.

Targeted scope, ordered by share of staff user-visible time (estimated from workflow centrality — reservations and the planner are the daily loop; settings/integrations are setup-time):

| Priority | Screens | Est. share of staff screen-time | Work |
|---|---|---|---|
| 1 | Token layer + AppShell chrome (sidebar, topbar, cards, buttons, chips, tables) | 100% of sessions touch it | Replace `.glass`/gradients with flat tokens; ~small CSS diff, huge reach |
| 2 | Reservations list + `reservations/[id]/page.js` + checkout/checkin wizards | ~40–50% | Highest inline-style debt on the money path; migrate opportunistically per-component, not big-bang |
| 3 | Planner | ~20–25% | Variable re-point only; zero structural change |
| 4 | reports-v2 | ~10% | Migrate `components/reports/ReportPageLayout.js` + the chart cards once; 22 pages inherit |
| 5 | Customer-facing + customer-display | low staff time, high customer eyeballs | Full Product-Led Premium treatment |
| — | Settings (7,460 lines), integration panels, tenants, kiosks admin, host/car-sharing | rare, admin-only | **Do not migrate.** They inherit the token layer's colors for free and get touched only when edited for other reasons |
| — | Kiosk visuals | — | Already correct for its environment; tokens only |

---

## 3. Keep / Kill / Adapt — component-level map of the marketing language

| Marketing element (source: `design/C-productled.html` / `design/design-system.css`) | Decision | Note |
|---|---|---|
| Layered flat neutrals (`--n-0…n-100` surfaces) | **KEEP** | Replaces radial-gradient body + `.glass` |
| Purple-tinted neutral ramp with annotated contrast ratios | **KEEP** | Adopt the annotations as law |
| 3-layer soft shadows `--sh-1/2/3` | **KEEP** | Paired with visible borders, never alone (glare) |
| Semantic surface/border/text aliases (`--surface-*`, `--text-1/2/3`) | **KEEP** | The mechanism that lets the planner dark theme unify |
| Tabular numerals everywhere | **KEEP** | Missing from app today; five-line adoption |
| Blue focus ring (`--focus: #0b63d6`) | **KEEP** | Better than app's purple-on-purple `.switch` focus |
| Radii 8–22px | **ADAPT** | App is already 12–24px; converge on the target's scale, cap staff surfaces at `--r-lg` 14px |
| Status chips (led-dot + tinted bg + border) | **ADAPT** | Keep the anatomy; raise text to 12.5px staff / 14px kiosk; keep app's uppercase or drop it, but pick one |
| Dense data table (`table.data`) | **ADAPT** | Adopt structure; replace 10px mono th with 11px `th-strong` default (see §4) |
| `.plate` mono registration chip | **KEEP** | Genuinely good; planner's `.pl-plate` is 80% there |
| Meter bars (`.meter`) | **KEEP** | For utilization cells in reports-v2 |
| Inline sparklines | **ADAPT** | reports-v2 KPI cards only (chart.js already present); never in tables or planner |
| KPI cards (`.kpi`) | **ADAPT** | Adopt for dashboard/reports; strip the gradient background |
| Score ring / animated dial | **KILL** | See Q2; at most a static arc on fleet-status |
| Floating annotation callouts | **KILL** | See Q3 |
| Gradient primary button | **ADAPT → flat** | Flat `--p-600` fill, white text (6.57:1 AA per the target's own annotation) |
| 999px pill chips (app's current `.status-chip`, `.hero-pill`) | **KILL** | Rectangular `--r-xs`/`--r-sm` chips per target |
| Glassmorphism / backdrop-blur | **KILL** | See Q4; one functional exception over live camera video |
| Radial-gradient body background | **KILL** | Flat `--n-25` |
| Ambient blur glows (`.amb`), hero grid mask | **KILL** | Marketing theater; never ship in app |
| Window-chrome dots / fake browser bar (`.app-bar .dots`) | **KILL** | It is a picture frame for screenshots |
| `⌘K` searchpill | **KEEP — by building it for real** | It is drawn in the marketing chrome but does not exist in the app; see Innovation A |
| Segmented control (`.segmented`) | **KEEP** | Planner's `.pl-seg` converges on it |
| Dark "band--ink" console variant | **ADAPT** | Use its values for the existing `[data-theme='dark']`, not as a new surface |
| Editorial grafts (giant numerals, 2px rules, chapter marks) | **KILL** for app | Marketing-page vocabulary only |
| `.badge-building` honest-placeholder chip | **KEEP** | Perfect for the app's not-yet-wired states (e.g., empty-state honesty already practiced in this codebase) |

---

## 4. Mandated environmental token overrides

These are the places the Product-Led Premium spec, applied verbatim, fails at a rental counter (sun, glare, one hand, gloves). Each row is binding.

| Failing token/component | Spec value | Failure mode | Mandated replacement |
|---|---|---|---|
| `--n-400` #b3aac9 as any glyph that carries state | 2.21:1 | Invisible in glare; spec itself says decorative-only — enforce it | State-bearing icons/text ≥ `--n-600` (5.04:1); keep n-400 for pure dividers |
| `table.data th` | 10px mono, `--text-3` on `--surface-2` = 4.67:1 | 10px at 4.67:1 is unreadable on a sun-hit counter monitor | 11px minimum, `th-strong` (`--text-2`, 8.53:1) is the *default* on operational tables; 10px/4.67 permitted only on reports-v2 desktop |
| `.chip` text | 11.5px | Sub-12px status text outdoors | 12.5px staff surfaces, 14px kiosk/customer; chip height ≥ 24px |
| `.app-side .grp` group label | 9.5px | Below any legibility floor | 11px floor app-wide — **no text below 11px, ever** |
| `.searchpill kbd`, `.callout .cl` (10–10.5px) | — | Same | Covered by the 11px floor (callouts are killed anyway) |
| `--border-subtle` (`--n-100`) on interactive containers | 1px near-white hairline | Card edges vanish in bright light; shadows wash out first | Interactive containers use `--border` (n-200) minimum; inputs/buttons `--border-strong` (n-300) or 2px, matching `kiosk.css` which already uses 2px borders throughout |
| Elevation by shadow alone | `--sh-1/2/3` | Shadows are the first casualty of glare | Every elevated interactive surface = border + shadow, never shadow alone |
| `.iconbtn` 28px, `.act` ~26px height | — | Gloves/one-hand: misses | 40px minimum hit area on staff surfaces (visual can stay 28px with padding), 48px on kiosk (already law in `kiosk.css`) and on customer mobile pages |
| `.ring .rsuf` 10px uppercase | — | Killed with the ring | — |
| Toggle (`.toggle`, app `.switch`) 38–44px wide, color-only state | — | Sun + color-vision: on/off ambiguous | Keep size ≥ 44×24; add a non-color cue (knob position is acceptable; add subtle track icon if contested) |
| Hover-revealed actions (`.pl-hold-btn` opacity 0 until `:hover`) | — | Touch devices have no hover — Capacitor build loses the affordance | On coarse pointers (`@media (pointer: coarse)`) always-visible at reduced opacity |
| Focus ring purple (app `.switch:focus-visible` uses `--brand-violet`) | — | Purple-on-purple invisible | Adopt target `--focus: #0b63d6` universally |
| Dark-mode counter use at night | — | Already handled | Keep planner's variable pattern; extend `[data-theme='dark']` coverage as screens migrate |

---

## 5. Innovations beyond the page (grounded in this repo)

### A. Real ⌘K command palette — ship the thing the marketing page only draws
- **Problem**: `C-productled.html` line 640 draws `Search plate, booking… ⌘K` in the fake chrome. The real app has no global search of any kind; `AppShell.jsx` renders ~25 NAV_ITEMS in a sidebar, and finding a reservation from, say, the tolls page means sidebar → reservations → per-page search. The marketing site is making a promise the product doesn't keep.
- **Interaction**: palette overlay (Ctrl/⌘K, and a topbar button for touch): type a plate → vehicle + its active reservation; booking code → reservation detail; customer name → customer; verbs ("check in KII873") deep-link into the wizard. Backed by one small cross-entity search endpoint.
- **Screens touched**: `AppShell.jsx` (one new component), one backend route.
- **Cost**: 1–2 weeks.
- **Success**: median time-to-open-a-reservation from a non-reservations screen; sidebar click counts drop.

### B. Reservation lifecycle rail across the 13 subroutes
- **Problem**: `reservations/[id]/` is 13 sibling routes plus a 3,761-line hub page. Staff mid-checkout bounce between payments, inspection, and the wizard with browser-back; nothing persistent tells them where in the lifecycle they are or what's owed. This is the screen fighting itself hardest in the repo.
- **Interaction**: a shared header rail in a `reservations/[id]/layout.js`: stage stepper (Reserved → Checked out → Returned → Closed), the balance/deposit figure always visible (this branch exists because deposit balance display was wrong — permanent visibility is the structural fix), and pill-links to the subroutes.
- **Screens touched**: one new layout component; subpages delete their ad-hoc back-links over time.
- **Cost**: ~1 week for the rail; incremental cleanup after.
- **Success**: page loads per completed checkout drop; fewer "wrong balance" reports of the class this branch fixes.

### C. Blocked-reason chips on the planner rail — the honest replacement for "turn-ready 88"
- **Problem**: the marketing dial aggregates what the planner already knows disaggregated: wash blocks (`.pl-bar-wash`), holds (`.pl-bar-hold`, `PlannerHoldModal.jsx`), locked rentals, maintenance. But the vehicle rail today shows only a colored dot (`.pl-dot-ok/rent/hold`); *why* a unit isn't rentable requires opening panels.
- **Interaction**: on each `.pl-rail` row, up to two 12.5px reason chips ("Wash 30m", "WO-4471", "Hold"); tap → the existing block sidepanel (`PlannerBlockSidepanel.jsx`) scrolled to the blocker, with resolve action. A header count ("11 blocked") filters the board — that is the dial's number, made clickable.
- **Screens touched**: `PlannerTrackRow.jsx`, `PlannerHeader.jsx`, data already in `usePlannerData.js`.
- **Cost**: ~1 week, front-end only.
- **Success**: measured turn gap (return → next checkout on the same unit, computable from board data) shrinks; blocked count at 9am trends down.

### D. Toll reconciliation confidence triage
- **Problem**: `tolls/page.js` (953 lines) has bulk `Auto-Match All` (`runBulkAutoMatch`, line 463) and an auto-sync dashboard ("Last Sweep Auto-Matched"), but everything the sweep *doesn't* match lands in an undifferentiated table. The marketing toll surface draws a per-row confidence indicator (`.conf` in `design-system.css`) that the product doesn't have — second promise not kept.
- **Interaction**: three buckets — auto-applied (high confidence), review (one candidate reservation, shown side-by-side with accept/reject, j/k keyboard), unmatched (needs search). Confidence = plate match quality x time-window overlap, which the matcher already computes implicitly.
- **Screens touched**: `tolls/page.js`; backend exposes the match score it already uses to decide.
- **Cost**: 1–2 weeks including backend surfacing.
- **Success**: % of crossings resolved without opening a reservation manually; minutes per 100 crossings.

### E. Live-synced customer display during checkout
- **Problem**: `AppShell.jsx` line 307 opens `/customer-display` in a second window and `customer-display/page.js` is 842 lines — the second screen exists — but the checkout wizard (`checkout-wizard-v2`, 112 inline styles) doesn't drive it. Staff physically rotate the monitor or read charges aloud; disputed-charge conversations happen after signing.
- **Interaction**: checkout wizard broadcasts step state (vehicle, dates, line items, deposit, agreement) via BroadcastChannel/localStorage to the display window; customer watches totals build, then the display flips into the existing sign-agreement surface for signature on the customer-facing screen.
- **Screens touched**: `checkout-wizard-v2/page.js` (emit), `customer-display/page.js` (render states); sign flow already exists (`customer/sign-agreement/`).
- **Cost**: ~1 week (no new backend; it's window-to-window state).
- **Success**: checkout wall-clock duration; post-signature charge disputes.

---

## 6. Recommended scope, in priority order

**Migrate (in order):**
1. Token layer: shared ramp + semantic aliases + tabular numerals + blue focus + 11px floor + the section-4 overrides, replacing `.glass`/gradients in `globals.css`. One CSS-only PR, app-wide reach, planner untouched.
2. AppShell chrome (sidebar, topbar, buttons, chips, tables) — every session, every minute.
3. Reservations list + detail + wizards — component-at-a-time, retiring their 400+ combined inline styles as they're touched; never a big-bang restyle of a money path.
4. Planner: re-point `--pl-*` variable values to the shared ramp. Nothing else.
5. reports-v2 via `ReportPageLayout.js` — one file, 22 pages inherit.
6. Customer-facing pages + customer-display: full Product-Led Premium airiness (this is where the owner's instinct is simply right).

**Do not migrate:** `settings/page.js` (7,460 lines, 369 inline styles, admin-rare), the five integration panels (100+ inline styles each, setup-time surfaces), tenants, kiosks-admin, host/car-sharing beta pages, kiosk visual language (tokens only). They inherit colors from step 1 for free.

**Never ship:** animated score dial in chrome, floating callouts, backdrop-blur on staff surfaces, window-chrome dots, ambient glows, editorial giant numerals, a standalone hue-change PR.

---

## 7. The one sentence

The marketing page's tokens, flat surfaces, and tabular numerals are a real upgrade and the planner already proves it — but the dial, the callouts, and the glass are theater, so spend the weeks on the ⌘K search and the toll-confidence queue the page *pretends* already exist, and on the reservation screen's 13 fragmented subroutes, because that is what an eight-hour user will actually feel.

---

## Owner constraints (Hector, 2026-07-26) — BINDING, additive to every verdict above

Approved the post-verdict mockups with three PRESERVATION rules. The migration
re-skins and ADDS; it never removes:

1. **Dashboard**: every existing tile survives, re-skinned. He explicitly wants
   the "Collected today" and "Pending tolls" KPIs from the mockups, and BOTH
   "Next pickups" AND "Next returns" tables stay.
2. **Planner**: the board treatment + blocked-reason chips are approved, but the
   EXISTING CALENDAR VIEW must not be lost — Board / Calendario switch in the
   topbar; the calendar view is re-skinned with the same tokens, zero
   functionality touched.
3. **Reservation page**: the lifecycle rail + always-visible balance are
   approved, but EVERY existing button and function stays (Edit / Extend /
   Payments / Swap vehicle / Inspections / Damage / Duplicate / Cancel /
   Delete / Print, memo, pricing overrides, log). Most-used in the topbar, the
   rest under an overflow menu — none deleted.

Mockups artifact (approved v2): claude.ai/code/artifact/ac930d5f-b6ab-4984-a7bd-e554a5b3b344
