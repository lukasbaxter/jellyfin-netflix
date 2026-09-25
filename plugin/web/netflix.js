/* jellyfin-netflix client, served by the Netflix UI plugin at /NetflixUi/netflix.js
 * One IIFE, no framework, ES2019. Every entry point is wrapped so a failure
 * leaves the stock Jellyfin UI untouched. Markup follows CONTRACT.md. */
(function () {
    'use strict';

    if (window.__NFX_VERSION__) return;
    var VERSION = '2.1.0';
    window.__NFX_VERSION__ = VERSION;

    var doc = document;
    var root = doc.documentElement;
    var CACHE_MS = 5 * 60 * 1000;
    var HERO_ROTATE_MS = 9000;
    var PREVIEW_DELAY_MS = 380;

    var state = {
        cfg: null,
        cfgPromise: null,
        feeds: {},          // key -> { t, promise }
        items: {},          // id -> item (nfx shape or BaseItemDto), used by preview
        hero: { list: [], index: 0, timer: 0, paused: false, trailerTimer: 0 },
        scanQueued: false,
        preview: { el: null, card: null, timer: 0, closeTimer: 0, openFor: null, armed: null },
        lastMove: 0
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
                        HomeCardShape: c.HomeCardShape || 'backdrop',
                        ExcludedLibraryIds: c.ExcludedLibraryIds || []
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
        btn.innerHTML = icon(fav ? 'check' : 'add') +
            (btn.hasAttribute('data-label') ? '<span class="nfx-btn__label">My List</span>' : '');
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
        var cardMode = isMobile() && !isTv();
        hero.classList.toggle('nfx-hero--card', cardMode);
        newImg.src = cardMode && it.PrimaryTag ? img(it.Id, 'Primary', it.PrimaryTag, 800)
            : img(it.Id, 'Backdrop', it.BackdropTag, isMobile() ? 1000 : 1920);
        hero.style.setProperty('--nfx-glow', cardMode ? 'url("' + newImg.src + '")' : 'none');
        if (imgEl) imgEl.replaceWith(newImg); else backdropHost.appendChild(newImg);

        var content = hero.querySelector('.nfx-hero__content');
        var title = it.LogoTag
            ? '<img class="nfx-hero__logo" alt="' + esc(it.Name) + '" src="' + esc(img(it.Id, 'Logo', it.LogoTag, 800)) + '">'
            : '<h1 class="nfx-hero__title">' + esc(it.Name) + '</h1>';
        var fav = it.UserData && it.UserData.IsFavorite;
        content.innerHTML = kindLabel(it.Type) + title +
            '<div class="nfx-hero__meta">' + metaHtml(it) + '</div>' +
            '<p class="nfx-hero__overview">' + esc(it.Overview || '') + '</p>' +
            '<div class="nfx-hero__genres">' + genresHtml(it.Genres) + '</div>' +
            '<div class="nfx-hero__actions">' +
            '<button type="button" is="emby-button" class="nfx-btn nfx-btn--play emby-button" data-focusable="true">' + icon('play_arrow') + '<span>' + heroPlayLabel(it) + '</span></button>' +
            '<button type="button" is="emby-button" class="nfx-btn nfx-btn--info emby-button" data-focusable="true">' + icon('info_outline') + '<span>More Info</span></button>' +
            '<button type="button" is="emby-button" class="nfx-btn nfx-btn--icon nfx-btn--list emby-button" data-focusable="true" data-label></button>' +
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
            if (state.hero.paused || !heroActive(hero) || doc.getElementById('nfx-modal') || doc.getElementById('nfx-gate')) return;
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
                if (useModal()) openModal(it.Id); else goDetails(it.Id);
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
            closePreview(); // the hero just moved every card down; a pending preview would be misplaced
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
        // the Ids query is capped at 100 per call, so fetch every batch
        for (var i = 0; i < ids.length; i += 100) fetchShapes(c, container, ids.slice(i, i + 100));
    }

    function fetchShapes(c, container, batch) {
        batch.forEach(function (id) { shapePending[id] = true; });
        c.getItems(userId(), {
            Ids: batch.join(','),
            EnableImageTypes: 'Primary,Thumb,Backdrop,Logo',
            ImageTypeLimit: 1,
            Fields: 'Genres,Overview',
            EnableTotalRecordCount: false
        }).then(function (res) {
            (res.Items || []).forEach(function (i) { state.items[i.Id] = i; });
            batch.forEach(function (id) { delete shapePending[id]; });
            applyShapes(container);
        }).catch(function (e) {
            batch.forEach(function (id) { delete shapePending[id]; });
            applyShapes(container); // cards whose item never came back are kept as they are
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

    // Every card in a home row ends up 16:9 so heights match (Netflix rows never mix shapes).
    // No landscape art: the poster is cropped into the 16:9 box (nfx-crop), and with no art at
    // all the stock placeholder sits in a 16:9 box (nfx-noart).
    function applyShapes(container) {
        var cards = container.querySelectorAll('.card[data-nfx-shape="pending"]');
        Array.prototype.forEach.call(cards, function (card) {
            var id = card.getAttribute('data-id');
            if (shapePending[id]) return; // its batch is still loading
            var it = state.items[id];
            if (!it) { card.setAttribute('data-nfx-shape', 'kept'); return; }
            var src = dtoLandscape(it.ImageTags ? it : null);
            var kind = 'backdrop';
            if (!src && it.ImageTags && it.ImageTags.Primary) { src = img(it.Id, 'Primary', it.ImageTags.Primary, 640); kind = 'crop'; }
            if (!src) kind = 'noart';
            card.classList.remove('overflowPortraitCard');
            card.classList.add('overflowBackdropCard');
            if (kind !== 'backdrop') card.classList.add('nfx-' + kind);
            var pad = card.querySelector('.cardPadder');
            if (pad) { pad.classList.remove('cardPadder-overflowPortrait'); pad.classList.add('cardPadder-overflowBackdrop'); }
            var box = card.querySelector('.cardImageContainer');
            if (box && src) {
                box.setAttribute('data-src', src);
                if (!box.classList.contains('lazy')) box.style.backgroundImage = 'url("' + src + '")';
            }
            card.setAttribute('data-nfx-shape', kind);
        });
    }

    // ------------------------------------------------------------------ hover preview

    // ------------------------------------------------------------------ own header
    // Stock header is hidden (CSS, html.nfx-own-chrome). Ours links to the stock routes.

    var BRAND = 'JELLYFLIX';
    var views = { list: null, promise: null };

    function loadViews() {
        if (views.list) return Promise.resolve(views.list);
        if (!views.promise) {
            views.promise = getJSON('UserViews', { userId: userId() }).then(function (r) {
                views.list = (r && r.Items) || [];
                return views.list;
            }, function (e) { views.promise = null; throw e; });
        }
        return views.promise;
    }

    function excludedView(v) {
        var ex = (state.cfg && state.cfg.ExcludedLibraryIds) || [];
        var id = String(v.Id).replace(/-/g, '').toLowerCase();
        if (ex.some(function (x) { return String(x).replace(/-/g, '').toLowerCase() === id; })) return true;
        return !ex.length && /^demos?$/i.test(v.Name || '');
    }

    function mainView(type) {
        var vs = (views.list || []).filter(function (v) { return v.CollectionType === type && !excludedView(v); });
        return vs[0] || null;
    }

    function viewHash(v) {
        if (!v) return '#/home';
        var route = v.CollectionType === 'tvshows' ? 'tv' : v.CollectionType;
        return '#/' + route + '?topParentId=' + v.Id + '&collectionType=' + v.CollectionType;
    }

    function navLinks() {
        return [
            ['home', 'Home', '#/home'],
            ['shows', 'TV Shows', viewHash(mainView('tvshows'))],
            ['movies', 'Movies', viewHash(mainView('movies'))],
            ['new', 'New & Popular', '#/home?nfx=new'],
            ['list', 'My List', '#/home?nfx=list']
        ];
    }

    function activeNav() {
        var h = location.hash || '';
        if (/nfx=new/.test(h)) return 'new';
        if (/nfx=list/.test(h)) return 'list';
        var tv = mainView('tvshows'), mv = mainView('movies');
        if (tv && h.indexOf(tv.Id) > -1) return 'shows';
        if (mv && h.indexOf(mv.Id) > -1) return 'movies';
        if (/^#\/(home)?(\?|$)/.test(h) || h === '' || h === '#/') return 'home';
        return '';
    }

    function avatarUrl() {
        var c = api();
        var u = state.user;
        if (u && u.PrimaryImageTag) return url('Users/' + u.Id + '/Images/Primary', { tag: u.PrimaryImageTag, maxWidth: 96 });
        return '';
    }

    function renderMenu(menu) {
        var me = userId();
        var others = profilesFor(serverId()).filter(function (p) { return p.UserId !== me; });
        var admin = !!(state.user && state.user.Policy && state.user.Policy.IsAdministrator);
        var item = function (act, ic, label, extra) {
            return '<button type="button" role="menuitem" class="nfx-menu__item" data-act="' + act + '"' + (extra || '') + '>' + ic + '<span>' + esc(label) + '</span></button>';
        };
        menu.innerHTML = '<span class="nfx-menu__caret"></span>' +
            others.map(function (p, i) {
                return '<button type="button" role="menuitem" class="nfx-menu__item nfx-menu__prof" data-act="switch" data-uid="' + esc(p.UserId) + '">' +
                    avatarHtml(p, i + 1) + '<span>' + esc(p.Name) + '</span></button>';
            }).join('') +
            item('manage', icon('edit'), 'Manage Profiles') +
            item('profiles', icon('switch_account'), 'Switch Profile') +
            '<hr>' +
            item('go', icon('person_outline'), 'Account & Settings', ' data-href="#/mypreferencesmenu"') +
            (admin ? item('go', icon('dashboard'), 'Admin Dashboard', ' data-href="#/dashboard"') +
                item('go', icon('edit_note'), 'Metadata Manager', ' data-href="#/metadata"') : '') +
            '<hr>' +
            '<button type="button" role="menuitem" class="nfx-menu__item nfx-menu__signout" data-act="signout"><span>Sign out of ' + esc(BRAND.charAt(0) + BRAND.slice(1).toLowerCase()) + '</span></button>';
    }

    function signOut() {
        // a real sign-out: revoke the token and forget this profile on this device
        forgetProfile(serverId(), userId());
        var c = api();
        var done = function () {
            var cs = credStore();
            var srv = currentServer(cs);
            if (srv) { srv.AccessToken = null; srv.UserId = null; cs.store.setItem('jellyfin_credentials', JSON.stringify(cs.creds)); }
            ssSet(GATE_KEY, '1');
            location.hash = '#/login';
            location.reload();
        };
        try {
            fetch(url('Sessions/Logout'), { method: 'POST', headers: { Authorization: 'MediaBrowser Token="' + (c && c.accessToken ? c.accessToken() : '') + '"' } })
                .then(done, done);
        } catch (e) { done(); }
    }

    function ensureHeader() {
        var h = doc.getElementById('nfx-header');
        if (!h) {
            h = doc.createElement('header');
            h.id = 'nfx-header';
            h.className = 'nfx-header';
            h.innerHTML =
                '<button type="button" class="nfx-header__back" aria-label="Back">' + icon('arrow_back') + '</button>' +
                '<a class="nfx-logo" href="#/home" aria-label="Home">' + BRAND + '</a>' +
                '<nav class="nfx-nav" aria-label="Browse"></nav>' +
                '<div class="nfx-header__right">' +
                '<a class="nfx-hbtn nfx-hbtn--search" href="#/search" aria-label="Search">' + icon('search') + '</a>' +
                '<button type="button" class="nfx-hbtn nfx-hbtn--cast" aria-label="Cast">' + icon('cast') + '</button>' +
                '<div class="nfx-account">' +
                '<button type="button" class="nfx-avatar" aria-label="Account menu" aria-haspopup="true" aria-expanded="false"><span class="nfx-avatar__img"></span>' + icon('arrow_drop_down') + '</button>' +
                '<div class="nfx-menu" role="menu"></div></div>' +
                '</div>' +
                '<nav class="nfx-chips" aria-label="Categories"></nav>';
            h.querySelector('.nfx-header__back').addEventListener('click', function () { history.back(); });
            var acct = h.querySelector('.nfx-account');
            var openMenu = function (on) {
                acct.classList.toggle('is-open', on);
                acct.querySelector('.nfx-avatar').setAttribute('aria-expanded', on ? 'true' : 'false');
                if (on) renderMenu(acct.querySelector('.nfx-menu'));
            };
            var hideTimer = 0;
            acct.addEventListener('mouseenter', function () { if (!finePointer()) return; clearTimeout(hideTimer); openMenu(true); });
            acct.addEventListener('mouseleave', function () { if (!finePointer()) return; hideTimer = setTimeout(function () { openMenu(false); }, 250); });
            acct.querySelector('.nfx-avatar').addEventListener('click', function (e) {
                e.stopPropagation();
                openMenu(!acct.classList.contains('is-open'));
                var first = acct.querySelector('.nfx-menu a, .nfx-menu button');
                if (acct.classList.contains('is-open') && first && !finePointer()) first.focus();
            });
            acct.querySelector('.nfx-menu').addEventListener('click', safe('menu', function (e) {
                var t = e.target.closest('[data-act]');
                if (!t) { openMenu(false); return; }
                e.preventDefault();
                openMenu(false);
                var act = t.getAttribute('data-act');
                if (act === 'switch') {
                    var p = profilesFor(serverId()).filter(function (x) { return x.UserId === t.getAttribute('data-uid'); })[0];
                    if (p) switchTo(p);
                } else if (act === 'profiles') { openGate(); }
                else if (act === 'manage') { openGate(); var g = doc.getElementById('nfx-gate'); if (g) { g.classList.add('is-managing'); renderGate(g); } }
                else if (act === 'signout') { signOut(); }
                else if (act === 'go') { location.hash = t.getAttribute('data-href'); }
            }));
            doc.addEventListener('click', function (e) { if (!acct.contains(e.target)) openMenu(false); });
            h.querySelector('.nfx-hbtn--cast').addEventListener('click', function () {
                var b = doc.querySelector('.headerCastButton, button[aria-label="Cast to Device"]');
                if (b) b.click();
            });
            doc.body.appendChild(h);
        }
        var links = navLinks();
        var active = activeNav();
        var nav = h.querySelector('.nfx-nav');
        var navHtml = links.map(function (l) {
            return '<a href="' + esc(l[2]) + '" class="nfx-nav__link' + (l[0] === active ? ' is-active' : '') + '">' + esc(l[1]) + '</a>';
        }).join('');
        if (nav.getAttribute('data-html') !== navHtml) { nav.innerHTML = navHtml; nav.setAttribute('data-html', navHtml); }
        var chips = h.querySelector('.nfx-chips');
        var chipHtml = links.slice(1, 4).map(function (l) {
            return '<a href="' + esc(l[2]) + '" class="nfx-chip' + (l[0] === active ? ' is-active' : '') + '">' + esc(l[1]) + '</a>';
        }).join('');
        if (chips.getAttribute('data-html') !== chipHtml) { chips.innerHTML = chipHtml; chips.setAttribute('data-html', chipHtml); }
        var av = h.querySelector('.nfx-avatar__img');
        var src = avatarUrl();
        var bg = src ? 'url("' + src + '")' : '';
        var letter = src ? '' : ((state.user && state.user.Name) || '').charAt(0).toUpperCase();
        if (av.style.backgroundImage !== bg) av.style.backgroundImage = bg;
        if (av.classList.contains('is-default') !== !src) av.classList.toggle('is-default', !src);
        if (av.textContent !== letter) av.textContent = letter;
        setRootClass('nfx-at-home', active === 'home' || active === 'new');
        setRootClass('nfx-mode-list', active === 'list');
        return h;
    }

    function loadUser() {
        var c = api();
        if (state.user || state.userLoading || !c || !c.getCurrentUser) return;
        state.userLoading = true;
        c.getCurrentUser().then(function (u) { state.user = u; state.userLoading = false; ensureHeader(); rememberProfile(); ensureGate(); },
            function () { state.userLoading = false; });
    }

    // search: titles first, people after, music/studios hidden (Netflix only shows titles)
    var SEARCH_KIND = { movies: 'title', shows: 'title', series: 'title', episodes: 'title', collections: 'noise', 'live tv': 'title', programs: 'title',
        people: 'people', studios: 'noise', artists: 'noise', albums: 'noise', songs: 'noise', 'music videos': 'noise', playlists: 'noise', books: 'noise', photos: 'noise', 'photo albums': 'noise', videos: 'noise' };
    function tagSearch() {
        var pg = doc.querySelector('#searchPage:not(.hide)');
        if (!pg) return;
        Array.prototype.forEach.call(pg.querySelectorAll('.verticalSection'), function (sec) {
            var h = sec.querySelector('h2, .sectionTitle');
            var k = SEARCH_KIND[((h && h.textContent) || '').trim().toLowerCase()] || 'title';
            if (sec.getAttribute('data-nfx-kind') !== k) sec.setAttribute('data-nfx-kind', k);
        });
    }

    // ------------------------------------------------------------------ hide collections
    // Collections (incl. the studio/streaming ones) never show: search section, detail
    // "Collections" row, library "Collections" tab, BoxSet cards.
    function hideCollections() {
        var sel = '#itemDetailPage:not(.hide) .verticalSection, .emby-tab-button, .MuiTab-root, .MuiMenuItem-root';
        Array.prototype.forEach.call(doc.querySelectorAll(sel), function (el) {
            var h = el.matches('.verticalSection') ? el.querySelector('h2, .sectionTitle') : el;
            var txt = ((h && h.textContent) || '').trim();
            var hide = /^collections?$/i.test(txt);
            if (hide && !el.hasAttribute('data-nfx-hide')) el.setAttribute('data-nfx-hide', '');
        });
    }

    // ------------------------------------------------------------------ More Info modal (2022)

    function useModal() { return !isTv() && !isMobile() && window.innerWidth > 800; }

    function kindLabel(type) {
        var k = type === 'Series' || type === 'Episode' || type === 'Season' ? 'SERIES' : 'FILM';
        return '<div class="nfx-kind"><span class="nfx-kind__b">' + esc(BRAND.charAt(0)) + '</span><span class="nfx-kind__t">' + k + '</span></div>';
    }

    function peopleOf(it, types) {
        return (it.People || []).filter(function (p) { return types.indexOf(p.Type) > -1; }).map(function (p) { return p.Name; });
    }

    function listLine(label, names, max) {
        if (!names || !names.length) return '';
        var shown = names.slice(0, max || names.length);
        return '<div class="nfx-m-line"><span class="nfx-m-label">' + esc(label) + ':</span> ' +
            shown.map(function (n) { return '<span>' + esc(n) + '</span>'; }).join(', ') +
            (max && names.length > max ? ', <i>more</i>' : '') + '</div>';
    }

    function seasonsText(it) {
        var n = it.ChildCount;
        return n ? n + (n === 1 ? ' Season' : ' Seasons') : '';
    }

    function modalMeta(it) {
        return '<span class="nfx-match">' + esc(match(it.CommunityRating)) + '</span>' +
            '<span>' + esc(it.ProductionYear || '') + '</span>' +
            (it.OfficialRating ? '<span class="nfx-maturity">' + esc(it.OfficialRating) + '</span>' : '') +
            '<span>' + esc(it.Type === 'Series' ? seasonsText(it) : runtime(it.RunTimeTicks)) + '</span>' +
            '<span class="nfx-hd">HD</span>';
    }

    function epHtml(ep) {
        var ud = ep.UserData || {};
        var pct = ud.PlaybackPositionTicks && ep.RunTimeTicks ? Math.round(ud.PlaybackPositionTicks / ep.RunTimeTicks * 100) : 0;
        var src = ep.ImageTags && ep.ImageTags.Primary ? img(ep.Id, 'Primary', ep.ImageTags.Primary, 400) : '';
        return '<button type="button" class="nfx-ep" data-play="' + esc(ep.Id) + '" data-pos="' + (ud.PlaybackPositionTicks || 0) + '">' +
            '<span class="nfx-ep__num">' + esc(ep.IndexNumber != null ? ep.IndexNumber : '') + '</span>' +
            '<span class="nfx-ep__img">' + (src ? '<img loading="lazy" alt="" src="' + esc(src) + '">' : '') +
            '<span class="nfx-ep__play">' + icon('play_arrow') + '</span>' +
            (pct ? '<span class="nfx-ep__bar"><i style="width:' + pct + '%"></i></span>' : '') + '</span>' +
            '<span class="nfx-ep__body"><span class="nfx-ep__head"><span class="nfx-ep__title">' + esc(ep.Name) + '</span>' +
            '<span class="nfx-ep__rt">' + esc(runtime(ep.RunTimeTicks)) + '</span></span>' +
            '<span class="nfx-ep__ov">' + esc(ep.Overview || '') + '</span></span></button>';
    }

    function simHtml(it) {
        var m = card(it);
        var src = m.thumb || m.backdrop || m.poster;
        var fav = it.UserData && it.UserData.IsFavorite;
        return '<div class="nfx-sim" data-open="' + esc(it.Id) + '" tabindex="0" role="button">' +
            '<div class="nfx-sim__img">' + (src ? '<img loading="lazy" alt="" src="' + esc(src) + '">' : '') +
            (m.thumb ? '' : (m.logo ? '<img class="nfx-sim__logo" alt="" src="' + esc(m.logo) + '">' : '<span class="nfx-sim__name">' + esc(it.Name) + '</span>')) +
            '<span class="nfx-sim__rt">' + esc(it.Type === 'Series' ? seasonsText(it) : runtime(it.RunTimeTicks)) + '</span></div>' +
            '<div class="nfx-sim__body"><div class="nfx-sim__meta"><div><span class="nfx-match">' + esc(match(it.CommunityRating)) + '</span>' +
            '<div class="nfx-sim__sub">' + (it.OfficialRating ? '<span class="nfx-maturity">' + esc(it.OfficialRating) + '</span>' : '') +
            '<span>' + esc(it.ProductionYear || '') + '</span></div></div>' +
            '<button type="button" class="nfx-circle" data-fav="' + esc(it.Id) + '" aria-label="My List">' + icon(fav ? 'check' : 'add') + '</button></div>' +
            '<p class="nfx-sim__ov">' + esc(it.Overview || '') + '</p></div></div>';
    }

    function loadEpisodes(box, seriesId, seasonId) {
        var list = box.querySelector('.nfx-eps__list');
        list.innerHTML = '<div class="nfx-m-loading"></div>';
        getJSON('Shows/' + seriesId + '/Episodes', { userId: userId(), seasonId: seasonId, Fields: 'Overview', EnableImageTypes: 'Primary', ImageTypeLimit: 1 })
            .then(safe('episodes', function (r) {
                list.innerHTML = ((r && r.Items) || []).map(epHtml).join('') || '<p class="nfx-m-empty">No episodes.</p>';
            }), function (e) { warn('episodes', e); });
    }

    function closeModal() {
        var m = doc.getElementById('nfx-modal');
        if (!m) return;
        root.classList.remove('nfx-modal-open');
        m.classList.add('is-leaving');
        setTimeout(function () { m.remove(); }, 250);
        if (state.modalReturn && state.modalReturn.focus) { try { state.modalReturn.focus(); } catch (_) { /* */ } }
    }

    function openModal(id) {
        closePreview();
        var c = api();
        if (!c || !c.getItem) { goDetails(id); return; }
        var m = doc.getElementById('nfx-modal');
        if (!m) {
            state.modalReturn = doc.activeElement;
            m = doc.createElement('div');
            m.id = 'nfx-modal';
            m.className = 'nfx-modal';
            m.setAttribute('role', 'dialog');
            m.setAttribute('aria-modal', 'true');
            m.innerHTML = '<div class="nfx-modal__box"></div>';
            m.addEventListener('click', safe('modalClick', onModalClick));
            doc.body.appendChild(m);
            requestAnimationFrame(function () { root.classList.add('nfx-modal-open'); });
        }
        var box = m.querySelector('.nfx-modal__box');
        m.scrollTop = 0;
        box.innerHTML = '<div class="nfx-m-loading nfx-m-loading--big"></div>';
        m.setAttribute('data-id', id);
        c.getItem(userId(), id).then(safe('modal', function (it) {
            if (m.getAttribute('data-id') !== id) return;
            state.items[it.Id] = it;
            renderModal(m, box, it);
        }), function (e) { warn('modal item', e); closeModal(); goDetails(id); });
    }

    function renderModal(m, box, it) {
        var isSeries = it.Type === 'Series';
        var t = it.ImageTags || {};
        var bd = it.BackdropImageTags && it.BackdropImageTags.length ? img(it.Id, 'Backdrop', it.BackdropImageTags[0], 1280) : (t.Thumb ? img(it.Id, 'Thumb', t.Thumb, 1280) : '');
        var logo = t.Logo ? img(it.Id, 'Logo', t.Logo, 600) : '';
        var fav = it.UserData && it.UserData.IsFavorite;
        var resume = it.UserData && it.UserData.PlaybackPositionTicks > 0;
        var cast = peopleOf(it, ['Actor', 'GuestStar']);
        m.setAttribute('aria-label', it.Name);
        box.innerHTML =
            '<button type="button" class="nfx-modal__close" aria-label="Close">' + icon('close') + '</button>' +
            '<div class="nfx-modal__media">' + (bd ? '<img class="nfx-modal__bd" alt="" src="' + esc(bd) + '">' : '') +
            '<div class="nfx-modal__shade"></div>' +
            '<div class="nfx-modal__hero">' + kindLabel(it.Type) +
            (logo ? '<img class="nfx-modal__logo" alt="' + esc(it.Name) + '" src="' + esc(logo) + '">' : '<h2 class="nfx-modal__title">' + esc(it.Name) + '</h2>') +
            '<div class="nfx-modal__actions">' +
            '<button type="button" class="nfx-btn nfx-btn--play nfx-m-play">' + icon('play_arrow') + '<span>' + (resume ? 'Resume' : 'Play') + '</span></button>' +
            '<button type="button" class="nfx-circle nfx-circle--lg" data-fav="' + esc(it.Id) + '" aria-label="My List">' + icon(fav ? 'check' : 'add') + '</button>' +
            '<button type="button" class="nfx-circle nfx-circle--lg nfx-m-like" aria-label="I like this">' + icon('thumb_up_off_alt') + '</button>' +
            '</div></div></div>' +
            '<div class="nfx-modal__body">' +
            '<div class="nfx-modal__info"><div class="nfx-modal__left">' +
            '<div class="nfx-modal__meta">' + modalMeta(it) + '</div>' +
            (it.Taglines && it.Taglines[0] ? '<p class="nfx-modal__tag">' + esc(it.Taglines[0]) + '</p>' : '') +
            '<p class="nfx-modal__ov">' + esc(it.Overview || '') + '</p></div>' +
            '<div class="nfx-modal__right">' + listLine('Cast', cast, 3) + listLine('Genres', it.Genres) + '</div></div>' +
            (isSeries ? '<section class="nfx-eps"><div class="nfx-eps__head"><h3>Episodes</h3><select class="nfx-eps__season" aria-label="Season"></select></div><div class="nfx-eps__list"></div></section>' : '') +
            '<section class="nfx-more"><h3>More Like This</h3><div class="nfx-more__grid"><div class="nfx-m-loading"></div></div></section>' +
            '<section class="nfx-about"><h3>About <b>' + esc(it.Name) + '</b></h3>' +
            listLine('Director', peopleOf(it, ['Director'])) +
            listLine('Cast', cast, 12) +
            listLine('Writer', peopleOf(it, ['Writer'])) +
            listLine('Genres', it.Genres) +
            (it.OfficialRating ? '<div class="nfx-m-line"><span class="nfx-m-label">Maturity rating:</span> <span class="nfx-maturity">' + esc(it.OfficialRating) + '</span></div>' : '') +
            '<a class="nfx-about__all" href="' + esc(detailsHash(it.Id)) + '">All details, trailers and audio options</a>' +
            '</section></div>';

        if (isSeries) {
            getJSON('Shows/' + it.Id + '/Seasons', { userId: userId() }).then(safe('seasons', function (r) {
                var seasons = ((r && r.Items) || []).filter(function (s) { return s.IndexNumber !== 0 || (r.Items.length === 1); });
                var sel = box.querySelector('.nfx-eps__season');
                if (!sel || !seasons.length) return;
                sel.innerHTML = seasons.map(function (s) { return '<option value="' + esc(s.Id) + '">' + esc(s.Name) + '</option>'; }).join('');
                // start on the season you're in
                var cur = seasons.filter(function (s) { return s.UserData && s.UserData.UnplayedItemCount > 0 && s.UserData.PlayedPercentage > 0; })[0] || seasons[0];
                sel.value = cur.Id;
                sel.addEventListener('change', function () { loadEpisodes(box, it.Id, sel.value); });
                loadEpisodes(box, it.Id, cur.Id);
            }), function (e) { warn('seasons', e); });
        }
        getJSON('Items/' + it.Id + '/Similar', withImg({ Limit: 12 })).then(safe('similar', function (r) {
            var grid = box.querySelector('.nfx-more__grid');
            var items = ((r && r.Items) || []).filter(function (x) { return x.Type === 'Movie' || x.Type === 'Series'; });
            if (!items.length) { box.querySelector('.nfx-more').remove(); return; }
            grid.innerHTML = items.map(simHtml).join('');
        }), function () { var s = box.querySelector('.nfx-more'); if (s) s.remove(); });
        var pb = box.querySelector('.nfx-m-play');
        if (pb) setTimeout(function () { try { pb.focus({ preventScroll: true }); } catch (_) { /* */ } }, 50);
    }

    function playFromModal(it) {
        if (it.Type !== 'Series') { closeModal(); play(it.Id, it.Type, (it.UserData && it.UserData.PlaybackPositionTicks) || 0, it.Id); return; }
        getJSON('Shows/NextUp', { userId: userId(), SeriesId: it.Id, Limit: 1, EnableResumable: true }).then(function (r) {
            var ep = r && r.Items && r.Items[0];
            closeModal();
            if (ep) play(ep.Id, 'Episode', (ep.UserData && ep.UserData.PlaybackPositionTicks) || 0, it.Id);
            else play(it.Id, 'Series', 0, it.Id);
        }, function () { closeModal(); play(it.Id, 'Series', 0, it.Id); });
    }

    function onModalClick(e) {
        var m = doc.getElementById('nfx-modal');
        var t = e.target;
        var it = state.items[m.getAttribute('data-id')] || {};
        if (t === m || t.closest('.nfx-modal__close')) { closeModal(); return; }
        var fav = t.closest('[data-fav]');
        if (fav) {
            e.stopPropagation();
            var fid = fav.getAttribute('data-fav');
            var c = api();
            var cur = fav.querySelector('.material-icons');
            var next = !(cur && cur.classList.contains('check'));
            c.updateFavoriteStatus(userId(), fid, next).then(function () {
                fav.innerHTML = icon(next ? 'check' : 'add');
                if (state.items[fid]) (state.items[fid].UserData = state.items[fid].UserData || {}).IsFavorite = next;
            }).catch(function (er) { warn('fav', er); });
            return;
        }
        if (t.closest('.nfx-m-like')) { var b = t.closest('.nfx-m-like'); b.innerHTML = icon(b.classList.toggle('is-on') ? 'thumb_up' : 'thumb_up_off_alt'); return; }
        if (t.closest('.nfx-m-play')) { playFromModal(it); return; }
        var ep = t.closest('[data-play]');
        if (ep) { closeModal(); play(ep.getAttribute('data-play'), 'Episode', parseInt(ep.getAttribute('data-pos'), 10) || 0, it.Id); return; }
        var sim = t.closest('[data-open]');
        if (sim) { openModal(sim.getAttribute('data-open')); return; }
        if (t.closest('.nfx-about__all')) { closeModal(); }
    }

    // ------------------------------------------------------------------ Who's watching?
    // Netflix-style profile gate on every app open. Profiles = accounts that have signed in on
    // THIS device (never the server's user list). Each keeps its own token, so switching is
    // instant: swap the web client's stored credentials and reload.

    var PROFILES_KEY = 'nfx-profiles';
    var GATE_KEY = 'nfx-gate-passed';

    function lsGet(k, fallback) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } }
    function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } }
    function ssGet(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } }
    function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (_) { /* */ } }

    function credStore() {
        // "Remember me" off keeps credentials in sessionStorage
        var stores = [];
        try { stores.push(localStorage); } catch (_) { /* */ }
        try { stores.push(sessionStorage); } catch (_) { /* */ }
        for (var i = 0; i < stores.length; i++) {
            try {
                var raw = stores[i].getItem('jellyfin_credentials');
                if (raw) return { store: stores[i], creds: JSON.parse(raw) };
            } catch (_) { /* */ }
        }
        return null;
    }

    function currentServer(cs) {
        if (!cs || !cs.creds || !cs.creds.Servers) return null;
        var sid = serverId();
        var list = cs.creds.Servers;
        return list.filter(function (s) { return s.Id === sid; })[0] ||
            list.slice().sort(function (a, b) { return (b.DateLastAccessed || 0) - (a.DateLastAccessed || 0); })[0] || null;
    }

    function profilesFor(sid) {
        return lsGet(PROFILES_KEY, []).filter(function (p) { return p.ServerId === sid; });
    }

    function rememberProfile() {
        var cs = credStore();
        var srv = currentServer(cs);
        var u = state.user;
        if (!srv || !srv.AccessToken || !u || u.Id !== srv.UserId) return;
        var all = lsGet(PROFILES_KEY, []);
        var p = all.filter(function (x) { return x.ServerId === srv.Id && x.UserId === u.Id; })[0];
        if (!p) { p = { ServerId: srv.Id, UserId: u.Id }; all.push(p); }
        p.Name = u.Name;
        p.Token = srv.AccessToken;
        p.ImageTag = u.PrimaryImageTag || '';
        p.Last = Date.now();
        lsSet(PROFILES_KEY, all);
    }

    function forgetProfile(sid, uid) {
        lsSet(PROFILES_KEY, lsGet(PROFILES_KEY, []).filter(function (x) { return !(x.ServerId === sid && x.UserId === uid); }));
    }

    var AVATAR_COLORS = ['#0071eb', '#e50914', '#f5b50a', '#2bb871', '#8c4ad8', '#e87c03'];
    function avatarHtml(p, i) {
        if (p.ImageTag) {
            return '<span class="nfx-prof__img" style="background-image:url(&quot;' +
                esc(url('Users/' + p.UserId + '/Images/Primary', { tag: p.ImageTag, maxWidth: 320 })) + '&quot;)"></span>';
        }
        return '<span class="nfx-prof__img nfx-prof__img--letter" style="background-color:' + AVATAR_COLORS[i % AVATAR_COLORS.length] + '">' +
            esc((p.Name || '?').charAt(0).toUpperCase()) + '</span>';
    }

    function switchTo(p) {
        var cs = credStore();
        var srv = currentServer(cs);
        if (!srv) return;
        // make sure the saved token still works (Session Cleaner or a sign-out can revoke it)
        fetch(url('Users/Me'), { headers: { Authorization: 'MediaBrowser Token="' + p.Token + '"' } }).then(function (r) {
            if (r.status === 401 || r.status === 403) {
                forgetProfile(p.ServerId, p.UserId);
                srv.AccessToken = null;
                srv.UserId = null;
            } else {
                srv.AccessToken = p.Token;
                srv.UserId = p.UserId;
            }
            cs.store.setItem('jellyfin_credentials', JSON.stringify(cs.creds));
            ssSet(GATE_KEY, '1');
            location.hash = '#/home';
            location.reload();
        }).catch(function (e) { warn('switch', e); });
    }

    function addProfile() {
        // sign-in screen WITHOUT revoking the current token, so this profile stays switchable
        var cs = credStore();
        var srv = currentServer(cs);
        if (!srv) return;
        srv.AccessToken = null;
        srv.UserId = null;
        cs.store.setItem('jellyfin_credentials', JSON.stringify(cs.creds));
        ssSet(GATE_KEY, '1');
        location.hash = '#/login';
        location.reload();
    }

    function closeGate(gate) {
        ssSet(GATE_KEY, '1');
        root.classList.remove('nfx-gate-open');
        gate.classList.add('is-leaving');
        setTimeout(function () { gate.remove(); }, 350);
    }

    function renderGate(gate) {
        var sid = serverId();
        var list = profilesFor(sid).sort(function (a, b) { return (a.Name || '').localeCompare(b.Name || ''); });
        var me = userId();
        var manage = gate.classList.contains('is-managing');
        gate.innerHTML =
            '<div class="nfx-gate__logo">' + BRAND + '</div>' +
            '<div class="nfx-gate__center">' +
            '<h1 class="nfx-gate__title">' + (manage ? 'Manage Profiles:' : 'Who\'s watching?') + '</h1>' +
            '<ul class="nfx-gate__list">' +
            list.map(function (p, i) {
                return '<li><button type="button" class="nfx-prof" data-uid="' + esc(p.UserId) + '">' + avatarHtml(p, i) +
                    (manage && p.UserId !== me ? '<span class="nfx-prof__remove" aria-hidden="true">' + icon('close') + '</span>' : '') +
                    '<span class="nfx-prof__name">' + esc(p.Name) + '</span></button></li>';
            }).join('') +
            (manage ? '' : '<li><button type="button" class="nfx-prof nfx-prof--add"><span class="nfx-prof__img nfx-prof__img--add">' + icon('add_circle') + '</span><span class="nfx-prof__name">Add Profile</span></button></li>') +
            '</ul>' +
            '<button type="button" class="nfx-gate__manage">' + (manage ? 'Done' : 'Manage Profiles') + '</button>' +
            '</div>';
        var first = gate.querySelector('.nfx-prof[data-uid="' + me + '"]') || gate.querySelector('.nfx-prof');
        if (first) setTimeout(function () { try { first.focus(); } catch (_) { /* */ } }, 50);
    }

    function openGate() {
        if (doc.getElementById('nfx-gate')) return;
        var gate = doc.createElement('div');
        gate.id = 'nfx-gate';
        gate.className = 'nfx-gate';
        gate.setAttribute('role', 'dialog');
        gate.setAttribute('aria-modal', 'true');
        gate.setAttribute('aria-label', 'Who\'s watching?');
        renderGate(gate);
        gate.addEventListener('click', safe('gate', function (e) {
            var t = e.target;
            if (t.closest('.nfx-gate__manage')) { gate.classList.toggle('is-managing'); renderGate(gate); return; }
            if (t.closest('.nfx-prof--add')) { addProfile(); return; }
            var b = t.closest('.nfx-prof[data-uid]');
            if (!b) return;
            var uid = b.getAttribute('data-uid');
            if (gate.classList.contains('is-managing')) {
                if (uid !== userId()) { forgetProfile(serverId(), uid); renderGate(gate); }
                return;
            }
            if (uid === userId()) { closeGate(gate); return; }
            var p = profilesFor(serverId()).filter(function (x) { return x.UserId === uid; })[0];
            if (p) switchTo(p);
        }));
        gate.addEventListener('keydown', function (e) {
            // own arrow-key focus so TV remotes work without Jellyfin's focus manager
            var items = Array.prototype.slice.call(gate.querySelectorAll('.nfx-prof, .nfx-gate__manage'));
            var i = items.indexOf(doc.activeElement);
            var k = e.key;
            if (k === 'ArrowRight' || k === 'ArrowLeft' || k === 'ArrowDown' || k === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                var n = k === 'ArrowRight' ? i + 1 : k === 'ArrowLeft' ? i - 1 : k === 'ArrowDown' ? items.length - 1 : 0;
                n = Math.max(0, Math.min(items.length - 1, n));
                if (items[n]) items[n].focus();
            }
        }, true);
        doc.body.appendChild(gate);
        root.classList.add('nfx-gate-open');
        root.classList.remove('nfx-gate-pending');
    }

    function ensureGate() {
        if (!state.user || ssGet(GATE_KEY)) { root.classList.remove('nfx-gate-pending'); return; }
        rememberProfile();
        if (onDashboard()) { ssSet(GATE_KEY, '1'); root.classList.remove('nfx-gate-pending'); return; }
        openGate();
    }

    // ------------------------------------------------------------------ own home
    // The stock home sections are hidden (html.nfx-own-home) and replaced by #nfx-home.

    var DTO_FIELDS = 'Overview,Genres,PrimaryImageAspectRatio,ProductionYear,OfficialRating,CommunityRating,RunTimeTicks';
    var DTO_IMG = { EnableImageTypes: 'Primary,Backdrop,Thumb,Logo', ImageTypeLimit: 1 };

    function withImg(p) { return Object.assign({ Fields: DTO_FIELDS, userId: userId() }, DTO_IMG, p); }

    // one card model for both plugin feed items (NfxItem) and stock BaseItemDto
    function card(it) {
        var dto = !!it.ImageTags || !!it.BackdropImageTags;
        var ep = it.Type === 'Episode';
        var m = { id: it.Id, type: it.Type, name: ep && it.SeriesName ? it.SeriesName : it.Name, raw: it };
        m.linkId = ep && it.SeriesId ? it.SeriesId : it.Id;
        if (dto) {
            var t = it.ImageTags || {};
            m.thumb = t.Thumb ? img(it.Id, 'Thumb', t.Thumb, 640)
                : (it.ParentThumbItemId && it.ParentThumbImageTag ? img(it.ParentThumbItemId, 'Thumb', it.ParentThumbImageTag, 640) : '');
            m.backdrop = it.BackdropImageTags && it.BackdropImageTags.length ? img(it.Id, 'Backdrop', it.BackdropImageTags[0], 640)
                : (it.ParentBackdropItemId && it.ParentBackdropImageTags && it.ParentBackdropImageTags.length ? img(it.ParentBackdropItemId, 'Backdrop', it.ParentBackdropImageTags[0], 640) : '');
            m.logo = t.Logo ? img(it.Id, 'Logo', t.Logo, 400)
                : (it.ParentLogoItemId && it.ParentLogoImageTag ? img(it.ParentLogoItemId, 'Logo', it.ParentLogoImageTag, 400) : '');
            m.poster = ep ? (it.SeriesId && it.SeriesPrimaryImageTag ? img(it.SeriesId, 'Primary', it.SeriesPrimaryImageTag, 360) : '')
                : (t.Primary ? img(it.Id, 'Primary', t.Primary, 360) : '');
            m.still = ep && t.Primary ? img(it.Id, 'Primary', t.Primary, 640) : '';
        } else {
            m.thumb = it.ThumbTag ? img(it.Id, 'Thumb', it.ThumbTag, 640) : '';
            m.backdrop = it.BackdropTag ? img(it.Id, 'Backdrop', it.BackdropTag, 640) : '';
            m.logo = it.LogoTag ? img(it.Id, 'Logo', it.LogoTag, 400) : '';
            m.poster = it.PrimaryTag ? img(it.Id, 'Primary', it.PrimaryTag, 360) : '';
        }
        var ud = it.UserData || {};
        var pos = ud.PlaybackPositionTicks || it.PlayPositionTicks || 0;
        m.pos = pos;
        m.pct = pos && it.RunTimeTicks ? Math.max(3, Math.min(100, Math.round(pos / it.RunTimeTicks * 100))) : 0;
        m.sub = ep ? 'S' + (it.ParentIndexNumber || 0) + ':E' + (it.IndexNumber || 0) : '';
        state.items[it.Id] = it;
        return m;
    }

    function landHtml(m) {
        // Thumb art normally has the title baked in; a backdrop gets the logo on top, like Netflix
        var src = m.thumb || m.backdrop || m.still || m.poster;
        var overlay = !m.thumb && m.backdrop && m.logo ? '<img class="nfx-card__logo" alt="" loading="lazy" src="' + esc(m.logo) + '">' : '';
        var name = (!m.thumb && !(m.backdrop && m.logo)) ? '<span class="nfx-card__name">' + esc(m.name) + '</span>' : '';
        return '<div class="nfx-card__img' + (!m.thumb && !m.backdrop && m.poster ? ' is-poster' : '') + (overlay ? ' has-logo' : '') + '">' +
            (src ? '<img loading="lazy" decoding="async" alt="" src="' + esc(src) + '">' : '') + overlay + name + '</div>';
    }

    function posterHtml(m) {
        var src = m.poster || m.thumb || m.backdrop;
        return '<div class="nfx-card__img">' + (src ? '<img loading="lazy" decoding="async" alt="" src="' + esc(src) + '">' : '') +
            (m.poster ? '' : '<span class="nfx-card__name">' + esc(m.name) + '</span>') + '</div>';
    }

    function tiles(list, opts) {
        var ms = list.map(card);
        if (!opts.poster && !opts.resume) {
            var art = ms.filter(function (m) { return m.thumb || m.backdrop; });
            if (art.length >= 6) ms = art;
        }
        return ms.map(function (m) { return tileHtml(m, opts); }).join('');
    }

    function tileHtml(m, opts) {
        var poster = opts.poster;
        var cls = 'card nfx-card ' + (poster ? 'nfx-card--poster' : 'nfx-card--land') + (opts.resume ? ' nfx-card--resume' : '');
        return '<a class="' + cls + '" href="' + esc(detailsHash(m.linkId)) + '" data-id="' + esc(m.id) + '" data-type="' + esc(m.type) + '"' +
            (opts.resume ? ' data-nfx-action="play" data-pos="' + m.pos + '"' : '') +
            ' aria-label="' + esc(m.name + (m.sub ? ' ' + m.sub : '')) + '">' +
            (poster ? posterHtml(m) : landHtml(m)) +
            (opts.resume ? '<div class="nfx-card__progress"><i style="width:' + m.pct + '%"></i></div>' : '') +
            '</a>';
    }

    function top10Html(m, rank) {
        return '<a class="card nfx-card nfx-card--top10" href="' + esc(detailsHash(m.linkId)) + '" data-id="' + esc(m.id) + '" data-type="' + esc(m.type) + '"' +
            ' aria-label="' + esc('#' + rank + ' ' + m.name) + '">' +
            '<span class="nfx-rank" aria-hidden="true">' + rank + '</span>' +
            '<div class="nfx-card__img"><img loading="lazy" decoding="async" alt="" src="' + esc(m.poster || m.thumb || m.backdrop) + '"></div></a>';
    }

    function ownRowHtml(key, title, inner) {
        return '<section class="nfx-row" data-nfx-row="' + esc(key) + '">' +
            '<h2 class="nfx-row__title">' + esc(title) + '</h2>' +
            '<div class="nfx-row__wrap">' +
            '<button type="button" class="nfx-row__arrow nfx-row__arrow--prev" tabindex="-1" aria-label="Previous">' + icon('chevron_left') + '</button>' +
            '<div class="nfx-row__items itemsContainer focuscontainer-x">' + inner + '</div>' +
            '<button type="button" class="nfx-row__arrow nfx-row__arrow--next" tabindex="-1" aria-label="Next">' + icon('chevron_right') + '</button>' +
            '</div></section>';
    }

    function dedupe(list, key) {
        var seen = {};
        return list.filter(function (x) { var k = key(x); if (seen[k]) return false; seen[k] = true; return true; });
    }

    // Row specs, in Netflix order. Each returns a promise of { title, html } or null.
    function homeRows() {
        var cfg = state.cfg;
        var poster = isMobile() && !isTv();
        var name = (state.user && state.user.Name) || '';
        var lib = function (type) { var v = mainView(type); return v ? v.Id : undefined; };
        var rows = [];

        rows.push(['continue', function () {
            return Promise.all([
                getJSON('UserItems/Resume', withImg({ Limit: 20, MediaTypes: 'Video' })).catch(function () { return { Items: [] }; }),
                getJSON('Shows/NextUp', withImg({ Limit: 20, EnableResumable: false, EnableRewatching: false, DisableFirstEpisode: true })).catch(function () { return { Items: [] }; })
            ]).then(function (r) {
                var items = dedupe((r[0].Items || []).concat(r[1].Items || []), function (i) { return i.SeriesId || i.Id; })
                    .filter(function (i) { return i.Type === 'Movie' || i.Type === 'Episode'; });
                if (!items.length) return null;
                return { title: 'Continue Watching' + (name ? ' for ' + name : ''), html: items.map(function (i) { return tileHtml(card(i), { poster: poster, resume: true }); }).join('') };
            });
        }]);

        var top10 = function (type, title) {
            return function () {
                if (!cfg.EnableTop10) return Promise.resolve(null);
                return feed('top10-' + type, 'NetflixUi/Top10', { type: type }).then(function (list) {
                    if (!list || list.length < 3) return null;
                    return { title: title, cls: 'nfx-row--top10', html: list.map(function (it, i) { return top10Html(card(it), it.Rank || i + 1); }).join('') };
                });
            };
        };
        rows.push(['top10-series', top10('Series', 'Top 10 Shows Today')]);

        rows.push(['mylist', function () {
            return getJSON('Items', withImg({ Recursive: true, Filters: 'IsFavorite', IncludeItemTypes: 'Movie,Series', SortBy: 'DateLastContentAdded,DateCreated', SortOrder: 'Descending', Limit: 30 }))
                .then(function (r) {
                    var items = (r.Items || []);
                    if (!items.length) return null;
                    return { title: 'My List', html: tiles(items, { poster: poster }) };
                });
        }]);

        rows.push(['new', function () {
            var q = function (type, parent) {
                if (!parent) return Promise.resolve({ Items: [] });
                return getJSON('Items', withImg({ Recursive: true, ParentId: parent, IncludeItemTypes: type, SortBy: type === 'Series' ? 'DateLastContentAdded' : 'DateCreated', SortOrder: 'Descending', Limit: 15, HasPrimaryImage: true }))
                    .catch(function () { return { Items: [] }; });
            };
            return Promise.all([q('Movie', lib('movies')), q('Series', lib('tvshows'))]).then(function (r) {
                var a = r[0].Items || [], b = r[1].Items || [], out = [];
                for (var i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) out.push(a[i]); if (b[i]) out.push(b[i]); }
                if (!out.length) return null;
                return { title: 'New on ' + BRAND.charAt(0) + BRAND.slice(1).toLowerCase(), html: tiles(out, { poster: poster }) };
            });
        }]);

        rows.push(['top10-movie', top10('Movie', 'Top 10 Movies Today')]);

        rows.push(['genres', function () {
            if (!(cfg.GenreRowCount > 0)) return Promise.resolve(null);
            return feed('genres', 'NetflixUi/GenreRows', { count: cfg.GenreRowCount }).then(function (list) {
                if (!Array.isArray(list) || !list.length) return null;
                return {
                    multi: list.map(function (r) {
                        return { key: 'genre-' + r.Slug, title: r.Genre, html: tiles(r.Items, { poster: poster }) };
                    })
                };
            });
        }]);
        return rows;
    }

    function wireRow(sec) {
        var items = sec.querySelector('.nfx-row__items');
        var step = function (dir) {
            items.scrollBy({ left: dir * (items.clientWidth - 40), behavior: reducedMotion() ? 'auto' : 'smooth' });
        };
        sec.querySelector('.nfx-row__arrow--prev').addEventListener('click', function () { step(-1); });
        sec.querySelector('.nfx-row__arrow--next').addEventListener('click', function () { step(1); });
        var pagesEl = doc.createElement('ul');
        pagesEl.className = 'nfx-row__pages';
        pagesEl.setAttribute('aria-hidden', 'true');
        sec.insertBefore(pagesEl, sec.firstChild);
        var edges = function () {
            sec.classList.toggle('at-start', items.scrollLeft < 8);
            sec.classList.toggle('at-end', items.scrollLeft + items.clientWidth > items.scrollWidth - 8);
            var n = Math.ceil((items.scrollWidth - 8) / Math.max(1, items.clientWidth));
            var cur = sec.classList.contains('at-end') ? n - 1 : Math.round(items.scrollLeft / Math.max(1, items.clientWidth));
            var html = '';
            for (var i = 0; n > 1 && i < n; i++) html += '<li' + (i === cur ? ' class="is-on"' : '') + '></li>';
            if (pagesEl.innerHTML !== html) pagesEl.innerHTML = html;
        };
        items.addEventListener('scroll', edges, { passive: true });
        if (items.pause === undefined) { items.pause = function () { }; items.resume = function () { return Promise.resolve(); }; }
        setTimeout(edges, 0);
    }

    function renderMyList(home) {
        home.classList.add('nfx-list');
        home.innerHTML = '<h1 class="nfx-list__title">My List</h1><div class="nfx-list__grid"></div>';
        getJSON('Items', withImg({ Recursive: true, Filters: 'IsFavorite', IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 200 }))
            .then(safe('mylist', function (r) {
                var items = (r && r.Items) || [];
                var grid = home.querySelector('.nfx-list__grid');
                if (!items.length) {
                    grid.outerHTML = '<p class="nfx-list__empty">You haven\'t added any titles to your list yet.</p>';
                    return;
                }
                grid.innerHTML = items.map(function (i) { return tileHtml(card(i), { poster: isMobile() && !isTv() }); }).join('');
            }), function (e) { warn('mylist', e); });
    }

    function ensureHome(tab) {
        var home = tab.querySelector('#nfx-home');
        var listMode = /nfx=list/.test(location.hash);
        var mode = (isMobile() && !isTv() ? 'p' : 'l') + (/nfx=new/.test(location.hash) ? 'n' : '') + (listMode ? 'm' : '');
        if (home && home.getAttribute('data-mode') === mode && home.getAttribute('data-user') === userId()) return;
        if (home) home.remove();
        home = doc.createElement('div');
        home.id = 'nfx-home';
        home.setAttribute('data-mode', mode);
        home.setAttribute('data-user', userId());
        // after the (hidden) stock sections: the hero is inserted before those, so it stays on top
        var stock = tab.querySelector('.homeSectionsContainer');
        tab.insertBefore(home, stock ? stock.nextSibling : null);
        root.classList.add('nfx-own-home');

        if (listMode) { renderMyList(home); return; }
        var specs = homeRows();
        if (/nfx=new/.test(location.hash)) {
            // New & Popular: new first, then the Top 10s
            var order = ['new', 'top10-series', 'top10-movie'];
            specs = order.map(function (k) { return specs.filter(function (s) { return s[0] === k; })[0]; }).filter(Boolean);
        }
        // placeholders keep the order stable while feeds resolve at different speeds
        specs.forEach(function (s) {
            var slot = doc.createElement('div');
            slot.className = 'nfx-slot';
            slot.setAttribute('data-slot', s[0]);
            home.appendChild(slot);
            Promise.resolve().then(s[1]).then(safe('row ' + s[0], function (r) {
                if (!r || !slot.isConnected) { slot.remove(); return; }
                var list = r.multi || [{ key: s[0], title: r.title, html: r.html, cls: r.cls }];
                var w = doc.createElement('div');
                w.innerHTML = list.map(function (x) { return ownRowHtml(x.key, x.title, x.html); }).join('');
                var secs = Array.prototype.slice.call(w.children);
                secs.forEach(function (sec, i) {
                    if (list[i].cls) sec.classList.add(list[i].cls);
                    wireRow(sec);
                });
                secs.forEach(function (sec) { slot.parentNode.insertBefore(sec, slot); });
                slot.remove();
            }), function (e) { slot.remove(); warn('row ' + s[0], e); });
        });

        home.addEventListener('click', safe('homeClick', function (e) {
            var any = e.target.closest && e.target.closest('a.nfx-card');
            if (any && !any.hasAttribute('data-nfx-action') && useModal() && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                var it0 = state.items[any.getAttribute('data-id')] || {};
                openModal(it0.Type === 'Episode' && it0.SeriesId ? it0.SeriesId : any.getAttribute('data-id'));
                return;
            }
            var a = e.target.closest && e.target.closest('a.nfx-card[data-nfx-action="play"]');
            if (!a) return;
            e.preventDefault();
            var it = state.items[a.getAttribute('data-id')] || {};
            play(it.Id, it.Type, parseInt(a.getAttribute('data-pos'), 10) || 0, a.getAttribute('data-id'));
        }));
    }

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
                var dl = (state.items[id] && state.items[id].Type === 'Episode' && state.items[id].SeriesId) || id;
                if (useModal()) openModal(dl); else goDetails(dl);
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
        p.querySelector('.nfx-preview__meta').innerHTML = metaHtml(it) + '<span class="nfx-hd">HD</span>';
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

    function onMove(e) {
        state.lastMove = Date.now();
        var p = state.preview;
        if (p.armed || !state.cfg || !state.cfg.EnableHoverPreview) return;
        var card = e.target && e.target.closest ? e.target.closest('.card[data-id]') : null;
        if (card && card !== p.card) onOver(e);
    }

    function closePreview() {
        clearTimeout(state.preview.timer);
        state.preview.armed = null;
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
        if (!card.closest('.homeSectionsContainer, #homeTab, #nfx-home')) return null;
        // library tiles (My Media) and folders: Play would queue a whole library
        if (/^(CollectionFolder|UserView|Folder|Channel|Playlist)$/.test(card.getAttribute('data-type') || '')) return null;
        if (card.closest('.section0')) return null;
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

    // card position ignoring its own hover transform (scale), so only real layout shifts count
    function layoutPos(card) {
        var r = (card.parentNode || card).getBoundingClientRect();
        return { x: r.left + card.offsetLeft, y: r.top + card.offsetTop };
    }

    function onOver(e) {
        if (isTv() || !finePointer()) return;
        var card = homeCardFrom(e.target);
        if (!card) return;
        markEdges(card);
        if (!state.cfg || !state.cfg.EnableHoverPreview) return;
        if (state.preview.card === card || state.preview.armed === card) return;
        clearTimeout(state.preview.timer);
        state.preview.armed = null;
        // content rendering under a still cursor fires mouseover too; only a moving mouse
        // counts (onMove arms it on the next real move if this one was stale)
        if (Date.now() - state.lastMove > 500) return;
        state.preview.armed = card;
        var r0 = layoutPos(card);
        state.preview.timer = setTimeout(safe('preview', function () {
            state.preview.armed = null;
            var r1 = layoutPos(card);
            if (Math.abs(r1.x - r0.x) > 4 || Math.abs(r1.y - r0.y) > 4) return; // layout shifted
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
        state.preview.armed = null;
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

    // ------------------------------------------------------------------ detail backdrop
    // Stock only paints #itemBackdrop on desktop >= 1000px wide, never in TV layout.

    function ensureDetailBackdrop() {
        var page = doc.querySelector('#itemDetailPage:not(.hide)');
        var bd = page && page.querySelector('#itemBackdrop');
        if (!bd) return;
        var m = /[?&]id=([0-9a-f-]{32,36})/i.exec(location.hash || location.search);
        var id = m && m[1];
        if (!id) return;
        var mine = bd.getAttribute('data-nfx-bd');
        if (mine === id) return;
        if (!mine && bd.style.backgroundImage) return;              // stock painted it
        if (doc.querySelector('.backdropContainer .backdropImage')) return; // full-screen backdrop is on
        if (mine) { bd.style.backgroundImage = ''; bd.classList.remove('nfx-detail-backdrop'); }
        bd.setAttribute('data-nfx-bd', id);
        var c = api();
        if (!c || !c.getItem) return;
        c.getItem(userId(), id).then(safe('detailBackdrop', function (it) {
            if (bd.getAttribute('data-nfx-bd') !== id || !it) return;
            var src = '';
            if (it.BackdropImageTags && it.BackdropImageTags.length) src = img(it.Id, 'Backdrop', it.BackdropImageTags[0], 1920);
            else if (it.ParentBackdropItemId && it.ParentBackdropImageTags && it.ParentBackdropImageTags.length) {
                src = img(it.ParentBackdropItemId, 'Backdrop', it.ParentBackdropImageTags[0], 1920);
            } else if (it.SeriesId) src = img(it.SeriesId, 'Backdrop', null, 1920);
            if (!src || bd.style.backgroundImage) return;
            bd.style.backgroundImage = 'url("' + src + '")';
            bd.classList.add('nfx-detail-backdrop');
        }), function (e) { warn('detail backdrop', e); });
    }

    function osdOpen() {
        var o = doc.getElementById('videoOsdPage');
        return !!(o && !o.classList.contains('hide'));
    }

    // ------------------------------------------------------------------ scan

    function activeHomeTab() {
        var page = doc.querySelector('#indexPage:not(.hide)');
        if (!page) return null;
        var tab = page.querySelector('#homeTab');
        if (!tab) return null;
        return tab;
    }

    function setRootClass(c, on) {
        if (root.classList.contains(c) !== !!on) root.classList.toggle(c, !!on);
    }

    // Page-state flags on <html>. The CSS keys off these instead of html:has(#page:not(.hide)),
    // which Chrome re-evaluates on every DOM change anywhere in the document.
    function pageFlags() {
        var on = function (sel) { return !!doc.querySelector(sel); };
        setRootClass('nfx-pg-osd', on('#videoOsdPage:not(.hide)'));
        setRootClass('nfx-pg-detail', on('#itemDetailPage:not(.hide)'));
        setRootClass('nfx-pg-search', on('#searchPage:not(.hide)'));
        setRootClass('nfx-pg-login', on('#loginPage:not(.hide)'));
        setRootClass('nfx-pg-solid', on('.page:not(.hide):is(#searchPage, .type-interior, #myPreferencesMenuPage, #displayPreferencesPage, .libraryPage:not(.homePage):not(.itemDetailPage))'));
        setRootClass('nfx-dash', !!(doc.body && doc.body.classList.contains('dashboardDocument')));
        setRootClass('nfx-stock-backdrop', on('.backdropContainer .backdropImage'));
    }

    function scan() {
        state.scanQueued = false;
        pageFlags();
        setRootClass('nfx-modern', !!doc.querySelector('.MuiAppBar-root'));
        setRootClass('nfx-legacy', !doc.querySelector('.MuiAppBar-root'));
        if (onDashboard()) { closePreview(); root.classList.remove('nfx-own-chrome', 'nfx-own-home'); return; }
        if (/#\/login/.test(location.hash)) { ssSet(GATE_KEY, '1'); root.classList.remove('nfx-gate-pending'); }
        if (!api() || !userId()) return;
        setRootClass('nfx-own-chrome', true);
        loadUser();
        loadConfig().then(function () { return loadViews().catch(function () { return []; }); }).then(safe('header', ensureHeader));
        ensureDetailBackdrop();
        tagSearch();
        hideCollections();
        var tab = activeHomeTab();
        if (!tab) { root.classList.remove('nfx-on-home', 'nfx-own-home'); return; }
        var container = tab.querySelector('.homeSectionsContainer');
        if (!container) return;
        root.classList.add('nfx-on-home');
        bridge();
        loadConfig().then(function () { return loadViews().catch(function () { return []; }); }).then(safe('home', function () {
            ensureHeader();
            ensureHero(tab, container);
            ensureHome(tab);
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
        // hide the app until the profile gate decides, so home never flashes first
        if (!ssGet(GATE_KEY) && !/#\/login/.test(location.hash)) {
            root.classList.add('nfx-gate-pending');
            setTimeout(function () { root.classList.remove('nfx-gate-pending'); }, 4000); // never strand a black screen
        }
        var OWN = '#nfx-header, #nfx-home, #nfx-hero, .nfx-preview, #nfx-modal, #nfx-gate, #nfx-bridge';
        new MutationObserver(function (muts) {
            if (state.scanQueued || osdOpen()) return; // the OSD clock mutates constantly
            for (var i = 0; i < muts.length; i++) {
                var t = muts[i].target;
                if (!muts[i].addedNodes.length) continue;
                // our own rendering must never trigger a rescan (that was a 16/s idle loop)
                if (t.nodeType === 1 && t.closest && t.closest(OWN)) continue;
                var a = muts[i].addedNodes[0];
                if (a && a.nodeType === 1 && a.matches && a.matches(OWN)) continue;
                queueScan();
                return;
            }
        }).observe(doc.body, { childList: true, subtree: true });
        doc.addEventListener('viewshow', safe('viewshow', onNavigate), true);
        window.addEventListener('hashchange', safe('hashchange', onNavigate));
        window.addEventListener('popstate', safe('popstate', onNavigate));
        window.addEventListener('scroll', safe('scroll', onScroll), { passive: true });
        doc.addEventListener('mousemove', safe('move', onMove), { passive: true });
        doc.addEventListener('mouseover', safe('over', onOver), { passive: true });
        doc.addEventListener('mouseout', safe('out', onOut), { passive: true });
        window.addEventListener('resize', safe('resize', closePreview), { passive: true });
        doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && doc.getElementById('nfx-modal')) { e.stopPropagation(); closeModal(); } }, true);
        window.addEventListener('hashchange', function () { if (doc.getElementById('nfx-modal')) closeModal(); });
        queueScan();
    }

    try {
        if (doc.body) init();
        else doc.addEventListener('DOMContentLoaded', safe('init', init));
    } catch (e) {
        warn('init', e);
    }
})();
