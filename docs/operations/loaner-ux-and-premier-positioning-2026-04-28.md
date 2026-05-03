# Loaner Module — UX & Premier Positioning Analysis

**Date:** 2026-04-28
**Owner:** Hector
**Companion to:** `docs/operations/loaner-module-premier-product-2026-04-28.md` (feature-parity gaps).
**Question this doc answers:** *Is what we have actually good, and how do we make it the best in the category — without sacrificing user-friendliness?*

---

## 1. Executive summary

The loaner module **already feels capable** to a service-lane manager — the Priority Board, quick-intake shortcuts, draft persistence, and clear queue subtitles put us above the median dealer-loaner tool out of the box. We have real differentiators (toll integration, multi-tenant, car-sharing crossover) that competitors don't.

But the dominant emotion when a new user lands on the page is **"capable but faintly lost."** The page is dense. Required fields aren't marked. Submit doesn't disable. Errors say "fill the required fields" without naming them. There are no skeleton loaders so slow networks render blank cards. The split-panel layout (Lookup + Intake side-by-side) competes for attention. And the internal jargon ("Packet Pending," "Borrower Packet," "SLA Alert," "Return Exception") asks users to learn our terminology before they can do their job.

**Two strategic moves get us from "capable" to "premier":**

1. **Polish the existing flow to remove friction** — required-field marking, submit disable, named validation errors, skeleton loaders, semantic form labels, light copy edits. ~3-5 days of work, immediate perceived-quality lift.
2. **Add the in-bay tablet experience that category leaders have** — e-signature, walkaround photos, fuel/odometer with photo capture. Already in the feature-scoping doc. ~3-4 weeks; biggest perceived-parity item.

The two are independent. Ship #1 immediately as it's almost free; #2 is the bigger investment.

The doc below has the audit findings, the gap-to-premier mapping, concrete recommendations ranked by ROI, and a performance-for-UX section.

---

## 2. What we already do well (preserve these)

Lifted directly from the audit. Don't break these in any redesign.

1. **Form draft auto-persists to localStorage** (`page.js:233-243`). Service-lane staff get interrupted constantly; their in-progress intake survives a tab switch, a network blip, or a page refresh. This is **above** what most competitors offer.
2. **Service Lane Priority Board** computes the single most-urgent item per category (next delivery, next return, billing blocker, SLA risk, advisor follow-up) from live queue data. Reduces "where do I start" cognitive load. This is one of the most premium-feeling parts of the page.
3. **Queue cards have explanatory subtitles** that name *why* each queue matters and *who* should care. Excellent for onboarding new staff. Most competitor tools show queue counts only.
4. **Quick-window shortcuts** ("2 Days," "5 Days") on the date inputs auto-fill standard loan durations. Small, high-frequency win.
5. **Helpful placeholder examples** in the notes textareas — concrete prompts ("Coverage details, insurer approval, courtesy policy") guide users to the right kind of content without being prescriptive.
6. **CSV + monthly statement print** baked into the page. Manager can close month-end without leaving. Reduces friction for back-office work.

---

## 3. UX audit findings — the specific frictions

Grouped by severity. References cite `frontend/src/app/loaner/page.js` line numbers from the audit.

### 3.1 HIGH — Required fields are not marked

- 26 fields in the Quick Intake form. No asterisks, no "Required" labels, no `(optional)` tags. Users must infer which fields are mandatory by submitting and reading the validation error.
- Validation error itself is generic: `"Complete the required loaner intake fields first."` (line 432). Doesn't name *which*.
- Required fields per the validation: vehicle type, pickup location, return location, pickup date, return date, customer (existing OR firstName + lastName + phone), liability checkbox.

**Why it matters:** A service-lane person filling this for the first time will hit the error 1-2 times before learning the implicit contract. Premium tools surface required fields before submit.

### 3.2 HIGH — Submit button never disables during request

- `createLoaner`, `exportBillingCsv`, `exportStatementCsv`, `printStatementPacket` all run async without disabling their buttons. Multi-clicks land multiple intakes / multiple downloads / multiple print popups.
- Search button DOES disable correctly (`disabled={loading}` line 715). The pattern exists; just isn't applied consistently.

