# Change Management Policy

**Owner:** [responding organisation] · **Version:** 1.0 · **Date:** 2026-08-23 · **Review:** annually.

> Readiness deliverable (compliance roadmap). Defines how changes to production are proposed,
> reviewed, tested, approved and deployed. Much of this is already enforced by the existing workflow.

---

## 1. Principle

No change reaches production without review, automated verification, and a controlled deploy. Changes
are traceable to their author and their commit.

## 2. Workflow (in place today)

1. **Branch** — every change is made on a branch off the production branch (`main`), never committed
   directly to production ad hoc.
2. **Review** — changes are reviewed before merge.
3. **Automated verification (CI)** — an extensive regression suite runs on every push/PR: unit and
   integration tests, **authorisation and tenant-isolation guards**, money-path guards, plus the
   security scanners (dependency audit, SAST/CodeQL, secret scanning, container scanning). A newly
   committed secret fails the build.
4. **Merge** — only after review + green CI.
5. **Deploy** — via a **zero-downtime blue-green** process with health-gating; the new instance must
   pass `/health` before traffic is cut over, and the deploy aborts safely if it does not.
6. **Database migrations** — applied idempotently on boot before traffic is served, so a release
   cannot run against a schema missing a change.

## 3. Traceability

Every change is a signed-off commit with an author and message; releases are recorded. The
administrative audit trail records security-relevant configuration changes.

## 4. Emergency changes

An urgent fix follows the same branch → CI → deploy path; where speed is critical, review may be
expedited but is still performed, and the change is documented retrospectively within one business
day.

## 5. Rollback

Blue-green deploys keep the previous image available for rapid rollback; database changes are
additive/idempotent to avoid destructive rollbacks.

## 6. Evidence

Commit history, pull requests, CI run results and deploy logs serve as change-management evidence for
SOC 2.
