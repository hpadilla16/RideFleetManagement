# UI Migration — Product-Led Premium (as adapted by design/INNOVATION-REVIEW.md)

Status: **complete through Phase 6** (2026-07-26). One local commit per phase.

Binding verdict: `design/INNOVATION-REVIEW.md` (including the owner constraints
section). Where this doc and the review disagree, the review wins.

---

## Phase 0 — Audit (measured 2026-07-26, this branch)

| Measurement | Value |
|---|---|
| Inline `style={{` occurrences | 5,312 across 163 of ~206 .js/.jsx files |
| Worst offenders | settings/page.js 369 · reservations/[id]/page.js 225 · kiosk/page.js 127 · checkout-wizard-v2 113 · Mex/Flexways/Advantage panels 110 each · precheckin 106 · customer-display 106 · vehicles/[id] 103 · host 102 · NuIntegrationPanel 100 |
| globals.css | 1,807 lines · 280 top-level class selectors · 99 `.pl-*` planner classes |
| `.glass` className usages in JSX | 454 (excl. kiosk) |
| Brand-purple literals | `rgba(135,82,254,…)` 34× globals.css + 71× inline JS/JSX; `#8752FE` 21× JS/JSX |
| Verification limitation | No local backend: screens render chrome + honest empty/error states behind a fake JWT. Data-rich states verified via Playwright API mocking where practical. |

Before screenshots: `design/screenshots/before/` (1440×900, EN; dashboard,
planner, reservations list, reservation detail, fleet-status, vehicle detail,
kiosk).

---

## Mapping table — old token/class → new → note

### Tokens (`:root`)

| Old | New | Note |
|---|---|---|
| `--brand-purple: #8752FE` | `--brand: #8752FE` (kept; `--brand-purple` aliases it) | Review Q6: hue change REJECTED; tokenized so a later swap is one line |
| `--brand-violet: #6d3df2` | `var(--p-700)` #5a26c9 | Accent/link text, 8.22:1 AAA on white |
| `--brand-mint / #1fc7aa` | kept only as planner wash color | Not a system color anymore |
| `--bg-soft / body radial-gradient` | flat `var(--n-50)` body | Review: radial body KILLED |
| `--bg-soft-2` | `var(--n-25)` | |
| `--border-soft: #e6dfff` | `var(--border)` = `--n-200` | Interactive containers ≥ n-200 (glare mandate) |
| `--border-strong: #d7cbff` | `var(--border-strong)` = `--n-300` | Inputs/buttons |
| `--ios-surface (rgba .88)` | `var(--surface-card)` = `--n-0` opaque | Glass KILLED |
| `--ios-surface-2` | `var(--surface-2)` = `--n-50` | |
| `--ios-text: #1f1f28` | `var(--text-1)` = `--n-900` | |
| `--ios-muted: #6f668f` | `var(--text-3)` = `--n-600` #736a8b | 5.04:1 AA floor for meta text |
| `--ios-ring rgba(135,82,254,.2)` | `var(--focus-halo)` rgba(11,99,214,.22) | Focus is BLUE #0b63d6 everywhere (review §4) |
| `--ios-shadow / -hover` | `var(--sh-1)` / `var(--sh-2)` | Always paired with a visible border |
| `--ios-radius 16 / -lg 20` | `--r-md` 11 / `--r-lg` 14 | Staff surfaces capped at 14px (review Q on radii) |
| (new) | full `--n-*`, `--p-*`, `--ok/warn/danger/info` sets, `--sh-1/2/3`, `--r-*`, `--focus` | Imported from design/design-system.css §1 |

### Classes (names unchanged — values re-pointed)

