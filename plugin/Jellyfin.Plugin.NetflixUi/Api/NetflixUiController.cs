using System.Net.Mime;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.NetflixUi.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.NetflixUi.Api;

/// <summary>
/// Static assets (anonymous) and per-user feeds (authenticated).
/// </summary>
[ApiController]
[Route("NetflixUi")]
public class NetflixUiController : ControllerBase
{
    private const string UserIdClaim = "Jellyfin-UserId";

    private readonly FeedService _feeds;
    private readonly ILogger<NetflixUiController> _logger;

    public NetflixUiController(FeedService feeds, ILogger<NetflixUiController> logger)
    {
        _feeds = feeds;
        _logger = logger;
    }

    /// <summary>
    /// Client performance samples (long frames, slow input, slow requests), only sent when
    /// PerfBeacon is on. Written to the server log so real-device lag can be diagnosed remotely.
    /// </summary>
    [HttpPost("Perf")]
    [Authorize]
    [Consumes("text/plain", "application/json")]
    public async Task<ActionResult> PostPerf()
    {
        if (!(Plugin.Instance?.Configuration.PerfBeacon ?? false))
        {
            return NoContent();
        }

        using var reader = new StreamReader(Request.Body);
        var buf = new char[16384];
        var n = await reader.ReadBlockAsync(buf, 0, buf.Length).ConfigureAwait(false);
        var user = CurrentUser();
        _logger.LogInformation("NfxPerf {User} {Sample}", user?.Username ?? "?", new string(buf, 0, n).Replace('\n', ' '));
        return NoContent();
    }

    [HttpGet("netflix.css")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult GetCss([FromQuery] string? v) => Serve(AssetStore.Css, v);

    [HttpGet("netflix.js")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult GetJs([FromQuery] string? v) => Serve(AssetStore.Js, v);

    [HttpGet("config.json")]
    [AllowAnonymous]
    [Produces(MediaTypeNames.Application.Json)]
    public ActionResult<NfxPublicConfig> GetConfig()
    {
        var c = Plugin.Instance?.Configuration ?? new Configuration.PluginConfiguration();
        Response.Headers.CacheControl = "no-cache";
        return new NfxPublicConfig
        {
            Version = AssetStore.PluginVersion,
            AssetVersion = AssetStore.Version,
            EnableHero = c.EnableHero,
            EnableTop10 = c.EnableTop10,
            GenreRowCount = Math.Clamp(c.GenreRowCount, 0, 10),
            EnableHoverPreview = c.EnableHoverPreview,
            EnableHeroTrailer = c.EnableHeroTrailer,
            HomeCardShape = string.IsNullOrEmpty(c.HomeCardShape) ? "backdrop" : c.HomeCardShape,
            ExcludedLibraryIds = c.ExcludedLibraryIds ?? Array.Empty<Guid>(),
            PerfBeacon = c.PerfBeacon,
        };
    }

    [HttpGet("Hero")]
    [Authorize]
    [Produces(MediaTypeNames.Application.Json)]
    public ActionResult<List<NfxItem>> GetHero([FromQuery] int limit = 6)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        Response.Headers.CacheControl = "private, no-cache";
        return _feeds.GetHero(user, limit);
    }

    [HttpGet("Top10")]
    [Authorize]
    [Produces(MediaTypeNames.Application.Json)]
    public ActionResult<List<NfxItem>> GetTop10([FromQuery] string type = "Movie")
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        BaseItemKind kind = string.Equals(type, "Series", StringComparison.OrdinalIgnoreCase)
            ? BaseItemKind.Series
            : BaseItemKind.Movie;
        Response.Headers.CacheControl = "private, no-cache";
        return _feeds.GetTop10(user, kind);
    }

    [HttpGet("GenreRows")]
    [Authorize]
    [Produces(MediaTypeNames.Application.Json)]
    public ActionResult<List<NfxGenreRow>> GetGenreRows([FromQuery] int count = 4)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        Response.Headers.CacheControl = "private, no-cache";
        return _feeds.GetGenreRows(user, count);
    }

    private Jellyfin.Database.Implementations.Entities.User? CurrentUser()
    {
        string? raw = User.Claims.FirstOrDefault(c => c.Type == UserIdClaim)?.Value;
        return Guid.TryParse(raw, out var id) ? _feeds.GetUser(id) : null;
    }

    private ActionResult Serve(AssetStore.Asset? asset, string? v)
    {
        if (asset is null)
        {
            return NotFound();
        }

        string etag = "\"" + asset.Hash + "\"";
        // Only a content hash in ?v= (the index.html injection uses AssetStore.Version) is safe to
        // cache forever: it changes whenever a file changes. Anything else (no v, the plugin
        // version from a branding @import, a typo) gets a short cache plus the ETag, because the
        // plugin version does not change on every rebuild.
        bool contentVersioned = !string.IsNullOrEmpty(v) && (v == AssetStore.Version || v == asset.Hash);
        Response.Headers.CacheControl = contentVersioned ? "public, max-age=31536000, immutable" : "public, max-age=3600";
        Response.Headers.ETag = etag;
        if (Request.Headers.IfNoneMatch.ToString() == etag)
        {
            return StatusCode(StatusCodes.Status304NotModified);
        }

        return File(asset.Bytes, asset.ContentType);
    }
}