**Why it matters:** Real users in noisy environments double-click reflexively. Creating two intake records or three identical CSV downloads is bad UX *and* bad data hygiene.

### 3.3 HIGH — No skeleton / loading states; blank cards on slow networks

- Initial dashboard fetch returns into `dashboard = null` and queues render with empty arrays. On a slow network, the user sees blank cards for 1-3 seconds with no indication that anything is loading.
- Search button changes label to "Loading..." (good). The same pattern isn't extended to the dashboard, queues, or priority board.

**Why it matters:** Perceived speed is not real speed. A skeleton with a shimmer feels 2× faster than the same network roundtrip with a blank card.

### 3.4 MEDIUM-HIGH — Form labels are `<div>`, not semantic `<label>` (a11y + tablet)

- Most form fields use `<div className="label">` (lines 798, 814, 828, etc.) instead of semantic `<label htmlFor>`. Only the liability checkbox (line 950) is correctly wrapped.
- No `aria-` attributes anywhere in the file (no `aria-label`, `aria-required`, `aria-invalid`, `aria-describedby`).

**Why it matters:** Tablet users tap labels expecting the input to focus. With `<div>`, that doesn't work. Plus the obvious accessibility audit failure.

### 3.5 MEDIUM — Internal jargon visible to users

- "INTAKE," "ADVISOR," "Packet Pending," "Packet Complete," "Borrower Packet," "Return Exception," "SLA Alert," "Loaner Program Notes."
- Subtitles explain most of these, but the user has to read carefully.
- Compare: Loaner Manager labels its equivalent surfaces "New Loaner Check-In," "Service Advisor Follow-Up," "Inspection Pending," "Damage Reported," "Return Overdue."

**Why it matters:** Premier-feeling tools speak the user's language. Internal terminology slows new staff onboarding and signals "engineer-built, not service-tested."

### 3.6 MEDIUM — No mobile / tablet provisions in the file

- Zero `@media` rules. No conditional rendering on viewport width. Class names like `split-panel`, `form-grid-2`, `form-grid-3` may handle responsiveness in CSS but it's invisible from this file.
- Service-lane staff use tablets at the customer-facing counter. The current desktop-first layout will work but probably won't feel native.

**Why it matters:** Category leaders explicitly market "tablet-first" as a feature. We don't need to redesign mobile-first, but we need to verify the existing CSS handles tablets (768-1024px) gracefully.

### 3.7 MEDIUM — Split-panel "Lookup + Intake" wastes attention

- Both panels demand attention. The user has to choose. On narrow screens they stack, putting Lookup behind the Intake form.
- Two competing primary tasks side-by-side dilutes the page's intent.

**Why it matters:** A premium UI commits to one primary action per surface. Either *create* or *find*; the user picks via clear navigation, not by scrolling between two equally-prominent forms.

### 3.8 LOW — No optimistic updates anywhere

- All async actions wait for the server before reflecting state. The `createLoaner` call doesn't show "Created" until the round-trip completes.
- Most competitors use the same pattern; this is parity-level, not a gap. But it's a place to win.

### 3.9 LOW — No `useCallback`; event handlers re-create every render

- 9 `useState`, 4 `useEffect`, 7 `useMemo`, 0 `useCallback`. Trivially adds re-renders to child components. Probably not measurable in the current page (no expensive children) but worth noting if we extract sub-components.

### 3.10 LOW — Page outline is hub-shaped but reaches an "everything" feeling by the time you scroll past Quick Intake

- Hero → Shift Hub → Priority Board → Lookup + Intake → Six queues + Alert Escalation. That's a lot of distinct surfaces stacked.
- The Shift Hub navigation pills could deep-link to the queues section so the user doesn't have to scroll past the intake form.

---

## 4. Gap to premier — where we still trail category leaders on UX

Categories like Loaner Manager and TSD have invested years in the in-bay flow. Five UX behaviors they do that we don't (yet):

