# Prod upgrade: Jellyfin 10.11.5 to 12.1

Runbook for `jellyfin-jellyfin-1` on .85 (`ssh server`). Every step here was rehearsed on staging (`jellyfin-staging`, :2199) on 2026-09-25 against a copy of the prod config.

Target image, pinned by digest (never `:latest` again):

```
jellyfin/jellyfin:12.1.20260915-010956@sha256:78d3ea1207d1322471fcac39a614f004f2ccf7e878f95ab2977d752f07e4dd7e
```

Rollback image (what prod runs today, 10.11.5):

```
jellyfin/jellyfin@sha256:58b57fd06c97905fc095a2f9f188b39ef914db031ee69e9585324b64d40c6d6f
```

## What the official notes say (12.0 and 12.1)

- Direct upgrade from 10.11.x to 12.x is supported. No stop at 12.0 needed.
- There is no way back without a full restore. The DB schema changes.
- Remove repository plugins before migrating, reinstall them after.
- A full library scan is REQUIRED after the upgrade (it restores alternate versions).
- The first scan is slower than normal. Some movies may show as newly added.
- Legacy auth (`X-Emby-Authorization`, `X-Emby-Token`, `?api_key=`) is off by default and a migration turns it off on existing installs too.
- `/emby/*` and `/mediabrowser/*` route prefixes are gone.
- Global subtitle settings are gone. They are per library now.
- Usernames that differ only by case block the upgrade. (Checked: none on prod.)
- Plugins must target .NET 10 / ABI 12.0.0.0.

## Things staging found that the notes do not mention

1. **encoding.xml gets wiped.** Prod has `<EncoderPreset xsi:nil="true" />`. 12.1 cannot parse that, logs `Error loading configuration file: /config/config/encoding.xml`, and rewrites the file with defaults. That silently turns off NVENC, tonemapping, HEVC/AV1 encoding and the hw decode codec list. Fix it before first start (step 6). With the fix, staging kept `nvenc` and all 8 decode codecs.
2. **The migration deletes items whose files are missing.** `MigrateLinkedChildren` checks every item path (182k items). On staging it removed 1685 stale items (files really gone, for example The Wire S04). If `/mnt/unas` or `/mnt/wd_nvme1/music` is unmounted or wedged at that moment, it would treat the whole library as missing and wipe watch history. The UNAS pre-check below is not optional.
3. **Playlists and counts drop until the scan runs.** Right after the migration staging showed 180 playlists (prod 196). The missing ones were music playlists made from `.m3u` files in album folders. The full scan brought them back (196). Movies / Series / Episodes drop for good: 1516 to 1260, 284 to 195, 13436 to 12628. That is exactly the number of prod items whose file still exists on disk (checked one by one), so nothing real is lost. Expect the same on prod.
4. Streaming Collections 1.0.1.0 targets 10.11. It has to be rebuilt for net10/12 (release step 1 in the plan) before it can go back on.

## Measured on staging

- `MigrateSystem`: **195 s** (about 3.5 min). Log: `staging/migrate-20260925.log`.
- Full library scan: **75 min** (08:27 to 09:42 UTC). Movies and shows were done in about 5 min. The rest was the music library, held up by MusicBrainz rate limits on album lookups. Post-scan tasks took 2.5 min.
- Plan a **45 minute downtime window** (stop, backup of about 42 GB, migrate, start, plugins). The scan then runs with the server already up, so plan about 90 more minutes of "music may look odd". Do not restart during the scan: every restart aborts it, and staging lost 5 scan runs that way.

## Who breaks when legacy auth is off

