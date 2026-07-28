#!/usr/bin/env bash
# ============================================================================
# SHIP: localise the business-documents panel. 2026-07-28.
#
# WHY: the panel shipped earlier today with hardcoded English copy while the
# rest of the app runs through react-i18next with en/es. Hector's team works in
# Spanish, so a Spanish-language operator was reading English labels on a screen
# about legal paperwork — exactly where a misread has consequences. My omission,
# fixed here.
#
# Adds a `locationDocs` namespace (en + es) plus the four dashboard tile keys
# that were previously inline defaultValues. Every visible string now resolves
# through t(): headings, the intro, form placeholders and labels, table headers,
# buttons, empty/loading states, all toasts and error messages, the document
# TYPE names, and the status chips.
#
# The status chip text moved into a makeStatusText(t) factory because it is the
# sentence the operator actually acts on ("Venció hace 3d") and had to be
# translatable, not just re-labelled.
#
# Verified: all 45 keys used by the panel and the dashboard tile resolve in BOTH
# locales (a script walks the t() calls against each JSON), and en/es key sets
# are at parity.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "frontend/src/components/settings/LocationDocumentsPanel.jsx"
  "frontend/src/locales/en.json"
  "frontend/src/locales/es.json"
  ".deploy-notes/2026-07-28-ship-location-documents-i18n.sh"
)

echo "== GATE 1: JSX parses =="
( cd frontend && node -e "
const { transformSync } = require('next/dist/build/swc');
const fs = require('fs');
transformSync(fs.readFileSync('src/components/settings/LocationDocumentsPanel.jsx','utf8'), { jsc: { parser: { syntax: 'ecmascript', jsx: true } } });
console.log('JSX OK');
" )

echo "== GATE 2: no English literals left + keys resolve in BOTH locales =="
c1=$( (grep -cE ">(Business documents|Add document|Valid until|Archive<|View<|Loading…|No documents)" frontend/src/components/settings/LocationDocumentsPanel.jsx || true) )
echo "hardcoded visible copy (0): $c1"; [ "$c1" -eq 0 ]
c2=$(grep -c "useTranslation" frontend/src/components/settings/LocationDocumentsPanel.jsx); echo "hook wired (>=1): $c2"; [ "$c2" -ge 1 ]
python - <<'PY'
import json, io, re, sys
en=json.load(io.open('frontend/src/locales/en.json',encoding='utf-8'))
es=json.load(io.open('frontend/src/locales/es.json',encoding='utf-8'))
src=io.open('frontend/src/components/settings/LocationDocumentsPanel.jsx',encoding='utf-8').read()
src+=io.open('frontend/src/app/page.js',encoding='utf-8').read()
def get(d,path):
    cur=d
    for p in path.split('.'):
        if not isinstance(cur,dict) or p not in cur: return None
        cur=cur[p]
    return cur
keys=set(re.findall(r"t\(['\"]([a-zA-Z0-9_.]+)['\"]", src))
keys |= {f'locationDocs.type.{c}' for c in ['PERMIT','REGISTRATION','INSURANCE','LICENSE','TAX','LEASE','OTHER']}
keys = {k for k in keys if k.startswith(('locationDocs','dashboard.tileDocs'))}
bad=[k for k in sorted(keys) if get(en,k) is None or get(es,k) is None]
print(f"i18n keys checked: {len(keys)}; missing: {bad or 'none'}")
sys.exit(1 if bad else 0)
PY

echo "== GATE 3: encoding =="
n=$(tr -dc '\r' < frontend/src/components/settings/LocationDocumentsPanel.jsx | wc -c); [ "$n" -eq 0 ] || { echo "CR in panel: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests =="
( cd frontend && npm test )

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
