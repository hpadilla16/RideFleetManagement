# Secure Software Development Lifecycle (SDLC) Policy

**Owner:** Engineering · **Version:** 1.0 · **Date:** 2026-08-23 · **Review:** annually.

> Readiness deliverable (compliance roadmap). Much is already enforced in the pipeline; this codifies it.

---

## 1. Principles

Security is built in, not bolted on. Every change is reviewed, automatically tested and scanned before
it reaches production; no secrets are committed; production data is protected in development.

## 2. Lifecycle controls

- **Design:** changes affecting personal data, auth, payments or tenant isolation get extra scrutiny;
  risky designs (e.g. field encryption) are written up and decided before coding.
- **Development:** work on branches off the production branch; parameterised DB access; input
  validation via shared validators; least-privilege and fail-closed tenant scoping by default.
- **Code review:** changes are reviewed before merge.
- **Automated testing & scanning (CI on every push/PR):** regression suite including **authorisation,
  tenant-isolation and money-path guards**; dependency audit (`npm audit`); SAST (CodeQL); secret
  scanning over full git history (gitleaks — a committed secret **fails the build**); container image
  scanning (Trivy).
- **Dynamic testing:** periodic DAST (OWASP ZAP) against the running application.
- **Deployment:** zero-downtime blue-green with health gating; idempotent DB migrations applied before
  traffic; rapid rollback available.

## 3. Secrets & data in development

- No secrets in source control (verified continuously). Secrets are environment variables; the
  field-encryption/integration keys are held off-repository.
- Local/dev uses a disposable local database — **production data is not used in development**.

## 4. Dependencies

Automated dependency-update PRs (Dependabot); vulnerable dependencies are triaged and remediated;
critical fixable direct-dependency vulnerabilities are on the path to a hard CI gate.

## 5. Evidence

Pull requests, review records, CI run results (tests + scanners) and deploy logs are the SDLC evidence
for SOC 2.
