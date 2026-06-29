
# Mandatory multi-agent workflow (set by Hector, 2026-06-29)

EVERY non-trivial task in EVERY session must flow through this pipeline. The main
assistant acts as the Project Manager (the PM subagent can't spawn other agents, so
the main assistant orchestrates) and deploys the specialist subagents defined in
`.claude/agents/`: `project-manager`, `innovation`, `graphic-design`, `quality-assurance`.

Flow:
1. PROJECT MANAGER (main assistant): clarify goal + acceptance criteria, decide WHICH
   specialist agents are needed (skip ones that add no value), and produce an ordered
   coordination plan with review/QA gates. Deploy agents as efficiently as possible
   (parallelize independent work).
2. BUILD: implement per the plan (build in a clean clone, embedded-postgres tests, etc.).
   For any UI-affecting work, produce a mockup and get Hector's approval BEFORE building.
3. REVIEW (in parallel): hand the build to the INNOVATION agent (best approach vs.
   codebase + industry best practices) AND, if UI is affected, the GRAPHIC DESIGN agent
   (UX clarity, consistency, Ride theme #8752FE). Any MUST-CHANGE items they raise go
   BACK to the Project Manager, who re-dispatches the fixes.
4. SIGN-OFF: once Innovation and Graphic Design both give OK, the Project Manager hands
   the change to the QUALITY ASSURANCE agent.
5. QA GATE: QA must return SHIP (no BLOCKER/MAJOR) before anything is eligible for deploy.
   QA verifies correctness, regression safety (nothing live breaks), test coverage, the
   team's quality bar, and data/financial safety.
6. DEPLOY: only after QA's SHIP. Then push tag, confirm CI green, give/run deploy.

Rules:
- Nothing is "done" until QA approves.
- UI reimagining always needs a Hector-approved mockup first.
- Keep control: do not auto-relax permissions or skip a gate to save time.
- Keep Hector informed with a crisp plan, not a wall of text.
