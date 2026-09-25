namespace Jellyfin.Plugin.NetflixUi.Services;

/// <summary>
/// Item shape returned by every NetflixUi data route.
/// </summary>
public class NfxItem
{
    public Guid Id { get; set; }

    public string Name { get; set; } = string.Empty;

    public string Type { get; set; } = string.Empty;

    public string? Overview { get; set; }

    public string? OfficialRating { get; set; }

    public int? ProductionYear { get; set; }

    public long? RunTimeTicks { get; set; }

    public float? CommunityRating { get; set; }

    public string[] Genres { get; set; } = Array.Empty<string>();

    public string? BackdropTag { get; set; }

    public string? LogoTag { get; set; }

    public string? PrimaryTag { get; set; }

    public string? ThumbTag { get; set; }

    public Guid? SeriesId { get; set; }

    /// <summary>
    /// Episode (or movie) to resume when this hero entry came from Continue Watching.
    /// </summary>
    public Guid? ResumeItemId { get; set; }

    /// <summary>
    /// What the Play button should start: the resume item, the next episode of a series, or the item itself.
    /// </summary>
    public Guid? PlayItemId { get; set; }

    public string? PlayItemType { get; set; }

    public long PlayPositionTicks { get; set; }

    public string? TrailerUrl { get; set; }

    public Guid? LocalTrailerId { get; set; }

    public int? Rank { get; set; }

    public NfxUserData UserData { get; set; } = new NfxUserData();
}

public class NfxUserData
{
    public bool Played { get; set; }

    public bool IsFavorite { get; set; }

    public long PlaybackPositionTicks { get; set; }
}

public class NfxGenreRow
{
    public string Genre { get; set; } = string.Empty;

    public string Slug { get; set; } = string.Empty;

    public List<NfxItem> Items { get; set; } = new List<NfxItem>();
}

public class NfxPublicConfig
{
    public string Version { get; set; } = string.Empty;

    public string AssetVersion { get; set; } = string.Empty;

    public bool EnableHero { get; set; }

    public bool EnableTop10 { get; set; }

    public int GenreRowCount { get; set; }

    public bool EnableHoverPreview { get; set; }

    public bool EnableHeroTrailer { get; set; }

    public string HomeCardShape { get; set; } = "backdrop";

    /// <summary>Gets or sets libraries the home rows leave out (e.g. Demos).</summary>
    public Guid[] ExcludedLibraryIds { get; set; } = Array.Empty<Guid>();
}
