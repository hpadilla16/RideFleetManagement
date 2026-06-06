#!/usr/bin/env bash
# v0.9.0-beta.117 — Bug-triage staged fixes (3 non-money fixes from the 2026-06-05 bug-agent run).
#   bash .deploy-notes/2026-06-05-ship-bug-triage-fixes-beta117.sh
#
# RUN AFTER beta.116 is deployed + verified. Applies three reviewed patches from
# ops/.agent-patches/ (none touch payments/checkout/pricing/ledger — not money paths):
#   1) precheckin staff-complete 500  (Sentry JAVASCRIPT-NEXTJSBACKEND-1M)
#        reservations.routes.js — reject an out-of-range dateOfBirth with HTTP 400
#        instead of passing it to prisma.customer.update() (which threw
#        PrismaClientUnknownRequestError -> unhandled 500).
#   2) MailerSend 502 -> guest-signin 500  (Sentry JAVASCRIPT-NEXTJSBACKEND-1K)
#        lib/mailer.js — wrap the MailerSend + Resend POSTs in a small transient
#        retry (429/502/503/504 + network errors, 2 short backoffs) so a single
#        upstream gateway blip no longer 500s guest sign-in.
#   3) Supabase upload raw 500  (Sentry JAVASCRIPT-NEXTJSBACKEND-1J)
#        loaner-agreement.routes.js — wrap() now maps StorageError to an
#        actionable status (503 + clear message on misconfig) instead of a 500.
#        NOTE: the ROOT cause of #3 is that SUPABASE_URL is unset on the droplet.
#        This patch only improves the error surface — set the env var too:
#          run `bash scripts/env-diff-check.sh` from your deployer machine and
#          add SUPABASE_URL (+ SUPABASE_SERVICE_ROLE_KEY) to the prod .env.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.117"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

PATCHES=(
  "ops/.agent-patches/01-precheckin-staff-complete-500.patch"
  "ops/.agent-patches/02-mailersend-502-retry.patch"
  "ops/.agent-patches/03-supabase-upload-storageerror.patch"
)
EDITED=(
  "backend/src/modules/reservations/reservations.routes.js"
  "backend/src/lib/mailer.js"
  "backend/src/modules/dealership-loaner/loaner-agreement.routes.js"
)

# ── PRE-FLIGHT: every patch must still apply cleanly on top of the deployed base
for p in "${PATCHES[@]}"; do
  [ -f "$p" ] || { echo "missing patch: $p" >&2; exit 1; }
  git apply --check "$p" || { echo "patch does not apply cleanly: $p (base changed since staging — re-review)" >&2; exit 1; }
done
echo "All ${#PATCHES[@]} patches apply cleanly. Applying…"
for p in "${PATCHES[@]}"; do git apply "$p"; done

# ── SYNTAX GATE (same gate the other ship scripts use)
for f in "${EDITED[@]}"; do ( cd backend && node --check "${f#backend/}" ); done
echo "node --check OK on all edited files."

FILES=( "${EDITED[@]}" "${PATCHES[@]}" ".deploy-notes/2026-06-05-ship-bug-triage-fixes-beta117.sh" )
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left applied + staged (not committed). To undo: git checkout -- ${EDITED[*]}"; exit 0; }
git commit -m "fix(triage): precheckin DOB 400, MailerSend transient retry, storage error mapping

Three non-money bug fixes from the 2026-06-05 bug-agent run:
- reservations precheckin staff-complete: reject out-of-range dateOfBirth with
  400 instead of an unhandled PrismaClientUnknownRequestError 500. (Sentry -1M)
- mailer: retry transient 429/502/503/504 + network errors on MailerSend/Resend
  so a gateway blip no longer 500s guest sign-in. (Sentry -1K)
- loaner photo upload: map StorageError to an actionable status (503 on
  misconfig) instead of a raw 500. (Sentry -1J; also set SUPABASE_URL on prod)"
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy v0.9.0-beta.117:"
echo "  git checkout v0.9.0-beta.117 && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
