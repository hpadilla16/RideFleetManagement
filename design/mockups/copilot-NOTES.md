# Agent Copilot — architecture notes & build-feasibility design

Companion to `copilot-mockup.html`. Design only — no application code exists yet.
Date: 2026-08-31 · Branch: `design/copilot-mockups`

---

## 1. The vision, restated as a mechanism

> "A chatbot always ready for the agent in case they forget how to do something.
> If the agent asks 'how do I add an additional driver', the bot tells them how
> AND offers *te enseño* — then navigates to exactly where the thing is and
> guides them step-by-step until they complete it. For EVERYTHING in the
> knowledge base."

The platform already has both halves of this. The copilot is a **bridge, not a
new engine**:

| Half | Where it lives | What it gives the copilot |
|---|---|---|
| The knowledge (answers) | `backend/src/modules/knowledge-base/default-articles.js` — 16 bilingual articles (`DEFAULT_ARTICLES`, lines 53–984), seeded per-tenant with slug identity + `supersedes` hash upgrades (lines 25–48, 1022–1038). Plus ~35 hand-written playbooks in `frontend/src/app/knowledge-base/page.js` (e.g. `reservationPlaybooks`, line 103) with `route`, `steps[]`, `commonMistakes[]`. | Sourced step lists, bilingual in one body, already per-tenant and admin-editable. The KB service already does search: title/body `contains` + tag match, `knowledge-base.service.js:47–53`. |
| The guiding ("te enseño") | `frontend/src/components/training/TourHost.jsx` + `frontend/src/lib/training/curriculum.js` + `tour-state.js`. 13 modules, 33 steps, 26 `data-tour` anchors across 16 files. | Launched by ONE event: `window.dispatchEvent(new CustomEvent('ride-university:start', { detail: { track: 'MODULE', moduleKey } }))` — `TourHost.jsx:41` (constant), `:200–223` (listener). Cross-route navigation (`step.route`, TourHost `:265–296`), spotlight scrim (`:544–563`), record-scoped **parking** with a watcher (`parkIfRecordScoped` `:155–177`, waiting bar `:413–465`, `resumeAt` polling `:250–260`), completion event `ride-university:module-walked` (`:43`, fired `:319–328`), role + tenant-module gating (`curriculum.js modulesFor()` `:587–595`). |

So "te enseño" is **a dispatch call plus an intent→module map**. The tour
engine is production-proven (onboarding, showcase, module tracks, the 2026-08-28
parking fixes). The copilot adds: a launcher, an answer surface, and the map.

Mounting: a `CopilotMount` sits beside `TourMount` in `app/layout.js:141` —
same pattern (`TourMount.jsx:8–43`): reads the cached staff user, renders
`null` on customer-facing pages (kiosk, tracker, portal) and while the
screen-lock overlay is up (`AppShell.jsx:149` `IDLE_LOCK_MS`, `:245` `locked`).
Zero cost when closed: one event listener, no fetches.

---

## 2. The answer engine — options and the phased recommendation

### Option A — no-LLM intent match (MVP)
A static intent table (aliases EN/ES → `{ articleSlug | playbookId, tourModuleKey?, route? }`)
plus a scorer over article titles/tags/headings and playbook titles. The KB
list endpoint already supports `search`; the copilot needs one new read-only
endpoint at most (`GET /api/knowledge-base/copilot-index`) or can ship the
index to the client the way `curriculum.js` already ships.

- Answer rendering: split the bilingual body on its own `## … (Español)`
  heading — the corpus's hard convention (`default-articles.js:20–23`) — and
  show the asker's language. No translation layer.
- Pros: zero cost, zero latency, deterministic, fully offline, no new secrets.
- Cons: brittle phrasing ("¿cómo pongo otro chofer?" must alias-match), no
  synthesis across articles.

### Option B — LLM answering over retrieval
The platform **already calls Anthropic in production**: citation OCR
(`backend/src/modules/citations/citation-ocr.extract.js:18–20` —
`api.anthropic.com/v1/messages`, default model `claude-haiku-4-5`, `:88–110`)
and kiosk ID OCR (`kiosk-id-ocr.extract.js`), with per-tenant key resolution
via `backend/src/lib/tenant-provider-credential.js` (platform key fallback
policy already thought through — see the comment at `citation-ocr.extract.js:121–133`).