| Pattern | What they do | Where we are |
|---|---|---|
| **Required-field UX** | Asterisks + persistent validation summary at top of the form, focusing the first invalid field on submit | Submit then "fill required fields" with no name |
| **Field-level inline errors** | Errors appear directly under the offending field, in the field's own color | Single page-level banner; user has to scroll up to see it |
| **Save-as-you-go** | Each field saves independently; intake doesn't have a single "create" submit, it's auto-saved as you fill | One big submit at the end |
| **Confirmation dialogs for destructive actions** | "Are you sure you want to swap loaners on RES-12345?" | Direct link click; relies on the destination page to confirm |
| **In-page wayfinding** | A sticky breadcrumb / step indicator on long forms | Linear scroll |

We don't need ALL five to be premium. We need the first two; the rest are nice-to-haves.

---

## 5. Recommendations — ranked by ROI

Tagged by **effort** (S / M / L) and **impact** (low / medium / high). Sequenced so the biggest perceived-quality lifts ship first.

### 5.1 Phase 1 — UX polish (3-5 days, ship as one PR)

**The goal: make the existing page feel premium without changing what it does.**

| # | Action | Effort | Impact | Notes |
|---|---|---|---|---|
| P1-1 | Mark required fields with a red asterisk in the label, add an "(optional)" tag to obviously-optional ones | S (2 hrs) | High | Removes the #1 friction point. ~10 fields touched. |
| P1-2 | Replace generic "complete required fields" error with a list naming each missing field, with a "Jump to first" link | S (3 hrs) | High | Tells the user exactly what to fix. |
| P1-3 | Move validation errors inline under each field; keep the page-level banner only for server errors | M (4-6 hrs) | High | Standard form pattern; we're behind on it. |
| P1-4 | Disable submit/export/print buttons during their request; show inline spinner ("Creating...") on the active button | S (1-2 hrs) | High | Prevents double-submits. Existing pattern in search; extend to all async buttons. |
| P1-5 | Add skeleton loaders to dashboard, queues, priority board for the initial fetch | M (4 hrs) | Medium-High | Big perceived-speed win. |
| P1-6 | Convert `<div className="label">` wrappers to semantic `<label htmlFor>`; add `aria-required`, `aria-invalid` where appropriate | M (3-4 hrs) | Medium | Accessibility + tablet tap-on-label behavior. |
| P1-7 | Soft copy edits: "Intake And Delivery" → "New loaner check-ins"; "Advisor Follow-Up" → "Service advisor follow-up"; "Borrower Packet" → "Customer agreement packet"; "Return Exception" → "Return issue flagged" | S (1 hr) | Medium | Speaks to the user instead of the system. Keep API field names internal. |
| P1-8 | Add a "Required fields:" summary at the top of the intake form before submit (or a sticky validation panel on submit) | S (2 hrs) | Medium | Helps new users scan. Disappears once form is valid. |

**Total effort: ~3-5 days of one engineer.** Combined impact is the difference between "this works" and "this feels good."

### 5.2 Phase 2 — Layout + tablet polish (1-2 weeks)

**The goal: page feels native on tablet and the Lookup-vs-Intake conflict resolves cleanly.**

| # | Action | Effort | Impact | Notes |
|---|---|---|---|---|
| P2-1 | Tab between "New Intake" and "Find Loaner" instead of side-by-side split panel; keep the current Quick Intake form on the New Intake tab | M (1 day) | High | Removes attention split. New users immediately know what they're looking at. |
| P2-2 | Audit the page in Chrome DevTools at 768px, 1024px, 1280px viewports — fix any horizontal overflow, button-too-small, label-wrap issues | M (1-2 days) | High | Tablet readiness without a full redesign. |
| P2-3 | Make the Shift Hub navigation pills actually scroll-anchor to the intake form / queue section / alert section, not just visual | S (2 hrs) | Medium | "Jump To Queues" pill needs to actually jump. |
| P2-4 | Sticky compact priority-board summary (just the next 3 actions + counts) at the top of the page on scroll | M (4-6 hrs) | Medium | Premium feel; competitor tools have this on long pages. |
| P2-5 | Verify the existing CSS responsive behavior (form-grid-2, form-grid-3, split-panel) works on tablet; if not, add the breakpoints | M (1 day) | Medium | Depends on the audit in P2-2. |

