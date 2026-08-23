# Incident Response Procedure

**Owner:** [responding organisation — to be completed]
**Version:** 1.0 · **Effective date:** 2026-08-23 · **Review cadence:** at least annually, and after
any significant incident.

> Prepared as the incident-response procedure requested in Section 4 of the TL International
> information request; formalises Section 3.11 of the DDQ response.

---

## 1. Purpose and scope

This procedure defines how RFM detects, responds to and reports information-security incidents and
personal-data breaches affecting the platform or the data it processes, including UK-originating data
processed on behalf of TL International.

A **security incident** is any event that may compromise the confidentiality, integrity or
availability of systems or data. A **personal-data breach** is a security incident leading to the
accidental or unlawful destruction, loss, alteration, or unauthorised disclosure of or access to
personal data.

## 2. Roles

| Role | Responsibility |
|---|---|
| **Incident Lead** | [name/contact — to be completed] — coordinates the response end to end |
| **Technical responder(s)** | investigate, contain, eradicate, recover |
| **Privacy / legal contact** | [name/contact — to be completed] — assesses notification obligations |
| **TL liaison** | notifies and coordinates with TL |

## 3. Detection and reporting

Incidents may surface from: error-monitoring alerts (Sentry), the administrative/security audit
trail (anomalous logins, role changes, exports, impersonation), request logs, provider notifications
(DigitalOcean / Supabase / payment processors), automated scanning (CI, DAST), or a report from
staff or a customer. **Anyone who suspects an incident reports it immediately to the Incident Lead**
at [contact — to be completed].

## 4. Severity classification

| Severity | Definition | Example |
|---|---|---|
| **SEV-1** | Confirmed or likely breach of personal data, or a full outage | Unauthorised access to customer records; database compromise |
| **SEV-2** | Security control failure without confirmed data exposure | An exposed service, a leaked non-production credential |
| **SEV-3** | Minor / contained, no data at risk | A blocked intrusion attempt, a single failed control caught by monitoring |

## 5. Response steps

1. **Triage & classify** — the Incident Lead confirms the incident and assigns a severity.
2. **Contain** — stop the bleeding: revoke sessions/tokens (deactivation terminates access within 30
   seconds), rotate affected credentials, disable an affected account or endpoint, or block a source.
3. **Preserve evidence** — snapshot relevant audit-trail entries, request logs, error reports and
   system state before remediation alters them.
4. **Investigate** — determine scope: what data, whose data, how, when, and whether UK-originating
   data is involved.
5. **Eradicate & recover** — remove the cause, patch, restore from a known-good backup if needed, and
   verify the control is effective.
6. **Notify** — see Section 6.
7. **Close & review** — see Section 7.

## 6. Notification

- **To TL International:** where an incident affects, or may affect, UK-originating data, RFM will
  notify TL **within 24 hours of becoming aware**, to give TL adequate margin within its own UK GDPR
  deadline (72 hours to the ICO). The notification states what is known, the data and individuals
  potentially affected, the containment taken, and next steps, and is updated as facts develop.
- **Regulatory / statutory:** the privacy/legal contact assesses obligations under the applicable US
  state and Puerto Rico breach-notification laws and any federal sectoral obligations, and notifies
  as required. *(Specific statutes, thresholds and deadlines — counsel to confirm; see DDQ 3.11.)*
- **Affected individuals / sub-processors:** notified where required by law or contract.

## 7. Post-incident review

Within a defined period after closure, the Incident Lead runs a review: root cause, timeline, what
worked, what did not, and concrete follow-up actions (control fixes, new monitoring, a new regression
test). Follow-ups are tracked to completion. This procedure and the information-security policy are
updated as needed.

## 8. Contacts

| Purpose | Contact |
|---|---|
| Incident Lead (24/7 escalation) | ______________________________ |
| Privacy / legal | ______________________________ |
| Technical on-call | ______________________________ |

*(Contacts to be completed by the responding organisation.)*
