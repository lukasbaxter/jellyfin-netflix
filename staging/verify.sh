#!/bin/bash
# Verify the Jellyfin 12.1 staging instance. Runs on the Mac (or anywhere with curl + python3).
# Reads .staging.env from the repo root. Prod is only ever READ (GET requests).
#   PROD_API_KEY=... staging/verify.sh     (optional; without it the prod comparisons are skipped)
# Pass --no-legacy-flip to skip the EnableLegacyAuthorization toggle test.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.staging.env; set +a
U=$STAGING_URL
P=${PROD_URL:-http://192.168.1.85:2101}
K=$STAGING_API_KEY
AUTH="Authorization: MediaBrowser Token=\"$K\""
fails=0
ok()   { echo "PASS  $*"; }
bad()  { echo "FAIL  $*"; fails=$((fails+1)); }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
j()    { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }

# 0. wait until the server answers authenticated calls (it may be mid-restart)
for i in $(seq 1 60); do [ "$(code -H "$AUTH" "$U/System/Info")" = 200 ] && break; sleep 5; done

# 1. version
v=$(curl -s "$U/System/Info/Public" | j "d['Version']")
[ "$v" = "${JF_VERSION:-12.1.0}" ] && ok "version $v" || bad "version is '$v'"

# 2. web client + login for both users
[ "$(code "$U/web/")" = 200 ] && ok "web client 200" || bad "web client"
login() {
  curl -s -H 'Authorization: MediaBrowser Client="verify", Device="verify", DeviceId="verify-'"$1"'", Version="1"' \
    -H 'Content-Type: application/json' -X POST "$U/Users/AuthenticateByName" \
    --data "{\"Username\":\"$1\",\"Pw\":\"$2\"}"
}
VJSON=$(login "$STAGING_VIEWER_USER" "$STAGING_VIEWER_PASS")
VTOK=$(echo "$VJSON" | j "d['AccessToken']" 2>/dev/null); VUID=$(echo "$VJSON" | j "d['User']['Id']" 2>/dev/null)
[ -n "$VTOK" ] && ok "login $STAGING_VIEWER_USER" || bad "login $STAGING_VIEWER_USER"
ATOK=$(login "$STAGING_ADMIN_USER" "$STAGING_ADMIN_PASS" | j "d['AccessToken']" 2>/dev/null)
[ -n "$ATOK" ] && ok "login $STAGING_ADMIN_USER" || bad "login $STAGING_ADMIN_USER"
VAUTH="Authorization: MediaBrowser Token=\"$VTOK\""

# 3. counts vs prod (within 1%)
# The 12.x migration deletes items whose files are gone (prod still lists them), so for
# Movie/Series/Episode the baseline is "prod items whose file still exists" (checked read-only over ssh).
# Staging counts use the admin user's view (a bare API key without userId collapses box sets).
AUID=$(curl -s -H "$AUTH" "$U/Users" | python3 -c "import json,sys;print([u['Id'] for u in json.load(sys.stdin) if u['Name']=='$STAGING_ADMIN_USER'][0])")
cnt() { curl -s -H "Authorization: MediaBrowser Token=\"$2\"" "$1/Items?IncludeItemTypes=$3&Recursive=true&Limit=0${4:-}" | j "d['TotalRecordCount']" 2>/dev/null || echo -1; }
prod_existing() {
  ssh server "sudo sqlite3 -readonly /home/admin/services/jellyfin/config/data/jellyfin.db \"select Path from BaseItems where Type='$1'\" | sed 's#^/media/#/mnt/unas/#' | while IFS= read -r f; do [ -e \"\$f\" ] && echo; done | wc -l"
}
if [ -n "${PROD_API_KEY:-}" ]; then
  for t in Movie Series Episode MusicAlbum Audio BoxSet Playlist; do
    uq="&userId=$AUID"; case $t in BoxSet|Playlist) uq="";; esac   # playlists are per user, count them server-wide
    s=$(cnt "$U" "$K" $t "$uq"); p=$(cnt "$P" "$PROD_API_KEY" $t); base=$p; note=""
    case $t in
      Movie)   base=$(prod_existing MediaBrowser.Controller.Entities.Movies.Movie); note=" prod-on-disk=$base";;
      Series)  base=$(prod_existing MediaBrowser.Controller.Entities.TV.Series); note=" prod-on-disk=$base";;
      Episode) base=$(prod_existing MediaBrowser.Controller.Entities.TV.Episode); note=" prod-on-disk=$base";;
    esac
    if python3 -c "import sys;s,p=$s,$base;sys.exit(0 if s>=0 and (p==s or abs(s-p)/max(p,1)<=0.01) else 1)"; then
      ok "count $t staging=$s prod=$p$note"
    else bad "count $t staging=$s prod=$p$note"; fi
  done