### 5.3 Phase 3 — Differentiator polish (3-4 weeks; pair with the feature-parity scoping doc's Phase 1)

**The goal: features the competition doesn't have, polished enough to be marketing material.**

This phase is in-bay tablet experience — e-signature, walkaround photos, fuel/odometer with photo. **Already specified in `loaner-module-premier-product-2026-04-28.md` Phase 1.** Don't duplicate the spec here; just note that when those features ship, they should match the polish established in P1 (required-field marking, skeleton states, inline errors).

### 5.4 Phase 4 — Performance for UX (parallel; ongoing)

See §6 below — these are smaller items but they compound.

---

## 6. Performance for UX

The page already does a reasonable amount; here's where to push.

### 6.1 Skeleton loaders + perceived-speed wins (highest ROI)

Already covered in P1-5. Worth restating: the difference between "blank for 1.5s" and "skeleton-with-shimmer for 1.5s" is the difference between feeling slow and feeling fast. Most users don't measure milliseconds; they measure "did anything happen when I clicked."

### 6.2 Optimistic updates on the high-confidence path

For the **intake create** flow specifically: when the user clicks "Create Loaner Intake," show the new row in the INTAKE queue immediately with a faint "saving" indicator. If the server rejects, remove the row and surface the error. The Priority Board can absorb this trivially.

Lower-confidence actions (vehicle swap, billing approval) should stay pessimistic — failure cost is too high.

### 6.3 Pre-fetch on hover

Service-lane users hover over a queue row before clicking "Open." We can pre-fetch `/api/reservations/{id}` on the row's `onMouseEnter` (debounced 100ms). When they click, the detail page loads from cache.

Cheap win; ~2-4 hours of work; meaningful perceived-snappiness lift.

### 6.4 Memoize child components

The page is a single 1,127-line component. Extracting `<LoanerQueueCard>`, `<PriorityBoardItem>`, etc. into memoized children would prevent unnecessary re-renders of the entire dashboard when an unrelated bit of state changes (say, the search input value).

Effort: M (1 day to extract + memoize the 4-5 hot child surfaces). Impact: medium — currently not a measurable problem, but as the page grows it will be.

### 6.5 Cache `intake-options` in `cache.js`

Already covered in `performance-prep-2026-04-28.md` Q-4. Repeating here because it has direct UX impact: opening the loaner page should not refetch all locations + vehicle types + customers from scratch. 5-minute TTL on these makes the page feel instant on second visit.

### 6.6 Debounce the search input as a fallback

Currently search is manual (button click). Consider adding debounced live search (300-500ms after typing stops) as a quality-of-life improvement. Don't replace the manual search — make it parallel. Some users prefer one, some the other.

### 6.7 Background refresh of the dashboard every 60s

Service-lane staff leave the page open all morning. The dashboard data goes stale. A silent refresh every 60s (with a "Updated 12s ago" indicator) keeps the queues live without making the user reload.

Effort: S (1-2 hrs). Impact: medium-high in the day-long tablet-on-counter use case.

---

## 7. Sequencing across both docs (this + scoping)

Combined view of what to ship in what order. Each Phase here is an independent PR / sprint.

| When | What | Source doc |
|---|---|---|
| Sprint 1 (this/next week) | UX polish (P1-1 through P1-8) | This doc §5.1 |
| Sprint 1 (parallel) | Performance — skeleton loaders + button-disable + optimistic intake | This doc §6.1, §6.2 |
| Sprint 2 | Layout + tablet polish (P2-1 through P2-5) | This doc §5.2 |
| Sprint 2 (parallel) | Pre-fetch on hover, memoize children, dashboard auto-refresh | This doc §6.3, §6.4, §6.7 |
| Sprint 3-4 | In-bay tablet experience: e-signature + walkaround photos + fuel/odometer photo capture | Scoping doc Phase 1 (T-1, T-2, T-6, T-7) + C-5 (return reminders) |
| Sprint 5-7 | Customer self-service portal for loaner + SMS + recall lookup + NPS | Scoping doc Phase 2 (C-1, C-2, C-4, I-6) |
| Sprint 8+ | DMS + manufacturer warranty integrations (1-2 chosen based on target market) | Scoping doc Phase 3 (I-1 / I-2 / I-3, I-4 / I-5) |

