# Asset & Data Inventory

**Owner:** [responding organisation] · **Version:** 1.0 · **Date:** 2026-08-23 · **Review:** quarterly
and on change.

> Readiness deliverable (compliance roadmap). Inventories the systems, data stores and data
> categories in scope, so controls, risk and retention can be tied to specific assets.

---

## 1. Systems / infrastructure assets

| Asset | Type | Provider / location | Data it holds | Owner |
|---|---|---|---|---|
| API + web application | Compute | DigitalOcean, NYC3 (NJ) | Transient request data (loopback-bound) | Eng |
| Background worker | Compute | DigitalOcean, NYC3 (NJ) | Job/queue data | Eng |
| Reverse proxy (nginx) | Network | DigitalOcean, NYC3 (NJ) | TLS termination; no storage | Eng |
| PostgreSQL database | Data store | Supabase on AWS us-east-1 (VA) | **All personal + transactional data** | Eng |
| Object storage (documents/photos) | Data store | Supabase on AWS us-east-1 (VA) | ID images, signatures, inspection photos | Eng |
| Redis cache | Data store | DigitalOcean, private net | Short-lived cached/operational data | Eng |
| Backup storage (Spaces) | Data store | DigitalOcean, NYC3 (NJ) | Nightly DB dumps (30-day) | Eng |
| Cloud firewall | Security control | DigitalOcean | — | Eng |
| Source repository | Code | GitHub (private) | Application source (no secrets — verified) | Eng |
| CI/CD | Pipeline | GitHub Actions | Build/test; scanning results | Eng |
| Secrets | Credentials | Host environment variables | Integration creds (field-encrypted), keys | Eng |

## 2. Data categories (and where they live)

| Category | Sensitivity | Location | Retention (see schedule) |
|---|---|---|---|
| Customer identity (name, contact, address, DOB) | **PII** | DB | Identity clock ~4y |
| Driving-licence number/state/expiry | **PII** | DB | Identity clock ~4y |
| Driving-licence / ID images | **Sensitive PII** | Object storage | Minimise after rental/claim |
| Signatures (image + name + IP) | **PII** | Object storage / DB | Identity clock ~4y |
| Inspection / damage photographs | Operational + incidental PII | Object storage | Claims period |
| Payment tokens / last4 / brand | Financial (no PAN/CVV) | DB | Accounting clock ~10y |
| Reservation / rental records | Transactional | DB | Two-clock |
| Telematics (GPS, odometer) | Operational | DB | With rental record |
| Audit trail / logs | Security | DB / container stdout | Policy |

## 3. Sub-processor assets

The full third-party inventory is maintained in the sub-processor list
(`tl-subprocessor-list-2026-08-23.md`) — all US-based, each processing only its assigned data.

## 4. Ownership & review

Engineering owns the technical assets; the responding organisation owns vendor relationships and
data-controller responsibilities. This inventory is reviewed quarterly and whenever an asset, data
category or sub-processor is added or removed.
