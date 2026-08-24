# Backup Policy

**Owner:** Engineering · **Version:** 1.0 · **Date:** 2026-08-23 · **Review:** annually.

> Readiness deliverable (compliance roadmap, risk R7).

---

## 1. What is backed up

- **Primary database** — nightly full dump.
- **Point-in-time recovery** — provided by the database platform (Supabase) within its retention
  window, for fine-grained recovery between nightly dumps.
- Object storage (documents/photos) is redundantly stored by the storage provider.

## 2. How

- Nightly dump transmitted **over TLS** to DigitalOcean Spaces (US, New Jersey).
- **Retention: 30 days**, then rotated out.
- **Encryption:** provider storage-level encryption; **client-side (GPG) encryption of the dump before
  upload is available and can be enabled** (key held off the host).

## 3. Restoration testing

A restore to a scratch environment is performed and **documented at least quarterly** (what was
restored, time taken, RPO/RTO met, issues). This is the roadmap item that closes risk R7.

## 4. Erasure interaction

Backups are full snapshots on a 30-day rotation; a GDPR erasure performed today is superseded from all
backup media within 30 days. Individual records cannot be selectively excised from an existing
snapshot (stated in the retention schedule).

## 5. Access & integrity

Backup storage access is limited to named administrators (covered by the access-review policy);
backups are validated by the restoration tests.

## 6. Evidence

Backup job logs, retention configuration and restoration-test records are the evidence for SOC 2.