---

## 8. Success metrics

Track these to confirm the work landed.

### 8.1 Friction metrics (lower is better)

| Metric | Today | After Phase 1 | After Phase 2 |
|---|---|---|---|
| Median time-to-create a loaner intake (form-open → success message) | unmeasured | < 90s | < 60s |
| % of intake submissions that fail validation on first try | unknown (likely 30-50%) | < 15% | < 10% |
| % of double-submitted intakes (duplicate within 5s) | unknown (>0) | 0% | 0% |
| % of users who land on the page and exit within 5s without clicking anything | unmeasured | unmeasured | < 10% |

### 8.2 Quality metrics

| Metric | Today | After Phase 1 | After Phase 2 |
|---|---|---|---|
| Service-lane staff onboarding time to "comfortable" | varies | -25% | -50% |
| Sentry error rate on `/api/dealership-loaner/*` | unknown (assume low) | unchanged or lower | unchanged or lower |
| Customer NPS (post-loaner survey, once C-4 ships) | n/a | n/a | baseline |

### 8.3 Performance metrics

| Metric | Today | After §6 work |
|---|---|---|
| Dashboard initial-paint perceived speed | "blank for 1-3s" | "skeleton showing immediately" |
| /api/dealership-loaner/dashboard p95 | unmeasured | (Sentry traces will tell us; aim < 500ms with cache hits) |
| Reservation detail open from loaner queue (hover-prefetch) | full network round-trip on click | feels instant if cache hit |

---

## 9. Implementation suggestion — start here

If you want to ship something this week that materially improves the loaner UX, I'd batch **P1-1, P1-2, P1-4, P1-5, P1-7** (~1 day of work) into a small PR titled `feat(loaner): UX polish — required fields, button states, skeletons, copy`. That's the highest-leverage subset:

- Required-field marks + named validation = solves the #1 friction.
- Button disable + skeleton loaders = solves the perceived-speed problem.
- Copy edits = removes the jargon barrier for new staff.

Drop me a yes and I'll do the implementation in the sandbox so you can review + commit.

---

## 10. Open questions

1. **Tablet hardware target.** What size tablets do dealerships actually use — iPad Pro (11"), iPad standard (10.2"), Android Surface-class (12")? The CSS breakpoint choices change based on this. If unknown, design for 768-1024px range and verify on whatever hardware is available.
2. **Service-lane manager language.** Are "Borrower Packet" and "SLA Alert" terms YOUR target customers actually use, or industry jargon we adopted from the schema? If they use these, keep them. If not, soften the labels per P1-7.
3. **Auto-save vs explicit submit.** §4 mentions save-as-you-go pattern. Do your target customers prefer typing through a form and committing, or filling field-by-field and seeing autosave indicators? Different workflow cultures. Default to explicit-submit unless we have signal otherwise.
4. **NPS / feedback collection.** Does the target customer want survey data, or treat that as noise? Affects whether to prioritize C-4 (Phase 2 of the scoping doc).

---

## 11. References

- **Companion scoping doc:** `docs/operations/loaner-module-premier-product-2026-04-28.md` (feature-parity gaps).
- **Performance plan:** `docs/operations/performance-prep-2026-04-28.md` (back-office load prep — directly impacts the UX-perceived-speed items here).
- **Loaner page surveyed:** `frontend/src/app/loaner/page.js` (1,127 lines), with line-number citations throughout this doc and the audit it was built on.
- **Loaner backend:** `backend/src/modules/dealership-loaner/{service,routes}.js`.
- **Bug backlog:** `doc/known-bugs-2026-04-23.md` — open BUG-001 / BUG-002 / BUG-003 / BUG-004 all closed; loaner module has no open bugs.
