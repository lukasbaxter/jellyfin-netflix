# Netflix look on the TVs

## What the theme can and can't reach

- The Netflix theme and the Netflix UI plugin change the **web client**. That covers browsers, the Jellyfin iPhone/Android app and Jellyfin Media Player.
- The official **Jellyfin Android TV app** (Google TV Streamer, XGIMI) is a native app. It ignores web CSS and JS, so it stays stock.
- What does reach every app, the native TV one included:
  - Intro Skipper: "Skip Intro" and "Skip Credits" come from server media segments.
  - Artwork: logos, backdrops and thumbs, which show wherever the app shows art.
  - Trickplay thumbnails when scrubbing.
  - Collections.

## Recommended: Moonfin on both TVs

Moonfin is a Jellyfin client for Android TV that already looks close to Netflix. It has a backdrop media bar, logo titles, big rows and auto skip.

1. On the Google TV Streamer (192.168.1.106) or the XGIMI, open the Play Store and search **Moonfin**. The package is `org.moonfin.androidtv`. Install it.
2. Open it, add a server and enter `https://jellyfin.baxtergroup.io`. On the home network you can use `http://192.168.1.85:2101` instead, which skips Cloudflare.
3. Sign in with your normal Jellyfin user.
4. Settings to change:
   - Media bar / featured banner: **on**
   - Detail screen style: the full backdrop layout (the Netflix-like one)
   - Media segments: Intro set to **Auto skip**, Credits set to **Ask** (shows a button). Recap and Preview are up to you.
   - Home rows: put Continue Watching and Next Up first
5. The Moonbase server plugin is optional and not installed. Moonfin works without it.

To test against staging first, add the server `http://192.168.1.85:2199` in Moonfin.

## Fallback: Wholphin

If Moonfin misbehaves on the XGIMI, try **Wholphin** from the Play Store. It is another modern Android TV client with a similar layout. Point it at the same server URL. It also honours media segments.

## Server-side checklist (helps every client)

- [ ] Logos: most movies and shows already have them. Run "Refresh metadata" with "Replace missing images" on anything without one.
- [ ] Backdrops and thumbs: same refresh. The Netflix rows prefer thumbs.
- [ ] Trickplay: Dashboard > Libraries > enable trickplay extraction, then let the scheduled task run.
- [ ] Intro Skipper: enable "Detect and Analyze Media Segments" in scheduled tasks. The first run over all shows takes hours.
- [ ] Top 10 and genre rows show only in the web client and Jellyfin apps built on it, not in Moonfin.
- [ ] Hide the Demos library from home. The Dolby test clips show as a row of black tiles. Each user: Profile > Home > under "Latest media" untick Demos. This applies on every client, TV apps included. In Netflix UI settings, also tick Demos under "Leave these libraries out".
