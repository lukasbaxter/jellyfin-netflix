# Shared contract: theme (B) and plugin (C)

**Prefix:** everything uses `nfx`. The plugin emits only these classes and ids, and the theme styles only these plus stock Jellyfin classes.

## Root state classes on `<html>`
- `nfx` (JS loaded)
- `nfx-scrolled`
- `nfx-modern` (set when `.MuiAppBar-root` exists) or `nfx-legacy`
- `nfx-preview-open`
- `nfx-on-home`, `nfx-has-hero` (informational)

## Hero
```
<section id="nfx-hero" class="nfx-hero" data-item-id>
  <div class="nfx-hero__backdrop"><img class="nfx-hero__img"></div>
  <div class="nfx-hero__shade"></div>
  <div class="nfx-hero__content">
    <img class="nfx-hero__logo"> | <h1 class="nfx-hero__title">
    <div class="nfx-hero__meta"><span class="nfx-match">98% match</span><span class="nfx-year"></span><span class="nfx-rating"></span><span class="nfx-runtime"></span></div>
    <p class="nfx-hero__overview"></p>
    <div class="nfx-hero__genres"></div>
    <div class="nfx-hero__actions">
      <button class="nfx-btn nfx-btn--play emby-button">Play|Resume</button>
      <button class="nfx-btn nfx-btn--info emby-button">More Info</button>
      <button class="nfx-btn nfx-btn--icon nfx-btn--list emby-button" data-label>+ <span class="nfx-btn__label">My List</span></button>
    </div>
  </div>
  <div class="nfx-hero__badge"></div>
  <div class="nfx-hero__dots"><button class="nfx-dot is-active"></button>...</div>
</section>
```
- The hero auto-rotates every 9 s on desktop only and pauses on hover or focus.
- `.nfx-btn__label` (added in fix round 1): the text label inside the hero My List button. Hidden by default, shown under the icon on phones.

## Rows
`<div class="verticalSection nfx-row" data-nfx-row="top10-movie|top10-series|genre-<slug>">` containing the stock `sectionTitleContainer` / `h2.sectionTitle` and `emby-scroller` markup, then `.itemsContainer.scrollSlider.nfx-row__items`.

## Cards
- **Top 10 card:** `.nfx-card.nfx-card--top10` holding `<span class="nfx-rank">1</span>` plus a portrait image. The theme draws the big outlined rank numeral to the left of the poster.
- **Generic card:** `a.card.backdropCard.nfx-card > .nfx-card__img(img) + .nfx-card__progress > i[style=width:%]`.
- **Edge hints on stock cards:** `.nfx-edge-left` and `.nfx-edge-right`.

## Preview
```
<div class="nfx-preview" role="dialog">
  .nfx-preview__media(img)
  .nfx-preview__body(.nfx-preview__actions(.nfx-btn--icon.nfx-btn--play, .nfx-btn--icon.nfx-btn--list, .nfx-btn--icon.nfx-btn--more), .nfx-preview__meta, .nfx-preview__genres)
</div>
```
- The plugin sets `left`, `top` and `width` inline. The theme does the look and the open/close transition via `.is-open`.

## Detail backdrop (added in fix round 1)
- Stock jellyfin-web only paints `#itemBackdrop` on desktop at 1000 px or wider, never in TV layout. When `#itemBackdrop` has no `background-image` and the full-screen `.backdropContainer` has no image, the plugin sets `#itemBackdrop` `style.backgroundImage` to the item backdrop (parent series backdrop for seasons and episodes) and adds the class `nfx-detail-backdrop`.
- This is the one extra inline style the plugin may set.

## Variables
- The plugin may set `--nfx-hero-h` on `<html>` (optional override). The theme owns every other variable.

## Stable hooks
- Stock Jellyfin classes. The plugin never removes or renames them and never adds inline styles except preview positioning, progress width and the detail backdrop image.
