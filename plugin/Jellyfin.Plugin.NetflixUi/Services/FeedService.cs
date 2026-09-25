using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.TV;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.NetflixUi.Services;

/// <summary>
/// Builds the hero, Top 10 and genre row feeds. Every query goes through
/// InternalItemsQuery(user) so library access and parental limits apply.
/// </summary>
public class FeedService
{
    private static readonly TimeSpan Top10CacheTime = TimeSpan.FromHours(1);
    private static readonly TimeSpan FeedCacheTime = TimeSpan.FromMinutes(10);
    private static readonly string[] MainProviders = { "Tmdb", "Imdb", "Tvdb" };

    private readonly ILibraryManager _libraryManager;
    private readonly IUserManager _userManager;
    private readonly IUserDataManager _userDataManager;
    private readonly IImageProcessor _imageProcessor;
    private readonly ITVSeriesManager _tvSeriesManager;
    private readonly ILogger<FeedService> _logger;

    private readonly object _top10Lock = new object();
    private readonly Dictionary<BaseItemKind, (DateTime Built, List<Guid> Ids)> _top10Cache = new();

    // one running build per kind; concurrent callers share it instead of starting their own
    private readonly Dictionary<BaseItemKind, Task<List<Guid>>> _top10Builds = new();

    // per user feed cache: (user|feed|args|day) -> (built, value)
    private readonly ConcurrentDictionary<string, (DateTime Built, object Value)> _feedCache = new();

    private (DateTime Built, string[] Paths)? _excludedPathCache;

    public FeedService(
        ILibraryManager libraryManager,
        IUserManager userManager,
        IUserDataManager userDataManager,
        IImageProcessor imageProcessor,
        ITVSeriesManager tvSeriesManager,
        ILogger<FeedService> logger)
    {
        _tvSeriesManager = tvSeriesManager;
        _libraryManager = libraryManager;
        _userManager = userManager;
        _userDataManager = userDataManager;
        _imageProcessor = imageProcessor;
        _logger = logger;
    }

    public User? GetUser(Guid userId) => userId == Guid.Empty ? null : _userManager.GetUserById(userId);

    // ---------------------------------------------------------------- hero

    public List<NfxItem> GetHero(User user, int limit)
    {
        limit = Math.Clamp(limit, 1, 12);
        return Cached(user, "hero", limit.ToString(CultureInfo.InvariantCulture), () => BuildHero(user, limit));
    }

    private List<NfxItem> BuildHero(User user, int limit)
    {
        var result = new List<NfxItem>();
        var seen = new HashSet<Guid>();

        void Consider(BaseItem item, Guid? resumeId)
        {
            if (result.Count >= limit)
            {
                return;
            }

            var display = item is Episode ep && ep.Series is not null ? ep.Series : item;
            if (!seen.Add(display.Id))
            {
                return;
            }

            if (!display.HasImage(ImageType.Backdrop, 0) || !display.HasImage(ImageType.Logo, 0) || !HasMainProviderId(display))
            {
                return;
            }

            var dto = ToNfx(display, user);
            dto.ResumeItemId = resumeId;
            SetPlayTarget(dto, display, resumeId.HasValue ? item : null, user);
            result.Add(dto);
        }

        // 1. continue watching (at most 2 so the hero is not all old stuff)
        var resumable = Query(user, new[] { BaseItemKind.Movie, BaseItemKind.Episode }, q =>
        {
            q.IsResumable = true;
            q.OrderBy = new[] { (ItemSortBy.DatePlayed, SortOrder.Descending) };
            q.Limit = 20;
        });
        int resumeTaken = 0;
        foreach (var item in resumable)
        {
            if (resumeTaken >= 2)
            {
                break;
            }

            int before = result.Count;
            Consider(item, item.Id);
            if (result.Count > before)
            {
                resumeTaken++;
            }
        }

        // 2. added in the last 30 days
        var recent = Query(user, new[] { BaseItemKind.Movie, BaseItemKind.Series }, q =>
        {
            q.MinDateCreated = DateTime.UtcNow.AddDays(-30);
            q.OrderBy = new[] { (ItemSortBy.DateCreated, SortOrder.Descending) };
            q.Limit = 40;
        });
        foreach (var item in DailyShuffle(recent, user.Id, "hero-recent").Take(limit * 3))
        {
            Consider(item, null);
        }

        // 3. highly rated and not watched yet
        var rated = Query(user, new[] { BaseItemKind.Movie, BaseItemKind.Series }, q =>
        {
            q.MinCommunityRating = 7.0;
            q.IsPlayed = false;
            q.OrderBy = new[] { (ItemSortBy.CommunityRating, SortOrder.Descending) };
            q.Limit = 80;
        });
        foreach (var item in DailyShuffle(rated, user.Id, "hero-rated"))
        {
            Consider(item, null);
        }

        return result;
    }

