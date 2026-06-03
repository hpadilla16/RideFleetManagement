#!/usr/bin/env bash
# =====================================================================
# Merge dejavoo-spin-checkout-redesign into release as v0.9.0-beta.66.
# FULL CUTOVER — all tenants switch to checkout-wizard-v2.
# Run from your Mac, repo root:
#     bash .deploy-notes/2026-06-02-merge-dejavoo-beta66.sh
#
# This was validated in an isolated clone: the ONLY conflict is schema.prisma
# (both branches appended models). This script reproduces the exact resolution
# Claude validated — a clean union of the incident block (release) + the
# checkout-session block (dejavoo) — then prisma-validates before committing.
# =====================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BRANCH="release/v0.9.0-beta.58"
TAG="v0.9.0-beta.66"
DEJAVOO="origin/dejavoo-spin-checkout-redesign"

[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

echo "→ Fetching latest..."
git fetch origin --tags
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH" || true

echo "→ Merging $DEJAVOO (expect ONE conflict: schema.prisma)..."
set +e
git merge --no-ff --no-commit "$DEJAVOO"
MERGE_RC=$?
set -e

CONFLICTS="$(git diff --name-only --diff-filter=U)"
echo "→ Conflicted files:"; echo "${CONFLICTS:-  (none)}"
if [ "$CONFLICTS" != "backend/prisma/schema.prisma" ] && [ -n "$CONFLICTS" ]; then
  echo "✗ Unexpected conflicts beyond schema.prisma. Stop and review:" >&2
  echo "$CONFLICTS" >&2
  echo "   (run 'git merge --abort' to back out)" >&2
  exit 1
fi

echo "→ Resolving schema.prisma (union of incident + checkout-session blocks)..."
python3 - <<'PY'
import subprocess
def show(ref):
    return subprocess.check_output(['git','show',f'{ref}:backend/prisma/schema.prisma'], text=True).split('\n')

merged = open('backend/prisma/schema.prisma').read().split('\n')
rel = show('HEAD')        # release side
dej = show('MERGE_HEAD')  # dejavoo side

def block_from(lines, needle):
    for i,l in enumerate(lines):
        if l.startswith('// ===') and i+1 < len(lines) and needle in lines[i+1]:
            blk = lines[i:]
            while blk and blk[-1].strip()=='':
                blk.pop()
            return blk
    raise SystemExit(f'block marker not found: {needle}')

incident = block_from(rel, 'Incident / Damage Report module')
checkout = block_from(dej, 'Dejavoo Spin checkout redesign')

ci = next(i for i,l in enumerate(merged) if l.startswith('<<<<<<<'))
head = merged[:ci]
while head and head[-1].strip()=='':
    head.pop()

out = head + ['',''] + incident + [''] + checkout + ['']
open('backend/prisma/schema.prisma','w').write('\n'.join(out))

# sanity
txt = open('backend/prisma/schema.prisma').read()
assert '<<<<<<<' not in txt and '>>>>>>>' not in txt, 'conflict markers remain!'
for m in ['ReservationIncident','IncidentEvidence','AgreementClause','CheckoutSession','HandoffToken','AgreementSectionInitial','VehicleInspectionAnnotation']:
    assert f'model {m} ' in txt, f'missing model {m}'
print('  schema.prisma resolved — all 7 models present, no markers')
PY

git add backend/prisma/schema.prisma
git add -A

echo "→ prisma validate..."
( cd backend && npx prisma validate ) || { echo "✗ prisma validate failed — do NOT commit. Review schema." >&2; exit 1; }
echo "  ✓ schema valid"
echo

echo "→ Files in this merge:"; git diff --cached --name-only --diff-filter=ACM | wc -l
read -r -p "Commit merge + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. ('git merge --abort' to back out entirely.)"; exit 0; }

git commit -m "merge: Dejavoo Spin checkout redesign into release (v0.9.0-beta.66)

Full cutover — checkout-wizard-v2 + checkout-session state machine, SPIn
sale/preauth/tokenize + iPOSpays card-on-file, T&C/inspection handoff tokens.
Only schema.prisma conflicted (incident + checkout-session model blocks);
resolved as a union. Validated in an isolated clone: prisma valid, all backend
JS compiles, 52 existing tests pass, frontend parses. Today's beta.60-65 work
(override, vehicle-sync, incident, autocharge, DOB) preserved.

Migrations to apply (run once, in order): 20260528_dejavoo_checkout_session,
then 20260528_checkout_session_auto_emailed_at."
git tag "$TAG"
git push origin "$BRANCH" "$TAG"
echo "✓ Pushed $BRANCH and $TAG. Next: the deploy runbook (migrations FIRST)."
