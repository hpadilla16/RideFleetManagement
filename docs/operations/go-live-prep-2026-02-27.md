# Go-Live Prep Status (2026-02-27)

## Completed now
- Confirmed frontend production build passes (`next build`).
- Upgraded frontend Next.js from `14.2.5` ? `14.2.35` and re-ran production build successfully.
- Confirmed backend source syntax checks pass (`node --check` on all backend `src/**/*.js`).
- Generated Prisma client successfully (`npm run prisma:generate`).
- Verified reservation unpaid-balance handoff fix compiles in production build (`/reservations/[id]` + `/reservations/[id]/payments`).

## Current blockers / risks before production
1. **Dependency vulnerabilities remain**
   - Frontend: `next` still has a high-severity advisory unless moving to `15.0.8+` / `15.5.10+` / latest major.
   - Backend: `nodemailer@6.10.1` flagged (high). Suggested fix path is major upgrade to `8.x`.

2. **Repository hygiene**
   - Project root currently contains many `tmp_*` patch scripts and scratch files.
   - Recommend cleanup/archive before release to reduce operator mistakes.

3. **No explicit production compose profile yet**
   - Current `docker-compose.yml` is dev-oriented (bind mounts + `npm run dev`).
   - Recommend dedicated production compose/deploy manifest with immutable images and `npm start`.

## Recommended next actions (in order)
1. Freeze release candidate branch/tag from current working state.
2. Run full user-journey smoke test on staging:
   - reservation create/edit
   - charges table save
   - view payments / record OTC payment
   - checkout/checkin lifecycle
   - print/email agreement
   - tenant isolation sanity checks
3. Decide security posture for dependency advisories:
   - either patch now (preferred) or document accepted risk + compensating controls.
4. Clean root `tmp_*` files into an archive folder (`backups/phased-rebuild/tmp-scripts-archive/`).
5. Add production runbook (start/stop/restart, DB backup/restore, rollback).

## Quick command log (executed)
- Frontend:
  - `npm install`
  - `npm audit --json`
  - `npm run build`
- Backend:
  - `npm install`
  - `npm run prisma:generate`
  - `node --check src/**/*.js`
  - `npm audit --json`

## Release readiness summary
- **Functional compile status:** PASS
- **Security readiness:** NOT READY (dependency advisories unresolved)
- **Operational readiness:** PARTIAL (needs prod deploy profile + cleanup + runbook)