    // ---------------------------------------------------------------- top 10

    public List<NfxItem> GetTop10(User user, BaseItemKind kind)
    {
        var ids = GetTop10Ids(kind);
        var list = new List<NfxItem>();
        if (ids is null)
        {
            // cold cache: the build runs in the background, the client hides a short row
            return list;
        }

        foreach (var id in ids)
        {
            if (list.Count >= 10)
            {
                break;
            }

            var item = _libraryManager.GetItemById(id);
            if (item is null || !item.HasImage(ImageType.Primary, 0) || !HasMainProviderId(item) || IsExcluded(item) || !item.IsVisibleStandalone(user))
            {
                continue;
            }

            var dto = ToNfx(item, user);
            dto.Rank = list.Count + 1;
            list.Add(dto);
        }

        // user could not see enough of the server-wide list; top up from their own libraries
        if (list.Count < 10)
        {
            var have = new HashSet<Guid>(list.Select(x => x.Id));
            var fill = Query(user, new[] { kind }, q =>
            {
                q.MinCommunityRating = 6.5;
                q.OrderBy = new[] { (ItemSortBy.CommunityRating, SortOrder.Descending) };
                q.Limit = 60;
            });
            foreach (var item in DailyShuffle(fill, Guid.Empty, "top10-fill-" + kind))
            {
                if (list.Count >= 10)
                {
                    break;
                }

                if (item.HasImage(ImageType.Primary, 0) && HasMainProviderId(item) && have.Add(item.Id))
                {
                    var dto = ToNfx(item, user);
                    dto.Rank = list.Count + 1;
                    list.Add(dto);
                }
            }
        }

        return list;
    }

    /// <summary>
    /// Serve the cached list; when it is older than an hour, rebuild in the background
    /// (stale while revalidate). Returns null while the very first build is still running,
    /// so no request ever waits 10 to 20 s on it. Only one build per kind runs at a time.
    /// </summary>
    private List<Guid>? GetTop10Ids(BaseItemKind kind)
    {
        lock (_top10Lock)
        {
            bool have = _top10Cache.TryGetValue(kind, out var cached);
            if (!have || DateTime.UtcNow - cached.Built >= Top10CacheTime)
            {
                StartTop10Build(kind);
            }

            return have ? cached.Ids : null;
        }
    }

    /// <summary>
    /// Build both Top 10 lists ahead of the first request.
    /// </summary>
    public void WarmTop10()
    {
        Task<List<Guid>> m, t;
        lock (_top10Lock)
        {
            // a request may already have built them (cold path); only build what is missing
            m = _top10Cache.ContainsKey(BaseItemKind.Movie) ? Task.FromResult(new List<Guid>()) : StartTop10Build(BaseItemKind.Movie);
            t = _top10Cache.ContainsKey(BaseItemKind.Series) ? Task.FromResult(new List<Guid>()) : StartTop10Build(BaseItemKind.Series);
        }

        Task.WaitAll(m, t);
    }

    // caller holds _top10Lock
    private Task<List<Guid>> StartTop10Build(BaseItemKind kind)
    {
        if (_top10Builds.TryGetValue(kind, out var running))
        {
            return running;
        }

        var task = Task.Run(() => RebuildTop10(kind));
        _top10Builds[kind] = task;
        return task;
    }

    private List<Guid> RebuildTop10(BaseItemKind kind)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var ids = BuildTop10(kind);
            lock (_top10Lock)
            {
                _top10Cache[kind] = (DateTime.UtcNow, ids);
            }

