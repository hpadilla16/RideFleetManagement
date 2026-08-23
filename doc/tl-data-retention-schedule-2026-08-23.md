# Data Retention Schedule

**Owner:** [responding organisation — to be completed]
**Version:** 1.0 · **Effective date:** 2026-08-23 · **Review cadence:** at least annually, and on
change of applicable law.

> Prepared as the standalone data-retention schedule requested in Section 4 of the TL International
> information request; formalises Section 3.10 of the DDQ response. **Legal-basis attributions below
> are drafted for counsel review and are not legal advice** — counsel is to confirm or correct each
> period and its authority.

---

## 1. Principle — a two-clock model

Personal data is retained no longer than necessary, governed by two clocks implemented as a
configuration-driven retention sweep with per-record purge markers:

- **Identity clock (~4 years)** — direct identifiers are removed after the contract/claims-limitation
  period.
- **Accounting clock (~10 years)** — the remaining, anonymised transactional record is kept for the
  tax and financial-records period, then purged.

The regime ships in a conservative mode and is configured to this schedule before live UK data flows.

## 2. Schedule

| Data category | Retention | Basis (counsel to confirm) |
|---|---|---|
| Customer identity (name, contact, address, DOB) | Identity clock — ~4 years after the rental / last activity | Claims-limitation period |
| Driving-licence number, state, expiry | Identity clock — ~4 years | Claims-limitation; then minimise |
| Driving-licence / identity **images** | Removed / minimised once the rental and any live claim are closed | Data minimisation — no long statutory hold identified |
| Signatures (images + signer name/timestamp/IP) | Identity clock — ~4 years | Contractual limitation |
| Rental agreements (personal-data portion) | Identity clock | Contractual limitation |
| Rental agreements (financial record) | Accounting clock — ~10 years (anonymised) | Tax / accounting |
| Payment & transaction records (amount, method, status, gateway ref, last4, expiry) | Accounting clock — ~10 years (anonymised) | Tax and chargeback requirements |
| Damage / incident records and photographs | Claims-limitation period | Tort / personal-injury limitation |
| Tolls and citations | For the life of the attributed rental + claims period | Operational / claims |
| Vehicle telematics (GPS, odometer) | Operational retention; purged with the rental record | Policy |
| Passport data | **Not collected** | — |
| Administrative / security audit trail | Aged under the sweep (candidate ~24 months) | Security policy |
| API / system logs | Container logs size-rotated (10 MB × 5 per service) | Operational-security policy |
| Database backups | **30 days**, then rotated out | Company policy |
| Transient UI session table | Short cleanup (days) | Company policy |

*Candidate legal periods (for counsel): tax/accounting ~10 years (US federal + Puerto Rico Hacienda);
contract claims-limitation ~4 years (PR Civil Code / Act 55-2020); personal-injury limitation ~1
year in Puerto Rico, longer in some states. Counsel to confirm the applicable set per operating
jurisdiction.*

## 3. Erasure and exceptions

- A **single customer erasure service** removes, in one operation, the master customer record, its
  denormalised copies on contracts and additional-driver records, signature images, staged inbound
  records, and the underlying stored document and photograph files.
- Erasure applies an **explicit statutory-retention exception**: where a record must be kept to meet
  a tax/accounting or limitation-period obligation, the identifying fields are removed while the
  minimum required (anonymised) record is retained to the accounting clock.
- Erasure does not automatically propagate to sub-processors; where a sub-processor holds a copy,
  deletion is requested from that processor.

## 4. Deletion from backups

Backups are full database snapshots on a 30-day rotation. An erasure performed today is superseded
from all backup media within 30 days; individual records cannot be selectively excised from an
existing snapshot.

## 5. Data-subject requests

- **Access / portability:** a per-subject export assembles the data held about an individual across
  all tables holding it into a single structured, machine-readable record.
- **Deletion:** via the erasure service above.
- Requests concerning UK-originating data are coordinated with TL per the contractual roles.

## 6. Review

This schedule is reviewed at least annually and whenever applicable law changes, and is maintained
alongside the information-security policy and incident-response procedure.
