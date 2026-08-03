# Dashboard v2 — spec

Goal (Hector, 2026-08-03): the staff dashboard should look like the product shot
on <https://ridefleet-web.vercel.app/en>, keep every block we already have, and
the Turn-Ready score must actually work the way that page promises.

Three separate pieces of work. They are ordered by dependency, not importance —
the score is the one that carries real risk.

---

## 0. What we found

**The design system is already shared.** `frontend/src/app/globals.css` and the
marketing site resolve the same token names to the same values: `--n-*`,
`--p-*`, `--ok/--warn/--danger/--info`, `--r-*`, `--sp-*`, `--sh-*`. That came
out of the beta.365 UI migration. The one deliberate difference is the brand
hue: the app keeps `--brand:#8752FE` (Hector's constraint in
`INNOVATION-REVIEW.md`), the marketing site uses `--p-500:#7f4ff0`.

So "igualito" is **not** a re-theme. It is a composition job: the marketing page
arranges the same tokens into a shell (rail + sidebar + pane), a 3-up KPI row,
and a dense data table. We do not have that arrangement; we have a stack of
`section.glass.card-lg` cards.

**The current dashboard** (`frontend/src/app/page.js`, 972 lines) already
renders, and all of it must survive:

| Block | Where |
|---|---|
| Ops hub tiles — vehicles, available, migration holds, maintenance/OOS, collected today, pending tolls, citations, docs expiring, overdue returns, active reservations, status mismatches, fee advisories, maintenance due | `grid4` tile wall |
| Next pickups / Next returns | attention rail |
| Kiosk escalations, inspections to review, registrations expiring, ready to rotate, loaner requests, loaner lane | attention rail |
| Ops board | `section` @ 851 |
| Market Intelligence card | `MarketIntelligenceCard` |
| Sales revenue comparison | @ 228 |
| Operations timeline | `section` @ 964 |

**Turn-Ready today** lives in `backend/src/modules/vehicles/vehicle-intelligence.service.js`
(`buildTurnReadyScore`, line 346) and surfaces in vehicles/[id], issues, and the
planner. **It is not on the dashboard at all.**

---

## 1. Turn-Ready score — make it match the promise

The marketing page shows this, and calls it "the real screen":

```
Unit baseline    Every unit starts at 100 and drops on evidence     100
Wash             Completed 10:12 · photo on the record               0
Maintenance      Current · next service in 1,200 mi                  0
Fuel 7/8         Below the handover policy (full)                   −2
Open damage      Scrape on rear bumper · INS-2231 · 3 photos        −8
Documents        Registration expires in 21 days                    −2
                                                          TURN-READY 88
```

Every line has a **category, a human detail, a signed point value, and a piece
of evidence**. The current implementation cannot produce that. Four concrete
gaps:

**1.1 — No point values are recorded per line.** `buildTurnReadyScore` mutates a
running `score` and pushes a prose sentence. The deduction and the sentence are
never associated, so there is nothing to render in the right-hand column.

**1.2 — The lines do not add up, and silently.** `reasons` is
`[...new Set(reasons)].slice(0, 4)` and `blockers` is `.slice(0, 3)`. A vehicle
with six deductions displays four. The visible lines will not sum to the score,
and nothing tells the user lines were dropped. For a screen whose entire claim
is "every point traces to an event", this is the thing that breaks trust.

**1.3 — Two promised factors do not exist in the score.**
- *Documents* — registration expiry is computed for a dashboard tile
  (`registrationsExpiring30d`) but never feeds the score.
- *Wash* — only `WASH_HOLD` (an active block, −35) counts. A **completed** wash,
  which is what the mock shows as a `0`, is not a factor at all.

Also worth deciding: *Maintenance* currently only counts as `MAINTENANCE_HOLD`
(−75). The mock shows "Current · next service in 1,200 mi" as a `0` line —
i.e. mileage/time-to-service as a graded factor, which we have data for
(`maintenanceDue`, the rotation rule) but do not score.

**1.4 — No evidence references.** The mock cites `INS-2231 · 3 photos` and
`Completed 10:12`. We have inspection ids and timestamps in scope at scoring
time; they are just not carried out of the function.

### Proposed shape

Keep `score`, `status`, `summary` exactly as they are — the planner, issues, and
vehicle pages read them and must not change behaviour. **Add** a `breakdown`:

