using System.Globalization;
using System.Text;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
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

    private readonly ILibraryManager _libraryManager;
    private readonly IUserManager _userManager;
    private readonly IUserDataManager _userDataManager;
    private readonly IImageProcessor _imageProcessor;
    private readonly ILogger<FeedService> _logger;

    private readonly object _top10Lock = new object();
    private readonly Dictionary<BaseItemKind, (DateTime Built, List<Guid> Ids)> _top10Cache = new();
    private readonly HashSet<BaseItemKind> _top10Building = new();

    public FeedService(
        ILibraryManager libraryManager,
        IUserManager userManager,
        IUserDataManager userDataManager,
        IImageProcessor imageProcessor,
        ILogger<FeedService> logger)
    {
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

            if (!display.HasImage(ImageType.Backdrop, 0) || !display.HasImage(ImageType.Logo, 0))
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
        foreach (var id in ids)
        {
            if (list.Count >= 10)
            {
                break;
            }

            var item = _libraryManager.GetItemById(id);
            if (item is null || !item.HasImage(ImageType.Primary, 0) || !item.IsVisibleStandalone(user))
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

                if (item.HasImage(ImageType.Primary, 0) && have.Add(item.Id))
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
    /// (stale while revalidate) so a request only ever waits on the very first build.
    /// </summary>
    private List<Guid> GetTop10Ids(BaseItemKind kind)
    {
        lock (_top10Lock)
        {
            if (_top10Cache.TryGetValue(kind, out var cached))
            {
                if (DateTime.UtcNow - cached.Built >= Top10CacheTime && _top10Building.Add(kind))
                {
                    _ = Task.Run(() => RebuildTop10(kind));
                }

                return cached.Ids;
            }
        }

        return RebuildTop10(kind);
    }

    /// <summary>
    /// Build both Top 10 lists ahead of the first request.
    /// </summary>
    public void WarmTop10()
    {
        RebuildTop10(BaseItemKind.Movie);
        RebuildTop10(BaseItemKind.Series);
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
        finally
        {
            lock (_top10Lock)
            {
                _top10Building.Remove(kind);
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

            var items = Query(user, new[] { BaseItemKind.Movie, BaseItemKind.Series }, q =>
            {
                q.Genres = new[] { genre };
                q.OrderBy = new[] { (ItemSortBy.CommunityRating, SortOrder.Descending) };
                q.Limit = 80;
            });

            // unplayed first, then a per-day shuffle so rows change daily but not on every refresh
            var picked = DailyShuffle(items, user.Id, "genre-" + genre)
                .Select(i => (Item: i, Played: _userDataManager.GetUserData(user, i)?.Played ?? false))
                .OrderBy(x => x.Played)
                .Take(20)
                .Select(x => ToNfx(x.Item, user))
                .ToList();

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
            var episodes = Query(user, new[] { BaseItemKind.Episode }, q =>
            {
                q.AncestorIds = new[] { display.Id };
                q.OrderBy = new[] { (ItemSortBy.ParentIndexNumber, SortOrder.Ascending), (ItemSortBy.IndexNumber, SortOrder.Ascending) };
                q.Limit = 2000;
            });

            BaseItem? firstUnplayed = null;
            foreach (var ep in episodes)
            {
                if (ep.ParentIndexNumber == 0)
                {
                    continue; // skip specials
                }

                var d = _userDataManager.GetUserData(user, ep);
                if (d is not null && !d.Played && d.PlaybackPositionTicks > 0)
                {
                    target = ep;
                    break;
                }

                if (firstUnplayed is null && (d is null || !d.Played))
                {
                    firstUnplayed = ep;
                }
            }

            target ??= firstUnplayed ?? episodes.FirstOrDefault();
        }

        target ??= display;
        dto.PlayItemId = target.Id;
        dto.PlayItemType = target.GetBaseItemKind().ToString();
        var data = _userDataManager.GetUserData(user, target);
        dto.PlayPositionTicks = data is not null && !data.Played ? data.PlaybackPositionTicks : 0;
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
            return _libraryManager.GetItemList(q);
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

    private NfxItem ToNfx(BaseItem item, User user)
    {
        var data = _userDataManager.GetUserData(user, item);
        var dto = new NfxItem
        {
            Id = item.Id,
            Name = item.Name ?? string.Empty,
            Type = item.GetBaseItemKind().ToString(),
            Overview = item.Overview,
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