else
  echo "SKIP  prod count comparison (set PROD_API_KEY)"
fi

# 4. playback starts for 1 movie + 1 episode (PlaybackInfo + first MB of the stream)
for t in Movie Episode; do
  id=$(curl -s -H "$VAUTH" "$U/Items?userId=$VUID&IncludeItemTypes=$t&Recursive=true&Limit=1&SortBy=Random&HasTrickplayImages=true" | j "d['Items'][0]['Id']")
  pi=$(curl -s -H "$VAUTH" -H 'Content-Type: application/json' -X POST "$U/Items/$id/PlaybackInfo?userId=$VUID" --data '{}')
  ms=$(echo "$pi" | j "d['MediaSources'][0]['Id']" 2>/dev/null)
  c=$(code -H "$VAUTH" -r 0-1048575 "$U/Videos/$id/stream?static=true&mediaSourceId=$ms")
  [ "$c" = 206 ] || [ "$c" = 200 ] && ok "playback $t $id ($c)" || bad "playback $t $id ($c)"
  h=$(code -H "$VAUTH" "$U/Videos/$id/master.m3u8?mediaSourceId=$ms&VideoCodec=h264&AudioCodec=aac&SegmentContainer=ts&TranscodingMaxAudioChannels=2")
  [ "$h" = 200 ] && ok "hls transcode playlist $t ($h)" || bad "hls playlist $t ($h)"
done

# 5. auth forms. Staging runs with legacy auth ON (the prod day-one state, see UPGRADE.md 7).
# The test checks both states and puts back whatever was set before.
# The 12.1 web client opens /socket?ApiKey=<token> after login, so its socket does not need
# legacy auth. The browser check at the end proves it (test/socket-check.mjs).
authtest() {
  a=$(code -H "X-Emby-Authorization: MediaBrowser Client=\"v\", Device=\"v\", DeviceId=\"v\", Version=\"1\", Token=\"$K\"" "$U/System/Info")
  b=$(code -H "$AUTH" "$U/System/Info")
  c=$(code "$U/System/Info?api_key=$K")
  d=$(code "$U/System/Info?ApiKey=$K")
  echo "$a $b $c $d"
}
sock() {  # prints the HTTP status of a websocket upgrade using ?$1=<key>
  curl -s -o /dev/null -m 3 -w '%{http_code}' "$U/socket?$1=$K&deviceId=verify" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='
}
setlegacy() {
  curl -s -H "$AUTH" "$U/System/Configuration" | python3 -c "import json,sys;d=json.load(sys.stdin);d['EnableLegacyAuthorization']=$1;print(json.dumps(d))" > /tmp/nfx-sys.json
  code -H "$AUTH" -H 'Content-Type: application/json' -X POST --data @/tmp/nfx-sys.json "$U/System/Configuration" >/dev/null
}
legacy0=$(curl -s -H "$AUTH" "$U/System/Configuration" | j "d['EnableLegacyAuthorization']")
echo "INFO  EnableLegacyAuthorization is $legacy0 on staging"
if [ "$legacy0" = True ]; then
  r=$(authtest); [ "$r" = "200 200 200 200" ] && ok "auth legacy-on: all four forms 200" || bad "auth legacy-on got '$r' (want 200 200 200 200)"
  s1=$(sock api_key); s2=$(sock ApiKey)
  [ "$s1 $s2" = "101 101" ] && ok "websocket legacy-on: api_key 101, ApiKey 101 (web client socket works)" || bad "websocket legacy-on got api_key=$s1 ApiKey=$s2 (want 101 101)"