```js
breakdown: [
  { key: 'baseline',   label: 'Unit baseline', detail: '…', delta: 100, kind: 'base' },
  { key: 'wash',       label: 'Wash',          detail: 'Completed 10:12 · photo on the record',
    delta: 0, kind: 'ok',   evidence: { type: 'inspection', id: 'INS-2231', at: '…', photos: 3 } },
  { key: 'fuel',       label: 'Fuel 7/8',      detail: 'Below the handover policy (full)',
    delta: -2, kind: 'down', evidence: { type: 'telematics', at: '…' } },
]
```

with two invariants enforced by test:

- `breakdown.reduce((s, r) => s + r.delta, 0) === score` — **before** clamping,
  and the clamp itself becomes a visible line when it fires.
- Nothing is ever sliced. If the list is long the UI collapses it; the data
  stays complete.

`reasons`/`blockers` stay as they are (derived from `breakdown`) so no caller
breaks.

### Where it goes

- **Vehicle profile** — replace the current prose list with the itemized rows.
- **Dashboard** — the fleet-wide ring (see §2), and clicking it opens the
  breakdown for the worst-scoring units.
- **Planner side panel** — already shows the summary; add the top 3 deductions.

---

## 2. Visual system — port the product-shot composition

Extracted from the live page (verbatim CSS in `design/marketing-shot.css`).

**Shell.** `.app-bar` (breadcrumbs + search pill with ⌘K) / `.app-rail` (56px
icon rail) / `.app-side` (200px nav, `.grp` mono uppercase group labels,
`.app-nav` items with a `.count` badge) / `.app-pane`. Responsive rules already
defined: rail hides ≤900px, sidebar ≤768px.

**KPI row.** `.kpis` is `repeat(3, 1fr)`, collapsing to 2-up ≤1180px with the
first cell spanning full width, then 1-up ≤560px. `.kpi` = 1px `--border-subtle`,
`--r-lg`, `linear-gradient(180deg,var(--n-0),var(--surface-1))`, `--sh-1`.
`.klab` is mono 9.5px / `0.14em` / uppercase. `.kval` is 26px / 680 weight /
`-0.035em` / tabular-nums.

**Ring.** `.ring` 88px, `.track` stroke `--n-200` width 8, `.prog` stroke
`--p-600`, `stroke-dasharray: 238.76`, offset driven by a `--pct` custom
property. Center: `.rnum` 24px/700, `.rsuf` mono 9.5px uppercase.

**Chips.** `.chip` + `.chip--ok/warn/danger/brand/neutral` map 1:1 onto our
existing `status-chip` tones. Alias rather than duplicate.

**Breakdown rows.** `.srow` is `grid-template-columns: 26px minmax(0,1fr) auto`
— icon, label+detail, points. `.pts--base` `--text-3`, `.pts--zero` `--ok-tx`,
`.pts--down` `--danger-tx`.

**Tabular numbers** are already global in the app; the marketing rule is the
same selector list.

### Open conflict — the ring

`design/INNOVATION-REVIEW.md` records a binding decision: **REJECT the animated
ring**, replaced by blocked-reason decomposition. The page Hector now wants to
match has the ring.

Recommendation: **ship the ring static and keep the decomposition.** The
marketing page already disables the sweep under `prefers-reduced-motion`, and
the rejection was of the animation, not the shape. That satisfies both the old
decision and the new request without asking anyone to reverse themselves.

### The other two binding constraints still hold

- Dashboard keeps **all** existing tiles, including Next pickups *and* Next
  returns, Collected today, Pending tolls. The marketing shot only shows three
  KPIs — that is a hero row, not the whole page. Everything else sits below it.
- Nothing gets deleted to make room.

---

## 3. Rollout

Build at `/dashboard-v2` behind a per-user preference, with `/` untouched until
Hector signs off on live data. The existing `/dashboard` route is already a
redirect shim to `/`, so the naming stays consistent.

Phases, one commit each:

1. `marketing-shot.css` reference + token alias check (no JSX)
2. Turn-Ready `breakdown` in the backend + tests for the sum invariant
3. Turn-Ready breakdown UI on the vehicle profile (proves the data)
4. `/dashboard-v2` shell — bar, rail, sidebar, pane
5. Hero KPI row — Turn-Ready ring, utilization, tolls reconciled
6. Fleet table with the `TURN-READY` column
7. Port every existing block below the hero
8. Screenshot matrix, 3 widths × 2 languages, same as beta.365

### Backend work this needs

- Fleet-wide Turn-Ready aggregate (ready / blocked counts) — no endpoint today.
- Utilization + week-over-week delta — not currently computed.
- Tolls reconciled 30d + crossings + in-review — partially available via the
  tolls module; needs an aggregate.

These are the same "dashboard aggregates endpoint" already listed as a pending
follow-up in `design/UI-MIGRATION.md`.
