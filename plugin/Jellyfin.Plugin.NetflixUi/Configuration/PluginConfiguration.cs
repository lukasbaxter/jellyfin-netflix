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
}