| Caller | What it sends | Fix |
|---|---|---|
| Jellyseerr 2.7.3 (`services-jellyseerr-1`) | `X-Emby-Authorization` | move to Seerr (`ghcr.io/seerr-team/seerr`) or a build that sends `Authorization: MediaBrowser`, then re-test |
| `music-requests/spotify_to_jellyfin.py:28` | `q["api_key"]` | `q["ApiKey"]` |
| `music-requests/spotify_to_jellyfin.py:45` | `?api_key=` | `?ApiKey=` |
| `music-requests/app.py:866` | `?api_key=` | `?ApiKey=` |
| `music-requests/discovery_queue.py:192` | `&api_key=` | `&ApiKey=` |
| `music-requests/spotify_likes_to_conduit.py:26` | `q["api_key"]` | `q["ApiKey"]` |
| conduit-relay | `Authorization: MediaBrowser` | nothing, already fine |
| Sonarr / Radarr | no Jellyfin connection configured | nothing |
| Home Assistant | no Jellyfin integration | nothing |

Paths are under `/home/admin/services/`. The header form `Authorization: MediaBrowser Token="<key>"` also works everywhere.

Plan: turn legacy auth ON for day one, fix the table above, then turn it OFF.

## 0. Pre-checks (day before is fine)

```bash
ssh server
# disk: need about 45 GB free for the local backup
df -h /home/admin /mnt/cloud
# usernames that clash by case (must print 0)
sudo sqlite3 -readonly /home/admin/services/jellyfin/config/data/jellyfin.db \
  "select count(*) from (select lower(Username) u from Users group by u having count(*)>1);"
# UNAS health: the SMB wedge check from memory unas_smb_wedge_failure.md
dmesg -T | grep "cifs: VFS" | tail -5          # should be empty or old
time ls /mnt/unas > /dev/null                   # must be instant
time smbclient -L //192.168.1.100 -A /root/.smbcredentials-jellyfin > /dev/null
mountpoint /mnt/unas && mountpoint /mnt/cloud
ls /mnt/unas | wc -l ; ls /mnt/wd_nvme1/music | wc -l   # both non-zero
# who is watching
curl -s -H 'Authorization: MediaBrowser Token="<prod key>"' http://127.0.0.1:2101/Sessions | python3 -c 'import json,sys;print([s["UserName"] for s in json.load(sys.stdin) if s.get("NowPlayingItem")])'
```

If any UNAS check hangs or is slow, stop. Do not migrate on a sick UNAS (see finding 2).

## 1. Stop

```bash
cd /home/admin/services/jellyfin
docker compose stop
docker inspect -f '{{.State.Status}}' jellyfin-jellyfin-1   # exited
```

## 2. Backup (local + UNAS) and verify

```bash
D=$(date +%Y%m%d-%H%M)
B=/home/admin/services/.backups/jellyfin-10.11.5-$D.tar.zst
cd /home/admin/services/jellyfin
sudo tar --use-compress-program='zstd -T0 -3' -cf "$B" config docker-compose.yml
sudo zstd -t "$B"
# DB integrity check on the copy inside the backup, not on prod
mkdir -p /tmp/jfchk && sudo tar -I zstd -xf "$B" -C /tmp/jfchk config/data/jellyfin.db
sudo sqlite3 /tmp/jfchk/config/data/jellyfin.db "PRAGMA integrity_check;"   # ok
sudo rm -rf /tmp/jfchk
sudo mkdir -p /mnt/cloud/jellyfin-backups
sudo cp "$B" /mnt/cloud/jellyfin-backups/ && sudo zstd -t /mnt/cloud/jellyfin-backups/$(basename "$B")
ls -lh "$B" /mnt/cloud/jellyfin-backups/
```

Note: the backup includes `jellyfin.db-wal`. That is fine because Jellyfin is stopped and the WAL is replayed on open.

## 3. Remove repository plugins

The notes say remove them before migrating. Staging did exactly this and it worked. Configs in `plugins/configurations/` stay, so settings survive the reinstall.

```bash
cd /home/admin/services/jellyfin
sudo mkdir -p /home/admin/services/.backups/jellyfin-plugins-10.11-$D
for p in config/plugins/*/; do
  [ "$p" = "config/plugins/configurations/" ] || sudo mv "$p" /home/admin/services/.backups/jellyfin-plugins-10.11-$D/
done
ls config/plugins    # only configurations
```

This removes Streaming Collections too. It comes back as 1.1.0.0 (net10 build) in step 8.

