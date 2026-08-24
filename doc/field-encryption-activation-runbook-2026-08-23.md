# Field Encryption Phase 1 — Activation Runbook

**Date:** 2026-08-23 · **Status:** code deployed INERT (commit b4f1623d). This runbook activates it.

> ⚠️ This encrypts **real production PII** and involves an **encryption key**. Do the steps in order,
> and **never lose the key** (key loss = permanent data loss). The key must NOT pass through chat,
> commits, or logs.

---

## 0. Decision needed FIRST — encryption scope

Post-activation, any encrypted column can no longer be filtered by SQL. The custom-report **"State"
filter** on the Customers dataset would return 0 rows once `state` is encrypted (group-by still works).

**Recommendation:** narrow the scope to the **street lines only** (`address1`, `address2`) and leave
`city`, `state`, `zip` in plaintext — they are low-sensitivity (not identifying on their own), are
used as report dimensions/filters, and encrypting them adds little privacy for a real functional cost.
Licence number, DOB and signatures (the sensitive fields) stay encrypted.

- **If you agree** → a one-line field-map change is made first (still inert), redeployed, *then* this
  runbook runs. No data is encrypted yet, so this is safe to change now.
- **If you want city/state/zip encrypted too** → accept the report-filter gap and proceed as-is.

## 1. Generate the key (YOU do this — never share it)

On a secure machine:
```bash
openssl rand -base64 32
```
- Store it in your **secrets manager / password vault** AND a secure offline backup.
- Set it on the droplet as `FIELD_ENC_KEY=<value>` in `backend/.env` — do **not** commit it, do not
  paste it into chat.

## 2. Rehearse on a copy (do NOT skip)

- Restore a recent backup (or a Supabase branch) into a **scratch** database.
- Point the backfill at the scratch DB and run a dry run, then a real run:
```bash
FIELD_ENCRYPTION_ENABLED=true FIELD_ENC_KEY=<key> DATABASE_URL=<scratch> \
  node backend/scripts/backfill-field-encryption.mjs --dry-run
# then without --dry-run on the scratch DB
```
- Verify: the app reads customers/agreements normally against the scratch DB (values decrypt), age
  rules work, DSAR export shows plaintext. Confirm timing/row counts.

## 3. Activate on production

1. Set `FIELD_ENC_KEY` + `FIELD_ENCRYPTION_ENABLED=true` in the droplet `backend/.env`.
2. Redeploy so the containers pick up the env (`ops/deploy.sh`). From now, **new writes are encrypted**;
   reads dual-read (old plaintext still readable).
3. **Run the backfill on production** (encrypts existing rows), in batches:
```bash
FIELD_ENCRYPTION_ENABLED=true FIELD_ENC_KEY=<key> DATABASE_URL=<prod> \
  node backend/scripts/backfill-field-encryption.mjs --batch-size 200
```
   It is resumable (keyset pagination) and idempotent (skips already-`encf:`-prefixed values).

## 4. Verify

- Spot-check in the DB: `Customer.licenseNumber` etc. now start with `encf:v1:`; `dateOfBirth` is null
  and `dateOfBirthEnc` is set.
- In the app: customer detail, agreement PDF, kiosk age-rules, and the **DSAR export** all show
  correct plaintext.
- No spike in errors (the read walker returns null on any decrypt failure — watch monitoring).

## 5. Rollback (if needed, BEFORE/EARLY in rollout)

- Reads always dual-read, so setting `FIELD_ENCRYPTION_ENABLED=false` stops *new* encryption but
  already-encrypted values still decrypt as long as `FIELD_ENC_KEY` remains set. **Do not remove the
  key** while any encrypted data exists.
- There is no bulk-decrypt script; if a full reversal is ever required it must be built. Hence the
  rehearsal in step 2.

## 6. Follow-up

- Move the key to a **KMS / envelope encryption** with rotation (design doc R5). The `encf:v1` format
  already carries a key version for rotation.
