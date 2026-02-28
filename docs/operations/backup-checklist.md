# Fleet Management Backup Checklist (Daily/Weekly)

## Daily (5 minutes)

1. **Confirm app health**
   - Backend: `http://localhost:4000/health`
   - Frontend: `http://localhost:3000`
2. **Confirm Supabase project is active** (not paused)
3. **Export latest critical data snapshot** (from dashboard/DB if needed)
4. **Verify cron/report jobs ran** (reservation intake + notifications)
5. **Record issues** in ops notes if any failures occurred

---

## Weekly (15–30 minutes)

1. **Database backup check (Supabase)**
   - Verify automated backups are enabled in Supabase
   - Confirm latest successful backup timestamp
2. **Manual schema backup (recommended)**
   - Save current Prisma schema file:
     - `backend/prisma/schema.prisma`
3. **Config backup**
   - Copy sanitized env templates:
     - `backend/.env.example`
     - `frontend` env config references
4. **Disaster recovery test (quick)**
   - Confirm you can run:
     - `docker compose up -d`
     - `npm run prisma:generate` (backend)
5. **Security review**
   - Rotate admin passwords if needed
   - Review active users/roles and remove stale access

---

## Monthly (30–60 minutes)

1. **Restore drill (non-production)**
   - Restore backup to test environment
   - Validate API and frontend startup
2. **Dependency patching**
   - Backend/frontend package updates
   - Re-test login, reservations, status transitions, audit logs
3. **Audit log review**
   - Check admin overrides and unusual state transitions

---

## Incident Checklist (if something breaks)

1. `docker compose ps`
2. `docker compose logs backend --tail=120`
3. `docker compose logs frontend --tail=120`
4. Validate DB connection (`DATABASE_URL`)
5. Restart stack:
   - `docker compose down`
   - `docker compose up --build -d`

---

## Local startup/stop helpers

- Start day:
  - `powershell -ExecutionPolicy Bypass -File .\ops\start-day.ps1`
- Stop day:
  - `powershell -ExecutionPolicy Bypass -File .\ops\stop-day.ps1`
