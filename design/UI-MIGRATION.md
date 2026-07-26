# UI Migration — Product-Led Premium (as adapted by design/INNOVATION-REVIEW.md)

Status: **Phase 0 — audit**. This file is the working deliverable; it grows one
section per phase and ends as the hand-off doc.

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

*(Phases 1–6 appended below as they land.)*
