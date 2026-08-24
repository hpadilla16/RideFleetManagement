# Business Continuity & Disaster Recovery Plan

**Owner:** [org] · **Version:** 1.0 · **Date:** 2026-08-23 · **Review:** annually and after any test.

> Readiness deliverable (compliance roadmap, risk R7/R12).

---

## 1. Objectives

| Metric | Target |
|---|---|
| **RTO** (recovery time objective) | ≤ 4 hours for the application |
| **RPO** (recovery point objective) | ≤ 24 hours (nightly backup); near-zero within the DB platform's PITR window |

## 2. What could disrupt service, and the response

| Scenario | Response |
|---|---|
| Application host failure (droplet) | Rebuild from the versioned images; `ops/deploy.sh` brings the stack up; DNS/proxy already points at it |
| Database corruption / accidental data loss | Restore via Supabase **point-in-time recovery** (within its retention window) or the nightly full backup (30-day) |
| Bad deploy | Blue-green rollback to the previous image (kept during deploy) |
| Provider outage (DigitalOcean / Supabase) | Wait on provider recovery within region; escalate via provider support; the queue-based integration means inbound/outbound to TL buffers rather than loses data |
| Ransomware / destructive compromise | Isolate, rotate all credentials, restore from a known-good backup, invoke the incident-response procedure |

## 3. Backups (see also the backup policy)

Nightly full database dump, 30-day retention, over TLS, US object storage; platform PITR for
fine-grained recovery. **Restoration testing:** perform and document a restore to a scratch
environment at least **quarterly** (this is the roadmap item that closes R7).

## 4. Roles & communication

- **Recovery lead:** [name — to be completed]. Coordinates the recovery and stakeholder comms.
- Internal + customer/partner communication follows the incident-response procedure's contacts.

## 5. Dependencies

DigitalOcean (compute/network/backup storage), Supabase-on-AWS (DB/storage), DNS, Let's Encrypt
(certs, auto-renew), the payment/email/SMS sub-processors. Each is US-based; provider status pages are
monitored during an incident.

## 6. Testing & review

- **Quarterly** restoration test (documented: what was restored, time taken, issues).
- **Annual** tabletop of a full-recovery scenario.
- Plan reviewed annually and after any real invocation or test.