            _logger.LogInformation("NetflixUi: Top 10 {Kind} built in {Ms} ms ({Count} candidates)", kind, sw.ElapsedMilliseconds, ids.Count);
            return ids;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "NetflixUi: Top 10 build failed for {Kind}", kind);
            return new List<Guid>();
        }
        finally
        {
            lock (_top10Lock)
            {
                _top10Builds.Remove(kind);
            }
        }
    }

    /// <summary>
    /// Server-wide popularity: one point per (user, item) played in the last 30 days,
    /// episodes roll up to their series. Falls back to all-time play counts.
    /// </summary>
    private List<Guid> BuildTop10(BaseItemKind kind)
    {
        var cutoff = DateTime.UtcNow.AddDays(-30);
        var recentScore = new Dictionary<Guid, double>();
        var allTimeScore = new Dictionary<Guid, double>();
        var sourceKind = kind == BaseItemKind.Series ? BaseItemKind.Episode : kind;

        try
        {
            foreach (var u in _userManager.GetUsers())
            {
                // finished items plus in-progress ones; both filters are indexed joins on UserData
                var played = new List<BaseItem>(Query(u, new[] { sourceKind }, q =>
                {
                    q.IsPlayed = true;
                    q.OrderBy = new[] { (ItemSortBy.DatePlayed, SortOrder.Descending) };
                    q.Limit = 200;
                }));
                played.AddRange(Query(u, new[] { sourceKind }, q =>
                {
                    q.IsResumable = true;
                    q.Limit = 50;
                }));
                if (played.Count == 0)
                {
                    continue;
                }

                var batch = _userDataManager.GetUserDataBatch(played, u);
                var counted = new HashSet<Guid>();
                foreach (var item in played)
                {
                    if (!counted.Add(item.Id) || !batch.TryGetValue(item.Id, out var data))
                    {
                        continue;
                    }

                    if (data is null || (data.PlayCount <= 0 && data.PlaybackPositionTicks <= 0))
                    {
                        continue;
                    }

                    Guid key = item is Episode ep ? ep.SeriesId : item.Id;
                    if (key == Guid.Empty)
                    {
                        continue;
                    }

                    allTimeScore[key] = allTimeScore.GetValueOrDefault(key) + Math.Max(1, data.PlayCount);
                    if (data.LastPlayedDate.HasValue && data.LastPlayedDate.Value >= cutoff)
                    {
                        recentScore[key] = recentScore.GetValueOrDefault(key) + 1;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "NetflixUi: Top 10 scoring failed for {Kind}", kind);
        }

        var ordered = recentScore
            .OrderByDescending(kv => kv.Value)
            .ThenByDescending(kv => allTimeScore.GetValueOrDefault(kv.Key))
            .Select(kv => kv.Key)
            .ToList();

        foreach (var kv in allTimeScore.OrderByDescending(kv => kv.Value))
        {
            if (ordered.Count >= 30)
            {
                break;
            }

            if (!ordered.Contains(kv.Key))
            {
                ordered.Add(kv.Key);
            }
        }

        // keep a few spares so per-user access filtering still leaves 10
        return ordered.Take(30).ToList();
    }

    // ---------------------------------------------------------------- genres

    public List<NfxGenreRow> GetGenreRows(User user, int count)
    {
        count = Math.Clamp(count, 0, 10);
        return Cached(user, "genres", count.ToString(CultureInfo.InvariantCulture), () => BuildGenreRows(user, count));
    }

    private List<NfxGenreRow> BuildGenreRows(User user, int count)
    {
        var rows = new List<NfxGenreRow>();
        if (count == 0)
        {
            return rows;
        }

        var weights = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        var played = Query(user, new[] { BaseItemKind.Movie, BaseItemKind.Episode }, q =>
        {
            q.IsPlayed = true;
            q.OrderBy = new[] { (ItemSortBy.DatePlayed, SortOrder.Descending) };
            q.Limit = 300;
        });

        var seenSeries = new HashSet<Guid>();
        foreach (var item in played)
        {
            string[] genres = item.Genres ?? Array.Empty<string>();
            if (item is Episode ep)
            {
                // count a series once, not per episode
                if (!seenSeries.Add(ep.SeriesId))
                {
                    continue;
                }

                genres = ep.Series?.Genres ?? genres;
            }

            foreach (var g in genres)
            {
                weights[g] = weights.GetValueOrDefault(g) + 1;
            }
        }

        // no history (new user): use the most common genres in their libraries
        if (weights.Count < count)
        {
            var sample = Query(user, new[] { BaseItemKind.Movie, BaseItemKind.Series }, q =>
            {
                q.OrderBy = new[] { (ItemSortBy.Random, SortOrder.Ascending) };
                q.Limit = 400;
            });
            foreach (var item in sample)
            {
                foreach (var g in item.Genres ?? Array.Empty<string>())
                {
                    weights[g] = weights.GetValueOrDefault(g) + 0.01;
                }
            }
        }

        var topGenres = weights.OrderByDescending(kv => kv.Value).Select(kv => kv.Key).Take(count * 2).ToList();
        foreach (var genre in topGenres)
        {
            if (rows.Count >= count)
            {
                break;
            }

            // unplayed first (filtered in the query, not per item), then played to top up.
            // A per-day shuffle so rows change daily but not on every refresh.
            var unplayed = Query(user, new[] { BaseItemKind.Movie, BaseItemKind.Series }, q =>
            {
                q.Genres = new[] { genre };
                q.IsPlayed = false;
                q.OrderBy = new[] { (ItemSortBy.CommunityRating, SortOrder.Descending) };
                q.Limit = 80;
            });
            var chosen = DailyShuffle(unplayed.Where(HasMainProviderId), user.Id, "genre-" + genre).Take(20).ToList();
            if (chosen.Count < 20)
            {
                var seen = Query(user, new[] { BaseItemKind.Movie, BaseItemKind.Series }, q =>
                {
                    q.Genres = new[] { genre };
                    q.IsPlayed = true;
                    q.OrderBy = new[] { (ItemSortBy.CommunityRating, SortOrder.Descending) };
                    q.Limit = 40;
                });
                chosen.AddRange(DailyShuffle(seen.Where(HasMainProviderId), user.Id, "genre-p-" + genre).Take(20 - chosen.Count));
            }

            // no Overview here: the hover preview fetches the full item when it opens
            var picked = chosen.Select(i => ToNfx(i, user, light: true)).ToList();

            if (picked.Count < 5)
            {
                continue;
            }

            rows.Add(new NfxGenreRow { Genre = genre, Slug = Slug(genre), Items = picked });
        }

        return rows;
    }

    // ---------------------------------------------------------------- helpers

    /// <summary>
    /// Netflix style Play: resume what was being watched, else the next unwatched episode, else the item.
    /// </summary>
    private void SetPlayTarget(NfxItem dto, BaseItem display, BaseItem? resumeItem, User user)
    {
        BaseItem? target = resumeItem;
        if (target is null && display.GetBaseItemKind() == BaseItemKind.Series)
        {
            // the server's own Next Up logic (resume point, else next unwatched episode)
            try
            {
                var next = _tvSeriesManager.GetNextUp(
                    new NextUpQuery { User = user, SeriesId = display.Id, Limit = 1 },
                    new DtoOptions(false));
                target = next.Items.FirstOrDefault();
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "NetflixUi: next up failed for {Id}", display.Id);
            }

            // never watched: first regular episode (skip specials)
            target ??= Query(user, new[] { BaseItemKind.Episode }, q =>
            {
                q.AncestorIds = new[] { display.Id };
                q.OrderBy = new[] { (ItemSortBy.ParentIndexNumber, SortOrder.Ascending), (ItemSortBy.IndexNumber, SortOrder.Ascending) };
                q.Limit = 30;
            }).OrderBy(e => e.ParentIndexNumber == 0 ? 1 : 0).FirstOrDefault();
        }

        target ??= display;
        dto.PlayItemId = target.Id;
        dto.PlayItemType = target.GetBaseItemKind().ToString();
        var data = _userDataManager.GetUserData(user, target);
        dto.PlayPositionTicks = data is not null && !data.Played ? data.PlaybackPositionTicks : 0;
    }

    private T Cached<T>(User user, string feed, string args, Func<T> build)
        where T : class
    {
        string key = user.Id.ToString("N") + "|" + feed + "|" + args + "|" + DateTime.UtcNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (_feedCache.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.Built < FeedCacheTime && hit.Value is T value)
        {
            return value;
        }

        var fresh = build();
        _feedCache[key] = (DateTime.UtcNow, fresh);

        // drop stale entries now and then so the dictionary cannot grow forever
        if (_feedCache.Count > 500)
        {
            foreach (var kv in _feedCache)
            {
                if (DateTime.UtcNow - kv.Value.Built >= FeedCacheTime)
                {
                    _feedCache.TryRemove(kv.Key, out _);
                }
            }
        }

        return fresh;
    }

    /// <summary>
    /// Real titles have a TMDb, IMDb or TVDb id. Demo clips, home videos and test files do not.
    /// </summary>
    private static bool HasMainProviderId(BaseItem item)
    {
        var ids = item.ProviderIds;
        if (ids is null)
        {
            return false;
        }

        foreach (var p in MainProviders)
        {
            if (ids.TryGetValue(p, out var v) && !string.IsNullOrWhiteSpace(v))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Folder paths of the libraries excluded in the plugin settings, cached for a minute.
    /// Matching by path works for every item type; TopParentId in the DB is not the library id.
    /// </summary>
    private string[] ExcludedPaths()
    {
        var ids = Plugin.Instance?.Configuration.ExcludedLibraryIds;
        if (ids is null || ids.Length == 0)
        {
            return Array.Empty<string>();
        }

        var cache = _excludedPathCache;
        if (cache.HasValue && DateTime.UtcNow - cache.Value.Built < TimeSpan.FromMinutes(1))
        {
            return cache.Value.Paths;
        }

        var excluded = new HashSet<Guid>(ids);
        var paths = new List<string>();
        foreach (var vf in _libraryManager.GetVirtualFolders())
        {
            if (Guid.TryParse(vf.ItemId, out var g) && excluded.Contains(g) && vf.Locations is not null)
            {
                paths.AddRange(vf.Locations.Where(l => !string.IsNullOrEmpty(l)).Select(l => l.TrimEnd('/') + "/"));
            }
        }

        var arr = paths.ToArray();
        _excludedPathCache = (DateTime.UtcNow, arr);
        return arr;
    }

    private bool IsExcluded(BaseItem item)
    {
        var paths = ExcludedPaths();
        if (paths.Length == 0 || string.IsNullOrEmpty(item.Path))
        {
            return false;
        }

        foreach (var p in paths)
        {
            if (item.Path.StartsWith(p, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private IReadOnlyList<BaseItem> Query(User user, BaseItemKind[] kinds, Action<InternalItemsQuery> configure)
    {
        var q = new InternalItemsQuery(user)
        {
            IncludeItemTypes = kinds,
            Recursive = true,
            IsVirtualItem = false,
            EnableTotalRecordCount = false,
        };
        configure(q);
        try
        {
            var list = _libraryManager.GetItemList(q);
            return ExcludedPaths().Length == 0 ? list : list.Where(i => !IsExcluded(i)).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "NetflixUi: item query failed");
            return Array.Empty<BaseItem>();
        }
    }

    private static IEnumerable<BaseItem> DailyShuffle(IEnumerable<BaseItem> items, Guid userId, string salt)
    {
        string day = DateTime.UtcNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        int seed = StableHash(day + userId.ToString("N") + salt);
        return items.OrderBy(i => StableHash(seed.ToString(CultureInfo.InvariantCulture) + i.Id.ToString("N")));
    }

    private static int StableHash(string s)
    {
        unchecked
        {
            int h = (int)2166136261;
            foreach (char c in s)
            {
                h = (h ^ c) * 16777619;
            }

            return h;
        }
    }

    public static string Slug(string s)
    {
        var sb = new StringBuilder();
        foreach (char c in s.ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(c))
            {
                sb.Append(c);
            }
            else if (sb.Length > 0 && sb[^1] != '-')
            {
                sb.Append('-');
            }
        }

        return sb.ToString().Trim('-');
    }

    private string? Tag(BaseItem item, ImageType type)
    {
        try
        {
            var info = item.GetImageInfo(type, 0);
            return info is null ? null : _imageProcessor.GetImageCacheTag(item, info);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private NfxItem ToNfx(BaseItem item, User user, bool light = false)
    {
        var data = _userDataManager.GetUserData(user, item);
        var dto = new NfxItem
        {
            Id = item.Id,
            Name = item.Name ?? string.Empty,
            Type = item.GetBaseItemKind().ToString(),
            Overview = light ? null : item.Overview,
            OfficialRating = item.OfficialRating,
            ProductionYear = item.ProductionYear,
            RunTimeTicks = item.RunTimeTicks,
            CommunityRating = item.CommunityRating,
            Genres = (item.Genres ?? Array.Empty<string>()).Take(3).ToArray(),
            BackdropTag = Tag(item, ImageType.Backdrop),
            LogoTag = Tag(item, ImageType.Logo),
            PrimaryTag = Tag(item, ImageType.Primary),
            ThumbTag = Tag(item, ImageType.Thumb),
            TrailerUrl = item.RemoteTrailers?.FirstOrDefault()?.Url,
            UserData = new NfxUserData
            {
                Played = data?.Played ?? false,
                IsFavorite = data?.IsFavorite ?? false,
                PlaybackPositionTicks = data?.PlaybackPositionTicks ?? 0,
            },
        };

        if (item is Episode ep && ep.SeriesId != Guid.Empty)
        {
            dto.SeriesId = ep.SeriesId;
        }

        if (light)
        {
            return dto;
        }

        try
        {
            var trailer = item.GetExtras(new[] { ExtraType.Trailer }).FirstOrDefault();
            if (trailer is not null)
            {
                dto.LocalTrailerId = trailer.Id;
            }
        }
        catch (Exception)
        {
            // extras lookup is best effort
        }

        return dto;
    }
}