| Class | Old rendering | New rendering | Note |
|---|---|---|---|
| `.glass` | translucent + backdrop-blur 14px | opaque `--surface-card`, `--border`, `--sh-1` | Q4 ADOPT flat; 454 JSX usages restyled with zero JSX change |
| `body` | radial purple/mint gradients | flat `--n-50` | |
| `.topbar` | translucent gradient | opaque `--n-0`, border, `--sh-1`, radius 14px | Bleed-through bug history honored |
| `.sidebar` | gradient, 24px radius | flat `--surface-1`, border, 14px radius | |
| `.nav-link` | purple tint pill 14px | `--r-sm` 8px, active = `--p-50` bg + `--p-800` text, inset brand border | Matches target `.app-nav.is-on` |
| `button` (global) | purple gradient + heavy glow | flat `--p-600` fill, white text (6.57:1), `--r-md`, `--sh-1` | Component map: gradient → flat `--p-600` |
| `.button-subtle` | purple-tint pill | `--n-0` bg, `--border-strong`, `--text-1` | Target `.btn--secondary` anatomy |
| `.status-chip` (+good/warn/neutral) | 999px pill, 11px | rectangular `--r-sm`, **12.5px**, ≥24px tall, semantic `--ok/warn` sets | 999px pills KILLED; 12.5px staff floor |
| `.badge`, `.hero-pill`, `.app-banner-pill`, `.legal-link-pill`, `.mobile-app-shell-link` | 999px pills | `--r-sm` rectangles, semantic tints | Same kill |
| `.card / .card-lg` | 16/20px radius, hover lift | 12/14px radius, border + `--sh-1`, hover = `--sh-2` (no translate) | |
| `table` th | purple-grey gradient, 13px | `--surface-2` flat, 11px strong (`--text-2`, 8.53:1), mono-caps | §4: 11px minimum, th-strong default |
| `table` td | 13px | 13px, `--text-2`, `--border-subtle` rows, **tabular-nums** | |
| `.table-shell` | translucent gradient | `--n-0`, `--border`, `--r-lg` | |
| `.value`, `.metric-card strong` | 30px/24px | same size + `tabular-nums`, `--text-1` | |
| `.label`, `.eyebrow`, `.nav-section-label` | 11px purple/grey caps | 11px, `--text-3` / `--p-700` | 11px floor kept |
| input/select/textarea | 14px radius, purple focus glow | `--r-md`, `--border-strong`, blue focus outline + halo | §4 focus mandate |
| `.switch` | purple gradient ON, purple focus | flat `--p-600` ON, blue focus ring | |
| `.modal-backdrop`, `.rent-modal`, `.detail-drawer` | glass surfaces | opaque `--surface-card`, `--sh-3` + border | |
| `.pl-*` (99 classes) | own light values | **variable re-point only**: `--pl-bg→--n-0`, `--pl-bg-soft→--n-25`, `--pl-bg-group→--p-50`, `--pl-line→--n-100`, `--pl-border→--n-200`, `--pl-border-strong→--n-300`, `--pl-ink→--n-900`, `--pl-muted→--n-600`, `--pl-violet→--p-700`, `--pl-purple→--brand`, `--pl-ok/warn/bad→--ok/--warn-fill/--danger` | Review fork 2: change inputs, never structure |
| `.pl-bar-locked::before "🔒"` | emoji | inline-SVG data-URI padlock | No-emoji rule |
| `.screenlock-*`, auth intro animation | unchanged | unchanged | Out of scope (not one of the four forks' daily surfaces) |
| kiosk (`.kio-*`, kiosk.css) | unchanged | unchanged except shared color token values | Fork 3: tokens only, nothing shrinks |

### New additive components (safe to use in new work)

`.tnum` (tabular numerals), `.chip` + `.chip--ok/warn/danger/brand/neutral`
(rectangular led-dot chips), `.kpi/.klab/.kval/.kfoot` (flat KPI card),
`.plate` (mono registration chip), `.th-strong`, `.meter` (utilization bar),
`.badge-building` (honest placeholder).

---

## What changed, per phase

- **Phase 1 — Token layer (globals.css only, no JSX).** New `:root` imports
  the ramps/aliases/shadows/radii from `design/design-system.css` §1 with the
  review's environmental overrides baked in. Every legacy token name
  (`--brand-purple`, `--ios-*`, `--bg-soft`, `--border-soft`…) aliases into
  the new system, and every class kept its name: `.glass` is now an opaque
  `--surface-card` plate + `--border` + `--sh-1`; the body radial gradient is
  a flat `--surface-0`; the global `button` is a flat `--p-600` fill; chips
  and pills are rectangles at 12.5px; tables get 11px strong mono-caps heads,
  `--border-subtle` rows and tabular numerals; focus is blue app-wide. The
  planner `.pl-*` system was re-pointed strictly by variable values.
- **Phase 2 — Chrome.** Topbar/ sidebar restyle came free from Phase 1;
  AppShell's fighting inline styles became classes (`.topbar-display-btn` on
  the ok set, `.topbar-lang-btn`, `.nav-link-disabled`) and the `☰` glyph is
  an inline SVG. MobileAppShell needed no JSX change.
- **Phase 3 — Data surfaces.** `components/reports/ReportPageLayout.js`
  (all 22 reports-v2 pages inherit) moved from inline beige/emoji styling to
  `.report-*` token classes with SVG icons and 40px targets. WizardShell's
  translucent blurred sticky action bar went opaque.
