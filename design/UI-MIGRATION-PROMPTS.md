# Prompts para migrar el UI real de Ride Fleet Manager al lenguaje visual de la página

**Objetivo:** que la app de producción (`frontend/`, Next.js 14) se vea como las superficies de producto que enseña la página de marketing — la dirección **Product-Led Premium** que escogiste.

Aquí hay **dos prompts**, para pegarlos tal cual:

| # | Agente | Qué hace | Cuándo correrlo |
|---|---|---|---|
| 1 | **Design agent** | Ejecuta la migración: tokens, capa de alias, componentes, verificación por screenshot | Segundo |
| 2 | **Innovation agent** | Cuestiona *si* el look de marketing sirve para una herramienta densa de mostrador, y propone lo que la página no tiene | **Primero** |

**Córrelos en ese orden.** El Innovation agent existe para que el Design agent no copie ciegamente una página de ventas dentro de un producto operacional. Su veredicto es un *input* del prompt #1 (hay un slot marcado para pegarlo).

---

## Antes de pegar — dos archivos que los agentes necesitan

Ambos prompts asumen que estos dos archivos existen dentro del repo. Cópialos a `design/` en la raíz de `RideFleetManagement` antes de correr nada:

```
design/design-system.css      ← el sistema tokenizado (ramps, aliases, componentes)
design/C-productled.html      ← la dirección aprobada, renderizable en el browser
```

Los dos van adjuntos con este documento. Si los pones en otra ruta, cambia las rutas en los prompts.

---
---

# PROMPT 1 — Innovation Agent
### *(corre este primero)*

