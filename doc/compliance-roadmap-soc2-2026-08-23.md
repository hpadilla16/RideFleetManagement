# Security Compliance Roadmap — SOC 2 Type II (ISO 27001 follow-on)

**Owner:** [responding organisation] · **Date:** 2026-08-23 · **Status:** programme initiated.

> The plan to obtain an independent security attestation. **Primary target: SOC 2 Type II** — most
> commonly requested of a SaaS, and 60–80% of the evidence collection can be automated with a
> readiness platform. The information-security management foundation built here also positions the
> organisation for **ISO 27001** as a follow-on, since the two overlap heavily.

---

## 1. Why SOC 2 Type II first

- **Type I** attests that controls are *designed* appropriately at a point in time — achievable
  quickly, useful as an interim proof.
- **Type II** attests that controls *operated effectively over a period* (we target a 3-month initial
  observation window, extendable to 6). This is the report customers and partners actually want.
- Sequence: reach **Type I readiness → begin the observation window → Type II report**.

## 2. Current state (what is already in place)

A large share of the technical controls exist and are documented:

- Access control (RBAC, fail-closed tenant scoping, capability gates), **2FA (TOTP)** for privileged
  roles, session revocation within 30s.
- Encryption in transit (TLS 1.2/1.3), field-encrypted integration credentials, PCI SAQ C.
- **Administrative/security audit trail**, request logging with PII redaction, error monitoring with
  a PII scrubber.
- Vulnerability management in CI (npm audit, Dependabot, CodeQL, gitleaks, Trivy) + a **DAST** pass.
- Default-deny **cloud firewall**, CORS allowlist, parameterised DB access, input validation.
- Nightly backups (30-day), platform point-in-time recovery.
- **Policies already written:** information-security policy, data-retention schedule,
  incident-response procedure, sub-processor list, architecture/data-flow diagram.

## 3. Gap analysis (to SOC 2 / ISO)

| Control family | Status | What's needed |
|---|---|---|
| Security policies | **Partial** | Core set written; add the readiness set in §5 |
| Risk management | **Missing** | Formal risk assessment + risk register + treatment plan |
| Asset management | **Missing** | Asset / data inventory |
| Access reviews | **Missing** | Scheduled, documented periodic access reviews |
| Change management | **Partial** | Documented change-management policy (CI/branch flow exists as evidence) |
| Vendor risk | **Partial** | Vendor register + risk assessments + DPAs (sub-processor list exists) |
| HR security | **Missing** | Background checks, onboarding/offboarding, confidentiality agreements, security-awareness training |
| BC/DR | **Partial** | BC/DR plan + **tested** restoration on a schedule |
| Logging retention / SIEM | **Partial** | Centralised log retention; SIEM/alerting maturity |
| Encryption at rest (field-level PII) | **Gap** | Optional field-level encryption of sensitive PII columns |
| Key management | **Gap** | KMS/vault + key rotation |
| Pen test | **Gap** | Independent third-party penetration test (annual) |
| Monitoring hardening | **Gap** | HSTS, restoration tests, formal metrics |
| Independent audit | **Missing** | Readiness platform + CPA auditor engagement + observation window |

## 4. Phased plan

| Phase | Window | Work | Owner |
|---|---|---|---|
| **0 — Foundation & docs** | weeks 0–4 | Write the readiness document set (§5); define scope, roles, asset inventory, risk assessment; select a readiness platform (Vanta / Drata / Secureframe) | Docs: engineering · Platform choice/budget: **[org]** |
| **1 — Implement & remediate** | month 1–3 | Close the technical gaps (HSTS, key rotation, restoration testing, log retention, field encryption if in scope); stand up process controls (access reviews, vendor assessments, HR controls, security-awareness training); connect the platform to auto-collect evidence | Eng + **[org]** |
| **2 — Observation window** | month 3–6+ | Operate the controls; the platform continuously collects evidence; run internal review; (optional) obtain a **Type I** report as an interim milestone | **[org]** + eng |
| **3 — Audit** | month 6–9 | Engage a licensed **CPA firm**; Type II audit over the observation window; receive the report; then plan ISO 27001 (Stage 1/2 with an accredited body) if pursued | **[org]** |

*Indicative timeline for a first SOC 2 Type II: ~6–9 months. A Type I interim report can be reached
in ~2–3 months.*

## 5. Document / readiness backlog (engineering can draft)

| Document | Status |
|---|---|
| Information-security policy | ✅ done |
| Data-retention schedule | ✅ done |
| Incident-response procedure | ✅ done |
| Sub-processor list | ✅ done |
| Architecture / data-flow diagram | ✅ done |
| **Risk assessment + risk register** | ▶ next |
| Asset / data inventory | ☐ |
| Access-control policy + periodic access-review procedure | ☐ |
| Change-management policy | ☐ |
| Vendor / third-party risk-management policy + register | ☐ |
| Business-continuity & disaster-recovery plan | ☐ |
| Data-classification policy | ☐ |
| Acceptable-use policy | ☐ |
| Secure-SDLC policy | ☐ |
| Vulnerability-management policy | ☐ |
| Logging & monitoring policy | ☐ |
| Backup policy | ☐ |
| HR security: onboarding/offboarding checklist + confidentiality agreement + security-awareness policy | ☐ |

## 6. What only the organisation can do

- Choose and pay for the readiness platform and the CPA auditor.
- HR/people processes (background checks, training records, agreements).
- Management review cadence and budget sign-off.
- Run the observation window (the controls operating over time).

## 7. Definition of done

A SOC 2 Type II report issued by a licensed CPA firm covering the Security criterion (and any of
Availability / Confidentiality / Privacy elected), with no exceptions material to the service — then
optionally ISO 27001 certification using the same ISMS foundation.
