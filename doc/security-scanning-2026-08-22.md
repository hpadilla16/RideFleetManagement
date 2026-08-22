# Automated security scanning — Phase 1

**Created:** 2026-08-22
**Owner:** Engineering (RFM CI)
**Status:** Phase 1 shipped — report-first, with a documented path to gating.

This document is the evidence artifact for the automated security scanning added
to RideFleetManagement CI. It describes what each scanner covers, when it runs,
what fails versus what only warns today, and what will eventually hard-gate.

Everything here is **additive**. The existing correctness gates —
`.github/workflows/beta-ci.yml` (money-path guards, tenant-isolation suite) and
`.github/workflows/rideops-ci.yml` (enum parity, Flutter build) — are unchanged.
This is CI configuration only; it does not touch production runtime.

---

## Scanners and coverage

| Scanner | Tool | Covers | Config |
|---|---|---|---|
| Dependency audit | `npm audit --audit-level=high` | Known CVEs in `backend/` and `frontend/` dependency trees (NOT root — root `package.json` is a near-empty shell) | `.github/workflows/security-scan.yml` → `dependency-audit` |
| Dependency updates | Dependabot | Automated update PRs for `backend`, `frontend`, root, and GitHub Actions | `.github/dependabot.yml` |
| Static analysis (SAST) | CodeQL (`javascript-typescript`) | Backend (Express/Prisma) + frontend (Next 14) JS/TS source; injection, unsafe deserialization, path traversal, etc. | `.github/workflows/security-scan.yml` → `codeql` |
| Secret scanning | gitleaks (full git history) | Committed credentials/tokens across all files and all commits | `.github/workflows/security-scan.yml` → `secret-scan`; allowlist in `gitleaks.toml` |
| Container image scan | Trivy (image mode) | OS + language-package HIGH/CRITICAL, fixable, in the two prod images built from `backend/Dockerfile.prod` and `frontend/Dockerfile.prod` | `.github/workflows/security-scan.yml` → `container-scan` |

---

## Triggers and cadence

All jobs live in `.github/workflows/security-scan.yml`, a standalone workflow.

| Trigger | Fires |
|---|---|
| `push` to `main` | dependency-audit, codeql, secret-scan (container-scan only if a `backend/**`, `frontend/**`, or Dockerfile path changed) |
| `pull_request` to `main` | dependency-audit, codeql, secret-scan (container-scan only if a Docker/app path changed) |
| `schedule` — **`0 6 * * 0`** (weekly, Sunday 06:00 UTC, a fixed off-peak slot) | all jobs, including container-scan |
| `workflow_dispatch` (manual) | all jobs, including container-scan |

Dependabot runs weekly (Sunday 06:00 UTC), grouped minor/patch per ecosystem,
capped at 5 open PRs per ecosystem.

The container-scan job is guarded by a `changes` job (using `dorny/paths-filter`)
rather than workflow-level `on: paths` filters — a workflow-level path filter
would also suppress the cheap jobs (audit, CodeQL, secret-scan) on unrelated PRs,
which we do not want. So the expensive image build runs only when it is relevant
or on the weekly/manual schedule.

---

## Fail-vs-warn matrix

**Phase 1 posture is report-first.** Only one gate is live today: a new secret.

| Scanner | Today (Phase 1) | Planned hard gate |
|---|---|---|
| Dependency audit | **Warn.** `continue-on-error: true`; prints a severity summary to the run summary. Never blocks. | Block on **CRITICAL + fixable** vulnerabilities in a **direct** dependency (transitive/unfixable stay advisory). |
| CodeQL | **Warn.** Report-only; results upload to the Security tab when GHAS permits. The job never gates and never fails the run even if SARIF upload is rejected. | Block on **new error-severity** alerts introduced by the **PR diff** (not the pre-existing backlog). |
| Secret scan (gitleaks) | **GATE (live).** A **new, non-allowlisted** secret **fails** the job. Known CI dummies are allowlisted in `gitleaks.toml`, so the gate fires only on genuinely new material. | Already gating — kept as-is. |
| Container scan (Trivy) | **Warn.** `continue-on-error: true`; `--severity HIGH,CRITICAL --ignore-unfixed`; prints findings to the run summary. Never blocks. | Block on **HIGH/CRITICAL with a fixed version available** once the base-image update cadence is established. |

Rationale for report-first: we want a full inventory of what these scanners
surface on the current codebase before turning any of them into a merge blocker,
so the first gates we add are ones we have already triaged to near-zero noise.
The one exception — new secrets — is gated from day one because a leaked
credential is high-impact, low-false-positive, and cheap to remediate.

---

## Where reports live

- **Dependency audit & Trivy:** the GitHub Actions **run summary** (`$GITHUB_STEP_SUMMARY`) for each run. Trivy findings also as the step output.
- **CodeQL:** the repository **Security → Code scanning alerts** tab (requires GHAS on private repos; the analysis still runs regardless, and its SARIF is produced even when the UI is unavailable).
- **gitleaks:** the job log (redacted) plus a `gitleaks-sarif` build artifact uploaded on every run.
- **Dependabot:** open pull requests, labelled `dependencies`.

---

## CI dummy secrets allowlisted in `gitleaks.toml`

These are established, harmless test fixtures. They are allowlisted so the
secret-scan gate does not fail permanently on them. See `gitleaks.toml` for the
exact regexes.

| Dummy value | Where it appears |
|---|---|
| `ci-test-secret-do-not-use-in-prod` | `.github/workflows/beta-ci.yml` (tenant-isolation `.env`) |
| `ci-resolve-only` | `.github/workflows/beta-ci.yml` (transitive-import step) |
| `postgresql://postgres:postgres@localhost:5432/ci_unit_only...` | `.github/workflows/beta-ci.yml` (money-guard step) |
| `postgresql://postgres:postgres@localhost:5432/ci_resolve_only...` | `.github/workflows/beta-ci.yml` (transitive-import step) |
| `postgresql://postgres:postgres@db:5432/fleet_management...` | `.github/workflows/beta-ci.yml` (tenant-isolation `.env`) |
| `test-jwt-secret-for-account-deletion` | `backend/src/modules/public-booking/account-deletion.test.mjs` |
| `test-jwt-secret-for-inspection` | `backend/src/modules/customer-inspection/customer-inspection.test.mjs` |
| `test-secret-for-password-gate-tests-0123456789` | `backend/src/modules/auth/password-gate.test.mjs` |
| `test-secret-for-service-auth-tests-0123456789` | `backend/src/modules/auth/service-auth.test.mjs` |
| `test-secret-for-va-commission-tests-0123456789` | `backend/src/modules/rental-agreements/virtual-agent-commission.test.mjs` |
| `test-secret-for-mileage-override-tests-0123456789` | `backend/src/modules/reservations/mileage-override.test.mjs` |
| `test-secret-for-kiosk-staff-assist-0123456789` | `backend/src/modules/kiosk/kiosk-staff-assist.test.mjs` |
| `test-secret-key` | `backend/src/modules/public-booking/payarc-hosted-fields.test.mjs` |
| `change-this-secret` | `backend/.env.example` (placeholder) |
| `dev-secret-change-me` | `backend/src/modules/auth/auth.config.js` (rejected insecure default) |

---

## Triage log

To be filled after the first scheduled/dispatch run. One row per finding
triaged; the goal is to drive each scanner's real-signal count low enough to
promote it from warn to gate per the matrix above.

| Date | Scanner | Finding | Severity | Disposition (fix / ignore+reason / allowlist) | Owner |
|---|---|---|---|---|---|
| _(pending first run)_ | | | | | |