## 4. Fix the repo URL typo

```bash
sudo grep -n 'manifest.json  </Url>' config/config/system.xml
sudo sed -i 's#manifest.json  </Url>#manifest.json</Url>#' config/config/system.xml
```

## 5. Fix encoding.xml (or NVENC gets wiped)

```bash
sudo cp config/config/encoding.xml config/config/encoding.xml.bak-10.11
sudo sed -i 's#<EncoderPreset xsi:nil="true" />#<EncoderPreset>auto</EncoderPreset>#' config/config/encoding.xml
grep -n EncoderPreset config/config/encoding.xml    # <EncoderPreset>auto</EncoderPreset>
```

## 6. Pin the image

In `docker-compose.yml` change `image: jellyfin/jellyfin:latest` to:

```yaml
    image: jellyfin/jellyfin:12.1.20260915-010956@sha256:78d3ea1207d1322471fcac39a614f004f2ccf7e878f95ab2977d752f07e4dd7e
```

Nothing else in the compose file changes (GPU via CDI, `docker_internal`, volumes all stay).

```bash
docker compose pull
```

## 7. Migrate, then start

```bash
cd /home/admin/services/jellyfin
time docker compose run --rm jellyfin --mode MigrateSystem 2>&1 | tee migrate-12.1-$D.log
# expect about 4 min. Do not interrupt. If it passes 2 h, stop and report (jellyfin#17840).
tail -3 migrate-12.1-$D.log      # "jellyfin.db optimized successfully!"
docker compose up -d
until curl -sf http://127.0.0.1:2101/System/Info/Public; do sleep 3; done   # "Version":"12.1.0"
docker logs jellyfin-jellyfin-1 2>&1 | grep -E 'ERR|FTL' | head     # must NOT show encoding.xml
```

## 8. Plugins and repos

Dashboard > Plugins > Repositories should hold exactly:

- `https://repo.jellyfin.org/files/plugin/manifest.json` (Jellyfin Stable)
- `https://raw.githubusercontent.com/lukasbaxter/jellyfin-platform-collections/main/manifest.json`
- `https://www.iamparadox.dev/jellyfin/plugins/manifest.json` (File Transformation)
- `https://intro-skipper.org/manifest.json` (only answers to a Jellyfin server, a browser gets a redirect)
- the jellyfin-netflix manifest (`https://raw.githubusercontent.com/lukasbaxter/jellyfin-netflix/main/plugin/manifest.json`)

Install from the catalog (versions staging used):

| Plugin | Version |
|---|---|
| Cover Art Archive | 10.0.0.0 |
| Discogs | 3.0.0.0 |
| Fanart | 15.0.0.0 |
| LrcLib Lyrics | 5.0.0.0 |
| Open Subtitles | 25.0.0.0 |
| Session Cleaner | 6.0.0.0 |
| Subtitle Extract | 8.0.0.0 |
| Streaming Collections | 1.1.0.0 (net10 build, release step 1) |
| File Transformation | 3.0.1.0 |
| Intro Skipper | 12.0.4.0 |
| Netflix UI | 1.0.0.0 |

Then `docker compose restart` and check Dashboard > Plugins: all Active.

Intro Skipper: staging turned off `AutoDetectIntros` so it would not hammer the UNAS. On prod decide on purpose. Turning it on means one long analysis pass over every episode over CIFS. Run it at night and watch `/var/log/unas-stall.log`.

## 9. Full library scan (required)

Dashboard > Scheduled Tasks > Scan Media Library > Run. About 75 min on staging. Do not restart the server while it runs (a restart aborts it, and 12 also starts a scan on boot that a restart cancels). Watch the UNAS the whole time (`tail -f /var/log/unas-stall.log`). Expected log noise: `Read-only file system ... album.nfo` from the Music library, since `/music` is mounted `:ro`.

## 10. Auth: day one

```bash
sudo sed -i 's#<EnableLegacyAuthorization>false</EnableLegacyAuthorization>#<EnableLegacyAuthorization>true</EnableLegacyAuthorization>#' config/config/system.xml
docker compose restart
```