- **Phase 4 — The five screens.** Dashboard: semantic `--danger`/`--ok`
  tokens for the alarm tiles, `var(--charcoal)` (undefined) → `--text-1`,
  checked-in pill → `.status-chip good`, returns accent → `--teal-tx`, 10px
  chip text raised to the floor. Fleet-status: fully re-pointed (KPI cards →
  `.kpi`, status pills → `.chip` variants, plates → `.plate`, shell →
  `.table-shell`, token skeleton). Reservation + vehicle detail: 999px pills
  → 6px rectangles, 10px → 11px, purple-tint buttons → secondary anatomy,
  admin-override chip → danger set — every existing button and function
  preserved. Planner: nothing needed beyond Phase 1 (board AND calendar
  views verified structurally untouched, re-skinned via variables).
- **Phase 5 — Verification.** Playwright matrix (5 screens × 1440/768/390 ×
  EN/ES + dark + kiosk) actually reviewed; three dark-mode bugs found by
  looking and fixed (`:where()` on the dark button rule so classed surfaces
  win; `--brand-ink/--brand-charcoal` → `--text-1` so brand text inverts;
  dark re-points `--n-0..300` band--ink-style plus `--brand-tx`/`--teal-tx`
  text tokens). `npm run build` green.

## Rules for new screens

1. **Never hardcode a color.** Surfaces: `--surface-card/-1/-2/-3`; borders:
   `--border` minimum on anything interactive, `--border-strong` on
   inputs/buttons; text: `--text-1/2/3` (never `--n-400/500` as text); state:
   the `--ok/warn/danger/info` bg/bd/tx triples; brand text: `--brand-tx`.
2. **No blur, no translucent sticky bars, no 999px pills, no gradients on
   fills, no emoji (inline SVG only).** Elevation is always border + shadow.
3. **Text floor 11px**; chip text 12.5px staff / 14px kiosk; state-bearing
   text ≥ `--text-3` (5.04:1). Touch targets ≥ 40px staff, 48px kiosk.
4. **Numbers get tabular numerals** — put `.tnum` (or `.money`, or a table)
   around anything numeric.
5. **Use the additive kit**: `.chip` + variants, `.plate`, `.kpi`, `.meter`,
   `.badge-building`, `.report-*` chassis for new reports.
6. **Dark mode is free if you follow rule 1** — the aliases re-point under
   `[data-theme='dark']`. If you must add a dark-specific rule for a bare
   element, wrap the theme selector in `:where()` so classes still win.
7. **Planner**: change `--pl-*` variable values only, never `.pl-*`
   structure. **Kiosk**: shared color tokens only; nothing shrinks.

## Inline-style backlog (deliberately left)

Ranked; none of these fight the token layer today, they are just debt:

1. `reservations/[id]/page.js` (~220 remaining) + `checkout-wizard-v2`
   (113) — migrate per-component as the money path is touched; never
   big-bang.
2. `settings/page.js` (369) and the five integration panels (100+ each) —
   **do not migrate** (review Q8); they inherit token colors for free.
3. `kiosk/page.js` (127) — kiosk keeps its own language; tokens only.
4. `customer/precheckin`, `customer-display`, `host` (~100 each) — fork 4
   candidates for the full airy treatment (separate effort).
5. Dashboard SVG chart internals (`#30D5C8`/`#6C8FF6`/`#8752FE` strokes) and
   chart.js configs — canvas/SVG attributes can't take `var()`; needs a JS
   theme-color helper.
6. `PhotoCapture.jsx` keeps its blur **by design** (over live camera video —
   the review's one sanctioned exception).

## Screenshots

- Before: `design/screenshots/before/` (1440 EN, glassmorphic baseline).
- After: `design/screenshots/after/` — light 1440 EN+ES, 768 EN, 390 ES,
  dark 1440 (dashboard, fleet-status, planner), kiosk unbroken.
- Verification ran against a fake JWT with no backend (chrome + honest
  empty/error states) plus Playwright API mocks for fleet-status, so the
  data table/chips/KPIs were verified with realistic rows.

## Needs the owner's decision

- **"Collected today" / "Pending tolls" dashboard KPIs** (approved mockups):
  need backend aggregates + i18n strings — out of scope under this runbook's
  "no logic/data/i18n changes" rule. One small follow-up once the dashboard
  API exposes the two numbers (render as `.kpi` tiles; `.badge-building` if
  shipped before the data).
- **Brand hue**: still `#8752FE`. Moving to `#7f4ff0` is now literally one
  line (`--brand` in globals.css) — owner's call, per the review.
- Pre-existing test failure `test/i18n.test.js` ("EN nav has 17 items",
  actual 27) — predates the migration; the assertion needs updating.
