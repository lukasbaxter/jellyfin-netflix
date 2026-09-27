# Release: Netflix UI 1.0.0 and prod Jellyfin 12.1

This is the order for going live. Nothing here has been run on prod yet. The prod details (every command, the why, the measured times) are in `UPGRADE.md`. This file is the order and the checklist, and it points at the UPGRADE.md step for each part.

Prod: `jellyfin-jellyfin-1` on .85 (`ssh server`), `/home/admin/services/jellyfin`, port 2101, public at `https://jellyfin.baxtergroup.io` (Cloudflare Flexible, never add an 80 to 443 redirect).

| | Image |
|---|---|
| Upgrade to | `jellyfin/jellyfin:12.1.20260915-010956@sha256:78d3ea1207d1322471fcac39a614f004f2ccf7e878f95ab2977d752f07e4dd7e` |
| Roll back to (10.11.5) | `jellyfin/jellyfin@sha256:6d819e9ab067efcf712993b23455cc100ee5585919bb297ea5a109ac00cb626e` (local ID `58b57fd06c97`, offline tag `jellyfin/jellyfin:10.11.5-rollback` from step 6) |

## A. Before the day: GitHub releases

Prod installs plugins from their manifests, so both releases have to exist first.

### A1. Streaming Collections 1.1.0.0 (`~/Projects/jellyfin-platform-collections`)

- [ ] csproj `net10.0`, `Jellyfin.Controller` / `Jellyfin.Model` `12.1.*`, `Microsoft.Extensions.Http` `10.0.*`
- [ ] build.yaml: `targetAbi: "12.0.0.0"`, `framework: "net10.0"`, `version: "1.1.0.0"`
- [ ] build in `mcr.microsoft.com/dotnet/sdk:10.0` on `server`
- [ ] install on staging (`config/plugins/`, then `docker restart jellyfin-staging`), check it is Active and its collections still fill
- [ ] tag `v1.1.0`, GitHub release with the zip, add the 1.1.0.0 entry (checksum, sourceUrl, timestamp) to its `manifest.json`, push

### A2. Netflix UI 1.0.0 (this repo)

- [ ] `git status` is clean. `screenshots/`, `test/out/` and `.staging.env` are gitignored. Nothing secret in history (review 2 checked this).
- [ ] final build: `plugin/build.sh --install`. It rebuilds the theme copy into the dll and writes the zip md5 and timestamp into `plugin/manifest.json`.
- [ ] staging check on that exact build: `staging/verify.sh` prints ALL PASS, and `node test/shoot.mjs` exits 0
- [ ] commit (`plugin/manifest.json` now has the checksum of `plugin/dist/netflix-ui_1.0.0.0.zip`)
- [ ] create the repo `lukasbaxter/jellyfin-netflix` (public, GPL-3.0) and push `main`
- [ ] tag `v1.0.0`, GitHub release named `Netflix UI 1.0.0`, asset = that same `plugin/dist/netflix-ui_1.0.0.0.zip`. Do not rebuild between the commit and the upload, because every build changes the md5.
- [ ] check the asset: `curl -sL https://github.com/lukasbaxter/jellyfin-netflix/releases/download/v1.0.0/netflix-ui_1.0.0.0.zip | md5` equals the manifest checksum
- [ ] check the manifest: `curl -s https://raw.githubusercontent.com/lukasbaxter/jellyfin-netflix/main/plugin/manifest.json` shows 1.0.0.0, targetAbi 12.0.0.0 and the same checksum
- [ ] release notes (short, plain): what it does, needs File Transformation 3.0.1.0, Jellyfin 12.x only, TV apps: see `plugin/TV.md`

## B. The day before

- [ ] UPGRADE.md step 0, all of it. That includes the new rollback check: the 10.11.5 digest must pull and match what prod runs today. Stop if it does not.
- [ ] Pick a quiet window: about 45 min down, then about 90 min of scan with the server up.

## C. The window (UPGRADE.md steps 1 to 8)