A `POST /api/copilot/ask` would: run the existing KB search + keyword scoring
to pick top-3 articles/playbooks, send them as context with a strict system
prompt ("answer ONLY from these sources, in the asker's language; return
`moduleKey` only from this allowlist; if unsure, return `NO_ANSWER`"), and
return `{ answerMd, sourceRef, tourModuleKey?, route? }`. The client dispatches
only moduleKeys it knows — the model never gets to name an arbitrary action.

- Pros: handles free phrasing, synthesizes ("what's the difference between
  Close and Void?"), cheap at haiku prices.
- Cons: needs latency handling, per-tenant key/entitlement decision, and the
  no-invention guardrail must be enforced by retrieval (no sources → no call).

### Recommendation — phased, A then B on the same UI
1. **Phase 1 (smallest shippable):** launcher + panel + Option A matcher +
   `te enseño` dispatch + `llévame` router.push + the "doesn't know" handoff to
   `/knowledge-base?search=…`. The conversation UI, intent map, guardrails and
   handoff are identical in every later phase — nothing is thrown away.
2. **Phase 2:** swap the matcher's "no confident match" branch for the LLM
   endpoint (Option B). Confident intent hits stay instant and free.
3. **Phase 3:** close the coverage gaps below — micro-modules and articles —
   and log unanswered questions per tenant: the miss list IS the authoring
   backlog.

---

## 3. The intent map — 16 articles × 13 tour modules

Curriculum modules (all in `frontend/src/lib/training/curriculum.js`):
`the-workspace`, `find-reservation`, `create-reservation`, `check-out`,
`check-in`, `take-payment`, `shuttle-tracker`, `overdue-returns`,
`shuttle-dispatch`, `availability`, `users-and-locations`,
`incoming-bookings`, `market-pricing`.

| # | Article slug | Category | Tour module for "te enseño" | Route for "llévame" | Coverage |
|---|---|---|---|---|---|
| 1 | `how-to-checkout` | CHECKOUT | `check-out` (needsRecord `/reservations`) | reservation → checkout wizard | FULL |
| 2 | `how-to-checkin` | CHECKIN | `check-in` (needsRecord) | reservation → check-in | FULL |
| 3 | `handling-damage-disputes` | DISPUTES | — none | Issue Center | **GAP: article, no tour** |
| 4 | `processing-toll-charges` | TOLLS | — none | `/tolls` | **GAP: article, no tour** |
| 5 | `car-sharing-trip-workflow` | CAR_SHARING | — none | trips screen | GAP (low priority — host surface) |
| 6 | `payment-processing` | PAYMENTS | `take-payment` (needsRecord) | reservation → payments | PARTIAL (gateway setup half has no tour) |
| 7 | `handling-citations` | DISPUTES | — none | `/citations` | **GAP: article, no tour** |
| 8 | `citation-documents-and-export` | DISPUTES | — none | citation detail | GAP (record-scoped candidate) |
| 9 | `precheckin-and-arrival` | AGREEMENTS | — none | reservation (pre-check-in card) | **GAP: article, no tour** (record-scoped candidate) |
| 10 | `quote-to-reservation` | GENERAL | — none | `/quotes` | **GAP: article, no tour** |
| 11 | `long-term-and-monthly-rentals` | AGREEMENTS | `create-reservation` (rate-type step only) | `/reservations/new` | PARTIAL (Bill Next Cycle has no tour) |
| 12 | `security-basics-for-agents` | GENERAL | `users-and-locations` (admin-only; scoping part) | `/people` | PARTIAL (2FA/screen-lock are self-evident flows) |
| 13 | `shuttle-dispatch-and-driver-mode` | GENERAL | `shuttle-dispatch` + `shuttle-tracker` | `/shuttles` | FULL |
| 14 | `maintenance-holds` | PLANNER | — none | `/maintenance` | **GAP: article, no tour** |
| 15 | `loaner-program` | AGREEMENTS | — none | loaner intake | **GAP: article, no tour** |
| 16 | `kiosk-operations` | GENERAL | — none | `/kiosks` | **GAP: article, no tour** |

Reverse gaps — **tour module, no article** (copilot answers from the module's
own `summary` + `steps[].body` + `gotcha`, which are real prose):
`the-workspace`, `find-reservation`, `create-reservation` (nearest article is
quotes/monthly), `overdue-returns`, `availability`, `incoming-bookings`,
`market-pricing`.

**Neither** (the owner's own example): *additional drivers*. Real screen at
`frontend/src/app/reservations/[id]/additional-drivers/page.js`, entered from
the reservation page button (`reservations/[id]/page.js:3399`), fee flag in
Settings (`settings/page.js:3694`) — but no article, no anchor, no module. Only
two playbook bullets mention it (`knowledge-base/page.js:127,133`). Phase 3
ships a 2-step micro-module (`additional-drivers`: anchor the button, anchor
the save) + a short article. Until then the copilot answers from the playbook
and offers **Llévame** (navigation) instead of **Te enseño** — the CTA row
degrades honestly by what the map has.

The intent map lives beside `curriculum.js` as
`frontend/src/lib/training/intents.js` — same "one file, many surfaces" rule
the curriculum already enforces (`curriculum.js:1–15`), and testable the same
way (`frontend/test/curriculum*.test.js` precedent). Rule going forward: a new
KB article ships with its `tourModuleKey` (or an explicit `route`) the way it
ships with a `sortOrder`.

The map deliberately carries **no `requiresContext` column**: what a module
needs before teaching (a route, or an open record) is derived at ask-time from
the curriculum itself — see the pre-flight check in §5.

---

## 4. UX decisions (as mocked)

**Launcher.** One dark pill, bottom-right, labeled with the question it
answers ("¿Cómo se hace…?" / "How do I…?"), teal dot — teal being the accent
`design-system.css` already reserves for the assistant voice (Voz AI ramp,
§1.4), while the product stays purple. Never auto-opens, no badges. Renders
`null` exactly where `TourMount` does (no cached staff user) plus while
`locked` is true. Keyboard: `?` opens, `Esc` closes. It must not collide with
the tour's own surfaces: TourHost portals at z-index 100000; the copilot sits
below that and **collapses to a chip whenever a tour state exists** (listen for
the same localStorage key `tour-state.js TOUR_STORAGE_KEY` + the start event).

**The handoff.** Answer card carries up to three CTAs, driven by the map row:
- `Te enseño` → **pre-flight context check first (§5)** → ask (record-scoped)
  or announce (route) → minimize to chip → dispatch `ride-university:start`
  `{ track:'MODULE', moduleKey }`.
  Everything after the dispatch is TourHost's job — including navigation to
  `step.route` and the **parking bar** when the module `needsRecord` and no
  reservation is open (the bot never re-implements this; mockup section 04
  shows the production bar verbatim).
- `Llévame allí` → `router.push(route)` only.
- `Ver artículo` → `/knowledge-base` deep link to the slug.
On `ride-university:module-walked`, the chip re-opens with a completion
message; for OPPORTUNISTIC modules it says the truth: the module completes when
the real record exists (`curriculum.js:78–89`).

**Guardrails.**
1. **Never acts.** Its only side effects are `router.push` and the tour event.
   No form-filling, no API writes. This also keeps training points honest —
   verification stays with the backend record checks (`curriculum.js:49–76`).
2. **Never invents.** Every answer names and links its source. No sourced
   match → the one-line "no lo tengo todavía" + `Buscar en Ride University`
   (pre-filled search) + optional "avisar a un admin". Misses are logged.
3. **Bilingual by corpus.** Answer language = question language; the EN/ES
   toggle re-renders the other half of the same body, never machine output.
4. **Role & gate aware.** Candidate modules filter through
   `modulesFor(viewer)` — an AGENT asking about Settings gets "eso lo hace un
   admin" plus the article, not a tour that dies on a missing anchor.

---

## 5. Pre-flight context check — right place before teaching

Owner refinement (2026-09-01, his words translated): *"make sure the agent is
in the CORRECT PLACE before starting to teach."* And its follow-up, same day:
*"the chatbot should ASK if they'd like to be guided in the reservation where
they're having the problem."*

**Why a question and not an announcement:** at the counter, "how do I add an
additional driver" is almost never an abstract question — it is about the
customer standing there, i.e. one SPECIFIC reservation. A walkthrough running
on the wrong record feels like a demo instead of help. One question converts
the tour from generic training into help-with-THIS-case, and the happy path
costs exactly one tap.

**The rule:** `Te enseño` never dispatches blind. Before firing the event, the
copilot compares the current route/context against what the mapped module
needs — its first step's `route`, and whether the module is record-scoped
(`needsRecord`, `curriculum.js:35–40`) — and **says what happens next** before
anything moves. The person is never teleported, and never watches a spotlight
arm on the wrong screen.

**What already exists vs. what is new — the honest split.** The *mechanics* of
being in the wrong place are already solved by the tour engine:

- Wrong screen → TourHost itself navigates: when `step.route && pathname !==
  step.route` it calls `router.push(step.route)` before locating the anchor
  (`TourHost.jsx:265–269`). Today that navigation is **silent**.
- No record open → TourHost parks: `parkIfRecordScoped` (`TourHost.jsx:155–177`)
  is applied to the very first settle at launch (`:215–219`), the persistent
  waiting bar renders (`:413–465`), and a watcher polls until the person opens
  a reservation (`resumeAt`, `:250–260`). Today the person *discovers* the bar
  after pressing the button.
- Already mid-record → the engine already distinguishes "on the module's first
  step, still needs to open a record" from "inside one, just move to the next
  screen" (`first` boundary logic, `TourHost.jsx:167`).

The **new** part is purely an *ask-first layer* in the copilot, run before the
dispatch, so intent → question → words → motion, in that order. No TourHost
change is required for outcomes (a) and (b); (a′) and (c) reuse the parking
machinery as-is.

**The check** is a pure helper beside the map (`intents.js`), testable like
`curriculum.js` selectors:

```js
// preflightFor(module, pathname) → one of four outcomes
function preflightFor(module, pathname) {
  if (module.needsRecord) {
    const inRecord = /^\/reservations\/[^/]+/.test(pathname);
    return inRecord
      ? { kind: 'ASK_HERE' }                      // outcome (a′) — a QUESTION
      : { kind: 'NEEDS_RECORD', go: module.needsRecord }; // outcome (c)
  }
  const first = module.steps?.[0];
  if (first?.route && pathname !== first.route)
    return { kind: 'NAVIGATE', to: first.route }; // outcome (b)
  return { kind: 'HERE' };                        // outcome (a)
}
```

**The four outcomes, with copy:**

| Outcome | When | The copilot says (ES / EN) | Then |
|---|---|---|---|
| (a) HERE | Route-anchored module and we are already on its screen | "Empiezo aquí mismo." / "Starting right here." | Dispatch immediately; chip. |
| (a′) ASK_HERE | Record-scoped module and a reservation IS open | **A question:** "¿Te guío aquí mismo en **{{ref}}**?" / "Want me to guide you right here on **{{ref}}**?" — with two one-tap replies: **[Sí, aquí]** and **[Es en otra reserva]** | **Sí, aquí** → dispatch on the open record; chip. **Es en otra reserva** → "Abre la reserva donde tienes el problema y sigo ahí." / "Open the reservation where you're having the problem and I'll pick up there." — panel collapses, copilot `router.push(module.needsRecord)`, then dispatches; launch-settle finds no anchors and parks (`:215–219`), the watcher (`:250–260`) resumes on THEIR record. |
| (b) NAVIGATE | First step carries a `route` and we are elsewhere | "Te llevo a **{{screen}}** primero — la guía empieza allá." / "I'll take you to **{{screen}}** first — the guide starts there." | Announce (~1.2s beat), then dispatch; TourHost's own `step.route` push does the moving (`:265–269`). Announced, never silent. |
| (c) NEEDS_RECORD | Record-scoped module, no reservation open | Same question shape, as an offer to follow them: "¿En qué reserva tienes el problema? Ábrela y sigo ahí." / "Which reservation is the problem on? Open it and I'll pick up there." — with a one-tap **[Llévame a Reservations]** | Dispatch; the engine's parking bar (`:413–465`) owns the wait, watcher resumes on whichever reservation they open — theirs. |

**Why (a′) must not dispatch blind, mechanically:** if the copilot dispatched
while reservation A's page is open, `settleStart` would find A's anchors and
the tour would arm on A immediately (`TourHost.jsx:215–219`) — which is exactly
right after **Sí, aquí** and exactly wrong if the problem lives on reservation
B. That is why "Es en otra reserva" navigates to the list FIRST and only then
dispatches: from `/reservations` the record anchors are absent, the launch
settle parks instead of arming, and the existing watcher follows the agent into
whichever reservation they open. The wrong-record case costs the engine
nothing new — it is the parked-launch path Ride University already exercises.

**Edge case, resolved by the question.** "Mid-task on record A, meaning record
B" was previously handled by teaching on A and saying so; the question
dissolves it — the agent tells us which case it is with one tap. Steps taught
on the open record still generalize (anchors are stable names, not records,
`curriculum.js:18–20`), which is why **Sí, aquí** is safe even when the agent
just wants to learn in the abstract.

**Derived, not stored — no `requiresContext` column in the intent map.** The
context requirement is fully derivable from the curriculum the tour already
obeys: `module.needsRecord` and `module.steps[0].route`. Storing it again in
`intents.js` would recreate the drift the curriculum's one-file rule exists to
kill (`curriculum.js:1–15`). For reference, the derived values for every
currently mapped module:

| Module | Derived pre-flight context | Source |
|---|---|---|
| `check-out` | record:reservation | `needsRecord:'/reservations'`, `curriculum.js:224` |
| `check-in` | record:reservation | `curriculum.js:259` |
| `take-payment` | record:reservation | `curriculum.js:290` |
| `create-reservation` | route `/reservations` | first step route, `curriculum.js:189` |
| `shuttle-dispatch` | route `/shuttles` | `curriculum.js:393` |
| `shuttle-tracker` | route `/shuttle` | `curriculum.js:323` |
| `users-and-locations` | route `/people` | `curriculum.js:463` |
| (future `additional-drivers` micro-module) | record:reservation | would set `needsRecord:'/reservations'` |

---

## 6. EN/ES copy (namespaced `copilot.*`, same i18n pattern as `training.*`)

| Key | EN | ES |
|---|---|---|
| `copilot.launcher` | How do I…? | ¿Cómo se hace…? |
| `copilot.title` | Copilot | Copiloto |
| `copilot.subtitle` | Ride University | Ride University |
| `copilot.hello` | Ask me how to do anything in RideFleet. I'll explain — and if you want, I'll show you on the screen itself. | Pregúntame cómo se hace cualquier cosa en RideFleet. Te explico — y si quieres, te enseño en la pantalla misma. |
| `copilot.placeholder` | Type your question… | Escribe tu pregunta… |
| `copilot.teach` | Show me | Te enseño |
| `copilot.takeMe` | Take me there | Llévame allí |
| `copilot.viewArticle` | View article | Ver artículo |
| `copilot.source` | Source | Fuente |
| `copilot.gotchaLabel` | Where people trip | Donde se traba la gente |
| `copilot.noAnswer` | I don't have that in the articles yet, and I'd rather not invent steps. | Eso no lo tengo en los artículos todavía, y prefiero no inventarte pasos. |
| `copilot.searchKb` | Search Ride University | Buscar en Ride University |
| `copilot.tellAdmin` | Tell an admin | Avisar a un admin |
| `copilot.touring` | Copilot · guide running | Copiloto · guía en curso |
| `copilot.done` | Did you get it done? | ¿Lo lograste? |
| `copilot.preflight.here` | Starting right here. | Empiezo aquí mismo. |
| `copilot.preflight.navigate` | I'll take you to {{screen}} first — the guide starts there. | Te llevo a {{screen}} primero — la guía empieza allá. |
| `copilot.preflight.askHere` | Want me to guide you right here on {{ref}}? | ¿Te guío aquí mismo en {{ref}}? |
| `copilot.preflight.yesHere` | Yes, here | Sí, aquí |
| `copilot.preflight.notThisOne` | It's a different reservation | Es en otra reserva |
| `copilot.preflight.followThere` | Open the reservation where you're having the problem and I'll pick up there. | Abre la reserva donde tienes el problema y sigo ahí. |
| `copilot.preflight.whichReservation` | Which reservation is the problem on? Open it and I'll pick up there. | ¿En qué reserva tienes el problema? Ábrela y sigo ahí. |
| `copilot.preflight.takeMeList` | Take me to Reservations | Llévame a Reservations |
| `copilot.adminOnly` | That screen needs an admin — here's what they'll do. | Esa pantalla la maneja un admin — esto es lo que va a hacer. |
| `copilot.footer` | Explains and guides · never performs actions | Explica y guía · nunca ejecuta acciones |

---

## 7. Smallest shippable Phase 1 (one branch)

1. `frontend/src/lib/training/intents.js` — the map in §3, a scorer over
   titles/tags/aliases, and the pure `preflightFor()` helper from §5 (all
   unit-tested like curriculum).
2. `frontend/src/components/copilot/CopilotMount.jsx` + panel — mounted in
   `app/layout.js` beside `TourMount`; renders null without a staff user or
   while locked; collapses to chip during tours.
3. Answer renderer: fetch article by slug from the existing KB API, split the
   bilingual body, show steps + bold-line gotcha + source chip + CTA row.
4. The three CTAs (dispatch / push / deep-link) + the no-answer handoff to
   `/knowledge-base?search=`.
5. `copilot.*` i18n keys (ES merged into the existing namespace — mind the
   namespace-merge gotcha).
6. Telemetry: log question, matched intent (or MISS), and whether te-enseño
   was taken — the flywheel for Phases 2–3.

No backend change is required for Phase 1. No schema change at all.
