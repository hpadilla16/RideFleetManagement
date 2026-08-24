# Vanta Onboarding Runbook — start ASAP

**Owner:** [org] · **Date:** 2026-08-23 · **Target:** SOC 2 Type II (Security), Type I interim first.

> Fastest path to getting Vanta collecting evidence. Much is already in place (policies written,
> controls live) — the goal is to connect it and let evidence auto-flow.

---

## Day 1 — account + scope (owner)

1. **Sign up for Vanta**, pick the **SOC 2** framework (add ISO 27001 later — shared controls).
2. Set scope: **Security** criterion, **Type I → Type II**, observation window **3 months**.
3. Assign a **Security/Compliance Owner** (required named person) and add team members.
4. In Vanta, browse its **auditor marketplace** and request 2–3 quotes now (parallel-tracks the audit).

## Integrations to connect (the evidence engine)

Connect these so Vanta auto-collects — highest value first:

| Integration | Connect | Auto-covers |
|---|---|---|
| **GitHub** | OAuth to the RideFleetManagement org/repo | Code review, branch protection, CI checks, change management |
| **DigitalOcean** | API token (read) | Infra inventory, firewall, backups |
| **AWS** (Supabase's underlying) / **Supabase** | Where supported | DB/storage config, encryption at rest |
| **Google Workspace / identity provider** | OAuth | Employee list, MFA status, on/offboarding |
| **Sentry** | API | Monitoring/alerting evidence |
| **Vanta Agent** (on admin laptops) | Install | Endpoint security (disk encryption, screen lock, antivirus) |
| **Background-check + HR** (e.g. Vanta's partners) | Set up | HR security controls |

*If a system has no native Vanta integration, Vanta supports manual evidence upload + a URL/policy link.*

## Upload the policies we already have

Vanta asks for a policy set — **we already wrote most of it.** Upload / link:

- Information-security policy → `tl-information-security-policy-2026-08-23.md`
- Data-retention schedule → `tl-data-retention-schedule-2026-08-23.md`
- Incident-response procedure → `tl-incident-response-procedure-2026-08-23.md`
- Access-control & review policy → `access-control-review-policy-2026-08-23.md`
- Change-management policy → `change-management-policy-2026-08-23.md`
- Vendor/third-party risk policy + register → `vendor-risk-management-2026-08-23.md`
- Risk assessment + register → `risk-assessment-register-2026-08-23.md`
- Asset & data inventory → `asset-data-inventory-2026-08-23.md`
- Logging/monitoring + SIEM plan → `logging-monitoring-siem-plan-2026-08-23.md`
- Architecture/data-flow diagram → `tl-architecture-dataflow-2026-08-23.md` (PDF)
- Sub-processor list → `tl-subprocessor-list-2026-08-23.md`

*(Vanta has templates too — where our doc and their template overlap, keep ours and map it to the
Vanta control; adopt their template only for docs we haven't written, e.g. acceptable-use, SDLC, BC/DR
which are next in the roadmap backlog.)*

## Personnel / HR controls (owner — Vanta will flag these)

- Employee roster in Vanta (via the identity provider).
- **MFA enforced** for all staff on email/identity (Vanta checks this) — plus our app-level 2FA.
- Background checks, confidentiality agreements, security-awareness training assigned to each person.
- On/offboarding checklist (Vanta tracks completion).

## Close Vanta's remaining "tests"

Vanta shows a live list of passing/failing checks. Work the failing ones:

- Ones **we already satisfy** → connect the integration so Vanta *sees* it (firewall, backups, TLS,
  access model, code review, monitoring).
- Ones needing **the roadmap items** → knock them out: access reviews (do the first quarterly one and
  log it), the remaining policies (BC/DR, data-classification, acceptable-use, SDLC, vuln-mgmt,
  backup), the SIEM/log platform, restoration test, HSTS (done), field encryption Phase 1 (in progress).

## Then: observation window → audit

1. Reach **Type I readiness** (all in-scope controls designed + evidenced) — Vanta shows when.
2. Optionally get the **Type I** report as an interim proof.
3. Run the **3-month observation window** (controls operating; Vanta collects continuously).
4. Auditor performs the **Type II** audit → report issued.

## Who does what

- **Engineering:** connect GitHub/DO/Sentry integrations, keep the policy docs current, close technical
  Vanta tests, build the SIEM forwarder + field-encryption.
- **Owner/org:** Vanta subscription, HR controls + training, pick the auditor, run access reviews,
  management review, budget.

## First concrete actions (this week)

- [ ] Create the Vanta account; choose SOC 2 / Security / Type I→II.
- [ ] Connect **GitHub + DigitalOcean + identity provider** (biggest evidence coverage fast).
- [ ] Upload the 11 policy docs above.
- [ ] Enforce MFA on the identity provider for all staff.
- [ ] Request 2–3 auditor quotes via Vanta's marketplace.
