using Jellyfin.Plugin.NetflixUi.Services;

namespace Jellyfin.Plugin.NetflixUi.Startup;

/// <summary>
/// Payload File Transformation hands to the callback (deserialized from {"contents": "..."}).
/// </summary>
public class TransformPayload
{
    public string? Contents { get; set; }
}

/// <summary>
/// Callback invoked by File Transformation for index.html. Must stay public static.
/// </summary>
public static class IndexTransformer
{
    public const string Marker = "/NetflixUi/netflix.js";

    /// <summary>
    /// Gets or sets the server base url ("" or "/jellyfin"), set at startup.
    /// </summary>
    public static string BaseUrl { get; set; } = string.Empty;

    public static string TransformIndex(TransformPayload payload)
    {
        string html = payload?.Contents ?? string.Empty;
        return Inject(html);
    }

    public static string Inject(string html)
    {
        if (string.IsNullOrEmpty(html) || html.Contains(Marker, StringComparison.Ordinal))
        {
            return html;
        }

        int head = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        if (head < 0)
        {
            return html;
        }

        string v = AssetStore.Version;
        bool css = Plugin.Instance?.Configuration.InjectCss ?? true;
        string tags =
            (css && AssetStore.Css is not null ? $"<link rel=\"stylesheet\" href=\"{BaseUrl}/NetflixUi/netflix.css?v={v}\">" : string.Empty)
            + $"<script defer src=\"{BaseUrl}{Marker}?v={v}\"></script>";

        return html.Insert(head, tags);
    }
}
