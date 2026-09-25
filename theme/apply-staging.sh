#!/bin/sh
# Push theme/dist/netflix.css inline into STAGING branding CustomCss (testing only).
# --import switches to the release form: @import url("/NetflixUi/netflix.css?v=VER");
set -eu
cd "$(dirname "$0")/.."
. ./.staging.env
ver=$(tr -d ' \n' < theme/VERSION)
auth="Authorization: MediaBrowser Token=\"$STAGING_API_KEY\""
cur=$(curl -fsS -H "$auth" "$STAGING_URL/System/Configuration/branding")
if [ "${1:-}" = "--import" ]; then
    css="@import url(\"/NetflixUi/netflix.css?v=$ver\");"
else
    css=$(cat theme/dist/netflix.css)
fi
body=$(printf '%s' "$cur" | CSS="$css" python3 -c 'import json,os,sys; b=json.load(sys.stdin); b["CustomCss"]=os.environ["CSS"]; print(json.dumps(b))')
printf '%s' "$body" | curl -fsS -X POST -H "$auth" -H 'Content-Type: application/json' --data-binary @- "$STAGING_URL/System/Configuration/branding"
echo "branding updated ($(printf '%s' "$css" | wc -c | tr -d ' ') bytes)"
