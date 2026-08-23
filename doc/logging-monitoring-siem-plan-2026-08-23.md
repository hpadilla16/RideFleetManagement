# Logging, Monitoring & SIEM — Policy and Plan

**Owner:** [responding organisation] · **Date:** 2026-08-23 · **Status:** policy + implementation plan
(maps to risk R8). Also serves as the roadmap's *logging & monitoring policy*.

> "SIEM" for an operation this size does not mean standing up a heavy self-hosted stack. It means
> **centralising logs + the security audit trail into a managed platform with retention, correlation
> and alerting.** This is a tooling + light-integration project, not a same-day code change.

---

## 1. What we log today

- **Request logs** — every API call (request id, method, path, status, duration, client IP, user
  agent, user id, tenant id), with a PII-redaction layer; bodies are not logged. Written to container
  stdout, **size-rotated** (10 MB × 5 per service).
- **Administrative / security audit trail** (`AdminAuditLog`, in the database) — authentication,
  role/user changes, password resets, exports, erasures, impersonation.
- **Error monitoring** — Sentry, with a PII scrubber, alerting on failures.

**Gap:** logs are not centralised or retained long-term, and there is no correlation/alerting layer
across them (no SIEM). This is R8.

## 2. Target (the "SIEM" for this scale)

1. **Centralise** container stdout logs + a stream/export of the `AdminAuditLog` security events into
   a **managed log platform**.
2. **Retain** security-relevant logs for a defined period (target **12 months**) to satisfy SOC 2.
3. **Alert** on security-relevant events (below).
4. **Correlate** across sources for investigation.

## 3. Tooling options (pick one)

| Option | Fit |
|---|---|
| **Better Stack / Logtail** | Lightweight, inexpensive, simple log shipping + alerts — good fit for this size |
| **Datadog (Logs + Security)** | Fuller platform; more powerful, higher cost |
| **Grafana Cloud (Loki)** | Cost-effective, flexible; more setup |
| **Panther / Elastic Security** | True SIEM; heavier, for when scale/compliance demands it |

*Recommendation for the first pass: a lightweight managed platform (Better Stack or Datadog). Some
integrate with Vanta for the SOC 2 "monitoring" controls.*

## 4. Alert rules (the security value)

- Spike in **failed logins** (per IP / per account) → possible brute force.
- Any **new privileged-role grant** (`ADMIN` / `SUPER_ADMIN`).
- Any **administrative impersonation** event.
- Any **data export or erasure** action.
- **5xx error spikes** or health-check failures.
- Unusual access patterns (off-hours privileged access, new-country admin login once geo is available).

## 5. Implementation steps

1. Choose the platform; provision it.
2. Ship container stdout to it (a log driver / forwarder — no app code change) and **stream the
   `AdminAuditLog` security events** (a small forwarder or periodic export — light code).
3. Configure retention (12 months for security logs).
4. Create the alert rules in §4; route to the on-call channel.
5. Document the runbook (who responds, links to the incident-response procedure).

## 6. Ownership

Platform choice, subscription and alert-routing are organisation decisions; engineering does the log
shipping and the audit-event forwarder. Ties into the incident-response procedure for what happens
when an alert fires.
