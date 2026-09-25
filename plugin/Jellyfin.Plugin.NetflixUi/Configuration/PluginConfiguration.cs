using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.NetflixUi.Configuration;

/// <summary>
/// Feature flags for the Netflix UI. All of these are public (served by /NetflixUi/config.json).
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    public bool EnableHero { get; set; } = true;

    public bool EnableTop10 { get; set; } = true;

    public int GenreRowCount { get; set; } = 4;

    /// <summary>
    /// A title only makes the Top 10 when at least this many different people played it,
    /// so one person's viewing is never shown to everyone. 1 turns the check off.
    /// </summary>
    public int Top10MinDistinctUsers { get; set; } = 2;

    public bool EnableHoverPreview { get; set; } = true;

    public bool EnableHeroTrailer { get; set; } = false;

    /// <summary>
    /// "backdrop" (16:9 cards on home) or "stock".
    /// </summary>
    public string HomeCardShape { get; set; } = "backdrop";

    /// <summary>
    /// Also inject a &lt;link&gt; to the theme css into index.html (on top of the branding @import).
    /// </summary>
    public bool InjectCss { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether clients send perf samples to the server log (diagnostics only).</summary>
    public bool PerfBeacon { get; set; }

    /// <summary>
    /// Libraries (CollectionFolder ids) left out of the hero, Top 10 and genre rows, for example Demos.
    /// </summary>
#pragma warning disable CA1819 // XML config needs an array
    public Guid[] ExcludedLibraryIds { get; set; } = Array.Empty<Guid>();
#pragma warning restore CA1819
}
