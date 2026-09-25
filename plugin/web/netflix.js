/* jellyfin-netflix client, served by the Netflix UI plugin at /NetflixUi/netflix.js
 * One IIFE, no framework, ES2019. Every entry point is wrapped so a failure
 * leaves the stock Jellyfin UI untouched. Markup follows CONTRACT.md. */
(function () {
    'use strict';

    if (window.__NFX_VERSION__) return;
    var VERSION = '1.0.0';
    window.__NFX_VERSION__ = VERSION;

    var doc = document;
    var root = doc.documentElement;
    var CACHE_MS = 5 * 60 * 1000;
    var HERO_ROTATE_MS = 9000;
    var PREVIEW_DELAY_MS = 600;

    var state = {
        cfg: null,
        cfgPromise: null,
        feeds: {},          // key -> { t, promise }
        items: {},          // id -> item (nfx shape or BaseItemDto), used by preview
        hero: { list: [], index: 0, timer: 0, paused: false, trailerTimer: 0 },
        scanQueued: false,
        preview: { el: null, card: null, timer: 0, closeTimer: 0, openFor: null }
    };

    function warn(where, e) {
        try { console.warn('[nfx] ' + where + ': ' + (e && e.message ? e.message : e)); } catch (_) { /* ignore */ }
    }

    function safe(where, fn) {
        return function () {
            try { return fn.apply(this, arguments); } catch (e) { warn(where, e); }
        };
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ------------------------------------------------------------------ env

    function api() { return window.ApiClient || null; }

    function userId() {
        var c = api();
        try { return c && c.getCurrentUserId ? c.getCurrentUserId() : null; } catch (_) { return null; }
    }

    function serverId() {
        var c = api();
        try { return c && c.serverId ? c.serverId() : ''; } catch (_) { return ''; }
    }

    function url(path, params) {
        var c = api();
        if (c && c.getUrl) return c.getUrl(path, params);
        var q = params ? '?' + Object.keys(params).filter(function (k) { return params[k] != null; })
            .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&') : '';
        return '/' + path + q;
    }

    function getJSON(path, params) {
        var c = api();
        if (!c || !c.getJSON) return Promise.reject(new Error('no ApiClient'));
        return c.getJSON(url(path, params));
    }

    function isTv() { return root.classList.contains('layout-tv'); }
    function isMobile() { return root.classList.contains('layout-mobile') || window.innerWidth <= 600; }
    function finePointer() {
        return !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
    }
    function reducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function onDashboard() {
        var h = (location.hash || '') + ' ' + location.pathname;
        return /#\/(dashboard|configurationpage|plugins|wizard)/i.test(h) ||
            /configurationpage/i.test(h) ||
            (doc.body && doc.body.classList.contains('dashboardDocument'));
    }

    function detailsHash(id) {
        return '#/details?id=' + encodeURIComponent(id) + '&serverId=' + encodeURIComponent(serverId());
    }

    function goDetails(id) {
        try {
            if (window.Emby && window.Emby.Page && window.Emby.Page.showItem) {
                window.Emby.Page.showItem(id, serverId());
                return;
            }
        } catch (e) { warn('showItem', e); }
        location.hash = detailsHash(id);
    }

    function img(id, type, tag, maxWidth) {
        if (!id) return '';
        var p = { maxWidth: maxWidth, quality: 90 };
        if (tag) p.tag = tag;
        return url('Items/' + id + '/Images/' + type + (type === 'Backdrop' ? '/0' : ''), p);
    }

    function loadConfig() {
        if (state.cfg) return Promise.resolve(state.cfg);
        if (!state.cfgPromise) {
            state.cfgPromise = fetch(url('NetflixUi/config.json'), { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : {}; })
                .catch(function () { return {}; })
                .then(function (c) {
                    state.cfg = {
                        EnableHero: c.EnableHero !== false,
                        EnableTop10: c.EnableTop10 !== false,
                        GenreRowCount: typeof c.GenreRowCount === 'number' ? c.GenreRowCount : 4,
                        EnableHoverPreview: c.EnableHoverPreview !== false,
                        EnableHeroTrailer: c.EnableHeroTrailer === true,
                        HomeCardShape: c.HomeCardShape || 'backdrop'
                    };
                    return state.cfg;
                });
        }
        return state.cfgPromise;
    }

    function feed(key, path, params) {
        var k = (userId() || '') + '|' + key;
        var f = state.feeds[k];
        if (f && Date.now() - f.t < CACHE_MS) return f.promise;
        var p = getJSON(path, params).then(function (res) {
            (Array.isArray(res) ? res : []).forEach(function (x) {
                if (x && x.Id) state.items[x.Id] = x;
                if (x && x.Items) x.Items.forEach(function (i) { state.items[i.Id] = i; });
            });
            return res;
        });
        p.catch(function () { delete state.feeds[k]; });
        state.feeds[k] = { t: Date.now(), promise: p };
        return p;
    }

    // ------------------------------------------------------------------ formatting

    function runtime(ticks) {
        if (!ticks) return '';
        var min = Math.round(ticks / 600000000);
        if (min < 60) return min + 'm';
        return Math.floor(min / 60) + 'h' + (min % 60 ? ' ' + (min % 60) + 'm' : '');
    }

    function match(rating) {
        if (!rating) return '';
        var pct = Math.max(1, Math.min(99, Math.round(rating * 10)));
        return pct + '% match';
    }

    function metaHtml(it) {
        var isSeries = it.Type === 'Series';
        return '<span class="nfx-match">' + esc(match(it.CommunityRating)) + '</span>' +
            '<span class="nfx-year">' + esc(it.ProductionYear || '') + '</span>' +
            '<span class="nfx-rating">' + esc(it.OfficialRating || '') + '</span>' +
            '<span class="nfx-runtime">' + esc(isSeries ? '' : runtime(it.RunTimeTicks)) + '</span>';
    }

    function genresHtml(genres) {
        return (genres || []).slice(0, 3).map(function (g) { return '<span>' + esc(g) + '</span>'; }).join('');
    }

    function icon(name) {
        return '<span class="material-icons ' + name + '" aria-hidden="true"></span>';
    }

    // ------------------------------------------------------------------ playback bridge
    // Stock itemShortcuts handle clicks on .itemAction inside an emby-itemscontainer,
    // which calls the private playbackManager. We keep one hidden container for that.

    function bridge() {
        var b = doc.getElementById('nfx-bridge');
        if (!b) {
            var wrap = doc.createElement('div');
            wrap.innerHTML = '<div id="nfx-bridge" is="emby-itemscontainer" hidden aria-hidden="true"></div>';
            b = wrap.firstChild;
            doc.body.appendChild(b);
        }
        return b;
    }

    function play(id, type, positionTicks, fallbackDetailsId, retry) {
        var b = bridge();
        // createdCallback adds .itemsContainer: that tells us the element was upgraded
        if (!b.classList.contains('itemsContainer') && !retry) {
            setTimeout(function () { play(id, type, positionTicks, fallbackDetailsId, true); }, 250);
            return;
        }
        if (b.classList.contains('itemsContainer')) {
            b.innerHTML = '<button type="button" class="itemAction" data-action="resume"' +
                ' data-id="' + esc(id) + '" data-serverid="' + esc(serverId()) + '"' +
                ' data-type="' + esc(type || 'Movie') + '"' +
                ' data-mediatype="' + (type === 'Series' || type === 'Season' || type === 'BoxSet' ? '' : 'Video') + '"' +
                ' data-isfolder="' + (type === 'Series' || type === 'Season' || type === 'BoxSet') + '"' +
                ' data-positionticks="' + (positionTicks || 0) + '"></button>';
            b.firstChild.click();
            return;
        }
        // fallback: open details and press its Play button
        goDetails(fallbackDetailsId || id);
        var tries = 0;
        var t = setInterval(function () {
            tries++;
            var btn = doc.querySelector('#itemDetailPage:not(.hide) .mainDetailButtons .btnPlay:not(.hide), .itemDetailPage:not(.hide) .btnPlay:not(.hide)');
            if (btn) { clearInterval(t); btn.click(); } else if (tries > 40) { clearInterval(t); }
        }, 150);
    }

    function toggleFavorite(id, btn) {
        var c = api();
        var it = state.items[id] || {};
        var ud = it.UserData || (it.UserData = {});
        var next = !ud.IsFavorite;
        if (!c || !c.updateFavoriteStatus) return;
        c.updateFavoriteStatus(userId(), id, next).then(function () {
            ud.IsFavorite = next;
            setListIcon(btn, next);
        }).catch(function (e) { warn('favorite', e); });
    }

    function setListIcon(btn, fav) {
        if (!btn) return;
        btn.innerHTML = icon(fav ? 'check' : 'add');
        btn.setAttribute('aria-label', fav ? 'Remove from My List' : 'Add to My List');
        btn.setAttribute('title', fav ? 'Remove from My List' : 'My List');
        btn.classList.toggle('is-active', !!fav);
    }

    // ------------------------------------------------------------------ hero

    function heroPlayLabel(it) {
        return it.PlayPositionTicks > 0 ? 'Resume' : 'Play';
    }

    function renderHeroSlide(hero, i) {
        var list = state.hero.list;
        if (!list.length) return;
        var it = list[i];
        state.hero.index = i;
        hero.setAttribute('data-item-id', it.Id);

        var imgEl = hero.querySelector('.nfx-hero__img');
        var backdropHost = hero.querySelector('.nfx-hero__backdrop');
        var oldVideo = backdropHost.querySelector('video');
        if (oldVideo) oldVideo.remove();
        clearTimeout(state.hero.trailerTimer);
        var newImg = doc.createElement('img');
        newImg.className = 'nfx-hero__img';
        newImg.alt = '';
        newImg.decoding = 'async';
        newImg.src = img(it.Id, 'Backdrop', it.BackdropTag, isMobile() ? 1000 : 1920);
        if (imgEl) imgEl.replaceWith(newImg); else backdropHost.appendChild(newImg);

        var content = hero.querySelector('.nfx-hero__content');
        var title = it.LogoTag
            ? '<img class="nfx-hero__logo" alt="' + esc(it.Name) + '" src="' + esc(img(it.Id, 'Logo', it.LogoTag, 800)) + '">'
            : '<h1 class="nfx-hero__title">' + esc(it.Name) + '</h1>';
        var fav = it.UserData && it.UserData.IsFavorite;
        content.innerHTML = title +
            '<div class="nfx-hero__meta">' + metaHtml(it) + '</div>' +
            '<p class="nfx-hero__overview">' + esc(it.Overview || '') + '</p>' +
            '<div class="nfx-hero__genres">' + genresHtml(it.Genres) + '</div>' +
            '<div class="nfx-hero__actions">' +
            '<button type="button" is="emby-button" class="nfx-btn nfx-btn--play emby-button" data-focusable="true">' + icon('play_arrow') + '<span>' + heroPlayLabel(it) + '</span></button>' +
            '<button type="button" is="emby-button" class="nfx-btn nfx-btn--info emby-button" data-focusable="true">' + icon('info_outline') + '<span>More Info</span></button>' +
            '<button type="button" is="emby-button" class="nfx-btn nfx-btn--icon nfx-btn--list emby-button" data-focusable="true"></button>' +
            '</div>';
        setListIcon(content.querySelector('.nfx-btn--list'), fav);

        var logo = content.querySelector('.nfx-hero__logo');
        if (logo) {
            logo.addEventListener('error', function () {
                var h = doc.createElement('h1');
                h.className = 'nfx-hero__title';
                h.textContent = it.Name;
                logo.replaceWith(h);
            });
        }

        hero.querySelector('.nfx-hero__badge').textContent = it.OfficialRating || '';

        var dots = hero.querySelectorAll('.nfx-dot');
        for (var d = 0; d < dots.length; d++) {
            dots[d].classList.toggle('is-active', d === i);
            dots[d].setAttribute('aria-current', d === i ? 'true' : 'false');
        }

        maybeTrailer(hero, it);
    }

    function maybeTrailer(hero, it) {
        if (!state.cfg || !state.cfg.EnableHeroTrailer || !it.LocalTrailerId || isMobile() || isTv() || reducedMotion()) return;
        var c = api();
        var token = c && c.accessToken ? c.accessToken() : '';
        state.hero.trailerTimer = setTimeout(safe('trailer', function () {
            if (!hero.isConnected || hero.getAttribute('data-item-id') !== it.Id) return;
            var v = doc.createElement('video');
            v.className = 'nfx-hero__img';
            v.muted = true;
            v.autoplay = true;
            v.playsInline = true;
            v.setAttribute('playsinline', '');
            v.src = url('Videos/' + it.LocalTrailerId + '/stream', { static: true, ApiKey: token });
            v.addEventListener('ended', function () { v.remove(); });
            v.addEventListener('error', function () { v.remove(); });
            hero.querySelector('.nfx-hero__backdrop').appendChild(v);
        }), 3000);
    }

    function heroActive(hero) {
        return hero && hero.isConnected && hero.offsetParent !== null && !doc.hidden;
    }

    function scheduleRotate(hero) {
        clearInterval(state.hero.timer);
        if (isMobile() || isTv() || reducedMotion() || state.hero.list.length < 2) return;
        state.hero.timer = setInterval(safe('rotate', function () {
            if (!hero.isConnected) { clearInterval(state.hero.timer); return; }
            if (state.hero.paused || !heroActive(hero)) return;
            if (hero.querySelector('video')) return; // let a trailer finish
            renderHeroSlide(hero, (state.hero.index + 1) % state.hero.list.length);
        }), HERO_ROTATE_MS);
    }

    function buildHero(list) {
        var hero = doc.createElement('section');
        hero.id = 'nfx-hero';
        hero.className = 'nfx-hero';
        hero.setAttribute('aria-label', 'Featured');
        var dots = '';
        for (var i = 0; i < list.length; i++) {
            dots += '<button type="button" class="nfx-dot' + (i === 0 ? ' is-active' : '') + '" data-index="' + i + '" aria-label="Show ' + esc(list[i].Name) + '" tabindex="-1"></button>';
        }
        hero.innerHTML =
            '<div class="nfx-hero__backdrop"><img class="nfx-hero__img" alt=""></div>' +
            '<div class="nfx-hero__shade"></div>' +
            '<div class="nfx-hero__content"></div>' +
            '<div class="nfx-hero__badge"></div>' +
            '<div class="nfx-hero__dots">' + (list.length > 1 ? dots : '') + '</div>';

        hero.addEventListener('click', safe('heroClick', function (e) {
            var t = e.target;
            var it = state.hero.list[state.hero.index];
            if (!it) return;
            var dot = t.closest('.nfx-dot');
            if (dot) {
                renderHeroSlide(hero, parseInt(dot.getAttribute('data-index'), 10) || 0);
                scheduleRotate(hero);
                return;
            }
            if (t.closest('.nfx-btn--play')) {
                e.preventDefault();
                play(it.PlayItemId || it.Id, it.PlayItemType || it.Type, it.PlayPositionTicks, it.Id);
            } else if (t.closest('.nfx-btn--info')) {
                e.preventDefault();
                goDetails(it.Id);
            } else if (t.closest('.nfx-btn--list')) {
                e.preventDefault();
                toggleFavorite(it.Id, t.closest('.nfx-btn--list'));
            }
        }));
        var pause = function () { state.hero.paused = true; };
        var resume = function () { state.hero.paused = false; };
        hero.addEventListener('mouseenter', pause);
        hero.addEventListener('mouseleave', resume);
        hero.addEventListener('focusin', function (e) {
            pause();
            // TV: coming into the hero from a row lands on the nearest button; Netflix lands on Play
            if (!isTv()) return;
            var from = e.relatedTarget;
            if (from && hero.contains(from)) return;
            var playBtn = hero.querySelector('.nfx-btn--play');
            if (playBtn && e.target !== playBtn && e.target.closest && e.target.closest('.nfx-hero__actions')) {
                setTimeout(function () { try { playBtn.focus(); } catch (_) { /* */ } }, 0);
            }
        });
        hero.addEventListener('focusout', resume);
        return hero;
    }

    function ensureHero(tab, container) {
        if (!state.cfg.EnableHero) return;
        var existing = tab.querySelector('#nfx-hero');
        if (existing) {
            if (existing.nextElementSibling !== container && container.parentNode === tab) {
                tab.insertBefore(existing, container);
            }
            return;
        }
        if (tab.getAttribute('data-nfx-hero') === 'loading') return;
        tab.setAttribute('data-nfx-hero', 'loading');
        feed('hero', 'NetflixUi/Hero', { limit: 6 }).then(safe('hero', function (list) {
            tab.removeAttribute('data-nfx-hero');
            if (!Array.isArray(list) || !list.length || tab.querySelector('#nfx-hero')) return;
            // one hero on the page, ever
            Array.prototype.forEach.call(doc.querySelectorAll('#nfx-hero'), function (h) { h.remove(); });
            var c = tab.querySelector('.homeSectionsContainer') || tab.firstElementChild;
            state.hero.list = list;
            var hero = buildHero(list);
            tab.insertBefore(hero, c);
            renderHeroSlide(hero, 0);
            scheduleRotate(hero);
            if (isTv()) {
                var a = doc.activeElement;
                if (!a || a === doc.body || (a.closest && a.closest('.homeSectionsContainer') && window.scrollY < 50)) {
                    var pb = hero.querySelector('.nfx-btn--play');
                    if (pb) pb.focus();
                }
            }
            root.classList.add('nfx-has-hero');
        }), function (e) {
            tab.removeAttribute('data-nfx-hero');
            warn('hero feed', e);
        });
    }

    // ------------------------------------------------------------------ rows

    function cardImage(it, preferBackdrop) {
        if (preferBackdrop && it.BackdropTag) return img(it.Id, 'Backdrop', it.BackdropTag, 640);
        if (it.ThumbTag) return img(it.Id, 'Thumb', it.ThumbTag, 640);
        if (it.BackdropTag) return img(it.Id, 'Backdrop', it.BackdropTag, 640);
        if (it.PrimaryTag) return img(it.Id, 'Primary', it.PrimaryTag, 640);
        return '';
    }

    function progressHtml(it) {
        var ud = it.UserData || {};
        if (!ud.PlaybackPositionTicks || !it.RunTimeTicks) return '';
        var pct = Math.max(2, Math.min(100, Math.round(ud.PlaybackPositionTicks / it.RunTimeTicks * 100)));
        return '<div class="nfx-card__progress"><i style="width:' + pct + '%"></i></div>';
    }

    function cardHtml(it) {
        return '<a class="card backdropCard nfx-card" href="' + esc(detailsHash(it.Id)) + '" data-id="' + esc(it.Id) + '"' +
            ' data-type="' + esc(it.Type) + '" aria-label="' + esc(it.Name) + '">' +
            '<div class="nfx-card__img"><img loading="lazy" decoding="async" alt="" src="' + esc(cardImage(it)) + '"></div>' +
            progressHtml(it) + '</a>';
    }

    function top10CardHtml(it, rank) {
        var src = it.PrimaryTag ? img(it.Id, 'Primary', it.PrimaryTag, 400) : cardImage(it);
        return '<a class="card nfx-card nfx-card--top10" href="' + esc(detailsHash(it.Id)) + '" data-id="' + esc(it.Id) + '"' +
            ' data-type="' + esc(it.Type) + '" aria-label="' + esc('#' + rank + ' ' + it.Name) + '">' +
            '<span class="nfx-rank" aria-hidden="true">' + rank + '</span>' +
            '<div class="nfx-card__img"><img loading="lazy" decoding="async" alt="" src="' + esc(src) + '"></div></a>';
    }

    function rowHtml(key, title, cards) {
        return '<div class="verticalSection nfx-row" data-nfx-row="' + esc(key) + '">' +
            '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">' +
            '<h2 class="sectionTitle sectionTitle-cards">' + esc(title) + '</h2></div>' +
            '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">' +
            '<div class="itemsContainer scrollSlider focuscontainer-x nfx-row__items">' + cards + '</div>' +
            '</div></div>';
    }

    function toNode(html) {
        var w = doc.createElement('div');
        w.innerHTML = html;
        return stubRow(w.firstChild);
    }

    // homesections.pause()/resume() call .pause()/.resume() on every .itemsContainer
    // in the home tab. Ours are plain divs, so give them no-op versions.
    function stubRow(row) {
        var ics = row && row.querySelectorAll ? row.querySelectorAll('.itemsContainer') : [];
        for (var i = 0; i < ics.length; i++) {
            if (typeof ics[i].pause !== 'function') ics[i].pause = function () { };
            if (typeof ics[i].resume !== 'function') ics[i].resume = function () { return Promise.resolve(); };
        }
        return row;
    }

    function insertAfterSection(container, node, afterSelector) {
        var anchor = container.querySelector(afterSelector);
        if (anchor && anchor.parentNode === container) {
            // keep our rows in order: skip past rows we already placed after the anchor
            var next = anchor.nextElementSibling;
            while (next && next.hasAttribute('data-nfx-row') && next.getAttribute('data-nfx-row').indexOf('top10') === 0) {
                anchor = next;
                next = next.nextElementSibling;
            }
            container.insertBefore(node, anchor.nextSibling);
        } else {
            container.appendChild(node);
        }
    }

    function ensureRows(container) {
        var cfg = state.cfg;
        if (cfg.EnableTop10) {
            [['Movie', 'top10-movie', 'Top 10 Movies'], ['Series', 'top10-series', 'Top 10 Shows']].forEach(function (spec) {
                if (container.querySelector('[data-nfx-row="' + spec[1] + '"]')) return;
                feed('top10-' + spec[0], 'NetflixUi/Top10', { type: spec[0] }).then(safe('top10', function (list) {
                    if (!list || list.length < 3 || container.querySelector('[data-nfx-row="' + spec[1] + '"]') || !container.isConnected) return;
                    var html = rowHtml(spec[1], spec[2], list.map(function (it, i) { return top10CardHtml(it, it.Rank || i + 1); }).join(''));
                    var node = toNode(html);
                    // Movies first, then Shows
                    var movies = container.querySelector('[data-nfx-row="top10-movie"]');
                    var shows = container.querySelector('[data-nfx-row="top10-series"]');
                    if (spec[0] === 'Series' && movies) container.insertBefore(node, movies.nextSibling);
                    else if (spec[0] === 'Movie' && shows) container.insertBefore(node, shows);
                    else insertAfterSection(container, node, '.section1');
                }), function (e) { warn('top10 feed', e); });
            });
        }
        if (cfg.GenreRowCount > 0 && !container.querySelector('[data-nfx-row^="genre-"]') && !container.hasAttribute('data-nfx-genres')) {
            container.setAttribute('data-nfx-genres', 'loading');
            feed('genres', 'NetflixUi/GenreRows', { count: cfg.GenreRowCount }).then(safe('genres', function (rows) {
                container.removeAttribute('data-nfx-genres');
                if (!Array.isArray(rows) || !container.isConnected || container.querySelector('[data-nfx-row^="genre-"]')) return;
                var html = rows.map(function (r) {
                    return rowHtml('genre-' + r.Slug, r.Genre, r.Items.map(cardHtml).join(''));
                }).join('');
                var w = doc.createElement('div');
                w.innerHTML = html;
                while (w.firstChild) container.appendChild(stubRow(w.firstChild));
            }), function (e) {
                container.removeAttribute('data-nfx-genres');
                warn('genre feed', e);
            });
        }
    }

    // ------------------------------------------------------------------ 16:9 stock home cards

    var shapePending = {};

    function backdropify(container) {
        if (state.cfg.HomeCardShape !== 'backdrop') return;
        var cards = container.querySelectorAll('.verticalSection:not([data-nfx-row]) .card.overflowPortraitCard[data-id]:not([data-nfx-shape])');
        if (!cards.length) return;
        var ids = [];
        Array.prototype.forEach.call(cards, function (c) {
            c.setAttribute('data-nfx-shape', 'pending');
            var id = c.getAttribute('data-id');
            if (id && !shapePending[id] && ids.indexOf(id) < 0) ids.push(id);
        });
        var c = api();
        if (!c || !ids.length) { applyShapes(container); return; }
        var batch = ids.slice(0, 100);
        batch.forEach(function (id) { shapePending[id] = true; });
        c.getItems(userId(), {
            Ids: batch.join(','),
            EnableImageTypes: 'Thumb,Backdrop,Logo',
            ImageTypeLimit: 1,
            Fields: 'Genres,Overview',
            EnableTotalRecordCount: false
        }).then(function (res) {
            (res.Items || []).forEach(function (i) { state.items[i.Id] = i; });
            batch.forEach(function (id) { delete shapePending[id]; });
            applyShapes(container);
        }).catch(function (e) {
            batch.forEach(function (id) { delete shapePending[id]; });
            warn('shape', e);
        });
    }

    function dtoLandscape(i, preferBackdrop) {
        if (!i) return '';
        if (preferBackdrop && i.BackdropImageTags && i.BackdropImageTags.length) return img(i.Id, 'Backdrop', i.BackdropImageTags[0], 640);
        if (i.ImageTags && i.ImageTags.Thumb) return img(i.Id, 'Thumb', i.ImageTags.Thumb, 640);
        if (i.BackdropImageTags && i.BackdropImageTags.length) return img(i.Id, 'Backdrop', i.BackdropImageTags[0], 640);
        if (i.ParentThumbItemId && i.ParentThumbImageTag) return img(i.ParentThumbItemId, 'Thumb', i.ParentThumbImageTag, 640);
        if (i.ParentBackdropItemId && i.ParentBackdropImageTags && i.ParentBackdropImageTags.length) {
            return img(i.ParentBackdropItemId, 'Backdrop', i.ParentBackdropImageTags[0], 640);
        }
        return '';
    }

    function applyShapes(container) {
        var cards = container.querySelectorAll('.card[data-nfx-shape="pending"]');
        Array.prototype.forEach.call(cards, function (card) {
            var it = state.items[card.getAttribute('data-id')];
            var src = dtoLandscape(it && it.ImageTags ? it : null);
            if (!src) { card.setAttribute('data-nfx-shape', 'kept'); return; }
            card.classList.remove('overflowPortraitCard');
            card.classList.add('overflowBackdropCard');
            var pad = card.querySelector('.cardPadder');
            if (pad) { pad.classList.remove('cardPadder-overflowPortrait'); pad.classList.add('cardPadder-overflowBackdrop'); }
            var box = card.querySelector('.cardImageContainer');
            if (box) {
                box.setAttribute('data-src', src);
                if (!box.classList.contains('lazy')) box.style.backgroundImage = 'url("' + src + '")';
            }
            card.setAttribute('data-nfx-shape', 'backdrop');
        });
    }

    // ------------------------------------------------------------------ hover preview

    function previewEl() {
        var p = state.preview.el;
        if (p && p.isConnected) return p;
        p = doc.createElement('div');
        p.className = 'nfx-preview';
        p.setAttribute('role', 'dialog');
        p.setAttribute('aria-hidden', 'true');
        p.innerHTML = '<div class="nfx-preview__media"><img class="nfx-preview__img" alt=""><img class="nfx-preview__logo" alt="" hidden></div>' +
            '<div class="nfx-preview__body">' +
            '<div class="nfx-preview__actions">' +
            '<button type="button" class="nfx-btn nfx-btn--icon nfx-btn--play" aria-label="Play" title="Play">' + icon('play_arrow') + '</button>' +
            '<button type="button" class="nfx-btn nfx-btn--icon nfx-btn--list"></button>' +
            '<button type="button" class="nfx-btn nfx-btn--icon nfx-btn--more" aria-label="More Info" title="More Info">' + icon('expand_more') + '</button>' +
            '</div>' +
            '<h3 class="nfx-preview__title"></h3>' +
            '<div class="nfx-preview__meta"></div>' +
            '<div class="nfx-preview__genres"></div>' +
            '</div>';
        p.addEventListener('mouseleave', function (e) {
            var to = e.relatedTarget;
            if (to && state.preview.card && state.preview.card.contains(to)) return;
            closePreview();
        });
        p.addEventListener('click', safe('previewClick', function (e) {
            var id = p.getAttribute('data-item-id');
            if (!id) return;
            var it = state.items[id] || {};
            var t = e.target;
            if (t.closest('.nfx-btn--play')) {
                var type = it.Type || p.getAttribute('data-type');
                var pos = (it.UserData && it.UserData.PlaybackPositionTicks) || 0;
                closePreview();
                play(id, type, pos, id);
            } else if (t.closest('.nfx-btn--list')) {
                toggleFavorite(id, t.closest('.nfx-btn--list'));
            } else if (t.closest('.nfx-btn--more') || t.closest('.nfx-preview__media')) {
                closePreview();
                goDetails(id);
            }
        }));
        doc.body.appendChild(p);
        state.preview.el = p;
        return p;
    }

    function fillPreview(p, id, card) {
        var it = state.items[id];
        p.setAttribute('data-item-id', id);
        p.setAttribute('data-type', card.getAttribute('data-type') || '');
        var mediaImg = p.querySelector('.nfx-preview__img');
        var logoImg = p.querySelector('.nfx-preview__logo');
        var titleEl = p.querySelector('.nfx-preview__title');
        var logo = it ? logoUrl(it) : '';
        var src = '';
        if (it) src = it.ImageTags ? dtoLandscape(it, !!logo) : cardImage(it, !!logo);
        if (!src) src = ownCardImage(card);
        if (mediaImg.getAttribute('src') !== src) mediaImg.src = src;
        var name = it ? (it.SeriesName && it.Type === 'Episode' ? it.SeriesName : it.Name) : (card.getAttribute('aria-label') || '');
        mediaImg.alt = name || '';
        p.setAttribute('aria-label', name || 'Preview');
        if (logo) {
            logoImg.hidden = false;
            if (logoImg.getAttribute('src') !== logo) logoImg.src = logo;
            logoImg.alt = name || '';
            titleEl.hidden = true;
        } else {
            logoImg.hidden = true;
            logoImg.removeAttribute('src');
            titleEl.hidden = false;
        }
        titleEl.textContent = name || '';
        if (!it) {
            p.querySelector('.nfx-preview__meta').innerHTML = '';
            p.querySelector('.nfx-preview__genres').innerHTML = '';
            setListIcon(p.querySelector('.nfx-btn--list'), false);
            return;
        }
        p.querySelector('.nfx-preview__meta').innerHTML = metaHtml(it);
        p.querySelector('.nfx-preview__genres').innerHTML = genresHtml(it.Genres);
        setListIcon(p.querySelector('.nfx-btn--list'), it.UserData && it.UserData.IsFavorite);
    }

    function ownCardImage(card) {
        var own = card.querySelector('.nfx-card__img img');
        if (own) return own.getAttribute('src') || '';
        var box = card.querySelector('.cardImageContainer');
        if (!box) return '';
        var ds = box.getAttribute('data-src');
        if (ds) return ds;
        var m = /url\(["']?([^"')]+)["']?\)/.exec(box.style.backgroundImage || '');
        return m ? m[1] : '';
    }

    function logoUrl(it) {
        if (it.LogoTag) return img(it.Id, 'Logo', it.LogoTag, 500);
        if (it.ImageTags && it.ImageTags.Logo) return img(it.Id, 'Logo', it.ImageTags.Logo, 500);
        if (it.ParentLogoItemId && it.ParentLogoImageTag) return img(it.ParentLogoItemId, 'Logo', it.ParentLogoImageTag, 500);
        return '';
    }

    function positionPreview(p, card) {
        var r = card.getBoundingClientRect();
        var w = Math.round(Math.max(r.width * 1.5, 260));
        var gutter = 16;
        var left = r.left + r.width / 2 - w / 2;
        left = Math.max(gutter, Math.min(left, window.innerWidth - w - gutter));
        var top = r.top - r.height * 0.3;
        top = Math.max(8, top);
        p.style.left = Math.round(left + window.scrollX) + 'px';
        p.style.top = Math.round(top + window.scrollY) + 'px';
        p.style.width = w + 'px';
    }

    function openPreview(card) {
        var id = card.getAttribute('data-id');
        if (!id || !card.isConnected) return;
        var p = previewEl();
        fillPreview(p, id, card);
        positionPreview(p, card);
        state.preview.card = card;
        state.preview.openFor = id;
        p.setAttribute('aria-hidden', 'false');
        // next frame so the transition runs
        requestAnimationFrame(function () {
            if (state.preview.openFor !== id) return;
            p.classList.add('is-open');
            root.classList.add('nfx-preview-open');
        });
        if (!state.items[id] || !state.items[id].Genres) {
            var c = api();
            if (c && c.getItem) {
                c.getItem(userId(), id).then(function (full) {
                    state.items[id] = Object.assign({}, state.items[id] || {}, full);
                    if (state.preview.openFor === id) fillPreview(p, id, card);
                }).catch(function () { /* keep what we have */ });
            }
        }
    }

    function closePreview() {
        clearTimeout(state.preview.timer);
        var p = state.preview.el;
        state.preview.openFor = null;
        state.preview.card = null;
        root.classList.remove('nfx-preview-open');
        if (p) {
            p.classList.remove('is-open');
            p.setAttribute('aria-hidden', 'true');
        }
    }

    function homeCardFrom(target) {
        if (!target || !target.closest) return null;
        var card = target.closest('.card[data-id]');
        if (!card) return null;
        if (!card.closest('.homeSectionsContainer, #homeTab')) return null;
        return card;
    }

    function markEdges(card) {
        var scroller = card.closest('.emby-scroller, .scrollX, .itemsContainer');
        if (!scroller) return;
        var sr = scroller.getBoundingClientRect();
        var cr = card.getBoundingClientRect();
        var left = Math.max(sr.left, 0);
        var right = Math.min(sr.right, window.innerWidth);
        card.classList.toggle('nfx-edge-left', cr.left - left < cr.width * 0.5);
        card.classList.toggle('nfx-edge-right', right - cr.right < cr.width * 0.5);
    }

    function onOver(e) {
        if (isTv() || !finePointer()) return;
        var card = homeCardFrom(e.target);
        if (!card) return;
        markEdges(card);
        if (!state.cfg || !state.cfg.EnableHoverPreview) return;
        if (state.preview.card === card) return;
        clearTimeout(state.preview.timer);
        state.preview.timer = setTimeout(safe('preview', function () {
            if (card.matches(':hover')) openPreview(card);
        }), PREVIEW_DELAY_MS);
    }

    function onOut(e) {
        var card = homeCardFrom(e.target);
        if (!card) return;
        var to = e.relatedTarget;
        if (to && card.contains(to)) return;
        card.classList.remove('nfx-edge-left', 'nfx-edge-right');
        clearTimeout(state.preview.timer);
        var p = state.preview.el;
        if (to && p && p.contains(to)) return;
        if (state.preview.card === card) closePreview();
    }

    // ------------------------------------------------------------------ scroll

    var scrollTicking = false;
    function onScroll() {
        if (scrollTicking) return;
        scrollTicking = true;
        requestAnimationFrame(function () {
            scrollTicking = false;
            var y = window.scrollY || doc.documentElement.scrollTop || 0;
            root.classList.toggle('nfx-scrolled', y > 40);
        });
        if (state.preview.openFor) closePreview();
    }

    // ------------------------------------------------------------------ scan

    function activeHomeTab() {
        var page = doc.querySelector('#indexPage:not(.hide)');
        if (!page) return null;
        var tab = page.querySelector('#homeTab');
        if (!tab) return null;
        return tab;
    }

    function scan() {
        state.scanQueued = false;
        root.classList.toggle('nfx-modern', !!doc.querySelector('.MuiAppBar-root'));
        root.classList.toggle('nfx-legacy', !doc.querySelector('.MuiAppBar-root'));
        if (onDashboard()) { closePreview(); return; }
        if (!api() || !userId()) return;
        var tab = activeHomeTab();
        if (!tab) { root.classList.remove('nfx-on-home'); return; }
        var container = tab.querySelector('.homeSectionsContainer');
        if (!container) return;
        root.classList.add('nfx-on-home');
        bridge();
        loadConfig().then(safe('home', function () {
            ensureHero(tab, container);
            ensureRows(container);
            backdropify(container);
        }));
    }

    function queueScan() {
        if (state.scanQueued) return;
        state.scanQueued = true;
        setTimeout(safe('scan', scan), 120);
    }

    function onNavigate() {
        closePreview();
        queueScan();
    }

    function init() {
        root.classList.add('nfx');
        new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) {
                if (muts[i].addedNodes.length) { queueScan(); return; }
            }
        }).observe(doc.body, { childList: true, subtree: true });
        doc.addEventListener('viewshow', safe('viewshow', onNavigate), true);
        window.addEventListener('hashchange', safe('hashchange', onNavigate));
        window.addEventListener('popstate', safe('popstate', onNavigate));
        window.addEventListener('scroll', safe('scroll', onScroll), { passive: true });
        doc.addEventListener('mouseover', safe('over', onOver), { passive: true });
        doc.addEventListener('mouseout', safe('out', onOut), { passive: true });
        window.addEventListener('resize', safe('resize', closePreview), { passive: true });
        queueScan();
    }

    try {
        if (doc.body) init();
        else doc.addEventListener('DOMContentLoaded', safe('init', init));
    } catch (e) {
        warn('init', e);
    }
})();
