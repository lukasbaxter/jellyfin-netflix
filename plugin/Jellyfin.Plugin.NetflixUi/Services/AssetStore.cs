using System.Reflection;
using System.Security.Cryptography;

namespace Jellyfin.Plugin.NetflixUi.Services;

/// <summary>
/// Embedded css/js, loaded once. The asset version is a short content hash so a
/// changed file always gets a new URL.
/// </summary>
public static class AssetStore
{
    private static readonly Lazy<Asset?> CssLazy = new(() => Load("NetflixUi.netflix.css", "text/css; charset=utf-8"));
    private static readonly Lazy<Asset?> JsLazy = new(() => Load("NetflixUi.netflix.js", "application/javascript; charset=utf-8"));

    public static Asset? Css => CssLazy.Value;

    public static Asset? Js => JsLazy.Value;

    public static string PluginVersion => typeof(AssetStore).Assembly.GetName().Version?.ToString() ?? "1.0.0.0";

    /// <summary>
    /// Combined hash of both files, used as ?v= in the index.html injection.
    /// </summary>
    public static string Version
    {
        get
        {
            string a = Css?.Hash ?? "nocss";
            string b = Js?.Hash ?? "nojs";
            return (a + b).Length >= 16 ? a[..8] + b[..8] : a + b;
        }
    }

    private static Asset? Load(string name, string contentType)
    {
        using Stream? s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        if (s is null)
        {
            return null;
        }

        using var ms = new MemoryStream();
        s.CopyTo(ms);
        byte[] bytes = ms.ToArray();
        string hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()[..12];
        return new Asset(bytes, contentType, hash);
    }

    public sealed record Asset(byte[] Bytes, string ContentType, string Hash);
}