1. [ ] **Stop** (step 1)
2. [ ] **Backup** (step 2): tar of `config` + `docker-compose.yml`, `zstd -t`, `PRAGMA integrity_check` on the copy. Write down the backup path `$B`.
3. [ ] **Remove repo plugins** (step 3), Streaming Collections included
4. [ ] **Repo URL typo** in system.xml (step 4)
5. [ ] **encoding.xml fix** (step 5), or NVENC gets wiped
6. [ ] **Pin the image** (step 6): `docker tag 58b57fd06c97 jellyfin/jellyfin:10.11.5-rollback`, then compose `image:` to the 12.1 digest, `docker compose pull`
7. [ ] **Migrate, then start** (step 7): the UNAS guard (no pipefail around it) and `MigrateSystem` in the same command, legacy auth set to true, `up -d`, version says 12.1.0, no encoding.xml error
8. [ ] **Plugins** (step 8): the 5 repos, then install Cover Art Archive, Discogs, Fanart, LrcLib, Open Subtitles, Session Cleaner, Subtitle Extract, Streaming Collections 1.1.0.0, File Transformation 3.0.1.0, Intro Skipper 12.0.4.0 and Netflix UI 1.0.0.0. One `docker compose restart`, then all Active. This is the last restart.

## D. Theme on

- [ ] Leave Dashboard > General > Branding > Custom CSS **empty**. Netflix UI injects the css and js into `index.html` through File Transformation. Setting both loads the theme twice.
- [ ] check: `curl -s http://127.0.0.1:2101/web/ | grep -c NetflixUi/netflix.js` prints 1
- [ ] check: `curl -s http://127.0.0.1:2101/NetflixUi/config.json` shows `"Version":"1.0.0.0"` and an `AssetVersion`
- [ ] only if the log says `File Transformation plugin not found`: set Custom CSS to `@import url("/NetflixUi/netflix.css");` (no `?v=`, served with a 1 hour cache and an ETag, so updates show up on their own)
- [ ] Dashboard > Plugins > Netflix UI: tick Demos under "Leave these libraries out". Leave "Top 10: people needed per title" at 2.
- [ ] tell people to hard refresh once (the iPhone app: pull to refresh, or force close and reopen)

## E. After the window, server up

- [ ] **Full library scan** (step 9). About 75 min. No restarts while it runs.
- [ ] **Backup to the UNAS** (step 9b), only once the scan is done and `/var/log/unas-stall.log` is quiet
- [ ] **Auth** (step 10): legacy auth is True
- [ ] **Connections** (step 11): Jellyseerr sync, music-requests, Sonarr/Radarr, public URL
- [ ] **NVENC** (step 12)
- [ ] **Verify checklist** (step 13), every box
- [ ] **Home tidy** (step 15): each user unticks Demos and Music under "Latest media"
- [ ] **TVs**: Moonfin on the Google TV Streamer and the XGIMI, per `plugin/TV.md`

## F. Verification of the theme on real devices

- [ ] desktop browser: hero rotates, Top 10 and genre rows show, hover preview opens after a beat, header goes solid on scroll
- [ ] iPhone app: rows snap, no play button on cards, player shows the big rewind / play / forward
- [ ] Google TV Streamer and XGIMI in Moonfin: log in, play, Skip Intro shows on a show Intro Skipper has analysed
- [ ] Dashboard pages look stock (no theme on the dashboard)
- [ ] Plugins page: turn Netflix UI off, restart later in a quiet moment, and the stock UI comes back clean. Only if something is wrong.

## G. Later (not in the window)

- [ ] **Auth follow-up** (UPGRADE.md step 14): fix Jellyseerr and the 5 music-requests lines, prove on staging, then set `EnableLegacyAuthorization` false. The web client is not a blocker.
- [ ] Stop staging: `cd /home/admin/services/jellyfin-staging && sudo docker compose stop`. Optionally revoke the copied prod API keys on it (UPGRADE.md, staging notes).
- [ ] Update the memory notes: Jellyfin 12.1 upgrade and the Netflix theme.

## Rollback (UPGRADE.md, Rollback)

Only if 12.1 is broken and a fix is not quick.

1. `docker compose stop`
2. move `config` aside as `config.broken-12.1-<date>`
3. extract **only** `config` from the backup: `sudo tar -I zstd -xf $B config`. A plain extract also restores the old compose file with `:latest`.
4. set the compose `image:` to `jellyfin/jellyfin@sha256:6d819e9ab067efcf712993b23455cc100ee5585919bb297ea5a109ac00cb626e` (or `jellyfin/jellyfin:10.11.5-rollback` if the registry is down), check with `grep -n image: docker-compose.yml`
5. `docker compose up -d`, version says 10.11.5

Never start 10.11 on a migrated config. Restore the tar first, always.

To take only the theme off (server stays on 12.1): Dashboard > Plugins > Netflix UI > Disable, then restart when nobody is watching. Branding Custom CSS is already empty, so nothing else to undo.
