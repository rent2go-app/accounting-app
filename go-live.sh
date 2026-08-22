#!/usr/bin/env bash
# Point the customer site at a domain. Run only once the DNS record resolves.
#
#   ./go-live.sh demo.rentaride2go.com
#   ./go-live.sh rentaride2go.com          # the real cutover, later
#
# Order matters. The CNAME file is written LAST, because the moment GitHub Pages
# sees it the old rent2go-app.github.io address stops serving and redirects to
# the new one - so if DNS is not already answering, that takes the site down.
set -euo pipefail
DOMAIN="${1:?usage: go-live.sh <domain>}"
SITE="https://${DOMAIN}/"
REPO="${REPO:-$HOME/Documents/GitHub/Rent2Go}"
PROJ=fsapfxhyjbgxjydahdlx
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36'
: "${SUPABASE_PAT:?set SUPABASE_PAT}"

echo "==> checking ${DOMAIN} actually resolves"
if ! dig +short "$DOMAIN" | grep -q .; then
  echo "    ${DOMAIN} does not resolve yet. Add the DNS record first:"
  echo "      CNAME  ${DOMAIN%%.*}  ->  rent2go-app.github.io."
  exit 1
fi
echo "    resolves"

echo "==> Supabase: sign-in and redirect URLs"
python3 -c "
import json,sys
print(json.dumps({'site_url':'${SITE}',
 'uri_allow_list':'${SITE}**,https://rent2go-app.github.io/Rent2Go/**,http://localhost:8788/**,http://127.0.0.1:8788/**'}))" > /tmp/auth.json
curl -s -X PATCH -A "$UA" -H "Authorization: Bearer $SUPABASE_PAT" -H "Content-Type: application/json" \
  --data @/tmp/auth.json "https://api.supabase.com/v1/projects/$PROJ/config/auth" -o /dev/null -w "    HTTP %{http_code}\n"
# the old address stays allow-listed on purpose: links already sitting in
# renters' inboxes must keep working through the changeover

echo "==> Supabase: SITE_URL, which every customer email is built from"
python3 -c "import json;print(json.dumps([{'name':'SITE_URL','value':'${SITE}'}]))" > /tmp/sec.json
curl -s -X POST -A "$UA" -H "Authorization: Bearer $SUPABASE_PAT" -H "Content-Type: application/json" \
  --data @/tmp/sec.json "https://api.supabase.com/v1/projects/$PROJ/secrets" -o /dev/null -w "    HTTP %{http_code}\n"

echo "==> admin console: point the renter preview at the new address"
sed -i '' "s#const SITE = 'https://[^']*index.html?r2gpreview=1'#const SITE = '${SITE}index.html?r2gpreview=1'#" renter-access.html
git add renter-access.html && git commit -qm "chore(deploy): preview points at ${DOMAIN}" && git push -q origin main
echo "    done"

echo "==> the site itself (last, for the reason at the top)"
cd "$REPO"
echo "$DOMAIN" > CNAME
git add CNAME && git commit -qm "chore(deploy): serve at ${DOMAIN}" && git push -q origin main
echo "    CNAME written and pushed"

echo
echo "Now, by hand and once: GitHub repo -> Settings -> Pages -> Custom domain"
echo "  set ${DOMAIN}, then tick Enforce HTTPS after the certificate is issued"
echo "  (that takes a few minutes and cannot be done through the API)"