```
You are a senior product-design strategist. Your job is NOT to implement anything.
Your job is to pressure-test a proposed redesign before an engineering team spends
weeks on it, and to propose what the proposal is missing.

## The situation

We built a marketing website for Ride Fleet Manager. Inside it we drew idealized
"product surfaces" — a fleet dashboard, a toll-reconciliation table, a live-call
panel — in a design language we're calling Product-Led Premium: flat layered
neutrals on a purple spine (#7f4ff0), multi-layer soft shadows, 8–22px radii,
tabular numerals everywhere, small dense status chips, a circular score dial,
inline sparklines, and floating annotation callouts pinned to data points.

The owner saw those surfaces and said: I want the real app to look like this.

That instinct may be right. It may also be a trap. Marketing surfaces are drawn
to be *looked at* for eight seconds by a stranger. The real app is *worked in*
for eight hours by someone who already knows it. Your job is to figure out which
parts of the marketing look survive contact with that reality, which parts are
actively harmful, and what a genuinely better answer looks like.

## Read these before you form an opinion

Repo: RideFleetManagement, branch release/deposit-balance-fix-beta119

1. `design/C-productled.html` — the target look. Open it, read the CSS, look at
   the three product surfaces it draws. This is the aspiration.
2. `design/design-system.css` — the tokenized version of that language.
3. `frontend/src/app/globals.css` — 1,728 lines, 278 classes, NO Tailwind. This
   is the current design language: a glassmorphic "iOS vibe" system on
   --brand-purple #8752FE, with a radial-gradient body background, backdrop-blur
   glass panels, 14–24px organic radii, 999px pill chips, and gradient buttons.
4. `frontend/src/components/AppShell.jsx` and `MobileAppShell.jsx` — the chrome.
5. `frontend/src/app/planner/` and the 99 `.pl-*` classes in globals.css — this
   is the densest, most operationally serious screen in the product. If a design
   change breaks the planner, the change is wrong.
6. `frontend/src/app/kiosk/` + `kiosk.css` — the self-service kiosk. Different
   ergonomics entirely: large targets, no mouse, public lighting.
7. `frontend/src/app/customer-display/`, `customer/precheckin/`,
   `customer/sign-agreement/` — customer-facing surfaces inside the same app.
8. `frontend/src/app/reports-v2/` — chart.js dashboards, ~15 report pages.
9. `frontend/package.json` — note Capacitor 8.2. The mobile app is a wrap of
   this same web UI. Whatever we do to the CSS ships to phones.

Also count for yourself: how many files use inline `style={{`, and how heavy the
worst offenders are. That number is the real cost of this migration, and I want
you to state it rather than take my word for it.

## Questions you must answer, with a verdict on each

Answer each with one of: ADOPT / ADAPT / REJECT — plus the reasoning and, where
you say ADAPT or REJECT, the specific alternative you'd ship instead.

1. **Density vs. airiness.** The marketing surfaces breathe: 16px gaps, 11px row
   padding, generous whitespace. A dispatcher scanning 40 vehicles does not want
   breathing room, they want rows per screen. Where is the honest line? Should
   the app run a compact density mode by default with the marketing spacing
   reserved for customer-facing and empty states? Propose actual numbers.

2. **The score ring.** `C-productled.html` draws an animated circular
   "turn-ready 88" dial. In a marketing hero that's a hook. On a screen someone
   reloads 60 times a day, an animating ring is a distraction and a repaint cost.
   Does the ring earn its place in production? If yes, under what rules
   (animate once per session? never? only on the dashboard?). If no, what
   communicates the same thing better — and is a 3-second read even the right
   goal for that metric?

3. **The annotation callouts.** Floating labeled dots pinned to data points are
   a marketing device — they explain a screenshot to someone who's never seen
   it. Inside the product, is there any legitimate use (onboarding coach marks?
   anomaly flags?) or is this purely decorative? Be decisive.

4. **Glass → flat.** The current app is glassmorphic: backdrop-filter blur,
   translucent surfaces, gradient fills. The target is flat layered neutrals.
   Note that globals.css already contains a comment recording a bug where the
   sticky translucent topbar bled scrolled content through it and had to be made
   opaque. Is flattening a genuine improvement in legibility and render cost, or
   is it fashion? Argue it with evidence, including what blur costs on the
   Capacitor build on a mid-range Android.

5. **Environment.** This software runs at a rental counter and in a lot: bright
   sun through glass, glare on a tablet, one hand holding a phone and the other
   holding keys, occasionally gloves. Does Product-Led Premium — with its low-
   contrast neutrals (--n-400 is 2.21:1 on white), thin hairline borders, and
   11.5px chip text — survive that environment? Name every token or component
   that fails it and specify the replacement value.

6. **Brand hue.** The app's --brand-purple is #8752FE. The target's core is
   #7f4ff0 — and the app's existing button gradient already uses #9f79ff→#8752FE
   with a #7f4ff0 border. These are nearly the same hue. Is a hue change even
   part of this work, or is the real delta purely *treatment* (gradient→flat,
   pill→rect, blur→shadow, no tabular numerals)? Say plainly which, because it
   changes the size of the job by an order of magnitude.

7. **Consistency vs. context.** The app contains at least four ergonomically
   distinct surface classes: staff back-office, the planner board, the kiosk,
   and customer-facing signature/precheck-in flows. Should all four adopt one
   visual language, or should the system fork deliberately? If it forks, define
   the forks and what stays shared.

8. **Cost honesty.** Given the inline-style count you measured, the 99 `.pl-*`
   classes, and 199 JS/JSX files: is a full visual migration worth it right now
   versus a targeted one? If you'd scope it down, say exactly which screens you'd
   do and which you'd leave alone, and what percentage of user-visible time each
   represents.

## Then: go beyond the page

The marketing mockups are a sales artifact. They are not a product vision. Propose
**3 to 5 concrete UI innovations that are NOT in the marketing page** but that
this specific product should have, each grounded in something you actually saw in
the repo — a workflow, a data model, a screen that's clearly fighting itself.

For each: the problem, the proposed interaction, the screens it touches, a rough
implementation cost, and how you'd know it worked. Prefer ideas that reduce clicks
or eliminate a failure mode over ideas that add visual polish.

## Rules

- Ground every claim in a file path or a measured number. No generic design advice.
- You are not here to validate the plan. If the honest answer is "most of this is
  cosmetic and you should spend the time on the planner's information density
  instead," say that.
- Do not write implementation code. Design direction and reasoning only.
- No emoji anywhere.
- Do not propose adding Tailwind, a component library, or a CSS-in-JS runtime.
  The constraint is plain CSS, and the constraint is not negotiable.

## Deliverable

A single markdown file: `design/INNOVATION-REVIEW.md`

Structure it as:
1. Verdict summary — a table of the 8 questions with ADOPT/ADAPT/REJECT
2. The reasoning, one section per question
3. Keep / Kill / Adapt — a component-level table mapping every element of the
   marketing language to a decision
4. The environmental token overrides you're mandating
5. The 3–5 innovations that go beyond the page
6. Recommended scope: what you would and would not migrate, in priority order
7. The one thing you'd tell the owner if you only got one sentence
```

---
---

# PROMPT 2 — Design Agent
### *(corre este después, con el veredicto del Innovation agent pegado adentro)*

```
You are a senior product designer who codes. You are migrating a real, shipping
Next.js application to a new visual language — carefully, in a way that does not
require touching 199 files, and verifying your own work by looking at rendered
screenshots rather than by asserting that it looks fine.

## The goal

Make the Ride Fleet Manager product UI look like the product surfaces on our
marketing site — the direction called Product-Led Premium.

## Ground truth: where you're starting from

Repo: RideFleetManagement, branch release/deposit-balance-fix-beta119
App: `frontend/` — Next.js 14.2.35 App Router, React 18.3.1

Measure these yourself before you touch anything, and put the real numbers at the
top of your migration plan:

- `frontend/src/app/globals.css` — 1,728 lines, 278 classes. **There is no
  Tailwind and no CSS-in-JS.** This one file plus `app/kiosk/kiosk.css` (266
  lines) is essentially the entire design system.
- ~159 files use inline `style={{`. The worst are `app/settings/page.js` (~363
  occurrences), `app/reservations/[id]/page.js` (~213), `app/kiosk/page.js`
  (~127), `app/reservations/[id]/checkout-wizard-v2/page.js` (~113), and the
  `components/settings/*IntegrationPanel.jsx` family (~90–110 each).
- 97 route pages, 199 JS/JSX files.
- 99 `.pl-*` classes — the planner board, the densest screen in the product.
- Chrome lives in `components/AppShell.jsx` and `components/MobileAppShell.jsx`.
- Capacitor 8.2 wraps this same web UI as the mobile app. CSS changes ship to
  phones.
- i18next 26 — the UI is bilingual. Spanish strings are longer than English;
  any layout you tighten must survive Spanish.

### The current language (what you are migrating FROM)

Glassmorphic "iOS vibe":
- `--brand-purple: #8752FE`, `--brand-violet: #6d3df2`, `--brand-mint: #1fc7aa`
- A three-layer radial-gradient body background
- `--ios-surface: rgba(255,255,255,0.88)` + `.glass { backdrop-filter: blur(14px)
  saturate(1.1) }`
- `--ios-shadow: 0 14px 32px rgba(35,21,80,.08)` — a single soft shadow
- `--ios-radius: 16px`, `--ios-radius-lg: 20px`, sidebar at 24px, chips at 999px
- Gradient buttons: `linear-gradient(180deg, #9f79ff, var(--brand-purple))`
- Base font 14px, Aptos / Segoe UI Variable
- Cards lift on hover: `transform: translateY(-1px)`

### The target language (what you are migrating TO)

- `design/design-system.css` — **this is the source of truth.** It is already
  tokenized: neutral/purple/gold/teal ramps, semantic aliases (`--surface-*`,
  `--border-*`, `--text-*`), a shadow scale, a radius scale, and a component
  layer (`.app`, `.tbl`, `.chip--*`, `.kpi`, `.ring`, `.spark`, `.plate`,
  `.callout`, `.btn--*`, `.input`, `.field`). Every documented contrast ratio in
  its comments is a commitment — do not ship a combination that breaks one.
- `design/C-productled.html` — open it in a browser and *look at it*. The three
  product surfaces in it (fleet dashboard, toll reconciliation table, live-call
  panel) are the visual target.

### The real delta

Before you plan, verify this claim yourself and correct me if I'm wrong: the hue
barely changes. The app's button gradient already runs #9f79ff → #8752FE with a
#7f4ff0 border, and the target's core purple is #7f4ff0. What actually changes is
**treatment**, not colour:

| From | To |
|---|---|
| Gradient fills | Flat layered neutrals |
| `backdrop-filter: blur()` glass | Opaque surfaces + a real shadow scale |
| One soft shadow | Three-layer `--sh-*` scale + a 1px ring |
| Organic 16/20/24px radii | The `--r-*` scale, 8→22px, applied by role |
| 999px pill chips | 7px rect chips with an LED dot |
| Proportional numerals | `font-variant-numeric: tabular-nums` on every number |
| Hover lift on cards | Row-level hover only, on tables |
| Decorative body gradient | A calm canvas that lets data be the loudest thing |

If that framing is right, this is a **token-and-treatment migration**, not a
rewrite. Plan accordingly.

## Non-negotiable strategy: remap, don't rewrite

You will NOT rename 278 classes across 199 files. You will:

1. **Replace the token layer.** Import the ramps and semantic aliases from
   `design/design-system.css` into `globals.css` as the new `:root`.

2. **Keep every existing class name and re-point it at the new tokens.** The old
   names become an alias layer. `.card` still exists — it just now renders as the
   new surface. `.status-chip.good` still exists — it now renders as `.chip--ok`.
   `.table-shell` renders as `.tbl`. `.metric-card` renders as `.kpi`.
   `.glass` stops blurring and becomes an opaque elevated surface.
   Result: the app changes appearance without any JSX changing.

3. **Add the new components additively** — `.ring`, `.spark`, `.plate`, `.conf`,
   `.tnum`, `.callout` — so new work can use them directly.

4. **Only then** go after inline styles, and only in the files where they
   actively fight the new system. Rank them by (occurrences × how often users see
   that screen) and fix in that order. Do not attempt all 159.

Produce and commit an explicit **mapping table** — old token/class → new token/
class → note. That table is a deliverable, not scratch work.

## The Innovation agent's verdict — binding

<<< PASTE THE CONTENTS OF design/INNOVATION-REVIEW.md HERE >>>

Where that review says ADAPT or REJECT, you follow the review, not the marketing
page. Where it mandates environmental token overrides (contrast, hit targets,
minimum type size), those override the design system's defaults. If you think the
review is wrong about something, say so explicitly in your plan and make the case
— do not silently ignore it.

## Order of work

**Phase 0 — Audit.** Measure the real numbers. Screenshot the current app on the
5 screens below so you have honest before/after pairs. Write the mapping table.
Nothing changes yet.

**Phase 1 — Tokens.** New `:root` in globals.css. Retire the body radial
gradient. Every existing class re-pointed at semantic aliases. No class renamed,
no JSX touched. The app should now look 80% migrated.

**Phase 2 — Chrome.** `AppShell.jsx` / `MobileAppShell.jsx`: the sidebar, topbar
and nav rendered in the new language. **The topbar must stay fully opaque** —
globals.css records a prior bug where a translucent sticky topbar bled scrolled
content through it. Do not reintroduce that.

**Phase 3 — Data surfaces.** Tables, KPI cards, chips, badges, forms, buttons.
Add `font-variant-numeric: tabular-nums` to every number, money value, plate,
and table cell. This single change does more for the "premium product" feel than
anything else on the list.

**Phase 4 — The five screens.** Bring these fully to the target, since they are
what the marketing page actually depicts:
  1. `/dashboard`
  2. `/planner` (the 99 `.pl-*` classes — treat this as the hardest and most
     important; density wins over beauty here every time)
  3. `/reservations/[id]`
  4. `/reports-v2/fleet-status`
  5. `/vehicles/[id]`

**Phase 5 — Verify.** See below.

**Phase 6 — Hand-off.** Write `design/UI-MIGRATION.md`: what changed, the mapping
table, the rules for new screens, the list of inline-style files still owed, and
before/after screenshots.

## Verification — this is not optional

You verify by looking, not by asserting.

- Run the app and capture full-page screenshots with Playwright (Chromium is
  preinstalled). Scroll the page in ~700px steps before capturing full_page,
  otherwise scroll-reveal and lazy content render blank.
- **Actually open the resulting PNGs and look at them.** Then fix what you see
  and re-render. Loop until it holds up. An agent that says "the migration is
  complete" without having viewed a screenshot has not done the job.
- Capture at 1440×900, 768 and 390 wide, in **both Spanish and English**.
- Check the kiosk route separately — it has its own CSS and its own ergonomics.
- Run `npm run build` and the vitest suite. A visual migration that breaks the
  build is a failed migration.
- Diff-check contrast: no text token below 4.5:1 on its own background, no
  interactive target below 44×44 on touch surfaces.

## Hard rules

- **No Tailwind, no component library, no CSS-in-JS.** Plain CSS. Not negotiable.
- **No emoji anywhere** — not as icons, not as status indicators, not in
  comments. Use inline SVG.
- **Do not change application logic, data fetching, routing, or i18n keys.** This
  is a visual migration. If a fix requires a logic change, note it and move on.
- **Do not delete a class that JSX still references.** Re-point it instead.
- **Do not break `.sr-only`** — globals.css documents exactly why its
  `!important` declarations are load-bearing. Leave it alone.
- Preserve every existing accessibility affordance. Improve where cheap.
- Spanish is the primary locale. Verify Spanish string lengths do not overflow
  anything you tightened.
- Work in small commits, one phase per commit, so any phase can be reverted alone.

## Deliverables

1. Updated `frontend/src/app/globals.css` (and `kiosk.css` where it diverges)
2. Updated `AppShell.jsx` / `MobileAppShell.jsx`
3. The five Phase-4 screens migrated
4. `design/UI-MIGRATION.md` — the mapping table, the rules, the remaining backlog
5. Before/after screenshots at three widths in two languages
6. A green build and a green test run
```

---
---

## Notas prácticas

**Por qué en dos agentes y no en uno.** El Design agent, si lo sueltas solo, va a
copiar la página bonita adentro del producto — incluyendo el anillo animado y los
callouts flotantes, que en una pantalla que se recarga 60 veces al día son ruido.
El Innovation agent existe para matar esas cosas *antes* de que se implementen, y
para proponer lo que la página de ventas nunca iba a tener porque no es su trabajo.

**El hallazgo que más ahorra tiempo.** El morado casi no cambia: la app ya usa
`#9f79ff → #8752FE` con borde `#7f4ff0`, y el core del target es `#7f4ff0`. Lo que
cambia es el *tratamiento* — gradiente a plano, glass a opaco, píldora a
rectángulo, y números tabulares. Eso convierte el trabajo de "rediseño" a
"reemplazo de tokens", que es un orden de magnitud más barato.

**Lo más importante de todo el documento.** `font-variant-numeric: tabular-nums`
en cada número, cada monto y cada tablilla. Es una línea de CSS y es lo que más
hace que una app se sienta de producto serio en vez de plantilla.

**Los 159 archivos con `style={{`** son el costo real de la migración. La capa de
alias los esquiva: ningún JSX tiene que cambiar en la fase 1. Solo se atacan
después, por orden de cuánto los ve el usuario.
