# Supabase Storage — bucket setup (16h)

Backend module `backend/src/lib/storage/supabase-storage.js` talks to Supabase
Storage via REST using the **service role** key. Before it can do anything
useful, two buckets must exist in the Supabase project and the env vars must
be wired.

This doc is the one-time setup checklist. After this, 16l (inspection-photo
migration) and the manual-receipt upload feature will both just work.

---

## 1. Create the buckets

Supabase dashboard → **Storage** → **New bucket**. Create two:

| Bucket name                  | Public? | Purpose                                                                 |
|------------------------------|---------|-------------------------------------------------------------------------|
| `inspection-photos`          | **No**  | Before/after vehicle photos. Served to staff/customers via signed URLs. |
| `payment-receipts`           | **No**  | Cash/ATH-mobile receipt scans. Strictly private.                        |

Default values for the rest (file size limit, allowed MIME types) are fine for
now. We will tighten later if abuse appears.

Bucket names are overridable via env:
- `SUPABASE_STORAGE_PHOTOS_BUCKET` (default `inspection-photos`)
- `SUPABASE_STORAGE_RECEIPTS_BUCKET` (default `payment-receipts`)

---

## 2. RLS policies

Supabase Storage RLS sits on the `storage.objects` table.

### Recommended policy set (apply to BOTH buckets)

Dashboard → **Storage** → bucket → **Policies** → **New policy** → "For full
customization".

#### a) Service role full access

```sql
-- Allow service_role to do anything in this bucket.
CREATE POLICY "service_role_full_access_<bucket>"
ON storage.objects
FOR ALL
TO service_role
USING (bucket_id = '<bucket-name>')
WITH CHECK (bucket_id = '<bucket-name>');
```

Replace `<bucket>` / `<bucket-name>` twice. Apply once for `inspection-photos`
and once for `payment-receipts`.

This is what the backend's service role key actually uses. Without this policy
even the service role is denied.

#### b) No anon access (default — confirm it stays that way)

Do **NOT** add policies for the `anon` or `authenticated` roles. All client
access goes through signed URLs minted by the backend.

If you accidentally turned the bucket Public, flip it back: bucket settings →
Public → off.

#### c) (Optional, photos only) Allow authenticated users to read their own tenant's photos

Only add this if a future feature needs direct authenticated reads. For 16l we
will use signed URLs, so skip.

---

## 3. Find your `SUPABASE_SERVICE_ROLE_KEY`

1. Supabase dashboard → **Project Settings** (gear) → **API**.
2. Scroll to **Project API keys**.
3. Copy the **`service_role`** secret. It is labeled "secret" and starts with
   `eyJ...`. **NOT** the `anon` public key.
4. Paste into `backend/.env`:

   ```
   SUPABASE_URL="https://<project-ref>.supabase.co"
   SUPABASE_SERVICE_ROLE_KEY="eyJ...<long string>..."
   ```

5. Rotate it the instant it leaks anywhere — Settings → API → "Reset
   service_role secret". It will break every running backend until updated.

Never put the service_role key in the frontend, mobile bundle, or any client
shipped to a customer.

---

## 4. Verification script

Save as `backend/scripts/verify-storage.mjs` and run with
`node scripts/verify-storage.mjs`. It uploads a 1-byte test object, downloads
it back, signs a URL, then deletes it.

```js
// backend/scripts/verify-storage.mjs
import 'dotenv/config';
import storage from '../src/lib/storage/index.js';

const bucket = process.env.SUPABASE_STORAGE_PHOTOS_BUCKET || 'inspection-photos';
const path = `_healthcheck/${Date.now()}.txt`;

console.log(`→ uploading to ${bucket}/${path}`);
const up = await storage.uploadObject({
  bucket, path,
  body: Buffer.from('ok'),
  contentType: 'text/plain',
});
console.log('  upload OK', up);

const dl = await storage.downloadObject({ bucket, path });
console.log('  download OK', { size: dl.size, contentType: dl.contentType, body: dl.body.toString() });

const url = await storage.getSignedUrl({ bucket, path, expiresIn: 60 });
console.log('  signed URL OK', url.slice(0, 80) + '...');

const del = await storage.deleteObject({ bucket, path });
console.log('  delete OK', del);

console.log('\nAll storage operations succeeded.');
```

Expected output: all four steps log "OK" with no exception. If you see
`UnauthorizedError`, the service role key or RLS policy is wrong. If you see
`NotFoundError` on upload, the bucket name is wrong.

Repeat with `SUPABASE_STORAGE_RECEIPTS_BUCKET=payment-receipts node scripts/verify-storage.mjs`
to confirm the receipts bucket.

---

## 5. Production checklist

- [ ] Both buckets created in production Supabase project (not just staging)
- [ ] RLS policy "service_role_full_access_*" exists for each bucket
- [ ] Buckets are **not** marked Public
- [ ] `SUPABASE_SERVICE_ROLE_KEY` set in prod env (Render / Fly / etc.) — NOT the anon key
- [ ] Verification script runs clean against prod (do it once, then delete the test object)
- [ ] Service role key rotated since any recent contractor/handoff
