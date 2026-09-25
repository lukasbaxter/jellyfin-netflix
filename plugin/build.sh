#!/usr/bin/env bash
# Build the Netflix UI plugin in a dotnet 10 SDK container on `server`,
# zip it, and (with --install) drop it into the STAGING Jellyfin and restart it.
#
#   plugin/build.sh            build + zip into plugin/dist/
#   plugin/build.sh --install  also install into jellyfin-staging (never prod)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
HOST="${NFX_BUILD_HOST:-server}"
REMOTE=/tmp/nfx-build
STAGING_DIR=/home/admin/services/jellyfin-staging
INSTALL=0
[[ "${1:-}" == "--install" ]] && INSTALL=1

VER="$(awk -F'"' '/^version:/{print $2}' "$HERE/build.yaml")"
ABI="$(awk -F'"' '/^targetAbi:/{print $2}' "$HERE/build.yaml")"
GUID="$(awk -F'"' '/^guid:/{print $2}' "$HERE/build.yaml")"
[[ -n "$VER" && -n "$ABI" && -n "$GUID" ]] || { echo "build.yaml incomplete" >&2; exit 1; }

if [[ ! -f "$ROOT/theme/dist/netflix.css" ]]; then
  echo "warning: theme/dist/netflix.css missing, building without embedded css" >&2
fi

echo "== sync sources to $HOST:$REMOTE"
ssh "$HOST" "mkdir -p $REMOTE/plugin $REMOTE/theme/dist $REMOTE/nuget && sudo rm -rf $REMOTE/out"
rsync -a --delete --exclude bin --exclude obj --exclude dist \
  "$HERE/Jellyfin.Plugin.NetflixUi" "$HERE/web" "$HOST:$REMOTE/plugin/"
if [[ -f "$ROOT/theme/dist/netflix.css" ]]; then
  rsync -a "$ROOT/theme/dist/netflix.css" "$HOST:$REMOTE/theme/dist/netflix.css"
else
  ssh "$HOST" "rm -f $REMOTE/theme/dist/netflix.css"
fi

# Light minify of the embedded js copy (source stays readable): drop indentation, blank lines
# and whole-line // comments. Safe here because netflix.js has no template literals or
# multi-line strings (checked below).
if grep -q '`' "$HERE/web/netflix.js"; then echo "netflix.js has a template literal, minify would be unsafe" >&2; exit 1; fi
ssh "$HOST" "perl -i -ne 's/^[ \t]+//; next if /^\s*\$/ || m{^//}; print' $REMOTE/plugin/web/netflix.js && wc -c < $REMOTE/plugin/web/netflix.js | xargs echo 'embedded netflix.js bytes:'"

TS="$(date -u +%Y-%m-%dT%H:%M:%S.0000000Z)"
META=$(cat <<EOF
{
  "category": "General",
  "changelog": "",
  "description": "Netflix style hero, Top 10 and genre rows, hover previews and theme for the Jellyfin web client.",
  "guid": "$GUID",
  "name": "Netflix UI",
  "overview": "Netflix style home and theme for the Jellyfin web client",
  "owner": "lukasbaxter",
  "targetAbi": "$ABI",
  "timestamp": "$TS",
  "version": "$VER",
  "status": "Active",
  "autoUpdate": false,
  "imagePath": "",
  "assemblies": []
}
EOF
)

echo "== dotnet publish (sdk:10.0)"
ssh "$HOST" bash -s <<EOF
set -euo pipefail
sudo docker run --rm \
  -v $REMOTE:/src -v $REMOTE/nuget:/root/.nuget/packages \
  -w /src/plugin/Jellyfin.Plugin.NetflixUi \
  mcr.microsoft.com/dotnet/sdk:10.0 \
  dotnet publish -c Release -o /src/out -p:Version=$VER -p:AssemblyVersion=$VER -p:FileVersion=$VER --nologo -v q
test -f $REMOTE/out/Jellyfin.Plugin.NetflixUi.dll
sudo rm -rf $REMOTE/pkg && mkdir -p $REMOTE/pkg
cp $REMOTE/out/Jellyfin.Plugin.NetflixUi.dll $REMOTE/pkg/
cat > $REMOTE/pkg/meta.json <<'META'
$META
META
cd $REMOTE/pkg && rm -f ../netflix-ui_$VER.zip && python3 -c "import zipfile,sys; z=zipfile.ZipFile('../netflix-ui_$VER.zip','w',zipfile.ZIP_DEFLATED); [z.write(f) for f in ('Jellyfin.Plugin.NetflixUi.dll','meta.json')]; z.close()"
EOF

mkdir -p "$HERE/dist"
scp -q "$HOST:$REMOTE/netflix-ui_$VER.zip" "$HERE/dist/"
( cd "$HERE/dist" && md5 -q "netflix-ui_$VER.zip" 2>/dev/null > "netflix-ui_$VER.zip.md5" || md5sum "netflix-ui_$VER.zip" | cut -d' ' -f1 > "netflix-ui_$VER.zip.md5" )
echo "== built plugin/dist/netflix-ui_$VER.zip md5=$(cat "$HERE/dist/netflix-ui_$VER.zip.md5")"

if [[ $INSTALL -eq 1 ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/.staging.env"
  [[ "${STAGING_READY:-0}" == "1" ]] || { echo "staging not ready" >&2; exit 1; }
  echo "== install into jellyfin-staging"
  ssh "$HOST" bash -s <<EOF
set -euo pipefail
P=$STAGING_DIR/config/plugins
[[ -d \$P ]] || { echo "no staging plugins dir" >&2; exit 1; }
sudo find \$P -maxdepth 1 -name 'NetflixUi_*' -exec rm -rf {} +
sudo mkdir -p "\$P/NetflixUi_$VER"
sudo cp $REMOTE/pkg/Jellyfin.Plugin.NetflixUi.dll $REMOTE/pkg/meta.json "\$P/NetflixUi_$VER/"
sudo docker restart jellyfin-staging >/dev/null
echo restarted
EOF
fi
