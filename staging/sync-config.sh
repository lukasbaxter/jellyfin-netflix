#!/bin/bash
# Copy PROD Jellyfin config into STAGING. Read-only on prod. Run ON the server as root.
# Safe while prod runs: the DB is copied with sqlite3 -readonly .backup (consistent snapshot).
set -euo pipefail
P=/home/admin/services/jellyfin/config
S=/home/admin/services/jellyfin-staging/config
if docker ps --format '{{.Names}}' | grep -qx jellyfin-staging; then
  echo "stop jellyfin-staging first" >&2; exit 1
fi
mkdir -p "$S/data" /home/admin/services/jellyfin-staging/cache
t0=$(date +%s)
rm -f "$S/data/jellyfin.db" "$S/data/jellyfin.db-wal" "$S/data/jellyfin.db-shm"
sqlite3 -readonly "$P/data/jellyfin.db" ".backup $S/data/jellyfin.db"
echo "db backup $(( $(date +%s)-t0 ))s, integrity: $(sqlite3 "$S/data/jellyfin.db" 'PRAGMA quick_check;' | head -1)"
rsync -a --delete \
  --exclude "/data/jellyfin.db*" --exclude "/data/SQLiteBackups/" \
  --exclude "/cache/" --exclude "/log/" --exclude "/transcodes/" \
  --exclude "/plugins/" \
  "$P/" "$S/"
# plugin configs only (the 12.0 notes say remove repo plugins before migrating, reinstall after)
mkdir -p "$S/plugins"
rsync -a --delete "$P/plugins/configurations/" "$S/plugins/configurations/"
# nothing on staging may write next to media (mounts are :ro anyway)
for f in "$S"/root/default/*/options.xml; do
  sed -i -E 's#<(SaveLocalMetadata|SaveSubtitlesWithMedia|SaveTrickplayWithMedia|SaveLyricsWithMedia)>true#<\1>false#g' "$f"
done
echo "sync done in $(( $(date +%s)-t0 ))s"; du -sh "$S"