Or Dashboard > Networking / General (API: POST `/System/Configuration` with `EnableLegacyAuthorization: true`, no restart needed, staging proved the toggle is live).

## 11. Connection checks

- Jellyseerr: Settings > Jellyfin > Sync libraries, then request something small.
- music-requests: `python3 spotify_to_jellyfin.py --help` style dry run, or wait for the nightly cron and read its log.
- Sonarr / Radarr: nothing points at Jellyfin today, just confirm a download still lands in the library after the scan.
- HA: no Jellyfin integration today.
- Public URL: `https://jellyfin.baxtergroup.io` loads and logs in (Cloudflare Flexible, never add an 80 to 443 redirect).

## 12. GPU (NVENC) test

```bash
docker exec jellyfin-jellyfin-1 /usr/lib/jellyfin-ffmpeg/ffmpeg -hide_banner -loglevel error \
  -f lavfi -i testsrc2=size=1920x1080:rate=30 -t 3 -c:v hevc_nvenc -f null - && echo NVENC OK
curl -s -H 'Authorization: MediaBrowser Token="<key>"' http://127.0.0.1:2101/System/Configuration/encoding \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["HardwareAccelerationType"],d["HardwareDecodingCodecs"])'
# nvenc ['h264','vc1','hevc','mpeg2video','mpeg4','vp9','vp8','av1']
```

Then play a 4K HDR file in a browser with a forced low bitrate and check the Dashboard shows a hardware transcode. Already proven on 2026-09-25: the 12.1 image with `--device nvidia.com/gpu=all` encodes h264_nvenc and hevc_nvenc (ffmpeg 8.1.2-Jellyfin). If it fails, it is the "container lost the GPU" case: `docker compose up -d --force-recreate`.

## 13. Verify checklist

- [ ] `/System/Info/Public` says 12.1.0
- [ ] web login works (a normal user, not only admin)
- [ ] Albums / Songs within 1% of before. Movies / Series / Episodes match "items whose file exists" (finding 3), roughly 1260 / 195 / 12628
- [ ] Collections 242, playlists about 196 after the scan
- [ ] a movie and an episode play, one direct and one transcoded on NVENC
- [ ] resume points and watched state look right for a couple of users
- [ ] all plugins Active
- [ ] subtitle settings present in each library's options (global page is gone)
- [ ] Jellyseerr sync works
- [ ] iPhone app, Google TV Streamer, XGIMI all connect
- [ ] no `encoding.xml` error in the log

`staging/verify.sh` covers most of this for staging. Point it at prod only for read checks.

## 14. Auth follow-up (later, not in the window)

1. Fix every row in the "Who breaks" table.
2. Set `EnableLegacyAuthorization` back to false.
3. Re-run Jellyseerr sync and one music-requests job.

## Rollback

Only if 12.1 is broken and a fix is not quick.

```bash
cd /home/admin/services/jellyfin
docker compose stop
sudo mv config config.broken-12.1-$(date +%Y%m%d-%H%M)
sudo tar -I zstd -xf /home/admin/services/.backups/jellyfin-10.11.5-<D>.tar.zst
# set image back to the 10.11.5 digest in docker-compose.yml:
#   jellyfin/jellyfin@sha256:58b57fd06c97905fc095a2f9f188b39ef914db031ee69e9585324b64d40c6d6f
docker compose up -d
```

**Never start 10.11 on a migrated config.** Restore the tar first, always.

## Staging notes

- Location: `/home/admin/services/jellyfin-staging` (compose copy in `staging/docker-compose.yml`). Media mounted `:ro`, no GPU, own server id, name `baxtergroup-staging`, never auto-restarts.
- Refresh from prod: `staging/sync-config.sh` (stop staging first), then `staging/migrate.sh`, then fix encoding.xml, then up.
- The plugin folders removed from the staging copy are in `/home/admin/services/jellyfin-staging/plugins-10.11-removed`.
- Stop it when done: `cd /home/admin/services/jellyfin-staging && sudo docker compose stop`.
