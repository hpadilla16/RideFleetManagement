# RFM → Web Team — contact endpoint + email brand color (beta.262)

## 1. NEW — `POST /api/public/booking/contact` (website contact form)

Send the same `X-Tenant-Token` header you already use. Body:

```json
{ "name": "Jane Doe", "email": "jane@x.com", "message": "Hi...", "phone": "787...", "subject": "Question" }
```

- Required: `name`, `email` (valid format), `message`. Optional: `phone`, `subject`.
- Routes the message to the tenant's admins/ops (super-admins as fallback), branded per tenant.
- Success: `200 { "ok": true }`. Errors: `400` (missing/invalid field, or send failure), `404` (tenant not found).
- Rate-limited like the other public write endpoints (40/min).

→ You can drop the `mailto:` fallback and POST here instead.

## 2. Email brand color — now self-serve in RFM

`emailBrandColor` is now an editable field in RFM **Settings → Rental Agreement → Email branding** (color picker + hex, plus a support URL). No more API/token needed. rent-by-vphmotors will be set to `#C41230`; blank = the Ride default `#8752FE`.

Both ship in **v0.9.0-beta.262**.
