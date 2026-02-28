# Fleet Management Project

## Vision
Internal fleet management software for operations, reservations, maintenance, and profitability.

## Monorepo Structure
- `docs/` product + architecture docs
- `backend/` API + business logic
- `frontend/` web app
- `infra/` deployment + docker
- `scripts/` automation and helper scripts

## Run Locally (without Docker)
### Backend
```bash
cd backend
npm install
npm run dev
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

## Run with Docker
From project root:
```bash
docker compose up --build
```

Services:
- Frontend: http://localhost:3000
- Backend: http://localhost:4000

## One-command daily operations (PowerShell)
- Start local stack + health checks:
```powershell
powershell -ExecutionPolicy Bypass -File .\ops\start-day.ps1
```
- Start with rebuild:
```powershell
powershell -ExecutionPolicy Bypass -File .\ops\start-day.ps1 -Rebuild
```
- Start using staging templates:
```powershell
powershell -ExecutionPolicy Bypass -File .\ops\start-day.ps1 -Env staging
```
- Start using production templates:
```powershell
powershell -ExecutionPolicy Bypass -File .\ops\start-day.ps1 -Env production
```
- Stop everything:
```powershell
powershell -ExecutionPolicy Bypass -File .\ops\stop-day.ps1
```

### Env template helper
```powershell
powershell -ExecutionPolicy Bypass -File .\ops\set-env.ps1 -Target staging
powershell -ExecutionPolicy Bypass -File .\ops\set-env.ps1 -Target production
```

## Backup checklist
See:
- `docs/operations/backup-checklist.md`

## Notes
- Backend reads env vars from `backend/.env`
- Frontend uses `NEXT_PUBLIC_API_BASE` (set in `docker-compose.yml`)
- You can keep adding modules/features freely; this setup is meant for iterative growth.