fi
if [ "${1:-}" != "--no-legacy-flip" ] || [ "$legacy0" != True ]; then
  # if this script dies between the flip and the restore, put legacy auth back anyway
  [ "$legacy0" = True ] && trap 'setlegacy True' EXIT
  [ "$legacy0" = True ] && setlegacy False
  r=$(authtest); [ "$r" = "401 200 401 200" ] && ok "auth legacy-off: X-Emby 401, MediaBrowser 200, api_key 401, ApiKey 200" || bad "auth legacy-off got '$r' (want 401 200 401 200)"
  s2=$(sock ApiKey)
  [ "$s2" = 101 ] && ok "websocket legacy-off: ApiKey 101" || bad "websocket legacy-off ApiKey=$s2 (want 101)"
  [ "$legacy0" = True ] && setlegacy True
  [ "$(curl -s -H "$AUTH" "$U/System/Configuration" | j "d['EnableLegacyAuthorization']")" = "$legacy0" ] \
    && ok "EnableLegacyAuthorization restored to $legacy0" || bad "EnableLegacyAuthorization not restored"
  trap - EXIT
  # The real web client, legacy off: socket uses ApiKey=, no 403 after login, remote control works.
  # (It flips legacy off and restores it itself.) Needs node + playwright in test/.
  if [ -d test/node_modules/playwright ]; then
    node test/socket-check.mjs | sed 's/^/  /' | tee /tmp/nfx-sock
    grep -q 'ALL PASS' /tmp/nfx-sock && ok "web client socket works with legacy auth off (test/socket-check.mjs)" \
      || bad "web client socket check with legacy off (see above)"
  else
    echo "NOTE  test/node_modules missing, skipped the browser socket check (cd test && npm ci)"
  fi
fi

# 6. plugins all Active
curl -s -H "$AUTH" "$U/Plugins" | python3 -c "
import json,sys
bad=[p['Name']+':'+p['Status'] for p in json.load(sys.stdin) if p['Status']!='Active']
print('PASS  all plugins Active' if not bad else 'FAIL  plugins not active: '+', '.join(bad))" | tee /tmp/nfx-pl; grep -q FAIL /tmp/nfx-pl && fails=$((fails+1))

# 7. subtitle settings live in per-library options now
curl -s -H "$AUTH" "$U/Library/VirtualFolders" | python3 -c "
import json,sys
libs=json.load(sys.stdin)
okk=all('SubtitleFetcherOrder' in l['LibraryOptions'] and 'SaveSubtitlesWithMedia' in l['LibraryOptions'] for l in libs)
print(('PASS' if okk else 'FAIL')+'  per-library subtitle options on %d libraries'%len(libs))" | tee /tmp/nfx-sub; grep -q FAIL /tmp/nfx-sub && fails=$((fails+1))
[ "$(curl -s -H "$AUTH" "$U/System/Configuration/subtitles" -o /dev/null -w '%{http_code}')" != 200 ] && ok "global subtitle config gone" || echo "NOTE  /System/Configuration/subtitles still answers"

# 8. staging never writes next to media
curl -s -H "$AUTH" "$U/Library/VirtualFolders" | python3 -c "
import json,sys
keys=['SaveLocalMetadata','SaveSubtitlesWithMedia','SaveTrickplayWithMedia','SaveLyricsWithMedia']
on=[l['Name']+'.'+k for l in json.load(sys.stdin) for k in keys if l['LibraryOptions'].get(k)]
print('PASS  no save-with-media options on' if not on else 'FAIL  on: '+', '.join(on))" | tee /tmp/nfx-sv; grep -q FAIL /tmp/nfx-sv && fails=$((fails+1))

echo; [ $fails = 0 ] && echo "ALL PASS" || echo "$fails FAILED"
exit $fails
