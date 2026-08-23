# Field-Level PII Encryption — Design & Decision

**Owner:** Engineering · **Date:** 2026-08-23 · **Status:** DESIGN — needs a scope decision before
implementation (maps to risk R4/R5 in the risk register).

> Application-level encryption of sensitive personal-data columns, as defence-in-depth beyond the
> platform's managed encryption at rest. **This is a real engineering project with a functional
> trade-off, not a config change** — hence a design + decision, not a same-day edit.

---

## 1. What we already have

Integration credentials are already field-encrypted with **AES-256-GCM + a random per-write IV**
(`integration-crypto`). The same primitive is reused here; the work is not the cipher, it is *which
columns, searchability, keys, and the backfill*.

## 2. The core trade-off (why this needs a decision)

**An encrypted column cannot be queried, filtered, sorted or partial-matched by the database.** RFM
searches and de-duplicates customers by **name, telephone and email** (DDQ 3.12). So:

- Encrypting **licence number, date of birth, address, signature images** → **safe** (these are not
  searched); transparent encrypt-on-write / decrypt-on-read, no functional loss.
- Encrypting **email / telephone** → breaks search and dedup **unless** we add a **blind index** (a
  deterministic HMAC of the normalised value in a separate indexed column) to restore *exact-match*
  lookup and dedup. **Partial/prefix search on these is lost.**
- Encrypting **name** → partial-name search is central to the UI; a blind index only restores exact
  match. **Recommendation: do NOT encrypt name** (accept it stays plaintext; it is lower-sensitivity
  than licence/DOB and is needed for search).

## 3. Recommended scope — phased

**Phase 1 — non-searched sensitive fields (recommended, low risk):**
`Customer.licenseNumber`, `dateOfBirth`, `address1/2`, `city/state/zip` (as applicable), and the
signature image data URLs, plus the denormalised copies of these on `RentalAgreement` /
additional-driver records. No blind index needed; no search impact.

**Phase 2 — searched contact fields (optional, invasive):** `email`, `telephone` with HMAC blind
indexes for exact-match lookup + dedup. Accept the loss of partial search on these, or keep them
plaintext. **Decide based on whether TL/counsel require it.**

**Out of scope:** `name` (search), payment fields (already tokens, no PAN/CVV), ID-document *images*
in object storage (encrypt at the storage layer separately if required).

## 4. Key management (couples with R5)

- Move from a single static key to **versioned keys** (a `keyId` tag stored with each ciphertext) so
  keys can be **rotated** without a full re-encrypt.
- Target a **KMS / envelope encryption** (e.g. cloud KMS) rather than a static env-var key.
- **Key loss = permanent data loss** — the key(s) must be backed up securely and separately.

## 5. Implementation approach

- A `fieldCrypto` helper (wrapping `integration-crypto`) with an output format that is **self-
  identifying** (a version/prefix), so encrypted and not-yet-encrypted values coexist during rollout.
- Apply transparently at the repository/service boundary (or a Prisma client extension) so call sites
  do not each handle crypto.
- **Backfill migration:** batched, resumable, encrypts existing rows; a marker column or the value
  prefix tracks progress; dual-read (decrypt-if-encrypted, else plaintext) during the transition.
- Full test coverage (round-trip, mixed-state reads, blind-index lookup for Phase 2).

## 6. Risks

- Search/dedup breakage if a searched field is encrypted without a blind index (mitigated by scope).
- Backfill runs over **production PII** — must be batched, reversible-in-plan, and rehearsed on a copy.
- Performance: per-row crypto on hot read paths (mitigate by encrypting only the scoped columns).
- Key loss (mitigate with secure key backup + KMS).

## 7. Recommendation & the decision needed

- **Do Phase 1 now** — it is scoped, has no functional trade-off, and covers the most sensitive fields
  (licence, DOB, address, signatures). Run it through the normal branch → CI → deploy pipeline with a
  rehearsed backfill.
- **Defer/decide Phase 2** (email/telephone) explicitly, since it costs partial search.

**Decision required from Hector:** approve Phase 1, and choose whether Phase 2 (contact fields with
blind indexes) is in or out. On approval, this becomes a scoped implementation task (coding → QA).
